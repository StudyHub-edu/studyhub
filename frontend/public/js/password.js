/* ============================================================================
 * StudyHub — password recovery, reset and change
 * One file, three entry points. Each block only runs if its form is on the page.
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * A) forgot-password.html — send the recovery email
 * ------------------------------------------------------------------------- */
function initForgotPassword() {
  const form = document.getElementById("forgot-form");
  if (!form) return;

  const alertBox = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");
  const email = document.getElementById("email");

  const prefill = pendingEmail.get();
  if (prefill) email.value = prefill;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    clearFieldErrors(form);

    if (!email.value.trim()) {
      setFieldError(email, "Please enter your email address.");
      email.focus();
      return;
    }
    if (!isValidEmail(email.value)) {
      setFieldError(email, "Please enter a valid email address.");
      email.focus();
      return;
    }

    setLoading(submitBtn, true, "Sending…");
    const cleanEmail = email.value.trim().toLowerCase();

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: STUDYHUB_RESET_REDIRECT,
      });
      if (error) throw error;

      /* Deliberately the same message whether or not the address exists —
         otherwise this page becomes a way to find out who has an account. */
      pendingEmail.set(cleanEmail);
      showAlert(
        alertBox,
        "success",
        "If that address has a StudyHub account, a code is on its way. It expires in 10 minutes.",
        { label: "Enter the code", onClick: () => (window.location.href = "reset-password.html") }
      );
      form.reset();
      submitBtn.disabled = true;
      setTimeout(() => setLoading(submitBtn, false), 20000);
    } catch (err) {
      setLoading(submitBtn, false);
      showAlert(alertBox, "error", friendlyError(err));
    }
  });
}

/* ---------------------------------------------------------------------------
 * B) reset-password.html — set the new password
 *
 * The recovery email contains a typed code (via {{ .Token }} in the Supabase
 * template), not a clickable link. This sidesteps a real problem with links:
 * some mail providers wrap links in a click-tracking redirect (e.g. Amazon
 * SES's awstrack.me), and that redirect can be triggered by an automated
 * scanner before the person ever clicks it themselves — silently burning the
 * one-time token. A code the person types in by hand can't be pre-consumed
 * that way. We never ask for the OLD password here — the code from the email
 * is what proves the account is theirs.
 * ------------------------------------------------------------------------- */
function initResetPassword() {
  const form = document.getElementById("reset-form");
  if (!form) return;

  const alertBox = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");
  const email = document.getElementById("email");
  const code = document.getElementById("reset-code");
  const password = document.getElementById("new-password");
  const confirm = document.getElementById("confirm-password");
  const strength = document.getElementById("strength");

  const prefill = pendingEmail.get();
  if (prefill) email.value = prefill;

  initPasswordToggles();

  password.addEventListener("input", () => {
    strength.dataset.level = String(passwordStrength(password.value));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    clearFieldErrors(form);

    let firstBad = null;
    const fail = (input, message) => {
      setFieldError(input, message);
      if (!firstBad) firstBad = input;
    };

    if (!email.value.trim()) fail(email, "Please enter your email address.");
    else if (!isValidEmail(email.value))
      fail(email, "Please enter a valid email address.");

    if (!code.value.trim()) fail(code, "Please enter the code from your email.");

    if (!meetsPasswordRules(password.value))
      fail(password, "Use at least 12 characters, including a letter and a number.");

    if (password.value !== confirm.value)
      fail(confirm, "Passwords do not match.");

    if (firstBad) {
      firstBad.focus();
      return;
    }

    setLoading(submitBtn, true, "Verifying…");
    const cleanEmail = email.value.trim().toLowerCase();

    try {
      /* Step 1 — the code proves this is really the account owner, and
         starts a short-lived recovery session. */
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: cleanEmail,
        token: code.value.trim(),
        type: "recovery",
      });
      if (verifyError) throw verifyError;

      /* Step 2 — set the new password within that recovery session. */
      const { error: updateError } = await supabase.auth.updateUser({
        password: password.value,
      });
      if (updateError) throw updateError;

      showAlert(
        alertBox,
        "success",
        "Password updated ✓ Signing you out of this recovery session…"
      );
      form.reset();
      pendingEmail.clear();

      /* End the one-time recovery session so the new password is used next time. */
      await supabase.auth.signOut();

      setTimeout(() => {
        window.location.href = "index.html";
      }, 1600);
    } catch (err) {
      setLoading(submitBtn, false);

      const raw = (err.message || "").toLowerCase();
      if (raw.includes("expired")) {
        showAlert(alertBox, "error", "This code has expired. Please request a new one.", {
          label: "Request a new code",
          onClick: () => (window.location.href = "forgot-password.html"),
        });
      } else if (raw.includes("invalid") || raw.includes("token")) {
        showAlert(alertBox, "error", "That code is incorrect. Please check it and try again.");
        code.focus();
      } else {
        showAlert(alertBox, "error", friendlyError(err));
      }
    }
  });
}

/* ---------------------------------------------------------------------------
 * C) Change password for a signed-in user (for the future settings page)
 *
 *     const result = await studyHubChangePassword(email, oldPw, newPw);
 *     if (!result.ok) showAlert(box, "error", result.message);
 *
 * The current password is checked by re-authenticating against Supabase, not
 * by comparing anything locally. Neither password is stored or logged.
 * ------------------------------------------------------------------------- */
async function studyHubChangePassword(email, currentPassword, newPassword) {
  if (!meetsPasswordRules(newPassword)) {
    return {
      ok: false,
      message: "Use at least 12 characters, including a letter and a number.",
    };
  }
  if (currentPassword === newPassword) {
    return { ok: false, message: "Your new password must be different from your current one." };
  }

  try {
    /* Step 1 — prove the current password is right. */
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: String(email).trim().toLowerCase(),
      password: currentPassword,
    });
    if (signInError) {
      return { ok: false, message: "Your current password is incorrect." };
    }

    /* Step 2 — set the new one. */
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (updateError) throw updateError;

    return { ok: true, message: "Password changed ✓" };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initForgotPassword();
  initResetPassword();
});
