/* ============================================================================
 * StudyHub — shared auth helpers
 * Loaded on every page, after js/config.js.
 * ========================================================================== */

/* ------------------------------------------------------------------ alerts */

const ICON_ERROR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>';
const ICON_OK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

/**
 * Render a message into an .alert container.
 * @param {HTMLElement} box
 * @param {"error"|"success"|"info"} kind
 * @param {string} message
 * @param {{label:string, onClick:Function}} [action]
 */
function showAlert(box, kind, message, action) {
  if (!box) return;
  const icon = kind === "error" ? ICON_ERROR : kind === "success" ? ICON_OK : ICON_INFO;
  box.className = "alert alert--" + kind;
  box.innerHTML = icon + "<div><span></span></div>";
  box.querySelector("span").textContent = message;

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "alert__action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    box.querySelector("div").appendChild(btn);
  }

  box.hidden = false;
  box.setAttribute("role", kind === "error" ? "alert" : "status");
}

function clearAlert(box) {
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
}

/* ------------------------------------------------------- button loading UI */

function setLoading(button, isLoading, loadingLabel) {
  if (!button) return;
  const label = button.querySelector(".btn__label");
  if (isLoading) {
    button.dataset.idleLabel = label ? label.textContent : "";
    button.disabled = true;
    button.classList.add("is-loading");
    if (label && loadingLabel) label.textContent = loadingLabel;
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    if (label && button.dataset.idleLabel) label.textContent = button.dataset.idleLabel;
  }
}

/* ------------------------------------------------------------- validation */

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(value).trim());

/** Accepts 7–15 digits, optional leading +, spaces/dashes/brackets ignored. */
const isValidPhone = (value) => {
  const digits = String(value).replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(digits);
};

/** Minimum: 8 chars, at least one letter and one number. */
const meetsPasswordRules = (value) =>
  typeof value === "string" &&
  value.length >= 12 &&
  /[A-Za-z]/.test(value) &&
  /\d/.test(value);

/** 0–4, used only for the visual strength meter. */
function passwordStrength(value) {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  return Math.min(score, 4);
}

/** Attach an inline error to a field. */
function setFieldError(input, message) {
  if (!input) return;
  const holder = document.getElementById(input.id + "-error");
  if (holder) holder.textContent = message || "";
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function clearFieldErrors(form) {
  form.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  form.querySelectorAll("[aria-invalid]").forEach((el) =>
    el.removeAttribute("aria-invalid")
  );
}

/* ------------------------------------------------- friendly error messages */
/* Raw Supabase / Postgres text never reaches the user. */

function friendlyError(error) {
  if (!error) return "Something went wrong. Please try again.";

  if (
    error.name === "TypeError" ||
    /fetch|network|failed to fetch/i.test(error.message || "")
  ) {
    return "Unable to connect right now. Please check your internet connection.";
  }

  const raw = (error.message || "").toLowerCase();
  const status = error.status;

  if (raw.includes("already registered") || raw.includes("user already exists"))
    return "This email is already registered. Try logging in.";
  if (raw.includes("invalid login credentials") || raw.includes("invalid credentials"))
    return "Incorrect email or password.";
  if (raw.includes("email not confirmed") || raw.includes("not confirmed"))
    return "Please verify your email before logging in.";
  if (raw.includes("expired") && raw.includes("token"))
    return "Your verification code has expired. Request a new code.";
  if (raw.includes("token has expired") || raw.includes("otp_expired"))
    return "Your verification code has expired. Request a new code.";
  if (raw.includes("invalid") && (raw.includes("token") || raw.includes("otp")))
    return "The verification code is incorrect.";
  if (raw.includes("for security purposes") || status === 429)
    return "Too many attempts. Please wait a moment and try again.";
  if (raw.includes("password should be") || raw.includes("weak password"))
    return "Please choose a stronger password (at least 12 characters, with a letter and a number).";
  if (raw.includes("same as the old password") || raw.includes("should be different"))
    return "Your new password must be different from your current one.";
  if (raw.includes("email rate limit"))
    return "We've sent too many emails to this address. Please wait a few minutes.";
  if (raw.includes("signups not allowed") || raw.includes("signup is disabled"))
    return "New sign-ups are currently closed. Please contact StudyHub support.";
  if (raw.includes("provider is not enabled") || raw.includes("unsupported provider"))
    return "Google sign-in isn't configured yet. Enable Google in Supabase Authentication providers and add the Google OAuth client ID and secret.";
  if (raw.includes("redirect") && (raw.includes("allow") || raw.includes("url")))
    return "This sign-in redirect is not allowed. Add this site's URL under Supabase Authentication URL configuration.";
  if (raw.includes("auth session missing") || raw.includes("session_not_found"))
    return "Your session has ended. Please sign in again.";

  console.debug("[StudyHub] unmapped auth error:", error);
  return "Something went wrong. Please try again.";
}

async function isGoogleSignInEnabled() {
  const response = await fetch(SUPABASE_URL + "/auth/v1/settings", {
    headers: { apikey: SUPABASE_ANON_KEY },
  });
  if (!response.ok) {
    throw new Error("Google provider check failed: " + response.status);
  }
  const settings = await response.json();
  return settings.external?.google === true;
}

/* ------------------------------------------------------ password visibility */

function initPasswordToggles(root = document) {
  const EYE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  const EYE_OFF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 6.2A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.2 4M6.5 7.6A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5a9.7 9.7 0 0 0 4-.85"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>';

  root.querySelectorAll(".toggle-password").forEach((btn) => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    btn.innerHTML = EYE;
    btn.setAttribute("aria-label", "Show password");
    btn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.innerHTML = showing ? EYE : EYE_OFF;
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus({ preventScroll: true });
    });
  });
}

/* ----------------------------------------------------- shared UI rendering */

function initialsFromName(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

/**
 * Fills in every [data-identity-name] / [data-identity-meta] / [data-avatar]
 * element on the page, and swaps in a real photo wherever an
 * [data-avatar-img] element sits next to a [data-avatar] initials badge.
 * Used by dashboard.html, profile.html, and anywhere else that shows who's
 * signed in.
 */
async function loadIdentity(session) {
  const sessionName = session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "StudyHub member";
  document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = sessionName));
  renderAvatarEverywhere(null, sessionName);

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(
      "full_name, role, class_level, verification_status, identity_status, avatar_url, institution_id"
    )
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error || !profile) {
    console.debug("[StudyHub] profile load failed:", error?.message);
    return null;
  }

  let institutionName = session.user.user_metadata?.institution_name || "";
  if (!institutionName && profile.institution_id) {
    const { data: institution, error: institutionError } = await supabase
      .from("institutions")
      .select("name")
      .eq("id", profile.institution_id)
      .maybeSingle();
    if (institutionError) console.warn("[StudyHub] institution name load failed:", institutionError.message);
    institutionName = institution?.name || "";
  }

  let identityStatus = "unavailable";
  const { data: latestVerification, error: verificationError } = await supabase
    .from("identity_verifications")
    .select("status")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (verificationError) {
    console.warn("[StudyHub] identity status load failed:", verificationError.message);
  } else {
    identityStatus = latestVerification?.status || "not_submitted";
  }
  profile.identity_status = identityStatus;

  const meta = profile.role === "admin"
    ? "Administrator"
    : [profile.class_level, institutionName].filter(Boolean).join(" • ");
  document.querySelectorAll("[data-identity-meta]").forEach((el) => (el.textContent = meta || profile.role));
  document.querySelectorAll("[data-profile-institution]").forEach((el) => {
    el.textContent = institutionName || "Not set";
  });
  document.querySelectorAll("[data-profile-level]").forEach((el) => {
    el.textContent = profile.role === "teacher" ? "Teacher" : profile.class_level || "Not set";
  });
  document.querySelectorAll("[data-profile-level-label]").forEach((el) => {
    el.textContent = profile.role === "teacher" ? "Account type" : "Study level";
  });
  const displayName = profile.full_name || session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "StudyHub member";
  profile.full_name = displayName;
  document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = displayName));

  renderAvatarEverywhere(profile.avatar_url, displayName);

  /* The trust badge reflects ID-card verification, not just having a
     confirmed email — anyone who can log in already has a confirmed email,
     so that alone would make every user "verified". */
  const idVerified = identityStatus === "verified";
  document.querySelectorAll("[data-verified-badge]").forEach((el) => (el.hidden = !idVerified));
  document.querySelectorAll("[data-verified-dot]").forEach((el) => (el.hidden = !idVerified));

  /* The explicit non-verified counterpart: never leave this ambiguous by
     just hiding the verified badge and saying nothing. Matches the real
     identity_status values: not_submitted | pending | verified | rejected. */
  const pendingLabel = identityStatus === "pending" ? "Verification Pending" :
    identityStatus === "rejected" ? "Verification Rejected" :
    identityStatus === "unavailable" ? "Status unavailable" :
    "Not verified";
  document.querySelectorAll("[data-profile-verification]").forEach((el) => {
    el.textContent = idVerified ? `Verified ${profile.role === "teacher" ? "Teacher" : "Student"}` : pendingLabel;
    el.classList.toggle("is-verified", idVerified);
    el.classList.toggle("is-unverified", !idVerified);
    el.classList.toggle("is-pending", identityStatus === "pending");
    el.classList.toggle("is-rejected", identityStatus === "rejected");
    el.classList.toggle("is-unavailable", identityStatus === "unavailable");
  });
  document.querySelectorAll("[data-unverified-label]").forEach((el) => (el.textContent = pendingLabel));
  document.querySelectorAll("[data-unverified-badge]").forEach((el) => {
    el.hidden = idVerified;
    el.classList.toggle("is-pending", identityStatus === "pending" || identityStatus === "rejected");
    el.classList.toggle("is-rejected", identityStatus === "rejected");
    el.classList.toggle("is-unavailable", identityStatus === "unavailable");
  });

  return profile;
}

/** Swap every [data-avatar] initials badge for a real photo, if one exists. */
function renderAvatarEverywhere(avatarUrl, fullName) {
  const letters = initialsFromName(fullName || "");
  document.querySelectorAll("[data-avatar]").forEach((el) => {
    el.textContent = letters;
    el.hidden = !!avatarUrl;
  });
  document.querySelectorAll("[data-avatar-img]").forEach((img) => {
    if (avatarUrl) {
      img.src = avatarUrl + (avatarUrl.includes("?") ? "&" : "?") + "v=" + Date.now();
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
    }
  });
}

/** Table not created yet (Postgres undefined_table) vs a real error. Shared
    by every page that queries a table which might not exist yet. */
function isMissingTable(error) {
  return !!error && (error.code === "42P01" || /relation .* does not exist/i.test(error.message || ""));
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function isSupportedImageFile(file) {
  if (!file || file.size < 12 || file.size > 25 * 1024 * 1024) return false;
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
  const isWebp = String.fromCharCode(...header.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
  return isJpeg || isPng || isWebp;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Drop-in "nothing here yet" state for any list container. */
function renderEmptyState(container, { message, actionLabel, actionHref }) {
  const action = actionHref && actionLabel ? `<a href="${actionHref}">${actionLabel}</a>` : "";
  container.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
      <p>${escapeHtml(message)}</p>
      ${action}
    </div>`;
}

/* ------------------------------------------------------------- session API */

async function getSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

async function getCurrentProfile() {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) {
    console.debug("[StudyHub] profile fetch failed:", error.message);
    return null;
  }
  return data;
}

/**
 * Drop-in guard for dashboard.html, profile.html, settings.html,
 * library.html, community.html …
 *
 *   <script src="js/config.js"></script>
 *   <script src="js/auth.js"></script>
 *   <script>requireAuth();</script>
 *
 * Note: this is a convenience redirect. Real protection is Row Level
 * Security on the server — hiding a page is never enough on its own.
 */
async function requireAuth(options = {}) {
  const {
    requireVerified = true,
    requireOnboarding = true,
    allowAdmin = false,
  } = options;
  const session = await getSession();

  if (!session) {
    window.location.replace("index.html");
    return null;
  }

  if (requireVerified && !session.user.email_confirmed_at && !session.user.phone_confirmed_at) {
    if (session.user.email) pendingVerification.set(session.user.email, "email");
    else if (session.user.phone) pendingVerification.set(session.user.phone, "phone");
    window.location.replace("verify.html");
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("institution_id, role")
    .eq("user_id", session.user.id)
    .maybeSingle();

  /* The admin never belongs on a student/teacher page, and never has an
     institution, so it must not be sent through onboarding either. */
  if (profile?.role === "admin" && !allowAdmin) {
    window.location.replace(STUDYHUB_ADMIN_DASHBOARD);
    return null;
  }

  /* Google (and any future OAuth provider) hands us a confirmed email
     but never an institution or account type — those only come from our
     own form. A missing institution is what tells us that step never
     happened, whichever way the account was created. */
  if (
    requireOnboarding &&
    profile?.role !== "admin" &&
    profile &&
    !profile.institution_id &&
    !session.user.user_metadata?.institution_name
  ) {
    window.location.replace("onboarding.html");
    return null;
  }

  return session;
}

/** Where a signed-in user of this role should land. */
function homeForRole(role) {
  if (role === "admin") return STUDYHUB_ADMIN_DASHBOARD;
  if (role === "teacher") return STUDYHUB_TEACHER_DASHBOARD;
  return STUDYHUB_DASHBOARD;
}

/** For login/register pages: bounce an already-signed-in user to the app. */
async function redirectIfSignedIn() {
  const session = await getSession();
  if (session && (session.user.email_confirmed_at || session.user.phone_confirmed_at)) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", session.user.id)
      .maybeSingle();
    window.location.replace(homeForRole(profile?.role));
    return true;
  }
  return false;
}

/** Sign out from anywhere: <button onclick="studyHubSignOut()">Log out</button> */
async function studyHubSignOut() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.debug("[StudyHub] sign-out issue:", err);
  } finally {
    sessionStorage.removeItem("studyhub:pending_email");
    localStorage.removeItem("sh_token"); // also sign out of Community/Calendar
    localStorage.removeItem("studyhub_home");
    window.location.replace("index.html");
  }
}

/* -------------------------------------------------- pending-email handoff */
/* Only the email address travels between pages. Never a password, never an OTP. */

const pendingEmail = {
  set: (email) => sessionStorage.setItem("studyhub:pending_email", email),
  get: () => sessionStorage.getItem("studyhub:pending_email") || "",
  clear: () => sessionStorage.removeItem("studyhub:pending_email"),
};

/**
 * Same idea, but also remembers whether the identifier is an email or a
 * phone number, since verify.html needs to know which kind of OTP to check.
 */
const pendingVerification = {
  set: (value, method) => {
    sessionStorage.setItem("studyhub:pending_value", value);
    sessionStorage.setItem("studyhub:pending_method", method); // "email" | "phone"
  },
  get: () => ({
    value: sessionStorage.getItem("studyhub:pending_value") || "",
    method: sessionStorage.getItem("studyhub:pending_method") || "email",
  }),
  clear: () => {
    sessionStorage.removeItem("studyhub:pending_value");
    sessionStorage.removeItem("studyhub:pending_method");
  },
};

/* --------------------------------------------------------- institutions UI */

/**
 * Turns a text input into a searchable institution picker. Names not in the
 * reference list use the seeded "Other / not listed" institution record and
 * are retained as user metadata for display.
 */
async function initInstitutionCombo(inputId, hiddenId, listId, errorBox) {
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(hiddenId);
  const list = document.getElementById(listId);
  if (!input || !hidden || !list) return;

  let items = [];
  let active = -1;
  let customOption = null;

  try {
    const { data, error } = await supabase
      .from("institutions")
      .select("id, name, type, city")
      .order("name");
    if (error) throw error;
    items = data || [];
  } catch (err) {
    input.placeholder = "Could not load the list — type your institution";
    if (errorBox) showAlert(errorBox, "info", "Institution list unavailable. You can still finish signing up.");
    return;
  }
  const otherInstitution = items.find((item) => item.name.toLowerCase() === "other / not listed");
  hidden.dataset.otherId = otherInstitution?.id || "";

  const render = (query) => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            (i.city || "").toLowerCase().includes(q)
        )
      : items;

    list.innerHTML = "";
    active = -1;

    if (!matches.length) {
      const li = document.createElement("li");
      li.className = "is-empty";
      li.textContent = "No listed match. You can use your typed institution name.";
      list.appendChild(li);
    }

    matches.slice(0, 40).forEach((item) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.id = item.id;
      li.textContent = item.name;
      if (item.city) {
        const small = document.createElement("small");
        small.textContent = item.city;
        li.appendChild(small);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(item, false);
      });
      list.appendChild(li);
    });

    const exactMatch = matches.some((item) => item.name.toLowerCase() === q);
    const other = items.find((item) => item.name.toLowerCase() === "other / not listed");
    const typedName = input.value.trim();
    if (typedName && !exactMatch && other) {
      customOption = document.createElement("li");
      customOption.setAttribute("role", "option");
      customOption.dataset.id = other.id;
      customOption.textContent = `Use "${typedName}" (not listed)`;
      customOption.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(other, true);
      });
      list.appendChild(customOption);
    } else {
      customOption = null;
    }
  };

  const choose = (item, isCustom) => {
    if (!isCustom) input.value = item.name;
    hidden.value = item.id;
    hidden.dataset.customName = isCustom ? input.value.trim() : "";
    hidden.dataset.chosenName = input.value;
    list.hidden = true;
    setFieldError(input, "");
  };

  const open = () => {
    render(input.value === hidden.dataset.chosenName ? "" : input.value);
    list.hidden = false;
  };

  input.addEventListener("focus", open);
  input.addEventListener("input", () => {
    hidden.value = "";
    hidden.dataset.customName = "";
    hidden.dataset.chosenName = "";
    render(input.value);
    list.hidden = false;
  });
  input.addEventListener("change", () => {
    const typedName = input.value.trim();
    const exact = items.find((item) => item.name.toLowerCase() === typedName.toLowerCase());
    if (exact) choose(exact, false);
    else if (typedName && otherInstitution) choose(otherInstitution, true);
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 120));

  input.addEventListener("keydown", (e) => {
    let options = [...list.querySelectorAll('li[role="option"]')];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) open();
      options = [...list.querySelectorAll('li[role="option"]')];
      if (!options.length) return;
      options.forEach((o) => o.setAttribute("aria-selected", "false"));
      active =
        e.key === "ArrowDown"
          ? (active + 1) % options.length
          : (active - 1 + options.length) % options.length;
      options[active].setAttribute("aria-selected", "true");
      options[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && !list.hidden && active > -1) {
      e.preventDefault();
      const id = options[active].dataset.id;
      const item = items.find((i) => i.id === id);
      if (item) choose(item, options[active] === customOption);
    } else if (e.key === "Escape") {
      list.hidden = true;
    }
  });
}
