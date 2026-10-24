// ALMA direct execution: pump.fun bonding curve (buy_exact_quote_in_v3 / sell_v3) and PumpSwap canonical pools,
// built locally with the official @pump-fun SDKs. No aggregator fee (PumpPortal Local API charges +0.5% per side).
// * Exact quotes from on-chain state (curve/pool reserves + the pump-fees FeeConfig tier for that market cap,
//   per-coin creator rate included) -> expected price impact and a minimum-out set by our slippage policy.
// * Token account rent is reclaimed in the same sell tx (CloseAccount after a full sell), so no extra tx.
// * Compute-unit limit is fitted from a simulation; priority fee = recent median for the pump program, capped.
// Nothing here signs or sends: agent.js signs, simulates (guard) and sends.
const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const BN = require('bn.js');
const LAMPORTS = 1e9, TOK = 1e6; // pump coins have 6 decimals
let P = null, S = null, SPL = null;
const lib = () => { if (!P) { P = require('@pump-fun/pump-sdk'); S = require('@pump-fun/pump-swap-sdk'); SPL = require('@solana/spl-token'); } return { P, S, SPL }; };
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

// ---- slippage policy (pure, unit-tested). Tolerance = what our own size moves the price + a buffer for what the
// market can do in the ~1-2 s before landing, never above a hard cap. Exits that must happen (stop/time/graduation)
// escalate the tolerance on each retry, up to a higher cap, so a falling coin cannot trap the position.
const SLIP = () => ({
  minPct: Number(process.env.AGENT_SLIP_MIN_PCT || 0.5),
  bufferPct: Number(process.env.AGENT_SLIP_BUFFER_PCT || 0.5),
  volMult: Number(process.env.AGENT_SLIP_VOL_MULT || 1.5),
  buyCapPct: Number(process.env.AGENT_SLIP_BUY_CAP_PCT || 2.5),
  sellCapPct: Number(process.env.AGENT_SLIP_SELL_CAP_PCT || 3),
  forcedSteps: [3, 6, 10], // stop/time/graduation exit retries
});
function slippagePolicy({ side, impactPct = 0, volPct = 0, forced = false, attempt = 0 }, c = SLIP()) {
  const raw = Math.max(c.minPct, impactPct + c.bufferPct + c.volMult * Math.max(0, volPct));
  if (side === 'sell' && forced) { const cap = c.forcedSteps[Math.min(attempt, c.forcedSteps.length - 1)]; return { tolPct: r2(Math.min(Math.max(raw, cap), cap)), capPct: cap, ok: true, forced: true }; }
  const cap = side === 'buy' ? c.buyCapPct : c.sellCapPct;
  return { tolPct: r2(Math.min(raw, cap)), capPct: cap, ok: raw <= cap, wantedPct: r2(raw) };
}

// ---- cost model (pure, shared by live quotes, paper fills, backtest). Per side, all in SOL.
// route: 'direct' (curve/PumpSwap, 0 aggregator fee), 'pumpportal' (+0.5%), 'jupiter-build' (0), 'jupiter-order' (0.1%, 0.5% <24h tokens)
const ROUTE_FEE_PCT = { direct: 0, pumpportal: 0.5, 'jupiter-build': 0, 'jupiter-order': 0.5 };
const NET = () => ({
  baseFeeLamports: 5000, // 1 signature
  cuBuy: Number(process.env.AGENT_CU_BUY || 95000), cuSell: Number(process.env.AGENT_CU_SELL || 75000), // fitted from simulation live
  cuPriceMicro: Number(process.env.AGENT_CU_PRICE_MICRO || 200000), // measured median for the pump program (Oct 2026); live uses the current median, capped
  maxPriorityLamports: Number(process.env.AGENT_MAX_PRIORITY_LAMPORTS || 20000), // 0.00002 SOL hard cap per tx
  ataRentLamports: 2074080, // Token-2022 ATA for create_v2 coins (SPL: 2039280); refunded when closed in the sell tx
  volAccRentLamports: 1346200, // pump user_volume_accumulator, one-time per wallet (created by the first buy; measured in mainnet simulation)
});
const priorityLamports = (cu, micro, cap) => Math.min(cap, Math.ceil((cu * micro) / 1e6));
function networkSol(side, n = NET(), micro = n.cuPriceMicro) { return (n.baseFeeLamports + priorityLamports(side === 'buy' ? n.cuBuy : n.cuSell, micro, n.maxPriorityLamports)) / LAMPORTS; }
// Constant-product curve fills with fees. curveFeePct = protocol + creator (pump.fun 1.25% today), routeFeePct on top.
function buyQuote(vs, vt, spendSol, { curveFeePct = 1.25, routeFeePct = 0, netSol = 0 } = {}) {
  const afterRoute = spendSol * (1 - routeFeePct / 100);
  const solIn = afterRoute / (1 + curveFeePct / 100); // pump.fun charges its fee on top of the SOL that moves the curve
  const tok = vt - (vs * vt) / (vs + solIn);
  const spot = vs / vt, avg = solIn / tok; const impactPct = (avg / spot - 1) * 100;
  return { solIn, tok, cost: spendSol + netSol, fees: { curveSol: afterRoute - solIn, routeSol: spendSol - afterRoute, networkSol: netSol }, impactPct, impactSol: solIn - tok * spot };
}
function sellQuote(vs, vt, tok, { curveFeePct = 1.25, routeFeePct = 0, netSol = 0, rentBackSol = 0 } = {}) {
  if (vt <= 0) return { out: 0 };
  const gross = (vs * tok) / (vt + tok); const spot = vs / vt; const atSpot = tok * spot;
  const curveSol = gross * (curveFeePct / 100); const afterCurve = gross - curveSol; const routeSol = afterCurve * (routeFeePct / 100);
  return { gross, out: afterCurve - routeSol - netSol + rentBackSol, fees: { curveSol, routeSol, networkSol: netSol }, impactPct: (1 - gross / atSpot) * 100, impactSol: atSpot - gross };
}
// Full round trip at unchanged reserves: what a trade of `size` SOL must earn just to break even.
function roundTrip(size, { vs = 45, vt = 715e6, route = 'direct', curveFeePct = 1.25, micro, rentLost = false, firstTrade = false } = {}) {
  const n = NET(); const rf = ROUTE_FEE_PCT[route] ?? 0;
  const nb = networkSol('buy', n, micro), ns = networkSol('sell', n, micro) + (route === 'pumpportal' ? n.baseFeeLamports / LAMPORTS : 0); // PumpPortal sells don't close the ATA: a 2nd tx does
  const b = buyQuote(vs, vt, size, { curveFeePct, routeFeePct: rf, netSol: nb });
  const s = sellQuote(vs + b.solIn, vt - b.tok, b.tok, { curveFeePct, routeFeePct: rf, netSol: ns, rentBackSol: 0 });
  const rent = rentLost ? n.ataRentLamports / LAMPORTS : 0; const once = firstTrade ? n.volAccRentLamports / LAMPORTS : 0;
  const lost = size + nb - (s.out) + rent + once; // cash out of pocket: spend + buy network - proceeds (sell network already netted)
  const fees = b.fees.curveSol + s.fees.curveSol, route$ = b.fees.routeSol + s.fees.routeSol, net = nb + ns;
  return { size, route, totalSol: r4(lost * 1e4) / 1e4, totalPct: r2((lost / size) * 100), breakdown: { pumpFeesPct: r2((fees / size) * 100), routeFeePct: r2((route$ / size) * 100), networkPct: r2((net / size) * 100), impactRoundTripPct: r2(((lost - fees - route$ - net - rent - once) / size) * 100), rentLostPct: r2((rent / size) * 100), oneTimeAccountPct: r2((once / size) * 100) }, impactBuyPct: r4(b.impactPct), impactSellPct: r4(s.impactPct) };
}

// ---- live executor (RPC reads + instruction building)
function createExecutor({ rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', connection = null, rpc = null } = {}) {
  const conn = connection || new Connection(rpcUrl, 'confirmed');
  let cache = { at: 0 }, feeCache = { at: 0, micro: null };
  async function pumpState() {
    const { P } = lib(); if (Date.now() - cache.at < 10 * 60e3 && cache.global) return cache;
    const sdk = new P.OnlinePumpSdk(conn); const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
    cache = { at: Date.now(), sdk, global, feeConfig }; return cache;
  }
  // recent prioritization fees for txs touching the pump program (bonding curve if given): median of non-zero, capped
  async function priorityMicro(accounts = []) {
    if (Date.now() - feeCache.at < 30e3 && feeCache.micro != null) return feeCache.micro;
    const n = NET(); let micro = n.cuPriceMicro;
    try {
      const arr = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: [new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), ...accounts] });
      const v = arr.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
      if (v.length) micro = v[Math.floor(v.length / 2)];
    } catch {}
    micro = Math.max(1000, Math.min(micro, Number(process.env.AGENT_MAX_CU_PRICE_MICRO || 300000)));
    feeCache = { at: Date.now(), micro }; return micro;
  }
  async function mintInfo(mint) {
    const ai = await conn.getAccountInfo(mint); if (!ai) throw new Error('mint not found');
    const { SPL } = lib(); const m = SPL.unpackMint(mint, ai, ai.owner); return { tokenProgram: ai.owner, supply: new BN(m.supply.toString()), mintAuthority: m.mintAuthority ? m.mintAuthority.toBase58() : null, freezeAuthority: m.freezeAuthority ? m.freezeAuthority.toBase58() : null };
  }
  // where does this coin trade right now?
  async function venue(mintS) {
    const { P } = lib(); const mint = new PublicKey(mintS); const st = await pumpState();
    const bcAi = await conn.getAccountInfo(P.bondingCurvePda(mint));
    const curve = bcAi ? new P.PumpSdk().decodeBondingCurve(bcAi) : null;
    if (curve && !curve.complete) return { kind: 'curve', mint, curve };
    const poolKey = P.canonicalPumpPoolPda(mint); const poolAi = await conn.getAccountInfo(poolKey);
    if (poolAi) return { kind: 'pumpswap', mint, poolKey, curve };
    return { kind: curve?.complete ? 'migrating' : 'none', mint, curve };
  }
  const curveFeeBps = (st, curve, supply) => { const { P } = lib(); const f = P.computeFeesBps({ global: st.global, feeConfig: st.feeConfig, mintSupply: supply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves, quoteMint: curve.quoteMint, creatorFeeBps: curve.creatorFeeBps }); return Number(f.protocolFeeBps) + Number(f.creatorFeeBps); };

  // Quote + instructions. side 'buy': amount = SOL to spend. side 'sell': amount = raw token units (BN or number) or 'all'.
  async function plan({ side, mint: mintS, user: userS, amount, slip = {}, closeAta = true }) {
    const { P, S, SPL } = lib(); const mint = new PublicKey(mintS), user = new PublicKey(userS);
    const st = await pumpState(); const v = await venue(mintS); const mi = await mintInfo(mint);
    const ata = SPL.getAssociatedTokenAddressSync(mint, user, true, mi.tokenProgram);
    if (side === 'buy' && (mi.mintAuthority || mi.freezeAuthority)) { const e = new Error(`the mint still has a ${mi.mintAuthority ? 'mint' : 'freeze'} authority (can be inflated or frozen). Not buying.`); e.skip = true; throw e; }
    let tokRaw = null;
    if (side === 'sell') {
      if (amount === 'all') { const b = await conn.getTokenAccountBalance(ata).catch(() => null); tokRaw = new BN(b?.value?.amount || '0'); } else tokRaw = new BN(String(amount));
      if (tokRaw.isZero()) throw new Error('nothing to sell');
    }
    const ixs = []; let q;
    if (v.kind === 'curve') {
      const c = v.curve; if (!c.quoteMint.equals(PublicKey.default) && !c.quoteMint.equals(WSOL)) throw new Error('curve not quoted in SOL');
      const feeBps = curveFeeBps(st, c, mi.supply);
      const vs = Number(c.virtualQuoteReserves.toString()) / LAMPORTS, vt = Number(c.virtualTokenReserves.toString()) / TOK;
      if (side === 'buy') {
        const lam = new BN(Math.floor(amount * LAMPORTS));
        const bal = await conn.getTokenAccountBalance(SPL.getAssociatedTokenAddressSync(mint, P.bondingCurvePda(mint), true, mi.tokenProgram)).catch(() => null);
        const curveBal = new BN(bal?.value?.amount || c.realTokenReserves.toString());
        const expTok = P.getBuyV3TokenAmountFromQuoteAmount({ global: st.global, feeConfig: st.feeConfig, mintSupply: mi.supply, bondingCurve: c, amount: lam, curveBaseTokenBalance: curveBal });
        const bq = buyQuote(vs, vt, amount, { curveFeePct: feeBps / 100 });
        const pol = slippagePolicy({ side, impactPct: bq.impactPct, ...slip });
        const minOut = expTok.muln(Math.round((1 - pol.tolPct / 100) * 1e6)).divn(1e6);
        ixs.push(SPL.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, mi.tokenProgram));
        if (c.isCashbackCoin) throw new Error('cashback coin: v3 not supported (fallback route)');
        ixs.push(await new P.PumpSdk().getBuyExactQuoteInV3InstructionRaw({ user, mint, spendableQuoteIn: lam, minTokensOut: minOut, tokenProgram: mi.tokenProgram, quoteMint: c.quoteMint }));
        q = { venue: 'pump.fun curve', ix: 'buy_exact_quote_in_v3', feeBps, vs, vt, spendSol: amount, expectedTok: Number(expTok.toString()) / TOK, minTok: Number(minOut.toString()) / TOK, impactPct: r4(bq.impactPct), slippage: pol };
      } else {
        const expSol = P.getSellSolAmountFromTokenAmount({ global: st.global, feeConfig: st.feeConfig, mintSupply: mi.supply, bondingCurve: c, amount: tokRaw });
        const tok = Number(tokRaw.toString()) / TOK; const sq = sellQuote(vs, vt, tok, { curveFeePct: feeBps / 100 });
        const pol = slippagePolicy({ side, impactPct: sq.impactPct, ...slip });
        const minOut = expSol.muln(Math.round((1 - pol.tolPct / 100) * 1e6)).divn(1e6);
        if (c.isCashbackCoin) throw new Error('cashback coin: v3 not supported (fallback route)');
        ixs.push(await new P.PumpSdk().getSellV3InstructionRaw({ user, mint, amount: tokRaw, quoteAmount: minOut, tokenProgram: mi.tokenProgram, quoteMint: c.quoteMint }));
        q = { venue: 'pump.fun curve', ix: 'sell_v3', feeBps, vs, vt, tokens: tok, expectedSol: Number(expSol.toString()) / LAMPORTS, minSol: Number(minOut.toString()) / LAMPORTS, impactPct: r4(sq.impactPct), slippage: pol };
      }
    } else if (v.kind === 'pumpswap') {
      const on = new S.OnlinePumpAmmSdk(conn); const ss = await on.swapSolanaState(v.poolKey, user); const off = new S.PumpAmmSdk();
      if (!ss.pool.quoteMint.equals(WSOL)) throw new Error('pool not quoted in SOL');
      const base = Number(ss.poolBaseAmount.toString()) / TOK, quote = (Number(ss.poolQuoteAmount.toString()) + Number(ss.pool.virtualQuoteReserves?.toString?.() || 0)) / LAMPORTS;
      const mc = (quote / base) * (Number(mi.supply.toString()) / TOK); const feeBps = tierBps(ss.feeConfig, mc);
      if (side === 'buy') {
        const bq = buyQuote(quote, base, amount, { curveFeePct: feeBps / 100 }); const pol = slippagePolicy({ side, impactPct: bq.impactPct, ...slip });
        ixs.push(...(await off.buyQuoteInput(ss, new BN(Math.floor(amount * LAMPORTS)), pol.tolPct, { v2: true })));
        q = { venue: 'PumpSwap', ix: 'buy (quote in)', feeBps, vs: quote, vt: base, spendSol: amount, expectedTok: bq.tok, impactPct: r4(bq.impactPct), slippage: pol };
      } else {
        const tok = Number(tokRaw.toString()) / TOK; const sq = sellQuote(quote, base, tok, { curveFeePct: feeBps / 100 }); const pol = slippagePolicy({ side, impactPct: sq.impactPct, ...slip });
        ixs.push(...(await off.sellBaseInput(ss, tokRaw, pol.tolPct, { v2: true })));
        q = { venue: 'PumpSwap', ix: 'sell (base in)', feeBps, vs: quote, vt: base, tokens: tok, expectedSol: sq.out, impactPct: r4(sq.impactPct), slippage: pol };
      }
    } else throw new Error(v.kind === 'migrating' ? 'curve complete, pool not open yet (migration pending)' : 'no pump.fun curve or pool for this mint');
    if (side === 'sell' && closeAta) {
      const left = await conn.getTokenAccountBalance(ata).catch(() => null);
      if (left && new BN(left.value.amount).eq(tokRaw)) ixs.push(SPL.createCloseAccountInstruction(ata, user, user, [], mi.tokenProgram)); // full sell: reclaim the rent in the same tx
    }
    return { ...q, route: 'direct', ata: ata.toBase58(), tokenProgram: mi.tokenProgram.toBase58(), ixs, user, tokRaw: tokRaw ? tokRaw.toString() : null };
  }
  function tierBps(fc, mcSol) {
    if (!fc?.feeTiers?.length) return 125; let t = fc.feeTiers[0];
    for (const x of fc.feeTiers) if (mcSol * LAMPORTS >= Number(x.marketCapLamportsThreshold.toString())) t = x;
    return Number(t.fees.lpFeeBps) + Number(t.fees.protocolFeeBps) + Number(t.fees.creatorFeeBps);
  }
  // assemble a v0 tx: compute budget (limit fitted by a first simulation, capped priority) + plan instructions
  async function assemble(pl, { cuLimit = 300000, micro = null } = {}) {
    const n = NET(); const m = micro ?? (await priorityMicro());
    const cuPrice = Math.max(1, Math.floor(Math.min(m, (n.maxPriorityLamports * 1e6) / cuLimit)));
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: pl.user, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...pl.ixs] }).compileToV0Message();
    const tx = new VersionedTransaction(msg); return { tx, cuLimit, cuPrice, micro: m, priorityLamports: Math.ceil((cuLimit * cuPrice) / 1e6), baseFeeLamports: 5000 };
  }
  async function simulate(tx, addresses = []) {
    const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: addresses.length ? { encoding: 'base64', addresses } : undefined });
    return r.value;
  }
  // build with a tight CU limit: simulate once at 300k (no signature needed), then rebuild at used*1.15
  async function build(args) {
    const pl = await plan(args); let a = await assemble(pl);
    const sim = await simulate(a.tx).catch(() => null);
    if (sim && !sim.err && sim.unitsConsumed) a = await assemble(pl, { cuLimit: Math.ceil(sim.unitsConsumed * 1.15) + 1000, micro: a.micro });
    return { ...pl, ...a, fitSim: sim ? { err: sim.err, units: sim.unitsConsumed } : null };
  }
  return { plan, assemble, simulate, build, venue, priorityMicro, pumpState, conn };
}

module.exports = { createExecutor, slippagePolicy, SLIP, buyQuote, sellQuote, roundTrip, networkSol, NET, ROUTE_FEE_PCT, priorityLamports };
