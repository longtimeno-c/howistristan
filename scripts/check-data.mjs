#!/usr/bin/env node
// Run before every commit that touches data/. Fails on broken JSON, missing fields,
// or anything that looks like private detail leaking into a public file.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const dir = join(root, 'data');
const problems = [];
const need = { profile: ['name', 'timezone'], calendar: ['updatedAt', 'events'], body: ['updatedAt', 'days'], email: ['updatedAt', 'days'], github: ['updatedAt', 'login'], history: ['updatedAt', 'weeks'], notes: ['updatedAt', 'watch'], heart: ['updatedAt', 'date', 'samples'] };
const leaks = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address'],
  [/(?:\+44\s?|\b0)7\d{3}\s?\d{6}\b/, 'a phone number'],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, 'a UK postcode'],
  [/https?:\/\/(?!github\.com)/, 'a link'],
  [/\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/, 'a number plate'],
];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const name = f.replace(/\.json$/, '');
  const text = readFileSync(join(dir, f), 'utf8');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { problems.push(`${f}: not valid JSON (${e.message})`); continue; }
  for (const k of need[name] || []) if (doc[k] == null) problems.push(`${f}: missing "${k}"`);
  if (doc.updatedAt && Number.isNaN(Date.parse(doc.updatedAt))) problems.push(`${f}: updatedAt is not a date`);
  for (const [re, what] of leaks) { const m = re.exec(text); if (m) problems.push(`${f}: contains what looks like ${what} ("${m[0]}")`); }
  if (name === 'calendar') for (const e of doc.events || []) {
    if (!e.start || !e.end || !e.label || !e.cat) problems.push(`${f}: event missing start/end/label/cat: ${JSON.stringify(e)}`);
    for (const k of Object.keys(e)) if (!['start', 'end', 'cat', 'label', 'allDay', 'routine', 'window', 'away', 'light', 'clash'].includes(k)) problems.push(`${f}: unexpected event field "${k}"`);
  }
  if (name === 'body') for (const d of doc.days || []) if (!/^\d{4}-\d\d-\d\d$/.test(d.date || '')) problems.push(`${f}: bad date in ${JSON.stringify(d)}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('data/ looks fine');
