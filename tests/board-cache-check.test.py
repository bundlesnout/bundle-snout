import importlib.util, json, os, tempfile
s=importlib.util.spec_from_file_location("bc","scripts/board-cache-check.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
d=tempfile.mkdtemp(); B=os.path.join(d,"featured-board.json"); M=os.path.join(d,"featured-board.meta.json"); F=os.path.join(d,"NEED_BROWSER_FETCH")
assert m.check(B,M,F)=="BOARD_MISSING"
open(B,"w").write("<html>Just a moment...</html>")
r=m.check(B,M,F); assert r.startswith("BOARD_BAD") and not os.path.exists(B), r
open(B,"w").write(json.dumps({"entries":[{"a":1},{"b":2}]})); open(F,"w").write("{}")
r=m.check(B,M,F); assert r=="BOARD_OK 2 entries (meta written)", r
mm=json.load(open(M)); assert mm["entries"]==2 and mm["source"]=="browser" and not os.path.exists(F), mm
assert m.check(B,M,F)=="BOARD_OK 2 entries"
open(B,"w").write(json.dumps({"entries":[]})); assert m.check(B,M,F).startswith("BOARD_BAD")
print("ok")
