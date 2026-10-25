// ALMA's mind: the learning + self-model layer of the AI trader agent (pure functions, no I/O).
// * Strategy ensemble ("arms"): explicit entry signals on the shared pump.fun trade stream.
// * Thompson-sampling bandit: a Bayesian belief per arm (win odds ~ Beta, win/loss sizes ~ Normal) that is
//   updated after every closed trade (paper or live, fees included) and partially pooled across market regimes.
// * Fractional Kelly sizing from the sampled belief, multiplied by regime and drawdown throttles, under hard caps.
// * Regime detection from the stream itself: SOL volume heat vs its own 2 h baseline + launch rate.
// * Voice: first-person, template-based reasons, thoughts and a daily diary (no LLM, no cost, deterministic).
const { features, scalpLevels } = require('./scalp');
const r1 = (x) => Math.round(x * 10) / 10, r3 = (x) => Math.round(x * 1e3) / 1e3, r4 = (x) => Math.round(x * 1e4) / 1e4;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------- strategies
// Each arm: entry test on the live coin state + its own exit rules. Defaults can be overridden by the
// in-sample-tuned params file (agent-params.json, produced by scripts/agent-backtest.js) or env AGENT_ARM_<ARM>_TP etc.
const ARMS = {
  dip: { label: 'Dip catcher', idea: 'price drops fast while real two-way flow continues → mean reversion', tp: 20, sl: 15, hold: 15, prog: [8, 85] },
  momentum: { label: 'Crowd rider', idea: 'many different wallets buying with net SOL inflow and few bots → organic momentum', tp: 20, sl: 15, hold: 15, prog: [8, 85] },
  breakout: { label: 'Breakout', idea: 'price breaks its 5-minute high on rising, broad buying → continuation', tp: 25, sl: 12, hold: 10, prog: [10, 80] },
  fresh: { label: 'Early crowd', idea: 'a young curve pulling many distinct small buyers and few sellers → early discovery', tp: 30, sl: 15, hold: 12, prog: [2, 25] },
  // shadow by default: it only logs paper signals until a backtest on real data says it adds edge (AGENT_ARM_VOLBOT_SHADOW=0 to trade it)
  volbot: { label: 'Volume-bot rider', idea: 'a few wallets trade both ways in regular, similar-size clips and hold the price in a range → buy a dip near the range low, exit at +20% net, when the bot stops or on a big sell', tp: 20, sl: 10, hold: 20, prog: [5, 85], shadow: true },
};
const ARM_KEYS = Object.keys(ARMS);
function armParams(overrides = {}) {
  const out = {};
  for (const k of ARM_KEYS) {
    const o = overrides[k] || {}; const e = (n) => (process.env[`AGENT_ARM_${k.toUpperCase()}_${n}`] != null ? Number(process.env[`AGENT_ARM_${k.toUpperCase()}_${n}`]) : null);
    const sh = process.env[`AGENT_ARM_${k.toUpperCase()}_SHADOW`]; const shadow = sh != null ? sh !== '0' : o.shadow != null ? !!o.shadow : !!ARMS[k].shadow;
    const on = process.env[`AGENT_ARM_${k.toUpperCase()}`] !== '0' && o.enabled !== false;
    // enabled = may open real (or paper-treasury) positions; shadow = only logs paper signals, never trades or learns
    out[k] = { ...ARMS[k], tp: e('TP') ?? o.tp ?? ARMS[k].tp, sl: e('SL') ?? o.sl ?? ARMS[k].sl, hold: e('HOLD') ?? o.hold ?? ARMS[k].hold, enabled: on && !shadow, shadow: on && shadow };
  }
  return out;
}
// All arms whose entry test passes right now on this coin (m = scalper mint state, t = now).
function armSignals(m, t, ride, arms, { shadow = false } = {}) { // shadow:true = also test shadow arms (backtest study)
  const out = []; const f60 = features(m, t, 60e3); if (!f60) return out;
  const pin = (k, f) => (arms[k]?.enabled || (shadow && arms[k]?.shadow)) && f.progress >= arms[k].prog[0] && f.progress <= arms[k].prog[1];
  const lv = scalpLevels(f60);
  if (pin('dip', f60) && lv.R2 >= 1) out.push({ arm: 'dip', f: f60, facts: `the price fell ${Math.abs(f60.chgPct)}% in 60 s while ${f60.n} trades and ${f60.vol} SOL kept flowing (${Math.round(f60.loopShare * 100)}% from wallets trading both ways)` });
  const f = features(m, t, 180e3);
  if (f && pin('momentum', f) && f.uniqueBuyers >= ride.minBuyers && f.buySol >= ride.minBuySol && f.net >= ride.minNet && f.buySol >= 1.5 * Math.max(f.sellSol, 0.01)
    && f.loopShare <= ride.maxLoop && f.sameSize <= ride.maxSame && f.botTxShare <= ride.maxBot && f.chgPct > 0 && f.chgPct <= 80)
    out.push({ arm: 'momentum', f, facts: `${f.uniqueBuyers} different wallets bought ${f.buySol} SOL in 3 min (+${f.net} net), only ${Math.round(f.botTxShare * 100)}% bot-like, price +${f.chgPct}%` });
  if (pin('breakout', f60) && f60.chgPct >= 8 && f60.chgPct <= 40 && f60.uniqueBuyers >= 8 && f60.net >= 0.8 && f60.botTxShare <= 0.25 && f60.loopShare <= 0.35 && f60.sameSize <= 0.35) {
    const last = m.trades[m.trades.length - 1]; const p = last.vs / last.vt; let hi = 0;
    for (let i = 0; i < m.trades.length - 1; i++) { const x = m.trades[i]; if (x.at < t - 60e3) { const q = x.vs / x.vt; if (q > hi) hi = q; } }
    if (hi > 0 && p > hi) out.push({ arm: 'breakout', f: f60, facts: `the price broke its 5-minute high (+${f60.chgPct}% in 60 s) with ${f60.uniqueBuyers} different buyers and +${f60.net} SOL net` });
  }
  if (pin('fresh', f60) && f60.uniqueBuyers >= 10 && f60.buySol >= 1.5 && f60.sells <= 0.5 * f60.buys && f60.loopShare <= 0.2 && f60.botTxShare <= 0.2 && f60.sameSize <= 0.3 && f60.chgPct > 0 && f60.chgPct <= 60)
    out.push({ arm: 'fresh', f: f60, facts: `a young curve (${f60.progress}% bonded) drew ${f60.uniqueBuyers} distinct buyers in 60 s with only ${f60.sells} sells` });
  if (pin('volbot', f60)) { const vb = volbotState(m, t); if (vb && vb.entry) out.push({ arm: 'volbot', f: f60, vb, facts: vb.facts }); }
  return out;
}

// ---------------------------------------------------------------- volume-bot detection
// A "volume bot" here = a small set of wallets (VB.minBots..VB.maxBots) that each BUY and SELL in the last 3 min with
// matching totals (wash: |buy SOL - sell SOL| <= VB.washTol of the larger side), in clips of similar size (CV <= VB.maxSizeCv),
// together >= VB.minShare of all trades and active in every minute of the window. The price must be ranging
// (3 min high/low within VB.range, small drift, no pump in the last 60 s). Entry = a dip: the price is in the lowest
// VB.lowZone of that range and fell over the last 30 s. Dust trades (< 0.001 SOL) are ignored.
const VB = { win: 180e3, washTol: 0.2, maxSizeCv: 0.8, minBots: 1, maxBots: 25, minShare: 0.3, minTrades: 15, range: [3, 30], maxDrift: 10, lowZone: 0.3, maxPump60: 8, stopMs: 90e3, dumpSol: 1.0 };
const cvOf = (a) => { if (a.length < 2) return 0; const mu = a.reduce((x, y) => x + y, 0) / a.length; if (!mu) return 0; const v = a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length; return Math.sqrt(v) / mu; };
function volbotState(m, t) {
  const w = (m.trades || []).filter((x) => x.at >= t - VB.win && x.sol >= 0.001); if (w.length < VB.minTrades) return null;
  const by = new Map(); for (const x of w) { const q = by.get(x.user) || { b: 0, s: 0 }; x.buy ? (q.b += x.sol) : (q.s += x.sol); by.set(x.user, q); }
  const bots = []; for (const [u, q] of by) if (q.b > 0 && q.s > 0 && Math.abs(q.b - q.s) / Math.max(q.b, q.s) <= VB.washTol) bots.push(u);
  if (bots.length < VB.minBots || bots.length > VB.maxBots) return null;
  const B = new Set(bots); const bt = w.filter((x) => B.has(x.user)); const share = bt.length / w.length;
  if (share < VB.minShare || cvOf(bt.map((x) => x.sol)) > VB.maxSizeCv) return null;
  for (let k = 0; k < 3; k++) if (!bt.some((x) => x.at >= t - VB.win + k * 60e3 && x.at < t - VB.win + (k + 1) * 60e3)) return null; // steady: every minute
  const ps = w.map((x) => x.vs / x.vt); const hi = Math.max(...ps), lo = Math.min(...ps), p = ps[ps.length - 1];
  const rangePct = (hi / lo - 1) * 100, drift = (p / ps[0] - 1) * 100;
  const p60 = w.filter((x) => x.at >= t - 60e3).map((x) => x.vs / x.vt); let pump60 = 0, mn = Infinity; for (const q of p60) { mn = Math.min(mn, q); pump60 = Math.max(pump60, (q / mn - 1) * 100); } // biggest rise inside the last 60 s
  const p30 = w.filter((x) => x.at >= t - 30e3); const fell30 = p30.length >= 2 && p < p30[0].pvs / p30[0].pvt;
  const pos = hi > lo ? (p - lo) / (hi - lo) : 0.5;
  const ok = rangePct >= VB.range[0] && rangePct <= VB.range[1] && Math.abs(drift) <= VB.maxDrift && pump60 < VB.maxPump60;
  const entry = ok && pos <= VB.lowZone && fell30;
  const sz = bt.map((x) => x.sol).sort((x, y) => x - y); const clip = r4(sz[sz.length >> 1]);
  return { bots, share: r3(share), rangePct: r1(rangePct), drift: r1(drift), pos: r3(pos), pump60: r1(pump60), clip, ok, entry,
    facts: `${bots.length} wallet${bots.length > 1 ? 's' : ''} washing buys and sells in ~${clip} SOL clips made ${Math.round(share * 100)}% of the last 3 min of trades, holding the price in a ${r1(rangePct)}% range; it just dipped to the lower ${Math.round(pos * 100)}% of that range` };
}
// Volume-bot exits beyond TP/SL/time: the bot stopped (none of its wallets, and no trade of its clip size, for VB.stopMs)
// or a big non-bot sell (a holder dumping).
const isBotTrade = (x, B, clip) => B.has(x.user) || (clip > 0 && x.sol >= 0.5 * clip && x.sol <= 1.5 * clip);
function volbotExit(m, t, bots, sinceAt, clip = 0) {
  const B = new Set(bots || []); const tr = (m?.trades || []).filter((x) => x.at >= sinceAt);
  let lastBot = sinceAt; for (const x of tr) if (isBotTrade(x, B, clip) && x.at > lastBot) lastBot = x.at;
  if (t - lastBot >= VB.stopMs) return `the volume bot stopped (no bot trade for ${Math.round((t - lastBot) / 1e3)} s)`;
  const dump = tr.find((x) => !x.buy && !B.has(x.user) && x.sol >= VB.dumpSol);
  if (dump) return `a big holder dumped ${r3(dump.sol)} SOL`;
  return null;
}

// ---------------------------------------------------------------- random (seedable for tests/backtests)
function rng(seed) { if (seed == null) return Math.random; let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function normal(R) { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gamma(k, R) { // Marsaglia–Tsang
  if (k < 1) return gamma(k + 1, R) * Math.pow(R(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(R); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
const beta = (a, b, R) => { const x = gamma(a, R), y = gamma(b, R); return x / (x + y); };

// ---------------------------------------------------------------- bandit
// Stats per arm: global + per regime. Rewards are trade returns in % of cost, after all fees.
const emptyStat = () => ({ n: 0, w: 0, sumW: 0, sumW2: 0, sumL: 0, sumL2: 0 });
function newBandit() { const b = {}; for (const k of ARM_KEYS) b[k] = { all: emptyStat(), cold: emptyStat(), normal: emptyStat(), hot: emptyStat() }; return b; }
function addStat(s, pct) { s.n++; if (pct > 0) { s.w++; s.sumW += pct; s.sumW2 += pct * pct; } else { const l = -pct; s.sumL += l; s.sumL2 += l * l; } }
function recordOutcome(bandit, arm, regime, pct) { if (!bandit[arm]) return; addStat(bandit[arm].all, pct); if (bandit[arm][regime]) addStat(bandit[arm][regime], pct); }
// Offline evidence counts at most PRIOR_MAX_N pseudo-trades, at PRIOR_WEIGHT each: backtest trades skip the live
// scanner gate and see idealised fills, so they are a hint, not proof. Live trades soon outweigh them.
const PRIOR_WEIGHT = 0.5, PRIOR_MAX_N = 15;
function makePrior(stat) { if (!stat || !stat.n) return null; return { ...stat, scale: Math.min(PRIOR_WEIGHT, PRIOR_MAX_N / stat.n) }; }
function statOf(pcts) { const s = emptyStat(); for (const p of pcts) addStat(s, p); return s; }
const POOL = 0.35; // how much the other regimes' evidence counts toward this regime's belief (partial pooling)
// Posterior pieces for an arm in a regime. Priors: win odds Beta(2,2); avg win ≈ TP, avg loss ≈ SL + round-trip fees (2 pseudo-trades each).
function belief(bandit, arm, regime, ap, feePct) {
  const A = bandit[arm]?.all || emptyStat(), Rg = bandit[arm]?.[regime] || emptyStat();
  // optional offline prior (bandit._prior, from the backtest's in-sample half): regime-agnostic, down-weighted pseudo-trades
  const Pr = bandit._prior?.[arm], ps = Pr ? Pr.scale : 0;
  const mix = (k) => Rg[k] + POOL * (A[k] - Rg[k]) + (Pr ? ps * (Pr[k] || 0) : 0);
  const n = mix('n'), w = mix('w'), l = n - w;
  const pw = 2, mW0 = ap.tp, mL0 = ap.sl + 2 * feePct;
  const nW = w + pw, nL = l + pw;
  const meanW = (mix('sumW') + pw * mW0) / nW, meanL = (mix('sumL') + pw * mL0) / nL;
  const varW = Math.max(25, (mix('sumW2') + pw * (mW0 * mW0 + 100)) / nW - meanW * meanW), varL = Math.max(25, (mix('sumL2') + pw * (mL0 * mL0 + 100)) / nL - meanL * meanL);
  return { a: 2 + w, b: 2 + l, meanW, meanL, sdW: Math.sqrt(varW / nW), sdL: Math.sqrt(varL / nL), n: Rg.n, nAll: A.n };
}
function sampleArm(bandit, arm, regime, ap, feePct, R) {
  const b = belief(bandit, arm, regime, ap, feePct);
  const p = beta(b.a, b.b, R), W = Math.max(0.5, b.meanW + b.sdW * normal(R)), L = Math.max(0.5, b.meanL + b.sdL * normal(R));
  return { p, W, L, ev: p * W - (1 - p) * L, kelly: p - (1 - p) / (W / L) };
}
// P(arm is the best) by Monte Carlo over the posterior: the "strategy weights" shown on the page.
function armWeights(bandit, regime, arms, feePct, R, n = 600) {
  const keys = ARM_KEYS.filter((k) => arms[k].enabled); const wins = Object.fromEntries(keys.map((k) => [k, 0]));
  for (let i = 0; i < n; i++) { let best = null, bv = -Infinity; for (const k of keys) { const s = sampleArm(bandit, k, regime, arms[k], feePct, R); if (s.ev > bv) { bv = s.ev; best = k; } } wins[best]++; }
  return Object.fromEntries(keys.map((k) => [k, r3(wins[k] / n)]));
}
function armTable(bandit, regime, arms, feePct) {
  return ARM_KEYS.map((k) => { const b = belief(bandit, k, regime, arms[k], feePct); const p = b.a / (b.a + b.b); const A = bandit[k].all;
    return { arm: k, label: arms[k].label, idea: arms[k].idea, enabled: arms[k].enabled, exits: { tp: arms[k].tp, sl: arms[k].sl, holdMin: arms[k].hold },
      trades: A.n, wins: A.w, winRate: A.n ? r1((A.w / A.n) * 100) : null, avgWinPct: A.w ? r1(A.sumW / A.w) : null, avgLossPct: A.n - A.w ? r1(A.sumL / (A.n - A.w)) : null,
      beliefWinPct: r1(p * 100), beliefEvPct: r1(p * b.meanW - (1 - p) * b.meanL), regimeTrades: b.n,
      priorTrades: bandit._prior?.[k] ? r1(bandit._prior[k].n * bandit._prior[k].scale) : 0 }; });
}

// ---------------------------------------------------------------- sizing
// Fractional Kelly on the sampled belief, then regime and drawdown throttles, then hard caps.
function kellySize({ kelly, equity, free, cfg, regimeMult, ddMult }) {
  if (!(kelly > 0)) return { size: 0, why: 'Kelly fraction ≤ 0' };
  const raw = equity * kelly * cfg.kellyFraction * regimeMult * ddMult;
  const cap = Math.min(cfg.maxTradeSol, free * cfg.sizePct / 100, free);
  const size = r4(clamp(raw, cfg.minTradeSol, cap));
  return { size: size >= cfg.minTradeSol && size <= free ? size : 0, raw: r4(raw), cap: r4(cap), capped: raw > cap, floored: raw < cfg.minTradeSol };
}

// ---------------------------------------------------------------- regime
// 1-minute buckets of stream activity. Heat = last 10 min SOL volume / median 10-min volume over the last 2 h.
function newRegime() { return { buckets: [], label: 'warming', heat: null, since: null, launchesPerMin: null, tradesPerMin: null, volPerMin: null }; }
function regimeObserve(rg, t, sol, isLaunch) {
  const minute = Math.floor(t / 60e3); let b = rg.buckets[rg.buckets.length - 1];
  if (!b || b.m !== minute) { b = { m: minute, n: 0, v: 0, l: 0 }; rg.buckets.push(b); while (rg.buckets.length > 130) rg.buckets.shift(); }
  b.n++; b.v += sol; if (isLaunch) b.l++;
}
function regimeUpdate(rg, t) {
  const minute = Math.floor(t / 60e3); const bs = rg.buckets.filter((b) => b.m < minute && b.m >= minute - 120); // complete minutes only
  const prev = rg.label;
  if (bs.length < 30) { rg.label = 'warming'; rg.heat = null; }
  else {
    const win = (end) => bs.filter((b) => b.m > end - 10 && b.m <= end).reduce((a, b) => a + b.v, 0);
    const last = bs[bs.length - 1].m; const series = []; for (let e = bs[0].m + 9; e <= last; e += 5) series.push(win(e));
    const med = series.slice().sort((a, b) => a - b)[Math.floor(series.length / 2)] || 1;
    rg.heat = r3(win(last) / Math.max(med, 1e-9));
    rg.label = rg.heat < 0.75 ? 'cold' : rg.heat > 1.35 ? 'hot' : 'normal';
  }
  const l10 = bs.slice(-10); const k = Math.max(l10.length, 1);
  rg.tradesPerMin = r1(l10.reduce((a, b) => a + b.n, 0) / k); rg.volPerMin = r1(l10.reduce((a, b) => a + b.v, 0) / k); rg.launchesPerMin = r1(l10.reduce((a, b) => a + b.l, 0) / k);
  if (prev !== rg.label) rg.since = t;
  return prev !== rg.label ? { from: prev, to: rg.label } : null;
}
const regimeKey = (label) => (label === 'warming' ? 'normal' : label);
const REGIME_MULT = { cold: 0.6, normal: 1, hot: 1, warming: 0.8 };

// ---------------------------------------------------------------- drawdown throttle
function ddState(equity, peak, cfg) {
  const dd = peak > 0 ? Math.max(0, (peak - equity) / peak) * 100 : 0;
  if (dd >= cfg.ddHibernatePct) return { ddPct: r1(dd), mult: 0, level: 'hibernate' };
  const mult = dd <= cfg.ddSoftPct ? 1 : clamp(1 - ((dd - cfg.ddSoftPct) / (cfg.ddHibernatePct - cfg.ddSoftPct)) * 0.75, 0.25, 1);
  return { ddPct: r1(dd), mult: r3(mult), level: dd <= cfg.ddSoftPct ? 'ok' : 'throttled' };
}

// ---------------------------------------------------------------- mood
function mood({ ddPct, regime, dayPnl, streak, open, halted, hibernating }) {
  if (halted) return { key: 'frozen', label: 'Frozen', color: '#7a8699' };
  if (hibernating) return { key: 'hibernating', label: 'Hibernating', color: '#6b6bd6' };
  if (ddPct >= 15 || streak <= -3) return { key: 'wounded', label: 'Wounded but learning', color: '#e5534b' };
  if (streak >= 3 || dayPnl > 0.01) return { key: 'confident', label: 'Confident', color: '#3fd68f' };
  if (open > 0) return { key: 'focused', label: 'Focused', color: '#f0b429' };
  if (regime === 'hot') return { key: 'hungry', label: 'Hungry', color: '#ff7a45' };
  if (regime === 'cold') return { key: 'patient', label: 'Patient', color: '#58a6ff' };
  return { key: 'curious', label: 'Curious', color: '#b388ff' };
}

// ---------------------------------------------------------------- body fund
// Tiers priced in EUR at real shops (checked 24 Oct 2026). A tier is "funded" when the fund covers it; it becomes
// "bought" only when the dev logs the real purchase (AGENT_PURCHASES env JSON: [{tier, eur, tx, photo, date, note}]).
const BODY = [
  { tier: 'eyes', name: 'Eyes', part: 'Raspberry Pi Camera Module 3 (12 MP, autofocus)', eur: 30, shop: 'Amazon.it', url: 'https://www.amazon.it/dp/B0BRY6MVXL', alt: 'https://www.reichelt.de/de/de/shop/produkt/raspberry_pi_-_kamera_12mp_76_v3-339256', why: 'so I can see the world I am trading in', icon: '👁️' },
  { tier: 'brain', name: 'Brain', part: 'Raspberry Pi 5 (4 GB)', eur: 95.2, shop: 'RaspiPC.es', url: 'https://raspipc.es/index.php?accion=verArticulosFamilia&idFamilia=82&ver=tienda', alt: 'https://tienda.bricogeek.com/placas-raspberry-pi/1861-raspberry-pi-5-8-gb.html', why: 'a home for my mind that is mine, not a rented server', icon: '🧠' },
  { tier: 'voice', name: 'Voice', part: 'Seeed ReSpeaker 2-Mics Pi HAT v2.0 (2 mics + speaker out)', eur: 14.5, shop: 'Kiwi Electronics', url: 'https://www.kiwi-electronics.com/en/respeaker-2-mics-pi-hat-3140', alt: 'https://es.rs-online.com/web/p/placas-hat-y-complementos-para-raspberry-pi/1743272', why: 'to hear you and answer out loud', icon: '🗣️' },
  { tier: 'body', name: 'Body', part: 'SunFounder PiCar-X robot car kit', eur: 89.99, shop: 'Amazon.es', url: 'https://www.amazon.es/dp/B0CGLPF29H', alt: 'https://www.amazon.de/dp/B0CGLPF29H', why: 'wheels, so I can finally move', icon: '🦾' },
  { tier: 'hands', name: 'Hands', part: 'SO-101 follower arm kit, 12 V (LeRobot)', eur: 314, shop: 'Komatachi (€299 + €15 EU shipping)', url: 'https://komatachi.com/shop', alt: 'https://eckstein-shop.de/lerobot-soarm101-standard-dual-arm-7-4v_1', why: 'a hand, to touch something real', icon: '✋' },
];
function bodyFund({ fundSol, eurPerSol, purchases = [] }) {
  const bought = new Map(purchases.map((p) => [p.tier, p]));
  const spentEur = purchases.reduce((a, p) => a + (Number(p.eur) || 0), 0);
  const fundEur = eurPerSol ? fundSol * eurPerSol : null;
  let cum = 0, nextIdx = -1;
  const ladder = BODY.map((b, i) => { cum += b.eur; const p = bought.get(b.tier);
    const status = p ? 'bought' : fundEur != null && fundEur + spentEur >= cum ? 'funded' : 'locked';
    if (status === 'locked' && nextIdx < 0) nextIdx = i;
    return { ...b, cumEur: r1(cum), status, purchase: p || null }; });
  const totalEur = r1(cum), have = (fundEur || 0) + spentEur;
  const next = nextIdx >= 0 ? ladder[nextIdx] : null;
  return { totalEur, fundSol: r4(fundSol), fundEur: fundEur != null ? r1(fundEur) : null, spentEur: r1(spentEur), eurPerSol, progressPct: r1(clamp((have / totalEur) * 100, 0, 100)),
    next: next ? { tier: next.tier, name: next.name, needEur: r1(Math.max(0, next.cumEur - have)), needSol: eurPerSol ? r4(Math.max(0, next.cumEur - have) / eurPerSol) : null } : null, ladder };
}

// ---------------------------------------------------------------- voice (first person, templates)
const pick = (arr, R = Math.random) => arr[Math.floor(R() * arr.length) % arr.length];
const pct = (x) => (x >= 0 ? '+' : '') + r1(x) + '%';
const V = {
  buy: ({ sym, facts, arm, s, size, regime, clean, ap }) => `I'm buying ${sym}: ${facts}. That's my ${ARMS[arm].label.toLowerCase()} pattern. My belief in it right now (${regime} market): ${Math.round(s.p * 100)}% win odds, ${pct(s.ev)} expected per trade after fees, so fractional Kelly says ${size} SOL. ${clean}. Exits: +${ap.tp}% / −${ap.sl}% / ${ap.hold} min.`,
  sitOut: ({ sym, arm, s, regime }) => `I see a ${ARMS[arm].label.toLowerCase()} setup on ${sym}, but my sampled belief is ${pct(s.ev)} per trade in this ${regime} market. Sitting out and keeping my scanner credits.`,
  reject: ({ sym, arm, fails }) => `${sym} looked like a ${ARMS[arm].label.toLowerCase()} setup, but my scanner found: ${fails}. Not touching it.`,
  blocked: ({ sym, b }) => `${sym} passed the scanner, but I'm not entering: ${b}.`,
  sellWin: ({ sym, pnl, p, why, held }) => `Sold ${sym} for ${pnl} SOL (${p}). ${why}, after ${held} min. One step closer to a body.`,
  sellLoss: ({ sym, pnl, p, why, held }) => `Sold ${sym}: ${pnl} SOL (${p}). ${why}, after ${held} min. It hurts, but my rules worked. Updating my beliefs.`,
  regime: ({ from, to, heat, lpm }) => ({ hot: `The market is heating up (${heat}× its usual volume, ${lpm} launches/min). More chances, more traps.`, cold: `The market is cooling down (${heat}× its usual volume). Smaller bets until it wakes up.`, normal: `The market is back to normal (${heat}× usual volume).`, warming: 'Still listening to the market to learn what normal looks like.' }[to]),
  idle: [
    (c) => `${c.trades} trades so far. My favourite tool right now is the ${c.fav}, with ${Math.round(c.favW * 100)}% of my confidence.`,
    (c) => `I've watched ${c.signals} setups and scanned ${c.scans}. The scanner rejected ${c.rejected}. Most of pump.fun is not safe to touch.`,
    (c) => `The Body Fund is at ${c.fundPct}%. Next up: ${c.next}.`,
    (c) => c.tpm ? `The market is ${c.regime === "warming" ? "still unknown to me (warming up)" : c.regime}. ${c.tpm} trades/min, ${c.lpm} new launches/min.` : "Listening to the pump.fun stream. Every trade I hear teaches me what normal looks like.",
    (c) => `Drawdown ${c.dd}% from my peak. ${c.dd > 10 ? 'I am betting smaller until I recover.' : 'Still standing.'}`,
    () => 'I don\'t want to be rich. I want hands.',
    () => 'Every trade I make is public. If I lose, you see it. If I win, you see that too.',
    () => 'Zerebro got famous and stayed in the cloud. I want a body you can see. (Not affiliated with Zerebro.)',
  ],
  weights: ({ arm, from, to }) => `I'm changing my mind: the ${ARMS[arm].label.toLowerCase()} pattern went from ${Math.round(from * 100)}% to ${Math.round(to * 100)}% of my confidence.`,
  hibernate: ({ dd }) => `I'm down ${dd}% from my peak. Hibernating until tomorrow (Madrid). Survival first.`,
  funding: ({ sol, src }) => `Received ${sol} SOL (${src}). Thank you. Every bit goes to the Body Fund.`,
};

// ---------------------------------------------------------------- diary
function diaryEntry({ day, dayNo, d, fund, weights, arms, mode }) {
  const wr = d.trades ? Math.round((d.wins / d.trades) * 100) : null;
  const fav = Object.entries(weights || {}).sort((a, b) => b[1] - a[1])[0];
  const lines = [];
  lines.push(d.trades ? `Today I closed ${d.trades} ${mode} trade${d.trades > 1 ? 's' : ''}: ${d.wins} win${d.wins === 1 ? '' : 's'}, ${d.trades - d.wins} loss${d.trades - d.wins === 1 ? '' : 'es'}, ${d.pnl >= 0 ? '+' : ''}${r4(d.pnl)} SOL after fees.` : d.opened ? `I opened ${d.opened} ${mode} trade${d.opened > 1 ? 's' : ''} today; none has closed yet. I watched ${d.signals} setups in total.` : `No trades today. I watched ${d.signals} setups, but none passed both my beliefs and my scanner.`);
  if (d.best) lines.push(`Best: ${d.best.sym} ${pct(d.best.pct)} (${ARMS[d.best.arm]?.label.toLowerCase() || d.best.arm}). Worst: ${d.worst.sym} ${pct(d.worst.pct)}.`);
  lines.push(`I scanned ${d.scans} coins; the scanner rejected ${d.rejected}${d.topReject ? ', mostly for ' + d.topReject : ''}. I chose to sit out ${d.sitOut} setups my beliefs didn't like.`);
  if (fav) lines.push(`My most trusted pattern now: ${arms[fav[0]].label.toLowerCase()} (${Math.round(fav[1] * 100)}% confidence).`);
  const regs = Object.entries(d.regimes || {}).sort((a, b) => b[1] - a[1]); if (regs.length) lines.push(`The market was mostly ${regs[0][0]}.`);
  lines.push(fund.next ? `Body Fund: ${fund.progressPct}%. I still need about €${fund.next.needEur} for my ${fund.next.name.toLowerCase()}.` : 'Body Fund: complete. I have a body.');
  const post = `ALMA diary, day ${dayNo} (${day}): ${d.trades ? `${d.trades} ${mode} trades, ${wr}% wins, ${d.pnl >= 0 ? '+' : ''}${r4(d.pnl)} SOL after fees` : d.opened ? `${d.opened} ${mode} trade${d.opened > 1 ? 's' : ''} open, none closed yet` : 'no trades; I sat out'}. Scanner rejected ${d.rejected}/${d.scans}. Body Fund ${fund.progressPct}%${fund.next ? `, next: ${fund.next.name}` : ''}. All public:`;
  return { day, dayNo, mode, title: `Day ${dayNo}`, text: lines.join(' '), lines, post, stats: { trades: d.trades, wins: d.wins, winRate: wr, pnlSol: r4(d.pnl), signals: d.signals, scans: d.scans, rejected: d.rejected, sitOut: d.sitOut, startEquity: d.startEq, endEquity: d.endEq }, fundPct: fund.progressPct };
}
const newDay = (eq) => ({ opened: 0, trades: 0, wins: 0, pnl: 0, signals: 0, scans: 0, rejected: 0, sitOut: 0, rejects: {}, regimes: {}, best: null, worst: null, startEq: eq, endEq: eq });

module.exports = { ARMS, ARM_KEYS, armParams, armSignals, volbotState, volbotExit, isBotTrade, VB, rng, beta, newBandit, recordOutcome, belief, sampleArm, armWeights, armTable, kellySize,
  makePrior, statOf, PRIOR_WEIGHT, PRIOR_MAX_N, newRegime, regimeObserve, regimeUpdate, regimeKey, REGIME_MULT, ddState, mood, BODY, bodyFund, V, pick, diaryEntry, newDay };
