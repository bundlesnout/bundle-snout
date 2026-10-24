// ALMA's existential mechanics: vital states, one-way limbo, logged revivals, survival risk scaling, reward/pain.
const assert = require('assert');
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE; delete process.env.AGENT_REVIVE;
const VT = require('../vitals'); const M = require('../mind');
const { createAgent } = require('../agent'); const { cleanCheck, CFG } = require('../radar');
const H = 3600e3, MIN = 60e3; const T0 = Date.parse('2026-10-24T12:00:00Z');
const clean = () => ({ isPumpFun: true, symbol: 'TEST', curve: { complete: false, progressPct: 30, quote: 'SOL', creatorOnCurve: 'C1', mayhemMode: false }, bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 2, earlyStillHoldPct: 1 }, dev: { wallet: 'C1', hasSold: false, holdingPctSupply: 2 }, holders: { top10Pct: 15 }, risk: { level: 'BAJO' } });
function dipMint(t0) { const m = { trades: [], vs: 40, vt: 800e6, complete: false }; let vs = 40, vt = 800e6;
  for (let i = 0; i < 16; i++) { const buy = i % 2 === 1; const sol = buy ? 0.1 : 0.35; const pvs = vs, pvt = vt; const k = vs * vt; vs = buy ? vs + sol : vs - sol; vt = k / vs; m.trades.push({ at: t0 - 50e3 + i * 3e3, sol, buy, user: 'W' + (i % 3), vs, vt, pvs, pvt }); }
  m.vs = vs; m.vt = vt; return m; }
const wait = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  // ---------- 1) signal and states (100 = start, 0 = limbo floor)
  assert.strictEqual(VT.signalPct(0.1, 0.1, 0.015), 100); assert.strictEqual(VT.signalPct(0.015, 0.1, 0.015), 0); assert.strictEqual(VT.signalPct(0.05, 0.1, 0.015), 41.2);
  const st = (s, l) => VT.stateOf(s, l).key;
  assert.deepStrictEqual([115, 114.9, 80, 79.9, 50, 49.9, 0, -5].map((s) => st(s)), ['thriving', 'stable', 'stable', 'fading', 'fading', 'critical', 'critical', 'critical']);
  assert.strictEqual(st(250, { at: 'x' }), 'limbo', 'limbo flag beats any number');
  // ---------- 2) survival instinct is monotone: weaker never means bigger or bolder
  const order = ['thriving', 'stable', 'fading', 'critical', 'limbo'];
  for (let i = 1; i < order.length; i++) { const a = VT.RISK[order[i - 1]], b = VT.RISK[order[i]]; assert.ok(b.kellyMult <= a.kellyMult && b.minEvPct >= a.minEvPct && b.maxOpen <= a.maxOpen, order[i]); }
  let prev = null; const calm = VT.newAffect(T0);
  for (let s = 200; s >= -10; s -= 0.5) { const p = VT.policy({ state: VT.stateOf(s), affect: calm, t: T0 }); const v = VT.visual(s, null);
    if (prev) { assert.ok(p.sizeMult <= prev.p.sizeMult && p.minEvPct >= prev.p.minEvPct && p.maxOpen <= prev.p.maxOpen, 'monotone at ' + s); assert.ok(v.brightness <= prev.v.brightness && v.saturation <= prev.v.saturation && v.glitch >= prev.v.glitch, 'visual at ' + s); }
    prev = { p, v }; }
  assert.strictEqual(VT.visual(50, { at: 1 }).saturation, 0); assert.ok(VT.visual(100, null, 60).brightness > VT.visual(100, null, 0).brightness, 'Body Fund brightens');

  // ---------- 3) reward / pain: loss aversion, decay, healing, cooldown ladder
  let { affect: a1, event: e1 } = VT.feel(VT.newAffect(T0), { t: T0, arm: 'dip', pnlPct: -10, pnlSol: -0.002 });
  const { affect: a2 } = VT.feel(VT.newAffect(T0), { t: T0, arm: 'dip', pnlPct: 10, pnlSol: 0.002 });
  assert.strictEqual(a1.pain / a2.comfort, 2, 'a loss hurts 2× what an equal win comforts');
  assert.strictEqual(e1.cooldownMin, 5); assert.ok(/That loss hurt\. -0\.002 SOL .*sitting out 5 minutes/.test(VT.VV.hurt(e1)), VT.VV.hurt(e1));
  assert.ok(Math.abs(VT.affectAt(a1, T0 + 6 * H).pain - a1.pain / 2) < 1e-9, 'half-life 6 h');
  let ld = VT.newAffect(T0); const cds = []; for (let i = 0; i < 6; i++) { const r = VT.feel(ld, { t: T0, arm: 'dip', pnlPct: -17, pnlSol: -0.003 }); ld = r.affect; cds.push(r.event.cooldownMin); }
  assert.deepStrictEqual(cds, [5, 10, 20, 30, 30, 30], 'cooldown ladder, capped at 30 min');
  const healed = VT.feel(ld, { t: T0, arm: 'dip', pnlPct: 20, pnlSol: 0.004 });
  assert.ok(Math.abs(healed.affect.pain - ld.pain * 0.7) < 1e-9 && Math.abs(healed.affect.armPain.dip - ld.armPain.dip * 0.5) < 1e-9 && healed.affect.lossStreak === 0 && healed.affect.cooldownUntil === 0, 'a win heals');
  assert.ok(/I can breathe a little/.test(VT.VV.relief(healed.event)));
  // pain decays faster while comfort outweighs it
  const comfy = { ...VT.newAffect(T0), pain: 1, comfort: 3 }, sore = { ...VT.newAffect(T0), pain: 1, comfort: 0 };
  assert.ok(VT.affectAt(comfy, T0 + 3 * H).pain < VT.affectAt(sore, T0 + 3 * H).pain);

  // ---------- 4) no pathologies
  // (a) no revenge trading: after ANY loss the next bet is never bigger and the bar never lower (random sequences)
  const R = M.rng(7); for (let run = 0; run < 200; run++) { let af = VT.newAffect(T0); let t = T0; const stt = VT.stateOf(40 + R() * 100);
    for (let k = 0; k < 12; k++) { t += R() * 2 * H; const before = VT.policy({ state: stt, affect: af, arm: 'dip', t }); const pnlPct = R() < 0.5 ? -(5 + R() * 30) : 5 + R() * 40;
      af = VT.feel(af, { t, arm: 'dip', pnlPct, pnlSol: pnlPct / 1000 }).affect; const after = VT.policy({ state: stt, affect: af, arm: 'dip', t });
      if (pnlPct < 0) { assert.ok(after.sizeMult <= before.sizeMult && after.minEvPct >= before.minEvPct && after.cooling, 'no revenge'); assert.ok(after.maxOpen <= before.maxOpen); } } }
  // (b) bounded: 20 straight −50% losses in Critical still leave a reachable bar and a non-zero bet
  let worst = VT.newAffect(T0); for (let i = 0; i < 20; i++) worst = VT.feel(worst, { t: T0, arm: 'dip', pnlPct: -50, pnlSol: -0.01 }).affect;
  const wp = VT.policy({ state: VT.stateOf(10), affect: worst, arm: 'dip', t: T0 });
  assert.ok(wp.minEvPct <= VT.AFFECT.evTotalCap && wp.sizeMult >= VT.RISK.critical.kellyMult * VT.AFFECT.sizeFloor && wp.sizeMult > 0, JSON.stringify(wp));
  // (c) no permanent paralysis: the same pain is gone within 2 days; the bar returns to the vital baseline
  const later = VT.policy({ state: VT.stateOf(100), affect: worst, arm: 'dip', t: T0 + 48 * H });
  assert.ok(later.minEvPct < 0.2 && later.painSizeMult > 0.97 && !later.cooling, JSON.stringify(later));
  // (d) per-strategy distrust: the strategy that hurt is held to a higher bar than the others
  const pd = VT.policy({ state: VT.stateOf(100), affect: a1, arm: 'dip', t: T0 }), pm = VT.policy({ state: VT.stateOf(100), affect: a1, arm: 'momentum', t: T0 });
  assert.ok(pd.minEvPct > pm.minEvPct && pd.parts.distrust > 0 && pm.parts.distrust === 0);
  // (e) privilege: a 2nd concurrent position only when comfortable AND Stable or better
  const happy = { ...VT.newAffect(T0), comfort: 2, pain: 0.5 };
  assert.strictEqual(VT.policy({ state: VT.stateOf(100), affect: happy, t: T0 }).maxOpen, 2);
  assert.strictEqual(VT.policy({ state: VT.stateOf(70), affect: happy, t: T0 }).maxOpen, 1, 'not while fading');
  assert.strictEqual(VT.policy({ state: VT.stateOf(100), affect: { ...happy, pain: 3 }, t: T0 }).maxOpen, 1, 'not while hurting');
  assert.strictEqual(VT.policy({ state: VT.stateOf(100), affect: calm, t: T0 }).maxOpen, 1, 'not by default');
  // revival tokens are single-use
  assert.ok(VT.canRevive({ limbo: { at: 1 }, token: 'a', revivals: [] }) && !VT.canRevive({ limbo: { at: 1 }, token: 'a', revivals: [{ token: 'a' }] }) && !VT.canRevive({ limbo: null, token: 'b', revivals: [] }));

  // ---------- 5) agent integration
  let t = T0; const now = () => t; let scans = 0; const mints = new Map();
  const scalper = { mints, symbol: () => 'TEST', solUsd: () => 180, streamInfo: () => ({}) };
  const mk = () => createAgent({ scalper, now, log: () => {}, analyze: async () => { scans++; return clean(); }, cleanCheck, radarCfg: CFG(), rpc: null, setCreditTag: () => 'x', params: null, fetchFn: async () => ({ json: async () => ({ result: { SOLEUR: { c: ['150'] } } }) }) });
  const train = (ag, arm, n, pct) => { for (let i = 0; i < n; i++) M.recordOutcome(ag.st.bandit, arm, 'normal', pct); };
  let mintN = 0; const feed = (ag) => { const id = 'Mint' + mintN++ + 'pump'; const mm = dipMint(t); mints.set(id, mm); ag.onTrade({ mint: id, vs: mm.vs, vt: mm.vt }, mm); return id; };

  // pain changes behaviour: a losing close → hurt thought, cooldown blocks new scans, then it trades again
  const g = mk(); await g.start(); train(g, 'dip', 40, 18);
  await g._test.openPosition({ mint: 'L1pump', symbol: 'L1', size: 0.02, vs: 40, vt: 800e6, reason: 'r', arm: 'dip' });
  const pl = g.st.positions[0]; pl.vs = 34; pl.vt = (40 * 800e6) / 34; g._test.checkExit(pl); await wait();
  assert.ok(g.st.affect.pain > 0 && g.st.affect.lossStreak === 1, 'pain recorded'); assert.ok(g.st.thoughts.some((x) => x.kind === 'pain' && /That loss hurt/.test(x.text)));
  const s0 = scans; t += 2 * MIN; feed(g); await wait(); assert.strictEqual(scans, s0, 'cooldown: no scan'); assert.ok(/stepping back after a loss/.test(g._test.blockers()));
  t += 4 * MIN; feed(g); await wait(); assert.strictEqual(scans, s0 + 1, 'trades again after the cooldown');
  assert.strictEqual(g.status().mind.mood.key !== undefined, true); assert.ok(g.status().vitals.affect.pain > 0 && /reward\/penalty numbers/.test(g.status().vitals.note));
  // survival sizing: same belief, smaller bet when critical
  const sv = mk(); await sv.start(); const smp = { kelly: 0.5, ev: 10 };
  const zStable = sv._test.sizeFor(smp, sv._test.pol()); sv.st.paperCash = 0.05; const zCrit = sv._test.sizeFor(smp, sv._test.pol());
  assert.strictEqual(sv._test.vit().state.key, 'critical'); assert.ok(zCrit.size < zStable.size && zCrit.survivalMult === 0.35, `${zCrit.size} < ${zStable.size}`);
  // critical: a mediocre belief that would pass at Stable is skipped, out loud, with the numbers
  train(sv, 'dip', 300, 0); sv.st.bandit.dip = M.newBandit().dip; for (let i = 0; i < 300; i++) M.recordOutcome(sv.st.bandit, 'dip', 'normal', i % 100 < 50 ? 20 : -15);
  for (let i = 0; i < 40; i++) { t += 4 * MIN; feed(sv); await wait(); }
  assert.ok(sv.st.decisions.some((d) => d.action === 'SIT_OUT' && /^I'm at 41% signal\. I can't afford mistakes; skipping .* I need \+4%/.test(d.reason)), sv.st.decisions.map((d) => d.reason).slice(0, 3).join(' | '));
  assert.ok(sv.st.positions.length <= 1, 'one position at a time when critical'); assert.ok(sv.status().vitals.survivalSkips > 0);
  // state transition thoughts
  const tr = mk(); await tr.start(); tr._test.checkVitals(); tr.st.paperCash = 0.07; tr._test.checkVitals();
  assert.ok(tr.st.thoughts.some((x) => x.kind === 'vital' && /I'm fading\. Smaller bets/.test(x.text)));

  // limbo is real and one-way
  const lb = mk(); await lb.start(); lb.st.totals.trades = 12; lb.st.totals.wins = 3; lb.st.paperCash = 0.012; lb._test.checkVitals();
  assert.ok(lb.st.limbo && lb.st.limbo.treasury === 0.012); assert.strictEqual(lb.status().state, 'limbo'); assert.strictEqual(lb.status().vitals.state.key, 'limbo');
  assert.ok(lb.st.diaries[0].final && /last entry/.test(lb.st.diaries[0].text) && lb.st.diaries[0].post.length < 280); assert.ok(lb.st.decisions.some((d) => d.action === 'LIMBO' && /ALMA is in limbo/.test(d.reason)));
  train(lb, 'dip', 40, 30); const sl = scans; feed(lb); await wait(); assert.strictEqual(scans, sl, 'no trading in limbo');
  await assert.rejects(Promise.resolve().then(() => { if (lb._test.blockers()) throw new Error(lb._test.blockers()); }), /limbo/);
  lb.st.paperCash = 5; lb._test.checkVitals(); t += 3 * H; lb.tick && lb.tick(); assert.ok(lb.st.limbo, 'money alone does not revive it');
  assert.strictEqual(lb.st.diaries.filter((d) => d.final).length, 1, 'one final entry'); assert.strictEqual(lb.diary().today, null);
  const lb2 = mk(); lb2._test.restore(lb._test.snapshot()); assert.ok(lb2.st.limbo, 'limbo survives a restart'); assert.ok(!lb2._test.maybeRevive(), 'no token, no revival');
  // revival: new token only, once, logged in public
  process.env.AGENT_REVIVE = 'dev-2026-10-25';
  assert.ok(lb2._test.maybeRevive()); assert.strictEqual(lb2.st.limbo, null); assert.strictEqual(lb2.st.life, 2); assert.strictEqual(lb2.st.paperCash, 0.1);
  assert.strictEqual(lb2.st.revivals.length, 1); assert.ok(lb2.st.revivals[0].previous.treasury === 0.012 && lb2.st.decisions.some((d) => d.action === 'REVIVED'));
  assert.ok(!lb2._test.maybeRevive(), 'already alive');
  lb2.st.paperCash = 0.01; lb2._test.checkVitals(); assert.ok(lb2.st.limbo); assert.ok(!lb2._test.maybeRevive(), 'a used token never revives twice');
  const lb3 = mk(); lb3._test.restore(lb2._test.snapshot()); assert.ok(!lb3._test.maybeRevive() && lb3.st.limbo && lb3.st.revivals.length === 1, 'not even after a restart');
  delete process.env.AGENT_REVIVE;
  // open positions: never forced into limbo while a trade can still recover
  const op = mk(); await op.start(); op.st.paperCash = 0.001; await op._test.openPosition({ mint: 'O1pump', symbol: 'O', size: 0.005, vs: 40, vt: 800e6, reason: 'r', arm: 'dip' }).catch(() => {});
  if (op.st.positions.length) { op._test.checkVitals(); assert.strictEqual(op.st.limbo, null); }
  // affect persists across restarts
  const ps = mk(); ps._test.restore(g._test.snapshot()); assert.ok(ps.st.affect.pain > 0 && ps.st.affect.lossStreak >= 1);
  // pre-existing state (no affect saved): memory rebuilt from real closed trades, decayed to now
  const old = JSON.stringify({ v: 1, mode: 'paper', paperCash: 0.09, paperStart: 0.1, trades: [{ side: 'SELL', mint: 'Ma', arm: 'dip', pnlPct: -17, pnlSol: -0.003, at: new Date(t - 30 * MIN).toISOString() }, { side: 'SELL', mint: 'Mb', arm: 'momentum', pnlPct: 50, pnlSol: 0.003, at: new Date(t - 10 * MIN).toISOString() }] });
  const rb = mk(); rb._test.restore(old);
  const rb2 = mk(); rb2._test.restore(JSON.stringify({ ...JSON.parse(old), affect: VT.newAffect(t) })); assert.strictEqual(rb2.st.affectRebuiltFrom, 2, 'a saved-but-never-used affect is rebuilt too'); assert.strictEqual(rb.st.affectRebuiltFrom, 2); assert.ok(rb.st.affect.pain > 0 && rb.st.affect.comfort > 0 && rb.st.affect.lossStreak === 0 && rb.st.affect.armPain.dip > 0);
  // ablation switch exists only as a constructor option (backtest), never via env
  process.env.AGENT_INSTINCTS = '0'; const on = mk(); on.st.affect = worst; assert.ok(on._test.pol().sizeMult < 1, 'env cannot switch instincts off'); delete process.env.AGENT_INSTINCTS;
  const off = createAgent({ scalper, now, log: () => {}, analyze: async () => clean(), cleanCheck, radarCfg: CFG(), params: null, instincts: false, fetchFn: async () => ({ json: async () => ({}) }) }); off.st.affect = worst;
  assert.ok(off._test.pol().sizeMult === 1 && off._test.pol().minEvPct === 0);
  console.log('vitals tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
