/**
 * Производственный календарь РФ для расчёта дедлайнов авто-задач.
 *
 * Правило дедлайна месячного родителя (ТЗ §8.3):
 *   DEADLINE = дата создания (1-е число периода) + 1 месяц + 3 рабочих дня,
 *   время 19:00 по часовому поясу портала Europe/Moscow (UTC+3).
 *
 * Рабочие/выходные дни берём из внешнего календаря isdayoff.ru
 * (учитывает переносы выходных по постановлениям Правительства РФ),
 * строка на год кэшируется в памяти процесса. При недоступности API —
 * фолбэк на «суббота/воскресенье = выходной» (с пометкой в результате).
 */

const MSK_OFFSET = "+03:00";
const yearCache = new Map(); // year -> { data: "0101...", fallback: bool }

/** Загрузка строки дней года из isdayoff.ru. data[i] = '0' рабочий, '1' выходной. */
async function loadYear(year) {
  if (yearCache.has(year)) return yearCache.get(year);
  let entry;
  try {
    const res = await fetch(`https://isdayoff.ru/api/getdata?year=${year}&cc=ru`, {
      signal: AbortSignal.timeout(8000),
    });
    const text = (await res.text()).trim();
    // Валидный ответ — строка из 365/366 символов «0/1»; ошибки приходят как "100" и т.п.
    if (res.ok && /^[01]+$/.test(text) && text.length >= 365) {
      entry = { data: text, fallback: false };
    } else {
      entry = { data: null, fallback: true };
    }
  } catch {
    entry = { data: null, fallback: true };
  }
  yearCache.set(year, entry);
  return entry;
}

/** Порядковый день в году (0-based) для Date в МСК-смысле (используем UTC-поля). */
function dayOfYear(y, m0, d) {
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m0, d);
  return Math.floor((cur - start) / 86400000);
}

/** true, если дата — выходной/праздник РФ. */
async function isDayOff(y, m0, d) {
  const { data } = await loadYear(y);
  if (data) {
    const idx = dayOfYear(y, m0, d);
    const ch = data[idx];
    if (ch === "0") return false;
    if (ch === "1") return true;
  }
  // Фолбэк: сб/вс
  const dow = new Date(Date.UTC(y, m0, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Прибавляет n рабочих дней к дате (по календарю РФ). Возвращает {y, m0, d}.
 * Стартовая дата сама не считается; шагаем вперёд, пропуская выходные.
 */
export async function addWorkingDays(y, m0, d, n) {
  let cur = new Date(Date.UTC(y, m0, d));
  let added = 0;
  let guard = 0;
  while (added < n && guard < 60) {
    guard++;
    cur = new Date(cur.getTime() + 86400000);
    if (!(await isDayOff(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate()))) {
      added++;
    }
  }
  return { y: cur.getUTCFullYear(), m0: cur.getUTCMonth(), d: cur.getUTCDate() };
}

/**
 * Дедлайн месячного родителя для периода period {year, month0}.
 * База = 1-е число периода; +1 месяц; +3 рабочих дня; 19:00 МСК.
 * Возвращает { iso, fallback } где iso — строка для поля DEADLINE.
 */
export async function monthParentDeadline(period) {
  // 1-е число периода + 1 месяц (нормализуется через Date.UTC)
  const base = new Date(Date.UTC(period.year, period.month0 + 1, 1));
  const r = await addWorkingDays(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 3);
  const { fallback } = await loadYear(r.y);
  const mm = String(r.m0 + 1).padStart(2, "0");
  const dd = String(r.d).padStart(2, "0");
  return { iso: `${r.y}-${mm}-${dd}T19:00:00${MSK_OFFSET}`, fallback };
}

/** Разбор period: "YYYY-MM" | undefined(текущий месяц МСК) → { year, month0 }. */
export function parsePeriod(input) {
  if (input) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(input).trim());
    if (!m) throw new Error(`bad period "${input}", expected YYYY-MM`);
    const year = Number(m[1]);
    const month0 = Number(m[2]) - 1;
    if (month0 < 0 || month0 > 11) throw new Error(`bad month in "${input}"`);
    return { year, month0 };
  }
  // Текущий месяц по МСК
  const now = new Date(Date.now() + 3 * 3600000);
  return { year: now.getUTCFullYear(), month0: now.getUTCMonth() };
}
