// ALMA live activity: "Right now" state, scan counts, candidates with reasons, rolling log, error recovery, downtime after restart.
const assert = require('assert');
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE; delete process.env.AGENT_ENABLED;
const { createAgent } = require('../agent');
const { cleanCheck, CFG } = require('../radar');
const M = require('../mind');
const cleanRep = () => ({ isPumpFun: true, symbol: 'TEST', curve: { complete: false, progressPct: 30, quote: 'SOL', creatorOnCurve: 'Creator111', mayhemMode: false },
  bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 2, earlyStillHoldPct: 1 },
  dev: { wallet: 'Creator111', hasSold: false, holdingPctSupply: 2 }, holders: { top10Pct: 15 }, risk: { level: 'BAJO' } });
function dipMint(t0) {
  const m = { trades: [], vs: 40, vt: 800e6, complete: false }; let vs = 40, vt = 800e6;
  for (let i = 0; i < 16; i++) { const buy = i % 2 === 1; const sol = buy ? 0.1 : 0.35; const pvs = vs, pvt = vt; const k = vs * vt;
    vs = buy ? vs + sol : vs - sol; vt = k / vs; m.trades.push({ at: t0 - 50e3 + i * 3e3, sol, buy, user: 'W' + (i % 3), vs, vt, pvs, pvt }); }
  m.vs = vs; m.vt = vt; return m;
}
(async () => {
  let t = Date.parse('2026-10-24T12:00:00Z'); const now = () => t;
  const mints = new Map(); let lastAt = new Date(t).toISOString();
  const scalper = { mints, symbol: (m) => (m.startsWith('Coin') ? m.slice(4, 7) : null), solUsd: () => 180, streamInfo: () => ({ connected: true, lastAt, mintsTracked: mints.size }) };
  let scans = 0; let saved = null;
  const store = { name: 'mem', get: async () => saved, put: async (v) => { saved = v; } };
  const cs = { byTag: { agent: 0 } };
  const mk = (extra = {}) => createAgent({ scalper, now, log: () => {}, creditStats: () => cs, analyze: async () => { scans++; cs.byTag.agent += 7; return { ...cleanRep(), dev: { wallet: 'Creator111', hasSold: true, holdingPctSupply: 2 } }; }, cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x', params: null, store, fetchFn: async () => ({ json: async () => ({}) }), ...extra });
  const a = mk(); await a.start();
  let act = a.activity();
  assert.strictEqual(act.key, 'researching', act.key); assert.ok(/^Researching — scanned 0 coins in the last minute/.test(act.headline), act.headline);
  assert.ok(act.log.some((e) => e.kind === 'wake'), 'start logged');
  // a losing belief: setup seen, sat out, shows as candidate with a reason; no scanner credits
  for (let i = 0; i < 30; i++) M.recordOutcome(a.st.bandit, 'dip', 'normal', -15);
  const mA = dipMint(t); mints.set('CoinAAA', mA); a.onTrade({ mint: 'CoinAAA', vs: mA.vs, vt: mA.vt }, mA);
  const mB = dipMint(t); mints.set('CoinBBB', mB); a.onTrade({ mint: 'CoinBBB', vs: mB.vs, vt: mB.vt }, mB);
  act = a.activity();
  assert.strictEqual(act.scannedLastMin, 2); assert.strictEqual(act.coinsToday, 2); assert.strictEqual(scans, 0);
  assert.ok(act.candidates.length === 2 && act.candidates.every((c) => c.verdict === 'pass' && /setup/.test(c.why) && c.edgePct != null && c.barPct != null), JSON.stringify(act.candidates));
  assert.ok(/watching: \$AAA \(/.test(act.headline) || /watching: \$BBB \(/.test(act.headline), act.headline);
  // confident belief: scanner runs, rejects (dev sold) -> candidate shows scanner fail; log has scan + skip
  for (let i = 0; i < 60; i++) M.recordOutcome(a.st.bandit, 'dip', 'normal', 25);
  t += 61e3; lastAt = new Date(t).toISOString(); const mC = dipMint(t); mints.set('CoinCCC', mC); a.onTrade({ mint: 'CoinCCC', vs: mC.vs, vt: mC.vt }, mC);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(scans, 1); act = a.activity();
  const c = act.candidates.find((x) => x.mint === 'CoinCCC'); assert.ok(c && c.verdict === 'rejected' && c.scanner === 'fail' && /scanner said no/.test(c.why), JSON.stringify(c));
  assert.ok(act.log.some((e) => e.kind === 'scan') && act.log.some((e) => e.kind === 'skip'), 'scan + skip in the log');
  // a coin that clears the bar while the scanner gap is in the way: counted once per coin per day as a missed check, not scanned
  const mE = dipMint(t); mints.set('CoinEEE', mE); a.onTrade({ mint: 'CoinEEE', vs: mE.vs, vt: mE.vt }, mE); a.onTrade({ mint: 'CoinEEE', vs: mE.vs, vt: mE.vt }, mE);
  await new Promise((r) => setTimeout(r, 20)); act = a.activity();
  assert.deepStrictEqual([act.scanner.credits.today, act.scanner.credits.perScan, act.scanner.credits.scansMeasured, act.scanner.credits.fullBudgetPerDay], [7, 7, 1, 7 * act.scanner.dailyBudget], JSON.stringify(act.scanner.credits));
  assert.strictEqual(scans, 1, 'gap: no second scan'); assert.deepStrictEqual([act.scanner.missedToday.gap, act.scanner.missedToday.budget], [1, 0], JSON.stringify(act.scanner.missedToday));
  assert.strictEqual(act.candidates.find((x) => x.mint === 'CoinEEE')?.verdict, 'watch');
  // paced budget used up: with the shared Helius day near the cap the coin is missed; with spare credits an extra scan runs (diary note once)
  const keepScans = a.st.scansToday; a.st.scansToday = 999; cs.today = 27000; t += 61e3; lastAt = new Date(t).toISOString();
  const mF = dipMint(t); mints.set('CoinFFF', mF); a.onTrade({ mint: 'CoinFFF', vs: mF.vs, vt: mF.vt }, mF);
  await new Promise((r) => setTimeout(r, 20)); act = a.activity();
  assert.strictEqual(scans, 1, 'no spare credits: no extra scan'); assert.strictEqual(act.scanner.missedToday.budget, 1); assert.strictEqual(act.scanner.bonusToday, 0);
  cs.today = 1000; const mG = dipMint(t); mints.set('CoinGGG', mG); a.onTrade({ mint: 'CoinGGG', vs: mG.vs, vt: mG.vt }, mG);
  await new Promise((r) => setTimeout(r, 20)); act = a.activity();
  assert.strictEqual(scans, 2, 'spare credits: extra scan'); assert.strictEqual(act.scanner.bonusToday, 1); assert.strictEqual(act.scanner.missedToday.budget, 1);
  assert.ok(a.st.thoughts.some((e) => e.kind === 'diary' && /Spare Helius credits/.test(e.text)), 'diary note');
  a.st.scansToday = keepScans; delete cs.today; a.st.lastScanAt = 0;
  // the dev's sell seen on the live stream: skipped before the scanner (no scan, no credits), diary note once
  { t += 61e3; a.st.lastScanAt = 0; const s0 = scans; const mH = dipMint(t); mints.set('CoinHHH', mH);
    a.onTrade({ mint: 'CoinHHH', vs: mH.vs, vt: mH.vt, buy: false, user: 'DevH', creator: 'DevH' }, mH);
    await new Promise((r) => setTimeout(r, 20)); const ah = a.activity();
    assert.strictEqual(scans, s0, 'dev sell seen: no scan'); assert.strictEqual(ah.scanner.devSellSkipsToday, 1);
    assert.ok(/saw the dev sell/.test(ah.candidates.find((x) => x.mint === 'CoinHHH')?.why || ''), JSON.stringify(ah.candidates));
    assert.ok(a.st.thoughts.some((e) => e.kind === 'diary' && /dev I already saw selling/.test(e.text)), 'diary note');
    // someone else's sell does not count as the dev's
    const mI = dipMint(t); mints.set('CoinIII', mI); a.onTrade({ mint: 'CoinIII', vs: mI.vs, vt: mI.vt, buy: false, user: 'W1', creator: 'DevI' }, mI);
    await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(scans, s0 + 1, 'other seller: scanned'); a.st.lastScanAt = 0;
    // the scalper forgot CoinJJJ after its dev sold (idle eviction gives a fresh market object): still skipped, no scan
    t += 61e3; const s1 = scans; const mJ = dipMint(t); mints.set('CoinJJJ', mJ); a.onTrade({ mint: 'CoinJJJ', vs: mJ.vs, vt: mJ.vt, buy: false, user: 'DevJ', creator: 'DevJ' }, { trades: [], vs: mJ.vs, vt: mJ.vt, complete: true });
    t += 15 * 60e3; const mJ2 = dipMint(t); mints.set('CoinJJJ', mJ2); a.onTrade({ mint: 'CoinJJJ', vs: mJ2.vs, vt: mJ2.vt, buy: true, user: 'W2', creator: 'DevJ' }, mJ2);
    await new Promise((r) => setTimeout(r, 20)); const aj = a.activity();
    assert.strictEqual(scans, s1, 'remembered dev sell: no scan'); assert.strictEqual(aj.scanner.devSellRememberedToday, 1, JSON.stringify(aj.scanner));
    assert.ok(/saw the dev sell/.test(aj.candidates.find((x) => x.mint === 'CoinJJJ')?.why || ''), JSON.stringify(aj.candidates)); a.st.lastScanAt = 0; }
  assert.ok(act.log.length <= 30);
  // in a trade: state + detail
  await a._test.openPosition({ mint: 'CoinDDD', symbol: 'DDD', size: 0.01, vs: 40, vt: 800e6, reason: 'r' });
  act = a.activity(); assert.strictEqual(act.key, 'trading'); assert.ok(/^In a trade: \$DDD/.test(act.label), act.label);
  // housekeeping errors are caught and counted, the loop keeps going
  const orig = a.st.positions; a.st.positions = null; a._test.safeTick(); a.st.positions = orig;
  act = a.activity(); assert.strictEqual(act.loop.errorsCaught, 1); assert.ok(act.log.some((e) => e.kind === 'error'));
  // a broken trade event never throws into the stream
  a.onTrade({ mint: 'CoinEEE', vs: 1, vt: 1 }, null); assert.ok(a.activity().loop.errorsCaught >= 2);
  // stale stream -> reconnecting (when nothing else is going on)
  for (const p of [...a.st.positions]) await a._test.closePosition(p, 'test');
  a.st.affect.cooldownUntil = 0; t += 3600e3; act = a.activity();
  assert.ok(['reconnecting', 'resting'].includes(act.key), act.key);
  // restart after a long gap: downtime measured from the last save, activity log kept
  await a.save(); const n = a.activity().log.length; t += 40 * 60e3;
  const b = mk(); await b.start(); const ab = b.activity();
  assert.ok(ab.loop.downtimes.length === 1 && ab.loop.downtimes[0].min === 40, JSON.stringify(ab.loop.downtimes));
  assert.ok(/not running for about 40 min/.test(ab.log[0].text), ab.log[0].text); assert.ok(ab.log.length >= Math.min(30, n));
  assert.ok(ab.coinsToday >= 3, 'coins today carried over ' + ab.coinsToday);
  // status() exposes activity
  assert.ok(b.status().activity && b.status().activity.key);
  a.stop(); b.stop();
  console.log('activity tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
