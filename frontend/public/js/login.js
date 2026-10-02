/* ============================================================================
 * StudyHub — login
 * Credentials are checked by Supabase Auth. Nothing is compared in the browser.
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("login-form");
  const alertBox = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");
  const googleBtn = document.getElementById("google-btn");

  const email = document.getElementById("email");
  const password = document.getElementById("password");

  initPasswordToggles();

  /* Already have a live session? Go straight in. This is what makes
     "close the tab and come back" keep you logged in. */
  await redirectIfSignedIn();

  /* Prefill the address if we bounced here from another auth page. */
  const remembered = pendingEmail.get();
  if (remembered) email.value = remembered;

  /* Best-effort entry for the admin's "Security Activity" card. Never blocks
     or fails the login: if the table isn't there yet we just skip it. */
  function recordAdminSignIn(userId) {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "device";
    supabase
      .from("security_events")
      .insert({ user_id: userId, title: "Admin signed in", device: `${browser} on ${os}` })
      .then(() => {}, () => {});
  }

  /** Treat anything with an @ as an email attempt, otherwise as a phone number. */
  const looksLikeEmail = (value) => value.includes("@");

  function validate() {
    clearFieldErrors(form);
    let ok = true;

    const raw = email.value.trim();
    if (!raw) {
      setFieldError(email, "Please enter your email address or phone number.");
      ok = false;
    } else if (looksLikeEmail(raw) && !isValidEmail(raw)) {
      setFieldError(email, "Please enter a valid email address.");
      ok = false;
    } else if (!looksLikeEmail(raw) && !/^\+[1-9]\d{7,14}$/.test(raw.replace(/[\s-]/g, ""))) {
      setFieldError(email, "Please enter a valid phone number with country code, e.g. +9779800000000.");
      ok = false;
    }

    if (!password.value) {
      setFieldError(password, "Please enter your password.");
      ok = false;
    }

    if (!ok) (email.getAttribute("aria-invalid") ? email : password).focus();
    return ok;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    if (!validate()) return;

    setLoading(submitBtn, true, "Signing in…");
    const raw = email.value.trim();
    const isEmailLogin = looksLikeEmail(raw);
    const identifier = isEmailLogin ? raw.toLowerCase() : raw.replace(/[\s-]/g, "");

    try {
      const { data, error } = await supabase.auth.signInWithPassword(
        isEmailLogin
          ? { email: identifier, password: password.value }
          : { phone: identifier, password: password.value }
      );

      if (error) {
        /* Supabase refuses the session when the account is unconfirmed. */
        const unverified = /not confirmed|not_confirmed/i.test(error.message || "");
        setLoading(submitBtn, false);

        if (unverified) {
          pendingVerification.set(identifier, isEmailLogin ? "email" : "phone");
          showAlert(alertBox, "error", "Please verify your account before logging in.", {
            label: "Verify now",
            onClick: () => (window.location.href = "verify.html"),
          });
        } else {
          showAlert(alertBox, "error", friendlyError(error));
          password.value = "";
          password.focus();
        }
        return;
      }

      /* Belt and braces: a session should never exist without a confirmed
         account, but if the setting is ever changed we still stop here. */
      if (!data.user?.email_confirmed_at && !data.user?.phone_confirmed_at) {
        pendingVerification.set(identifier, isEmailLogin ? "email" : "phone");
        setLoading(submitBtn, false);
        showAlert(alertBox, "error", "Please verify your account before logging in.", {
          label: "Verify now",
          onClick: () => (window.location.href = "verify.html"),
        });
        return;
      }

      showAlert(alertBox, "success", "Login successful ✓");
      pendingEmail.clear();
      pendingVerification.clear();

      /* Make sure the profile row landed before we hand over to the app,
         and use its role to decide where to go: the fixed admin account goes
         to the admin dashboard, everyone else to the student homepage. */
      const profile = await getCurrentProfile();
      const destination = homeForRole(profile?.role);

      if (profile?.role === "admin") recordAdminSignIn(data.user.id);

      const requestedDestination = new URLSearchParams(window.location.search).get("next");
      const safeCommunityDestination = requestedDestination && requestedDestination.startsWith("/community/")
        ? requestedDestination
        : null;
      let nextDestination = destination;
      if (safeCommunityDestination) {
        try {
          const bridgeResponse = await fetch("/api/bridge/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + data.session.access_token,
            },
          });
          if (bridgeResponse.ok) {
            const bridge = await bridgeResponse.json();
            if (bridge.token) {
              localStorage.setItem("sh_token", bridge.token);
              if (bridge.home) localStorage.setItem("studyhub_home", bridge.home);
              nextDestination = safeCommunityDestination;
            }
          } else {
            console.error("[StudyHub] Could not resume Community destination after sign-in:", bridgeResponse.status);
          }
        } catch (bridgeError) {
          console.error("[StudyHub] Could not resume Community destination after sign-in:", bridgeError);
        }
      }

      setTimeout(() => {
        window.location.href = nextDestination;
      }, 500);
    } catch (err) {
      setLoading(submitBtn, false);
      showAlert(alertBox, "error", friendlyError(err));
    }
  });

  /* -------------------------------------------------------- Google sign-in */
  const GOOGLE_PROVIDER_ENABLED = true;

  if (googleBtn) {
    if (!GOOGLE_PROVIDER_ENABLED) {
      googleBtn.disabled = true;
      googleBtn.title = "Google sign-in is not enabled for this project yet.";
      const note = document.getElementById("google-note");
      if (note) note.hidden = false;
    } else {
      googleBtn.addEventListener("click", async () => {
        setLoading(googleBtn, true, "Opening Google…");
        try {
          if (!(await isGoogleSignInEnabled())) {
            setLoading(googleBtn, false);
            showAlert(
              alertBox,
              "error",
              "Google sign-in isn't enabled for this StudyHub project yet. The project owner must enable Google and add its OAuth client ID and secret in Supabase."
            );
            return;
          }
          const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
              redirectTo: STUDYHUB_AUTH_REDIRECT,
            },
          });
          if (error) throw error;
        } catch (err) {
          setLoading(googleBtn, false);
          showAlert(alertBox, "error", friendlyError(err));
        }
      });
    }
  }
});
