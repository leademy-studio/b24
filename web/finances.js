/* finances.js — наполняет экран «Финансы» живыми данными из /api/finances.
   Срабатывает по событию screen:render (см. app.js) для id === "finances". */
(function () {
  "use strict";

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtRub(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("ru-RU") + " ₽";
  }

  var STATUS = {
    paid: ["chip--ok", "оплачено"],
    partial: ["chip--warn", "частичная"],
    unpaid: ["chip--err", "не оплачено"],
  };

  function renderByProject(rows) {
    var tb = document.getElementById("finByProject");
    if (!tb) return;
    if (!rows || !rows.length) {
      tb.innerHTML = '<tr><td colspan="4" class="muted">Нет активных подписок</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map(function (r) {
        var s = STATUS[r.status] || STATUS.unpaid;
        return (
          "<tr><td>" + esc(r.project) + "</td>" +
          '<td class="r">' + fmtRub(r.budget) + "</td>" +
          '<td class="r' + (r.paid > 0 ? "" : " muted") + '">' + fmtRub(r.paid) + "</td>" +
          '<td class="c"><span class="chip ' + s[0] + '">' + s[1] + "</span></td></tr>"
        );
      })
      .join("");
  }

  function renderPayments(items) {
    var box = document.getElementById("finPayments");
    if (!box) return;
    if (!items || !items.length) {
      box.innerHTML = '<div class="feed__item"><span class="feed__text muted">Оплат пока нет</span></div>';
      return;
    }
    box.innerHTML = items
      .map(function (p) {
        var who = p.project || p.company || (p.dealId ? "сделка " + p.dealId : "—");
        return (
          '<div class="feed__item">' +
          '<div class="feed__head"><span class="feed__time">' + esc(p.date) + "</span></div>" +
          '<div class="feed__text"><b>' + fmtRub(p.amount) + "</b> · " + esc(who) + "</div></div>"
        );
      })
      .join("");
  }

  async function load() {
    try {
      var d = await window.apiGet("/api/finances");
      setText("appMonth", d.month || "");
      setText("finBudget", fmtRub(d.kpi.monthlyBudget));
      setText("finPaid", fmtRub(d.kpi.paidThisMonth));
      setText("finAwaiting", fmtRub(d.kpi.awaiting));
      renderByProject(d.byProject);
      renderPayments(d.payments);
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      var tb = document.getElementById("finByProject");
      if (tb) tb.innerHTML = '<tr><td colspan="4" class="muted">Ошибка загрузки: ' + esc(e.message) + "</td></tr>";
    }
  }

  document.addEventListener("screen:render", function (e) {
    if (e.detail && e.detail.id === "finances") load();
  });
})();
