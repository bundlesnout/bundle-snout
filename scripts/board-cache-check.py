#!/usr/bin/env python3
"""Validate the browser-saved featured board cache and keep its meta in sync.

A browser "Save As" can produce an HTML Cloudflare page or a JSON with no entries
instead of the movers JSON. The featured runner would then read a broken cache.
This check (run by box-ensure after each browser fetch window):
  - valid JSON with a non-empty entries[] -> write meta if missing/older than the file,
    clear NEED_BROWSER_FETCH, print BOARD_OK
  - otherwise move the file aside to featured-board.bad.<ts> and print BOARD_BAD,
    so the runner keeps its last good in-memory board and the next run refetches.
"""
import json, os, sys, time

def check(board, meta, flag):
    if not os.path.exists(board):
        return "BOARD_MISSING"
    raw = open(board, "rb").read()
    try:
        d = json.loads(raw.decode("utf-8"))
        entries = d.get("entries") if isinstance(d, dict) else None
    except Exception:
        entries = None
    if not isinstance(entries, list) or not entries:
        bad = board.replace(".json", "") + ".bad.%d" % int(time.time())
        os.replace(board, bad)
        return "BOARD_BAD moved to " + bad
    mtime = os.path.getmtime(board)
    need = True
    if os.path.exists(meta):
        try:
            m = json.load(open(meta))
            need = m.get("bytes") != len(raw) or os.path.getmtime(meta) < mtime - 1
        except Exception:
            need = True
    if need:
        json.dump({"savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
                   "bytes": len(raw), "entries": len(entries), "source": "browser",
                   "metaBy": "board-cache-check"}, open(meta, "w"), indent=2)
    if os.path.exists(flag) and time.time() - mtime < 2100:
        os.remove(flag)
    return "BOARD_OK %d entries%s" % (len(entries), " (meta written)" if need else "")

if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "/workspace/agentdata"
    print("board-check: " + check(os.path.join(base, "featured-board.json"),
                                  os.path.join(base, "featured-board.meta.json"),
                                  os.path.join(base, "NEED_BROWSER_FETCH")))
