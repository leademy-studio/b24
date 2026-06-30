/* conspect-realism.js — MVP движка реалистичности сроков для задач из конспектов.
 *
 * Сверяет дедлайн черновика с тремя сигналами из плана §6.1:
 *   1) история закрытых задач похожего типа (p50/p80 created→closed);
 *   2) текущая нагрузка исполнителя и просрочки;
 *   3) рабочих дней до предложенного срока.
 *
 * Движок НЕ меняет дедлайн автоматически. Он возвращает verdict + suggested
 * internal/client deadlines для предпросмотра оператором.
 */
import { b24ListAll, bitrixConfigured } from "./bitrix24.js";

const MSK_OFFSET = "+03:00";
const DEFAULT_P80 = {
  web_design: 4,
  web_dev: 4,
  seo: 5,
  ppc: 3,
  content: 3,
  support: 2,
  other: 3,
  "": 3,
};

function val(task, key) {
  return task?.[key] ?? task?.[key.toUpperCase()] ?? null;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return Math.max(0, (b.getTime() - a.getTime()) / 86_400_000);
}

function workdaysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  start.setUTCHours(12, 0, 0, 0);
  end.setUTCHours(12, 0, 0, 0);
  let days = 0;
  while (start < end) {
    start.setUTCDate(start.getUTCDate() + 1);
    const wd = start.getUTCDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

function addWorkdays(anchor, count) {
  const d = new Date(anchor);
  d.setUTCHours(12, 0, 0, 0);
  let left = Math.max(0, Math.ceil(count));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T19:00:00${MSK_OFFSET}`;
}

function percentile(nums, p) {
  if (!nums.length) return null;
  const arr = [...nums].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1);
  return Math.round(arr[idx] * 10) / 10;
}

function classifyType(draft) {
  const dir = draft.direction || "";
  if (dir) return dir;
  const title = String(draft.title || "").toLowerCase();
  if (/директ|реклам|кампан|ppc|google ads|вконтакте|vk/.test(title)) return "ppc";
  if (/seo|семантик|ядр|ссыл|перелинков|страниц|тз|копирайт/.test(title)) return "seo";
  if (/дизайн|макет|figma|баннер|креатив/.test(title)) return "web_design";
  if (/сайт|верст|разработ|правк|интеграц|код/.test(title)) return "web_dev";
  if (/текст|контент|стать/.test(title)) return "content";
  return "other";
}

function cycleDays(task) {
  const created = parseDate(val(task, "createdDate"));
  const closed = parseDate(val(task, "closedDate"));
  if (!created || !closed || closed < created) return null;
  return Math.max(0.5, daysBetween(created, closed));
}

function taskTitle(task) {
  return String(val(task, "title") || "");
}

function activeStats(tasks, responsibleId, deadline) {
  const now = new Date();
  let active = 0;
  let overdue = 0;
  let dueBeforeDeadline = 0;
  for (const t of tasks) {
    if (String(val(t, "responsibleId")) !== String(responsibleId)) continue;
    active++;
    const dl = parseDate(val(t, "deadline"));
    if (dl && dl < now) overdue++;
    if (deadline && dl && dl <= deadline) dueBeforeDeadline++;
  }
  return { active, overdue, dueBeforeDeadline };
}

async function loadBitrixStats(responsibleIds) {
  if (!bitrixConfigured || !responsibleIds.length) return { active: [], closed: [] };
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 180);
  const filterIds = responsibleIds.map(Number).filter(Boolean);
  const [active, closed] = await Promise.all([
    b24ListAll(
      "tasks.task.list",
      {
        filter: { "@RESPONSIBLE_ID": filterIds, "<REAL_STATUS": 5 },
        select: ["ID", "TITLE", "RESPONSIBLE_ID", "DEADLINE", "REAL_STATUS"],
      },
      (x) => x.result?.tasks || [],
      1000
    ),
    b24ListAll(
      "tasks.task.list",
      {
        filter: { "@RESPONSIBLE_ID": filterIds, "=REAL_STATUS": 5, ">=CLOSED_DATE": since.toISOString() },
        select: ["ID", "TITLE", "RESPONSIBLE_ID", "CREATED_DATE", "CLOSED_DATE"],
      },
      (x) => x.result?.tasks || [],
      1000
    ),
  ]);
  return { active, closed };
}

export async function assessDraftsRealism(drafts, opts = {}) {
  const ids = [...new Set((drafts || []).map((d) => Number(d.responsibleId)).filter(Boolean))];
  let stats = { active: [], closed: [] };
  try {
    stats = await loadBitrixStats(ids);
  } catch (e) {
    console.warn("[conspect-realism] Bitrix stats unavailable:", e?.message || e);
  }
  return (drafts || []).map((d) => assessDraft(d, stats, opts));
}

export function assessDraft(draft, stats = {}, opts = {}) {
  const anchor = parseDate(opts.anchorDate ? `${opts.anchorDate}T12:00:00Z` : null) || new Date();
  const deadline = parseDate(draft.deadline);
  const type = classifyType(draft);
  const closedCycles = (stats.closed || [])
    .filter((t) => String(val(t, "responsibleId")) === String(draft.responsibleId))
    .filter((t) => classifyType({ title: taskTitle(t) }) === type)
    .map(cycleDays)
    .filter((x) => x != null);
  const allCycles = (stats.closed || [])
    .filter((t) => String(val(t, "responsibleId")) === String(draft.responsibleId))
    .map(cycleDays)
    .filter((x) => x != null);

  const sourceCycles = closedCycles.length >= 3 ? closedCycles : allCycles;
  const p50 = percentile(sourceCycles, 50);
  const p80 = percentile(sourceCycles, 80) || DEFAULT_P80[type] || DEFAULT_P80.other;
  const load = activeStats(stats.active || [], draft.responsibleId, deadline);
  const workdays = deadline ? workdaysBetween(anchor, deadline) : null;
  const suggestedInternalDeadline = addWorkdays(anchor, p80);
  const bufferDays = Math.min(5, Math.max(1, Math.ceil(((p80 || 3) - (p50 || p80 || 3)) || 1)));
  const suggestedClientDeadline = addWorkdays(parseDate(suggestedInternalDeadline), bufferDays);

  const reasons = [];
  let level = 0; // 0 green, 1 yellow, 2 red
  if (!deadline) {
    level = Math.max(level, 1);
    reasons.push("нет абсолютного дедлайна");
  } else if (workdays < Math.ceil(p80 * 0.6)) {
    level = Math.max(level, 2);
    reasons.push(`до срока ${workdays} раб.дн., p80 типа ${p80} дн.`);
  } else if (workdays < Math.ceil(p80)) {
    level = Math.max(level, 1);
    reasons.push(`срок впритык: ${workdays} раб.дн. при p80 ${p80} дн.`);
  }

  if (load.overdue >= 3 || load.active >= 12) {
    level = Math.max(level, 2);
    reasons.push(`перегруз исполнителя: ${load.active} активных, ${load.overdue} просроченных`);
  } else if (load.overdue >= 1 || load.active >= 8) {
    level = Math.max(level, 1);
    reasons.push(`высокая нагрузка: ${load.active} активных, ${load.overdue} просроченных`);
  }

  if (draft.clientCommitted && deadline && deadline < parseDate(suggestedInternalDeadline)) {
    level = Math.max(level, 2);
    reasons.push("клиенту обещан срок раньше рекомендованного internalDeadline");
  }

  const verdict = level === 2 ? "red" : level === 1 ? "yellow" : "green";
  if (!reasons.length) reasons.push("срок выглядит реалистично по доступным данным");

  return {
    ...draft,
    realism: {
      verdict,
      label: verdict === "red" ? "нереалистично" : verdict === "yellow" ? "впритык" : "реалистично",
      reasons,
      suggestedInternalDeadline,
      suggestedClientDeadline,
      metrics: {
        type,
        historyCount: sourceCycles.length,
        p50Days: p50,
        p80Days: p80,
        workdaysToDeadline: workdays,
        activeTasks: load.active,
        overdueTasks: load.overdue,
        dueBeforeDeadline: load.dueBeforeDeadline,
        bufferDays,
      },
    },
  };
}
