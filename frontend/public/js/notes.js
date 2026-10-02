/* ============================================================================
 * StudyHub — Notes page
 * Reads/writes public.resources (extended by supabase/notes_schema.sql),
 * public.note_saves, public.note_ratings, and the public.note_details view.
 * Uploaded files go to the "notes-uploads" Storage bucket.
 * ========================================================================== */

const COMMON_SUBJECTS = ["Mathematics", "Science", "English", "Social Studies", "Computer Science", "Nepali", "Physics", "Chemistry", "Biology", "Accountancy", "Economics"];
const COMMON_CLASSES = ["Class 9", "Class 10", "Class 11", "Class 12", "Bachelor's"];

const TYPE_ICON = {
  text: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><path d="M9 13h6M9 17h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  video_link: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m22 8-5 4 5 4V8Z"/>',
  video_file: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m22 8-5 4 5 4V8Z"/>',
};

let me = null;
let myProfile = null;
let mySavedIds = new Set();
let currentTab = "all";
let page = 0;
const PAGE_SIZE = 24;

/* escapeHtml() is already defined globally by auth.js, loaded before this file. */
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 2592000) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function starsSvg(filled) {
  return `<svg viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6"><path d="m12 2.5 3 6.4 6.8.7-5 4.8 1.3 6.8L12 17.8 5.9 21.2l1.3-6.8-5-4.8 6.8-.7Z"/></svg>`;
}

/* ------------------------------------------------------------------ boot */

(async () => {
  const session = await requireAuth();
  if (!session) return;
  me = session.user.id;
  myProfile = await loadIdentity(session);

  const home = myProfile?.role === "admin" ? "admin-dashboard.html" : myProfile?.role === "teacher" ? "teacher-dashboard.html" : "dashboard.html";
  document.getElementById("back-link").href = home;
  document.getElementById("home-link").href = home;

  await populateFilterOptions();
  await loadMySaves();
  await loadNotes(true);

  wireHeader();
  wireTabs();
  wireFilters();
  wireUploadModal();
})();

/* --------------------------------------------------------- filter setup */

async function populateFilterOptions() {
  const subjectSel = document.getElementById("filter-subject");
  const classSel = document.getElementById("filter-class");
  const subjectList = document.getElementById("subject-list");
  const classList = document.getElementById("class-list");

  let subjects = new Set(COMMON_SUBJECTS);
  let classes = new Set(COMMON_CLASSES);
  try {
    const { data } = await supabase.from("note_details").select("subject, class_level").eq("status", "approved").limit(500);
    (data || []).forEach((r) => {
      if (r.subject) subjects.add(r.subject);
      if (r.class_level) classes.add(r.class_level);
    });
  } catch (err) { console.debug("[Notes] filter options:", err.message); }

  [...subjects].sort().forEach((s) => {
    subjectSel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
    subjectList.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(s)}">`);
  });
  [...classes].sort().forEach((c) => {
    classSel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
    classList.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(c)}">`);
  });
}

async function loadMySaves() {
  try {
    const { data, error } = await supabase.from("note_saves").select("resource_id").eq("user_id", me);
    if (error) throw error;
    mySavedIds = new Set((data || []).map((r) => r.resource_id));
  } catch (err) { console.debug("[Notes] my saves:", err.message); }
}

/* ------------------------------------------------------------- load list */

async function loadNotes(reset) {
  const grid = document.getElementById("notes-grid");
  if (reset) { page = 0; grid.innerHTML = renderSkeletons(); }

  const subject = document.getElementById("filter-subject").value;
  const classLevel = document.getElementById("filter-class").value;
  const noteType = document.getElementById("filter-type").value;
  const sortBy = document.getElementById("sort-by").value;
  const q = document.getElementById("search-input").value.trim();

  try {
    let rows = [];
    if (currentTab === "saved") {
      const ids = [...mySavedIds];
      if (!ids.length) { rows = []; }
      else {
        const { data, error } = await supabase.from("note_details").select("*").in("id", ids);
        if (error) throw error;
        rows = data || [];
      }
    } else {
      let query = supabase.from("note_details").select("*");
      if (currentTab === "mine") query = query.eq("uploaded_by", me);
      else query = query.eq("status", "approved");

      if (subject) query = query.eq("subject", subject);
      if (classLevel) query = query.eq("class_level", classLevel);
      if (noteType) query = query.eq("note_type", noteType);
      if (q) query = query.or(`title.ilike.%${q}%,subject.ilike.%${q}%,chapter.ilike.%${q}%,description.ilike.%${q}%`);

      if (sortBy === "popular") query = query.order("save_count", { ascending: false });
      else if (sortBy === "rating") query = query.order("avg_rating", { ascending: false });
      else query = query.order("created_at", { ascending: false });

      query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) throw error;
      rows = data || [];
    }

    if (reset) grid.innerHTML = "";
    if (!rows.length && page === 0) {
      grid.innerHTML = renderEmptyState();
      document.getElementById("load-more-wrap").hidden = true;
      return;
    }
    grid.insertAdjacentHTML("beforeend", rows.map(renderCard).join(""));
    document.getElementById("load-more-wrap").hidden = rows.length < PAGE_SIZE || currentTab === "saved";
    grid.querySelectorAll(".note-card[data-new]").forEach(wireCard);
  } catch (err) {
    console.debug("[Notes] load:", err.message);
    if (reset) grid.innerHTML = `<div class="empty-state"><p>Couldn't load notes right now.</p></div>`;
  }
}

function renderSkeletons() {
  return Array.from({ length: 6 }).map(() => `<div class="skeleton" style="height:190px;border-radius:16px;"></div>`).join("");
}
function renderEmptyState() {
  const msgs = {
    all: ["No notes match your filters yet.", "Be the first to upload one for your class."],
    mine: ["You haven't uploaded any notes yet.", "Click \u201c+ Upload\u201d to share your first one."],
    saved: ["You haven't saved any notes yet.", "Tap the bookmark icon on a note to save it here."],
  };
  const [line1, line2] = msgs[currentTab] || msgs.all;
  return `<div class="empty-state" style="grid-column:1/-1;padding:3rem 1rem;">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>
    <p>${line1}</p><p style="font-size:.8rem;">${line2}</p>
  </div>`;
}

function renderCard(n) {
  const isSaved = mySavedIds.has(n.id);
  const statusBadge = n.uploaded_by === me && n.status !== "approved"
    ? `<span class="note-card__status ${n.status}">${n.status === "pending" ? "Pending Approval" : "Rejected"}</span>` : "";
  return `
  <div class="note-card" data-new data-id="${n.id}">
    <div class="note-card__top">
      <span class="note-card__type-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICON[n.note_type] || TYPE_ICON.text}</svg></span>
      <button type="button" class="note-card__save ${isSaved ? "is-saved" : ""}" data-save-btn aria-label="Save">${starsSvg(false)}</button>
    </div>
    <div class="note-card__title">${escapeHtml(n.title)}</div>
    <div class="note-card__meta">${escapeHtml(n.subject || "")}${n.class_level ? " · " + escapeHtml(n.class_level) : ""}${n.chapter ? " · " + escapeHtml(n.chapter) : ""}</div>
    ${n.description ? `<div class="note-card__desc">${escapeHtml(n.description)}</div>` : ""}
    ${statusBadge}
    <div class="note-card__footer">
      <div class="note-card__uploader">
        <span class="avatar avatar--sm" style="width:20px;height:20px;font-size:.6rem;">${(n.uploader_name || "?").slice(0, 1).toUpperCase()}</span>
        <span>${escapeHtml(n.uploader_name || "Unknown")}</span>
      </div>
      <div class="note-card__stats">
        <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.5 3 6.4 6.8.7-5 4.8 1.3 6.8L12 17.8 5.9 21.2l1.3-6.8-5-4.8 6.8-.7Z"/></svg>${n.avg_rating > 0 ? n.avg_rating : "—"}</span>
        <span>${n.save_count} saved</span>
        <span>${timeAgo(n.created_at)}</span>
      </div>
    </div>
  </div>`;
}

function wireCard(card) {
  card.removeAttribute("data-new");
  const id = card.dataset.id;
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-save-btn]")) return;
    openDetail(id);
  });
  const saveBtn = card.querySelector("[data-save-btn]");
  saveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await toggleSave(id, saveBtn);
  });
}

async function toggleSave(id, btnEl) {
  const isSaved = mySavedIds.has(id);
  btnEl.disabled = true;
  try {
    if (isSaved) {
      const { error } = await supabase.from("note_saves").delete().eq("user_id", me).eq("resource_id", id);
      if (error) throw error;
      mySavedIds.delete(id);
    } else {
      const { error } = await supabase.from("note_saves").insert({ user_id: me, resource_id: id });
      if (error) throw error;
      mySavedIds.add(id);
    }
    document.querySelectorAll(`.note-card[data-id="${id}"] [data-save-btn]`).forEach((b) => b.classList.toggle("is-saved", !isSaved));
    if (currentTab === "saved" && isSaved) loadNotes(true);
  } catch (err) {
    console.debug("[Notes] toggle save:", err.message);
  } finally {
    btnEl.disabled = false;
  }
}

/* ---------------------------------------------------------------- header */

function wireHeader() {
  document.getElementById("search-form").addEventListener("submit", (e) => { e.preventDefault(); loadNotes(true); });
  document.getElementById("search-input").addEventListener("input", debounce(() => loadNotes(true), 350));
  document.getElementById("upload-btn").addEventListener("click", () => openUploadModal());
  document.getElementById("load-more-btn").addEventListener("click", () => { page++; loadNotes(false); });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function wireTabs() {
  document.querySelectorAll(".notes-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".notes-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      currentTab = tab.dataset.tab;
      loadNotes(true);
    });
  });
}
function wireFilters() {
  ["filter-subject", "filter-class", "filter-type", "sort-by"].forEach((id) =>
    document.getElementById(id).addEventListener("change", () => loadNotes(true))
  );
}

/* ============================================================ UPLOAD MODAL */

let uploadType = "text";

function wireUploadModal() {
  const modal = document.getElementById("upload-modal");
  document.getElementById("upload-close").addEventListener("click", closeUploadModal);
  document.getElementById("upload-cancel").addEventListener("click", closeUploadModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeUploadModal(); });

  document.querySelectorAll(".type-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".type-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      uploadType = tab.dataset.type;
      document.querySelectorAll("[data-field-for]").forEach((f) => (f.hidden = f.dataset.fieldFor !== uploadType));
      document.getElementById("photo-required-label").textContent = uploadType === "image" ? "(required)" : "(optional)";
    });
  });

  document.getElementById("upload-form").addEventListener("submit", submitUpload);
}

function openUploadModal() {
  document.getElementById("upload-form").reset();
  document.getElementById("upload-error").textContent = "";
  uploadType = "text";
  document.getElementById("photo-required-label").textContent = "(optional)";
  document.querySelectorAll(".type-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.type === "text"));
  document.querySelectorAll("[data-field-for]").forEach((f) => (f.hidden = f.dataset.fieldFor !== "text"));
  document.getElementById("upload-modal").hidden = false;
}
function closeUploadModal() { document.getElementById("upload-modal").hidden = true; }

async function submitUpload(e) {
  e.preventDefault();
  const errEl = document.getElementById("upload-error");
  errEl.textContent = "";

  const title = document.getElementById("f-title").value.trim();
  const subject = document.getElementById("f-subject").value.trim();
  const classLevel = document.getElementById("f-class").value.trim();
  const chapter = document.getElementById("f-chapter").value.trim();
  const description = document.getElementById("f-desc").value.trim();
  const tags = document.getElementById("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const allowDownload = document.getElementById("f-allow-download").checked;

  if (!title || !subject || !classLevel) { errEl.textContent = "Title, subject and class are required."; return; }

  let contentText = null, externalUrl = null, filePath = null;
  let imageUrls = [];
  const uploadedPaths = [];

  if (uploadType === "text") {
    contentText = document.getElementById("f-content").value.trim();
    if (!contentText) { errEl.textContent = "Please write your note content."; return; }
  } else if (uploadType === "link") {
    externalUrl = document.getElementById("f-link").value.trim();
    if (!externalUrl) { errEl.textContent = "Please add a link."; return; }
  } else if (uploadType === "video_link") {
    externalUrl = document.getElementById("f-video-link").value.trim();
    if (!externalUrl) { errEl.textContent = "Please add a video link."; return; }
  }
  const files = [...document.getElementById("f-image").files];
  if (uploadType === "image" && !files.length) { errEl.textContent = "Please choose at least one image."; return; }
  if (files.length > 10) { errEl.textContent = "Choose no more than 10 images."; return; }
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { errEl.textContent = `${file.name} is larger than 25MB.`; return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || !(await isSupportedImageFile(file))) {
      errEl.textContent = `Upload valid JPG, PNG, or WebP images. Check ${file.name}.`;
      return;
    }
  }
  if (files.length) {
    const submitBtn = document.getElementById("upload-submit");
    submitBtn.disabled = true;
    submitBtn.querySelector(".btn__label").textContent = "Uploading…";
    try {
      for (const file of files) {
        const path = `${me}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100)}`;
        const { error: upErr } = await supabase.storage.from("notes-uploads").upload(path, file, { contentType: file.type });
        if (upErr) throw upErr;
        uploadedPaths.push(path);
        const { data: pub } = supabase.storage.from("notes-uploads").getPublicUrl(path);
        imageUrls.push(pub.publicUrl);
      }
      if (uploadType === "image") {
        filePath = uploadedPaths[0];
        externalUrl = imageUrls[0];
      }
    } catch (err) {
      errEl.textContent = "Upload failed: " + err.message;
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage.from("notes-uploads").remove(uploadedPaths);
        if (cleanupError) console.error("[Notes] Could not clean up partial image uploads:", cleanupError.message);
      }
      uploadedPaths.length = 0;
      imageUrls = [];
      submitBtn.disabled = false;
      submitBtn.querySelector(".btn__label").textContent = "Upload";
      return;
    }
  }

  const submitBtn = document.getElementById("upload-submit");
  submitBtn.disabled = true;
  submitBtn.querySelector(".btn__label").textContent = "Saving…";

  try {
    const { error } = await supabase.from("resources").insert({
      title, subject, class_level: classLevel, chapter: chapter || null,
      description: description || null, tags, note_type: uploadType,
      image_urls: imageUrls,
      content_text: contentText, external_url: externalUrl, file_path: filePath,
      allow_download: allowDownload, uploaded_by: me, status: "pending",
    });
    if (error) throw error;
    closeUploadModal();
    document.querySelector('.notes-tab[data-tab="mine"]').click();
  } catch (err) {
    errEl.textContent = "Couldn't save your note: " + err.message;
    if (uploadedPaths.length) {
      const { error: cleanupError } = await supabase.storage.from("notes-uploads").remove(uploadedPaths);
      if (cleanupError) console.error("[Notes] Could not clean up uploaded images:", cleanupError.message);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector(".btn__label").textContent = "Upload";
  }
}

/* ============================================================ DETAIL MODAL */

async function openDetail(id) {
  const modal = document.getElementById("detail-modal");
  const card = document.getElementById("detail-card");
  card.innerHTML = `<div class="skeleton" style="height:220px;border-radius:12px;"></div>`;
  modal.hidden = false;

  try {
    const { data: n, error } = await supabase.from("note_details").select("*").eq("id", id).single();
    if (error) throw error;

    let myRating = 0;
    try {
      const { data: r } = await supabase.from("note_ratings").select("rating").eq("resource_id", id).eq("user_id", me).maybeSingle();
      myRating = r?.rating || 0;
    } catch (err) { /* no rating yet */ }

    const isOwner = n.uploaded_by === me;
    const isAdmin = myProfile?.role === "admin";
    const isSaved = mySavedIds.has(id);

    card.innerHTML = `
      <div class="modal-card__head">
        <h2>${escapeHtml(n.title)}</h2>
        <button type="button" class="modal-close" id="detail-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="detail-meta-row">
        <span class="badge">${escapeHtml(n.subject || "")}</span>
        ${n.class_level ? `<span class="badge">${escapeHtml(n.class_level)}</span>` : ""}
        ${n.chapter ? `<span class="badge">${escapeHtml(n.chapter)}</span>` : ""}
        ${n.uploaded_by === me && n.status !== "approved" ? `<span class="badge" style="color:#e2a15c;">${n.status === "pending" ? "Pending Approval" : "Rejected"}</span>` : ""}
      </div>
      <div class="detail-uploader">
        <span class="avatar avatar--md">${(n.uploader_name || "?").slice(0, 1).toUpperCase()}</span>
        <div>
          <div class="detail-uploader__name">${escapeHtml(n.uploader_name || "Unknown")}</div>
          <div class="detail-uploader__meta">${escapeHtml(n.uploader_role || "")}${n.institution_name ? " · " + escapeHtml(n.institution_name) : ""} · ${timeAgo(n.created_at)}</div>
        </div>
      </div>
      ${n.description ? `<div class="detail-body">${escapeHtml(n.description)}</div>` : ""}
      <div class="detail-body" id="detail-content">${renderContent(n)}</div>
      <div class="detail-stats-row">
        <div class="star-rate" id="star-rate">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" class="${i <= myRating ? "is-on" : ""}">${starsSvg(i <= myRating)}</button>`).join("")}</div>
        <div style="font-size:.8rem;color:var(--text-faint);">${n.avg_rating > 0 ? n.avg_rating + " avg · " : ""}${n.rating_count} rating${n.rating_count === 1 ? "" : "s"} · ${n.views_count} views</div>
      </div>
      <div class="detail-actions">
        <button type="button" class="note-card__save ${isSaved ? "is-saved" : ""}" id="detail-save-btn" style="width:auto;padding:.55rem 1rem;border-radius:var(--r-sm);display:inline-flex;gap:.4rem;align-items:center;">
          ${starsSvg(false)}<span>${isSaved ? "Saved" : "Save"}</span>
        </button>
        ${n.external_url && n.allow_download ? `<a class="btn btn--primary btn--sm" id="detail-download" href="${escapeHtml(n.external_url)}" target="_blank" rel="noopener"><span class="btn__label">${n.note_type.startsWith("video") ? "Open video" : n.note_type === "link" ? "Open link" : "Download"}</span></a>` : ""}
        ${isOwner || isAdmin ? `<button type="button" class="btn btn--ghost btn--sm" id="detail-delete"><span class="btn__label" style="color:var(--danger);">Delete</span></button>` : ""}
      </div>
    `;

    document.getElementById("detail-close").addEventListener("click", () => (modal.hidden = true));

    document.getElementById("detail-save-btn").addEventListener("click", async () => {
      await toggleSave(id, document.getElementById("detail-save-btn"));
      const nowSaved = mySavedIds.has(id);
      document.getElementById("detail-save-btn").classList.toggle("is-saved", nowSaved);
      document.getElementById("detail-save-btn").querySelector("span").textContent = nowSaved ? "Saved" : "Save";
    });

    document.querySelectorAll("#star-rate [data-star]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rating = Number(btn.dataset.star);
        try {
          const { error } = await supabase.from("note_ratings").upsert({ user_id: me, resource_id: id, rating, updated_at: new Date().toISOString() }, { onConflict: "user_id,resource_id" });
          if (error) throw error;
          document.querySelectorAll("#star-rate [data-star]").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.star) <= rating));
        } catch (err) { console.debug("[Notes] rate:", err.message); }
      });
    });

    const deleteBtn = document.getElementById("detail-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        if (!confirm("Delete this note? This can't be undone.")) return;
        try {
          const { error } = await supabase.from("resources").delete().eq("id", id);
          if (error) throw error;
          modal.hidden = true;
          loadNotes(true);
          const paths = new Set([n.file_path, ...(n.image_urls || []).map((url) => {
            const marker = "/storage/v1/object/public/notes-uploads/";
            const index = url.indexOf(marker);
            return index >= 0 ? decodeURIComponent(url.slice(index + marker.length)) : "";
          })].filter(Boolean));
          if (paths.size) {
            const { error: cleanupError } = await supabase.storage.from("notes-uploads").remove([...paths]);
            if (cleanupError) alert(`The note was deleted, but its image cleanup failed: ${cleanupError.message}`);
          }
        } catch (err) { alert("Couldn't delete: " + err.message); }
      });
    }

    if (!isOwner) {
      try { await supabase.rpc("increment_resource_views", { p_resource_id: id }); } catch (err) { /* non-fatal */ }
    }
    const dl = document.getElementById("detail-download");
    if (dl) {
      dl.addEventListener("click", () => { supabase.rpc("increment_resource_downloads", { p_resource_id: id }).catch(() => {}); });
    }
  } catch (err) {
    card.innerHTML = `<div class="empty-state"><p>Couldn't load this note.</p></div>`;
    console.debug("[Notes] detail:", err.message);
  }
}

function renderContent(n) {
  const images = Array.isArray(n.image_urls) && n.image_urls.length
    ? n.image_urls
    : (n.note_type === "image" && n.external_url ? [n.external_url] : []);
  const gallery = images.length
    ? `<div class="note-image-gallery">${images.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(n.title)}" loading="lazy"></a>`).join("")}</div>`
    : "";
  if (n.note_type === "text") return `${escapeHtml(n.content_text || "")}${gallery}`;
  if (n.note_type === "image") {
    return gallery;
  }
  if (n.note_type === "video_file") return `${n.external_url ? `<video src="${escapeHtml(n.external_url)}" controls style="width:100%;border-radius:var(--r-md);"></video>` : ""}${gallery}`;
  if (n.note_type === "video_link") {
    const embed = toEmbedUrl(n.external_url);
    return `${embed ? `<iframe src="${escapeHtml(embed)}" allowfullscreen></iframe>` : `<a href="${escapeHtml(n.external_url)}" target="_blank" rel="noopener">${escapeHtml(n.external_url)}</a>`}${gallery}`;
  }
  if (n.note_type === "link") return `<a href="${escapeHtml(n.external_url)}" target="_blank" rel="noopener">${escapeHtml(n.external_url)}</a>${gallery}`;
  return gallery;
}
function toEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.searchParams.get("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
    if (u.hostname === "youtu.be") return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    return null;
  } catch (e) { return null; }
}
