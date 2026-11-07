"""deploy-lag box-only prefixes: board-cache-check must not flag RENDER_DEPLOY_LAG."""
import re
from pathlib import Path

src = Path("scripts/box-ensure.sh").read_text()
# Extract the BOX_ONLY_PREFIXES tuple literal from the embedded python.
m = re.search(r"BOX_ONLY_PREFIXES = \((.*?)\)\n    changed", src, re.S)
assert m, "BOX_ONLY_PREFIXES block not found in box-ensure.sh"
block = m.group(1)
prefs = re.findall(r'"([^"]+)"', block)
assert "scripts/board-cache-check" in prefs, prefs
assert "tests/board-cache-check" in prefs, prefs
assert "scripts/box-coverage" in prefs
assert "tests/box-ensure" in prefs
assert "early.js" in prefs

def is_box_only(path, prefixes=prefs):
    return any(path == p or path.startswith(p) for p in prefixes)

changed = [
    "scripts/board-cache-check.py",
    "tests/board-cache-check.test.py",
    "scripts/box-ensure.sh",
    "early.js",
    ".gitignore",
]
render = [c for c in changed if not is_box_only(c)]
assert render == [], render

# A real server file must still flag
assert not is_box_only("server.js")
assert not is_box_only("lib/agent.js")
print("ok deploy-lag box-only includes board-cache-check")
