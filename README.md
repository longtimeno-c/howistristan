# How is Tristan

A status page for one person. It answers the question in one line, shows what he is doing right
now, and draws his sleep, heart rate, energy, workload, email and GitHub activity on a body figure
and a few plain charts.

Open `index.html` through any static web server:

```bash
python3 -m http.server 8080
```

## How it stays current

| What | Where it comes from | Updates |
|---|---|---|
| Clock, current activity, progress bar, energy estimate, rest-day streak, headline | worked out in the browser from the calendar and last night's sleep | every 30 seconds, no data refresh needed |
| GitHub activity | `scripts/sync-github.mjs` in the workflow, plus a live read of public activity in the browser | every 15 minutes, and live |
| Calendar | either the workflow reading Google Calendar's private iCal feeds, or an agent with the Google Calendar connector | every 15 minutes, or daily |
| Emails sent | an agent with the Gmail connector (counts and times only) | daily |
| Heart rate, sleep score and stages, HRV, stress, Body Battery | the workflow reading Garmin Connect, once `GARMIN_TOKENS` is set; otherwise an agent, from watch data Tristan supplies | every 15 minutes, as fresh as the watch's last sync |
| Weekly history and watch-outs | an agent | weekly, daily |

Everything an agent does is written down in [AGENT.md](AGENT.md).

Each panel says when its data was last updated and turns amber when it is out of date.

## Turning on the automatic parts

1. **Merge this branch into `main`.** Scheduled workflows only run from the default branch.
2. **GitHub activity** then works with no setup. To count private work as well, create a
   fine-grained personal access token (read-only, no repository access needed) and save it as the
   repository secret `GH_PAT`.
3. **Calendar without an agent.** In Google Calendar, open Settings, pick a calendar, and copy
   "Secret address in iCal format". Do that for each calendar you want shown. Save them as the
   repository secret `GCAL_ICS_URLS`, one per line, each optionally named:

   ```
   Work=https://calendar.google.com/calendar/ical/…/basic.ics
   Sport=https://calendar.google.com/calendar/ical/…/basic.ics
   ```

   Those addresses give read access to the whole calendar, so they belong in a secret and nowhere else.
4. **Watch data from Garmin.** On your own computer, once:

   ```bash
   pip install -r requirements.txt
   ```

   ```bash
   python3 scripts/garmin-login.py | gh secret set GARMIN_TOKENS
   ```

   It asks for your Garmin email, password and two-factor code and stores a sign-in token as the
   secret. Your password is not kept. Garmin replaces that token from time to time, so the
   workflow has to be able to save the new one: give the `GH_PAT` token from step 2 the
   repository permission **Secrets: read and write** on this repository.

   What to expect:
   - Garmin offers no public feed for personal data. This uses the community `garminconnect`
     client, which speaks to the same service as the Garmin Connect app. It can break when Garmin
     changes something, and Garmin sometimes blocks sign-ins from data centres.
   - It is not a live stream. The watch hands its readings to your phone when it syncs, so the
     page is usually 15 minutes to an hour behind, and further behind when the phone is away.
   - Heart rate is published as 10-minute averages. Change `heart.bucketMin` in
     `data/profile.json` for finer or coarser.
   - If the first run writes nothing, run `python3 scripts/sync-garmin.py --shapes` locally with
     `GARMIN_TOKENS` set. It prints the field names Garmin returned, without the values.
5. **Email and notes** need an agent. Set up the daily scheduled task described at the end
   of AGENT.md.
6. **Hosting.** GitHub Pages serves the `gh-pages` branch at
   `https://longtimeno-c.github.io/howistristan/`. The workflow copies `main` to `gh-pages` at the
   end of every run and on every push to `main`, so there is nothing to deploy by hand.

## What gets published

This repository is public, and so is anything in `data/`. Calendar events are reduced to a short
label, a category and a time by `config/calendar-rules.json` before they are written. Descriptions,
locations, attendees and links are never copied. An event that matches no rule appears as "Busy".
Email is published as counts and times.

The page still says where Tristan is and when he is away. If that is more than you want public,
make the repository private, or set the trip rules in `config/calendar-rules.json` to `"skip": true`.

`node scripts/check-data.mjs` fails if a data file contains anything that looks like an email
address, phone number, postcode, number plate or link.

## Files

```
index.html                  the page
assets/style.css, app.js    styles and all the logic; no build step
data/*.json                 the data; see AGENT.md for each file's fields
config/calendar-rules.json  what calendar events may be shown as
scripts/normalize-calendar.mjs  raw events -> data/calendar.json
scripts/sync-calendar.mjs   iCal feeds -> data/calendar.json
scripts/sync-github.mjs     GitHub API -> data/github.json
scripts/sync-garmin.py      Garmin Connect -> data/heart.json and today's record in data/body.json
scripts/garmin-login.py     one-time Garmin sign-in, run on your own computer
scripts/check-data.mjs      validates data/ and looks for leaks
scripts/build-artifact.mjs  bundles the page into one file for hosts that wrap it
.github/workflows/update.yml  the job that runs every 15 minutes
```

## How the numbers are worked out

- **Committed hours**: scheduled time in the day, overlaps merged, clashes and all-day entries left out.
- **Rest day**: no work shift, no squadron evening or flying, no swim training or competition,
  nothing before 10:00, and at most three hours of other commitments. Surf lessons count as light.
- **Load**: committed hours, plus 2 for a start before 08:00, plus 2 for a finish after 22:00,
  plus overnight stress ÷ 10 when there is a reading.
- **Recovery**: hours slept plus overnight Body Battery gain ÷ 10.
- **Energy**: the level on waking (measured, or the overnight gain plus 5), minus 2.5 an hour awake,
  minus more for what the calendar held: 5 an hour on shift, 9 in the pool, 3.5 to 4.5 for most
  other things. It is an estimate and the page says so.
- **Headline**: last night's sleep against need, and the last seven days of sleep debt together
  with the days since a rest day.

None of this is medical advice.
