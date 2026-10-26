// Bundle Sniffer analyzer — read-only. Never signs or sends transactions.
const { PublicKey } = require('@solana/web3.js');

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const SYSTEM = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const KNOWN_PROGRAMS = {
  [PUMP_PROGRAM.toBase58()]: 'pump.fun bonding curve',
  [PUMP_AMM]: 'PumpSwap pool',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora DAMM v2',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
};
const DEFAULT_INITIAL_REAL_TOKENS = 793_100_000n * 10n ** 6n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpcCalls = 0;
// Helius credit accounting (1 per call, 10 for getProgramAccounts), per UTC day.
const credits = { day: new Date().toISOString().slice(0, 10), today: 0, total: 0, byTag: {} };
let creditTag = 'other';
function setCreditTag(t) { const prev = creditTag; creditTag = t; return prev; }
function creditStats() { const d = new Date().toISOString().slice(0, 10); if (d !== credits.day) { credits.day = d; credits.today = 0; credits.byTag = {}; credits.restored = 0; } return credits; }
// Restarts (every deploy) used to reset the per-day counter, so the daily credit cap never held. Add back today's
// pre-restart spend from a persisted snapshot (same UTC day only).
function restoreCredits(snap) {
  const c = creditStats();
  if (!snap || snap.day !== c.day || !(snap.today > 0) || c.restored) return 0;
  c.today += snap.today; c.restored = snap.today;
  for (const [k, v] of Object.entries(snap.byTag || {})) c.byTag[k] = (c.byTag[k] || 0) + (Number(v) || 0);
  return snap.today;
}
function creditSnapshot() { const c = creditStats(); return { day: c.day, today: c.today, byTag: { ...c.byTag } }; }

// --- RPC with rate-limit handling (429 / -32429 / network errors -> exponential backoff)
let lastCall = 0;
const MIN_GAP_MS = Number(process.env.RPC_MIN_GAP_MS || 120);
async function rpc(method, params, tries = 7) {
  let delay = 600;
  for (let i = 0; i < tries; i++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    rpcCalls++;
    { const c = creditStats(); const n = method === 'getProgramAccounts' ? 10 : 1; c.today += n; c.total += n; c.byTag[creditTag] = (c.byTag[creditTag] || 0) + n; }
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error('HTTP ' + res.status), { retry: true });
      const j = await res.json();
      if (j.error) {
        if (j.error.code === 429 || j.error.code === -32429 || /rate|too many/i.test(j.error.message)) throw Object.assign(new Error(j.error.message), { retry: true });
        throw new Error(`${method}: ${j.error.message}`);
      }
      return j.result;
    } catch (e) {
      if (!(e.retry || e.name === 'TimeoutError' || e.name === 'TypeError') || i === tries - 1) throw e;
      await sleep(delay + Math.random() * 300);
      delay = Math.min(delay * 2, 10000);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const u64 = (buf, off) => buf.readBigUInt64LE(off);
const fmt = (raw, dec) => Number(raw) / 10 ** dec;

function parseBondingCurve(data) {
  let o = 8;
  const bc = {};
  bc.virtualTokenReserves = u64(data, o); o += 8;
  bc.virtualQuoteReserves = u64(data, o); o += 8;
  bc.realTokenReserves = u64(data, o); o += 8;
  bc.realQuoteReserves = u64(data, o); o += 8;
  bc.tokenTotalSupply = u64(data, o); o += 8;
  bc.complete = data[o] === 1; o += 1;
  if (data.length >= o + 32) { bc.creator = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32; }
  if (data.length >= o + 2) { bc.isMayhemMode = data[o] === 1; bc.isCashbackCoin = data[o + 1] === 1; o += 2; }
  if (data.length >= o + 32) {
    const q = new PublicKey(data.subarray(o, o + 32)).toBase58();
    bc.quoteMint = q === SYSTEM ? WSOL : q;
  }
  return bc;
}

async function getGlobalInitialReal() {
  try {
    const [g] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
    const r = await rpc('getAccountInfo', [g.toBase58(), { encoding: 'base64' }]);
    const d = Buffer.from(r.value.data[0], 'base64');
    const v = u64(d, 8 + 1 + 32 + 32 + 16); // initial_real_token_reserves
    return v > 0n ? v : DEFAULT_INITIAL_REAL_TOKENS;
  } catch { return DEFAULT_INITIAL_REAL_TOKENS; }
}

async function getMetadata(mint, mintParsed) {
  // Token-2022 metadata extension
  const ext = mintParsed?.extensions?.find((e) => e.extension === 'tokenMetadata');
  if (ext) return { name: ext.state.name, symbol: ext.state.symbol, uri: ext.state.uri };
  try {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX);
    const r = await rpc('getAccountInfo', [pda.toBase58(), { encoding: 'base64' }]);
    if (!r.value) return {};
    const d = Buffer.from(r.value.data[0], 'base64');
    let o = 1 + 32 + 32;
    const rd = () => { const l = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + l).toString('utf8').replace(/\0/g, '').trim(); o += l; return s; };
    return { name: rd(), symbol: rd(), uri: rd() };
  } catch { return {}; }
}

async function getDexScreener(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const pairs = await r.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return { dexId: p.dexId, pairAddress: p.pairAddress, url: p.url, priceUsd: p.priceUsd ? Number(p.priceUsd) : null, marketCapUsd: p.marketCap ?? p.fdv ?? null, liquidityUsd: p.liquidity?.usd ?? null, pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null, name: p.baseToken?.name, symbol: p.baseToken?.symbol, pairs: pairs.length };
  } catch { return null; }
}

// Oldest signatures for an address (walks back up to maxPages*1000 txs).
async function getOldestSignatures(address, maxPages) {
  let before; let last = []; let pages = 0; let total = 0;
  while (pages < maxPages) {
    const page = await rpc('getSignaturesForAddress', [address, { limit: 1000, before }]);
    pages++;
    if (!page.length) break;
    total += page.length;
    last = page.length < 1000 ? last.concat(page) : page; // keep tail
    if (page.length < 1000) return { sigs: last, complete: true, total, pages };
    before = page[page.length - 1].signature;
    last = page;
  }
  return { sigs: last, complete: false, total, pages };
}

async function getTx(sig) {
  return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
}

// Net token delta per owner for `mint` in a tx.
function ownerDeltas(tx, mint) {
  const m = new Map();
  const add = (list, sign) => (list || []).filter((b) => b.mint === mint).forEach((b) => {
    const k = b.owner; m.set(k, (m.get(k) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
  });
  add(tx.meta?.preTokenBalances, -1n);
  add(tx.meta?.postTokenBalances, 1n);
  return m;
}
const signers = (tx) => tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);

async function analyze(mintStr, opts = {}) {
  const t0 = Date.now(); rpcCalls = 0;
  const maxPages = opts.maxPages ?? Number(process.env.MAX_SIG_PAGES || 12);
  const notes = [];
  let mintPk;
  try { mintPk = new PublicKey(mintStr.trim()); } catch { throw new Error('Mint inválido / invalid mint address'); }
  const mint = mintPk.toBase58();

  const mintInfo = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  if (!mintInfo.value || mintInfo.value.data?.parsed?.type !== 'mint') throw new Error('No es un mint SPL / not an SPL token mint');
  const tokenProgram = mintInfo.value.owner;
  const mp = mintInfo.value.data.parsed.info;
  const decimals = mp.decimals;
  const supplyRaw = BigInt(mp.supply);

  const [bcPda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintPk.toBuffer()], PUMP_PROGRAM);
  const bondingCurve = bcPda.toBase58();

  const [meta, dex, bcAcc, initialReal] = await Promise.all([
    getMetadata(mint, mp), getDexScreener(mint),
    rpc('getAccountInfo', [bondingCurve, { encoding: 'base64' }]), getGlobalInitialReal(),
  ]);

  const report = {
    mint, name: meta.name || dex?.name || null, symbol: meta.symbol || dex?.symbol || null, uri: meta.uri || null,
    tokenProgram: tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'Token-2022' : 'SPL Token',
    decimals, supply: fmt(supplyRaw, decimals), isPumpFun: false, bondingCurve, dex,
  };

  // ---- Bonding curve
  if (bcAcc.value && bcAcc.value.owner === PUMP_PROGRAM.toBase58()) {
    report.isPumpFun = true;
    const bc = parseBondingCurve(Buffer.from(bcAcc.value.data[0], 'base64'));
    const quoteIsSol = !bc.quoteMint || bc.quoteMint === WSOL;
    let qDec = 9, quoteLabel = 'SOL';
    if (!quoteIsSol) {
      const qi = await rpc('getAccountInfo', [bc.quoteMint, { encoding: 'jsonParsed' }]).catch(() => null);
      qDec = qi?.value?.data?.parsed?.info?.decimals ?? 6;
      const qm = await getMetadata(bc.quoteMint, qi?.value?.data?.parsed?.info);
      quoteLabel = qm.symbol || bc.quoteMint.slice(0, 6) + '…';
      notes.push(`Esta curva no cotiza en SOL sino en ${quoteLabel} (${bc.quoteMint}); el umbral de ~85 SOL no aplica. / This curve is quoted in ${quoteLabel}, not SOL.`);
    }
    const initReal = bc.realTokenReserves > initialReal ? bc.realTokenReserves : initialReal;
    const sold = initReal - bc.realTokenReserves;
    let quoteRemaining = 0n;
    if (!bc.complete && bc.realTokenReserves > 0n) {
      const k = bc.virtualTokenReserves * bc.virtualQuoteReserves;
      const vTend = bc.virtualTokenReserves - bc.realTokenReserves;
      quoteRemaining = k / vTend - bc.virtualQuoteReserves;
    }
    const priceQuote = Number(bc.virtualQuoteReserves) / 10 ** qDec / (Number(bc.virtualTokenReserves) / 10 ** decimals);
    report.curve = {
      complete: bc.complete,
      progressPct: bc.complete ? 100 : Math.round((Number(sold) / Number(initReal)) * 10000) / 100,
      quote: quoteLabel, quoteMint: quoteIsSol ? WSOL : bc.quoteMint,
      realQuoteInCurve: fmt(bc.realQuoteReserves, qDec),
      quoteRemainingToGraduate: bc.complete ? 0 : fmt(quoteRemaining, qDec),
      curveMarketCapQuote: bc.complete ? null : priceQuote * report.supply,
      creatorOnCurve: bc.creator || null,
      mayhemMode: !!bc.isMayhemMode,
    };
    report.graduated = bc.complete;
  } else {
    notes.push('No se encontró cuenta de bonding curve de pump.fun / no pump.fun bonding curve account found (not a pump.fun token, or closed).');
    report.graduated = null;
  }
  if (dex && ['pumpswap', 'raydium', 'meteora', 'orca'].some((d) => (dex.dexId || '').includes(d))) {
    report.graduated = report.graduated ?? true;
  }

  // ---- Creation tx (cheap paths first: metadata PDA history, dev ATA history, then mint history)
  const isCreateTx = (tx) => !!tx && (tx.meta?.logMessages || []).some((l) => /Instruction: Create(V2)?$/.test(l)) &&
    tx.transaction.message.accountKeys.some((k) => k.pubkey === mint);
  // Oldest few SUCCESSFUL sigs, oldest first: failed sniper txs in the creation slot can sort before the create tx (seen on Token-2022 coins)
  const oldestOk = (h) => (h.complete ? h.sigs.filter((x) => !x.err).slice(-6).reverse() : []);
  const oldestOf = async (addr, pages = 1) => oldestOk(await getOldestSignatures(addr, pages));
  let createSig = null, createTx = null;
  const candidates = [];
  if (report.tokenProgram === 'SPL Token') candidates.push(async () => oldestOf(PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mintPk.toBuffer()], METAPLEX)[0].toBase58(), 2));
  if (report.curve?.creatorOnCurve) candidates.push(async () => {
    const [ata] = PublicKey.findProgramAddressSync([new PublicKey(report.curve.creatorOnCurve).toBuffer(), new PublicKey(tokenProgram).toBuffer(), mintPk.toBuffer()], ATA_PROGRAM);
    return oldestOf(ata.toBase58(), 2);
  });
  candidates.push(async () => { const h = await getOldestSignatures(mint, maxPages); report.history = { txScanned: h.total, reachedCreation: h.complete }; return oldestOk(h); });
  for (const c of candidates) {
    try {
      for (const sig of await c()) {
        const tx = await getTx(sig.signature);
        if (isCreateTx(tx)) { createSig = sig; createTx = tx; break; }
      }
      if (createTx) break;
    } catch (e) { notes.push('creation lookup: ' + e.message); }
  }
  let creation = null;
  if (createTx) {
    const dev = createTx.transaction.message.accountKeys[0].pubkey;
    const slot = createTx.slot;
    creation = { signature: createSig.signature, slot, time: createTx.blockTime ? new Date(createTx.blockTime * 1000).toISOString() : null, dev };
    const devInitial = ownerDeltas(createTx, mint).get(dev) || 0n;
    creation.devInitialBuy = fmt(devInitial > 0n ? devInitial : 0n, decimals);
    creation.devInitialBuyPct = Math.round((Number(devInitial > 0n ? devInitial : 0n) / Number(supplyRaw)) * 10000) / 100;

    // ---- Same-block buyers: read the creation block and the next 2 slots
    const buyers = new Map(); const blocksRead = []; let createIndex = null; const multiTx = []; const consecutive = new Set();
    for (let off = 0; off <= 2; off++) {
      let blk;
      try { blk = await rpc('getBlock', [slot + off, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, transactionDetails: 'full', rewards: false }]); }
      catch (e) { if (/skipped|not available|-3200[479]/i.test(e.message)) { blocksRead.push({ slot: slot + off, skipped: true }); continue; } notes.push(`getBlock ${slot + off}: ${e.message}`); continue; }
      blocksRead.push({ slot: slot + off, txs: blk.transactions.length });
      const buyIdx = new Set();
      blk.transactions.forEach((tx, idx) => {
        if (tx.meta?.err) return;
        if (tx.transaction.signatures[0] === createSig.signature) { createIndex = idx; return; }
        const deltas = ownerDeltas(tx, mint);
        const txBuyers = [...deltas].filter(([owner, d]) => d > 0n && owner !== bondingCurve && owner !== dev);
        if (deltas.size) buyIdx.add(idx);
        if (txBuyers.length >= 2) multiTx.push({ signature: tx.transaction.signatures[0], wallets: txBuyers.length, slotOffset: off });
        for (const [owner, d] of txBuyers) {
          const bb = buyers.get(owner) || { wallet: owner, raw: 0n, slotOffset: off, sig: tx.transaction.signatures[0], feePayer: tx.transaction.message.accountKeys[0].pubkey, idx, multi: txBuyers.length >= 2 };
          bb.raw += d; buyers.set(owner, bb);
        }
      });
      if (off === 0 && createIndex != null) { let i = createIndex + 1; while (buyIdx.has(i)) { consecutive.add(i); i++; } }
    }
    const list = [...buyers.values()].map((bb) => ({ wallet: bb.wallet, tokens: fmt(bb.raw, decimals), pctSupply: Math.round((Number(bb.raw) / Number(supplyRaw)) * 10000) / 100, slotOffset: bb.slotOffset, signature: bb.sig, paidByDev: bb.feePayer === dev, multiWalletTx: bb.multi, rightAfterCreate: bb.slotOffset === 0 && consecutive.has(bb.idx) }));
    list.sort((x, y) => y.tokens - x.tokens);
    const same = list.filter((x) => x.slotOffset === 0);
    const early = list.filter((x) => x.slotOffset > 0);
    report.bundle = {
      creationSlot: slot, blocksRead,
      sameSlotBuyers: same, sameSlotWallets: same.length,
      sameSlotPctSupply: Math.round(same.reduce((t, x) => t + x.pctSupply, 0) * 100) / 100,
      sameSlotPaidByDev: same.filter((x) => x.paidByDev).length,
      createTxIndex: createIndex,
      rightAfterCreateWallets: same.filter((x) => x.rightAfterCreate).length,
      rightAfterCreatePct: Math.round(same.filter((x) => x.rightAfterCreate).reduce((t, x) => t + x.pctSupply, 0) * 100) / 100,
      multiWalletTxs: multiTx.length, multiWalletTxList: multiTx.slice(0, 10),
      next2SlotBuyers: early.length,
      next2SlotPctSupply: Math.round(early.reduce((t, x) => t + x.pctSupply, 0) * 100) / 100,
    };
    if (list.length) {
      const subset = list.slice(0, 20);
      const holds = await mapLimit(subset, 2, async (x) => {
        const r = await rpc('getTokenAccountsByOwner', [x.wallet, { mint }, { encoding: 'jsonParsed' }]).catch(() => null);
        return r ? r.value.reduce((t, acc) => t + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n) : null;
      });
      let still = 0n, stillSame = 0n; subset.forEach((x, i) => { x.stillHolds = holds[i] == null ? null : fmt(holds[i], decimals); if (holds[i]) { still += holds[i]; if (x.slotOffset === 0) stillSame += holds[i]; } });
      report.bundle.sameSlotStillHoldPct = Math.round((Number(stillSame) / Number(supplyRaw)) * 10000) / 100;
      report.bundle.earlyStillHoldPct = Math.round((Number(still) / Number(supplyRaw)) * 10000) / 100;
      report.bundle.next2SlotList = early.slice(0, 10);
    }
  } else {
    notes.push('No se pudo localizar la tx de creación con el RPC público; el chequeo de bundle no está disponible. Usa un RPC propio (RPC_URL). / Creation tx not found; bundle check unavailable.');
  }
  report.creation = creation;

  // ---- Dev wallet trades (via dev's associated token account history)
  const devWallet = creation?.dev || report.curve?.creatorOnCurve;
  if (devWallet) {
    const [ata] = PublicKey.findProgramAddressSync([new PublicKey(devWallet).toBuffer(), new PublicKey(tokenProgram).toBuffer(), mintPk.toBuffer()], ATA_PROGRAM);
    const sigs = await rpc('getSignaturesForAddress', [ata.toBase58(), { limit: 200 }]);
    const ok = sigs.filter((s) => !s.err).slice(0, 60);
    const txs = await mapLimit(ok, 3, (s) => getTx(s.signature).catch(() => null));
    let bought = 0n, sold = 0n, buys = 0, sells = 0;
    txs.forEach((tx) => {
      if (!tx) return;
      const d = ownerDeltas(tx, mint).get(devWallet) || 0n;
      if (d > 0n) { bought += d; buys++; } else if (d < 0n) { sold += -d; sells++; }
    });
    const cur = await rpc('getTokenAccountsByOwner', [devWallet, { mint }, { encoding: 'jsonParsed' }]);
    const holding = cur.value.reduce((a, acc) => a + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n);
    report.dev = {
      wallet: devWallet, creatorOnCurve: report.curve?.creatorOnCurve || null,
      bought: fmt(bought, decimals), sold: fmt(sold, decimals), buys, sells,
      soldPctOfBought: bought > 0n ? Math.round((Number(sold) / Number(bought)) * 1000) / 10 : null,
      holding: fmt(holding, decimals), holdingPctSupply: Math.round((Number(holding) / Number(supplyRaw)) * 10000) / 100,
      hasSold: sold > 0n, txChecked: ok.length, partial: sigs.length >= 200 || sigs.filter((s) => !s.err).length > 60,
    };
  }

  // ---- Top holders (excluding curve, pools and other program-owned accounts)
  let accs = [], owners = [], holderCount = null;
  try {
    const filters = [{ memcmp: { offset: 0, bytes: mint } }];
    if (report.tokenProgram === 'SPL Token') filters.push({ dataSize: 165 });
    const all = await rpc('getProgramAccounts', [tokenProgram, { encoding: 'base64', dataSlice: { offset: 32, length: 40 }, filters }], 4);
    const rows = all.map((a) => { const d = Buffer.from(a.account.data[0], 'base64'); return { address: a.pubkey, owner: new PublicKey(d.subarray(0, 32)).toBase58(), amount: d.readBigUInt64LE(32) }; }).filter((r) => r.amount > 0n);
    holderCount = new Set(rows.map((r) => r.owner)).size;
    rows.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    accs = rows.slice(0, 25).map((r) => ({ address: r.address, amount: r.amount.toString() }));
    owners = rows.slice(0, 25).map((r) => r.owner);
  } catch (e) {
    notes.push('getProgramAccounts no disponible, uso getTokenLargestAccounts / fallback to getTokenLargestAccounts: ' + e.message);
    const largest = await rpc('getTokenLargestAccounts', [mint]);
    accs = largest.value.filter((a) => a.amount !== '0');
    const parsed = await rpc('getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed' }]);
    owners = parsed.value.map((v) => v?.data?.parsed?.info?.owner || null);
  }
  const uniqOwners = [...new Set(owners.filter(Boolean))];
  const ownerInfo = await rpc('getMultipleAccounts', [uniqOwners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  const ownerProg = new Map(uniqOwners.map((o, i) => [o, ownerInfo.value[i]?.owner || null]));
  const holders = [];
  const excluded = [];
  accs.forEach((a, i) => {
    const owner = owners[i]; const prog = ownerProg.get(owner);
    const pct = Math.round((Number(a.amount) / Number(supplyRaw)) * 10000) / 100;
    if (owner === bondingCurve) excluded.push({ owner, label: 'pump.fun bonding curve', pct });
    else if (prog && prog !== SYSTEM) excluded.push({ owner, label: KNOWN_PROGRAMS[prog] || `program-owned (${prog.slice(0, 6)}…)`, pct });
    else holders.push({ wallet: owner, tokenAccount: a.address, pct, isDev: owner === devWallet, isSameSlotBuyer: !!report.bundle?.sameSlotBuyers.some((b) => b.wallet === owner) });
  });
  const merged = new Map();
  holders.forEach((h) => { const m = merged.get(h.wallet); if (m) m.pct += h.pct; else merged.set(h.wallet, { ...h }); });
  const top = [...merged.values()].sort((a, b) => b.pct - a.pct).slice(0, 10);
  report.holders = { holderCount, top10: top, top10Pct: Math.round(top.reduce((a, h) => a + h.pct, 0) * 100) / 100, excluded };

  report.risk = scoreRisk(report);
  report.notes = notes;
  report.meta = { rpc: RPC_URL.replace(/api-key=[^&]+/, 'api-key=***'), rpcCalls, ms: Date.now() - t0, analyzedAt: new Date().toISOString() };
  return report;
}

function scoreRisk(r) {
  const flags = []; let score = 0;
  const add = (lvl, es, en) => { flags.push({ level: lvl, es, en }); score += lvl === 'high' ? 3 : lvl === 'medium' ? 1 : 0; };
  const b = r.bundle;
  if (b) {
    const strong = b.multiWalletTxs > 0 || b.sameSlotPaidByDev > 0 || (b.rightAfterCreateWallets >= 2 && b.rightAfterCreatePct >= 5);
    if (strong) {
      const es = [], en = [];
      if (b.multiWalletTxs) { es.push(`${b.multiWalletTxs} tx compraron para varias carteras a la vez`); en.push(`${b.multiWalletTxs} tx(s) bought for several wallets at once`); }
      if (b.rightAfterCreateWallets) { es.push(`${b.rightAfterCreateWallets} carteras compraron justo detrás de la tx de creación (${b.rightAfterCreatePct}%)`); en.push(`${b.rightAfterCreateWallets} wallets bought right after the create tx (${b.rightAfterCreatePct}%)`); }
      if (b.sameSlotPaidByDev) { es.push(`${b.sameSlotPaidByDev} compras pagadas por el dev`); en.push(`${b.sameSlotPaidByDev} buys fee-paid by the dev`); }
      add('high', `Bundle probable: ${es.join('; ')}. Bloque de creación: ${b.sameSlotWallets} carteras, ${b.sameSlotPctSupply}% del supply.`, `Likely bundle: ${en.join('; ')}. Creation block: ${b.sameSlotWallets} wallets, ${b.sameSlotPctSupply}% of supply.`);
    }
    else if (b.sameSlotWallets >= 1) add(b.sameSlotPctSupply >= 15 ? 'high' : 'medium', `${b.sameSlotWallets} cartera(s) compraron en el mismo bloque de la creación (${b.sameSlotPctSupply}%), sin patrón claro de bundle: probablemente snipers.`, `${b.sameSlotWallets} wallet(s) bought in the creation block (${b.sameSlotPctSupply}%), no clear bundle pattern: likely snipers.`);
    if (false) add('high', `${b.sameSlotPaidByDev} compra(s) del mismo bloque las pagó la cartera del dev (bundle del dev).`, `${b.sameSlotPaidByDev} same-block buy(s) were fee-paid by the dev wallet (dev bundle).`);

    if (b.next2SlotPctSupply >= 15) add('high', `${b.next2SlotBuyers} carteras se llevaron el ${b.next2SlotPctSupply}% del supply en los 2 bloques siguientes a la creación.`, `${b.next2SlotBuyers} wallets took ${b.next2SlotPctSupply}% of supply in the 2 blocks after creation.`);
    else if (b.next2SlotBuyers >= 5) add('medium', `${b.next2SlotBuyers} carteras compraron en los 2 bloques siguientes (snipers/bots).`, `${b.next2SlotBuyers} wallets bought in the next 2 blocks (snipers/bots).`);
    if (b.earlyStillHoldPct != null && (b.sameSlotWallets + b.next2SlotBuyers) > 0) add(b.earlyStillHoldPct >= 10 ? 'high' : 'ok', `Las carteras tempranas (mismo bloque + 2 siguientes) aún tienen el ${b.earlyStillHoldPct}% del supply.`, `Early wallets (same block + next 2) still hold ${b.earlyStillHoldPct}% of supply.`);
  } else add('unknown', 'No se pudo comprobar el bundle (historial no alcanzado).', 'Bundle check not available (history not reached).');
  const d = r.dev;
  if (r.creation?.devInitialBuyPct >= 10) add('medium', `El dev compró el ${r.creation.devInitialBuyPct}% del supply al crear.`, `Dev bought ${r.creation.devInitialBuyPct}% of supply at creation.`);
  if (d) {
    if (d.soldPctOfBought != null && d.soldPctOfBought >= 90) add('medium', `El dev ha vendido el ${d.soldPctOfBought}% de lo que compró.`, `Dev sold ${d.soldPctOfBought}% of what they bought.`);
    else if (d.hasSold) add('ok', `El dev ha vendido parte (${d.soldPctOfBought ?? '?'}%).`, `Dev sold some (${d.soldPctOfBought ?? '?'}%).`);
    else add('ok', 'El dev no ha vendido.', 'Dev has not sold.');
    if (d.holdingPctSupply >= 10) add('high', `El dev aún tiene el ${d.holdingPctSupply}% del supply.`, `Dev still holds ${d.holdingPctSupply}% of supply.`);
  }
  const t = r.holders?.top10Pct;
  if (t != null) {
    if (t >= 35) add('high', `Top 10 holders concentran el ${t}% (sin contar curva/pools).`, `Top 10 holders hold ${t}% (excl. curve/pools).`);
    else if (t >= 20) add('medium', `Top 10 holders concentran el ${t}%.`, `Top 10 holders hold ${t}%.`);
    else add('ok', `Top 10 holders: ${t}%, distribución razonable.`, `Top 10 holders: ${t}%, reasonable spread.`);
  }
  const level = score >= 4 ? 'ALTO' : score >= 2 ? 'MEDIO' : 'BAJO';
  const levelEn = { ALTO: 'HIGH', MEDIO: 'MEDIUM', BAJO: 'LOW' }[level];
  return { level, levelEn, score, flags, disclaimer: { es: 'Señales automáticas on-chain, no son consejo financiero. Un riesgo BAJO no garantiza nada.', en: 'Automated on-chain signals, not financial advice. LOW risk guarantees nothing.' } };
}

module.exports = { analyze, rpc, getTx, ownerDeltas, getDexScreener, mapLimit, creditStats, setCreditTag, restoreCredits, creditSnapshot, PUMP_PROGRAM_ID: PUMP_PROGRAM.toBase58() };

if (require.main === module) {
  analyze(process.argv[2]).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
