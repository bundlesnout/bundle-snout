// ALMA offline backtest on recorded pump.fun trades (scripts/record-trades.js JSONL).
// 1) Per-arm study: every first signal per coin, entry filled at the first trade ≥ LATENCY after the signal (the scanner
//    takes seconds), fixed 0.02 SOL, exits checked on each later trade of that coin, all fees included.
//    Exit params (TP/SL/hold) are chosen on the IN-SAMPLE half only, then scored once on the OUT-OF-SAMPLE half.
// 2) System replay: the real agent code (bandit + Kelly + regime + drawdown + limits) runs on the stream; entries only
//    in the out-of-sample half, with the in-sample params; many random seeds. The Bundle Snout scanner cannot be
//    replayed (it reads live chain state), so here every coin "passes": live results will differ.
// Usage: node scripts/agent-backtest.js data.jsonl [more.jsonl ...]  → public/agent-backtest.json + agent-params.json
const fs = require('fs'); const path = require('path');
const M = require('../mind'); const { buyFill, sellValue } = require('../scalp');
const files = process.argv.slice(2).filter((x) => !x.startsWith('--')); const SEEDS = Number(process.env.BT_SEEDS || 20);
const LATENCY = 5000, SIZE = 0.02, FEE = { feePct: 1.75, txFeeSol: 0.0001 };
const GRID = { tp: [10, 15, 20, 30, 50], sl: [8, 12, 15, 25], hold: [3, 5, 10, 15] };
const r1 = (x) => Math.round(x * 10) / 10, r4 = (x) => Math.round(x * 1e4) / 1e4;
const solCurve = (t) => t.vs >= 29.9 && t.vs <= 130 && t.vt > 250e6 && t.vt <= 1.0731e9;

function load() {
  const rows = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line) continue; try { const [at, mint, sol, tok, buy, user, vs, vt, done] = JSON.parse(line); const tr = { at, mint, sol, tok, buy: !!buy, user, vs, vt, realTok: done ? 0 : 1 }; if (solCurve(tr)) rows.push(tr); } catch {} }
  rows.sort((a, b) => a.at - b.at); return rows;
}
// same per-coin state the live scalper keeps
function feed(mints, tr) {
  let m = mints.get(tr.mint); if (!m) { m = { trades: [], vs: tr.vs, vt: tr.vt }; mints.set(tr.mint, m); }
  const pvs = tr.buy ? tr.vs - tr.sol : tr.vs + tr.sol, pvt = tr.buy ? tr.vt + tr.tok : tr.vt - tr.tok;
  m.trades.push({ at: tr.at, sol: tr.sol, buy: tr.buy, user: tr.user, vs: tr.vs, vt: tr.vt, pvs, pvt });
  while (m.trades.length > 400 || (m.trades.length && m.trades[0].at < tr.at - 300e3)) m.trades.shift();
  m.vs = tr.vs; m.vt = tr.vt; m.lastAt = tr.at; m.complete = tr.realTok === 0 || tr.vt <= 279.95e6; return m;
}
const stats = (pnls) => { let eq = 0, pk = 0, dd = 0; for (const p of pnls) { eq += p.sol; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const w = pnls.filter((p) => p.sol > 0).length; return { n: pnls.length, wins: w, winRate: pnls.length ? r1((w / pnls.length) * 100) : null, netSol: r4(eq), avgPct: pnls.length ? r1(pnls.reduce((a, p) => a + p.pct, 0) / pnls.length) : null, maxDDSol: r4(dd) }; };

// bootstrap 90% interval for the mean % per trade: if it straddles 0 the sample cannot tell an edge from luck
const boot = (pnls, B = 2000) => { if (pnls.length < 5) return null; const R = M.rng(12345), xs = pnls.map((p) => p.pct), n = xs.length, means = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(R() * n)]; means.push(s / n); }
  means.sort((a, b) => a - b); return [r1(means[Math.floor(B * 0.05)]), r1(means[Math.floor(B * 0.95)])]; };
const statsCI = (pnls) => ({ ...stats(pnls), ci90AvgPct: boot(pnls) });

(async () => {
  const rows = load(); if (rows.length < 1000) throw new Error('not enough data: ' + rows.length);
  const tStart = rows[0].at, tEnd = rows[rows.length - 1].at, tSplit = tStart + (tEnd - tStart) / 2;
  const arms = M.armParams({}); const ride = require('../agent').ACFG().ride;
  // ---- 1) signal events + price paths
  const mints = new Map(), lastEval = new Map(), fired = Object.fromEntries(M.ARM_KEYS.map((k) => [k, new Set()])); const events = []; const byMint = new Map();
  for (const tr of rows) {
    const m = feed(mints, tr);
    if (!byMint.has(tr.mint)) byMint.set(tr.mint, []); byMint.get(tr.mint).push([tr.at, tr.vs, tr.vt, m.complete]);
    if (m.complete || (lastEval.get(tr.mint) || 0) > tr.at - 3000) continue; lastEval.set(tr.mint, tr.at);
    for (const s of M.armSignals(m, tr.at, ride, arms)) { if (fired[s.arm].has(tr.mint)) continue; fired[s.arm].add(tr.mint); events.push({ arm: s.arm, mint: tr.mint, at: tr.at, idx: byMint.get(tr.mint).length - 1 }); }
  }
  // simulate one event for all grid combos
  function simulate(ev) {
    const path = byMint.get(ev.mint); let i = ev.idx + 1; while (i < path.length && path[i][0] < ev.at + LATENCY) i++; if (i >= path.length) return null;
    const [ft, fvs, fvt, fdone] = path[i]; if (fdone) return null; const fill = buyFill(fvs, fvt, SIZE, FEE); const pos = { solIn: fill.solIn, tok: fill.tok };
    const res = {};
    for (const tp of GRID.tp) for (const sl of GRID.sl) for (const hold of GRID.hold) {
      let out = null;
      for (let j = i + 1; j < path.length; j++) { const [t, vs, vt, done] = path[j]; const v = Math.max(0, sellValue(vs, vt, pos, FEE)); const pct = ((v - fill.cost) / fill.cost) * 100;
        if (done || pct >= tp || pct <= -sl || t - ft >= hold * 60e3) { out = { sol: v - fill.cost, pct, at: t }; break; } }
      if (!out) { const [t, vs, vt] = path[path.length - 1]; const v = Math.max(0, sellValue(vs, vt, pos, FEE)); out = { sol: v - fill.cost, pct: ((v - fill.cost) / fill.cost) * 100, at: t, open: true }; }
      res[`${tp}/${sl}/${hold}`] = out;
    }
    return { at: ft, res };
  }
  const sims = events.map((ev) => ({ ...ev, sim: simulate(ev) })).filter((e) => e.sim && e.sim.at + 15 * 60e3 <= tEnd); // only trades whose longest hold fits in the data
  const perArm = [], chosen = {}, priors = {};
  for (const k of M.ARM_KEYS) {
    const evs = sims.filter((e) => e.arm === k); const IS = evs.filter((e) => e.at < tSplit && e.sim.at < tSplit), OOS = evs.filter((e) => e.at >= tSplit);
    const score = (set, key) => stats(set.map((e) => e.sim.res[key])); const scoreCI = (set, key) => statsCI(set.map((e) => e.sim.res[key]));
    const defKey = `${GRID.tp.includes(arms[k].tp) ? arms[k].tp : 20}/${GRID.sl.includes(arms[k].sl) ? arms[k].sl : 15}/${GRID.hold.includes(arms[k].hold) ? arms[k].hold : 15}`;
    const keys = Object.keys(evs[0]?.sim.res || {});
    let best = null; for (const key of keys) { const s = score(IS, key); if (s.n >= 15 && (!best || s.netSol > best.s.netSol)) best = { key, s }; }
    // how lucky is the in-sample winner? share of the 80 combos that are positive in-sample
    const posShare = IS.length ? keys.filter((key) => score(IS, key).netSol > 0).length / 80 : 0;
    const defIS = score(IS, defKey);
    // anti-overfit rule: only move away from the defaults when a real region of the grid works (≥20% of combos
    // profitable in-sample) and the best combo beats the defaults; one lucky corner of the grid is not an edge
    const robust = !!best && posShare >= 0.2 && best.s.netSol > 0 && best.s.netSol > defIS.netSol;
    const pick = robust ? best.key : defKey; const [tp, sl, hold] = pick.split('/').map(Number);
    const picked = !best ? 'kept defaults: too few in-sample trades to tune' : robust ? 'tuned: best in-sample combo, with ≥20% of the grid profitable' : best.s.netSol <= 0 ? 'kept defaults: none of the 80 exit combos was profitable in-sample' : `kept defaults: the best in-sample combo (${best.key}) looked like luck, only ${r1(posShare * 100)}% of the grid was profitable`;
    const enabled = true; const inSamplePositive = score(IS, pick).netSol > 0; // one short sample is too little to switch an arm off: the live bandit decides
    chosen[k] = { tp, sl, hold, enabled, inSamplePositive };
    // what the in-sample half says about this arm (with the exits picked above) becomes a down-weighted prior for the bandit
    if (IS.length) priors[k] = M.statOf(IS.map((e) => e.sim.res[pick].pct));
    perArm.push({ arm: k, label: arms[k].label, signals: events.filter((e) => e.arm === k).length, evaluated: evs.length, defaults: { params: defKey, inSample: scoreCI(IS, defKey), outOfSample: scoreCI(OOS, defKey) },
      chosen: { params: pick, enabled, inSamplePositive, picked, bestInSample: best ? best.key : null, inSample: scoreCI(IS, pick), outOfSample: scoreCI(OOS, pick) }, inSampleCombosPositivePct: r1(posShare * 100) });
  }
  // ---- 2) system replay with the real agent code
  process.env.AGENT_MODE = 'paper'; process.env.AGENT_ENABLED = '1'; delete process.env.AGENT_SECRET_KEY;
  const { createAgent } = require('../agent'); const { cleanCheck, CFG } = require('../radar');
  const cleanRep = { isPumpFun: true, curve: { quote: 'SOL', mayhemMode: false, creatorOnCurve: 'x' }, bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 0, earlyStillHoldPct: 0 }, dev: { wallet: 'x', hasSold: false, holdingPctSupply: 1 }, holders: { top10Pct: 10 }, risk: { level: 'BAJO' } };
  async function system(seed, params, pri, instincts = true) {
    process.env.AGENT_SEED = String(seed); let t = tStart; const mm = new Map();
    const scalper = { mints: mm, symbol: () => null }; const ag = createAgent({ scalper, now: () => t, analyze: async () => cleanRep, cleanCheck, radarCfg: CFG(), rpc: null, quiet: true, instincts, params: { source: 'backtest', arms: params, priors: pri }, fetchFn: async () => ({ json: async () => ({}) }) });
    ag.cfg.enabled = false; let nextTick = t + 5000;
    for (const tr of rows) {
      t = tr.at; if (!ag.cfg.enabled && t >= tSplit) { ag.cfg.enabled = true; ag.st.peak = ag.equity(); }
      while (nextTick <= t) { const keep = t; t = nextTick; ag.tick(); t = keep; nextTick += 5000; }
      const m = feed(mm, tr); ag.onTrade(tr, m); if (ag.isBusy()) await new Promise((r) => setImmediate(r));
    }
    for (const p of [...ag.st.positions]) await ag._test.closePosition(p, 'end of data (marked at last price)');
    const sells = ag.st.trades.filter((x) => x.side === 'SELL');
    return { seed, ...stats(sells.reverse().map((x) => ({ sol: x.pnlSol, pct: x.pnlPct }))), sitOut: ag.st.totals.sitOut, survivalSkips: ag.st.totals.survivalSkips || 0, pains: Math.round((ag.st.affect.totalPain || 0) * 10) / 10, life: ag.st.limbo ? 'limbo' : ag._test.vit().state.key, signal: ag._test.vit().signal, scans: ag.st.totals.scans, weights: ag.st.weights, byArm: Object.fromEntries(M.ARM_KEYS.map((k) => [k, ag.st.bandit[k].all.n])) };
  }
  const sysRuns = { chosen: [], noInstincts: [], noPrior: [], defaults: [] };
  for (let s = 1; s <= SEEDS; s++) { sysRuns.chosen.push(await system(s, chosen, priors)); sysRuns.noInstincts.push(await system(s, chosen, priors, false)); sysRuns.noPrior.push(await system(s, chosen, null)); sysRuns.defaults.push(await system(s, {}, null)); }
  const summ = (runs) => { const v = runs.map((r) => r.netSol).sort((a, b) => a - b); return { seeds: runs.length, medianNetSol: v[Math.floor(v.length / 2)], meanNetSol: r4(v.reduce((a, x) => a + x, 0) / v.length), minNetSol: v[0], maxNetSol: v[v.length - 1], profitableSeedsPct: r1((v.filter((x) => x > 0).length / v.length) * 100), avgTrades: r1(runs.reduce((a, r) => a + r.n, 0) / runs.length), avgWinRate: r1(runs.reduce((a, r) => a + (r.winRate || 0), 0) / runs.length), avgMaxDDSol: r4(runs.reduce((a, r) => a + r.maxDDSol, 0) / runs.length), avgSurvivalSkips: r1(runs.reduce((a, r) => a + (r.survivalSkips || 0), 0) / runs.length), endStates: runs.reduce((a, r) => ((a[r.life] = (a[r.life] || 0) + 1), a), {}) }; };
  const iso = (t) => new Date(t).toISOString();
  const outJ = { generatedAt: new Date().toISOString(), data: { files: files.map((f) => path.basename(f)), trades: rows.length, coins: byMint.size, from: iso(tStart), to: iso(tEnd), minutes: r1((tEnd - tStart) / 60e3) },
    split: { inSample: [iso(tStart), iso(tSplit)], outOfSample: [iso(tSplit), iso(tEnd)] },
    assumptions: { sizeSol: SIZE, feesPerSidePct: FEE.feePct, txFeeSol: FEE.txFeeSol, entryLatencyMs: LATENCY, grid: GRID, oneEntryPerCoinPerArm: true },
    perArm, system: { note: 'real agent code, entries only out-of-sample, 0.1 SOL paper start, scanner gate NOT replayed (all coins pass). withInSampleParams = what is deployed (in-sample exits + in-sample priors); withoutInstincts = deployed setup with survival scaling and reward/pain switched off (ablation); withoutPriors = same exits, bandit starts blank; withDefaults = hand-set exits, blank bandit; doing nothing = 0 SOL', withInSampleParams: summ(sysRuns.chosen), withoutInstincts: summ(sysRuns.noInstincts), withoutPriors: summ(sysRuns.noPrior), withDefaults: summ(sysRuns.defaults), baselineNoTrading: 0, runs: sysRuns.chosen },
    caveats: ['Short sample (one recording session): results are noisy and say little about the future.', 'The live scanner rejects most coins; it cannot be replayed offline, so the system replay trades coins the live agent would refuse.', 'Fills use the observed curve after a 5 s delay; real fills can be worse (slippage, priority-fee races, failed txs).', 'Exit params were picked on the in-sample half only; the out-of-sample numbers are the honest ones.', 'ci90AvgPct is a bootstrap 90% interval for the average % per trade: if it includes 0, this sample cannot distinguish an edge from luck.'] };
  const OUT = process.env.BT_OUT_DIR; if (OUT) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(OUT ? path.join(OUT, 'agent-backtest.json') : path.join(__dirname, '..', 'public', 'agent-backtest.json'), JSON.stringify(outJ, null, 1));
  fs.writeFileSync(OUT ? path.join(OUT, 'agent-params.json') : path.join(__dirname, '..', 'agent-params.json'), JSON.stringify({ priors, priorNote: `in-sample outcomes per arm; the agent counts them at ≤${M.PRIOR_WEIGHT}× weight, ≤${M.PRIOR_MAX_N} pseudo-trades`, source: `backtest in-sample ${iso(tStart).slice(0, 16)}→${iso(tSplit).slice(11, 16)}Z (${files.map((f) => path.basename(f)).join(',')})`, generatedAt: outJ.generatedAt, arms: chosen }, null, 1));
  console.log(JSON.stringify({ data: outJ.data, perArm: perArm.map((a) => ({ arm: a.arm, signals: a.signals, def: [a.defaults.inSample, a.defaults.outOfSample].map((s) => `${s.n}t ${s.winRate}% ${s.netSol}`), chosen: a.chosen.params, en: a.chosen.enabled, ch: [a.chosen.inSample, a.chosen.outOfSample].map((s) => `${s.n}t ${s.winRate}% ${s.netSol}`), posCombos: a.inSampleCombosPositivePct })), system: { deployed: outJ.system.withInSampleParams, noInstincts: outJ.system.withoutInstincts, noPrior: outJ.system.withoutPriors, defaults: outJ.system.withDefaults } }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
