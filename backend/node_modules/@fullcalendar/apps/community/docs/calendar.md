# Calendar: how it works

The calendar is a port of the **live-calendar** design (Supabase + React + FullCalendar) to StudyHub's own stack
(Express + Socket.IO + JSON file + plain JavaScript), so it uses the same accounts as chat and Q&A.
There is no second login and nothing else to set up.

## Where things are

| File | What it does |
| --- | --- |
| `lib/recurrence.js` | Expands a recurring event (RRULE) into occurrences, in the event's own time zone |
| `calendar.js` | API: courses, enrolments, events, occurrence overrides, completions, reminders |
| `public/js/views/dashboard.js` | The Home page: stats, calendar, Coming up, courses, latest announcement |
| `public/js/views/calendar.js` | FullCalendar wrapper and the event dialog |
| `public/js/views/courses.js` | Create / join courses, join codes, class list |

## Data (same shape as the original SQL schema)

- `courses`, `enrollments`: a teacher owns a course; students join with a 6 character code (or the teacher adds them).
- `events`: **one row per series**. `startAt` / `endAt` are UTC, `repeatRule` is an RFC 5545 RRULE, `tz` is the IANA
  zone the event was created in, `scope` is `personal` or `course`.
- `overrides`: change or cancel a **single occurrence** without copying the series ("this event only").
- `completions`: "done" per person for course events, so one student ticking a task never affects another.
  Personal one-off events use `events.completed`, personal recurring events use `overrides.isCompleted`.

## Who can do what (enforced in the API, like the RLS policies in the original)

| | Teacher | Student |
| --- | --- | --- |
| Personal events | create, edit, delete, drag | create, edit, delete, drag |
| Course events | create/edit/delete/drag for courses they teach | see only, read-only |
| Mark done | yes (own status) | yes, only their own |
| See how many students marked done | yes (per event) | no |
| Create / delete courses, manage class list | yes | join or leave only |

## Recurring events and time zones

Rules are expanded in the event's wall-clock time. "Every Monday 08:00" in Kathmandu stays Monday 08:00 there, and a
weekly 09:00 class in New York stays at 09:00 when daylight saving changes (both are covered by `npm test`).
An unbounded rule is always expanded for a limited date range only (max 120 days per request).

Editing or moving a recurring event asks **"only this event"** or **"all events in the series"**.
"Only this" writes an override; "all" moves/changes the series (this clears the one-off changes, because their keys
came from the old schedule).

## Live updates and reminders

- Every change emits `calendar:changed` / `courses:changed` over Socket.IO to the people affected, and their calendar
  refreshes immediately.
- The server checks every 30 seconds (`REMINDER_TICK_MS` to change) for events whose reminder time has come and sends
  a notification (toast + bell). Each person is reminded once per occurrence, and not if they already marked it done.
- The Home page has a "Turn on desktop reminders" button: with permission, the browser also shows a system notification
  while StudyHub is open in a tab.

## Not included (compared with the original plan)

- Background push when **no** StudyHub tab is open (service worker + VAPID keys + HTTPS). The design doc's "Tier 2".
  The reminder notifications wait in the bell instead.
- Per-user time zone setting. Times are shown in the viewer's browser time zone.
- "This and all following events" editing (only "this event" and "all events").
