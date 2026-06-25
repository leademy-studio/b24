/* overview.js — наполняет экран «Обзор» живыми данными из /api/overview.
   Срабатывает по событию screen:render (см. app.js) для id === "overview". */
(function () {
  "use strict";

  var ICON_TASK =
    '<svg class="feed__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  var ICON_LATE =
    '<svg class="feed__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtRub(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("ru-RU") + " ₽";
  }

  function renderMatrix(rows) {
    var tb = document.getElementById("ovMatrix");
    if (!tb) return;
    if (!rows || !rows.length) {
      tb.innerHTML = '<tr><td colspan="5" class="muted">Нет активных задач</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map(function (r) {
        return (
          "<tr><td>" + escapeHtml(r.service) + "</td>" +
          '<td class="c">' + r.active + "</td>" +
          '<td class="c' + (r.overdue > 0 ? " bad" : "") + '">' + r.overdue + "</td>" +
          '<td class="c">' + r.waiting + "</td>" +
          '<td class="r total">' + r.total + "</td></tr>"
        );
      })
      .join("");
  }

  function renderFeed(feed) {
    var box = document.getElementById("ovFeed");
    if (!box) return;
    if (!feed || !feed.length) {
      box.innerHTML = '<div class="feed__item"><span class="feed__text muted">Пусто</span></div>';
      return;
    }
    box.innerHTML = feed
      .map(function (f) {
        var cls = f.overdue ? "feed__item feed__item--late" : "feed__item";
        var label = f.project ? escapeHtml(f.project) : "Задача";
        var titleHtml = f.url
          ? '<a class="tlink" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(f.title) + "</a>"
          : escapeHtml(f.title);
        return (
          '<div class="' + cls + '">' +
          '<div class="feed__head"><span class="feed__time">' + label + "</span>" +
          (f.overdue ? ICON_LATE : ICON_TASK) + "</div>" +
          '<div class="feed__text">' + titleHtml + "</div></div>"
        );
      })
      .join("");
  }

  function plural(n) {
    var d = n % 10, dd = n % 100;
    if (d === 1 && dd !== 11) return "а";
    if (d >= 2 && d <= 4 && (dd < 10 || dd >= 20)) return "и";
    return "";
  }

  async function load() {
    try {
      var d = await window.apiGet("/api/overview");
      setText("appMonth", d.month || "");
      setText("kpiProjects", d.kpi.activeProjects);
      setText("kpiServices", d.kpi.servicesInWork);
      setText("kpiDone", d.kpi.donePct + "%");
      setText("kpiOverdue", d.kpi.overdue);
      setText("kpiBudget", fmtRub(d.kpi.monthlyBudget));
      renderMatrix(d.matrix);
      renderFeed(d.feed);

      var alert = document.getElementById("ovAlert");
      if (alert) {
        if (d.kpi.overdue > 0) {
          setText("ovAlertText", d.kpi.overdue + " просроченных задач" + plural(d.kpi.overdue));
          alert.hidden = false;
        } else {
          alert.hidden = true;
        }
      }
      var close = document.getElementById("ovAlertClose");
      if (close && alert) close.onclick = function () { alert.hidden = true; };
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      var tb = document.getElementById("ovMatrix");
      if (tb) tb.innerHTML = '<tr><td colspan="5" class="muted">Ошибка загрузки: ' + escapeHtml(e.message) + "</td></tr>";
    }
  }

  document.addEventListener("screen:render", function (e) {
    if (e.detail && e.detail.id === "overview") load();
  });
})();
