#!/usr/bin/env python3
"""Refreshes data/heart.json and today's record in data/body.json from Garmin Connect.

    GARMIN_TOKENS='<token from scripts/garmin-login.py>' python3 scripts/sync-garmin.py

Garmin has no public API for personal data, so this uses the community `garminconnect`
client, which talks to the same service as the Garmin Connect app. The numbers are as
fresh as the watch's last sync to the phone, not a live stream.

Environment:
  GARMIN_TOKENS      required. Token JSON printed by scripts/garmin-login.py.
  GARMIN_TOKENS_OUT  optional path. If Garmin issues a replacement token during the run,
                     it is written here so the workflow can store it back in the secret.

Flags:
  --shapes   print the field names Garmin returned (no values) and exit; for debugging.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import sys
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def read(name: str, fallback):
    p = DATA / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else fallback


def write_if_changed(name: str, doc: dict, max_age_h: float = 3) -> bool:
    p = DATA / f"{name}.json"
    old = read(name, None)
    strip = lambda d: json.dumps({**d, "updatedAt": None}, sort_keys=True)
    if old and strip(old) == strip(doc):
        try:
            age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(old["updatedAt"].replace("Z", "+00:00"))).total_seconds() / 3600
        except Exception:
            age = 99
        if age < max_age_h:
            print(f"{name}.json unchanged")
            return False
    p.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"{name}.json written")
    return True


def iso(ms: float) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pairs(arr) -> list[tuple[float, float]]:
    """[[timestamp_ms, ..., value]] -> [(timestamp_ms, value)], dropping gaps and 'not measured' codes."""
    out = []
    for row in arr or []:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        ts = row[0]
        val = next((v for v in reversed(row[1:]) if isinstance(v, (int, float)) and not isinstance(v, bool)), None)
        if isinstance(ts, (int, float)) and val is not None and val > 0:
            out.append((float(ts), float(val)))
    return sorted(out)


def shapes(obj, depth=0, limit=3) -> object:
    if isinstance(obj, dict):
        return {k: shapes(v, depth + 1, limit) for k, v in obj.items()} if depth < limit else "{...}"
    if isinstance(obj, list):
        return [shapes(obj[0], depth + 1, limit), f"... {len(obj)} items"] if obj else []
    return type(obj).__name__


def build(now: dt.datetime, tz: ZoneInfo, bucket: int, hr: dict, sleep: dict, stress: dict, battery: list, hrv: dict | None):
    """Pure transform from Garmin responses to (heart.json document, body.json record for today)."""
    today = now.astimezone(tz).date().isoformat()

    # Heart rate through the day, averaged into buckets.
    raw = pairs(hr.get("heartRateValues"))
    buckets: dict[int, list[float]] = {}
    for ts, bpm in raw:
        local = dt.datetime.fromtimestamp(ts / 1000, tz)
        if local.date().isoformat() != today:
            continue
        buckets.setdefault((local.hour * 60 + local.minute) // bucket * bucket, []).append(bpm)
    samples = [[m, round(sum(v) / len(v))] for m, v in sorted(buckets.items())]

    heart = {
        "updatedAt": now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Garmin Connect, synced automatically. As fresh as the watch's last sync.",
        "date": today,
        "bucketMin": bucket,
        "samples": samples,
    }
    if raw:
        heart["now"] = {"bpm": round(raw[-1][1]), "at": iso(raw[-1][0])}
    for key, src in (("resting", "restingHeartRate"), ("min", "minHeartRate"), ("max", "maxHeartRate"), ("resting7d", "lastSevenDaysAvgRestingHeartRate")):
        if isinstance(hr.get(src), (int, float)):
            heart[key] = round(hr[src])
    st = pairs(stress.get("stressValuesArray"))
    if st:
        heart["stress"] = {"level": round(st[-1][1]), "at": iso(st[-1][0])}
    bb = sorted(p for day in battery or [] for p in pairs((day or {}).get("bodyBatteryValuesArray")))
    if bb:
        heart["bodyBattery"] = {"level": round(bb[-1][1]), "at": iso(bb[-1][0])}

    # Last night's sleep, written against the wake date.
    dto = sleep.get("dailySleepDTO") or {}
    rec: dict = {"date": today}
    secs = dto.get("sleepTimeSeconds")
    if isinstance(secs, (int, float)) and secs > 0:
        rec["watch"] = "worn"
        rec["sleepH"] = round(secs / 3600, 1)
        for key, src in (("deepMin", "deepSleepSeconds"), ("lightMin", "lightSleepSeconds"), ("remMin", "remSleepSeconds"), ("awakeMin", "awakeSleepSeconds")):
            if isinstance(dto.get(src), (int, float)):
                rec[key] = round(dto[src] / 60)
        overall = ((dto.get("sleepScores") or {}).get("overall") or {})
        if isinstance(overall.get("value"), (int, float)):
            rec["score"] = round(overall["value"])
        if overall.get("qualifierKey"):
            rec["quality"] = str(overall["qualifierKey"]).replace("_", " ").title()
        need = (dto.get("sleepNeed") or {}).get("actual")
        if isinstance(need, (int, float)) and need > 0:
            rec["needH"] = round(need / 60, 1)
        if isinstance(dto.get("avgSleepStress"), (int, float)):
            rec["stress"] = round(dto["avgSleepStress"])
        if isinstance(dto.get("avgHeartRate"), (int, float)):
            rec["overnightHR"] = round(dto["avgHeartRate"])
        start, end = dto.get("sleepStartTimestampGMT"), dto.get("sleepEndTimestampGMT")
        if isinstance(end, (int, float)):
            rec["wakeTime"] = dt.datetime.fromtimestamp(end / 1000, tz).strftime("%H:%M")
            after = [lvl for ts, lvl in bb if ts >= end - 10 * 60000]
            if after:
                rec["bodyBatteryWake"] = round(after[0])
            if isinstance(start, (int, float)):
                before = [lvl for ts, lvl in bb if ts <= start + 10 * 60000]
                if after and before:
                    rec["bodyBatteryGain"] = round(after[0] - before[-1])
    rhr = sleep.get("restingHeartRate") or hr.get("restingHeartRate")
    if isinstance(rhr, (int, float)):
        rec["restingHR"] = round(rhr)
    night_hrv = sleep.get("avgOvernightHrv") or ((hrv or {}).get("hrvSummary") or {}).get("lastNightAvg")
    if isinstance(night_hrv, (int, float)):
        rec["hrv"] = round(night_hrv)
    return heart, rec


def merge_body(rec: dict, now_iso: str) -> None:
    if len(rec) <= 1:
        return
    body = read("body", {"days": []})
    days = body.setdefault("days", [])
    old = next((d for d in days if d.get("date") == rec["date"]), None)
    if old is None:
        days.append(rec)
    else:
        if old.get("watch") == "off" and "sleepH" not in rec:
            rec.pop("watch", None)
        old.update(rec)
    days.sort(key=lambda d: d.get("date", ""))
    body["days"] = days[-90:]
    body["updatedAt"] = now_iso
    body["source"] = "Garmin Connect, synced automatically; earlier nights from the 25 Nov review"
    write_if_changed("body", body)


def main() -> int:
    tokens = os.environ.get("GARMIN_TOKENS", "").strip()
    if not tokens:
        print("GARMIN_TOKENS is not set; nothing to do.")
        return 0
    try:
        before = json.loads(tokens)
    except ValueError:
        print("GARMIN_TOKENS is not the JSON printed by scripts/garmin-login.py.", file=sys.stderr)
        return 1

    from garminconnect import Garmin

    profile = read("profile", {})
    tz = ZoneInfo(profile.get("timezone", "Europe/London"))
    bucket = int((profile.get("heart") or {}).get("bucketMin", 10))
    now = dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(tz).date()

    client = Garmin()
    try:
        client.login(tokens)
    except Exception as e:  # never print the token or the raw error body
        print(f"Garmin sign-in failed ({type(e).__name__}). Run scripts/garmin-login.py again and update GARMIN_TOKENS.", file=sys.stderr)
        return 1

    def call(label, fn, *args, default=None):
        try:
            return fn(*args) or default
        except Exception as e:
            print(f"{label}: unavailable ({type(e).__name__})", file=sys.stderr)
            return default

    d = today.isoformat()
    hr = call("heart rate", client.get_heart_rates, d, default={})
    sleep = call("sleep", client.get_sleep_data, d, default={})
    stress = call("stress", client.get_stress_data, d, default={})
    battery = call("body battery", client.get_body_battery, (today - dt.timedelta(days=1)).isoformat(), d, default=[])
    hrv = call("hrv", client.get_hrv_data, d, default=None)

    # Garmin may hand back a replacement token; pass it on so the next run can sign in.
    out = os.environ.get("GARMIN_TOKENS_OUT")
    try:
        after = json.loads(client.client.dumps())
        if out and after != before and after.get("di_refresh_token"):
            fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(after, f)
            print("Garmin issued a new token; written for the workflow to store.")
        elif after.get("di_refresh_token") != before.get("di_refresh_token"):
            print("Garmin replaced the sign-in token but GARMIN_TOKENS_OUT is not set, so it was not saved.", file=sys.stderr)
    except Exception:
        pass

    if "--shapes" in sys.argv:
        print(json.dumps({"heart": shapes(hr), "sleep": shapes(sleep), "stress": shapes(stress), "battery": shapes(battery), "hrv": shapes(hrv)}, indent=1))
        return 0

    heart, rec = build(now, tz, bucket, hr, sleep, stress, battery, hrv)
    if not heart["samples"] and len(rec) <= 1:
        print("Garmin returned nothing for today yet; leaving the files alone.")
        return 0
    write_if_changed("heart", heart)
    merge_body(rec, heart["updatedAt"])
    last = heart.get("now", {}).get("at", "none")
    print(f"{len(heart['samples'])} heart-rate points, latest sample {last}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
