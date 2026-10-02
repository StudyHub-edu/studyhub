// Small UI toolkit shared by every screen.
// Everything is built with DOM nodes (never innerHTML with user text), so user content can't inject HTML.
import { state } from './state.js';

/* ------------------------------------------------------------------ */
/* DOM builder:  h('div', { class: 'card', onclick: fn }, child, child) */
/* ------------------------------------------------------------------ */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const debounce = (fn, ms = 300) => {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
};

/* ------------------------------------------------------------------ */
/* Icons (inline SVG, so the app works without any icon library)       */
/* ------------------------------------------------------------------ */
const ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  up: '<polyline points="18 15 12 9 6 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  mapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};

export function icon(name, size = 18) {
  const wrap = document.createElement('span');
  wrap.className = 'icon';
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return wrap;
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */
export const initials = (name = '?') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] || '').join('').toUpperCase() || '?';

export function avatar(user, size = 36) {
  const u = user || { name: '?', color: '#64748b' };
  const fallback = h('span', {
    class: 'avatar',
    style: { width: size + 'px', height: size + 'px', background: u.color, fontSize: Math.max(10, Math.round(size * 0.4)) + 'px' },
    'aria-hidden': 'true',
  }, initials(u.name));
  if (u.avatarUrl) {
    const image = h('img', {
      src: u.avatarUrl,
      alt: '',
      onerror: () => image.remove(),
    });
    fallback.append(image);
  }
  return fallback;
}

/** Avatar with a small green dot when the person is online. */
export function avatarStatus(user, size = 36) {
  const dot = h('span', { class: 'status-dot' });
  const wrap = h('span', { class: 'avatar-wrap', style: { width: size + 'px', height: size + 'px' } }, avatar(user, size), dot);
  if (user && state.online.has(user.id)) wrap.classList.add('online');
  return wrap;
}

export function roleBadge(user) {
  if (!user || !['teacher', 'admin'].includes(user.role)) return null;
  const label = user.role === 'admin' ? 'Admin' : 'Teacher';
  return h('span', { class: 'badge ' + user.role, title: label }, icon('cap', 12), label);
}

export const userName = (id) => (state.users.get(id) ? state.users.get(id).name : 'Someone');

export function nameLink(user, className = 'name-link') {
  if (!user) return h('span', { class: className }, 'Someone');
  return h('a', { class: className, href: '#/user/' + user.id }, user.name);
}

export function subjectChip(subject) {
  return h('span', { class: 'chip', dataset: { subject } }, subject);
}

/** "(avatar) Name [Teacher] asked 2 h ago" line used on questions, answers and announcements. */
export function byline(user, verb, ts, { link = true, size = 20 } = {}) {
  return h('span', { class: 'byline' },
    avatar(user, size),
    link ? nameLink(user) : h('span', { class: 'name-link' }, user ? user.name : 'Someone'),
    roleBadge(user),
    h('span', { class: 'byline-time' }, verb + ' ' + timeAgo(ts)));
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return Math.max(1, minutes) + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + ' d ago';
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

/* ------------------------------------------------------------------ */
/* Rich text: links, **bold**, `code`, ```code blocks``` and @mentions */
/* ------------------------------------------------------------------ */
export function richText(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/```([\s\S]*?)```/).forEach((part, i) => {
    if (i % 2 === 1) frag.append(h('pre', { class: 'code-block' }, h('code', null, part.replace(/^\n/, '').replace(/\n$/, ''))));
    else inline(frag, part);
  });
  return frag;
}

function inline(parent, text) {
  const re = /(https?:\/\/[^\s<>]+)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w])@([a-z0-9_]{3,20})/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      let url = m[1];
      let trail = '';
      const t = url.match(/[.,;:!?)\]]+$/);
      if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
      parent.append(h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
      if (trail) parent.append(document.createTextNode(trail));
    } else if (m[2]) {
      parent.append(h('code', { class: 'inline-code' }, m[2]));
    } else if (m[3]) {
      parent.append(h('strong', null, m[3]));
    } else if (m[4]) {
      const isMe = state.me && m[4].toLowerCase() === state.me.username;
      parent.append(h('span', { class: 'mention' + (isMe ? ' me' : '') }, '@' + m[4]));
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

/* ------------------------------------------------------------------ */
/* Feedback: toast, modal, confirm, popover                            */
/* ------------------------------------------------------------------ */
export function toast(message, type = 'info', { onClick, duration = 4000 } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;
  let timer;
  const remove = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h('div', {
    class: 'toast ' + type,
    role: type === 'error' ? 'alert' : 'status',
    onclick: () => { if (onClick) onClick(); remove(); },
  }, message);
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  timer = setTimeout(remove, duration);
}

const modalStack = [];

export function openModal({ title, content, wide = false, onClose }) {
  const opener = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalStack.splice(modalStack.indexOf(close), 1);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    if (onClose) onClose();
  };
  // Escape only closes the top-most dialog when several are open
  const onKey = (e) => { if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) close(); };
  modalStack.push(close);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, content)));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = overlay.querySelector('input:not([type=hidden]), textarea, select');
  if (first) first.focus();
  return { close, el: overlay };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => { if (!answered) { answered = true; resolve(value); } };
    const modal = openModal({
      title,
      onClose: () => finish(false),
      content: h('div', null,
        h('p', { class: 'confirm-text' }, message),
        h('div', { class: 'form-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => { finish(true); modal.close(); } }, confirmText))),
    });
  });
}

let activePopover = null;

export function closePopover() {
  if (activePopover) {
    activePopover.cleanup();
    activePopover = null;
  }
}

/** Shows floating content next to an element. Clicking the same anchor again closes it (returns null). */
export function showPopover(anchor, content, { align = 'start', className = '', side } = {}) {
  if (activePopover && activePopover.anchor === anchor) { closePopover(); return null; }
  closePopover();
  const pop = h('div', { class: 'popover ' + className }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left;
  let top;
  if (side === 'right') {
    left = r.right + 8;
    top = r.bottom - ph;
  } else {
    left = align === 'end' ? r.right - pw : r.left;
    top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  document.addEventListener('mousedown', onDown);
  document.addEventListener('keydown', onKey);
  activePopover = {
    anchor,
    cleanup() {
      pop.remove();
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    },
  };
  return pop;
}

/* ------------------------------------------------------------------ */
/* Empty / loading / error states                                      */
/* ------------------------------------------------------------------ */
export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 26)),
    h('h3', null, title),
    text ? h('p', null, text) : null,
    action || null);
}

export const loadingState = (text = 'Loading...') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), text);

export function errorState(message, retry) {
  return h('div', { class: 'empty error' },
    h('h3', null, 'Could not load this'),
    h('p', null, message),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again') : null);
}

/** Reusable form field: label + control (+ optional hint). */
export function field(label, control, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  control.id = id;
  return h('div', { class: 'field' },
    h('label', { htmlFor: id }, label),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

export function selectOf(options, value, { onChange, includeAll } = {}) {
  const select = h('select', { class: 'select', onchange: onChange ? (e) => onChange(e.target.value) : null });
  if (includeAll) select.append(h('option', { value: '' }, includeAll));
  for (const o of options) select.append(h('option', { value: o }, o));
  select.value = value || '';
  return select;
}
