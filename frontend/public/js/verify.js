/* ============================================================================
 * StudyHub — account verification (email OR phone)
 * A single code field is used rather than fixed-length boxes, since email
 * and SMS codes can come out at different lengths depending on provider
 * settings — the code is only ever kept in this input, never in storage.
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  const alertBox = document.getElementById("form-alert");
  const form = document.getElementById("verify-form");
  const codeInput = document.getElementById("verify-code");
  const submitBtn = document.getElementById("submit-btn");
  const resendBtn = document.getElementById("resend-btn");
  const resendStatus = document.getElementById("resend-status");
  const targetValue = document.getElementById("target-value");
  const changeTarget = document.getElementById("change-target");

  const COOLDOWN_SECONDS = 30;
  const MAX_RESENDS = 5;
  let resendCount = 0;
  let cooldownTimer = null;

  /* ------------------------------------------------- who are we verifying? */
  let { value: target, method } = pendingVerification.get();

  if (!target) {
    const session = await getSession();
    if (session?.user?.email) {
      target = session.user.email;
      method = "email";
    } else if (session?.user?.phone) {
      target = session.user.phone;
      method = "phone";
    }
  }

  if (!target) {
    showAlert(
      alertBox,
      "info",
      "We don't know which account to verify. Please start from registration."
    );
    setTimeout(() => (window.location.href = "register.html"), 1800);
    return;
  }

  targetValue.textContent = target;
  changeTarget.href = "register.html";

  /* Someone who is already confirmed doesn't belong here. */
  const existing = await getSession();
  if (existing?.user?.email_confirmed_at || existing?.user?.phone_confirmed_at) {
    pendingVerification.clear();
    window.location.replace(STUDYHUB_DASHBOARD);
    return;
  }

  const otpType = method === "phone" ? "sms" : "signup";
  const identifierKey = method === "phone" ? "phone" : "email";

  /* ------------------------------------------------------------- verify -- */

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    setFieldError(codeInput, "");

    const token = codeInput.value.trim();
    if (!token) {
      setFieldError(
        codeInput,
        "Please enter the code from your " + (method === "phone" ? "text message" : "email") + "."
      );
      codeInput.focus();
      return;
    }

    setLoading(submitBtn, true, "Verifying…");

    try {
      const { data, error } = await supabase.auth.verifyOtp({
        [identifierKey]: target,
        token,
        type: otpType,
      });

      if (error) throw error;
      if (!data.session) throw new Error("auth session missing");

      showAlert(alertBox, "success", "Verified ✓");
      codeInput.disabled = true;
      resendBtn.disabled = true;

      /* The database trigger flips verification_status to 'verified' the
         moment Supabase confirms the account. Read it back so we know the
         profile row exists before the dashboard loads. */
      const profile = await getCurrentProfile();
      if (!profile) {
        console.debug("[StudyHub] profile row not found yet — check the schema triggers.");
      }

      pendingVerification.clear();
      setTimeout(() => {
        window.location.href = STUDYHUB_DASHBOARD;
      }, 900);
    } catch (err) {
      setLoading(submitBtn, false);

      const raw = (err.message || "").toLowerCase();
      if (raw.includes("expired")) {
        setFieldError(codeInput, "This code has expired. Please request a new one.");
      } else if (raw.includes("invalid") || raw.includes("token")) {
        setFieldError(codeInput, "That code is incorrect. Please check it and try again.");
      } else {
        showAlert(alertBox, "error", friendlyError(err));
      }
      codeInput.focus();
      codeInput.select();
    }
  });

  /* ------------------------------------------------------------- resend -- */

  function startCooldown(seconds) {
    let left = seconds;
    resendBtn.disabled = true;
    resendStatus.textContent = `Resend code in ${left}s`;

    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(cooldownTimer);
        resendStatus.textContent = "Didn't get the code?";
        resendBtn.disabled = resendCount >= MAX_RESENDS;
        if (resendCount >= MAX_RESENDS) {
          resendStatus.textContent = "Resend limit reached for now.";
        }
      } else {
        resendStatus.textContent = `Resend code in ${left}s`;
      }
    }, 1000);
  }

  /* The code was already sent by sign-up, so start on cooldown rather than
     firing a second one the moment the page opens. */
  startCooldown(COOLDOWN_SECONDS);
  showAlert(
    alertBox,
    "info",
    method === "phone"
      ? "Check your text messages — it can take a minute to arrive."
      : "Check your inbox — and your spam folder if it isn't there within a minute."
  );

  resendBtn.addEventListener("click", async () => {
    if (resendCount >= MAX_RESENDS) return;
    clearAlert(alertBox);
    setLoading(resendBtn, true, "Sending…");

    try {
      const { error } = await supabase.auth.resend({
        type: otpType,
        [identifierKey]: target,
        ...(method === "email"
          ? { options: { emailRedirectTo: STUDYHUB_VERIFY_REDIRECT } }
          : {}),
      });
      if (error) throw error;

      resendCount += 1;
      showAlert(alertBox, "success", "A new code is on its way.");
      codeInput.value = "";
      codeInput.focus();
    } catch (err) {
      showAlert(alertBox, "error", friendlyError(err));
    } finally {
      setLoading(resendBtn, false);
      startCooldown(COOLDOWN_SECONDS);
    }
  });

  codeInput.focus();
});
