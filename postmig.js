// ALMA post-migration SHADOW arm (research C, pre-registered 2026-10-25 02:58 CEST). PAPER ONLY BY CONSTRUCTION:
// no wallet, no keys, no executor, no transactions. It watches PumpSwap pool logs for coins that just graduated
// and computes what the frozen strategies would have made (same cost model as the box research engine).
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const bs58m = require('bs58'); const b58 = (bs58m.default || bs58m).encode;
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const ev = (n) => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8);
const DB = ev('BuyEvent'), DS = ev('SellEvent');
const FEE_AMM_CREATOR = 0.003, NET_TX = 0.000025, SIZE = 0.02;
const TR = [15, 10];
const VARIANTS = [ // frozen (alma-research/C/PREREG.md); F0 is the primary
  { id: 'F0_P5', delay: 30, cond: 'none', thr: 0, tp: 50, sl: 20, trail: TR, hold: 2 },
  { id: 'F1_tp30', delay: 30, cond: 'none', thr: 0, tp: 30, sl: 20, trail: TR, hold: 2 },
  { id: 'F1b_d10', delay: 10, cond: 'none', thr: 0, tp: 50, sl: 20, trail: TR, hold: 2 },
  { id: 'F2_d120', delay: 120, cond: 'none', thr: 0, tp: 50, sl: 20, trail: TR, hold: 2 },
  { id: 'F3_P1nowhale', delay: 30, cond: 'nowhale', thr: 20, tp: 50, sl: 20, trail: TR, hold: 2 },
];
const BASE = { lat_in: 3000, lat_out: 2000, hair: 0.002 };
const SETTLE_MS = 300e3; // every variant has exited by grad + delay(<=120 s) + lat + hold(2 min) + lat
const r6 = (x) => Math.round(x * 1e6) / 1e6, r1 = (x) => Math.round(x * 10) / 10;
const pools = new Map();
function poolOf(mint) {
  if (pools.has(mint)) return pools.get(mint);
  const m = new PublicKey(mint);
  const pa = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], new PublicKey(PUMP))[0];
  const p = PublicKey.findProgramAddressSync([Buffer.from('pool'), Buffer.alloc(2), pa.toBuffer(), m.toBuffer(), WSOL.toBuffer()], new PublicKey(PAMM))[0].toBase58();
  pools.set(mint, p); if (pools.size > 5000) pools.delete(pools.keys().next().value); return p;
}
// PumpSwap Buy/Sell event -> post-trade reserves (event reserves are PRE-trade)
function decodePoolEvent(b64) {
  const d = Buffer.from(b64, 'base64'); if (d.length < 184) return null;
  const h = d.subarray(0, 8); const buy = h.equals(DB) ? 1 : h.equals(DS) ? 0 : -1; if (buy < 0) return null;
  const u = (i) => Number(d.readBigUInt64LE(8 + 8 * i));
  const base = u(1) / 1e6, quote = u(7) / 1e9, bres = u(5) / 1e6, qres = u(6) / 1e9;
  if (bres <= 0) return null;
  const bp = buy ? bres - base : bres + base, qp = buy ? qres + quote : qres - quote;
  return { buy, base, quote, bp, qp, pool: b58(d.subarray(120, 152)), user: b58(d.subarray(152, 184)), feeBps: u(8) + u(10) };
}
const LOG_RE = /Program data: ([A-Za-z0-9+/=]+)/g;
function poolEventsFromLogs(logs) { const out = []; let m; const s = logs.join('\n'); LOG_RE.lastIndex = 0; while ((m = LOG_RE.exec(s))) { const e = decodePoolEvent(m[1]); if (e) out.push(e); } return out; }
const ammSell = (base, quote, tok, feeBps, hair) => quote * tok / (base + tok) * (1 - (feeBps / 1e4 + FEE_AMM_CREATOR)) * (1 - hair) - NET_TX;
const ammBuy = (base, quote, size, feeBps, hair) => { const q = size / (1 + feeBps / 1e4 + FEE_AMM_CREATOR) - NET_TX; return base * q / (quote + q) * (1 - hair); };
const lowerBound = (a, x, lo = 0) => { let hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
// Port of pm_sim (alma-research/B/src/structural.py). ev: [{at, buy, quote, bp, qp, user, feeBps}] sorted by at. Returns null | {skip} | {tIn, tOut, ret, why}
function pmSim(E, P, S = BASE) {
  const evs = E.ev, ts = evs.map((e) => e.at), px = (e) => e.qp / e.bp;
  const tDec = E.grad + P.delay * 1000; const k0 = lowerBound(ts, E.grad), kd = lowerBound(ts, tDec);
  if (kd >= evs.length || k0 >= evs.length) return null;
  const win = evs.slice(k0, kd); if (!win.length) return null;
  const pDec = px(evs[kd - 1]);
  const maxbuy = Math.max(0, ...win.filter((e) => e.buy).map((e) => e.quote));
  if (P.cond === 'nowhale' && !(maxbuy < P.thr)) return null;
  if (P.cond === 'whale' && !(maxbuy >= P.thr)) return null;
  const k = lowerBound(ts, tDec + S.lat_in); if (k >= evs.length) return null;
  const e = evs[k]; if (px(e) > pDec * 1.025) return { skip: 'slippage' };
  const tok = ammBuy(e.bp, e.qp, SIZE, e.feeBps, S.hair), tIn = e.at; let peak = -1;
  const qIn = SIZE / (1 + e.feeBps / 1e4 + FEE_AMM_CREATOR);
  const val = (y) => ammSell(y.bp - tok, y.qp + qIn, tok, y.feeBps, S.hair) / SIZE - 1;
  for (let j = k + 1; j < evs.length; j++) {
    const x = evs[j]; const r = val(x); peak = Math.max(peak, r); let why = null;
    if (r <= -P.sl / 100) why = 'sl'; else if (r >= P.tp / 100) why = 'tp';
    else if (P.trail && peak >= P.trail[0] / 100 && r <= peak - P.trail[1] / 100) why = 'trail';
    else if (x.at - tIn >= P.hold * 60e3) why = 'time';
    if (why) { const kk = Math.min(lowerBound(ts, x.at + S.lat_out, j), evs.length - 1); const y = evs[kk]; return { tIn, tOut: y.at, ret: val(y), why }; }
  }
  const y = evs[evs.length - 1]; return { tIn, tOut: y.at + 60e3, ret: val(y), why: 'end' };
}
const fresh = (t) => ({ since: new Date(t).toISOString(), prereg: 'alma-research/C/PREREG.md', grads: 0, excluded: 0, settled: 0, noData: 0, byVar: {}, closed: [] });
function createPostmig({ WS = require('ws'), wsUrl = process.env.POSTMIG_WS_URL || process.env.SCALP_WS_URL || 'wss://api.mainnet-beta.solana.com', now = () => Date.now(), log = console.log,
  getState = null, isExcluded = () => false, maxWatch = 12 } = {}) {
  let local = null; const state = () => { if (getState) { const s = getState(); if (s) return s; } return local || (local = fresh(now())); };
  const seen = new Map(); // mint -> graduation time (dedupe)
  const watch = new Map(); // pool -> { mint, grad, pc, creator, ev: [], subId, reqId }
  const byReq = new Map(), bySub = new Map(); let ws = null, reqId = 1, connected = false, stopped = false, msgs = 0, failedTx = 0, events = 0, lastErr = null;
  function send(o) { if (ws && connected) { try { ws.send(JSON.stringify(o)); } catch (e) { lastErr = e.message; } } }
  function subscribe(pool) { const w = watch.get(pool); if (!w) return; const id = ++reqId; w.reqId = id; byReq.set(id, pool); send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] }); }
  function unsubscribe(w) { if (w.subId != null) { bySub.delete(w.subId); send({ jsonrpc: '2.0', id: ++reqId, method: 'logsUnsubscribe', params: [w.subId] }); } }
  function connect() {
    if (stopped) return; ws = new WS(wsUrl, { perMessageDeflate: false });
    ws.on('open', () => { connected = true; byReq.clear(); bySub.clear(); for (const [p, w] of watch) { w.subId = null; subscribe(p); } });
    ws.on('message', (b) => { msgs++; const str = b.toString(); if (str.includes('logsNotification') && !str.includes('"err":null')) { failedTx++; return; } try { onMsg(JSON.parse(str)); } catch {} }); // failed txs skipped before parsing (bot spam)
    ws.on('close', () => { connected = false; if (!stopped) setTimeout(connect, 3000).unref?.(); });
    ws.on('error', (e) => { lastErr = e.message; });
  }
  function onMsg(j) {
    if (j.id != null && byReq.has(j.id)) { const pool = byReq.get(j.id); byReq.delete(j.id); const w = watch.get(pool); if (w && typeof j.result === 'number') { w.subId = j.result; bySub.set(j.result, pool); } return; }
    const v = j.params?.result?.value; if (!v || v.err) return;
    const pool = bySub.get(j.params.subscription); const w = pool && watch.get(pool); if (!w) return;
    const t = now();
    for (const e of poolEventsFromLogs(v.logs || [])) if (e.pool === pool) { events++; w.ev.push({ at: t, buy: e.buy, quote: e.quote, bp: e.bp, qp: e.qp, user: e.user, feeBps: e.feeBps }); }
  }
  // fed with every bonding-curve trade from the shared stream (scalper hook)
  function onCurveTrade(tr, m) {
    if (!tr || !(tr.realTok === 0 || m?.complete)) return;
    if (!(tr.vs >= 29.9 && tr.vs <= 130 && tr.vt <= 281e6)) return;
    const t = now(); if (seen.has(tr.mint)) return; seen.set(tr.mint, t); for (const [k, v] of seen) { if (t - v < 3600e3) break; seen.delete(k); }
    const s = state(); s.grads++;
    if (isExcluded(tr.mint, tr.creator || null)) { s.excluded++; return; }
    let pool; try { pool = poolOf(tr.mint); } catch { s.noData++; return; }
    if (watch.has(pool)) return;
    if (watch.size >= maxWatch) { s.noData++; return; }
    watch.set(pool, { mint: tr.mint, grad: t, pc: tr.vs / tr.vt, creator: tr.creator || null, ev: [], subId: null });
    subscribe(pool);
  }
  function settle(w) {
    const s = state(); if (!w.ev.length) { s.noData++; return; } s.settled++;
    for (const P of VARIANTS) {
      const o = pmSim(w, P); if (!o || o.skip) continue;
      const a = s.byVar[P.id] || (s.byVar[P.id] = { n: 0, wins: 0, netSol: 0, eq: 0, peak: 0, maxDD: 0, sumPct: 0 });
      const pnl = SIZE * o.ret; a.n++; a.wins += pnl > 0 ? 1 : 0; a.netSol = r6(a.netSol + pnl); a.eq = r6(a.eq + pnl); a.peak = Math.max(a.peak, a.eq); a.maxDD = r6(Math.max(a.maxDD, a.peak - a.eq)); a.sumPct = r1(a.sumPct + 100 * o.ret);
      if (P.id === 'F0_P5') { s.closed.unshift({ mint: w.mint, gradAt: new Date(w.grad).toISOString(), inAt: new Date(o.tIn).toISOString(), retPct: r1(100 * o.ret), netSol: r6(pnl), why: o.why }); s.closed.length = Math.min(s.closed.length, 30); }
    }
  }
  function tick() { const t = now(); for (const [p, w] of watch) if (t - w.grad >= SETTLE_MS) { watch.delete(p); unsubscribe(w); try { settle(w); } catch (e) { lastErr = e.message; } } }
  let timer = null;
  return {
    start() { connect(); timer = setInterval(tick, 5000); timer.unref?.(); return this; },
    stop() { stopped = true; clearInterval(timer); try { ws?.close(); } catch {} },
    onCurveTrade, tick, _watch: watch, _onMsg: onMsg,
    status() { const s = state(); return { paperOnly: true, note: 'Shadow test: hypothetical fills only, no orders are ever sent. Fixed 0.02 SOL per trade, base latency 3 s in / 2 s out.', ...s,
      variants: VARIANTS.map((P) => { const a = s.byVar[P.id] || { n: 0, wins: 0, netSol: 0, maxDD: 0, sumPct: 0 }; return { ...P, n: a.n, winRate: a.n ? r1(100 * a.wins / a.n) : null, netSol: a.netSol, maxDD: a.maxDD, avgPct: a.n ? r1(a.sumPct / a.n) : null }; }),
      stream: { connected, msgs, failedTx, events, watching: watch.size, lastErr } }; },
  };
}
module.exports = { createPostmig, pmSim, decodePoolEvent, poolEventsFromLogs, poolOf, VARIANTS, ammSell, ammBuy };
