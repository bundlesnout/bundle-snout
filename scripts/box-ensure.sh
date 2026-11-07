#!/bin/bash
# Box-side self-heal after a box restart/update: reinstall deps if wiped, restart pinger + paper-test runners if dead.
# Also always poke /health once so a Vigilancia run right after a box pause does not leave a keep-alive gap
# while the pinger finishes its sleep cycle.
# After a VM pause, ping.sh can look "alive" while its sleep/curl is wedged — restart if the log is stale.
# Early runner now self-heals a half-open chain WS; box-ensure still restarts it if the process died.
set -e
cd /workspace/sniff || exit 1
mkdir -p /workspace/agentdata /workspace/keepalive

if [ ! -d node_modules/@solana/web3.js ]; then
  echo "npm-ci: missing @solana/web3.js, running npm ci"
  npm ci --no-audit --no-fund >/workspace/agentdata/npm-ci.log 2>&1
  echo "npm-ci: done"
else
  echo "npm-ci: ok"
fi

# Immediate keep-alive poke (independent of whether ping.sh is mid-sleep)
code=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "https://bundle-snout.onrender.com/health?src=box-ensure" 2>/dev/null || echo "err")
echo "health-poke: $code"

PING_LOG=/workspace/keepalive/ping.log
PING_STALE_S=360
ping_stale=0
if [ -f "$PING_LOG" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$PING_LOG") ))
  if [ "$age" -gt "$PING_STALE_S" ]; then ping_stale=1; fi
fi

if pgrep -f keepalive/ping.sh >/dev/null && [ "$ping_stale" -eq 0 ]; then
  echo "pinger: alive"
else
  if pgrep -f keepalive/ping.sh >/dev/null; then
    pkill -f keepalive/ping.sh || true
    sleep 1
    echo "pinger: log stale (>${PING_STALE_S}s), killing"
  fi
  nohup /workspace/keepalive/ping.sh >/dev/null 2>&1 &
  echo "pinger: restarted"
fi

if pgrep -f featured-runner.js >/dev/null; then
  # Process can stay up while refreshBoard early-returned during 403 backoff with a stale
  # browser cache (board.lastAt frozen). Restart if the board heartbeat is >10 min old.
  board_ago=$(python3 -c 'import json,datetime
try:
 d=json.load(open("/workspace/agentdata/featured-status.json"))
 now=datetime.datetime.now(datetime.timezone.utc).timestamp()
 la=d.get("board",{}).get("lastAt")
 if not la:
  # Brand-new process has not refreshed yet; only treat as stale if runner.savedAt is also old.
  sa=(d.get("runner") or {}).get("savedAt")
  if sa:
   t=datetime.datetime.fromisoformat(sa.replace("Z","+00:00")).timestamp()
   print(0 if now-t < 120 else 99999)
  else:
   print(99999)
  raise SystemExit
 t=datetime.datetime.fromisoformat(la.replace("Z","+00:00")).timestamp()
 print(int(now-t))
except Exception:
 print(99999)' 2>/dev/null || echo 99999)
  if [ "$board_ago" -gt 600 ]; then
    echo "featured: board stale ${board_ago}s, restarting"
    pkill -f featured-runner.js || true
    sleep 1
    nohup node scripts/featured-runner.js >> /workspace/agentdata/featured-runner.log 2>&1 &
    echo "featured: restarted"
  else
    echo "featured: alive (board ${board_ago}s)"
  fi
else
  nohup node scripts/featured-runner.js >> /workspace/agentdata/featured-runner.log 2>&1 &
  echo "featured: restarted"
fi

if pgrep -f early-runner.sh >/dev/null; then
  # If chain feed has been silent >3 min while the process lives, force a restart
  # (belt-and-suspenders; early-runner.js also has a 90s stale WS heartbeat).
  chain_ago=$(python3 -c 'import json,sys
try:
 d=json.load(open("/workspace/agentdata/early-status.json"))
 a=d.get("runner",{}).get("chain",{}).get("lastMsgAgoS")
 print(99999 if a is None else int(a))
except Exception:
 print(99999)' 2>/dev/null || echo 99999)
  if [ "$chain_ago" -gt 180 ]; then
    echo "early: chain stale ${chain_ago}s, restarting"
    pkill -f 'scripts/early-runner' || true
    sleep 1
    nohup scripts/early-runner.sh >/dev/null 2>&1 &
    echo "early: restarted"
  else
    echo "early: alive"
  fi
else
  nohup scripts/early-runner.sh >/dev/null 2>&1 &
  echo "early: restarted"
fi

# featured board cache age (runner fresh ~45 min; stale grace ~3 h via FEATURED_BOARD_CACHE_STALE_MAX_MS). Still ask browser if >35 min.
# Try a direct curl first (sometimes works); on 403/fail write NEED_BROWSER_FETCH for Vigilancia/parent computerUse.
B=/workspace/agentdata/featured-board.json
M=/workspace/agentdata/featured-board.meta.json
FLAG=/workspace/agentdata/NEED_BROWSER_FETCH
BOARD_URL='https://advanced-indexer.pump.fun/boards/movers?chains=solana&limit=100'
need_board=0
if [ -f "$B" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$B") ))
  if [ "$AGE" -gt 2100 ]; then
    echo "board-cache: STALE ${AGE}s"
    need_board=1
  else
    echo "board-cache: fresh ${AGE}s"
    rm -f "$FLAG"
  fi
else
  echo "board-cache: MISSING"
  need_board=1
  AGE=-1
fi
if [ "$need_board" -eq 1 ]; then
  tmp="$B.tmp"
  code=$(curl -sS -m 25 -A 'Mozilla/5.0' -H 'Accept: application/json' -H 'Origin: https://pump.fun' -H 'Referer: https://pump.fun/'     -o "$tmp" -w '%{http_code}' "$BOARD_URL" 2>/dev/null || echo err)
  if [ "$code" = "200" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); e=d.get("entries"); assert isinstance(e,list) and len(e)>=5' "$tmp" 2>/dev/null; then
    mv "$tmp" "$B"
    python3 -c 'import json,time,sys; from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); Path(sys.argv[2]).write_text(json.dumps({"savedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"bytes":p.stat().st_size,"entries":len(d.get("entries") or []),"source":"box-ensure-curl"},indent=2)+"\n")' "$B" "$M"
    rm -f "$FLAG"
    echo "board-cache: refreshed via curl ($(python3 -c 'import json;print(len(json.load(open("/workspace/agentdata/featured-board.json")).get("entries") or []))') entries)"
    # Restart featured so it reloads the fresh cache immediately
    if pgrep -f featured-runner.js >/dev/null; then
      pkill -f featured-runner.js || true
      sleep 1
    fi
    nohup node scripts/featured-runner.js >> /workspace/agentdata/featured-runner.log 2>&1 &
    echo "featured: restarted after board refresh"
  else
    rm -f "$tmp"
    python3 -c 'import json,time,sys
age=int(sys.argv[1]); code=sys.argv[2]
open("/workspace/agentdata/NEED_BROWSER_FETCH","w").write(json.dumps({"at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"reason":"featured-board cache stale/missing; box curl failed","http":code,"url":"https://advanced-indexer.pump.fun/boards/movers?chains=solana&limit=100","cacheAgeMin":round(age/60,1) if age>=0 else None,"dest":"/workspace/agentdata/featured-board.json","metaDest":"/workspace/agentdata/featured-board.meta.json","hint":"computerUse: fetch movers JSON, save to dest with entries[], write meta {savedAt,bytes,entries,source:browser}"},indent=2)+"\n")' "$AGE" "$code"
    echo "board-cache: curl failed (HTTP $code) -> NEED_BROWSER_FETCH"
  fi
fi

# Browser fetch (Vigilancia computerUse) writes the board while featured is already running.
# Mirror the curl-refresh restart: if the board file is fresh and newer than the runner
# process start, bounce featured so it reloads cache immediately (ops 2026-11-06).
if [ -f "$B" ] && pgrep -f featured-runner.js >/dev/null; then
  AGE_NOW=$(( $(date +%s) - $(stat -c %Y "$B") ))
  if [ "$AGE_NOW" -le 2100 ]; then
    newer=$(python3 -c '
import os, time, subprocess
board_m = os.path.getmtime("/workspace/agentdata/featured-board.json")
out = subprocess.check_output(["pgrep", "-f", "featured-runner.js"], text=True).strip().splitlines()
pids = []
for line in out:
    # pgrep -af not used; plain pgrep gives PIDs
    try: pids.append(int(line.strip().split()[0]))
    except: pass
if not pids:
    print(0); raise SystemExit
# pick node runner if /proc cmdline matches
pick = None
for pid in pids:
    try:
        cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "replace")
    except Exception:
        continue
    if "featured-runner.js" in cmd and "node" in cmd:
        pick = pid; break
if pick is None: pick = pids[0]
hz = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
up = float(open("/proc/uptime").read().split()[0])
boot = time.time() - up
start_ticks = int(open(f"/proc/{pick}/stat").read().split()[21])
start = boot + start_ticks / hz
print(1 if start < board_m else 0)
')
    if [ "$newer" = "1" ]; then
      pkill -f featured-runner.js || true
      sleep 1
      nohup node scripts/featured-runner.js >> /workspace/agentdata/featured-runner.log 2>&1 &
      echo "featured: restarted after browser board refresh (${AGE_NOW}s cache)"
    fi
  fi
fi

# Box awake coverage (pinger log) -> box-coverage.json; flags LOW_BOX_COVERAGE under 50%.
python3 "$(dirname "$0")/box-coverage.py" 2>/dev/null || echo "box-coverage: error"

# Flag when origin/main is ahead of the live Render deploy (autoDeploy can miss a push).
# Read-only: prints RENDER_DEPLOY_LAG and writes a flag for Vigilancia; does not trigger deploys.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi
if [ -n "${RENDER_API_KEY:-}" ]; then
  python3 - <<'PY' || true
import json, os, subprocess, urllib.request
KEY = os.environ.get("RENDER_API_KEY", "")
SID = "srv-dbe7j9gm7kps73cu9o00"
FLAG = "/workspace/agentdata/NEED_RENDER_DEPLOY"
try:
    origin = subprocess.check_output(
        ["git", "-C", "/workspace/sniff", "rev-parse", "origin/main"], text=True
    ).strip()
except Exception as e:
    print(f"deploy-lag: skip (git {e})")
    raise SystemExit
try:
    req = urllib.request.Request(
        f"https://api.render.com/v1/services/{SID}/deploys?limit=3",
        headers={"Authorization": f"Bearer {KEY}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.load(r)
except Exception as e:
    print(f"deploy-lag: API err {e}")
    raise SystemExit
live = None
building = None
for row in rows:
    d = row.get("deploy", row)
    st = d.get("status")
    cid = (d.get("commit") or {}).get("id") or ""
    if st == "live" and live is None:
        live = d
    if st in ("build_in_progress", "update_in_progress", "created", "queued") and building is None:
        building = d
live_id = ((live or {}).get("commit") or {}).get("id") or ""
if building:
    bid = ((building.get("commit") or {}).get("id") or "")[:12]
    print(f"deploy-lag: deploy in progress {building.get('status')} {bid}")
    if os.path.exists(FLAG):
        os.remove(FLAG)
elif live_id and live_id == origin:
    print(f"deploy-lag: ok ({live_id[:12]})")
    if os.path.exists(FLAG):
        os.remove(FLAG)
elif live_id:
    ahead = ""
    try:
        ahead = subprocess.check_output(
            ["git", "-C", "/workspace/sniff", "log", "--oneline", f"{live_id}..{origin}"],
            text=True,
        ).strip()
    except Exception:
        ahead = "(diff unavailable)"
    n = len([l for l in ahead.splitlines() if l.strip()]) if ahead else 0
    # Classify: only flag when at least one changed path is Render-relevant.
    # Box-only runners (featured/early/box-ensure) live under scripts/ and are not
    # loaded by `node server.js` — false NEED_RENDER_DEPLOY for those wasted Vigilancia
    # (ops 2026-11-06: live=5952b8b origin=1af40cf, only scripts/featured-runner.js).
    BOX_ONLY_PREFIXES = (
        "scripts/featured-runner",
        "scripts/box-ensure",
        "scripts/early-runner",
        "tests/featured-runner",
        "tests/early",
        # early.js is the Frongus early-volume rule module, required only by
        # scripts/early-runner.js + tests (not server.js); .gitignore never ships
        # behaviour (ops 2026-11-07: false renderFiles=2 for live=5952b8b origin=6de4d14).
        "early.js",
        ".gitignore",
    )
    changed = []
    try:
        changed = subprocess.check_output(
            ["git", "-C", "/workspace/sniff", "diff", "--name-only", f"{live_id}..{origin}"],
            text=True,
        ).splitlines()
    except Exception:
        changed = []
    changed = [c.strip() for c in changed if c.strip()]
    def is_box_only(path: str) -> bool:
        return any(path == pref or path.startswith(pref) for pref in BOX_ONLY_PREFIXES)
    # Guard: if Render-side code ever starts requiring early.js, it stops being box-only.
    try:
        hits = subprocess.run(
            ["git", "-C", "/workspace/sniff", "grep", "-lE", r"require\(['\"]\.{1,2}/early['\"]\)", origin, "--", "*.js"],
            text=True, capture_output=True,
        ).stdout.splitlines()
        srv = [h.split(":", 1)[-1] for h in hits if not h.split(":", 1)[-1].startswith(("scripts/", "tests/"))]
    except Exception:
        srv = ["?"]
    if srv:
        BOX_ONLY_PREFIXES = tuple(p for p in BOX_ONLY_PREFIXES if p != "early.js")
    render_paths = [c for c in changed if not is_box_only(c)]
    box_paths = [c for c in changed if is_box_only(c)]
    if changed and not render_paths:
        if os.path.exists(FLAG):
            os.remove(FLAG)
        print(
            f"deploy-lag: box-only ahead ({n}) live={live_id[:12]} origin={origin[:12]} "
            f"files={','.join(box_paths)[:200]}"
        )
    else:
        payload = {
            "at": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
            "liveCommit": live_id,
            "originMain": origin,
            "aheadCount": n,
            "ahead": ahead[:500],
            "renderPaths": render_paths[:40],
            "boxOnlyPaths": box_paths[:40],
            "hint": "POST /v1/services/{sid}/deploys to catch up; autoDeploy missed these commits",
        }
        open(FLAG, "w").write(json.dumps(payload, indent=2) + "\n")
        print(f"deploy-lag: RENDER_DEPLOY_LAG live={live_id[:12]} origin={origin[:12]} ahead={n} renderFiles={len(render_paths)}")
else:
    print("deploy-lag: no live deploy found")
PY
else
  echo "deploy-lag: skip (no RENDER_API_KEY)"
fi
