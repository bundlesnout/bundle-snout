// Open positions and paper entries read the bonding curve account directly (the shared stream misses trades on Render):
// a stop crossed between two stream trades fires on the next curve poll, at the polled price; entries fill at the live curve.
const assert = require('assert');
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE; process.env.AGENT_SEED = '7';
const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const { createAgent, decodeCurve } = require('../agent');
const { cleanCheck, CFG } = require('../radar');
const curveBuf = (vs, vt, complete = false) => { const b = Buffer.alloc(81); b.writeBigUInt64LE(BigInt(Math.round(vt * 1e6)), 8); b.writeBigUInt64LE(BigInt(Math.round(vs * 1e9)), 16); b.writeBigUInt64LE(BigInt(Math.round((vt - 279.9e6) * 1e6)), 24); b[48] = complete ? 1 : 0; return b; };
(async () => {
  // decoder: layout of pump.fun BondingCurve
  const d = decodeCurve(curveBuf(30.0065, 1072767364.775885), 5); assert.ok(Math.abs(d.vs - 30.0065) < 1e-9 && Math.abs(d.vt - 1072767364.775885) < 1e-3 && !d.complete && d.slot === 5);
  assert.ok(decodeCurve(curveBuf(85, 280e6, true)).complete);
  let t = Date.parse('2026-10-26T12:00:00Z'); const now = () => t;
  let curve = { vs: 40, vt: 800e6 }, slot = 100, calls = 0, status = 200;
  const fetchFn = async (url, opt) => {
    const body = opt?.body ? JSON.parse(opt.body) : {};
    if (body.method === 'getAccountInfo') { calls++; return { status, json: async () => ({ result: { context: { slot: slot++ }, value: { data: [curveBuf(curve.vs, curve.vt).toString('base64'), 'base64'] } } }) }; }
    return { status: 200, json: async () => ({ result: { SOLEUR: '90' } }) };
  };
  const mint = 'CHpPBovmkCN49Mm9qGewJ5iLPFYMbAWhXYy6wdjApump';
  const a = createAgent({ scalper: { mints: new Map(), symbol: () => 'T', solUsd: () => 100, streamInfo: () => ({}) }, now, log: () => {}, analyze: async () => ({}), cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x', params: null, fetchFn, quiet: true });
  await a.start(); a.stop();
  await a._test.openPosition({ mint, symbol: 'T', size: 0.005, vs: 40, vt: 800e6, reason: 'r', signal: 'momentum' });
  const p = a.st.positions[0]; const sl = p.sl;
  // price unchanged on the curve: no exit
  await a._test.pollPositions(); await settle(); assert.strictEqual(a.st.positions.length, 1); assert.strictEqual(p.polls, 1);
  // the curve dumps ~10% but the stream sends nothing: the poll alone must fire the stop, at the polled (real) price
  curve = { vs: 37, vt: (40 * 800e6) / 37 }; await a._test.pollPositions(); await settle();
  assert.strictEqual(a.st.positions.length, 0, 'stop fired from the curve poll');
  const s = a.st.trades[0]; assert.ok(/stop loss/.test(s.reason), s.reason); assert.ok(s.pnlPct <= -sl && s.pnlPct > -19, 'filled near the real price, not a later tick: ' + s.pnlPct);
  assert.strictEqual(s.feed.curvePolls, 2); assert.strictEqual(s.feed.curveUpdates, 1);
  // an older slot never overwrites a newer state
  curve = { vs: 40, vt: 800e6 };
  await a._test.openPosition({ mint, symbol: 'T', size: 0.005, vs: 40, vt: 800e6, reason: 'r', signal: 'momentum' });
  const q = a.st.positions[0]; q.slot = 10e6; const vs0 = q.vs; curve = { vs: 30, vt: (40 * 800e6) / 30 };
  await a._test.pollPositions(); await settle(); assert.strictEqual(a.st.positions.length, 1, 'stale slot ignored'); assert.strictEqual(q.vs, vs0);
  // 429 backs the poller off instead of hammering the RPC
  q.slot = 0; status = 429; const c0 = calls; await a._test.pollPositions(); await a._test.pollPositions(); assert.strictEqual(calls, c0 + 1, 'backoff after 429');
  assert.ok(a._test.FEED.pollErrors >= 1);
  // the curve read is what the paper entry fills at (scanAndEnter path): curveState returns the live reserves
  status = 200; curve = { vs: 41, vt: (40 * 800e6) / 41 }; const cs = await a._test.curveState(mint); assert.ok(Math.abs(cs.vs - 41) < 1e-9);

  // full path: a signal on a stale stream state, the paper buy fills at the curve account's current reserves
  {
    const cleanRep = { isPumpFun: true, symbol: 'TEST', curve: { complete: false, progressPct: 30, quote: 'SOL', creatorOnCurve: 'Creator111', mayhemMode: false },
      bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 2, earlyStillHoldPct: 1 },
      dev: { wallet: 'Creator111', hasSold: false, holdingPctSupply: 2 }, holders: { top10Pct: 15 }, risk: { level: 'BAJO' } };
    const mk = { trades: [], vs: 40, vt: 800e6, complete: false }; let vs = 40, vt = 800e6;
    for (let i = 0; i < 16; i++) { const buy = i % 2 === 1; const sol = buy ? 0.1 : 0.35; const pvs = vs, pvt = vt; const k = vs * vt; vs = buy ? vs + sol : vs - sol; vt = k / vs; mk.trades.push({ at: t - 50e3 + i * 3e3, sol, buy, user: 'W' + (i % 3), vs, vt, pvs, pvt }); }
    mk.vs = vs; mk.vt = vt;
    const mints = new Map([[mint, mk]]);
    const b = createAgent({ scalper: { mints, symbol: () => 'T', solUsd: () => 100, streamInfo: () => ({}) }, now, log: () => {}, analyze: async () => cleanRep, cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x', params: null, fetchFn, quiet: true });
    await b.start(); b.stop(); const M = require('../mind'); for (let i = 0; i < 30; i++) M.recordOutcome(b.st.bandit, 'dip', 'normal', 18);
    curve = { vs: vs * 1.01, vt: (vs * vt) / (vs * 1.01) }; // the curve moved on since the last trade the stream caught
    b.onTrade({ mint, vs, vt }, mk); await settle(400);
    assert.strictEqual(b.st.positions.length, 1, 'opened');
    const e = b.st.positions[0]; assert.ok(Math.abs(e.entryVs - curve.vs) < 1e-9, 'entry at the live curve ' + e.entryVs + ' vs ' + curve.vs); assert.strictEqual(e.priceFrom, 'curve account');
    assert.strictEqual(mk.vs, vs, 'the shared stream state is not modified');
  }
  console.log('feed tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
