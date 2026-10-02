/* ============================================================================
 * StudyHub — dark/light theme toggle
 * The theme itself is already applied pre-paint by the inline script in
 * <head>. This just wires the button and persists the choice.
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("studyhub_theme", next); } catch (e) {}
  });
});
