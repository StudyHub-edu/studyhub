// Courses: teachers create them and share a join code, students join with the code.
import { state } from '../state.js';
import { api } from '../api.js';
import { h, icon, avatar, toast, openModal, confirmDialog, field, emptyState } from '../ui.js?v=3';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ' + text, 'success');
  } catch (_) {
    toast('Your join code is ' + text);
  }
}

function openCreateCourse(onDone) {
  const name = h('input', { class: 'input', maxlength: '60', placeholder: 'e.g. Grade 10 Mathematics', autocomplete: 'off' });
  const code = h('input', { class: 'input', maxlength: '12', placeholder: 'e.g. MATH10 (optional)', autocomplete: 'off' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create course');
  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = await api('/courses', { method: 'POST', body: { name: name.value, code: code.value } });
        modal.close();
        toast(`Course created. Students join with the code ${r.course.joinCode}.`, 'success', { duration: 7000 });
        onDone();
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  field('Course name', name),
  field('Short code', code, 'A label shown next to the course name.'),
  err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'New course', content: form });
}

function openJoinCourse(onDone) {
  const code = h('input', { class: 'input code-input', maxlength: '12', placeholder: 'ABC123', autocomplete: 'off', autocapitalize: 'characters' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Join course');
  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = await api('/courses/join', { method: 'POST', body: { joinCode: code.value } });
        modal.close();
        toast(`You joined ${r.course.name}. Its schedule is now on your calendar.`, 'success');
        onDone();
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  field('Join code', code, 'Your teacher gives you a 6 character code.'),
  err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Join a course', content: form });
}

function openRoster(course, onDone) {
  const listEl = h('div', { class: 'roster' });
  const username = h('input', { class: 'input', placeholder: 'Add a student by username', 'aria-label': 'Student username', autocomplete: 'off', autocapitalize: 'none' });
  const err = h('p', { class: 'form-error', role: 'alert' });

  async function load() {
    try {
      const r = await api(`/courses/${course.id}/students`);
      listEl.replaceChildren(...(r.students.length
        ? r.students.map((u) => h('div', { class: 'roster-row' },
          avatar(u, 32),
          h('div', { class: 'roster-name' }, h('strong', null, u.name), h('small', null, '@' + u.username)),
          h('button', {
            class: 'btn small danger-ghost', type: 'button',
            onclick: async () => {
              const ok = await confirmDialog(`${u.name} will no longer see this course's events.`, { title: 'Remove student', confirmText: 'Remove', danger: true });
              if (!ok) return;
              try { await api(`/courses/${course.id}/students/${u.id}`, { method: 'DELETE' }); await load(); onDone(); } catch (ex) { toast(ex.message, 'error'); }
            },
          }, 'Remove')))
        : [h('p', { class: 'side-empty' }, 'No students yet. Share the join code, or add them by username.')]));
    } catch (ex) {
      listEl.replaceChildren(h('p', { class: 'form-error' }, ex.message));
    }
  }

  const form = h('form', {
    class: 'add-student',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const r = await api(`/courses/${course.id}/students`, { method: 'POST', body: { username: username.value } });
        username.value = '';
        toast(`${r.student.name} was added`, 'success');
        await load();
        onDone();
      } catch (ex) { err.textContent = ex.message; }
    },
  }, username, h('button', { class: 'btn primary', type: 'submit' }, 'Add'));

  openModal({
    title: course.name,
    content: h('div', null,
      h('div', { class: 'join-code-box' },
        h('div', null, h('p', { class: 'label' }, 'Join code'), h('strong', { class: 'join-code' }, course.joinCode)),
        h('button', { class: 'btn small', type: 'button', onclick: () => copy(course.joinCode) }, icon('copy', 14), 'Copy')),
      form, err, listEl),
  });
  load();
}

/** The "My courses" card. `courses` comes from GET /api/courses; call onChange() after anything that changes them. */
export function coursesCard(courses, onChange) {
  const teacher = state.me.role === 'teacher';

  const row = (c) => {
    const t = state.users.get(c.teacherId);
    return h('li', { class: 'course' },
      h('div', { class: 'course-main' },
        h('strong', null, c.name, c.code ? h('span', { class: 'chip course-code' }, c.code) : null),
        teacher
          ? h('small', null, `${c.studentCount} ${c.studentCount === 1 ? 'student' : 'students'}`)
          : h('small', null, t ? `Teacher: ${t.name}` : '')),
      teacher
        ? h('div', { class: 'course-actions' },
          h('button', { class: 'code-pill', type: 'button', title: 'Copy join code', onclick: () => copy(c.joinCode) }, c.joinCode, icon('copy', 13)),
          h('button', { class: 'btn small', type: 'button', onclick: () => openRoster(c, onChange) }, icon('users', 14), 'Students'),
          h('button', {
            class: 'icon-btn small', type: 'button', title: 'Delete course', 'aria-label': 'Delete ' + c.name,
            onclick: async () => {
              const ok = await confirmDialog(`"${c.name}", all of its events and its student list will be deleted.`, { title: 'Delete course', confirmText: 'Delete course', danger: true });
              if (!ok) return;
              try { await api('/courses/' + c.id, { method: 'DELETE' }); toast('Course deleted'); onChange(); } catch (ex) { toast(ex.message, 'error'); }
            },
          }, icon('trash', 15)))
        : h('button', {
          class: 'btn small danger-ghost', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog(`You will stop seeing the events of ${c.name}.`, { title: 'Leave course', confirmText: 'Leave', danger: true });
            if (!ok) return;
            try { await api(`/courses/${c.id}/students/${state.me.id}`, { method: 'DELETE' }); toast('You left ' + c.name); onChange(); } catch (ex) { toast(ex.message, 'error'); }
          },
        }, 'Leave'));
  };

  return h('section', { class: 'card side-card courses-card' },
    h('div', { class: 'card-head' },
      h('h2', null, 'My courses'),
      h('button', { class: 'btn small', type: 'button', onclick: () => (teacher ? openCreateCourse(onChange) : openJoinCourse(onChange)) },
        icon('plus', 14), teacher ? 'New course' : 'Join a course')),
    courses.length
      ? h('ul', { class: 'course-list' }, courses.map(row))
      : emptyState('users',
        teacher ? 'No courses yet' : 'Not in a course yet',
        teacher ? 'Create a course to schedule classes, assignments and exams for your students.' : 'Ask your teacher for a join code to see the schedule of your classes here.'));
}
