// Fee Rips tracker: creator fees (read on-chain) -> Collector Crypt card packs opened by the dev wallet, shown live on /rips.
// Free sources only: public Solana RPC (no Helius), Collector Crypt public gacha API, DexScreener, CoinGecko.
// Env: RIPS_CA (coin mint), RIPS_DEV_WALLET (creator wallet), RIPS_EXTRA (comma list of pack memos or purchase tx signatures,
// manual fallback; add ":dev" to mark a pack paid by the dev, not by fees), RIPS_DEV_PAID (comma list of memos / purchase sigs paid by
// the dev, not fees), RIPS_RPC_URL (default public mainnet RPC), RIPS_REFRESH_MS (default 180000), RIPS_FEE_GAP_MS (default 300),
// RIPS_TICKER, RIPS_NAME, RIPS_X_URL.
// Per-coin fees: the creator vault is shared by every coin of the dev wallet, so "this coin's fees" is the exact sum of creator_fee in
// every pump.fun TradeEvent (bonding curve) and coin_creator_fee in every PumpSwap Buy/SellEvent (canonical pool) for this mint,
// read tx by tx from the public RPC. The pooled vault/claim totals are shown separately, labelled "all coins from this dev wallet".
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
let bs58 = null; try { const b = require('bs58'); bs58 = b.default || b; } catch {}

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PAMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const GACHA = 'https://gacha.collectorcrypt.com';
const RENT_0_DEFAULT = 650240; // rent-exempt minimum for a 0-byte account (the pump creator vault keeps it); read live via RPC
const CREATOR_FEE_PCT = 0.30; // pump.fun bonding curve creator fee (pump.fun/docs/fees, updated 17 Oct 2026)
const TIER = { 1: 'Epic', 2: 'Rare', 3: 'Uncommon', 4: 'Common' };
const MEMO_RE = /([a-z0-9]{1,24}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):open/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const evDisc = (n) => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex');
const D_TRADE = evDisc('TradeEvent'); const D_BUY = evDisc('BuyEvent'); const D_SELL = evDisc('SellEvent');
const EMIT_CPI = 'e445a52e51cb9a1d'; // anchor event-cpi instruction tag

function coinAccounts(mint) {
  const m = new PublicKey(mint);
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), m.toBuffer()], PUMP)[0];
  const poolAuth = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], PUMP)[0];
  const pool = PublicKey.findProgramAddressSync([Buffer.from('pool'), Buffer.alloc(2), poolAuth.toBuffer(), m.toBuffer(), WSOL.toBuffer()], PAMM)[0];
  return { bondingCurve: curve.toBase58(), pumpswapPool: pool.toBase58() };
}

// Creator fees for ONE coin inside one raw ("json" encoding) tx. Events are read from anchor emit_cpi inner instructions and from
// "Program data:" logs, de-duplicated by payload. Layouts verified on mainnet (24 Oct 2026): creator_fee equals the vault delta.
//  pump TradeEvent: disc, mint@8, ..., creator@177, creator_fee_bps@209, creator_fee@217
//  PumpSwap Buy/SellEvent: disc, 14 x u64, pool@120, ..., coin_creator@312, coin_creator_fee_bps@344, coin_creator_fee@352
function tradeFees(tx, { mint, pool }) {
  const out = { curveLamports: 0, ammLamports: 0, trades: 0, creators: new Set() };
  if (!tx || tx.meta?.err) return out;
  const payloads = new Set();
  for (const l of tx.meta?.logMessages || []) if (l.startsWith('Program data: ')) payloads.add(Buffer.from(l.slice(14), 'base64').toString('hex'));
  const msg = tx.transaction?.message || {};
  const keys = [...(msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  if (bs58) for (const g of tx.meta?.innerInstructions || []) for (const ix of g.instructions || []) {
    const pid = ix.programId || keys[ix.programIdIndex]; if (pid !== PUMP.toBase58() && pid !== PAMM.toBase58()) continue;
    try { const d = Buffer.from(bs58.decode(ix.data)); if (d.subarray(0, 8).toString('hex') === EMIT_CPI) payloads.add(d.subarray(8).toString('hex')); } catch {}
  }
  const pk = (b, o) => new PublicKey(b.subarray(o, o + 32)).toBase58();
  for (const h of payloads) {
    const b = Buffer.from(h, 'hex'); const disc = h.slice(0, 16);
    if (disc === D_TRADE && b.length >= 225 && pk(b, 8) === mint) {
      out.curveLamports += Number(b.readBigUInt64LE(217)); out.trades++; out.creators.add(pk(b, 177));
    } else if ((disc === D_BUY || disc === D_SELL) && b.length >= 360 && pool && pk(b, 120) === pool) {
      out.ammLamports += Number(b.readBigUInt64LE(352)); out.trades++; out.creators.add(pk(b, 312));
    }
  }
  return out;
}

function vaults(dev) {
  const d = new PublicKey(dev);
  const curve = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), d.toBuffer()], PUMP)[0];
  const ammAuth = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), d.toBuffer()], PAMM)[0];
  const amm = PublicKey.findProgramAddressSync([ammAuth.toBuffer(), TOKEN.toBuffer(), WSOL.toBuffer()], ATA)[0];
  return { curve: curve.toBase58(), ammAuthority: ammAuth.toBase58(), amm: amm.toBase58() };
}
const memoFrom = (s) => { const m = MEMO_RE.exec(String(s || '')); return m ? m[1] : null; };

// Metaplex Core AssetV1: key u8, owner [32], update_authority enum (0 None | 1 Address[32] | 2 Collection[32]), name str, uri str
function parseCoreAsset(buf) {
  let o = 1 + 32; const ua = buf[o]; o += 1 + (ua === 0 ? 0 : 32);
  const str = () => { const n = buf.readUInt32LE(o); o += 4; const s = buf.slice(o, o + n).toString('utf8'); o += n; return s; };
  const name = str(); const uri = str();
  return { name: name.replace(/\0/g, '').trim(), uri: uri.replace(/\0/g, '').trim() };
}

// Lamport / WSOL changes of the creator vaults inside one parsed tx. Negative = paid out (a claim).
function vaultDeltas(tx, v) {
  const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const m = tx?.meta || {}; let curve = 0; let amm = 0;
  const i = keys.indexOf(v.curve); if (i >= 0) curve = ((m.postBalances?.[i] ?? 0) - (m.preBalances?.[i] ?? 0)) / 1e9;
  const j = keys.indexOf(v.amm);
  if (j >= 0) {
    const amt = (arr) => { const t = (arr || []).find((b) => b.accountIndex === j); return t ? Number(t.uiTokenAmount?.amount || 0) / 1e9 : 0; };
    amm = amt(m.postTokenBalances) - amt(m.preTokenBalances);
  }
  return { curve, amm };
}

function createRips(opts = {}) {
  const env = opts.env || process.env;
  const f = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  const log = opts.log || ((...a) => console.log('[rips]', ...a));
  const rpcUrl = env.RIPS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const CA = (env.RIPS_CA || '').trim(); const DEV = (env.RIPS_DEV_WALLET || '').trim();
  const configured = B58.test(CA) && B58.test(DEV);
  const V = B58.test(DEV) ? vaults(DEV) : null;
  const st = { startedAt: new Date(now()).toISOString(), lastRefreshAt: null, lastError: null, refreshes: 0, rpcCalls: 0,
    unclaimed: { curveSol: 0, ammSol: 0 }, claims: [], seenSigs: new Set(), retries: new Map(), lastTxError: null, newest: null, memos: new Map(), packs: new Map(), cards: new Map(),
    market: null, solUsd: null, shelf: null, shelfAt: 0, solAt: 0,
    coin: { createdAt: null, createdSig: null, listed: new Set(), queue: [], done: 0, curveLamports: 0, ammLamports: 0, trades: 0, creators: new Set(), newest: {}, backfilled: {}, lastError: null, rateLimited: 0 } };
  const C = B58.test(CA) ? coinAccounts(CA) : null;
  const devPaid = new Set(String(env.RIPS_DEV_PAID || '').split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/:(open|dev)$/, '')));
  for (const raw of String(env.RIPS_EXTRA || '').split(/[\s,]+/)) if (/:dev$/.test(raw)) devPaid.add(raw.replace(/:dev$/, '').replace(/:open$/, ''));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopped = false;
  let timer = null; let running = false;

  async function j(url, init) { const r = await f(url, { ...init, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`); return r.json(); }
  async function rpc(method, params) {
    st.rpcCalls++;
    const r = await j(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result;
  }
  const getRawTx = (sig) => rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  const getTx = (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);

  // List every signature of the coin's bonding curve and PumpSwap pool (cheap: 1 call per 1000 sigs), queue the new ones.
  async function listCoinSigs() {
    for (const [key, addr] of [['curve', C.bondingCurve], ['pool', C.pumpswapPool]]) {
      const fresh = []; let before;
      for (let page = 0; page < 500; page++) {
        const until = st.coin.newest[key];
        const list = await rpc('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}), ...(until ? { until } : {}), commitment: 'confirmed' }]);
        if (!list?.length) break;
        fresh.push(...list); before = list[list.length - 1].signature;
        if (list.length < 1000) break;
      }
      if (fresh.length) st.coin.newest[key] = fresh[0].signature;
      if (key === 'curve' && !st.coin.createdAt && fresh.length) {
        const first = fresh[fresh.length - 1]; st.coin.createdSig = first.signature;
        st.coin.createdAt = first.blockTime ? new Date(first.blockTime * 1000).toISOString() : null;
      }
      for (const s of fresh) { if (s.err || st.coin.listed.has(s.signature)) continue; st.coin.listed.add(s.signature); st.coin.queue.push(s.signature); }
    }
  }
  // Read queued txs one by one (gap between calls, backoff on 429) and add this coin's creator fees. Returns how many were read.
  async function drainFees(max = Infinity, gapMs = Number(env.RIPS_FEE_GAP_MS || 300)) {
    let n = 0;
    while (st.coin.queue.length && n < max && !stopped) {
      const sig = st.coin.queue[0];
      try {
        const tx = await getRawTx(sig);
        if (!tx) { st.coin.queue.push(st.coin.queue.shift()); n++; if (gapMs) await sleep(gapMs); continue; } // not yet available: retry later
        const r = tradeFees(tx, { mint: CA, pool: C.pumpswapPool });
        st.coin.curveLamports += r.curveLamports; st.coin.ammLamports += r.ammLamports; st.coin.trades += r.trades; r.creators.forEach((c) => st.coin.creators.add(c));
        st.coin.queue.shift(); st.coin.done++; n++; st.coin.backoff = 0;
      } catch (e) {
        st.coin.lastError = e.message;
        if (/429|Too many/i.test(e.message)) { st.coin.rateLimited++; st.coin.backoff = (st.coin.backoff || 0) + 1; await sleep(Math.min(60000, 1000 * 2 ** Math.min(6, st.coin.backoff))); }
        else { st.coin.queue.push(st.coin.queue.shift()); n++; }
      }
      if (gapMs) await sleep(gapMs);
    }
    return n;
  }
  async function feeLoop() {
    while (!stopped) {
      try { const n = await drainFees(200); if (!n) await sleep(15000); } catch { await sleep(15000); }
    }
  }

  let rent0 = null;
  async function readVaults() {
    if (rent0 == null) { try { rent0 = Number(await rpc('getMinimumBalanceForRentExemption', [0])) || RENT_0_DEFAULT; } catch { rent0 = RENT_0_DEFAULT; } }
    const [a, b] = await Promise.all([rpc('getBalance', [V.curve, { commitment: 'confirmed' }]), rpc('getAccountInfo', [V.amm, { encoding: 'jsonParsed', commitment: 'confirmed' }])]);
    st.unclaimed.curveSol = Math.max(0, ((a?.value ?? 0) - rent0) / 1e9);
    st.unclaimed.ammSol = Number(b?.value?.data?.parsed?.info?.tokenAmount?.amount || 0) / 1e9;
  }

  // Incremental scan of the dev wallet: pack purchases (memo "<slug>-<uuid>:open") and creator-fee claims (vault balance drops).
  async function scanDev() {
    if (!st.coin.createdAt) return; // need the coin's creation time first: the wallet is shared with older coins
    const since = Date.parse(st.coin.createdAt) / 1000;
    const fresh = []; let before;
    for (let page = 0; page < 10; page++) {
      const list = await rpc('getSignaturesForAddress', [DEV, { limit: 100, ...(before ? { before } : {}), ...(st.newest ? { until: st.newest } : {}) }]);
      if (!list?.length) break;
      fresh.push(...list); before = list[list.length - 1].signature;
      if (list.length < 100 || (list[list.length - 1].blockTime || 0) < since) break;
    }
    if (fresh.length) st.newest = fresh[0].signature;
    for (let i = fresh.length - 1; i >= 0; i--) if ((fresh[i].blockTime || 0) < since) fresh.splice(i, 1); // before this coin existed
    let fetched = 0;
    for (const s of fresh.reverse()) {
      if (st.seenSigs.has(s.signature)) continue; st.seenSigs.add(s.signature);
      if (s.err) continue;
      const memo = memoFrom(s.memo);
      if (memo && !st.memos.has(memo)) st.memos.set(memo, { memo, source: 'dev-wallet', purchaseSig: s.signature });
      if (memo || fetched >= 40) continue; // pack buys never claim; cap tx fetches per refresh (rest next time)
      fetched++;
      try {
        const tx = await getTx(s.signature); if (!tx) { st.seenSigs.delete(s.signature); continue; }
        const d = vaultDeltas(tx, V); const sol = -(Math.min(0, d.curve) + Math.min(0, d.amm));
        if (sol > 0) st.claims.push({ sig: s.signature, sol: +sol.toFixed(9), at: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, from: d.curve < 0 && d.amm < 0 ? 'curve+pumpswap' : d.curve < 0 ? 'bonding curve' : 'pumpswap' });
      } catch (e) { const n = (st.retries.get(s.signature) || 0) + 1; st.retries.set(s.signature, n); if (n < 5) st.seenSigs.delete(s.signature); st.lastTxError = e.message; }
    }
  }

  async function manualExtras() {
    for (const raw0 of String(env.RIPS_EXTRA || '').split(/[\s,]+/).filter(Boolean)) {
      const raw = raw0.replace(/:dev$/, '');
      let memo = memoFrom(raw.endsWith(':open') ? raw : raw + ':open');
      if (memo && st.memos.has(memo)) continue;
      if (!memo && SIG.test(raw)) {
        if ([...st.memos.values()].some((m) => m.purchaseSig === raw)) continue;
        const tx = await getTx(raw); memo = memoFrom(JSON.stringify(tx?.meta?.logMessages || []));
        if (memo && !st.memos.has(memo)) st.memos.set(memo, { memo, source: 'manual', purchaseSig: raw });
      } else if (memo) st.memos.set(memo, { memo, source: 'manual', purchaseSig: null });
    }
  }

  async function card(nft) {
    if (st.cards.has(nft)) return st.cards.get(nft);
    let c = { name: null, image: null, uri: null, link: `https://collectorcrypt.com/assets/solana/${nft}` };
    try {
      const a = await rpc('getAccountInfo', [nft, { encoding: 'base64' }]);
      if (a?.value?.owner === CORE) {
        const p = parseCoreAsset(Buffer.from(a.value.data[0], 'base64')); c = { ...c, name: p.name, uri: p.uri };
        if (p.uri) { try { const m = await j(p.uri); c.name = m.name || c.name; c.image = m.image || m.properties?.files?.[0]?.uri || null; c.attributes = (m.attributes || []).filter((x) => ['Category', 'Grading Company', 'The Grade', 'Grade', 'Year', 'Insured Value'].includes(x.trait_type)); } catch {} }
      }
      st.cards.set(nft, c);
    } catch {}
    return c;
  }

  async function resolvePacks() {
    for (const m of st.memos.values()) {
      const prev = st.packs.get(m.memo);
      if (prev && prev.final) continue;
      const s = await j(`${GACHA}/api/pack/status?memo=${encodeURIComponent(m.memo)}`);
      const delivered = s.send && (s.send.status === 'confirmed' || s.send.webhook_sent || s.send.transaction_signature === 'turbomode');
      const fromDev = s.pack?.wallet === DEV;
      const p = { memo: m.memo, source: m.source, verified: !!(s.pack && fromDev && s.pack.status === 'confirmed'), buyer: s.pack?.wallet || null,
        packType: s.pack?.pack_type || null, purchaseSig: s.pack?.transaction_signature || m.purchaseSig, boughtAt: s.pack?.created_at || null,
        paidWith: s.pack?.token_mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : s.pack?.token_mint || null,
        refunded: !!s.pack?.refunded, nft: s.send?.nft_address || null, sendSig: s.send?.transaction_signature || null,
        recipient: s.send?.to_wallet || null, insuredValueUsd: s.send?.insured_value ?? null, rarity: TIER[s.send?.prize_tier] || null,
        vrfProof: s.send?.vrf_proof ? true : false, soldBack: (s.buyback || []).some((b) => b.status === 'confirmed' || b.webhook_confirmed),
        delivered: !!delivered };
      p.paidBy = devPaid.has(m.memo) || (p.purchaseSig && devPaid.has(p.purchaseSig)) ? 'dev' : 'fees';
      p.final = p.delivered && !!p.nft && (now() - Date.parse(p.boughtAt || 0) > 73 * 3600e3); // re-check buybacks for 72h
      if (p.nft) p.card = await card(p.nft);
      st.packs.set(m.memo, p);
    }
  }

  async function market() {
    try { const a = await j(`https://api.dexscreener.com/tokens/v1/solana/${CA}`); const p = (Array.isArray(a) ? a : []).sort((x, y) => (y.volume?.h24 || 0) - (x.volume?.h24 || 0))[0];
      st.market = p ? { dex: p.dexId, url: p.url, priceUsd: Number(p.priceUsd) || null, mcapUsd: p.marketCap || p.fdv || null, vol24hUsd: p.volume?.h24 ?? null, name: p.baseToken?.name, symbol: p.baseToken?.symbol, image: p.info?.imageUrl || null } : null;
    } catch (e) { st.market = st.market || null; }
  }
  async function solPrice() {
    if (st.solUsd && now() - st.solAt < 300e3) return;
    try { const r = await j('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); if (r?.solana?.usd > 1) { st.solUsd = r.solana.usd; st.solAt = now(); } } catch {}
  }
  async function shelf() {
    if (st.shelf && now() - st.shelfAt < 900e3) return;
    try {
      const r = await j(`${GACHA}/api/machines`);
      st.shelf = (r.machines || []).filter((m) => m.public && m.price > 0).sort((a, b) => a.price - b.price).slice(0, 8)
        .map((m) => ({ code: m.code, name: m.name, category: m.menuCategory, priceUsd: m.price, instantBuybackPct: m.instantBuyback, evUsd: m.ev == null ? null : +m.ev.toFixed(2), odds: m.odds,
          volumeNeededUsd: Math.round(m.price / (CREATOR_FEE_PCT / 100)) }));
      st.shelfAt = now();
    } catch {}
  }

  async function refresh() {
    if (running) return; running = true;
    try {
      await Promise.all([shelf(), solPrice()]);
      const errs = [];
      if (configured) for (const step of [listCoinSigs, readVaults, scanDev, manualExtras, resolvePacks, market]) { try { await step(); } catch (e) { errs.push(`${step.name}: ${e.message}`); } }
      st.lastRefreshAt = new Date(now()).toISOString(); st.lastError = errs.length ? errs.join(' | ') : null; st.refreshes++;
      if (errs.length) log('refresh errors', st.lastError);
    } catch (e) { st.lastError = e.message; log('refresh error', e.message); }
    finally { running = false; }
  }

  function status() {
    const packs = [...st.packs.values()].sort((a, b) => Date.parse(b.boughtAt || 0) - Date.parse(a.boughtAt || 0));
    const ok = packs.filter((p) => p.verified);
    const claimedSol = st.claims.reduce((s, c) => s + c.sol, 0);
    const unclaimedSol = st.unclaimed.curveSol + st.unclaimed.ammSol;
    const priceOf = (t) => (st.shelf || []).find((m) => m.code === t)?.priceUsd ?? (Number(String(t || '').match(/_(\d+)$/)?.[1]) || null);
    const usd = (sol) => (st.solUsd ? +(sol * st.solUsd).toFixed(2) : null);
    const c = st.coin; const coinSol = (c.curveLamports + c.ammLamports) / 1e9;
    const spent = (arr) => arr.reduce((s, p) => s + (priceOf(p.packType) || 0), 0);
    const fromFees = spent(ok.filter((p) => p.paidBy !== 'dev')); const byDev = spent(ok.filter((p) => p.paidBy === 'dev'));
    const feesUsd = usd(coinSol);
    return {
      state: configured ? 'live' : 'launching_soon',
      statement: 'Creator fees open packs live. The dev keeps the cards. Not financial advice.',
      coin: { ca: configured ? CA : null, devWallet: configured ? DEV : null, ticker: env.RIPS_TICKER || null, name: env.RIPS_NAME || null, x: env.RIPS_X_URL || null,
        pumpUrl: configured ? `https://pump.fun/coin/${CA}` : null, creatorVaults: configured ? V : null, accounts: configured ? C : null,
        createdAt: c.createdAt, createdSig: c.createdSig, market: st.market },
      fees: {
        creatorFeePct: CREATOR_FEE_PCT,
        note: 'pump.fun bonding curve: 0.30% of every trade to the creator. After graduation PumpSwap pays 0.30% below 420 SOL market cap, then a tier table (0.95% at 420-1470 SOL, stepping down as it grows).',
        thisCoin: { scope: 'this coin only', earnedSol: +coinSol.toFixed(9), earnedUsd: feesUsd, curveSol: +(c.curveLamports / 1e9).toFixed(9), pumpswapSol: +(c.ammLamports / 1e9).toFixed(9),
          tradesCounted: c.trades, txRead: c.done, txPending: c.queue.length, complete: configured && !!c.createdAt && c.queue.length === 0,
          method: 'Exact: sum of creator_fee in every pump.fun TradeEvent and coin_creator_fee in every PumpSwap Buy/SellEvent for this coin, read from each transaction on the public Solana RPC. USD at the current SOL price.',
          creatorsSeen: [...c.creators], lastError: c.lastError },
        wallet: { scope: 'all coins from this dev wallet', note: 'pump.fun keeps one creator vault per wallet, shared by every coin this wallet created, so these numbers include other coins.',
          unclaimedSol: +unclaimedSol.toFixed(6), unclaimedCurveSol: +st.unclaimed.curveSol.toFixed(6), unclaimedPumpswapSol: +st.unclaimed.ammSol.toFixed(6),
          claimedSinceLaunchSol: +claimedSol.toFixed(6), claims: [...st.claims].reverse() },
      },
      packs: { opened: ok.length, spentUsd: spent(ok), paidFromFeesUsd: fromFees, paidByDevUsd: byDev, insuredValueUsd: ok.reduce((s, p) => s + (p.insuredValueUsd || 0), 0),
        check: { packsFromFeesUsd: fromFees, thisCoinFeesUsd: feesUsd, ok: feesUsd == null ? null : fromFees <= feesUsd + 0.01, rule: 'Packs paid from fees should never exceed this coin\'s creator fees. Packs paid by the dev are listed but not charged to fees.' },
        list: packs.map(({ final, ...p }) => ({ ...p, priceUsd: priceOf(p.packType) })) },
      shelf: st.shelf, solUsd: st.solUsd,
      meta: { startedAt: st.startedAt, lastRefreshAt: st.lastRefreshAt, lastError: st.lastError, lastTxError: st.lastTxError, refreshes: st.refreshes, rpcCalls: st.rpcCalls, rateLimited: c.rateLimited, sources: ['public Solana RPC', 'gacha.collectorcrypt.com', 'DexScreener', 'CoinGecko'], now: new Date(now()).toISOString() },
    };
  }

  return {
    refresh, status, configured, drainFees,
    start() { refresh(); timer = setInterval(refresh, Number(env.RIPS_REFRESH_MS || 180000)); timer.unref?.(); if (configured) feeLoop(); },
    stop() { stopped = true; clearInterval(timer); },
  };
}
module.exports = { createRips, vaults, coinAccounts, tradeFees, memoFrom, parseCoreAsset, vaultDeltas, CREATOR_FEE_PCT };
