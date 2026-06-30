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
import { conspectApi } from "./conspect-api.js";
import { requireCron } from "./cron-auth.js";
import { runLaunchMonth } from "./scheduler.js";
import { runLaunchWeekly } from "./weekly.js";
import { verifyTbankAuth, normalizeOperation, extractOperations } from "./tbank.js";
import { matchPayment } from "./payments-matcher.js";

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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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
// launch-weekly: недельные PPC-подзадачи (№10 ср, №11 пн). dryRun по умолчанию = true.
app.post("/api/cron/launch-weekly", requireCron, async (req, res) => {
  try {
    const { kind, period, runDate } = req.body || {};
    const dryRun = req.body?.dryRun !== false;
    const result = await runLaunchWeekly({ kind, period, runDate, dryRun });
    res.status(200).json(result);
  } catch (e) {
    console.error("[launch-weekly]", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
});
// tbank/webhook: входящие платежи. dryRun по умолчанию = true (env TBANK_DRYRUN!=="false").
// Всегда отвечаем 2XX (иначе T-Bank ретраит). Сделки двигаем только в боевом режиме.
app.post("/api/tbank/webhook", async (req, res) => {
  const auth = verifyTbankAuth(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized", reason: auth.reason });
  const dryRun = process.env.TBANK_DRYRUN !== "false";
  const ops = extractOperations(req.body);
  const results = [];
  for (const raw of ops) {
    const op = normalizeOperation(raw);
    if (!op) {
      results.push({ action: "skip", reason: "unparseable_operation" });
      continue;
    }
    try {
      results.push(await matchPayment(op, { dryRun }));
    } catch (e) {
      console.error("[tbank/webhook]", e?.message || e);
      results.push({ action: "manual", reason: "matcher_error", error: e?.message, operationId: op.operationId });
    }
  }
  res.status(200).json({ ok: true, dryRun, count: results.length, results });
});

// --- Гейт: всё ниже требует валидной сессии ---
app.use(requireAuth);

// --- Защищённые маршруты ---
app.get("/api/me", meHandler);

// Конспекты встреч → задачи (НЕ за bitrix-гардом: список/разбор доступны без Bitrix).
app.use("/api/conspect", conspectApi);

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
