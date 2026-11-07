#!/usr/bin/env python3
"""Box awake coverage from the box pinger log (one line per ~4-5 min while the box runs).
Box-side paper tests (featured, early) only see prices while the box is awake; a trade open
across a pause is voided. Writes /workspace/agentdata/box-coverage.json and prints one line."""
import datetime as dt, json, sys
LOG = sys.argv[1] if len(sys.argv) > 1 else "/workspace/keepalive/ping.log"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/workspace/agentdata/box-coverage.json"
GAP = 400  # s; pinger cadence ~240-300 s

def coverage(lines, hours=24, now=None):
    ts = []
    for l in lines:
        try: ts.append(dt.datetime.strptime(l.split()[0], "%Y-%m-%dT%H:%M:%SZ"))
        except Exception: pass
    if not ts: return None
    end = now or ts[-1]; start = end - dt.timedelta(hours=hours)
    t = [x for x in ts if x >= start]
    awake, gaps, runs, cur = 0.0, [], [], 0.0
    for a, b in zip(t, t[1:]):
        g = (b - a).total_seconds()
        if g <= GAP: awake += g; cur += g
        else:
            gaps.append(int(g)); runs.append(cur); cur = 0.0
    runs.append(cur)
    return {"hours": hours, "awakePct": round(100 * awake / (hours * 3600), 1),
            "pauses": len(gaps), "medianPauseMin": round(sorted(gaps)[len(gaps)//2] / 60) if gaps else 0,
            "longestAwakeMin": round(max(runs) / 60) if runs else 0,
            "note": "box awake share from pinger log; box paper tests void trades open across a pause, so holds longer than the typical awake stretch are mostly unmeasurable"}

if __name__ == "__main__":
    c = coverage(open(LOG).read().splitlines())
    if not c: print("box-coverage: no data"); sys.exit(0)
    c["at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    open(OUT, "w").write(json.dumps(c, indent=2) + "\n")
    flag = " LOW_BOX_COVERAGE" if c["awakePct"] < 50 else ""
    print(f"box-coverage: awake {c['awakePct']}% of 24h, {c['pauses']} pauses (median {c['medianPauseMin']} min), longest awake {c['longestAwakeMin']} min{flag}")
