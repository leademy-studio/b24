/* subscriptions.js — экран «Подписки»: реестр из /api/subscriptions.
   Срабатывает по screen:render для id === "subscriptions". Фильтры — на клиенте. */
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
    return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear();
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  function render() {
    var svc = document.getElementById("subService").value;
    var pkg = document.getElementById("subPackage").value;
    var rows = ALL.filter(function (s) {
      if (svc && s.service !== svc) return false;
      if (pkg && s.package !== pkg) return false;
      return true;
    });
    setText("subCount", "· " + rows.length);
    var tb = document.getElementById("subBody");
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="5" class="muted">Ничего не найдено</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map(function (s) {
        var pkgCell = s.package && s.package !== "—"
          ? '<span class="chip chip--blue">' + esc(s.package) + "</span>"
          : '<span class="muted">—</span>';
        return (
          "<tr><td>" + esc(s.project) + "</td>" +
          "<td>" + esc(s.service) + "</td>" +
          '<td class="c">' + pkgCell + "</td>" +
          '<td class="c">' + fmtDate(s.nextExecution) + "</td>" +
          '<td class="c"><span class="chip chip--ok">активна</span></td></tr>'
        );
      })
      .join("");
  }

  async function load() {
    try {
      var d = await window.apiGet("/api/subscriptions");
      ALL = d.subscriptions || [];
      ["subService", "subPackage"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el._wired) { el._wired = true; el.addEventListener("input", render); }
      });
      render();
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      var tb = document.getElementById("subBody");
      if (tb) tb.innerHTML = '<tr><td colspan="5" class="muted">Ошибка загрузки: ' + esc(e.message) + "</td></tr>";
    }
  }

  document.addEventListener("screen:render", function (e) {
    if (e.detail && e.detail.id === "subscriptions") load();
  });
})();
