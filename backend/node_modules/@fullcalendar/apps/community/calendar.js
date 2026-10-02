'use strict';
/**
 * Calendar for StudyHub (port of the "live-calendar" Supabase design to StudyHub's own server).
 *
 *  - Students keep personal events and see the events of the courses they joined (read-only).
 *  - Teachers create courses and course events, and see how many students completed each one.
 *  - Recurring events are stored once (RRULE) with per-occurrence overrides.
 *  - Completion is per person: one student ticking "done" never affects another.
 *  - Everything is live over Socket.IO, and reminders arrive as notifications.
 *
 * The permission rules that Supabase enforced with row-level security are enforced here in the API.
 */
const crypto = require('crypto');
const { expand, validateRule, isValidTimeZone, DAY } = require('./lib/recurrence');

const EVENT_TYPES = ['exam', 'test', 'assignment', 'class', 'meeting', 'study_session', 'reminder'];
const TYPE_LABELS = {
  exam: 'exam', test: 'test', assignment: 'assignment', class: 'class', meeting: 'meeting',
  study_session: 'study session', reminder: 'reminder',
};
const MAX_RANGE_DAYS = 120;
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos

module.exports = function mountCalendar(ctx) {
  const { app, io, db, save, uid, auth, wrap, HttpError, clean, notify, tick, userById, pubUser } = ctx;

  const isTeacher = (u) => u.role === 'teacher';
  const courseById = (id) => db.courses.find((c) => c.id === id);
  const eventById = (id) => db.events.find((e) => e.id === id);
  const isEnrolled = (userId, courseId) => db.enrollments.some((e) => e.courseId === courseId && e.studentId === userId);
  const studentsOf = (courseId) => db.enrollments.filter((e) => e.courseId === courseId).map((e) => e.studentId);

  function canSee(user, ev) {
    return ev.ownerId === user.id || (ev.scope === 'course' && isEnrolled(user.id, ev.courseId));
  }
  function audience(ev) {
    return ev.scope === 'course' ? [...new Set([ev.ownerId, ...studentsOf(ev.courseId)])] : [ev.ownerId];
  }
  function emitTo(userIds, event, payload) {
    const rooms = [...new Set(userIds)].map((id) => 'user:' + id);
    if (rooms.length) io.to(rooms).emit(event, payload);
  }
  const calendarChanged = (ids) => emitTo(ids, 'calendar:changed', {});
  const coursesChanged = (ids) => emitTo(ids, 'courses:changed', {});

  const pubCourse = (c, viewer) => {
    const out = {
      id: c.id, name: c.name, code: c.code || '', teacherId: c.teacherId,
      studentCount: studentsOf(c.id).length, createdAt: c.createdAt,
    };
    if (c.teacherId === viewer.id) out.joinCode = c.joinCode;
    return out;
  };

  const pubEvent = (e) => ({
    id: e.id, ownerId: e.ownerId, courseId: e.courseId, scope: e.scope, type: e.type, title: e.title,
    description: e.description || '', location: e.location || '', start: e.startAt, end: e.endAt,
    allDay: !!e.allDay, reminderMinutes: e.reminderMinutes, repeatRule: e.repeatRule, tz: e.tz,
  });

  /* ================================================================== */
  /* Courses                                                             */
  /* ================================================================== */
  function findOwnCourse(req) {
    const course = courseById(req.params.id);
    if (!course) throw new HttpError(404, 'Course not found.');
    if (course.teacherId !== req.user.id) throw new HttpError(403, 'Only the teacher of this course can do this.');
    return course;
  }

  app.get('/api/courses', auth, wrap((req, res) => {
    const list = isTeacher(req.user)
      ? db.courses.filter((c) => c.teacherId === req.user.id)
      : db.courses.filter((c) => isEnrolled(req.user.id, c.id));
    res.json({ courses: list.map((c) => pubCourse(c, req.user)) });
  }));

  app.post('/api/courses', auth, wrap((req, res) => {
    if (!isTeacher(req.user)) throw new HttpError(403, 'Only teachers can create courses.');
    if (db.courses.filter((c) => c.teacherId === req.user.id).length >= 20) throw new HttpError(400, 'You can have up to 20 courses.');
    const name = clean(req.body.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Give the course a name (at least 2 characters).');
    let joinCode;
    do {
      joinCode = Array.from({ length: 6 }, () => JOIN_ALPHABET[crypto.randomInt(JOIN_ALPHABET.length)]).join('');
    } while (db.courses.some((c) => c.joinCode === joinCode));
    const course = {
      id: uid(), name, code: clean(req.body.code, 12).toUpperCase(), teacherId: req.user.id, joinCode, createdAt: Date.now(),
    };
    db.courses.push(course);
    save();
    coursesChanged([req.user.id]);
    res.status(201).json({ course: pubCourse(course, req.user) });
  }));

  app.post('/api/courses/join', auth, wrap((req, res) => {
    if (isTeacher(req.user)) throw new HttpError(403, 'Teachers create courses. Students join them with a code.');
    const code = clean(req.body.joinCode, 12).toUpperCase().replace(/\s+/g, '');
    const course = db.courses.find((c) => c.joinCode === code);
    if (!code || !course) throw new HttpError(404, 'No course has that code. Check it with your teacher.');
    if (isEnrolled(req.user.id, course.id)) throw new HttpError(409, 'You are already in this course.');
    db.enrollments.push({ id: uid(), courseId: course.id, studentId: req.user.id, enrolledAt: Date.now() });
    notify(course.teacherId, { type: 'course', text: `${req.user.name} joined ${course.name}`, link: '#/dashboard' });
    save();
    coursesChanged([req.user.id, course.teacherId]);
    calendarChanged([req.user.id]);
    res.status(201).json({ course: pubCourse(course, req.user) });
  }));

  app.get('/api/courses/:id/students', auth, wrap((req, res) => {
    const course = findOwnCourse(req);
    const students = studentsOf(course.id).map(userById).filter(Boolean).map((u) => pubUser(u));
    res.json({ students });
  }));

  app.post('/api/courses/:id/students', auth, wrap((req, res) => {
    const course = findOwnCourse(req);
    const username = clean(req.body.username, 20).toLowerCase().replace(/^@/, '');
    const student = db.users.find((u) => u.username === username);
    if (!student || student.bot) throw new HttpError(404, 'No member has that username.');
    if (isTeacher(student)) throw new HttpError(400, 'Only students can be added to a course.');
    if (isEnrolled(student.id, course.id)) throw new HttpError(409, `${student.name} is already in this course.`);
    db.enrollments.push({ id: uid(), courseId: course.id, studentId: student.id, enrolledAt: Date.now() });
    notify(student.id, { type: 'course', text: `You were added to ${course.name}`, link: '#/dashboard' });
    save();
    coursesChanged([student.id, req.user.id]);
    calendarChanged([student.id]);
    res.status(201).json({ student: pubUser(student) });
  }));

  // A teacher removes a student, or a student leaves.
  app.delete('/api/courses/:id/students/:userId', auth, wrap((req, res) => {
    const course = courseById(req.params.id);
    if (!course) throw new HttpError(404, 'Course not found.');
    const self = req.params.userId === req.user.id;
    if (!self && course.teacherId !== req.user.id) throw new HttpError(403, 'Only the teacher can remove students.');
    if (!isEnrolled(req.params.userId, course.id)) throw new HttpError(404, 'That student is not in this course.');
    db.enrollments = db.enrollments.filter((e) => !(e.courseId === course.id && e.studentId === req.params.userId));
    const courseEventIds = new Set(db.events.filter((e) => e.courseId === course.id).map((e) => e.id));
    db.completions = db.completions.filter((c) => !(courseEventIds.has(c.eventId) && c.userId === req.params.userId));
    save();
    coursesChanged([req.params.userId, course.teacherId]);
    calendarChanged([req.params.userId, course.teacherId]);
    res.json({ ok: true });
  }));

  app.delete('/api/courses/:id', auth, wrap((req, res) => {
    const course = findOwnCourse(req);
    const people = [course.teacherId, ...studentsOf(course.id)];
    const eventIds = new Set(db.events.filter((e) => e.courseId === course.id).map((e) => e.id));
    db.events = db.events.filter((e) => !eventIds.has(e.id));
    db.overrides = db.overrides.filter((o) => !eventIds.has(o.eventId));
    db.completions = db.completions.filter((c) => !eventIds.has(c.eventId));
    db.enrollments = db.enrollments.filter((e) => e.courseId !== course.id);
    db.courses = db.courses.filter((c) => c.id !== course.id);
    save();
    coursesChanged(people);
    calendarChanged(people);
    res.json({ ok: true });
  }));

  /* ================================================================== */
  /* Reading the calendar                                                */
  /* ================================================================== */
  function overrideMap(eventId) {
    const map = new Map();
    for (const o of db.overrides) if (o.eventId === eventId) map.set(o.occurrenceStart, o);
    return map;
  }

  function completionOf(ev, occ, userId, override) {
    if (ev.scope === 'personal') return ev.repeatRule ? !!(override && override.isCompleted) : !!ev.completed;
    return db.completions.some((c) => c.eventId === ev.id && c.userId === userId && (c.occurrenceStart || null) === (occ || null) && c.completed);
  }

  app.get('/api/calendar', auth, wrap((req, res) => {
    const from = Date.parse(req.query.start);
    const to = Date.parse(req.query.end);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) throw new HttpError(400, 'Give a valid start and end.');
    if (to - from > MAX_RANGE_DAYS * DAY) throw new HttpError(400, `Ask for at most ${MAX_RANGE_DAYS} days at a time.`);

    const out = [];
    for (const ev of db.events) {
      if (!canSee(req.user, ev)) continue;
      const course = ev.courseId ? courseById(ev.courseId) : null;
      const mine = ev.ownerId === req.user.id;
      const students = mine && ev.scope === 'course' ? new Set(studentsOf(ev.courseId)) : null;
      for (const occ of expand(ev, from, to, overrideMap(ev.id))) {
        const ov = occ.override;
        const item = {
          key: ev.id + (occ.occurrenceStart ? '::' + occ.occurrenceStart : ''),
          eventId: ev.id,
          occurrenceStart: occ.occurrenceStart,
          scope: ev.scope,
          courseId: ev.courseId,
          courseName: course ? course.name : null,
          courseCode: course ? course.code : null,
          ownerId: ev.ownerId,
          type: ev.type,
          title: (ov && ov.overrideTitle) || ev.title,
          description: ov && ov.overrideDescription !== undefined && ov.overrideDescription !== null ? ov.overrideDescription : ev.description || '',
          location: ov && ov.overrideLocation !== undefined && ov.overrideLocation !== null ? ov.overrideLocation : ev.location || '',
          start: new Date(occ.startMs).toISOString(),
          end: new Date(occ.endMs).toISOString(),
          allDay: !!ev.allDay,
          reminderMinutes: ev.reminderMinutes,
          repeatRule: ev.repeatRule,
          isRecurring: !!ev.repeatRule,
          canEdit: mine,
          completed: completionOf(ev, occ.occurrenceStart, req.user.id, ov),
        };
        if (students) {
          item.totalStudents = students.size;
          item.completedCount = db.completions.filter((c) => c.eventId === ev.id && (c.occurrenceStart || null) === (occ.occurrenceStart || null) && c.completed && students.has(c.userId)).length;
        }
        out.push(item);
      }
    }
    out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    res.json({ events: out });
  }));

  /* ================================================================== */
  /* Creating and changing events                                        */
  /* ================================================================== */
  function readFields(body, existing) {
    const out = {};
    if (!existing || body.title !== undefined) {
      const title = clean(body.title, 120);
      if (!title) throw new HttpError(400, 'Give the event a title.');
      out.title = title;
    }
    if (!existing || body.type !== undefined) {
      if (!EVENT_TYPES.includes(body.type)) throw new HttpError(400, 'Pick an event type.');
      out.type = body.type;
    }
    if (body.description !== undefined) out.description = clean(body.description, 1000);
    if (body.location !== undefined) out.location = clean(body.location, 120);
    if (body.allDay !== undefined) out.allDay = !!body.allDay;
    if (!existing || body.start !== undefined || body.end !== undefined) {
      const s = Date.parse(body.start !== undefined ? body.start : existing && existing.startAt);
      const e = Date.parse(body.end !== undefined ? body.end : existing && existing.endAt);
      if (Number.isNaN(s) || Number.isNaN(e)) throw new HttpError(400, 'Pick a valid date and time.');
      if (e < s) throw new HttpError(400, 'The event cannot end before it starts.');
      if (e - s > 14 * DAY) throw new HttpError(400, 'An event can be at most 14 days long.');
      if (s < Date.UTC(2000, 0, 1) || s > Date.UTC(2100, 0, 1)) throw new HttpError(400, 'That date is out of range.');
      out.startAt = new Date(s).toISOString();
      out.endAt = new Date(e).toISOString();
    }
    if (body.reminderMinutes !== undefined) {
      if (body.reminderMinutes === null || body.reminderMinutes === '') out.reminderMinutes = null;
      else {
        const m = Number(body.reminderMinutes);
        if (!Number.isInteger(m) || m < 0 || m > 10080) throw new HttpError(400, 'Reminders can be set up to 7 days ahead.');
        out.reminderMinutes = m;
      }
    }
    if (body.repeatRule !== undefined) {
      if (!body.repeatRule) out.repeatRule = null;
      else if (validateRule(body.repeatRule)) out.repeatRule = body.repeatRule;
      else throw new HttpError(400, 'That repeat setting is not valid.');
    }
    if (body.tz !== undefined) {
      if (!isValidTimeZone(body.tz)) throw new HttpError(400, 'Unknown time zone.');
      out.tz = body.tz;
    }
    return out;
  }

  // e.g. "Mon, Oct 5, 9:00 AM", in the time zone the event was created in
  const whenText = (ev) => new Intl.DateTimeFormat('en-US', {
    timeZone: ev.tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ev.startAt));

  app.post('/api/events', auth, wrap((req, res) => {
    const scope = req.body.scope === 'course' ? 'course' : 'personal';
    let course = null;
    if (scope === 'course') {
      if (!isTeacher(req.user)) throw new HttpError(403, 'Only teachers can add events to a course.');
      course = courseById(req.body.courseId);
      if (!course || course.teacherId !== req.user.id) throw new HttpError(403, 'You can only add events to courses you teach.');
    }
    if (db.events.filter((e) => e.ownerId === req.user.id).length >= 500) throw new HttpError(400, 'You have reached the limit of 500 events. Delete some old ones.');
    const f = readFields(req.body, null);
    const now = Date.now();
    const ev = {
      id: uid(), ownerId: req.user.id, scope, courseId: course ? course.id : null, type: f.type, title: f.title,
      description: f.description || '', location: f.location || '', startAt: f.startAt, endAt: f.endAt,
      allDay: !!f.allDay, reminderMinutes: f.reminderMinutes === undefined ? null : f.reminderMinutes,
      repeatRule: f.repeatRule || null, tz: f.tz || 'UTC', completed: false, completedAt: null, createdAt: now, updatedAt: now,
    };
    db.events.push(ev);
    if (course) {
      for (const id of studentsOf(course.id)) {
        notify(id, { type: 'event', text: `New ${TYPE_LABELS[ev.type]} in ${course.name}: ${ev.title} (${whenText(ev)})`, link: '#/dashboard' });
      }
    }
    save();
    calendarChanged(audience(ev));
    res.status(201).json({ event: pubEvent(ev) });
  }));

  function ownEvent(req) {
    const ev = eventById(req.params.id);
    if (!ev || !canSee(req.user, ev)) throw new HttpError(404, 'Event not found. It may have been deleted.');
    if (ev.ownerId !== req.user.id) throw new HttpError(403, 'Only the person who created this event can change it.');
    return ev;
  }

  app.patch('/api/events/:id', auth, wrap((req, res) => {
    const ev = ownEvent(req);
    const body = { ...req.body };
    // "All events in the series": move the whole series by the same amount the dragged occurrence moved
    if (body.shiftStartMs !== undefined || body.shiftEndMs !== undefined) {
      const a = Number(body.shiftStartMs || 0);
      const b = Number(body.shiftEndMs || 0);
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 366 * DAY || Math.abs(b) > 366 * DAY) throw new HttpError(400, 'That move is too large.');
      body.start = new Date(Date.parse(ev.startAt) + a).toISOString();
      body.end = new Date(Date.parse(ev.endAt) + b).toISOString();
    }
    const f = readFields(body, ev);
    const scheduleChanged = (f.startAt && f.startAt !== ev.startAt) || (f.repeatRule !== undefined && f.repeatRule !== ev.repeatRule) || (f.tz && f.tz !== ev.tz);
    Object.assign(ev, f, { updatedAt: Date.now() });
    if (scheduleChanged) {
      // occurrence keys are derived from the schedule, so old per-occurrence edits no longer apply
      db.overrides = db.overrides.filter((o) => o.eventId !== ev.id);
      db.completions = db.completions.filter((c) => !(c.eventId === ev.id && c.occurrenceStart));
    }
    if (scheduleChanged && ev.scope === 'course' && (!ev.lastNotifiedAt || Date.now() - ev.lastNotifiedAt > 30000)) {
      ev.lastNotifiedAt = Date.now();
      const course = courseById(ev.courseId);
      for (const id of studentsOf(ev.courseId)) {
        notify(id, { type: 'event', text: `Schedule change in ${course ? course.name : 'your course'}: ${ev.title} (${whenText(ev)})`, link: '#/dashboard' });
      }
    }
    save();
    calendarChanged(audience(ev));
    res.json({ event: pubEvent(ev) });
  }));

  // Change ONE occurrence of a recurring event ("this event only").
  app.patch('/api/events/:id/occurrence', auth, wrap((req, res) => {
    const ev = ownEvent(req);
    if (!ev.repeatRule) throw new HttpError(400, 'This event does not repeat.');
    const key = Date.parse(req.body.occurrenceStart);
    if (Number.isNaN(key)) throw new HttpError(400, 'Missing occurrence.');
    const occurrenceStart = new Date(key).toISOString();
    let ov = db.overrides.find((o) => o.eventId === ev.id && o.occurrenceStart === occurrenceStart);
    if (!ov) {
      ov = { id: uid(), eventId: ev.id, occurrenceStart, isCancelled: false };
      db.overrides.push(ov);
    }
    if (req.body.start !== undefined || req.body.end !== undefined) {
      const s = Date.parse(req.body.start);
      const e = Date.parse(req.body.end);
      if (Number.isNaN(s) || Number.isNaN(e) || e < s) throw new HttpError(400, 'Pick a valid date and time.');
      ov.overrideStart = new Date(s).toISOString();
      ov.overrideEnd = new Date(e).toISOString();
    }
    if (req.body.title !== undefined) {
      const title = clean(req.body.title, 120);
      if (!title) throw new HttpError(400, 'Give the event a title.');
      ov.overrideTitle = title;
    }
    if (req.body.location !== undefined) ov.overrideLocation = clean(req.body.location, 120);
    if (req.body.description !== undefined) ov.overrideDescription = clean(req.body.description, 1000);
    ov.isCancelled = false;
    save();
    calendarChanged(audience(ev));
    res.json({ ok: true });
  }));

  app.delete('/api/events/:id', auth, wrap((req, res) => {
    const ev = ownEvent(req);
    const occurrence = req.query.occurrence;
    if (occurrence && ev.repeatRule) {
      const key = Date.parse(occurrence);
      if (Number.isNaN(key)) throw new HttpError(400, 'Missing occurrence.');
      const occurrenceStart = new Date(key).toISOString();
      let ov = db.overrides.find((o) => o.eventId === ev.id && o.occurrenceStart === occurrenceStart);
      if (!ov) { ov = { id: uid(), eventId: ev.id, occurrenceStart }; db.overrides.push(ov); }
      ov.isCancelled = true;
    } else {
      db.events = db.events.filter((e) => e.id !== ev.id);
      db.overrides = db.overrides.filter((o) => o.eventId !== ev.id);
      db.completions = db.completions.filter((c) => c.eventId !== ev.id);
    }
    save();
    calendarChanged(audience(ev));
    res.json({ ok: true });
  }));

  // Mark done / not done for the person asking. Never touches anyone else's status.
  app.post('/api/events/:id/complete', auth, wrap((req, res) => {
    const ev = eventById(req.params.id);
    if (!ev || !canSee(req.user, ev)) throw new HttpError(404, 'Event not found. It may have been deleted.');
    const done = req.body.completed !== false;
    let occ = null;
    if (ev.repeatRule) {
      const key = Date.parse(req.body.occurrenceStart);
      if (Number.isNaN(key)) throw new HttpError(400, 'Missing occurrence.');
      occ = new Date(key).toISOString();
    }
    const stamp = done ? new Date().toISOString() : null;
    if (ev.scope === 'personal') {
      if (!ev.repeatRule) { ev.completed = done; ev.completedAt = stamp; }
      else {
        let ov = db.overrides.find((o) => o.eventId === ev.id && o.occurrenceStart === occ);
        if (!ov) { ov = { id: uid(), eventId: ev.id, occurrenceStart: occ, isCancelled: false }; db.overrides.push(ov); }
        ov.isCompleted = done;
        ov.completedAt = stamp;
      }
    } else {
      let row = db.completions.find((c) => c.eventId === ev.id && c.userId === req.user.id && (c.occurrenceStart || null) === occ);
      if (!row) { row = { id: uid(), eventId: ev.id, occurrenceStart: occ, userId: req.user.id }; db.completions.push(row); }
      row.completed = done;
      row.completedAt = stamp;
    }
    save();
    calendarChanged([req.user.id, ev.ownerId]);
    res.json({ ok: true, completed: done });
  }));

  /* ================================================================== */
  /* Reminders: turned into notifications (toast + bell + optional OS alert) */
  /* ================================================================== */
  function checkReminders() {
    const now = Date.now();
    for (const ev of db.events) {
      if (ev.reminderMinutes === null || ev.reminderMinutes === undefined) continue;
      const lead = ev.reminderMinutes * 60000;
      let occurrences;
      try { occurrences = expand(ev, now, now + lead + 60000, overrideMap(ev.id)); } catch (_) { continue; }
      for (const occ of occurrences) {
        const remindAt = occ.startMs - lead;
        const stillUseful = lead === 0 ? now < occ.startMs + 60000 : now < occ.startMs;
        if (remindAt > now || !stillUseful) continue;
        const course = ev.courseId ? courseById(ev.courseId) : null;
        const ov = occ.override;
        const title = (ov && ov.overrideTitle) || ev.title;
        for (const userId of audience(ev)) {
          const key = `${ev.id}|${occ.occurrenceStart || '-'}|${userId}`;
          if (db.reminded[key]) continue;
          db.reminded[key] = occ.startMs;
          if (completionOf(ev, occ.occurrenceStart, userId, ov)) continue;
          const mins = Math.ceil((occ.startMs - now) / 60000);
          const label = course ? `${course.name}: ${title}` : title;
          const text = mins <= 0 ? `${label} is starting now` : `${label} starts in ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
          notify(userId, { type: 'reminder', text, link: '#/dashboard' });
        }
      }
    }
    for (const [key, startMs] of Object.entries(db.reminded)) if (startMs < now - 3 * 3600000) delete db.reminded[key];
    save();
  }

  const tickMs = Math.max(500, Number(process.env.REMINDER_TICK_MS) || 30000);
  const timer = setInterval(() => { try { checkReminders(); } catch (err) { console.error('Reminder check failed:', err); } }, tickMs);
  timer.unref();
  return { checkReminders };
};
