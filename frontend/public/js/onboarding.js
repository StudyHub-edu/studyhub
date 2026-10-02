/* ============================================================================
 * StudyHub — onboarding (fills in what Google sign-in couldn't collect)
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  // requireOnboarding: false is essential here — otherwise a user who still
  // needs onboarding would get bounced right back to this same page.
  const session = await requireAuth({ requireOnboarding: false });
  if (!session) return;

  const form = document.getElementById("onboarding-form");
  const alertBox = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");

  const fullName = document.getElementById("full-name");
  const phone = document.getElementById("phone");
  const institution = document.getElementById("institution");
  const institutionId = document.getElementById("institution-id");
  const classLevel = document.getElementById("class-level");
  const classField = document.getElementById("class-field");

  // If this account somehow already has an institution set, there's nothing
  // to complete — send them straight in rather than asking again.
  const { data: existing } = await supabase
    .from("profiles")
    .select("full_name, phone, role, institution_id, class_level")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (existing?.institution_id || session.user.user_metadata?.institution_name) {
    window.location.replace(STUDYHUB_DASHBOARD);
    return;
  }

  // Prefill whatever we already know — Google usually gives us a name.
  const googleName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || "";
  fullName.value = existing?.full_name && existing.full_name !== "StudyHub member" ? existing.full_name : googleName;
  phone.value = existing?.phone || "";
  if (existing?.role === "teacher") document.getElementById("role-teacher").checked = true;

  initInstitutionCombo("institution", "institution-id", "institution-list", alertBox);
  initPasswordToggles(); // harmless no-op here, kept for consistency with other pages

  const STUDENT_LEVELS = [
    ["", "Select your class or level"],
    ["Grade 9", "Grade 9"],
    ["Grade 10", "Grade 10"],
    ["Grade 11", "Grade 11"],
    ["Grade 12", "Grade 12"],
    ["Other", "Other"],
  ];
  const TEACHER_LEVELS = [["Teacher", "Teacher"]];

  const currentRole = () => document.querySelector('input[name="role"]:checked')?.value || "student";

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
    classField.querySelector("label").textContent = isTeacher ? "Role at institution" : "Class / level";
    setFieldError(classLevel, "");
  }

  document.querySelectorAll('input[name="role"]').forEach((radio) => radio.addEventListener("change", paintClassOptions));
  paintClassOptions();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    clearFieldErrors(form);

    if (institution.value.trim() && !institutionId.value) {
      institutionId.dataset.customName = institution.value.trim();
      if (institutionId.dataset.otherId) institutionId.value = institutionId.dataset.otherId;
    }

    let firstBad = null;
    const fail = (input, message) => {
      setFieldError(input, message);
      if (!firstBad) firstBad = input;
    };

    if (!fullName.value.trim()) fail(fullName, "Please enter your full name.");
    if (!institution.value.trim() || (!institutionId.value && !institutionId.dataset.customName))
      fail(institution, "Please select your school or college from the list.");
    if (!classLevel.value) fail(classLevel, "Please select your class or level.");

    if (firstBad) {
      firstBad.focus();
      return;
    }

    setLoading(submitBtn, true, "Saving…");

    try {
      const { error: metadataError } = await supabase.auth.updateUser({
        data: { institution_name: institutionId.dataset.customName || "" },
      });
      if (metadataError) throw metadataError;

      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: fullName.value.trim(),
          phone: phone.value.trim() || null,
          role: currentRole(),
          institution_id: institutionId.value || null,
          class_level: classLevel.value,
        })
        .eq("user_id", session.user.id);

      if (error) throw error;

      window.location.href = STUDYHUB_DASHBOARD;
    } catch (err) {
      setLoading(submitBtn, false);
      showAlert(alertBox, "error", friendlyError(err));
    }
  });
});
