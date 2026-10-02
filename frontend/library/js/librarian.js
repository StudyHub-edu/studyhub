// Librarian tools: sign in with the librarian code, add ebooks (file or link), edit and delete, make covers.
import { h, toast, openModal, confirmBox, field, fmtSize } from './dom.js';
import { store } from './catalog.js';
import { pdfjs, epubjs, PDF_OPTIONS } from './engines.js';

const CODE_KEY = 'shl:code';
export const librarianCode = () => sessionStorage.getItem(CODE_KEY) || '';
export const isLibrarian = () => !!librarianCode();
export const signOutLibrarian = () => sessionStorage.removeItem(CODE_KEY);

/** Call the library API as a librarian. Errors become readable messages. */
export async function callApi(path, { method = 'GET', json, body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Librarian-Code': librarianCode(), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    if (res.status === 403) signOutLibrarian();
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data;
}

/** Ask for the librarian code once per browser session. Resolves true when signed in. */
export function ensureLibrarian() {
  if (isLibrarian()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const code = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Librarian code' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const go = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
    const modal = openModal({
      title: 'Librarian sign in',
      onClose: () => finish(false),
      content: h('form', {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          go.disabled = true;
          sessionStorage.setItem(CODE_KEY, code.value);
          try { await callApi('api/librarian/check', { method: 'POST' }); finish(true); modal.close(); toast('Librarian tools unlocked', 'success'); }
          catch (ex) { err.textContent = ex.message; sessionStorage.removeItem(CODE_KEY); go.disabled = false; }
        },
      },
      h('p', { class: 'muted' }, 'Only librarians can add or change ebooks. Ask whoever runs this library for the code.'),
      field('Code', code), err,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), go)),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Reading details out of a file: title, author, pages, cover          */
/* ------------------------------------------------------------------ */
function canvasToJpeg(source, width = 360) {
  const w = source.naturalWidth || source.width;
  const hgt = source.naturalHeight || source.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((hgt / w) * width);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cover image failed'));
    img.src = url;
  });
}

async function inspectPdf(url) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ url, ...PDF_OPTIONS }).promise;
  try {
    const meta = await pdf.getMetadata().catch(() => ({ info: {} }));
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return {
      format: 'pdf', pages: pdf.numPages, title: (meta.info && meta.info.Title) || '', author: (meta.info && meta.info.Author) || '',
      description: '', language: '', cover: await canvasToJpeg(canvas, 360),
    };
  } finally { pdf.destroy(); }
}

async function inspectEpub(source) {
  const ePub = await epubjs();
  const book = ePub(source);
  try {
    await book.ready;
    const meta = await book.loaded.metadata;
    let cover = null;
    try {
      const url = await book.coverUrl();
      if (url) cover = await canvasToJpeg(await loadImage(url), 360);
    } catch (_) { /* many ebooks have no cover */ }
    return {
      format: 'epub', pages: 0, title: meta.title || '', author: meta.creator || '',
      description: (meta.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600), language: meta.language || '', cover,
    };
  } finally { book.destroy(); }
}

/** file: a File chosen by the user, or a URL of a book already on the server. */
export async function inspect(file, format) {
  if (typeof file === 'string') return format === 'epub' ? inspectEpub(file) : inspectPdf(file);
  if (format === 'epub') return inspectEpub(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  try { return await inspectPdf(url); } finally { URL.revokeObjectURL(url); }
}

export async function uploadCover(id, blob) {
  if (!blob) return;
  await callApi(`api/books/${encodeURIComponent(id)}/cover`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
}

/** Fill in pages, cover and (when missing) author for a book that is already on the server. */
export async function enrichBook(book) {
  const info = await inspect(book.file, book.format);
  const patch = {};
  if (info.pages && !book.pages) patch.pages = info.pages;
  if (info.author && (!book.author || book.author === 'Unknown author')) patch.author = info.author;
  if (info.description && !book.description) patch.description = info.description;
  if (info.language && !book.language) patch.language = info.language;
  if (Object.keys(patch).length) await callApi('api/books/' + encodeURIComponent(book.id), { method: 'PATCH', json: patch });
  await uploadCover(book.id, info.cover);
}

/* ------------------------------------------------------------------ */
/* Add an ebook                                                        */
/* ------------------------------------------------------------------ */
function sendFile(file, params, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/books?' + new URLSearchParams(params));
    xhr.setRequestHeader('X-Librarian-Code', librarianCode());
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.book);
      else reject(new Error(data.error || 'The upload failed.'));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection.'));
    xhr.send(file);
  });
}

export function openAddModal({ onDone }) {
  const categories = [...new Set(store.books.map((b) => b.category).filter(Boolean))].sort();
  let tab = 'file';
  let file = null;
  let info = null;
  let coverBlob = null;

  const drop = h('label', { class: 'dropzone' },
    h('strong', null, 'Choose a PDF or EPUB'),
    h('span', null, 'or drop the file here'),
    h('input', { type: 'file', accept: '.pdf,.epub,application/pdf,application/epub+zip', onchange: (e) => pick(e.target.files[0]) }));
  const preview = h('div', { class: 'add-preview hidden' });
  const link = h('input', { class: 'input', type: 'url', placeholder: 'https://example.com/book.epub', autocomplete: 'off' });
  const title = h('input', { class: 'input', maxlength: '160', autocomplete: 'off' });
  const author = h('input', { class: 'input', maxlength: '120', autocomplete: 'off' });
  const category = h('input', { class: 'input', maxlength: '60', list: 'cats', placeholder: 'e.g. Nepali Literature', autocomplete: 'off' });
  const description = h('textarea', { class: 'input', rows: 3, maxlength: '1200' });
  const titleNe = h('input', { class: 'input', maxlength: '160', autocomplete: 'off' });
  const authorNe = h('input', { class: 'input', maxlength: '120', autocomplete: 'off' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const status = h('p', { class: 'status', role: 'status' });
  const bar = h('div', { class: 'upload-bar hidden' }, h('i'));
  const submit = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Add to library');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const fileBlock = h('div', null, drop, preview);
  const linkBlock = h('div', { class: 'hidden' }, field('Link to a PDF or EPUB', link, 'For example the EPUB link of a book on Project Gutenberg.'));

  const setBusy = (busy) => { submit.disabled = busy || (tab === 'file' && !file); };
  function drawTabs() {
    tabs.replaceChildren(...[['file', 'From my device'], ['link', 'From a link']].map(([key, label]) =>
      h('button', {
        class: 'tab' + (tab === key ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': String(tab === key),
        onclick: () => { tab = key; fileBlock.classList.toggle('hidden', key !== 'file'); linkBlock.classList.toggle('hidden', key !== 'link'); drawTabs(); setBusy(false); err.textContent = ''; },
      }, label)));
  }

  async function pick(chosen) {
    if (!chosen) return;
    err.textContent = '';
    const ext = (chosen.name.match(/\.(pdf|epub)$/i) || [])[1];
    if (!ext) { err.textContent = 'Please choose a PDF or EPUB file.'; return; }
    if (store.maxMb && chosen.size > store.maxMb * 1048576) { err.textContent = `That file is ${fmtSize(chosen.size)}. The limit is ${store.maxMb} MB.`; return; }
    file = chosen;
    status.textContent = 'Reading the file...';
    submit.disabled = true;
    try {
      info = await inspect(chosen, ext.toLowerCase());
    } catch (ex) {
      info = null;
      err.textContent = 'This file could not be opened. It may be damaged or protected with a password.';
      status.textContent = '';
      file = null;
      return;
    }
    coverBlob = info.cover;
    title.value = info.title || chosen.name.replace(/\.(pdf|epub)$/i, '').replace(/[-_]+/g, ' ').trim();
    author.value = info.author || '';
    description.value = info.description || '';
    if (!category.value) category.value = info.language && info.language.startsWith('ne') ? 'Nepali Literature' : '';
    preview.classList.remove('hidden');
    preview.replaceChildren(
      coverBlob ? h('img', { src: URL.createObjectURL(coverBlob), alt: 'Cover preview' }) : h('div', { class: 'no-cover' }, 'No cover found'),
      h('div', null, h('strong', null, chosen.name), h('p', { class: 'muted' }, `${ext.toUpperCase()}, ${fmtSize(chosen.size)}${info.pages ? ', ' + info.pages + ' pages' : ''}`)));
    status.textContent = 'Check the details below, then add the book.';
    setBusy(false);
  }
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  const form = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!title.value.trim()) { err.textContent = 'Give the book a title.'; return; }
      if (!category.value.trim()) { err.textContent = 'Choose or type a subject, for example "Science" or "Nepali Literature".'; return; }
      setBusy(true);
      bar.classList.remove('hidden');
      bar.firstChild.style.width = '0%';
      const meta = {
        title: title.value, author: author.value, category: category.value, description: description.value,
        titleNe: titleNe.value, authorNe: authorNe.value,
      };
      try {
        let book;
        if (tab === 'file') {
          status.textContent = 'Uploading...';
          book = await sendFile(file, { ...meta, pages: info ? info.pages : 0, language: info ? info.language : '' }, (f) => { bar.firstChild.style.width = Math.round(f * 100) + '%'; });
          status.textContent = 'Saving the cover...';
          await uploadCover(book.id, coverBlob).catch(() => {});
        } else {
          if (!link.value.trim()) throw new Error('Paste the link to a PDF or EPUB.');
          status.textContent = 'Downloading the book. Large files can take a minute...';
          bar.firstChild.style.width = '60%';
          book = (await callApi('api/import', { method: 'POST', json: { url: link.value.trim(), ...meta } })).book;
          status.textContent = 'Reading details from the book...';
          await enrichBook(book).catch(() => {});
        }
        toast(`"${book.title}" was added to the library`, 'success');
        modal.close();
        onDone(book);
      } catch (ex) {
        err.textContent = ex.message;
        status.textContent = '';
        bar.classList.add('hidden');
        setBusy(false);
      }
    },
  },
  tabs, fileBlock, linkBlock,
  field('Title', title),
  h('div', { class: 'field-row' }, field('Author', author), field('Subject', category)),
  h('datalist', { id: 'cats' }, categories.map((c) => h('option', { value: c }))),
  field('About the book (optional)', description),
  h('details', { class: 'more' }, h('summary', null, 'Nepali title and author (optional)'),
    h('div', { class: 'field-row' }, field('Title in Nepali', titleNe), field('Author in Nepali', authorNe))),
  bar, status, err,
  h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  drawTabs();
  const modal = openModal({ title: 'Add an ebook', content: form, wide: true });
  return modal;
}

/* ------------------------------------------------------------------ */
/* Edit / delete                                                       */
/* ------------------------------------------------------------------ */
export function openEditModal(book, { onSaved, onDeleted }) {
  const inputs = {
    title: h('input', { class: 'input', maxlength: '160' }),
    titleNe: h('input', { class: 'input', maxlength: '160' }),
    author: h('input', { class: 'input', maxlength: '120' }),
    authorNe: h('input', { class: 'input', maxlength: '120' }),
    category: h('input', { class: 'input', maxlength: '60', list: 'cats2' }),
    description: h('textarea', { class: 'input', rows: 4, maxlength: '1200' }),
  };
  for (const [k, el] of Object.entries(inputs)) el.value = book[k] || '';
  const cats = [...new Set(store.books.map((b) => b.category).filter(Boolean))].sort();
  const err = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');
  const modal = openModal({
    title: 'Edit book',
    wide: true,
    content: h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        save.disabled = true;
        try {
          const json = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
          const r = await callApi('api/books/' + encodeURIComponent(book.id), { method: 'PATCH', json });
          toast('Saved', 'success');
          modal.close();
          onSaved(r.book);
        } catch (ex) { err.textContent = ex.message; save.disabled = false; }
      },
    },
    field('Title', inputs.title),
    h('div', { class: 'field-row' }, field('Author', inputs.author), field('Subject', inputs.category)),
    h('datalist', { id: 'cats2' }, cats.map((c) => h('option', { value: c }))),
    field('About the book', inputs.description),
    h('div', { class: 'field-row' }, field('Title in Nepali', inputs.titleNe), field('Author in Nepali', inputs.authorNe)),
    err,
    h('div', { class: 'form-actions' },
      h('button', {
        class: 'btn danger-ghost', type: 'button',
        onclick: async () => {
          const ok = await confirmBox(`"${book.title}"${book.file ? ' and its file' : ''} will be removed from the library.`, { title: 'Delete book', confirmText: 'Delete', danger: true });
          if (!ok) return;
          try { await callApi('api/books/' + encodeURIComponent(book.id), { method: 'DELETE' }); toast('Book deleted'); modal.close(); onDeleted(); } catch (ex) { err.textContent = ex.message; }
        },
      }, 'Delete book'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      save)),
  });
}
