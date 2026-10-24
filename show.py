import json,sys
d=json.load(open(sys.argv[1]))
for k in ['name','symbol','graduated','curve','creation','history','dev','notes','meta']: print(k, json.dumps(d.get(k), ensure_ascii=False))
b=d.get('bundle');print('bundle', b and json.dumps({k:v for k,v in b.items() if k!='sameSlotBuyers'}), b and json.dumps(b['sameSlotBuyers'][:6]))
print('holders', d['holders']['holderCount'], d['holders']['top10Pct'], d['holders']['excluded'])
print('dex', d['dex'])
print('RISK', d['risk']['level'], d['risk']['score']); [print(' -',f['level'],f['es']) for f in d['risk']['flags']]
