#!/usr/bin/env python3
"""Read-only ALMA health snapshot for Vigilancia (box-side).

Fetches /health and /api/agent, flags anything a human would otherwise have to
eyeball each run, and writes /workspace/agentdata/agent-health.json.
Never posts anything to Render.
"""
import json, sys, time, urllib.request
from datetime import datetime, timezone

BASE = "https://bundle-snout.onrender.com"
OUT = "/workspace/agentdata/agent-health.json"


def _age(iso, now):
    if not iso:
        return None
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
    return round(now - t)


def check(health, agent, now, prev=None):
    """Return (flags, summary). Pure: no I/O."""
    flags = []
    h = (health or {}).get("agent") or {}
    if not (health or {}).get("ok"):
        flags.append("HEALTH_NOT_OK")
    if not h.get("loopRunning"):
        flags.append("LOOP_STOPPED")
    if not h.get("streamConnected"):
        flags.append("STREAM_DOWN")
    mem = (health or {}).get("mem") or {}
    if mem.get("rssMB") and mem.get("restartAtMB") and mem["rssMB"] > 0.85 * mem["restartAtMB"]:
        flags.append("MEM_NEAR_RESTART")
    a = agent or {}
    if a.get("mode") != "paper":
        flags.append("MODE_NOT_PAPER")
    if a.get("halted"):
        flags.append("HALTED")
    st = a.get("stats") or {}
    dec_age = _age(a.get("lastDecisionAt"), now)
    if dec_age is None or dec_age > 20 * 60:
        flags.append("DECISIONS_STALE")
    p = a.get("persistence") or {}
    if p.get("lastSaveError"):
        flags.append("SAVE_ERROR")
    save_age = _age(p.get("lastSaveAt"), now)
    if save_age is not None and save_age > 30 * 60:
        flags.append("SAVE_STALE")
    sb, mx = p.get("stateBytes"), p.get("maxStateBytes")
    if sb and mx and sb > 0.9 * mx:
        flags.append("STATE_NEAR_CAP")
    # Projection: state growing fast enough to reach 90% of cap within 3 days.
    eta_days = None
    if sb and mx and prev and prev.get("stateBytes") and prev.get("at") and now - prev["at"] > 600 \
            and sb > prev["stateBytes"]:
        rate = (sb - prev["stateBytes"]) / (now - prev["at"])
        eta_days = round(max(0, 0.9 * mx - sb) / rate / 86400, 1)
        if eta_days < 3:
            flags.append("STATE_GROWING_FAST")
    if p.get("stateTrimmed"):
        flags.append("STATE_TRIMMED")
    sh = ((a.get("stream") or {}).get("health")) or {}
    if (sh.get("downPct") or 0) > 5:
        flags.append("STREAM_BLIND_HIGH")
    prev = prev or {}
    new_trades = new_wins = None
    if prev.get("closedTrades") is not None and st.get("closedTrades") is not None:
        new_trades = st["closedTrades"] - prev["closedTrades"]
        new_wins = (st.get("wins") or 0) - (prev.get("wins") or 0)
    for k in ("scanErrors", "liveErrors"):
        if prev.get(k) is not None and (st.get(k) or 0) > prev[k]:
            flags.append(k.upper() + "_UP")
    if prev.get("uptimeSec") is not None and (health or {}).get("uptimeSec") is not None \
            and health["uptimeSec"] < prev["uptimeSec"] and prev.get("at") and now - prev["at"] > health["uptimeSec"]:
        flags.append("RESTARTED")
    summary = {
        "at": now, "mode": a.get("mode"), "uptimeSec": (health or {}).get("uptimeSec"),
        "rssMB": mem.get("rssMB"), "closedTrades": st.get("closedTrades"), "wins": st.get("wins"),
        "drawdownPct": st.get("drawdownPct"), "scanErrors": st.get("scanErrors"),
        "liveErrors": st.get("liveErrors"), "lastDecisionAgoSec": dec_age, "stateBytes": sb,
        "maxStateBytes": mx, "streamBlindPct": sh.get("downPct"), "streamClosesLastHour": sh.get("closesLastHour"),
        "newTradesSincePrev": new_trades, "newWinsSincePrev": new_wins, "stateCapEtaDays": eta_days,
        "worstPctPastStop": (st.get("exitSlippage") or {}).get("worstPctPastStop"),
        "flags": flags,
    }
    return flags, summary


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=40) as r:
        return json.load(r)


def main():
    now = time.time()
    try:
        prev = json.load(open(OUT))
    except Exception:
        prev = None
    try:
        health, agent = _get("/health"), _get("/api/agent")
    except Exception as e:
        print(f"agent-health: FETCH_FAILED {str(e)[:120]}")
        return
    flags, summary = check(health, agent, now, prev)
    json.dump(summary, open(OUT, "w"), indent=2)
    print("agent-health: " + ("ok" if not flags else " ".join(flags)) +
          f" (mode={summary['mode']} trades={summary['closedTrades']} dd={summary['drawdownPct']}% "
          f"state={summary['stateBytes']}/{summary['maxStateBytes']} capEta={summary['stateCapEtaDays']}d "
          f"new={summary['newTradesSincePrev']}t/{summary['newWinsSincePrev']}w lastDecision={summary['lastDecisionAgoSec']}s)")


if __name__ == "__main__":
    main()
