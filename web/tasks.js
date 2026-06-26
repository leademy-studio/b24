/* tasks.js — экран «Задачи»: сквозной список из /api/tasks с ссылкой на каждую задачу.
   Срабатывает по screen:render для id === "tasks". Фильтры — на клиенте. */
(function () {
  "use strict";

  var ALL = [];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2);
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  var STATE = {
    overdue: ["chip--err", "просрочено"],
    active: ["chip--blue", "в работе"],
    waiting: ["chip--warn", "ждёт"],
  };

  function taskLink(t) {
    var title = String(t.title || "").split(" | ")[0];
    var prefix = t.isSub ? '<span class="muted">└ </span>' : "";
    if (!t.url) return prefix + esc(title);
    return prefix + '<a class="tlink" href="' + esc(t.url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + "</a>";
  }

  function render() {
    var svc = document.getElementById("tkService").value;
    var st = document.getElementById("tkStatus").value;
    var q = (document.getElementById("tkSearch").value || "").toLowerCase().trim();
    var rows = ALL.filter(function (t) {
      if (svc && t.service !== svc) return false;
      if (st && t.state !== st) return false;
      if (q && String(t.title || "").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    setText("tkCount", "· " + rows.length);
    var tb = document.getElementById("tkBody");
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted">Ничего не найдено</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map(function (t) {
        var s = STATE[t.state] || STATE.active;
        return (
          "<tr><td>" + taskLink(t) + "</td>" +
          "<td>" + esc(t.project || "—") + "</td>" +
          "<td>" + esc(t.service) + "</td>" +
          "<td>" + esc(t.responsible || "—") + "</td>" +
          '<td class="c">' + fmtDate(t.deadline) + "</td>" +
          '<td class="c"><span class="chip ' + s[0] + '">' + s[1] + "</span></td></tr>"
        );
      })
      .join("");
  }

  async function load(params) {
    try {
      var d = await window.apiGet("/api/tasks");
      setText("appMonth", d.month || "");
      ALL = d.tasks || [];
      ["tkService", "tkStatus", "tkSearch"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el._wired) { el._wired = true; el.addEventListener("input", render); }
      });
      // Предустановка фильтра из роутера (напр. «Исправить» в алерте Обзора → status=overdue)
      if (params && params.status) {
        var st = document.getElementById("tkStatus");
        if (st) st.value = params.status;
      }
      render();
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      var tb = document.getElementById("tkBody");
      if (tb) tb.innerHTML = '<tr><td colspan="6" class="muted">Ошибка загрузки: ' + esc(e.message) + "</td></tr>";
    }
  }

  document.addEventListener("screen:render", function (e) {
    if (e.detail && e.detail.id === "tasks") load(e.detail.params);
  });
})();
