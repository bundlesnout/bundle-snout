// Fee Rips tracker tests: PDAs, memo parsing, Core asset parsing, claim detection, and an end-to-end refresh with a mocked network.
const assert = require('assert');
const R = require('../rips');

// 1) creator vault PDA (verified live against the SNOUT dev wallet, which holds unclaimed fees there)
const v = R.vaults('9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys');
assert.strictEqual(v.curve, 'FcATdZmcWGEcKP9N2DyYVdsQ1J4G4CMwj5dYthUwjDE3');

// 2) memo parsing: Collector Crypt purchase memos look like "[44] cc-<uuid>:open"
assert.strictEqual(R.memoFrom('[44] cc-cec4b9f8-8674-481b-8281-29264b30fde0:open'), 'cc-cec4b9f8-8674-481b-8281-29264b30fde0');
assert.strictEqual(R.memoFrom('[47] cc-ff579073-347e-4833-bab5-2630dfb9077a:buyback'), null, 'buybacks are not purchases');
assert.strictEqual(R.memoFrom('pump-cec4b9f8-8674-481b-8281-29264b30fde0:open'), 'pump-cec4b9f8-8674-481b-8281-29264b30fde0', 'any partner slug');

// 3) Core asset parsing
const s = (x) => { const b = Buffer.from(x, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const asset = Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 1), Buffer.from([2]), Buffer.alloc(32, 2), s('Test Card PSA 10'), s('https://arweave.net/abc')]);
assert.deepStrictEqual(R.parseCoreAsset(asset), { name: 'Test Card PSA 10', uri: 'https://arweave.net/abc' });

// 4) claim detection from a parsed tx
const tx = { transaction: { message: { accountKeys: [{ pubkey: 'DEV' }, { pubkey: v.curve }, { pubkey: v.amm }] } },
  meta: { preBalances: [1e9, 0.5e9 + 890880, 2039280], postBalances: [1.5e9, 890880, 2039280],
    preTokenBalances: [{ accountIndex: 2, uiTokenAmount: { amount: '200000000' } }], postTokenBalances: [{ accountIndex: 2, uiTokenAmount: { amount: '0' } }] } };
const d = R.vaultDeltas(tx, v); assert.ok(Math.abs(d.curve + 0.5) < 1e-9 && Math.abs(d.amm + 0.2) < 1e-9, JSON.stringify(d));

// 4b) per-coin creator fees from a REAL mainnet SNOUT sell (creator_fee 481820 lamports == the vault delta in that tx).
// The event appears both in the logs and as an emit_cpi inner instruction: it must be counted once.
const real = require('./fixtures/pump_trade_snout.json');
const SNOUT = 'FdAfduhybRLYNjreVSpPyBZEWfHbUVYaLQGp33Vjpump';
let tf = R.tradeFees(real, { mint: SNOUT, pool: null });
assert.strictEqual(tf.curveLamports, 481820); assert.strictEqual(tf.trades, 1); assert.deepStrictEqual([...tf.creators], ['9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys']);
assert.strictEqual(R.tradeFees(real, { mint: 'So11111111111111111111111111111111111111112', pool: null }).trades, 0, 'other coin of the same creator: not counted');
assert.strictEqual(R.tradeFees({ ...real, meta: { ...real.meta, err: { x: 1 } } }, { mint: SNOUT }).trades, 0, 'failed tx');
// 4c) live feed: individual trades from the same real tx (sell of 0.160606476 SOL), counted once despite log + emit_cpi copies
const ct = R.curveTrades(real, SNOUT, 'sigX');
assert.strictEqual(ct.length, 1); assert.strictEqual(ct[0].side, 'sell'); assert.strictEqual(ct[0].sol, 0.160606476);
assert.strictEqual(ct[0].wallet, '3NUE8epmweWe67xHQCq1xhwJ737cJSCCjFo3ZNAtFVFn'); assert.strictEqual(ct[0].ts, 1792840269);
assert.ok(Math.abs(ct[0].curvePct - 2.709) < 0.01, 'curve % ' + ct[0].curvePct); assert.ok(Math.abs(ct[0].mcapSol - 29.113) < 0.01, 'mcap SOL ' + ct[0].mcapSol);
assert.strictEqual(R.curveTrades(real, 'So11111111111111111111111111111111111111112', 's').length, 0, 'other mint');
assert.strictEqual(R.coinAccounts(SNOUT).bondingCurve, 'GWfgfrRVju5Bh9U9Ssiv59uMTzjo8zyoPysEZDEUDtnw');
// PumpSwap BuyEvent (synthetic, layout verified on mainnet): pool@120, coin_creator@312, bps@344, fee@352
const crypto = require('crypto'); const { PublicKey } = require('@solana/web3.js');
const POOL = R.coinAccounts(SNOUT).pumpswapPool;
const ev = Buffer.alloc(368); crypto.createHash('sha256').update('event:BuyEvent').digest().copy(ev, 0, 0, 8);
new PublicKey(POOL).toBuffer().copy(ev, 120); new PublicKey('9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys').toBuffer().copy(ev, 312);
ev.writeBigUInt64LE(30n, 344); ev.writeBigUInt64LE(12345n, 352);
const ammTx = (pool) => { const b = Buffer.from(ev); new PublicKey(pool).toBuffer().copy(b, 120); return { meta: { err: null, logMessages: ['Program data: ' + b.toString('base64')] }, transaction: { message: { accountKeys: [] } } }; };
tf = R.tradeFees(ammTx(POOL), { mint: SNOUT, pool: POOL }); assert.strictEqual(tf.ammLamports, 12345); assert.strictEqual(tf.trades, 1);
assert.strictEqual(R.tradeFees(ammTx('So11111111111111111111111111111111111111112'), { mint: SNOUT, pool: POOL }).trades, 0, 'other pool');

(async () => {
  // 5) not configured -> launching soon, no RPC
  let calls = 0;
  const off = R.createRips({ env: {}, fetch: async (u) => { calls++; return { ok: true, json: async () => (String(u).includes('machines') ? { machines: [{ code: 'pokemon_25', name: 'Starter', public: true, price: 25, instantBuyback: 85, ev: 27.5 }] } : { solana: { usd: 100 } }) }; }, log: () => {} });
  await off.refresh(); let st = off.status();
  assert.strictEqual(st.state, 'launching_soon'); assert.strictEqual(st.meta.rpcCalls, 0);
  assert.strictEqual(st.shelf[0].volumeNeededUsd, 8333); assert.ok(/dev keeps the cards/i.test(st.statement));
  assert.strictEqual(st.coin.ticker, 'DEVRIPS'); assert.strictEqual(st.coin.x, 'https://x.com/SpaniardDev', 'X link default (env RIPS_X_URL overrides)');
  assert.deepStrictEqual([st.nextPack.priceUsd, st.nextPack.pct, st.nextPack.volumeLeftUsd], [25, 0, 8333]);

  // 6) end-to-end: one claim, one pack bought by the dev, one manual memo from a stranger (shown, not counted)
  const DEV = '9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys', CA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const NFT = 'H1JsvCMt52wLUpXP8BWHk2MhY7Bk7z5t9Rfrs5iXtAat';
  const M1 = 'cc-11111111-2222-3333-4444-555555555555', M2 = 'cc-99999999-2222-3333-4444-555555555555';
  const M3 = 'cc-33333333-2222-3333-4444-555555555555', M4 = 'cc-44444444-2222-3333-4444-555555555555';
  const ACC = R.coinAccounts(CA);
  const tradeTx = { ...real, meta: { ...real.meta, logMessages: real.meta.logMessages.map((l) => { const b = Buffer.from(l.slice(14), 'base64'); new PublicKey(CA).toBuffer().copy(b, 8); return 'Program data: ' + b.toString('base64'); }), innerInstructions: [] } };
  const otherCoinTx = real; // same creator, another mint (SNOUT): pooled vault only, not this coin
  const claimTx = { transaction: { message: { accountKeys: [{ pubkey: DEV }, { pubkey: v.curve }] } }, meta: { preBalances: [0, 0.3e9 + 890880], postBalances: [0.3e9, 890880] } };
  const ok = (j) => ({ ok: true, json: async () => j });
  const fetchMock = async (url, init) => {
    url = String(url);
    if (init?.method === 'POST') {
      const { method, params } = JSON.parse(init.body);
      if (method === 'getMinimumBalanceForRentExemption') return ok({ result: 890880 });
      if (method === 'getBalance') return ok({ result: { value: 0.1e9 + 890880 } });
      if (method === 'getAccountInfo' && params[0] === v.amm) return ok({ result: { value: null } });
      if (method === 'getAccountInfo' && params[0] === NFT) return ok({ result: { value: { owner: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', data: [asset.toString('base64'), 'base64'] } } });
      if (method === 'getSignaturesForAddress') {
        if (params[1].until) return ok({ result: [] });
        if (params[0] === ACC.bondingCurve) return ok({ result: [{ signature: 'trade2', err: null, blockTime: 2000 }, { signature: 'mixed', err: null, blockTime: 1500 }, { signature: 'failed', err: { x: 1 }, blockTime: 1200 }, { signature: 'create', err: null, blockTime: 1000 }] });
        if (params[0] === ACC.pumpswapPool) return ok({ result: [] });
        return ok({ result: [{ signature: 'buySig', memo: `[44] ${M1}:open`, err: null, blockTime: 3000 }, { signature: 'devBuy', memo: `[44] ${M3}:open`, err: null, blockTime: 3100 }, { signature: 'claimSig', memo: null, err: null, blockTime: 2500 }, { signature: 'oldPack', memo: `[44] ${M4}:open`, err: null, blockTime: 500 }] });
      }
      if (method === 'getTransaction') {
        const sig = params[0];
        if (params[1].encoding === 'json') return ok({ result: sig === 'trade2' ? tradeTx : sig === 'mixed' ? otherCoinTx : { meta: { err: null, logMessages: [] }, transaction: { message: { accountKeys: [] } } } });
        return ok({ result: claimTx });
      }
      throw new Error('unexpected rpc ' + method);
    }
    if (url.includes('/api/pack/status')) {
      const mine = url.includes(M1) || url.includes(M3); if (url.includes(M4)) throw new Error('pack from before the coin existed must not be looked up');
      return ok({ pack: { wallet: mine ? DEV : 'Stranger1111111111111111111111111111111111', status: 'confirmed', pack_type: 'pokemon_50', transaction_signature: mine ? (url.includes(M3) ? 'devBuy' : 'buySig') : 'x', created_at: new Date().toISOString(), token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        send: { nft_address: NFT, status: 'confirmed', transaction_signature: 'sendSig', insured_value: 60, prize_tier: 3, to_wallet: DEV }, buyback: [] });
    }
    if (url.includes('arweave')) return ok({ name: 'Test Card PSA 10', image: 'https://img/x.jpg', attributes: [{ trait_type: 'Grade', value: '10' }] });
    if (url.includes('dexscreener')) return ok([{ dexId: 'pumpfun', url: 'https://dexscreener.com/x', priceUsd: '0.00001', marketCap: 10000, volume: { h24: 5000 }, baseToken: { name: 'Fees Rip Packs', symbol: 'RIPS' } }]);
    if (url.includes('machines')) return ok({ machines: [{ code: 'pokemon_50', name: 'Elite', public: true, price: 50, instantBuyback: 85, ev: 55 }] });
    if (url.includes('coingecko')) return ok({ solana: { usd: 100 } });
    throw new Error('unexpected url ' + url);
  };
  const r = R.createRips({ env: { RIPS_CA: CA, RIPS_DEV_WALLET: DEV, RIPS_EXTRA: M2, RIPS_DEV_PAID: 'devBuy', RIPS_FEE_GAP_MS: '0' }, fetch: fetchMock, log: () => {} });
  await r.refresh(); st = r.status();
  assert.strictEqual(st.fees.thisCoin.txPending, 3, 'failed tx not queued'); assert.strictEqual(st.fees.thisCoin.complete, false);
  await r.drainFees(); st = r.status();
  assert.strictEqual(st.fees.thisCoin.earnedSol, 0.00048182, 'only this coin\'s trade counted'); assert.strictEqual(st.fees.thisCoin.tradesCounted, 1);
  assert.strictEqual(st.fees.thisCoin.complete, true); assert.strictEqual(st.coin.createdSig, 'create');
  assert.strictEqual(st.meta.lastError, null, st.meta.lastError);
  assert.strictEqual(st.state, 'live');
  assert.strictEqual(st.fees.wallet.claims.length, 1); assert.strictEqual(st.fees.wallet.claimedSinceLaunchSol, 0.3);
  assert.strictEqual(st.fees.wallet.unclaimedSol, 0.1); assert.ok(/all coins/.test(st.fees.wallet.scope));
  assert.strictEqual(st.packs.list.length, 3, 'old pack before launch skipped'); assert.strictEqual(st.packs.opened, 2, 'stranger pack not counted');
  assert.strictEqual(st.packs.spentUsd, 100); assert.strictEqual(st.packs.paidByDevUsd, 50); assert.strictEqual(st.packs.paidFromFeesUsd, 50);
  assert.strictEqual(st.packs.list.find((p) => p.purchaseSig === 'devBuy').paidBy, 'dev');
  assert.strictEqual(st.nextPack.haveUsd, 0, 'fees already spent on packs leave nothing for the next one'); assert.strictEqual(st.nextPack.pct, 0);
  assert.strictEqual(st.packs.check.ok, false, '$50 of packs from fees > $0.05 of this coin\'s fees'); assert.strictEqual(st.packs.insuredValueUsd, 120);
  const mine = st.packs.list.find((p) => p.memo === M1);
  assert.ok(mine.verified && mine.rarity === 'Uncommon' && mine.card.name === 'Test Card PSA 10' && mine.card.image === 'https://img/x.jpg');
  assert.strictEqual(st.packs.list.find((p) => p.memo === M2).verified, false);
  assert.strictEqual(st.coin.market.symbol, 'RIPS');
  // live screen data: the one real trade of this coin, last verified rip, no invented numbers
  let L = r.live();
  assert.strictEqual(L.state, 'live'); assert.strictEqual(L.coin.ca, CA); assert.strictEqual(L.trades.length, 1);
  assert.deepStrictEqual([L.trades[0].side, L.trades[0].sol, L.trades[0].wallet], ['sell', 0.1606, '3NUE...FVFn']);
  assert.deepStrictEqual([L.stats.trades, L.stats.buys, L.stats.sells, L.stats.buyers], [1, 0, 1, 0]);
  assert.strictEqual(L.stats.curvePct, 2.71); assert.ok(L.stats.mcapUsd > 2900 && L.stats.mcapUsd < 2920, 'mcap from curve * SOL price');
  assert.ok(L.lastRip && L.lastRip.card.name === 'Test Card PSA 10'); assert.strictEqual(L.packsOpened, 2);
  await r.livePoll(); assert.strictEqual(r.status().fees.thisCoin.txPending, 0, 'live poll does not re-queue known sigs');
  await r.drainFees(); assert.strictEqual(r.live().stats.trades, 1, 'no double counting in the feed');
  assert.strictEqual(off.live().state, 'launching_soon'); assert.strictEqual(off.live().trades.length, 0); assert.strictEqual(off.live().coin.ca, null);
  // second refresh is incremental: no double counting
  await r.refresh(); st = r.status();
  await r.drainFees();
  assert.strictEqual(st.fees.wallet.claims.length, 1); assert.strictEqual(st.packs.opened, 2); assert.strictEqual(r.status().fees.thisCoin.earnedSol, 0.00048182);
  r.stop();
  console.log('rips tests OK');
})().catch((e) => { console.error(e); process.exit(1); });

// RPC 429 is retried (then succeeds) instead of failing the whole refresh step
(async () => {
  const R2 = require('../rips');
  let n = 0;
  const r = R2.createRips({ env: { RIPS_RETRY_MS: '0' }, log: () => {}, fetch: async () => { n++; return n < 3 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, json: async () => ({ result: 42 }) }; } });
  if (!r._rpc) { console.log('rips 429 retry: (no _rpc hook, skipped)'); return; }
  const v = await r._rpc('getSlot', []);
  if (v !== 42 || n !== 3) { console.error('FAIL rips 429 retry', v, n); process.exit(1); }
  console.log('ok rips 429 retry');
  let m = 0;
  const r3 = R2.createRips({ env: { RIPS_RETRY_MS: '0' }, log: () => {}, fetch: async () => { m++; return m < 2 ? { ok: false, status: 413, json: async () => ({}) } : { ok: true, json: async () => ({ result: 7 }) }; } });
  const v3 = await r3._rpc('getSlot', []);
  if (v3 !== 7 || m !== 2) { console.error('FAIL rips 413 retry', v3, m); process.exit(1); }
  let k = 0;
  const r4 = R2.createRips({ env: { RIPS_RETRY_MS: '0' }, log: () => {}, fetch: async () => { k++; return { ok: false, status: 400, json: async () => ({}) }; } });
  let threw = false; try { await r4._rpc('getSlot', []); } catch { threw = true; }
  if (!threw || k !== 1) { console.error('FAIL rips 400 not retried', k); process.exit(1); }
  console.log('ok rips 413 retry / 400 no retry');
})();

// When the RPC throttles during refresh, the remaining RPC steps are skipped for that round (no hammering), market still runs.
(async () => {
  const R5 = require('../rips');
  let rpcCalls = 0, other = 0;
  const r = R5.createRips({ env: { RIPS_CA: '3eoNHop3a7MYVEw94yJrqvRWnfYWQcg6yruCymg2pump', RIPS_DEV_WALLET: '4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy', RIPS_RETRY_MS: '0' }, log: () => {},
    fetch: async (u) => { if (String(u).includes('solana.com')) { rpcCalls++; return { ok: false, status: 429, json: async () => ({}) }; } other++; return { ok: true, json: async () => ({}) }; } });
  await r.refresh();
  const s = r.status();
  if (rpcCalls !== 3 || !s.meta.throttleSkips || !/skipped/.test(s.meta.lastError || '')) { console.error('FAIL rips throttle skip', rpcCalls, s.meta); process.exit(1); }
  console.log('ok rips throttle skip (rpc calls', rpcCalls + ', skipped steps', s.meta.throttleSkips + ')');
})();
