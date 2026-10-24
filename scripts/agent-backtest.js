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
  const perArm = [], chosen = {};
  for (const k of M.ARM_KEYS) {
    const evs = sims.filter((e) => e.arm === k); const IS = evs.filter((e) => e.at < tSplit && e.sim.at < tSplit), OOS = evs.filter((e) => e.at >= tSplit);
    const score = (set, key) => stats(set.map((e) => e.sim.res[key]));
    const defKey = `${GRID.tp.includes(arms[k].tp) ? arms[k].tp : 20}/${GRID.sl.includes(arms[k].sl) ? arms[k].sl : 15}/${GRID.hold.includes(arms[k].hold) ? arms[k].hold : 15}`;
    let best = null; for (const key of Object.keys(evs[0]?.sim.res || {})) { const s = score(IS, key); if (s.n >= 15 && (!best || s.netSol > best.s.netSol)) best = { key, s }; }
    const pick = best ? best.key : defKey; const [tp, sl, hold] = pick.split('/').map(Number);
    const enabled = !!best && best.s.netSol > 0; // the in-sample data must at least say "positive" for the arm to trade
    chosen[k] = { tp, sl, hold, enabled };
    // how lucky is the in-sample winner? share of the 80 combos that are positive in-sample
    const posShare = IS.length ? Object.keys(evs[0].sim.res).filter((key) => score(IS, key).netSol > 0).length / 80 : 0;
    perArm.push({ arm: k, label: arms[k].label, signals: events.filter((e) => e.arm === k).length, evaluated: evs.length, defaults: { params: defKey, inSample: score(IS, defKey), outOfSample: score(OOS, defKey) },
      chosen: { params: pick, enabled, inSample: score(IS, pick), outOfSample: score(OOS, pick) }, inSampleCombosPositivePct: r1(posShare * 100) });
  }
  // ---- 2) system replay with the real agent code
  process.env.AGENT_MODE = 'paper'; process.env.AGENT_ENABLED = '1'; delete process.env.AGENT_SECRET_KEY;
  const { createAgent } = require('../agent'); const { cleanCheck, CFG } = require('../radar');
  const cleanRep = { isPumpFun: true, curve: { quote: 'SOL', mayhemMode: false, creatorOnCurve: 'x' }, bundle: { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 0, earlyStillHoldPct: 0 }, dev: { wallet: 'x', hasSold: false, holdingPctSupply: 1 }, holders: { top10Pct: 10 }, risk: { level: 'BAJO' } };
  async function system(seed, params) {
    process.env.AGENT_SEED = String(seed); let t = tStart; const mm = new Map();
    const scalper = { mints: mm, symbol: () => null }; const ag = createAgent({ scalper, now: () => t, analyze: async () => cleanRep, cleanCheck, radarCfg: CFG(), rpc: null, quiet: true, params: { source: 'backtest', arms: params }, fetchFn: async () => ({ json: async () => ({}) }) });
    ag.cfg.enabled = false; let nextTick = t + 5000;
    for (const tr of rows) {
      t = tr.at; if (!ag.cfg.enabled && t >= tSplit) { ag.cfg.enabled = true; ag.st.peak = ag.equity(); }
      while (nextTick <= t) { const keep = t; t = nextTick; ag.tick(); t = keep; nextTick += 5000; }
      const m = feed(mm, tr); ag.onTrade(tr, m); if (ag.isBusy()) await new Promise((r) => setImmediate(r));
    }
    for (const p of [...ag.st.positions]) await ag._test.closePosition(p, 'end of data (marked at last price)');
    const sells = ag.st.trades.filter((x) => x.side === 'SELL');
    return { seed, ...stats(sells.reverse().map((x) => ({ sol: x.pnlSol, pct: x.pnlPct }))), sitOut: ag.st.totals.sitOut, scans: ag.st.totals.scans, weights: ag.st.weights, byArm: Object.fromEntries(M.ARM_KEYS.map((k) => [k, ag.st.bandit[k].all.n])) };
  }
  const sysRuns = { chosen: [], defaults: [] };
  for (let s = 1; s <= SEEDS; s++) { sysRuns.chosen.push(await system(s, chosen)); sysRuns.defaults.push(await system(s, {})); }
  const summ = (runs) => { const v = runs.map((r) => r.netSol).sort((a, b) => a - b); return { seeds: runs.length, medianNetSol: v[Math.floor(v.length / 2)], meanNetSol: r4(v.reduce((a, x) => a + x, 0) / v.length), minNetSol: v[0], maxNetSol: v[v.length - 1], profitableSeedsPct: r1((v.filter((x) => x > 0).length / v.length) * 100), avgTrades: r1(runs.reduce((a, r) => a + r.n, 0) / runs.length), avgWinRate: r1(runs.reduce((a, r) => a + (r.winRate || 0), 0) / runs.length), avgMaxDDSol: r4(runs.reduce((a, r) => a + r.maxDDSol, 0) / runs.length) }; };
  const iso = (t) => new Date(t).toISOString();
  const outJ = { generatedAt: new Date().toISOString(), data: { files: files.map((f) => path.basename(f)), trades: rows.length, coins: byMint.size, from: iso(tStart), to: iso(tEnd), minutes: r1((tEnd - tStart) / 60e3) },
    split: { inSample: [iso(tStart), iso(tSplit)], outOfSample: [iso(tSplit), iso(tEnd)] },
    assumptions: { sizeSol: SIZE, feesPerSidePct: FEE.feePct, txFeeSol: FEE.txFeeSol, entryLatencyMs: LATENCY, grid: GRID, oneEntryPerCoinPerArm: true },
    perArm, system: { note: 'real agent code, entries only out-of-sample, 0.1 SOL paper start, scanner gate NOT replayed (all coins pass)', withInSampleParams: summ(sysRuns.chosen), withDefaults: summ(sysRuns.defaults), runs: sysRuns.chosen },
    caveats: ['Short sample (one recording session): results are noisy and say little about the future.', 'The live scanner rejects most coins; it cannot be replayed offline, so the system replay trades coins the live agent would refuse.', 'Fills use the observed curve after a 5 s delay; real fills can be worse (slippage, priority-fee races, failed txs).', 'Exit params were picked on the in-sample half only; the out-of-sample numbers are the honest ones.'] };
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'agent-backtest.json'), JSON.stringify(outJ, null, 1));
  fs.writeFileSync(path.join(__dirname, '..', 'agent-params.json'), JSON.stringify({ source: `backtest in-sample ${iso(tStart).slice(0, 16)}→${iso(tSplit).slice(11, 16)}Z (${files.map((f) => path.basename(f)).join(',')})`, generatedAt: outJ.generatedAt, arms: chosen }, null, 1));
  console.log(JSON.stringify({ data: outJ.data, perArm: perArm.map((a) => ({ arm: a.arm, signals: a.signals, def: [a.defaults.inSample, a.defaults.outOfSample].map((s) => `${s.n}t ${s.winRate}% ${s.netSol}`), chosen: a.chosen.params, en: a.chosen.enabled, ch: [a.chosen.inSample, a.chosen.outOfSample].map((s) => `${s.n}t ${s.winRate}% ${s.netSol}`), posCombos: a.inSampleCombosPositivePct })), system: { chosen: outJ.system.withInSampleParams, defaults: outJ.system.withDefaults } }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
