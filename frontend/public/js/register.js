/* ============================================================================
 * StudyHub — registration
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("register-form");
  const alertBox = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");

  const fullName = document.getElementById("full-name");
  const email = document.getElementById("email");
  const phone = document.getElementById("phone");
  const emailField = document.getElementById("email-field");
  const phoneField = document.getElementById("phone-field");
  const password = document.getElementById("password");
  const confirm = document.getElementById("confirm-password");
  const institution = document.getElementById("institution");
  const institutionId = document.getElementById("institution-id");
  const classLevel = document.getElementById("class-level");
  const classField = document.getElementById("class-field");
  const terms = document.getElementById("terms");
  const strength = document.getElementById("strength");
  const googleBtn = document.getElementById("google-btn");

  const currentMethod = () =>
    document.querySelector('input[name="method"]:checked')?.value || "email";

  function paintMethod() {
    const isPhone = currentMethod() === "phone";
    emailField.hidden = isPhone;
    phoneField.hidden = !isPhone;
    setFieldError(email, "");
    setFieldError(phone, "");
  }

  document
    .querySelectorAll('input[name="method"]')
    .forEach((radio) => radio.addEventListener("change", paintMethod));
  paintMethod();

  /* Phone sign-up needs a real E.164 number (leading + and country code),
     since that's what Supabase's phone auth expects. */
  const isE164Phone = (value) => /^\+[1-9]\d{7,14}$/.test(value.trim().replace(/[\s-]/g, ""));

  initPasswordToggles();
  await redirectIfSignedIn();
  initInstitutionCombo("institution", "institution-id", "institution-list", alertBox);

  /* --- account type switches the class/level options ---------------------- */
  const STUDENT_LEVELS = [
    ["", "Select your class or level"],
    ["Grade 9", "Grade 9"],
    ["Grade 10", "Grade 10"],
    ["Grade 11", "Grade 11"],
    ["Grade 12", "Grade 12"],
    ["Other", "Other"],
  ];
  const TEACHER_LEVELS = [["Teacher", "Teacher"]];

  const currentRole = () =>
    document.querySelector('input[name="role"]:checked')?.value || "student";

  function paintClassOptions() {
    const isTeacher = currentRole() === "teacher";
    const options = isTeacher ? TEACHER_LEVELS : STUDENT_LEVELS;
    classLevel.innerHTML = "";
    options.forEach(([value, label]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      classLevel.appendChild(opt);
    });
    classLevel.value = isTeacher ? "Teacher" : "";
    classField.querySelector("label").textContent = isTeacher
      ? "Role at institution"
      : "Class / level";
    setFieldError(classLevel, "");
  }

  document
    .querySelectorAll('input[name="role"]')
    .forEach((radio) => radio.addEventListener("change", paintClassOptions));
  paintClassOptions();

  /* --- live password strength -------------------------------------------- */
  password.addEventListener("input", () => {
    strength.dataset.level = String(passwordStrength(password.value));
  });

  /* --- validation --------------------------------------------------------- */
  function validate() {
    clearFieldErrors(form);
    let firstBad = null;
    const fail = (input, message) => {
      setFieldError(input, message);
      if (!firstBad) firstBad = input;
    };

    if (!fullName.value.trim())
      fail(fullName, "Please enter your full name.");
    else if (fullName.value.trim().length < 3)
      fail(fullName, "Please enter your full name.");

    if (currentMethod() === "email") {
      if (!email.value.trim()) fail(email, "Please enter your email address.");
      else if (!isValidEmail(email.value))
        fail(email, "Please enter a valid email address.");
    } else {
      if (!phone.value.trim()) fail(phone, "Please enter your phone number.");
      else if (!isE164Phone(phone.value))
        fail(phone, "Please enter a valid number with country code, e.g. +9779800000000.");
    }

    if (!password.value) fail(password, "Please create a password.");
    else if (!meetsPasswordRules(password.value))
      fail(
        password,
        "Use at least 12 characters, including a letter and a number."
      );

    if (!confirm.value) fail(confirm, "Please confirm your password.");
    else if (confirm.value !== password.value)
      fail(confirm, "Passwords do not match.");

    if (!classLevel.value)
      fail(classLevel, "Please select your class or level.");

    if (institution.value.trim() && !institutionId.value) {
      institutionId.dataset.customName = institution.value.trim();
      if (institutionId.dataset.otherId) institutionId.value = institutionId.dataset.otherId;
    }

    if (!institution.value.trim() || (!institutionId.value && !institutionId.dataset.customName))
      fail(institution, "Please select a listed institution or choose to use your typed name.");

    if (!terms.checked) {
      showAlert(
        alertBox,
        "error",
        "Please accept the StudyHub Terms and Privacy Policy to continue."
      );
      if (!firstBad) firstBad = terms;
    }

    if (firstBad) {
      firstBad.focus({ preventScroll: false });
      return false;
    }
    return true;
  }

  /* --- submit ------------------------------------------------------------- */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    if (!validate()) return;

    setLoading(submitBtn, true, "Creating account…");

    const method = currentMethod();
    const cleanEmail = method === "email" ? email.value.trim().toLowerCase() : null;
    const cleanPhone = method === "phone" ? phone.value.trim().replace(/[\s-]/g, "") : null;

    const metadata = {
      full_name: fullName.value.trim(),
      role: currentRole(), // clamped to student/teacher server-side
      institution_id: institutionId.value || null,
      institution_name: institutionId.dataset.customName || "",
      class_level: classLevel.value,
    };
    /* Keep a phone in metadata too so the profile trigger can store it even
       when Supabase's own `phone` column is what's actually used for auth. */
    if (cleanPhone) metadata.phone = cleanPhone;

    try {
      const { data, error } = await supabase.auth.signUp(
        method === "email"
          ? {
              email: cleanEmail,
              password: password.value,
              options: {
                data: metadata,
                emailRedirectTo: STUDYHUB_VERIFY_REDIRECT,
              },
            }
          : { phone: cleanPhone, password: password.value, options: { data: metadata } }
      );

      if (error) throw error;

      /* Supabase returns a user with an empty identities array when the
         address/number already exists, rather than leaking that fact outright. */
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setLoading(submitBtn, false);
        showAlert(
          alertBox,
          "error",
          method === "email"
            ? "This email address is already registered. Try logging in."
            : "This phone number is already registered. Try logging in.",
          { label: "Go to login", onClick: () => (window.location.href = "index.html") }
        );
        return;
      }

      /* Only the identifier travels between pages — never the password. */
      pendingVerification.set(method === "email" ? cleanEmail : cleanPhone, method);

      showAlert(
        alertBox,
        "success",
        "Account created. Sending your verification code…"
      );
      form.reset();

      setTimeout(() => {
        window.location.href = "verify.html";
      }, 700);
    } catch (err) {
      setLoading(submitBtn, false);
      showAlert(alertBox, "error", friendlyError(err));
    }
  });

  /* -------------------------------------------------------- Google sign-up */
  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      clearAlert(alertBox);
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
});
