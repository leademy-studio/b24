/* conspect-api.js — REST для пайплайна конспектов встреч.
 * Монтируется в server.js на /api/conspect (за пользовательским гейтом,
 * но НЕ за bitrix-гардом — список доступен и без Bitrix; постановка задач
 * проверяет bitrixConfigured отдельно).
 *
 * Поток: ingest (.txt) → list/get → bind subject → extract (LLM) →
 *        draft-tasks (резолвер+маршрутизация) → confirm-tasks (Bitrix).
 */
import express from "express";
import {
  putConspect,
  getConspect,
  listConspects,
  summary,
  taskHash,
  parseMeetingFromFilename,
  conspectsBackend,
} from "./conspects-store.js";
import { extractConspect, extractConfigured, extractModel, extractProvider } from "./conspect-extract.js";
import { resolveDeadline, routeAssignee } from "./conspect-deadlines.js";
import { assessDraftsRealism } from "./conspect-realism.js";
import { bitrixConfigured, taskAdd, taskUrl, imNotifyOwner } from "./bitrix24.js";
import { OWNER_DIALOG_ID } from "./routine-templates.js";

export const conspectApi = express.Router();

const OWNER_RESP_ID = Number(process.env.CONSPECT_OWNER_ID || 1); // Равиль Шакиров
const INTERNAL_CHATS = {
  seo: "chat1363",
  ppc: "chat2045",
};

function fail(res, code, status = 400, extra = {}) {
  return res.status(status).json({ error: code, ...extra });
}

/** GET /api/conspect/health — статус модуля (для диагностики). */
conspectApi.get("/health", (_req, res) => {
  res.json({ ok: true, backend: conspectsBackend, extractConfigured, extractProvider, extractModel, bitrixConfigured });
});

/** POST /api/conspect/ingest — принять сырой конспект.
 * body: { fileName, rawText, source?, participants?, date?, subjectType?, subjectId?, subjectName? } */
conspectApi.post("/ingest", async (req, res, next) => {
  try {
    const b = req.body || {};
    const rawText = String(b.rawText || "").trim();
    if (!rawText) return fail(res, "raw_text_required");
    const fromName = parseMeetingFromFilename(b.fileName || "");
    const rec = await putConspect({
      source: b.source || "upload",
      fileName: b.fileName || "",
      rawText,
      date: b.date || fromName.date || null,
      participants: Array.isArray(b.participants) ? b.participants : [],
      subjectType: b.subjectType || "",
      subjectId: b.subjectId ?? null,
      subjectName: b.subjectName || "",
      internalDirection: b.internalDirection || "",
      internalChatId: b.internalChatId || "",
      status: "to_parse",
    });
    res.status(201).json({ ok: true, id: rec.id, conspect: summary(rec) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/conspect/list — карточки (новые первыми). */
conspectApi.get("/list", async (_req, res, next) => {
  try {
    const all = await listConspects();
    res.json({ total: all.length, conspects: all.map(summary) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/conspect/:id — полная запись. */
conspectApi.get("/:id", async (req, res, next) => {
  try {
    const rec = await getConspect(req.params.id);
    if (!rec) return fail(res, "not_found", 404);
    res.json(rec);
  } catch (e) {
    next(e);
  }
});

/** PATCH /api/conspect/:id — обновить привязку/метаданные. */
conspectApi.patch("/:id", async (req, res, next) => {
  try {
    const rec = await getConspect(req.params.id);
    if (!rec) return fail(res, "not_found", 404);
    const b = req.body || {};
    for (const k of ["subjectType", "subjectId", "subjectName", "date", "status", "internalDirection", "internalChatId"]) {
      if (k in b) rec[k] = b[k];
    }
    if (Array.isArray(b.participants)) rec.participants = b.participants;
    const saved = await putConspect(rec);
    res.json({ ok: true, conspect: summary(saved) });
  } catch (e) {
    next(e);
  }
});

/** POST /api/conspect/:id/extract — Этап 1: извлечь структуру (LLM). */
conspectApi.post("/:id/extract", async (req, res, next) => {
  try {
    if (!extractConfigured) return fail(res, "llm_not_configured", 503);
    const rec = await getConspect(req.params.id);
    if (!rec) return fail(res, "not_found", 404);
    const extracted = await extractConspect(rec.rawText, {
      project: rec.subjectName || "",
      date: rec.date || "",
    });
    rec.extracted = extracted;
    if (!rec.date && extracted.meeting?.date) rec.date = extracted.meeting.date;
    rec.status = "extracted";
    const saved = await putConspect(rec);
    res.json({ ok: true, extracted, conspect: summary(saved) });
  } catch (e) {
    if (e.code === "llm_not_configured") return fail(res, "llm_not_configured", 503);
    if (e.code === "empty_raw_text") return fail(res, "empty_raw_text");
    console.error("[conspect/extract]", e?.response?.data || e?.message || e);
    return fail(res, "extract_failed", 502, { message: e?.message || "unknown" });
  }
});

/** Собрать черновики задач из извлечённого JSON (резолвер + маршрутизация). */
function buildDrafts(rec) {
  const anchor = rec.date || rec.extracted?.meeting?.date || null;
  const existing = new Set((rec.createdTasks || []).map((t) => t.hash));
  const seen = new Set();
  const groupId = (rec.subjectType === "project" || rec.subjectType === "internal") && rec.subjectId ? Number(rec.subjectId) : null;
  const dealId = rec.subjectType === "prospect" && rec.subjectId ? Number(rec.subjectId) : null;
  const drafts = [];
  for (const theme of rec.extracted?.themes || []) {
    for (const t of theme.tasks || []) {
      if (!t.text || !t.text.trim()) continue;
      const dl = resolveDeadline(t.deadline, anchor, { defaultSlaDays: 3 });
      const route = routeAssignee(
        { direction: t.direction, assignee: t.assignee },
        { fallbackResponsibleId: OWNER_RESP_ID }
      );
      const hash = taskHash({ subjectId: rec.subjectId, date: anchor, text: t.text });
      const duplicate = existing.has(hash) || seen.has(hash);
      seen.add(hash);
      const description = [
        `Задача сформирована из конспекта встречи${anchor ? " от " + anchor : ""}.`,
        rec.subjectName ? `Проект/клиент: ${rec.subjectName}.` : "",
        theme.title ? `Тема: ${theme.title}.` : "",
        theme.discussion ? `Контекст: ${theme.discussion}` : "",
        t.deadline?.raw ? `Срок из разговора: ${t.deadline.raw}.` : "",
        t.clientCommitted ? "Срок был озвучен клиенту: да." : "",
        t.deadlineProvisional ? "Срок предварительный: да." : "",
      ].filter(Boolean).join("\n");
      drafts.push({
        hash,
        theme: theme.title,
        project: theme.project || rec.subjectName || rec.extracted?.meeting?.project || "",
        title: t.text.trim(),
        description,
        direction: t.direction || "",
        assignee: t.assignee || "",
        responsibleId: route.responsibleId,
        accomplices: route.accomplices,
        routedBy: route.by,
        deadline: dl.deadline,
        deadlineBasis: dl.basis,
        recurring: dl.recurring,
        ambiguous: dl.ambiguous,
        clientCommitted: Boolean(t.clientCommitted),
        deadlineProvisional: Boolean(t.deadlineProvisional),
        done: Boolean(t.done),
        groupId,
        dealId,
        duplicate,
        skip: duplicate || Boolean(t.done) || dl.recurring,
      });
    }
  }
  return drafts;
}

/** POST /api/conspect/:id/draft-tasks — Этап 3 (предпросмотр, без записи в Bitrix). */
conspectApi.post("/:id/draft-tasks", async (req, res, next) => {
  try {
    const rec = await getConspect(req.params.id);
    if (!rec) return fail(res, "not_found", 404);
    if (!rec.extracted) return fail(res, "not_extracted");
    if (rec.subjectType === "unassigned") {
      return fail(res, "no_tasks_for_subject", 409, { subjectType: rec.subjectType });
    }
    if (rec.subjectType !== "project" && rec.subjectType !== "prospect" && rec.subjectType !== "internal") {
      return fail(res, "subject_required", 409);
    }
    if ((rec.subjectType === "project" || rec.subjectType === "prospect" || rec.subjectType === "internal") && !rec.subjectId) {
      return fail(res, "subject_id_required", 409, { subjectType: rec.subjectType });
    }
    if (rec.subjectType === "internal" && !internalChatId(rec)) {
      return fail(res, "internal_chat_required", 409);
    }
    const drafts = await assessDraftsRealism(buildDrafts(rec), {
      anchorDate: rec.date || rec.extracted?.meeting?.date || null,
    });
    rec.draftTasks = drafts;
    rec.status = "tasks_drafted";
    await putConspect(rec);
    res.json({ ok: true, drafts });
  } catch (e) {
    next(e);
  }
});

/** POST /api/conspect/:id/confirm-tasks — создать подтверждённые задачи в Bitrix.
 * body: { tasks: [{ title, responsibleId, deadline?, groupId?, dealId?, accomplices?, description?, hash? }] } */
conspectApi.post("/:id/confirm-tasks", async (req, res, next) => {
  try {
    if (!bitrixConfigured) return fail(res, "bitrix_not_configured", 503);
    const rec = await getConspect(req.params.id);
    if (!rec) return fail(res, "not_found", 404);
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!tasks.length) return fail(res, "no_tasks");

    const creator = Number(process.env.TASK_LINK_USER_ID || 1) || 1;
    const created = [];
    const errors = [];
    const existing = new Set((rec.createdTasks || []).map((t) => t.hash));

    for (const t of tasks) {
      const title = String(t.title || "").trim();
      const responsibleId = Number(t.responsibleId);
      if (!title || !responsibleId) {
        errors.push({ title, error: "missing_title_or_responsible" });
        continue;
      }
      if (t.hash && existing.has(t.hash)) {
        errors.push({ title, error: "duplicate_skipped" });
        continue;
      }
      const fields = { TITLE: title, CREATED_BY: creator, RESPONSIBLE_ID: responsibleId };
      if (t.groupId && Number(t.groupId)) fields.GROUP_ID = Number(t.groupId);
      if (t.deadline) fields.DEADLINE = String(t.deadline);
      if (Array.isArray(t.accomplices) && t.accomplices.length) fields.ACCOMPLICES = t.accomplices.map(Number);
      if (t.dealId && Number(t.dealId)) fields.UF_CRM_TASK = [`D_${Number(t.dealId)}`];
      const descrParts = [];
      if (t.description) {
        // Описание уже собрано в buildDrafts (источник/проект/тема/контекст) — не дублируем.
        descrParts.push(String(t.description));
      } else {
        descrParts.push(`Источник: конспект встречи${rec.date ? " от " + rec.date : ""}.`);
      }
      if (t.clientCommitted && t.deadline) descrParts.push(`Срок (internalDeadline): ${String(t.deadline).slice(0, 10)}.`);
      if (t.clientDeadline) descrParts.push(`Рекомендованный clientDeadline: ${String(t.clientDeadline).slice(0, 10)}.`);
      if (t.realism?.label) {
        const reasons = Array.isArray(t.realism.reasons) ? t.realism.reasons.join("; ") : "";
        descrParts.push(`Реалистичность срока: ${t.realism.label}${reasons ? " — " + reasons : ""}.`);
      }
      fields.DESCRIPTION = descrParts.join("\n");
      fields.DESCRIPTION_IN_BBCODE = "N";

      try {
        const id = await taskAdd(fields);
        const entry = {
          hash: t.hash || taskHash({ subjectId: rec.subjectId, date: rec.date, text: title }),
          taskId: id,
          url: taskUrl(id, responsibleId),
          title,
          responsibleId,
          theme: t.theme || "",
          project: t.project || "",
          direction: t.direction || "",
        };
        created.push(entry);
        existing.add(entry.hash);
      } catch (e) {
        console.error("[conspect/confirm-tasks]", e?.message || e);
        errors.push({ title, error: "create_failed", message: e?.message });
      }
    }

    rec.createdTasks = [...(rec.createdTasks || []), ...created];
    if (created.length) rec.status = "done";
    await putConspect(rec);

    if (created.length && rec.subjectType === "internal") {
      try {
        await imNotifyOwner(internalChatId(rec), renderInternalBbcode(rec, created, tasks));
      } catch (e) {
        console.warn("[conspect/confirm-tasks] internal chat post failed:", e?.message || e);
        errors.push({ error: "internal_chat_post_failed", message: e?.message });
      }
    } else if (created.length) {
      try {
        const lines = created.map((c, i) => `${i + 1}. [url=${c.url}]${c.title}[/url]`);
        await imNotifyOwner(
          OWNER_DIALOG_ID,
          `Из конспекта${rec.date ? " от " + rec.date : ""} создано задач: ${created.length}\n` + lines.join("\n")
        );
      } catch (e) {
        console.warn("[conspect/confirm-tasks] notify failed:", e?.message || e);
      }
    }

    res.status(201).json({ ok: true, created, errors });
  } catch (e) {
    next(e);
  }
});

function internalChatId(rec) {
  if (rec.internalChatId) return rec.internalChatId;
  return INTERNAL_CHATS[rec.internalDirection] || "";
}

function bb(s) {
  return String(s || "")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

function renderInternalBbcode(rec, created, submittedTasks) {
  const byHash = new Map((submittedTasks || []).map((t) => [String(t.hash || ""), t]));
  const rows = created.map((c) => ({ ...c, ...(byHash.get(String(c.hash || "")) || {}) }));
  const groups = new Map();
  for (const row of rows) {
    const key = row.project || row.theme || rec.subjectName || "Внутренняя планёрка";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const lines = [];
  lines.push(`[b]Внутренняя планёрка${rec.date ? " от " + rec.date : ""}[/b]`);
  const summaryText = rec.extracted?.meeting?.summary || "";
  if (summaryText) lines.push(bb(summaryText));
  lines.push("");

  for (const [project, tasks] of groups) {
    lines.push(`[color=#14274E][b]${bb(project).toUpperCase()}[/b][/color]`);
    tasks.forEach((task, i) => {
      const url = task.url || taskUrl(task.taskId, task.responsibleId);
      const title = bb(task.title);
      lines.push(`${i + 1}. ${url ? `[url=${url}]${title}[/url]` : title}`);
    });
    lines.push("");
  }

  return lines.join("\n").trim();
}

// Локальный обработчик ошибок роутера
conspectApi.use((err, _req, res, _next) => {
  console.error("[conspect-api]", err?.message || err);
  res.status(500).json({ error: "internal_error" });
});
