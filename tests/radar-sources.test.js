// Bond Radar data layer: trade stream -> progress -> queue; GeckoTerminal discovery -> on-chain tracker; pump.fun API off by default.
process.env.RADAR_WS = '0'; process.env.RADAR_SCAN_GAP_MS = '0';
const assert = require('assert');
const analyzer = require('../analyzer');
const queued = []; const logs = [];
analyzer.analyze = async (mint) => { queued.push(mint); throw new Error('stub'); };
const { createRadar } = require('../radar');
(async () => {
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (u) => {
    calls.push(String(u));
    if (String(u).includes('pump.fun')) throw new Error('pump.fun API must not be called by default');
    return { ok: true, json: async () => ({ data: [{ attributes: { address: 'CURVE1', name: 'GEK / SOL' }, relationships: { base_token: { data: { id: 'solana_MINTG' } } } }] }) };
  };
  analyzer.rpc = async (method, params) => {
    assert.strictEqual(method, 'getMultipleAccounts');
    return { value: params[0].map(() => { const d = Buffer.alloc(49); d.writeBigUInt64LE(BigInt(793_100_000e6 * 0.25), 24); return { owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', data: [d.toString('base64')] }; }) };
  };
  const r = createRadar({ log: (...a) => logs.push(a.join(' ')) });
  const s0 = r.status();
  assert.strictEqual(s0.sources.pumpApi, false); assert.ok(s0.poll.disabled);
  // stream: 30% progress -> tracked, not queued; 80% -> queued; realTok missing -> derived from virtual reserves
  r.onTrade({ mint: 'MINTA', vs: 40, vt: 279.9e6 + 793.1e6 * 0.7, realTok: 793.1e6 * 0.7, ts: 1 }, { symbol: 'AAA', solUsd: 100 });
  r.onTrade({ mint: 'MINTB', vs: 80, vt: 279.9e6 + 793.1e6 * 0.2, realTok: null, ts: 1 }, { symbol: 'BBB', solUsd: 100 });
  r.onTrade({ mint: 'MINTC', vs: 85, vt: 279.9e6, realTok: 0, ts: 1 }); // graduated -> dropped
  let s = r.status();
  assert.strictEqual(s.trackedCoins, 2, 'two live coins tracked');
  assert.strictEqual(s.hottest[0].mint, 'MINTB'); assert.strictEqual(s.hottest[0].progress, 80); assert.strictEqual(s.hottest[1].progress, 30);
  assert.ok(s.stream.trades === 3 && s.stream.lastAt);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepStrictEqual(queued, ['MINTB'], 'only the coin above threshold is scanned');
  // throttle: a second trade within 2 s is counted but not re-upserted
  r.onTrade({ mint: 'MINTA', vs: 41, vt: 279.9e6 + 793.1e6 * 0.69, realTok: 793.1e6 * 0.69, ts: 2 });
  assert.strictEqual(r.status().hottest[1].progress, 30);
  // gecko -> chain tracker -> 75% -> queued
  await r.geckoPoll(true);
  assert.ok(calls.every((u) => u.includes('geckoterminal')), 'only GeckoTerminal fetched');
  assert.strictEqual(r.status().gecko.added, 1);
  await r.chainTick();
  s = r.status();
  assert.ok(s.hottest.some((h) => h.mint === 'MINTG' && h.progress === 75), 'gecko coin read on chain');
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(queued.includes('MINTG'));
  r.stop(); global.fetch = realFetch;
  console.log('all radar source tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
