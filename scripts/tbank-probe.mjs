#!/usr/bin/env node
/**
 * Диагностика T-Business OpenAPI (READ-ONLY): проверяет токен, выводит счета и
 * СТРУКТУРУ операций выписки (имена полей), маскируя значения. Ничего не платит,
 * не двигает, не пишет. Нужен для подтверждения имён полей payload.
 *
 * Токен: env TBANK_TOKEN или строка TBANK_TOKEN=... в .secrets/dashboard-admin.txt.
 * Запуск:  node scripts/tbank-probe.mjs
 */
import { readFileSync } from "node:fs";

const BASE = "https://business.tbank.ru/openapi/api";

function token() {
  if (process.env.TBANK_TOKEN) return process.env.TBANK_TOKEN.trim();
  try {
    const txt = readFileSync(".secrets/dashboard-admin.txt", "utf8");
    const m = txt.match(/^TBANK_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("TBANK_TOKEN не найден (env или .secrets/dashboard-admin.txt)");
}

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

function mask(v) {
  if (v == null) return v;
  if (typeof v === "number") return "<num>";
  if (typeof v === "boolean") return v;
  const s = String(v);
  if (/^\d+$/.test(s)) return `<${s.length}d>`;
  return s.length <= 4 ? s : s.slice(0, 3) + "…(" + s.length + ")";
}

// Поля-перечисления (направление/тип) НЕ чувствительны — показываем как есть
const ENUM_KEY = /type|direction|credit|debit|drcr|category|status|operationType/i;

function describe(obj, depth = 0) {
  if (obj == null || typeof obj !== "object") return;
  const pad = "  ".repeat(depth + 1);
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      console.log(`${pad}${k}: {object}`);
      if (depth < 1) describe(v, depth + 1);
    } else if (Array.isArray(v)) {
      console.log(`${pad}${k}: [array x${v.length}]`);
    } else {
      const shown = ENUM_KEY.test(k) ? JSON.stringify(v) : mask(v);
      console.log(`${pad}${k}: ${shown}  (${typeof v})`);
    }
  }
}

console.log("=== 1) GET /api/v4/bank-accounts ===");
let acc = await get("/v4/bank-accounts");
if (acc.status !== 200) {
  console.log(`  v4 → HTTP ${acc.status}: ${acc.text.slice(0, 200)}`);
  console.log("  пробую v3...");
  acc = await get("/v3/bank-accounts");
}
console.log(`  HTTP ${acc.status}`);
const accounts = Array.isArray(acc.json) ? acc.json : acc.json?.accounts || acc.json?.bankAccounts || [];
console.log(`  счетов: ${accounts.length}`);
let accountNumber = process.env.TBANK_ACCOUNT || null;
for (const a of accounts) {
  const n = a.accountNumber || a.number || a.account || "";
  console.log(`   счёт ****${String(n).slice(-4)}  валюта=${a.currency || a.currencyIso || "?"}  тип=${a.accountType || a.type || "?"}`);
  if (!accountNumber && /^\d{20,22}$/.test(String(n))) accountNumber = String(n);
}
if (!accountNumber) { console.log("  Нет accountNumber — стоп."); process.exit(acc.status === 200 ? 0 : 1); }

const till = new Date();
const from = new Date(till.getTime() - 30 * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);
console.log(`\n=== 2) GET /api/v1/bank-statement (****${accountNumber.slice(-4)}, ${fmt(from)}..${fmt(till)}) ===`);
const st = await get("/v1/bank-statement", { accountNumber, from: fmt(from), till: fmt(till) });
console.log(`  HTTP ${st.status}`);
if (st.status !== 200) { console.log("  body:", st.text.slice(0, 300)); process.exit(1); }
const ops = st.json?.operations || st.json?.data || (Array.isArray(st.json) ? st.json : []);
console.log(`  операций за период: ${Array.isArray(ops) ? ops.length : "?"}`);
if (Array.isArray(ops) && ops.length) {
  console.log("\n  --- СТРУКТУРА первой операции (значения замаскированы; enum-поля как есть) ---");
  describe(ops[0]);
  // покажем уникальные значения «направления» по выборке
  const dirKeys = Object.keys(ops[0]).filter((k) => ENUM_KEY.test(k));
  if (dirKeys.length) {
    console.log("\n  --- значения enum-полей по первым 10 операциям ---");
    for (const k of dirKeys) {
      const vals = [...new Set(ops.slice(0, 10).map((o) => JSON.stringify(o[k])))];
      console.log(`   ${k}: ${vals.join(", ")}`);
    }
  }
}
console.log("\nГотово (read-only).");
