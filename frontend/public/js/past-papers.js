const PAPER_BUCKET = "past-papers";
const MAX_PAPER_BYTES = 25 * 1024 * 1024;
let paperUserId = null;
let paperProfile = null;
let papers = [];

(async () => {
  const session = await requireAuth();
  if (!session) return;
  paperUserId = session.user.id;
  paperProfile = await loadIdentity(session);

  const dashboard = homeForRole(paperProfile?.role);
  document.getElementById("paper-year").value = new Date().getFullYear();
  document.getElementById("back-link").href = dashboard;
  document.getElementById("home-link").href = dashboard;
  if (!["student", "teacher", "admin"].includes(paperProfile?.role)) {
    setStatus("Your account profile is not ready yet. Complete onboarding before using Past Papers.", true);
    return;
  }

  wirePastPapers();
  await loadPastPapers();
})();

function setStatus(message, isError = false) {
  const status = document.getElementById("papers-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function wirePastPapers() {
  ["filter-search", "filter-level", "filter-exam", "filter-institution", "filter-year"].forEach((id) => {
    document.getElementById(id).addEventListener(id === "filter-search" ? "input" : "change", renderPapers);
  });

  const modal = document.getElementById("upload-modal");
  const close = () => { modal.hidden = true; };
  document.getElementById("upload-open").addEventListener("click", () => {
    document.getElementById("upload-error").textContent = "";
    modal.hidden = false;
    document.getElementById("paper-title").focus();
  });
  document.getElementById("upload-close").addEventListener("click", close);
  document.getElementById("upload-cancel").addEventListener("click", close);
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.hidden) close(); });
  document.getElementById("upload-form").addEventListener("submit", uploadPastPaper);
}

async function loadPastPapers() {
  const grid = document.getElementById("papers-grid");
  grid.innerHTML = '<div class="paper-empty">Loading past papers…</div>';
  setStatus("");

  const { data, error } = await supabase
    .from("past_papers")
    .select("id,title,exam_name,education_level,subject,exam_year,institution_name,description,uploader_name,file_path,image_paths,uploaded_by,created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    grid.innerHTML = "";
    const missing = error.code === "42P01" || error.code === "PGRST205" || /past_papers.*not exist|could not find.*past_papers/i.test(error.message || "");
    setStatus(missing
      ? "Past Papers setup is missing. Run backend/supabase/past_papers_schema.sql in your Supabase SQL Editor."
      : `Could not load past papers: ${friendlyError(error)}`, true);
    return;
  }

  papers = data || [];
  const paths = papers.flatMap((paper) => Array.isArray(paper.image_paths) && paper.image_paths.length ? paper.image_paths : [paper.file_path]);
  if (paths.length) {
    const { data: signed, error: signedError } = await supabase.storage.from(PAPER_BUCKET).createSignedUrls(paths, 600);
    if (signedError) {
      setStatus(`Could not load question-paper images: ${friendlyError(signedError)}`, true);
      return;
    }
    let offset = 0;
    papers.forEach((paper) => {
      const count = Array.isArray(paper.image_paths) && paper.image_paths.length ? paper.image_paths.length : 1;
      paper.imageUrls = signed.slice(offset, offset + count).map((item) => item.signedUrl).filter(Boolean);
      offset += count;
    });
  }
  populatePaperFilters();
  renderPapers();
}

function populatePaperFilters() {
  const filters = [
    ["filter-level", "education_level", "All levels"],
    ["filter-exam", "exam_name", "All exams"],
    ["filter-institution", "institution_name", "All schools / colleges"],
    ["filter-year", "exam_year", "All years"],
  ];
  for (const [id, field, label] of filters) {
    const select = document.getElementById(id);
    const current = select.value;
    const values = [...new Set(papers.map((paper) => String(paper[field] || "")).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    select.replaceChildren(new Option(label, ""), ...values.map((value) => new Option(value, value)));
    select.value = values.includes(current) ? current : "";
  }
}

function renderPapers() {
  const grid = document.getElementById("papers-grid");
  const query = document.getElementById("filter-search").value.trim().toLowerCase();
  const level = document.getElementById("filter-level").value;
  const exam = document.getElementById("filter-exam").value;
  const institution = document.getElementById("filter-institution").value;
  const year = document.getElementById("filter-year").value;
  const rows = papers.filter((paper) => {
    const searchable = [paper.title, paper.exam_name, paper.education_level, paper.subject, paper.institution_name, paper.description].join(" ").toLowerCase();
    return (!query || searchable.includes(query))
      && (!level || paper.education_level === level)
      && (!exam || paper.exam_name === exam)
      && (!institution || paper.institution_name === institution)
      && (!year || String(paper.exam_year) === year);
  });

  setStatus(rows.length ? `${rows.length} paper${rows.length === 1 ? "" : "s"}` : "");
  if (!rows.length) {
    grid.innerHTML = `<div class="paper-empty">${papers.length ? "No papers match those filters." : "No past papers have been shared yet. Upload the first question-paper image for your class."}</div>`;
    return;
  }

  grid.innerHTML = rows.map((paper) => `
    <article class="paper-card">
      <span class="paper-card__year">${escapeHtml(String(paper.exam_year))}</span>
      <h2>${escapeHtml(paper.title)}</h2>
      <div class="paper-card__meta">
        ${escapeHtml(paper.exam_name)} · ${escapeHtml(paper.education_level)}<br>
        ${escapeHtml(paper.subject)}<br>
        ${escapeHtml(paper.institution_name)}<br>
        Shared by ${escapeHtml(paper.uploader_name || "StudyHub member")}
      </div>
      ${paper.description ? `<p class="paper-card__description">${escapeHtml(paper.description)}</p>` : ""}
      ${!(/\.pdf$/i.test(paper.file_path)) && paper.imageUrls?.length ? `<div class="paper-card__gallery">${paper.imageUrls.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(paper.title)} image ${index + 1}" loading="lazy"></a>`).join("")}</div>` : ""}
      <footer class="paper-card__footer">
        <span>${new Date(paper.created_at).toLocaleDateString()}</span>
        <span class="paper-card__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-open-paper="${paper.id}"><span class="btn__label">${/\.pdf$/i.test(paper.file_path) ? "Open PDF" : "Open image"}</span></button>
          ${paper.uploaded_by === paperUserId ? `<button class="btn btn--ghost btn--sm" type="button" data-delete-paper="${paper.id}"><span class="btn__label">Delete</span></button>` : ""}
        </span>
      </footer>
    </article>
  `).join("");

  grid.querySelectorAll("[data-open-paper]").forEach((button) => button.addEventListener("click", () => openPaper(button.dataset.openPaper)));
  grid.querySelectorAll("[data-delete-paper]").forEach((button) => button.addEventListener("click", () => deletePaper(button.dataset.deletePaper)));
}

async function uploadPastPaper(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = document.getElementById("upload-error");
  const submit = document.getElementById("upload-submit");
  errorBox.textContent = "";

  const files = [...document.getElementById("paper-file").files];
  if (!files.length) { errorBox.textContent = "Choose at least one question-paper image."; return; }
  if (files.length > 10) { errorBox.textContent = "Choose no more than 10 images."; return; }
  for (const file of files) {
    if (file.size > MAX_PAPER_BYTES) { errorBox.textContent = `${file.name} is larger than 25 MB.`; return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || !(await isSupportedImageFile(file))) {
      errorBox.textContent = `Upload a valid JPG, PNG, or WebP image. Check ${file.name}.`;
      return;
    }
  }

  setLoading(submit, true, "Uploading…");
  const filePaths = [];

  try {
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      const path = `${paperUserId}/${crypto.randomUUID()}-${safeName}`;
      const { error: storageError } = await supabase.storage.from(PAPER_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (storageError) throw storageError;
      filePaths.push(path);
    }

    const institutionName = document.getElementById("paper-institution").value.trim();
    const { error: rowError } = await supabase.from("past_papers").insert({
      title: document.getElementById("paper-title").value.trim(),
      exam_name: document.getElementById("paper-exam").value.trim(),
      education_level: document.getElementById("paper-level").value.trim(),
      subject: document.getElementById("paper-subject").value.trim(),
      exam_year: Number(document.getElementById("paper-year").value),
      institution_name: institutionName,
      description: document.getElementById("paper-description").value.trim(),
      uploader_name: paperProfile?.full_name || "StudyHub member",
      file_path: filePaths[0],
      image_paths: filePaths,
      uploaded_by: paperUserId,
    });
    if (rowError) throw rowError;

    form.reset();
    document.getElementById("paper-year").value = new Date().getFullYear();
    document.getElementById("upload-modal").hidden = true;
    await loadPastPapers();
  } catch (error) {
    if (filePaths.length) {
      const { error: cleanupError } = await supabase.storage.from(PAPER_BUCKET).remove(filePaths);
      if (cleanupError) console.error("[Past Papers] Uploaded file cleanup failed:", cleanupError.message);
    }
    errorBox.textContent = `Could not upload this paper: ${friendlyError(error)}`;
  } finally {
    setLoading(submit, false);
  }
}

async function openPaper(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  const preview = window.open("about:blank", "_blank");
  if (!preview) {
    setStatus("Allow pop-ups for StudyHub to open the private paper image in a new tab.", true);
    return;
  }
  const button = document.querySelector(`[data-open-paper="${CSS.escape(id)}"]`);
  if (button) setLoading(button, true, "Opening…");
  const { data, error } = paper.imageUrls?.length
    ? { data: { signedUrl: paper.imageUrls[0] }, error: null }
    : await supabase.storage.from(PAPER_BUCKET).createSignedUrl(paper.file_path, 300);
  if (button) setLoading(button, false);
  if (error) {
    preview.close();
    setStatus(`Could not open this paper image: ${friendlyError(error)}`, true);
    return;
  }
  preview.opener = null;
  preview.location.replace(data.signedUrl);
}

async function deletePaper(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper || paper.uploaded_by !== paperUserId) return;
  if (!confirm(`Delete "${paper.title}"? This permanently removes the paper image.`)) return;

  const filePaths = Array.isArray(paper.image_paths) && paper.image_paths.length ? paper.image_paths : [paper.file_path];
  const { error: storageError } = await supabase.storage.from(PAPER_BUCKET).remove(filePaths);
  if (storageError) {
    setStatus(`Could not remove the paper image: ${friendlyError(storageError)}`, true);
    return;
  }
  const { error: rowError } = await supabase.from("past_papers").delete().eq("id", id).eq("uploaded_by", paperUserId);
  if (rowError) {
    setStatus(`The image was removed, but its paper record could not be deleted: ${friendlyError(rowError)}`, true);
    return;
  }
  await loadPastPapers();
}
