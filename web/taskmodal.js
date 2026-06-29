/* taskmodal.js — модальное окно создания задачи (POST /api/task).
   Поддерживает шаблоны описаний (тип задачи → поля → авто-описание BBCode).
   Открывается через window.openTaskModal({ groupId, projectName }). */
(function () {
  "use strict";

  var modal, form, msg, submitBtn;
  var projectsCache = null, usersCache = null, templatesCache = null;
  var currentTpl = null; // выбранный шаблон

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function showMsg(text, kind) {
    if (!msg) return;
    msg.className = "modal__msg" + (kind ? " modal__msg--" + kind : "");
    msg.innerHTML = text;
    msg.hidden = false;
  }
  function clearMsg() { if (msg) { msg.hidden = true; msg.innerHTML = ""; } }
  function close() { if (modal) modal.hidden = true; clearMsg(); }

  // --- справочники ---
  async function fillProjects(selectedGid) {
    if (!projectsCache) {
      var d = await window.apiGet("/api/projects");
      projectsCache = (d.projects || []).filter(function (p) { return p.active; });
    }
    var sel = $("tmProject");
    sel.innerHTML = projectsCache.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + "</option>"; }).join("");
    if (selectedGid) sel.value = String(selectedGid);
  }
  async function fillUsers() {
    if (!usersCache) { var d = await window.apiGet("/api/users"); usersCache = d.users || []; }
    $("tmResponsible").innerHTML =
      '<option value="">— выберите —</option>' +
      usersCache.map(function (u) { return '<option value="' + u.id + '">' + esc(u.name) + "</option>"; }).join("");
  }
  async function fillTemplates() {
    if (!templatesCache) { var d = await window.apiGet("/api/task-templates"); templatesCache = d.templates || []; }
    $("tmTemplate").innerHTML = templatesCache.map(function (t) { return '<option value="' + t.key + '">' + esc(t.label) + "</option>"; }).join("");
  }
  async function fillParents(gid) {
    var sel = $("tmParent");
    sel.innerHTML = '<option value="">— без родителя —</option>';
    if (!gid) return;
    try {
      var d = await window.apiGet("/api/project/" + gid);
      (d.services || []).forEach(function (s) {
        if (s.parent && s.parent.id) {
          var name = String(s.parent.title || s.service).split(" | ")[0];
          sel.innerHTML += '<option value="' + s.parent.id + '">' + esc(name) + "</option>";
        }
      });
    } catch (e) { /* без родителей */ }
  }

  // --- шаблон: поля + предпросмотр ---
  function clientFill(body, vars) {
    return String(body || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (m, k) {
      var key = k.trim();
      return vars[key] != null && vars[key] !== "" ? vars[key] : m;
    });
  }
  function collectVars() {
    var vars = {};
    if (!currentTpl) return vars;
    (currentTpl.fields || []).forEach(function (f) {
      var el = $("tmf_" + f.key.replace(/\s+/g, "_"));
      if (el) vars[f.key] = el.value;
    });
    return vars;
  }
  function updatePreview() {
    if (!currentTpl || currentTpl.freeText) return;
    var pre = $("tmPreview");
    if (pre) pre.textContent = clientFill(currentTpl.body, collectVars());
  }
  function renderTplFields() {
    var box = $("tmTplFields");
    box.innerHTML = "";
    if (!currentTpl || currentTpl.freeText) return;
    (currentTpl.fields || []).forEach(function (f) {
      var id = "tmf_" + f.key.replace(/\s+/g, "_");
      var wrap = document.createElement("label");
      wrap.className = "field";
      var def = f.default != null ? String(f.default) : "";
      var ph = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "";
      wrap.innerHTML =
        '<span class="field__label">' + esc(f.label) + (f.required ? " *" : "") + "</span>" +
        '<input class="input" id="' + id + '" type="' + (f.type === "number" ? "number" : "text") + '" value="' + esc(def) + '"' + ph + ">";
      box.appendChild(wrap);
      wrap.querySelector("input").addEventListener("input", updatePreview);
    });
  }
  function onTemplateChange(keepTitle) {
    var key = $("tmTemplate").value;
    currentTpl = (templatesCache || []).find(function (t) { return t.key === key; }) || null;
    var isFree = !currentTpl || currentTpl.freeText;
    // подсказка названия
    if (!keepTitle && currentTpl && currentTpl.titleSuggest) {
      var titleEl = $("tmTitle");
      if (!titleEl.value || titleEl.dataset.suggested === "1") {
        titleEl.value = currentTpl.titleSuggest;
        titleEl.dataset.suggested = "1";
      }
    }
    $("tmDescField").hidden = !isFree;       // свободное описание только для «Свободной»
    $("tmTplFields").hidden = isFree;
    $("tmPreviewWrap").hidden = isFree;
    renderTplFields();
    updatePreview();
  }

  window.openTaskModal = async function (opts) {
    opts = opts || {};
    if (!modal) return;
    form.reset();
    clearMsg();
    submitBtn.disabled = false;
    $("tmTitle").dataset.suggested = "";
    modal.hidden = false;
    try {
      await Promise.all([fillProjects(opts.groupId), fillUsers(), fillTemplates()]);
      await fillParents($("tmProject").value);
      onTemplateChange(true); // дефолт — «Свободная»
      $("tmTitle").focus();
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      showMsg("Не удалось загрузить справочники: " + esc(e.message), "err");
    }
  };

  async function submit(e) {
    e.preventDefault();
    clearMsg();
    var title = $("tmTitle").value.trim();
    var responsibleId = $("tmResponsible").value;
    if (!title) return showMsg("Укажите название задачи", "err");
    if (!responsibleId) return showMsg("Выберите ответственного", "err");

    var deadline = $("tmDeadline").value;
    var payload = {
      title: title,
      groupId: $("tmProject").value || null,
      parentId: $("tmParent").value || null,
      responsibleId: Number(responsibleId),
      deadline: deadline ? deadline + ":00" : null,
    };
    if (currentTpl && !currentTpl.freeText) {
      payload.templateKey = currentTpl.key;
      payload.vars = collectVars();
    } else {
      payload.description = $("tmDescription").value || null;
    }

    submitBtn.disabled = true;
    showMsg("Создаём…", null);
    try {
      var res = await fetch("/api/task", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { location.replace("login.html"); return; }
      var d = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        submitBtn.disabled = false;
        return showMsg("Ошибка: " + esc(d.error || res.status) + (d.message ? " — " + esc(d.message) : ""), "err");
      }
      showMsg('✓ Задача создана. <a class="tlink" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">Открыть в Bitrix</a>', "ok");
      document.dispatchEvent(new CustomEvent("task:created", { detail: { id: d.id } }));
      setTimeout(close, 1800);
    } catch (e) {
      submitBtn.disabled = false;
      showMsg("Сеть недоступна, попробуйте ещё раз", "err");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    modal = $("taskModal"); form = $("taskForm"); msg = $("tmMsg"); submitBtn = $("tmSubmit");
    if (!modal) return;
    $("taskModalClose").onclick = close;
    $("taskModalCancel").onclick = close;
    $("taskModalOverlay").onclick = close;
    $("tmProject").addEventListener("change", function () { fillParents($("tmProject").value); });
    $("tmTemplate").addEventListener("change", function () { onTemplateChange(false); });
    var pv = $("tmPreviewToggle");
    if (pv) pv.onclick = function () {
      var pre = $("tmPreview");
      pre.hidden = !pre.hidden;
      pv.textContent = (pre.hidden ? "▸" : "▾") + " Предпросмотр описания";
    };
    form.addEventListener("submit", submit);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal && !modal.hidden) close(); });
  });
})();
