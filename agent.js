// SpaniardDev AI Trader Agent — an autonomous, fully public trading experiment on pump.fun bonding curves.
// * Reuses the scalper's free public-RPC trade stream (TradeEvents: price, reserves, buyers) for signals,
//   and the Bundle Snout scanner (analyze + radar cleanCheck) as a hard safety gate before every entry.
// * Explicit rules only (no hidden discretion): size cap, take profit, stop loss, time stop, max open positions,
//   daily loss limit, kill switch. Every decision (buy, sell, skip) is logged with a plain-language reason.
// * HARD RULES: never trades its own coin (AGENT_EXCLUDE_CA), never trades coins created by protected wallets
//   (the dev wallet), never sends SOL anywhere except through buy/sell swaps it verifies by simulation.
// * AGENT_MODE=paper (default): simulated fills on the real curve with live-equivalent fees. AGENT_MODE=live: real swaps
//   via PumpPortal's Local Transaction API (tx built by PumpPortal, verified + simulated + signed locally, sent via our RPC).
const crypto = require('crypto');
const { Keypair, VersionedTransaction, Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');
const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
const { features, scalpLevels, buyFill, sellValue } = require('./scalp');

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const csv = (k) => (process.env[k] || '').split(',').map((x) => x.trim()).filter(Boolean);
const DEV_WALLET = '9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys'; // the dev's main wallet: never touched, its coins never traded
const ACFG = () => ({
  mode: (process.env.AGENT_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
  enabled: process.env.AGENT_ENABLED !== '0',
  exclude: new Set([...csv('AGENT_EXCLUDE_CA'), ...csv('RIPS_CA')]),
  protectedWallets: new Set([DEV_WALLET, ...csv('RIPS_DEV_WALLET'), ...csv('AGENT_PROTECTED_WALLETS')]),
  maxTradeSol: num('AGENT_MAX_TRADE_SOL', 0.02),
  sizePct: num('AGENT_SIZE_PCT', 20),            // % of free balance per trade, capped by maxTradeSol
  minTradeSol: num('AGENT_MIN_TRADE_SOL', 0.005),
  reserveSol: num('AGENT_RESERVE_SOL', 0.01),     // never spent: tx fees + token-account rent
  maxOpen: num('AGENT_MAX_OPEN', 2),
  tpPct: num('AGENT_TP_PCT', 20), slPct: num('AGENT_SL_PCT', 15), maxHoldMin: num('AGENT_MAX_HOLD_MIN', 15),
  dailyLossSol: num('AGENT_DAILY_LOSS_SOL', 0.03),
  cooldownMin: num('AGENT_COOLDOWN_MIN', 240),    // per coin, after any decision on it
  minProg: num('AGENT_MIN_PROGRESS', 8), maxProg: num('AGENT_MAX_PROGRESS', 85),
  maxScansPerDay: num('AGENT_MAX_SCANS_PER_DAY', 150), scanGapSec: num('AGENT_SCAN_GAP_SEC', 60),
  paperStartSol: num('AGENT_PAPER_START_SOL', 0.1),
  feePct: num('AGENT_FEE_PCT', 1.75),             // per side: pump.fun 1.25% (0.95 protocol + 0.30 creator) + PumpPortal Local API 0.5%
  txFeeSol: num('AGENT_TX_FEE_SOL', 0.0001),      // base 0.000005 + priority fee, per tx
  slippagePct: num('AGENT_SLIPPAGE_PCT', 15), priorityFeeSol: num('AGENT_PRIORITY_FEE_SOL', 0.00005),
  ride: { minBuyers: num('AGENT_RIDE_MIN_BUYERS', 12), minBuySol: num('AGENT_RIDE_MIN_BUY_SOL', 3), minNet: num('AGENT_RIDE_MIN_NET_SOL', 1.5), maxLoop: 0.25, maxSame: 0.3, maxBot: 0.2 },
  saveMin: num('AGENT_SAVE_MIN', 5),
  keep: { trades: 200, decisions: 80 },
});
const r1 = (x) => Math.round(x * 10) / 10, r4 = (x) => Math.round(x * 1e4) / 1e4, r6 = (x) => Math.round(x * 1e6) / 1e6;
const madridDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const sym = (s, mint) => '$' + (s || mint.slice(0, 4) + '…');
const LAMPORTS = 1e9;

function parseSecret(s) {
  if (!s) return null;
  try { const t = s.trim(); const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t); return Keypair.fromSecretKey(bytes); } catch { return null; }
}

// ---- entry signals (explicit, from the shared trade stream)
function signal(m, t, cfg) {
  const f60 = features(m, t, 60e3); if (!f60) return null;
  if (f60.progress < cfg.minProg || f60.progress > cfg.maxProg) return null;
  const lv = scalpLevels(f60);
  if (lv.R2 >= 1) return { kind: 'dip', f: f60, why: `price dipped ${f60.chgPct}% in 60s while ${f60.n} trades / ${f60.vol} SOL kept flowing (${Math.round(f60.loopShare * 100)}% from wallets buying and selling) → mean-reversion bet` };
  const f = features(m, t, 180e3); const R = cfg.ride;
  if (f && f.uniqueBuyers >= R.minBuyers && f.buySol >= R.minBuySol && f.net >= R.minNet && f.buySol >= 1.5 * Math.max(f.sellSol, 0.01)
    && f.loopShare <= R.maxLoop && f.sameSize <= R.maxSame && f.botTxShare <= R.maxBot && f.chgPct > 0 && f.chgPct <= 80)
    return { kind: 'momentum', f, why: `${f.uniqueBuyers} different buyers and +${f.net} SOL net in 3 min, low bot share (${Math.round(f.botTxShare * 100)}%), price +${f.chgPct}% → organic-demand momentum` };
  return null;
}

// ---- scanner gate: Bundle Snout report -> pass/fail with reasons
function gate(rep, cfg, cleanCheck, rcfg) {
  const fails = [];
  if (rep.curve?.mayhemMode) fails.push('Mayhem Mode coin (AI-agent trading on curve)');
  if (rep.curve && rep.curve.quote !== 'SOL') fails.push(`curve quoted in ${rep.curve.quote}, not SOL`);
  const creator = rep.curve?.creatorOnCurve || rep.dev?.wallet || rep.creation?.dev;
  if (creator && cfg.protectedWallets.has(creator)) fails.push('created by the dev\'s own wallet (never traded)');
  const cc = cleanCheck(rep, { ...rcfg, thresholdPct: 0, allowDevSell: process.env.AGENT_ALLOW_DEV_SELL === '1' });
  for (const x of cc.reasons) if (!/progress .* < threshold/.test(x)) fails.push(x);
  return fails;
}
function cleanSummary(rep) {
  const b = rep.bundle || {}, d = rep.dev || {}, h = rep.holders || {};
  return `scanner clean: ${b.multiWalletTxs ?? 0} bundle txs, creation block ${b.sameSlotPctSupply ?? 0}%, dev holds ${d.holdingPctSupply ?? '?'}% and hasn't sold, top-10 ${h.top10Pct ?? '?'}%`;
}

function createAgent({ scalper = null, store = null, log = console.log, now = () => Date.now(), analyze = null, cleanCheck = null, radarCfg = null, rpc = null, setCreditTag = () => 'other', fetchFn = (...a) => fetch(...a) } = {}) {
  const cfg = ACFG();
  if (!analyze) ({ analyze, rpc, setCreditTag } = require('./analyzer'));
  if (!cleanCheck) { const r = require('./radar'); cleanCheck = r.cleanCheck; radarCfg = radarCfg || r.CFG(); }
  const kp = parseSecret(process.env.AGENT_SECRET_KEY);
  const address = kp ? kp.publicKey.toBase58() : (process.env.AGENT_PUBLIC_KEY || null);
  const st = {
    startedAt: new Date(now()).toISOString(), restoredFrom: null, halted: null,
    paperCash: cfg.paperStartSol, paperStart: cfg.paperStartSol, liveBalance: null, liveBalanceAt: null,
    positions: [], trades: [], decisions: [], seen: {}, day: madridDay(now()), dayPnl: 0, scansDay: madridDay(now()), scansToday: 0, lastScanAt: 0,
    totals: { trades: 0, wins: 0, realizedSol: 0, signals: 0, scans: 0, rejected: 0, scanErrors: 0, liveErrors: 0 }, saves: 0, lastSaveAt: null, lastSaveError: null, lastDecisionAt: null,
  };
  if (cfg.mode === 'live') {
    if (!kp) st.halted = 'LIVE mode needs AGENT_SECRET_KEY: trading halted';
    else if (cfg.protectedWallets.has(address)) st.halted = 'agent key is a protected wallet: refusing to trade';
  }
  let busy = false, dirty = false, lastSave = 0; const timers = [];

  const decide = (d) => { d.at = new Date(now()).toISOString(); st.decisions.unshift(d); st.decisions.length = Math.min(st.decisions.length, cfg.keep.decisions); st.lastDecisionAt = d.at; dirty = true; log(`[agent] ${d.action} ${d.symbol || ''} ${d.reason}`); };
  const rollDay = () => { const d = madridDay(now()); if (d !== st.day) { st.day = d; st.dayPnl = 0; } if (d !== st.scansDay) { st.scansDay = d; st.scansToday = 0; } };
  const freeBalance = () => (cfg.mode === 'live' ? (st.liveBalance ?? 0) : st.paperCash);
  const excluded = (mint) => cfg.exclude.has(mint);
  const valueOf = (pos, vs, vt) => (cfg.mode === 'live'
    ? Math.max(0, ((vs * pos.tok) / (vt + pos.tok)) * (1 - cfg.feePct / 100) - cfg.txFeeSol) // our buy is already in the stream reserves
    : Math.max(0, sellValue(vs, vt, pos, cfg)));
  const blockers = () => {
    if (!cfg.enabled) return 'kill switch on (AGENT_ENABLED=0)';
    if (st.halted) return st.halted;
    if (st.dayPnl <= -cfg.dailyLossSol) return `daily loss limit hit (${r4(st.dayPnl)} SOL ≤ -${cfg.dailyLossSol})`;
    if (st.positions.length >= cfg.maxOpen) return 'max open positions';
    if (freeBalance() - cfg.reserveSol < cfg.minTradeSol) return 'balance too low';
    return null;
  };
  const sizeFor = () => { const free = freeBalance() - cfg.reserveSol; return r4(Math.min(cfg.maxTradeSol, Math.max(cfg.minTradeSol, free * cfg.sizePct / 100), free)); };

  // ---- stream hook (called by the scalper for every bonding-curve trade)
  function onTrade(tr, m) {
    if (excluded(tr.mint)) return; // never even evaluated
    const t = now();
    for (const pos of st.positions) if (pos.mint === tr.mint) { pos.vs = tr.vs; pos.vt = tr.vt; pos.lastAt = t; pos.complete = m.complete; checkExit(pos); }
    if (busy || m.complete || blockers()) return;
    if ((m.agentEval || 0) > t - 3000) return; m.agentEval = t;
    const seen = st.seen[tr.mint]; if (seen && seen > t) return;
    if (st.positions.some((p) => p.mint === tr.mint)) return;
    const sg = signal(m, t, cfg); if (!sg) return;
    st.totals.signals++;
    rollDay();
    // credit pacing for the scanner (Helius): allowance grows through the Madrid day
    const [hh, mm] = new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour12: false }).split(':').map(Number);
    const allowance = Math.min(cfg.maxScansPerDay, 10 + cfg.maxScansPerDay * ((hh * 60 + mm) / 1440));
    if (st.scansToday >= allowance || t - st.lastScanAt < cfg.scanGapSec * 1000) return;
    scanAndEnter(tr.mint, m, sg).catch((e) => { st.totals.scanErrors++; log('[agent] scan error ' + e.message); });
  }

  async function scanAndEnter(mint, m, sg) {
    busy = true; st.lastScanAt = now(); st.scansToday++; st.totals.scans++;
    st.seen[mint] = now() + cfg.cooldownMin * 60e3;
    const symbol = scalper?.symbol?.(mint) || null;
    try {
      const prev = setCreditTag('agent'); let rep;
      try { rep = await analyze(mint); } finally { setCreditTag(prev); }
      const s = rep.symbol || rep.metadata?.symbol || symbol;
      const fails = gate(rep, cfg, cleanCheck, radarCfg);
      if (excluded(mint)) fails.unshift('this is the agent\'s own coin');
      if (fails.length) { st.totals.rejected++; return decide({ action: 'SKIP', mint, symbol: s, signal: sg.kind, reason: `Signal (${sg.kind}) but scanner said no: ${fails.slice(0, 3).join('; ')}.` }); }
      const b = blockers(); if (b) return decide({ action: 'SKIP', mint, symbol: s, signal: sg.kind, reason: `Clean coin, but not entering: ${b}.` });
      const cur = scalper?.mints?.get(mint) || m;
      if (cur.complete) return decide({ action: 'SKIP', mint, symbol: s, signal: sg.kind, reason: 'Graduated while scanning.' });
      const size = sizeFor();
      const reason = `${sg.why}. ${cleanSummary(rep)}. Rules: TP +${cfg.tpPct}% / SL -${cfg.slPct}% / max ${cfg.maxHoldMin} min.`;
      await openPosition({ mint, symbol: s, size, vs: cur.vs, vt: cur.vt, reason, signal: sg.kind, progress: sg.f.progress });
    } finally { busy = false; }
  }

  async function openPosition({ mint, symbol, size, vs, vt, reason, signal: kind, progress }) {
    if (excluded(mint)) throw new Error('refusing to trade excluded coin');
    let pos;
    if (cfg.mode === 'paper') {
      const fill = buyFill(vs, vt, size, cfg);
      pos = { id: crypto.randomUUID().slice(0, 8), mint, symbol, kind, solIn: fill.solIn, tok: fill.tok, cost: r6(fill.cost), entryPrice: vs / vt, vs, vt, openAt: now(), lastAt: now(), progress, reason, tx: null };
      st.paperCash = r6(st.paperCash - fill.cost);
    } else {
      let res;
      try { res = await liveSwap('buy', mint, size); } catch (e) { st.totals.liveErrors++; return decide({ action: 'ERROR', mint, symbol, reason: `Buy failed, nothing spent: ${e.message.slice(0, 160)}` }); }
      pos = { id: res.sig.slice(0, 8), mint, symbol, kind, solIn: size, tok: res.tokDelta, cost: r6(-res.solDelta), entryPrice: (-res.solDelta) / Math.max(res.tokDelta, 1e-9), vs, vt, openAt: now(), lastAt: now(), progress, reason, tx: res.sig, ata: res.ata, tokenProgram: res.tokenProgram };
      refreshBalance();
    }
    st.positions.push(pos);
    pushTrade({ side: 'BUY', mint, symbol, sol: pos.cost, tok: r1(pos.tok), reason, tx: pos.tx, posId: pos.id });
    decide({ action: 'BUY', mint, symbol, signal: kind, reason: `Bought ${r4(pos.cost)} SOL: ${reason}` });
    await save(true);
  }

  function checkExit(pos) {
    if (pos.closing) return;
    const t = now(); const val = valueOf(pos, pos.vs, pos.vt); const pnlPct = ((val - pos.cost) / pos.cost) * 100; pos.pnlPct = r1(pnlPct); pos.value = r6(val);
    const age = (t - pos.openAt) / 60e3;
    let why = null;
    if (pos.complete) why = `coin graduated (bonding curve complete), closing at ${r1(pnlPct)}%`;
    else if (pnlPct >= cfg.tpPct) why = `take profit: +${r1(pnlPct)}% ≥ +${cfg.tpPct}%`;
    else if (pnlPct <= -cfg.slPct) why = `stop loss: ${r1(pnlPct)}% ≤ -${cfg.slPct}%`;
    else if (age >= cfg.maxHoldMin) why = `time stop: ${r1(age)} min held, ${pnlPct >= 0 ? '+' : ''}${r1(pnlPct)}%${t - pos.lastAt > 120e3 ? ' (no trades for ' + Math.round((t - pos.lastAt) / 60e3) + ' min)' : ''}`;
    if (why) closePosition(pos, why).catch((e) => log('[agent] close error ' + e.message));
  }

  async function closePosition(pos, why) {
    pos.closing = true;
    let proceeds, tx = null;
    if (cfg.mode === 'paper') { proceeds = valueOf(pos, pos.vs, pos.vt); st.paperCash = r6(st.paperCash + proceeds); }
    else {
      try { const res = await liveSwap('sell', pos.mint, '100%', pos); proceeds = res.solDelta; tx = res.sig; }
      catch (e) { st.totals.liveErrors++; pos.closing = false; pos.sellErrors = (pos.sellErrors || 0) + 1; decide({ action: 'ERROR', mint: pos.mint, symbol: pos.symbol, reason: `Sell failed (${why}), will retry: ${e.message.slice(0, 140)}` }); return; }
      closeTokenAccount(pos).catch((e) => log('[agent] close ATA ' + e.message));
      refreshBalance();
    }
    const pnl = r6(proceeds - pos.cost); rollDay();
    st.dayPnl = r6(st.dayPnl + pnl); st.totals.trades++; if (pnl > 0) st.totals.wins++; st.totals.realizedSol = r6(st.totals.realizedSol + pnl);
    st.positions = st.positions.filter((p) => p !== pos);
    const reason = `${why}. Held ${r1((now() - pos.openAt) / 60e3)} min.`;
    pushTrade({ side: 'SELL', mint: pos.mint, symbol: pos.symbol, sol: r6(proceeds), pnlSol: pnl, pnlPct: r1((pnl / pos.cost) * 100), reason, tx, posId: pos.id, heldMin: r1((now() - pos.openAt) / 60e3) });
    decide({ action: 'SELL', mint: pos.mint, symbol: pos.symbol, reason: `Sold for ${r4(proceeds)} SOL (${pnl >= 0 ? '+' : ''}${r4(pnl)} SOL): ${reason}` });
    if (st.dayPnl <= -cfg.dailyLossSol) decide({ action: 'PAUSE', reason: `Daily loss limit reached (${r4(st.dayPnl)} SOL). No new trades until tomorrow (Madrid time).` });
    await save(true);
  }
  function pushTrade(x) { x.at = new Date(now()).toISOString(); x.mode = cfg.mode; st.trades.unshift(x); st.trades.length = Math.min(st.trades.length, cfg.keep.trades); dirty = true; }

  // ---- live execution (PumpPortal Local Transaction API; we sign locally, nothing custodial)
  async function buildPortalTx(action, mint, amount, pubkey = address) {
    const body = { publicKey: pubkey, action, mint, amount, denominatedInSol: action === 'buy' ? 'true' : 'false', slippage: cfg.slippagePct, priorityFee: cfg.priorityFeeSol, pool: 'auto' };
    const r = await fetchFn('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (r.status !== 200) throw new Error(`PumpPortal HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    if (keys[0] !== pubkey) throw new Error('tx fee payer is not the agent wallet');
    if (!keys.includes(mint) && !(tx.message.addressTableLookups || []).length) throw new Error('tx does not reference the mint');
    if (excluded(mint)) throw new Error('excluded coin');
    return tx;
  }
  // Simulate with the agent account returned: reject if the SOL outflow exceeds what this trade can cost.
  async function simulateGuard(tx, action, amountSol, pubkey = address) {
    const pre = (await rpc('getBalance', [pubkey, { commitment: 'confirmed' }])).value;
    const sim = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [pubkey] } }]);
    const v = sim.value; if (v.err) { const e = new Error('simulation failed: ' + JSON.stringify(v.err) + ' ' + (v.logs || []).filter((l) => /error|insufficient/i.test(l)).slice(-2).join(' | ')); e.sim = v; e.preLamports = pre; throw e; }
    const post = v.accounts?.[0]?.lamports ?? pre; const out = (pre - post) / LAMPORTS;
    const bound = action === 'buy' ? amountSol * 1.06 + 0.0035 : 0.0035;
    if (out > bound) throw new Error(`simulated SOL outflow ${out} > bound ${bound}`);
    return { pre, post, out, units: v.unitsConsumed, logs: v.logs };
  }
  async function sendAndConfirm(tx) {
    const sig = await rpc('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 2);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = (await rpc('getSignatureStatuses', [[sig]])).value[0];
      if (s?.err) throw new Error('tx failed on-chain ' + JSON.stringify(s.err) + ' ' + sig);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    }
    throw new Error('not confirmed in 60s ' + sig);
  }
  async function txDeltas(sig, mint) {
    for (let i = 0; i < 5; i++) {
      const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (tx) {
        const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
        const i0 = keys.indexOf(address); const solDelta = (tx.meta.postBalances[i0] - tx.meta.preBalances[i0]) / LAMPORTS;
        const tb = (arr) => (arr || []).find((b) => b.owner === address && b.mint === mint);
        const pre = tb(tx.meta.preTokenBalances), post = tb(tx.meta.postTokenBalances);
        const amt = (b) => Number(b?.uiTokenAmount?.uiAmount || 0);
        return { solDelta, tokDelta: amt(post) - amt(pre), ata: post ? keys[post.accountIndex] : pre ? keys[pre.accountIndex] : null, tokenProgram: (post || pre)?.programId || null };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('confirmed tx not readable ' + sig);
  }
  async function liveSwap(action, mint, amount) {
    if (cfg.mode !== 'live' || !kp) throw new Error('not in live mode');
    if (excluded(mint)) throw new Error('refusing: agent\'s own coin');
    const tx = await buildPortalTx(action, mint, amount);
    tx.sign([kp]);
    await simulateGuard(tx, action, action === 'buy' ? Number(amount) : 0);
    const sig = await sendAndConfirm(tx);
    return { sig, ...(await txDeltas(sig, mint)) };
  }
  // Recover the ~0.002 SOL token-account rent after a full sell (SPL / Token-2022 CloseAccount = instruction 9).
  async function closeTokenAccount(pos) {
    if (!pos.ata || !pos.tokenProgram) return;
    const bal = await rpc('getTokenAccountBalance', [pos.ata]).catch(() => null);
    if (!bal || Number(bal.value.amount) !== 0) return;
    const owner = kp.publicKey;
    const ix = new TransactionInstruction({ programId: new PublicKey(pos.tokenProgram), keys: [{ pubkey: new PublicKey(pos.ata), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from([9]) });
    const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = new Transaction({ feePayer: owner, recentBlockhash: value.blockhash }).add(ix); tx.sign(kp);
    await rpc('sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', maxRetries: 3 }], 2);
  }
  async function refreshBalance() {
    if (!address || !rpc) return;
    try { st.liveBalance = (await rpc('getBalance', [address, { commitment: 'confirmed' }])).value / LAMPORTS; st.liveBalanceAt = new Date(now()).toISOString(); } catch {}
  }

  // Live only: tokens in the wallet that no open position knows about (e.g. a buy that confirmed after a timeout,
  // or a restart mid-trade) are adopted and sold by the normal rules. The agent's own coin is never adopted or sold.
  async function reconcile() {
    if (cfg.mode !== 'live' || !kp || st.halted) return;
    for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
      let res; try { res = await rpc('getTokenAccountsByOwner', [address, { programId: prog }, { encoding: 'jsonParsed' }]); } catch { continue; }
      for (const a of res.value) {
        const info = a.account.data.parsed.info; const amt = Number(info.tokenAmount.uiAmount || 0);
        if (!amt || excluded(info.mint) || st.positions.some((p) => p.mint === info.mint)) continue;
        const lastBuy = st.trades.find((x) => x.mint === info.mint && x.side === 'BUY');
        const pos = { id: 'rec-' + info.mint.slice(0, 4), mint: info.mint, symbol: lastBuy?.symbol || scalper?.symbol?.(info.mint) || null, kind: 'recovered', solIn: lastBuy?.sol || 0, tok: amt, cost: lastBuy?.sol || 0, vs: 30, vt: 1073e6, openAt: now() - cfg.maxHoldMin * 60e3, lastAt: 0, reason: 'untracked tokens found in the agent wallet', tx: null, ata: a.pubkey, tokenProgram: prog };
        st.positions.push(pos); decide({ action: 'RECOVER', mint: info.mint, symbol: pos.symbol, reason: `Found ${r1(amt)} untracked tokens in the wallet; selling them under the time-stop rule.` });
      }
    }
  }

  // ---- housekeeping
  function tick() {
    const t = now();
    for (const pos of [...st.positions]) checkExit(pos);
    for (const [k, v] of Object.entries(st.seen)) if (v < t) delete st.seen[k];
    rollDay(); save();
  }
  function snapshot() { return JSON.stringify({ v: 1, mode: cfg.mode, paperCash: st.paperCash, paperStart: st.paperStart, positions: st.positions.map(({ closing, ...p }) => p), trades: st.trades, decisions: st.decisions.slice(0, 40), seen: st.seen, day: st.day, dayPnl: st.dayPnl, scansDay: st.scansDay, scansToday: st.scansToday, totals: st.totals, savedAt: new Date(now()).toISOString() }); }
  function restore(raw) {
    let j; try { j = JSON.parse(raw); } catch { return; } if (!j || j.v !== 1) return;
    if (j.mode !== cfg.mode) { st.restoredFrom = `${j.mode} state ignored (now ${cfg.mode})`; if (j.mode === 'paper' && cfg.mode === 'live') return; }
    Object.assign(st, { paperCash: j.paperCash ?? st.paperCash, paperStart: j.paperStart ?? st.paperStart, positions: j.positions || [], trades: j.trades || [], decisions: j.decisions || [], seen: j.seen || {}, day: j.day || st.day, dayPnl: j.dayPnl || 0, scansDay: j.scansDay || st.scansDay, scansToday: j.scansToday || 0, totals: { ...st.totals, ...(j.totals || {}) } });
    st.restoredFrom = j.savedAt;
  }
  async function save(force = false) {
    if (!store || (!dirty && !force)) return; const t = now(); if (!force && t - lastSave < cfg.saveMin * 60e3) return;
    lastSave = t; dirty = false;
    try { await store.put(snapshot()); st.saves++; st.lastSaveAt = new Date(t).toISOString(); st.lastSaveError = null; } catch (e) { st.lastSaveError = e.message; dirty = true; }
  }

  function status() {
    const t = now(); const solUsd = scalper?.solUsd?.() || null;
    const open = st.positions.map((p) => ({ mint: p.mint, symbol: p.symbol, kind: p.kind, costSol: p.cost, valueSol: p.value ?? null, pnlPct: p.pnlPct ?? null, openedAt: new Date(p.openAt).toISOString(), ageMin: r1((t - p.openAt) / 60e3), reason: p.reason, tx: p.tx }));
    const unreal = r6(st.positions.reduce((a, p) => a + ((p.value ?? p.cost) - p.cost), 0));
    const equity = cfg.mode === 'paper' ? r6(st.paperCash + st.positions.reduce((a, p) => a + (p.value ?? p.cost), 0)) : null;
    const state = !cfg.enabled ? 'stopped' : st.halted ? 'halted' : st.dayPnl <= -cfg.dailyLossSol ? 'paused (daily loss limit)' : 'running';
    return {
      name: 'SpaniardDev AI Trader', mode: cfg.mode, state, enabled: cfg.enabled, halted: st.halted, startedAt: st.startedAt, restoredFrom: st.restoredFrom, now: new Date(t).toISOString(),
      wallet: { address, solscan: address ? `https://solscan.io/account/${address}` : null, onChainSol: st.liveBalance, onChainAt: st.liveBalanceAt },
      balance: cfg.mode === 'paper' ? { source: 'paper', startSol: st.paperStart, cashSol: st.paperCash, equitySol: equity } : { source: 'on-chain', sol: st.liveBalance },
      solUsd,
      pnl: { realizedSol: st.totals.realizedSol, unrealizedSol: unreal, todaySol: st.dayPnl, dailyLossLimitSol: cfg.dailyLossSol, day: st.day },
      stats: { closedTrades: st.totals.trades, wins: st.totals.wins, winRate: st.totals.trades ? r1((st.totals.wins / st.totals.trades) * 100) : null, signals: st.totals.signals, scans: st.totals.scans, rejectedByScanner: st.totals.rejected, scansToday: st.scansToday, maxScansPerDay: cfg.maxScansPerDay, scanErrors: st.totals.scanErrors, liveErrors: st.totals.liveErrors },
      rules: { maxTradeSol: cfg.maxTradeSol, sizePctOfBalance: cfg.sizePct, reserveSol: cfg.reserveSol, maxOpen: cfg.maxOpen, takeProfitPct: cfg.tpPct, stopLossPct: cfg.slPct, maxHoldMin: cfg.maxHoldMin, dailyLossLimitSol: cfg.dailyLossSol, coinCooldownMin: cfg.cooldownMin, curveProgressPct: [cfg.minProg, cfg.maxProg], feesPerSidePct: cfg.feePct, txFeeSol: cfg.txFeeSol, slippagePct: cfg.slippagePct,
        signals: { dip: 'price dips ≥4% in 60 s while ≥12 trades / ≥1 SOL keep flowing from looping wallets (mean reversion)', momentum: `≥${cfg.ride.minBuyers} different buyers, ≥${cfg.ride.minBuySol} SOL bought and ≥${cfg.ride.minNet} SOL net in 3 min, low bot share, price up` },
        scannerGate: 'no multi-wallet bundle txs, no dev-paid creation-block buys, creation block <10% supply, early wallets <10%, dev holds <10% and has not sold, top-10 <30%, risk not HIGH, not Mayhem Mode, SOL-quoted curve, not created by the dev wallet',
        neverTrades: [...cfg.exclude], protectedWallets: [...cfg.protectedWallets] },
      positions: open, trades: st.trades, decisions: st.decisions,
      stream: scalper?.streamInfo?.() || null, persistence: store ? { backend: store.name, saves: st.saves, lastSaveAt: st.lastSaveAt, lastSaveError: st.lastSaveError } : { backend: 'memory' },
      lastDecisionAt: st.lastDecisionAt,
    };
  }

  return {
    async start() {
      if (store) { try { const raw = await store.get(); if (raw) restore(raw); } catch (e) { st.lastSaveError = 'load ' + e.message; } }
      st.positions = st.positions.filter((p) => !excluded(p.mint));
      await refreshBalance();
      timers.push(setInterval(tick, 5000), setInterval(refreshBalance, 120e3), setInterval(() => reconcile().catch(() => {}), 600e3));
      if (cfg.mode === 'live') reconcile().catch(() => {}); timers.forEach((x) => x.unref?.());
      log(`[agent] ${cfg.mode.toUpperCase()} ${cfg.enabled ? 'enabled' : 'DISABLED'} wallet ${address || 'none'}; excludes ${[...cfg.exclude].join(',') || 'none'}${st.halted ? '; HALTED: ' + st.halted : ''}`);
    },
    stop() { timers.forEach(clearInterval); }, save: () => save(true), onTrade, status, tick, cfg, st,
    _test: { reconcile, signal, gate, buildPortalTx, simulateGuard, openPosition, closePosition, checkExit, scanAndEnter },
  };
}

module.exports = { createAgent, ACFG, parseSecret, signal, gate, DEV_WALLET };
