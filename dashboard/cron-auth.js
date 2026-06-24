/**
 * Авторизация машинных cron-эндпоинтов (`/api/cron/*`).
 *
 * Прод: Cloud Scheduler шлёт OIDC-токен сервис-аккаунта в заголовке
 *   Authorization: Bearer <id_token>. Проверяем подпись Google и совпадение
 *   audience (URL сервиса) и email SA (CRON_SA_EMAIL).
 * Dev/локально: заголовок X-Cron-Key == CRON_SHARED_SECRET (для dry-run без OIDC).
 *
 * Если не настроено НИ одного способа — fail-closed (401), кроме явного
 * ALLOW_INSECURE_CRON=1 (только для локальной разработки).
 */

import { OAuth2Client } from "google-auth-library";

const SHARED_SECRET = process.env.CRON_SHARED_SECRET || "";
const SA_EMAIL = process.env.CRON_SA_EMAIL || "";
const AUDIENCE = process.env.CRON_AUDIENCE || ""; // обычно публичный URL Cloud Run
const ALLOW_INSECURE = process.env.ALLOW_INSECURE_CRON === "1";

const oauth = new OAuth2Client();

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyOidc(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  try {
    const ticket = await oauth.verifyIdToken({
      idToken: m[1],
      ...(AUDIENCE ? { audience: AUDIENCE } : {}),
    });
    const payload = ticket.getPayload();
    if (!payload) return false;
    if (SA_EMAIL && payload.email !== SA_EMAIL) return false;
    if (SA_EMAIL && payload.email_verified === false) return false;
    return true;
  } catch {
    return false;
  }
}

/** Express middleware. */
export async function requireCron(req, res, next) {
  // 1) Общий секрет (dev / простой режим)
  if (SHARED_SECRET) {
    const key = req.headers["x-cron-key"];
    if (typeof key === "string" && timingSafeEqual(key, SHARED_SECRET)) return next();
  }
  // 2) OIDC от Cloud Scheduler
  if (SA_EMAIL || AUDIENCE) {
    if (await verifyOidc(req)) return next();
  }
  // 3) Явный небезопасный режим только для локалки
  if (ALLOW_INSECURE && !SHARED_SECRET && !SA_EMAIL && !AUDIENCE) {
    console.warn("[cron-auth] ALLOW_INSECURE_CRON=1 — авторизация cron отключена (только для dev)");
    return next();
  }
  return res.status(401).json({ error: "unauthorized" });
}

export const cronAuthConfigured = Boolean(SHARED_SECRET || SA_EMAIL || AUDIENCE || ALLOW_INSECURE);
