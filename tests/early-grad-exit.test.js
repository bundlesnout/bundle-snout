// Graduated coin without AMM price must close as grad_exit before the 60 s blind window voids it.
const assert = require('assert');
const E = require('../early');
assert.ok(E.GRAD_WAIT_MS < E.MAX_BLIND_MS, 'fallback must fire before positions are voided');
const now = 1e12, last = { vs: 80, vt: 2e8 };
assert.strictEqual(E.graduationMark({ graduatedAt: now - 5000, last, amm: null, now }), null, 'wait for AMM first');
const m = E.graduationMark({ graduatedAt: now - 20000, last, amm: null, now });
assert.strictEqual(m.kind, 'grad_fallback'); assert.strictEqual(m.final, true);
const a = E.graduationMark({ graduatedAt: now - 20000, last, amm: { priceSol: 5e-7, at: now - 1000 }, now });
assert.strictEqual(a.kind, 'amm'); assert.ok(!a.final);
assert.strictEqual(E.graduationMark({ graduatedAt: now - 20000, last, amm: { priceSol: 5e-7, at: now - 70e3 }, now }).kind, 'grad_fallback', 'stale AMM ignored');
// Haircut value is below the plain curve value
const pos = { tok: 1e6, cost: 0.1 };
assert.ok(E.markValue(pos, m) < E.markValue(pos, { kind: 'curve', vs: last.vs, vt: last.vt }));
console.log('early-grad-exit ok');
