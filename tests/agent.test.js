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
  const mk = (a = analyze) => createAgent({ scalper, now, log: (x) => logs.push(x), analyze: a, cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x' });

  // signal fires on the synthetic dip
  const m = dipMint(t); const sg = signal(m, t, ACFG()); assert.ok(sg && sg.kind === 'dip', 'dip signal'); 

  // 1) own coin is never evaluated
  let a = mk(); await a.start();
  a.onTrade({ mint: process.env.AGENT_EXCLUDE_CA, vs: m.vs, vt: m.vt }, dipMint(t));
  await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(scans, 0, 'excluded coin not scanned'); assert.strictEqual(a.st.positions.length, 0);
  await assert.rejects(a._test.openPosition({ mint: process.env.AGENT_EXCLUDE_CA, symbol: 'OWN', size: 0.02, vs: 40, vt: 800e6, reason: 'x' }), /excluded/);

  // 2) clean coin + signal -> paper BUY with reason, cost capped at 0.02 SOL
  const mintA = 'CoinA11111111111111111111111111111111pump'; const mA = dipMint(t); mints.set(mintA, mA);
  a.onTrade({ mint: mintA, vs: mA.vs, vt: mA.vt }, mA); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(scans, 1); assert.strictEqual(a.st.positions.length, 1, 'opened');
  const p = a.st.positions[0]; assert.ok(p.cost <= 0.0201 && p.cost > 0.015, 'size cap ' + p.cost); assert.ok(/scanner clean/.test(p.reason) && /TP \+20%/.test(p.reason));
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
  console.log('agent tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
