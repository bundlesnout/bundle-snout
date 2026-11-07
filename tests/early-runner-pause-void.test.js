// Box-only: after a long box pause, open paper exits must be voided as void_pause
// (batched log + voidedPause), not mixed into "price unwatched >60s" (ops 2026-11-07:
// ~6304s pause voided time15/time60 HOUR and ₽ as unwatched).
const assert = require('assert');
const { voidOpenAfterBoxPause, formatPauseVoidLog } = require('../scripts/early-runner');
const { MAX_BLIND_MS } = require('../early');

const now = Date.now();
const open = [
  { v: 'time15', sym: 'HOUR', lastPriceAt: now - 7000e3 },
  { v: 'time60', sym: 'HOUR', lastPriceAt: now - 7000e3 },
  { v: 'time15', sym: '₽', lastPriceAt: now - 7000e3 },
  { v: 'time60', sym: '₽', lastPriceAt: now - 7000e3 },
  { v: 'tp50_sl20', sym: 'KEEP', done: 'tp', lastPriceAt: now - 7000e3 }, // already closed
];

// Short gap under blind window → no marks
assert.deepStrictEqual(voidOpenAfterBoxPause(open, { now, gapMs: MAX_BLIND_MS - 1 }), []);
assert.strictEqual(open.filter((p) => p.done === 'void_pause').length, 0);

const gapMs = 6304e3;
const marked = voidOpenAfterBoxPause(open, { now, gapMs, blindMs: MAX_BLIND_MS });
assert.strictEqual(marked.length, 4, 'four still-open positions marked');
assert.ok(marked.every((p) => p.done === 'void_pause' && p.pauseGapSec === 6304));
assert.strictEqual(open.find((p) => p.sym === 'KEEP').done, 'tp', 'already-done untouched');

const line = formatPauseVoidLog(marked, 6304);
assert.ok(line.startsWith('[early] VOID box pause 6304s:'));
assert.ok(line.includes('time15 HOUR'));
assert.ok(line.includes('time60 ₽'));
assert.ok(line.endsWith('(4)'));
assert.ok(!/price unwatched/.test(line), 'must not use unwatched wording');

assert.deepStrictEqual(voidOpenAfterBoxPause(null, { now, gapMs }), []);
assert.deepStrictEqual(voidOpenAfterBoxPause(open, { now, gapMs: 0 }), []);

console.log('early-runner-pause-void.test.js ok');

// Boot path: box-ensure restart after pause (fresh lastTick) must still void as void_pause
// per position lastPriceAt, not as generic unwatched (ops 2026-11-07: 206 generic vs 7 pause).
const { voidBlindOpensOnBoot } = require('../scripts/early-runner');
const bootNow = Date.now();
const bootOpen = [
  { v: 'time60', sym: 'OLD', lastPriceAt: bootNow - 4200e3 },
  { v: 'time15', sym: 'FRESH', lastPriceAt: bootNow - 5e3 },
  { v: 'trail25', sym: 'DONE', done: 'trail', lastPriceAt: bootNow - 4200e3 },
];
const bootMarked = voidBlindOpensOnBoot(bootOpen, { now: bootNow, blindMs: MAX_BLIND_MS });
assert.strictEqual(bootMarked.length, 1, 'only OLD is blind');
assert.strictEqual(bootMarked[0].sym, 'OLD');
assert.strictEqual(bootMarked[0].done, 'void_pause');
assert.strictEqual(bootMarked[0].voidFrom, 'boot');
assert.ok(bootMarked[0].pauseGapSec >= 4200);
assert.strictEqual(bootOpen.find((p) => p.sym === 'FRESH').done, undefined, 'fresh untouched');
assert.strictEqual(bootOpen.find((p) => p.sym === 'DONE').done, 'trail', 'already-done untouched');
assert.deepStrictEqual(voidBlindOpensOnBoot(null, { now: bootNow }), []);
assert.deepStrictEqual(voidBlindOpensOnBoot([], { now: bootNow }), []);
assert.deepStrictEqual(voidBlindOpensOnBoot([{ v: 'x', lastPriceAt: bootNow }], { now: bootNow, blindMs: MAX_BLIND_MS }), []);
console.log('early-runner-pause-void boot path ok');
