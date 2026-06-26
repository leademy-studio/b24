#!/usr/bin/env node
/**
 * T-Bank statement poller — РАБОТАЕТ НА ВАШЕМ VPS (не в Cloud Run).
 *
 * Зачем: токен T-Business привязан к IP. Этот скрипт запускается с VPS, чей
 * статический IP зарегистрирован при выпуске токена, читает банковскую выписку
 * и пересылает НОВЫЕ операции на вебхук дашборда в Cloud Run, где их разбирает
 * уже готовый матчер (auto NEW → «В работе»). Push-вебхук от T-Bank работает
 * параллельно; этот опрос — подстраховка на случай недоставленных пушей.
 *
 * Требования: Node.js 18+ (нужен встроенный fetch). Без npm-зависимостей.
 *
 * Конфиг через переменные окружения:
 *   TBANK_TOKEN            (обяз.) API-токен T-Business; IP этого VPS зарегистрирован в токене
 *   DASHBOARD_WEBHOOK_URL  (обяз.) https://leademy-dashboard-yej2ugzhsq-ew.a.run.app/api/tbank/webhook
 *   TBANK_WEBHOOK_SECRET   (обяз.) Bearer для вызова нашего вебхука (= секрет из Secret Manager)
 *   TBANK_ACCOUNT          (опц.)  номер расчётного счёта (20/22 цифры); если пусто — автоопределение
 *   STATE_FILE             (опц.)  файл состояния, по умолч. ./tbank-poller-state.json
 *   LOOKBACK_MINUTES       (опц.)  окно перекрытия, по умолч. 180
 *   TBANK_BASE             (опц.)  по умолч. https://business.tbank.ru/openapi/api
 *
 * Запуск разово (для cron/systemd-таймера):
 *   TBANK_TOKEN=... DASHBOARD_WEBHOOK_URL=... TBANK_WEBHOOK_SECRET=... node scripts/tbank-poller.mjs
 *
 * --- Вариант cron (каждые 10 минут) ---
 *   * /10 * * * *  cd /opt/tbank-poller && /usr/bin/node tbank-poller.mjs >> poller.log 2>&1
 *   (переменные — в /opt/tbank-poller/.env, подгружайте через `env $(cat .env|xargs)` или systemd)
 *
 * --- Вариант systemd (надёжнее) ---
 *   /etc/systemd/system/tbank-poller.service:
 *     [Service]
 *     Type=oneshot
 *     EnvironmentFile=/opt/tbank-poller/.env
 *     WorkingDirectory=/opt/tbank-poller
 *     ExecStart=/usr/bin/node /opt/tbank-poller/tbank-poller.mjs
 *   /etc/systemd/system/tbank-poller.timer:
 *     [Timer]
 *     OnBootSec=2min
 *     OnUnitActiveSec=10min
 *     [Install]
 *     WantedBy=timers.target
 *   sudo systemctl enable --now tbank-poller.timer
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOKEN = req("TBANK_TOKEN");
const WEBHOOK_URL = req("DASHBOARD_WEBHOOK_URL");
const WEBHOOK_SECRET = req("TBANK_WEBHOOK_SECRET");
const BASE = (process.env.TBANK_BASE || "https://business.tbank.ru/openapi/api").replace(/\/$/, "");
const STATE_FILE = process.env.STATE_FILE || "./tbank-poller-state.json";
const LOOKBACK_MIN = Number(process.env.LOOKBACK_MINUTES || 180);
const SEEN_CAP = 5000;

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`[poller] нет обязательной переменной ${name}`); process.exit(2); }
  return v.trim();
}
function log(...a) { console.log(new Date().toISOString(), "[poller]", ...a); }

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { seen: [] }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log("WARN: не сохранил state:", e.message); }
}

async function tbankGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function resolveAccount() {
  if (process.env.TBANK_ACCOUNT) return process.env.TBANK_ACCOUNT.trim();
  for (const v of ["/v4/bank-accounts", "/v3/bank-accounts"]) {
    const r = await tbankGet(v);
    if (r.status !== 200) continue;
    const list = Array.isArray(r.json) ? r.json : r.json?.accounts || r.json?.bankAccounts || [];
    for (const a of list) {
      const n = String(a.accountNumber || a.number || a.account || "");
      if (/^\d{20,22}$/.test(n)) return n;
    }
  }
  throw new Error("не удалось определить accountNumber — задайте TBANK_ACCOUNT");
}

function extractOps(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.operations)) return json.operations;
  if (Array.isArray(json.data)) return json.data;
  return [];
}
function opId(o) {
  return o.operationId ?? o.id ?? o.ucid ?? o.documentNumber ?? null;
}

async function main() {
  const state = loadState();
  const seen = new Set(state.seen || []);

  const account = await resolveAccount();
  const till = new Date();
  const from = new Date(till.getTime() - LOOKBACK_MIN * 60000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const st = await tbankGet("/v1/bank-statement", { accountNumber: account, from: fmt(from), till: fmt(till) });
  if (st.status !== 200) {
    log(`ОШИБКА выписки HTTP ${st.status}: ${st.text.slice(0, 200)}`);
    process.exit(1);
  }
  const ops = extractOps(st.json);
  const fresh = ops.filter((o) => { const id = opId(o); return id != null && !seen.has(String(id)); });
  log(`счёт ****${account.slice(-4)} | операций в окне: ${ops.length} | новых: ${fresh.length}`);

  if (!fresh.length) { saveState({ seen: [...seen].slice(-SEEN_CAP) }); return; }

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: JSON.stringify(fresh),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`вебхук вернул HTTP ${res.status} — НЕ помечаю операции обработанными:`, JSON.stringify(body).slice(0, 200));
    process.exit(1);
  }
  // успех — фиксируем operationId, чтобы не пересылать повторно
  for (const o of fresh) { const id = opId(o); if (id != null) seen.add(String(id)); }
  saveState({ seen: [...seen].slice(-SEEN_CAP) });

  const acts = (body.results || []).reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
  log(`отправлено ${fresh.length} | вебхук dryRun=${body.dryRun} | решения:`, JSON.stringify(acts));
}

main().catch((e) => { log("FATAL:", e.message || e); process.exit(1); });
