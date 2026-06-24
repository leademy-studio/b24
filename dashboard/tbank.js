/**
 * T-Bank (T-Business OpenAPI): нормализация payload вебхука + авторизация.
 *
 * Авторизация входящего вебхука: T-Business не подписывает payload криптографически —
 * защита = (1) Bearer/Basic-секрет в заголовке Authorization, который мы регистрируем
 * у T-Bank (письмо openapi@tbank.ru), и (2) опц. allowlist известных IP T-Bank.
 *
 * Нормализация: payload приводим к { operationId, direction, amount, currency,
 * payerInn, payerName, purpose, date }. Точные имена полей T-Bank подтверждаются
 * read-only вызовом выписки на этапе боевого подключения — здесь учитываем
 * наиболее вероятные варианты и берём первое непустое.
 */

const WEBHOOK_SECRET = process.env.TBANK_WEBHOOK_SECRET || "";
const ALLOW_INSECURE = process.env.ALLOW_INSECURE_TBANK === "1";

// Известные IP T-Bank (офиц. доки). Включается флагом TBANK_IP_ALLOWLIST=on.
export const TBANK_IPS = [
  "212.233.80.7",
  "91.218.132.2",
  "91.194.226.234",
  "91.194.226.235",
  "91.194.226.250",
  "91.194.226.251",
];
const IP_ALLOWLIST_ON = process.env.TBANK_IP_ALLOWLIST === "on";

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIps(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...xff, req.ip, req.socket?.remoteAddress].filter(Boolean);
}

/**
 * Проверка подлинности вебхука. Возвращает {ok:true} или {ok:false, reason}.
 */
export function verifyTbankAuth(req) {
  if (IP_ALLOWLIST_ON) {
    const ips = clientIps(req).map((ip) => ip.replace(/^::ffff:/, ""));
    if (!ips.some((ip) => TBANK_IPS.includes(ip))) return { ok: false, reason: "ip_not_allowed" };
  }
  if (WEBHOOK_SECRET) {
    const h = req.headers.authorization || "";
    // принимаем «Bearer <secret>», «Basic <secret>» или голый секрет
    const presented = h.replace(/^(Bearer|Basic)\s+/i, "");
    if (timingSafeEqual(presented, WEBHOOK_SECRET)) return { ok: true };
    return { ok: false, reason: "bad_secret" };
  }
  if (ALLOW_INSECURE) return { ok: true }; // только для локалки
  return { ok: false, reason: "not_configured" };
}

export const tbankAuthConfigured = Boolean(WEBHOOK_SECRET || ALLOW_INSECURE);

// --- Нормализация операции ---------------------------------------------------
function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toNumber(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Кредит (зачисление) или дебет. Учитываем разные представления T-Bank. */
function normalizeDirection(raw) {
  const t = String(
    pick(raw, ["typeOfOperation", "type", "direction", "operationType", "drcr"]) || ""
  ).toLowerCase();
  if (/credit|incoming|in\b|приход|зачисл/.test(t)) return "credit";
  if (/debit|outgoing|out\b|расход|списан/.test(t)) return "debit";
  // некоторые форматы дают флаг isCredit / признак стороны
  if (raw.isCredit === true) return "credit";
  if (raw.isCredit === false) return "debit";
  return "unknown";
}

/**
 * Нормализует одну операцию T-Bank → стандартный объект матчера.
 * Терпимо к разным именам полей (адаптер).
 */
export function normalizeOperation(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    operationId: pick(raw, ["operationId", "id", "ucid", "documentNumber"]) ?? null,
    direction: normalizeDirection(raw),
    amount: toNumber(pick(raw, ["amount", "accountAmount", "operationAmount", "sum"])),
    currency: pick(raw, ["currency", "currencyCode", "iso"]) ?? "RUB",
    payerInn: String(
      pick(raw, [
        "payerInn",
        "counterPartyInn",
        "counterpartyInn",
        "payer.inn",
        "counterParty.inn",
        "contractorInn",
      ]) || ""
    ).trim(),
    payerName: pick(raw, ["payerName", "counterPartyName", "payer.name", "counterParty.name"]) || "",
    purpose: pick(raw, ["paymentPurpose", "purpose", "description", "nazначение", "comment"]) || "",
    date: pick(raw, ["date", "operationDate", "chargeDate", "documentDate"]) || null,
    _raw: raw,
  };
}

/**
 * Достаёт массив операций из тела вебхука (одиночная операция, массив,
 * либо обёртки {operation}/{operations}/{data}).
 */
export function extractOperations(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.operations)) return body.operations;
  if (Array.isArray(body.data)) return body.data;
  if (body.operation && typeof body.operation === "object") return [body.operation];
  // одиночная операция в корне
  return [body];
}
