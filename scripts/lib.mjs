// Shared helpers for the sync scripts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const dataPath = (name) => join(root, 'data', `${name}.json`);
export const readJson = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

export function localParts(t, timeZone) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) o[p.type] = p.value;
  return o;
}
export const dayKey = (t, tz) => { const p = localParts(t, tz); return `${p.year}-${p.month}-${p.day}`; };
export function zonedTime(key, hh, mm, tz) {
  // UTC instant for a wall-clock time on a calendar day in tz.
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = (t) => { const p = localParts(t, tz); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - t; };
  return guess - off(guess - off(guess));
}

// Write only when something other than the timestamp changed, or the file is getting old,
// so a scheduled job does not commit every run.
export function writeIfChanged(name, doc, maxAgeHours = 3) {
  const p = dataPath(name);
  const old = readJson(p);
  const strip = (o) => JSON.stringify({ ...o, updatedAt: null });
  if (old && strip(old) === strip(doc)) {
    const age = (Date.now() - Date.parse(old.updatedAt || 0)) / 3600000;
    if (age < maxAgeHours) { console.log(`${name}.json unchanged`); return false; }
  }
  writeFileSync(p, JSON.stringify(doc, null, 1) + '\n');
  console.log(`${name}.json written`);
  return true;
}
