/* ============================================================================
 * StudyHub — Supabase configuration
 * ----------------------------------------------------------------------------
 * PASTE YOUR TWO VALUES BELOW.
 *
 * Where to find them:
 *   Supabase Dashboard -> your project -> Project Settings -> API
 *     • "Project URL"            -> SUPABASE_URL
 *     • "anon public" / publishable key -> SUPABASE_ANON_KEY
 *
 * The anon key is designed to be public. It is safe in frontend code because
 * Row Level Security decides what it can actually touch.
 *
 * NEVER paste the "service_role" / secret key into any file in this folder.
 * It bypasses RLS entirely and belongs only on a server you control.
 * ========================================================================== */

// ⬇⬇⬇  PASTE HERE  ⬇⬇⬇
const SUPABASE_URL = "https://rhcpnzduqishmbmfdwat.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_UjrKKitdiei3AQLfDZUm-g_D0StWem1";
// ⬆⬆⬆  PASTE HERE  ⬆⬆⬆

/* Where users land after a successful, verified sign-in.
   No ".html" here on purpose: this URL also has to survive a Google OAuth
   round-trip, and the extensionless form is this server's canonical path
   (requesting the .html version gets redirected, which can strip query
   parameters that the OAuth code needs to complete sign-in). */
const STUDYHUB_DASHBOARD = "dashboard";
const STUDYHUB_AUTH_REDIRECT = new URL(
  STUDYHUB_DASHBOARD,
  window.location.href
).toString();
const STUDYHUB_VERIFY_REDIRECT = new URL(
  "verify.html",
  window.location.href
).toString();

/* Where a verified teacher lands after signing in. Same extensionless
   convention as above. */
const STUDYHUB_TEACHER_DASHBOARD = "teacher-dashboard";

/* Where the (single, fixed) admin account lands after signing in. Same
   extensionless convention as above. Students and teachers never see it:
   the page checks the role again and sends anyone else to their own home. */
const STUDYHUB_ADMIN_DASHBOARD = "admin-dashboard";

/* Where the password-recovery email should send people back to.
   This must ALSO be listed in Supabase -> Authentication -> URL Configuration
   -> Redirect URLs, or Supabase will refuse the redirect. */
const STUDYHUB_RESET_REDIRECT =
  window.location.origin +
  window.location.pathname.replace(/[^/]*$/, "") +
  "reset-password.html";

/* --------------------------------------------------------------------------
 * Client
 * ------------------------------------------------------------------------ */
if (
  SUPABASE_URL.startsWith("YOUR_") ||
  SUPABASE_ANON_KEY.startsWith("YOUR_")
) {
  console.error(
    "[StudyHub] js/config.js still has placeholder values. " +
      "Paste your Project URL and anon key before testing."
  );
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Session is kept by the Supabase SDK itself (localStorage + auto refresh).
    // We never store passwords or OTP codes ourselves.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});
window.studyhubSupabase = supabase;
