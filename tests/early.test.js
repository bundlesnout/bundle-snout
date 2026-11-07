// early-volume paper rule: trigger conditions, fills/exits from curve math, voiding helpers
const assert = require('assert');
const E = require('../early');
const cr = 1_000_000_000_000, LP = E.LAUNCH_PRICE;
function mk({ n = 40, sol = 2.5, buyFrac = 0.7, mult = 3, spread = 110, users = n, usd = 100 } = {}) {
  const t = []; for (let i = 0; i < n; i++) { const buy = i < n * buyFrac; t.push({ at: cr + Math.round((i / n) * spread * 1000), user: 'w' + (i % users), buy, sol, priceSol: LP * mult, priceUsd: LP * mult * usd }); } return t;
}
const now = cr + 115e3;
// passes: 100 SOL in 110 s, 40 buyers... (28 buys of 40 -> buyers 28) -> use n=50
let r = E.evalRule(mk({ n: 50, sol: 2 }), cr, now); assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(r.f.buyers, 35); assert.ok(r.f.vol120 >= 80 && r.f.volLast >= 30 && r.f.mult >= 2.5 && r.f.bs >= 1.3);
// each condition fails on its own
assert.deepStrictEqual(E.evalRule(mk({ n: 50, sol: 1 }), cr, now).fails, ['vol120', 'volLast']);
assert.deepStrictEqual(E.evalRule(mk({ n: 50, sol: 2, mult: 2 }), cr, now).fails, ['mult']);
assert.deepStrictEqual(E.evalRule(mk({ n: 50, sol: 2, buyFrac: 0.5 }), cr, now).fails, ['bs', 'buyers']);
assert.deepStrictEqual(E.evalRule(mk({ n: 50, sol: 2, users: 3 }), cr, now).fails, ['buyers', 'wallet']);
assert.deepStrictEqual(E.evalRule(mk({ n: 50, sol: 2, mult: 30 }), cr, now).fails, ['mc']); // 30x launch ~ $78k at $100/SOL
assert.ok(E.evalRule(mk({ n: 50, sol: 2 }), cr, cr + 181e3).fails.includes('age'));
// volume after 120 s does not count toward vol120
assert.ok(E.evalRule(mk({ n: 50, sol: 2, spread: 400 }), cr, cr + 179e3).fails.includes('vol120'));
// curve math: 0.1 SOL buy at 3x launch costs a 1.25% fee + small impact; immediate sell loses ~fees both sides
const vs = 30 * Math.sqrt(3), vt = 30 * 1.073e9 / vs * 1; // vs*vt = k, price = vs/vt
const f = E.buyFill(vs, vt * 1, 0.1); assert.ok(f.impactPct > 0 && f.impactPct < 1, f.impactPct);
const back = E.curveSell(vs + f.solIn, vt - f.tok, f.tok); assert.ok(back < 0.1 && back > 0.096, back);
// exits
const pos = { cost: 0.100024, tok: f.tok, at: cr, peakVal: 0 };
assert.strictEqual(E.exitCheck({ ...pos }, { tp: 50, sl: 20 }, 0.16, cr + 1e3), 'tp');
assert.strictEqual(E.exitCheck({ ...pos }, { tp: 50, sl: 20 }, 0.079, cr + 1e3), 'sl');
const tp = { ...pos }; assert.strictEqual(E.exitCheck(tp, { trail: 25 }, 0.3, cr + 1e3), null); assert.strictEqual(E.exitCheck(tp, { trail: 25 }, 0.224, cr + 2e3), 'trail');
assert.strictEqual(E.exitCheck({ ...pos }, { holdMin: 15 }, 0.1, cr + 15 * 60e3), 'time');
assert.strictEqual(E.exitCheck({ ...pos }, { tp: 100, sl: 30 }, 0.1, cr + 60 * 60e3), 'maxhold');
// graduated valuation: AMM price path and 0.8x fallback
assert.ok(Math.abs(E.markValue({ tok: f.tok }, { kind: 'grad_fallback', vs, vt }) - 0.8 * E.curveSell(vs, vt, f.tok)) < 1e-12);
assert.ok(E.markValue({ tok: f.tok }, { kind: 'amm', priceSol: vs / vt }) < f.tok * vs / vt);
// stats
const s = E.stats([{ pnlPct: 10, pnlSol: 0.01 }, { pnlPct: -20, pnlSol: -0.02 }]); assert.strictEqual(s.n, 2); assert.strictEqual(s.wins, 1); assert.strictEqual(s.meanPct, -5);
console.log('early tests ok');
