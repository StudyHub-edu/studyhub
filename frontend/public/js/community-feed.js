/* A shared dashboard feed for approved study materials, past papers, and questions. */
(() => {
  const LIMIT_PER_SOURCE = 50;
  const PAGE_SIZE = 10;
  const feed = { items: [], filter: "all", visible: PAGE_SIZE };

  function escape(value) {
    return typeof escapeHtml === "function" ? escapeHtml(String(value ?? "")) : String(value ?? "");
  }

  function initials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    return words.length ? `${words[0][0]}${words[1]?.[0] || ""}`.toUpperCase() : "S";
  }

  function safeHttpUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function timeLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Recently";
    const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function dateTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }

  function renderCard(item) {
    const attachmentUrl = safeHttpUrl(item.attachmentUrl);
    const attachmentUrls = (item.attachmentUrls || []).map(safeHttpUrl).filter(Boolean);
    const canShowImage = item.attachmentType === "image" && attachmentUrl;
    const canOpenAttachment = item.attachmentType === "link" && attachmentUrl;
    const canInteract = (item.source === "notes" && item.status === "approved") || item.source === "papers";
    return `
      <article class="feed-card">
        <header class="feed-card__header">
          <span class="feed-card__avatar" aria-hidden="true">${escape(initials(item.author))}</span>
          <div class="feed-card__byline">
            <div class="feed-card__author">${escape(item.author)}</div>
            <div class="feed-card__meta">${escape(item.authorRole || "StudyHub member")}${item.context ? ` · ${escape(item.context)}` : ""}</div>
          </div>
          <span class="feed-card__kind">${escape(item.kind)}</span>
        </header>
        <div class="feed-card__content">
          <h3 class="feed-card__title">${escape(item.title)}</h3>
          ${item.description ? `<p class="feed-card__description">${escape(item.description)}</p>` : ""}
          ${canShowImage ? `<div class="feed-card__gallery">${(attachmentUrls.length ? attachmentUrls : [attachmentUrl]).map((url, index) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer"><img class="feed-card__attachment" src="${escape(url)}" alt="${escape(item.title)} image ${index + 1}" loading="lazy"></a>`).join("")}</div>` : ""}
          ${item.details?.length ? `<div class="feed-card__details">${item.details.map((detail) => `<span>${escape(detail)}</span>`).join("")}</div>` : ""}
        </div>
        <footer class="feed-card__footer">
          <time datetime="${escape(dateTime(item.createdAt))}">${escape(timeLabel(item.createdAt))}</time>
          ${canOpenAttachment
            ? `<a class="feed-card__open" href="${escape(attachmentUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
            : `<a class="feed-card__open" href="${escape(item.href)}">${escape(item.action || "View post")} →</a>`}
        </footer>
        ${canInteract ? `
          <div class="feed-card__actions">
            <button type="button" data-feed-save="${escape(item.id)}" aria-pressed="${item.saved ? "true" : "false"}">${item.saved ? "Saved ✓" : "Save"}</button>
            <div class="feed-card__rating" aria-label="Rate ${escape(item.title)}">
              ${[1, 2, 3, 4, 5].map((rating) => `<button type="button" data-feed-rate="${escape(item.id)}" data-rating="${rating}" aria-label="Rate ${rating} out of 5" aria-pressed="${rating <= item.myRating}">${rating <= item.myRating ? "★" : "☆"}</button>`).join("")}
              <span>${item.avgRating ? Number(item.avgRating).toFixed(1) : "No ratings"}${item.ratingCount ? ` · ${item.ratingCount}` : ""}</span>
            </div>
            ${item.downloadUrl && item.allowDownload ? `<button type="button" class="community-feed__action" data-feed-download="${escape(item.id)}">Download</button>` : ""}
            <a class="feed-card__open" href="${escape(item.href)}">${escape(item.action || "View")} →</a>
          </div>` : ""}
      </article>`;
  }

  function showProblem(element, sourceErrors) {
    if (!sourceErrors.length) return;
    const labels = sourceErrors.map(({ name }) => name).join(", ");
    element.textContent += ` · Could not load: ${labels}. Refresh to retry.`;
  }

  function render(container) {
    const list = container.querySelector("[data-feed-list]");
    const status = container.querySelector("[data-feed-status]");
    const more = container.querySelector("[data-feed-more]");
    const selected = feed.filter === "all" ? feed.items : feed.items.filter((item) => item.group === feed.filter);
    const visibleItems = selected.slice(0, feed.visible);

    container.querySelectorAll("[data-feed-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.feedFilter === feed.filter));
    });
    list.innerHTML = visibleItems.length
      ? visibleItems.map(renderCard).join("")
      : `<div class="empty-state"><p>No shared items yet. Check back soon, or add the first one.</p></div>`;
    more.hidden = visibleItems.length >= selected.length;
    more.textContent = `Show more (${Math.min(PAGE_SIZE, selected.length - visibleItems.length)})`;
    status.textContent = `${selected.length} item${selected.length === 1 ? "" : "s"}`;
  }

  async function loadResources(userId) {
    const result = await supabase
      .from("note_details")
      .select("id,title,description,subject,class_level,chapter,note_type,content_text,external_url,file_path,image_urls,allow_download,avg_rating,rating_count,save_count,status,uploaded_by,uploader_name,uploader_role,institution_name,created_at")
      .or(`status.eq.approved,and(uploaded_by.eq.${userId},status.eq.pending)`)
      .order("created_at", { ascending: false })
      .limit(LIMIT_PER_SOURCE);
    if (result.error) throw result.error;
    return (result.data || []).map((row) => {
      const ownPending = row.status === "pending" && row.uploaded_by === userId;
      const name = ownPending ? "You" : row.uploader_name || "StudyHub member";
      const description = row.description || row.content_text || (ownPending ? "This resource is awaiting review before it appears to others." : "");
      return {
        id: `resource-${row.id}`,
        source: "notes",
        sourceId: row.id,
        group: "materials",
        kind: ownPending ? "Awaiting review" : row.note_type === "link" ? "Source" : "Study resource",
        author: name,
        authorId: ownPending ? null : row.uploaded_by,
        authorRole: row.uploader_role,
        context: row.institution_name,
        title: row.title,
        description,
        details: [row.subject, row.class_level, row.chapter].filter(Boolean),
        attachmentUrl: row.image_urls?.[0] || (row.note_type === "image" ? row.external_url : row.note_type === "link" ? row.external_url : ""),
        attachmentUrls: row.image_urls?.length ? row.image_urls : row.note_type === "image" && row.external_url ? [row.external_url] : [],
        attachmentType: row.image_urls?.length || row.note_type === "image" ? "image" : row.note_type === "link" ? "link" : "",
        downloadUrl: row.note_type === "image" && row.allow_download ? row.external_url : "",
        downloadName: row.title,
        allowDownload: row.allow_download,
        status: row.status,
        avgRating: row.avg_rating,
        ratingCount: row.rating_count || 0,
        saveCount: row.save_count || 0,
        saved: false,
        myRating: 0,
        createdAt: row.created_at,
        href: "note.html",
        action: "Browse notes",
      };
    });
  }

  async function loadPastPapers(userId) {
    const result = await supabase
      .from("past_papers")
      .select("id,title,exam_name,education_level,subject,exam_year,institution_name,description,uploader_name,uploaded_by,created_at,file_path,image_paths")
      .order("created_at", { ascending: false })
      .limit(LIMIT_PER_SOURCE);
    if (result.error) throw result.error;
    const rows = result.data || [];
    const pathsByPaper = rows.map((row) => Array.isArray(row.image_paths) && row.image_paths.length ? row.image_paths : [row.file_path]);
    const allPaths = pathsByPaper.flat();
    const signed = allPaths.length
      ? await supabase.storage.from("past-papers").createSignedUrls(allPaths, 600)
      : { data: [], error: null };
    if (signed.error) throw signed.error;
    const ratingsResult = rows.length
      ? await supabase.from("past_paper_ratings").select("paper_id,rating").in("paper_id", rows.map((row) => row.id))
      : { data: [], error: null };
    if (ratingsResult.error) throw ratingsResult.error;
    const ratingsById = new Map();
    (ratingsResult.data || []).forEach(({ paper_id, rating }) => {
      const values = ratingsById.get(paper_id) || [];
      values.push(Number(rating));
      ratingsById.set(paper_id, values);
    });
    let signedOffset = 0;
    return rows.map((row, index) => {
      const imagePaths = pathsByPaper[index];
      const attachmentUrls = signed.data?.slice(signedOffset, signedOffset + imagePaths.length).map((item) => item.signedUrl).filter(Boolean) || [];
      signedOffset += imagePaths.length;
      const isPdf = /\.pdf$/i.test(row.file_path);
      return ({
      id: `paper-${row.id}`,
      source: "papers",
      sourceId: row.id,
      group: "materials",
      kind: "Past paper",
      author: row.uploaded_by === userId ? "You" : row.uploader_name || "StudyHub member",
      authorId: row.uploaded_by === userId ? null : row.uploaded_by,
      context: row.institution_name,
      title: row.title,
      description: row.description || `${row.exam_name} · ${row.exam_year}`,
      details: [row.education_level, row.subject, row.institution_name].filter(Boolean),
      attachmentUrl: attachmentUrls[0] || "",
      attachmentUrls,
      attachmentType: isPdf ? "link" : "image",
      downloadUrl: attachmentUrls[0] || "",
      downloadName: row.title,
      allowDownload: true,
      avgRating: (ratingsById.get(row.id) || []).reduce((sum, rating) => sum + rating, 0) / Math.max(1, (ratingsById.get(row.id) || []).length),
      ratingCount: (ratingsById.get(row.id) || []).length,
      saved: false,
      myRating: 0,
      createdAt: row.created_at,
      href: "past-papers.html",
      action: "Browse past papers",
      });
    });
  }

  async function loadQuestions() {
    const { items } = await communityApi("/api/questions", { sort: "new", limit: String(LIMIT_PER_SOURCE) });
    return (items || []).map((question) => ({
      id: `question-${question.id}`,
      source: "questions",
      group: "questions",
      kind: "Question",
      author: question.authorName || "StudyHub member",
      authorRole: question.authorRole,
      title: question.title,
      description: question.body,
      details: [question.subject || "General", `${question.answerCount || 0} answers`, question.solved ? "Solved" : "Open"],
      createdAt: question.createdAt,
      href: `/community/#/qa/${encodeURIComponent(question.id)}`,
      action: "View discussion",
    }));
  }

  async function loadSavedState(userId, items, problems) {
    const resources = items.filter((item) => item.source === "notes");
    const papers = items.filter((item) => item.source === "papers");
    const requests = [
      ["Note saves", supabase.from("note_saves").select("resource_id").eq("user_id", userId)],
      ["Note ratings", supabase.from("note_ratings").select("resource_id,rating").eq("user_id", userId)],
      ["Past paper saves", supabase.from("past_paper_saves").select("paper_id").eq("user_id", userId)],
      ["Past paper ratings", supabase.from("past_paper_ratings").select("paper_id,rating").eq("user_id", userId)],
    ];
    const results = await Promise.all(requests.map(async ([name, query]) => {
      const result = await query;
      if (result.error) {
        console.error(`[StudyHub] ${name} could not be loaded:`, result.error.message);
        problems.push({ name });
        return [];
      }
      return result.data || [];
    }));
    const noteSaves = new Set(results[0].map((row) => row.resource_id));
    const noteRatings = new Map(results[1].map((row) => [row.resource_id, row.rating]));
    const paperSaves = new Set(results[2].map((row) => row.paper_id));
    const paperRatings = new Map(results[3].map((row) => [row.paper_id, row.rating]));
    resources.forEach((item) => {
      item.saved = noteSaves.has(item.sourceId);
      item.myRating = noteRatings.get(item.sourceId) || 0;
    });
    papers.forEach((item) => {
      item.saved = paperSaves.has(item.sourceId);
      item.myRating = paperRatings.get(item.sourceId) || 0;
    });
  }

  async function loadAuthorNames(items) {
    const ids = [...new Set(items.map((item) => item.authorId).filter(Boolean))];
    if (!ids.length) return;
    try {
      const batches = [];
      for (let index = 0; index < ids.length; index += 50) {
        batches.push(ids.slice(index, index + 50));
      }
      const results = await Promise.all(
        batches.map((batch) => communityApi("/api/authors", { ids: batch.join(",") }))
      );
      const namesById = new Map(results.flatMap(({ users }) => (users || []).map((user) => [user.id, user])));
      items.forEach((item) => {
        const author = namesById.get(item.authorId);
        if (!author) return;
        item.author = author.name || item.author;
        item.authorRole = author.role || item.authorRole;
      });
    } catch (error) {
      console.warn("[StudyHub] Could not load feed author names:", error.message);
    }
  }

  async function load(container, session) {
    const list = container.querySelector("[data-feed-list]");
    const status = container.querySelector("[data-feed-status]");
    const problems = [];
    list.innerHTML = Array.from({ length: 2 }, () => '<div class="skeleton" style="height:160px;border-radius:14px;"></div>').join("");

    const sources = await Promise.all([
      ["Notes & resources", loadResources(session.user.id)],
      ["Past papers", loadPastPapers(session.user.id)],
      ["Questions", loadQuestions()],
    ].map(async ([name, request]) => {
      try { return { name, items: await request }; }
      catch (error) {
        console.error(`[StudyHub] ${name} feed load failed:`, error);
        problems.push({ name });
        return { name, items: [] };
      }
    }));

    feed.items = sources.flatMap((source) => source.items);
    await loadSavedState(session.user.id, feed.items, problems);
    await loadAuthorNames(feed.items);
    feed.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    feed.visible = PAGE_SIZE;
    render(container);
    showProblem(status, problems);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const container = document.querySelector("[data-community-feed]");
    if (!container) return;
    const session = await getSession();
    if (!session) return;
    container.querySelectorAll("[data-feed-filter]").forEach((button) => button.addEventListener("click", () => {
      feed.filter = button.dataset.feedFilter;
      feed.visible = PAGE_SIZE;
      render(container);
    }));
    container.querySelector("[data-feed-more]").addEventListener("click", () => {
      feed.visible += PAGE_SIZE;
      render(container);
    });
    container.querySelector("[data-feed-list]").addEventListener("click", async (event) => {
      const saveButton = event.target.closest("[data-feed-save]");
      const ratingButton = event.target.closest("[data-feed-rate]");
      const downloadButton = event.target.closest("[data-feed-download]");
      const itemId = saveButton?.dataset.feedSave || ratingButton?.dataset.feedRate || downloadButton?.dataset.feedDownload;
      if (!itemId) return;
      const item = feed.items.find((entry) => entry.id === itemId);
      if (!item) return;
      const userId = session.user.id;
      const button = saveButton || ratingButton || downloadButton;
      button.disabled = true;
      try {
        if (downloadButton) {
          const response = await fetch(item.downloadUrl);
          if (!response.ok) throw new Error("The image could not be downloaded.");
          const blob = await response.blob();
          const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" }[blob.type.split(";")[0]];
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          const name = item.downloadName || item.title || "studyhub-resource";
          anchor.download = extension && !/\.[a-z0-9]{2,5}$/i.test(name) ? `${name}${extension}` : name;
          document.body.append(anchor);
          anchor.click();
          URL.revokeObjectURL(anchor.href);
          anchor.remove();
          return;
        }
        const isPaper = item.source === "papers";
        const table = isPaper ? "past_paper_saves" : "note_saves";
        const key = isPaper ? "paper_id" : "resource_id";
        const ratingsTable = isPaper ? "past_paper_ratings" : "note_ratings";
        const ratingKey = isPaper ? "paper_id" : "resource_id";
        if (saveButton) {
          const mutation = item.saved
            ? supabase.from(table).delete().eq("user_id", userId).eq(key, item.sourceId)
            : supabase.from(table).insert({ user_id: userId, [key]: item.sourceId });
          const { error } = await mutation;
          if (error) throw error;
          item.saved = !item.saved;
          item.saveCount = Math.max(0, item.saveCount + (item.saved ? 1 : -1));
        } else {
          const rating = Number(ratingButton.dataset.rating);
          const { error } = await supabase.from(ratingsTable).upsert(
            { user_id: userId, [ratingKey]: item.sourceId, rating, updated_at: new Date().toISOString() },
            { onConflict: `user_id,${ratingKey}` }
          );
          if (error) throw error;
          const previous = item.myRating;
          item.avgRating = item.ratingCount
            ? (Number(item.avgRating || 0) * item.ratingCount - previous + rating) / (item.ratingCount + (previous ? 0 : 1))
            : rating;
          if (!previous) item.ratingCount += 1;
          item.myRating = rating;
        }
        render(container);
      } catch (error) {
        console.error("[StudyHub] Could not update feed item:", error.message);
        container.querySelector("[data-feed-status]").textContent = `Could not ${saveButton ? (item.saved ? "remove this saved item" : "save this item") : downloadButton ? "download this image" : "rate this item"}: ${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
    await load(container, session);
  });
})();
