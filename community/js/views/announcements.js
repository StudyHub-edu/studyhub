// Announcements: teachers post and pin, everyone reads.
import { state, subscribe } from '../state.js';
import { api } from '../api.js';
import { h, icon, byline, richText, toast, confirmDialog, openModal, emptyState, errorState, loadingState, field } from '../ui.js?v=3';

function openNewAnnouncement() {
  const title = h('input', { class: 'input', maxlength: '120', placeholder: 'e.g. Maths test on Friday', autocomplete: 'off' });
  const body = h('textarea', { class: 'input', rows: 6, maxlength: '3000', placeholder: 'Write the details students need to know.' });
  const pinned = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Post announcement');
  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await api('/announcements', { method: 'POST', body: { title: title.value, body: body.value, pinned: pinned.checked } });
        modal.close();
        toast('Announcement posted. Everyone has been notified.', 'success');
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Title', title),
  field('Message', body),
  h('label', { class: 'check' }, pinned, 'Pin to the top'),
  err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'New announcement', content: form, wide: true });
}

export function mountAnnouncements(container) {
  const sub = subscribe();
  const isTeacher = state.me.role === 'teacher';
  const listEl = h('div', { class: 'announce-list' }, loadingState());

  container.append(h('div', { class: 'page narrow' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, 'Announcements'), h('p', null, 'News from your teachers.')),
      isTeacher ? h('button', { class: 'btn primary', type: 'button', onclick: openNewAnnouncement }, icon('plus', 16), 'New announcement') : null),
    listEl));

  async function act(fn) {
    try { await fn(); } catch (err) { toast(err.message, 'error'); }
  }

  function card(a) {
    const author = state.users.get(a.userId);
    return h('article', { class: 'announce' + (a.pinned ? ' pinned' : '') },
      a.pinned ? h('span', { class: 'tag pin' }, icon('pin', 12), 'Pinned') : null,
      h('h2', null, a.title),
      h('div', { class: 'q-body' }, richText(a.body)),
      h('div', { class: 'announce-foot' },
        byline(author, 'posted', a.createdAt),
        isTeacher ? h('div', { class: 'foot-actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => act(() => api(`/announcements/${a.id}/pin`, { method: 'POST' })) },
            icon('pin', 14), a.pinned ? 'Unpin' : 'Pin'),
          h('button', {
            class: 'btn small danger-ghost', type: 'button',
            onclick: async () => {
              const ok = await confirmDialog('This announcement will be removed for everyone.', { title: 'Delete announcement', confirmText: 'Delete', danger: true });
              if (ok) act(() => api('/announcements/' + a.id, { method: 'DELETE' }));
            },
          }, icon('trash', 14), 'Delete')) : null));
  }

  async function load() {
    try {
      const r = await api('/announcements');
      listEl.replaceChildren(...(r.items.length
        ? r.items.map(card)
        : [emptyState('megaphone', 'No announcements yet', isTeacher ? 'Post the first one for your class.' : 'When a teacher posts news, it appears here.')]));
    } catch (err) {
      listEl.replaceChildren(errorState(err.message, load));
    }
  }

  sub.on('announcements:changed', load);
  load();
  return () => sub.off();
}
