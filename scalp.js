// Bot-Volume Scalper + Ride-to-Bonding — PAPER TRADING ONLY (no wallet, no keys, no transactions are ever sent).
// Data: pump.fun program logs from a free public Solana RPC websocket (logsSubscribe "mentions" the pump program).
// Every pump.fun TradeEvent carries mint, SOL, tokens, side, wallet and the post-trade virtual reserves, so price,
// slippage and market cap come straight from the constant-product curve. 0 Helius credits.
// (PumpPortal's subscribeTokenTrade needs an API key funded with >=0.02 SOL, so it is not used.)
//
// Many shadow variants run on the SAME price stream: entry rule x strictness x size x TP x SL x time stop for the
// scalper, and target MC x SL x max hold x size for ride-to-bonding. Each variant has its own capacity/cooldown/P&L.
const WebSocket = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');
const bs58m = require('bs58'); const b58 = (bs58m.default || bs58m).encode;

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const list = (k, d) => (process.env[k] ? process.env[k].split(',').map(Number) : d);
const SCFG = () => ({
  wsUrl: process.env.SCALP_WS_URL || 'wss://api.mainnet-beta.solana.com',
  feePct: num('SCALP_FEE_PCT', 1.25),        // pump.fun bonding curve: 0.95% protocol + 0.30% creator = 1.25% per side (pump.fun/docs/fees, 17 Oct 2026)
  txFeeSol: num('SCALP_TX_FEE_SOL', 0.0005),  // base fee + priority fee per tx (assumption)
  latencyMs: num('SCALP_LATENCY_MS', 1500),   // fill at the first trade seen >= this long after the decision (else latest reserves 3 s later)
  maxOpen: num('SCALP_MAX_OPEN', 5),          // concurrent positions per variant
  cooldownMin: num('SCALP_COOLDOWN_MIN', 10), // per variant per mint, after a close
  tp: list('SCALP_TP', [5, 10, 15, 20, 30, 50]),
  sl: list('SCALP_SL', [5, 10, 15, 25, 0]),   // 0 = no stop loss
  tmin: list('SCALP_TIME_MIN', [2, 5, 10, 30]),
  sizes: list('SCALP_SIZES', [0.05, 0.1, 0.25]),
  rideTargets: list('RIDE_TARGETS_USD', [30000, 40000, 50000]),
  rideSl: list('RIDE_SL', [20, 35, 50]),
  rideHold: list('RIDE_HOLD_MIN', [30, 60, 120]),
  primary: process.env.SCALP_PRIMARY || 'R1-L2-0.1-tp10-sl10-t5',
  ridePrimary: process.env.RIDE_PRIMARY || 'RIDE-0.1-40k-sl35-h60',
  saveMin: num('SCALP_SAVE_MIN', 10),
  maxLagMs: num('SCALP_MAX_LAG_MS', 250),
});
const DISC = crypto.createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);
const DISC_B64 = DISC.toString('base64').slice(0, 10);
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOTAL_SUPPLY = 1e9;
const r4 = (x) => Math.round(x * 1e4) / 1e4, r6 = (x) => Math.round(x * 1e6) / 1e6, r1 = (x) => Math.round(x * 10) / 10;
const mean = (a) => a.reduce((t, x) => t + x, 0) / (a.length || 1);
const cv = (a) => { if (a.length < 2) return 1; const m = mean(a); return m ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m : 1; };

// ---- decoding
function decodeTrade(b64) {
  const d = Buffer.from(b64, 'base64');
  if (d.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32 || !d.subarray(0, 8).equals(DISC)) return null;
  let o = 8; const mint = b58(d.subarray(o, o + 32)); o += 32;
  const sol = Number(d.readBigUInt64LE(o)) / 1e9; o += 8; const tok = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const buy = d[o] === 1; o += 1; const user = b58(d.subarray(o, o + 32)); o += 32; const ts = Number(d.readBigInt64LE(o)); o += 8;
  const vs = Number(d.readBigUInt64LE(o)) / 1e9; o += 8; const vt = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  let realTok = null; if (d.length >= o + 16) { o += 8; realTok = Number(d.readBigUInt64LE(o)) / 1e6; }
  return { mint, sol, tok, buy, user, ts, vs, vt, realTok };
}
const LOG_RE = /Program data: ([A-Za-z0-9+/=]+)/g;
function tradesFromMessage(str) {
  if (str.indexOf('"err":null') < 0) return [];
  const out = []; LOG_RE.lastIndex = 0; let m;
  while ((m = LOG_RE.exec(str))) if (m[1].startsWith(DISC_B64)) { const t = decodeTrade(m[1]); if (t) out.push(t); }
  return out;
}
const solCurve = (t) => t.vs >= 29.9 && t.vs <= 130 && t.vt > 250e6 && t.vt <= 1.0731e9; // SOL-paired bonding curve only

// ---- curve math (constant product on virtual reserves; fees per pump.fun: buy fee on SOL in, sell fee on SOL out)
function buyFill(vs, vt, size, cfg) { const solIn = size / (1 + cfg.feePct / 100); const tok = vt - (vs * vt) / (vs + solIn); return { solIn, tok, cost: size + cfg.txFeeSol }; }
// Sell into the observed reserves PLUS our own earlier buy (which the observed stream does not contain).
function sellValue(vs, vt, pos, cfg) { const vs2 = vs + pos.solIn, vt2 = vt - pos.tok; if (vt2 <= 0) return 0; const gross = (vs2 * pos.tok) / (vt2 + pos.tok); return gross * (1 - cfg.feePct / 100) - cfg.txFeeSol; }
const progressPct = (vt) => Math.max(0, Math.min(100, ((1073e6 - vt) / 793.1e6) * 100));

// ---- signal features
function features(m, now, winMs) {
  const w = m.trades.filter((t) => t.at >= now - winMs); if (!w.length) return null;
  const buys = w.filter((t) => t.buy), sells = w.filter((t) => !t.buy);
  const buySol = buys.reduce((a, t) => a + t.sol, 0), sellSol = sells.reduce((a, t) => a + t.sol, 0);
  const side = new Map(); w.forEach((t) => { const s = side.get(t.user) || { b: 0, s: 0, n: 0 }; t.buy ? s.b++ : s.s++; s.n++; side.set(t.user, s); });
  let loopN = 0; for (const s of side.values()) if (s.b && s.s) loopN += s.n;
  const cnt = new Map(); buys.forEach((t) => { const k = t.sol.toFixed(3); cnt.set(k, (cnt.get(k) || 0) + 1); });
  const sameSize = buys.length >= 5 ? Math.max(...cnt.values()) / buys.length : 0;
  // clock-rhythm wallets: >=4 trades in the 5 min ring with very regular spacing
  const byW = new Map(); m.trades.forEach((t) => { if (!byW.has(t.user)) byW.set(t.user, []); byW.get(t.user).push(t.at); });
  const rhythm = new Set(); for (const [u, a] of byW) if (a.length >= 4) { const iv = a.slice(1).map((x, i) => x - a[i]); if (cv(iv) <= 0.3 && mean(iv) >= 1500) rhythm.add(u); }
  const botTx = w.filter((t) => rhythm.has(t.user)).length;
  const first = w[0], last = w[w.length - 1];
  const p0 = first.pvs / first.pvt, p1 = last.vs / last.vt; // price before the first trade in the window -> after the last
  return { n: w.length, buys: buys.length, sells: sells.length, buySol: r4(buySol), sellSol: r4(sellSol), net: r4(buySol - sellSol), vol: r4(buySol + sellSol),
    uniqueBuyers: new Set(buys.map((t) => t.user)).size, loopShare: r4(loopN / w.length), sameSize: r4(sameSize), botTxShare: r4(botTx / w.length), rhythmWallets: rhythm.size,
    chgPct: r1((p1 / p0 - 1) * 100), progress: r1(progressPct(last.vt)), mcSol: r1((last.vs / last.vt) * TOTAL_SUPPLY) };
}
// Scalper entry rules. Strictness L1 (loose) / L2 (medium) / L3 (strict). Returns the highest level met (0 = none) for each rule.
const LV = { n: [12, 20, 30], vol: [1, 2, 4], loop: [0.3, 0.4, 0.5], same: [0.25, 0.35, 0.45], bot: [0.25, 0.35, 0.45], flags: [1, 1, 2],
  upMin: [2, 3, 5], net: [0.2, 0.5, 1], dipMin: [4, 6, 8] };
function scalpLevels(f) {
  const res = { R1: 0, R2: 0 }; if (!f || f.progress < 3 || f.progress > 90) return res;
  for (let L = 0; L < 3; L++) {
    if (f.n < LV.n[L] || f.vol < LV.vol[L]) break;
    const flags = (f.loopShare >= LV.loop[L]) + (f.sameSize >= LV.same[L]) + (f.botTxShare >= LV.bot[L]);
    if (flags < LV.flags[L]) break;
    if (f.chgPct >= LV.upMin[L] && f.chgPct <= 30 && f.net >= LV.net[L]) res.R1 = L + 1;
    if (f.chgPct <= -LV.dipMin[L] && f.chgPct >= -30 && f.loopShare >= LV.loop[L]) res.R2 = L + 1;
  }
  return res;
}
// Ride-to-bonding entry: organic-looking demand over 3 minutes.
const RIDE = { minUniqueBuyers: num('RIDE_MIN_BUYERS', 15), minBuySol: num('RIDE_MIN_BUY_SOL', 5), minNet: num('RIDE_MIN_NET_SOL', 3), minBuySellRatio: 1.5,
  maxLoop: 0.25, maxSame: 0.3, maxBot: 0.2, minProg: 10, maxProg: 75 };
function rideOk(f) {
  return !!f && f.uniqueBuyers >= RIDE.minUniqueBuyers && f.buySol >= RIDE.minBuySol && f.net >= RIDE.minNet && f.buySol >= RIDE.minBuySellRatio * Math.max(f.sellSol, 0.01)
    && f.loopShare <= RIDE.maxLoop && f.sameSize <= RIDE.maxSame && f.botTxShare <= RIDE.maxBot && f.progress >= RIDE.minProg && f.progress <= RIDE.maxProg;
}

function newVariant(o) { return { ...o, open: 0, openMints: new Set(), cool: new Map(), n: 0, wins: 0, net: 0, sumWin: 0, sumLoss: 0, equity: 0, peak: 0, maxDD: 0, reasons: {} }; }
function buildVariants(cfg) {
  const v = new Map();
  for (const rule of ['R1', 'R2']) for (const L of [1, 2, 3]) for (const size of cfg.sizes) for (const tp of cfg.tp) for (const sl of cfg.sl) for (const t of cfg.tmin) {
    const key = `${rule}-L${L}-${size}-tp${tp}-sl${sl || 'none'}-t${t}`;
    v.set(key, newVariant({ key, kind: 'scalp', rule, level: L, size, tp, sl, tmin: t }));
  }
  for (const size of cfg.sizes) for (const tgt of cfg.rideTargets) for (const sl of cfg.rideSl) for (const h of cfg.rideHold) {
    const key = `RIDE-${size}-${tgt / 1000}k-sl${sl}-h${h}`; v.set(key, newVariant({ key, kind: 'ride', rule: 'RIDE', level: 0, size, target: tgt, sl, tmin: h }));
  }
  return v;
}
const vSummary = (v) => ({ key: v.key, kind: v.kind, trades: v.n, winRate: v.n ? r1((v.wins / v.n) * 100) : null, netSol: r6(v.net), avgWin: v.wins ? r6(v.sumWin / v.wins) : null,
  avgLoss: v.n - v.wins ? r6(v.sumLoss / (v.n - v.wins)) : null, maxDrawdownSol: r6(v.maxDD), open: v.open, exits: v.reasons });

function createScalper({ store = null, symbolOf = () => null, log = console.log, WS = WebSocket, now = () => Date.now(), onTradeHook = null } = {}) {
  const cfg = SCFG();
  const variants = buildVariants(cfg);
  const groups = new Map(); for (const v of variants.values()) { const g = v.kind === 'ride' ? 'RIDE' : `${v.rule}-${v.level}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(v); }
  const mints = new Map();      // mint -> { trades[], vs, vt, lastAt, lastEval, rideDone }
  const positions = new Map();  // mint -> [pos]
  const pendingEntries = [];    // { mint, kind, rule, level, at, signalAt, feat, vlist }
  const logs = { primary: [], ride: [], signals: [] };
  const st = { startedAt: new Date(now()).toISOString(), ws: { connected: false, connects: 0, msgs: 0, trades: 0, bytes: 0, lastAt: null, lastError: null, pausedUntil: null, pauses: 0 },
    signals: { R1: [0, 0, 0], R2: [0, 0, 0], RIDE: 0 }, entries: 0, skippedFull: 0, closes: 0, solUsd: null, solUsdAt: null, solUsdSrc: null, lagMs: 0, saves: 0, lastSaveAt: null, lastSaveError: null, restoredFrom: null };
  let ws = null, backoff = 2000, timers = [], stopped = false, lastSave = 0;
  // symbols: from the caller (radar's PumpPortal create stream) or resolved later on DexScreener (free) for logged trades only
  const syms = new Map(); const symOf = (m) => syms.get(m) || symbolOf(m) || null;
  async function resolveSymbols() {
    const recs = [...logs.primary, ...logs.ride, ...logs.signals];
    recs.forEach((r) => { if (!r.symbol) r.symbol = symOf(r.mint); });
    const need = [...new Set(recs.filter((r) => !r.symbol).map((r) => r.mint))].slice(0, 30); if (!need.length) return;
    try { const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${need.join(',')}`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) return;
      for (const p of await r.json()) if (p.baseToken?.address && p.baseToken.symbol) syms.set(p.baseToken.address, p.baseToken.symbol);
      recs.forEach((x) => { if (!x.symbol) x.symbol = syms.get(x.mint) || null; }); } catch {}
  }

  // ---- restore aggregates
  function restore(raw) {
    try {
      const j = JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString());
      for (const [key, a] of Object.entries(j.v || {})) { const v = variants.get(key); if (!v) continue; [v.n, v.wins, v.net, v.sumWin, v.sumLoss, v.equity, v.peak, v.maxDD] = a.slice(0, 8); v.reasons = a[8] || {}; }
      Object.assign(logs, { primary: j.primary || [], ride: j.ride || [], signals: j.signals || [] });
      if (j.st) { st.signals = j.st.signals || st.signals; st.entries = j.st.entries || 0; st.closes = j.st.closes || 0; st.startedAt = j.st.startedAt || st.startedAt; }
      st.restoredFrom = j.savedAt || 'unknown';
    } catch (e) { log('[scalp] restore failed:', e.message); }
  }
  function snapshot() {
    const v = {}; for (const x of variants.values()) if (x.n) v[x.key] = [x.n, x.wins, r6(x.net), r6(x.sumWin), r6(x.sumLoss), r6(x.equity), r6(x.peak), r6(x.maxDD), x.reasons];
    const j = { savedAt: new Date(now()).toISOString(), v, primary: logs.primary.slice(0, 60), ride: logs.ride.slice(0, 60), signals: logs.signals.slice(0, 30), st: { signals: st.signals, entries: st.entries, closes: st.closes, startedAt: st.startedAt } };
    return zlib.gzipSync(JSON.stringify(j)).toString('base64');
  }
  async function save(force = false) {
    if (!store || (!force && now() - lastSave < cfg.saveMin * 60e3)) return; lastSave = now();
    try { await store.put(snapshot()); st.saves++; st.lastSaveAt = new Date(now()).toISOString(); st.lastSaveError = null; } catch (e) { st.lastSaveError = e.message; }
  }

  // ---- SOL/USD (free sources)
  async function solPrice() {
    const srcs = [['coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', (j) => j.solana.usd],
      ['kraken', 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD', (j) => Number(Object.values(j.result)[0].c[0])],
      ['dexscreener', 'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', (j) => Number(j.pairs.find((p) => /USD/.test(p.quoteToken.symbol)).priceUsd)]];
    for (const [name, u, f] of srcs) { try { const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); if (!r.ok) continue; const p = f(await r.json()); if (p > 1) { st.solUsd = p; st.solUsdAt = new Date(now()).toISOString(); st.solUsdSrc = name; return p; } } catch {} }
    return null;
  }

  // ---- positions
  const fmt = (t) => new Date(t).toISOString();
  function openPositions(e, m) {
    let opened = 0;
    for (const v of e.vlist) {
      if (v.open >= cfg.maxOpen || v.openMints.has(e.mint) || (v.cool.get(e.mint) || 0) > now()) continue;
      if (v.kind === 'ride' && m.mcSol * st.solUsd >= v.target * 0.8) continue; // target too close to bother
      const f = buyFill(m.vs, m.vt, v.size, cfg);
      const pos = { v, mint: e.mint, ...f, openAt: now(), signalAt: e.signalAt, entryVs: m.vs, entryVt: m.vt, entryMcSol: m.mcSol, peakPct: -100, pending: null, feat: e.feat };
      if (!positions.has(e.mint)) positions.set(e.mint, []); positions.get(e.mint).push(pos);
      v.open++; v.openMints.add(e.mint); opened++;
    }
    if (opened) { st.entries++; logs.signals.unshift({ at: fmt(e.signalAt), mint: e.mint, symbol: symOf(e.mint), kind: e.kind, rule: e.rule, level: e.level, feat: e.feat, filledAt: fmt(now()), entryMcSol: r1(m.mcSol), variants: opened }); logs.signals.length = Math.min(logs.signals.length, 40); }
  }
  function closePos(pos, m, reason) {
    const v = pos.v, proceeds = sellValue(m.vs, m.vt, pos, cfg), pnl = proceeds - pos.cost;
    v.open--; v.openMints.delete(pos.mint); v.cool.set(pos.mint, now() + (v.kind === 'ride' ? 864e5 : cfg.cooldownMin * 60e3));
    v.n++; v.net += pnl; v.equity += pnl; if (pnl > 0) { v.wins++; v.sumWin += pnl; } else v.sumLoss += pnl;
    v.peak = Math.max(v.peak, v.equity); v.maxDD = Math.max(v.maxDD, v.peak - v.equity); v.reasons[reason] = (v.reasons[reason] || 0) + 1;
    st.closes++;
    if (v.key === cfg.primary || v.key === cfg.ridePrimary) {
      const rec = { mint: pos.mint, symbol: symOf(pos.mint), variant: v.key, entryAt: fmt(pos.openAt), exitAt: fmt(now()), holdSec: Math.round((now() - pos.openAt) / 1000), reason,
        sizeSol: v.size, entryPrice: r6((pos.solIn / pos.tok) * 1e6), exitPrice: r6((m.vs / m.vt) * 1e6), entryMcSol: r1(pos.entryMcSol), exitMcSol: r1(m.mcSol),
        grossPct: r1((m.vs / m.vt / (pos.entryVs / pos.entryVt) - 1) * 100), netSol: r6(pnl), netPct: r1((pnl / pos.cost) * 100) };
      (v.kind === 'ride' ? logs.ride : logs.primary).unshift(rec); for (const k of ['ride', 'primary']) logs[k].length = Math.min(logs[k].length, 200);
    }
  }
  function checkExits(mint, m, fresh) {
    const arr = positions.get(mint); if (!arr) return;
    const t = now(), keep = [];
    for (const pos of arr) {
      const v = pos.v;
      if (pos.pending && t >= pos.pending.at && (fresh || t >= pos.pending.at + 3000)) { closePos(pos, m, pos.pending.reason); continue; }
      if (!pos.pending) {
        if (m.complete) { pos.pending = { reason: 'graduated', at: t }; closePos(pos, m, 'graduated'); continue; }
        const pnlPct = ((sellValue(m.vs, m.vt, pos, cfg) - pos.cost) / pos.cost) * 100;
        let reason = null;
        if (v.kind === 'scalp' && pnlPct >= v.tp) reason = 'tp';
        else if (v.kind === 'ride' && st.solUsd && m.mcSol * st.solUsd >= v.target) reason = 'target';
        else if (v.sl && pnlPct <= -v.sl) reason = 'sl';
        else if (t - pos.openAt >= v.tmin * 60e3) reason = 'time';
        if (reason) pos.pending = { reason, at: t + cfg.latencyMs };
      }
      keep.push(pos);
    }
    if (keep.length) positions.set(mint, keep); else positions.delete(mint);
  }

  // ---- stream
  function onTrade(tr) {
    if (!solCurve(tr)) return;
    const t = now(); st.ws.trades++;
    let m = mints.get(tr.mint);
    if (!m) { m = { trades: [], vs: tr.vs, vt: tr.vt, lastAt: t, lastEval: 0, rideDone: false }; mints.set(tr.mint, m); }
    // pre-trade reserves for the price-change window
    const pvs = tr.buy ? tr.vs - tr.sol : tr.vs + tr.sol, pvt = tr.buy ? tr.vt + tr.tok : tr.vt - tr.tok;
    m.trades.push({ at: t, sol: tr.sol, buy: tr.buy, user: tr.user, vs: tr.vs, vt: tr.vt, pvs, pvt });
    while (m.trades.length > 400 || (m.trades.length && m.trades[0].at < t - 300e3)) m.trades.shift();
    m.vs = tr.vs; m.vt = tr.vt; m.lastAt = t; m.mcSol = (tr.vs / tr.vt) * TOTAL_SUPPLY; m.complete = tr.realTok === 0 || tr.vt <= 279.95e6;
    // fills waiting for "the next trade after latency"
    for (let i = pendingEntries.length - 1; i >= 0; i--) { const e = pendingEntries[i]; if (e.mint === tr.mint && t >= e.at) { pendingEntries.splice(i, 1); if (!m.complete) openPositions(e, m); } }
    checkExits(tr.mint, m, true);
    if (onTradeHook) { try { onTradeHook(tr, m); } catch (e) { log('[scalp] trade hook error ' + e.message); } } // AI trader agent shares this stream
    if (t - m.lastEval >= 2000 && !m.complete) { m.lastEval = t; evaluate(tr.mint, m, t); }
  }
  function evaluate(mint, m, t) {
    const f = features(m, t, 60e3); const lv = scalpLevels(f);
    for (const rule of ['R1', 'R2']) for (let L = 1; L <= lv[rule]; L++) {
      const vlist = groups.get(`${rule}-${L}`).filter((v) => v.open < cfg.maxOpen && !v.openMints.has(mint) && (v.cool.get(mint) || 0) <= t);
      if (!vlist.length || pendingEntries.some((e) => e.mint === mint && e.rule === rule && e.level === L)) continue;
      st.signals[rule][L - 1]++; pendingEntries.push({ mint, kind: 'scalp', rule, level: L, signalAt: t, at: t + cfg.latencyMs, feat: f, vlist });
    }
    if (!m.rideDone && st.solUsd) {
      const f3 = features(m, t, 180e3);
      if (rideOk(f3)) { m.rideDone = true; st.signals.RIDE++; pendingEntries.push({ mint, kind: 'ride', rule: 'RIDE', level: 0, signalAt: t, at: t + cfg.latencyMs, feat: f3, vlist: groups.get('RIDE') }); }
    }
  }
  function tick() {
    const t = now();
    for (let i = pendingEntries.length - 1; i >= 0; i--) { const e = pendingEntries[i]; if (t >= e.at + 3000) { pendingEntries.splice(i, 1); const m = mints.get(e.mint); if (m && !m.complete) openPositions(e, m); } }
    for (const [mint] of positions) checkExits(mint, mints.get(mint), false);
    for (const [mint, m] of mints) if (t - m.lastAt > 600e3 && !positions.has(mint)) mints.delete(mint);
    save();
  }
  function onMessage(buf) { st.ws.msgs++; st.ws.bytes += buf.length; const s = buf.toString(); const tr = tradesFromMessage(s); if (tr.length) st.ws.lastAt = new Date(now()).toISOString(); tr.forEach(onTrade); }

  function connect() {
    if (stopped) return;
    if (st.ws.pausedUntil && now() < Date.parse(st.ws.pausedUntil)) return void setTimeout(connect, Date.parse(st.ws.pausedUntil) - now());
    ws = new WS(cfg.wsUrl, { handshakeTimeout: 15000, perMessageDeflate: false });
    let ping = null, lastMsg = now();
    ws.on('open', () => { st.ws.connected = true; st.ws.connects++; backoff = 2000; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }));
      ping = setInterval(() => { try { ws.ping(); } catch {} if (now() - lastMsg > 90e3) { st.ws.lastError = 'stalled'; ws.terminate(); } }, 30000); });
    ws.on('message', (b) => { lastMsg = now(); onMessage(b); });
    ws.on('error', (e) => { st.ws.lastError = e.message; });
    ws.on('close', (c) => { clearInterval(ping); st.ws.connected = false; st.ws.lastError ||= 'closed ' + c; if (!stopped) setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 120e3); });
  }
  // CPU guard: if the event loop lags (Render free = 0.1 CPU), pause the stream for 5 min so the radar is never starved.
  let lagSlow = 0, lastTick = now();
  function lagCheck() {
    const t = now(); const lag = Math.max(0, t - lastTick - 1000); lastTick = t;
    if (lag > 30e3) { st.clockJumps = (st.clockJumps || 0) + 1; return; } // host was suspended / clock jump, not CPU starvation st.lagMs = Math.round(st.lagMs * 0.8 + lag * 0.2);
    if (st.lagMs > cfg.maxLagMs && st.ws.connected) { if (++lagSlow >= 10) { lagSlow = 0; st.ws.pauses++; st.ws.pausedUntil = new Date(t + 300e3).toISOString(); st.ws.lastError = `paused: event-loop lag ${st.lagMs}ms`; log('[scalp] ' + st.ws.lastError); try { ws.close(); } catch {} } }
    else lagSlow = 0;
  }

  function ranking(kind, n = 10, minTrades = 3) {
    return [...variants.values()].filter((v) => v.kind === kind && v.n >= minTrades).sort((a, b) => b.net - a.net || b.n - a.n).slice(0, n).map(vSummary);
  }
  function totals(kind) {
    const vs = [...variants.values()].filter((v) => v.kind === kind);
    const active = vs.filter((v) => v.n); return { variants: vs.length, withTrades: active.length, profitable: active.filter((v) => v.net > 0).length, simulatedTrades: active.reduce((a, v) => a + v.n, 0) };
  }

  return {
    async start() {
      if (store) { try { const raw = await store.get(); if (raw) restore(raw); } catch (e) { st.lastSaveError = 'load ' + e.message; } }
      await solPrice();
      timers.push(setInterval(tick, 1000), setInterval(resolveSymbols, 60e3), setInterval(lagCheck, 1000), setInterval(solPrice, 300e3));
      timers.forEach((x) => x.unref?.());
      connect(); log(`[scalp] paper trader on ${cfg.wsUrl}: ${variants.size} variants, fee ${cfg.feePct}%/side + ${cfg.txFeeSol} SOL/tx, latency ${cfg.latencyMs} ms, SOL $${st.solUsd}`);
    },
    stop() { stopped = true; timers.forEach(clearInterval); try { ws?.close(); } catch {} },
    solUsd: () => st.solUsd, symbol: (m) => symOf(m), streamInfo: () => ({ connected: st.ws.connected, lastAt: st.ws.lastAt, pausedUntil: st.ws.pausedUntil, mintsTracked: mints.size }),
    save: () => save(true), resolveSymbols, onTrade, onMessage, tick, variants, logs,
    status() {
      const prim = variants.get(cfg.primary), rp = variants.get(cfg.ridePrimary);
      const openNow = [...positions.values()].reduce((a, x) => a + x.length, 0);
      return { mode: 'paper', startedAt: st.startedAt, restoredFrom: st.restoredFrom, now: new Date(now()).toISOString(),
        assumptions: { feePctPerSide: cfg.feePct, txFeeSol: cfg.txFeeSol, latencyMs: cfg.latencyMs, maxOpenPerVariant: cfg.maxOpen, cooldownMin: cfg.cooldownMin, solUsd: st.solUsd, solUsdSrc: st.solUsdSrc, solUsdAt: st.solUsdAt,
          roundTripCostPctAt: Object.fromEntries(cfg.sizes.map((s) => [s, r1((1 - (1 - cfg.feePct / 100) / (1 + cfg.feePct / 100)) * 100 + (2 * cfg.txFeeSol / s) * 100)])) },
        rules: { scalp: { windowSec: 60, levels: LV, R1: 'bot volume + price up (momentum) + net SOL in', R2: 'bot volume (looping wallets) + price dip (mean reversion)' }, ride: { windowSec: 180, ...RIDE } },
        stream: { ...st.ws, mintsTracked: mints.size, lagMs: st.lagMs }, signals: st.signals, entries: st.entries, closes: st.closes, openPositions: openNow, pendingEntries: pendingEntries.length,
        primary: prim ? vSummary(prim) : null, ridePrimary: rp ? vSummary(rp) : null,
        scalp: { totals: totals('scalp'), top10: ranking('scalp'), worst3: [...variants.values()].filter((v) => v.kind === 'scalp' && v.n >= 3).sort((a, b) => a.net - b.net).slice(0, 3).map(vSummary) },
        ride: { totals: totals('ride'), top10: ranking('ride', 10, 1) },
        persistence: store ? { backend: store.name, saves: st.saves, lastSaveAt: st.lastSaveAt, lastSaveError: st.lastSaveError } : { backend: 'memory' } };
    },
    trades: () => ({ primaryVariant: cfg.primary, ridePrimaryVariant: cfg.ridePrimary, scalp: logs.primary, ride: logs.ride, signals: logs.signals }),
    variant: (key) => { const v = variants.get(key); return v ? vSummary(v) : null; },
  };
}

// Render env-var store (same pattern as state.js, separate key so the radar's RADAR_STATE is never touched).
function renderEnvStore(key = process.env.SCALP_STATE_KEY || 'SCALP_STATE') {
  const API_KEY = process.env.STATE_RENDER_API_KEY || '', SERVICE = process.env.RENDER_SERVICE_ID || process.env.STATE_RENDER_SERVICE_ID || '';
  if (!API_KEY || !SERVICE || process.env.STATE_BACKEND === 'memory') return null;
  const url = `https://api.render.com/v1/services/${SERVICE}/env-vars/${key}`;
  const headers = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'application/json' };
  return { name: 'render-env:' + key,
    async get() { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return (await r.json()).value; },
    async put(value) { const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ value }), signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('HTTP ' + r.status); } };
}

module.exports = { createScalper, renderEnvStore, decodeTrade, tradesFromMessage, buyFill, sellValue, features, scalpLevels, rideOk, buildVariants, SCFG, DISC };
