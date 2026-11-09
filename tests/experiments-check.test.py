import json, os, subprocess, sys, tempfile
S = os.path.join(os.path.dirname(__file__), "..", "scripts", "experiments-check.py")

def run(f, e):
    d = tempfile.mkdtemp()
    fp, ep = os.path.join(d, "f.json"), os.path.join(d, "e.json")
    json.dump(f, open(fp, "w")); json.dump(e, open(ep, "w"))
    return subprocess.check_output([sys.executable, S, fp, ep], text=True)

neg = {"variants": [{"id": "a", "closed": 40, "avgPct": -3, "ciFamilyPct": [-5, -1]}]}
eneg = {"filled": 50, "peaks": {"ge10x": 0}, "byExit": {"x": {"n": 40, "meanPct": -2, "ci95": [-4, 1]}}}
out = run(neg, eneg); assert "not notable" in out and "best a" in out and "best x" in out, out
pos = {"variants": [{"id": "b", "closed": 35, "avgPct": 6, "ciFamilyPct": [1, 9]}, {"id": "c", "closed": 5, "avgPct": 50, "ciFamilyPct": [10, 90]}]}
out = run(pos, eneg); assert "NOTABLE featured:b" in out and "featured:c" not in out, out
out = run(neg, dict(eneg, peaks={"ge10x": 1})); assert "NOTABLE early:1x10" in out, out
out = subprocess.check_output([sys.executable, S, "/nonexistent", "/nonexistent"], text=True)
assert "unreadable" in out, out
print("ok")
