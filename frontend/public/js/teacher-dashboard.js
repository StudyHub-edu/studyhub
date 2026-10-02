/* ============================================================================
 * StudyHub — Teacher Dashboard
 * Loaded after config.js, auth.js, community-client.js and charts.js.
 *
 * "My Classes" is Community's own course system (a teacher creates a course
 * there, students join with a code) — reused as-is rather than inventing a
 * parallel "classes" table. "Resources Uploaded" / "Recent Uploads" /
 * "Avg Rating" use the existing public.resources table from
 * supabase/admin_schema.sql (uploaded_by = this teacher's profile).
 * Today's Schedule / This Week / Upcoming Events / Recent Activity all come
 * from Community's calendar + notifications, exactly like the student
 * dashboard's Calendar widget.
 * ========================================================================== */

const MONTH_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const EVENT_TYPE_LABEL = {
  exam: "Exam", test: "Test", assignment: "Assignment", class: "Class",
  meeting: "Meeting", study_session: "Study", reminder: "Reminder",
};
const SUBJECT_STYLE = (name = "") => {
  const s = name.toLowerCase();
  if (s.includes("math")) return { bg: "rgba(77,124,255,.15)", fg: "var(--blue-soft)", icon: '<path d="M4 7h16M4 17h7M15 17l2 2 4-4"/>' };
  if (s.includes("phys")) return { bg: "var(--ok-bg)", fg: "var(--ok)", icon: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)"/>' };
  if (s.includes("chem")) return { bg: "rgba(217,138,82,.16)", fg: "#e2a15c", icon: '<path d="M9 3h6M10 3v6l-5.5 9a1.8 1.8 0 0 0 1.6 2.7h11.8a1.8 1.8 0 0 0 1.6-2.7L14 9V3"/>' };
  if (s.includes("comp") || s.includes("program")) return { bg: "rgba(138,107,255,.15)", fg: "var(--violet-soft)", icon: '<path d="m9 18-6-6 6-6M15 6l6 6-6 6"/>' };
  return { bg: "var(--ink-800)", fg: "var(--text-dim)", icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/>' };
};

function timeAgo2(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function renderEmpty(el, { message, actionLabel, actionHref }) {
  el.innerHTML = `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1 1.3 2.4 2 4 2s3-.7 4-2"/></svg>
    <p>${message}</p>
    ${actionLabel ? `<a href="${actionHref}">${actionLabel} →</a>` : ""}
  </div>`;
}
function renderSkeleton(el, rows = 3, h = 48) {
  el.innerHTML = Array.from({ length: rows }).map(() => `<div class="skeleton" style="height:${h}px;border-radius:10px;margin-bottom:8px;"></div>`).join("");
}

/* ------------------------------------------------------------- 1. courses */

let cachedCourses = [];

async function loadClasses() {
  const el = document.getElementById("classes-body");
  renderSkeleton(el, 3, 62);
  try {
    const { courses } = await communityApi("/api/courses");
    cachedCourses = courses || [];
    document.getElementById("stat-classes").textContent = cachedCourses.length;
    const totalStudents = cachedCourses.reduce((s, c) => s + (c.studentCount || 0), 0);
    document.getElementById("stat-students").textContent = totalStudents;
    document.getElementById("week-students").textContent = totalStudents;

    if (!cachedCourses.length) {
      return renderEmpty(el, { message: "You haven't created a class yet.", actionLabel: "Create one in Community", actionHref: "/community/#/dashboard" });
    }
    el.innerHTML = cachedCourses
      .map((c) => {
        const { bg, fg, icon } = SUBJECT_STYLE(c.name);
        return `
        <div class="class-row2">
          <span class="class-row2__icon" style="background:${bg};color:${fg}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>
          <div class="class-row2__body">
            <div class="class-row2__title">${escapeHtml(c.name)}</div>
            <div class="class-row2__meta">${c.code ? escapeHtml(c.code) + " · " : ""}${c.studentCount} student${c.studentCount === 1 ? "" : "s"}${c.joinCode ? " · Join code " + c.joinCode : ""}</div>
            <div class="class-row2__accent" style="background:${fg}"></div>
          </div>
          <svg class="class-row2__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.debug("[StudyHub] classes:", err.message);
    document.getElementById("stat-classes").textContent = "0";
    document.getElementById("stat-students").textContent = "0";
    renderEmpty(el, { message: "You haven't created a class yet.", actionLabel: "Create one in Community", actionHref: "/community/#/dashboard" });
  }
}

/* -------------------------------------------------------------- 2. uploads */

async function loadUploads(session) {
  const el = document.getElementById("uploads-body");
  renderSkeleton(el, 3, 52);
  try {
    const { data, error } = await supabase
      .from("resources")
      .select("id, title, subject, class_level, rating, status, created_at")
      .eq("uploaded_by", session.user.id)
      .order("created_at", { ascending: false })
      .limit(4);
    if (error) throw error;

    const countRes = await supabase.from("resources").select("id, rating", { count: "exact" }).eq("uploaded_by", session.user.id);
    const total = countRes.count || (countRes.data || []).length;
    const ratings = (countRes.data || []).map((r) => r.rating).filter((r) => r != null);
    const avg = ratings.length ? (ratings.reduce((a, b) => a + Number(b), 0) / ratings.length).toFixed(1) : "—";
    document.getElementById("stat-resources").textContent = total;
    document.getElementById("stat-rating").textContent = avg;

    if (!data || !data.length) {
      return renderEmpty(el, { message: "No uploads yet.", actionLabel: "Upload something", actionHref: "/library/" });
    }
    el.innerHTML = data
      .map(
        (r) => `
      <div class="progress-item2" style="align-items:center;">
        <span class="progress-item2__icon" style="background:var(--ink-800);color:var(--blue-soft)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg></span>
        <div class="progress-item2__body">
          <div class="progress-item2__title">${escapeHtml(r.title)}</div>
          <div class="progress-item2__meta">${[r.subject, r.class_level].filter(Boolean).map(escapeHtml).join(" • ")} · ${timeAgo2(r.created_at)}</div>
        </div>
        <span class="status-chip ${r.status}">${r.status[0].toUpperCase() + r.status.slice(1)}</span>
      </div>`
      )
      .join("");
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] uploads:", err.message);
    document.getElementById("stat-resources").textContent = "0";
    document.getElementById("stat-rating").textContent = "—";
    renderEmpty(el, { message: "No uploads yet.", actionLabel: "Upload something", actionHref: "/library/" });
  }
}

/* ------------------------------------------------- 3. week glance + schedule */

async function loadWeekAndSchedule() {
  const weekEl = document.getElementById("weekbar");
  const todayEl = document.getElementById("today-body");
  renderSkeleton(todayEl, 2, 50);

  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    const { events } = await communityApi("/api/calendar", { start: weekStart.toISOString(), end: weekEnd.toISOString() });

    // This-week bar chart (Mon..Sun counts)
    const counts = [0, 0, 0, 0, 0, 0, 0];
    let assignments = 0;
    events.forEach((ev) => {
      const day = (new Date(ev.start).getDay() + 6) % 7;
      counts[day]++;
      if (ev.type === "assignment") assignments++;
    });
    document.getElementById("week-classes").textContent = events.filter((e) => e.type === "class").length;
    document.getElementById("week-assignments").textContent = assignments;
    const maxC = Math.max(1, ...counts);
    const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    weekEl.innerHTML = counts
      .map((c, i) => `<div class="weekbar2__col"><div class="weekbar2__bar" style="height:${(c / maxC) * 100}%"></div><span class="weekbar2__label">${DOW[i]}</span></div>`)
      .join("");

    // Today's schedule
    const todays = events
      .filter((ev) => new Date(ev.start).toDateString() === now.toDateString())
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    if (!todays.length) {
      return renderEmpty(todayEl, { message: "Nothing scheduled today.", actionLabel: "Add to Calendar", actionHref: "/community/#/calendar" });
    }
    todayEl.innerHTML = todays
      .map((ev) => {
        const start = new Date(ev.start), end = new Date(ev.end);
        const isLive = now >= start && now <= end;
        const isUpcoming = now < start;
        const timeStr = ev.allDay ? "All day" : `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
        return `
        <div class="schedule-item2">
          <span class="schedule-item2__dot ${isLive ? "is-live" : ""}"></span>
          <div class="schedule-item2__body">
            <div class="schedule-item2__time">${timeStr}</div>
            <div class="schedule-item2__title">${escapeHtml(ev.title)}</div>
            <div class="schedule-item2__meta">${ev.location ? escapeHtml(ev.location) : EVENT_TYPE_LABEL[ev.type] || "Event"}</div>
          </div>
          ${isLive ? '<span class="status-pill2 is-live">Live</span>' : isUpcoming ? '<span class="status-pill2 is-upcoming">Upcoming</span>' : ""}
        </div>`;
      })
      .join("");
  } catch (err) {
    console.debug("[StudyHub] week/schedule:", err.message);
    weekEl.innerHTML = "";
    document.getElementById("week-classes").textContent = "0";
    document.getElementById("week-assignments").textContent = "0";
    renderEmpty(todayEl, { message: "Nothing scheduled today.", actionLabel: "Add to Calendar", actionHref: "/community/#/calendar" });
  }
}

/* ------------------------------------------------------------ 4. upcoming */

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

/* --------------------------------------------------------- 5. student activity */

async function loadActivity() {
  const el = document.getElementById("activity-body");
  renderSkeleton(el, 4, 46);
  try {
    const { items } = await communityApi("/api/notifications");
    if (!items || !items.length) {
      return renderEmpty(el, { message: "No student activity yet." });
    }
    el.innerHTML = items
      .slice(0, 6)
      .map(
        (n) => `
      <div class="timeline-item2">
        <div class="timeline-item2__body">
          <div class="timeline-item2__title">${escapeHtml(n.text)}</div>
          <div class="timeline-item2__time">${timeAgo2(new Date(n.createdAt || Date.now()).toISOString())}</div>
        </div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.debug("[StudyHub] activity:", err.message);
    renderEmpty(el, { message: "No student activity yet." });
  }
}

/* ------------------------------------------------------------------- boot */

(async () => {
  const session = await requireAuth();
  if (!session) return;

  const profile = await loadIdentity(session);

  // Role guard: this page is teacher-only.
  if (profile && profile.role !== "teacher") {
    window.location.replace(profile.role === "admin" ? STUDYHUB_ADMIN_DASHBOARD : STUDYHUB_DASHBOARD);
    return;
  }

  if (profile) {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    document.title = `${profile.full_name} — StudyHub`;
    document.getElementById("greeting-name").textContent = profile.full_name;
    document.getElementById("greeting-word").textContent = greeting + ",";
  }

  loadClasses();
  loadUploads(session);
  loadWeekAndSchedule();
  loadUpcoming();
  loadActivity();
  loadNotifications();
})();

async function loadNotifications() {
  const dot = document.getElementById("notif-dot");
  if (!dot) return;
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
