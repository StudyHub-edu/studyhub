// People: member directory, profile pages, your settings and the leaderboard.
import { state, bus, subscribe, dmId } from '../state.js';
import { api } from '../api.js';
import {
  h, icon, avatar, avatarStatus, roleBadge, subjectChip, toast, field, emptyState, errorState, loadingState, debounce, timeAgo,
} from '../ui.js?v=3';

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */
export function mountMembers(container) {
  const sub = subscribe();
  let role = 'all';
  let onlineOnly = false;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or username', 'aria-label': 'Search people' });
  const onlineBox = h('input', { type: 'checkbox', onchange: (e) => { onlineOnly = e.target.checked; draw(); } });
  const tabsEl = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Role filter' });
  const countEl = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const grid = h('div', { class: 'member-grid' }, loadingState());

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('div', null, h('h1', null, 'People'), h('p', null, 'Students and teachers in your community.'))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search-box' }, icon('search', 16), search),
      h('label', { class: 'check' }, onlineBox, 'Online now')),
    tabsEl, countEl, grid));

  const TABS = [['all', 'Everyone'], ['student', 'Students'], ['teacher', 'Teachers']];
  function drawTabs() {
    tabsEl.replaceChildren(...TABS.map(([value, label]) =>
      h('button', {
        class: 'tab' + (role === value ? ' active' : ''), type: 'button', 'aria-pressed': String(role === value),
        onclick: () => { role = value; drawTabs(); draw(); },
      }, label)));
  }

  function card(u) {
    const online = state.online.has(u.id);
    const isMe = u.id === state.me.id;
    return h('article', { class: 'member' },
      h('div', { class: 'member-top' },
        avatarStatus(u, 52),
        h('div', { class: 'member-id' },
          h('h3', null, h('a', { href: '#/user/' + u.id }, u.name), isMe ? h('span', { class: 'you' }, 'you') : null),
          h('p', null, '@' + u.username),
          roleBadge(u))),
      h('p', { class: 'member-bio' }, u.bio || (u.role === 'admin' ? 'Admin' : u.role === 'teacher' ? 'Teacher' : 'Student')),
      h('div', { class: 'member-foot' },
        h('span', { class: 'points', title: 'Reputation points' }, icon('star', 14), u.points + ' points'),
        h('span', { class: 'presence-text' + (online ? ' on' : '') }, online ? 'Online' : 'Offline'),
        isMe
          ? h('a', { class: 'btn small', href: '#/profile' }, 'Edit profile')
          : h('a', { class: 'btn small primary', href: '#/chat/' + dmId(state.me.id, u.id) }, icon('chat', 14), 'Message')));
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => !u.bot)
      .filter((u) => u.role === 'student' || u.role === 'teacher')
      .filter((u) => role === 'all' || u.role === role)
      .filter((u) => !onlineOnly || state.online.has(u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.includes(q))
      .sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name));
    countEl.textContent = people.length === 1 ? '1 person' : people.length + ' people';
    grid.replaceChildren(...(people.length ? people.map(card) : [emptyState('users', 'Nobody found', 'Try a different name or filter.')]));
  }

  async function refresh() {
    try {
      const r = await api('/users');
      r.users.forEach((u) => state.users.set(u.id, u));
      draw();
    } catch (err) {
      grid.replaceChildren(errorState(err.message, refresh));
    }
  }

  search.addEventListener('input', debounce(draw, 150));
  sub.on('presence', draw);
  sub.on('users:changed', draw);
  drawTabs();
  draw();
  refresh();
  return () => sub.off();
}

/* ------------------------------------------------------------------ */
/* Profile page                                                        */
/* ------------------------------------------------------------------ */
export function mountProfile(container, id) {
  const sub = subscribe();
  const body = h('div', { class: 'profile-body' }, loadingState());
  container.append(h('div', { class: 'page narrow' },
    h('a', { class: 'back-link', href: '#/members' }, icon('arrowLeft', 16), 'People'), body));

  function render(data) {
    const u = data.user;
    const isMe = u.id === state.me.id;
    const s = data.stats;
    const tiles = [
      ['Points', u.points], ['Questions', s.questions], ['Answers', s.answers],
      ['Best answers', s.accepted], ['Teacher verified', s.verified], ['Messages', s.messages],
    ];
    body.replaceChildren(
      h('section', { class: 'profile-head' },
        avatarStatus(u, 84),
        h('div', { class: 'profile-id' },
          h('h1', null, u.name, roleBadge(u)),
          h('p', { class: 'muted' }, '@' + u.username + ' - joined ' + new Date(u.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })),
          u.bio ? h('p', { class: 'profile-bio' }, u.bio) : null,
          h('div', { class: 'profile-actions' },
            isMe
              ? h('a', { class: 'btn', href: '#/profile' }, icon('edit', 15), 'Edit profile')
              : h('a', { class: 'btn primary', href: '#/chat/' + dmId(state.me.id, u.id) }, icon('chat', 15), 'Send a message')))),
      h('section', { class: 'stat-grid', 'aria-label': 'Activity' }, tiles.map(([label, value]) =>
        h('div', { class: 'stat-tile' }, h('strong', null, value), h('span', null, label)))),
      h('section', null,
        h('h2', { class: 'section-title' }, 'Recent questions'),
        data.recentQuestions.length
          ? h('div', { class: 'q-list' }, data.recentQuestions.map((q) =>
            h('a', { class: 'q-row compact' + (q.solved ? ' solved' : ''), href: '#/qa/' + q.id },
              h('div', { class: 'q-main' },
                h('h3', null, q.title),
                h('div', { class: 'q-meta' }, subjectChip(q.subject),
                  q.solved ? h('span', { class: 'tag ok' }, icon('check', 12), 'Solved') : null,
                  h('span', { class: 'byline-time' }, q.answerCount + (q.answerCount === 1 ? ' answer' : ' answers') + ' - ' + timeAgo(q.createdAt)))))))
          : h('p', { class: 'muted' }, 'No questions yet.')));
  }

  async function load() {
    try { render(await api('/users/' + id)); } catch (err) { body.replaceChildren(errorState(err.message, load)); }
  }
  sub.on('users:changed', load);
  load();
  return () => sub.off();
}

/* ------------------------------------------------------------------ */
/* Your settings                                                       */
/* ------------------------------------------------------------------ */
function themeCard() {
  const btn = h('button', { class: 'btn', type: 'button' });
  const draw = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon', 16), dark ? 'Switch to light theme' : 'Switch to dark theme');
  };
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sh_theme', next);
    window.dispatchEvent(new Event('sh:theme'));
    draw();
  });
  draw();
  return h('div', { class: 'form card-form' }, h('h2', null, 'Appearance'), h('p', { class: 'muted' }, 'Pick the theme that is easiest on your eyes.'), h('div', { class: 'form-actions' }, btn));
}

export function mountSettings(container) {
  const me = state.me;
  let color = me.color;

  const name = h('input', { class: 'input', maxlength: '40', autocomplete: 'name' });
  name.value = me.name;
  const bio = h('textarea', { class: 'input', rows: 3, maxlength: '200', placeholder: 'A short line about you: grade, favourite subject, goals...' });
  bio.value = me.bio || '';
  const preview = h('div', { class: 'preview' });
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Avatar colour' });
  const profileErr = h('p', { class: 'form-error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

  function drawPreview() {
    preview.replaceChildren(avatar({ name: name.value || me.name, color }, 56),
      h('div', null, h('strong', null, name.value.trim() || me.name), h('p', { class: 'muted' }, '@' + me.username)));
    swatches.replaceChildren(...state.colors.map((c) =>
      h('button', {
        class: 'swatch' + (c === color ? ' on' : ''), type: 'button', style: { background: c },
        'aria-label': 'Colour ' + c, 'aria-pressed': String(c === color),
        onclick: () => { color = c; drawPreview(); },
      }, c === color ? icon('check', 14) : null)));
  }
  name.addEventListener('input', drawPreview);

  const profileForm = h('form', {
    class: 'form card-form',
    onsubmit: async (e) => {
      e.preventDefault();
      profileErr.textContent = '';
      saveBtn.disabled = true;
      try {
        const r = await api('/me', { method: 'PATCH', body: { name: name.value, bio: bio.value, color } });
        state.me = r.me;
        state.users.set(r.me.id, r.me);
        bus.emit('users:changed');
        toast('Profile saved', 'success');
      } catch (ex) {
        profileErr.textContent = ex.message;
      } finally {
        saveBtn.disabled = false;
      }
    },
  },
  h('h2', null, 'Your profile'),
  preview,
  field('Display name', name),
  field('About you', bio),
  h('div', { class: 'field' }, h('p', { class: 'label' }, 'Avatar colour'), swatches),
  profileErr,
  h('div', { class: 'form-actions' }, saveBtn));

  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minLength: 6 });
  const passErr = h('p', { class: 'form-error', role: 'alert' });
  const passBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const passForm = h('form', {
    class: 'form card-form',
    onsubmit: async (e) => {
      e.preventDefault();
      passErr.textContent = '';
      passBtn.disabled = true;
      try {
        await api('/me/password', { method: 'POST', body: { current: current.value, next: next.value } });
        current.value = '';
        next.value = '';
        toast('Password changed', 'success');
      } catch (ex) {
        passErr.textContent = ex.message;
      } finally {
        passBtn.disabled = false;
      }
    },
  },
  h('h2', null, 'Password'),
  field('Current password', current),
  field('New password', next, 'At least 6 characters.'),
  passErr,
  h('div', { class: 'form-actions' }, passBtn));

  container.append(h('div', { class: 'page narrow' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, 'Settings'), h('p', null, 'Signed in as @' + me.username + ' (' + me.role + ')')),
      h('a', { class: 'btn', href: '#/user/' + me.id }, 'View my profile')),
    profileForm, passForm,
    themeCard(),
    h('div', { class: 'form card-form' },
      h('h2', null, 'Sign out'),
      h('p', { class: 'muted' }, 'You will need your password to sign back in.'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn danger-ghost', type: 'button', onclick: () => window.dispatchEvent(new Event('sh:logout')) }, icon('logout', 16), 'Log out')))));
  drawPreview();
  return () => {};
}

/* ------------------------------------------------------------------ */
/* Leaderboard                                                         */
/* ------------------------------------------------------------------ */
export function mountLeaderboard(container) {
  const sub = subscribe();
  const listEl = h('ol', { class: 'board' });
  const wrap = h('div', { class: 'board-wrap' }, loadingState());

  const RULES = [
    ['Ask a question', '+1'], ['Someone votes for your question', '+2 each'],
    ['Post an answer', '+2'], ['Someone votes for your answer', '+5 each'],
    ['Your answer is chosen as best', '+15'], ['A teacher verifies your answer', '+10'],
    ['Share a resource', '+1, then +1 per like'],
  ];

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('div', null, h('h1', null, 'Leaderboard'), h('p', null, 'The people who help the most.'))),
    h('div', { class: 'board-layout' },
      wrap,
      h('aside', { class: 'rules' },
        h('h2', null, 'How points work'),
        h('dl', null, RULES.map(([what, pts]) => [h('dt', null, what), h('dd', null, pts)]))))));

  async function load() {
    try {
      const r = await api('/leaderboard');
      listEl.replaceChildren(...r.items.map((it, i) =>
        h('li', { class: 'board-row' + (i < 3 ? ' top top-' + (i + 1) : '') + (it.user.id === state.me.id ? ' me' : '') },
          h('span', { class: 'rank' }, i + 1),
          avatarStatus(it.user, 40),
          h('div', { class: 'board-name' },
            h('a', { href: '#/user/' + it.user.id }, it.user.name), roleBadge(it.user),
            h('small', null, it.answers + (it.answers === 1 ? ' answer' : ' answers') + ', ' + it.accepted + ' best')),
          h('strong', { class: 'board-points' }, it.points, h('small', null, 'pts')))));
      wrap.replaceChildren(r.items.length ? listEl : emptyState('trophy', 'No one yet', 'Answer a question to get on the board.'));
    } catch (err) {
      wrap.replaceChildren(errorState(err.message, load));
    }
  }
  load();
  return () => sub.off();
}
