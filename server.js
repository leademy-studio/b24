import express from "express";
import axios from "axios";

const app = express();

// Bitrix может прислать JSON или form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * ВАЖНО:
 * B24_WEBHOOK_BASE должен быть вида:
 * https://leademy.bitrix24.ru/rest/<user_id>/<token>/
 */
const B24_WEBHOOK_BASE_RAW = process.env.B24_WEBHOOK_BASE || "";
const B24_WEBHOOK_BASE = B24_WEBHOOK_BASE_RAW.endsWith("/")
  ? B24_WEBHOOK_BASE_RAW
  : (B24_WEBHOOK_BASE_RAW ? `${B24_WEBHOOK_BASE_RAW}/` : "");

function safeLogEnvBase() {
  if (!B24_WEBHOOK_BASE) {
    console.error("[BOOT] B24_WEBHOOK_BASE is NOT set");
    return;
  }
  // Логируем только домен/путь без секрета
  // Пример: https://leademy.bitrix24.ru/rest/123/***/
  const masked = B24_WEBHOOK_BASE.replace(/\/rest\/(\d+)\/([^/]+)\//, "/rest/$1/***/");
  console.log("[BOOT] B24_WEBHOOK_BASE =", masked);
}

safeLogEnvBase();

if (!B24_WEBHOOK_BASE) {
  // Лучше падать сразу: иначе вебхуки будут всегда error
  throw new Error("B24_WEBHOOK_BASE is not set. Put it in .env or platform env vars.");
}

/**
 * Достаём taskId из разных возможных структур payload.
 */
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
    payload.data?.FIELDS_BEFORE?.ID ||
    payload.FIELDS_AFTER?.ID ||
    payload.FIELDS_BEFORE?.ID ||
    null
  );
}

/**
 * Превращаем вложенные параметры в form-urlencoded (самый совместимый формат для Bitrix REST).
 * Пример: { taskId: 1, fields: { TITLE: "x" } } =>
 * taskId=1&fields[TITLE]=x
 */
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
      // если вдруг массивы понадобятся
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
    validateStatus: () => true, // сами обработаем статусы
  });

  // Bitrix иногда возвращает 200 с error-полями
  if (!data) throw new Error("Empty response from Bitrix REST");

  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || "no_description"}`);
  }

  return data;
}

function buildNewTitle(childTitle, parentTitle) {
  const suffix = ` | ${parentTitle}`;
  if (childTitle.endsWith(suffix)) return null; // уже ок (защита от цикла)

  // Чтобы не делать "A | B | C" — берём только первую часть
  const baseChild = childTitle.split(" | ")[0].trim();
  return `${baseChild}${suffix}`;
}

// Healthcheck (лучше ставить именно "/" в проверке состояния)
app.get("/", (req, res) => res.status(200).send("ok"));

// Чтобы в браузере не было "Cannot GET /bitrix24/outgoing"
app.get("/bitrix24/outgoing", (req, res) => {
  res.status(200).send("ok (GET). Webhook should send POST here.");
});

app.post("/bitrix24/outgoing", async (req, res) => {
  const startedAt = Date.now();

  try {
    // Для диагностики покажем, что пришло (безопасно: тут нет токенов)
    console.log("[WEBHOOK] Incoming payload:", JSON.stringify(req.body));

    const taskIdRaw = extractTaskId(req.body);
    if (!taskIdRaw) {
      return res.status(200).send("no taskId");
    }

    const taskId = Number(taskIdRaw);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return res.status(200).send("invalid taskId");
    }

    // 1) текущая задача
    const t = await b24Call("tasks.task.get", { taskId });
    const task = t?.result?.task;
    if (!task) return res.status(200).send("no task");

    const parentIdRaw = task.parentId ?? task.parentTaskId ?? null;
    if (!parentIdRaw) return res.status(200).send("not a subtask");

    const parentId = Number(parentIdRaw);
    if (!Number.isFinite(parentId) || parentId <= 0) {
      return res.status(200).send("invalid parentId");
    }

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

    const ms = Date.now() - startedAt;
    console.log(`[WEBHOOK] Renamed taskId=${taskId} in ${ms}ms`);
    return res.status(200).send("renamed");
  } catch (e) {
    // Покажем понятную причину
    const msg = e?.message || "unknown_error";
    console.error("[WEBHOOK ERROR]", msg);

    // Bitrix лучше всегда 200, чтобы не ретраил бесконечно
    return res.status(200).send(`error: ${msg}`);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
