import importlib.util, datetime as dt
s=importlib.util.spec_from_file_location("bc","scripts/box-coverage.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
t0=dt.datetime(2026,1,1)
L=[(t0+dt.timedelta(minutes=5*i)).strftime("%Y-%m-%dT%H:%M:%SZ")+" 200 0.3s" for i in range(13)]  # 60 min awake
L+=[(t0+dt.timedelta(minutes=180+5*i)).strftime("%Y-%m-%dT%H:%M:%SZ")+" 200" for i in range(7)]  # pause 120, 30 awake
c=m.coverage(L,hours=24)
assert c["pauses"]==1 and c["medianPauseMin"]==120 and c["longestAwakeMin"]==60, c
assert abs(c["awakePct"]-round(100*90*60/86400,1))<0.01, c
assert m.coverage(["junk"]) is None
print("ok")
