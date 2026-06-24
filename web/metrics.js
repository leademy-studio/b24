/* metrics.js — логика расчёта метрик нагрузки сотрудников для экрана «Сотрудники».
 *
 * Закладывает три расчёта (см. docs/dashboard-ui-struktura.md §4 и dashboard-tz.md §10):
 *   1) Проектов на человека      — distinct GROUP_ID активных задач специалиста.
 *   2) Задач в неделю на человека — среднее и фактическое (последняя неделя) по CLOSED_DATE.
 *   3) Время отписки по задаче    — средний час комментариев (циклическое среднее),
 *                                    второстепенный фактор оценки нагруженности.
 *
 * Функции — чистые: на вход данные в форме ответов Bitrix24 REST, на выходе числа.
 * Источники в проде:
 *   tasks.task.list (RESPONSIBLE_ID, GROUP_ID, STATUS, CLOSED_DATE, CREATED_DATE, DEADLINE)
 *   task.commentitem.getlist (AUTHOR_ID, POST_DATE)   ← время отписки
 * Здесь работают на встроенном демо-датасете (DEMO ниже), результаты пишутся в таблицу.
 */
(function () {
  "use strict";

  // STATUS Bitrix: 2 ждёт, 3 в работе, 4 ждёт контроля, 5 завершена, 6 отложена, 7 отклонена.
  const STATUS_DONE = 5;

  // Нормативы нагрузки (в проде — справочник Firestore, §10.3 ТЗ). Светофор строится от них.
  const NORM = {
    projects: { warn: 6, over: 9 },      // проектов на специалиста
    perWeek: { warn: 12, over: 18 },     // задач/неделю
    lateHour: 18.5,                       // средний час отписки позже → флаг переработки
  };

  /* ---------- утилиты дат ---------- */

  // Толерантный парсер: '2026-06-10 14:32:00', '2026-06-10T14:32:00', '10.06.2026 14:32:00'.
  function parseDate(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4] || 0, +m[5] || 0);
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  // Ключ ISO-недели 'YYYY-Www' — для группировки задач по неделям.
  function isoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;           // пн=1 … вс=7
    d.setUTCDate(d.getUTCDate() + 4 - day);    // четверг текущей недели
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
  }

  /* ---------- 1) Проектов на человека ---------- */
  // Уникальные GROUP_ID активных задач (STATUS<5). {activeOnly:false} — по всем задачам периода.
  function projectsPerPerson(tasks, responsibleId, opts) {
    const activeOnly = !opts || opts.activeOnly !== false;
    const groups = new Set();
    for (const t of tasks) {
      if (String(t.RESPONSIBLE_ID) !== String(responsibleId)) continue;
      if (activeOnly && Number(t.STATUS) >= STATUS_DONE) continue;
      if (t.GROUP_ID && Number(t.GROUP_ID) > 0) groups.add(String(t.GROUP_ID));
    }
    return groups.size;
  }

  /* ---------- 2) Задач в неделю на человека ---------- */
  // Пропускная способность: считаем ТОЛЬКО закрытые задачи (по CLOSED_DATE) по ISO-неделям.
  // Активные WIP сюда не входят (их отражает колонка «Проектов»), иначе среднее завышается.
  // avg — среднее за период, last — факт последней недели, weeks — сколько недель учтено.
  function tasksPerWeek(tasks, responsibleId) {
    const byWeek = new Map();
    for (const t of tasks) {
      if (String(t.RESPONSIBLE_ID) !== String(responsibleId)) continue;
      const d = parseDate(t.CLOSED_DATE);
      if (!d) continue;
      const k = isoWeekKey(d);
      byWeek.set(k, (byWeek.get(k) || 0) + 1);
    }
    const weeks = [...byWeek.keys()].sort();
    if (!weeks.length) return { avg: 0, last: 0, weeks: 0, total: 0 };
    const total = [...byWeek.values()].reduce((a, b) => a + b, 0);
    return {
      avg: Math.round((total / weeks.length) * 10) / 10,
      last: byWeek.get(weeks[weeks.length - 1]),
      weeks: weeks.length,
      total,
    };
  }

  /* ---------- 3) Время отписки по задаче ---------- */
  // Циклическое среднее часа суток по комментариям автора (корректно через полночь).
  // Возвращает {hhmm, hour, count} либо null. Это второстепенный фактор нагруженности.
  function avgCommentTimeOfDay(comments, authorId) {
    let sx = 0, sy = 0, n = 0;
    for (const c of comments) {
      if (String(c.AUTHOR_ID) !== String(authorId)) continue;
      const d = parseDate(c.POST_DATE);
      if (!d) continue;
      const frac = (d.getHours() + d.getMinutes() / 60) / 24;
      const ang = frac * 2 * Math.PI;
      sx += Math.cos(ang);
      sy += Math.sin(ang);
      n += 1;
    }
    if (!n) return null;
    let ang = Math.atan2(sy / n, sx / n);
    if (ang < 0) ang += 2 * Math.PI;
    const hourFloat = (ang / (2 * Math.PI)) * 24;
    const h = Math.floor(hourFloat);
    const mm = Math.round((hourFloat - h) * 60);
    const hh = mm === 60 ? h + 1 : h;
    return {
      hour: hourFloat,
      hhmm: String(hh % 24).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0"),
      count: n,
    };
  }

  /* ---------- сводный светофор нагрузки ---------- */
  // Комбинирует объёмные факторы (проекты, задачи/нед) с поправкой на позднее время отписки.
  function loadFlag(m) {
    let level = 0; // 0 норма, 1 внимание, 2 перегруз
    if (m.projects >= NORM.projects.over || m.perWeekAvg >= NORM.perWeek.over) level = 2;
    else if (m.projects >= NORM.projects.warn || m.perWeekAvg >= NORM.perWeek.warn) level = 1;
    // Поздняя средняя отписка повышает уровень внимания (вторичный фактор), но не «перегруз» сам по себе.
    const late = m.commentHour != null && m.commentHour >= NORM.lateHour;
    if (late && level < 1) level = 1;
    return {
      level,
      late,
      chip: level === 2 ? "chip--warn" : level === 1 ? "chip--warn" : "chip--ok",
      label: level === 2 ? "перегруз" : level === 1 ? "внимание" : "в норме",
    };
  }

  // Полный расчёт по одному специалисту из сырых данных B24.
  function computeForPerson(person, tasks, comments) {
    const projects = projectsPerPerson(tasks, person.id);
    const tpw = tasksPerWeek(tasks, person.id);
    const ct = avgCommentTimeOfDay(comments, person.id);
    const m = {
      projects,
      perWeekAvg: tpw.avg,
      perWeekLast: tpw.last,
      weeks: tpw.weeks,
      commentHHMM: ct ? ct.hhmm : "—",
      commentHour: ct ? ct.hour : null,
      commentCount: ct ? ct.count : 0,
    };
    m.flag = loadFlag(m);
    return m;
  }

  /* =================== ДЕМО-ДАННЫЕ (форма ответов B24) =================== */
  // В проде заменяется на ответы tasks.task.list / task.commentitem.getlist.
  const TEAM = [
    { id: 1, name: "Анна К.", role: "SEO-специалист" },
    { id: 2, name: "Олег В.", role: "PPC-лид" },
    { id: 3, name: "Елена Р.", role: "Account Manager" },
    { id: 4, name: "Дмитрий П.", role: "DevOps" },
  ];

  // Генератор демо-задач: раскладываем закрытия по 4 неделям июня 2026 и активные WIP по проектам.
  const JUNE_WEEKS = ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23"];
  function demoTasks() {
    const rows = [];
    let id = 1000;
    // [responsible, [groupId список активных проектов], недельные закрытия]
    const plan = [
      { r: 1, groups: [101, 102, 103, 104, 105, 106, 107], weekly: [6, 7, 8, 7] }, // Анна: 7 проектов
      { r: 2, groups: [101, 108, 109, 110], weekly: [8, 9, 8, 9] },                  // Олег: 4 проекта
      { r: 3, groups: [102, 103, 104, 105, 106, 107, 108, 109, 110, 101], weekly: [3, 4, 3, 2] }, // Елена: 10
      { r: 4, groups: [111, 112], weekly: [11, 12, 10, 12] },                        // Дмитрий: 2 проекта
    ];
    for (const p of plan) {
      // активные задачи (по одной на проект → distinct GROUP_ID)
      for (const g of p.groups) {
        rows.push({ ID: ++id, RESPONSIBLE_ID: p.r, GROUP_ID: g, STATUS: 3, CREATED_DATE: "2026-06-01 10:00:00" });
      }
      // закрытые задачи по неделям
      p.weekly.forEach((cnt, wi) => {
        for (let i = 0; i < cnt; i++) {
          const base = parseDate(JUNE_WEEKS[wi] + " 12:00:00");
          base.setDate(base.getDate() + (i % 5)); // разносим по будням
          rows.push({
            ID: ++id, RESPONSIBLE_ID: p.r,
            GROUP_ID: p.groups[i % p.groups.length],
            STATUS: STATUS_DONE,
            CLOSED_DATE: base.getFullYear() + "-" + String(base.getMonth() + 1).padStart(2, "0") +
              "-" + String(base.getDate()).padStart(2, "0") + " 15:00:00",
          });
        }
      });
    }
    return rows;
  }

  // Демо-комментарии: задаём «характерный час» отписки на человека + разброс.
  function demoComments() {
    const rows = [];
    let id = 5000;
    const profile = [
      { a: 1, hour: 15, spread: 3, n: 22 }, // Анна — дневная
      { a: 2, hour: 11, spread: 2, n: 28 }, // Олег — утро/первая половина
      { a: 3, hour: 17, spread: 2, n: 14 }, // Елена — вторая половина
      { a: 4, hour: 21, spread: 3, n: 30 }, // Дмитрий — поздние вечера (вторичный флаг)
    ];
    for (const p of profile) {
      for (let i = 0; i < p.n; i++) {
        const h = p.hour + ((i % 5) - 2) * (p.spread / 2); // детерминированный разброс
        const hh = Math.max(0, Math.min(23, Math.round(h)));
        const day = 2 + (i % 20);
        rows.push({
          ID: ++id, AUTHOR_ID: p.a,
          POST_DATE: "2026-06-" + String(day).padStart(2, "0") + " " + String(hh).padStart(2, "0") + ":15:00",
        });
      }
    }
    return rows;
  }

  /* ---------- рендер в экран «Сотрудники» ---------- */
  function renderEmployees() {
    const tbody = document.querySelector("[data-load-metrics]");
    if (!tbody) return; // не на экране сотрудников
    const tasks = demoTasks();
    const comments = demoComments();
    tbody.innerHTML = TEAM.map((p) => {
      const m = computeForPerson(p, tasks, comments);
      const lateMark = m.flag.late
        ? ' <span class="info" title="Средняя отписка позже норматива — вторичный признак переработки">i</span>'
        : "";
      return (
        "<tr>" +
        `<td>${p.name} <span class="muted">· ${p.role}</span></td>` +
        `<td class="num">${m.projects}</td>` +
        `<td class="num">${m.perWeekAvg}</td>` +
        `<td class="num">${m.perWeekLast}</td>` +
        `<td class="num">${m.commentHHMM}${lateMark}</td>` +
        `<td><span class="chip ${m.flag.chip}">${m.flag.label}</span></td>` +
        "</tr>"
      );
    }).join("");
  }

  // Публичный API для будущей привязки к /api/staff-metrics.
  window.LeademyMetrics = {
    projectsPerPerson, tasksPerWeek, avgCommentTimeOfDay, loadFlag, computeForPerson,
    renderEmployees, NORM, _demo: { TEAM, demoTasks, demoComments },
  };

  // Роутер app.js шлёт это событие после вставки экрана в DOM.
  document.addEventListener("screen:render", (e) => {
    if (e.detail && e.detail.id === "employees") renderEmployees();
  });
})();
