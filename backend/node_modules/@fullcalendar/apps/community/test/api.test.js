'use strict';
/**
 * Runs the real server on a temporary port with a temporary database and
 * checks every backend feature (accounts, chat, DMs, Q&A, announcements,
 * resources, notifications, real-time events).
 *
 *   npm install
 *   npm test
 */
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `studyhub-test-${Date.now()}.json`);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  \u2713 ' + name); }
  catch (err) { console.error('  \u2717 ' + name + '\n    ' + (err.stack || err)); process.exitCode = 1; throw err; }
}

async function call(method, url, token, body) {
  const res = await fetch(BASE + '/community/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, data };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function once(socket, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out waiting for ' + event)), ms);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE + '/community', { path: '/community/socket.io', auth: { token }, transports: ['websocket'], reconnection: false });
    s.firstPresence = new Promise((r) => s.once('presence:all', r)); // registered early so it cannot be missed
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), STUDYHUB_DATA: DATA, TEACHER_CODE: 'secret-code', ALLOW_LEGACY_COMMUNITY_AUTH: '1', REMINDER_TICK_MS: '1000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
    server.on('exit', (c) => reject(new Error('server exited early with code ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });

  const sockets = [];
  try {
    let alice, bob, cara, teacher, sb2;
    let general;

    console.log('\nAccounts');
    await test('registers students and a teacher (teacher needs the code)', async () => {
      let r = await call('POST', '/register', null, { username: 'alice', name: 'Alice Stone', password: 'secret1', role: 'student' });
      assert.equal(r.status, 201); alice = r.data;
      r = await call('POST', '/register', null, { username: 'bob', name: 'Bob Lee', password: 'secret2', role: 'student' });
      assert.equal(r.status, 201); bob = r.data;
      r = await call('POST', '/register', null, { username: 'cara', name: 'Cara Diaz', password: 'secret3', role: 'student' });
      assert.equal(r.status, 201); cara = r.data;
      r = await call('POST', '/register', null, { username: 'mrs_smith', name: 'Mrs Smith', password: 'teachpass', role: 'teacher', teacherCode: 'wrong' });
      assert.equal(r.status, 403);
      r = await call('POST', '/register', null, { username: 'mrs_smith', name: 'Mrs Smith', password: 'teachpass', role: 'teacher', teacherCode: 'secret-code' });
      assert.equal(r.status, 201); teacher = r.data;
      assert.equal(teacher.me.role, 'teacher');
      assert.equal(alice.me.role, 'student');
    });
    await test('rejects duplicate usernames, weak passwords and bad usernames', async () => {
      assert.equal((await call('POST', '/register', null, { username: 'ALICE', name: 'X Y', password: 'secret1' })).status, 409);
      assert.equal((await call('POST', '/register', null, { username: 'newuser', name: 'New User', password: '123' })).status, 400);
      assert.equal((await call('POST', '/register', null, { username: 'a b', name: 'New User', password: '123456' })).status, 400);
    });
    await test('logs in with the right password only', async () => {
      assert.equal((await call('POST', '/login', null, { username: 'alice', password: 'nope' })).status, 400);
      const r = await call('POST', '/login', null, { username: 'Alice', password: 'secret1' });
      assert.equal(r.status, 200);
      assert.ok(r.data.token);
    });
    await test('protects the API without a token', async () => {
      assert.equal((await call('GET', '/bootstrap')).status, 401);
      assert.equal((await call('GET', '/bootstrap', 'bad-token')).status, 401);
    });
    await test('bootstrap returns channels, users, subjects and reactions', async () => {
      const r = await call('GET', '/bootstrap', alice.token);
      assert.equal(r.status, 200);
      assert.ok(r.data.channels.length >= 8);
      assert.ok(r.data.users.length >= 5);
      assert.ok(r.data.subjects.includes('Math'));
      assert.ok(r.data.reactions.length >= 6);
      general = r.data.channels.find((c) => c.name === 'general');
      assert.ok(general && general.locked);
    });

    console.log('\nReal-time chat');
    let sa, sb;
    await test('sockets need a valid token', async () => {
      await assert.rejects(connect('nope'));
      sa = await connect(alice.token); sb = await connect(bob.token);
      sockets.push(sa, sb);
      const list = await sb.firstPresence;
      assert.ok(list.includes(alice.me.id));
    });

    let m1;
    await test('a message reaches other users instantly and shows as unread', async () => {
      const incoming = once(sb, 'message:new');
      const r = await call('POST', `/conversations/${general.id}/messages`, alice.token, { text: 'Hello everyone!' });
      assert.equal(r.status, 201); m1 = r.data.message;
      const got = await incoming;
      assert.equal(got.text, 'Hello everyone!');
      assert.equal(got.userId, alice.me.id);
      const boot = await call('GET', '/bootstrap', bob.token);
      assert.equal(boot.data.unread[general.id], 1);
      assert.equal((await call('POST', `/conversations/${general.id}/read`, bob.token)).status, 200);
      assert.equal(((await call('GET', '/bootstrap', bob.token)).data.unread[general.id] || 0), 0);
    });
    await test('empty and over-long messages are handled', async () => {
      assert.equal((await call('POST', `/conversations/${general.id}/messages`, alice.token, { text: '   ' })).status, 400);
      const long = await call('POST', `/conversations/${general.id}/messages`, alice.token, { text: 'x'.repeat(5000) });
      assert.equal(long.data.message.text.length, 2000);
    });
    await test('replies keep a preview of the original message', async () => {
      const r = await call('POST', `/conversations/${general.id}/messages`, bob.token, { text: 'Hi Alice', replyTo: m1.id });
      assert.equal(r.data.message.reply.id, m1.id);
      assert.equal(r.data.message.reply.text, 'Hello everyone!');
    });
    await test('only the author can edit; edits are broadcast', async () => {
      assert.equal((await call('PATCH', `/messages/${m1.id}`, bob.token, { text: 'hacked' })).status, 403);
      const upd = once(sb, 'message:update');
      const r = await call('PATCH', `/messages/${m1.id}`, alice.token, { text: 'Hello all!' });
      assert.equal(r.status, 200);
      const got = await upd;
      assert.equal(got.text, 'Hello all!');
      assert.ok(got.editedAt);
    });
    await test('reactions toggle on and off', async () => {
      let r = await call('POST', `/messages/${m1.id}/react`, bob.token, { emoji: '👍' });
      assert.deepEqual(r.data.message.reactions['👍'], [bob.me.id]);
      r = await call('POST', `/messages/${m1.id}/react`, alice.token, { emoji: '👍' });
      assert.equal(r.data.message.reactions['👍'].length, 2);
      r = await call('POST', `/messages/${m1.id}/react`, bob.token, { emoji: '👍' });
      assert.equal(r.data.message.reactions['👍'].length, 1);
      assert.equal((await call('POST', `/messages/${m1.id}/react`, bob.token, { emoji: '💩' })).status, 400);
    });
    await test('@mentions notify the mentioned user in real time', async () => {
      const note = once(sb, 'notification:new');
      await call('POST', `/conversations/${general.id}/messages`, alice.token, { text: 'Can you check this @bob? and @nobody_here' });
      const n = await note;
      assert.equal(n.type, 'mention');
      assert.ok(n.text.includes('Alice'));
      const list = await call('GET', '/notifications', bob.token);
      assert.ok(list.data.items.some((x) => x.type === 'mention' && !x.read));
      await call('POST', '/notifications/read', bob.token, {});
      assert.ok((await call('GET', '/notifications', bob.token)).data.items.every((x) => x.read));
    });
    await test('teachers can delete anyone\'s message, students only their own', async () => {
      const r = await call('POST', `/conversations/${general.id}/messages`, alice.token, { text: 'to be deleted' });
      const id = r.data.message.id;
      assert.equal((await call('DELETE', `/messages/${id}`, bob.token)).status, 403);
      const upd = once(sb, 'message:update');
      const del = await call('DELETE', `/messages/${id}`, teacher.token);
      assert.equal(del.status, 200);
      const got = await upd;
      assert.equal(got.deleted, true);
      assert.equal(got.text, '');
    });
    await test('history loads with pagination', async () => {
      for (let i = 0; i < 6; i += 1) await call('POST', `/conversations/${general.id}/messages`, cara.token, { text: 'msg ' + i });
      const page1 = await call('GET', `/conversations/${general.id}/messages?limit=5`, alice.token);
      assert.equal(page1.data.messages.length, 5);
      assert.equal(page1.data.hasMore, true);
      const oldest = page1.data.messages[0].createdAt;
      const page2 = await call('GET', `/conversations/${general.id}/messages?limit=100&before=${oldest}`, alice.token);
      assert.ok(page2.data.messages.length > 0);
      assert.ok(page2.data.messages.every((m) => m.createdAt < oldest));
    });
    await test('typing indicators reach other people', async () => {
      const typing = once(sb, 'typing');
      sa.emit('typing', { cid: general.id });
      const got = await typing;
      assert.equal(got.userId, alice.me.id);
    });

    console.log('\nDirect messages');
    const dmId = ['dm', ...[alice.me.id, bob.me.id].sort()].join('-');
    await test('two users can talk privately; others cannot read it', async () => {
      const incoming = once(sb, 'message:new');
      const r = await call('POST', `/conversations/${dmId}/messages`, alice.token, { text: 'psst, private' });
      assert.equal(r.status, 201);
      assert.equal((await incoming).text, 'psst, private');
      assert.equal((await call('GET', `/conversations/${dmId}/messages`, cara.token)).status, 404);
      assert.equal((await call('POST', `/conversations/${dmId}/messages`, cara.token, { text: 'snoop' })).status, 404);
      const boot = await call('GET', '/bootstrap', bob.token);
      assert.equal(boot.data.dms.length, 1);
      assert.equal(boot.data.dms[0].userId, alice.me.id);
      assert.equal(boot.data.unread[dmId], 1);
    });
    await test('teachers cannot delete private messages of students', async () => {
      const list = await call('GET', `/conversations/${dmId}/messages`, alice.token);
      const id = list.data.messages[0].id;
      assert.equal((await call('DELETE', `/messages/${id}`, teacher.token)).status, 404);
    });
    await test('DM ids must be valid', async () => {
      assert.equal((await call('GET', `/conversations/dm-${alice.me.id}-${alice.me.id}/messages`, alice.token)).status, 404);
      assert.equal((await call('GET', '/conversations/does-not-exist/messages', alice.token)).status, 404);
    });

    console.log('\nChannels');
    await test('anyone can create a channel; names are cleaned; duplicates blocked', async () => {
      const ev = once(sb, 'channel:new');
      let r = await call('POST', '/channels', bob.token, { name: 'Physics Club!', description: 'Forces & fun', emoji: '⚛️' });
      assert.equal(r.status, 201);
      assert.equal(r.data.channel.name, 'physics-club');
      assert.equal((await ev).name, 'physics-club');
      assert.equal((await call('POST', '/channels', alice.token, { name: 'physics-club' })).status, 409);
      assert.equal((await call('POST', '/channels', alice.token, { name: '!' })).status, 400);
      const chId = r.data.channel.id;
      await call('POST', `/conversations/${chId}/messages`, bob.token, { text: 'first!' });
      assert.equal((await call('DELETE', `/channels/${chId}`, alice.token)).status, 403);
      const gone = once(sb, 'channel:deleted');
      assert.equal((await call('DELETE', `/channels/${chId}`, bob.token)).status, 200);
      assert.equal((await gone).id, chId);
      assert.equal((await call('GET', `/conversations/${chId}/messages`, bob.token)).status, 404);
    });
    await test('the general channel cannot be deleted; teachers can delete any channel', async () => {
      assert.equal((await call('DELETE', `/channels/${general.id}`, teacher.token)).status, 400);
      const r = await call('POST', '/channels', cara.token, { name: 'temp-room' });
      assert.equal((await call('DELETE', `/channels/${r.data.channel.id}`, teacher.token)).status, 200);
    });

    console.log('\nQuestions & answers');
    let q, ans;
    await test('asking a question is validated and broadcast', async () => {
      assert.equal((await call('POST', '/questions', bob.token, { title: 'hi', body: 'short' })).status, 400);
      const ev = once(sa, 'question:new');
      const r = await call('POST', '/questions', bob.token, { title: 'How do I factor x^2 + 5x + 6?', body: 'I do not understand how to factor quadratics. Can someone explain the steps?', subject: 'Math', images: ['https://studyhub.example/images/problem.jpg'] });
      assert.equal(r.status, 201); q = r.data.question;
      assert.equal(q.authorName, bob.me.name);
      assert.equal(q.authorRole, bob.me.role);
      assert.deepEqual(q.images, ['https://studyhub.example/images/problem.jpg']);
      assert.equal((await call('POST', '/questions', bob.token, { title: 'Image validation question', body: 'This question has sufficient detail.', images: ['javascript:alert(1)'] })).status, 400);
      assert.equal((await call('POST', '/questions', bob.token, { title: 'Too many photos', body: 'This question has sufficient detail.', images: Array(11).fill('https://studyhub.example/image.jpg') })).status, 400);
      assert.equal((await ev).subject, 'Math');
    });
    await test('answering notifies the asker and shows up in the question', async () => {
      const note = once(sb, 'notification:new');
      const r = await call('POST', `/questions/${q.id}/answers`, alice.token, { body: 'Find two numbers that multiply to 6 and add to 5: 2 and 3. So (x+2)(x+3).', images: ['https://studyhub.example/images/solution.jpg'] });
      assert.equal(r.status, 201);
      assert.equal(r.data.question.answers.length, 1);
      ans = r.data.question.answers[0];
      assert.deepEqual(ans.images, ['https://studyhub.example/images/solution.jpg']);
      assert.equal((await note).type, 'answer');
      assert.equal((await call('POST', `/questions/${q.id}/answers`, cara.token, { body: '?' })).status, 400);
    });
    await test('voting works, but not on your own posts', async () => {
      assert.equal((await call('POST', `/answers/${ans.id}/vote`, alice.token)).status, 400);
      let r = await call('POST', `/answers/${ans.id}/vote`, bob.token);
      assert.equal(r.data.question.answers[0].votes, 1);
      assert.equal(r.data.question.answers[0].voted, true);
      r = await call('POST', `/answers/${ans.id}/vote`, bob.token);
      assert.equal(r.data.question.answers[0].votes, 0);
      assert.equal((await call('POST', `/questions/${q.id}/vote`, bob.token)).status, 400);
      r = await call('POST', `/questions/${q.id}/vote`, cara.token);
      assert.equal(r.data.question.votes, 1);
    });
    await test('only the asker can pick the best answer; only teachers can verify', async () => {
      assert.equal((await call('POST', `/answers/${ans.id}/accept`, cara.token)).status, 403);
      let r = await call('POST', `/answers/${ans.id}/accept`, bob.token);
      assert.equal(r.data.question.solved, true);
      assert.equal(r.data.question.answers[0].accepted, true);
      assert.equal((await call('POST', `/answers/${ans.id}/verify`, bob.token)).status, 403);
      r = await call('POST', `/answers/${ans.id}/verify`, teacher.token);
      assert.equal(r.data.question.answers[0].verifiedBy, teacher.me.id);
      assert.equal(r.data.question.verified, true);
    });
    await test('lists can be searched, filtered and sorted', async () => {
      await call('POST', '/questions', cara.token, { title: 'What is photosynthesis?', body: 'Please explain photosynthesis in simple words.', subject: 'Science' });
      const all = await call('GET', '/questions', alice.token);
      assert.ok(all.data.total >= 3);
      assert.equal((await call('GET', '/questions?q=factor', alice.token)).data.total, 1);
      assert.equal((await call('GET', '/questions?subject=Science', alice.token)).data.total, 1);
      const solved = await call('GET', '/questions?filter=solved', alice.token);
      assert.ok(solved.data.items.every((x) => x.solved));
      const un = await call('GET', '/questions?filter=unanswered', alice.token);
      assert.ok(un.data.items.every((x) => x.answerCount === 0));
      const mine = await call('GET', '/questions?filter=mine', bob.token);
      assert.ok(mine.data.items.every((x) => x.userId === bob.me.id));
      const top = await call('GET', '/questions?sort=votes', alice.token);
      assert.ok(top.data.items[0].votes >= top.data.items[1].votes);
      const page = await call('GET', '/questions?limit=1&offset=1', alice.token);
      assert.equal(page.data.items.length, 1);
    });
    await test('views are counted for other people, not the author', async () => {
      const before = (await call('GET', `/questions/${q.id}?noview=1`, alice.token)).data.question.views;
      await call('GET', `/questions/${q.id}`, alice.token);
      await call('GET', `/questions/${q.id}`, bob.token);
      const after = (await call('GET', `/questions/${q.id}?noview=1`, alice.token)).data.question.views;
      assert.equal(after, before + 1);
    });
    await test('leaderboard reflects reputation', async () => {
      const r = await call('GET', '/leaderboard', alice.token);
      assert.equal(r.data.items[0].user.id, alice.me.id); // answer + accepted + verified
      assert.ok(r.data.items[0].points >= 2 + 15 + 10);
      assert.ok(r.data.items.every((x) => !x.user.bot));
    });
    await test('deleting: strangers cannot, authors and teachers can', async () => {
      assert.equal((await call('DELETE', `/answers/${ans.id}`, cara.token)).status, 403);
      assert.equal((await call('DELETE', `/questions/${q.id}`, cara.token)).status, 403);
      const r = await call('DELETE', `/answers/${ans.id}`, alice.token);
      assert.equal(r.data.question.answers.length, 0);
      assert.equal(r.data.question.solved, false);
      assert.equal((await call('DELETE', `/questions/${q.id}`, teacher.token)).status, 200);
      assert.equal((await call('GET', `/questions/${q.id}`, alice.token)).status, 404);
    });

    console.log('\nAnnouncements');
    await test('only teachers post; students are notified; pin and delete work', async () => {
      assert.equal((await call('POST', '/announcements', alice.token, { title: 'Hi', body: 'Hello there' })).status, 403);
      const note = once(sa, 'notification:new');
      let r = await call('POST', '/announcements', teacher.token, { title: 'Exam on Friday', body: 'Chapters 1 to 4 will be covered.' });
      assert.equal(r.status, 201);
      assert.equal((await note).type, 'announcement');
      const id = r.data.announcement.id;
      r = await call('POST', `/announcements/${id}/pin`, teacher.token);
      assert.equal(r.data.announcement.pinned, true);
      const list = await call('GET', '/announcements', alice.token);
      assert.ok(list.data.items.length >= 2);
      assert.ok(list.data.items[0].pinned);
      assert.equal((await call('DELETE', `/announcements/${id}`, alice.token)).status, 403);
      assert.equal((await call('DELETE', `/announcements/${id}`, teacher.token)).status, 200);
    });

    console.log('\nResources');
    await test('sharing links: validated, searchable, likeable, deletable', async () => {
      assert.equal((await call('POST', '/resources', alice.token, { title: 'Bad', url: 'javascript:alert(1)' })).status, 400);
      assert.equal((await call('POST', '/resources', alice.token, { title: 'Nothing here' })).status, 400);
      let r = await call('POST', '/resources', alice.token, { title: 'Khan Academy', url: 'khanacademy.org', description: 'Free lessons', subject: 'Math' });
      assert.equal(r.status, 201);
      assert.equal(r.data.resource.url, 'https://khanacademy.org/');
      const id = r.data.resource.id;
      r = await call('POST', '/resources', alice.token, { title: 'Study tip', description: 'Use spaced repetition every day.', subject: 'General' });
      assert.equal(r.status, 201);
      r = await call('POST', '/resources', alice.token, { title: 'Geometry diagrams', images: ['https://studyhub.example/images/triangle.jpg'] });
      assert.equal(r.status, 201);
      assert.deepEqual(r.data.resource.images, ['https://studyhub.example/images/triangle.jpg']);
      assert.equal((await call('GET', '/resources?subject=Math', bob.token)).data.items.length, 1);
      assert.equal((await call('GET', '/resources?q=spaced', bob.token)).data.items.length, 1);
      r = await call('POST', `/resources/${id}/like`, bob.token);
      assert.equal(r.data.resource.likes, 1);
      assert.equal(r.data.resource.liked, true);
      assert.equal((await call('DELETE', `/resources/${id}`, bob.token)).status, 403);
      assert.equal((await call('DELETE', `/resources/${id}`, alice.token)).status, 200);
    });

    console.log('\nProfiles');
    await test('members list and profile stats', async () => {
      const list = await call('GET', '/users', alice.token);
      assert.ok(list.data.users.length >= 4);
      assert.ok(list.data.users.every((u) => !u.bot && !('hash' in u) && !('salt' in u)));
      const p = await call('GET', `/users/${alice.me.id}`, bob.token);
      assert.ok(p.data.stats.messages >= 3);
      assert.equal(p.data.stats.answers, 0);
      assert.equal((await call('GET', '/users/nobody', bob.token)).status, 404);
    });
    await test('editing your profile updates everyone', async () => {
      const ev = once(sb, 'user:updated');
      const r = await call('PATCH', '/me', alice.token, { name: 'Alice S.', bio: 'Loves maths', color: '#0e7490' });
      assert.equal(r.data.me.name, 'Alice S.');
      assert.equal((await ev).bio, 'Loves maths');
      assert.equal((await call('PATCH', '/me', alice.token, { color: 'red' })).status, 400);
      assert.equal((await call('PATCH', '/me', alice.token, { name: 'A' })).status, 400);
    });
    await test('changing the password works and old password stops working', async () => {
      assert.equal((await call('POST', '/me/password', alice.token, { current: 'wrong', next: 'newpass1' })).status, 400);
      assert.equal((await call('POST', '/me/password', alice.token, { current: 'secret1', next: 'newpass1' })).status, 200);
      assert.equal((await call('POST', '/login', null, { username: 'alice', password: 'secret1' })).status, 400);
      assert.equal((await call('POST', '/login', null, { username: 'alice', password: 'newpass1' })).status, 200);
    });
    await test('logout ends the session', async () => {
      const r = await call('POST', '/login', null, { username: 'cara', password: 'secret3' });
      assert.equal((await call('POST', '/logout', r.data.token)).status, 200);
      assert.equal((await call('GET', '/bootstrap', r.data.token)).status, 401);
    });
    await test('presence updates when someone disconnects', async () => {
      const ev = once(sa, 'presence');
      sb.close();
      const got = await ev;
      assert.equal(got.online, false);
      assert.equal(got.userId, bob.me.id);
    });

    console.log('\nCalendar: courses');
    let course, joinCode;
    const localParts = (iso, tz) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
      const g = (t) => p.find((x) => x.type === t).value;
      return `${g('weekday')} ${g('hour')}:${g('minute')}`;
    };
    const cal = async (token, from, to) => (await call('GET', `/calendar?start=${from}&end=${to}`, token)).data.events;
    await test('only teachers create courses; the join code is only shown to the teacher', async () => {
      assert.equal((await call('POST', '/courses', alice.token, { name: 'Hack' })).status, 403);
      assert.equal((await call('POST', '/courses', teacher.token, { name: 'x' })).status, 400);
      const r = await call('POST', '/courses', teacher.token, { name: 'Math 101', code: 'm101' });
      assert.equal(r.status, 201);
      course = r.data.course; joinCode = course.joinCode;
      assert.equal(joinCode.length, 6);
      assert.equal(course.code, 'M101');
      assert.equal((await call('GET', '/courses', teacher.token)).data.courses[0].joinCode, joinCode);
      assert.deepEqual((await call('GET', '/courses', alice.token)).data.courses, []);
    });
    await test('students join with a code; teachers add or remove students', async () => {
      assert.equal((await call('POST', '/courses/join', alice.token, { joinCode: 'NOPE99' })).status, 404);
      const ev = once(sa, 'courses:changed');
      let r = await call('POST', '/courses/join', alice.token, { joinCode: ' ' + joinCode.toLowerCase() + ' ' });
      assert.equal(r.status, 201);
      await ev;
      assert.equal(r.data.course.joinCode, undefined);
      assert.equal((await call('POST', '/courses/join', alice.token, { joinCode })).status, 409);
      assert.equal((await call('POST', '/courses/join', teacher.token, { joinCode })).status, 403);
      assert.equal((await call('POST', `/courses/${course.id}/students`, teacher.token, { username: '@bob' })).status, 201);
      assert.equal((await call('POST', `/courses/${course.id}/students`, teacher.token, { username: 'bob' })).status, 409);
      assert.equal((await call('POST', `/courses/${course.id}/students`, teacher.token, { username: 'mrs_smith' })).status, 400);
      assert.equal((await call('POST', `/courses/${course.id}/students`, teacher.token, { username: 'ghost' })).status, 404);
      assert.equal((await call('POST', `/courses/${course.id}/students`, alice.token, { username: 'cara' })).status, 403);
      assert.equal((await call('GET', `/courses/${course.id}/students`, alice.token)).status, 403);
      const roster = await call('GET', `/courses/${course.id}/students`, teacher.token);
      assert.deepEqual(roster.data.students.map((u) => u.username).sort(), ['alice', 'bob']);
      assert.equal((await call('GET', '/courses', teacher.token)).data.courses[0].studentCount, 2);
    });

    console.log('\nCalendar: events');
    const NEXT_MON = '2026-10-05'; // a Monday
    let series;
    await test('teachers create course events; students cannot', async () => {
      const base = { title: 'Algebra class', type: 'class', start: '2026-10-05T02:15:00.000Z', end: '2026-10-05T03:15:00.000Z', tz: 'Asia/Kathmandu', scope: 'course', courseId: course.id };
      assert.equal((await call('POST', '/events', alice.token, base)).status, 403);
      assert.equal((await call('POST', '/events', teacher.token, { ...base, courseId: 'nope' })).status, 403);
      const changed = once(sa, 'calendar:changed');
      const note = once(sa, 'notification:new');
      // 08:00-09:00 in Kathmandu every Monday and Wednesday until the end of October
      const r = await call('POST', '/events', teacher.token, { ...base, repeatRule: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261031T235959Z', reminderMinutes: 15 });
      assert.equal(r.status, 201);
      series = r.data.event;
      await changed;
      const n = await note;
      assert.equal(n.type, 'event');
      assert.match(n.text, /New class in Math 101: Algebra class/);
      assert.match(n.text, /Mon, Oct 5, 8:00 AM/);
    });
    await test('recurring events expand once per day, in the event\'s own time zone', async () => {
      const list = await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z');
      const mine = list.filter((e) => e.eventId === series.id);
      assert.equal(mine.length, 8);
      for (const e of mine) assert.match(localParts(e.start, 'Asia/Kathmandu'), /^(Mon|Wed) 08:00$/);
      assert.ok(mine.every((e) => e.canEdit === false && e.courseName === 'Math 101' && e.isRecurring));
      assert.equal((await cal(cara.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).length, 0);
    });
    await test('daylight saving changes do not move a 09:00 class', async () => {
      const r = await call('POST', '/events', alice.token, { title: 'Study', type: 'study_session', start: '2026-10-26T13:00:00.000Z', end: '2026-10-26T14:00:00.000Z', tz: 'America/New_York', repeatRule: 'FREQ=WEEKLY' });
      assert.equal(r.status, 201);
      const list = (await cal(alice.token, '2026-10-25T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === r.data.event.id);
      assert.equal(list.length, 3);
      assert.deepEqual(list.map((e) => e.start), ['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
      for (const e of list) assert.match(localParts(e.start, 'America/New_York'), /09:00$/);
      assert.equal((await cal(bob.token, '2026-10-25T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.title === 'Study').length, 0);
      await call('DELETE', `/events/${r.data.event.id}`, alice.token);
    });
    await test('students cannot edit or delete course events', async () => {
      assert.equal((await call('PATCH', `/events/${series.id}`, alice.token, { title: 'x' })).status, 403);
      assert.equal((await call('DELETE', `/events/${series.id}`, alice.token)).status, 403);
      assert.equal((await call('PATCH', `/events/${series.id}/occurrence`, alice.token, { occurrenceStart: '2026-10-05T02:15:00.000Z', title: 'x' })).status, 403);
      assert.equal((await call('PATCH', `/events/${series.id}`, cara.token, { title: 'x' })).status, 404);
    });
    await test('completion is per student and the teacher sees the class total', async () => {
      const first = (await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).find((e) => e.eventId === series.id);
      assert.equal((await call('POST', `/events/${series.id}/complete`, alice.token, { completed: true })).status, 400); // occurrence needed
      assert.equal((await call('POST', `/events/${series.id}/complete`, cara.token, { occurrenceStart: first.occurrenceStart })).status, 404);
      assert.equal((await call('POST', `/events/${series.id}/complete`, alice.token, { occurrenceStart: first.occurrenceStart, completed: true })).status, 200);
      const a = (await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      const b = (await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      const t = (await cal(teacher.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      assert.equal(a.filter((e) => e.completed).length, 1);
      assert.equal(b.filter((e) => e.completed).length, 0);
      assert.equal(t[0].completedCount, 1);
      assert.equal(t[0].totalStudents, 2);
      assert.equal(t[1].completedCount, 0);
      assert.equal(t[0].canEdit, true);
      await call('POST', `/events/${series.id}/complete`, alice.token, { occurrenceStart: first.occurrenceStart, completed: false });
      assert.equal((await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.completed).length, 0);
    });
    await test('"this event only": cancel or change one occurrence without touching the series', async () => {
      const all = (await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      const [o1, o2] = all;
      assert.equal((await call('DELETE', `/events/${series.id}?occurrence=${encodeURIComponent(o1.occurrenceStart)}`, teacher.token)).status, 200);
      const moved = { occurrenceStart: o2.occurrenceStart, start: '2026-10-07T05:00:00.000Z', end: '2026-10-07T06:00:00.000Z', title: 'Algebra (room 4)' };
      assert.equal((await call('PATCH', `/events/${series.id}/occurrence`, teacher.token, moved)).status, 200);
      const after = (await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      assert.equal(after.length, 7);
      assert.ok(!after.some((e) => e.occurrenceStart === o1.occurrenceStart));
      const edited = after.find((e) => e.occurrenceStart === o2.occurrenceStart);
      assert.equal(edited.title, 'Algebra (room 4)');
      assert.equal(edited.start, '2026-10-07T05:00:00.000Z');
      assert.equal(after.filter((e) => e.title === 'Algebra class').length, 6);
    });
    await test('personal recurring events keep completion per occurrence', async () => {
      const r = await call('POST', '/events', alice.token, { title: 'Read chapter', type: 'assignment', start: '2026-10-06T08:00:00.000Z', end: '2026-10-06T09:00:00.000Z', tz: 'UTC', repeatRule: 'FREQ=DAILY;COUNT=3' });
      const id = r.data.event.id;
      const list = (await cal(alice.token, '2026-10-06T00:00:00Z', '2026-10-10T00:00:00Z')).filter((e) => e.eventId === id);
      assert.equal(list.length, 3);
      await call('POST', `/events/${id}/complete`, alice.token, { occurrenceStart: list[1].occurrenceStart, completed: true });
      const after = (await cal(alice.token, '2026-10-06T00:00:00Z', '2026-10-10T00:00:00Z')).filter((e) => e.eventId === id);
      assert.deepEqual(after.map((e) => e.completed), [false, true, false]);
    });
    await test('one-off personal events: complete, move, delete', async () => {
      const r = await call('POST', '/events', bob.token, { title: 'Essay due', type: 'assignment', start: '2026-12-01T10:00:00.000Z', end: '2026-12-01T11:00:00.000Z', tz: 'UTC', description: 'x'.repeat(2000) });
      assert.equal(r.data.event.description.length, 1000);
      const id = r.data.event.id;
      await call('POST', `/events/${id}/complete`, bob.token, { completed: true });
      assert.equal((await cal(bob.token, '2026-12-01T00:00:00Z', '2026-12-02T00:00:00Z'))[0].completed, true);
      const moved = await call('PATCH', `/events/${id}`, bob.token, { start: '2026-12-03T10:00:00.000Z', end: '2026-12-03T11:00:00.000Z' });
      assert.equal(moved.data.event.start, '2026-12-03T10:00:00.000Z');
      assert.equal((await cal(bob.token, '2026-12-01T00:00:00Z', '2026-12-02T00:00:00Z')).length, 0);
      assert.equal((await call('DELETE', `/events/${id}`, bob.token)).status, 200);
      assert.equal((await cal(bob.token, '2026-12-01T00:00:00Z', '2026-12-05T00:00:00Z')).length, 0);
    });
    await test('editing the whole series resets one-off changes; students are told about schedule changes', async () => {
      const note = once(sb2 = await connect(bob.token), 'notification:new');
      sockets.push(sb2);
      const r = await call('PATCH', `/events/${series.id}`, teacher.token, { start: '2026-10-05T03:15:00.000Z', end: '2026-10-05T04:15:00.000Z' });
      assert.equal(r.status, 200);
      const n = await note;
      assert.match(n.text, /Schedule change in Math 101/);
      const list = (await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      assert.equal(list.length, 8);
      assert.ok(list.every((e) => e.title === 'Algebra class'));
      for (const e of list) assert.match(localParts(e.start, 'Asia/Kathmandu'), /09:00$/);
      // shifting the series by an hour (what "all events" does after a drag)
      assert.equal((await call('PATCH', `/events/${series.id}`, teacher.token, { shiftStartMs: 3600000, shiftEndMs: 3600000 })).status, 200);
      const shifted = (await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.eventId === series.id);
      for (const e of shifted) assert.match(localParts(e.start, 'Asia/Kathmandu'), /10:00$/);
      assert.equal((await call('PATCH', `/events/${series.id}`, teacher.token, { shiftStartMs: 1e15 })).status, 400);
    });
    await test('bad input is rejected', async () => {
      const ok = { title: 'T', type: 'exam', start: '2026-10-10T10:00:00Z', end: '2026-10-10T11:00:00Z', tz: 'UTC' };
      assert.equal((await call('POST', '/events', alice.token, { ...ok, title: ' ' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, type: 'party' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, end: '2026-10-10T09:00:00Z' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, start: 'soon' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, tz: 'Mars/Base' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, reminderMinutes: 99999 })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, repeatRule: 'FREQ=SECONDLY' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, repeatRule: 'FREQ=DAILY;EXDATE=20261010' })).status, 400);
      assert.equal((await call('POST', '/events', alice.token, { ...ok, end: '2026-12-10T09:00:00Z' })).status, 400);
      assert.equal((await call('GET', '/calendar?start=2026-01-01&end=2027-12-31', alice.token)).status, 400);
      assert.equal((await call('GET', '/calendar?start=nope&end=nope', alice.token)).status, 400);
    });

    console.log('\nCalendar: reminders');
    await test('reminders arrive as notifications once, for people who have not finished the task', async () => {
      const soon = Date.now() + 3 * 60000;
      const note = once(sa, 'notification:new', 4000);
      const r = await call('POST', '/events', alice.token, { title: 'Quiz prep', type: 'study_session', start: new Date(soon).toISOString(), end: new Date(soon + 3600000).toISOString(), tz: 'UTC', reminderMinutes: 5 });
      assert.equal(r.status, 201);
      const n = await note;
      assert.equal(n.type, 'reminder');
      assert.match(n.text, /Quiz prep starts in [23] minutes/);
      let extra = null;
      sa.once('notification:new', (x) => { extra = x; });
      await wait(2500);
      assert.equal(extra, null, 'a reminder must not repeat');
      // a course event: teacher and both students are reminded
      const soon2 = Date.now() + 4 * 60000;
      const notes = [once(sb2, 'notification:new', 4000), once(sa, 'notification:new', 4000)];
      await call('POST', '/events', teacher.token, { title: 'Pop quiz', type: 'test', start: new Date(soon2).toISOString(), end: new Date(soon2 + 1800000).toISOString(), tz: 'UTC', scope: 'course', courseId: course.id, reminderMinutes: 10 });
      const got = await Promise.all(notes);
      assert.ok(got.every((x) => x.type === 'event' || x.type === 'reminder'));
      await wait(2500);
      const bobNotes = (await call('GET', '/notifications', bob.token)).data.items.filter((x) => x.type === 'reminder');
      assert.ok(bobNotes.some((x) => /Math 101: Pop quiz starts in/.test(x.text)));
    });

    console.log('\nCalendar: leaving and deleting');
    await test('a student can leave; a teacher can remove a student', async () => {
      assert.equal((await call('DELETE', `/courses/${course.id}/students/${bob.me.id}`, alice.token)).status, 403);
      assert.equal((await call('DELETE', `/courses/${course.id}/students/${alice.me.id}`, alice.token)).status, 200);
      assert.equal((await cal(alice.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.courseId).length, 0);
      assert.equal((await call('DELETE', `/courses/${course.id}/students/${alice.me.id}`, alice.token)).status, 404);
      assert.equal((await call('DELETE', `/courses/${course.id}/students/${bob.me.id}`, teacher.token)).status, 200);
      assert.equal((await call('GET', '/courses', bob.token)).data.courses.length, 0);
    });
    await test('deleting a course removes its events for everyone', async () => {
      await call('POST', '/courses/join', bob.token, { joinCode });
      assert.ok((await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).some((e) => e.courseId));
      assert.equal((await call('DELETE', `/courses/${course.id}`, bob.token)).status, 403);
      assert.equal((await call('DELETE', `/courses/${course.id}`, teacher.token)).status, 200);
      assert.equal((await cal(bob.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).filter((e) => e.courseId).length, 0);
      assert.equal((await cal(teacher.token, '2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z')).length, 0);
      assert.equal((await call('POST', '/courses/join', bob.token, { joinCode })).status, 404);
    });

    console.log('\nData is saved to disk');
    await test('database file is written', async () => {
      await wait(500);
      const saved = JSON.parse(fs.readFileSync(DATA, 'utf8'));
      assert.ok(saved.users.length >= 5);
      assert.ok(saved.users.every((u) => !u.bot ? typeof u.hash === 'string' && u.hash.length === 128 : true));
      assert.ok(!JSON.stringify(saved).includes('newpass1'), 'plain-text passwords must never be stored');
    });
  } finally {
    sockets.forEach((s) => s.close());
    server.kill('SIGTERM');
    await wait(300);
    try { fs.unlinkSync(DATA); } catch (_) { /* ignore */ }
  }
  console.log(`\nAll ${passed} checks passed.\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
