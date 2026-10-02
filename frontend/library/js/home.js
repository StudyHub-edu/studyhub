import { h, toast, debounce } from './dom.js';
import { store, loadCatalog, bookCard, isReadable, searchable, continueReading } from './catalog.js';
import { ensureLibrarian, isLibrarian, signOutLibrarian, openAddModal } from './librarian.js';

const $ = (id) => document.getElementById(id);
const filters = { q: '', format: 'all', category: '', sort: 'new' };
const FORMATS = [['all', 'All'], ['pdf', 'PDF'], ['epub', 'EPUB'], ['online', 'Online sources']];

/* ---------- rails ---------- */
function fillRail(id, books, render = bookCard) {
  $(id).replaceChildren(...books.map(render));
}

function setupRails() {
  document.querySelectorAll('[data-rail]').forEach((btn) => btn.addEventListener('click', () => {
    const rail = $(btn.dataset.rail);
    rail.scrollBy({ left: Number(btn.dataset.dir) * rail.clientWidth * 0.8, behavior: 'smooth' });
  }));
}

function continueCard({ book, progress }) {
  const card = bookCard(book);
  card.href = 'reader.html?id=' + encodeURIComponent(book.id);
  card.querySelector('.cardText').append(h('p', { class: 'resume' }, `${Math.round(progress.pct * 100)}% read. Resume`));
  return card;
}

function renderRails() {
  const readable = store.books.filter(isReadable);
  const newest = [...readable].sort((a, b) => Date.parse(b.added) - Date.parse(a.added)).slice(0, 14);
  fillRail('newRail', newest);
  $('new').classList.toggle('hidden', !newest.length);

  const popular = readable.filter((b) => (b.reads || 0) > 0).sort((a, b) => b.reads - a.reads).slice(0, 14);
  fillRail('popularRail', popular);
  $('popular').classList.toggle('hidden', !popular.length);

  const resuming = continueReading().slice(0, 14);
  fillRail('continueRail', resuming, continueCard);
  $('continue').classList.toggle('hidden', !resuming.length);
  $('navContinue').classList.toggle('hidden', !resuming.length);
}

function renderHero() {
  const picks = store.books.filter((b) => isReadable(b) && b.cover).sort((a, b) => Date.parse(b.added) - Date.parse(a.added)).slice(0, 3);
  const cls = ['b1', 'b2', 'b3'];
  $('heroShelf').replaceChildren(...picks.map((b, i) => h('div', { class: 'heroBook ' + cls[i] }, h('img', { src: encodeURI(b.cover), alt: '' }))));
  const total = store.books.length;
  const readable = store.books.filter(isReadable).length;
  $('stats').textContent = `${readable} ebooks to read here${total > readable ? ', plus ' + (total - readable) + ' free online sources' : ''}.`;
}

/* ---------- subjects + browse ---------- */
function categoriesWithCounts() {
  const map = new Map();
  for (const b of store.books) map.set(b.category, (map.get(b.category) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderSubjects() {
  const cats = categoriesWithCounts();
  $('subjectsGrid').replaceChildren(...cats.map(([name, n]) =>
    h('button', { type: 'button', onclick: () => { filters.category = name; filters.q = ''; $('search').value = ''; syncControls(); renderGrid(); $('browse').scrollIntoView({ behavior: 'smooth' }); } },
      h('span', null, name), h('small', null, `${n} ${n === 1 ? 'book' : 'books'}`))));
  const sel = $('categorySel');
  sel.replaceChildren(h('option', { value: '' }, 'All subjects'), ...cats.map(([name, n]) => h('option', { value: name }, `${name} (${n})`)));
  sel.value = filters.category;
}

function syncControls() {
  $('categorySel').value = filters.category;
  $('sortSel').value = filters.sort;
  $('formatChips').replaceChildren(...FORMATS.map(([key, label]) =>
    h('button', {
      class: 'chip' + (filters.format === key ? ' active' : ''), type: 'button', 'aria-pressed': String(filters.format === key),
      onclick: () => { filters.format = key; syncControls(); renderGrid(); },
    }, label)));
}

const formatMatches = (b) => filters.format === 'all' || (filters.format === 'online' ? !isReadable(b) : isReadable(b) && b.format === filters.format);

function renderGrid() {
  const q = filters.q.trim().toLowerCase();
  let list = store.books.filter((b) => formatMatches(b) && (!filters.category || b.category === filters.category) && (!q || searchable(b).includes(q)));
  const by = {
    new: (a, b) => Date.parse(b.added) - Date.parse(a.added),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
    read: (a, b) => (b.reads || 0) - (a.reads || 0) || Date.parse(b.added) - Date.parse(a.added),
  };
  list = list.sort(by[filters.sort]);
  $('count').textContent = `${list.length} ${list.length === 1 ? 'book' : 'books'}`;
  $('browseTitle').textContent = q ? `Results for "${filters.q.trim()}"` : filters.category || 'All books';
  if (!list.length) {
    $('grid').replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'No books found'), h('p', null, 'Try a different word, or clear the filters.'),
      h('button', { class: 'btn', type: 'button', onclick: () => { Object.assign(filters, { q: '', format: 'all', category: '' }); $('search').value = ''; syncControls(); renderGrid(); } }, 'Clear filters')));
    return;
  }
  $('grid').replaceChildren(...list.map(bookCard));
}

/* ---------- librarian buttons ---------- */
function syncLibrarianButtons() {
  $('addBtn').classList.toggle('hidden', !store.api);
  $('lockBtn').classList.toggle('hidden', !(store.api && isLibrarian()));
}

async function refresh() {
  await loadCatalog();
  renderAll();
}

function renderAll() {
  renderHero();
  renderRails();
  renderSubjects();
  syncControls();
  renderGrid();
  syncLibrarianButtons();
}

async function start() {
  setupRails();
  try {
    await loadCatalog();
  } catch (err) {
    $('grid').replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'The library could not be loaded'), h('p', null, 'Start it with "npm start" and open the address it shows.')));
    return;
  }
  renderAll();

  $('search').addEventListener('input', debounce(() => {
    filters.q = $('search').value;
    renderGrid();
    // bring the results into view, but do not keep jumping while the person is still typing
    if (filters.q.trim() && $('browse').getBoundingClientRect().top > window.innerHeight * 0.6) $('browse').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 250));
  $('categorySel').addEventListener('change', (e) => { filters.category = e.target.value; renderGrid(); });
  $('sortSel').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  $('addBtn').addEventListener('click', async () => {
    if (!(await ensureLibrarian())) return;
    syncLibrarianButtons();
    openAddModal({ onDone: () => refresh() });
  });
  $('lockBtn').addEventListener('click', () => { signOutLibrarian(); syncLibrarianButtons(); toast('Librarian tools locked'); });
}

start();
