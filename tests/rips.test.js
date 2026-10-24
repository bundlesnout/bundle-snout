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

(async () => {
  // 5) not configured -> launching soon, no RPC
  let calls = 0;
  const off = R.createRips({ env: {}, fetch: async (u) => { calls++; return { ok: true, json: async () => (String(u).includes('machines') ? { machines: [{ code: 'pokemon_25', name: 'Starter', public: true, price: 25, instantBuyback: 85, ev: 27.5 }] } : { solana: { usd: 100 } }) }; }, log: () => {} });
  await off.refresh(); let st = off.status();
  assert.strictEqual(st.state, 'launching_soon'); assert.strictEqual(st.meta.rpcCalls, 0);
  assert.strictEqual(st.shelf[0].volumeNeededUsd, 8333); assert.ok(/dev keeps the cards/i.test(st.statement));

  // 6) end-to-end: one claim, one pack bought by the dev, one manual memo from a stranger (shown, not counted)
  const DEV = '9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys', CA = 'FdAfduhybRLYNjreVSpPyBZEWfHbUVYaLQGp33Vjpump';
  const NFT = 'H1JsvCMt52wLUpXP8BWHk2MhY7Bk7z5t9Rfrs5iXtAat';
  const M1 = 'cc-11111111-2222-3333-4444-555555555555', M2 = 'cc-99999999-2222-3333-4444-555555555555';
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
      if (method === 'getSignaturesForAddress') return ok({ result: params[1].until ? [] : [{ signature: 'buySig', memo: `[44] ${M1}:open`, err: null, blockTime: 1 }, { signature: 'claimSig', memo: null, err: null, blockTime: 1 }] });
      if (method === 'getTransaction') return ok({ result: claimTx });
      throw new Error('unexpected rpc ' + method);
    }
    if (url.includes('/api/pack/status')) {
      const mine = url.includes(M1);
      return ok({ pack: { wallet: mine ? DEV : 'Stranger1111111111111111111111111111111111', status: 'confirmed', pack_type: 'pokemon_50', transaction_signature: mine ? 'buySig' : 'x', created_at: new Date().toISOString(), token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        send: { nft_address: NFT, status: 'confirmed', transaction_signature: 'sendSig', insured_value: 60, prize_tier: 3, to_wallet: DEV }, buyback: [] });
    }
    if (url.includes('arweave')) return ok({ name: 'Test Card PSA 10', image: 'https://img/x.jpg', attributes: [{ trait_type: 'Grade', value: '10' }] });
    if (url.includes('dexscreener')) return ok([{ dexId: 'pumpfun', url: 'https://dexscreener.com/x', priceUsd: '0.00001', marketCap: 10000, volume: { h24: 5000 }, baseToken: { name: 'Fees Rip Packs', symbol: 'RIPS' } }]);
    if (url.includes('machines')) return ok({ machines: [{ code: 'pokemon_50', name: 'Elite', public: true, price: 50, instantBuyback: 85, ev: 55 }] });
    if (url.includes('coingecko')) return ok({ solana: { usd: 100 } });
    throw new Error('unexpected url ' + url);
  };
  const r = R.createRips({ env: { RIPS_CA: CA, RIPS_DEV_WALLET: DEV, RIPS_EXTRA: M2 }, fetch: fetchMock, log: () => {} });
  await r.refresh(); st = r.status();
  assert.strictEqual(st.meta.lastError, null, st.meta.lastError);
  assert.strictEqual(st.state, 'live');
  assert.strictEqual(st.fees.claims.length, 1); assert.strictEqual(st.fees.claimedSol, 0.3);
  assert.strictEqual(st.fees.unclaimedSol, 0.1); assert.strictEqual(st.fees.earnedSol, 0.4); assert.strictEqual(st.fees.earnedUsd, 40);
  assert.strictEqual(st.packs.list.length, 2); assert.strictEqual(st.packs.opened, 1, 'stranger pack not counted');
  assert.strictEqual(st.packs.spentUsd, 50); assert.strictEqual(st.packs.insuredValueUsd, 60);
  const mine = st.packs.list.find((p) => p.memo === M1);
  assert.ok(mine.verified && mine.rarity === 'Uncommon' && mine.card.name === 'Test Card PSA 10' && mine.card.image === 'https://img/x.jpg');
  assert.strictEqual(st.packs.list.find((p) => p.memo === M2).verified, false);
  assert.strictEqual(st.coin.market.symbol, 'RIPS');
  // second refresh is incremental: no double counting
  await r.refresh(); st = r.status();
  assert.strictEqual(st.fees.claims.length, 1); assert.strictEqual(st.packs.opened, 1);
  console.log('rips tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
