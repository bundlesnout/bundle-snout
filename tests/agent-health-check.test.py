import importlib.util, time
s=importlib.util.spec_from_file_location("ah","scripts/agent-health-check.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
now=time.time(); iso=lambda ago: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now-ago))
H={"ok":True,"uptimeSec":100,"mem":{"rssMB":120,"restartAtMB":450},"agent":{"loopRunning":True,"streamConnected":True}}
A={"mode":"paper","stats":{"scanErrors":0,"liveErrors":1},"lastDecisionAt":iso(60),"persistence":{"lastSaveAt":iso(120),"lastSaveError":None,"stateBytes":70000,"maxStateBytes":100000},"stream":{"health":{"downPct":1.1}}}
f,_=m.check(H,A,now); assert f==[], f
B=dict(A,mode="live",lastDecisionAt=iso(3600),persistence=dict(A["persistence"],stateBytes=95000,lastSaveError="x"))
f,_=m.check(dict(H,agent={"loopRunning":False,"streamConnected":True}),B,now,{"liveErrors":0,"uptimeSec":5000,"at":now-200})
for k in ["LOOP_STOPPED","MODE_NOT_PAPER","DECISIONS_STALE","SAVE_ERROR","STATE_NEAR_CAP","LIVEERRORS_UP","RESTARTED"]: assert k in f,(k,f)
G=dict(A,stats={"closedTrades":70,"wins":10,"scanErrors":0,"liveErrors":1},persistence=dict(A["persistence"],stateBytes=88000))
f,sm=m.check(H,G,now,{"stateBytes":80000,"at":now-7200,"closedTrades":68,"wins":9,"uptimeSec":50})
assert "STATE_GROWING_FAST" in f,(f,sm); assert sm["newTradesSincePrev"]==2 and sm["newWinsSincePrev"]==1, sm
f,sm=m.check(H,A,now,{"stateBytes":69990,"at":now-7200}); assert "STATE_GROWING_FAST" not in f and sm["stateCapEtaDays"]>3, sm
print("ok")
