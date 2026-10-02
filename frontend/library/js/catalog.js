// The catalogue, covers, book cards and reading progress (kept in this browser).
import { h } from './dom.js';

export const store = { books: [], api: false, maxMb: 200 };

export async function loadCatalog() {
  try {
    const res = await fetch('api/books', { cache: 'no-store' });
    if (!res.ok) throw new Error('no api');
    const data = await res.json();
    store.books = data.books;
    store.api = true;
    store.maxMb = data.maxMb || 200;
  } catch (_) {
    // opened as plain files: read-only catalogue
    store.books = await fetch('data.json', { cache: 'no-store' }).then((r) => r.json());
    store.api = false;
  }
  return store.books;
}

export const findBook = (id) => store.books.find((b) => b.id === id);
export const isReadable = (b) => b.kind === 'uploaded' && !!b.file;
export const formatLabel = (b) => (isReadable(b) ? b.format.toUpperCase() : 'ONLINE');

const PALETTE = ['#293f56', '#6d4e40', '#435849', '#8d693d', '#30343a', '#664957', '#3f5b66', '#705a3c', '#3d4b58', '#594f69'];
const hash = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0);

/** A real cover image when there is one, otherwise a designed cover with the title. */
export function coverEl(book, className = 'cover') {
  const designed = () => h('div', { class: className + ' designed', style: { background: PALETTE[hash(book.title) % PALETTE.length] } },
    h('div', { class: 'coverTitle' }, book.title), h('div', { class: 'coverMeta' }, (book.category || '').toUpperCase()));
  if (!book.cover) return designed();
  const wrap = h('div', { class: className + ' photo' });
  const img = h('img', { src: encodeURI(book.cover), alt: 'Cover of ' + book.title, loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => wrap.replaceWith(designed()));
  wrap.append(img);
  return wrap;
}

export function bookCard(book) {
  const p = getProgress(book.id);
  return h('a', { class: 'card', href: 'book.html?id=' + encodeURIComponent(book.id), title: book.title },
    coverEl(book),
    h('span', { class: 'badge fmt-' + formatLabel(book).toLowerCase() }, formatLabel(book)),
    p && p.pct > 0 && p.pct < 0.99 ? h('span', { class: 'progressBar', title: Math.round(p.pct * 100) + '% read' }, h('i', { style: { width: Math.round(p.pct * 100) + '%' } })) : null,
    h('div', { class: 'cardText' },
      h('h3', null, book.title),
      book.titleNe ? h('p', { class: 'ne' }, book.titleNe) : null,
      h('p', null, book.author)));
}

export const searchable = (b) => [b.title, b.titleNe, b.author, b.authorNe, b.category, b.description].join(' ').toLowerCase();

/* ---------- reading progress and bookmarks (private to this browser) ---------- */
const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage full or blocked */ } };

export const getProgress = (id) => read('shl:progress:' + id);
export const setProgress = (id, data) => write('shl:progress:' + id, { ...data, ts: Date.now() });
export const getBookmarks = (id) => read('shl:bookmarks:' + id) || [];
export const setBookmarks = (id, list) => write('shl:bookmarks:' + id, list);

export function continueReading() {
  const out = [];
  for (const b of store.books) {
    const p = isReadable(b) && getProgress(b.id);
    if (p && p.pct > 0 && p.pct < 0.99) out.push({ book: b, progress: p });
  }
  return out.sort((a, b) => b.progress.ts - a.progress.ts);
}
