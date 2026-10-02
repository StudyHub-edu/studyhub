/* ============================================================================
 * StudyHub — Admin Dashboard
 * Loaded after config.js, auth.js, community-client.js and charts.js.
 *
 * Reuses the same Supabase tables/views the platform already defines
 * (supabase/schema.sql, supabase/admin_schema.sql): profiles,
 * institution_stats (a view), activity_log, resources, calendar_events.
 * "System Overview" and "Storage & Server" also pull real numbers from the
 * Library app's own API — no fabricated metrics.
 * ========================================================================== */

function timeAgo3(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function tryCount(table, apply) {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  } catch (err) {
    if (!isMissingTable(err)) console.debug(`[StudyHub] count ${table}:`, err.message);
    return 0;
  }
}

/* ---------------------------------------------------------------- 1. KPIs */

async function loadKpis() {
  const [students, teachers, admins, institutions] = await Promise.all([
    tryCount("profiles", (q) => q.eq("role", "student")),
    tryCount("profiles", (q) => q.eq("role", "teacher")),
    tryCount("profiles", (q) => q.eq("role", "admin")),
    tryCount("institutions"),
  ]);
  document.getElementById("kpi-total-users").textContent = (students + teachers + admins).toLocaleString();
  document.getElementById("kpi-students").textContent = students.toLocaleString();
  document.getElementById("kpi-teachers").textContent = teachers.toLocaleString();
  document.getElementById("kpi-institutions").textContent = institutions.toLocaleString();
  return { students, teachers, admins, institutions };
}

/* ---------------------------------------------------------- 2. user growth */

async function loadUserGrowth() {
  const el = document.getElementById("growth-chart");
  const days = 7;
  const labels = [];
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role, created_at")
      .gte("created_at", since.toISOString())
      .neq("role", "admin");
    if (error) throw error;

    const studentCounts = Array(days).fill(0);
    const teacherCounts = Array(days).fill(0);
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
    (data || []).forEach((row) => {
      const d = new Date(row.created_at);
      const dayIdx = Math.floor((d - since) / 864e5);
      if (dayIdx < 0 || dayIdx >= days) return;
      if (row.role === "teacher") teacherCounts[dayIdx]++;
      else studentCounts[dayIdx]++;
    });
    // Cumulative, matching the "growing line" look of the mockup.
    for (let i = 1; i < days; i++) { studentCounts[i] += studentCounts[i - 1]; teacherCounts[i] += teacherCounts[i - 1]; }

    renderLineChart(el, {
      labels,
      series: [
        { name: "Students", color: "#4d7cff", values: studentCounts },
        { name: "Teachers", color: "#8a6bff", values: teacherCounts },
      ],
    });
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] growth:", err.message);
    el.innerHTML = `<div class="empty-state" style="padding:2rem 0;"><p>No sign-up data yet.</p></div>`;
  }
}

/* ---------------------------------------------------------- 3. user roles */

async function loadUserRoles(kpis) {
  const total = kpis.students + kpis.teachers + kpis.admins;
  const slices = [
    { label: "Students", value: kpis.students, color: "#4d7cff" },
    { label: "Teachers", value: kpis.teachers, color: "#8a6bff" },
    { label: "Admins", value: kpis.admins, color: "#e2a15c" },
  ];
  renderDonutChart(document.getElementById("roles-donut"), slices.filter((s) => s.value > 0), { size: 140, thickness: 20 });
  const legend = document.getElementById("roles-legend");
  if (!total) {
    legend.innerHTML = `<div class="empty-state"><p>No users yet.</p></div>`;
    return;
  }
  legend.innerHTML = slices
    .map((s) => `
    <div class="donut2-legend__row">
      <span class="donut2-legend__dot" style="background:${s.color}"></span>${s.label}
      <span class="donut2-legend__pct">${total ? Math.round((s.value / total) * 100) : 0}%</span>
      <b>${s.value.toLocaleString()}</b>
    </div>`)
    .join("");
}

/* --------------------------------------------------------------- 4. users */

async function loadRecentUsers() {
  const el = document.getElementById("users-body");
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, created_at, institutions(name)")
      .neq("role", "admin")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    if (!data || !data.length) {
      el.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No users yet.</p></div></td></tr>`;
      return;
    }
    el.innerHTML = data
      .map(
        (u) => `
      <tr>
        <td class="is-strong">
          <div class="row-avatar-name">
            <span class="avatar avatar--sm" style="font-size:.7rem;">${(u.full_name || "?").slice(0, 1).toUpperCase()}</span>
            ${escapeHtml(u.full_name || "Unnamed")}
          </div>
        </td>
        <td><span class="status-chip ${u.role}">${u.role[0].toUpperCase() + u.role.slice(1)}</span></td>
        <td>${escapeHtml(u.institutions?.name || "—")}</td>
        <td>${new Date(u.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
      </tr>`
      )
      .join("");
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] users:", err.message);
    el.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No users yet.</p></div></td></tr>`;
  }
}

/* -------------------------------------------------------------- 5. schools */

async function loadTopSchools() {
  const el = document.getElementById("schools-body");
  try {
    const { data, error } = await supabase
      .from("institution_stats")
      .select("id, name, student_count, teacher_count")
      .order("student_count", { ascending: false })
      .limit(5);
    if (error) throw error;
    if (!data || !data.length) {
      el.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>No schools yet.</p></div></td></tr>`;
      return;
    }
    el.innerHTML = data
      .map((s) => `<tr><td class="is-strong">${escapeHtml(s.name)}</td><td>${(s.student_count || 0).toLocaleString()}</td><td>${(s.teacher_count || 0).toLocaleString()}</td></tr>`)
      .join("");
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] schools:", err.message);
    el.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>No schools yet.</p></div></td></tr>`;
  }
}

/* --------------------------------------------------------------- 6. events */

async function loadRecentEvents(session) {
  const el = document.getElementById("events-body");
  try {
    const today = new Date().toLocaleDateString("en-CA");
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, title, event_type, event_date, event_time")
      .eq("user_id", session.user.id)
      .gte("event_date", today)
      .order("event_date", { ascending: true })
      .limit(5);
    if (error) throw error;
    if (!data || !data.length) {
      el.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No upcoming events.</p><a href="/community/#/calendar">Create one →</a></div></td></tr>`;
      return;
    }
    el.innerHTML = data
      .map((e) => {
        const when = `${new Date(e.event_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${e.event_time ? ", " + e.event_time : ""}`;
        return `<tr><td>${when}</td><td class="is-strong">${escapeHtml(e.title)}</td><td><span class="status-chip pending">${escapeHtml(e.event_type || "Event")}</span></td><td><span class="status-chip upcoming">Upcoming</span></td></tr>`;
      })
      .join("");
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] events:", err.message);
    el.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No upcoming events.</p><a href="/community/#/calendar">Create one →</a></div></td></tr>`;
  }
}

/* ------------------------------------------------------------- 7. activity */

async function loadActivity() {
  const el = document.getElementById("activity-body");
  try {
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, kind, title, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(6);
    if (error) throw error;
    if (!data || !data.length) {
      el.innerHTML = `<div class="empty-state"><p>No recent activity yet.</p></div>`;
      return;
    }
    el.innerHTML = data
      .map(
        (a) => `
      <div class="timeline-item2">
        <div class="timeline-item2__body">
          <div class="timeline-item2__title"><b>${escapeHtml(a.title)}</b>${a.detail ? " — " + escapeHtml(a.detail) : ""}</div>
          <div class="timeline-item2__time">${timeAgo3(a.created_at)}</div>
        </div>
      </div>`
      )
      .join("");
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[StudyHub] activity:", err.message);
    el.innerHTML = `<div class="empty-state"><p>No recent activity yet.</p></div>`;
  }
}

/* ------------------------------------------------------- 8. system overview */

async function loadSystemOverview(kpis) {
  const el = document.getElementById("sysgrid");
  const resources = await tryCount("resources");
  let libraryBooks = 0;
  try {
    const { books } = await libraryApi("/api/books");
    libraryBooks = (books || []).length;
  } catch (err) { /* Library unreachable — leave at 0 */ }

  const cards = [
    { label: "Resources", value: resources, icon: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/>', color: "var(--blue-soft)" },
    { label: "E-Library Books", value: libraryBooks, icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/>', color: "var(--ok)" },
    { label: "Schools/Colleges", value: kpis.institutions, icon: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4Z"/>', color: "var(--violet-soft)" },
    { label: "Total Users", value: kpis.students + kpis.teachers + kpis.admins, icon: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c0-3 3-5.2 6.5-5.2s6.5 2.2 6.5 5.2"/>', color: "#e2a15c" },
  ];
  el.innerHTML = cards
    .map(
      (c) => `
    <div class="syscard2">
      <span class="syscard2__icon" style="background:var(--ink-700);color:${c.color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${c.icon}</svg></span>
      <div class="syscard2__value">${c.value.toLocaleString()}</div>
      <div class="syscard2__label">${c.label}</div>
    </div>`
    )
    .join("");
}

/* -------------------------------------------------------- 9. storage/server */

async function loadStorageAndServer() {
  const donutEl = document.getElementById("storage-donut");
  const rowsEl = document.getElementById("status-rows");

  // Real library storage usage (sum of every book's file size).
  let usedBytes = 0, bookCount = 0, libraryOnline = false;
  try {
    const { books } = await libraryApi("/api/books");
    bookCount = (books || []).length;
    usedBytes = (books || []).reduce((s, b) => s + (b.size || 0), 0);
    libraryOnline = true;
  } catch (err) { /* offline */ }

  const usedGb = usedBytes / 1024 / 1024 / 1024;
  const capacityGb = Math.max(5, Math.ceil(usedGb * 1.4)); // just a visual ceiling, not a real limit
  renderDonutChart(donutEl, [
    { label: "Used", value: usedGb, color: "#4d7cff" },
    { label: "Free", value: Math.max(0.01, capacityGb - usedGb), color: "var(--ink-800)" },
  ], { size: 130, thickness: 18 });
  donutEl.insertAdjacentHTML("beforeend", `<div style="text-align:center;font-size:.78rem;color:var(--text-faint);margin-top:.4rem;">${usedGb.toFixed(2)} GB across ${bookCount} books</div>`);

  // Real reachability checks.
  let dbOnline = false;
  try {
    await supabase.from("institutions").select("id", { head: true, count: "exact" });
    dbOnline = true;
  } catch (err) { dbOnline = false; }

  let communityOnline = false;
  try {
    const res = await fetch("/community/", { method: "GET" });
    communityOnline = res.ok || res.status === 401 || res.status === 404;
  } catch (err) { communityOnline = false; }

  const rows = [
    { label: "Database (Supabase)", online: dbOnline },
    { label: "Library service", online: libraryOnline },
    { label: "Community service", online: communityOnline },
  ];
  rowsEl.innerHTML = rows
    .map((r) => `<div class="status-online-row"><span><span class="status-online-row__dot ${r.online ? "" : "is-offline"}"></span>${r.label}</span><b>${r.online ? "Online" : "Offline"}</b></div>`)
    .join("");
}

/* ------------------------------------------------------------------- boot */

(async () => {
  const session = await requireAuth({ requireOnboarding: false, allowAdmin: true });
  if (!session) return;

  const { data: profile } = await supabase.from("profiles").select("full_name, role").eq("user_id", session.user.id).maybeSingle();
  if (!profile || profile.role !== "admin") {
    window.location.replace(profile ? homeForRole(profile.role) : "index.html");
    return;
  }
  document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = profile.full_name || "Admin"));
  renderAvatarEverywhere(null, profile.full_name || "Admin");

  const hour = new Date().getHours();
  document.getElementById("greeting-word").textContent = (hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening") + ",";
  document.getElementById("greeting-name").textContent = " " + (profile.full_name || "Admin") + "!";

  const kpis = await loadKpis();
  loadUserGrowth();
  loadUserRoles(kpis);
  loadRecentUsers();
  loadTopSchools();
  loadRecentEvents(session);
  loadActivity();
  loadSystemOverview(kpis);
  loadStorageAndServer();
})();
