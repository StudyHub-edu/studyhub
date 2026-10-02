(() => {
  const list = document.getElementById("saved-list");
  const status = document.getElementById("saved-status");
  let userId = null;

  function safeUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function escape(value) {
    return escapeHtml(String(value ?? ""));
  }

  function card(item) {
    const images = (item.images || [item.image]).map(safeUrl).filter(Boolean);
    return `<article class="feed-card" data-saved-id="${escape(item.id)}" data-saved-kind="${escape(item.kind)}">
      <header class="feed-card__header">
        <span class="feed-card__avatar" aria-hidden="true">${escape(item.author.slice(0, 1).toUpperCase())}</span>
        <div class="feed-card__byline">
          <div class="feed-card__author">${escape(item.author)}</div>
          <div class="feed-card__meta">${escape(item.role || "StudyHub member")}${item.institution ? ` · ${escape(item.institution)}` : ""}</div>
        </div>
        <span class="feed-card__kind">${item.kind === "paper" ? "Past paper" : "Study resource"}</span>
      </header>
      <div class="feed-card__content">
        <h2 class="feed-card__title">${escape(item.title)}</h2>
        ${item.description ? `<p class="feed-card__description">${escape(item.description)}</p>` : ""}
        ${images.length ? `<div class="feed-card__gallery">${images.map((image, index) => `<a href="${escape(image)}" target="_blank" rel="noopener noreferrer"><img class="feed-card__attachment" src="${escape(image)}" alt="${escape(item.title)} image ${index + 1}" loading="lazy"></a>`).join("")}</div>` : ""}
        <div class="feed-card__details">${item.details.map((detail) => `<span>${escape(detail)}</span>`).join("")}</div>
      </div>
      <footer class="feed-card__actions">
        <button type="button" data-unsave="${escape(item.id)}">Remove from saved</button>
        ${item.downloadUrl ? `<button type="button" data-download="${escape(item.id)}">Download</button>` : ""}
        <div class="feed-card__rating">
          ${[1, 2, 3, 4, 5].map((rating) => `<button type="button" data-rate="${escape(item.id)}" data-rating="${rating}" aria-label="Rate ${rating} out of 5" aria-pressed="${rating <= item.rating}">${rating <= item.rating ? "★" : "☆"}</button>`).join("")}
          <span>${item.avgRating ? Number(item.avgRating).toFixed(1) : "No ratings"}${item.ratingCount ? ` · ${item.ratingCount}` : ""}</span>
        </div>
      </footer>
    </article>`;
  }

  async function download(item) {
    const response = await fetch(item.downloadUrl);
    if (!response.ok) throw new Error("The resource download failed.");
    const blob = await response.blob();
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" }[blob.type.split(";")[0]];
    const name = item.title || "studyhub-resource";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = extension && !/\.[a-z0-9]{2,5}$/i.test(name) ? `${name}${extension}` : name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function load() {
    list.innerHTML = '<div class="skeleton" style="height:160px;border-radius:14px;"></div>';
    const [noteSaves, paperSaves] = await Promise.all([
      supabase.from("note_saves").select("resource_id").eq("user_id", userId),
      supabase.from("past_paper_saves").select("paper_id").eq("user_id", userId),
    ]);
    if (noteSaves.error) throw noteSaves.error;
    if (paperSaves.error) throw paperSaves.error;
    const noteIds = (noteSaves.data || []).map((row) => row.resource_id);
    const paperIds = (paperSaves.data || []).map((row) => row.paper_id);
    const [notes, noteRatings, papers] = await Promise.all([
      noteIds.length ? supabase.from("note_details").select("*").in("id", noteIds) : { data: [], error: null },
      noteIds.length ? supabase.from("note_ratings").select("resource_id,rating").eq("user_id", userId).in("resource_id", noteIds) : { data: [], error: null },
      paperIds.length ? supabase.from("past_papers").select("*").in("id", paperIds) : { data: [], error: null },
    ]);
    if (notes.error) throw notes.error;
    if (noteRatings.error) throw noteRatings.error;
    if (papers.error) throw papers.error;

    const rows = [];
    const noteRatingsById = new Map((noteRatings.data || []).map((row) => [row.resource_id, row.rating]));
    for (const note of notes.data || []) {
      rows.push({
        id: note.id, kind: "note", title: note.title, author: note.uploader_name || "StudyHub member",
        role: note.uploader_role, institution: note.institution_name,
        description: note.description || note.content_text || "",
        details: [note.subject, note.class_level, note.chapter].filter(Boolean),
        images: note.note_type === "image" ? (note.image_urls?.length ? note.image_urls : note.external_url ? [note.external_url] : []) : (note.image_urls || []),
        downloadUrl: note.note_type === "image" && note.allow_download ? note.external_url : "",
        rating: noteRatingsById.get(note.id) || 0, avgRating: note.avg_rating, ratingCount: note.rating_count,
      });
    }
    const savedPapers = papers.data || [];
    const [signed, paperRatings] = await Promise.all([
      savedPapers.length
      ? supabase.storage.from("past-papers").createSignedUrls(savedPapers.flatMap((paper) => paper.image_paths?.length ? paper.image_paths : [paper.file_path]), 600)
        : { data: [], error: null },
      paperIds.length
        ? supabase.from("past_paper_ratings").select("paper_id,user_id,rating").in("paper_id", paperIds)
        : { data: [], error: null },
    ]);
    if (signed.error) throw signed.error;
    if (paperRatings.error) throw paperRatings.error;
    const paperRatingsById = new Map();
    for (const row of paperRatings.data || []) {
      const ratings = paperRatingsById.get(row.paper_id) || [];
      ratings.push({ userId: row.user_id, rating: Number(row.rating) });
      paperRatingsById.set(row.paper_id, ratings);
    }
    let signedOffset = 0;
    for (const paper of savedPapers) {
      const votes = paperRatingsById.get(paper.id) || [];
      const values = votes.map((vote) => vote.rating);
      const imagePaths = paper.image_paths?.length ? paper.image_paths : [paper.file_path];
      const signedImages = signed.data?.slice(signedOffset, signedOffset + imagePaths.length).map((file) => file.signedUrl).filter(Boolean) || [];
      signedOffset += imagePaths.length;
      rows.push({
        id: paper.id, kind: "paper", title: paper.title, author: paper.uploader_name || "StudyHub member",
        institution: paper.institution_name, description: paper.description,
        details: [paper.exam_name, paper.education_level, paper.subject, String(paper.exam_year)].filter(Boolean),
        images: /\.pdf$/i.test(paper.file_path) ? [] : signedImages,
        downloadUrl: signedImages[0] || "",
        rating: votes.find((vote) => vote.userId === userId)?.rating || 0,
        avgRating: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
        ratingCount: values.length,
      });
    }
    list.innerHTML = rows.length ? rows.map(card).join("") : '<div class="empty-state"><p>You have not saved any resources yet. Save an item from the dashboard feed to see it here.</p></div>';
    status.textContent = `${rows.length} saved resource${rows.length === 1 ? "" : "s"}`;
    list.querySelectorAll(".feed-card").forEach((element) => {
      element.__item = rows.find((row) => row.id === element.dataset.savedId && row.kind === element.dataset.savedKind);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      const session = await requireAuth();
      if (!session) return;
      userId = session.user.id;
      const profile = await loadIdentity(session);
      document.getElementById("saved-back").href = homeForRole(profile?.role);
      await load();
    } catch (error) {
      console.error("[StudyHub] Could not load saved resources:", error.message);
      status.textContent = `Could not load saved resources: ${friendlyError(error)}`;
      list.replaceChildren();
    }
  });

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-unsave],[data-download],[data-rate]");
    if (!button) return;
    const article = button.closest(".feed-card");
    const item = article?.__item;
    if (!item) return;
    button.disabled = true;
    try {
      if (button.hasAttribute("data-unsave")) {
        const table = item.kind === "paper" ? "past_paper_saves" : "note_saves";
        const key = item.kind === "paper" ? "paper_id" : "resource_id";
        const { error } = await supabase.from(table).delete().eq("user_id", userId).eq(key, item.id);
        if (error) throw error;
        await load();
      } else if (button.hasAttribute("data-download")) {
        await download(item);
      } else {
        const rating = Number(button.dataset.rating);
        const table = item.kind === "paper" ? "past_paper_ratings" : "note_ratings";
        const key = item.kind === "paper" ? "paper_id" : "resource_id";
        const { error } = await supabase.from(table).upsert(
          { user_id: userId, [key]: item.id, rating, updated_at: new Date().toISOString() },
          { onConflict: `user_id,${key}` }
        );
        if (error) throw error;
        item.rating = rating;
        await load();
      }
    } catch (error) {
      console.error("[StudyHub] Saved resource action failed:", error.message);
      status.textContent = `Action failed: ${friendlyError(error)}`;
      button.disabled = false;
    }
  });
})();
