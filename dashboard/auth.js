import crypto from "node:crypto";

/**
 * Минимальная серверная аутентификация для дашборда.
 *
 * - Логин: process.env.DASHBOARD_USERNAME
 * - Пароль: проверяется по scrypt-хэшу из process.env.DASHBOARD_PASSWORD_HASH
 *           (формат "scrypt$<saltHex>$<hashHex>")
 * - Сессия: HMAC-подписанная cookie (секрет process.env.SESSION_SECRET)
 *
 * Зависимостей нет — только встроенный node:crypto.
 * Fail-closed: если хэш/секрет не заданы, вход невозможен и защищённые
 * маршруты закрыты (лучше залочить, чем открыть наружу).
 */

const USERNAME = process.env.DASHBOARD_USERNAME || "";
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const COOKIE = "leademy_session";
const TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

export const authConfigured = Boolean(USERNAME && PASSWORD_HASH && SESSION_SECRET);

function timingEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function verifyPassword(password, stored = PASSWORD_HASH) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !SESSION_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingEqual(sig, sign(payload))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    out[s.slice(0, i)] = decodeURIComponent(s.slice(i + 1));
  }
  return out;
}

function setSessionCookie(res, token, remember) {
  const attrs = [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
  ];
  if (remember) attrs.push(`Max-Age=${Math.floor(TTL_MS / 1000)}`);
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

/** POST /api/login — { username, password, remember } */
export function loginHandler(req, res) {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_credentials" });
  if (!authConfigured) return res.status(503).json({ error: "auth_not_configured" });
  const ok = timingEqual(username, USERNAME) && verifyPassword(password);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });
  setSessionCookie(res, makeToken(USERNAME), remember !== false);
  return res.json({ ok: true });
}

/** POST /api/logout */
export function logoutHandler(_req, res) {
  clearSessionCookie(res);
  return res.json({ ok: true });
}

/** Гейт: пускает только с валидной сессией. API → 401 JSON, остальное → редирект на /login.html */
export function requireAuth(req, res, next) {
  const session = authConfigured ? verifyToken(parseCookies(req)[COOKIE]) : null;
  if (session) {
    req.user = session;
    return next();
  }
  if (req.path.startsWith("/api")) return res.status(401).json({ error: "unauthorized" });
  return res.redirect(302, "/login.html");
}

/** GET /api/me — кто залогинен (для фронта) */
export function meHandler(req, res) {
  res.json({ username: req.user?.u || null });
}
