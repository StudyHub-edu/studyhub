// StudyHub front end: login screen, app shell, hash router and live (Socket.IO) wiring.
import { state, bus, totalUnread, markRead } from './state.js';
import { api, getToken, setToken } from './api.js';
import { h, icon, avatar, toast, showPopover, closePopover, timeAgo, errorState, field } from './ui.js?v=3';
import { mountDashboard } from './views/dashboard.js';
import { mountChat } from './views/chat.js';
import { mountQuestions, mountQuestion } from './views/qa.js?v=2';
import { mountAnnouncements } from './views/announcements.js';
import { mountResources } from './views/resources.js?v=2';
import { mountMembers, mountProfile, mountSettings, mountLeaderboard } from './views/people.js';
import { mountCalendarPage } from './views/calendar-page.js';

const root = document.getElementById('root');
let viewEl = null;
let railEl = null;
let connEl = null;
let cleanup = null;
let routerBound = false;
let redrawThemeIcon = null;

/** Where the "back to StudyHub" / logo links should go: the person's real
 * dashboard (student/teacher/admin), remembered by the main site's
 * js/auth-bridge.js right after login. Falls back to the student dashboard
 * if this is somehow opened without ever going through the main site. */
function studyHubHome() {
  try { return localStorage.getItem('studyhub_home') || '/dashboard.html'; } catch (e) { return '/dashboard.html'; }
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */
function currentTheme() {
  return document.documentElement.dataset.theme || 'light';
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('sh_theme', theme);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
window.addEventListener('sh:unauthorized', () => forceLogout('Your session ended. Please log in again.'));
window.addEventListener('sh:logout', logout);
window.addEventListener('sh:theme', () => { if (redrawThemeIcon) redrawThemeIcon(); });
boot();

async function boot() {
  // There is no login screen here: StudyHub Community always signs a person
  // in with the account they used on the main StudyHub site. A short-lived
  // token for this app is minted right after login (see js/auth-bridge.js on
  // the main site) and stored under the same 'sh_token' key this app reads.
  await refreshCommunitySession();
  if (!getToken()) { redirectToLogin(); return; }
  root.replaceChildren(h('div', { class: 'boot' }, h('span', { class: 'spinner' }), 'Loading StudyHub...'));
  try {
    startApp(await api('/bootstrap'));
  } catch (err) {
    if (err.status === 401) { setToken(''); redirectToLogin(); return; }
    root.replaceChildren(h('div', { class: 'boot' }, errorState(err.message, boot)));
  }
}

async function refreshCommunitySession() {
  const client = window.studyhubSupabase;
  if (!client) return;

  try {
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.warn('[StudyHub] Could not refresh Community sign-in:', error.message);
      return;
    }
    const accessToken = data.session?.access_token;
    if (!accessToken) return;

    const response = await fetch('/api/bridge/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + accessToken,
      },
    });
    if (!response.ok) {
      console.warn('[StudyHub] Community sign-in refresh failed:', response.status);
      return;
    }
    const session = await response.json();
    if (session.token) setToken(session.token);
    if (session.home) localStorage.setItem('studyhub_home', session.home);
  } catch (error) {
    console.warn('[StudyHub] Could not refresh Community sign-in:', error.message);
  }
}

function redirectToLogin() {
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.replace('/index.html?next=' + next);
}

function applyBootstrap(data) {
  state.me = data.me;
  state.users = new Map(data.users.map((u) => [u.id, u]));
  state.channels = data.channels;
  state.unread = data.unread;
  state.dms = data.dms;
  state.notifications = data.notifications;
  state.subjects = data.subjects;
  state.reactions = data.reactions;
  state.colors = data.colors;
  state.online = new Set(data.online);
}

function startApp(data) {
  applyBootstrap(data);
  connectSocket();
  renderShell();
  if (!routerBound) { window.addEventListener('hashchange', route); routerBound = true; }
  route();
}

function teardownApp() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  window.removeEventListener('hashchange', route);
  routerBound = false;
  closePopover();
  Object.assign(state, { me: null, users: new Map(), channels: [], unread: {}, dms: [], notifications: [], online: new Set(), current: null });
  history.replaceState(null, '', location.pathname);
  document.title = 'StudyHub';
}

async function logout() {
  if (!state.me) return;
  try { await api('/logout', { method: 'POST' }); } catch (_) { /* logging out anyway */ }
  forceLogout();
}

function forceLogout(message) {
  if (!state.me) return;
  setToken('');
  teardownApp();
  if (message) toast(message, 'error');
  redirectToLogin();
}

/* ------------------------------------------------------------------ */
/* Shell: navigation rail + view container                             */
/* ------------------------------------------------------------------ */
const NAV = [
  { key: 'dashboard', label: 'Home', icon: 'home', href: '#/dashboard' },
  { key: 'chat', label: 'Chat', icon: 'chat', href: '#/chat' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '#/calendar' },
  { key: 'qa', label: 'Q&A', icon: 'help', href: '#/qa' },
  { key: 'announcements', label: 'News', icon: 'megaphone', href: '#/announcements' },
  { key: 'resources', label: 'Resources', icon: 'book', href: '#/resources' },
  { key: 'members', label: 'People', icon: 'users', href: '#/members' },
  { key: 'leaderboard', label: 'Top', icon: 'trophy', href: '#/leaderboard' },
];

function renderShell() {
  const navItems = NAV.map((n) => h('a', { class: 'rail-item', href: n.href, dataset: { nav: n.key }, title: n.label },
    icon(n.icon, 22), h('span', { class: 'rail-label' }, n.label), h('span', { class: 'rail-badge hidden', dataset: { badge: n.key } })));

  const bell = h('button', { class: 'rail-item', type: 'button', title: 'Notifications', 'aria-label': 'Notifications', onclick: openNotifications },
    icon('bell', 22), h('span', { class: 'rail-label' }, 'Alerts'), h('span', { class: 'rail-badge hidden', dataset: { badge: 'bell' } }));

  const themeBtn = h('button', {
    class: 'rail-item theme-btn', type: 'button', title: 'Switch light / dark', 'aria-label': 'Switch light or dark theme',
    onclick: () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); drawThemeIcon(); },
  });
  const drawThemeIcon = () => {
    themeBtn.replaceChildren(icon(currentTheme() === 'dark' ? 'sun' : 'moon', 22), h('span', { class: 'rail-label' }, currentTheme() === 'dark' ? 'Light' : 'Dark'));
  };
  drawThemeIcon();
  redrawThemeIcon = drawThemeIcon;

  const profileBtn = h('a', { class: 'rail-item profile-btn', href: '#/profile', title: 'Settings', dataset: { nav: 'profile' } });
  const drawProfile = () => {
    profileBtn.replaceChildren(avatar(state.me, 30), h('span', { class: 'rail-label' }, 'Me'));
    profileBtn.title = state.me.name + ' - settings';
  };
  drawProfile();
  bus.on('users:changed', () => { if (state.me) { const fresh = state.users.get(state.me.id); if (fresh) state.me = fresh; drawProfile(); } });

  railEl = h('nav', { class: 'rail', 'aria-label': 'Main' },
    h('a', { class: 'rail-item rail-back', href: studyHubHome(), 'aria-label': 'Back to StudyHub', title: 'Back to StudyHub' }, icon('back', 20)),
    h('a', { class: 'rail-logo', href: studyHubHome(), 'aria-label': 'StudyHub home', title: 'StudyHub' },
      h('img', { src: '/assets/studyhub-logo.png', alt: 'StudyHub', style: 'width:24px;height:24px;object-fit:contain;' })),
    h('div', { class: 'rail-nav' }, navItems),
    h('div', { class: 'rail-bottom' }, bell, themeBtn, profileBtn));

  connEl = h('div', { class: 'conn-banner hidden', role: 'status' }, 'Connection lost. Trying to reconnect...');
  viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  root.replaceChildren(h('div', { class: 'shell' }, connEl, railEl, viewEl));
  updateBadges();
}

function setActiveNav(key) {
  railEl.querySelectorAll('[data-nav]').forEach((el) => {
    const on = el.dataset.nav === key;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}

const unreadNotes = (types) => state.notifications.filter((n) => !n.read && (!types || types.includes(n.type))).length;

function updateBadges() {
  if (!railEl) return;
  const counts = {
    dashboard: unreadNotes(['reminder', 'event', 'course']),
    chat: totalUnread(),
    qa: unreadNotes(['answer', 'accepted', 'verified']),
    announcements: unreadNotes(['announcement']),
    bell: unreadNotes(),
  };
  for (const [key, n] of Object.entries(counts)) {
    const el = railEl.querySelector(`[data-badge="${key}"]`);
    if (!el) continue;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', !n);
  }
  document.title = (counts.chat ? `(${counts.chat}) ` : '') + 'StudyHub';
}
bus.on('unread:changed', updateBadges);
bus.on('notifications:changed', updateBadges);

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
const NOTE_ICONS = {
  mention: 'chat', answer: 'help', accepted: 'checkCircle', verified: 'cap', announcement: 'megaphone',
  reminder: 'clock', event: 'calendar', course: 'users',
};

function markNotifications(ids) {
  const set = new Set(ids);
  let changed = false;
  for (const n of state.notifications) if (set.has(n.id) && !n.read) { n.read = true; changed = true; }
  if (!changed) return;
  bus.emit('notifications:changed');
  api('/notifications/read', { method: 'POST', body: { ids } }).catch(() => {});
}

function markNotificationsForLink(hash) {
  const ids = state.notifications.filter((n) => !n.read && n.link === hash).map((n) => n.id);
  if (ids.length) markNotifications(ids);
}

function openNotifications(e) {
  const unread = state.notifications.filter((n) => !n.read);
  const panel = h('div', { class: 'notif-panel' },
    h('div', { class: 'notif-head' },
      h('strong', null, 'Notifications'),
      unread.length ? h('button', {
        class: 'btn small', type: 'button',
        onclick: () => { markNotifications(unread.map((n) => n.id)); closePopover(); },
      }, 'Mark all read') : null),
    state.notifications.length
      ? h('div', { class: 'notif-list' }, state.notifications.map((n) =>
        h('a', {
          class: 'notif' + (n.read ? '' : ' unread'), href: n.link || '#/chat',
          onclick: () => { closePopover(); markNotifications([n.id]); },
        }, icon(NOTE_ICONS[n.type] || 'bell', 16), h('span', { class: 'notif-text' }, n.text), h('small', null, timeAgo(n.createdAt)))))
      : h('p', { class: 'side-empty' }, 'You are all caught up.'));
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  showPopover(e.currentTarget, panel, { className: 'notif-pop', side: mobile ? undefined : 'right' });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const ROUTES = [
  [/^#\/dashboard$/, 'dashboard', (c) => mountDashboard(c)],
  [/^#\/chat(?:\/([\w-]+))?$/, 'chat', (c, m) => mountChat(c, m[1])],
  [/^#\/calendar$/, 'calendar', (c) => mountCalendarPage(c)],
  [/^#\/qa\/(\w+)$/, 'qa', (c, m) => mountQuestion(c, m[1])],
  [/^#\/qa$/, 'qa', (c) => mountQuestions(c)],
  [/^#\/announcements$/, 'announcements', (c) => mountAnnouncements(c)],
  [/^#\/resources$/, 'resources', (c) => mountResources(c)],
  [/^#\/members$/, 'members', (c) => mountMembers(c)],
  [/^#\/user\/(\w+)$/, 'members', (c, m) => mountProfile(c, m[1])],
  [/^#\/leaderboard$/, 'leaderboard', (c) => mountLeaderboard(c)],
  [/^#\/profile$/, 'profile', (c) => mountSettings(c)],
];

function route() {
  if (!state.me || !viewEl) return;
  if (!location.hash) history.replaceState(null, '', '#/dashboard'); // so links and "you are already here" checks agree
  const hash = location.hash;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  closePopover();

  let found = null;
  for (const [re, nav, mount] of ROUTES) {
    const m = hash.match(re);
    if (m) { found = { nav, mount, m }; break; }
  }
  if (!found) { location.replace('#/dashboard'); return; }

  viewEl.replaceChildren();
  viewEl.scrollTop = 0;
  viewEl.className = 'view' + (found.nav === 'chat' ? ' view-chat' : '');
  setActiveNav(found.nav);
  updateBadges();
  markNotificationsForLink(hash);
  try {
    cleanup = found.mount(viewEl, found.m) || null;
  } catch (err) {
    console.error(err);
    viewEl.replaceChildren(errorState('Something went wrong showing this page.', route));
  }
}

const go = (link) => { if (link) location.hash = link; };

/* ------------------------------------------------------------------ */
/* Live connection                                                     */
/* ------------------------------------------------------------------ */
function upsertDM(m) {
  const other = m.cid.split('-').slice(1).find((id) => id !== state.me.id);
  if (!other) return;
  const entry = { cid: m.cid, userId: other, lastAt: m.createdAt, lastText: m.deleted ? 'Message deleted' : m.text.slice(0, 60) };
  const i = state.dms.findIndex((d) => d.cid === m.cid);
  if (i >= 0) state.dms[i] = entry; else state.dms.push(entry);
  state.dms.sort((a, b) => b.lastAt - a.lastAt);
  bus.emit('dms:changed');
}

function onMessageNew(m) {
  const isDM = m.cid.startsWith('dm-');
  if (isDM) upsertDM(m);
  bus.emit('message:new', m);
  if (m.userId === state.me.id || m.system) return;

  if (state.current === m.cid && !document.hidden) {
    markRead(m.cid);
    return;
  }
  state.unread[m.cid] = (state.unread[m.cid] || 0) + 1;
  bus.emit('unread:changed');
  if (isDM) {
    const sender = state.users.get(m.userId);
    toast(`${sender ? sender.name : 'Someone'}: ${m.text.slice(0, 80)}`, 'info', { onClick: () => go('#/chat/' + m.cid) });
  }
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = window.io('/community', { path: '/community/socket.io', auth: { token: getToken() } });
  state.socket = socket;
  let hadConnection = false;

  socket.on('connect', async () => {
    connEl.classList.add('hidden');
    if (hadConnection) {
      // We missed things while offline: refresh everything once.
      try {
        applyBootstrap(await api('/bootstrap'));
        ['channels:changed', 'dms:changed', 'users:changed', 'unread:changed', 'notifications:changed', 'reconnected'].forEach((e) => bus.emit(e));
      } catch (_) { /* the next event will retry */ }
    }
    hadConnection = true;
  });
  socket.on('disconnect', () => connEl.classList.remove('hidden'));
  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') forceLogout('Your session ended. Please log in again.');
    else connEl.classList.remove('hidden');
  });

  socket.on('presence:all', (ids) => { state.online = new Set(ids); bus.emit('presence'); });
  socket.on('presence', ({ userId, online }) => {
    if (online) state.online.add(userId); else state.online.delete(userId);
    bus.emit('presence', { userId, online });
  });
  socket.on('user:joined', (u) => { state.users.set(u.id, u); bus.emit('users:changed'); });
  socket.on('user:updated', (u) => { state.users.set(u.id, u); bus.emit('users:changed'); });

  socket.on('channel:new', (ch) => {
    if (!state.channels.some((c) => c.id === ch.id)) {
      state.channels.push(ch);
      if (ch.createdBy !== state.me.id) toast(`New channel: #${ch.name}`, 'info', { onClick: () => go('#/chat/' + ch.id) });
    }
    bus.emit('channels:changed');
  });
  socket.on('channel:deleted', ({ id, by }) => {
    state.channels = state.channels.filter((c) => c.id !== id);
    delete state.unread[id];
    bus.emit('channels:changed');
    bus.emit('unread:changed');
    if (state.current === id) {
      if (by !== state.me.id) toast('This channel was deleted.');
      location.hash = '#/chat/general';
    }
  });

  socket.on('message:new', onMessageNew);
  socket.on('message:update', (m) => {
    if (m.cid.startsWith('dm-')) {
      const d = state.dms.find((x) => x.cid === m.cid);
      if (d && m.deleted) { d.lastText = 'Message deleted'; bus.emit('dms:changed'); }
    }
    bus.emit('message:update', m);
  });
  socket.on('typing', (d) => bus.emit('typing', d));

  socket.on('notification:new', (n) => {
    state.notifications.unshift(n);
    const here = n.link === location.hash; // already looking at what it is about
    if (here) {
      n.read = true;
      api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {});
    }
    bus.emit('notifications:changed');
    if (n.type === 'reminder' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('StudyHub reminder', { body: n.text, tag: n.id }); } catch (_) { /* some browsers need a service worker for this */ }
    }
    // on Home the schedule updates by itself, but new events and reminders deserve a nudge
    if (!here || n.type === 'reminder' || n.type === 'event') toast(n.text, 'info', { onClick: () => go(n.link), duration: n.type === 'reminder' ? 9000 : 4000 });
  });


  socket.on('question:new', (d) => {
    if (d.userId !== state.me.id) toast(`New ${d.subject} question: ${d.title}`, 'info', { onClick: () => go('#/qa/' + d.id) });
  });
  socket.on('calendar:changed', () => bus.emit('calendar:changed'));
  socket.on('courses:changed', () => bus.emit('courses:changed'));
  socket.on('question:changed', (d) => bus.emit('question:changed', d));
  socket.on('questions:changed', () => bus.emit('questions:changed'));
  socket.on('announcements:changed', () => bus.emit('announcements:changed'));
  socket.on('resources:changed', () => bus.emit('resources:changed'));
}
