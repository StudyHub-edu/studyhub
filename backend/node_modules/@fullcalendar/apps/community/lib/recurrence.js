'use strict';
/**
 * Recurrence engine (port of live-calendar's src/lib/recurrence.ts + timezone.ts).
 *
 * A recurring event is stored ONCE (start, end, RRULE string, timezone).
 * Occurrences are computed on demand for a date range.
 *
 * Time zones: the rule is expanded in the event's own "wall clock" time.
 * "Every Monday at 09:00" therefore stays at 09:00 local time all year, also
 * across daylight-saving changes, and BYDAY=MO means Monday where the event
 * lives (not Monday in UTC). Instants are stored and returned as UTC.
 */
const { rrulestr } = require('rrule');

const DAY = 24 * 60 * 60 * 1000;

/* ---------------- time zone helpers ---------------- */
const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 60) return false;
  try { formatter(tz); return true; } catch (_) { return false; }
}

/** Offset (ms, east of UTC) of a time zone at a given instant. */
function offsetAt(utcMs, tz) {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A real instant -> "floating" wall-clock time (a Date whose UTC fields show the local clock). */
const utcToWall = (utcMs, tz) => utcMs + offsetAt(utcMs, tz);

/** Wall-clock time in a zone -> the real instant. */
function wallToUtc(wallMs, tz) {
  let guess = wallMs - offsetAt(wallMs, tz);
  guess = wallMs - offsetAt(guess, tz);
  return guess;
}

/* ---------------- rule validation ---------------- */
const RULE_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST', 'BYSETPOS']);

function validateRule(rule) {
  if (typeof rule !== 'string' || !rule || rule.length > 200) return false;
  const seen = {};
  for (const part of rule.split(';')) {
    const m = part.match(/^([A-Z]+)=([A-Za-z0-9,+\-]+)$/);
    if (!m || !RULE_KEYS.has(m[1])) return false;
    seen[m[1]] = m[2];
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(seen.FREQ)) return false;
  if (seen.INTERVAL !== undefined && !(Number(seen.INTERVAL) >= 1 && Number(seen.INTERVAL) <= 52)) return false;
  if (seen.COUNT !== undefined && !(Number(seen.COUNT) >= 1 && Number(seen.COUNT) <= 1000)) return false;
  if (seen.UNTIL !== undefined && !/^\d{8}T\d{6}Z$/.test(seen.UNTIL)) return false;
  try { rrulestr(rule, { dtstart: new Date(Date.UTC(2024, 0, 1)) }); } catch (_) { return false; }
  return true;
}

/* ---------------- expansion ---------------- */
/**
 * Occurrences of `event` that overlap [rangeStartMs, rangeEndMs].
 * `overrides` is a Map: occurrenceStart ISO string -> override row.
 * Returns [{ occurrenceStart (ISO | null), startMs, endMs, override }]
 */
function expand(event, rangeStartMs, rangeEndMs, overrides = new Map(), maxCount = 400) {
  const startMs = Date.parse(event.startAt);
  const endMs = Date.parse(event.endAt);
  const duration = endMs - startMs;

  if (!event.repeatRule) {
    if (endMs < rangeStartMs || startMs > rangeEndMs) return [];
    return [{ occurrenceStart: null, startMs, endMs, override: null }];
  }

  const tz = event.tz || 'UTC';
  const rule = rrulestr(event.repeatRule, { dtstart: new Date(utcToWall(startMs, tz)) });
  // pad by a day so an occurrence moved by an override is still found
  const from = new Date(utcToWall(rangeStartMs - duration, tz) - DAY);
  const to = new Date(utcToWall(rangeEndMs, tz) + DAY);

  const out = [];
  for (const wall of rule.between(from, to, true)) {
    const occ = wallToUtc(wall.getTime(), tz);
    const key = new Date(occ).toISOString();
    const ov = overrides.get(key) || null;
    if (ov && ov.isCancelled) continue;
    const s = ov && ov.overrideStart ? Date.parse(ov.overrideStart) : occ;
    const e = ov && ov.overrideEnd ? Date.parse(ov.overrideEnd) : s + duration;
    if (e < rangeStartMs || s > rangeEndMs) continue;
    out.push({ occurrenceStart: key, startMs: s, endMs: e, override: ov });
    if (out.length >= maxCount) break;
  }
  return out;
}

module.exports = { expand, validateRule, isValidTimeZone, utcToWall, wallToUtc, offsetAt, DAY };
