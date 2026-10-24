// Offline tests for Bond Radar clean thresholds using saved analyzer reports. Run: npm test
const assert = require('assert');
const { cleanCheck, progressFromApi } = require('../radar');
const fs = require('fs'); const path = require('path');
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f)));
const cfg = { thresholdPct: 70, maxTop10Pct: 30, maxSameSlotPct: 10, maxEarlyHoldPct: 10, maxDevHoldPct: 10, allowDevSell: false };
// Known bundled token (risk ALTO) must never be clean.
const bundled = load('Bo8T2nESUEwfZU4rygeb8n4d2Hm5DtsKLaYtP7tEpump.json');
const r1 = cleanCheck(bundled, cfg); assert.strictEqual(r1.clean, false); console.log('bundled ->', r1.reasons);
// Synthetic clean report derived from it.
const ok = JSON.parse(JSON.stringify(bundled));
Object.assign(ok, { isPumpFun: true, curve: { ...ok.curve, complete: false, progressPct: 74 }, risk: { level: 'BAJO' } });
Object.assign(ok.bundle, { multiWalletTxs: 0, sameSlotPaidByDev: 0, rightAfterCreateWallets: 0, rightAfterCreatePct: 0, sameSlotPctSupply: 2, earlyStillHoldPct: 3 });
ok.dev = { hasSold: false, holdingPctSupply: 1, soldPctOfBought: 0 }; ok.holders = { top10Pct: 18 };
assert.deepStrictEqual(cleanCheck(ok, cfg), { clean: true, reasons: [] });
for (const [mut, why] of [
  [(r) => (r.dev.hasSold = true), 'dev sold'], [(r) => (r.holders.top10Pct = 31), 'top-10'], [(r) => (r.bundle.multiWalletTxs = 1), 'multi-wallet'],
  [(r) => (r.bundle.sameSlotPaidByDev = 1), 'fee-paid by dev'], [(r) => (r.bundle = null), 'bundle check unavailable'], [(r) => (r.curve.complete = true), 'graduated'],
]) { const c = JSON.parse(JSON.stringify(ok)); mut(c); const res = cleanCheck(c, cfg); assert.strictEqual(res.clean, false, why); assert(res.reasons.some((x) => x.includes(why)), why + ' reason'); }
assert.strictEqual(progressFromApi({ real_token_reserves: 793_100_000e6 }), 0);
assert.strictEqual(progressFromApi({ real_token_reserves: 793_100_000e6 * 0.3 }), 70);
assert.strictEqual(progressFromApi({ complete: true }), 100);
console.log('all clean-check tests passed');
