import express from "express";
import { b24Call, b24Total, b24ListAll, bitrixConfigured } from "./bitrix24.js";

/**
 * REST API дашборда поверх Bitrix24 (живые данные).
 * Первый срез: проекты, задачи, матрица услуга×состояние для экрана «Обзор».
 * Финансы (бюджеты/оплаты по сделкам и смарт-счетам) — следующий шаг.
 */

export const api = express.Router();

// --- Маленький TTL-кэш, чтобы не дёргать Bitrix на каждый рендер ---
const CACHE_TTL_MS = 30_000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// --- Справочники/классификаторы ---
const INTERNAL_RE = /leademy|тест|test/i; // внутренние/тестовые группы — не клиентские проекты

function classifyService(title = "") {
  if (/seo/i.test(title)) return "SEO";
  if (/ppc|контекст|директ|реклам/i.test(title)) return "PPC";
  if (/поддержк|админ/i.test(title)) return "Поддержка";
  return "Прочее";
}

// Bitrix task status: 2 ждёт, 3 в работе, 4 условно завершена, 5 завершена, 6 отложена
function classifyState(task, now) {
  const dl = task.deadline ? new Date(task.deadline) : null;
  if (dl && dl < now) return "overdue";
  if (task.status === "2" || task.status === "6") return "waiting";
  return "active";
}

function monthStartISO(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
function monthLabel(d = new Date()) {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Гард: если Bitrix не настроен — отдаём 503, а не падаем
api.use((_req, res, next) => {
  if (!bitrixConfigured) return res.status(503).json({ error: "bitrix_not_configured" });
  next();
});

/** GET /api/projects — клиентские проекты (рабочие группы), без внутренних/тестовых. */
api.get("/projects", async (_req, res, next) => {
  try {
    const data = await cached("projects", async () => {
      const [groups, recurring] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME", "ACTIVE", "CLOSED"] },
          (d) => d.result?.workgroups || d.result || []
        ),
        b24ListAll("crm.deal.recurring.list", { select: ["ID", "DEAL_ID", "ACTIVE"] }, (d) => d.result || []),
      ]);
      const dealIds = recurring.filter((r) => r.ACTIVE === "Y").map((r) => r.DEAL_ID).filter(Boolean);
      const deals = dealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": dealIds }, select: ["ID", "UF_CRM_1727554217"] },
            (d) => d.result || []
          )
        : [];
      return { groups, subIds: new Set(deals.map((x) => String(x.UF_CRM_1727554217)).filter(Boolean)) };
    });
    const projects = data.groups
      .filter((g) => !INTERNAL_RE.test(g.name || ""))
      .map((g) => ({
        id: Number(g.id),
        name: g.name,
        active: g.active === "Y" || g.active === true,
        closed: g.closed === "Y" || g.closed === true,
        subscribed: data.subIds.has(String(g.id)),
      }))
      // проекты с активной подпиской — первыми, дальше по имени
      .sort((a, b) => (b.subscribed - a.subscribed) || a.name.localeCompare(b.name, "ru"));
    res.json({ total: projects.length, projects });
  } catch (e) {
    next(e);
  }
});

/** GET /api/project/:id — детальная карточка проекта: услуги, задачи, бюджет. */
api.get("/project/:id", async (req, res, next) => {
  try {
    const gid = Number(req.params.id);
    if (!gid) return res.status(400).json({ error: "bad_id" });
    const now = new Date();
    const d = await cached("project:" + gid, async () => {
      const [groups, tasks, recurring] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME", "ACTIVE", "CLOSED"] },
          (x) => x.result?.workgroups || x.result || []
        ),
        b24ListAll(
          "tasks.task.list",
          {
            filter: { GROUP_ID: gid, ">=CREATED_DATE": monthStartISO(now) },
            select: ["ID", "TITLE", "STATUS", "DEADLINE", "RESPONSIBLE_ID", "PARENT_ID"],
          },
          (x) => x.result?.tasks || []
        ),
        b24ListAll("crm.deal.recurring.list", { select: ["ID", "DEAL_ID", "ACTIVE"] }, (x) => x.result || []),
      ]);
      const dealIds = recurring.filter((r) => r.ACTIVE === "Y").map((r) => r.DEAL_ID).filter(Boolean);
      const deals = dealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": dealIds }, select: ["ID", "UF_CRM_1727554217", "OPPORTUNITY"] },
            (x) => x.result || []
          )
        : [];
      return { groups, tasks, deals };
    });

    const group = d.groups.find((g) => String(g.id) === String(gid));
    const SERVICES = ["SEO", "PPC", "Поддержка", "Прочее"];
    const svcMap = Object.fromEntries(SERVICES.map((s) => [s, { name: s, total: 0, done: 0, tasks: [] }]));
    for (const t of d.tasks) {
      const m = svcMap[classifyService(t.title)];
      const done = String(t.status) === "5";
      m.total += 1;
      if (done) m.done += 1;
      m.tasks.push({
        id: Number(t.id),
        title: t.title,
        done,
        state: done ? "done" : classifyState(t, now),
        responsible: t.responsible?.name || null,
        deadline: t.deadline || null,
      });
    }
    const services = SERVICES.map((s) => svcMap[s]).filter((s) => s.total > 0);

    const groupName = new Map(d.groups.map((g) => [String(g.id), g.name]));
    const budget = d.deals
      .filter((x) => String(x.UF_CRM_1727554217) === String(gid))
      .reduce((s, x) => s + (Number(x.OPPORTUNITY) || 0), 0);
    const otherProjects = [...new Set(d.deals.map((x) => String(x.UF_CRM_1727554217)).filter(Boolean))]
      .filter((id) => id !== String(gid))
      .slice(0, 5)
      .map((id) => ({ id: Number(id), name: groupName.get(id) || "#" + id }));

    res.json({
      id: gid,
      name: group?.name || "Проект #" + gid,
      active: group ? group.active === "Y" && group.closed !== "Y" : false,
      services,
      budget,
      otherProjects,
      payments: [], // смарт-счёта (DT31_9:P) — следующий шаг финмодуля
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/overview — KPI + матрица услуга×состояние для главного экрана. */
api.get("/overview", async (_req, res, next) => {
  try {
    const now = new Date();
    const data = await cached("overview", async () => {
      const [groups, recurring, notDone, completedThisMonth] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME", "ACTIVE", "CLOSED"] },
          (d) => d.result?.workgroups || d.result || []
        ),
        b24ListAll("crm.deal.recurring.list", { select: ["ID", "DEAL_ID", "ACTIVE"] }, (d) => d.result || []),
        b24ListAll(
          "tasks.task.list",
          { filter: { "<REAL_STATUS": 5 }, select: ["ID", "TITLE", "DEADLINE", "STATUS", "GROUP_ID"] },
          (d) => d.result?.tasks || []
        ),
        b24Total("tasks.task.list", {
          filter: { "=REAL_STATUS": 5, ">=CLOSED_DATE": monthStartISO(now) },
        }),
      ]);

      // Базовые сделки активных recurring → связь с группой (UF_CRM_1727554217) и сумма (OPPORTUNITY)
      const activeRec = recurring.filter((r) => r.ACTIVE === "Y" || r.ACTIVE === true);
      const dealIds = activeRec.map((r) => r.DEAL_ID).filter(Boolean);
      const deals = dealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": dealIds }, select: ["ID", "UF_CRM_1727554217", "OPPORTUNITY"] },
            (d) => d.result || []
          )
        : [];
      return { groups, activeRec, deals, notDone, completedThisMonth };
    });

    // Активные проекты = уникальные группы среди базовых сделок активных recurring-подписок
    const activeGroupIds = new Set(
      data.deals.map((d) => d.UF_CRM_1727554217).filter(Boolean).map(String)
    );
    const activeProjects = activeGroupIds.size;
    const servicesInWork = data.activeRec.length;
    const monthlyBudget = data.deals.reduce((s, d) => s + (Number(d.OPPORTUNITY) || 0), 0);

    // Матрица услуга × состояние по незакрытым задачам
    const SERVICES = ["SEO", "PPC", "Поддержка", "Прочее"];
    const matrix = Object.fromEntries(
      SERVICES.map((s) => [s, { service: s, active: 0, overdue: 0, waiting: 0, total: 0 }])
    );
    let overdue = 0;
    for (const t of data.notDone) {
      const svc = classifyService(t.title);
      const st = classifyState(t, now);
      matrix[svc][st] += 1;
      matrix[svc].total += 1;
      if (st === "overdue") overdue += 1;
    }
    const matrixRows = SERVICES.map((s) => matrix[s]).filter((r) => r.total > 0);

    const notDoneCount = data.notDone.length;
    const donePct =
      data.completedThisMonth + notDoneCount > 0
        ? Math.round((data.completedThisMonth / (data.completedThisMonth + notDoneCount)) * 100)
        : 0;

    // Лента: последние незакрытые задачи (по ID)
    const groupName = new Map(data.groups.map((g) => [String(g.id), g.name]));
    const feed = [...data.notDone]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 6)
      .map((t) => ({
        id: Number(t.id),
        title: t.title,
        project: groupName.get(String(t.groupId)) || null,
        overdue: classifyState(t, now) === "overdue",
      }));

    res.json({
      month: monthLabel(now),
      generatedAt: now.toISOString(),
      kpi: {
        activeProjects,
        servicesInWork,
        donePct,
        overdue,
        tasksNotDone: notDoneCount,
        completedThisMonth: data.completedThisMonth,
        monthlyBudget,
      },
      matrix: matrixRows,
      feed,
    });
  } catch (e) {
    next(e);
  }
});

// Обработчик ошибок роутера — наружу не светим детали
api.use((err, _req, res, _next) => {
  console.error("[API ERROR]", err?.message || err);
  res.status(502).json({ error: "bitrix_call_failed", message: err?.message || "unknown" });
});
