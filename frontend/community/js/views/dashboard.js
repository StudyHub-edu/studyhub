// Home: a dashboard for students and teachers, built around the live calendar.
import { state, subscribe } from '../state.js';
import { api } from '../api.js';
import { h, icon, byline, toast, debounce, loadingState } from '../ui.js?v=3';
import { createCalendar, TYPE_LABEL, formatWhen } from './calendar.js';
import { coursesCard } from './courses.js';

const DAY = 86400000;
const DUE_TYPES = ['assignment', 'test', 'exam'];   // "due soon" for a student
const OVERDUE_TYPES = ['assignment', 'reminder'];   // things that should have been ticked off by now

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

function dayLabel(iso) {
  const d = new Date(iso);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(d) - start(new Date())) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

const timeLabel = (e) => (e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));

export function mountDashboard(container) {
  const me = state.me;
  const teacher = me.role === 'teacher';
  const sub = subscribe();
  let courses = [];
  let items = [];        // events from 2 weeks ago to 1 week ahead
  let calendar = null;
  let timer = null;

  const statsEl = h('section', { class: 'stat-grid dash-stats', 'aria-label': 'Overview' });
  const upcomingEl = h('section', { class: 'card side-card' }, loadingState('Loading your schedule...'));
  const coursesEl = h('div');
  const newsEl = h('div');
  const calHost = h('section', { class: 'card cal-card' }, h('h2', { class: 'sr-only' }, 'Calendar'));

  /* ---------------- header ---------------- */
  let remindersBtn = null;
  if ('Notification' in window && Notification.permission === 'default') {
    remindersBtn = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        const result = await Notification.requestPermission();
        if (result === 'granted') {
          toast('Desktop reminders are on', 'success');
          try { new Notification('StudyHub', { body: 'You will get your reminders here.' }); } catch (_) { /* ignore */ }
        } else toast('No problem. Reminders will still appear inside StudyHub.');
        remindersBtn.remove();
      },
    }, icon('bell', 16), 'Turn on desktop reminders');
  }

  const page = h('div', { class: 'page wide dash' },
    h('header', { class: 'page-head dash-head' },
      h('div', null,
        h('h1', null, `${greeting()}, ${me.name.split(' ')[0]}`),
        h('p', null, new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), h('span', { class: 'role-tag' }, teacher ? 'Teacher dashboard' : 'Student dashboard'))),
      h('div', { class: 'head-buttons' }, remindersBtn,
        h('button', { class: 'btn primary', type: 'button', onclick: () => calendar && calendar.openCreate() }, icon('plus', 16), 'New event'))),
    statsEl,
    h('div', { class: 'dash-grid' },
      h('div', { class: 'dash-main' }, calHost),
      h('aside', { class: 'dash-side', 'aria-label': 'Schedule and courses' }, upcomingEl, coursesEl, newsEl)));
  container.append(page);

  /* ---------------- numbers ---------------- */
  function drawStats() {
    const now = Date.now();
    const thisWeek = items.filter((e) => Date.parse(e.end) >= now && Date.parse(e.start) <= now + 7 * DAY);
    let tiles;
    if (teacher) {
      const assignments = items.filter((e) => e.scope === 'course' && e.canEdit && e.type === 'assignment' && e.totalStudents > 0);
      const total = assignments.reduce((sum, e) => sum + e.totalStudents, 0);
      const done = assignments.reduce((sum, e) => sum + e.completedCount, 0);
      tiles = [
        ['Courses', courses.length],
        ['Students', courses.reduce((sum, c) => sum + c.studentCount, 0)],
        ['Events this week', thisWeek.length],
        ['Assignments handed in', total ? Math.round((done / total) * 100) + '%' : '-'],
      ];
    } else {
      const dueSoon = thisWeek.filter((e) => DUE_TYPES.includes(e.type) && !e.completed);
      const overdue = items.filter((e) => Date.parse(e.end) < now && !e.completed && OVERDUE_TYPES.includes(e.type));
      tiles = [
        ['Events this week', thisWeek.length],
        ['Due soon', dueSoon.length],
        ['Overdue', overdue.length, overdue.length > 0 ? 'warn' : ''],
        ['Courses', courses.length],
      ];
    }
    statsEl.replaceChildren(...tiles.map(([label, value, tone]) =>
      h('div', { class: 'stat-tile' + (tone ? ' ' + tone : '') }, h('strong', null, value), h('span', null, label))));
  }

  /* ---------------- coming up ---------------- */
  async function toggleDone(e) {
    try {
      await api(`/events/${e.eventId}/complete`, { method: 'POST', body: { completed: !e.completed, occurrenceStart: e.occurrenceStart } });
      calendar && calendar.refetch();
      await loadItems();
    } catch (err) { toast(err.message, 'error'); }
  }

  function itemRow(e, late) {
    const canTick = !(e.scope === 'course' && e.canEdit); // teachers do not tick off their own class events
    return h('li', { class: 'up-item ev-' + e.type + (e.completed ? ' is-done' : '') },
      canTick
        ? h('button', {
          class: 'tick' + (e.completed ? ' on' : ''), type: 'button', 'aria-pressed': String(e.completed),
          title: e.completed ? 'Mark as not done' : 'Mark as done', 'aria-label': (e.completed ? 'Mark not done: ' : 'Mark done: ') + e.title,
          onclick: () => toggleDone(e),
        }, e.completed ? icon('check', 14) : null)
        : h('span', { class: 'tick-space' }),
      h('button', { class: 'up-main', type: 'button', onclick: () => calendar && calendar.openEvent(e) },
        h('strong', null, e.title),
        h('small', null, late ? formatWhen(e.start, e.end, e.allDay) : timeLabel(e), ' ', TYPE_LABEL[e.type].toLowerCase(), e.courseName ? ' in ' + e.courseName : '')));
  }

  function drawUpcoming() {
    const now = Date.now();
    const soon = items.filter((e) => Date.parse(e.end) >= now && Date.parse(e.start) <= now + 7 * DAY).slice(0, 14);
    const late = items.filter((e) => Date.parse(e.end) < now && !e.completed && OVERDUE_TYPES.includes(e.type)).reverse().slice(0, 5);

    const groups = [];
    for (const e of soon) {
      const label = dayLabel(e.start);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.list.push(e);
      else groups.push({ label, list: [e] });
    }

    upcomingEl.replaceChildren(...[
      h('div', { class: 'card-head' }, h('h2', null, 'Coming up'), h('span', { class: 'muted small-text' }, 'Next 7 days')),
      late.length ? h('div', { class: 'up-group late' }, h('h3', null, 'Overdue'), h('ul', null, late.map((e) => itemRow(e, true)))) : null,
      ...(groups.length
        ? groups.map((g) => h('div', { class: 'up-group' }, h('h3', null, g.label), h('ul', null, g.list.map((e) => itemRow(e, false)))))
        : [h('div', { class: 'up-empty' }, icon('calendar', 22), h('p', null, 'Nothing scheduled this week.'),
          h('button', { class: 'btn small', type: 'button', onclick: () => calendar && calendar.openCreate() }, 'Add an event'))]),
    ].filter(Boolean));
  }

  /* ---------------- data ---------------- */
  async function loadItems() {
    try {
      const from = new Date(Date.now() - 14 * DAY).toISOString();
      const to = new Date(Date.now() + 8 * DAY).toISOString();
      items = (await api(`/calendar?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`)).events;
      drawStats();
      drawUpcoming();
    } catch (err) {
      upcomingEl.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  }

  function drawCourses() {
    coursesEl.replaceChildren(coursesCard(courses, () => loadCourses()));
  }

  async function loadCourses() {
    try {
      courses = (await api('/courses')).courses;
      drawCourses();
      if (calendar) calendar.setCourses();
      drawStats();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadNews() {
    try {
      const first = (await api('/announcements')).items[0];
      if (!first) { newsEl.replaceChildren(); return; }
      const author = state.users.get(first.userId);
      newsEl.replaceChildren(h('section', { class: 'card side-card news-card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Latest announcement'), h('a', { class: 'btn small', href: '#/announcements' }, 'See all')),
        h('h3', null, first.title),
        h('p', { class: 'news-body' }, first.body.length > 170 ? first.body.slice(0, 170) + '...' : first.body),
        byline(author, 'posted', first.createdAt, { size: 18 })));
    } catch (_) { /* the announcement card is optional */ }
  }

  /* ---------------- go ---------------- */
  calendar = createCalendar(calHost, { getCourses: () => courses, onChange: () => loadItems() });
  drawStats();
  loadCourses();
  loadItems();
  loadNews();

  sub.on('calendar:changed', debounce(() => { if (calendar) calendar.refetch(); loadItems(); }, 300));
  sub.on('courses:changed', debounce(loadCourses, 300));
  sub.on('announcements:changed', loadNews);
  sub.on('users:changed', debounce(() => { drawCourses(); }, 200));
  timer = setInterval(() => { drawStats(); drawUpcoming(); }, 60000); // "Overdue" and "Today" move on as time passes

  return () => {
    sub.off();
    clearInterval(timer);
    if (calendar) calendar.destroy();
  };
}
