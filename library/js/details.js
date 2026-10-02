import { h, toast, fmtSize, fmtDate } from './dom.js';
import { store, loadCatalog, findBook, coverEl, bookCard, isReadable, getProgress } from './catalog.js';
import { ensureLibrarian, isLibrarian, callApi, enrichBook, openEditModal } from './librarian.js';

const root = document.getElementById('details');
const id = new URLSearchParams(location.search).get('id');

function notFound() {
  root.replaceChildren(h('section', { class: 'detail single' }, h('div', null,
    h('h1', null, 'Book not found'), h('p', { class: 'description' }, 'It may have been removed from the library.'),
    h('div', { class: 'actions' }, h('a', { class: 'primary', href: 'index.html' }, 'Back to the library')))));
}

function metaRows(book) {
  const rows = [];
  rows.push(['Format', isReadable(book) ? book.format.toUpperCase() + ' ebook' : 'Online source' + (book.source ? ': ' + book.source : '')]);
  if (book.pages) rows.push(['Pages', String(book.pages)]);
  if (book.size) rows.push(['File size', fmtSize(book.size)]);
  if (book.language) rows.push(['Language', { ne: 'Nepali', en: 'English' }[book.language] || book.language]);
  if (book.added && isReadable(book)) rows.push(['Added', fmtDate(book.added)]);
  if (isReadable(book) && book.reads) rows.push(['Opened', book.reads + (book.reads === 1 ? ' time' : ' times')]);
  return h('dl', { class: 'meta' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

async function importOnline(book, button) {
  button.disabled = true;
  button.textContent = 'Adding...';
  try {
    const added = (await callApi('api/import', {
      method: 'POST',
      json: { url: book.epubUrl, title: book.title, author: book.author, category: book.category, description: `${book.title} by ${book.author}. Public-domain edition from ${book.source}.` },
    })).book;
    await enrichBook(added).catch(() => {});
    await callApi('api/books/' + encodeURIComponent(book.id), { method: 'DELETE' }); // the online link is replaced by the real ebook
    toast('Added to the library', 'success');
    location.href = 'book.html?id=' + encodeURIComponent(added.id);
  } catch (err) {
    toast(err.message, 'error', 6000);
    button.disabled = false;
    button.textContent = 'Add this book to the library';
  }
}

function render(book) {
  document.title = book.title + ' \u00b7 StudyHub Library';
  const progress = isReadable(book) && getProgress(book.id);
  const librarian = store.api && isLibrarian();
  const actions = [];

  if (isReadable(book)) {
    const resume = progress && progress.pct > 0 && progress.pct < 0.99;
    actions.push(h('a', { class: 'primary', href: 'reader.html?id=' + encodeURIComponent(book.id) }, resume ? `Continue reading (${Math.round(progress.pct * 100)}%)` : 'Read book'));
    if (resume) actions.push(h('a', { href: 'reader.html?id=' + encodeURIComponent(book.id) + '&start=1' }, 'Start from the beginning'));
    actions.push(h('a', { href: encodeURI(book.file), download: '' }, 'Download'));
  } else {
    actions.push(h('a', { class: 'primary', href: book.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open source page'));
    if (book.epubUrl) actions.push(h('a', { href: book.epubUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Download EPUB'));
    if (librarian && book.epubUrl) {
      const btn = h('button', { type: 'button', class: 'gold' }, 'Add this book to the library');
      btn.addEventListener('click', () => importOnline(book, btn));
      actions.push(btn);
    }
  }

  const tools = [];
  if (store.api) {
    if (librarian) {
      tools.push(h('button', { type: 'button', onclick: () => openEditModal(book, { onSaved: () => refresh(), onDeleted: () => { location.href = 'index.html'; } }) }, 'Edit details'));
      if (isReadable(book) && (!book.cover || (!book.pages && book.format === 'pdf'))) {
        const btn = h('button', { type: 'button' }, 'Make cover and details from the file');
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'Reading the book...';
          try { await enrichBook(book); toast('Done', 'success'); await refresh(); } catch (err) { toast('Could not read this file: ' + err.message, 'error'); btn.disabled = false; btn.textContent = 'Make cover and details from the file'; }
        });
        tools.push(btn);
      }
    } else {
      tools.push(h('button', { type: 'button', class: 'link', onclick: async () => { if (await ensureLibrarian()) render(findBook(id)); } }, 'Librarian sign in'));
    }
  }

  const same = store.books.filter((b) => b.id !== book.id && (b.author === book.author && book.author !== 'Unknown author')).slice(0, 8);
  const related = same.length ? same : store.books.filter((b) => b.id !== book.id && b.category === book.category).slice(0, 8);

  root.replaceChildren(
    h('section', { class: 'detail' },
      coverEl(book, 'detailCover'),
      h('div', null,
        h('p', { class: 'eyebrow' }, book.category),
        h('h1', null, book.title),
        book.titleNe ? h('p', { class: 'ne big' }, book.titleNe) : null,
        h('p', { class: 'author' }, 'by ', book.author, book.authorNe ? h('span', { class: 'ne' }, '  ' + book.authorNe) : null),
        book.description ? h('p', { class: 'description' }, book.description) : null,
        metaRows(book),
        progress && progress.pct > 0 ? h('div', { class: 'progress-line' }, h('div', { class: 'bar' }, h('i', { style: { width: Math.round(progress.pct * 100) + '%' } })), h('span', null, `${Math.round(progress.pct * 100)}% read`)) : null,
        h('div', { class: 'actions' }, actions),
        tools.length ? h('div', { class: 'tools' }, tools) : null)),
    related.length ? h('section', { class: 'section related' },
      h('div', { class: 'heading' }, h('div', null, h('p', { class: 'eyebrow' }, 'KEEP READING'), h('h2', null, same.length ? 'More by ' + book.author : 'More in ' + book.category))),
      h('div', { class: 'rail' }, related.map(bookCard))) : null);
}

async function refresh() {
  await loadCatalog();
  const book = findBook(id);
  if (!book) notFound(); else render(book);
}

(async () => {
  try { await refresh(); } catch (_) { notFound(); }
})();
