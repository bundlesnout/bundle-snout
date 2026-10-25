// Post-migration shadow arm: decoder, frozen strategy sim, exclusions, paper-only guarantees.
const assert = require('assert'); const crypto = require('crypto'); const fs = require('fs'); const path = require('path');
const P = require('../postmig'); const { decodeTrade } = require('../scalp');
const disc = (n) => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8);
const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
// 1) paper-only by construction: the module never loads wallet/executor code
const src = fs.readFileSync(path.join(__dirname, '..', 'postmig.js'), 'utf8');
for (const bad of ['./exec', './agent', 'Keypair', 'secretKey', 'AGENT_SECRET_KEY', 'sendTransaction', 'sendRawTransaction', 'VersionedTransaction']) assert.ok(!src.includes(bad), 'postmig must not reference ' + bad);
// 2) PumpSwap event decoder (pre-trade reserves -> post-trade)
const pool = P.poolOf('CLrjoTjzQVtViJaHsYm3HHSjuUtuQ1nSVBHqdS2bpump'); assert.strictEqual(pool, 'J22jvaNdL4TSeJxE4uHYgVVkm7JNdGch5Qm4zoRoTPdL');
function poolEv(buy, { base = 1e6, quote = 0.05, bres = 200e6, qres = 70, lp = 20, proto = 5 } = {}) {
  const d = Buffer.alloc(184); disc(buy ? 'BuyEvent' : 'SellEvent').copy(d, 0);
  const w = (i, v) => d.writeBigUInt64LE(BigInt(Math.round(v)), 8 + 8 * i);
  w(1, base * 1e6); w(5, bres * 1e6); w(6, qres * 1e9); w(7, quote * 1e9); w(8, lp); w(10, proto);
  Buffer.from(bs58.decode(pool)).copy(d, 120); return d.toString('base64');
}
const b = P.decodePoolEvent(poolEv(1)); assert.strictEqual(b.buy, 1); assert.strictEqual(b.pool, pool); assert.strictEqual(b.feeBps, 25);
assert.ok(Math.abs(b.bp - 199e6) < 1e-6 && Math.abs(b.qp - 70.05) < 1e-9, 'buy: post-trade reserves');
const s = P.decodePoolEvent(poolEv(0)); assert.strictEqual(s.buy, 0); assert.ok(Math.abs(s.bp - 201e6) < 1e-6 && Math.abs(s.qp - 69.95) < 1e-9, 'sell: post-trade reserves');
assert.strictEqual(P.decodePoolEvent(Buffer.alloc(184).toString('base64')), null, 'unknown discriminator ignored');
assert.strictEqual(P.poolEventsFromLogs(['Program log: x', 'Program data: ' + poolEv(1)]).length, 1);
// 3) curve TradeEvent now carries the creator (offset 177)
const td = Buffer.alloc(266); crypto.createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8).copy(td, 0);
const creator = 'GXwtbTr9DLWSHnSrtVwjTZmEJpdy3BZv1vcfLiHjpump'.slice(0, 43); const ck = new Uint8Array(32).fill(7); Buffer.from(ck).copy(td, 177);
td.writeBigUInt64LE(30n * 10n ** 9n, 97); td.writeBigUInt64LE(1000n * 10n ** 12n, 105);
const dt = decodeTrade(td.toString('base64')); assert.ok(dt && dt.creator === bs58.encode(ck), 'creator decoded'); void creator;
// 4) frozen sim: rising pool -> profit via time stop; crash -> stop loss; slippage skip; nowhale filter
const mkE = (path_, whale = 0) => { const ev = []; let t = 0; const g = 1_000_000;
  for (const [dt, price, buyQ] of path_) { t += dt; const qp = 85, bp = qp / price; ev.push({ at: g + t, buy: 1, quote: buyQ ?? 0.5, bp, qp, user: 'u', feeBps: 25 }); }
  if (whale) ev[1].quote = whale; return { mint: 'M', grad: g, pc: 85 / 300e6, ev }; };
const base = 85 / 300e6; const flat = (n, dt, p) => Array.from({ length: n }, () => [dt, p]);
const F0 = P.VARIANTS.find((v) => v.id === 'F0_P5');
let o = P.pmSim(mkE([...flat(20, 2000, base), ...flat(80, 2000, base * 1.1)]), F0); assert.ok(o && o.why === 'time' && o.ret > 0.05 && o.ret < 0.1, 'time-stop profit ' + JSON.stringify(o));
o = P.pmSim(mkE([...flat(20, 2000, base), [2000, base], [2000, base], [2000, base * 0.5], ...flat(10, 2000, base * 0.5)]), F0); assert.ok(o.why === 'sl' && o.ret < -0.4, 'stop loss');
o = P.pmSim(mkE([...flat(15, 2000, base), [2000, base * 1.05], ...flat(60, 2000, base * 1.05)]), F0); assert.ok(o.skip === 'slippage', 'slippage skip ' + JSON.stringify(o));
const F3 = P.VARIANTS.find((v) => v.id === 'F3_P1nowhale');
assert.strictEqual(P.pmSim(mkE(flat(100, 2000, base), 25), F3), null, 'whale buy blocks nowhale');
// 5) shadow lifecycle with a fake websocket: subscribe on graduation, settle after 5 min, exclusions respected
let t = 1e12; const sent = []; let inst = null;
class FakeWS { constructor() { inst = this; this.h = {}; setImmediate(() => this.h.open && this.h.open()); } on(k, f) { this.h[k] = f; } send(x) { sent.push(JSON.parse(x)); } close() {} }
const pm = P.createPostmig({ WS: FakeWS, now: () => t, log: () => {}, isExcluded: (m, c) => m === 'OwnCoin' || c === 'DevWallet' });
pm.start();
setImmediate(() => {
  pm.onCurveTrade({ mint: 'OwnCoin', vs: 85, vt: 280e6, realTok: 0, creator: 'x' }, { complete: true });
  pm.onCurveTrade({ mint: 'CLrjoTjzQVtViJaHsYm3HHSjuUtuQ1nSVBHqdS2bpump', vs: 85, vt: 280e6, realTok: 0, creator: 'DevWallet' }, { complete: true });
  pm.onCurveTrade({ mint: 'CLrjoTjzQVtViJaHsYm3HHSjuUtuQ1nSVBHqdS2bpump', vs: 60, vt: 500e6, realTok: 100, creator: 'ok' }, { complete: false }); // not a graduation
  assert.strictEqual(pm.status().excluded, 2); assert.strictEqual(pm._watch.size, 0);
  const pm2 = P.createPostmig({ WS: FakeWS, now: () => t, log: () => {} }); pm2.start();
  setImmediate(() => {
    pm2.onCurveTrade({ mint: 'CLrjoTjzQVtViJaHsYm3HHSjuUtuQ1nSVBHqdS2bpump', vs: 85, vt: 280e6, realTok: 0, creator: 'ok' }, { complete: true });
    const sub = sent.filter((x) => x.method === 'logsSubscribe').pop(); assert.deepStrictEqual(sub.params[0], { mentions: [pool] });
    pm2._onMsg({ id: sub.id, result: 77 });
    for (let i = 0; i < 120; i++) { t += 2000; pm2._onMsg({ method: 'logsNotification', params: { subscription: 77, result: { value: { err: null, logs: ['Program data: ' + poolEv(1, { qres: 85 + i * 0.01, bres: 300e6 - i * 1000 })] } } } }); }
    t += 300e3; pm2.tick();
    const st = pm2.status(); assert.strictEqual(st.settled, 1); assert.strictEqual(st.paperOnly, true);
    const f0 = st.variants.find((v) => v.id === 'F0_P5'); assert.strictEqual(f0.n, 1); assert.ok(sent.some((x) => x.method === 'logsUnsubscribe' && x.params[0] === 77), 'unsubscribed');
    pm.stop(); pm2.stop(); console.log('postmig tests OK');
  });
});
