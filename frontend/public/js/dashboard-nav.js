/* ============================================================================
 * StudyHub — shared topbar behaviour
 * Loaded on every page that has the app topbar (dashboard, profile, …).
 * ========================================================================== */

function initProfileMenu() {
  const menu = document.getElementById("profile-menu");
  const trigger = document.getElementById("profile-trigger");
  if (!menu || !trigger) return;

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("is-open");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target)) menu.classList.remove("is-open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.classList.remove("is-open");
  });
}

function initMobileNav() {
  const toggle = document.getElementById("nav-toggle");
  const target = document.getElementById("app-shell") || document.getElementById("topbar");
  if (!toggle || !target) return;
  toggle.addEventListener("click", () => target.classList.toggle("is-menu-open"));
}

function initSearch() {
  const wire = (formId, inputId) => {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = document.getElementById(inputId).value.trim();
      if (q) window.location.href = "search.html?q=" + encodeURIComponent(q);
    });
  };
  wire("search-form", "search-input");
  wire("hero-search-form", "hero-search-input");
}

document.addEventListener("DOMContentLoaded", () => {
  initProfileMenu();
  initMobileNav();
  initSearch();
});
