// One-off READ-ONLY verifier against the live portal (B24_WEBHOOK_BASE).
// Usage: node --env-file=.env scripts/verify-data.mjs
// Only GET/list methods — no writes.

import axios from "axios";

let BASE = process.env.B24_WEBHOOK_BASE || "";
if (!BASE) { console.error("ERROR: B24_WEBHOOK_BASE not set"); process.exit(1); }
if (!BASE.endsWith("/")) BASE += "/";

function toFormPairs(obj, prefix = "", out = []) {
  if (obj == null) return out;
  const isObj = typeof obj === "object" && !Array.isArray(obj);
  if (!isObj) { out.push([prefix, String(obj)]); return out; }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) toFormPairs(v, key, out);
    else if (Array.isArray(v)) v.forEach((it, i) => {
      const ak = `${key}[${i}]`;
      if (it && typeof it === "object") toFormPairs(it, ak, out);
      else out.push([ak, String(it)]);
    });
    else out.push([key, String(v)]);
  }
  return out;
}

async function call(method, params = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of toFormPairs(params)) form.append(k, v);
  const { data } = await axios.post(`${BASE}${method}.json`, form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000, validateStatus: () => true,
  });
  if (data && data.error) return { __error: `${data.error}: ${data.error_description || ""}` };
  return data;
}

async function safe(label, fn) {
  try { const r = await fn(); console.log(`\n### ${label}`); console.log(JSON.stringify(r, null, 2)); }
  catch (e) { console.log(`\n### ${label}\nEXC: ${e.message || e}`); }
}

await safe("scope() — выданные права вебхука", async () => {
  const r = await call("scope");
  return r.__error ? r : r.result;
});

await safe("im.dialog.get chat1363 (ожидаем SEO)", async () => {
  const r = await call("im.dialog.get", { DIALOG_ID: "chat1363" });
  if (r.__error) return r;
  const d = r.result || {};
  return { chat_id: d.chat_id, name: d.name, type: d.type, entity_type: d.entity_type };
});

await safe("im.dialog.get chat2045 (ожидаем PPC)", async () => {
  const r = await call("im.dialog.get", { DIALOG_ID: "chat2045" });
  if (r.__error) return r;
  const d = r.result || {};
  return { chat_id: d.chat_id, name: d.name, type: d.type, entity_type: d.entity_type };
});

await safe("ответственные SEO/PPC + дизайн/разработка", async () => {
  const out = {};
  for (const id of [1, 17, 31, 101, 103]) {
    const r = await call("user.get", { ID: id });
    if (r.__error) { out[id] = r.__error; continue; }
    const u = (r.result || [])[0];
    out[id] = u ? `${u.NAME} ${u.LAST_NAME}${u.WORK_POSITION ? " — " + u.WORK_POSITION : ""}${u.ACTIVE === false ? " [НЕАКТИВЕН]" : ""}` : "не найден";
  }
  return out;
});

await safe("crm.category.list (воронки сделок)", async () => {
  const r = await call("crm.category.list", { entityTypeId: 2 });
  if (r.__error) return r;
  return (r.result?.categories || []).map(c => ({ id: c.id, name: c.name, isDefault: c.isDefault }));
});

await safe("crm.deal.recurring.list (активные регулярные)", async () => {
  const r = await call("crm.deal.recurring.list", { filter: { ACTIVE: "Y" } });
  if (r.__error) return r;
  const rows = r.result || [];
  return { count: rows.length, dealIds: rows.map(x => x.DEAL_ID) };
});

await safe("socialnetwork.api.workgroup.list (кол-во групп)", async () => {
  const r = await call("socialnetwork.api.workgroup.list", { filter: { ">=ID": 0 }, select: ["ID"] });
  if (r.__error) return r;
  return { total: r.total };
});

console.log("\nDONE");
