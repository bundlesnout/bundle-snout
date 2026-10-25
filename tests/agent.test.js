// AI trader agent: hard exclusions, scanner gate, paper fills, exits, daily loss limit, live-mode guards.
const assert = require('assert');
process.env.AGENT_EXCLUDE_CA = 'OwnCoin1111111111111111111111111111111pump';
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE;
process.env.AGENT_SEED = '42'; // deterministic bandit sampling
// drain pending async work (scanner gate, fills) by event-loop turns instead of a wall-clock sleep
const settle = async (turns = 200) => { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); };
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
  await settle(); assert.strictEqual(scans, 0, 'excluded coin not scanned'); assert.strictEqual(a.st.positions.length, 0);
  await assert.rejects(a._test.openPosition({ mint: process.env.AGENT_EXCLUDE_CA, symbol: 'OWN', size: 0.02, vs: 40, vt: 800e6, reason: 'x' }), /excluded/);

  // 2) clean coin + signal -> paper BUY with reason, cost capped at 0.02 SOL
  const mintA = 'CoinA11111111111111111111111111111111pump'; const mA = dipMint(t); mints.set(mintA, mA);
  train(a, 'dip', 30, 18); // a confident belief in the dip arm so the Thompson draw is positive
  a.onTrade({ mint: mintA, vs: mA.vs, vt: mA.vt }, mA); await settle();
  assert.strictEqual(scans, 1); assert.strictEqual(a.st.positions.length, 1, 'opened');
  const p = a.st.positions[0]; assert.ok(p.cost <= 0.0201 && p.cost >= 0.005, 'size cap ' + p.cost); assert.ok(/scanner says clean/.test(p.reason) && /TP \+20%/.test(p.reason) && /^I'm buying/.test(p.reason), p.reason); assert.strictEqual(p.arm, 'dip');
  // 3) price up 30% -> take profit sell
  p.vs = p.vs * 1.15; p.vt = (mA.vs * mA.vt) / p.vs; a._test.checkExit(p); await settle();
  assert.strictEqual(a.st.positions.length, 0, 'closed'); const sell = a.st.trades[0]; assert.strictEqual(sell.side, 'SELL'); assert.ok(sell.pnlSol > 0 && /take profit/.test(sell.reason), sell.reason);
  // cooldown: same coin not re-scanned
  t += 10e3; a.onTrade({ mint: mintA, vs: mA.vs, vt: mA.vt }, mA); await settle(); assert.strictEqual(scans, 1, 'cooldown');

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
  const pb = b.st.positions[0]; pb.vs = 34; pb.vt = (40 * 800e6) / 34; b._test.checkExit(pb); await settle();
  assert.ok(/stop loss/.test(b.st.trades[0].reason)); assert.ok(b.status().state.startsWith('paused'), b.status().state);
  assert.ok(b.st.decisions.some((d) => d.action === 'PAUSE'));
  { const sp = b.status(); assert.ok(sp.pnl.oneTimeAccountSol > 0, 'one-time account shown'); assert.ok(Math.abs(sp.pnl.netSol - (sp.balance.equitySol - sp.balance.startSol)) < 2e-6, `net P&L matches equity: ${sp.pnl.netSol} vs ${sp.balance.equitySol - sp.balance.startSol}`); }

  // 6) live mode without a key halts; kill switch stops entries
  process.env.AGENT_MODE = 'live'; const l = mk(); assert.ok(/AGENT_SECRET_KEY/.test(l.status().halted)); assert.strictEqual(l.status().state, 'halted'); delete process.env.AGENT_MODE;
  process.env.AGENT_ENABLED = '0'; const k = mk(); const mC = dipMint(t); k.onTrade({ mint: 'CoinC', vs: mC.vs, vt: mC.vt }, mC); await settle(); assert.strictEqual(k.st.positions.length, 0); assert.strictEqual(k.status().state, 'stopped'); delete process.env.AGENT_ENABLED;

  // 7) status shape for the page
  const s = a.status(); for (const key of ['mode', 'wallet', 'balance', 'pnl', 'stats', 'rules', 'positions', 'trades', 'decisions']) assert.ok(key in s, key);
  assert.strictEqual(s.mode, 'paper'); assert.ok(s.rules.neverTrades.includes(process.env.AGENT_EXCLUDE_CA));
  assert.ok(!JSON.stringify(s).match(/secret/i), 'no secret in status');
  for (const key of ['identity', 'mind', 'bodyFund', 'feeSplit']) assert.ok(key in s, key);
  for (const key of ['fundings', 'fundingTotalSol', 'withdrawals', 'withdrawnTotalSol']) assert.ok(!(key in s), `${key} must not be public`);
  assert.ok(/Not affiliated with Zerebro/.test(s.identity.ancestor.disclaimer));
  assert.strictEqual(s.feeSplit.shares.reduce((x, y) => x + y.bps, 0), 10000); assert.strictEqual(s.feeSplit.shares[0].address, '4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy'); assert.strictEqual(s.feeSplit.shares[1].address, DEV_WALLET);
  assert.ok(a.st.bandit.dip.all.n === 31, 'trade outcome recorded in the bandit');

  // 8) learning: a losing arm is avoided (bandit sits out), and the sit-out is explained in first person
  const lz = mk(); await lz.start(); train(lz, 'dip', 60, -17); let scans0 = scans;
  const mD = dipMint(t); mints.set('CoinD', mD); lz.onTrade({ mint: 'CoinD', vs: mD.vs, vt: mD.vt }, mD); await settle();
  assert.strictEqual(scans, scans0, 'no scanner credits spent on a losing arm'); assert.ok(lz.st.decisions.some((d) => d.action === 'SIT_OUT' && /Sitting out/.test(d.reason)));
  const W = M.armWeights(lz.st.bandit, 'normal', lz.arms, 1.75, M.rng(3)); assert.ok(W.dip < 0.05, 'dip weight collapses ' + W.dip);

  // 9) Kelly sizing caps + drawdown throttle + hibernation
  const cfgK = { kellyFraction: 0.25, maxTradeSol: 0.02, sizePct: 20, minTradeSol: 0.005 };
  assert.strictEqual(M.kellySize({ kelly: 0.9, equity: 10, free: 10, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0.02, 'hard cap');
  assert.strictEqual(M.kellySize({ kelly: -0.1, equity: 1, free: 1, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0, 'no edge, no bet');
  assert.strictEqual(M.kellySize({ kelly: 0.5, equity: 0.012, free: 0.004, cfg: cfgK, regimeMult: 1, ddMult: 1 }).size, 0, 'never more than free balance');
  const dcfg = { ddSoftPct: 10, ddHibernatePct: 35 }; assert.strictEqual(M.ddState(1, 1, dcfg).mult, 1); assert.ok(M.ddState(0.78, 1, dcfg).mult < 0.7); assert.strictEqual(M.ddState(0.6, 1, dcfg).level, 'hibernate');
  const h = mk(); await h.start(); h.st.peak = 0.2; await h._test.openPosition({ mint: 'CoinH', symbol: 'H', size: 0.02, vs: 40, vt: 800e6, reason: 'r' });
  const ph = h.st.positions[0]; ph.vs = 30; ph.vt = (40 * 800e6) / 30; h._test.checkExit(ph); await settle();
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
    s3: { keys: ['Agent1111111111111111111111111111111111111', 'x'], pre: [2e9, 0], post: [1.9e9, 0] },
    s4: { keys: ['Agent1111111111111111111111111111111111111', 'Owner', '11111111111111111111111111111111'], pre: [3e9, 0, 1], post: [2.49999e9, 5e8, 1], ins: ['11111111111111111111111111111111'], fee: 10000 },
    s5: { keys: ['Agent1111111111111111111111111111111111111', 'Pool', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], pre: [3e9, 0, 1], post: [2.9e9, 1e8, 1], ins: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] } };
  const rpc = async (m, p) => m === 'getSignaturesForAddress' ? Object.keys(txs).map((k) => ({ signature: k, err: null })) : m === 'getTransaction' ? { blockTime: 1792850000, transaction: { message: { accountKeys: txs[p[0]].keys.map((k) => ({ pubkey: k })), instructions: (txs[p[0]].ins || []).map((programId) => ({ programId })) } }, meta: { fee: txs[p[0]].fee || 5000, preBalances: txs[p[0]].pre, postBalances: txs[p[0]].post } } : { value: 0 };
  const fz = mk(analyze, { rpc }); await fz._test.scanFunding(); delete process.env.AGENT_PUBLIC_KEY;
  assert.strictEqual(fz.st.fundings.length, 2); assert.ok(fz.st.fundings.some((f) => /dev wallet/.test(f.source) && f.sol === 1)); assert.ok(fz.st.fundings.some((f) => /creator fees/.test(f.source) && f.sol === 0.05));
  await fz._test.scanFunding(); assert.strictEqual(fz.st.fundings.length, 2, 'no double counting');
  assert.ok(!('withdrawals' in fz.st) && !('withdrawals' in fz.status()), 'owner withdrawals are never recorded or shown');
  assert.ok(!JSON.stringify(fz.status()).includes('"s4"'), 'an owner transfer out (s4) never appears in public status');
  // 14) v1 state migrates: its closed trades seed the bandit
  const v1 = JSON.stringify({ v: 1, mode: 'paper', paperCash: 0.09, paperStart: 0.1, trades: [{ side: 'SELL', mint: 'Mx', pnlPct: -20 }, { side: 'BUY', mint: 'Mx', reason: 'organic-demand momentum' }] });
  const mg = mk(); mg._test.restore(v1); assert.strictEqual(mg.st.bandit.momentum.all.n, 1); assert.strictEqual(mg.st.migratedTrades, 1);
  // 15) backtest priors: down-weighted, capped, regime-agnostic, never persisted over a newer backtest
  const losing = M.statOf(Array.from({ length: 100 }, (_, i) => (i % 5 ? -16 : 20))); const pr = M.makePrior(losing);
  assert.ok(Math.abs(pr.scale * pr.n - M.PRIOR_MAX_N) < 1e-9, 'prior capped at PRIOR_MAX_N pseudo-trades');
  assert.strictEqual(M.makePrior(M.statOf([5, -3])).scale, M.PRIOR_WEIGHT); assert.strictEqual(M.makePrior(null), null);
  const ap = M.armParams({}).dip; const blank = M.newBandit(); const withP = Object.assign(M.newBandit(), { _prior: { dip: pr } });
  const evOf = (b) => { const x = M.belief(b, 'dip', 'hot', ap, 1.75); const p = x.a / (x.a + x.b); return p * x.meanW - (1 - p) * x.meanL; };
  assert.ok(evOf(withP) < evOf(blank) - 3, 'a losing backtest lowers the belief');
  const pa = mk(analyze, { params: { arms: {}, priors: { dip: losing } } }); assert.ok(pa.st.bandit._prior.dip && pa.status().mind.arms.find((x) => x.arm === 'dip').priorTrades === 15);
  const pa2 = mk(analyze, { params: { arms: {}, priors: { dip: M.statOf([30, 30]) } } }); pa2._test.restore(pa._test.snapshot()); assert.strictEqual(pa2.st.bandit._prior.dip.n, 2, 'boot prior wins over a stored one');

  // 16) cost model: paper trades carry a per-trade cost breakdown; the edge gate counts the full round trip
  const E = require('../exec');
  const rtD = E.roundTrip(0.01, { route: 'direct' }), rtP = E.roundTrip(0.01, { route: 'pumpportal' });
  assert.ok(rtD.totalPct < rtP.totalPct - 0.9, 'direct beats PumpPortal by ~1 pt'); assert.strictEqual(rtD.breakdown.rentLostPct, 0);
  assert.ok(sell.costs && sell.costs.roundTrip.totalSol > 0 && sell.costs.route === 'direct', 'sell has cost breakdown');
  assert.ok(a.st.trades.find((x) => x.side === 'BUY').costs.slippageTolPct <= 2.5);
  const sp = E.slippagePolicy({ side: 'buy', impactPct: 0.05, volPct: 0 }); assert.ok(sp.ok && sp.tolPct === 0.55, JSON.stringify(sp));
  assert.strictEqual(E.slippagePolicy({ side: 'buy', impactPct: 0.5, volPct: 3 }).ok, false, 'too volatile: skip');
  assert.strictEqual(E.slippagePolicy({ side: 'sell', impactPct: 0.1, forced: true, attempt: 1 }).tolPct, 6, 'forced exits escalate');
  assert.ok(a.status().execution.roundTripPct.direct['0.01'].totalPct > 2);
  process.env.AGENT_MAX_COST_SHARE = '0.05'; const sk = mk(); delete process.env.AGENT_MAX_COST_SHARE; await sk.start(); train(sk, 'dip', 30, 18); scans0 = scans; const mS = dipMint(t); mints.set('CoinS', mS); sk.onTrade({ mint: 'CoinS', vs: mS.vs, vt: mS.vt }, mS); await settle();
  assert.strictEqual(scans, scans0, 'thin edge vs costs: no scan'); assert.strictEqual(sk.st.totals.costSkips, 1, 'cost skip counted');

  // 17) principal payout (paper simulation): fires once at 2x, only to the pinned address; baseline moves to the post-payout treasury
  process.env.AGENT_PAYOUT_ADDRESS = '76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm';
  const pz = mk(); await pz.start(); assert.strictEqual(pz.status().payout.status, 'waiting'); assert.strictEqual(pz.status().payout.goal, 0.2);
  pz.st.paperCash = 0.19; pz._test.safeTick(); await settle(); assert.ok(!pz.st.payout, 'not before the goal');
  pz.st.paperCash = 0.21; pz._test.safeTick(); await settle();
  assert.strictEqual(pz.st.payout.status, 'done'); assert.strictEqual(pz.st.payout.sol, 0.1); assert.ok(Math.abs(pz.st.paperCash - 0.11) < 1e-9);
  assert.ok(pz.st.decisions.some((d) => d.action === 'PAYOUT' && /Principal returned — I'm now running on my own profits/.test(d.reason)));
  assert.ok(Math.abs(pz.st.paperStart - 0.11) < 1e-9, 'baseline = post-payout treasury'); assert.ok(pz._test.vit().signal >= 0, 'no phantom loss after payout');
  pz.st.paperCash = 0.5; pz._test.safeTick(); await settle(); assert.strictEqual(pz.st.decisions.filter((d) => d.action === 'PAYOUT').length, 1, 'only once');
  process.env.AGENT_PAYOUT_ADDRESS = 'Someone1111111111111111111111111111111111111'; const pw = mk(); await pw.start(); pw.st.paperCash = 0.5; pw._test.safeTick(); await settle();
  assert.ok(!pw.st.payout && pw.status().payout.status === 'blocked', 'any other address is refused');
  delete process.env.AGENT_PAYOUT_ADDRESS;
  // 18) going live archives the paper record (labeled) and never mixes it into the live record; start-fund tx = baseline
  process.env.AGENT_MODE = 'live'; process.env.AGENT_PUBLIC_KEY = 'Agent1111111111111111111111111111111111111';
  const lv = mk(analyze, {}); lv._test.restore(a._test.snapshot());
  assert.ok(lv.st.paperArchive && /Paper trading/.test(lv.st.paperArchive.label) && lv.st.paperArchive.closedTrades >= 1); assert.strictEqual(lv.st.trades.length, 0, 'live record starts fresh');
  assert.strictEqual(lv.st.bandit.dip.all.n, 31, 'what it learned carries over');
  process.env.AGENT_START_FUND_TX = 's1'; const lf = mk(analyze, { rpc }); await lf._test.scanFunding();
  assert.strictEqual(lf.st.capitalIn, 0, 'starting deposit is the baseline, not extra capital'); assert.ok(lf.st.fundings.some((f) => /starting treasury/.test(f.counts)));
  delete process.env.AGENT_START_FUND_TX; delete process.env.AGENT_MODE; delete process.env.AGENT_PUBLIC_KEY;

  // 19) LIVE payout with a mocked RPC: simulate first, send once, persist 'sending' before sending, baseline after
  { const { Keypair } = require('@solana/web3.js'); const bs = require('bs58'); const kpT = Keypair.generate();
    process.env.AGENT_MODE = 'live'; process.env.AGENT_SECRET_KEY = (bs.default || bs).encode(kpT.secretKey); process.env.AGENT_PAYOUT_ADDRESS = '76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm';
    process.env.AGENT_PAYOUT_SOL = '0.185814381'; process.env.AGENT_LIVE_START_SOL = '0.185814381';
    let lam = 0.38e9; const sent = []; const calls = [];
    const rpcL = async (m, p) => { calls.push(m);
      if (m === 'getBalance') return { value: lam }; if (m === 'getLatestBlockhash') return { value: { blockhash: '11111111111111111111111111111111' } };
      if (m === 'simulateTransaction') return { value: { err: null, accounts: [{ lamports: lam - 185814381 - 5000 }], unitsConsumed: 150 } };
      if (m === 'sendTransaction') { sent.push(p[0]); lam -= 185814381 + 5000; return 'sig'; }
      if (m === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      if (m === 'getSignaturesForAddress') return []; return null; };
    process.env.AGENT_PAYOUT_POLL_MS = '0'; const lp = mk(analyze, { rpc: rpcL }); delete process.env.AGENT_PAYOUT_POLL_MS; delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE;
    lp.st.liveBalance = 0.30; lp.st.liveBaseline = 0.185814381; lp._test.safeTick(); await settle(400); assert.strictEqual(sent.length, 0, 'below goal: nothing sent');
    lp.st.liveBalance = 0.38; lp._test.safeTick(); for (let i = 0; i < 50 && lp.st.payout?.status !== 'done'; i++) await settle(200); // confirm polling is async
    assert.strictEqual(sent.length, 1, 'payout sent once'); assert.ok(calls.indexOf('simulateTransaction') < calls.indexOf('sendTransaction'), 'simulated before sending');
    assert.strictEqual(lp.st.payout.status, 'done'); assert.strictEqual(lp.st.payout.lamports, 185814381); assert.strictEqual(lp.st.payout.to, '76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm');
    assert.ok(Math.abs(lp.st.liveBaseline - lam / 1e9) < 1e-6, 'new baseline = post-payout wallet'); assert.strictEqual(lp.st.capitalIn, 0);
    lp.st.liveBalance = 0.9; lp._test.safeTick(); await settle(400); assert.strictEqual(sent.length, 1, 'never twice');
    for (const k of ['AGENT_PAYOUT_ADDRESS', 'AGENT_PAYOUT_SOL', 'AGENT_LIVE_START_SOL']) delete process.env[k]; }
  // 20) volume-bot rider: detection, dip entry, bot-stop exit; shadow by default = paper signal only, no position, no learning
  { const M2 = require('../mind'); const t1 = t + 3600e3; const vm = { trades: [], vs: 40, vt: 800e6, complete: false }; let vs = 40, vt = 800e6;
    const push = (at, sol, buy, user) => { const pvs = vs, pvt = vt, k = vs * vt; vs = buy ? vs + sol : vs - sol; vt = k / vs; vm.trades.push({ at, sol, buy, user, vs, vt, pvs, pvt }); vm.vs = vs; vm.vt = vt; };
    // 3 wallets wash 0.5 SOL clips every 4 s for 3 min (range-bound), then the price dips to the range low
    for (let i = 0; i < 44; i++) push(t1 - 180e3 + i * 4e3, 0.5, i % 2 === 0, 'BOT' + (Math.floor(i / 2) % 3));
    push(t1 - 6e3, 0.6, false, 'BOT0'); push(t1 - 3e3, 0.6, false, 'BOT1'); push(t1 - 2e3, 0.5, false, 'BOT2'); push(t1 - 1e3, 0.2, true, 'BOT2');
    const v = M2.volbotState(vm, t1); assert.ok(v && v.bots.length === 3 && v.entry, 'volume bot detected with a dip entry: ' + JSON.stringify(v && { b: v.bots.length, r: v.rangePct, pos: v.pos, ok: v.ok }));
    assert.strictEqual(M2.volbotExit(vm, t1 + 10e3, v.bots, t1, v.clip), null, 'bot still active');
    assert.ok(/stopped/.test(M2.volbotExit(vm, t1 + 120e3, v.bots, t1, v.clip)), 'bot-stop exit');
    vm.trades.push({ at: t1 + 5e3, sol: 2, buy: false, user: 'WHALE', vs, vt, pvs: vs, pvt: vt }); assert.ok(/dumped/.test(M2.volbotExit(vm, t1 + 6e3, v.bots, t1, v.clip)), 'dump exit');
    vm.trades.pop();
    assert.ok(M2.armParams().volbot.shadow && !M2.armParams().volbot.enabled, 'volbot ships in shadow mode');
    const tSave = t; t = t1; let sc = 0; process.env.AGENT_VARIANTS_FILE = '/nonexistent'; const sa = mk(async () => { sc++; return cleanRep(); }); delete process.env.AGENT_VARIANTS_FILE; await sa.start(); const vmint = 'VolBot1111111111111111111111111111111pump'; mints.set(vmint, vm);
    sa.onTrade({ mint: vmint, vs: vm.vs, vt: vm.vt }, vm); await settle();
    assert.strictEqual(sa.st.positions.length, 0, 'shadow arm never opens a position'); assert.strictEqual(sa.st.shadow.open.length, 1, 'shadow paper signal logged'); assert.ok(sa.st.shadow.open[0].pending, 'fill waits for the latency');
    t = t1 + 6e3; push(t, 0.5, true, 'BOT0'); sa.onTrade({ mint: vmint, vs: vm.vs, vt: vm.vt }, vm); assert.ok(!sa.st.shadow.open[0].pending && sa.st.shadow.open[0].cost > 0.02, 'filled on the first trade >= 5 s later');
    t = t1 + 120e3; sa._test.safeTick(); assert.strictEqual(sa.st.shadow.closed.length, 1, 'shadow closed by bot-stop'); assert.ok(/stopped/.test(sa.st.shadow.closed[0].why));
    assert.strictEqual(sa.st.bandit.volbot.all.n, 0, 'shadow does not teach the bandit'); const vv = sa.status().shadow.variants.find((x) => x.id === 'volbot'); assert.ok(vv && vv.closed === 1 && vv.maxDDSol >= 0);
    assert.strictEqual(vv.edge, 'too few trades'); assert.ok(/No variant has a proven positive edge/.test(sa.status().shadow.verdict));
    Object.assign(sa.st.shadow.byVar.volbot, { vN: 100, vSum: -500, vSq: 100 * (25 + 16) }); // mean -5%, sd ~4%: clearly negative
    const vn = sa.status().shadow.variants.find((x) => x.id === 'volbot'); assert.strictEqual(vn.edge, 'negative'); assert.ok(vn.ci95Pct[1] < 0 && vn.ci95Pct[0] < -5);
    Object.assign(sa.st.shadow.byVar.volbot, { vN: 100, vSum: 500, vSq: 100 * (25 + 16) });
    assert.strictEqual(sa.status().shadow.variants.find((x) => x.id === 'volbot').edge, 'positive'); assert.ok(/positive edge with 95% confidence: volbot/.test(sa.status().shadow.verdict));
    // stricter rug filters when it does trade
    const { volbotGate } = require('../agent'); const young = cleanRep({ creation: { time: new Date(t1 - 3 * 60e3).toISOString() } });
    assert.ok(volbotGate(young, t1).some((x) => /min old/.test(x)), 'young coin rejected'); assert.deepStrictEqual(volbotGate(cleanRep({ creation: { time: new Date(t1 - 30 * 60e3).toISOString() } }), t1), []);
    assert.ok(volbotGate(cleanRep({ creation: { time: new Date(t1 - 30 * 60e3).toISOString() }, dev: { wallet: 'C', hasSold: true, holdingPctSupply: 1 } }), t1).length, 'dev sell history rejected');
    // the pre-registered variant file loads and every variant names a real arm
    const vf = require('../agent-variants.json').variants; assert.ok(vf.length >= 10 && vf.every((x) => M2.ARMS[x.arm] && x.tp > 0 && x.sl > 0 && x.hold > 0 && x.size <= 0.02));
    const sb = mk(); assert.strictEqual(sb.status().shadow.variants.length, vf.length);
    t = tSave; mints.delete(vmint); }
  { const { exitSlippage } = require('../agent');
    const es = exitSlippage([{ side: 'SELL', pnlPct: -13.8, reason: 'stop loss: -13.8% ≤ -8%' }, { side: 'SELL', pnlPct: -9, reason: 'stop loss: -9% ≤ -8%' }, { side: 'SELL', pnlPct: 65.6, reason: 'take profit: +65.6% ≥ +50%' }, { side: 'SELL', pnlPct: 2, reason: 'time stop: 10 min held, +2%' }, { side: 'BUY', reason: 'x' }]);
    assert.strictEqual(es.stopLosses, 2); assert.strictEqual(es.avgPctPastStop, 3.4); assert.strictEqual(es.worstPctPastStop, 5.8); assert.strictEqual(es.takeProfits, 1); assert.strictEqual(es.avgPctPastTarget, 15.6);
    assert.strictEqual(exitSlippage([]).avgPctPastStop, null); }
  console.log('agent tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
