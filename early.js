// "Frongus early-volume" PAPER forward test (box only, never trades, no keys, no Helius credits, nothing sent to Render).
// Rule (evaluated from the complete pump.fun trade list while the coin is <=180 s old and still on the curve):
//   vol(first 120 s) >= 80 SOL, vol(last 60 s) >= 30 SOL, price >= 2.5x launch, buySol >= 1.3x sellSol,
//   >= 30 unique buyers, no wallet > 25% of volume, mcap < $20k at entry.
// Entry = 0.1 SOL simulated on the bonding-curve account read right after the trigger (1.25% fee, curve-math slippage).
// Exits = several variants in parallel. Any position whose price went unwatched > 60 s is VOIDED (the box pauses).
const LAUNCH_PRICE = 30 / 1.073e9; // SOL per token at creation (initial virtual reserves)
const RULE = { maxAgeS: 180, winS: 120, minVol: 80, lastS: 60, minLast: 30, minMult: 2.5, minBS: 1.3, minBuyers: 30, maxWallet: 0.25, maxMcUsd: 20000 };
const EXITS = [
  { id: 'tp50_sl20', tp: 50, sl: 20 }, { id: 'tp100_sl30', tp: 100, sl: 30 }, { id: 'trail25', trail: 25 },
  { id: 'time15', holdMin: 15 }, { id: 'time60', holdMin: 60 },
];
const SIZE = 0.1, FEE = 1.25, TXFEE = 0.000024, AMM_FEE = 1.0, AMM_QUOTE = 85, GRAD_HAIRCUT = 0.8, MAX_HOLD_MIN = 60, MAX_BLIND_MS = 60000;
// Graduated coin with no fresh AMM price: wait GRAD_WAIT_MS (< MAX_BLIND_MS) for one, then close
// at the last curve value minus GRAD_HAIRCUT ('grad_exit'). Before 2026-11-07 the fallback waited
// 60 s = MAX_BLIND_MS, so every such position was VOIDED instead; graduations are the best
// performers, so time15/time60 lost exactly their winners (GEO: peak 4.6x, time60 voided).
const GRAD_WAIT_MS = 15000;
function graduationMark({ graduatedAt, last, amm, now }) {
  if (amm && now - amm.at < 60e3) return { kind: 'amm', priceSol: amm.priceSol };
  if (last && now - graduatedAt > GRAD_WAIT_MS) return { kind: 'grad_fallback', vs: last.vs, vt: last.vt, final: true };
  return null;
}
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Pure: features of a coin's trades [{at(ms), user, buy, sol, priceSol, priceUsd}] as of `now`, created at `cr`.
function evalRule(trades, cr, now, R = RULE) {
  const age = (now - cr) / 1000;
  const w120 = trades.filter((t) => t.at <= cr + R.winS * 1000), last = trades.filter((t) => t.at > now - R.lastS * 1000);
  const vol120 = w120.reduce((a, t) => a + t.sol, 0), volLast = last.reduce((a, t) => a + t.sol, 0);
  let buySol = 0, sellSol = 0; const buyers = new Set(), perW = new Map();
  for (const t of trades) { if (t.buy) { buySol += t.sol; buyers.add(t.user); } else sellSol += t.sol; perW.set(t.user, (perW.get(t.user) || 0) + t.sol); }
  const vol = buySol + sellSol, maxW = vol ? Math.max(...perW.values()) / vol : 1;
  const lt = trades.length ? trades.reduce((a, t) => (t.at >= a.at ? t : a)) : null;
  const mult = lt ? lt.priceSol / LAUNCH_PRICE : 0, mcUsd = lt ? lt.priceUsd * 1e9 : 0;
  const f = { age: Math.round(age), vol120: r4(vol120), volLast: r4(volLast), mult: r4(mult), bs: r4(sellSol ? buySol / sellSol : buySol ? 99 : 0), buyers: buyers.size, maxW: r4(maxW), mcUsd: Math.round(mcUsd), n: trades.length };
  const fails = [];
  if (age > R.maxAgeS) fails.push('age'); if (vol120 < R.minVol) fails.push('vol120'); if (volLast < R.minLast) fails.push('volLast');
  if (mult < R.minMult) fails.push('mult'); if (f.bs < R.minBS) fails.push('bs'); if (buyers.size < R.minBuyers) fails.push('buyers');
  if (maxW > R.maxWallet) fails.push('wallet'); if (!(mcUsd > 0 && mcUsd < R.maxMcUsd)) fails.push('mc');
  return { ok: fails.length === 0, fails, f };
}
function buyFill(vs, vt, spend = SIZE) { const solIn = spend / (1 + FEE / 100); const tok = vt - (vs * vt) / (vs + solIn); return { solIn, tok, avg: spend / tok, spot: vs / vt, impactPct: ((solIn / tok) / (vs / vt) - 1) * 100 }; }
function curveSell(vs, vt, tok) { const gross = (vs * tok) / (vt + tok); return gross * (1 - FEE / 100) - TXFEE; } // vs/vt = reserves now (after our buy)
function ammSell(priceSol, tok) { const g = priceSol * tok; return g * (1 - AMM_FEE / 100) * (1 - Math.min(0.5, g / AMM_QUOTE)) - TXFEE; }
// Current net SOL value of a position given a mark {kind:'curve',vs,vt} | {kind:'amm',priceSol} | {kind:'grad_fallback',lastCurve:{vs,vt}}
function markValue(pos, m) {
  if (m.kind === 'curve') return curveSell(m.vs, m.vt, pos.tok);
  if (m.kind === 'amm') return ammSell(m.priceSol, pos.tok);
  return curveSell(m.vs, m.vt, pos.tok) * GRAD_HAIRCUT;
}
// Pure: should this position exit at value `val` (net SOL) at time `now`?
function exitCheck(pos, ex, val, now) {
  const pnl = (val / pos.cost - 1) * 100; pos.peakVal = Math.max(pos.peakVal || 0, val);
  const held = (now - pos.at) / 60000;
  if (ex.tp != null && pnl >= ex.tp) return 'tp'; if (ex.sl != null && pnl <= -ex.sl) return 'sl';
  if (ex.trail != null && val <= pos.peakVal * (1 - ex.trail / 100) && pos.peakVal > 0) return 'trail';
  if (ex.holdMin != null && held >= ex.holdMin) return 'time';
  if (held >= MAX_HOLD_MIN) return 'maxhold';
  return null;
}
function stats(closed) {
  const a = closed.map((p) => p.pnlPct); const n = a.length; if (!n) return { n: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / n, sd = n > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0, h = n > 1 ? 1.96 * sd / Math.sqrt(n) : null;
  return { n, wins: a.filter((x) => x > 0).length, meanPct: r4(mean), ci95: h == null ? null : [r4(mean - h), r4(mean + h)], netSol: r4(closed.reduce((x, p) => x + p.pnlSol, 0)) };
}
module.exports = { GRAD_WAIT_MS, graduationMark, RULE, EXITS, SIZE, FEE, LAUNCH_PRICE, MAX_BLIND_MS, GRAD_HAIRCUT, evalRule, buyFill, curveSell, ammSell, markValue, exitCheck, stats };
