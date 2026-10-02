/* ============================================================================
 * StudyHub — password-reactive login character behavior
 * Reads the *real* #password input and the existing .toggle-password button's
 * effect (input.type flips between "password" and "text") via a
 * MutationObserver, so this works regardless of script load order and never
 * needs to touch js/auth.js or js/login.js.
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const buddy = document.getElementById("password-buddy");
  const input = document.getElementById("password");
  if (!buddy || !input) return;

  let typingTimer = null;

  function setState(state) {
    buddy.dataset.state = state;
  }

  function currentState() {
    if (input.type === "text") return "visible";
    if (document.activeElement === input) return "typing"; // overridden below if not actively typing
    return "idle";
  }

  function refresh() {
    if (input.type === "text") { setState("visible"); return; }
    if (document.activeElement === input) { setState("focused"); return; }
    setState("idle");
  }

  input.addEventListener("focus", refresh);
  input.addEventListener("blur", refresh);
  input.addEventListener("input", () => {
    if (input.type === "text") return; // already visible, stay in "visible" state
    setState("typing");
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { if (document.activeElement === input) setState("focused"); }, 700);
  });

  // Catches the show/hide toggle regardless of which script flips input.type.
  const observer = new MutationObserver(refresh);
  observer.observe(input, { attributes: true, attributeFilter: ["type"] });

  setState("idle");

  // Natural idle blinking, at randomized intervals.
  function scheduleBlink() {
    const delay = 2200 + Math.random() * 2600;
    setTimeout(() => {
      if (buddy.dataset.state !== "visible") {
        buddy.classList.add("is-blinking");
        setTimeout(() => buddy.classList.remove("is-blinking"), 130);
      }
      scheduleBlink();
    }, delay);
  }
  scheduleBlink();
});
