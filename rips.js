// Fee Rips tracker: creator fees (read on-chain) -> Collector Crypt card packs opened by the dev wallet, shown live on /rips.
// Free sources only: public Solana RPC (no Helius), Collector Crypt public gacha API, DexScreener, CoinGecko.
// Env: RIPS_CA (coin mint), RIPS_DEV_WALLET (creator wallet), RIPS_EXTRA (comma list of pack memos or purchase tx signatures,
// manual fallback), RIPS_RPC_URL (default public mainnet RPC), RIPS_REFRESH_MS (default 180000), RIPS_TICKER, RIPS_NAME, RIPS_X_URL.
const { PublicKey } = require('@solana/web3.js');

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
    market: null, solUsd: null, shelf: null, shelfAt: 0, solAt: 0 };
  let timer = null; let running = false;

  async function j(url, init) { const r = await f(url, { ...init, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`); return r.json(); }
  async function rpc(method, params) {
    st.rpcCalls++;
    const r = await j(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result;
  }
  const getTx = (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);

  let rent0 = null;
  async function readVaults() {
    if (rent0 == null) { try { rent0 = Number(await rpc('getMinimumBalanceForRentExemption', [0])) || RENT_0_DEFAULT; } catch { rent0 = RENT_0_DEFAULT; } }
    const [a, b] = await Promise.all([rpc('getBalance', [V.curve, { commitment: 'confirmed' }]), rpc('getAccountInfo', [V.amm, { encoding: 'jsonParsed', commitment: 'confirmed' }])]);
    st.unclaimed.curveSol = Math.max(0, ((a?.value ?? 0) - rent0) / 1e9);
    st.unclaimed.ammSol = Number(b?.value?.data?.parsed?.info?.tokenAmount?.amount || 0) / 1e9;
  }

  // Incremental scan of the dev wallet: pack purchases (memo "<slug>-<uuid>:open") and creator-fee claims (vault balance drops).
  async function scanDev() {
    const fresh = []; let before;
    for (let page = 0; page < 10; page++) {
      const list = await rpc('getSignaturesForAddress', [DEV, { limit: 100, ...(before ? { before } : {}), ...(st.newest ? { until: st.newest } : {}) }]);
      if (!list?.length) break;
      fresh.push(...list); before = list[list.length - 1].signature;
      if (list.length < 100) break;
    }
    if (fresh.length) st.newest = fresh[0].signature;
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
    for (const raw of String(env.RIPS_EXTRA || '').split(/[\s,]+/).filter(Boolean)) {
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
      if (configured) for (const step of [readVaults, scanDev, manualExtras, resolvePacks, market]) { try { await step(); } catch (e) { errs.push(`${step.name}: ${e.message}`); } }
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
    return {
      state: configured ? 'live' : 'launching_soon',
      statement: 'Creator fees open packs live. The dev keeps the cards. Not financial advice.',
      coin: { ca: configured ? CA : null, devWallet: configured ? DEV : null, ticker: env.RIPS_TICKER || null, name: env.RIPS_NAME || null, x: env.RIPS_X_URL || null,
        pumpUrl: configured ? `https://pump.fun/coin/${CA}` : null, creatorVaults: configured ? V : null, market: st.market },
      fees: { creatorFeePct: CREATOR_FEE_PCT, vaultScope: 'pump.fun creator vaults are per creator wallet, not per coin: use a fresh dev wallet for this coin so the numbers are this coin only.', note: 'pump.fun bonding curve: 0.30% of every trade to the creator. After graduation PumpSwap pays 0.30% below 420 SOL market cap, then a tier table (0.95% at 420-1470 SOL, stepping down as it grows).',
        unclaimedSol: +unclaimedSol.toFixed(6), unclaimedCurveSol: +st.unclaimed.curveSol.toFixed(6), unclaimedPumpswapSol: +st.unclaimed.ammSol.toFixed(6),
        claimedSol: +claimedSol.toFixed(6), earnedSol: +(claimedSol + unclaimedSol).toFixed(6), earnedUsd: usd(claimedSol + unclaimedSol), claims: [...st.claims].reverse() },
      packs: { opened: ok.length, spentUsd: ok.reduce((s, p) => s + (priceOf(p.packType) || 0), 0), insuredValueUsd: ok.reduce((s, p) => s + (p.insuredValueUsd || 0), 0),
        list: packs.map(({ final, ...p }) => ({ ...p, priceUsd: priceOf(p.packType) })) },
      shelf: st.shelf, solUsd: st.solUsd,
      meta: { startedAt: st.startedAt, lastRefreshAt: st.lastRefreshAt, lastError: st.lastError, lastTxError: st.lastTxError, refreshes: st.refreshes, rpcCalls: st.rpcCalls, sources: ['public Solana RPC', 'gacha.collectorcrypt.com', 'DexScreener', 'CoinGecko'], now: new Date(now()).toISOString() },
    };
  }

  return {
    refresh, status, configured,
    start() { refresh(); timer = setInterval(refresh, Number(env.RIPS_REFRESH_MS || 180000)); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
module.exports = { createRips, vaults, memoFrom, parseCoreAsset, vaultDeltas, CREATOR_FEE_PCT };
