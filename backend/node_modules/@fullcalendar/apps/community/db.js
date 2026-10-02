'use strict';
/**
 * Tiny persistence layer for StudyHub.
 * Everything lives in one in-memory object that is saved to data/db.json.
 * That keeps the project dependency-free and easy to run. For a very large
 * school you would swap this file for a real database (SQLite, PostgreSQL...).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.STUDYHUB_DATA
  ? path.resolve(process.env.STUDYHUB_DATA)
  : path.join(__dirname, 'data', 'db.json');

const empty = () => ({
  users: [],
  sessions: {},
  channels: [],
  messages: [],
  reads: {},
  questions: [],
  answers: [],
  announcements: [],
  resources: [],
  notifications: [],
  // calendar
  courses: [],
  enrollments: [],
  events: [],
  overrides: [],
  completions: [],
  reminded: {},
});

let db = empty();

try {
  if (fs.existsSync(FILE)) {
    db = Object.assign(empty(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
  }
} catch (err) {
  const backup = FILE + '.corrupt-' + Date.now();
  console.error('Could not read the database (' + err.message + '). Saved a copy to ' + backup + ' and starting fresh.');
  try { fs.copyFileSync(FILE, backup); } catch (_) { /* ignore */ }
  db = empty();
}

let timer = null;

function writeNow() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE); // atomic replace, so a crash never leaves a half-written file
}

/** Save soon (debounced). Call after every change. */
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { writeNow(); } catch (err) { console.error('Saving failed:', err.message); }
  }, 250);
}

/** Save immediately (used on shutdown). */
function saveSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { writeNow(); } catch (err) { console.error('Saving failed:', err.message); }
}

const uid = () => crypto.randomBytes(8).toString('hex');

module.exports = { db, save, saveSync, uid, FILE };
