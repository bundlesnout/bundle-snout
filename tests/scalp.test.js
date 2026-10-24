// Paper scalper tests: decoding, curve math, and an end-to-end simulated pump (fake clock, no network).
const assert = require('assert');
process.env.SCALP_LATENCY_MS = '1500';
const bs58m = require('bs58'); const b58 = bs58m.default || bs58m;
const S = require('../scalp');
const cfg = S.SCFG();

// 1) TradeEvent decoding (layout: disc, mint, sol, tok, isBuy, user, ts, vSol, vTok, realSol, realTok)
const mintB = Buffer.alloc(32, 7), userB = Buffer.alloc(32, 9);
const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.round(x))); return b; };
const ev = Buffer.concat([S.DISC, mintB, u64(0.1e9), u64(3e6 * 1e6), Buffer.from([1]), userB, u64(1792848317), u64(40e9), u64(804.75e6 * 1e6), u64(10e9), u64(500e6 * 1e6)]);
const msg = JSON.stringify({ params: { result: { value: { err: null, logs: ['Program log: Instruction: Buy', 'Program data: ' + ev.toString('base64')] } } } });
const [d] = S.tradesFromMessage(msg);
assert.ok(d && d.mint === b58.encode(mintB) && d.buy === true && d.sol === 0.1 && d.vs === 40 && Math.abs(d.vt - 804.75e6) < 1 && d.realTok === 500e6, JSON.stringify(d));
assert.strictEqual(S.tradesFromMessage(msg.replace('"err":null', '"err":{"x":1}')).length, 0, 'failed txs ignored');

// 2) Curve math: round trip with no price move loses only fees (~2*1.25% + 2 tx fees), never gains from slippage
const f = S.buyFill(40, 804.75e6, 0.1, cfg); const back = S.sellValue(40, 804.75e6, f, cfg);
const lossPct = (1 - back / f.cost) * 100;
assert.ok(lossPct > 3.3 && lossPct < 3.6, 'round-trip cost ~3.5% at 0.1 SOL: ' + lossPct);
const fBig = S.buyFill(40, 804.75e6, 0.25, cfg); assert.ok(fBig.tok / 0.25 < f.tok / 0.1, 'bigger size -> worse average price (slippage)');

// 3) End-to-end: bot-looped coin that pumps -> R1 entries after latency, TP exits, all variants accounted
let clock = 1_800_000_000_000; const now = () => clock;
const sc = S.createScalper({ now, log: () => {} });
const K = 30 * 1073e6; let vs = 34; const mint = 'TestMint1111111111111111111111111111111111';
const trade = (user, buy, sol) => { const pvs = vs; vs = buy ? vs + sol : vs - sol; const vt = K / vs; sc.onTrade({ mint, sol, tok: Math.abs(K / pvs - vt), buy, user, ts: 0, vs, vt, realTok: 1 }); };
const bots = ['botA', 'botB', 'botC'];
for (let i = 0; i < 40; i++) { clock += 1000; const b = bots[i % 3]; trade(b, i % 2 === 0, 0.25); if (i % 2 === 0) trade('buyer' + i, true, 0.15); sc.tick(); }
let st = sc.status();
assert.ok(st.signals.R1[0] >= 1, 'R1 L1 signal fired: ' + JSON.stringify(st.signals));
assert.ok(st.entries >= 1 && st.openPositions > 0, 'positions opened after latency');
const pos0 = st.openPositions;
for (let i = 0; i < 25; i++) { clock += 1000; trade('fomo' + i, true, 1.5); sc.tick(); } // strong pump -> TPs
for (let i = 0; i < 20; i++) { clock += 1000; trade('fomo' + i, false, 1.2); sc.tick(); }
clock += 31 * 60e3; sc.tick(); clock += 5000; sc.tick(); // time stops flush the rest
st = sc.status();
assert.strictEqual(st.openPositions, 0, 'everything closed eventually');
assert.ok(st.closes >= pos0, 'closes recorded');
const tp = [...sc.variants.values()].find((v) => v.kind === 'scalp' && v.rule === 'R1' && v.level === 1 && v.size === 0.1 && v.tp === 10 && v.n);
assert.ok(tp && tp.reasons.tp >= 1 && tp.net > 0, 'TP variant profitable on a real pump: ' + JSON.stringify(tp && { n: tp.n, net: tp.net, r: tp.reasons }));
assert.ok(st.scalp.top10.length === 0 || st.scalp.top10[0].netSol >= st.scalp.top10[st.scalp.top10.length - 1].netSol, 'ranking sorted by net');
const zero = [...sc.variants.values()].filter((v) => v.n).every((v) => v.n === Object.values(v.reasons).reduce((a, x) => a + x, 0));
assert.ok(zero, 'exit reasons add up to trade count');
// ride signal must NOT fire on a coin dominated by looping bots
assert.strictEqual(S.rideOk({ uniqueBuyers: 30, buySol: 10, sellSol: 2, net: 8, loopShare: 0.6, sameSize: 0.1, botTxShare: 0.1, progress: 30 }), false);
assert.strictEqual(S.rideOk({ uniqueBuyers: 30, buySol: 10, sellSol: 2, net: 8, loopShare: 0.1, sameSize: 0.1, botTxShare: 0.05, progress: 30 }), true);
// 4) CPU guard: sustained event-loop lag updates lagMs and pauses the stream; clock jumps are ignored
{
  let c = 1_900_000_000_000; const sc2 = S.createScalper({ now: () => c, log: () => {} });
  sc2._setConnected(true); sc2.lagCheck(); // sync lastTick
  for (let i = 0; i < 5; i++) { c += 1000; sc2.lagCheck(); }
  assert.strictEqual(sc2.status().stream.lagMs, 0, 'no lag on 1 s ticks');
  c += 120e3; sc2.lagCheck(); // suspend / clock jump
  assert.strictEqual(sc2.status().stream.lagMs, 0, 'clock jump not counted as lag');
  for (let i = 0; i < 40; i++) { c += 3000; sc2.lagCheck(); } // 2 s lag every tick
  const s2 = sc2.status().stream;
  assert.ok(s2.lagMs > cfg.maxLagMs, 'lagMs tracks sustained lag: ' + s2.lagMs);
  assert.ok(s2.pauses >= 1 && s2.pausedUntil && /event-loop lag/.test(s2.lastError), 'stream paused on lag: ' + JSON.stringify(s2));
  sc2.stop();
}
console.log('scalp tests passed:', JSON.stringify({ signals: st.signals, entries: st.entries, closes: st.closes, tpVariant: { n: tp.n, net: Math.round(tp.net * 1e4) / 1e4, exits: tp.reasons } }));
process.exit(0);
