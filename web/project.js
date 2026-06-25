/* project.js — детальная карточка проекта: услуги/задачи/бюджет из /api/project/:id.
   Срабатывает по screen:render для id === "project". */
(function () {
  "use strict";

  var ICON_DONE =
    '<svg class="tline__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';
  var ICON_WAIT =
    '<svg class="tline__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  var ICON_LATE =
    '<svg class="tline__ico tline__ico--late" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  var CHEVRON =
    '<svg class="svc__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtRub(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("ru-RU") + " ₽";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2);
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  function taskRow(t) {
    var ico = t.done ? ICON_DONE : t.state === "overdue" ? ICON_LATE : ICON_WAIT;
    var badge = "";
    if (t.state === "overdue") badge = '<span class="tbadge tbadge--late">Просрочено</span>';
    else if (t.state === "waiting") badge = '<span class="tbadge tbadge--wait">ждёт</span>';
    var nameCls = "tline__name" + (t.done ? " tline__name--done" : "");
    var name = String(t.title || "").split(" | ")[0];
    var nameInner = t.url
      ? '<a class="tlink" href="' + esc(t.url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + "</a>"
      : esc(name);
    return (
      '<div class="tline">' + ico +
      '<span class="' + nameCls + '">' + nameInner + "</span>" +
      badge +
      '<span class="tline__date">' + fmtDate(t.deadline) + "</span></div>"
    );
  }

  function serviceCard(s, idx) {
    var pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    var collapsed = idx > 0 ? " is-collapsed" : "";
    return (
      '<div class="svc' + collapsed + '">' +
      '<div class="svc__head js-svc-head">' +
      '<div class="svc__left">' + CHEVRON + '<span class="svc__name">' + esc(s.name) + "</span></div>" +
      '<div class="svc__meta"><div class="svc__progress">' +
      '<div class="progress"><div class="progress__bar" style="width:' + pct + '%"></div></div>' +
      '<div class="svc__progresslabel">' + s.done + "/" + s.total + " задач (" + pct + "%)</div>" +
      "</div></div></div>" +
      '<div class="svc__tasks">' + s.tasks.map(taskRow).join("") + "</div>" +
      "</div>"
    );
  }

  function renderServices(services) {
    var box = document.getElementById("prjServices");
    if (!box) return;
    if (!services || !services.length) {
      box.innerHTML = '<div class="muted">Нет задач в этом проекте</div>';
      return;
    }
    box.innerHTML = services.map(serviceCard).join("");
    box.querySelectorAll(".js-svc-head").forEach(function (h) {
      h.addEventListener("click", function () { h.parentElement.classList.toggle("is-collapsed"); });
    });
  }

  async function loadProject(id) {
    try {
      var d = await window.apiGet("/api/project/" + id);
      setText("prjName", d.name);
      setText("prjCrumb", d.name);
      setText("prjStatusText", d.active ? "В работе" : "Не активен");
      var chip = document.getElementById("prjStatus");
      if (chip) chip.className = "status-chip" + (d.active ? "" : " status-chip--off");
      setText("prjBudget", fmtRub(d.budget));
      setText("prjDeal", fmtRub(d.budget));
      renderServices(d.services);

      var others = document.getElementById("prjOthers");
      if (others) {
        others.className = "";
        others.innerHTML = d.otherProjects && d.otherProjects.length
          ? d.otherProjects
              .map(function (p) {
                return '<div class="mini-card" style="margin-bottom:8px"><div><div class="mini-card__name">' +
                  esc(p.name) + '</div><div class="mini-card__sub">Подписка активна</div></div></div>';
              })
              .join("")
          : '<div class="muted">Нет других активных проектов</div>';
      }
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      var box = document.getElementById("prjServices");
      if (box) box.innerHTML = '<div class="muted">Ошибка загрузки: ' + esc(e.message) + "</div>";
    }
  }

  async function init() {
    var sel = document.getElementById("prjSelect");
    if (!sel) return;
    try {
      var d = await window.apiGet("/api/projects");
      var list = (d.projects || []).filter(function (p) { return p.active; });
      sel.innerHTML = list.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.name) + "</option>";
      }).join("");
      sel.onchange = function () { loadProject(sel.value); };
      if (list.length) loadProject(sel.value || list[0].id);
      else document.getElementById("prjServices").innerHTML = '<div class="muted">Нет проектов</div>';
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      sel.innerHTML = '<option>Ошибка</option>';
    }
  }

  document.addEventListener("screen:render", function (e) {
    if (e.detail && e.detail.id === "project") init();
  });
})();
