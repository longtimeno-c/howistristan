#!/usr/bin/env node
// Refreshes data/github.json from the GitHub API. No dependencies.
//
//   node scripts/sync-github.mjs
//
// Environment:
//   GH_PAT        optional. A token belonging to the account itself (fine-grained, read-only is enough).
//                 Adds the daily contribution count, private work included.
//   GITHUB_TOKEN  optional. The Actions token; only raises the rate limit for public data.
//   GITHUB_EVENTS_FIXTURE  optional path to a saved events response, for offline testing.
//
// Only public repository names are ever written.

import { readFileSync } from 'node:fs';
import { dataPath, readJson, dayKey, localParts, writeIfChanged } from './lib.mjs';

const profile = readJson(dataPath('profile'), {});
const tz = profile.timezone || 'Europe/London';
const login = profile.github;
if (!login) { console.error('profile.json has no "github" login'); process.exit(1); }

const pat = process.env.GH_PAT || '';
const token = pat || process.env.GITHUB_TOKEN || '';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'status-page-sync', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function publicEvents() {
  if (process.env.GITHUB_EVENTS_FIXTURE) return JSON.parse(readFileSync(process.env.GITHUB_EVENTS_FIXTURE, 'utf8'));
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/events/public?per_page=100&page=${page}`, { headers });
    if (!r.ok) { if (page === 1) throw new Error(`events: HTTP ${r.status}`); break; }
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function contributions() {
  if (!pat) return null;
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 86400000);
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
  const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { login, from: from.toISOString(), to: to.toISOString() } }) });
  if (!r.ok) { console.warn(`contributions: HTTP ${r.status}, skipping`); return null; }
  const j = await r.json();
  const weeks = j?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) { console.warn('contributions: unexpected response, skipping'); return null; }
  const days = {};
  for (const w of weeks) for (const d of w.contributionDays) if (d.contributionCount > 0) days[d.date] = d.contributionCount;
  return days;
}

const VERB = { PushEvent: 'Pushed', PullRequestEvent: 'Pull request', CreateEvent: 'Created', IssuesEvent: 'Issue', ReleaseEvent: 'Release', PullRequestReviewEvent: 'Reviewed', IssueCommentEvent: 'Commented' };

const old = readJson(dataPath('github'), {});
let events;
try { events = await publicEvents(); } catch (e) { console.error(`Could not reach GitHub (${e.message}); leaving github.json alone.`); process.exit(0); }

events.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
const pushDays = {};
const pushByHour = Array(24).fill(0);
for (const e of events) {
  if (e.type !== 'PushEvent') continue;
  const t = Date.parse(e.created_at);
  pushDays[dayKey(t, tz)] = (pushDays[dayKey(t, tz)] || 0) + 1;
  pushByHour[+localParts(t, tz).hour]++;
}
const recent = events.filter((e) => VERB[e.type]).slice(0, 8).map((e) => ({ at: e.created_at, what: VERB[e.type], repo: String(e.repo?.name || '').split('/').pop() }));
const contrib = await contributions();

const doc = {
  updatedAt: new Date().toISOString(),
  source: contrib ? 'GitHub API: contribution calendar and public activity' : 'GitHub API: public activity',
  login,
  notes: old.notes || [],
  unit: contrib ? 'contributions' : old.unit || 'commits',
  days: contrib || old.days || {},
  pushDays: { ...(old.pushDays || {}), ...pushDays },
  pushByHour,
  recent,
  review: old.review,
};
// keep a rolling 60 days of push counts
const cutoff = dayKey(Date.now() - 60 * 86400000, tz);
for (const k of Object.keys(doc.pushDays)) if (k < cutoff) delete doc.pushDays[k];
writeIfChanged('github', doc);
console.log(`${events.length} public events, ${Object.keys(pushDays).length} day(s) with pushes${contrib ? `, ${Object.keys(contrib).length} day(s) with contributions` : ''}`);
