import axios from "axios";

/**
 * Тонкий клиент Bitrix24 REST поверх входящего вебхука.
 * База берётся из env: B24_WEBHOOK_BASE_FILE > B24_WEBHOOK_BASE.
 * (паттерн вызова повторяет server.js / scripts/verify-data.mjs)
 */

const RAW_BASE = process.env.B24_WEBHOOK_BASE_FILE || process.env.B24_WEBHOOK_BASE || "";
const BASE = RAW_BASE ? (RAW_BASE.endsWith("/") ? RAW_BASE : `${RAW_BASE}/`) : "";

export const bitrixConfigured = Boolean(BASE);

export function maskBase(base = BASE) {
  return base.replace(/\/rest\/(\d+)\/([^/]+)\//, "/rest/$1/***/");
}

function toFormPairs(obj, prefix = "", out = []) {
  if (obj == null) return out;
  const isObj = typeof obj === "object" && !Array.isArray(obj);
  if (!isObj) {
    out.push([prefix, String(obj)]);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) toFormPairs(v, key, out);
    else if (Array.isArray(v))
      v.forEach((it, i) => {
        const ak = `${key}[${i}]`;
        if (it && typeof it === "object") toFormPairs(it, ak, out);
        else out.push([ak, String(it)]);
      });
    else out.push([key, String(v)]);
  }
  return out;
}

/** Один REST-вызов. Бросает Error при ответе с ошибкой Bitrix. */
export async function b24Call(method, params = {}) {
  if (!BASE) throw new Error("B24_WEBHOOK_BASE is not set");
  const form = new URLSearchParams();
  for (const [k, v] of toFormPairs(params)) form.append(k, v);
  const { data } = await axios.post(`${BASE}${method}.json`, form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (!data) throw new Error("Empty response from Bitrix REST");
  if (data.error) throw new Error(`${data.error}: ${data.error_description || "no_description"}`);
  return data;
}

/** Только total по list-методу (start:0, нулевой select по возможности). */
export async function b24Total(method, params = {}) {
  const data = await b24Call(method, { ...params, start: 0 });
  return Number(data.total || 0);
}

/**
 * Полный обход list-метода с пагинацией (по 50). pick(data) достаёт массив
 * из ответа (у tasks.task.list это result.tasks, у crm.* — result).
 */
export async function b24ListAll(method, params = {}, pick = (d) => d.result || [], cap = 2000) {
  const out = [];
  let start = 0;
  for (let i = 0; i < cap / 50 + 1; i++) {
    const data = await b24Call(method, { ...params, start });
    const batch = pick(data) || [];
    out.push(...batch);
    if (batch.length < 50 || data.next == null || out.length >= cap) break;
    start = data.next;
  }
  return out;
}
