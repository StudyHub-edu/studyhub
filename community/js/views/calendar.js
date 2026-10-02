// The calendar: month / week / day / list views, drag and drop, recurring events, per-person completion.
// Uses FullCalendar (served from /vendor/fullcalendar.js). All data comes from /api/calendar.
import { state } from '../state.js';
import { api } from '../api.js';
import { h, icon, toast, openModal, confirmDialog, field, richText, errorState } from '../ui.js?v=3';

export const EVENT_TYPES = [
  ['exam', 'Exam'], ['test', 'Test'], ['assignment', 'Assignment'], ['class', 'Class'],
  ['meeting', 'Meeting'], ['study_session', 'Study session'], ['reminder', 'Reminder'],
];
export const TYPE_LABEL = Object.fromEntries(EVENT_TYPES);
/** Things a person "does" and ticks off (as opposed to a class or an exam that just happens). */
export const TASK_TYPES = ['assignment', 'reminder', 'study_session'];

const REMINDERS = [
  [null, 'No reminder'], [0, 'At start time'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'],
  [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before'],
];
const REPEATS = [
  ['', 'Does not repeat'], ['FREQ=DAILY', 'Every day'], ['FREQ=WEEKLY', 'Every week'],
  ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday (Mon to Fri)'], ['FREQ=MONTHLY', 'Every month'], ['FREQ=YEARLY', 'Every year'],
];

/* ---------------- small helpers ---------------- */
const pad = (n) => String(n).padStart(2, '0');
export const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseLocal = (date, time) => new Date(`${date}T${time || '00:00'}`);
const DAY = 86400000;

function splitRule(rule) {
  if (!rule) return { base: '', until: '' };
  let until = '';
  const base = rule.split(';').filter((part) => {
    if (!part.startsWith('UNTIL=')) return true;
    const m = part.match(/^UNTIL=(\d{4})(\d{2})(\d{2})/);
    if (m) until = `${m[1]}-${m[2]}-${m[3]}`;
    return false;
  }).join(';');
  return { base, until };
}
const joinRule = (base, until) => (!base ? null : until ? `${base};UNTIL=${until.replace(/-/g, '')}T235959Z` : base);

/** "Mon, Oct 5, 8:00 AM to 9:00 AM" */
export function formatWhen(startIso, endIso, allDay) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (allDay) {
    const last = new Date(e.getTime() - DAY);
    return last > s && day(last) !== day(s) ? `${day(s)} to ${day(last)}, all day` : `${day(s)}, all day`;
  }
  return day(s) === day(e) ? `${day(s)}, ${time(s)} to ${time(e)}` : `${day(s)} ${time(s)} to ${day(e)} ${time(e)}`;
}

/** Recurring event: which occurrences does a change apply to? Resolves 'this', 'series' or null (cancelled). */
function askScope(title, verb) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (v) => { if (!answered) { answered = true; resolve(v); } };
    const modal = openModal({
      title,
      onClose: () => finish(null),
      content: h('div', { class: 'scope-choice' },
        h('p', { class: 'confirm-text' }, 'This event repeats. What should change?'),
        h('button', { class: 'btn block', type: 'button', onclick: () => { finish('this'); modal.close(); } }, `${verb} only this event`),
        h('button', { class: 'btn block', type: 'button', onclick: () => { finish('series'); modal.close(); } }, `${verb} all events in the series`),
        h('button', { class: 'btn block ghost', type: 'button', onclick: () => modal.close() }, 'Cancel')),
    });
  });
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* ================================================================== */
/* Event dialog                                                        */
/* ================================================================== */
/**
 * spec: { mode: 'create', start, end, allDay }  or  { mode: 'edit', event }   (event = an item from /api/calendar)
 * hooks: { courses, onDone }
 */
export function openEventModal(spec, { courses = [], onDone = () => {} } = {}) {
  const me = state.me;
  const raw = spec.mode === 'edit' ? spec.event : null;
  const own = !raw || raw.canEdit;
  const start = raw ? new Date(raw.start) : new Date(spec.start);
  const end = raw ? new Date(raw.end) : new Date(spec.end);
  const allDay = raw ? raw.allDay : !!spec.allDay;
  let lastDay = allDay ? new Date(end.getTime() - DAY) : end;
  if (lastDay < start) lastDay = start;

  let modal;
  const done = () => { modal.close(); onDone(); };

  /* ---------- top part shared by view and edit: completion + class stats ---------- */
  async function toggleDone() {
    try {
      await api(`/events/${raw.eventId}/complete`, { method: 'POST', body: { completed: !raw.completed, occurrenceStart: raw.occurrenceStart } });
      toast(raw.completed ? 'Marked as not done' : 'Marked as done', 'success');
      done();
    } catch (err) { toast(err.message, 'error'); }
  }
  const doneBlock = raw ? h('div', { class: 'ev-done-row' },
    h('button', { class: 'btn ' + (raw.completed ? '' : 'primary'), type: 'button', onclick: toggleDone },
      icon('check', 16), raw.completed ? 'Done. Mark as not done' : 'Mark as done'),
    raw.totalStudents !== undefined
      ? h('span', { class: 'ev-progress', title: 'Students who marked this done' },
        h('strong', null, `${raw.completedCount} of ${raw.totalStudents}`), ' students marked this done')
      : null) : null;

  /* ---------- read-only (a course event as a student) ---------- */
  if (!own) {
    const owner = state.users.get(raw.ownerId);
    modal = openModal({
      title: raw.title,
      onClose: () => onDone(false),
      content: h('div', { class: 'ev-view' },
        h('div', { class: 'ev-badges' },
          h('span', { class: 'type-pill ev-' + raw.type }, TYPE_LABEL[raw.type]),
          raw.courseName ? h('span', { class: 'chip' }, raw.courseName) : null,
          raw.isRecurring ? h('span', { class: 'tag' }, icon('repeat', 12), 'Repeats') : null),
        h('p', { class: 'ev-line' }, icon('clock', 16), formatWhen(raw.start, raw.end, raw.allDay)),
        raw.location ? h('p', { class: 'ev-line' }, icon('mapPin', 16), raw.location) : null,
        raw.description ? h('div', { class: 'q-body ev-notes' }, richText(raw.description)) : null,
        owner ? h('p', { class: 'muted ev-line' }, icon('cap', 16), `Set by ${owner.name}. Only they can change it.`) : null,
        doneBlock,
        h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Close'))),
    });
    return modal;
  }

  /* ---------- editable form ---------- */
  const title = h('input', { class: 'input', maxlength: '120', placeholder: 'e.g. Chapter 4 quiz', autocomplete: 'off' });
  title.value = raw ? raw.title : '';
  const type = h('select', { class: 'select' }, EVENT_TYPES.map(([v, l]) => h('option', { value: v }, l)));
  type.value = raw ? raw.type : 'assignment';

  const canPickCourse = !raw && me.role === 'teacher' && courses.length > 0;
  const target = h('select', { class: 'select' },
    h('option', { value: 'personal' }, 'Just me (personal)'),
    courses.map((c) => h('option', { value: c.id }, `Course: ${c.name} (${c.studentCount} ${c.studentCount === 1 ? 'student' : 'students'})`)));

  const startDate = h('input', { class: 'input', type: 'date', required: true });
  const startTime = h('input', { class: 'input', type: 'time' });
  const endDate = h('input', { class: 'input', type: 'date', required: true });
  const endTime = h('input', { class: 'input', type: 'time' });
  startDate.value = dateInput(start);
  startTime.value = timeInput(start);
  endDate.value = dateInput(lastDay);
  endTime.value = timeInput(end);
  const allDayBox = h('input', { type: 'checkbox' });
  allDayBox.checked = allDay;
  const times = [startTime, endTime];
  const syncAllDay = () => times.forEach((t) => t.classList.toggle('hidden', allDayBox.checked));
  allDayBox.addEventListener('change', syncAllDay);
  syncAllDay();
  // keep the end after the start when the start date moves
  startDate.addEventListener('change', () => { if (endDate.value < startDate.value) endDate.value = startDate.value; });

  const location = h('input', { class: 'input', maxlength: '120', placeholder: 'Room, link or place (optional)', autocomplete: 'off' });
  location.value = raw ? raw.location : '';
  const notes = h('textarea', { class: 'input', rows: 3, maxlength: '1000', placeholder: 'Notes (optional)' });
  notes.value = raw ? raw.description : '';

  const reminder = h('select', { class: 'select' }, REMINDERS.map(([v, l]) => h('option', { value: v === null ? '' : String(v) }, l)));
  const currentReminder = raw ? raw.reminderMinutes : (allDay ? null : 30);
  if (currentReminder !== null && !REMINDERS.some(([v]) => v === currentReminder)) reminder.append(h('option', { value: String(currentReminder) }, `${currentReminder} minutes before`));
  reminder.value = currentReminder === null ? '' : String(currentReminder);

  const parts = splitRule(raw ? raw.repeatRule : null);
  const repeat = h('select', { class: 'select' }, REPEATS.map(([v, l]) => h('option', { value: v }, l)));
  if (parts.base && !REPEATS.some(([v]) => v === parts.base)) repeat.append(h('option', { value: parts.base }, 'Custom repeat (kept as is)'));
  repeat.value = parts.base;
  const until = h('input', { class: 'input', type: 'date' });
  until.value = parts.until;
  const untilField = h('div', { class: 'field' }, h('label', null, 'Repeat until (optional)'), until, h('p', { class: 'hint' }, 'Leave empty to repeat with no end.'));
  const syncRepeat = () => untilField.classList.toggle('hidden', !repeat.value);
  repeat.addEventListener('change', syncRepeat);
  syncRepeat();

  const err = h('p', { class: 'form-error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, raw ? 'Save changes' : 'Add to calendar');

  async function remove() {
    try {
      if (raw.isRecurring) {
        const scope = await askScope('Delete event', 'Delete');
        if (!scope) return;
        await api(`/events/${raw.eventId}${scope === 'this' ? '?occurrence=' + encodeURIComponent(raw.occurrenceStart) : ''}`, { method: 'DELETE' });
      } else {
        const ok = await confirmDialog(`"${raw.title}" will be removed${raw.scope === 'course' ? ' for all students' : ''}.`, { title: 'Delete event', confirmText: 'Delete', danger: true });
        if (!ok) return;
        await api('/events/' + raw.eventId, { method: 'DELETE' });
      }
      toast('Event deleted');
      done();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Give the event a title.'; return; }
    if (!startDate.value || !endDate.value) { err.textContent = 'Pick a date.'; return; }
    let s;
    let en;
    if (allDayBox.checked) {
      s = parseLocal(startDate.value);
      en = parseLocal(endDate.value);
      en.setDate(en.getDate() + 1); // all-day events end at the start of the next day
    } else {
      if (!startTime.value || !endTime.value) { err.textContent = 'Pick a start and end time.'; return; }
      s = parseLocal(startDate.value, startTime.value);
      en = parseLocal(endDate.value, endTime.value);
    }
    if (en < s) { err.textContent = 'The event cannot end before it starts.'; return; }
    const reminderMinutes = reminder.value === '' ? null : Number(reminder.value);
    const rule = joinRule(repeat.value, until.value);
    const common = {
      title: title.value, type: type.value, description: notes.value, location: location.value,
      allDay: allDayBox.checked, reminderMinutes,
    };
    saveBtn.disabled = true;
    try {
      if (!raw) {
        const isCourse = canPickCourse && target.value !== 'personal';
        await api('/events', {
          method: 'POST',
          body: { ...common, start: s.toISOString(), end: en.toISOString(), repeatRule: rule, tz: browserZone(), scope: isCourse ? 'course' : 'personal', courseId: isCourse ? target.value : undefined },
        });
        toast(isCourse ? 'Added. Your students can see it now.' : 'Added to your calendar', 'success');
      } else if (!raw.isRecurring) {
        await api('/events/' + raw.eventId, { method: 'PATCH', body: { ...common, start: s.toISOString(), end: en.toISOString(), repeatRule: rule } });
        toast('Saved', 'success');
      } else {
        const scope = await askScope('Save changes', 'Change');
        if (!scope) { saveBtn.disabled = false; return; }
        if (scope === 'this') {
          await api(`/events/${raw.eventId}/occurrence`, {
            method: 'PATCH',
            body: { occurrenceStart: raw.occurrenceStart, start: s.toISOString(), end: en.toISOString(), title: title.value, location: location.value, description: notes.value },
          });
          // type and reminder can only be set for the whole series
          if (type.value !== raw.type || reminderMinutes !== raw.reminderMinutes || allDayBox.checked !== raw.allDay) {
            await api('/events/' + raw.eventId, { method: 'PATCH', body: { type: type.value, reminderMinutes, allDay: allDayBox.checked } });
          }
        } else {
          await api('/events/' + raw.eventId, {
            method: 'PATCH',
            body: { ...common, repeatRule: rule, shiftStartMs: s.getTime() - Date.parse(raw.start), shiftEndMs: en.getTime() - Date.parse(raw.end) },
          });
        }
        toast('Saved', 'success');
      }
      done();
    } catch (ex) {
      err.textContent = ex.message;
      saveBtn.disabled = false;
    }
  }

  const form = h('form', { class: 'form ev-form', onsubmit: submit },
    doneBlock,
    field('Title', title),
    h('div', { class: 'field-row' },
      field('Type', type),
      canPickCourse ? field('Add to', target) : (raw && raw.courseName ? h('div', { class: 'field' }, h('p', { class: 'label' }, 'Course'), h('p', { class: 'static-value' }, raw.courseName)) : null)),
    h('label', { class: 'check all-day' }, allDayBox, 'All day'),
    h('div', { class: 'field-row when-row' },
      h('div', { class: 'field' }, h('label', null, 'Starts'), h('div', { class: 'pair' }, startDate, startTime)),
      h('div', { class: 'field' }, h('label', null, 'Ends'), h('div', { class: 'pair' }, endDate, endTime))),
    field('Location', location),
    field('Notes', notes),
    h('div', { class: 'field-row' }, field('Reminder', reminder), field('Repeats', repeat)),
    untilField,
    raw && raw.isRecurring ? h('p', { class: 'hint' }, 'This event repeats. You will be asked whether a change applies to this event only or to all of them.') : null,
    err,
    h('div', { class: 'form-actions' },
      raw ? h('button', { class: 'btn danger-ghost', type: 'button', onclick: remove }, icon('trash', 15), 'Delete') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      saveBtn));

  modal = openModal({ title: raw ? 'Event details' : 'New event', content: form, wide: true, onClose: () => onDone(false) });
  return modal;
}

/* ================================================================== */
/* The calendar itself                                                 */
/* ================================================================== */
export function createCalendar(container, { getCourses = () => [], onChange = () => {} } = {}) {
  if (!window.FullCalendar) {
    container.append(errorState('The calendar could not be loaded. Run "npm install" and restart the server, then reload this page.'));
    return { refetch() {}, setCourses() {}, openCreate() {}, openEvent() {}, destroy() {} };
  }
  const mobile = () => window.matchMedia('(max-width: 720px)').matches;
  let filter = 'all';

  const filterSel = h('select', { class: 'select', 'aria-label': 'Which events to show', onchange: (e) => { filter = e.target.value; cal.refetchEvents(); } });
  const legend = h('div', { class: 'cal-legend', 'aria-label': 'Event colours' },
    EVENT_TYPES.map(([v, l]) => h('span', { class: 'legend-item ev-' + v }, h('i'), l)));
  const el = h('div', { class: 'cal' });
  container.append(h('div', { class: 'cal-tools' }, legend, filterSel), el);

  function drawFilter() {
    const courses = getCourses();
    filterSel.replaceChildren(
      h('option', { value: 'all' }, 'All events'),
      h('option', { value: 'personal' }, 'Only my personal events'),
      ...courses.map((c) => h('option', { value: c.id }, 'Course: ' + c.name)));
    if (filter !== 'all' && filter !== 'personal' && !courses.some((c) => c.id === filter)) filter = 'all';
    filterSel.value = filter;
    filterSel.classList.toggle('hidden', !courses.length);
  }

  const hooks = { get courses() { return getCourses(); }, onDone: (changed) => { if (changed !== false) { cal.refetchEvents(); onChange(); } else cal.unselect(); } };

  const toolbar = () => (mobile()
    ? { left: 'prev,next', center: 'title', right: 'today' }
    : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' });

  const toFc = (e) => ({
    id: e.key,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    editable: e.canEdit,
    classNames: ['ev-' + e.type, e.completed ? 'ev-done' : '', e.scope === 'course' ? 'ev-course' : 'ev-personal'],
    extendedProps: { raw: e },
  });

  async function moveEvent(info) {
    const raw = info.event.extendedProps.raw;
    if (!raw.canEdit) { info.revert(); return; }
    const oldStart = Date.parse(raw.start);
    const oldEnd = Date.parse(raw.end);
    const s = info.event.start.getTime();
    const en = info.event.end ? info.event.end.getTime() : s + (oldEnd - oldStart);
    try {
      if (raw.isRecurring) {
        const scope = await askScope('Move event', 'Move');
        if (!scope) { info.revert(); return; }
        if (scope === 'this') {
          await api(`/events/${raw.eventId}/occurrence`, { method: 'PATCH', body: { occurrenceStart: raw.occurrenceStart, start: new Date(s).toISOString(), end: new Date(en).toISOString() } });
        } else {
          await api('/events/' + raw.eventId, { method: 'PATCH', body: { allDay: info.event.allDay, shiftStartMs: s - oldStart, shiftEndMs: en - oldEnd } });
        }
      } else {
        await api('/events/' + raw.eventId, { method: 'PATCH', body: { allDay: info.event.allDay, start: new Date(s).toISOString(), end: new Date(en).toISOString() } });
      }
      cal.refetchEvents();
      onChange();
    } catch (err) {
      toast(err.message, 'error');
      info.revert();
    }
  }

  const cal = new window.FullCalendar.Calendar(el, {
    initialView: mobile() ? 'listWeek' : 'timeGridWeek',
    headerToolbar: toolbar(),
    footerToolbar: mobile() ? { center: 'dayGridMonth,timeGridDay,listWeek' } : false,
    buttonText: { today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'List' },
    timeZone: 'local',
    nowIndicator: true,
    navLinks: true,
    editable: true,
    selectable: true,
    selectMirror: true,
    longPressDelay: 350,
    eventDisplay: 'block', // coloured blocks in the month view too, not just dots
    dayMaxEvents: 3,
    slotEventOverlap: false, // events at the same time sit side by side instead of hiding each other
    slotMinTime: '00:00:00',
    slotMaxTime: '24:00:00',
    scrollTime: `${pad(Math.max(0, new Date().getHours() - 1))}:00:00`,
    height: mobile() ? 560 : 720,
    eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short' },
    displayEventEnd: false,
    noEventsContent: 'Nothing scheduled in this period.',
    events: async (info, ok, fail) => {
      try {
        const r = await api(`/calendar?start=${encodeURIComponent(info.start.toISOString())}&end=${encodeURIComponent(info.end.toISOString())}`);
        const show = (e) => filter === 'all' || (filter === 'personal' ? e.scope === 'personal' : e.courseId === filter);
        ok(r.events.filter(show).map(toFc));
      } catch (err) {
        toast(err.message, 'error');
        fail(err);
      }
    },
    eventContent(arg) {
      if (arg.view.type.startsWith('list')) return true; // keep FullCalendar's own list rows
      const raw = arg.event.extendedProps.raw;
      return {
        domNodes: [h('div', { class: 'fc-ev' },
          arg.timeText && !arg.event.allDay && arg.view.type !== 'dayGridMonth' ? h('span', { class: 'fc-ev-time' }, arg.timeText) : null,
          raw.completed ? icon('check', 12) : null,
          h('span', { class: 'fc-ev-title' }, arg.event.title),
          raw.isRecurring ? icon('repeat', 11) : null)],
      };
    },
    eventDidMount(arg) {
      const raw = arg.event.extendedProps.raw;
      arg.el.title = `${TYPE_LABEL[raw.type]}: ${raw.title}${raw.courseName ? ' (' + raw.courseName + ')' : ''}${raw.completed ? ' (done)' : ''}`;
    },
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openEventModal({ mode: 'edit', event: info.event.extendedProps.raw }, hooks);
    },
    select: (info) => {
      let { start, end, allDay } = info;
      // a click on a day in the month view means "something that day": suggest a normal timed slot
      if (allDay && info.view.type === 'dayGridMonth' && end - start <= DAY + 3600000) {
        start = new Date(start); start.setHours(9, 0, 0, 0);
        end = new Date(start); end.setHours(10, 0, 0, 0);
        allDay = false;
      }
      openEventModal({ mode: 'create', start, end, allDay }, hooks);
    },
    eventDrop: moveEvent,
    eventResize: moveEvent,
    windowResize: () => { cal.setOption('headerToolbar', toolbar()); cal.setOption('footerToolbar', mobile() ? { center: 'dayGridMonth,timeGridDay,listWeek' } : false); cal.setOption('height', mobile() ? 560 : 720); },
  });
  cal.render();
  drawFilter();

  return {
    refetch: () => cal.refetchEvents(),
    setCourses: drawFilter,
    openCreate(when) {
      const start = new Date(when || Date.now());
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() + 1);
      const end = new Date(start.getTime() + 3600000);
      openEventModal({ mode: 'create', start, end, allDay: false }, hooks);
    },
    openEvent: (event) => openEventModal({ mode: 'edit', event }, hooks),
    destroy() { cal.destroy(); },
  };
}
