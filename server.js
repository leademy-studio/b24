import express from "express";
import axios from "axios";

const app = express();

// Bitrix может прислать JSON или form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const B24_WEBHOOK_BASE = process.env.B24_WEBHOOK_BASE;
if (!B24_WEBHOOK_BASE) {
  throw new Error("B24_WEBHOOK_BASE is not set. Put it in .env");
}

function extractTaskId(payload) {
  // Подстраховка на разные форматы
  return (
    payload?.taskId ||
    payload?.TASK_ID ||
    payload?.data?.taskId ||
    payload?.data?.TASK_ID ||
    payload?.data?.FIELDS_AFTER?.ID ||
    payload?.FIELDS_AFTER?.ID ||
    payload?.ID ||
    null
  );
}

async function b24Call(method, params) {
  const url = `${B24_WEBHOOK_BASE}${method}.json`;
  const { data } = await axios.post(url, params, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });
  if (data?.error) throw new Error(`${data.error}: ${data.error_description || ""}`);
  return data;
}

function buildNewTitle(childTitle, parentTitle) {
  const suffix = ` | ${parentTitle}`;
  if (childTitle.endsWith(suffix)) return null; // чтобы не зациклиться

  // Чтобы не делать "A | B | C" — берём только первую часть
  const baseChild = childTitle.split(" | ")[0].trim();
  return `${baseChild}${suffix}`;
}

// healthcheck
app.get("/", (req, res) => res.status(200).send("ok"));

app.post("/bitrix24/outgoing", async (req, res) => {
  try {
    const taskId = extractTaskId(req.body);
    if (!taskId) return res.status(200).send("no taskId");

    // 1) текущая задача
    const t = await b24Call("tasks.task.get", { taskId: Number(taskId) });
    const task = t?.result?.task;
    if (!task) return res.status(200).send("no task");

    const parentId = task.parentId ?? task.parentTaskId ?? null;
    if (!parentId) return res.status(200).send("not a subtask");

    // 2) родитель
    const p = await b24Call("tasks.task.get", { taskId: Number(parentId) });
    const parent = p?.result?.task;
    if (!parent) return res.status(200).send("no parent");

    const newTitle = buildNewTitle(task.title, parent.title);
    if (!newTitle) return res.status(200).send("already ok");

    // 3) обновляем
    await b24Call("tasks.task.update", {
      taskId: Number(taskId),
      fields: { TITLE: newTitle },
    });

    return res.status(200).send("renamed");
  } catch (e) {
    // Отвечаем 200, чтобы Битрикс не делал бесконечные повторы
    return res.status(200).send("error");
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
