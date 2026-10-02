/* ============================================================================
 * StudyHub — Student Homepage logic
 * Loaded after config.js and auth.js on dashboard.html.
 *
 * Sections below (Continue Learning, Recommended Library, Upcoming,
 * Questions, Recently Viewed) query tables that don't exist in schema.sql
 * yet: learning_progress, library_books, calendar_events, questions,
 * recently_viewed, notifications. Each query is wrapped so that a missing
 * table (Postgres 42P01) or empty result renders the spec's real empty
 * state instead of fake data. Once those tables are created with the
 * shapes queried below, the matching section starts populating with no
 * further changes needed here.
 * ========================================================================== */

const ICONS = {
  physics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)"/></svg>',
  math: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 17h7M15 17l2 2 4-4"/></svg>',
  chem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-5.5 9a1.8 1.8 0 0 0 1.6 2.7h11.8a1.8 1.8 0 0 0 1.6-2.7L14 9V3"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18-6-6 6-6M15 6l6 6-6 6"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M4 19.5V6.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m22 8-5 4 5 4V8Z"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2-2.3 3.5M12 17h.01"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><path d="M9 13h6M9 17h6"/></svg>',
};

const SUBJECT_ICON = (subject = "") => {
  const s = subject.toLowerCase();
  if (s.includes("phys")) return { icon: ICONS.physics, bg: "#e7edff", fg: "#3a63d8" };
  if (s.includes("math")) return { icon: ICONS.math, bg: "#f0e9fc", fg: "#7c53e0" };
  if (s.includes("chem")) return { icon: ICONS.chem, bg: "#e4f8ef", fg: "#1f9e64" };
  if (s.includes("comp") || s.includes("program")) return { icon: ICONS.code, bg: "#0d1428", fg: "#7aa0ff" };
  return { icon: ICONS.book, bg: "#eef1fb", fg: "#3a63d8" };
};

const RESOURCE_TYPE_ICON = (type = "") => {
  const t = type.toLowerCase();
  if (t.includes("book")) return { icon: ICONS.book, bg: "#f0e9fc", fg: "#7c53e0" };
  if (t.includes("question")) return { icon: ICONS.question, bg: "#e4f8ef", fg: "#1f9e64" };
  if (t.includes("video")) return { icon: ICONS.video, bg: "#fdece0", fg: "#d9701e" };
  return { icon: ICONS.note, bg: "#e7edff", fg: "#3a63d8" };
};

function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* isMissingTable(), escapeHtml(), timeAgo(), and renderEmptyState() now live
   in js/auth.js, shared with every other logged-in page. loadIdentity(),
   initProfileMenu(), initMobileNav(), and initSearch() live in js/auth.js
   and js/dashboard-nav.js respectively. */

/* ------------------------------------------------- community/library APIs
 * getCommunityToken(), communityApi(), libraryApi() now live in
 * js/community-client.js, loaded before this file. */

/* --------------------------------------------------------------- generic render */

function renderEmpty(container, { message, actionLabel, actionHref, onAction }) {
  const btn = actionHref
    ? `<a href="${actionHref}">${actionLabel}</a>`
    : actionLabel
    ? `<button type="button" class="btn--link" style="background:none;border:0;color:var(--blue);font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;">${actionLabel}</button>`
    : "";
  container.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
      <p>${message}</p>
      ${btn}
    </div>`;
  if (onAction) container.querySelector("button")?.addEventListener("click", onAction);
}

function renderSkeleton(container, rows = 3, height = 48) {
  container.innerHTML = Array.from({ length: rows })
    .map(() => `<div class="skeleton" style="height:${height}px;margin-bottom:.6rem;border-radius:10px;"></div>`)
    .join("");
}

/* --------------------------------------------------------- 1. continue learning */

async function loadContinueLearning() {
  const el = document.getElementById("continue-learning-body");
  renderSkeleton(el, 3, 56);
  try {
    const session = await getSession();
    const { data, error } = await supabase
      .from("learning_progress")
      .select("subject, topic, chapter, progress_percent, resource_id, resource_type")
      .eq("user_id", session.user.id)
      .order("updated_at", { ascending: false })
      .limit(4);

    if (error) throw error;
    if (!data || !data.length) {
      renderStudyProgress(null);
      return renderEmpty(el, {
        message: "You haven't started learning yet.",
        actionLabel: "Explore Resources",
        actionHref: "learn.html",
      });
    }

    el.innerHTML = data
      .map((row) => {
        const { icon, bg, fg } = SUBJECT_ICON(row.subject);
        const pct = Math.max(0, Math.min(100, row.progress_percent || 0));
        return `
        <div class="progress-item2">
          <span class="progress-item2__icon" style="background:${bg};color:${fg}">${icon}</span>
          <div class="progress-item2__body">
            <div class="progress-item2__title">${escapeHtml(row.subject)}</div>
            <div class="progress-item2__meta">${[row.topic, row.chapter].filter(Boolean).map(escapeHtml).join(" • ")}</div>
            <div class="progress-bar2"><div class="progress-bar2__fill" style="width:${pct}%"></div></div>
            <span class="progress-item2__pct">${pct}%</span>
          </div>
          <a class="btn btn--primary btn--sm" href="/library/"><span class="btn__label">Continue</span></a>
        </div>`;
      })
      .join("");

    const avg = Math.round(data.reduce((s, r) => s + (r.progress_percent || 0), 0) / data.length);
    renderStudyProgress(avg);
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] continue-learning:", err.message);
    renderStudyProgress(null);
    renderEmpty(el, {
      message: "Start learning something new.",
      actionLabel: "Explore Resources",
      actionHref: "learn.html",
    });
  }
}

function renderStudyProgress(pct) {
  const fill = document.getElementById("study-progress-fill");
  const label = document.getElementById("study-progress-pct");
  if (!fill || !label) return;
  if (pct === null) { fill.style.width = "0%"; label.textContent = "Get started"; return; }
  fill.style.width = pct + "%";
  label.textContent = pct + "%";
}

/* ------------------------------------------------------- 2. library recs */

async function loadLibraryRecommendations(profile) {
  const el = document.getElementById("library-body");
  renderSkeleton(el, 1, 150);
  try {
    const { books } = await libraryApi("/api/books");
    if (!books || !books.length) {
      return renderEmpty(el, { message: "No recommendations yet.", actionLabel: "Browse Library", actionHref: "/library/" });
    }
    // A little variety, newest first.
    const picks = books.slice().sort((a, b) => new Date(b.added) - new Date(a.added)).slice(0, 8);

    el.innerHTML = `<div class="lib-scroller2">${picks
      .map(
        (b) => `
      <div class="lib-card2">
        <div class="lib-card2__cover" style="background-image:url('/library/${b.cover}')">
          <span class="lib-card2__badge">FREE</span>
          <span>${b.cover ? "" : escapeHtml(b.title)}</span>
        </div>
        <div class="lib-card2__title">${escapeHtml(b.title)}</div>
        <div class="lib-card2__author">${escapeHtml(b.author || "")}</div>
        <a class="btn btn--primary btn--sm" href="/library/book.html?id=${encodeURIComponent(b.id)}"><span class="btn__label">Read</span></a>
      </div>`
      )
      .join("")}</div>`;
  } catch (err) {
    console.debug("[StudyHub] library:", err.message);
    renderEmpty(el, { message: "No recommendations yet.", actionLabel: "Browse Library", actionHref: "/library/" });
  }
}

/* ------------------------------------------------- 3. calendar + upcoming */

const EVENT_TYPE_LABEL = {
  exam: "Exam", test: "Test", assignment: "Assignment", class: "Class",
  meeting: "Meeting", study_session: "Study", reminder: "Reminder",
};
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

let calendarViewDate = new Date();

async function renderCalendarMonth(viewDate) {
  const grid = document.getElementById("cal-grid");
  const label = document.getElementById("cal-month-label");
  if (!grid || !label) return;
  label.textContent = `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Monday = 0
  const rangeStart = new Date(year, month, 1 - startWeekday);
  const totalCells = 42;
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeStart.getDate() + totalCells);

  let events = [];
  try {
    const r = await communityApi("/api/calendar", { start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
    events = r.events || [];
  } catch (err) {
    // No community session yet, or the request failed — show a plain grid with no dots.
  }
  const eventDays = new Set(events.map((e) => new Date(e.start).toDateString()));
  const today = new Date();

  const dow = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  let html = dow.map((d) => `<div class="cal-widget__dow">${d}</div>`).join("");
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(rangeStart);
    d.setDate(rangeStart.getDate() + i);
    const classes = ["cal-widget__day"];
    if (d.getMonth() !== month) classes.push("is-muted");
    if (d.toDateString() === today.toDateString()) classes.push("is-today");
    if (eventDays.has(d.toDateString())) classes.push("has-event");
    html += `<div class="${classes.join(" ")}">${d.getDate()}</div>`;
  }
  grid.innerHTML = html;
}

function initCalendarWidget() {
  const prev = document.getElementById("cal-prev");
  const next = document.getElementById("cal-next");
  if (prev) prev.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendarMonth(calendarViewDate);
  });
  if (next) next.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendarMonth(calendarViewDate);
  });
  renderCalendarMonth(calendarViewDate);
}

async function loadUpcoming() {
  const el = document.getElementById("upcoming-body");
  renderSkeleton(el, 3, 40);
  try {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 30);
    const { events } = await communityApi("/api/calendar", { start: start.toISOString(), end: end.toISOString() });
    if (!events || !events.length) {
      return renderEmpty(el, { message: "No upcoming events.", actionLabel: "Add Event", actionHref: "/community/#/calendar" });
    }

    el.innerHTML = events
      .slice(0, 5)
      .map((ev) => {
        const d = new Date(ev.start);
        const badge = EVENT_TYPE_LABEL[ev.type] || "Event";
        return `
        <div class="event-item2">
          <div class="event-item2__date"><b>${d.getDate()}</b><span>${MONTH_SHORT[d.getMonth()]}</span></div>
          <div class="event-item2__body">
            <div class="event-item2__title">${escapeHtml(ev.title)}</div>
            <div class="event-item2__meta"><span class="event-dot2"></span>${ev.allDay ? "All day" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
          </div>
          <span class="type-badge ${ev.type}">${badge}</span>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.debug("[StudyHub] upcoming:", err.message);
    renderEmpty(el, { message: "No upcoming events.", actionLabel: "Add Event", actionHref: "/community/#/calendar" });
  }
}

/* ---------------------------------------------------- 4. questions feed */

async function loadQuestions(profile) {
  const el = document.getElementById("questions-body");
  renderSkeleton(el, 3, 44);
  try {
    const { items } = await communityApi("/api/questions", { sort: "new", limit: 4 });
    if (!items || !items.length) {
      return renderEmpty(el, { message: "No questions to show yet.", actionLabel: "Ask a Question", actionHref: "/community/#/qa" });
    }

    el.innerHTML = items
      .map(
        (q) => `
      <div class="question-item2">
        <span class="avatar avatar--sm" data-avatar>${ICONS.question}</span>
        <div class="question-item2__body">
          <div class="question-item2__title">${escapeHtml(q.title)}</div>
          <div class="question-item2__meta">${escapeHtml(q.subject || "General")} · ${q.answerCount} answer${q.answerCount === 1 ? "" : "s"}</div>
        </div>
        <a class="btn btn--ghost btn--sm" href="/community/#/qa/${q.id}"><span class="btn__label">View</span></a>
      </div>`
      )
      .join("");
  } catch (err) {
    console.debug("[StudyHub] questions:", err.message);
    renderEmpty(el, { message: "No questions to show yet.", actionLabel: "Ask a Question", actionHref: "/community/#/qa" });
  }
}

/* --------------------------------------------------- 6. nearby institutions */

async function loadNearbyPlaces() {
  const el = document.getElementById("places-legend");
  try {
    const { data, error } = await supabase.from("institutions").select("id, name, type").limit(3);
    if (error) throw error;

    if (!data || !data.length) {
      el.innerHTML = `<div class="place-row"><div class="place-row__body"><div class="place-row__title">No nearby places yet</div><div class="place-row__meta">Add your school on the Map page</div></div></div>`;
      return;
    }
    el.innerHTML = data
      .map(
        (p) => `
      <div class="place-row">
        <span class="place-row__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z"/></svg></span>
        <div class="place-row__body">
          <div class="place-row__title">${escapeHtml(p.name)}</div>
          <div class="place-row__meta">${escapeHtml((p.type || "institution").replace(/^./, (c) => c.toUpperCase()))}</div>
        </div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.debug("[StudyHub] nearby places:", err.message);
    el.innerHTML = `<div class="place-row"><div class="place-row__body"><div class="place-row__title">Educational places</div><div class="place-row__meta">Explore the map to find some</div></div></div>`;
  }
}

/* -------------------------------------------------------------- notifications */

async function loadNotifications() {
  const dot = document.getElementById("notif-dot");
  try {
    const session = await getSession();
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", session.user.id)
      .eq("is_read", false);
    if (error) throw error;
    dot.classList.toggle("is-visible", (count || 0) > 0);
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] notifications:", err.message);
    dot.classList.remove("is-visible");
  }
}

/* -------------------------------------------------------------------- UI */

/* initProfileMenu(), initMobileNav(), and initSearch() now live in
   js/dashboard-nav.js, shared with every other logged-in page. */

/* ------------------------------------------------------------------- boot */

(async () => {
  const session = await requireAuth();
  if (!session) return;

  const profile = await loadIdentity(session);
  const fallbackName = session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "there";

  // Role guard: this homepage is student-only. Teachers/admins are sent to
  // their own area rather than seeing student data. Real enforcement still
  // lives in RLS — this is just correct routing.
  if (profile && profile.role !== "student") {
    window.location.replace(profile.role === "teacher" ? "teacher-dashboard.html" : STUDYHUB_ADMIN_DASHBOARD);
    return;
  }

  if (profile) {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const firstName = profile.full_name.trim().split(/\s+/)[0] || fallbackName.split(/\s+/)[0];
    document.title = `${firstName ? firstName + " — " : ""}StudyHub`;
    document.getElementById("greeting-name").textContent = firstName;
    document.getElementById("greeting-word").textContent = greeting + ",";
  } else {
    document.getElementById("greeting-name").textContent = fallbackName.split(/\s+/)[0];
  }

  loadContinueLearning();
  loadLibraryRecommendations(profile);
  initCalendarWidget();
  loadUpcoming();
  loadQuestions(profile);
  loadNearbyPlaces();
  loadNotifications();
})();
