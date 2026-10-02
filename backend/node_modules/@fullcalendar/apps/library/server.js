'use strict';
/**
 * StudyHub Library server
 *  - serves the website (public/), the ebooks (books/) and the covers (covers/)
 *  - keeps the catalogue in data.json
 *  - lets a librarian (people who know the librarian code) add, edit and delete ebooks
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * Mounted as a sub-app under /library by the root server (server.js at the
 * project root). It no longer listens on its own port.
 */
module.exports = function createLibraryApp() {

const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const STORE = path.resolve(process.env.LIBRARY_STORE || __dirname);           // where data.json, books/ and covers/ live
const LIBRARIAN_CODE = process.env.LIBRARIAN_CODE || '';
const MAX_BYTES = (Number(process.env.LIBRARY_MAX_MB) || 200) * 1024 * 1024;
const ALLOW_PRIVATE_URLS = process.env.LIBRARY_ALLOW_PRIVATE_URLS === '1';   // only for tests
const DATA_FILE = path.join(STORE, 'data.json');
const BOOKS_DIR = path.join(STORE, 'books');
const COVERS_DIR = path.join(STORE, 'covers');
const EXTENSIONS = ['.pdf', '.epub'];

fs.mkdirSync(BOOKS_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */
let catalog = [];
try {
  catalog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(catalog)) catalog = [];
} catch (err) {
  if (fs.existsSync(DATA_FILE)) console.error('Could not read data.json (' + err.message + '). Starting with an empty catalogue.');
}

function saveCatalog() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const slugify = (text) => String(text || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const prettify = (name) => name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function uniqueId(base) {
  const root = slugify(base) || 'book';
  let id = root;
  for (let n = 2; catalog.some((b) => b.id === id) || fs.existsSync(path.join(BOOKS_DIR, id + '.pdf')) || fs.existsSync(path.join(BOOKS_DIR, id + '.epub')); n += 1) id = `${root}-${n}`;
  return id;
}

/** Books dropped into the books/ folder by hand are added to the catalogue automatically. */
function syncFolder() {
  const known = new Set(catalog.filter((b) => b.file).map((b) => path.basename(b.file)));
  let added = 0;
  for (const file of fs.readdirSync(BOOKS_DIR)) {
    const ext = path.extname(file).toLowerCase();
    if (!EXTENSIONS.includes(ext) || known.has(file)) continue;
    const stat = fs.statSync(path.join(BOOKS_DIR, file));
    const stem = path.basename(file, path.extname(file));
    const id = uniqueId(stem);
    catalog.push({
      id, title: prettify(stem), titleNe: '', author: 'Unknown author', authorNe: '', category: 'Uncategorised', language: '',
      kind: 'uploaded', format: ext.slice(1), file: 'books/' + file, cover: fs.existsSync(path.join(COVERS_DIR, stem + '.jpg')) ? 'covers/' + stem + '.jpg' : '',
      pages: 0, size: stat.size, added: stat.mtime.toISOString(), reads: 0, description: '',
    });
    added += 1;
  }
  if (added) { saveCatalog(); console.log(`  Added ${added} book${added === 1 ? '' : 's'} found in the books folder.`); }
}
syncFolder();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  return !!rec && rec.reset > now && rec.count >= 10;
}
function noteFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now) attempts.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
  else rec.count += 1;
}

function requireLibrarian(req, res, next) {
  if (Buffer.byteLength(LIBRARIAN_CODE) < 32) {
    return next(new HttpError(503, 'Librarian editing is disabled until a strong access code is configured.'));
  }
  if (tooManyAttempts(req.ip)) return next(new HttpError(429, 'Too many wrong codes. Wait a few minutes and try again.'));
  const given = Buffer.from(String(req.get('X-Librarian-Code') || ''));
  const wanted = Buffer.from(LIBRARIAN_CODE);
  const ok = given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
  if (!ok) { noteFailure(req.ip); return next(new HttpError(403, 'That librarian code is not correct.')); }
  next();
}

const findBook = (id) => {
  const book = catalog.find((b) => b.id === id);
  if (!book) throw new HttpError(404, 'Book not found.');
  return book;
};

async function sniff(file) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(8);
    await fd.read(buf, 0, 8, 0);
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'epub'; // EPUB is a zip file
    return null;
  } finally { await fd.close(); }
}

/** Stream a request or response body to disk, refusing anything bigger than MAX_BYTES. */
async function saveStream(source, destination) {
  let total = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > MAX_BYTES) return cb(new HttpError(413, `That file is larger than the ${Math.round(MAX_BYTES / 1048576)} MB limit.`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, limit, fs.createWriteStream(destination));
  } catch (err) {
    await fs.promises.unlink(destination).catch(() => {});
    throw err;
  }
  return total;
}

function metadataFrom(input, fallbackTitle) {
  const pages = Number(input.pages);
  return {
    title: clean(input.title, 160) || fallbackTitle,
    titleNe: clean(input.titleNe, 160),
    author: clean(input.author, 120) || 'Unknown author',
    authorNe: clean(input.authorNe, 120),
    category: clean(input.category, 60) || 'Uncategorised',
    language: clean(input.language, 12),
    description: clean(input.description, 1200),
    pages: Number.isInteger(pages) && pages > 0 && pages < 100000 ? pages : 0,
  };
}

async function addBookFile(tempPath, ext, input, fallbackTitle) {
  const format = await sniff(tempPath);
  if (!format || `.${format}` !== ext) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new HttpError(400, `That file is not a real ${ext.slice(1).toUpperCase()}. Choose a PDF or EPUB ebook.`);
  }
  const meta = metadataFrom(input, fallbackTitle);
  const id = uniqueId(meta.title === fallbackTitle ? fallbackTitle : meta.title);
  const finalName = id + ext;
  await fs.promises.rename(tempPath, path.join(BOOKS_DIR, finalName));
  const stat = await fs.promises.stat(path.join(BOOKS_DIR, finalName));
  const entry = {
    id, ...meta, kind: 'uploaded', format, file: 'books/' + finalName, cover: '', size: stat.size, added: new Date().toISOString(), reads: 0,
  };
  catalog.unshift(entry);
  saveCatalog();
  return entry;
}

/* ---- downloading from a link (librarian only) ---- */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new HttpError(400, 'That link does not look right.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https links can be imported.');
  if (ALLOW_PRIVATE_URLS) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new HttpError(400, 'That website could not be found.'); });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, 'That link points to a private address, so it cannot be imported.');
  return url;
}

async function download(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90 * 1000);
  try {
    for (let hop = 0; hop < 6; hop += 1) {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'StudyHubLibrary/2.0', Accept: 'application/pdf,application/epub+zip,*/*' } });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = res.headers.get('location');
        if (!next) throw new HttpError(502, 'The website sent a broken redirect.');
        url = await assertPublicUrl(new URL(next, url).href);
        continue;
      }
      if (!res.ok || !res.body) throw new HttpError(502, `The website answered with an error (${res.status}).`);
      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_BYTES) throw new HttpError(413, `That file is larger than the ${Math.round(MAX_BYTES / 1048576)} MB limit.`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const temp = path.join(BOOKS_DIR, `.import-${crypto.randomBytes(6).toString('hex')}.part`);
      await saveStream(Readable.fromWeb(res.body), temp);
      const format = await sniff(temp);
      if (!format) { await fs.promises.unlink(temp).catch(() => {}); throw new HttpError(400, `That link is not a PDF or EPUB file${type ? ' (it is ' + type.split(';')[0] + ')' : ''}.`); }
      return { temp, ext: '.' + format, fallback: prettify(decodeURIComponent(path.basename(url.pathname)).replace(/\.(pdf|epub3?(\.images|\.noimages)?)$/i, '')) || 'Imported book' };
    }
    throw new HttpError(502, 'The link redirected too many times.');
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(504, 'The download took too long.');
    throw err;
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/books', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json({ books: catalog, maxMb: Math.round(MAX_BYTES / 1048576) }); });
app.post('/api/librarian/check', requireLibrarian, (req, res) => res.json({ ok: true }));

// Add an ebook: the file itself is the request body, the details travel in the query string.
app.post('/api/books', requireLibrarian, wrap(async (req, res) => {
  const original = decodeURIComponent(String(req.get('X-File-Name') || 'book.pdf'));
  const ext = path.extname(original).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw new HttpError(400, 'Only PDF and EPUB ebooks can be added.');
  if (Number(req.get('content-length')) > MAX_BYTES) throw new HttpError(413, `That file is larger than the ${Math.round(MAX_BYTES / 1048576)} MB limit.`);
  const temp = path.join(BOOKS_DIR, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
  await saveStream(req, temp);
  const entry = await addBookFile(temp, ext, req.query, prettify(path.basename(original, ext)));
  res.status(201).json({ book: entry });
}));

app.post('/api/import', requireLibrarian, express.json({ limit: '20kb' }), wrap(async (req, res) => {
  const got = await download(String(req.body.url || '').trim());
  const entry = await addBookFile(got.temp, got.ext, req.body, got.fallback);
  res.status(201).json({ book: entry });
}));

app.post('/api/books/:id/cover', requireLibrarian, express.raw({ type: '*/*', limit: '3mb' }), wrap(async (req, res) => {
  const book = findBook(req.params.id);
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) throw new HttpError(400, 'The cover must be a JPEG image.');
  await fs.promises.writeFile(path.join(COVERS_DIR, book.id + '.jpg'), body);
  book.cover = `covers/${book.id}.jpg`;
  saveCatalog();
  res.json({ book });
}));

app.patch('/api/books/:id', requireLibrarian, express.json({ limit: '50kb' }), wrap(async (req, res) => {
  const book = findBook(req.params.id);
  const b = req.body;
  const text = { title: 160, titleNe: 160, author: 120, authorNe: 120, category: 60, language: 12, description: 1200 };
  for (const [key, max] of Object.entries(text)) if (b[key] !== undefined) book[key] = clean(b[key], max);
  if (!book.title) throw new HttpError(400, 'A book needs a title.');
  if (b.pages !== undefined && Number.isInteger(b.pages) && b.pages >= 0 && b.pages < 100000) book.pages = b.pages;
  saveCatalog();
  res.json({ book });
}));

app.delete('/api/books/:id', requireLibrarian, wrap(async (req, res) => {
  const book = findBook(req.params.id);
  for (const rel of [book.file, book.cover]) {
    if (!rel) continue;
    const full = path.resolve(STORE, rel);
    if (full.startsWith(BOOKS_DIR + path.sep) || full.startsWith(COVERS_DIR + path.sep)) await fs.promises.unlink(full).catch(() => {});
  }
  catalog = catalog.filter((b) => b.id !== book.id);
  saveCatalog();
  res.json({ ok: true });
}));

// Counts "most read": once per visitor per book every 30 minutes.
const recentReads = new Map();
app.post('/api/books/:id/read', wrap(async (req, res) => {
  const book = findBook(req.params.id);
  const key = req.ip + '|' + book.id;
  const now = Date.now();
  if (!recentReads.has(key) || recentReads.get(key) < now - 30 * 60 * 1000) {
    recentReads.set(key, now);
    book.reads = (book.reads || 0) + 1;
    saveCatalog();
  }
  res.json({ reads: book.reads });
}));
setInterval(() => { const cutoff = Date.now() - 30 * 60 * 1000; for (const [k, t] of recentReads) if (t < cutoff) recentReads.delete(k); }, 10 * 60 * 1000).unref();
setInterval(() => { const cutoff = Date.now(); for (const [ip, attempt] of attempts) if (attempt.reset <= cutoff) attempts.delete(ip); }, 10 * 60 * 1000).unref();

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// files: ebooks support range requests, so large PDFs open quickly
app.use('/books', express.static(BOOKS_DIR, { acceptRanges: true, dotfiles: 'deny', maxAge: '1h' }));
app.use('/covers', express.static(COVERS_DIR, { dotfiles: 'deny', maxAge: '1h' }));
app.get('/data.json', (req, res) => res.sendFile(DATA_FILE));
app.use(express.static(path.join(__dirname, '..', '..', '..', 'frontend', 'library'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return res.end();
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'That is too large.' : 'That request could not be understood.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (Buffer.byteLength(LIBRARIAN_CODE) < 32) console.warn('  [library] Librarian editing is disabled: set LIBRARIAN_CODE to a random value of at least 32 characters.');

return app;
};
