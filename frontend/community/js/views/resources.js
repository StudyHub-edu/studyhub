// Resources: share useful links and study notes.
import { state, subscribe } from '../state.js';
import { api } from '../api.js';
import { cleanupStudyImages, renderImageGallery, uploadStudyImages } from '../image-uploads.js';
import {
  h, icon, byline, subjectChip, toast, confirmDialog, openModal,
  emptyState, errorState, loadingState, field, selectOf, debounce,
} from '../ui.js?v=3';

const filters = { q: '', subject: '' };

function openShare() {
  const title = h('input', { class: 'input', maxlength: '100', placeholder: 'e.g. Khan Academy: Quadratic equations', autocomplete: 'off' });
  const url = h('input', { class: 'input', maxlength: '500', placeholder: 'https://example.com  (optional)', autocomplete: 'off', inputMode: 'url' });
  const subject = selectOf(state.subjects, 'General');
  const desc = h('textarea', { class: 'input', rows: 4, maxlength: '500', placeholder: 'Why is this useful? Or write a short study tip instead of a link.' });
  const images = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Share');
  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      let imageUrls = [];
      try {
        imageUrls = await uploadStudyImages(images.files);
        await api('/resources', { method: 'POST', body: { title: title.value, url: url.value, subject: subject.value, description: desc.value, images: imageUrls } });
        modal.close();
        toast('Resource shared', 'success');
      } catch (ex) {
        err.textContent = ex.message;
        try { await cleanupStudyImages(imageUrls); } catch (cleanupError) { console.error('[StudyHub] Could not clean up resource images:', cleanupError.message); }
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Title', title),
  field('Link', url, 'Leave empty to share a note.'),
  field('Subject', subject),
  field('Description', desc),
  field('Photos', images, 'Optional: add up to 10 JPG, PNG, or WebP images, 25 MB each.'),
  err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Share a resource', content: form });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

export function mountResources(container) {
  const sub = subscribe();
  let seq = 0;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search resources', 'aria-label': 'Search resources', value: filters.q });
  const subjectSel = selectOf(state.subjects, filters.subject, { includeAll: 'All subjects', onChange: (v) => { filters.subject = v; load(); } });
  subjectSel.setAttribute('aria-label', 'Filter by subject');
  const grid = h('div', { class: 'res-grid' }, loadingState());

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, 'Resources'), h('p', null, 'Links and notes that helped someone learn.')),
      h('button', { class: 'btn primary', type: 'button', onclick: openShare }, icon('plus', 16), 'Share a resource')),
    h('div', { class: 'toolbar' }, h('label', { class: 'search-box' }, icon('search', 16), search), subjectSel),
    grid));

  async function like(r) {
    try { await api(`/resources/${r.id}/like`, { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
  }

  async function remove(r) {
    const ok = await confirmDialog('This resource will be removed for everyone.', { title: 'Delete resource', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api('/resources/' + r.id, { method: 'DELETE' });
      try { await cleanupStudyImages(r.images || []); } catch (cleanupError) { console.error('[StudyHub] Could not clean up deleted resource images:', cleanupError.message); }
    } catch (err) { toast(err.message, 'error'); }
  }

  function card(r) {
    const author = state.users.get(r.userId);
    return h('article', { class: 'resource' },
      h('div', { class: 'res-top' },
        subjectChip(r.subject),
        h('span', { class: 'res-domain' }, r.url ? [icon('link', 12), hostOf(r.url)] : 'Study note')),
      h('h3', null, r.url
        ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, r.title, icon('external', 14))
        : r.title),
      r.description ? h('p', { class: 'res-desc' }, r.description) : null,
      renderImageGallery(r.images, 'Resource image'),
      h('div', { class: 'res-foot' },
        byline(author, 'shared', r.createdAt, { size: 18 }),
        h('div', { class: 'foot-actions' },
          h('button', {
            class: 'btn small like-btn' + (r.liked ? ' on' : ''), type: 'button', 'aria-pressed': String(r.liked),
            title: r.liked ? 'Remove your like' : 'Like this resource', onclick: () => like(r),
          }, icon('heart', 14), r.likes),
          r.userId === state.me.id || state.me.role === 'teacher'
            ? h('button', { class: 'icon-btn small', type: 'button', title: 'Delete', 'aria-label': 'Delete resource', onclick: () => remove(r) }, icon('trash', 15))
            : null)));
  }

  async function load() {
    const mine = ++seq;
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.subject) params.set('subject', filters.subject);
    try {
      const r = await api('/resources?' + params);
      if (mine !== seq) return;
      const filtered = filters.q || filters.subject;
      grid.replaceChildren(...(r.items.length
        ? r.items.map(card)
        : [emptyState('book', filtered ? 'Nothing matches' : 'No resources yet',
          filtered ? 'Try a different search.' : 'Share the first link or study tip.',
          filtered ? null : h('button', { class: 'btn primary', type: 'button', onclick: openShare }, 'Share a resource'))]));
    } catch (err) {
      if (mine === seq) grid.replaceChildren(errorState(err.message, load));
    }
  }

  search.addEventListener('input', debounce(() => { filters.q = search.value.trim(); load(); }, 300));
  sub.on('resources:changed', load);
  load();
  return () => sub.off();
}
