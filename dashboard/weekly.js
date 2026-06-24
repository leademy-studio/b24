/**
 * Генератор ЕЖЕНЕДЕЛЬНЫХ PPC-подзадач (ТЗ §8.1; rutinnye-podzadachi §10/§11).
 *
 * runLaunchWeekly({ kind, period, runDate, dryRun }) — под текущим месячным
 * PPC-родителем каждого активного PPC-проекта создаёт еженедельную подзадачу:
 *   - optimization (№10): «Оптимизация рекламы в Яндекс Директ» (ср → дедлайн пт, +2 дня)
 *   - feedback     (№11): «Передача конверсионных сигналов» (пн → дедлайн ср, +2 дня),
 *                          только если у сделки UF_CRM_CONV_DATA = «Да» (295)
 *
 * Дедлайн = дата старта + 2 КАЛЕНДАРНЫХ дня, 19:00 МСК (производственный календарь
 * РФ здесь НЕ применяется — фиксированный сдвиг). dryRun=true по умолчанию.
 *
 * Если kind не задан — выводится из дня недели (Пн→feedback, Ср→optimization);
 * в прочие дни без явного kind задачи не создаются.
 */

import { recurringActiveDealIds, dealsByIds, findTaskByTitle, taskAdd } from "./bitrix24.js";
import { parsePeriod } from "./calendar.js";
import {
  SERVICE,
  SERVICE_LABEL,
  RESP,
  CREATOR_ID,
  CONV_DATA_FIELD,
  CONV_DATA_YES,
  WEEKLY_KIND,
  monthYearLabel,
  weeklyTask,
} from "./routine-templates.js";

const F_GROUP = "UF_CRM_1727554217";
const F_SERVICES = "UF_CRM_1725984512097";
const F_PROJECT_NAME = "UF_CRM_1726088408701";
const DEAL_SELECT = ["ID", "TITLE", F_GROUP, F_SERVICES, F_PROJECT_NAME, CONV_DATA_FIELD];

const MSK_OFFSET = "+03:00";

/** «Сегодня» по МСК как {y,m0,d, dow} (dow: 0=вс..6=сб). */
function mskToday(runDate) {
  const base = runDate ? new Date(runDate) : new Date();
  const msk = new Date(base.getTime() + 3 * 3600000);
  return { y: msk.getUTCFullYear(), m0: msk.getUTCMonth(), d: msk.getUTCDate(), dow: msk.getUTCDay() };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Дедлайн = старт + 2 кал. дня, 19:00 МСК. Возвращает ISO. */
function deadlinePlus2(t) {
  const dt = new Date(Date.UTC(t.y, t.m0, t.d) + 2 * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T19:00:00${MSK_OFFSET}`;
}

/** Метка недели для заголовка = дата старта DD.MM.YYYY. */
function weekLabel(t) {
  return `${pad(t.d)}.${pad(t.m0 + 1)}.${t.y}`;
}

/** Какие виды задач создаём сегодня (если kind не задан явно). */
function kindsForWeekday(dow) {
  if (dow === 1) return [WEEKLY_KIND.FEEDBACK]; // понедельник
  if (dow === 3) return [WEEKLY_KIND.OPTIMIZATION]; // среда
  return [];
}

function isConvDataYes(deal) {
  const v = deal[CONV_DATA_FIELD];
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map(String).includes(CONV_DATA_YES);
}

/**
 * @param {object} opts { kind?, period?, runDate?, dryRun=true }
 */
export async function runLaunchWeekly({ kind, period: periodInput, runDate, dryRun = true } = {}) {
  const t = mskToday(runDate);
  const kinds = kind ? [kind] : kindsForWeekday(t.dow);
  const period = parsePeriod(periodInput);
  const monthLabel = monthYearLabel(period.year, period.month0);
  const deadline = deadlinePlus2(t);
  const wLabel = weekLabel(t);

  const base = {
    ok: true,
    kinds,
    weekLabel: wLabel,
    period: `${period.year}-${pad(period.month0 + 1)}`,
    monthLabel,
    deadline,
    dryRun,
    summary: { deals: 0, created: 0, skipped: 0, errors: 0 },
    projects: [],
    errors: [],
  };

  if (!kinds.length) {
    base.note = `сегодня (dow=${t.dow}) нет еженедельных задач и kind не задан`;
    return base;
  }

  const dealIds = await recurringActiveDealIds();
  const deals = (await dealsByIds(dealIds, DEAL_SELECT)).filter((d) => {
    const svc = d[F_SERVICES];
    const arr = Array.isArray(svc) ? svc : svc ? [svc] : [];
    return arr.map(Number).includes(SERVICE.PPC);
  });
  base.summary.deals = deals.length;

  for (const deal of deals) {
    const groupId = Number(deal[F_GROUP]) || null;
    const projectName = deal[F_PROJECT_NAME] || deal.TITLE || `Сделка ${deal.ID}`;
    const entry = { dealId: Number(deal.ID), groupId, project: projectName, created: [], skipped: [], error: null };

    if (!groupId) {
      entry.error = "нет GROUP_ID";
      base.errors.push({ dealId: entry.dealId, error: entry.error });
      base.projects.push(entry);
      continue;
    }

    try {
      // текущий месячный PPC-родитель
      const parentTitle = `${projectName} — ${SERVICE_LABEL[SERVICE.PPC]} (${monthLabel})`;
      const parent = await findTaskByTitle(groupId, parentTitle, 0);
      if (!parent) {
        entry.skipped.push({ reason: "no_monthly_ppc_parent", parentTitle });
        base.summary.skipped++;
        base.projects.push(entry);
        continue;
      }
      const parentId = Number(parent.id || parent.ID);

      for (const k of kinds) {
        if (k === WEEKLY_KIND.FEEDBACK && !isConvDataYes(deal)) {
          entry.skipped.push({ kind: k, reason: "conv_data_not_yes" });
          base.summary.skipped++;
          continue;
        }
        const sub = weeklyTask(k, { weekLabel: wLabel });
        const exists = await findTaskByTitle(groupId, sub.title, parentId);
        if (exists) {
          entry.skipped.push({ kind: k, reason: "already_exists", title: sub.title, taskId: Number(exists.id || exists.ID) });
          base.summary.skipped++;
          continue;
        }
        const rec = { kind: k, title: sub.title, responsibleId: sub.responsibleId, accomplices: sub.accomplices, deadline };
        if (!dryRun) {
          rec.taskId = await taskAdd({
            TITLE: sub.title,
            GROUP_ID: groupId,
            PARENT_ID: parentId,
            RESPONSIBLE_ID: sub.responsibleId,
            CREATED_BY: CREATOR_ID,
            DEADLINE: deadline,
            DESCRIPTION: sub.description,
            DESCRIPTION_IN_BBCODE: sub.bbcode ? "Y" : "N",
            ...(sub.accomplices?.length ? { ACCOMPLICES: sub.accomplices } : {}),
          });
          base.summary.created++;
        }
        entry.created.push(rec);
      }
    } catch (e) {
      entry.error = e.message || String(e);
      base.errors.push({ dealId: entry.dealId, error: entry.error });
    }

    base.projects.push(entry);
  }

  base.ok = base.errors.length === 0;
  return base;
}
