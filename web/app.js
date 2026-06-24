/* Простой хэш-роутер: грузит web/screens/<name>.html в <main>.
   Добавить страницу = создать screens/<name>.html + пункт в #nav с href="#<name>". */
(function () {
  const SCREENS = ["overview", "project", "tasks", "employees", "finances", "subscriptions", "scheduler"];
  const DEFAULT = "overview";
  const main = document.getElementById("main");
  const nav = document.getElementById("nav");
  const cache = {};

  function current() {
    const id = (location.hash || "#" + DEFAULT).slice(1);
    return SCREENS.includes(id) ? id : DEFAULT;
  }

  function setActive(id) {
    nav.querySelectorAll(".nav__item").forEach((a) => {
      a.classList.toggle("is-active", a.getAttribute("href") === "#" + id);
    });
  }

  async function load(id) {
    setActive(id);
    main.setAttribute("aria-busy", "true");
    try {
      if (!cache[id]) {
        const res = await fetch(`screens/${id}.html`, { cache: "no-cache" });
        if (!res.ok) throw new Error(res.status);
        cache[id] = await res.text();
      }
      main.innerHTML = cache[id];
      // Сообщаем модулям (metrics.js и т.п.), что экран вставлен в DOM.
      document.dispatchEvent(new CustomEvent("screen:render", { detail: { id } }));
    } catch (e) {
      main.innerHTML = `<div class="stub">Не удалось загрузить экран «${id}» (${e.message}).<br>Запусти статический сервер из папки web/.</div>`;
    } finally {
      main.removeAttribute("aria-busy");
      main.scrollTop = 0;
    }
  }

  const logout = document.getElementById("logout");
  if (logout) {
    logout.addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem("leademy_auth");
      sessionStorage.removeItem("leademy_auth");
      location.replace("login.html");
    });
  }

  window.addEventListener("hashchange", () => load(current()));
  load(current());
})();
