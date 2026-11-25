# Runbook for an agent keeping this page up to date

You are refreshing the data behind "How is Tristan", a public status page for one person.
The page is static. It reads the JSON files in `data/` and works out everything that depends
on the clock (current activity, energy, rest-day streak, the headline) in the browser.
Your job is only to keep those files true.

Do the steps below in order, run the check, commit, push. A full refresh takes a few minutes.

## Rules that do not bend

1. **This repository is public.** Publish labels, times and counts. Never publish:
   event descriptions, locations or addresses, attendees or anyone else's name, phone numbers,
   booking references, number plates, money, email subjects, recipients or text.
2. **Never invent a reading.** If the watch was off, write `{ "date": "...", "watch": "off" }`.
   If you have no figure, leave the field out. The page shows "no reading" on its own.
3. **Read-only on the accounts.** Do not send, label, delete or edit email, and do not create,
   move or respond to calendar events.
4. **Do not hand-edit `data/calendar.json`.** Change `config/calendar-rules.json` and re-run the
   normaliser, so the next run gives the same answer.
5. Set `updatedAt` (ISO 8601, UTC) on every file you change, and only on files you change.
6. Run `node scripts/check-data.mjs` before committing. If it fails, fix the data, not the check.

## Who owns which file

| File | Refreshed by | How often |
|---|---|---|
| `data/calendar.json` | you (step 1), or the workflow if `GCAL_ICS_URLS` is set | daily, or when plans change |
| `data/email.json` | you (step 2) | daily |
| `data/body.json` | you (step 3), only when Tristan supplies watch data | when supplied |
| `data/github.json` | the hourly workflow; you can run it too (step 4) | hourly |
| `data/history.json` | you (step 5) | Mondays |
| `data/notes.json` | you (step 6) | daily |
| `data/profile.json` | Tristan | rarely |

## 1. Calendar

Tools: the Google Calendar connector (`list_calendars`, `list_events`).

1. Call `list_calendars`. Use every calendar except shared family ones Tristan does not own.
2. For each calendar call `list_events` with `startTime` = three days ago at 00:00,
   `endTime` = 21 days ahead, `orderBy: "startTime"`, `pageSize: 250`. Follow `nextPageToken`.
3. Write the results to `raw/events.json` (the `raw/` folder is git-ignored; never commit it)
   as one array, one object per event:

   ```json
   { "calendar": "Work", "title": "<summary>", "start": "<start.dateTime or start.date>",
     "end": "<end.dateTime or end.date>", "allDay": false, "recurring": false, "free": false }
   ```

   - `allDay`: true when the event has `start.date` instead of `start.dateTime`.
   - `recurring`: true when the event has a `recurringEventId`, or comes from the imported
     university timetable.
   - `free`: true when `transparency` is `"transparent"` or `availability` is `AVAILABILITY_FREE`.
   - Copy nothing else. No description, no location.
4. Run:

   ```bash
   node scripts/normalize-calendar.mjs raw/events.json --source "Google Calendar, read by an agent"
   ```

5. Read the summary line. Events that match no rule are published as an anonymous **Busy** block.
   If a kind of event keeps turning up as Busy and it is not private, add a rule to
   `config/calendar-rules.json` (a regex, a category, a short generic label) and run it again.
   Categories: `work`, `uni`, `sport`, `raf`, `social`, `trip`, `travel`, `home`, `deadline`, `other`.
   Useful flags: `routine` (gives way to one-off events and trips), `light` (activity that does not
   break a rest day), `away` (all-day trip), `window` (an availability window, not a commitment),
   `skip` (never publish).
6. Delete `raw/events.json`.

## 2. Email

Tools: the Gmail connector (`search_threads`, `get_thread`).

1. Search `in:sent after:YYYY/MM/DD before:YYYY/MM/DD` covering the last 8 days through tomorrow,
   with `view: THREAD_VIEW_METADATA_ONLY`, `pageSize: 50`, following pages.
2. Search results show only the oldest few messages of each thread, so call `get_thread` for each
   thread and count every message that carries the `SENT` label. De-duplicate by message id.
3. Group by calendar day in Europe/London. For each day record the count and the time of the last
   send:

   ```json
   "2026-11-25": { "sent": 12, "lastSent": "16:19", "partial": true }
   ```

   Mark today `partial`. Keep the most recent 14 days in `days` and drop older ones.
4. Leave the `review` block alone unless Tristan gives you a new review to take figures from.

## 3. Sleep, heart and stress

There is no connector for the watch. Update `data/body.json` only from something Tristan has given
you: a Garmin export, a screenshot, or a new review document. One record per **wake date**:

```json
{ "date": "2026-11-25", "watch": "worn", "sleepH": 10.0, "score": 91, "quality": "Excellent",
  "needH": 7.2, "deepMin": 140, "remMin": 132, "restingHR": 48, "overnightHR": 56,
  "bodyBatteryGain": 79, "bodyBatteryWake": 84, "stress": 22, "hrv": 71, "wakeTime": "08:10" }
```

- `sleepH` is the sleep he woke with that morning. A night with the watch on and no sleep is `0`.
- `bodyBatteryWake` (the level on waking) and `wakeTime` make the energy figure exact; without them
  the page estimates both.
- `stress` is the overnight stress score; it feeds the load figure.
- Update `baseline` (usual resting HR and HRV) when a new review gives new averages.
- Keep at least the last 30 days.

## 4. GitHub

```bash
node scripts/sync-github.mjs
```

The workflow does this hourly, so only run it if the workflow is not enabled yet. It writes public
activity only. With a `GH_PAT` in the environment it also writes the daily contribution count.

## 5. Weekly history (Mondays)

In `data/history.json`:

- Close last week: set `hours` to the committed hours that actually happened (sum the day totals the
  page showed, which are merged scheduled hours excluding clashes) and remove `planned`.
- Set `avgSleepH` for that week from `body.json` (measured nights only).
- Add or update `planned` for this week and next from the calendar.
- If a genuine rest day happened (see `restRule` in `profile.json`), set `lastRestDay` to its date.
  Until then leave it `null`; the streak counts from `trackingSince`.
- Append yesterday's line to `days` when you know what the day held. Keep the last 21.

## 6. Watch-outs

`data/notes.json` holds up to five dated cautions and a few standing habits. They are judgement,
not measurement, so write them plainly and keep them short.

Flag a day when it has any of:

- a drive of an hour or more after a day of 12 committed hours, or after a night under 6 h;
- a start before 07:00 the morning after a finish past 23:00;
- a duty evening the night before an early shift, a flying day or a long drive;
- two commitments in different places at the same time that still need a decision.

Each note: `date`, `level` (`high`, `medium` or `low`), `title` (under eight words), `detail`
(what the day holds, then what would help). Remove notes dated before yesterday.
The page shows a banner for any `high` or `medium` note dated today or tomorrow.

## 7. Check, commit, publish

```bash
node scripts/check-data.mjs
git add data config
git commit -m "data: daily refresh"
git push
```

If the page is also published as a Claude artifact, rebuild and republish it to the same URL:

```bash
node scripts/build-artifact.mjs
```

then publish `dist/artifact.html` with the artifact's `url`, passing every `data/*.json` file in
`files` at the same relative path (`data/calendar.json` and so on).
Find the artifact by listing Tristan's artifacts and picking the one titled "How is Tristan".

## Running this on a schedule

Create a daily scheduled Claude task that starts a fresh session on this repository with the
Google Calendar and Gmail connectors, with this prompt:

> Follow AGENT.md in this repository: run the full refresh (steps 1, 2, 5 if it is Monday, 6, 7).
> Skip step 3 unless new watch data is attached. Commit to the default branch and push.
> Report only what changed and anything you could not do.
