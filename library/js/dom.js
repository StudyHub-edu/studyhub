// Tiny DOM helpers shared by every page. User text is always added as text nodes, never as HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el) {
        try { el[key] = value; } catch (_) { el.setAttribute(key, value === true ? '' : value); } // read-only properties such as input.list
      } else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const debounce = (fn, ms = 200) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export function toast(message, type = 'info', ms = 3800) {
  let root = document.getElementById('toasts');
  if (!root) { root = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(root); }
  const el = h('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' }, message);
  root.append(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, ms);
}

const stack = [];
export function openModal({ title, content, wide = false, onClose }) {
  let closed = false;
  const opener = document.activeElement;
  const close = () => {
    if (closed) return;
    closed = true;
    stack.splice(stack.indexOf(close), 1);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === close) close(); };
  stack.push(close);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '\u00d7')),
      h('div', { class: 'modal-body' }, content)));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = overlay.querySelector('input:not([type=hidden]):not([type=file]), textarea, select');
  if (first) first.focus();
  return { close, el: overlay };
}

export function confirmBox(message, { title = 'Are you sure?', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (v) => { if (!answered) { answered = true; resolve(v); } };
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

export function field(label, control, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  control.id = id;
  return h('div', { class: 'field' }, h('label', { htmlFor: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

export const fmtSize = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');
export const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); };
