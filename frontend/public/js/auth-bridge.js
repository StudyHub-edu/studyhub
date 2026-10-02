/* ============================================================================
 * StudyHub — Community/Calendar single sign-on bridge
 * ----------------------------------------------------------------------------
 * Community and Calendar are a separate app under the hood (server/community)
 * with their own session tokens, but they must NEVER show their own login
 * screen — only studyhub's index.html does that.
 *
 * Right after a person is confirmed signed in here, this file asks our own
 * server (not Supabase) to mint a matching Community session for the same
 * person and stores it under the key Community's front end already reads
 * ('sh_token'). By the time they click "Community" or "Calendar" in the nav,
 * they're already signed in there too.
 *
 * Requires js/config.js (for the `supabase` client) to be loaded first.
 * ========================================================================== */

async function studyHubBridgeCommunitySession() {
  try {
    const { data, error } = await supabase.auth.getSession();
    const session = data && data.session;
    if (error || !session) return false;

    const res = await fetch("/api/bridge/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.access_token,
      },
    });
    if (!res.ok) {
      console.debug("[StudyHub] community bridge login failed:", res.status);
      return false;
    }
    const body = await res.json();
    if (body && body.token) {
      localStorage.setItem("sh_token", body.token);
    }
    if (body && body.home) {
      localStorage.setItem("studyhub_home", body.home);
    }
    return !!(body && body.token);
  } catch (err) {
    console.debug("[StudyHub] community bridge login error:", err);
    return false;
  }
}

let communityNavigationPending = false;
document.addEventListener("click", async (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;

  const target = new URL(link.href, window.location.href);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/community/")) return;
  event.preventDefault();
  if (communityNavigationPending) return;
  communityNavigationPending = true;

  const next = target.pathname + target.search + target.hash;
  if (await studyHubBridgeCommunitySession()) {
    window.location.assign(next);
    return;
  }
  window.location.assign("/index.html?next=" + encodeURIComponent(next));
});

studyHubBridgeCommunitySession();
