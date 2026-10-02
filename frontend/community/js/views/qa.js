// Questions & answers: ask, answer, vote, pick the best answer, and teacher-verified answers.
import { state, subscribe } from '../state.js';
import { api } from '../api.js';
import { cleanupStudyImages, renderImageGallery, uploadStudyImages } from '../image-uploads.js';
import {
  h, icon, byline, subjectChip, richText, toast, confirmDialog, openModal,
  emptyState, errorState, loadingState, field, selectOf, debounce,
} from '../ui.js?v=3';

const PAGE_SIZE = 15;
// Remembered while the app stays open, so coming back from a question keeps your filters.
const filters = { q: '', subject: '', sort: 'new', filter: 'all' };

const SORTS = [['new', 'Newest'], ['votes', 'Most votes'], ['views', 'Most viewed']];
const TABS = [['all', 'All'], ['unanswered', 'Unanswered'], ['solved', 'Solved'], ['mine', 'My questions']];

/* ------------------------------------------------------------------ */
/* Ask a question                                                      */
/* ------------------------------------------------------------------ */
function openAsk() {
  const title = h('input', { class: 'input', maxlength: '150', placeholder: 'e.g. How do I factor x² + 5x + 6?', autocomplete: 'off' });
  const subject = selectOf(state.subjects, 'General');
  const body = h('textarea', { class: 'input', rows: 7, maxlength: '5000', placeholder: 'Explain what you are stuck on and what you already tried.' });
  const images = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Post question');
  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      let imageUrls = [];
      try {
        imageUrls = await uploadStudyImages(images.files);
        const r = await api('/questions', { method: 'POST', body: { title: title.value, subject: subject.value, body: body.value, images: imageUrls } });
        modal.close();
        toast('Question posted', 'success');
        location.hash = '#/qa/' + r.question.id;
      } catch (ex) {
        err.textContent = ex.message;
        try { await cleanupStudyImages(imageUrls); } catch (cleanupError) { console.error('[StudyHub] Could not clean up question images:', cleanupError.message); }
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Title', title, 'Be specific. A clear title gets answered faster.'),
  field('Subject', subject),
  field('Details', body, 'You can use **bold**, `code` and ```code blocks```.'),
  field('Problem photos', images, 'Optional: up to 10 JPG, PNG, or WebP images, 25 MB each.'),
  err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Ask a question', content: form, wide: true });
}

/* ------------------------------------------------------------------ */
/* Question list                                                       */
/* ------------------------------------------------------------------ */
export function mountQuestions(container) {
  const sub = subscribe();
  let items = [];
  let total = 0;
  let seq = 0;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search questions', 'aria-label': 'Search questions', value: filters.q });
  const subjectSel = selectOf(state.subjects, filters.subject, { includeAll: 'All subjects', onChange: (v) => { filters.subject = v; load(); } });
  subjectSel.setAttribute('aria-label', 'Filter by subject');
  const sortSel = h('select', { class: 'select', 'aria-label': 'Sort questions', onchange: (e) => { filters.sort = e.target.value; load(); } },
    SORTS.map(([value, label]) => h('option', { value }, label)));
  sortSel.value = filters.sort;

  const tabsEl = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Question filter' });
  const countEl = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const listEl = h('div', { class: 'q-list' });
  const moreBtn = h('button', { class: 'btn', type: 'button', onclick: () => load({ append: true }) }, 'Show more questions');
  const moreWrap = h('div', { class: 'more-wrap hidden' }, moreBtn);

  const page = h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, 'Questions'), h('p', null, 'Ask anything about your studies. Classmates and teachers answer.')),
      h('button', { class: 'btn primary', type: 'button', onclick: openAsk }, icon('plus', 16), 'Ask a question')),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search-box' }, icon('search', 16), search),
      subjectSel, sortSel),
    tabsEl, countEl, listEl, moreWrap);
  container.append(page);

  const hasFilters = () => filters.q || filters.subject || filters.filter !== 'all';

  function drawTabs() {
    tabsEl.replaceChildren(...TABS.map(([value, label]) =>
      h('button', {
        class: 'tab' + (filters.filter === value ? ' active' : ''), type: 'button', 'aria-pressed': String(filters.filter === value),
        onclick: () => { filters.filter = value; drawTabs(); load(); },
      }, label)));
  }

  function row(q) {
    const asker = state.users.get(q.userId);
    return h('a', { class: 'q-row' + (q.solved ? ' solved' : ''), href: '#/qa/' + q.id },
      h('div', { class: 'q-stats' },
        h('div', { class: 'stat' }, h('strong', null, q.votes), h('span', null, q.votes === 1 ? 'vote' : 'votes')),
        h('div', { class: 'stat answers' + (q.solved ? ' ok' : q.answerCount ? ' has' : '') }, h('strong', null, q.answerCount), h('span', null, q.answerCount === 1 ? 'answer' : 'answers'))),
      h('div', { class: 'q-main' },
        h('h3', null, q.title),
        h('p', { class: 'q-excerpt' }, q.body.replace(/\s+/g, ' ')),
        h('div', { class: 'q-meta' },
          subjectChip(q.subject),
          q.solved ? h('span', { class: 'tag ok' }, icon('check', 12), 'Solved') : null,
          q.verified ? h('span', { class: 'tag stamp' }, icon('cap', 12), 'Teacher verified') : null,
          byline(asker, 'asked', q.createdAt, { link: false, size: 18 }),
          h('span', { class: 'q-views', title: 'Views' }, icon('eye', 13), q.views))));
  }

  function draw() {
    countEl.textContent = total === 1 ? '1 question' : total + ' questions';
    if (items.length) listEl.replaceChildren(...items.map(row));
    else {
      listEl.replaceChildren(hasFilters()
        ? emptyState('search', 'No matching questions', 'Try different words, or clear the filters.',
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => { Object.assign(filters, { q: '', subject: '', filter: 'all' }); search.value = ''; subjectSel.value = ''; drawTabs(); load(); },
          }, 'Clear filters'))
        : emptyState('help', 'No questions yet', 'Be the first to ask something.',
          h('button', { class: 'btn primary', type: 'button', onclick: openAsk }, 'Ask a question')));
    }
    moreWrap.classList.toggle('hidden', items.length >= total);
  }

  async function load({ append = false, keep = false } = {}) {
    const mine = ++seq;
    if (!append && !keep) listEl.replaceChildren(loadingState('Loading questions...'));
    const params = new URLSearchParams({ sort: filters.sort, filter: filters.filter });
    if (filters.q) params.set('q', filters.q);
    if (filters.subject) params.set('subject', filters.subject);
    params.set('limit', String(keep ? Math.min(50, Math.max(PAGE_SIZE, items.length)) : PAGE_SIZE));
    params.set('offset', append ? String(items.length) : '0');
    if (append) moreBtn.disabled = true;
    try {
      const r = await api('/questions?' + params);
      if (mine !== seq) return;
      items = append ? [...items, ...r.items] : r.items;
      total = r.total;
      draw();
    } catch (err) {
      if (mine !== seq) return;
      if (append || keep) toast(err.message, 'error');
      else listEl.replaceChildren(errorState(err.message, () => load()));
    } finally {
      moreBtn.disabled = false;
    }
  }

  search.addEventListener('input', debounce(() => { filters.q = search.value.trim(); load(); }, 300));
  sub.on('questions:changed', debounce(() => load({ keep: true }), 500));

  drawTabs();
  load();
  return () => sub.off();
}

/* ------------------------------------------------------------------ */
/* One question with its answers                                       */
/* ------------------------------------------------------------------ */
function voteBox({ count, voted, disabled, label, onVote }) {
  return h('div', { class: 'vote-box' },
    h('button', {
      class: 'vote-btn' + (voted ? ' on' : ''), type: 'button', disabled,
      title: disabled ? 'You cannot vote on your own post' : voted ? 'Remove your vote' : 'Vote up',
      'aria-pressed': String(!!voted), 'aria-label': 'Vote up this ' + label, onclick: onVote,
    }, icon('up', 20)),
    h('strong', { 'aria-label': count + (count === 1 ? ' vote' : ' votes') }, count));
}

export function mountQuestion(container, id) {
  const sub = subscribe();
  const me = state.me;
  let question = null;

  const content = h('div', { class: 'q-content' }, loadingState('Loading question...'));

  // The answer form lives outside `content` so a live refresh never erases what you are typing.
  const ta = h('textarea', { class: 'input', rows: 5, maxlength: '5000', 'aria-label': 'Your answer', placeholder: 'Write your answer. Explain the steps, not only the result.' });
  const answerImages = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const postBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Post answer');
  const answerForm = h('form', {
    class: 'answer-form hidden',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      postBtn.disabled = true;
      let imageUrls = [];
      try {
        imageUrls = await uploadStudyImages(answerImages.files);
        const r = await api(`/questions/${id}/answers`, { method: 'POST', body: { body: ta.value, images: imageUrls } });
        ta.value = '';
        answerImages.value = '';
        toast('Answer posted', 'success');
        render(r.question);
      } catch (ex) {
        err.textContent = ex.message;
        try { await cleanupStudyImages(imageUrls); } catch (cleanupError) { console.error('[StudyHub] Could not clean up solution images:', cleanupError.message); }
      } finally {
        postBtn.disabled = false;
      }
    },
  },
  h('h2', null, 'Your answer'), ta, field('Solution photos', answerImages, 'Optional: add up to 10 JPG, PNG, or WebP images, 25 MB each.'), err,
  h('div', { class: 'form-actions' }, h('span', { class: 'hint' }, 'Be kind and explain your thinking.'), postBtn));

  container.append(h('div', { class: 'page narrow' },
    h('a', { class: 'back-link', href: '#/qa' }, icon('arrowLeft', 16), 'All questions'),
    content, answerForm));

  async function act(path) {
    try {
      const r = await api(path, { method: 'POST' });
      render(r.question);
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function deleteQuestion() {
    const ok = await confirmDialog('This deletes the question and all of its answers.', { title: 'Delete question', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api('/questions/' + id, { method: 'DELETE' });
      const attachments = [...(question?.images || []), ...(question?.answers || []).flatMap((answer) => answer.images || [])];
      try { await cleanupStudyImages(attachments); } catch (cleanupError) { console.error('[StudyHub] Could not clean up deleted question images:', cleanupError.message); }
      toast('Question deleted');
      location.hash = '#/qa';
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function deleteAnswer(a) {
    const ok = await confirmDialog('This answer will be removed.', { title: 'Delete answer', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      const r = await api('/answers/' + a.id, { method: 'DELETE' });
      try { await cleanupStudyImages(a.images || []); } catch (cleanupError) { console.error('[StudyHub] Could not clean up deleted solution images:', cleanupError.message); }
      render(r.question);
    } catch (ex) { toast(ex.message, 'error'); }
  }

  function answerEl(a) {
    const author = state.users.get(a.userId);
    const isAsker = question.userId === me.id;
    const verifier = a.verifiedBy ? state.users.get(a.verifiedBy) : null;
    let best = null;
    if (isAsker) {
      best = h('button', {
        class: 'accept-btn' + (a.accepted ? ' on' : ''), type: 'button', 'aria-pressed': String(a.accepted),
        title: a.accepted ? 'Unmark as best answer' : 'Mark as best answer',
        'aria-label': a.accepted ? 'Unmark as best answer' : 'Mark as best answer',
        onclick: () => act('/answers/' + a.id + '/accept'),
      }, icon('check', 20));
    } else if (a.accepted) {
      best = h('span', { class: 'accept-btn on static', title: 'Best answer, chosen by the asker' }, icon('check', 20));
    }
    return h('article', { class: 'answer' + (a.accepted ? ' accepted' : '') + (a.verifiedBy ? ' verified' : '') },
      h('div', { class: 'vote-col' },
        voteBox({ count: a.votes, voted: a.voted, disabled: a.userId === me.id, label: 'answer', onVote: () => act('/answers/' + a.id + '/vote') }),
        best),
      h('div', { class: 'answer-main' },
        a.accepted || a.verifiedBy ? h('div', { class: 'answer-tags' },
          a.accepted ? h('span', { class: 'tag ok' }, icon('check', 12), 'Best answer') : null,
          a.verifiedBy ? h('span', { class: 'tag stamp' }, icon('cap', 12), 'Verified by ' + (verifier ? verifier.name : 'a teacher')) : null) : null,
        h('div', { class: 'q-body' }, richText(a.body)),
        renderImageGallery(a.images, 'Solution image'),
        h('div', { class: 'answer-foot' },
          byline(author, 'answered', a.createdAt),
          h('div', { class: 'foot-actions' },
            me.role === 'teacher' ? h('button', { class: 'btn small', type: 'button', onclick: () => act('/answers/' + a.id + '/verify') },
              icon('cap', 14), a.verifiedBy ? 'Remove verification' : 'Verify answer') : null,
            a.userId === me.id || me.role === 'teacher' ? h('button', { class: 'btn small danger-ghost', type: 'button', onclick: () => deleteAnswer(a) }, icon('trash', 14), 'Delete') : null))));
  }

  function render(q) {
    question = q;
    const asker = state.users.get(q.userId);
    const mine = q.userId === me.id;
    document.title = q.title + ' - StudyHub';
    answerForm.classList.remove('hidden');
    content.replaceChildren(
      h('article', { class: 'q-card' },
        voteBox({ count: q.votes, voted: q.voted, disabled: mine, label: 'question', onVote: () => act('/questions/' + q.id + '/vote') }),
        h('div', { class: 'q-card-main' },
          h('h1', null, q.title),
          h('div', { class: 'q-meta' },
            subjectChip(q.subject),
            q.solved ? h('span', { class: 'tag ok' }, icon('check', 12), 'Solved') : null,
            q.verified ? h('span', { class: 'tag stamp' }, icon('cap', 12), 'Teacher verified') : null,
            byline(asker, 'asked', q.createdAt),
            h('span', { class: 'q-views', title: 'Views' }, icon('eye', 13), q.views + (q.views === 1 ? ' view' : ' views'))),
          h('div', { class: 'q-body' }, richText(q.body)),
          renderImageGallery(q.images, 'Problem image'),
          mine || me.role === 'teacher'
            ? h('div', { class: 'q-actions' }, h('button', { class: 'btn small danger-ghost', type: 'button', onclick: deleteQuestion }, icon('trash', 14), 'Delete question'))
            : null)),
      h('h2', { class: 'answers-title' }, q.answers.length === 1 ? '1 answer' : q.answers.length + ' answers'),
      q.answers.length
        ? h('div', { class: 'answers' }, q.answers.map(answerEl))
        : emptyState('chat', 'No answers yet', mine ? 'Answers from classmates and teachers will show up here.' : 'Know how to solve this? Write the first answer below.'));
  }

  async function load(first) {
    try {
      const r = await api(`/questions/${id}${first ? '' : '?noview=1'}`);
      render(r.question);
    } catch (ex) {
      if (first) content.replaceChildren(errorState(ex.message, () => load(true)));
      else if (ex.status === 404) { toast('This question was deleted.'); location.hash = '#/qa'; }
    }
  }

  sub.on('question:changed', (d) => {
    if (!d || d.id !== id) return;
    if (d.deleted) { toast('This question was deleted.'); location.hash = '#/qa'; return; }
    load(false);
  });

  load(true);
  return () => { sub.off(); document.title = 'StudyHub'; };
}
