#!/usr/bin/env node
// Turns raw calendar events into data/calendar.json, applying config/calendar-rules.json.
//
//   node scripts/normalize-calendar.mjs <raw.json> [--now 2026-11-25T16:00:00Z] [--source "label"]
//
// raw.json is an array of:
//   { "calendar": "Work", "title": "Screwfix shift", "start": ISO, "end": ISO,
//     "allDay": false, "recurring": false, "free": false }
// For all-day events start/end are YYYY-MM-DD with an exclusive end, as Google gives them.
// The raw file holds private detail; keep it outside the repo (raw/ is git-ignored).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;

export function stripEmoji(s) {
  return String(s || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classify(ev, cfg) {
  const title = stripEmoji(ev.title);
  for (const r of cfg.rules) {
    const m = new RegExp(r.match, 'i').exec(title);
    if (!m) continue;
    if (r.skip) return null;
    const label = (r.label || 'Busy').replace(/\$(\d)/g, (_, i) => (m[+i] || '').trim());
    return { cat: r.cat || 'other', label, routine: !!r.routine, window: !!r.window, away: !!r.away, light: !!r.light, matched: true };
  }
  if (ev.allDay) return null;
  return { ...cfg.default.timed, routine: false, window: false, away: false, light: false, matched: false };
}

const overlapMs = (a, b) => Math.min(a.e, b.e) - Math.max(a.s, b.s);

export function normalize(raw, cfg, now = new Date()) {
  const from = now.getTime() - cfg.windowDays.past * DAY;
  const to = now.getTime() + cfg.windowDays.future * DAY;
  let out = [];

  for (const ev of raw) {
    if (!ev || !ev.start) continue;
    const c = classify(ev, cfg);
    if (!c) continue;
    // "Free" timed entries are reminders, not commitments, unless a rule says they are a window.
    if (!ev.allDay && ev.free && cfg.skipFreeTimed && !c.window && c.cat !== 'trip') continue;
    const s = new Date(ev.allDay ? ev.start + 'T00:00:00Z' : ev.start).getTime();
    const e = new Date(ev.allDay ? ev.end + 'T00:00:00Z' : ev.end || ev.start).getTime();
    if (!(e > from && s < to)) continue;
    out.push({
      s, e,
      start: ev.allDay ? ev.start : new Date(s).toISOString(),
      end: ev.allDay ? ev.end : new Date(e).toISOString(),
      allDay: !!ev.allDay,
      cat: c.cat,
      label: c.label,
      routine: c.routine || !!ev.recurring,
      window: c.window,
      away: c.away,
      light: c.light,
    });
  }

  // De-duplicate (two booking confirmations for the same check-in, etc).
  const seen = new Set();
  out = out.filter((x) => {
    const k = [x.start, x.end, x.cat, x.label].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.s - b.s || a.e - b.e);

  const timed = out.filter((x) => !x.allDay && !x.window);
  const awaySpans = out.filter((x) => x.allDay && x.away);

  for (const x of timed) {
    if (!x.routine) continue;
    // A routine session (timetable, recurring training) loses to a trip away...
    const trip = awaySpans.find((a) => x.s >= a.s && x.s < a.e);
    if (trip) { x.clash = trip.label; continue; }
    // ...and to any one-off commitment it overlaps by more than 10 minutes.
    const other = timed.find((y) => y !== x && !y.routine && overlapMs(x, y) > 10 * 60000);
    if (other) x.clash = other.label;
  }
  // If the journey to a session is swallowed by a one-off journey, the session goes too.
  for (const x of timed) {
    if (!x.clash || x.cat !== 'travel') continue;
    const blocker = timed.find((y) => !y.routine && y.label === x.clash && (y.cat === 'travel' || y.cat === 'trip') && y.s <= x.s && y.e >= x.e);
    if (!blocker) continue;
    const next = timed.find((y) => y.routine && !y.clash && y.s === x.e);
    if (next) next.clash = x.clash;
  }

  return out.map(({ s, e, away, ...x }) => {
    const o = { start: x.start, end: x.end, cat: x.cat, label: x.label };
    if (x.allDay) o.allDay = true;
    if (x.routine) o.routine = true;
    if (x.window) o.window = true;
    if (away) o.away = true;
    if (x.light) o.light = true;
    if (x.clash) o.clash = x.clash;
    return o;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  if (!file) { console.error('usage: normalize-calendar.mjs <raw.json> [--now ISO] [--source text]'); process.exit(2); }
  const cfg = JSON.parse(readFileSync(join(root, 'config/calendar-rules.json'), 'utf8'));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const now = opt('now') ? new Date(opt('now')) : new Date();
  const events = normalize(raw, cfg, now);
  const doc = {
    updatedAt: now.toISOString(),
    source: opt('source') || 'Google Calendar',
    timezone: cfg.timezone,
    events,
  };
  writeFileSync(join(root, 'data/calendar.json'), JSON.stringify(doc, null, 1) + '\n');
  const unknown = events.filter((e) => e.label === 'Busy').length;
  console.log(`calendar.json: ${events.length} events from ${raw.length} raw (${unknown} shown as "Busy", ${events.filter((e) => e.clash).length} clashes)`);
}
