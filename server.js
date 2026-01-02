import express from "express";
import axios from "axios";

const app = express();

// Bitrix может прислать JSON или form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * ВАЖНО:
 * Иногда платформа задаёт env-переменные и Node --env-file их НЕ перезаписывает.
 * Поэтому вводим B24_WEBHOOK_BASE_FILE — его задаём в .env и он имеет приоритет.
 */
const RAW_BASE =
  process.env.B24_WEBHOOK_BASE_FILE ||
  process.env.B24_WEBHOOK_BASE ||
  "";

const B24_WEBHOOK_BASE = RAW_BASE.endsWith("/")
  ? RAW_BASE
  : (RAW_BASE ? `${RAW_BASE}/` : "");

// Маскируем ключ в логах/ответах (не светим секреты)
function maskWebhookBase(base) {
  return base.replace(/\/rest\/(\d+)\/([^/]+)\//, "/rest/$1/***/");
}

if (!B24_WEBHOOK_BASE) {
  throw new Error("B24_WEBHOOK_BASE is not set. Put it in .env or platform env vars.");
}

console.log("[BOOT] Using B24 base:", maskWebhookBase(B24_WEBHOOK_BASE));

function extractTaskId(payload) {
  if (!payload) return null;
  return (
    payload.taskId ||
    payload.TASK_ID ||
    payload.TASKID ||
    payload.ID ||
    payload.data?.taskId ||
    payload.data?.TASK_ID ||
    payload.data?.FIELDS_AFTER?.ID ||
    payload.FIELDS_AFTER?.ID ||
    null
  );
}

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

  const pairs = toFormPairs(params);
  const form = new URLSearchParams();
  for (const [k, v] of pairs) form.append(k, v);

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

function buildNewTitle(childTitle, parentTitle) {
  const suffix = ` | ${parentTitle}`;
  if (childTitle.endsWith(suffix)) return null;

  const baseChild = childTitle.split(" | ")[0].trim();
  return `${baseChild}${suffix}`;
}

// Healthcheck
app.get("/", (req, res) => res.status(200).send("ok"));

// Удобно для проверки из браузера
app.get("/bitrix24/outgoing", (req, res) => {
  res.status(200).send("ok (GET). Webhook should send POST here.");
});

// Debug: показывает, какой base реально используется (ключи замаскированы)
app.get("/debug/env", (req, res) => {
  res.status(200).json({
    hasBase: Boolean(B24_WEBHOOK_BASE),
    baseMasked: maskWebhookBase(B24_WEBHOOK_BASE),
    nodeEnv: process.env.NODE_ENV || null,
    portEnv: process.env.PORT || null,
    baseSource: process.env.B24_WEBHOOK_BASE_FILE
      ? "B24_WEBHOOK_BASE_FILE"
      : (process.env.B24_WEBHOOK_BASE ? "B24_WEBHOOK_BASE" : "none"),
  });
});

app.post("/bitrix24/outgoing", async (req, res) => {
  try {
    console.log("[WEBHOOK] Incoming payload:", JSON.stringify(req.body));

    const taskIdRaw = extractTaskId(req.body);
    if (!taskIdRaw) return res.status(200).send("no taskId");

    const taskId = Number(taskIdRaw);
    if (!Number.isFinite(taskId) || taskId <= 0) return res.status(200).send("invalid taskId");

    // 1) текущая задача
    const t = await b24Call("tasks.task.get", { taskId });
    const task = t?.result?.task;
    if (!task) return res.status(200).send("no task");

    const parentIdRaw = task.parentId ?? task.parentTaskId ?? null;
    if (!parentIdRaw) return res.status(200).send("not a subtask");

    const parentId = Number(parentIdRaw);
    if (!Number.isFinite(parentId) || parentId <= 0) return res.status(200).send("invalid parentId");

    // 2) родитель
    const p = await b24Call("tasks.task.get", { taskId: parentId });
    const parent = p?.result?.task;
    if (!parent) return res.status(200).send("no parent");

    const newTitle = buildNewTitle(task.title, parent.title);
    if (!newTitle) return res.status(200).send("already ok");

    // 3) обновляем
    await b24Call("tasks.task.update", {
      taskId,
      fields: { TITLE: newTitle },
    });

    return res.status(200).send("renamed");
  } catch (e) {
    const msg = e?.message || "unknown_error";
    console.error("[WEBHOOK ERROR]", msg);
    return res.status(200).send(`error: ${msg}`);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
