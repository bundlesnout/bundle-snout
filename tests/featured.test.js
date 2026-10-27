// featured-board random-entry paper test: picks, fills from the curve account, exits, skips, status, state size
const assert = require('assert');
const { PublicKey, Keypair } = require('@solana/web3.js');
const { createFeatured, decodeCurveFull, FEATURED_VARIANTS } = require('../featured');
const { createAgent } = require('../agent');

function curveBuf(vs, vt, complete = false, creator = null) {
  const b = Buffer.alloc(81); b.writeBigUInt64LE(BigInt(Math.round(vt * 1e6)), 8); b.writeBigUInt64LE(BigInt(Math.round(vs * 1e9)), 16);
  b.writeBigUInt64LE(BigInt(Math.round((vt - 279.9e6) * 1e6)), 24); b[48] = complete ? 1 : 0; if (creator) new PublicKey(creator).toBuffer().copy(b, 49); return b;
}
(async () => {
  // decoder reads reserves, complete flag and creator
  const cr = Keypair.generate().publicKey.toBase58();
  const d = decodeCurveFull(curveBuf(40, 800e6, false, cr)); assert.ok(Math.abs(d.vs - 40) < 1e-9 && Math.abs(d.vt - 800e6) < 1 && !d.complete && d.creator === cr);
  assert.strictEqual(FEATURED_VARIANTS.length, 18); assert.ok(FEATURED_VARIANTS.some((v) => v.id === 'feat_lt8k_20_15_15') && FEATURED_VARIANTS.some((v) => v.id === 'rand_20to60k_50_8_5'));

  let t = Date.parse('2026-10-27T12:00:00Z'); const now = () => t;
  const mk = () => { let k; do { k = Keypair.generate().publicKey.toBase58(); } while (!k); return k; };
  const A = mk(), B = mk(), C = mk(), X = mk(), R = mk();
  const curves = new Map(); const set = (m, vs, vt, complete = false, creator = null) => curves.set(m, curveBuf(vs, vt, complete, creator));
  const DEV = Keypair.generate().publicKey.toBase58();
  const entries = [
    { m: A, c: 'solana:mainnet', lp: 'pump', p: 10, mc: 5000, t: 'AAA', dw: 'x' },
    { m: B, c: 'solana:mainnet', lp: 'pump', p: 50, mc: 12000, t: 'BBB', dw: DEV },  // created by a protected wallet: never picked
    { m: C, c: 'solana:mainnet', lp: 'pump', p: 100, mc: 50000, t: 'CCC', gd: 1 }, // graduated: not on the curve
    { m: 'So11111111111111111111111111111111111111112', c: 'solana:mainnet', lp: '', p: 100, mc: 1e10 },
  ];
  let rpcCalls = 0, boardCalls = 0;
  const fetchFn = async (url, opt) => {
    if (/boards\/movers/.test(url)) { boardCalls++; return { ok: true, status: 200, json: async () => ({ board: 'movers', entries }) }; }
    rpcCalls++; const body = JSON.parse(opt.body); assert.strictEqual(body.method, 'getMultipleAccounts');
    const inv = new Map(); for (const m of [A, B, C, X, R]) inv.set(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(m).toBuffer()], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58(), m);
    return { status: 200, json: async () => ({ result: { value: body.params[0].map((pda) => { const m = inv.get(pda); const b = m && curves.get(m); return b ? { data: [b.toString('base64'), 'base64'] } : null; }) } }) };
  };
  const state = {};
  const mints = new Map([[R, { complete: false, lastAt: t - 10e3, mcSol: 50 }], [X, { complete: false, lastAt: t - 10e3, mcSol: 60, devSoldSeen: true }]]); // R = $5k at $100/SOL; X: dev sold -> skipped
  let dirty = 0;
  const F = createFeatured({ getState: () => state, fetchFn, now, rng: () => 0, streamMints: () => mints, solUsd: () => 100, excluded: () => false, isProtected: (w) => w === DEV, devSold: () => false, onDirty: () => dirty++ });
  await F.refreshBoard(); assert.strictEqual(boardCalls, 1);
  const featPicked = state.open.filter((p) => p.v.startsWith('feat_')).length;
  assert.strictEqual(featPicked, 0, 'mints that do not end in "pump" are not pump.fun curve coins: skipped');
  assert.strictEqual(state.open.filter((p) => p.v.startsWith('rand_lt8k_')).length, 3, 'baseline: one random non-featured coin, all three exit sets');
  assert.ok(state.open.every((p) => p.mint !== X), 'dev-sold coin never picked');
  // fill: before the delay nothing happens, after it the curve price is used
  set(R, 50, 1000e6);
  t += 2000; await F.poll(); assert.ok(state.open.every((p) => p.pending), 'waits for the fill delay');
  t += 4000; await F.poll(); assert.ok(state.open.every((p) => !p.pending && p.cost > 0.005 && p.tok > 0), 'filled at the curve price');
  assert.strictEqual(state.fills, 3);
  // price up ~+25% net: the +20 exit takes profit, the others keep running (or hit their own levels)
  set(R, 56.5, 1000e6 * 50 / 56.5); t += 3000; await F.poll();
  const tp = state.closed.find((c) => c.v === 'rand_lt8k_20_15_15'); assert.ok(tp && /^take profit/.test(tp.why), 'took profit at +20');
  assert.ok(state.open.some((p) => p.v === 'rand_lt8k_50_8_5'), '+50 exit still open');
  for (let i = 0; i < 10; i++) { t += 30e3; await F.poll(); } assert.ok(state.closed.some((c) => c.v === 'rand_lt8k_50_8_5' && /^time stop/.test(c.why)), '5 min time stop');
  set(R, 30, 1000e6 * 50 / 30); t += 3000; await F.poll(); assert.ok(state.closed.some((c) => c.v === 'rand_lt8k_30_10_10' && /^stop loss/.test(c.why)), 'stop loss on a dump');
  assert.strictEqual(state.open.length, 0);
  const st = F.status(); const v = st.variants.find((x) => x.id === 'rand_lt8k_20_15_15'); assert.ok(v.closed === 1 && v.wins === 1 && v.avgPct >= 20 && v.edge.startsWith('too few'));
  assert.ok(st.compare.length === 9 && st.board.entries === 4 && st.familyZ > 2.9);
  // box paused / restarted: a position nobody watched for > 60 s is voided, not closed at a price I could never have got
  { const st2 = {}; const F2 = createFeatured({ getState: () => st2, fetchFn, now, rng: () => 0, streamMints: () => mints, solUsd: () => 100, excluded: () => false, isProtected: (w) => w === DEV, devSold: () => false });
    mints.get(R).lastAt = t; set(R, 50, 1000e6); await F2.refreshBoard(); t += 6000; await F2.poll(); assert.ok(st2.open.length === 3 && st2.open.every((p) => !p.pending));
    t += 3000; await F2.poll(); assert.strictEqual(st2.open.length, 3, 'normal 3 s polls keep it open');
    set(R, 20, 1000e6 * 50 / 20); t += 77 * 60e3; await F2.poll();
    assert.ok(st2.open.length === 0 && st2.closed.length === 0 && st2.voided === 3, 'unwatched for 77 min: voided, no -60% stop counted');
    assert.strictEqual(F2.status().voidedUnwatched, 3); set(R, 30, 1000e6 * 50 / 30); }
  // graduated before the fill -> dropped
  mints.get(R).lastAt = t; await F.refreshBoard(); assert.strictEqual(state.open.length, 3); set(R, 85, 280e6, true); t += 6000; await F.poll(); assert.ok(state.dropped >= 3 && state.open.length === 0, 'graduated before the fill: dropped');

  // featured picks: real pump.fun mints (end in 'pump')
  const s2 = {}; const F2 = createFeatured({ getState: () => s2, fetchFn: async (url) => ({ ok: true, json: async () => ({ entries: [{ m: '7emEGMge9ucu2GZVCKxoWqnXTGfFFunczgbgiaqtpump', c: 'solana:mainnet', lp: 'pump', pg: 'pump', pa: 'SOL', p: 20, mc: 6000, t: 'MPIE' }, { m: 'CSXivEZa5zbCJFMHpP2JXpTi9sjznxT6AqH9PpqRpump', c: 'solana:mainnet', lp: 'pump', pg: 'pump', pa: 'SPX', p: 45, mc: 7000, t: 'SPXQ' }, { m: '5F8Y9HddfpttXg3SXiTU1aPVLwTMSxkP5sGchogNpump', c: 'solana:mainnet', lp: 'pump', pg: 'pump', p: 60, mc: 15000, t: 'G', dw: DEV }] }) }), now, rng: () => 0, streamMints: () => new Map(), solUsd: () => 100, isProtected: (w) => w === DEV });
  await F2.refreshBoard(); assert.strictEqual(s2.open.length, 3, 'one featured pick (under $8k) x 3 exits; SPX-quoted and protected-creator coins are never picked'); assert.ok(s2.open.every((p) => p.mint.startsWith('7emE') && p.rk === 1 && p.v.startsWith('feat_lt8k_')));
  await F2.refreshBoard(); assert.strictEqual(s2.open.length, 3, 'same coin not opened twice in the same variant');

  { const s3 = {}; const F3 = createFeatured({ getState: () => s3, fetchFn, now, rng: () => 0, streamMints: () => new Map([[R, { complete: false, lastAt: t, mcSol: 50 }]]), solUsd: () => 100 });
    set(R, 1327, 710e6); await F3.refreshBoard(); t += 6000; await F3.poll(); assert.ok(s3.open.length === 0 && s3.skips['dropped: not a SOL-quoted curve'] === 3, 'token-quoted curve dropped'); }
  { // 403 from pump.fun's Cloudflare: back off 30 min instead of knocking every minute
    let calls = 0; const s4 = {}; const F4 = createFeatured({ getState: () => s4, fetchFn: async () => { calls++; return { ok: false, status: 403 }; }, now });
    await F4.refreshBoard(); await F4.refreshBoard(); assert.strictEqual(calls, 1); assert.ok(/403/.test(F4.status().board.lastError) && F4.status().board.nextTryAt);
    t += 31 * 60e3; await F4.refreshBoard(); assert.strictEqual(calls, 2); }
  { // baseline from a list provider (box runner: pump.fun recently-traded coins), never a board coin
    const s5 = {}; const F5 = createFeatured({ getState: () => s5, fetchFn: async () => ({ ok: true, json: async () => ({ entries: [{ m: '7emEGMge9ucu2GZVCKxoWqnXTGfFFunczgbgiaqtpump', c: 'solana:mainnet', pg: 'pump', pa: 'SOL', p: 20, mc: 6000 }] }) }), now, rng: () => 0,
      baseline: async () => [{ mint: '7emEGMge9ucu2GZVCKxoWqnXTGfFFunczgbgiaqtpump', mcUsd: 5000, lastAt: t, complete: false }, { mint: R, mcUsd: 5000, lastAt: t, complete: false }, { mint: X, mcUsd: 5000, lastAt: t - 600e3, complete: false }] });
    await F5.refreshBoard(); const rb = s5.open.filter((p) => p.v.startsWith('rand_')); assert.ok(rb.length === 3 && rb.every((p) => p.mint === R), 'baseline = recent non-board coin'); }
  // wired into ALMA: status exposes it, the snapshot carries it and stays under the cap with a full book
  const ag = createAgent({ scalper: { mints: new Map(), symbol: () => 'T', solUsd: () => 100, streamInfo: () => ({}) }, now, log: () => {}, analyze: async () => ({}), cleanCheck: () => ({ ok: false, reasons: ['x'] }), rpc: null, params: null, fetchFn: async () => ({ json: async () => ({}) }), quiet: true });
  assert.ok(ag.status().shadowFeatured && ag.status().shadowFeatured.variants.length === 18);
  const sh = ag.st.shadow.featured; for (let i = 0; i < 150; i++) sh.open.push({ v: FEATURED_VARIANTS[i % 18].id, mint: Keypair.generate().publicKey.toBase58(), sym: 'SYMBOL' + i, mc: 12345, rk: 7, pickAt: t, at: t, solIn: 0.00493, tok: 123456.789, cost: 0.005024, vs: 41.23456789, vt: 780123456.123456, tp: 20, sl: 15, hold: 15 });
  for (const v of FEATURED_VARIANTS) sh.byVar[v.id] = { n: 500, wins: 100, tp: 90, net: -0.0123, s1: -1234.5, s2: 98765, eq: -0.0123, pk: 0.001, dd: 0.0133, d: { '2026-10-24': [100, -50], '2026-10-25': [100, -50], '2026-10-26': [100, -50], '2026-10-27': [100, -50] } };
  for (let i = 0; i < 30; i++) sh.closed.push({ v: FEATURED_VARIANTS[0].id, mint: Keypair.generate().publicKey.toBase58(), sym: 'X', mc: 5000, rk: 3, at: new Date(t).toISOString(), heldMin: 3.2, pnlPct: -8.1, why: 'stop loss -8.1%' });
  const raw = ag._test.snapshot(); console.log('featured worst-case state add-on (alone, b64 bytes):', raw.length); assert.ok(raw.length < 40000, 'full featured book adds well under the cap');
  ag._test.restore(raw); assert.strictEqual(ag.st.shadow.featured.open.length, 150, 'restored after a deploy');
  console.log('featured tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
