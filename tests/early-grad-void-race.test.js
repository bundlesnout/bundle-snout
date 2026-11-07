// Graduated mark must close as grad_exit even when lastPriceAt is already past MAX_BLIND_MS.
// Before this fix, monitor voided on stale lastPriceAt before applying grad_fallback
// (ops 2026-11-07: GEO peak 4.6x graduated, time60 voided; time60 0 exits / many voids).
const assert = require('assert');
const E = require('../early');
const { applyOpenMark, heartbeatGradWait } = require('../scripts/early-runner');

const now = 1e12;
const mint = 'GEOMint1111111111111111111111111111111';
const last = { vs: 100, vt: 1e8 };
const mark = E.graduationMark({ graduatedAt: now - 20e3, last, amm: null, now });
assert.strictEqual(mark.kind, 'grad_fallback');
assert.strictEqual(mark.final, true);

const fill = E.buyFill(last.vs, last.vt, E.SIZE);
const open = [
  { v: 'time60', mint, sym: 'GEO', at: now - 50 * 60e3, cost: E.SIZE + 0.000024, tok: fill.tok, peakVal: 0, lastPriceAt: now - 90e3 },
  { v: 'time15', mint, sym: 'GEO', at: now - 50 * 60e3, cost: E.SIZE + 0.000024, tok: fill.tok, peakVal: 0, lastPriceAt: now - 90e3, done: 'time' },
  { v: 'time60', mint: 'OTHER', sym: 'X', at: now - 1e3, cost: 0.1, tok: fill.tok, peakVal: 0, lastPriceAt: now - 90e3 },
];

const hit = applyOpenMark(open, mint, mark, now);
assert.strictEqual(hit.length, 1, 'one open GEO leg closed');
assert.strictEqual(hit[0].done, 'grad_exit');
assert.strictEqual(hit[0].markKind, 'grad_fallback');
assert.strictEqual(hit[0].lastPriceAt, now);
assert.ok(hit[0].pnlPct != null);
assert.strictEqual(open[1].done, 'time', 'already-done untouched');
assert.strictEqual(open[2].done, undefined, 'other mint untouched');
assert.deepStrictEqual(applyOpenMark(open, mint, null, now), []);
assert.deepStrictEqual(applyOpenMark(null, mint, mark, now), []);

// During GRAD_WAIT (no mark yet), heartbeat keeps sweep from voiding.
const waiting = [{ v: 'time60', mint, lastPriceAt: now - 50e3 }];
assert.strictEqual(heartbeatGradWait(waiting, mint, now), 1);
assert.strictEqual(waiting[0].lastPriceAt, now);
assert.strictEqual(heartbeatGradWait(null, mint, now), 0);

console.log('early-grad-void-race.test.js ok');
