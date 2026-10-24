// AI trader agent: hard exclusions, scanner gate, paper fills, exits, daily loss limit, live-mode guards.
const assert = require('assert');
process.env.AGENT_EXCLUDE_CA = 'OwnCoin1111111111111111111111111111111pump';
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE;
const { createAgent, signal, ACFG, DEV_WALLET } = require('../agent');
const { cleanCheck, CFG } = require('../radar');
const cleanRep = (over = {}) => ({ isPumpFun: true, symbol: 'TEST', curve: { complete: false, progressPct: 30, quote: 'SOL', creatorOnCurve: 'Creator111', mayhemMode: false },
  bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 2, earlyStillHoldPct: 1 },
  dev: { wallet: 'Creator111', hasSold: false, holdingPctSupply: 2 }, holders: { top10Pct: 15 }, risk: { level: 'BAJO' }, ...over });
// synthetic dip: looping wallets, price falling ~8%
function dipMint(t0) {
  const m = { trades: [], vs: 40, vt: 800e6, complete: false }; let vs = 40, vt = 800e6;
  for (let i = 0; i < 16; i++) { const buy = i % 2 === 1; const sol = buy ? 0.1 : 0.35; const pvs = vs, pvt = vt; const k = vs * vt;
    vs = buy ? vs + sol : vs - sol; vt = k / vs; m.trades.push({ at: t0 - 50e3 + i * 3e3, sol, buy, user: 'W' + (i % 3), vs, vt, pvs, pvt }); }
  m.vs = vs; m.vt = vt; return m;
}
(async () => {
  let t = Date.parse('2026-10-24T12:00:00Z'); const now = () => t; const logs = [];
  let scans = 0; const analyze = async () => { scans++; return cleanRep(); };
  const mints = new Map(); const scalper = { mints, symbol: () => 'TEST', solUsd: () => 180, streamInfo: () => ({}) };
  const mk = (a = analyze, extra = {}) => createAgent({ scalper, now, log: (x) => logs.push(x), analyze: a, cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x', params: null, fetchFn: async () => ({ json: async () => ({ result: { SOLEUR: { c: ['150'] } } }) }), ...extra });
  const M = require('../mind'); const train = (ag, arm, n, pct) => { for (let i = 0; i < n; i++) M.recordOutcome(ag.st.bandit, arm, 'normal', pct); };

  // signal fires on the synthetic dip
  const m = dipMint(t); const sg = signal(m, t, ACFG()); assert.ok(sg && sg.kind === 'dip', 'dip signal'); 

  // 1) own coin is never evaluated
  let a = mk(); await a.start();
  a.onTrade({ mint: process.env.AGENT_EXCLUDE_CA, vs: m.vs, vt: m.vt }, dipMint(t));
  await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(scans, 0, 'excluded coin not scanned'); assert.strictEqual(a.st.positions.length, 0);
  await assert.rejects(a._test.openPosition({ mint: process.env.AGENT_EXCLUDE_CA, symbol: 'OWN', size: 0.02, vs: 40, vt: 800e6, reason: 'x' }), /excluded/);

  // 2) clean coin + signal -> paper BUY with reason, cost capped at 0.02 SOL
  const mintA = 'CoinA11111111111111111111111111111111pump'; const mA = dipMint(t); mints.set(mintA, mA);
  train(a, 'dip', 30, 18); // a confident belief in the dip arm so the Thompson draw is positive
  a.onTrade({ mint: mintA, vs: mA.vs, vt: mA.vt }, mA); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(scans, 1); assert.strictEqual(a.st.positions.length, 1, 'opened');
  const p = a.st.positions[0]; assert.ok(p.cost <= 0.0201 && p.cost >= 0.005, 'size cap ' + p.cost); assert.ok(/scanner says clean/.test(p.reason) && /TP \+20%/.test(p.reason) && /^I'm buying/.test(p.reason), p.reason); assert.strictEqual(p.arm, 'dip');
  // 3) price up 30% -> take profit sell
  p.vs = p.vs * 1.15; p.vt = (mA.vs * mA.vt) / p.vs; a._test.checkExit(p); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(a.st.positions.length, 0, 'closed'); const sell = a.st.trades[0]; assert.strictEqual(sell.side, 'SELL'); assert.ok(sell.pnlSol > 0 && /take profit/.test(sell.reason), sell.reason);
  // cooldown: same coin not re-scanned
  t += 10e3; a.onTrade({ mint: mintA, vs: mA.vs, vt: mA.vt }, mA); await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(scans, 1, 'cooldown');

  // 4) scanner gate rejects bundles, dev-created coins and Mayhem Mode
  const gate = require('../agent').gate; const c = ACFG(), rc = CFG();
  assert.ok(gate(cleanRep({ bundle: { ...cleanRep().bundle, multiWalletTxs: 2 } }), c, cleanCheck, rc).some((x) => /multi-wallet/.test(x)));
  assert.ok(gate(cleanRep({ curve: { ...cleanRep().curve, creatorOnCurve: DEV_WALLET } }), c, cleanCheck, rc).some((x) => /dev's own wallet/.test(x)));
  assert.ok(gate(cleanRep({ curve: { ...cleanRep().curve, mayhemMode: true } }), c, cleanCheck, rc).some((x) => /Mayhem/.test(x)));
  assert.ok(gate(cleanRep({ holders: { top10Pct: 45 } }), c, cleanCheck, rc).some((x) => /top-10/.test(x)));
  assert.deepStrictEqual(gate(cleanRep(), c, cleanCheck, rc), [], 'clean passes');

  // 5) stop loss + daily loss limit pause
  const b = mk(); await b.start(); b.st.dayPnl = -0.025;
  await b._test.openPosition({ mint: 'CoinB', symbol: 'B', size: 0.02, vs: 40, vt: 800e6, reason: 'r' });
  const pb = b.st.positions[0]; pb.vs = 34; pb.vt = (40 * 800e6) / 34; b._test.checkExit(pb); await new Promise((r) => setTimeout(r, 20));
  assert.ok(/stop loss/.test(b.st.trades[0].reason)); assert.ok(b.status().state.startsWith('paused'), b.status().state);
  assert.ok(b.st.decisions.some((d) => d.action === 'PAUSE'));

  // 6) live mode without a key halts; kill switch stops entries
  process.env.AGENT_MODE = 'live'; const l = mk(); assert.ok(/AGENT_SECRET_KEY/.test(l.status().halted)); assert.strictEqual(l.status().state, 'halted'); delete process.env.AGENT_MODE;
  process.env.AGENT_ENABLED = '0'; const k = mk(); const mC = dipMint(t); k.onTrade({ mint: 'CoinC', vs: mC.vs, vt: mC.vt }, mC); await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(k.st.positions.length, 0); assert.strictEqual(k.status().state, 'stopped'); delete process.env.AGENT_ENABLED;

  // 7) status shape for the page
  const s = a.status(); for (const key of ['mode', 'wallet', 'balance', 'pnl', 'stats', 'rules', 'positions', 'trades', 'decisions']) assert.ok(key in s, key);
  assert.strictEqual(s.mode, 'paper'); assert.ok(s.rules.neverTrades.includes(process.env.AGENT_EXCLUDE_CA));
  assert.ok(!JSON.stringify(s).match(/secret/i), 'no secret in status');
  for (const key of ['identity', 'mind', 'bodyFund', 'feeSplit', 'fundings']) assert.ok(key in s, key);
  assert.ok(/Not affiliated with Zerebro/.test(s.identity.ancestor.disclaimer));
  assert.strictEqual(s.feeSplit.shares.reduce((x, y) => x + y.bps, 0), 10000); assert.strictEqual(s.feeSplit.shares[0].address, '4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy'); assert.strictEqual(s.feeSplit.shares[1].address, DEV_WALLET);
  assert.ok(a.st.bandit.dip.all.n === 31, 'trade outcome recorded in the bandit');

  // 8) learning: a losing arm is avoided (bandit sits out), and the sit-out is explained in first person
  const lz = mk(); await lz.start(); train(lz, 'dip', 60, -17); let scans0 = scans;
  const mD = dipMint(t); mints.set('CoinD', mD); lz.onTrade({ mint: 'CoinD', vs: mD.vs, vt: mD.vt }, mD); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(scans, scans0, 'no scanner credits spent on a losing arm'); assert.ok(lz.st.decisions.some((d) => d.action === 'SIT_OUT' && /Sitting out/.test(d.reason)));
  const W = M.armWeights(lz.st.bandit, 'normal', lz.arms, 1.75, M.rng(3)); assert.ok(W.dip < 0.05, 'dip weight collapses ' + W.dip);

  // 9) Kelly sizing caps + drawdown throttle + hibernation
  const cfgK = { kellyFraction: 0.25, maxTradeSol: 0.02, sizePct: 20, minTradeSol: 0.005 };
  assert.strictEqual(M.kellySize({ kelly: 0.9, equity: 10, free: 10, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0.02, 'hard cap');
  assert.strictEqual(M.kellySize({ kelly: -0.1, equity: 1, free: 1, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0, 'no edge, no bet');
  assert.strictEqual(M.kellySize({ kelly: 0.5, equity: 0.012, free: 0.004, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0, 'never more than free balance');
  const dcfg = { ddSoftPct: 10, ddHibernatePct: 35 }; assert.strictEqual(M.ddState(1, 1, dcfg).mult, 1); assert.ok(M.ddState(0.78, 1, dcfg).mult < 0.7); assert.strictEqual(M.ddState(0.6, 1, dcfg).level, 'hibernate');
  const h = mk(); await h.start(); h.st.peak = 0.2; await h._test.openPosition({ mint: 'CoinH', symbol: 'H', size: 0.02, vs: 40, vt: 800e6, reason: 'r' });
  const ph = h.st.positions[0]; ph.vs = 30; ph.vt = (40 * 800e6) / 30; h._test.checkExit(ph); await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.st.decisions.some((d) => d.action === 'HIBERNATE'), 'hibernates in deep drawdown'); assert.ok(h.status().state.startsWith('hibernating') || h.status().state.startsWith('paused'));

  // 10) regime detection from stream activity
  const rg = M.newRegime(); let tt = Date.parse('2026-10-24T10:00:00Z');
  for (let m = 0; m < 60; m++) for (let i = 0; i < 20; i++) M.regimeObserve(rg, tt + m * 60e3 + i * 1000, 1, i === 0);
  M.regimeUpdate(rg, tt + 60 * 60e3); assert.strictEqual(rg.label, 'normal');
  for (let m = 60; m < 72; m++) for (let i = 0; i < 20; i++) M.regimeObserve(rg, tt + m * 60e3 + i * 1000, 4, false);
  M.regimeUpdate(rg, tt + 72 * 60e3); assert.strictEqual(rg.label, 'hot', 'heat ' + rg.heat);

  // 11) Body Fund ladder + purchases
  const bf = M.bodyFund({ fundSol: 1, eurPerSol: 150, purchases: [{ tier: 'eyes', eur: 30, tx: 'x' }] });
  assert.strictEqual(bf.ladder[0].status, 'bought'); assert.strictEqual(bf.ladder[1].status, 'funded'); assert.strictEqual(bf.ladder[4].status, 'locked'); assert.ok(bf.totalEur > 500 && bf.totalEur < 600, bf.totalEur);
  for (const b of M.BODY) assert.ok(/^https:\/\//.test(b.url) && b.eur > 0);
  assert.strictEqual(a.status().bodyFund.fundSol, 0, 'paper P&L never counts toward the Body Fund');

  // 12) diary at the Madrid day rollover + snapshot/restore round trip
  const dy = mk(); await dy.start(); t += 24 * 3600e3; dy._test.rollDay();
  assert.strictEqual(dy.st.diaries.length, 1); assert.ok(/ALMA diary, day 1/.test(dy.st.diaries[0].post) && dy.st.diaries[0].post.length < 280);
  assert.ok(dy.diary().today.draft);
  const snap = a._test.snapshot(); assert.ok(snap.startsWith('gz:')); const a2 = mk(); a2._test.restore(snap); assert.strictEqual(a2.st.bandit.dip.all.n, 31); assert.strictEqual(a2.st.trades.length, a.st.trades.length);

  // 13) funding reader: dev transfers and pump.fun fee distributions count; my own txs don't
  process.env.AGENT_PUBLIC_KEY = 'Agent1111111111111111111111111111111111111';
  const txs = { s1: { keys: [DEV_WALLET, 'Agent1111111111111111111111111111111111111', '11111111111111111111111111111111'], pre: [5e9, 0], post: [4e9, 1e9] },
    s2: { keys: ['Cranker', 'Agent1111111111111111111111111111111111111', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], pre: [1e9, 1e9], post: [1e9, 1.05e9] },
    s3: { keys: ['Agent1111111111111111111111111111111111111', 'x'], pre: [2e9, 0], post: [1.9e9, 0] } };
  const rpc = async (m, p) => m === 'getSignaturesForAddress' ? Object.keys(txs).map((k) => ({ signature: k, err: null })) : m === 'getTransaction' ? { blockTime: 1792850000, transaction: { message: { accountKeys: txs[p[0]].keys.map((k) => ({ pubkey: k })) } }, meta: { preBalances: txs[p[0]].pre, postBalances: txs[p[0]].post } } : { value: 0 };
  const fz = mk(analyze, { rpc }); await fz._test.scanFunding(); delete process.env.AGENT_PUBLIC_KEY;
  assert.strictEqual(fz.st.fundings.length, 2); assert.ok(fz.st.fundings.some((f) => /dev wallet/.test(f.source) && f.sol === 1)); assert.ok(fz.st.fundings.some((f) => /creator fees/.test(f.source) && f.sol === 0.05));
  await fz._test.scanFunding(); assert.strictEqual(fz.st.fundings.length, 2, 'no double counting');
  console.log('agent tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
