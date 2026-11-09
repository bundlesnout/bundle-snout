#!/usr/bin/env python3
"""One-line verdict on the box paper experiments (featured-coin test, Frongus early-volume test).

Prints NOTABLE when something is worth telling the user: a variant with >=30 trades whose
family-corrected (featured) or plain (early) 95% CI is entirely above zero, or any early
trigger that peaked at >=10x. Otherwise prints "not notable" with the best variant, so the
Vigilancia run does not have to eyeball two JSON files every time.
"""
import json, sys

MIN_N = 30


def featured_summary(d):
    vs = d.get("variants") or []
    pos, best = [], None
    for v in vs:
        n = v.get("closed") or 0
        ci = v.get("ciFamilyPct") or v.get("ci95Pct")
        if n >= MIN_N and ci and ci[0] > 0:
            pos.append(v.get("id"))
        if n >= MIN_N and (best is None or (v.get("avgPct") or -1e9) > (best.get("avgPct") or -1e9)):
            best = v
    b = f"best {best['id']} n={best.get('closed')} avg {best.get('avgPct')}%" if best else "no variant with 30+ trades"
    return pos, f"featured {len(vs)} variants, {b}"


def early_summary(d):
    pos, best = [], None
    for k, v in (d.get("byExit") or {}).items():
        n = v.get("n") or 0
        ci = v.get("ci95")
        if n >= MIN_N and ci and ci[0] > 0:
            pos.append(k)
        if n >= MIN_N and (best is None or v.get("meanPct", -1e9) > best[1].get("meanPct", -1e9)):
            best = (k, v)
    ge10 = (d.get("peaks") or {}).get("ge10x") or 0
    b = f"best {best[0]} n={best[1].get('n')} mean {round(best[1].get('meanPct', 0), 1)}%" if best else "no exit with 30+ trades"
    return pos, ge10, f"early {d.get('filled', 0)} fills, {ge10} at 10x, {b}"


def main(fpath, epath):
    parts, notable = [], []
    try:
        pos, s = featured_summary(json.load(open(fpath)))
        parts.append(s)
        notable += [f"featured:{p}" for p in pos]
    except Exception as e:
        parts.append(f"featured unreadable ({e.__class__.__name__})")
    try:
        pos, ge10, s = early_summary(json.load(open(epath)))
        parts.append(s)
        notable += [f"early:{p}" for p in pos]
        if ge10:
            notable.append(f"early:{ge10}x10")
    except Exception as e:
        parts.append(f"early unreadable ({e.__class__.__name__})")
    tag = "NOTABLE " + ",".join(notable) if notable else "not notable"
    print(f"experiments: {tag}; " + "; ".join(parts))


if __name__ == "__main__":
    a = sys.argv[1:] or ["/workspace/agentdata/featured-status.json", "/workspace/agentdata/early-status.json"]
    main(a[0], a[1])
