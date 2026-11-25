/* How is Tristan — reads data/*.json and works out the rest from the clock.
   No build step, no dependencies. See AGENT.md for how the data is refreshed. */
(() => {
  'use strict';

  const FILES = ['profile', 'calendar', 'body', 'email', 'github', 'history', 'notes', 'heart'];
  const D = {};
  let TZ = 'Europe/London';
  let events = [];
  let liveGit = null;
  const HOUR = 3600000;

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round1 = (v) => Math.round(v * 10) / 10;
  const hrs = (v) => (Math.round(v * 10) / 10).toString().replace(/\.0$/, '');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'tip') { el.dataset.tip = v; el.tabIndex = 0; }
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const fill = (el, ...kids) => { el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); return el; };

  // ---------- time, always in Tristan's timezone ----------
  const fmts = {};
  const fmt = (opts) => {
    const k = TZ + JSON.stringify(opts);
    return fmts[k] || (fmts[k] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }));
  };
  function parts(t) {
    const o = {};
    for (const p of fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) o[p.type] = p.value;
    return o;
  }
  const dayKey = (t) => { const p = parts(t); return `${p.year}-${p.month}-${p.day}`; };
  const hm = (t) => { const p = parts(t); return `${p.hour}:${p.minute}`; };
  function tzOffset(t) {
    const p = parts(t);
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000;
  }
  function dayStart(key) {
    const [y, m, d] = key.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    const t = guess - tzOffset(guess);
    return guess - tzOffset(t);
  }
  const addDays = (key, n) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const keyFmt = (key, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(key + 'T12:00:00Z'));
  const dayName = (key) => keyFmt(key, { weekday: 'short', day: 'numeric', month: 'short' });
  function ago(t, now) {
    const m = Math.round((now - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 60 * 36) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  }
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  }

  // ---------- calendar maths ----------
  function prepEvents() {
    events = ((D.calendar && D.calendar.events) || []).map((e) =>
      e.allDay ? { ...e, s: dayStart(e.start), e: dayStart(e.end) } : { ...e, s: Date.parse(e.start), e: Date.parse(e.end) }
    ).filter((e) => e.e >= e.s).sort((a, b) => a.s - b.s);
  }
  const counts = (e) => !e.allDay && !e.window && !e.clash;
  function dayEvents(key) {
    const a = dayStart(key), b = dayStart(addDays(key, 1));
    return events.filter((e) => e.e > a && e.s < b);
  }
  function mergedHours(list, a, b) {
    const iv = list.map((e) => [Math.max(e.s, a), Math.min(e.e, b)]).filter((x) => x[1] > x[0]).sort((x, y) => x[0] - y[0]);
    let total = 0, cur = null;
    for (const x of iv) {
      if (cur && x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
      else { if (cur) total += cur[1] - cur[0]; cur = [...x]; }
    }
    if (cur) total += cur[1] - cur[0];
    return total / HOUR;
  }
  function calendarCovers(key) {
    if (!D.calendar || !events.length) return false;
    const first = dayKey(Math.min(Date.parse(D.calendar.updatedAt) || Infinity, events[0].s));
    const last = dayKey(events[events.length - 1].e - 1);
    return key >= first && key <= last;
  }
  function dayInfo(key) {
    const a = dayStart(key), b = dayStart(addDays(key, 1));
    const all = dayEvents(key);
    const live = all.filter(counts);
    const startsToday = live.filter((e) => e.s >= a);
    const hours = mergedHours(live, a, b);
    const first = startsToday.length ? Math.min(...startsToday.map((e) => e.s)) : null;
    const last = live.length ? Math.max(...live.map((e) => e.e)) : null;
    const rule = (D.profile && D.profile.restRule) || { noCats: ['work', 'raf'], noHardSport: true, earliestStart: '10:00', maxOtherHours: 3 };
    const hardSport = live.some((e) => e.cat === 'sport' && !e.light);
    const banned = live.some((e) => rule.noCats.includes(e.cat));
    const other = mergedHours(live.filter((e) => !(e.cat === 'sport' && e.light)), a, b);
    const early = first != null && hm(first) < rule.earliestStart;
    const covered = calendarCovers(key);
    const rest = covered && !banned && !(rule.noHardSport && hardSport) && !early && other <= rule.maxOtherHours;
    return {
      key, all, live, hours, first, last, rest, covered,
      earlyStart: first != null && hm(first) < '08:00',
      lateFinish: last != null && (last > b || hm(last) > '22:00'),
      away: all.find((e) => e.allDay && e.away),
    };
  }

  // ---------- body maths ----------
  const bodyDays = () => (D.body && D.body.days) || [];
  const bodyOn = (key) => bodyDays().find((d) => d.date === key);
  const measured = (d) => d && d.watch !== 'off' && d.sleepH != null;
  function sleepSummary(today) {
    const need = (D.profile && D.profile.sleepNeedH) || 8;
    const last7 = bodyDays().filter((d) => measured(d) && d.date > addDays(today, -7) && d.date <= today);
    const avg = last7.length ? last7.reduce((s, d) => s + d.sleepH, 0) / last7.length : null;
    const debt = last7.reduce((s, d) => s + Math.max(0, 7 - d.sleepH), 0);
    const latest = [...bodyDays()].reverse().find(measured);
    return { need, avg, debt, n: last7.length, latest, todayRec: bodyOn(today) };
  }
  // Watch readings pushed by scripts/sync-garmin.py. Optional: the page works without them.
  function liveHeart(now, today) {
    const hd = D.heart;
    if (!hd || !Array.isArray(hd.samples) || !hd.samples.length) return null;
    const at = hd.now ? Date.parse(hd.now.at) : NaN;
    const bbAt = hd.bodyBattery ? Date.parse(hd.bodyBattery.at) : NaN;
    return {
      ...hd, at, isToday: hd.date === today,
      fresh: hd.date === today && now - at < 45 * 60000,
      battery: hd.bodyBattery && hd.date === today && now - bbAt < 90 * 60000 ? { level: hd.bodyBattery.level, at: bbAt } : null,
    };
  }
  const RATE = { work: 5, sport: 9, uni: 3.5, travel: 4, social: 4.5, raf: 4.5, trip: 3, home: 3, other: 3.5 };
  const BASE_RATE = 2.5;
  function energy(now, today) {
    const lh = liveHeart(now, today);
    if (lh && lh.battery) return { level: Math.round(clamp(lh.battery.level, 0, 100)), measured: true, at: lh.battery.at };
    const b = bodyOn(today);
    if (!measured(b)) return null;
    const need = b.needH || (D.profile && D.profile.sleepNeedH) || 8;
    const wakeLevel = b.bodyBatteryWake != null ? b.bodyBatteryWake
      : b.bodyBatteryGain != null ? clamp(b.bodyBatteryGain + 5, 5, 100)
      : clamp(b.score != null ? b.score : (b.sleepH / need) * 80, 5, 100);
    const info = dayInfo(today);
    const a = dayStart(today);
    let wake = a + 8 * HOUR;
    if (b.wakeTime) { const [hh, mm] = b.wakeTime.split(':').map(Number); wake = a + hh * HOUR + mm * 60000; }
    else if (info.first != null) wake = Math.min(wake, info.first - HOUR);
    const until = Math.max(wake, now);
    let drain = ((until - wake) / HOUR) * BASE_RATE;
    for (const e of info.live) {
      const o = Math.min(e.e, until) - Math.max(e.s, wake);
      if (o > 0) drain += (o / HOUR) * Math.max(0, (e.light ? 6 : RATE[e.cat] || 3.5) - BASE_RATE);
    }
    return { level: Math.round(clamp(wakeLevel - drain, 5, 100)), wakeLevel: Math.round(wakeLevel), measuredWake: b.bodyBatteryWake != null };
  }
  function loadToday(today) {
    const info = dayInfo(today);
    const b = bodyOn(today);
    const pieces = [[`${hrs(info.hours)} h committed`, info.hours]];
    if (info.earlyStart) pieces.push(['start before 08:00', 2]);
    if (info.lateFinish) pieces.push(['finish after 22:00', 2]);
    if (b && b.stress != null) pieces.push([`overnight stress ${b.stress}`, b.stress / 10]);
    const load = pieces.reduce((s, p) => s + p[1], 0);
    const recovery = measured(b) ? b.sleepH + (b.bodyBatteryGain || 0) / 10 : null;
    return { load, recovery, pieces, info };
  }
  function restStreak(today) {
    const hist = D.history || {};
    const since = hist.lastRestDay ? addDays(hist.lastRestDay, 1) : (hist.trackingSince || (D.profile && D.profile.trackingSince));
    if (!since) return null;
    let start = since;
    for (let k = since; k <= today; k = addDays(k, 1)) if (calendarCovers(k) && dayInfo(k).rest) start = addDays(k, 1);
    let next = null;
    for (let i = 1; i <= 28 && !next; i++) { const k = addDays(today, i); if (calendarCovers(k) && dayInfo(k).rest) next = k; }
    return { days: Math.max(0, daysBetween(start, today) + 1), tracked: start === since && !hist.lastRestDay, since, next };
  }

  // ---------- the answer ----------
  function verdict(now, today) {
    const s = sleepSummary(today);
    const streak = restStreak(today);
    const rec = s.todayRec;
    let acute = 'unknown';
    if (measured(rec)) {
      const need = rec.needH || s.need;
      acute = rec.sleepH < 3 ? 'empty' : rec.sleepH < Math.min(6, need - 1.5) ? 'short' : 'well';
    } else if (rec && rec.watch === 'off') acute = 'unknown';
    const days = streak ? streak.days : 0;
    const chronic = s.debt >= 8 || days >= 21 ? 'overdrawn' : s.debt >= 4 || days >= 10 ? 'stretched' : 'fine';
    const table = {
      well: { fine: 'Doing well.', stretched: 'Rested, but stretched.', overdrawn: 'Rested today. Overdrawn overall.' },
      short: { fine: 'A bit tired.', stretched: 'Tired and stretched thin.', overdrawn: 'Running on fumes.' },
      empty: { fine: 'Running on empty today.', stretched: 'Running on empty.', overdrawn: 'Running on empty.' },
      unknown: { fine: 'Probably fine. No reading yet today.', stretched: 'Stretched. No reading yet today.', overdrawn: 'Overdrawn. No reading yet today.' },
    };
    const bits = [];
    if (measured(rec)) {
      const prev = bodyOn(addDays(today, -1));
      let line = `Slept ${hrs(rec.sleepH)} h last night`;
      if (measured(prev) && Math.abs(prev.sleepH - rec.sleepH) >= 3) line += `, after ${hrs(prev.sleepH)} h the night before`;
      bits.push(line + '.');
    } else if (s.latest) bits.push(`The last sleep reading is from ${dayName(s.latest.date)} (${hrs(s.latest.sleepH)} h).`);
    if (streak && streak.days >= 3) {
      let line = `No rest day in ${streak.days} days`;
      if (streak.next) line += `; the next one is ${dayName(streak.next)}`;
      bits.push(line + '.');
    } else if (streak && streak.days === 0) bits.push('Today is a rest day.');
    return { head: table[acute][chronic], sub: bits.join(' '), acute, chronic, sleep: s, streak };
  }

  function nowState(now, today) {
    const live = events.filter((e) => counts(e) && e.s <= now && now < e.e).sort((a, b) => b.s - a.s)[0] || null;
    const next = events.filter((e) => counts(e) && e.s > now).sort((a, b) => a.s - b.s)[0] || null;
    const info = dayInfo(today);
    const p = parts(now);
    const mins = +p.hour * 60 + +p.minute;
    const asleepGuess = !live && mins >= 90 && mins < 450;
    return { live, next, info, asleepGuess };
  }

  // ---------- rendering ----------
  const catName = { work: 'Work', uni: 'University', sport: 'Swim and surf', raf: 'Air squadron', social: 'Social and VP duty', trip: 'Trip', travel: 'Travel', other: 'Other', home: 'Other', deadline: 'Other' };
  const span = (e) => (e.allDay ? 'all day' : `${hm(e.s)} to ${hm(e.e)}`);
  const evTip = (e) => `${e.label}\n${span(e)}${e.clash ? `\nClashes with ${e.clash}` : ''}${e.window ? '\nAvailability window' : ''}`;

  function renderMast(now) {
    $('clock').textContent = `${fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(now)}, ${hm(now)} in ${(D.profile && D.profile.base) || 'UK'}`;
  }

  function renderAnswer(now, today) {
    const v = verdict(now, today);
    $('verdict').textContent = v.head;
    $('verdict-sub').textContent = v.sub;
    const st = nowState(now, today);
    const card = $('nowcard');
    const kids = [h('div', { class: 'label' }, 'Right now')];
    if (st.live) {
      const e = st.live;
      const pct = clamp(((now - e.s) / (e.e - e.s)) * 100, 0, 100);
      kids.push(
        h('div', { class: 'what' }, h('span', { class: `dot live cat-${e.cat}` }), e.label),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct), 'aria-label': 'Progress through this event' }, h('i', { style: `width:${pct}%` })),
        h('div', { class: 'meta' }, `${hm(e.s)} to ${hm(e.e)} · ${dur(e.e - now)} left`)
      );
    } else if (st.asleepGuess) {
      kids.push(h('div', { class: 'what' }, h('span', { class: 'dot' }), 'Probably asleep'), h('div', { class: 'meta' }, 'Nothing in the calendar, and it is the middle of the night'));
    } else {
      const free = st.next ? `Free for ${dur(st.next.s - now)}` : 'Nothing else in the calendar';
      kids.push(h('div', { class: 'what' }, h('span', { class: 'dot' }), st.info.away ? `Away: ${st.info.away.label}` : 'Between things'), h('div', { class: 'meta' }, free));
    }
    if (st.next) {
      const nk = dayKey(st.next.s);
      const when = nk === today ? `at ${hm(st.next.s)}` : nk === addDays(today, 1) ? `tomorrow at ${hm(st.next.s)}` : `${dayName(nk)} at ${hm(st.next.s)}`;
      kids.push(h('div', { class: 'next' }, 'Next: ', h('b', null, st.next.label), ` ${when}, until ${hm(st.next.e)}`));
    }
    fill(card, kids);
    return v;
  }

  function callout(side, y, part, value, unit, caption, state) {
    return h('div', { class: `callout ${side}`, style: `top:${(y / 420) * 100}%` },
      h('div', { class: 'label' }, part),
      h('div', { class: 'v' }, value, unit ? h('small', null, unit) : null),
      h('div', { class: 'c' }, caption),
      state ? h('div', { class: `state ${state[0]}` }, state[1]) : null);
  }

  function renderBody(now, today, v) {
    const stage = $('stage');
    const en = energy(now, today);
    const rec = v.sleep.todayRec;
    const latest = v.sleep.latest;
    const base = (D.body && D.body.baseline) || {};
    const ld = loadToday(today);

    // figure fill and heartbeat
    const level = en ? en.level : 0;
    const top = 406 - (level / 100) * 392;
    const g = $('fig-level');
    g.setAttribute('transform', `translate(0 ${top.toFixed(1)})`);
    g.setAttribute('class', `fig-fill${level < 30 ? ' low' : ''}`);
    g.style.display = en ? '' : 'none';
    const hrRec = [...bodyDays()].reverse().find((d) => d.restingHR != null);
    const lh = liveHeart(now, today);
    const bpm = lh && lh.fresh ? lh.now.bpm : hrRec ? hrRec.restingHR : 60;
    $('fig-heart').style.animationDuration = `${(60 / bpm).toFixed(2)}s`;
    $('figure').setAttribute('aria-label', en ? `Body figure filled to ${level} percent, the estimated energy level` : 'Body figure, no energy reading today');

    const out = [];
    // right side: head, heart, hand, legs
    if (measured(rec)) {
      const need = rec.needH || v.sleep.need;
      const st = rec.sleepH < 5 ? ['crit', 'very short'] : rec.sleepH < need - 1 ? ['warn', 'below need'] : ['good', 'met need'];
      out.push(callout('r', 50, 'Head · sleep', hrs(rec.sleepH), 'h', `last night${rec.score != null ? `, score ${rec.score}` : ''}. Need ${hrs(need)} h`, st));
    } else if (latest) {
      out.push(callout('r', 50, 'Head · sleep', '–', '', `No reading today. ${dayName(latest.date)}: ${hrs(latest.sleepH)} h`, ['none', rec && rec.watch === 'off' ? 'watch off' : 'waiting']));
    } else out.push(callout('r', 50, 'Head · sleep', '–', '', 'No sleep data yet', ['none', 'waiting']));

    if (lh && lh.fresh) {
      const rest = lh.resting != null ? lh.resting : hrRec ? hrRec.restingHR : null;
      out.push(callout('r', 150, 'Heart', lh.now.bpm, 'bpm', `at ${hm(lh.at)}, from the watch${rest != null ? `. Resting ${rest}` : ''}`, ['good', `synced ${ago(lh.at, now)}`]));
    } else if (hrRec) {
      const diff = base.restingHR != null ? hrRec.restingHR - base.restingHR : 0;
      const st = diff >= 5 ? ['warn', 'raised'] : ['good', 'normal'];
      const cap = `resting${hrRec.date !== today ? `, ${dayName(hrRec.date)}` : ''}${base.restingHR != null ? `. Usual ${base.restingHR}` : ''}${hrRec.hrv != null ? `. HRV ${hrRec.hrv} ms` : ''}`;
      out.push(callout('r', 150, 'Heart', hrRec.restingHR, 'bpm', cap, st));
    } else out.push(callout('r', 150, 'Heart', '–', '', 'No heart-rate data yet', ['none', 'waiting']));

    const em = D.email && D.email.days && D.email.days[today];
    const gh = D.github || {};
    let gitToday = null, gitWord = gh.unit || 'commits';
    if (gh.days && gh.days[today] != null) gitToday = gh.days[today];
    else {
      const pushes = (liveGit && liveGit.today) || (gh.pushDays && gh.pushDays[today]);
      if (pushes) { gitToday = pushes; gitWord = 'public pushes'; }
    }
    if (em) out.push(callout('r', 250, 'Hands · output', em.sent, em.sent === 1 ? 'email' : 'emails', `sent today${em.lastSent ? `, last at ${em.lastSent}` : ''}${gitToday != null ? `. ${gitToday} ${gitWord}` : ''}`, null));
    else if (gitToday != null) out.push(callout('r', 250, 'Hands · output', gitToday, gitWord, 'today. No email count yet', null));
    else out.push(callout('r', 250, 'Hands · output', '–', '', 'Nothing counted yet today', ['none', 'waiting']));

    const weekSport = [];
    for (let i = 0; i < 7; i++) weekSport.push(...dayInfo(addDays(today, i)).live.filter((e) => e.cat === 'sport' && e.s >= dayStart(addDays(today, i))));
    const nextSport = weekSport.find((e) => e.e > now);
    out.push(callout('r', 350, 'Legs · training', weekSport.length, weekSport.length === 1 ? 'session' : 'sessions', nextSport ? `in the next 7 days. Next: ${nextSport.label}, ${dayName(dayKey(nextSport.s))}` : 'in the next 7 days', null));

    // left side: shoulders, core, feet
    const lst = ld.info.hours >= 12 ? ['crit', 'heavy day'] : ld.info.hours >= 8 ? ['warn', 'full day'] : ld.info.hours > 0 ? ['good', 'light day'] : ['good', 'clear'];
    const span2 = ld.info.first != null && ld.info.last != null ? `${hm(ld.info.first)} to ${hm(ld.info.last)}` : 'nothing scheduled';
    out.push(callout('l', 90, 'Shoulders · load', hrs(ld.info.hours), 'h', `committed today, ${span2}`, lst));

    if (en) {
      const st = en.level < 30 ? ['crit', 'low'] : en.level < 55 ? ['warn', 'draining'] : ['good', 'charged'];
      out.push(callout('l', 200, 'Core · energy', `${en.level}`, '%', en.measured ? `Body Battery at ${hm(en.at)}, from the watch` : `estimate. Woke at about ${en.wakeLevel}%, drained by today's calendar`, st));
    } else out.push(callout('l', 200, 'Core · energy', '–', '', 'No estimate without last night\'s sleep', ['none', 'waiting']));

    if (v.streak) {
      const st = v.streak.days >= 21 ? ['crit', 'overdue'] : v.streak.days >= 10 ? ['warn', 'due'] : ['good', 'fine'];
      const cap = v.streak.days === 0 ? 'Today is a rest day' : `without a rest day${v.streak.tracked ? `, since ${dayName(v.streak.since).replace(/^\w+ /, '')}` : ''}${v.streak.next ? `. Next: ${dayName(v.streak.next)}` : ''}`;
      out.push(callout('l', 320, 'Feet · rest', v.streak.days, v.streak.days === 1 ? 'day' : 'days', cap, st));
    }
    stage.querySelectorAll('.callout').forEach((n) => n.remove());
    stage.append(...out);
  }

  function renderAlert(today) {
    const box = $('alert');
    const w = ((D.notes && D.notes.watch) || []).filter((n) => n.date >= today && n.date <= addDays(today, 1) && n.level !== 'low')[0];
    if (!w) { box.hidden = true; return; }
    box.hidden = false;
    box.className = `alert ${w.level === 'high' ? 'high' : ''}`;
    $('alert-title').textContent = `${w.date === today ? 'Today' : 'Tomorrow'}: ${w.title}`;
    $('alert-text').textContent = w.detail;
  }

  function track(key, now, mini) {
    const a = dayStart(key), b = dayStart(addDays(key, 1));
    const el = h('div', { class: `track${mini ? ' mini' : ''}`, role: 'img', 'aria-label': `Timeline for ${dayName(key)}` });
    for (const g of [6, 12, 18]) el.append(h('i', { class: 'grid', style: `left:${(g / 24) * 100}%` }));
    const list = dayEvents(key).filter((e) => !e.allDay);
    // draw clashes first so real commitments sit on top
    for (const e of [...list.filter((x) => x.clash), ...list.filter((x) => !x.clash)]) {
      const l = clamp((e.s - a) / (b - a), 0, 1) * 100;
      const r = clamp((e.e - a) / (b - a), 0, 1) * 100;
      el.append(h('button', { type: 'button', class: `ev ${e.clash ? 'clash' : e.window ? 'window' : `cat-${e.cat}`}`, style: `left:${l}%;width:${Math.max(r - l, 0.4)}%`, tip: evTip(e), 'aria-label': evTip(e).replace(/\n/g, ', ') }));
    }
    if (now >= a && now < b) {
      const p = ((now - a) / (b - a)) * 100;
      if (!mini) el.append(h('i', { class: 'past', style: `width:${p}%` }));
      el.append(h('i', { class: 'nowline', style: `left:calc(${p}% - 1px)` }));
    }
    return el;
  }

  function asof(id, file, now, maxAgeH) {
    const el = $(id);
    const t = D[file] && Date.parse(D[file].updatedAt);
    if (!t) { el.textContent = 'no data yet'; el.className = 'asof stale'; return; }
    const stale = now - t > maxAgeH * HOUR;
    el.textContent = `${stale ? 'Out of date: ' : ''}updated ${ago(t, now)}`;
    el.className = `asof${stale ? ' stale' : ''}`;
  }

  function renderToday(now, today) {
    const info = dayInfo(today);
    fill($('today-track'), track(today, now, false));
    const list = info.all.filter((e) => !e.allDay || e.cat !== 'deadline').sort((a, b) => a.s - b.s);
    const items = list.map((e) => {
      const cls = e.clash ? 'clash' : !e.allDay && e.e <= now ? 'done' : !e.allDay && e.s <= now && counts(e) ? 'live' : '';
      return h('li', { class: cls }, h('span', { class: `dot cat-${e.cat}` }), h('span', { class: 'n' }, e.label), h('span', { class: 't' }, e.clash ? `${span(e)} · clashes with ${e.clash}` : span(e)));
    });
    const targets = info.all.filter((e) => e.allDay && e.cat === 'deadline').map((e) => h('li', null, h('span', { class: 'dot cat-deadline' }), h('span', { class: 'n' }, e.label), h('span', { class: 't' }, 'self-set target for today')));
    fill($('today-list'), items.length || targets.length ? [...items, ...targets] : h('li', null, h('span', { class: 'n' }, 'Nothing in the calendar today')));
    $('today-sum').textContent = `${hrs(info.hours)} h committed${info.first != null ? `, ${hm(info.first)} to ${hm(info.last)}` : ''}`;
    asof('cal-asof', 'calendar', now, 26);
  }

  function renderDays(now, today) {
    const rows = [];
    const notes = (D.notes && D.notes.watch) || [];
    for (let i = 0; i < 14; i++) {
      const key = addDays(today, i);
      if (!calendarCovers(key) && i > 0) break;
      const info = dayInfo(key);
      const tags = [];
      if (info.rest) tags.push(h('span', { class: 'tag good' }, 'Rest day'));
      else if (info.hours >= 12) tags.push(h('span', { class: 'tag crit' }, 'Heavy'));
      if (info.earlyStart) tags.push(h('span', { class: 'tag warn' }, `${hm(info.first)} start`));
      if (info.lateFinish) tags.push(h('span', { class: 'tag warn' }, 'Late finish'));
      if (info.away) tags.push(h('span', { class: 'tag' }, info.away.label));
      const note = notes.find((n) => n.date === key && n.level === 'high');
      if (note) tags.push(h('span', { class: 'tag crit', tip: note.detail }, 'Watch'));
      const names = info.all.filter((e) => !e.allDay && !e.window).map((e) => (e.clash ? h('s', { title: `Clashes with ${e.clash}` }, e.label) : h('span', null, `${e.label} ${hm(e.s)}`)));
      rows.push(h('div', { class: `dayrow${i === 0 ? ' today' : ''}` },
        h('div', { class: 'd' }, keyFmt(key, { weekday: 'short', day: 'numeric' }), h('small', null, keyFmt(key, { month: 'short' }))),
        track(key, now, true),
        h('div', { class: 'h' }, hrs(info.hours), h('small', null, ' h')),
        h('div', { class: 'what' }, tags, names.length ? names : h('span', null, 'Nothing scheduled'))));
    }
    fill($('days'), rows.length ? rows : h('p', { class: 'hint' }, 'No calendar data yet.'));
  }

  function barChart(target, items, opt) {
    const max = opt.max || Math.max(1, ...items.map((i) => Math.max(i.value || 0, i.plan || 0)));
    const box = h('div', { class: `bars${opt.short ? ' short' : ''}`, role: 'img', 'aria-label': opt.label });
    for (const g of opt.guides || []) box.append(h('div', { class: 'guide', style: `bottom:${(g.at / max) * (100 - opt.padPct)}%` }, h('span', null, g.text)));
    for (const it of items) {
      const col = h('div', { class: 'col', tip: it.tip });
      const pct = (v) => `${clamp((v / max) * (100 - opt.padPct), 0, 100)}%`;
      if (it.off) col.append(h('div', { class: 'bar off' }));
      else if (it.plan != null) {
        const outer = h('div', { class: 'bar plan', style: `height:${pct(it.plan)}` });
        if (it.value) outer.append(h('div', { class: 'inner', style: `height:${(it.value / it.plan) * 100}%` }));
        col.append(outer);
      } else col.append(h('div', { class: `bar ${it.cls || ''}`, style: `height:${pct(it.value || 0)}` }));
      if (it.tick != null) col.append(h('i', { class: 'needtick', style: `bottom:${pct(it.tick)}` }));
      if (it.text != null) col.append(h('span', { class: 'val', style: `bottom:calc(${pct(Math.max(it.value || 0, it.plan || 0, it.off ? 0 : 0))} + 4px)` }, it.text));
      box.append(col);
    }
    const x = h('div', { class: 'xlabels' }, items.map((i) => h('span', null, i.x || '')));
    fill(target, box, x);
  }

  const minsText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`);
  function renderLastNight(now, today) {
    const panel = $('night-panel');
    const todayRec = bodyOn(today);
    const rec = measured(todayRec) ? todayRec : [...bodyDays()].reverse().find(measured);
    if (!rec) { panel.hidden = true; return; }
    panel.hidden = false;
    const isToday = rec.date === today;
    $('night-title').textContent = isToday ? 'Last night' : `Last measured night, woke ${dayName(rec.date)}`;
    $('night-hint').textContent = !isToday && todayRec && todayRec.watch === 'off' ? 'The watch was off last night, so this is the most recent night it recorded.'
      : !isToday ? 'Nothing from the watch for last night yet.' : rec.note || '';
    $('night-hint').hidden = !$('night-hint').textContent;

    // score dial
    const dial = $('night-dial');
    const has = rec.score != null;
    const tone = !has ? 'none' : rec.score >= 80 ? 'good' : rec.score >= 60 ? 'warn' : 'crit';
    const C = 2 * Math.PI * 52;
    dial.querySelector('.dial-arc').setAttribute('stroke-dasharray', `${has ? (rec.score / 100) * C : 0} ${C}`);
    dial.querySelector('.dial-arc').setAttribute('class', `dial-arc ${tone}`);
    $('night-score').textContent = has ? rec.score : '–';
    $('night-quality').textContent = has ? (rec.quality || 'Sleep score') : 'No score';
    dial.setAttribute('aria-label', has ? `Sleep score ${rec.score} out of 100, ${rec.quality || ''}` : 'No sleep score for this night');

    // stages
    const total = rec.sleepH * 60;
    const deep = rec.deepMin || 0, rem = rec.remMin || 0;
    const light = rec.lightMin != null ? rec.lightMin : Math.max(0, total - deep - rem);
    const awake = rec.awakeMin || 0;
    const stages = [['Deep', deep, 'st-deep'], ['Light', light, 'st-light'], ['REM', rem, 'st-rem'], ['Awake', awake, 'st-awake']].filter((x) => x[1] > 0);
    const sum = stages.reduce((a, x) => a + x[1], 0);
    const known = rec.deepMin != null || rec.remMin != null;
    fill($('night-stages'), total > 0 && known ? [
      h('div', { class: 'stagebar', role: 'img', 'aria-label': stages.map((x) => `${x[0]} ${minsText(x[1])}`).join(', ') }, stages.map((x) => h('i', { class: x[2], style: `flex:${x[1]} 1 0`, tip: `${x[0]}\n${minsText(x[1])}, ${Math.round((x[1] / sum) * 100)}%` }))),
      h('div', { class: 'stagekey' }, stages.map((x) => h('span', null, h('i', { class: x[2] }), `${x[0]} `, h('b', null, minsText(x[1]))))),
    ] : h('p', { class: 'hint', style: 'margin:0' }, total > 0 ? 'No sleep-stage breakdown for this night.' : 'No sleep was recorded.'));

    const need = rec.needH || (D.profile && D.profile.sleepNeedH) || 8;
    const cells = [[`${hrs(rec.sleepH)} h`, `slept, against a need of ${hrs(need)} h`]];
    if (rec.wakeTime) cells.push([rec.wakeTime, 'woke up']);
    if (rec.bodyBatteryGain != null) cells.push([`${rec.bodyBatteryGain >= 0 ? '+' : ''}${rec.bodyBatteryGain}`, `Body Battery recharged overnight${rec.bodyBatteryWake != null ? `, to ${rec.bodyBatteryWake}` : ''}`]);
    if (rec.restingHR != null) cells.push([`${rec.restingHR} bpm`, 'resting heart rate']);
    if (rec.overnightHR != null) cells.push([`${rec.overnightHR} bpm`, 'average heart rate overnight']);
    if (rec.hrv != null) cells.push([`${rec.hrv} ms`, 'overnight HRV']);
    if (rec.stress != null) cells.push([`${rec.stress}`, 'overnight stress, out of 100']);
    fill($('night-stats'), cells.map(([v, c]) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'c' }, c))));
  }

  function renderRecovery(now, today) {
    const days = [];
    const scores = [];
    for (let i = 13; i >= 0; i--) {
      const key = addDays(today, -i);
      const d = bodyOn(key);
      const xl = keyFmt(key, { day: 'numeric' });
      scores.push(measured(d) && d.score != null ? d.score : '');
      if (!d) days.push({ x: xl, value: 0, tip: `${dayName(key)}\nNo data`, cls: 'soft' });
      else if (!measured(d)) days.push({ x: xl, off: true, tip: `${dayName(key)}\nWatch off, night unknown` });
      else days.push({
        x: xl, value: d.sleepH, tick: d.needH, cls: d.sleepH < 5 ? 'crit' : '',
        text: d.sleepH < 5 || key === today || d.sleepH >= 12 ? hrs(d.sleepH) : null,
        tip: `${dayName(key)}\nSlept ${hrs(d.sleepH)} h${d.needH ? `, needed ${hrs(d.needH)} h` : ''}${d.score != null ? `\nScore ${d.score} ${d.quality || ''}` : ''}${d.restingHR != null ? `\nResting HR ${d.restingHR} bpm` : ''}${d.note ? `\n${d.note}` : ''}`,
      });
    }
    barChart($('sleep-chart'), days, { max: 14, padPct: 8, label: 'Hours slept each night for the last 14 nights', guides: [{ at: 7, text: '7 h' }] });
    if (scores.some((x) => x !== '')) $('sleep-chart').append(h('div', { class: 'xlabels scores', 'aria-label': 'Sleep score for each night' }, scores.map((x) => h('span', { class: x === '' ? '' : x >= 80 ? 'good' : x >= 60 ? 'warn' : 'crit' }, x))), h('div', { class: 'rowlabel' }, 'Sleep score out of 100'));
    $('sleep-title').textContent = `Sleep, last 14 nights (${keyFmt(addDays(today, -13), { day: 'numeric', month: 'short' })} to ${keyFmt(today, { day: 'numeric', month: 'short' })})`;
    const s = sleepSummary(today);
    const st = (D.history && D.history.stats) || {};
    const base = (D.body && D.body.baseline) || {};
    const cells = [];
    if (s.avg != null) cells.push([`${hrs(round1(s.avg))} h`, `average over the last 7 days (${s.n} measured night${s.n === 1 ? '' : 's'})`]);
    if (s.n) cells.push([`${hrs(round1(s.debt))} h`, 'sleep debt this week, counted as hours under 7']);
    if (st.nightsUnder5 != null) cells.push([`${st.nightsUnder5} of ${st.nightsMeasured}`, 'nights under 5 h since 8 Oct']);
    if (st.typicalBedtime) cells.push([st.typicalBedtime, 'typical bedtime']);
    if (base.hrv != null) cells.push([`${base.hrv} ms`, `average overnight HRV${base.hrvLow != null ? `, low of ${base.hrvLow}` : ''}`]);
    fill($('sleep-stats'), cells.map(([v, c]) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'c' }, c))));
    asof('body-asof', 'body', now, 30);
  }

  let heartHover = null;
  function renderHeart(now, today) {
    const panel = $('heart-panel');
    const lh = liveHeart(now, today);
    if (!lh) { panel.hidden = true; return; }
    panel.hidden = false;
    const pts = lh.samples.filter((p) => Array.isArray(p) && p[1] > 0);
    const vals = pts.map((p) => p[1]);
    const lo = Math.floor((Math.min(...vals, lh.resting || 999) - 6) / 10) * 10;
    const hi = Math.ceil((Math.max(...vals) + 6) / 10) * 10;
    const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
    const gap = (lh.bucketMin || 10) * 3;
    let d = '', area = '', segStart = null, prev = null;
    const closeArea = () => { if (segStart != null) area += `L${prev} 100L${segStart} 100Z`; };
    for (const [m, v] of pts) {
      if (prev == null || m - prev > gap) { closeArea(); d += `M${m} ${y(v).toFixed(1)}`; area += `M${m} ${y(v).toFixed(1)}`; segStart = m; }
      else { d += `L${m} ${y(v).toFixed(1)}`; area += `L${m} ${y(v).toFixed(1)}`; }
      prev = m;
    }
    closeArea();
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1440 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); svg.append(el); return el; };
    for (const g of [360, 720, 1080]) add('line', { x1: g, x2: g, y1: 0, y2: 100, class: 'hr-grid' });
    if (lh.resting != null) add('line', { x1: 0, x2: 1440, y1: y(lh.resting), y2: y(lh.resting), class: 'hr-rest' });
    add('path', { d: area, class: 'hr-area' });
    add('path', { d, class: 'hr-line' });
    const box = $('heart-chart');
    const last = pts[pts.length - 1];
    const kids = [svg];
    for (const t of [hi, Math.round((lo + hi) / 20) * 10, lo]) kids.push(h('span', { class: 'hr-y', style: `top:${y(t)}%` }, t));
    if (lh.resting != null) kids.push(h('span', { class: 'hr-restlabel', style: `top:${y(lh.resting)}%` }, `resting ${lh.resting}`));
    kids.push(h('i', { class: 'hr-dot', style: `left:${(last[0] / 1440) * 100}%;top:${y(last[1])}%` }));
    kids.push(h('span', { class: 'hr-now', style: `left:${(last[0] / 1440) * 100}%;top:${y(last[1])}%` }, `${last[1]}`));
    if (lh.isToday) { const p = parts(now); kids.push(h('i', { class: 'hr-clock', style: `left:${((+p.hour * 60 + +p.minute) / 1440) * 100}%` })); }
    const cross = h('i', { class: 'hr-cross', hidden: '' });
    kids.push(cross);
    fill(box, kids);
    box.setAttribute('aria-label', `Heart rate through ${lh.isToday ? 'today' : dayName(lh.date)}, from ${Math.min(...vals)} to ${Math.max(...vals)} beats per minute`);
    const label = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (heartHover) { box.removeEventListener('pointermove', heartHover); box.removeEventListener('pointerleave', heartHover); }
    heartHover = (e) => {
      const tip = $('tip');
      if (e.type === 'pointerleave') { cross.hidden = true; if (tip) tip.hidden = true; return; }
      const r = box.getBoundingClientRect();
      const m = ((e.clientX - r.left) / r.width) * 1440;
      const near = pts.reduce((a, b) => (Math.abs(b[0] - m) < Math.abs(a[0] - m) ? b : a));
      cross.hidden = false;
      cross.style.left = `${(near[0] / 1440) * 100}%`;
      if (!tip) return;
      tip.textContent = `${label(near[0])}\n${near[1]} bpm`;
      tip.hidden = false;
      const half = tip.offsetWidth / 2 + 8;
      tip.style.left = `${clamp(r.left + (near[0] / 1440) * r.width, half, window.innerWidth - half)}px`;
      tip.style.top = `${r.top + (y(near[1]) / 100) * r.height}px`;
      e.stopPropagation();
    };
    box.addEventListener('pointermove', heartHover);
    box.addEventListener('pointerleave', heartHover);
    $('heart-title').textContent = lh.isToday ? 'Heart rate today' : `Heart rate, ${dayName(lh.date)}`;
    const bits = [`${lh.bucketMin || 10}-minute averages from the watch`];
    if (!Number.isNaN(lh.at)) bits.push(`last reading ${lh.now.bpm} bpm at ${hm(lh.at)}, ${ago(lh.at, now)}`);
    if (lh.stress && lh.isToday) bits.push(`stress ${lh.stress.level}`);
    $('heart-hint').textContent = bits.join(' · ') + '. The watch only reports when it syncs to the phone.';
  }

  function renderLoad(now, today) {
    const weeks = (D.history && D.history.weeks) || [];
    const thisWeek = weeks.filter((w) => w.weekOf <= today).pop();
    barChart($('week-chart'), weeks.map((w) => ({
      x: keyFmt(w.weekOf, { day: 'numeric', month: 'short' }),
      value: w.hours || 0,
      plan: w.planned != null ? w.planned : null,
      text: w.planned != null ? hrs(w.planned) : hrs(w.hours),
      cls: w === thisWeek ? '' : '',
      tip: `Week of ${dayName(w.weekOf)}${w.partial ? ` (${w.partial})` : ''}\n${w.hours != null ? `${hrs(w.hours)} h done` : ''}${w.planned != null ? `${w.hours != null ? ', ' : ''}${hrs(w.planned)} h planned` : ''}${w.avgSleepH != null ? `\nAverage sleep ${hrs(w.avgSleepH)} h` : ''}`,
    })), { max: 84, padPct: 4, label: 'Committed hours per week', guides: [{ at: 40, text: '40 h' }] });

    const ld = loadToday(today);
    const scale = Math.max(20, ld.load, ld.recovery || 0);
    const rows = [
      h('span', null, 'Load'), h('div', { class: 'rail' }, h('i', { style: `width:${(ld.load / scale) * 100}%` })), h('span', { class: 'n' }, round1(ld.load)),
    ];
    if (ld.recovery != null) rows.push(h('span', null, 'Recovery'), h('div', { class: 'rail' }, h('i', { class: 'rec', style: `width:${(ld.recovery / scale) * 100}%` })), h('span', { class: 'n' }, round1(ld.recovery)));
    fill($('load-meter'), rows);
    let line;
    if (ld.recovery == null) line = [h('b', null, 'No recovery reading today.'), ` Load is ${ld.pieces.map((p) => p[0]).join(' + ')}.`];
    else {
      const strain = round1(ld.load - ld.recovery);
      line = [h('b', null, strain > 3 ? `Under-recovered by ${strain}.` : strain > 0 ? `Just short, by ${strain}.` : `Covered, with ${Math.abs(strain)} to spare.`), ` Load is ${ld.pieces.map((p) => p[0]).join(' + ')}. Recovery is hours slept plus overnight recharge ÷ 10.`];
    }
    fill($('load-line'), line);
    const st = (D.history && D.history.stats) || {};
    if (st.avgDailyLoad != null) $('load-avg').textContent = `Average daily load since 8 Oct: ${st.avgDailyLoad}.`;
  }

  function hourChart(target, arr, label, unit) {
    const max = Math.max(1, ...arr);
    const peak = arr.indexOf(max);
    barChart(target, arr.map((v, i) => ({
      x: i % 6 === 0 || i === 23 ? String(i).padStart(2, '0') : '',
      value: v, text: i === peak ? String(v) : null,
      tip: `${String(i).padStart(2, '0')}:00 to ${String(i).padStart(2, '0')}:59\n${v} ${unit}`,
    })), { max, padPct: 12, short: true, label });
  }

  function renderOutput(now, today) {
    const er = D.email && D.email.review;
    if (er) {
      hourChart($('email-chart'), er.byHourWritten, 'Emails written by hour of day', 'emails');
      $('email-hint').textContent = `${er.written} emails written by hand, ${keyFmt(er.from, { day: 'numeric', month: 'short' })} to ${keyFmt(er.to, { day: 'numeric', month: 'short' })}, by hour sent. Another ${er.automated} were automated.`;
    }
    const ed = (D.email && D.email.days) || {};
    const keys = Object.keys(ed).sort().slice(-8);
    if (keys.length) {
      barChart($('email-days'), keys.map((k) => ({
        x: keyFmt(k, { weekday: 'narrow' }) + ' ' + keyFmt(k, { day: 'numeric' }), value: ed[k].sent, text: String(ed[k].sent),
        cls: k === today ? '' : 'soft',
        tip: `${dayName(k)}${ed[k].partial && k === today ? ' (so far)' : ''}\n${ed[k].sent} sent${ed[k].lastSent ? `, last at ${ed[k].lastSent}` : ''}`,
      })), { padPct: 14, short: true, label: 'Emails sent per day' });
    }
    asof('email-asof', 'email', now, 30);

    const gr = D.github && D.github.review;
    if (gr) {
      hourChart($('git-chart'), gr.byHour, 'Commits by hour of day', 'commits');
      $('git-hint').textContent = `${gr.commits.toLocaleString('en-GB')} commits, ${keyFmt(gr.from, { day: 'numeric', month: 'short' })} to ${keyFmt(gr.to, { day: 'numeric', month: 'short' })}, by hour. Clusters after bedtime are agents working unattended.`;
    }
    const recent = (liveGit && liveGit.recent) || (D.github && D.github.recent) || [];
    const feed = $('git-feed');
    if (recent.length) {
      fill(feed, recent.slice(0, 5).map((r) => h('li', null, h('span', { class: 'r' }, `${r.what} · ${r.repo}`), h('span', { class: 'w' }, ago(Date.parse(r.at), now)))));
    } else {
      const gd = (D.github && D.github.days) || {};
      const last = Object.keys(gd).sort().slice(-4).reverse();
      fill(feed, last.length ? last.map((k) => h('li', null, h('span', { class: 'r' }, `${gd[k]} ${(D.github && D.github.unit) || 'commits'}`), h('span', { class: 'w' }, dayName(k)))) : h('li', null, h('span', { class: 'r' }, 'No activity recorded yet')));
    }
    $('git-feed-title').textContent = recent.length ? (liveGit ? 'Latest public activity, live from GitHub' : 'Latest public activity') : 'Recent days';
    const el = $('git-asof');
    if (liveGit) { el.textContent = `live, checked ${ago(liveGit.at, now)}`; el.className = 'asof'; } else asof('git-asof', 'github', now, 30);
    const login = (D.profile && D.profile.github) || (D.github && D.github.login);
    if (login) { const a = $('git-link'); a.href = `https://github.com/${encodeURIComponent(login)}`; a.textContent = `github.com/${login}`; }
  }

  function renderWatch(today) {
    const notes = (D.notes && D.notes.watch) || [];
    const upcoming = notes.filter((n) => n.date >= addDays(today, -1));
    fill($('watch'), upcoming.length ? upcoming.map((n) => h('li', { class: n.date < today ? 'gone' : '' },
      h('div', { class: 'd' }, n.date === today ? 'Today' : dayName(n.date)),
      h('h3', null, n.title, h('span', { class: `tag ${n.level === 'high' ? 'crit' : n.level === 'medium' ? 'warn' : ''}` }, n.level === 'high' ? 'High' : n.level === 'medium' ? 'Medium' : 'Low')),
      h('p', null, n.detail))) : h('li', null, h('p', null, 'Nothing flagged.')));
    fill($('habits'), ((D.notes && D.notes.habits) || []).map((t) => h('li', null, t)));
  }

  function renderSources(now) {
    const rows = [
      ['Calendar', 'calendar', 26], ['Sleep and heart', 'body', 30], ...(D.heart ? [['Heart rate, live', 'heart', 3]] : []), ['Email', 'email', 30], ['GitHub', 'github', 30], ['Weekly history', 'history', 24 * 9], ['Watch-outs', 'notes', 24 * 9],
    ].map(([name, f, maxH]) => {
      const t = D[f] && Date.parse(D[f].updatedAt);
      const stale = !t || now - t > maxH * HOUR;
      return h('div', null, h('b', null, name), h('span', null, (D[f] && D[f].source) || 'No data file'), h('div', { class: `st${stale ? ' stale' : ''}` }, t ? `${fmt({ day: 'numeric', month: 'short' }).format(t)}, ${hm(t)} · ${ago(t, now)}${stale ? ' · out of date' : ''}` : 'missing'));
    });
    fill($('sources'), rows);
  }

  function render() {
    const now = Date.now();
    const today = dayKey(now);
    renderMast(now);
    const v = renderAnswer(now, today);
    renderBody(now, today, v);
    renderAlert(today);
    renderToday(now, today);
    renderDays(now, today);
    renderLastNight(now, today);
    renderRecovery(now, today);
    renderHeart(now, today);
    renderLoad(now, today);
    renderOutput(now, today);
    renderWatch(today);
    renderSources(now);
    document.title = 'How is Tristan';
  }

  // ---------- tooltips ----------
  function tips() {
    const tip = h('div', { id: 'tip', role: 'tooltip', hidden: '' });
    document.body.append(tip);
    const show = (el) => {
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const half = tip.offsetWidth / 2 + 8;
      tip.style.left = `${clamp(r.left + r.width / 2, half, window.innerWidth - half)}px`;
      const above = r.top > tip.offsetHeight + 16;
      tip.style.top = `${above ? r.top : r.bottom + tip.offsetHeight + 20}px`;
    };
    const hide = () => { tip.hidden = true; };
    document.addEventListener('pointerover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el); else if (!(e.target.closest && e.target.closest('.hrchart'))) hide(); });
    document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el); });
    document.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, { passive: true });
  }

  // ---------- data ----------
  async function load() {
    const got = await Promise.all(FILES.map((f) =>
      fetch(`data/${f}.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    FILES.forEach((f, i) => { if (got[i]) D[f] = got[i]; });
    if (D.profile && D.profile.timezone) TZ = D.profile.timezone;
    prepEvents();
  }
  // Public GitHub activity, straight from the browser. Works on a normal web host;
  // inside a sandboxed viewer the request is blocked and the page falls back to data/github.json.
  async function loadLiveGit() {
    const login = (D.profile && D.profile.github) || (D.github && D.github.login);
    if (!login) return;
    try {
      const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/events/public?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const evs = (await r.json()).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const today = dayKey(Date.now());
      const verb = { PushEvent: 'Pushed to', PullRequestEvent: 'Pull request in', CreateEvent: 'Created in', IssuesEvent: 'Issue in', ReleaseEvent: 'Release in', PullRequestReviewEvent: 'Reviewed in', IssueCommentEvent: 'Commented in' };
      liveGit = {
        at: Date.now(),
        today: evs.filter((e) => e.type === 'PushEvent' && dayKey(Date.parse(e.created_at)) === today).length,
        recent: evs.filter((e) => verb[e.type]).slice(0, 5).map((e) => ({ at: e.created_at, what: verb[e.type].replace(/ (to|in)$/, ''), repo: String(e.repo && e.repo.name || '').split('/').pop() })),
      };
    } catch (_) { /* offline or blocked: keep the file data */ }
  }

  async function start() {
    tips();
    await load();
    render();
    loadLiveGit().then(() => liveGit && render());
    setInterval(render, 30000);
    setInterval(() => load().then(render), 5 * 60000);
    setInterval(() => loadLiveGit().then(() => liveGit && render()), 10 * 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load().then(render); });
  }
  start();
})();
