// The reader: real PDF pages (PDF.js) with a page-turn animation, and flowing EPUB text (epub.js).
import { h, toast } from './dom.js';
import { store, loadCatalog, findBook, isReadable, getProgress, setProgress, getBookmarks, setBookmarks } from './catalog.js';
import { pdfjs, epubjs, PDF_OPTIONS } from './engines.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const slider = $('slider');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let engine = null;           // whatever is open right now: { next, prev, ... }
let progressKey = '';
let panelTab = 'toc';

/* ------------------------------------------------------------------ */
/* Icons, themes, messages                                             */
/* ------------------------------------------------------------------ */
const ICONS = {
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}
const tool = (label, content, onclick, extra = {}) => h('button', { class: 'tool', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, content);

const THEMES = ['paper', 'sepia', 'night'];
let theme = localStorage.getItem('shl:theme');
if (!THEMES.includes(theme)) theme = 'paper';
function applyTheme() { document.body.dataset.theme = theme; localStorage.setItem('shl:theme', theme); if (engine && engine.onTheme) engine.onTheme(theme); }
function cycleTheme() { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme(); toast('Theme: ' + theme, 'info', 1200); }
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

function showMessage(title, text, ...actions) {
  stage.replaceChildren(h('div', { class: 'rd-message' }, h('h2', null, title), text ? h('p', null, text) : null, actions.length ? h('div', { class: 'actions' }, actions) : null));
}
const showLoading = (text) => stage.replaceChildren(h('div', { class: 'rd-message' }, h('span', { class: 'spinner' }), h('p', { id: 'loadingText' }, text)));

/* ------------------------------------------------------------------ */
/* Side panel: contents + bookmarks                                    */
/* ------------------------------------------------------------------ */
function drawPanel() {
  document.querySelectorAll('#panel [data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === panelTab));
  const body = $('panelBody');
  if (!engine) { body.replaceChildren(); return; }
  if (panelTab === 'toc') {
    body.replaceChildren(h('p', { class: 'muted pad' }, 'Loading...'));
    engine.toc().then((items) => {
      if (panelTab !== 'toc') return;
      body.replaceChildren(items.length
        ? h('ul', { class: 'toc' }, items.map((it) => h('li', { style: { paddingLeft: 12 + it.depth * 14 + 'px' } },
          h('button', { type: 'button', onclick: () => { it.go(); closePanelOnSmall(); } }, it.label))))
        : h('p', { class: 'muted pad' }, 'This book has no table of contents. Use the slider at the bottom to move around, or bookmark the pages you want to find again.'));
    });
  } else {
    const marks = getBookmarks(progressKey).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    body.replaceChildren(marks.length
      ? h('ul', { class: 'marks' }, marks.map((m) => h('li', null,
        h('button', { type: 'button', class: 'mark-go', onclick: () => { engine.gotoBookmark(m); closePanelOnSmall(); } }, h('strong', null, m.label), m.sub ? h('small', null, m.sub) : null),
        h('button', { type: 'button', class: 'mark-del', title: 'Remove bookmark', 'aria-label': 'Remove bookmark', onclick: () => { setBookmarks(progressKey, getBookmarks(progressKey).filter((x) => x.id !== m.id)); drawPanel(); if (engine.refreshBookmark) engine.refreshBookmark(); } }, '\u00d7'))))
      : h('p', { class: 'muted pad' }, 'No bookmarks yet. Press the bookmark button (or B) to save your place.'));
  }
}
function togglePanel(force) {
  const panel = $('panel');
  const show = force === undefined ? panel.classList.contains('hidden') : force;
  panel.classList.toggle('hidden', !show);
  if (show) drawPanel();
  if (engine && engine.resize) setTimeout(engine.resize, 60);
}
const closePanelOnSmall = () => { if (window.matchMedia('(max-width: 800px)').matches) togglePanel(false); };
document.querySelectorAll('#panel [data-tab]').forEach((t) => t.addEventListener('click', () => { panelTab = t.dataset.tab; drawPanel(); }));

function toggleBookmark(entry) {
  const list = getBookmarks(progressKey);
  const i = list.findIndex((m) => m.id === entry.id);
  if (i >= 0) { list.splice(i, 1); toast('Bookmark removed', 'info', 1400); }
  else { list.push({ ...entry, ts: Date.now() }); toast('Bookmarked. Find it in the panel on the left.', 'success', 2000); }
  setBookmarks(progressKey, list);
  if (!$('panel').classList.contains('hidden')) drawPanel();
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */
async function openPdf(source) {
  const lib = await pdfjs();
  const task = lib.getDocument(typeof source === 'string' ? { url: source, ...PDF_OPTIONS } : { data: source, ...PDF_OPTIONS });
  task.onProgress = ({ loaded, total }) => {
    const t = document.getElementById('loadingText');
    if (t && total) t.textContent = `Opening the book... ${Math.round((loaded / total) * 100)}%`;
  };
  const pdf = await task.promise;
  const total = pdf.numPages;

  stage.classList.remove('epub');
  const pageEl = h('div', { class: 'page pdf' });
  const scroller = h('div', { class: 'pdf-scroll' }, h('div', { class: 'book3d' }, pageEl));
  stage.replaceChildren(scroller);

  let zoom = 1;
  let current = 0;
  let target = 0;
  let token = 0;
  const cache = new Map();
  let saveTimer = null;

  const fitScale = (viewport) => Math.min((scroller.clientWidth - 32) / viewport.width, (scroller.clientHeight - 32) / viewport.height);

  async function renderCanvas(n) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(0.1, fitScale(base)) * zoom;
    const dpr = window.devicePixelRatio || 1;
    const key = `${n}@${scale.toFixed(3)}@${dpr}`;
    if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    cache.set(key, canvas);
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return canvas;
  }

  function updateUi() {
    $('counter').textContent = `Page ${current} / ${total}`;
    slider.max = String(total);
    slider.value = String(current);
    slider.disabled = total < 2;
    $('prev').disabled = current <= 1;
    $('next').disabled = current >= total;
    markBtn.classList.toggle('on', getBookmarks(progressKey).some((m) => m.id === 'p' + current));
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (current > 1 || getProgress(progressKey)) setProgress(progressKey, { page: current, total, pct: current / total }); }, 300);
  }

  async function show(n, dir = 0, force = false) {
    n = clamp(n, 1, total);
    target = n;
    if (n === current && !force) return;
    const mine = ++token;
    let canvas;
    try { canvas = await renderCanvas(n); } catch (err) { if (mine === token) toast('Could not draw page ' + n, 'error'); return; }
    if (mine !== token) return;
    if (dir !== 0 && zoom === 1 && !reduceMotion) {
      pageEl.classList.remove('flipNext', 'flipPrev');
      void pageEl.offsetWidth;
      pageEl.classList.add(dir > 0 ? 'flipNext' : 'flipPrev');
      await sleep(230);
      if (mine !== token) return;
    }
    pageEl.replaceChildren(canvas);
    scroller.scrollTop = 0;
    current = n;
    updateUi();
    saveSoon();
    if (n < total) renderCanvas(n + 1).catch(() => {});
    if (n > 1) renderCanvas(n - 1).catch(() => {});
  }

  const setZoom = (z) => { zoom = clamp(Math.round(z * 100) / 100, 0.5, 3); cache.clear(); toast(zoom === 1 ? 'Fit to screen' : `Zoom ${Math.round(zoom * 100)}%`, 'info', 900); show(current, 0, true); };

  // toolbar
  const markBtn = tool('Bookmark this page (B)', icon('bookmark'), () => { toggleBookmark({ id: 'p' + current, page: current, label: 'Page ' + current, sub: '', sort: current }); updateUi(); });
  $('tools').replaceChildren(
    tool('Contents and bookmarks', icon('menu'), () => togglePanel()),
    markBtn,
    tool('Zoom out (-)', icon('minus'), () => setZoom(zoom - 0.25)),
    tool('Fit to screen (0)', icon('fit'), () => setZoom(1)),
    tool('Zoom in (+)', icon('plus'), () => setZoom(zoom + 0.25)),
    tool('Change theme', icon('theme'), cycleTheme),
    tool('Full screen (F)', icon('full'), toggleFullscreen));

  // swipe to turn
  let touch = null;
  scroller.addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  scroller.addEventListener('touchend', (e) => {
    if (!touch || zoom !== 1) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > 55 && Math.abs(dy) < 60) show(target + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    touch = null;
  }, { passive: true });

  async function outline() {
    const out = await pdf.getOutline().catch(() => null);
    const flat = [];
    const walk = async (items, depth) => {
      for (const it of items) {
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest)) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
        } catch (_) { /* leave page null */ }
        if (page) flat.push({ label: it.title, depth, go: () => show(page, 0) });
        if (it.items && it.items.length) await walk(it.items, depth + 1);
      }
    };
    if (out) await walk(out, 0);
    return flat;
  }

  const startPage = params.get('start') ? 1 : (getProgress(progressKey) || {}).page || 1;
  engine = {
    kind: 'pdf',
    next: () => show(target + 1, 1),
    prev: () => show(target - 1, -1),
    first: () => show(1, -1),
    last: () => show(total, 1),
    goto: (n) => show(n, n > current ? 1 : -1),
    toc: outline,
    gotoBookmark: (m) => show(m.page, 0),
    bookmark: () => markBtn.click(),
    refreshBookmark: updateUi,
    zoomIn: () => setZoom(zoom + 0.25),
    zoomOut: () => setZoom(zoom - 0.25),
    zoomFit: () => setZoom(1),
    onSlider: (v) => show(Number(v), Number(v) > current ? 1 : -1),
    onSliderInput: (v) => { $('counter').textContent = `Page ${v} / ${total}`; },
    resize: () => { cache.clear(); show(current, 0, true); },
    onTheme: () => {},
  };
  await show(startPage, 0, true);
  if (startPage > 1) toast(`Continuing from page ${startPage}`, 'info', 2400);
}

/* ------------------------------------------------------------------ */
/* EPUB                                                                */
/* ------------------------------------------------------------------ */
const EPUB_THEMES = {
  paper: { body: { background: '#fbf6e9 !important', color: '#302b24 !important' }, a: { color: '#8a5a00 !important' } },
  sepia: { body: { background: '#f1e4c6 !important', color: '#4a3b26 !important' }, a: { color: '#7a4b00 !important' } },
  night: { body: { background: '#15130f !important', color: '#d9d2c3 !important' }, a: { color: '#e0b463 !important' } },
};

/**
 * Some ebooks (this is common in Gutenberg's EPUB output) start their spine with an image-only
 * "cover" page: no text, just an SVG wrapping the cover picture. Opening straight onto a blank page
 * looks broken, so when we are not resuming a saved position, step past any such pages once so the
 * reader lands on the first page that actually has something to read.
 */
async function skipBlankOpeningPages(rendition) {
  for (let i = 0; i < 3; i += 1) {
    await sleep(120);
    const iframe = rendition.manager && rendition.manager.views && rendition.manager.views.first
      ? rendition.manager.views.first().iframe : null;
    const text = iframe && iframe.contentDocument ? (iframe.contentDocument.body.innerText || '').trim() : null;
    if (text === null || text.length > 25 || !rendition.location || rendition.location.atEnd) return;
    await rendition.next();
  }
}

async function openEpub(source) {
  const ePub = await epubjs();
  const book = ePub(source);
  const host = h('div', { class: 'epub-host' });
  stage.replaceChildren(host);
  stage.classList.add('epub');

  const rendition = book.renderTo(host, { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false });
  for (const [name, rules] of Object.entries(EPUB_THEMES)) rendition.themes.register(name, rules);
  rendition.themes.select(theme);
  let fontSize = clamp(Number(localStorage.getItem('shl:epubFont')) || 100, 70, 220);
  rendition.themes.fontSize(fontSize + '%');

  let cfi = '';
  let pct = 0;
  let ready = false;
  let chapter = '';
  let tocItems = [];
  let saveTimer = null;

  function updateUi() {
    $('counter').textContent = (chapter ? chapter + '  ' : '') + Math.round(pct * 100) + '%';
    if (ready) { slider.disabled = false; slider.value = String(Math.round(pct * 1000)); }
    markBtn.classList.toggle('on', getBookmarks(progressKey).some((m) => m.id === cfi));
  }
  slider.min = '0';
  slider.max = '1000';
  slider.value = '0';

  rendition.on('relocated', (loc) => {
    cfi = loc.start.cfi;
    if (ready) pct = book.locations.percentageFromCfi(cfi);
    const href = (loc.start.href || '').split('#')[0];
    const item = tocItems.find((t) => t.href.split('#')[0] === href);
    if (item) chapter = item.label.trim();
    $('prev').disabled = !!loc.atStart;
    $('next').disabled = !!loc.atEnd;
    updateUi();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => setProgress(progressKey, { cfi, pct: ready ? pct : (getProgress(progressKey) || {}).pct || 0 }), 400);
  });
  const key = (e) => handleKey(e);
  rendition.on('keyup', key);
  let touch = null;
  rendition.on('touchstart', (e) => { touch = e.changedTouches && e.changedTouches.length === 1 ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : null; });
  rendition.on('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > 55 && Math.abs(dy) < 60) (dx < 0 ? rendition.next() : rendition.prev());
    touch = null;
  });

  const setFont = (delta) => {
    fontSize = clamp(fontSize + delta, 70, 220);
    localStorage.setItem('shl:epubFont', String(fontSize));
    rendition.themes.fontSize(fontSize + '%');
    toast(`Text size ${fontSize}%`, 'info', 900);
  };
  const markBtn = tool('Bookmark this place (B)', icon('bookmark'), () => {
    if (!cfi) return;
    toggleBookmark({ id: cfi, cfi, label: chapter || 'Bookmark', sub: Math.round(pct * 100) + '% through the book', sort: pct });
    updateUi();
  });
  $('tools').replaceChildren(
    tool('Contents and bookmarks', icon('menu'), () => togglePanel()),
    markBtn,
    tool('Smaller text (-)', 'A\u2212', () => setFont(-10), { class: 'tool text' }),
    tool('Bigger text (+)', 'A+', () => setFont(10), { class: 'tool text' }),
    tool('Change theme', icon('theme'), cycleTheme),
    tool('Full screen (F)', icon('full'), toggleFullscreen));

  book.loaded.navigation.then((nav) => {
    const flat = [];
    const walk = (items, depth) => items.forEach((it) => { flat.push({ label: it.label, href: it.href, depth }); if (it.subitems) walk(it.subitems, depth + 1); });
    walk(nav.toc, 0);
    tocItems = flat;
  }).catch(() => {});

  const saved = params.get('start') ? null : getProgress(progressKey);
  await rendition.display(saved && saved.cfi ? saved.cfi : undefined).catch(() => rendition.display());
  if (saved && saved.cfi) toast(`Continuing where you stopped (${Math.round((saved.pct || 0) * 100)}%)`, 'info', 2400);
  else await skipBlankOpeningPages(rendition);

  book.ready.then(() => book.locations.generate(1024)).then(() => {
    ready = true;
    if (cfi) pct = book.locations.percentageFromCfi(cfi);
    updateUi();
    if (cfi) setProgress(progressKey, { cfi, pct });
  }).catch(() => {});

  engine = {
    kind: 'epub',
    next: () => rendition.next(),
    prev: () => rendition.prev(),
    first: () => rendition.display(),
    last: () => rendition.display(book.spine.last().href),
    toc: async () => { await book.loaded.navigation.catch(() => {}); return tocItems.map((t) => ({ label: t.label, depth: t.depth, go: () => rendition.display(t.href) })); },
    gotoBookmark: (m) => rendition.display(m.cfi),
    bookmark: () => markBtn.click(),
    refreshBookmark: updateUi,
    zoomIn: () => setFont(10),
    zoomOut: () => setFont(-10),
    zoomFit: () => {},
    onSlider: (v) => { if (ready) rendition.display(book.locations.cfiFromPercentage(Number(v) / 1000)); },
    onSliderInput: (v) => { $('counter').textContent = Math.round(Number(v) / 10) + '%'; },
    resize: () => rendition.resize(),
    onTheme: (t) => rendition.themes.select(t),
  };
  updateUi();
}

/* ------------------------------------------------------------------ */
/* Controls shared by both formats                                     */
/* ------------------------------------------------------------------ */
function handleKey(e) {
  if (!engine) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); engine.next(); }
  else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); engine.prev(); }
  else if (k === 'Home') engine.first();
  else if (k === 'End') engine.last();
  else if (k === '+' || k === '=') engine.zoomIn();
  else if (k === '-' || k === '_') engine.zoomOut();
  else if (k === '0') engine.zoomFit();
  else if (k === 'f' || k === 'F') toggleFullscreen();
  else if (k === 'b' || k === 'B') engine.bookmark();
  else if (k === 't' || k === 'T') cycleTheme();
  else if (k === 'Escape' && !$('panel').classList.contains('hidden')) togglePanel(false);
}
document.addEventListener('keydown', handleKey);
$('prev').addEventListener('click', () => engine && engine.prev());
$('next').addEventListener('click', () => engine && engine.next());
slider.addEventListener('input', () => engine && engine.onSliderInput(slider.value));
slider.addEventListener('change', () => engine && engine.onSlider(slider.value));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => engine && engine.resize && engine.resize(), 200); });

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
async function openSource(source, format) {
  showLoading('Opening the book...');
  try {
    if (format === 'epub') await openEpub(source);
    else await openPdf(source);
    applyTheme();
  } catch (err) {
    console.error(err);
    showMessage('This book could not be opened', 'The file may be damaged, or your browser blocked it. ' + (err && err.message ? '(' + err.message + ')' : ''), h('a', { class: 'btn', href: 'index.html' }, 'Back to the library'));
  }
}

function detectFormat(name, buffer) {
  const head = new Uint8Array(buffer.slice(0, 5));
  if (String.fromCharCode(...head) === '%PDF-') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'epub';
  return /\.epub$/i.test(name) ? 'epub' : /\.pdf$/i.test(name) ? 'pdf' : null;
}

function showPicker() {
  $('title').textContent = 'Open a book from your computer';
  $('author').textContent = 'Nothing is uploaded. The book stays on your computer.';
  $('counter').textContent = '';
  const input = h('input', { type: 'file', accept: '.pdf,.epub,application/pdf,application/epub+zip', onchange: (e) => load(e.target.files[0]) });
  const zone = h('label', { class: 'dropzone big' }, h('strong', null, 'Choose a PDF or EPUB'), h('span', null, 'or drop it here'), input);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); load(e.dataTransfer.files[0]); });
  stage.replaceChildren(h('div', { class: 'rd-message' }, zone));
  async function load(file) {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const format = detectFormat(file.name, buffer);
    if (!format) { toast('That is not a PDF or EPUB file.', 'error'); return; }
    progressKey = `local:${file.name}:${file.size}`;
    $('title').textContent = file.name.replace(/\.(pdf|epub)$/i, '');
    $('author').textContent = format.toUpperCase() + ', opened from your computer';
    await openSource(buffer, format);
  }
}

async function start() {
  applyTheme();
  if (params.get('local')) { showPicker(); return; }
  try { await loadCatalog(); } catch (_) { showMessage('The library could not be loaded', 'Start it with "npm start" and try again.', h('a', { class: 'btn', href: 'index.html' }, 'Back')); return; }
  const id = params.get('id');
  const book = findBook(id);
  if (!book || !isReadable(book)) {
    showMessage('This book cannot be read here', 'It is not stored in the library, or it was removed.', h('a', { class: 'btn primary', href: 'index.html' }, 'Back to the library'));
    return;
  }
  document.title = book.title + ' \u00b7 StudyHub Library';
  $('title').textContent = book.title;
  $('author').textContent = book.author;
  $('back').href = 'book.html?id=' + encodeURIComponent(book.id);
  progressKey = book.id;
  if (store.api) fetch(`api/books/${encodeURIComponent(book.id)}/read`, { method: 'POST' }).catch(() => {});
  await openSource(encodeURI(book.file), book.format);
}

start();
