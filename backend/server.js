'use strict';
/**
 * StudyHub — unified server
 * -------------------------
 * One process, one port, three apps:
 *   /              -> the main StudyHub site (login lives ONLY here, at "/")
 *   /community/... -> Community + Calendar (Express sub-app, own session store)
 *   /library/...   -> the ebook Library (Express sub-app)
 *
 * Login only ever happens on the main site (Supabase Auth, including email
 * OTP — configure Supabase's SMTP with your Gmail App Password, see README).
 * Community/Calendar never show their own login form: right after signing in
 * on the main site, the browser calls POST /api/bridge/session (below) to
 * get a matching Community session, transparently, via Supabase's verified
 * identity — never a second password.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Same Supabase project the main site's public/js/config.js points at.
// Only the public anon key is needed here — verifying a person's own access
// token this way never requires the secret service-role key.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rhcpnzduqishmbmfdwat.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_UjrKKitdiei3AQLfDZUm-g_D0StWem1';
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseService = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
const server = http.createServer(app);

// Community/Calendar's live chat + presence, isolated on their own
// Socket.IO namespace and path so they can never collide with anything
// else mounted on this same server later.
const io = new SocketIOServer(server, { path: '/community/socket.io' });
const communityIO = io.of('/community');

const createCommunityApp = require('./apps/community/server');
const createLibraryApp = require('./apps/library/server');

const communityApp = createCommunityApp(communityIO);
const libraryApp = createLibraryApp();

/* ------------------------------------------------------------------ */
/* Admin tools                                                         */
/* ------------------------------------------------------------------ */
const adminToolAttempts = new Map();
async function requireAdminRequest(req, res, next) {
  const authorization = req.headers.authorization || '';
  const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!accessToken) return res.status(401).json({ error: 'Sign in as an administrator to continue.' });

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data?.user) return res.status(401).json({ error: 'Your session is invalid or expired. Sign in again.' });

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile, error: profileError } = await asUser
      .from('profiles')
      .select('role')
      .eq('user_id', data.user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    if (!supabaseService) return res.status(503).json({ error: 'Admin actions are not configured. Add SUPABASE_SERVICE_ROLE_KEY to backend/.env; never put it in frontend files.' });

    req.adminUser = data.user;
    req.supabaseService = supabaseService;
    next();
  } catch (error) {
    console.error('[admin-tools] authorization failed:', error.message);
    return res.status(500).json({ error: 'Could not verify administrator access.' });
  }
}

function limitAdminActions(req, res, next) {
  const now = Date.now();
  const record = adminToolAttempts.get(req.ip);
  if (record && record.resetAt > now && record.count >= 20) {
    return res.status(429).json({ error: 'Too many admin actions. Wait a minute and try again.' });
  }
  if (!record || record.resetAt <= now) adminToolAttempts.set(req.ip, { count: 1, resetAt: now + 60_000 });
  else record.count += 1;
  next();
}

const cleanAdminText = (value, max) => String(value == null ? '' : value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

app.post('/api/admin/users', express.json({ limit: '12kb' }), limitAdminActions, requireAdminRequest, async (req, res) => {
  const email = cleanAdminText(req.body.email, 254).toLowerCase();
  const fullName = cleanAdminText(req.body.full_name, 120);
  const role = req.body.role;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const institutionId = req.body.institution_id || null;
  const classLevel = cleanAdminText(req.body.class_level, 32);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!fullName) return res.status(400).json({ error: 'Enter the user’s full name.' });
  if (!['student', 'teacher'].includes(role)) return res.status(400).json({ error: 'Choose student or teacher. Admin roles cannot be created here.' });
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ error: 'Use a password of at least 12 characters containing a letter and a number.' });
  if (email === 'teamofstudyhub@gmail.com') return res.status(400).json({ error: 'The fixed administrator account cannot be created through this form.' });
  if (institutionId && !/^[0-9a-f-]{36}$/i.test(institutionId)) return res.status(400).json({ error: 'Choose a valid institution.' });

  try {
    if (institutionId) {
      const { data: institution, error: institutionError } = await req.supabaseService
        .from('institutions')
        .select('id')
        .eq('id', institutionId)
        .maybeSingle();
      if (institutionError) throw institutionError;
      if (!institution) return res.status(400).json({ error: 'The selected institution no longer exists. Refresh the page and choose again.' });
    }
    const { data, error } = await req.supabaseService.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role, institution_id: institutionId, class_level: classLevel },
    });
    if (error) {
      const duplicate = /already|registered/i.test(error.message || '');
      return res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'An account already exists with this email.' : error.message });
    }
    res.status(201).json({ user: { id: data.user.id, email: data.user.email, role } });
  } catch (error) {
    console.error('[admin-tools] user creation failed:', error.message);
    res.status(500).json({ error: 'Could not create the account. Check Supabase Auth settings and database triggers.' });
  }
});

app.post('/api/admin/institutions', express.json({ limit: '8kb' }), limitAdminActions, requireAdminRequest, async (req, res) => {
  const name = cleanAdminText(req.body.name, 160);
  const city = cleanAdminText(req.body.city, 100) || null;
  const address = cleanAdminText(req.body.address, 240) || null;
  const type = req.body.type;
  const allowedTypes = ['school', 'college', 'university', 'other'];
  if (name.length < 2) return res.status(400).json({ error: 'Enter the institution name.' });
  if (!allowedTypes.includes(type)) return res.status(400).json({ error: 'Choose a valid institution type.' });

  try {
    const latitude = req.body.latitude === '' || req.body.latitude == null ? null : Number(req.body.latitude);
    const longitude = req.body.longitude === '' || req.body.longitude == null ? null : Number(req.body.longitude);
    if ((latitude == null) !== (longitude == null) || (latitude != null && (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180))) {
      return res.status(400).json({ error: 'Enter both valid map coordinates, or leave both blank.' });
    }
    const institution = { name, city, type, verification_status: 'verified' };
    if (address) institution.address = address;
    if (latitude != null) Object.assign(institution, { latitude, longitude });
    const { data, error } = await req.supabaseService
      .from('institutions')
      .insert(institution)
      .select('id, name, city, type')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That institution already exists in this city.' });
      throw error;
    }
    res.status(201).json({ institution: data });
  } catch (error) {
    console.error('[admin-tools] institution creation failed:', error.message);
    res.status(500).json({ error: 'Could not add the institution. Confirm the database migrations have run.' });
  }
});

/* ------------------------------------------------------------------ */
/* SSO bridge: Supabase login -> Community session                     */
/* ------------------------------------------------------------------ */
const bridgeAttempts = new Map();
app.post('/api/bridge/session', express.json({ limit: '8kb' }), async (req, res) => {
  const now = Date.now();
  const ip = req.ip;
  const bucket = bridgeAttempts.get(ip);
  if (bucket && bucket.resetAt > now && bucket.count >= 20) {
    return res.status(429).json({ error: 'Too many session requests. Try again shortly.' });
  }
  if (!bucket || bucket.resetAt <= now) bridgeAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
  else bucket.count += 1;

  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: 'Missing StudyHub session.' });

    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid or expired session.' });

    const { id, email, user_metadata } = data.user;
    const name = (user_metadata && (user_metadata.full_name || user_metadata.name)) || null;

    // A per-request client authenticated as this person, so the profiles
    // read below is subject to their own row-level security policy (they
    // can only ever see their own row) rather than needing a service key.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: profile, error: profileError } = await asUser
      .from('profiles')
      .select('role, full_name, avatar_url')
      .eq('user_id', id)
      .maybeSingle();
    if (profileError) throw profileError;
    const realRole = profile && profile.role; // 'student' | 'teacher' | 'admin' | undefined
    const communityRole = realRole === 'admin' ? 'admin' : realRole === 'teacher' ? 'teacher' : 'student';
    const avatarUrl = profile?.avatar_url || null;

    const result = communityApp.locals.bridgeLogin({
      supabaseId: id,
      email,
      name: profile?.full_name || name,
      role: communityRole,
      avatarUrl,
    });
    result.home = realRole === 'admin' ? '/admin-dashboard.html' : realRole === 'teacher' ? '/teacher-dashboard.html' : '/dashboard.html';
    res.json(result);
  } catch (err) {
    console.error('[bridge] failed:', err);
    res.status(500).json({ error: 'Could not start a Community session.' });
  }
});
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of bridgeAttempts) if (bucket.resetAt <= now) bridgeAttempts.delete(ip);
  for (const [ip, bucket] of adminToolAttempts) if (bucket.resetAt <= now) adminToolAttempts.delete(ip);
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* Sub-apps                                                            */
/* ------------------------------------------------------------------ */
app.use('/community', communityApp);
app.use('/library', libraryApp);

/* ------------------------------------------------------------------ */
/* Main site (login, dashboard, profile, ...)                          */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).send('Not found.'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try:  PORT=4000 npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  StudyHub is running -> http://localhost:${PORT}`);
  console.log(`    Main site  : http://localhost:${PORT}/`);
  console.log(`    Community  : http://localhost:${PORT}/community/`);
  console.log(`    Calendar   : http://localhost:${PORT}/community/#/calendar`);
  console.log(`    Library    : http://localhost:${PORT}/library/\n`);
});
