/* conspect-deadlines.js — резолвер дедлайнов и маршрутизация исполнителей
 * для задач из конспектов (см. docs/avtomatizatsiya-konspektov-plan.md §6).
 *
 * Принцип: LLM извлекает только *сигнал* срока (kind/raw/...), а абсолютную
 * дату вычисляет этот детерминированный код от якоря = дата встречи.
 * Время дедлайна — 19:00 МSK; выходные переносятся на ближайший рабочий день.
 *
 * NB: производственный календарь РФ (праздники) подключается отдельным
 * хелпером (isdayoff, см. dashboard-tz §8.3). Здесь — переносы по выходным;
 * для праздников оставлен хук resolveDeadline(..., { isWorkday }).
 */
import { RESP } from "./routine-templates.js";

const MSK_OFFSET = "+03:00";
const DEADLINE_HOUR = 19;

// direction → RESPONSIBLE_ID (план §6.2). Денис=31, Равиль=1 (проверено 2026-06-17).
export const DIRECTION_RESP = {
  web_design: 31,
  web_dev: 1,
  seo: RESP.SEO, // 101
  ppc: RESP.PPC_SUB, // 103
  content: null,
  support: RESP.SUPPORT, // 101
  other: null,
};

// Соисполнители по направлению (PPC: +17).
export const DIRECTION_ACCOMPLICES = {
  ppc: [RESP.PPC_ACCOMPLICE], // 17
};

// Частые имена из созвонов. Полный справочник можно передать через opts.nameMap
// из Bitrix/Firestore; эти алиасы закрывают MVP и проверенные ID из памяти.
const NAME_ALIASES = [
  { re: /(денис|сафонов)/i, id: 31 },
  { re: /(равиль|шакиров)/i, id: 1 },
  { re: /(максим|логвинов)/i, id: RESP.SEO },
  { re: /(владислав|влад|павлишин)/i, id: RESP.PPC_SUB },
  { re: /(святослав)/i, id: RESP.PPC_PARENT },
];

const WEEKDAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function isWeekend(d) {
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
}

/** Сдвиг на ближайший рабочий день (вперёд). isWorkday(dateObj) опционально. */
function bumpToWorkday(d, isWorkday) {
  let i = 0;
  while (i < 14) {
    const ok = isWorkday ? isWorkday(d) : !isWeekend(d);
    if (ok) return d;
    d.setUTCDate(d.getUTCDate() + 1);
    i++;
  }
  return d;
}

/** Собрать ISO-строку дедлайна на 19:00 МSK для даты (UTC y/m/d). */
function atDeadlineHour(y, m, day) {
  const dd = String(day).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${y}-${mm}-${dd}T${String(DEADLINE_HOUR).padStart(2, "0")}:00:00${MSK_OFFSET}`;
}

function toISODateOnly(d) {
  return atDeadlineHour(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Резолвинг сигнала дедлайна в абсолютную дату.
 * @param {object} signal  deadline-объект из извлечения {kind, raw, days, weekday, which, date, cadence}
 * @param {string} anchorDate  дата встречи "YYYY-MM-DD"
 * @param {object} opts  { defaultSlaDays=3, isWorkday? }
 * @returns {{ deadline: string|null, basis: string, recurring: boolean, ambiguous: boolean }}
 */
export function resolveDeadline(signal = {}, anchorDate, opts = {}) {
  const defaultSlaDays = opts.defaultSlaDays ?? 3;
  const isWorkday = opts.isWorkday;
  const kind = signal.kind || "none";
  const anchor = anchorDate ? new Date(`${anchorDate}T12:00:00Z`) : new Date();

  if (kind === "recurring") {
    return { deadline: null, basis: "recurring", recurring: true, ambiguous: false };
  }

  if (kind === "absolute" && signal.date) {
    // Поддержка "YYYY-MM-DD" и "DD.MM[.YYYY]"
    let y, m, d;
    const iso = String(signal.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const ru = String(signal.date).match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
    if (iso) {
      [, y, m, d] = iso.map(Number);
    } else if (ru) {
      d = Number(ru[1]); m = Number(ru[2]);
      y = ru[3] ? Number(ru[3].length === 2 ? "20" + ru[3] : ru[3]) : anchor.getUTCFullYear();
      // нет года → ближайшая будущая относительно встречи
      const cand = new Date(Date.UTC(y, m - 1, d, 12));
      if (!ru[3] && cand < anchor) y += 1;
    } else {
      return { deadline: null, basis: "unparsed_absolute", recurring: false, ambiguous: true };
    }
    const dt = bumpToWorkday(new Date(Date.UTC(y, m - 1, d, 12)), isWorkday);
    return { deadline: toISODateOnly(dt), basis: "absolute", recurring: false, ambiguous: false };
  }

  if (kind === "relative_days") {
    const days = Number(signal.days) || 0;
    const dt = new Date(anchor);
    dt.setUTCDate(dt.getUTCDate() + days);
    return { deadline: toISODateOnly(bumpToWorkday(dt, isWorkday)), basis: "relative_days", recurring: false, ambiguous: false };
  }

  if (kind === "relative_weekday") {
    const target = WEEKDAY_IDX[signal.weekday];
    if (target == null) return { deadline: null, basis: "bad_weekday", recurring: false, ambiguous: true };
    const dt = new Date(anchor);
    // ближайший target-день строго после встречи
    let guard = 0;
    do { dt.setUTCDate(dt.getUTCDate() + 1); guard++; } while (dt.getUTCDay() !== target && guard < 14);
    if (signal.which === "next") dt.setUTCDate(dt.getUTCDate() + 7);
    const ambiguous = !signal.which; // «в пятницу» без эта/следующая
    return { deadline: toISODateOnly(bumpToWorkday(dt, isWorkday)), basis: "relative_weekday", recurring: false, ambiguous };
  }

  // none / неизвестно → дефолт-SLA = встреча + N рабочих дней
  const dt = new Date(anchor);
  let added = 0;
  while (added < defaultSlaDays) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const ok = isWorkday ? isWorkday(dt) : !isWeekend(dt);
    if (ok) added++;
  }
  return { deadline: toISODateOnly(dt), basis: "default_sla", recurring: false, ambiguous: false };
}

/**
 * Маршрутизация исполнителя: направление задаёт ответственного по умолчанию,
 * явно названный человек переопределяет (через nameMap имя→user_id).
 * @returns {{ responsibleId: number|null, accomplices: number[], by: string }}
 */
export function routeAssignee({ direction, assignee }, opts = {}) {
  const nameMap = opts.nameMap || {};
  const fallback = opts.fallbackResponsibleId ?? null;

  // Явно названный человек побеждает направление (план §6.2).
  if (assignee && nameMap[normName(assignee)]) {
    return { responsibleId: nameMap[normName(assignee)], accomplices: [], by: "name" };
  }
  if (assignee) {
    const alias = NAME_ALIASES.find((x) => x.re.test(String(assignee)));
    if (alias) return { responsibleId: alias.id, accomplices: [], by: "name" };
  }
  const byDir = DIRECTION_RESP[direction];
  if (byDir) {
    return { responsibleId: byDir, accomplices: DIRECTION_ACCOMPLICES[direction] || [], by: "direction" };
  }
  return { responsibleId: fallback, accomplices: [], by: fallback ? "fallback" : "none" };
}

function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
