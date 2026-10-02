/* ============================================================================
 * StudyHub — "back to the main site" links, shared by Community and Library
 * These pages are reached from a StudyHub dashboard, so:
 *   - [data-home-link] elements point at the person's actual dashboard
 *     (student/teacher/admin), remembered in localStorage by auth-bridge.js
 *     right after login.
 *   - [data-back-link] elements go back in browser history (i.e. wherever
 *     the person actually came from), falling back to the dashboard if this
 *     page was opened directly (no history to go back to).
 * Served from the root site, so it works the same from /library/* and
 * /community/* (both same-origin).
 * ========================================================================== */

(function () {
  function studyHubHome() {
    try { return localStorage.getItem("studyhub_home") || "/dashboard.html"; } catch (e) { return "/dashboard.html"; }
  }

  function wire() {
    var home = studyHubHome();
    document.querySelectorAll("[data-home-link]").forEach(function (el) { el.href = home; });
    document.querySelectorAll("[data-back-link]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        // If we got here by clicking within StudyHub, there's history to go back to.
        // If this page was opened directly (new tab, refresh), send them home instead.
        if (window.history.length > 1 && document.referrer.indexOf(window.location.origin) === 0) {
          window.history.back();
        } else {
          window.location.href = home;
        }
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
