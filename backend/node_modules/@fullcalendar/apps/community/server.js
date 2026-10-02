'use strict';
/**
 * StudyHub server
 * ---------------
 *  - Express serves the website (public/) and a JSON API (/api/...)
 *  - Socket.IO pushes live updates: new messages, typing, presence, notifications
 *  - Data is stored in data/db.json (see db.js)
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, save, saveSync, uid } = require('./db');

/**
 * Mounted as a sub-app under /community by the root server (server.js at the
 * project root). `io` is a Socket.IO *namespace* (mainIO.of('/community')),
 * shared with the same underlying HTTP server as the rest of StudyHub, so
 * this file no longer creates its own http server or listens on its own port.
 */
module.exports = function createCommunityApp(io) {

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const LEGACY_AUTH_ENABLED = process.env.ALLOW_LEGACY_COMMUNITY_AUTH === '1';
const TEACHER_CODE = process.env.TEACHER_CODE || '';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const SUBJECTS = ['General', 'Math', 'Science', 'Programming', 'English', 'History', 'Languages', 'Arts', 'Other'];
const COLORS = ['#c2410c', '#b45309', '#0e7490', '#0f766e', '#6d28d9', '#be185d', '#4d7c0f', '#7e22ce', '#1d4ed8', '#9f1239'];
const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👏', '🔥', '😮'];

const app = express();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (err) { next(err); } };
const legacyAuthOnly = (req, res, next) => {
  if (!LEGACY_AUTH_ENABLED) {
    return res.status(410).json({ error: 'Use StudyHub sign-in at the main site.' });
  }
  next();
};

const now = () => Date.now();
// Strictly increasing timestamps so messages never share the same millisecond.
let lastTs = 0;
const tick = () => (lastTs = Math.max(Date.now(), lastTs + 1));

// Trim, normalise line breaks, strip control characters and cap the length.
const clean = (value, max) =>
  String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
function cleanImageUrls(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new HttpError(400, 'Add no more than 10 images.');
  const urls = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > 2048) throw new HttpError(400, 'An image URL is invalid.');
    let url;
    try { url = new URL(candidate); } catch (_) { throw new HttpError(400, 'An image URL is invalid.'); }
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) {
      throw new HttpError(400, 'Images must use secure HTTPS URLs.');
    }
    urls.push(url.href);
  }
  return [...new Set(urls)];
}

const userById = (id) => db.users.find((u) => u.id === id);
const isTeacher = (u) => u.role === 'teacher' || u.role === 'admin';

// Very small in-memory rate limiter.
const buckets = new Map();
function allow(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count <= max;
}
setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60 * 1000).unref();

/* ---------------- passwords & sessions ---------------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, user) {
  if (!user.hash || !user.salt) return false;
  const attempt = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, expires: now() + SESSION_TTL };
  save();
  return token;
}
function sessionUser(token) {
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expires < now()) { delete db.sessions[token]; return null; }
  const user = userById(s.userId) || null;
  if (user && !LEGACY_AUTH_ENABLED && !user.supabaseId) return null;
  return user;
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = sessionUser(token);
  if (!user) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  req.user = user;
  req.token = token;
  next();
}
function requireTeacher(req, res, next) {
  if (!isTeacher(req.user)) return res.status(403).json({ error: 'Only teachers can do this.' });
  next();
}

/* ---------------- presence ---------------- */
const online = new Map(); // userId -> number of open tabs
const isOnline = (id) => (online.get(id) || 0) > 0;

/* ---------------- reputation points (always computed from real data) ---------------- */
function computePoints() {
  const points = new Map();
  const add = (id, n) => points.set(id, (points.get(id) || 0) + n);
  const questions = new Map(db.questions.map((q) => [q.id, q]));
  for (const q of db.questions) add(q.userId, 1 + 2 * q.votes.length);
  for (const a of db.answers) {
    add(a.userId, 2 + 5 * a.votes.length);
    const q = questions.get(a.questionId);
    if (q && q.acceptedId === a.id) add(a.userId, 15);
    if (a.verifiedBy) add(a.userId, 10);
  }
  for (const r of db.resources) add(r.userId, 1 + r.likes.length);
  return points;
}

/* ---------------- serializers ---------------- */
function pubUser(u, pts) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    avatarUrl: u.avatarUrl || null,
    bio: u.bio || '',
    color: u.color,
    createdAt: u.createdAt,
    bot: !!u.bot,
    points: (pts || computePoints()).get(u.id) || 0,
  };
}
const pubChannel = (c) => ({
  id: c.id, name: c.name, description: c.description || '', emoji: c.emoji || '💬',
  createdBy: c.createdBy, createdAt: c.createdAt, locked: !!c.locked,
});

function serializeMessage(m) {
  const reply = m.replyTo ? db.messages.find((x) => x.id === m.replyTo) : null;
  return {
    id: m.id,
    cid: m.cid,
    userId: m.userId,
    system: !!m.system,
    deleted: !!m.deleted,
    text: m.deleted ? '' : m.text,
    createdAt: m.createdAt,
    editedAt: m.editedAt || null,
    reactions: m.deleted ? {} : m.reactions || {},
    reply: reply
      ? { id: reply.id, userId: reply.userId, deleted: !!reply.deleted, text: reply.deleted ? '' : reply.text.slice(0, 140) }
      : null,
  };
}

function serializeQuestion(q, viewerId, full) {
  const answers = db.answers.filter((a) => a.questionId === q.id);
  const author = userById(q.userId);
  const out = {
    id: q.id,
    userId: q.userId,
    authorName: author ? author.name : 'StudyHub member',
    authorRole: author ? author.role : null,
    title: q.title,
    body: full ? q.body : q.body.slice(0, 220),
    images: Array.isArray(q.images) ? q.images : [],
    subject: q.subject,
    createdAt: q.createdAt,
    views: q.views || 0,
    votes: q.votes.length,
    voted: q.votes.includes(viewerId),
    answerCount: answers.length,
    solved: !!q.acceptedId,
    verified: answers.some((a) => a.verifiedBy),
  };
  if (full) {
    out.answers = answers
      .map((a) => ({
        id: a.id,
        questionId: a.questionId,
        userId: a.userId,
        body: a.body,
        images: Array.isArray(a.images) ? a.images : [],
        createdAt: a.createdAt,
        votes: a.votes.length,
        voted: a.votes.includes(viewerId),
        accepted: q.acceptedId === a.id,
        verifiedBy: a.verifiedBy || null,
      }))
      .sort((x, y) =>
        (y.accepted - x.accepted) || ((!!y.verifiedBy) - (!!x.verifiedBy)) || (y.votes - x.votes) || (x.createdAt - y.createdAt));
  }
  return out;
}

const serializeAnnouncement = (a) => ({
  id: a.id, userId: a.userId, title: a.title, body: a.body, pinned: !!a.pinned, createdAt: a.createdAt,
});
const serializeResource = (r, viewerId) => ({
  id: r.id, userId: r.userId, title: r.title, url: r.url || '', description: r.description || '',
  subject: r.subject, images: Array.isArray(r.images) ? r.images : [],
  createdAt: r.createdAt, likes: r.likes.length, liked: r.likes.includes(viewerId),
});

/* ---------------- conversations (public channels + direct messages) ---------------- */
// Direct-message ids look like  dm-<smallerUserId>-<largerUserId>
function getConv(user, cid) {
  if (typeof cid !== 'string') return null;
  if (cid.startsWith('dm-')) {
    const parts = cid.split('-');
    if (parts.length !== 3) return null;
    const [, a, b] = parts;
    if (!(a < b)) return null;
    if (user.id !== a && user.id !== b) return null;
    const otherId = user.id === a ? b : a;
    if (!userById(otherId)) return null;
    return { dm: true, otherId };
  }
  const channel = db.channels.find((c) => c.id === cid);
  return channel ? { dm: false, channel } : null;
}

function emitConv(cid, event, payload) {
  if (cid.startsWith('dm-')) {
    const [, a, b] = cid.split('-');
    io.to('user:' + a).to('user:' + b).emit(event, payload);
  } else {
    io.emit(event, payload); // public channels: everybody hears about them (unread badges)
  }
}

function unreadCounts(user) {
  const out = {};
  const reads = db.reads[user.id] || {};
  for (const m of db.messages) {
    if (m.userId === user.id || m.system || m.deleted) continue;
    if (m.cid.startsWith('dm-') && !m.cid.split('-').includes(user.id)) continue;
    const lastRead = reads[m.cid] === undefined ? user.createdAt : reads[m.cid];
    if (m.createdAt > lastRead) out[m.cid] = (out[m.cid] || 0) + 1;
  }
  return out;
}

function dmList(user) {
  const map = new Map();
  for (const m of db.messages) {
    if (!m.cid.startsWith('dm-')) continue;
    const parts = m.cid.split('-');
    if (!parts.includes(user.id)) continue;
    const other = parts[1] === user.id ? parts[2] : parts[1];
    const cur = map.get(m.cid);
    if (!cur || m.createdAt > cur.lastAt) {
      map.set(m.cid, { cid: m.cid, userId: other, lastAt: m.createdAt, lastText: m.deleted ? 'Message deleted' : m.text.slice(0, 60) });
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* ---------------- notifications ---------------- */
function notify(userId, { type, text, link }) {
  const n = { id: uid(), userId, type, text: clean(text, 200), link: link || '', read: false, createdAt: tick() };
  db.notifications.push(n);
  if (db.notifications.length > 5000) db.notifications.splice(0, db.notifications.length - 5000);
  io.to('user:' + userId).emit('notification:new', n);
  return n;
}

/* ------------------------------------------------------------------ */
/* First-run sample content                                            */
/* ------------------------------------------------------------------ */
function seed() {
  if (db.users.length || db.channels.length) return;
  const t = now() - 1000;
  const bot = {
    id: uid(), username: 'studyhub', name: 'StudyHub Team', role: 'teacher', bot: true,
    bio: 'The official StudyHub account.', color: '#0f766e', createdAt: t,
  };
  db.users.push(bot);
  const channels = [
    ['general', 'general', '💬', 'Say hi and chat about anything school related.', true],
    [uid(), 'homework-help', '📚', 'Stuck on homework? Ask here.'],
    [uid(), 'math', '📐', 'Algebra, geometry, calculus and everything in between.'],
    [uid(), 'science', '🔬', 'Physics, chemistry, biology and experiments.'],
    [uid(), 'programming', '💻', 'Code, bugs and projects.'],
    [uid(), 'english', '✍️', 'Essays, grammar and reading lists.'],
    [uid(), 'study-groups', '👥', 'Find people to study with.'],
    [uid(), 'off-topic', '☕', 'Take a break. Music, games, jokes.'],
  ];
  for (const [id, name, emoji, description, locked] of channels) {
    db.channels.push({ id, name, emoji, description, locked: !!locked, createdBy: bot.id, createdAt: t });
  }
  db.messages.push({
    id: uid(), cid: 'general', userId: bot.id, createdAt: t + 1, reactions: {},
    text: 'Welcome to StudyHub! 👋 This is the place for students and teachers to talk, ask questions and share what they learn.\n\nTip: type @ and a name to mention someone. You can also use **bold** and `code` in your messages.',
  });
  db.announcements.push({
    id: uid(), userId: bot.id, pinned: true, createdAt: t + 2,
    title: 'Welcome to StudyHub',
    body: 'Chat in the channels, ask questions in Q&A and share useful links in Resources. Be kind, help each other and keep it about learning.',
  });
  const q = {
    id: uid(), userId: bot.id, createdAt: t + 3, views: 0, votes: [], acceptedId: null, subject: 'General',
    title: 'How do I get good answers on StudyHub?',
    body: 'New here and not sure how Q&A works. What makes a question easy to answer?',
  };
  db.questions.push(q);
  db.answers.push({
    id: uid(), questionId: q.id, userId: bot.id, createdAt: t + 4, votes: [], verifiedBy: null,
    body: 'Give your question a clear title, say what you already tried, and pick the right subject. Vote up helpful answers, and mark the one that solved it as the best answer.',
  });
  save();
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, '..', '..', '..', 'frontend', 'community')));
// Calendar widget (FullCalendar) is served from node_modules, so `npm install` is all that is needed.
app.get('/vendor/fullcalendar.js', (req, res, next) =>
  res.sendFile(path.join(path.dirname(require.resolve('fullcalendar/package.json')), 'index.global.min.js'), { maxAge: '1d' }, (err) => err && next(err)));

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */
app.post('/api/register', legacyAuthOnly, wrap((req, res) => {
  if (!allow('register:' + req.ip, 20, 60 * 60 * 1000)) throw new HttpError(429, 'Too many sign-ups from this device. Try again later.');
  const username = clean(req.body.username, 20).toLowerCase();
  const name = clean(req.body.name, 40);
  const password = String(req.body.password || '');
  const role = req.body.role === 'teacher' ? 'teacher' : 'student';

  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers or underscore.');
  if (name.length < 2) throw new HttpError(400, 'Please enter your name (at least 2 characters).');
  if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Password must be at least 6 characters.');
  const suppliedTeacherCode = Buffer.from(String(req.body.teacherCode || '').trim());
  const expectedTeacherCode = Buffer.from(TEACHER_CODE);
  const teacherCodeMatches = expectedTeacherCode.length > 0 &&
    suppliedTeacherCode.length === expectedTeacherCode.length &&
    crypto.timingSafeEqual(suppliedTeacherCode, expectedTeacherCode);
  if (role === 'teacher' && !teacherCodeMatches) {
    throw new HttpError(403, 'That teacher code is not correct. Ask your school admin for it.');
  }
  if (db.users.some((u) => u.username === username)) throw new HttpError(409, 'That username is taken. Try another one.');

  const { salt, hash } = hashPassword(password);
  const user = {
    id: uid(), username, name, role, bio: '', salt, hash,
    color: COLORS[db.users.length % COLORS.length], createdAt: now(),
  };
  db.users.push(user);

  const sys = { id: uid(), cid: 'general', userId: null, system: true, text: `${name} joined StudyHub 👋`, createdAt: tick(), reactions: {} };
  db.messages.push(sys);
  const token = createSession(user.id);
  save();

  io.emit('user:joined', pubUser(user));
  io.emit('message:new', serializeMessage(sys));
  res.status(201).json({ token, me: pubUser(user) });
}));

app.post('/api/login', legacyAuthOnly, wrap((req, res) => {
  if (!allow('login:' + req.ip, 15, 5 * 60 * 1000)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
  const username = clean(req.body.username, 20).toLowerCase();
  const user = db.users.find((u) => u.username === username);
  if (!user || !verifyPassword(String(req.body.password || ''), user)) {
    throw new HttpError(400, 'Wrong username or password.');
  }
  res.json({ token: createSession(user.id), me: pubUser(user) });
}));

app.post('/api/logout', auth, wrap((req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
}));

/**
 * Single sign-on bridge: the root server (server.js at the project root)
 * verifies the person's real StudyHub (Supabase) login, then calls this
 * function directly (in-process, not over HTTP) to get them a session here
 * too — matched by their Supabase account id, never by a password. There is
 * no public route for this: Community/Calendar never show a login form of
 * their own.
 */
app.locals.bridgeLogin = function bridgeLogin({ supabaseId, email, name, role, avatarUrl }) {
  if (!supabaseId) throw new HttpError(400, 'Missing account id.');
  const safeRole = ['student', 'teacher', 'admin'].includes(role) ? role : 'student';
  let safeAvatarUrl = null;
  if (typeof avatarUrl === 'string' && avatarUrl.length <= 2048) {
    try {
      const parsedAvatarUrl = new URL(avatarUrl);
      if (parsedAvatarUrl.protocol === 'https:' && !parsedAvatarUrl.username && !parsedAvatarUrl.password) {
        safeAvatarUrl = parsedAvatarUrl.href;
      }
    } catch (_) {
      safeAvatarUrl = null;
    }
  }
  let user = db.users.find((u) => u.supabaseId === supabaseId);
  if (!user) {
    let base = clean((name || email || 'student').split('@')[0], 20).toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'student';
    if (!/^[a-z]/.test(base)) base = 'u_' + base;
    let username = base.slice(0, 20);
    let n = 1;
    while (db.users.some((u) => u.username === username)) username = (base.slice(0, 17) + '_' + (++n)).slice(0, 20);
    const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex')); // random, unused: sign-in only ever happens via the bridge
    user = {
      id: uid(), username, name: clean(name || email || 'Student', 40) || 'Student', role: safeRole, bio: '',
      salt, hash, supabaseId, email: email || null, avatarUrl: safeAvatarUrl,
      color: COLORS[db.users.length % COLORS.length], createdAt: now(),
    };
    db.users.push(user);
    const sys = { id: uid(), cid: 'general', userId: null, system: true, text: `${user.name} joined StudyHub 👋`, createdAt: tick(), reactions: {} };
    db.messages.push(sys);
    io.emit('user:joined', pubUser(user));
    io.emit('message:new', serializeMessage(sys));
  } else if (user.role !== safeRole) {
    user.role = safeRole; // e.g. someone was promoted to teacher on the main site since their last visit here
  }
  if (name) user.name = clean(name, 40) || user.name;
  user.avatarUrl = safeAvatarUrl;
  const token = createSession(user.id);
  save();
  return { token, me: pubUser(user) };
};

app.patch('/api/me', auth, wrap((req, res) => {
  const u = req.user;
  if (req.body.name !== undefined) {
    const name = clean(req.body.name, 40);
    if (name.length < 2) throw new HttpError(400, 'Name must be at least 2 characters.');
    u.name = name;
  }
  if (req.body.bio !== undefined) u.bio = clean(req.body.bio, 200);
  if (req.body.color !== undefined) {
    if (!COLORS.includes(req.body.color)) throw new HttpError(400, 'Pick one of the available colours.');
    u.color = req.body.color;
  }
  save();
  const out = pubUser(u);
  io.emit('user:updated', out);
  res.json({ me: out });
}));

app.post('/api/me/password', auth, wrap((req, res) => {
  const { current, next } = req.body;
  if (!verifyPassword(String(current || ''), req.user)) throw new HttpError(400, 'Your current password is not correct.');
  if (String(next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters.');
  Object.assign(req.user, hashPassword(String(next)));
  save();
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Bootstrap, members, leaderboard                                     */
/* ------------------------------------------------------------------ */
app.get('/api/bootstrap', auth, wrap((req, res) => {
  const pts = computePoints();
  res.json({
    me: pubUser(req.user, pts),
    users: db.users.map((u) => pubUser(u, pts)),
    channels: db.channels.map(pubChannel),
    unread: unreadCounts(req.user),
    dms: dmList(req.user),
    notifications: db.notifications.filter((n) => n.userId === req.user.id).slice(-50).reverse(),
    online: [...online.keys()],
    subjects: SUBJECTS,
    reactions: REACTIONS,
    colors: COLORS,
  });
}));

app.get('/api/users', auth, wrap((req, res) => {
  const pts = computePoints();
  res.json({ users: db.users.filter((u) => !u.bot).map((u) => pubUser(u, pts)), online: [...online.keys()] });
}));

app.get('/api/authors', auth, wrap((req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .slice(0, 50)
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  const requested = new Set(ids);
  const users = db.users
    .filter((user) => !user.bot && user.supabaseId && requested.has(user.supabaseId))
    .map((user) => ({ id: user.supabaseId, name: user.name, role: user.role }));
  res.json({ users });
}));

app.get('/api/users/:id', auth, wrap((req, res) => {
  const u = userById(req.params.id);
  if (!u) throw new HttpError(404, 'Member not found.');
  const questions = db.questions.filter((q) => q.userId === u.id);
  const answers = db.answers.filter((a) => a.userId === u.id);
  const qById = new Map(db.questions.map((q) => [q.id, q]));
  res.json({
    user: pubUser(u),
    stats: {
      questions: questions.length,
      answers: answers.length,
      accepted: answers.filter((a) => qById.get(a.questionId) && qById.get(a.questionId).acceptedId === a.id).length,
      verified: answers.filter((a) => a.verifiedBy).length,
      // direct messages are private, so they are never counted
      messages: db.messages.filter((m) => m.userId === u.id && !m.deleted && !m.system && !m.cid.startsWith('dm-')).length,
      resources: db.resources.filter((r) => r.userId === u.id).length,
    },
    recentQuestions: questions.slice(-5).reverse().map((q) => serializeQuestion(q, req.user.id)),
  });
}));

app.get('/api/leaderboard', auth, wrap((req, res) => {
  const pts = computePoints();
  const qById = new Map(db.questions.map((q) => [q.id, q]));
  const items = db.users
    .filter((u) => !u.bot)
    .map((u) => {
      const answers = db.answers.filter((a) => a.userId === u.id);
      return {
        user: pubUser(u, pts),
        points: pts.get(u.id) || 0,
        answers: answers.length,
        accepted: answers.filter((a) => qById.get(a.questionId) && qById.get(a.questionId).acceptedId === a.id).length,
      };
    })
    .sort((a, b) => b.points - a.points || b.answers - a.answers)
    .slice(0, 25);
  res.json({ items });
}));

/* ------------------------------------------------------------------ */
/* Channels & messages                                                 */
/* ------------------------------------------------------------------ */
app.post('/api/channels', auth, wrap((req, res) => {
  if (db.channels.length >= 60) throw new HttpError(400, 'This community has reached the channel limit.');
  const name = clean(req.body.name, 30).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (name.length < 2 || name.length > 24) throw new HttpError(400, 'Channel names need 2-24 letters, numbers or dashes.');
  if (db.channels.some((c) => c.name === name)) throw new HttpError(409, 'A channel with that name already exists.');
  const emoji = Array.from(clean(req.body.emoji, 8)).slice(0, 2).join('') || '💬';
  const channel = {
    id: uid(), name, emoji, description: clean(req.body.description, 120), locked: false,
    createdBy: req.user.id, createdAt: now(),
  };
  db.channels.push(channel);
  save();
  io.emit('channel:new', pubChannel(channel));
  res.status(201).json({ channel: pubChannel(channel) });
}));

app.delete('/api/channels/:id', auth, wrap((req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id);
  if (!channel) throw new HttpError(404, 'Channel not found.');
  if (channel.locked) throw new HttpError(400, 'The general channel cannot be deleted.');
  if (channel.createdBy !== req.user.id && !isTeacher(req.user)) throw new HttpError(403, 'Only the creator or a teacher can delete a channel.');
  db.channels = db.channels.filter((c) => c.id !== channel.id);
  db.messages = db.messages.filter((m) => m.cid !== channel.id);
  save();
  io.emit('channel:deleted', { id: channel.id, by: req.user.id });
  res.json({ ok: true });
}));

app.get('/api/conversations/:cid/messages', auth, wrap((req, res) => {
  const cid = req.params.cid;
  if (!getConv(req.user, cid)) throw new HttpError(404, 'Conversation not found.');
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || Infinity;
  const all = db.messages.filter((m) => m.cid === cid && m.createdAt < before);
  const slice = all.slice(-limit);
  res.json({ messages: slice.map(serializeMessage), hasMore: all.length > slice.length });
}));

app.post('/api/conversations/:cid/messages', auth, wrap((req, res) => {
  const cid = req.params.cid;
  const conv = getConv(req.user, cid);
  if (!conv) throw new HttpError(404, 'Conversation not found.');
  if (!allow('msg:' + req.user.id, 15, 10 * 1000)) throw new HttpError(429, 'You are sending messages too fast. Wait a moment.');
  const text = clean(req.body.text, 2000);
  if (!text) throw new HttpError(400, 'Write a message first.');

  let replyTo = null;
  if (req.body.replyTo) {
    const original = db.messages.find((m) => m.id === req.body.replyTo && m.cid === cid);
    if (original) replyTo = original.id;
  }
  const msg = { id: uid(), cid, userId: req.user.id, text, replyTo, createdAt: tick(), reactions: {} };
  db.messages.push(msg);
  (db.reads[req.user.id] = db.reads[req.user.id] || {})[cid] = msg.createdAt;
  save();

  const out = serializeMessage(msg);
  emitConv(cid, 'message:new', out);

  // @mentions in public channels
  if (!conv.dm) {
    const names = new Set((text.match(/(?<![\w])@([a-z0-9_]{3,20})/gi) || []).map((s) => s.slice(1).toLowerCase()));
    for (const n of names) {
      const target = db.users.find((u) => u.username === n);
      if (target && target.id !== req.user.id && !target.bot) {
        notify(target.id, { type: 'mention', text: `${req.user.name} mentioned you in #${conv.channel.name}`, link: '#/chat/' + cid });
      }
    }
    save();
  }
  res.status(201).json({ message: out });
}));

app.post('/api/conversations/:cid/read', auth, wrap((req, res) => {
  if (!getConv(req.user, req.params.cid)) throw new HttpError(404, 'Conversation not found.');
  (db.reads[req.user.id] = db.reads[req.user.id] || {})[req.params.cid] = tick();
  save();
  res.json({ ok: true });
}));

function findMessage(req) {
  const msg = db.messages.find((m) => m.id === req.params.id);
  if (!msg || !getConv(req.user, msg.cid)) throw new HttpError(404, 'Message not found.');
  return msg;
}

app.patch('/api/messages/:id', auth, wrap((req, res) => {
  const msg = findMessage(req);
  if (msg.userId !== req.user.id || msg.system) throw new HttpError(403, 'You can only edit your own messages.');
  if (msg.deleted) throw new HttpError(400, 'This message was deleted.');
  const text = clean(req.body.text, 2000);
  if (!text) throw new HttpError(400, 'A message cannot be empty. Delete it instead.');
  msg.text = text;
  msg.editedAt = now();
  save();
  const out = serializeMessage(msg);
  emitConv(msg.cid, 'message:update', out);
  res.json({ message: out });
}));

app.delete('/api/messages/:id', auth, wrap((req, res) => {
  const msg = findMessage(req);
  const publicChannel = !msg.cid.startsWith('dm-');
  const allowed = msg.userId === req.user.id || (isTeacher(req.user) && publicChannel);
  if (!allowed || msg.system) throw new HttpError(403, 'You cannot delete this message.');
  msg.deleted = true;
  msg.text = '';
  msg.reactions = {};
  save();
  const out = serializeMessage(msg);
  emitConv(msg.cid, 'message:update', out);
  res.json({ message: out });
}));

app.post('/api/messages/:id/react', auth, wrap((req, res) => {
  const msg = findMessage(req);
  const emoji = req.body.emoji;
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'That reaction is not available.');
  if (msg.deleted || msg.system) throw new HttpError(400, 'You cannot react to this message.');
  msg.reactions = msg.reactions || {};
  const list = msg.reactions[emoji] || [];
  const i = list.indexOf(req.user.id);
  if (i >= 0) list.splice(i, 1); else list.push(req.user.id);
  if (list.length) msg.reactions[emoji] = list; else delete msg.reactions[emoji];
  save();
  const out = serializeMessage(msg);
  emitConv(msg.cid, 'message:update', out);
  res.json({ message: out });
}));

/* ------------------------------------------------------------------ */
/* Questions & answers                                                 */
/* ------------------------------------------------------------------ */
app.get('/api/questions', auth, wrap((req, res) => {
  const { subject, sort = 'new', filter = 'all' } = req.query;
  const term = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  let list = db.questions.slice();
  if (subject && SUBJECTS.includes(subject)) list = list.filter((q) => q.subject === subject);
  if (term) list = list.filter((q) => (q.title + ' ' + q.body).toLowerCase().includes(term));
  if (filter === 'unanswered') {
    const answered = new Set(db.answers.map((a) => a.questionId));
    list = list.filter((q) => !answered.has(q.id));
  } else if (filter === 'solved') list = list.filter((q) => q.acceptedId);
  else if (filter === 'mine') list = list.filter((q) => q.userId === req.user.id);

  if (sort === 'votes') list.sort((a, b) => b.votes.length - a.votes.length || b.createdAt - a.createdAt);
  else if (sort === 'views') list.sort((a, b) => (b.views || 0) - (a.views || 0) || b.createdAt - a.createdAt);
  else list.sort((a, b) => b.createdAt - a.createdAt);

  res.json({ total: list.length, items: list.slice(offset, offset + limit).map((q) => serializeQuestion(q, req.user.id)) });
}));

app.post('/api/questions', auth, wrap((req, res) => {
  if (!allow('ask:' + req.user.id, 10, 60 * 60 * 1000)) throw new HttpError(429, 'You have asked a lot of questions in a short time. Try again later.');
  const title = clean(req.body.title, 150);
  const body = clean(req.body.body, 5000);
  const images = cleanImageUrls(req.body.images);
  const subject = SUBJECTS.includes(req.body.subject) ? req.body.subject : 'General';
  if (title.length < 5) throw new HttpError(400, 'Give your question a title of at least 5 characters.');
  if (body.length < 10) throw new HttpError(400, 'Describe your question in at least 10 characters so others can help.');
  const q = { id: uid(), userId: req.user.id, title, body, subject, images, createdAt: tick(), views: 0, votes: [], acceptedId: null };
  db.questions.push(q);
  save();
  io.emit('question:new', { id: q.id, title: q.title, subject: q.subject, userId: q.userId });
  io.emit('questions:changed');
  res.status(201).json({ question: serializeQuestion(q, req.user.id, true) });
}));

function findQuestion(id) {
  const q = db.questions.find((x) => x.id === id);
  if (!q) throw new HttpError(404, 'Question not found. It may have been deleted.');
  return q;
}

app.get('/api/questions/:id', auth, wrap((req, res) => {
  const q = findQuestion(req.params.id);
  if (!req.query.noview && q.userId !== req.user.id) { q.views = (q.views || 0) + 1; save(); }
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

app.delete('/api/questions/:id', auth, wrap((req, res) => {
  const q = findQuestion(req.params.id);
  if (q.userId !== req.user.id && !isTeacher(req.user)) throw new HttpError(403, 'Only the author or a teacher can delete this question.');
  db.questions = db.questions.filter((x) => x.id !== q.id);
  db.answers = db.answers.filter((a) => a.questionId !== q.id);
  save();
  io.emit('question:changed', { id: q.id, deleted: true });
  io.emit('questions:changed');
  res.json({ ok: true });
}));

app.post('/api/questions/:id/vote', auth, wrap((req, res) => {
  const q = findQuestion(req.params.id);
  if (q.userId === req.user.id) throw new HttpError(400, 'You cannot vote for your own question.');
  const i = q.votes.indexOf(req.user.id);
  if (i >= 0) q.votes.splice(i, 1); else q.votes.push(req.user.id);
  save();
  io.emit('question:changed', { id: q.id });
  io.emit('questions:changed');
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

app.post('/api/questions/:id/answers', auth, wrap((req, res) => {
  const q = findQuestion(req.params.id);
  if (!allow('answer:' + req.user.id, 20, 10 * 60 * 1000)) throw new HttpError(429, 'You are answering very fast. Wait a moment.');
  const body = clean(req.body.body, 5000);
  const images = cleanImageUrls(req.body.images);
  if (body.length < 3) throw new HttpError(400, 'Write your answer first (at least 3 characters).');
  const a = { id: uid(), questionId: q.id, userId: req.user.id, body, images, createdAt: tick(), votes: [], verifiedBy: null };
  db.answers.push(a);
  if (q.userId !== req.user.id) {
    notify(q.userId, { type: 'answer', text: `${req.user.name} answered your question: ${q.title}`, link: '#/qa/' + q.id });
  }
  save();
  io.emit('question:changed', { id: q.id });
  io.emit('questions:changed');
  res.status(201).json({ question: serializeQuestion(q, req.user.id, true) });
}));

function findAnswer(id) {
  const a = db.answers.find((x) => x.id === id);
  if (!a) throw new HttpError(404, 'Answer not found. It may have been deleted.');
  return { a, q: findQuestion(a.questionId) };
}

app.delete('/api/answers/:id', auth, wrap((req, res) => {
  const { a, q } = findAnswer(req.params.id);
  if (a.userId !== req.user.id && !isTeacher(req.user)) throw new HttpError(403, 'Only the author or a teacher can delete this answer.');
  db.answers = db.answers.filter((x) => x.id !== a.id);
  if (q.acceptedId === a.id) q.acceptedId = null;
  save();
  io.emit('question:changed', { id: q.id });
  io.emit('questions:changed');
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

app.post('/api/answers/:id/vote', auth, wrap((req, res) => {
  const { a, q } = findAnswer(req.params.id);
  if (a.userId === req.user.id) throw new HttpError(400, 'You cannot vote for your own answer.');
  const i = a.votes.indexOf(req.user.id);
  if (i >= 0) a.votes.splice(i, 1); else a.votes.push(req.user.id);
  save();
  io.emit('question:changed', { id: q.id });
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

app.post('/api/answers/:id/accept', auth, wrap((req, res) => {
  const { a, q } = findAnswer(req.params.id);
  if (q.userId !== req.user.id) throw new HttpError(403, 'Only the person who asked can choose the best answer.');
  if (q.acceptedId === a.id) q.acceptedId = null;
  else {
    q.acceptedId = a.id;
    if (a.userId !== req.user.id) notify(a.userId, { type: 'accepted', text: `${req.user.name} marked your answer as the best answer`, link: '#/qa/' + q.id });
  }
  save();
  io.emit('question:changed', { id: q.id });
  io.emit('questions:changed');
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

app.post('/api/answers/:id/verify', auth, requireTeacher, wrap((req, res) => {
  const { a, q } = findAnswer(req.params.id);
  if (a.verifiedBy) a.verifiedBy = null;
  else {
    a.verifiedBy = req.user.id;
    if (a.userId !== req.user.id) notify(a.userId, { type: 'verified', text: `${req.user.name} (teacher) verified your answer`, link: '#/qa/' + q.id });
  }
  save();
  io.emit('question:changed', { id: q.id });
  io.emit('questions:changed');
  res.json({ question: serializeQuestion(q, req.user.id, true) });
}));

/* ------------------------------------------------------------------ */
/* Announcements (teachers post, everyone reads)                       */
/* ------------------------------------------------------------------ */
app.get('/api/announcements', auth, wrap((req, res) => {
  const list = db.announcements.slice().sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
  res.json({ items: list.map(serializeAnnouncement) });
}));

app.post('/api/announcements', auth, requireTeacher, wrap((req, res) => {
  const title = clean(req.body.title, 120);
  const body = clean(req.body.body, 3000);
  if (title.length < 3) throw new HttpError(400, 'Add a title (at least 3 characters).');
  if (body.length < 3) throw new HttpError(400, 'Write the announcement text.');
  const a = { id: uid(), userId: req.user.id, title, body, pinned: !!req.body.pinned, createdAt: tick() };
  db.announcements.push(a);
  for (const u of db.users) {
    if (u.id !== req.user.id && !u.bot) notify(u.id, { type: 'announcement', text: `New announcement: ${title}`, link: '#/announcements' });
  }
  save();
  io.emit('announcements:changed');
  res.status(201).json({ announcement: serializeAnnouncement(a) });
}));

app.post('/api/announcements/:id/pin', auth, requireTeacher, wrap((req, res) => {
  const a = db.announcements.find((x) => x.id === req.params.id);
  if (!a) throw new HttpError(404, 'Announcement not found.');
  a.pinned = !a.pinned;
  save();
  io.emit('announcements:changed');
  res.json({ announcement: serializeAnnouncement(a) });
}));

app.delete('/api/announcements/:id', auth, requireTeacher, wrap((req, res) => {
  const a = db.announcements.find((x) => x.id === req.params.id);
  if (!a) throw new HttpError(404, 'Announcement not found.');
  db.announcements = db.announcements.filter((x) => x.id !== a.id);
  save();
  io.emit('announcements:changed');
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */
app.get('/api/resources', auth, wrap((req, res) => {
  const { subject } = req.query;
  const term = String(req.query.q || '').trim().toLowerCase();
  let list = db.resources.slice();
  if (subject && SUBJECTS.includes(subject)) list = list.filter((r) => r.subject === subject);
  if (term) list = list.filter((r) => (r.title + ' ' + (r.description || '')).toLowerCase().includes(term));
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ items: list.map((r) => serializeResource(r, req.user.id)) });
}));

app.post('/api/resources', auth, wrap((req, res) => {
  const title = clean(req.body.title, 100);
  const description = clean(req.body.description, 500);
  const images = cleanImageUrls(req.body.images);
  const subject = SUBJECTS.includes(req.body.subject) ? req.body.subject : 'General';
  let url = clean(req.body.url, 500);
  if (title.length < 3) throw new HttpError(400, 'Give the resource a title (at least 3 characters).');
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new HttpError(400, 'That link does not look right. Example: https://example.com'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) throw new HttpError(400, 'That link does not look right. Example: https://example.com');
    url = parsed.href;
  }
  if (!url && description.length < 10 && !images.length) throw new HttpError(400, 'Add a link, a photo, or write a short note (at least 10 characters).');
  const r = { id: uid(), userId: req.user.id, title, url, description, images, subject, createdAt: tick(), likes: [] };
  db.resources.push(r);
  save();
  io.emit('resources:changed');
  res.status(201).json({ resource: serializeResource(r, req.user.id) });
}));

app.post('/api/resources/:id/like', auth, wrap((req, res) => {
  const r = db.resources.find((x) => x.id === req.params.id);
  if (!r) throw new HttpError(404, 'Resource not found.');
  const i = r.likes.indexOf(req.user.id);
  if (i >= 0) r.likes.splice(i, 1); else r.likes.push(req.user.id);
  save();
  io.emit('resources:changed');
  res.json({ resource: serializeResource(r, req.user.id) });
}));

app.delete('/api/resources/:id', auth, wrap((req, res) => {
  const r = db.resources.find((x) => x.id === req.params.id);
  if (!r) throw new HttpError(404, 'Resource not found.');
  if (r.userId !== req.user.id && !isTeacher(req.user)) throw new HttpError(403, 'Only the author or a teacher can delete this resource.');
  db.resources = db.resources.filter((x) => x.id !== r.id);
  save();
  io.emit('resources:changed');
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
app.get('/api/notifications', auth, wrap((req, res) => {
  res.json({ items: db.notifications.filter((n) => n.userId === req.user.id).slice(-50).reverse() });
}));

app.post('/api/notifications/read', auth, wrap((req, res) => {
  const ids = Array.isArray(req.body.ids) ? new Set(req.body.ids) : null;
  for (const n of db.notifications) {
    if (n.userId === req.user.id && (!ids || ids.has(n.id))) n.read = true;
  }
  save();
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Misc + errors                                                       */
/* ------------------------------------------------------------------ */
/* Calendar (courses, events, reminders) lives in calendar.js */
require('./calendar')({ app, io, db, save, uid, auth, wrap, HttpError, clean, notify, tick, userById, pubUser });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: 'That request could not be understood.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

/* ------------------------------------------------------------------ */
/* Real-time (Socket.IO)                                               */
/* ------------------------------------------------------------------ */
io.use((socket, next) => {
  const user = sessionUser(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const id = socket.userId;
  socket.join('user:' + id);
  online.set(id, (online.get(id) || 0) + 1);
  if (online.get(id) === 1) io.emit('presence', { userId: id, online: true });
  socket.emit('presence:all', [...online.keys()]);

  socket.on('typing', (payload) => {
    const user = userById(id);
    const cid = payload && payload.cid;
    const conv = user && getConv(user, cid);
    if (!conv) return;
    if (conv.dm) io.to('user:' + conv.otherId).emit('typing', { cid, userId: id });
    else socket.broadcast.emit('typing', { cid, userId: id });
  });

  socket.on('disconnect', () => {
    const left = (online.get(id) || 1) - 1;
    if (left <= 0) {
      online.delete(id);
      const u = userById(id);
      if (u) { u.lastSeen = now(); save(); }
      io.emit('presence', { userId: id, online: false });
    } else online.set(id, left);
  });
});

/* ------------------------------------------------------------------ */
/* Ready (no own listen() - the root server owns the HTTP port)       */
/* ------------------------------------------------------------------ */
for (const [token, s] of Object.entries(db.sessions)) if (s.expires < now()) delete db.sessions[token];
seed();
function shutdown() { saveSync(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

return app;
};
