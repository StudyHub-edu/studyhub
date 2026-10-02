document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth({ requireOnboarding: false, allowAdmin: true });
  if (!session) return;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) {
    showAdminAlert("Could not verify your administrator role: " + error.message, "error");
    return;
  }
  if (profile?.role !== "admin") {
    window.location.replace(homeForRole(profile?.role));
    return;
  }

  const institutionSelect = document.getElementById("user-institution");
  const { data: institutions, error: institutionsError } = await supabase
    .from("institutions")
    .select("id, name, city")
    .order("name")
    .limit(500);
  if (institutionsError) {
    setStatus("user-status", "Could not load institutions: " + institutionsError.message, true);
  } else {
    (institutions || []).forEach((institution) => {
      const option = document.createElement("option");
      option.value = institution.id;
      option.textContent = institution.city ? `${institution.name} — ${institution.city}` : institution.name;
      institutionSelect.append(option);
    });
  }

  const userRole = document.getElementById("user-role");
  if (window.location.hash === "#teacher") userRole.value = "teacher";
  const toggleClassLevel = (event) => {
    document.getElementById("class-level-wrap").hidden = event.target.value === "teacher";
  };
  userRole.addEventListener("change", toggleClassLevel);
  toggleClassLevel({ target: userRole });

  document.getElementById("user-form").addEventListener("submit", (event) => submitUser(event, session));
  document.getElementById("institution-form").addEventListener("submit", (event) => submitInstitution(event, session));
  document.getElementById("content-form").addEventListener("submit", (event) => submitContent(event, session));
});

function setStatus(id, message, isError = false) {
  const status = document.getElementById(id);
  status.textContent = message;
  status.dataset.kind = isError ? "error" : "success";
}

function showAdminAlert(message, kind) {
  const alert = document.getElementById("admin-alert");
  alert.hidden = false;
  alert.dataset.kind = kind;
  alert.textContent = message;
  alert.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function adminPost(path, session, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  });
  let result;
  try { result = await response.json(); }
  catch (_) { throw new Error(`The server returned an unexpected response (${response.status}).`); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

async function submitUser(event, session) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const statusId = "user-status";
  button.disabled = true;
  setStatus(statusId, "Creating account…");
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    await adminPost("/api/admin/users", session, {
      ...data,
      institution_id: data.institution_id || null,
    });
    form.reset();
    setStatus(statusId, "Account created. Give the user their initial password securely.");
    showAdminAlert("The account was created successfully.", "success");
  } catch (error) {
    setStatus(statusId, error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function submitInstitution(event, session) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setStatus("institution-status", "Adding institution…");
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    await adminPost("/api/admin/institutions", session, data);
    form.reset();
    setStatus("institution-status", "Institution added to the directory.");
    showAdminAlert("The institution was added successfully.", "success");
    const select = document.getElementById("user-institution");
    select.replaceChildren(new Option("No institution selected", ""));
    const { data: institutions, error } = await supabase.from("institutions").select("id, name, city").order("name").limit(500);
    if (error) throw error;
    (institutions || []).forEach((institution) => {
      const option = new Option(institution.city ? `${institution.name} — ${institution.city}` : institution.name, institution.id);
      select.add(option);
    });
  } catch (error) {
    setStatus("institution-status", error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function submitContent(event, session) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const files = [...form.elements.file.files];
  button.disabled = true;
  setStatus("content-status", "Uploading content…");
  const uploadedPaths = [];

  try {
    if (!files.length) throw new Error("Choose at least one image.");
    if (files.length > 10) throw new Error("Choose no more than 10 images.");
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than the 25 MB limit.`);
      const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.type) && await isSupportedImageFile(file);
      if (!isImage) throw new Error(`Only valid JPG, PNG, and WebP images are supported. Check ${file.name}.`);
    }

    const data = Object.fromEntries(new FormData(form).entries());
    const imageUrls = [];
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      const path = `${session.user.id}/${crypto.randomUUID()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("notes-uploads").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) throw uploadError;
      uploadedPaths.push(path);
      imageUrls.push(supabase.storage.from("notes-uploads").getPublicUrl(path).data.publicUrl);
    }
    const { error: insertError } = await supabase.from("resources").insert({
      title: data.title.trim(),
      subject: data.subject.trim(),
      class_level: data.class_level.trim(),
      chapter: data.chapter.trim() || null,
      description: data.description.trim() || null,
      note_type: "image",
      external_url: imageUrls[0],
      image_urls: imageUrls,
      file_path: uploadedPaths[0],
      allow_download: true,
      uploaded_by: session.user.id,
      status: "approved",
    });
    if (insertError) throw insertError;

    form.reset();
    setStatus("content-status", "Uploaded and published to the Notes library.");
    showAdminAlert("The learning content is published and visible in Notes.", "success");
  } catch (error) {
    let message = error.message || "The content upload failed.";
    if (/bucket.*not found|not found.*bucket/i.test(message)) {
      message = "The notes-uploads bucket is missing. Run backend/supabase/notes_schema.sql in the Supabase SQL Editor, then retry.";
    } else if (/row-level security|new row violates|permission denied|not authorized/i.test(message)) {
      message = "Supabase blocked this upload. Confirm admin_schema.sql and notes_schema.sql have both been run, and that your signed-in account has the admin role.";
    } else if (/column .* does not exist|relation .* does not exist/i.test(message)) {
      message = "The Notes database setup is incomplete. Run backend/supabase/notes_schema.sql in the Supabase SQL Editor, then retry.";
    }
    if (uploadedPaths.length) {
      const { error: cleanupError } = await supabase.storage.from("notes-uploads").remove(uploadedPaths);
      if (cleanupError) message += ` The file cleanup also failed: ${cleanupError.message}`;
    }
    setStatus("content-status", message, true);
  } finally {
    button.disabled = false;
  }
}
