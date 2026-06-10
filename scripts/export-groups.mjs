// One-off exporter: dumps all Bitrix24 workgroups/projects (id + name + type)
// from the portal configured via B24_WEBHOOK_BASE into a Markdown table.
//
// Usage: node --env-file=.env scripts/export-groups.mjs
//
// Reuses the request/encoding conventions of b24Call/toFormPairs in ../server.js.

import axios from "axios";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_PATH = resolve(REPO_ROOT, "docs", "bitrix24-groups.md");

let B24_WEBHOOK_BASE = process.env.B24_WEBHOOK_BASE || "";
if (!B24_WEBHOOK_BASE) {
  console.error("ERROR: B24_WEBHOOK_BASE is not set. Run with: node --env-file=.env scripts/export-groups.mjs");
  process.exit(1);
}
if (!B24_WEBHOOK_BASE.endsWith("/")) B24_WEBHOOK_BASE += "/";

// Recursively flatten nested params into Bitrix form-data pairs (key[a][0]=v).
function toFormPairs(obj, prefix = "", out = []) {
  if (obj === null || obj === undefined) return out;
  const isPlainObject =
    typeof obj === "object" && !Array.isArray(obj) && !(obj instanceof Date);
  if (!isPlainObject) {
    out.push([prefix, String(obj)]);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      toFormPairs(v, key, out);
    } else if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        const arrKey = `${key}[${idx}]`;
        if (typeof item === "object" && item !== null) toFormPairs(item, arrKey, out);
        else out.push([arrKey, String(item)]);
      });
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}

async function b24Call(method, params) {
  const url = `${B24_WEBHOOK_BASE}${method}.json`;
  const form = new URLSearchParams();
  for (const [k, v] of toFormPairs(params)) form.append(k, v);

  const { data } = await axios.post(url, form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (!data) throw new Error("Empty response from Bitrix REST");
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || "no_description"}`);
  }
  return data;
}

// Pull all workgroups via the modern socialnetwork API, paginating on `next`.
async function fetchViaSocialnetwork() {
  const groups = [];
  let start = 0;
  let total = null;
  // Broad always-true filter so closed/archived groups are included too.
  const baseParams = {
    filter: { ">=ID": 0 },
    select: ["ID", "NAME", "TYPE"],
    order: { ID: "ASC" },
  };

  while (true) {
    const data = await b24Call("socialnetwork.api.workgroup.list", { ...baseParams, start });
    const page = data?.result?.workgroups || [];
    for (const g of page) {
      groups.push({ id: g.id ?? g.ID, name: g.name ?? g.NAME, type: g.type ?? g.TYPE ?? "" });
    }
    if (typeof data.total === "number") total = data.total;
    if (data.next === undefined || data.next === null || page.length === 0) break;
    start = data.next;
  }
  return { groups, total: total ?? groups.length, source: "socialnetwork.api.workgroup.list" };
}

// Legacy fallback if the webhook lacks the socialnetwork scope.
async function fetchViaSonetGroup() {
  const groups = [];
  let start = 0;
  while (true) {
    const data = await b24Call("sonet_group.get", { ORDER: { ID: "ASC" }, start });
    const page = Array.isArray(data?.result) ? data.result : [];
    for (const g of page) {
      groups.push({ id: g.ID, name: g.NAME, type: g.PROJECT === "Y" ? "project" : "group" });
    }
    if (data.next === undefined || data.next === null || page.length === 0) break;
    start = data.next;
  }
  return { groups, total: groups.length, source: "sonet_group.get (legacy fallback)" };
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function buildMarkdown({ groups, total, source }) {
  const lines = [];
  lines.push("# Группы Bitrix24 — leademy.bitrix24.ru");
  lines.push("");
  lines.push(`Всего групп: ${total}`);
  lines.push("");
  lines.push(`_Источник: \`${source}\`_`);
  lines.push("");
  lines.push("| ID | Название | Тип |");
  lines.push("|----|----------|-----|");
  for (const g of groups) {
    lines.push(`| ${mdEscape(g.id)} | ${mdEscape(g.name)} | ${mdEscape(g.type)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  let result;
  try {
    result = await fetchViaSocialnetwork();
  } catch (err) {
    const msg = String(err.message || err);
    if (/insufficient_scope|ACCESS_DENIED|METHOD_NOT_FOUND|not found/i.test(msg)) {
      console.warn(`socialnetwork.api.workgroup.list unavailable (${msg}); falling back to sonet_group.get`);
      result = await fetchViaSonetGroup();
    } else {
      throw err;
    }
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, buildMarkdown(result), "utf8");

  console.log(`Exported ${result.groups.length} groups (total reported: ${result.total})`);
  console.log(`Source method: ${result.source}`);
  console.log(`Written to: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Export failed:", err.message || err);
  process.exit(1);
});
