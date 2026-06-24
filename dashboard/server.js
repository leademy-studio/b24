import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authConfigured,
  loginHandler,
  logoutHandler,
  requireAuth,
  meHandler,
} from "./auth.js";
import { api } from "./api.js";
import { requireCron } from "./cron-auth.js";
import { runLaunchMonth } from "./scheduler.js";

/**
 * Каркас бэкенда дашборда Leademy (Cloud Run).
 *
 * Сейчас: health-эндпоинты + раздача статического SPA из ../web.
 * Дальше сюда навешиваются роутеры:
 *   - /api/cron/launch-month   (Cloud Scheduler → генерация месячных задач)
 *   - /api/cron/launch-weekly  (еженедельная PPC-оптимизация)
 *   - /api/tbank/webhook       (входящие платежи Т-Банка)
 *   - /api/...                 (данные дашборда поверх Bitrix24)
 *
 * Секреты (B24_WEBHOOK_BASE и пр.) приходят из env / Secret Manager,
 * а доступ к GCP — через привязанный к ревизии Service Account (keyless ADC),
 * без файлов ключей (запрещены оргполитикой).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const BOOT_TIME = new Date().toISOString();
const REVISION = process.env.K_REVISION || "local";

// --- Health / liveness ---
// ВНИМАНИЕ: путь /healthz зарезервирован Google Front End (GFE) и до контейнера
// не доходит (отдаёт платформенный 404). Поэтому health живёт на /health и /api/health.
const health = (_req, res) =>
  res.status(200).json({ status: "ok", revision: REVISION, bootedAt: BOOT_TIME });
app.get("/health", health);
app.get("/api/health", health);

if (!authConfigured) {
  console.warn(
    "[BOOT] WARNING: аутентификация НЕ настроена (нет DASHBOARD_USERNAME/DASHBOARD_PASSWORD_HASH/SESSION_SECRET). " +
      "Защищённые маршруты закрыты (fail-closed), вход невозможен."
  );
}

// --- Публичные маршруты аутентификации (ДО гейта) ---
app.post("/api/login", loginHandler);
app.post("/api/logout", logoutHandler);

// Страница логина и её стили доступны без авторизации
app.get(["/login", "/login.html"], (_req, res) =>
  res.sendFile(path.join(WEB_DIR, "login.html"))
);
app.get("/styles.css", (_req, res) => res.sendFile(path.join(WEB_DIR, "styles.css")));
// Статика бренда (лого/аватар) нужна и на странице логина — отдаём без авторизации
app.use("/assets", express.static(path.join(WEB_DIR, "assets")));

// --- Машинные эндпоинты (НЕ за пользовательским гейтом; своя auth — requireCron) ---
// cron от Cloud Scheduler (OIDC), вебхук Т-Банка (подпись/IP).
// launch-month: генератор месячных рутинных задач. dryRun=true по умолчанию (fail-safe).
app.post("/api/cron/launch-month", requireCron, async (req, res) => {
  try {
    const period = req.body?.period;
    const dryRun = req.body?.dryRun !== false; // только явный false включает запись
    const result = await runLaunchMonth({ period, dryRun });
    res.status(200).json(result);
  } catch (e) {
    console.error("[launch-month]", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
});
// launch-weekly и tbank/webhook — пока заглушки 501.
app.all("/api/cron/launch-weekly", (_req, res) =>
  res.status(501).json({ error: "not_implemented", endpoint: "launch-weekly" })
);
app.all("/api/tbank/webhook", (_req, res) =>
  res.status(501).json({ error: "not_implemented", endpoint: "tbank-webhook" })
);

// --- Гейт: всё ниже требует валидной сессии ---
app.use(requireAuth);

// --- Защищённые маршруты ---
app.get("/api/me", meHandler);

// Данные дашборда поверх Bitrix24
app.use("/api", api);

app.get("/api/version", (req, res) => {
  res.status(200).json({
    service: "leademy-dashboard",
    revision: REVISION,
    bootedAt: BOOT_TIME,
    node: process.version,
    user: req.user?.u || null,
  });
});

// --- Статический SPA (web/) ---
app.use(express.static(WEB_DIR, { extensions: ["html"] }));

// Фоллбэк на index.html для хэш-роутера SPA (кроме /api и /healthz)
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/health") return next();
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

// Аккуратная обработка битого JSON-тела (без stack-trace в логах)
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json" });
  }
  console.error("[ERROR]", err?.message || err);
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`[BOOT] leademy-dashboard listening on :${port} (revision ${REVISION})`);
});
