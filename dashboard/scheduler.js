/**
 * Генератор месячных рутинных задач (ТЗ §8).
 *
 * runLaunchMonth({ period, dryRun }) перебирает активные регулярные сделки
 * воронки «Производство», для каждой по выбранным услугам (SEO/PPC/Поддержка)
 * идемпотентно создаёт месячного родителя + типовые подзадачи.
 *
 * dryRun=true (по умолчанию) — НИЧЕГО не создаёт, только строит план.
 */

import {
  recurringActiveDealIds,
  dealsByIds,
  dealProductIds,
  findTaskByTitle,
  taskAdd,
  imNotifyOwner,
  b24Call,
} from "./bitrix24.js";
import { parsePeriod, monthParentDeadline } from "./calendar.js";
import {
  SERVICE,
  SERVICE_LABEL,
  RESP,
  CREATOR_ID,
  OWNER_DIALOG_ID,
  SEO_PACKAGE_PAGES,
  SEO_DEFAULT_PAGES,
  PPC_DEFAULT_PLATFORM,
  monthYearLabel,
  seoSubtasks,
  ppcSubtasks,
} from "./routine-templates.js";

// Поля сделки (см. b24-routine-task-model)
const F_GROUP = "UF_CRM_1727554217";
const F_SERVICES = "UF_CRM_1725984512097";
const F_PROJECT_NAME = "UF_CRM_1726088408701";
const F_SITE = "UF_CRM_1727619728";
const PPC_PLATFORMS_FIELD = process.env.PPC_PLATFORMS_FIELD || "UF_CRM_PPC_PLATFORMS";

const DEAL_SELECT = ["ID", "TITLE", "OPPORTUNITY", F_GROUP, F_SERVICES, F_PROJECT_NAME, F_SITE, PPC_PLATFORMS_FIELD];

// Порядок генерации услуг
const SERVICE_ORDER = [SERVICE.SEO, SERVICE.PPC, SERVICE.SUPPORT];

// --- ленивый кэш enum-меток поля площадок PPC ------------------------------
let _ppcEnumMap = null; // Map<string id, string label> | "absent"
async function ppcPlatformEnumMap() {
  if (_ppcEnumMap !== null) return _ppcEnumMap;
  try {
    const data = await b24Call("crm.deal.userfield.list", {
      filter: { FIELD_NAME: PPC_PLATFORMS_FIELD },
    });
    const field = (data.result || [])[0];
    const list = field?.LIST || [];
    if (!list.length) {
      _ppcEnumMap = "absent";
    } else {
      _ppcEnumMap = new Map(list.map((e) => [String(e.ID), e.VALUE]));
    }
  } catch {
    _ppcEnumMap = "absent";
  }
  return _ppcEnumMap;
}

/** Список меток площадок PPC для сделки (фолбэк — одна Я.Директ). */
async function resolvePpcPlatforms(deal) {
  const raw = deal[PPC_PLATFORMS_FIELD];
  const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!ids.length) return [PPC_DEFAULT_PLATFORM];
  const map = await ppcPlatformEnumMap();
  if (map === "absent") return [PPC_DEFAULT_PLATFORM];
  const labels = ids.map((id) => map.get(String(id))).filter(Boolean);
  return labels.length ? labels : [PPC_DEFAULT_PLATFORM];
}

/** Число SEO-страниц по товарному пакету сделки. */
async function seoPagesForDeal(dealId) {
  let productIds = [];
  try {
    productIds = await dealProductIds(dealId);
  } catch {
    /* нет доступа к товарам — дефолт */
  }
  for (const pid of productIds) {
    if (SEO_PACKAGE_PAGES[pid]) return { pages: SEO_PACKAGE_PAGES[pid], explicit: true };
  }
  return { pages: SEO_DEFAULT_PAGES, explicit: false };
}

/** Описание/ответственный/состав родителя+подзадач для услуги. */
async function buildService(deal, serviceId, ctx) {
  const { monthLabel, region, site } = ctx;
  const label = SERVICE_LABEL[serviceId];
  const parentResp =
    serviceId === SERVICE.PPC ? RESP.PPC_PARENT : RESP.SEO; // SEO и Поддержка → 101

  let subtasks = [];
  let note = null;
  if (serviceId === SERVICE.SEO) {
    const { pages, explicit } = await seoPagesForDeal(deal.ID);
    if (!explicit) note = `пакет SEO не задан товаром — дефолт S=${pages}`;
    subtasks = seoSubtasks({ pages, monthLabel, region, servicesUrl: site || undefined });
  } else if (serviceId === SERVICE.PPC) {
    const platforms = await resolvePpcPlatforms(deal);
    if (platforms.length === 1 && platforms[0] === PPC_DEFAULT_PLATFORM) {
      note = "площадки PPC не заданы — фолбэк: Яндекс Директ";
    }
    subtasks = ppcSubtasks({ platforms, monthLabel, region });
  } else {
    // Поддержка (149) — только родитель, без подзадач
    subtasks = [];
  }
  return { label, parentResp, subtasks, note };
}

/** Поля родителя для tasks.task.add. */
function parentFields(title, groupId, responsibleId, deadlineIso, site, monthLabel, label) {
  const desc = [`Месячный родитель услуги «${label}».`, `Период: ${monthLabel}.`];
  if (site) desc.push(`Сайт: ${site}`);
  return {
    TITLE: title,
    GROUP_ID: groupId,
    RESPONSIBLE_ID: responsibleId,
    CREATED_BY: CREATOR_ID,
    DEADLINE: deadlineIso,
    PARENT_ID: 0,
    DESCRIPTION: desc.join("\n"),
  };
}

/** Поля подзадачи для tasks.task.add. */
function subtaskFields(sub, groupId, parentId, deadlineIso) {
  const f = {
    TITLE: sub.title,
    GROUP_ID: groupId,
    PARENT_ID: parentId,
    RESPONSIBLE_ID: sub.responsibleId,
    CREATED_BY: CREATOR_ID,
    DEADLINE: deadlineIso,
    DESCRIPTION: sub.description,
    DESCRIPTION_IN_BBCODE: sub.bbcode ? "Y" : "N",
  };
  if (sub.accomplices?.length) f.ACCOMPLICES = sub.accomplices;
  return f;
}

/**
 * Главная функция планировщика.
 * @returns {Promise<object>} дерево-результат + summary.
 */
export async function runLaunchMonth({ period: periodInput, dryRun = true } = {}) {
  const period = parsePeriod(periodInput);
  const monthLabel = monthYearLabel(period.year, period.month0);
  const periodStr = `${period.year}-${String(period.month0 + 1).padStart(2, "0")}`;
  const deadline = await monthParentDeadline(period);

  const dealIds = await recurringActiveDealIds();
  const deals = await dealsByIds(dealIds, DEAL_SELECT);
  // порядок как в dealIds
  deals.sort((a, b) => dealIds.indexOf(Number(a.ID)) - dealIds.indexOf(Number(b.ID)));

  const projects = [];
  let parentsPlanned = 0;
  let subtasksPlanned = 0;
  let parentsCreated = 0;
  let subtasksCreated = 0;
  let skipped = 0;
  const errors = [];

  for (const deal of deals) {
    const groupId = Number(deal[F_GROUP]) || null;
    const projectName = deal[F_PROJECT_NAME] || deal.TITLE || `Сделка ${deal.ID}`;
    const siteRaw = deal[F_SITE];
    const site = Array.isArray(siteRaw) ? siteRaw[0] : siteRaw || null;
    const svcRaw = deal[F_SERVICES];
    const services = (Array.isArray(svcRaw) ? svcRaw : svcRaw ? [svcRaw] : []).map(Number);

    const entry = { dealId: Number(deal.ID), groupId, project: projectName, services: [], skipped: [], error: null };

    if (!groupId) {
      entry.error = `нет GROUP_ID (${F_GROUP}) — проект не привязан к группе`;
      errors.push({ dealId: entry.dealId, error: entry.error });
      projects.push(entry);
      continue;
    }

    try {
      for (const serviceId of SERVICE_ORDER) {
        if (!services.includes(serviceId)) continue;
        const { label, parentResp, subtasks, note } = await buildService(deal, serviceId, {
          monthLabel,
          region: undefined,
          site,
        });
        const parentTitle = `${projectName} — ${label} (${monthLabel})`;

        // Идемпотентность: услуга целиком пропускается, если родитель уже есть
        const existing = await findTaskByTitle(groupId, parentTitle, 0);
        if (existing) {
          entry.skipped.push({ service: label, parentTitle, existingTaskId: Number(existing.id || existing.ID) });
          skipped++;
          continue;
        }

        parentsPlanned++;
        subtasksPlanned += subtasks.length;

        const svcResult = {
          service: label,
          parentTitle,
          responsibleId: parentResp,
          deadline: deadline.iso,
          note: note || undefined,
          subtasks: subtasks.map((s) => ({ title: s.title, responsibleId: s.responsibleId, accomplices: s.accomplices })),
        };

        if (!dryRun) {
          const parentId = await taskAdd(
            parentFields(parentTitle, groupId, parentResp, deadline.iso, site, monthLabel, label)
          );
          svcResult.parentTaskId = parentId;
          parentsCreated++;
          for (const sub of subtasks) {
            const subId = await taskAdd(subtaskFields(sub, groupId, parentId, deadline.iso));
            subtasksCreated++;
            const ref = svcResult.subtasks.find((x) => x.title === sub.title && !x.taskId);
            if (ref) ref.taskId = subId;
          }
        }

        entry.services.push(svcResult);
      }
    } catch (e) {
      entry.error = e.message || String(e);
      errors.push({ dealId: entry.dealId, error: entry.error });
    }

    projects.push(entry);
  }

  const result = {
    ok: errors.length === 0,
    period: periodStr,
    monthLabel,
    dryRun,
    deadline: { iso: deadline.iso, calendarFallback: deadline.fallback },
    summary: {
      deals: deals.length,
      parentsPlanned,
      subtasksPlanned,
      parentsCreated,
      subtasksCreated,
      skipped,
      errors: errors.length,
    },
    projects,
    errors,
  };

  // Алерт владельцу — только в боевом режиме и только при ошибках
  if (!dryRun && errors.length) {
    const msg =
      `⚠️ Планировщик launch-month (${periodStr}): ошибок ${errors.length}. ` +
      `Создано родителей ${parentsCreated}, подзадач ${subtasksCreated}. ` +
      errors.map((e) => `сделка ${e.dealId}: ${e.error}`).join("; ");
    try {
      await imNotifyOwner(OWNER_DIALOG_ID, msg);
    } catch (e) {
      console.error("[scheduler] не удалось отправить алерт владельцу:", e.message);
    }
  }

  return result;
}
