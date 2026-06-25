import axios from "axios";

/**
 * Тонкий клиент Bitrix24 REST поверх входящего вебхука.
 * База берётся из env: B24_WEBHOOK_BASE_FILE > B24_WEBHOOK_BASE.
 * (паттерн вызова повторяет server.js / scripts/verify-data.mjs)
 */

const RAW_BASE = process.env.B24_WEBHOOK_BASE_FILE || process.env.B24_WEBHOOK_BASE || "";
const BASE = RAW_BASE ? (RAW_BASE.endsWith("/") ? RAW_BASE : `${RAW_BASE}/`) : "";

export const bitrixConfigured = Boolean(BASE);

export function maskBase(base = BASE) {
  return base.replace(/\/rest\/(\d+)\/([^/]+)\//, "/rest/$1/***/");
}

/** Origin портала из вебхук-базы: https://leademy.bitrix24.ru/rest/1/xxx/ → https://leademy.bitrix24.ru */
export function portalBase() {
  return BASE.replace(/\/rest\/\d+\/[^/]+\/?$/, "");
}

/** Прямая ссылка на задачу (открывается в Bitrix). user/0 → текущий пользователь. */
export function taskUrl(id) {
  const base = portalBase();
  return base ? `${base}/company/personal/user/0/tasks/task/view/${id}/` : null;
}

function toFormPairs(obj, prefix = "", out = []) {
  if (obj == null) return out;
  const isObj = typeof obj === "object" && !Array.isArray(obj);
  if (!isObj) {
    out.push([prefix, String(obj)]);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) toFormPairs(v, key, out);
    else if (Array.isArray(v))
      v.forEach((it, i) => {
        const ak = `${key}[${i}]`;
        if (it && typeof it === "object") toFormPairs(it, ak, out);
        else out.push([ak, String(it)]);
      });
    else out.push([key, String(v)]);
  }
  return out;
}

/** Один REST-вызов. Бросает Error при ответе с ошибкой Bitrix. */
export async function b24Call(method, params = {}) {
  if (!BASE) throw new Error("B24_WEBHOOK_BASE is not set");
  const form = new URLSearchParams();
  for (const [k, v] of toFormPairs(params)) form.append(k, v);
  const { data } = await axios.post(`${BASE}${method}.json`, form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (!data) throw new Error("Empty response from Bitrix REST");
  if (data.error) throw new Error(`${data.error}: ${data.error_description || "no_description"}`);
  return data;
}

/** Только total по list-методу (start:0, нулевой select по возможности). */
export async function b24Total(method, params = {}) {
  const data = await b24Call(method, { ...params, start: 0 });
  return Number(data.total || 0);
}

/**
 * Полный обход list-метода с пагинацией (по 50). pick(data) достаёт массив
 * из ответа (у tasks.task.list это result.tasks, у crm.* — result).
 */
export async function b24ListAll(method, params = {}, pick = (d) => d.result || [], cap = 2000) {
  const out = [];
  let start = 0;
  for (let i = 0; i < cap / 50 + 1; i++) {
    const data = await b24Call(method, { ...params, start });
    const batch = pick(data) || [];
    out.push(...batch);
    if (batch.length < 50 || data.next == null || out.length >= cap) break;
    start = data.next;
  }
  return out;
}

// ===========================================================================
// Хелперы планировщика (генерация рутинных задач)
// ===========================================================================

/** ID базовых сделок активных регулярных шаблонов воронки «Производство». */
export async function recurringActiveDealIds() {
  const rows = await b24ListAll(
    "crm.deal.recurring.list",
    { select: ["ID", "DEAL_ID", "ACTIVE"] },
    (d) => d.result || []
  );
  return rows
    .filter((r) => String(r.ACTIVE).toUpperCase() === "Y" && r.DEAL_ID)
    .map((r) => Number(r.DEAL_ID));
}

/** Полные карточки сделок по списку ID (батчами по 50 через filter @ID). */
export async function dealsByIds(ids, select) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const part = await b24ListAll(
      "crm.deal.list",
      { filter: { "@ID": chunk }, select: select || ["*", "UF_*"] },
      (d) => d.result || []
    );
    out.push(...part);
  }
  return out;
}

/** PRODUCT_ID товарных строк сделки (для определения SEO-пакета). */
export async function dealProductIds(dealId) {
  const data = await b24Call("crm.deal.productrows.get", { id: dealId });
  return (data.result || []).map((p) => Number(p.PRODUCT_ID));
}

/** Нормализация заголовка для сравнения: lower-case + схлопывание пробелов. */
function normTitle(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Ищет задачу с эквивалентным TITLE в группе (для идемпотентности).
 * Сравнение нормализованное (регистронезависимое) и терпимое к префиксам
 * вида «Что-то | <наш заголовок>» — иначе задачи робота с другим регистром
 * имени проекта не дедуплицировались бы и на cutover дали бы дубли.
 * parentId: 0/undefined — корневой родитель; число — подзадача под родителем.
 * Возвращает объект задачи или null.
 */
export async function findTaskByTitle(groupId, title, parentId) {
  const filter = { GROUP_ID: groupId };
  if (parentId != null) filter.PARENT_ID = parentId;
  const tasks = await b24ListAll(
    "tasks.task.list",
    { filter, select: ["ID", "TITLE", "PARENT_ID", "GROUP_ID"] },
    (d) => d.result?.tasks || [],
    1000
  );
  const target = normTitle(title);
  const hit = tasks.find((t) => {
    const cand = normTitle(t.title || t.TITLE);
    // Точное совпадение или наш заголовок после префикса-разделителя «… | <title>».
    return cand === target || cand.endsWith(" | " + target);
  });
  return hit || null;
}

/** Создаёт задачу. fields — поля Bitrix (TITLE/RESPONSIBLE_ID/...). Возвращает id. */
export async function taskAdd(fields) {
  const data = await b24Call("tasks.task.add", { fields });
  const id = data.result?.task?.id;
  if (!id) throw new Error("tasks.task.add: no task id in response");
  return Number(id);
}

/** Личное сообщение владельцу (алерт планировщика). */
export async function imNotifyOwner(dialogId, message) {
  return b24Call("im.message.add", { DIALOG_ID: dialogId, MESSAGE: message });
}

// ===========================================================================
// Хелперы матчера платежей T-Bank (auto NEW → EXECUTING)
// ===========================================================================

/** Карточка сделки по ID (или null). */
export async function dealGet(id) {
  const data = await b24Call("crm.deal.get", { id });
  return data.result || null;
}

/** Перевод сделки на стадию. Возвращает true при успехе. */
export async function dealUpdateStage(id, stageId) {
  const data = await b24Call("crm.deal.update", { id, fields: { STAGE_ID: stageId } });
  return data.result === true;
}

/** ИНН компании из реквизитов (первый непустой RQ_INN) или null. */
export async function companyInn(companyId) {
  const rows = await b24ListAll(
    "crm.requisite.list",
    { filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: companyId }, select: ["ID", "ENTITY_ID", "RQ_INN"] },
    (d) => d.result || []
  );
  for (const r of rows) if (r.RQ_INN) return String(r.RQ_INN).trim();
  return null;
}

/** ID компаний с данным ИНН в реквизитах (ENTITY_TYPE_ID=4). */
export async function companyByInn(inn) {
  const rows = await b24ListAll(
    "crm.requisite.list",
    { filter: { ENTITY_TYPE_ID: 4, RQ_INN: inn }, select: ["ID", "ENTITY_ID", "RQ_INN"] },
    (d) => d.result || []
  );
  return [...new Set(rows.map((r) => Number(r.ENTITY_ID)))];
}

/** Сделки компании в воронке 0 на стадии NEW. */
export async function newDealsByCompany(companyId) {
  return b24ListAll(
    "crm.deal.list",
    {
      filter: { CATEGORY_ID: 0, STAGE_ID: "NEW", COMPANY_ID: companyId },
      select: ["ID", "TITLE", "COMPANY_ID", "OPPORTUNITY", "STAGE_ID", "CATEGORY_ID", "UF_CRM_SUBCONTRACT"],
    },
    (d) => d.result || []
  );
}
