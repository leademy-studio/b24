import express from "express";
import { b24Call, b24Total, b24ListAll, bitrixConfigured, taskUrl, dealProductIds, taskAdd, webhookUserId } from "./bitrix24.js";
import { taskTemplatesCatalog, renderTaskTemplate } from "./routine-templates.js";

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
      const [groups, parents, recurring] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME", "ACTIVE", "CLOSED"] },
          (x) => x.result?.workgroups || x.result || []
        ),
        // Задачи проекта за месяц (верхнеуровневые родители имеют groupId=gid)
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
      // Родители = верхнеуровневые задачи (без parentId). Подзадачи тянем по PARENT_ID
      // (ловим и подзадачи с битым GROUP_ID = id родителя).
      const parentTasks = parents.filter((t) => !t.parentId || Number(t.parentId) === 0);
      const parentIds = parentTasks.map((p) => Number(p.id));
      const subs = parentIds.length
        ? await b24ListAll(
            "tasks.task.list",
            { filter: { PARENT_ID: parentIds }, select: ["ID", "TITLE", "STATUS", "DEADLINE", "RESPONSIBLE_ID", "PARENT_ID"] },
            (x) => x.result?.tasks || []
          )
        : [];
      const dealIds = recurring.filter((r) => r.ACTIVE === "Y").map((r) => r.DEAL_ID).filter(Boolean);
      const deals = dealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": dealIds }, select: ["ID", "UF_CRM_1727554217", "OPPORTUNITY"] },
            (x) => x.result || []
          )
        : [];
      return { groups, parents: parentTasks, subs, deals };
    });

    const group = d.groups.find((g) => String(g.id) === String(gid));
    const now2 = now;
    const taskObj = (t) => {
      const done = String(t.status) === "5";
      return {
        id: Number(t.id),
        title: t.title,
        url: taskUrl(t.id, t.responsibleId),
        done,
        state: done ? "done" : classifyState(t, now2),
        deadline: t.deadline || null,
      };
    };
    // Подзадачи по родителю
    const subsByParent = new Map();
    for (const s of d.subs) {
      const pid = String(s.parentId);
      if (!subsByParent.has(pid)) subsByParent.set(pid, []);
      subsByParent.get(pid).push(s);
    }
    // Услуга = месячный родитель + его подзадачи
    const SERVICES = ["SEO", "PPC", "Поддержка", "Прочее"];
    const services = d.parents
      .map((p) => {
        const subtasks = (subsByParent.get(String(p.id)) || []).map(taskObj);
        return {
          service: classifyService(p.title),
          parent: taskObj(p),
          subtasks,
          total: subtasks.length,
          done: subtasks.filter((t) => t.done).length,
        };
      })
      .sort((a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service) || a.parent.id - b.parent.id);

    const groupName = new Map(d.groups.map((g) => [String(g.id), g.name]));
    // Активные подписки (регулярные сделки) этого проекта
    const projectDeals = d.deals.filter((x) => String(x.UF_CRM_1727554217) === String(gid));
    const budget = projectDeals.reduce((s, x) => s + (Number(x.OPPORTUNITY) || 0), 0);
    const subscribed = projectDeals.length > 0; // есть активная регулярная сделка
    const otherProjects = [...new Set(d.deals.map((x) => String(x.UF_CRM_1727554217)).filter(Boolean))]
      .filter((id) => id !== String(gid))
      .slice(0, 5)
      .map((id) => ({ id: Number(id), name: groupName.get(id) || "#" + id }));

    res.json({
      id: gid,
      name: group?.name || "Проект #" + gid,
      // «В работе» = есть активная подписка; флаг группы — отдельно
      subscribed,
      groupActive: group ? group.active === "Y" && group.closed !== "Y" : false,
      active: subscribed,
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
          { filter: { "<REAL_STATUS": 5 }, select: ["ID", "TITLE", "DEADLINE", "STATUS", "GROUP_ID", "RESPONSIBLE_ID"] },
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

    // Имена групп + исключение внутренних/тестовых задач (как на экране Задачи),
    // чтобы счётчики Обзора совпадали со сквозным списком.
    const groupName = new Map(data.groups.map((g) => [String(g.id), g.name]));
    const notDone = data.notDone.filter((t) => {
      const name = groupName.get(String(t.groupId));
      return !(name && INTERNAL_RE.test(name));
    });

    // Матрица услуга × состояние по незакрытым задачам
    const SERVICES = ["SEO", "PPC", "Поддержка", "Прочее"];
    const matrix = Object.fromEntries(
      SERVICES.map((s) => [s, { service: s, active: 0, overdue: 0, waiting: 0, total: 0 }])
    );
    let overdue = 0;
    for (const t of notDone) {
      const svc = classifyService(t.title);
      const st = classifyState(t, now);
      matrix[svc][st] += 1;
      matrix[svc].total += 1;
      if (st === "overdue") overdue += 1;
    }
    const matrixRows = SERVICES.map((s) => matrix[s]).filter((r) => r.total > 0);

    const notDoneCount = notDone.length;
    const donePct =
      data.completedThisMonth + notDoneCount > 0
        ? Math.round((data.completedThisMonth / (data.completedThisMonth + notDoneCount)) * 100)
        : 0;

    // Лента: последние незакрытые задачи (по ID)
    const feed = [...notDone]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 6)
      .map((t) => ({
        id: Number(t.id),
        title: t.title,
        url: taskUrl(t.id, t.responsibleId),
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

/** GET /api/finances — бюджеты подписок, оплаты (смарт-счета DT31_9:P), лента платежей. */
const INVOICE_ETID = 31;
const PAID_STAGE = "DT31_9:P";

api.get("/finances", async (_req, res, next) => {
  try {
    const now = new Date();
    const monthStart = monthStartISO(now);
    const d = await cached("finances", async () => {
      const [groups, recurring, paidMonth, paidRecent] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME", "ACTIVE", "CLOSED"] },
          (x) => x.result?.workgroups || x.result || []
        ),
        b24ListAll("crm.deal.recurring.list", { select: ["ID", "DEAL_ID", "ACTIVE"] }, (x) => x.result || []),
        // Оплаченные счета, перешедшие в «оплачен» в этом месяце
        b24ListAll(
          "crm.item.list",
          {
            entityTypeId: INVOICE_ETID,
            filter: { stageId: PAID_STAGE, ">=movedTime": monthStart },
            select: ["id", "opportunity", "parentId2", "companyId", "movedTime"],
          },
          (x) => x.result?.items || []
        ),
        // Последние оплаченные счета (для ленты) — независимо от месяца
        b24ListAll(
          "crm.item.list",
          {
            entityTypeId: INVOICE_ETID,
            filter: { stageId: PAID_STAGE },
            order: { id: "desc" },
            select: ["id", "opportunity", "parentId2", "companyId", "movedTime", "closedate"],
          },
          (x) => x.result?.items || [],
          200
        ),
      ]);

      // Базовые сделки активных подписок → группа + сумма
      const activeRec = recurring.filter((r) => r.ACTIVE === "Y" || r.ACTIVE === true);
      const subDealIds = activeRec.map((r) => r.DEAL_ID).filter(Boolean);
      const subDeals = subDealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": subDealIds }, select: ["ID", "UF_CRM_1727554217", "OPPORTUNITY"] },
            (x) => x.result || []
          )
        : [];

      // Сделки и компании, на которые ссылаются счета (для маппинга счёт→группа и имён)
      const invDealIds = [...new Set([...paidMonth, ...paidRecent].map((i) => i.parentId2).filter(Boolean))];
      const invDeals = invDealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": invDealIds }, select: ["ID", "UF_CRM_1727554217"] },
            (x) => x.result || []
          )
        : [];
      const companyIds = [...new Set(paidRecent.map((i) => i.companyId).filter(Boolean))];
      const companies = companyIds.length
        ? await b24ListAll(
            "crm.company.list",
            { filter: { "@ID": companyIds }, select: ["ID", "TITLE"] },
            (x) => x.result || []
          )
        : [];
      return { groups, subDeals, paidMonth, paidRecent, invDeals, companies };
    });

    const groupName = new Map(d.groups.map((g) => [String(g.id), g.name]));
    const dealToGroup = new Map(d.invDeals.map((x) => [String(x.ID), String(x.UF_CRM_1727554217 || "")]));
    const companyName = new Map(d.companies.map((c) => [String(c.ID), c.TITLE]));

    // Бюджет по группам (активные подписки)
    const budgetByGroup = new Map();
    for (const x of d.subDeals) {
      const g = String(x.UF_CRM_1727554217 || "");
      if (!g) continue;
      budgetByGroup.set(g, (budgetByGroup.get(g) || 0) + (Number(x.OPPORTUNITY) || 0));
    }
    const monthlyBudget = [...budgetByGroup.values()].reduce((s, v) => s + v, 0);

    // Оплачено за месяц по группам (через счёт→сделка→группа)
    const paidByGroup = new Map();
    let paidThisMonth = 0;
    for (const inv of d.paidMonth) {
      const amt = Number(inv.opportunity) || 0;
      paidThisMonth += amt;
      const g = dealToGroup.get(String(inv.parentId2)) || "";
      if (g) paidByGroup.set(g, (paidByGroup.get(g) || 0) + amt);
    }

    // Таблица по проектам с активной подпиской
    const byProject = [...budgetByGroup.keys()]
      .map((g) => {
        const budget = budgetByGroup.get(g) || 0;
        const paid = paidByGroup.get(g) || 0;
        const status = paid <= 0 ? "unpaid" : paid + 0.5 < budget ? "partial" : "paid";
        return { groupId: Number(g), project: groupName.get(g) || "#" + g, budget, paid, status };
      })
      .sort((a, b) => b.budget - a.budget);

    // Лента последних оплат
    const payments = d.paidRecent.slice(0, 12).map((inv) => {
      const g = dealToGroup.get(String(inv.parentId2)) || "";
      return {
        invoiceId: Number(inv.id),
        amount: Number(inv.opportunity) || 0,
        company: companyName.get(String(inv.companyId)) || null,
        dealId: inv.parentId2 ? Number(inv.parentId2) : null,
        project: g ? groupName.get(g) || null : null,
        date: (inv.movedTime || inv.closedate || "").slice(0, 10),
      };
    });

    res.json({
      month: monthLabel(now),
      generatedAt: now.toISOString(),
      kpi: {
        monthlyBudget,
        paidThisMonth,
        awaiting: Math.max(0, monthlyBudget - paidThisMonth),
      },
      byProject,
      payments,
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/tasks — сквозной список незакрытых задач с прямой ссылкой на каждую. */
api.get("/tasks", async (_req, res, next) => {
  try {
    const now = new Date();
    const d = await cached("tasks", async () => {
      const [groups, tasks, users] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME"] },
          (x) => x.result?.workgroups || x.result || []
        ),
        b24ListAll(
          "tasks.task.list",
          {
            filter: { "<REAL_STATUS": 5 },
            select: ["ID", "TITLE", "GROUP_ID", "RESPONSIBLE_ID", "PARENT_ID", "DEADLINE", "STATUS"],
          },
          (x) => x.result?.tasks || []
        ),
        b24ListAll("user.get", { ACTIVE: true }, (x) => x.result || []),
      ]);
      return { groups, tasks, users };
    });

    const groupName = new Map(d.groups.map((g) => [String(g.id), g.name]));
    const userName = new Map(
      d.users.map((u) => [String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || ("#" + u.ID)])
    );
    // Часть подзадач имеет битый GROUP_ID (= id родителя). Группа подзадачи всегда
    // берётся от её родителя (вверх до верхнего уровня), иначе — собственный groupId.
    const taskById = new Map(d.tasks.map((t) => [String(t.id), t]));
    function topParent(t, depth = 0) {
      const pid = String(t.parentId || "0");
      if (depth < 8 && pid !== "0" && taskById.has(pid)) return topParent(taskById.get(pid), depth + 1);
      return t;
    }
    function effGroupId(t) {
      const root = topParent(t);
      const gid = String(root.groupId || "0");
      return gid !== "0" && groupName.has(gid) ? gid : null;
    }
    const rows = d.tasks
      .map((t) => {
        const gid = effGroupId(t);
        return {
          id: Number(t.id),
          title: t.title,
          url: taskUrl(t.id, t.responsibleId),
          project: gid ? groupName.get(gid) || null : null,
          groupId: gid ? Number(gid) : null,
          service: classifyService(t.title),
          responsible: userName.get(String(t.responsibleId)) || null,
          deadline: t.deadline || null,
          state: classifyState(t, now),
          isSub: Number(t.parentId) > 0,
          _root: Number(topParent(t).id), // верхняя задача — для группировки
        };
      })
      .filter((t) => !(t.project && INTERNAL_RE.test(t.project)))
      // Группировка для связности: проект → родительская задача → её подзадачи.
      .sort(
        (a, b) =>
          (a.project || "яяя").localeCompare(b.project || "яяя", "ru") ||
          a._root - b._root ||
          (a.isSub - b.isSub) ||
          a.id - b.id
      )
      .map(({ _root, ...t }) => t);

    res.json({ month: monthLabel(now), total: rows.length, tasks: rows.slice(0, 300) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/subscriptions — реестр «проект × услуга × пакет» из активных регулярных сделок. */
const SERVICE_ENUM = {
  139: "SEO", 141: "PPC", 143: "SMM", 145: "Контент", 147: "Аренда сайта",
  149: "Поддержка", 151: "Разработка", 287: "Комплекс", 293: "Пополнение баланса",
};
const SEO_PKG = { 87: "S", 1805: "M", 1801: "L" };

api.get("/subscriptions", async (_req, res, next) => {
  try {
    const now = new Date();
    const d = await cached("subscriptions", async () => {
      const [groups, recurring] = await Promise.all([
        b24ListAll(
          "socialnetwork.api.workgroup.list",
          { select: ["ID", "NAME"] },
          (x) => x.result?.workgroups || x.result || []
        ),
        b24ListAll(
          "crm.deal.recurring.list",
          { select: ["ID", "DEAL_ID", "ACTIVE", "NEXT_EXECUTION"] },
          (x) => x.result || []
        ),
      ]);
      const activeRec = recurring.filter((r) => r.ACTIVE === "Y" || r.ACTIVE === true);
      const dealIds = activeRec.map((r) => r.DEAL_ID).filter(Boolean);
      const deals = dealIds.length
        ? await b24ListAll(
            "crm.deal.list",
            { filter: { "@ID": dealIds }, select: ["ID", "UF_CRM_1727554217", "UF_CRM_1725984512097", "OPPORTUNITY"] },
            (x) => x.result || []
          )
        : [];
      // Пакет SEO из товаров — только для сделок с услугой SEO (139)
      const pkgByDeal = {};
      for (const deal of deals) {
        const svc = deal.UF_CRM_1725984512097;
        const arr = Array.isArray(svc) ? svc : svc ? [svc] : [];
        if (!arr.map(Number).includes(139)) continue;
        try {
          const pids = await dealProductIds(deal.ID);
          const hit = pids.find((p) => SEO_PKG[p]);
          pkgByDeal[deal.ID] = hit ? SEO_PKG[hit] : "S";
        } catch {
          pkgByDeal[deal.ID] = "S";
        }
      }
      return { groups, activeRec, deals, pkgByDeal };
    });

    const groupName = new Map(d.groups.map((g) => [String(g.id), g.name]));
    const nextByDeal = new Map(d.activeRec.map((r) => [String(r.DEAL_ID), r.NEXT_EXECUTION]));

    const rows = [];
    for (const deal of d.deals) {
      const gid = String(deal.UF_CRM_1727554217 || "");
      const project = gid ? groupName.get(gid) || "#" + gid : deal.TITLE || "Сделка " + deal.ID;
      if (project && INTERNAL_RE.test(project)) continue;
      const svcRaw = deal.UF_CRM_1725984512097;
      const services = (Array.isArray(svcRaw) ? svcRaw : svcRaw ? [svcRaw] : []).map(Number);
      for (const sid of services) {
        rows.push({
          project,
          groupId: gid ? Number(gid) : null,
          service: SERVICE_ENUM[sid] || "Прочее",
          package: sid === 139 ? d.pkgByDeal[deal.ID] || "S" : "—",
          nextExecution: nextByDeal.get(String(deal.ID)) || null,
          active: true,
        });
      }
    }
    rows.sort((a, b) => a.project.localeCompare(b.project, "ru") || a.service.localeCompare(b.service, "ru"));

    res.json({ total: rows.length, subscriptions: rows });
  } catch (e) {
    next(e);
  }
});

/** GET /api/egress-ip — наш исходящий IP (для регистрации в токене T-Bank). */
api.get("/egress-ip", async (_req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    res.json({ egressIp: j.ip });
  } catch (e) {
    res.status(502).json({ error: "probe_failed", message: e?.message || "unknown" });
  }
});

/** GET /api/users — активные сотрудники (для выбора ответственного). */
api.get("/users", async (_req, res, next) => {
  try {
    const users = await cached("users", () => b24ListAll("user.get", { ACTIVE: true }, (x) => x.result || []));
    const list = users
      .map((u) => ({ id: Number(u.ID), name: [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || ("#" + u.ID) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    res.json({ users: list });
  } catch (e) {
    next(e);
  }
});

/** GET /api/task-templates — каталог типов задач (шаблоны описаний). */
api.get("/task-templates", (_req, res) => {
  res.json({ templates: taskTemplatesCatalog() });
});

/**
 * POST /api/task — создать задачу в Bitrix.
 * body: {title, groupId?, responsibleId, parentId?, deadline?, description?, templateKey?, vars?}
 * Если задан templateKey (≠ free) — описание собирается из шаблона на сервере.
 */
api.post("/task", async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = String(b.title || "").trim();
    const responsibleId = Number(b.responsibleId);
    if (!title) return res.status(400).json({ error: "title_required" });
    if (!responsibleId) return res.status(400).json({ error: "responsible_required" });

    const creator = Number(process.env.TASK_LINK_USER_ID || webhookUserId()) || 1;
    const fields = { TITLE: title, CREATED_BY: creator, RESPONSIBLE_ID: responsibleId };
    if (b.groupId && Number(b.groupId)) fields.GROUP_ID = Number(b.groupId);
    if (b.parentId && Number(b.parentId)) fields.PARENT_ID = Number(b.parentId);
    if (b.deadline) fields.DEADLINE = String(b.deadline);

    // Описание: из шаблона (BBCode) либо свободный текст
    const tpl = b.templateKey && b.templateKey !== "free" ? renderTaskTemplate(b.templateKey, b.vars || {}) : null;
    if (tpl) {
      fields.DESCRIPTION = tpl.description;
      fields.DESCRIPTION_IN_BBCODE = tpl.bbcode ? "Y" : "N";
    } else if (b.description) {
      fields.DESCRIPTION = String(b.description);
      fields.DESCRIPTION_IN_BBCODE = "N";
    }

    const id = await taskAdd(fields);
    // сбрасываем кэш проекта/обзора/задач, чтобы новая задача появилась
    for (const k of [...cache.keys()]) {
      if (k === "overview" || k === "tasks" || k.startsWith("project:")) cache.delete(k);
    }
    res.status(201).json({ ok: true, id, url: taskUrl(id, responsibleId) });
  } catch (e) {
    console.error("[POST /api/task]", e?.message || e);
    res.status(502).json({ error: "create_failed", message: e?.message || "unknown" });
  }
});

// Обработчик ошибок роутера — наружу не светим детали
api.use((err, _req, res, _next) => {
  console.error("[API ERROR]", err?.message || err);
  res.status(502).json({ error: "bitrix_call_failed", message: err?.message || "unknown" });
});
