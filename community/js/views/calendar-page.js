// Dedicated "Calendar" page (StudyHub nav item), separate from the small
// calendar widget embedded in the Home dashboard. Reuses the same
// FullCalendar wrapper and the same /api/calendar, /api/courses, /api/events
// endpoints, so events created here show up on the dashboard widget too.
import { subscribe } from '../state.js';
import { api } from '../api.js';
import { h, icon, toast } from '../ui.js?v=3';
import { createCalendar } from './calendar.js';
import { coursesCard } from './courses.js';

export function mountCalendarPage(container) {
  const sub = subscribe();
  let courses = [];
  let calendar = null;

  const calHost = h('section', { class: 'card cal-card' });
  const coursesEl = h('div');

  const page = h('div', { class: 'page wide' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, 'Calendar'), h('p', null, 'Classes, assignments and study sessions in one place.')),
      h('div', { class: 'head-buttons' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => calendar && calendar.openCreate() }, icon('plus', 16), 'New event'))),
    h('div', { class: 'dash-grid' },
      h('div', { class: 'dash-main' }, calHost),
      h('aside', { class: 'dash-side', 'aria-label': 'Courses' }, coursesEl)));

  container.replaceChildren(page);

  async function loadCourses() {
    try {
      courses = (await api('/courses')).courses;
      coursesEl.replaceChildren(coursesCard(courses, () => loadCourses()));
    } catch (err) { toast(err.message, 'error'); }
  }

  loadCourses();
  calendar = createCalendar(calHost, { getCourses: () => courses, onChange: () => {} });

  sub.on('calendar:changed', () => calendar && calendar.refetch());
  sub.on('courses:changed', () => loadCourses());

  return () => {
    sub.off();
    if (calendar) calendar.destroy();
  };
}
