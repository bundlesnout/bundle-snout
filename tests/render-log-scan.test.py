import importlib.util
s=importlib.util.spec_from_file_location("rl","scripts/render-log-scan.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
L=lambda msg,lv="info",t="2026-01-01T00:00:00Z":{"message":msg,"timestamp":t,"labels":[{"name":"level","value":lv}]}
logs=[L("[radar] dirty x error"),L("TypeError: cannot read 12 of undefined"),L("TypeError: cannot read 13 of undefined"),
      L("boom","error"),L("all good"),L("rpc fail 4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy Error 429")]
c,sample,levels=m.classify(logs)
assert sum(c.values())==4, c
assert c[m.signature("TypeError: cannot read 99 of undefined")]==2, c
assert "<addr>" in m.signature("x 4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy"), "addr"
assert levels["error"]==1 and levels["info"]==5
c2,_,_=m.classify([L('[state] {"lastSaveError":null,"scanErrors":0,"x":1}')])
assert sum(c2.values())==0, c2
print("ok")
