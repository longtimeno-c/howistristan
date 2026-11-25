#!/usr/bin/env node
// Refreshes data/calendar.json from Google Calendar's private iCal feeds.
//
//   GCAL_ICS_URLS="Work=https://calendar.google.com/calendar/ical/.../basic.ics
//   Sport=https://..." node scripts/sync-calendar.mjs
//
// GCAL_ICS_URLS holds one feed per line (or comma separated), optionally prefixed "Name=".
// Get each from Google Calendar > Settings > the calendar > "Secret address in iCal format".
// The feeds are secrets: they go in a repository secret, never in a file.
// A local .ics path also works in place of a URL, for testing.

process.env.TZ = 'UTC';
const { default: ical } = await import('node-ical');
const { readFileSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const { root, dayKey, localParts, zonedTime, writeIfChanged } = await import('./lib.mjs');
const { normalize } = await import('./normalize-calendar.mjs');

const cfg = JSON.parse(readFileSync(join(root, 'config/calendar-rules.json'), 'utf8'));
const tz = cfg.timezone || 'Europe/London';
const sources = (process.env.GCAL_ICS_URLS || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = /^([^=:/]+)=(.+)$/.exec(s);
  return m ? { name: m[1].trim(), loc: m[2].trim() } : { name: 'Calendar', loc: s };
});
if (!sources.length) { console.log('GCAL_ICS_URLS is not set; nothing to do.'); process.exit(0); }

const now = new Date();
const from = new Date(now.getTime() - (cfg.windowDays.past + 1) * 86400000);
const to = new Date(now.getTime() + (cfg.windowDays.future + 1) * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10);
const raw = [];

function push(name, ev, start, end, recurring) {
  if (ev.status === 'CANCELLED') return;
  const allDay = ev.datetype === 'date' || ev.start?.dateOnly === true;
  raw.push({
    calendar: name,
    title: typeof ev.summary === 'object' ? ev.summary?.val : ev.summary,
    start: allDay ? ymd(start) : start.toISOString(),
    end: allDay ? ymd(end) : end.toISOString(),
    allDay,
    recurring,
    free: ev.transparency === 'TRANSPARENT',
  });
}

let failed = 0;
for (const src of sources) {
  let data;
  try { data = existsSync(src.loc) ? ical.sync.parseFile(src.loc) : await ical.async.fromURL(src.loc); }
  catch (e) { failed++; console.error(`${src.name}: could not read feed (${e.message})`); continue; }
  let n = 0;
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const length = (ev.end || ev.start).getTime() - ev.start.getTime();
    if (!ev.rrule) {
      const end = ev.end || ev.start;
      if (end > from && ev.start < to) { push(src.name, ev, ev.start, end, false); n++; }
      continue;
    }
    const evTz = ev.start.tz || tz;
    const wall = localParts(ev.start.getTime(), evTz);
    for (const occ of ev.rrule.between(from, to, true)) {
      // Pin each occurrence to the original wall-clock time so daylight-saving changes cannot shift it.
      const key = dayKey(occ.getTime(), evTz);
      const allDay = ev.datetype === 'date';
      const start = allDay ? new Date(key + 'T00:00:00Z') : new Date(zonedTime(key, +wall.hour, +wall.minute, evTz));
      const utcKey = ymd(start);
      if (ev.exdate && (ev.exdate[key] || ev.exdate[utcKey])) continue;
      const over = ev.recurrences && (ev.recurrences[key] || ev.recurrences[utcKey]);
      if (over) push(src.name, over, over.start, over.end || over.start, true);
      else push(src.name, ev, start, new Date(start.getTime() + length), true);
      n++;
    }
  }
  console.log(`${src.name}: ${n} events in window`);
}
if (failed === sources.length) { console.error('No feed could be read; leaving calendar.json alone.'); process.exit(1); }

const events = normalize(raw, cfg, now);
writeIfChanged('calendar', {
  updatedAt: now.toISOString(),
  source: `Google Calendar (${sources.length - failed} calendar${sources.length - failed === 1 ? '' : 's'}), synced automatically`,
  timezone: tz,
  events,
});
console.log(`${events.length} events published, ${events.filter((e) => e.label === 'Busy').length} as "Busy"`);
