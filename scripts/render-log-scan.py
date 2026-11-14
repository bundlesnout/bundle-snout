#!/usr/bin/env python3
"""Scan Render app logs for the last N hours (paginated) and summarise errors.

The Render logs API returns newest-first pages of <=100 lines; a single page
covers ~1.5 h of ALMA's chatty output, so a one-shot check silently misses
older errors. This pages backwards via nextEndTime until the window is
covered (or MAX_PAGES), groups error-like lines by a normalised signature,
writes /workspace/agentdata/render-log-scan.json and prints one line.
Never prints secrets: messages are truncated and only error-ish lines kept.
"""
import json, os, re, sys, time, urllib.request, urllib.parse, collections, datetime as dt

SID = "srv-dbe7j9gm7kps73cu9o00"
OUT = "/workspace/agentdata/render-log-scan.json"
MAX_PAGES = int(os.environ.get("RENDER_LOG_MAX_PAGES", "20"))
HOURS = float(os.environ.get("RENDER_LOG_HOURS", "2"))
ERR_RE = re.compile(r"(error|exception)\b|\b(uncaught|unhandled|fatal|crash(ed)?|ECONNRESET|ETIMEDOUT|out of memory|heap watchdog)\b", re.I)
# Known benign: ALMA's own reasoning text often says "failed"/"error" in diary lines; keep level-based + regex.
# JSON status dumps carry keys like "lastSaveError":null / "scanErrors":0 that are not errors.
NULLKEY_RE = re.compile(r'"?\w*(error|errors)"?\s*:\s*(null|0|false|\[\]|\{\}|"")', re.I)
DIARY_RE = re.compile(r"\[agent\] (SKIP|BUY|SELL|WATCH|SCAN|HOLD)\b|\[radar\] \S+ [1-9A-HJ-NP-Za-km-z]{32,44} crossed\b")
IGNORE_RE = re.compile(r"\[radar\] (dirty|clean)|scanErrors: 0", re.I)


def signature(msg: str) -> str:
    s = re.sub(r"[1-9A-HJ-NP-Za-km-z]{32,44}", "<addr>", msg)
    s = re.sub(r"\d+(\.\d+)?", "N", s)
    return s[:160]


def classify(logs):
    c = collections.Counter(); sample = {}; levels = collections.Counter()
    for l in logs:
        msg = l.get("message", "") or ""
        lv = next((x["value"] for x in l.get("labels", []) if x.get("name") == "level"), "info")
        levels[lv] += 1
        msg = NULLKEY_RE.sub("", msg)
        if IGNORE_RE.search(msg):
            continue
        # Render auto-levels lines containing words like "PANIC" as error; ALMA's
        # own "[agent] SKIP <TICKER>" diary lines (e.g. coin $PANIC) and Bond Radar
        # "[radar] <TICKER> <mint> crossed N%" lines are not errors.
        if lv in ("error", "fatal") and DIARY_RE.match(msg) and not ERR_RE.search(msg):
            continue
        if lv in ("error", "fatal") or ERR_RE.search(msg):
            k = signature(msg); c[k] += 1; sample.setdefault(k, l.get("timestamp"))
    return c, sample, levels


def fetch(key, owner, start, end):
    logs, pages, more = [], 0, False
    while pages < MAX_PAGES:
        q = urllib.parse.urlencode({"ownerId": owner, "resource": SID, "limit": 100, "startTime": start, "endTime": end})
        req = urllib.request.Request(f"https://api.render.com/v1/logs?{q}", headers={"Authorization": f"Bearer {key}"})
        d = json.load(urllib.request.urlopen(req, timeout=30)); pages += 1
        logs += d.get("logs", [])
        more = bool(d.get("hasMore"))
        if not more or not d.get("nextEndTime") or d["nextEndTime"] == end:
            break
        end = d["nextEndTime"]
    return logs, pages, more


def main():
    key = os.environ.get("RENDER_API_KEY")
    if not key:
        print("render-logs: skip (no RENDER_API_KEY)"); return
    try:
        req = urllib.request.Request(f"https://api.render.com/v1/services/{SID}", headers={"Authorization": f"Bearer {key}"})
        owner = json.load(urllib.request.urlopen(req, timeout=30))["ownerId"]
        now = dt.datetime.now(dt.timezone.utc)
        start = (now - dt.timedelta(hours=HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        logs, pages, truncated = fetch(key, owner, start, now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    except Exception as e:
        print(f"render-logs: error {type(e).__name__}"); return
    c, sample, levels = classify(logs)
    top = [{"count": n, "sig": k, "firstSeen": sample[k]} for k, n in c.most_common(15)]
    oldest = min((l.get("timestamp") for l in logs if l.get("timestamp")), default=None)
    res = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "hours": HOURS, "lines": len(logs), "pages": pages,
           "truncated": truncated, "oldest": oldest, "levels": dict(levels), "errorLines": sum(c.values()), "top": top}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(res, open(OUT, "w"), indent=2)
    flag = " RENDER_LOG_ERRORS" if res["errorLines"] else ""
    head = f" top={top[0]['count']}x {top[0]['sig'][:90]}" if top else ""
    print(f"render-logs: {len(logs)} lines/{HOURS:g}h pages={pages}{' TRUNCATED' if truncated else ''} errors={res['errorLines']}{flag}{head}")


if __name__ == "__main__":
    main()
