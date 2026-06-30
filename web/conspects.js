/* conspects.js — экран «Конспекты»: приём .txt → разбор (LLM) → черновики
   задач → подтверждение и постановка в Bitrix. Срабатывает по screen:render
   для id === "conspects". См. docs/avtomatizatsiya-konspektov-plan.md. */
(function () {
  "use strict";

  var usersCache = null, projectsCache = null, nameToId = {};
  var current = null; // открытая запись конспекта

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso); if (isNaN(d)) return String(iso).slice(0, 10);
    return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear();
  }
  function el(id) { return document.getElementById(id); }

  var STATUS = {
    to_parse: ["chip--warn", "к разбору"],
    extracted: ["chip--blue", "разобран"],
    tasks_drafted: ["chip--blue", "задачи готовы"],
    done: ["chip--ok", "готово"],
    unassigned: ["chip--warn", "без привязки"],
  };
  var SUBJECT_LABEL = { project: "Проект", prospect: "Прослект", internal: "Внутр.", unassigned: "Без привязки", "": "—" };
  var INTERNAL_CHATS = [
    { direction: "seo", chatId: "chat1363", label: "SEO-продвижение" },
    { direction: "ppc", chatId: "chat2045", label: "PPC-продвижение" },
  ];

  async function apiPost(path, body) {
    var res = await fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { location.replace("login.html"); throw new Error("unauthorized"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }
  async function apiPatch(path, body) {
    var res = await fetch(path, {
      method: "PATCH", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { location.replace("login.html"); throw new Error("unauthorized"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  async function ensureRefs() {
    if (!usersCache) {
      var u = await window.apiGet("/api/users").catch(function () { return { users: [] }; });
      usersCache = u.users || [];
      nameToId = {};
      usersCache.forEach(function (x) { nameToId[String(x.name).toLowerCase()] = x.id; });
    }
    if (!projectsCache) {
      var p = await window.apiGet("/api/projects").catch(function () { return { projects: [] }; });
      projectsCache = p.projects || [];
    }
  }

  function userName(id) {
    var u = (usersCache || []).find(function (x) { return String(x.id) === String(id); });
    return u ? u.name : (id ? "#" + id : "—");
  }

  // ---------------- Список ----------------
  async function loadList() {
    var tb = el("cnpBody");
    try {
      var d = await window.apiGet("/api/conspect/list");
      window._cnpAll = d.conspects || [];
      renderList();
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      if (tb) tb.innerHTML = '<tr><td colspan="6" class="muted">Ошибка загрузки: ' + esc(e.message) + "</td></tr>";
    }
  }

  function renderList() {
    var f = (el("cnpFilter") && el("cnpFilter").value) || "";
    var rows = (window._cnpAll || []).filter(function (c) { return !f || c.status === f; });
    if (el("cnpCount")) el("cnpCount").textContent = "· " + rows.length;
    var tb = el("cnpBody");
    if (!tb) return;
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">Нет конспектов</td></tr>'; return; }
    tb.innerHTML = rows.map(function (c) {
      var s = STATUS[c.status] || ["chip--blue", c.status];
      var subj = SUBJECT_LABEL[c.subjectType] || "—";
      if (c.subjectName) subj += ": " + esc(c.subjectName);
      var name = c.fileName || ("Конспект " + c.id);
      return '<tr class="cnp-row" data-id="' + esc(c.id) + '" style="cursor:pointer">' +
        "<td>" + esc(name) + "</td>" +
        '<td class="c">' + fmtDate(c.date) + "</td>" +
        "<td>" + subj + "</td>" +
        '<td class="c">' + (c.themes || 0) + "</td>" +
        '<td class="c">' + (c.createdCount || 0) + (c.draftCount ? " / " + c.draftCount : "") + "</td>" +
        '<td class="c"><span class="chip ' + s[0] + '">' + s[1] + "</span></td></tr>";
    }).join("");
    tb.querySelectorAll(".cnp-row").forEach(function (tr) {
      tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-id")); });
    });
  }

  // ---------------- Загрузка .txt ----------------
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("read_error")); };
      r.readAsText(file, "utf-8");
    });
  }
  async function handleUpload(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        var text = await readFile(file);
        await apiPost("/api/conspect/ingest", { fileName: file.name, rawText: text, source: "upload" });
      } catch (e) {
        alert("Не удалось загрузить «" + file.name + "»: " + e.message);
      }
    }
    await loadList();
  }

  // ---------------- Карточка / разбор ----------------
  async function openDetail(id) {
    await ensureRefs();
    var rec = await window.apiGet("/api/conspect/" + id).catch(function (e) { alert("Ошибка: " + e.message); return null; });
    if (!rec) return;
    current = rec;
    el("cnpListView").hidden = true;
    var v = el("cnpDetailView");
    v.hidden = false;
    v.innerHTML = renderDetail(rec);
    wireDetail(rec);
  }

  function backToList() {
    current = null;
    el("cnpDetailView").hidden = true;
    el("cnpDetailView").innerHTML = "";
    el("cnpListView").hidden = false;
    loadList();
  }

  function projectOptions(selectedId) {
    return '<option value="">— выберите проект —</option>' + (projectsCache || []).map(function (p) {
      return '<option value="' + p.id + '"' + (String(p.id) === String(selectedId) ? " selected" : "") + ">" + esc(p.name) + "</option>";
    }).join("");
  }
  function userOptions(selectedId) {
    return (usersCache || []).map(function (u) {
      return '<option value="' + u.id + '"' + (String(u.id) === String(selectedId) ? " selected" : "") + ">" + esc(u.name) + "</option>";
    }).join("");
  }

  function internalChatOptions(rec) {
    var selected = rec.internalChatId || "";
    return '<option value="">— выберите чат —</option>' + INTERNAL_CHATS.map(function (x) {
      return '<option value="' + x.chatId + '" data-direction="' + x.direction + '"' + (x.chatId === selected ? " selected" : "") + ">" + esc(x.label) + "</option>";
    }).join("");
  }

  function renderDetail(rec) {
    var s = STATUS[rec.status] || ["chip--blue", rec.status];
    var canTasks = rec.subjectType === "project" || rec.subjectType === "prospect" || rec.subjectType === "internal";
    var hasDrafts = rec.draftTasks && rec.draftTasks.length;
    var h = "";
    h += '<div class="toolbar"><button class="btn btn--light" id="cnpBack" type="button">← Назад</button>' +
      '<span class="spacer"></span><span class="chip ' + s[0] + '">' + s[1] + "</span></div>";

    h += '<div class="card"><h3 class="section__title">' + esc(rec.fileName || "Конспект") + "</h3>";
    h += '<div class="cnp-meta">';
    h += '<label class="field"><span class="field__label">Тип привязки</span><select class="select" id="cnpSubjType">' +
      ["", "project", "prospect", "internal", "unassigned"].map(function (t) {
        return '<option value="' + t + '"' + (t === rec.subjectType ? " selected" : "") + ">" + (SUBJECT_LABEL[t] || "—") + "</option>";
      }).join("") + "</select></label>";
    h += '<label class="field" id="cnpProjWrap"' + (rec.subjectType === "project" || rec.subjectType === "internal" ? "" : " hidden") + '><span class="field__label" id="cnpProjectLabel">' + (rec.subjectType === "internal" ? "Проект по умолчанию" : "Проект") + '</span>' +
      '<select class="select" id="cnpProject">' + projectOptions((rec.subjectType === "project" || rec.subjectType === "internal") ? rec.subjectId : "") + "</select></label>";
    h += '<label class="field" id="cnpDealWrap"' + (rec.subjectType === "prospect" ? "" : " hidden") + '><span class="field__label">ID сделки (прослект)</span>' +
      '<input class="input" id="cnpDeal" type="number" value="' + (rec.subjectType === "prospect" && rec.subjectId ? esc(rec.subjectId) : "") + '"></label>';
    h += '<label class="field" id="cnpChatWrap"' + (rec.subjectType === "internal" ? "" : " hidden") + '><span class="field__label">Чат направления</span>' +
      '<select class="select" id="cnpInternalChat">' + internalChatOptions(rec) + "</select></label>";
    h += '<label class="field"><span class="field__label">Дата встречи</span><input class="input" id="cnpDate" type="date" value="' + esc((rec.date || "").slice(0, 10)) + '"></label>';
    h += '<button class="btn btn--light" id="cnpSaveBind" type="button">Сохранить привязку</button>';
    h += "</div></div>";

    // Действия разбора
    h += '<div class="card"><div class="toolbar"><span class="section__title">Разбор</span><span class="spacer"></span>' +
      '<button class="btn btn--primary" id="cnpExtract" type="button">' + (rec.extracted ? "Перечитать" : "Разобрать конспект") + "</button></div>";
    h += '<div id="cnpExtractOut">' + renderExtracted(rec) + "</div></div>";

    // Задачи
    h += '<div class="card" id="cnpTasksCard"' + (rec.extracted && canTasks ? "" : " hidden") + '>';
    h += '<div class="toolbar"><span class="section__title">Задачи команде</span><span class="spacer"></span>' +
      '<button class="btn btn--light" id="cnpDraft" type="button">Сформировать черновики</button>' +
      '<button class="btn btn--primary" id="cnpConfirm" type="button"' + (hasDrafts ? "" : " hidden") + ">Создать выбранные</button></div>";
    h += '<div id="cnpDrafts">' + renderDrafts(rec.draftTasks, rec.createdTasks) + "</div></div>";

    // Сырой текст
    h += '<div class="card"><details><summary class="muted">Сырой текст конспекта</summary><pre class="tpl-preview__body" style="white-space:pre-wrap">' + esc(rec.rawText || "") + "</pre></details></div>";
    return h;
  }

  function renderExtracted(rec) {
    if (!rec.extracted) return '<div class="muted">Ещё не разобран.</div>';
    var m = rec.extracted.meeting || {};
    var h = '<div class="muted">Тип: ' + esc(m.type === "internal" ? "внутренняя" : "клиентская") +
      " · участники: " + esc((m.participants || []).join(", ") || "—") + "</div>";
    if (m.summary) h += "<p>" + esc(m.summary) + "</p>";
    (rec.extracted.themes || []).forEach(function (t) {
      h += '<div class="cnp-theme"><b>' + esc(t.title) + "</b>";
      if (t.discussion) h += '<div class="muted">' + esc(t.discussion) + "</div>";
      if ((t.tasks || []).length) {
        h += "<ul>" + t.tasks.map(function (x) {
          return "<li>" + esc(x.text) + (x.assignee ? ' <span class="muted">— ' + esc(x.assignee) + "</span>" : "") +
            (x.direction ? ' <span class="chip chip--blue">' + esc(x.direction) + "</span>" : "") +
            (x.deadline && x.deadline.raw ? ' <span class="muted">(' + esc(x.deadline.raw) + ")</span>" : "") + "</li>";
        }).join("") + "</ul>";
      }
      h += "</div>";
    });
    return h;
  }

  function renderDrafts(drafts, created) {
    var h = "";
    if (created && created.length) {
      h += '<div class="muted">Уже создано: ' + created.map(function (c) {
        return '<a class="tlink" href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title) + "</a>";
      }).join(", ") + "</div>";
    }
    if (!drafts || !drafts.length) return h + '<div class="muted">Черновики не сформированы.</div>';
    h += '<table class="table"><thead><tr><th></th><th>Задача</th><th>Ответственный</th><th>Дедлайн</th><th>Реалистичность</th><th>Флаги</th></tr></thead><tbody>';
    h += drafts.map(function (d, i) {
      var flags = [];
      if (d.duplicate) flags.push('<span class="chip chip--warn">дубль</span>');
      if (d.recurring) flags.push('<span class="chip chip--warn">повтор.</span>');
      if (d.ambiguous) flags.push('<span class="chip chip--warn">срок?</span>');
      if (d.clientCommitted) flags.push('<span class="chip chip--err">обещано клиенту</span>');
      if (d.done) flags.push('<span class="chip chip--ok">выполнено</span>');
      var realism = d.realism || {};
      var rClass = realism.verdict === "red" ? "chip--err" : realism.verdict === "yellow" ? "chip--warn" : "chip--ok";
      var rText = realism.label || "—";
      var rDetails = [];
      if (realism.metrics) {
        if (realism.metrics.p80Days) rDetails.push("p80 " + realism.metrics.p80Days + " дн.");
        if (realism.metrics.activeTasks != null) rDetails.push("активных " + realism.metrics.activeTasks);
        if (realism.metrics.overdueTasks) rDetails.push("проср. " + realism.metrics.overdueTasks);
      }
      if (realism.suggestedInternalDeadline) rDetails.push("int " + fmtDate(realism.suggestedInternalDeadline));
      if (realism.suggestedClientDeadline) rDetails.push("client " + fmtDate(realism.suggestedClientDeadline));
      var checked = d.skip ? "" : " checked";
      var dl = d.deadline ? new Date(d.deadline) : null;
      var dlVal = dl && !isNaN(dl) ? dl.toISOString().slice(0, 16) : "";
      return '<tr data-i="' + i + '">' +
        '<td><input type="checkbox" class="cnp-chk"' + checked + "></td>" +
        '<td><input class="input cnp-title" value="' + esc(d.title) + '">' +
          (d.project ? '<div class="muted">' + esc(d.project) + "</div>" : "") +
          (d.theme ? '<div class="muted">' + esc(d.theme) + "</div>" : "") + "</td>" +
        '<td><select class="select cnp-resp">' + userOptions(d.responsibleId) + "</select>" +
          '<div class="muted">' + esc(d.routedBy) + "</div></td>" +
        '<td><input class="input cnp-dl" type="datetime-local" value="' + dlVal + '"></td>' +
        '<td><span class="chip ' + rClass + '">' + esc(rText) + "</span>" +
          (rDetails.length ? '<div class="muted">' + esc(rDetails.join(" · ")) + "</div>" : "") +
          (realism.reasons && realism.reasons.length ? '<div class="muted">' + esc(realism.reasons.join("; ")) + "</div>" : "") + "</td>" +
        "<td>" + (flags.join(" ") || "—") + "</td></tr>";
    }).join("");
    h += "</tbody></table>";
    return h;
  }

  function wireDetail(rec) {
    el("cnpBack").addEventListener("click", backToList);

    var typeSel = el("cnpSubjType");
    typeSel.addEventListener("change", function () {
      el("cnpProjWrap").hidden = typeSel.value !== "project" && typeSel.value !== "internal";
      el("cnpDealWrap").hidden = typeSel.value !== "prospect";
      el("cnpChatWrap").hidden = typeSel.value !== "internal";
      el("cnpProjectLabel").textContent = typeSel.value === "internal" ? "Проект по умолчанию" : "Проект";
    });

    el("cnpSaveBind").addEventListener("click", async function () {
      var t = typeSel.value;
      var body = { subjectType: t, date: el("cnpDate").value || null };
      if (t === "project" || t === "internal") {
        var pid = el("cnpProject").value;
        var p = (projectsCache || []).find(function (x) { return String(x.id) === String(pid); });
        body.subjectId = pid ? Number(pid) : null;
        body.subjectName = p ? p.name : "";
        if (t === "internal") {
          var chat = el("cnpInternalChat");
          var opt = chat.options[chat.selectedIndex];
          body.internalChatId = chat.value || "";
          body.internalDirection = opt ? opt.getAttribute("data-direction") || "" : "";
        }
      } else if (t === "prospect") {
        body.subjectId = el("cnpDeal").value ? Number(el("cnpDeal").value) : null;
        body.internalChatId = "";
        body.internalDirection = "";
      } else { body.subjectId = null; body.subjectName = ""; }
      if (t !== "internal") {
        body.internalChatId = "";
        body.internalDirection = "";
      }
      try {
        await apiPatch("/api/conspect/" + rec.id, body);
        await openDetail(rec.id);
      } catch (e) { alert("Ошибка сохранения: " + e.message); }
    });

    el("cnpExtract").addEventListener("click", async function () {
      var btn = this; btn.disabled = true; btn.textContent = "Разбираю…";
      try {
        await apiPost("/api/conspect/" + rec.id + "/extract", {});
        await openDetail(rec.id);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Разобрать конспект";
        if (e.message === "llm_not_configured") alert("Разбор недоступен: не задан OPENROUTER_API_KEY на сервере.");
        else alert("Ошибка разбора: " + e.message);
      }
    });

    var draftBtn = el("cnpDraft");
    if (draftBtn) draftBtn.addEventListener("click", async function () {
      try {
        var d = await apiPost("/api/conspect/" + rec.id + "/draft-tasks", {});
        rec.draftTasks = d.drafts;
        el("cnpDrafts").innerHTML = renderDrafts(d.drafts, rec.createdTasks);
        el("cnpConfirm").hidden = !(d.drafts && d.drafts.length);
      } catch (e) {
        if (e.message === "not_extracted") alert("Сначала разберите конспект.");
        else if (e.message === "no_tasks_for_subject") alert("Для этого типа привязки задачи не формируются.");
        else if (e.message === "subject_required") alert("Сначала выберите тип привязки: проект или прослект.");
        else if (e.message === "subject_id_required") alert("Сначала выберите проект или укажите ID сделки.");
        else if (e.message === "internal_chat_required") alert("Для внутренней планёрки выберите чат направления.");
        else alert("Ошибка: " + e.message);
      }
    });

    var confirmBtn = el("cnpConfirm");
    if (confirmBtn) confirmBtn.addEventListener("click", async function () {
      var rows = el("cnpDrafts").querySelectorAll("tbody tr");
      var tasks = [];
      rows.forEach(function (tr) {
        if (!tr.querySelector(".cnp-chk").checked) return;
        var i = Number(tr.getAttribute("data-i"));
        var src = rec.draftTasks[i] || {};
        var dlv = tr.querySelector(".cnp-dl").value;
        tasks.push({
          hash: src.hash,
          title: tr.querySelector(".cnp-title").value,
          description: src.description,
          theme: src.theme,
          project: src.project,
          direction: src.direction,
          realism: src.realism,
          clientDeadline: src.realism && src.realism.suggestedClientDeadline,
          responsibleId: Number(tr.querySelector(".cnp-resp").value),
          deadline: dlv ? new Date(dlv).toISOString() : null,
          groupId: src.groupId, dealId: src.dealId,
          accomplices: src.accomplices, clientCommitted: src.clientCommitted,
        });
      });
      if (!tasks.length) return alert("Не выбрано ни одной задачи.");
      confirmBtn.disabled = true; confirmBtn.textContent = "Создаю…";
      try {
        var r = await apiPost("/api/conspect/" + rec.id + "/confirm-tasks", { tasks: tasks });
        var msg = "Создано: " + r.created.length + (r.errors.length ? ", ошибок: " + r.errors.length : "");
        alert(msg);
        await openDetail(rec.id);
      } catch (e) {
        confirmBtn.disabled = false; confirmBtn.textContent = "Создать выбранные";
        if (e.message === "bitrix_not_configured") alert("Постановка недоступна: Bitrix не настроен.");
        else alert("Ошибка: " + e.message);
      }
    });
  }

  // ---------------- Биндинг экрана ----------------
  document.addEventListener("screen:render", function (e) {
    if (!e.detail || e.detail.id !== "conspects") return;
    current = null;
    var dv = el("cnpDetailView"); if (dv) { dv.hidden = true; dv.innerHTML = ""; }
    var lv = el("cnpListView"); if (lv) lv.hidden = false;
    var filt = el("cnpFilter"); if (filt && !filt._wired) { filt._wired = true; filt.addEventListener("change", renderList); }
    var ub = el("cnpUploadBtn"); var fi = el("cnpFileInput");
    if (ub && !ub._wired) { ub._wired = true; ub.addEventListener("click", function () { fi.click(); }); }
    if (fi && !fi._wired) { fi._wired = true; fi.addEventListener("change", function () { if (fi.files && fi.files.length) handleUpload(fi.files); fi.value = ""; }); }
    loadList();
  });
})();
