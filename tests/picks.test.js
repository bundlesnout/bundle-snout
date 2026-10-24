// Unit tests for deep score() and the pick engine (no network: fetch is mocked).
const assert = require('assert');
process.env.RADAR_PICK_CONTEST_MIN = '0.001'; process.env.RADAR_PICK_COOLDOWN_MIN = '30'; process.env.RADAR_TRACK_MS = '3600000';
const { score } = require('../deep');
const { createPicker } = require('../picks');

const goodTrades = { sampled: 120, uniqueBuyers: 60, uniqueBuyerRatio: 0.8, buyersPerMin: 3, newBuyersSecondHalf: 30, buySizeCV: 1.5, avgBuySol: 0.3, netSol10: 5, buySol10: 6, sellSol10: 1, momentum: 1.6, tinyShare: 0.05, modeShare: 0.03, botWallets: 0, botTxShare: 0, washVolShare: 0.05 };
const goodClusters = { walletsChecked: 14, freshWallets: 0, freshShare: 0, largestCluster: { size: 0, pct: 0 }, devFundedHolders: 0, devFundedPct: 0 };
const goodDev = { known: true, walletSigs: 300, priorLaunches: 0, priorDead: 0, priorGraduated: 0, dumpedRatio: null };
const s1 = score({ trades: goodTrades, clusters: goodClusters, dev: goodDev, socials: { twitter: true, telegram: true, website: true } });
assert.ok(s1.score >= 95, 'ideal coin scores high: ' + s1.score); assert.deepStrictEqual(s1.hardFails, []);

const bot = score({ trades: { ...goodTrades, tinyShare: 0.7, washVolShare: 0.6, botTxShare: 0.55, uniqueBuyers: 9 }, clusters: { ...goodClusters, largestCluster: { size: 4, pct: 22 }, freshShare: 0.8 }, dev: { ...goodDev, priorLaunches: 6, priorDead: 6, dumpedRatio: 1 }, socials: {} });
assert.strictEqual(bot.hardFails.length, 7, 'all hard fails fire: ' + bot.hardFails.join(' | '));
assert.ok(bot.score < 50, 'bot coin scores low: ' + bot.score);
const sellers = score({ trades: { ...goodTrades, sellSol10: 9, buySol10: 3, netSol10: -6 }, clusters: goodClusters, dev: goodDev, socials: {} });
assert.ok(sellers.hardFails.some((f) => /presión vendedora/.test(f)));
console.log('score tests passed', s1.score, bot.score);

// ---- picker
const store = { data: { subs: [], alerted: [], picks: [] }, saves: 0, save() { this.saves++; } };
const mk = (sym, sc, extra = {}) => ({ mint: sym.padEnd(32, 'x'), symbol: sym, stage: 'deep', score: sc, parts: s1.parts, hardFails: [],
  rep: { name: sym, symbol: sym, mint: sym.padEnd(32, 'x'), curve: { progressPct: 75, quoteRemainingToGraduate: 20.5, quote: 'SOL' }, holders: { top10Pct: 22 }, dev: { holdingPctSupply: 0.5 }, bundle: { sameSlotWallets: 0, sameSlotPctSupply: 0 }, dex: { marketCapUsd: 15000, priceUsd: 0.000015 } },
  deep: { score: sc, trades: goodTrades, clusters: goodClusters, dev: goodDev, socials: { twitter: true } }, ...extra });
let mc = 16000;
global.fetch = async (u) => ({ ok: true, json: async () => u.split('/').pop().split(',').map((m) => ({ baseToken: { address: m }, marketCap: mc, priceUsd: String(mc / 1e9), dexId: mc > 60000 ? 'pumpswap' : 'pumpfun' })) });
const picked = [];
const pk = createPicker({ store, onPick: async (p) => picked.push(p), log: () => {} });
(async () => {
  pk.addCandidate({ mint: 'D1'.padEnd(32, 'x'), symbol: 'DIRTY', stage: 'basic', reasons: ['dev sold (100% of buys)'] });
  pk.addCandidate(mk('LOW', 55));
  pk.addCandidate(mk('HF', 90, { hardFails: ['wash trading: 60%'] }));
  pk.addCandidate(mk('AAA', 74));
  pk.addCandidate(mk('BBB', 81));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(picked.length, 1, 'exactly one pick'); const p = picked[0];
  assert.strictEqual(p.symbol, 'BBB', 'best qualifier wins'); assert.strictEqual(p.entryMcUsd, 16000); assert.strictEqual(p.mode, 'demo');
  assert.ok(/AAA: 74\/100/.test(p.rationale) && /HF: descartada/.test(p.rationale) && /filtro básico/.test(p.rationale), p.rationale);
  assert.ok(p.rationale.length <= 1800);
  pk.addCandidate(mk('CCC', 95)); await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(picked.length, 1, 'cooldown blocks a second pick');
  mc = 80000; await pk.track(); // 5x + migrated
  assert.ok(p.milestones.x2 && p.milestones.x5 && !p.milestones.x10 && p.migrated && p.peakMultiple === 5);
  mc = 2000; await pk.track();
  assert.ok(p.rugAt && p.curMultiple === 0.13 && p.peakMultiple === 5, 'rug recorded, peak kept');
  console.log('pick tests passed:\n' + p.rationale);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
