/* ============================================================================
 * StudyHub — shared Community/Library API helpers
 * Community requires the bridged session token (see js/auth-bridge.js),
 * minted asynchronously right after login, so we poll briefly for it rather
 * than assuming it's already in localStorage. Library has no login at all.
 * ========================================================================== */

async function getCommunityToken(retries = 6) {
  for (let i = 0; i < retries; i++) {
    const t = localStorage.getItem("sh_token");
    if (t) return t;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function communityApi(path, params) {
  const token = await getCommunityToken();
  if (!token) throw new Error("no-community-session");
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch("/community/api" + path + qs, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("community-api-" + res.status);
  return res.json();
}

async function libraryApi(path) {
  const res = await fetch("/library" + path);
  if (!res.ok) throw new Error("library-api-" + res.status);
  return res.json();
}
