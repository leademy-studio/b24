import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

app.get("/api/version", (_req, res) => {
  res.status(200).json({
    service: "leademy-dashboard",
    revision: REVISION,
    bootedAt: BOOT_TIME,
    node: process.version,
  });
});

// --- Заготовки под будущие роутеры (отвечают 501, чтобы маршруты были видимы) ---
app.all("/api/cron/launch-month", (_req, res) =>
  res.status(501).json({ error: "not_implemented", endpoint: "launch-month" })
);
app.all("/api/cron/launch-weekly", (_req, res) =>
  res.status(501).json({ error: "not_implemented", endpoint: "launch-weekly" })
);
app.all("/api/tbank/webhook", (_req, res) =>
  res.status(501).json({ error: "not_implemented", endpoint: "tbank-webhook" })
);

// --- Статический SPA (web/) ---
app.use(express.static(WEB_DIR, { extensions: ["html"] }));

// Фоллбэк на index.html для хэш-роутера SPA (кроме /api и /healthz)
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/health") return next();
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`[BOOT] leademy-dashboard listening on :${port} (revision ${REVISION})`);
});
