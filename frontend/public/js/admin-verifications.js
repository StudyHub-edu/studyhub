document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth({ requireOnboarding: false, allowAdmin: true });
  if (!session) return;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (profileError) {
    showVerificationAlert("Could not verify your administrator role: " + profileError.message, "error");
    return;
  }
  if (profile?.role !== "admin") {
    window.location.replace(homeForRole(profile?.role));
    return;
  }

  document.getElementById("verification-filter").addEventListener("change", loadVerifications);
  document.getElementById("verification-refresh").addEventListener("click", loadVerifications);
  await loadVerifications();
});

function showVerificationAlert(message, kind) {
  const alert = document.getElementById("verification-alert");
  alert.hidden = false;
  alert.dataset.kind = kind;
  alert.textContent = message;
}

function appendDetail(dl, label, value, code = false) {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  if (code) {
    const content = document.createElement("code");
    content.textContent = value || "—";
    description.append(content);
  } else {
    description.textContent = value || "—";
  }
  dl.append(term, description);
}

async function loadVerifications() {
  const list = document.getElementById("verification-list");
  const count = document.getElementById("verification-count");
  const filter = document.getElementById("verification-filter").value;
  const refresh = document.getElementById("verification-refresh");
  refresh.disabled = true;
  list.replaceChildren(Object.assign(document.createElement("div"), {
    className: "verification-empty",
    textContent: "Loading submissions…",
  }));
  document.getElementById("verification-alert").hidden = true;

  try {
    let query = supabase
      .from("identity_verifications")
      .select("id, user_id, role_at_submission, image_path, extracted_full_name, extracted_institution_id, extracted_institution_raw, extracted_class_level, extracted_expiry_date, extracted_text, status, review_note, created_at, reviewed_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (filter !== "all") query = query.eq("status", filter);
    const { data: submissions, error } = await query;
    if (error) throw error;

    const userIds = [...new Set((submissions || []).map((item) => item.user_id))];
    let profiles = [];
    if (userIds.length) {
      const { data, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, role, class_level, identity_status, institution_id, institutions(name)")
        .in("user_id", userIds);
      if (profilesError) throw profilesError;
      profiles = data || [];
    }
    const profilesById = new Map(profiles.map((item) => [item.user_id, item]));
    const institutionIds = [...new Set([
      ...profiles.map((item) => item.institution_id),
      ...(submissions || []).map((item) => item.extracted_institution_id),
    ].filter(Boolean))];
    let institutionsById = new Map();
    if (institutionIds.length) {
      const { data, error: institutionsError } = await supabase
        .from("institutions")
        .select("id, name")
        .in("id", institutionIds);
      if (institutionsError) throw institutionsError;
      institutionsById = new Map((data || []).map((item) => [item.id, item.name]));
    }
    count.textContent = `${(submissions || []).length} submission${submissions?.length === 1 ? "" : "s"}${filter === "pending" ? " awaiting review" : ""}`;

    if (!submissions?.length) {
      list.replaceChildren(Object.assign(document.createElement("div"), {
        className: "verification-empty",
        textContent: filter === "pending" ? "No ID submissions are waiting for review." : "No ID submissions found.",
      }));
      return;
    }

    const cards = await Promise.all(submissions.map((item) => renderVerificationCard(item, profilesById.get(item.user_id), institutionsById)));
    list.replaceChildren(...cards);
  } catch (error) {
    list.replaceChildren(Object.assign(document.createElement("div"), {
      className: "verification-empty",
      textContent: "Could not load verification submissions.",
    }));
    showVerificationAlert(error.message || "Could not load verification submissions.", "error");
  } finally {
    refresh.disabled = false;
  }
}

async function renderVerificationCard(item, profile, institutionsById) {
  const article = document.createElement("article");
  article.className = "verification-card";

  const head = document.createElement("div");
  head.className = "verification-card__head";
  const heading = document.createElement("div");
  const name = document.createElement("h2");
  name.textContent = profile?.full_name || item.extracted_full_name || "StudyHub user";
  const subtitle = document.createElement("p");
  subtitle.textContent = `${item.role_at_submission} · Submitted ${new Date(item.created_at).toLocaleString()}`;
  heading.append(name, subtitle);
  const badge = document.createElement("span");
  badge.className = "verification-status";
  badge.dataset.status = item.status;
  badge.textContent = item.status;
  head.append(heading, badge);

  const body = document.createElement("div");
  body.className = "verification-card__body";
  const photo = document.createElement("div");
  photo.className = "verification-photo";
  const { data: signed, error: signedError } = await supabase.storage
    .from("id-cards")
    .createSignedUrl(item.image_path, 600);
  if (signedError) {
    photo.textContent = "ID photo is unavailable: " + signedError.message;
  } else {
    const link = document.createElement("a");
    link.href = signed.signedUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Open submitted ID photo in a new tab");
    const image = document.createElement("img");
    image.src = signed.signedUrl;
    image.alt = `ID card submitted by ${profile?.full_name || "user"}`;
    image.loading = "lazy";
    link.append(image);
    photo.append(link);
  }

  const details = document.createElement("section");
  details.className = "verification-details";
  const accountHeading = document.createElement("h3");
  accountHeading.textContent = "Account information";
  const fields = document.createElement("dl");
  appendDetail(fields, "Account name", profile?.full_name);
  appendDetail(fields, "Account role", profile?.role || item.role_at_submission);
  appendDetail(fields, "Account class", profile?.class_level);
  appendDetail(fields, "Account institution", institutionsById.get(profile?.institution_id) || profile?.institutions?.name);
  appendDetail(fields, "Submitted ID name", item.extracted_full_name);
  appendDetail(fields, "ID institution", institutionsById.get(item.extracted_institution_id) || item.extracted_institution_raw);
  appendDetail(fields, "ID class", item.extracted_class_level);
  appendDetail(fields, "ID expiry", item.extracted_expiry_date);
  appendDetail(fields, "Account ID", item.user_id, true);
  details.append(accountHeading, fields);

  const ocr = document.createElement("div");
  ocr.className = "verification-ocr";
  const ocrHeading = document.createElement("h3");
  ocrHeading.textContent = "Text detected on ID";
  const rawText = document.createElement("pre");
  rawText.textContent = item.extracted_text || "No OCR text was stored for this submission.";
  ocr.append(ocrHeading, rawText);
  details.append(ocr);
  body.append(photo, details);
  article.append(head, body);

  if (item.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "verification-card__actions";
    const note = document.createElement("textarea");
    note.className = "verification-note";
    note.maxLength = 500;
    note.placeholder = "Optional review note (shown to the user if rejected)";
    note.setAttribute("aria-label", "Optional review note");
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "verification-reject";
    reject.textContent = "Not verified";
    reject.addEventListener("click", () => reviewVerification(item.id, false, note, actions));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "verification-approve";
    approve.textContent = "Verify account";
    approve.addEventListener("click", () => reviewVerification(item.id, true, note, actions));
    actions.append(note, reject, approve);
    article.append(actions);
  } else if (item.review_note) {
    const note = document.createElement("p");
    note.className = "verification-review-note";
    note.textContent = `Admin note: ${item.review_note}`;
    article.append(note);
  }

  return article;
}

async function reviewVerification(id, approve, note, actions) {
  const buttons = actions.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const { error } = await supabase.rpc("review_identity", {
      p_id: id,
      p_approve: approve,
      p_note: note.value.trim() || null,
    });
    if (error) throw error;
    showVerificationAlert(approve ? "The account identity was verified." : "The ID submission was rejected.", "success");
    await loadVerifications();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showVerificationAlert(error.message || "Could not update this verification.", "error");
  }
}
