// Box-side PAPER runner for early.js (Frongus early-volume rule). Never trades: no wallet, no keys, no Helius, nothing to Render.
// Data: new coins from PumpPortal's free create stream; live trades from the public Solana logsSubscribe on the pump.fun program
// (Cloudflare often blocks pump.fun swap-api / frontend-api from this box — chain logs are the durable feed); swap-api kept as fallback.
// Prices of open coins from the bonding-curve account on the public Solana RPC; graduated coins fall back to last curve mark.
// State: EARLY_STATE (default /workspace/agentdata/early-state.json), status: /workspace/agentdata/early-status.json, log: early-runner.log
const fs = require('fs'); const path = require('path'); const WS = require('ws');
const E = require('../early');
const { tradesFromMessage, reconnectPlan } = require('../scalp');
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const STATE = process.env.EARLY_STATE || '/workspace/agentdata/early-state.json';
const STATUS = path.join(path.dirname(STATE), 'early-status.json');
const RPC = process.env.EARLY_RPC_URL || 'https://api.mainnet-beta.solana.com';
const CHAIN_WS = process.env.EARLY_CHAIN_WS || RPC.replace(/^https:/, 'wss:');
const UA = { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (ALMA paper test)' };
const PROTECTED = new Set(['9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys', '76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm', ...(process.env.AGENT_PROTECTED_WALLETS || '').split(',').filter(Boolean)]);
const EXCLUDE = new Set((process.env.AGENT_EXCLUDE_CA || '').split(',').map((x) => x.trim()).filter(Boolean));
const ALMA = process.env.ALMA_URL || 'https://bundle-snout.onrender.com/api/agent';
const PROMOTE_USD = 5000, PRECHECK_S = 40, POLL_S = 10, PREFILTER_SOL = 12, MAX_PAGES = 12, PEAK_WIN_MS = 3600e3;
const log = (...a) => console.log(new Date().toISOString(), ...a);

let S = { since: new Date().toISOString(), seen: 0, prechecked: 0, candidates: 0, triggers: [], open: [], closed: [], voided: 0, voidedPause: 0, skips: {}, near: [] };
try { S = Object.assign(S, JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch {}
const skip = (k) => { S.skips[k] = (S.skips[k] || 0) + 1; };
const coins = new Map(); // mint -> {mint, cr, creator, bc, sym, next, stage}
let solUsd = 100, lastTick = Date.now(), pauses = 0, api = { ok: 0, err: 0, backoffUntil: 0, last: null }, wsInfo = { opens: 0, lastMsg: 0 };
let almaEx = new Set();
async function syncAlma() { try { const j = await (await fetch(ALMA, { signal: AbortSignal.timeout(20000) })).json(); const ex = j?.rules?.neverTrades || j?.rules?.hard?.neverTrades; if (Array.isArray(ex)) almaEx = new Set(ex); const pw = j?.rules?.protectedWallets || j?.rules?.hard?.protectedWallets; if (Array.isArray(pw)) pw.forEach((w) => PROTECTED.add(w)); if (Number(j?.solUsd) > 0) solUsd = Number(j.solUsd); } catch {} }

// ---- pump.fun swap-api, throttled (<= ~3 req/s), backs off on 403/429
let qBusy = 0; const q = [];
function pf(url) { return new Promise((res) => { q.push({ url, res }); pump(); }); }
function pump() {
  while (qBusy < 1 && q.length) {
    if (Date.now() < api.backoffUntil) { setTimeout(pump, 2000); return; }
    const { url, res } = q.shift(); qBusy++;
    fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) }).then(async (r) => {
      if (r.status === 403 || r.status === 429) { api.backoffUntil = Date.now() + 30e3; api.n429 = (api.n429 || 0) + 1; api.err++; api.last = 'HTTP ' + r.status; return res(null); }
      if (r.status === 410) { if (!api.goneSince) { api.goneSince = new Date().toISOString(); log('[early] pump.fun swap-api trades endpoint returned 410 Gone (deprecated); backing off 15 min per try, early test cannot evaluate candidates'); } api.gone = (api.gone || 0) + 1; api.backoffUntil = Date.now() + 15 * 60e3; api.err++; api.last = 'HTTP 410 (endpoint deprecated)'; return res(null); }
      if (!r.ok) { api.err++; api.last = 'HTTP ' + r.status; return res(null); } api.ok++; api.goneSince = null; res(await r.json());
    }).catch((e) => { api.err++; api.last = e.message; res(null); }).finally(() => setTimeout(() => { qBusy--; pump(); }, 400));
  }
}
const normT = (t) => ({ at: Date.parse(t.timestamp), user: t.userAddress, buy: t.type === 'buy', sol: Number(t.amountSol) || 0, priceSol: Number(t.priceSol) || 0, priceUsd: Number(t.priceUsd) || 0, prog: t.program });
async function tradesSince(mint, cr, maxPages = MAX_PAGES, cache = null) { // cache: Map slotIndexId -> trade (incremental: stop at known trades)
  let url = `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100`, pages = 0, more = false, hitKnown = false; const fresh = [];
  while (pages < maxPages) {
    const j = await pf(url); if (!j || !Array.isArray(j.trades)) return null; pages++;
    for (const raw of j.trades) { if (cache && cache.has(raw.slotIndexId)) { hitKnown = true; break; } fresh.push([raw.slotIndexId, normT(raw)]); }
    more = !!j.pagination?.hasMore; const L = j.trades.map(normT);
    if (hitKnown || !more || !L.length || Math.min(...L.map((t) => t.at)) <= cr) break;
    url = `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100&cursor=${encodeURIComponent(j.pagination.nextCursor)}`;
  }
  if (cache) for (const [k, t] of fresh) cache.set(k, t);
  const all = cache ? [...cache.values()] : fresh.map((x) => x[1]);
  const t = all.filter((x) => x.at >= cr - 2000 && x.prog !== 'pump_amm'); const lt = t.find((x) => x.priceUsd && x.priceSol); if (lt) solUsd = lt.priceUsd / lt.priceSol;
  return { trades: t, more, pages, amm: all.some((x) => x.prog === 'pump_amm'), truncated: !hitKnown && pages >= maxPages && more };
}

// ---- public RPC curve reads
async function rpc(method, params) { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; }
function decodeCurve(b64) { const b = Buffer.from(b64, 'base64'); if (b.length < 49) return null; const vt = Number(b.readBigUInt64LE(8)) / 1e6, vs = Number(b.readBigUInt64LE(16)) / 1e9, realTok = Number(b.readBigUInt64LE(24)) / 1e6; return { vs, vt, complete: b[48] === 1 || realTok === 0 }; }
async function curves(keys) { const out = {}; for (let i = 0; i < keys.length; i += 100) { const r = await rpc('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]); r.value.forEach((a, j) => { out[keys[i + j]] = a ? decodeCurve(a.data[0]) : null; }); } return out; }

// ---- new coins
// Ops evidence 2026-11-07 vigilancia: early-status right after box-ensure restart showed
// ws.lastMsgAgoS ≈ 1.79e9 (Date.now()-0) while opens was still 0 — status treated unset
// lastMsg as epoch, and the portal heartbeat used the same formula so a quiet/new socket
// looked "stale >90s" immediately. Match chain: stamp lastMsg on open, null-guard age,
// and only force-reconnect when a real lastMsg is older than 90s.
function wsLastMsgAgoS(lastMsg, now = Date.now()) {
  return lastMsg ? Math.round((now - lastMsg) / 1000) : null;
}
function portalWsShouldReconnect(lastMsg, now = Date.now(), staleMs = 90e3) {
  return !!(lastMsg && now - lastMsg > staleMs);
}
function connect() {
  const ws = new WS('wss://pumpportal.fun/api/data'); let alive = true;
  ws.on('open', () => {
    wsInfo.opens++;
    wsInfo.lastMsg = Date.now(); // prove socket live before first create (same as chain)
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });
  ws.on('message', (m) => { wsInfo.lastMsg = Date.now(); let d; try { d = JSON.parse(m); } catch { return; }
    if (d.txType !== 'create' || !d.mint || (d.pool && d.pool !== 'pump')) return;
    if (EXCLUDE.has(d.mint) || almaEx.has(d.mint) || PROTECTED.has(d.traderPublicKey)) { skip('excluded'); return; }
    S.seen++; if (!coins.has(d.mint) && !done.has(d.mint)) coins.set(d.mint, { mint: d.mint, cr: Date.now(), creator: d.traderPublicKey, bc: d.bondingCurveKey, sym: d.symbol, next: Date.now() + PRECHECK_S * 1000, stage: 'pre' }); });
  const dead = () => { if (!alive) return; alive = false; setTimeout(connect, 1000); };
  ws.on('close', dead); ws.on('error', () => { try { ws.terminate(); } catch {} dead(); });
  const hb = setInterval(() => {
    if (!alive) return clearInterval(hb);
    if (portalWsShouldReconnect(wsInfo.lastMsg)) {
      log('[early] portal WS stale >90s; forcing reconnect');
      try { ws.terminate(); } catch {}
      dead();
      clearInterval(hb);
    }
  }, 30e3);
}


// ---- public Solana log stream (free): trade lists without pump.fun HTTP
const recentTrades = new Map(); // mint -> evalRule trades
let chainInfo = { opens: 0, lastMsg: 0, trades: 0, kept: 0, lastError: null, closes: 0 };
function pruneRecent(now) {
  for (const [m, arr] of recentTrades) {
    while (arr.length && arr[0].at < now - 200e3) arr.shift();
    if (!arr.length && !coins.has(m)) recentTrades.delete(m);
  }
  if (recentTrades.size > 5000) {
    const drop = [...recentTrades.keys()].filter((m) => !coins.has(m)).slice(0, recentTrades.size - 4000);
    for (const m of drop) recentTrades.delete(m);
  }
}
function onChainTrade(tr) {
  const at = Date.now(); chainInfo.trades++; chainInfo.lastMsg = at;
  if (!(tr.vs >= 29.9 && tr.vs <= 130 && tr.vt > 250e6 && tr.vt <= 1.0731e9)) return; // SOL-quoted curve only
  const priceSol = tr.vt > 0 ? tr.vs / tr.vt : 0;
  const row = { at, user: tr.user, buy: !!tr.buy, sol: tr.sol, priceSol, priceUsd: priceSol * solUsd, prog: 'pump' };
  let arr = recentTrades.get(tr.mint);
  if (!arr) {
    if (!coins.has(tr.mint) && recentTrades.size > 4500) { pruneRecent(at); if (!coins.has(tr.mint) && recentTrades.size > 4500) return; }
    arr = []; recentTrades.set(tr.mint, arr);
  }
  arr.push(row); chainInfo.kept++;
  while (arr.length > 500 || (arr.length && arr[0].at < at - 200e3)) arr.shift();
  const c = coins.get(tr.mint);
  if (c && c.stage === 'pre' && row.priceUsd * 1e9 >= PROMOTE_USD) { c.stage = 'cand'; c.next = at; S.candidates++; }
}
let chainWs = null; // so a box-pause tick can tear down a half-open socket
function connectChain() {
  const openedAt = Date.now(); let alive = true, backoff = 2000;
  const ws = new WS(CHAIN_WS, { perMessageDeflate: false });
  chainWs = ws;
  ws.on('open', () => {
    chainInfo.opens++; chainInfo.lastError = null; chainInfo.lastMsg = Date.now(); backoff = 2000;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] }));
  });
  ws.on('message', (buf) => {
    chainInfo.lastMsg = Date.now(); // any frame (incl. sub confirm) proves the socket is live
    const trs = tradesFromMessage(buf.toString());
    if (trs.length) for (const tr of trs) onChainTrade(tr);
  });
  const dead = (err) => {
    if (!alive) return; alive = false; if (chainWs === ws) chainWs = null;
    chainInfo.closes++; if (err) chainInfo.lastError = String(err.message || err).slice(0, 160);
    const lived = Date.now() - openedAt; const plan = reconnectPlan(lived, backoff); backoff = plan.next;
    setTimeout(connectChain, plan.delay);
  };
  ws.on('close', (code) => dead(new Error('close ' + code)));
  ws.on('error', (e) => { try { ws.terminate(); } catch {} dead(e); });
  // Public RPC often leaves a half-open WS after a box pause; portal connect() already has this, chain did not.
  const hb = setInterval(() => {
    if (!alive) return clearInterval(hb);
    if (chainInfo.lastMsg && Date.now() - chainInfo.lastMsg > 90e3) {
      log('[early] chain WS stale >90s; forcing reconnect');
      try { ws.terminate(); } catch {}
      dead(new Error('stale >90s'));
      clearInterval(hb);
    }
  }, 30e3);
}

// ---- pump.fun listings (frontend-api-v3, ~2 requests / 8 s): promote young coins whose mcap reached PROMOTE_USD
// Ops evidence 2026-11-06 vigilancia: after box pauses, box-ensure restarts early ~8s after the
// still-alive process logged "list API 403"; in-memory listBlockedUntil was wiped so the new
// process re-hit Cloudflare and double-logged. Persist listNextTryAt to status immediately on
// 403 and restore it on boot so restarts inside the 30 min window skip the fetch entirely.
const LIST_403_BACKOFF_MS = 30 * 60e3;
function readPersistedListBlockedUntil(statusPath = STATUS, now = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const iso = j?.runner?.api?.listNextTryAt;
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t) || t <= now) return { until: 0, api: null, iso: null };
    return { until: t, api: j.runner.api || null, iso };
  } catch { return { until: 0, api: null, iso: null }; }
}
function applyList403({ now = Date.now(), backoffMs = LIST_403_BACKOFF_MS, logFn = log } = {}) {
  const until = now + backoffMs;
  const iso = new Date(until).toISOString();
  logFn('[early] list API 403 (Cloudflare); retry in 30 min');
  return { until, iso };
}
let listBlockedUntil = 0;
function restoreList403Backoff() {
  const r = readPersistedListBlockedUntil();
  if (!r.until) return false;
  listBlockedUntil = r.until;
  if (r.api) {
    if (r.api.listBlocked403 != null) api.listBlocked403 = r.api.listBlocked403;
    if (r.api.listErr != null) api.listErr = r.api.listErr;
    if (r.api.listLast) api.listLast = r.api.listLast;
  }
  api.listNextTryAt = r.iso;
  log('[early] list API 403 backoff restored until', r.iso, `(${Math.round((r.until - Date.now()) / 60000)} min left; skip fetch)`);
  return true;
}
async function listings() {
  if (Date.now() < listBlockedUntil) return;
  for (const sort of ['created_timestamp', 'last_trade_timestamp']) {
    let L; try { const r = await fetch(`https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=${sort}&order=DESC&includeNsfw=true`, { headers: UA, signal: AbortSignal.timeout(10000) }); if (r.status === 403) { api.listErr = (api.listErr || 0) + 1; api.listLast = 'HTTP 403'; api.listBlocked403 = (api.listBlocked403 || 0) + 1; const b = applyList403(); listBlockedUntil = b.until; api.listNextTryAt = b.iso; try { save(); } catch {} return; } if (!r.ok) { api.listErr = (api.listErr || 0) + 1; api.listLast = 'HTTP ' + r.status; continue; } L = await r.json(); api.listOk = (api.listOk || 0) + 1; } catch (e) { api.listErr = (api.listErr || 0) + 1; api.listLast = e.message; continue; }
    const now = Date.now();
    for (const x of Array.isArray(L) ? L : []) {
      if (!x?.mint || x.complete || (x.program && x.program !== 'pump') || (x.quote_mint && x.quote_mint !== '11111111111111111111111111111111')) continue;
      const age = (now - x.created_timestamp) / 1000; if (age > E.RULE.maxAgeS || age < 0) continue;
      if (EXCLUDE.has(x.mint) || almaEx.has(x.mint) || PROTECTED.has(x.creator)) continue;
      if (S.triggers.some((t) => t.mint === x.mint) || done.has(x.mint)) continue;
      let c = coins.get(x.mint); if (!c) { c = { mint: x.mint, cr: x.created_timestamp, creator: x.creator, bc: x.bonding_curve, sym: x.symbol, next: now, stage: 'pre', viaList: true }; coins.set(x.mint, c); S.listOnly = (S.listOnly || 0) + 1; }
      c.cr = x.created_timestamp || c.cr; c.bc = c.bc || x.bonding_curve;
      if (c.stage === 'pre' && Number(x.usd_market_cap) >= PROMOTE_USD) { c.stage = 'cand'; c.next = now; S.candidates++; }
    }
  }
}
const done = new Set(); // mints already evaluated to the end (no re-adding)

async function check(c) {
  const now = Date.now();
  if (c.stage === 'pre') {
    const buf = recentTrades.get(c.mint) || [];
    const lt = buf.length ? buf[buf.length - 1] : null;
    if (lt && lt.priceUsd * 1e9 >= PROMOTE_USD) { c.stage = 'cand'; S.candidates++; }
    else { c.next = now + 3e3; return; }
  }
  let r = null;
  const local = (recentTrades.get(c.mint) || []).filter((t) => t.at >= c.cr - 2000);
  if (local.length >= 8) r = { trades: local, more: false, pages: 0, amm: false, truncated: false, source: 'chain' };
  else {
    c.cache = c.cache || new Map();
    r = await tradesSince(c.mint, c.cr, MAX_PAGES, c.cache);
    if (r) r.source = 'swap-api';
  }
  if (!r) { c.next = now + POLL_S * 1000; return; }
  const ev = E.evalRule(r.trades, c.cr, Date.now()); c.best = ev;
  if (ev.ok) { coins.delete(c.mint); await trigger(c, ev, r); return; }
  if (ev.f.age > E.RULE.maxAgeS || r.amm) { coins.delete(c.mint); done.add(c.mint); skip('no_trigger'); const nf = ev.fails.filter((x) => x !== 'age');
    if (nf.length <= 2) { S.near.push({ mint: c.mint, sym: c.sym, at: new Date().toISOString(), fails: nf, f: ev.f, source: r.source }); S.near = S.near.slice(-40); } return; }
  c.next = Date.now() + POLL_S * 1000;
}

async function trigger(c, ev, r) {
  const t0 = Date.now(); let cv; try { cv = (await curves([c.bc]))[c.bc]; } catch (e) { skip('fill_rpc_err'); return; }
  const T = { mint: c.mint, sym: c.sym, bc: c.bc, creator: c.creator, cr: c.cr, at: t0, f: ev.f, truncated: r.truncated, peakMult: 1, m5: null, m15: null, m60: null, lastPriceAt: t0, gap: false };
  if (!cv || cv.complete) { T.miss = 'graduated_before_fill'; S.triggers.push(T); log('[early] trigger but curve complete', c.sym, c.mint); return; }
  const mcUsd = (cv.vs / cv.vt) * 1e9 * solUsd; T.fillMcUsd = Math.round(mcUsd); T.entrySpot = cv.vs / cv.vt; T.last = { vs: cv.vs, vt: cv.vt };
  if (mcUsd >= E.RULE.maxMcUsd) { T.miss = 'mc_over_cap_at_fill'; S.triggers.push(T); log('[early] trigger, mc over cap at fill', c.sym, Math.round(mcUsd)); return; }
  const fill = E.buyFill(cv.vs, cv.vt, E.SIZE); T.impactPct = Math.round(fill.impactPct * 100) / 100;
  for (const ex of E.EXITS) S.open.push({ v: ex.id, mint: c.mint, sym: c.sym, bc: c.bc, at: t0, cost: E.SIZE + 0.000024, tok: fill.tok, peakVal: 0, lastPriceAt: t0, lastVal: null });
  S.triggers.push(T); log('[early] TRIGGER', c.sym, c.mint, JSON.stringify(ev.f), 'fill mc $' + T.fillMcUsd, 'impact', T.impactPct + '%');
}

const ammPx = new Map(); // mint -> {priceSol, at}
async function monitor() {
  const now = Date.now();
  const tracked = S.triggers.filter((t) => !t.miss && now - t.at <= PEAK_WIN_MS + 60e3 && t.m60 == null);
  const mints = new Set([...S.open.map((p) => p.mint), ...tracked.map((t) => t.mint)]); if (!mints.size) return;
  const bcs = {}; for (const t of S.triggers) if (mints.has(t.mint)) bcs[t.mint] = t.bc;
  let cv; try { cv = await curves(Object.values(bcs)); } catch (e) { return; }
  for (const mint of mints) {
    const T = S.triggers.find((t) => t.mint === mint && !t.miss); const c = cv[bcs[mint]]; let mark = null, spot = null;
    if (c && !c.complete) { mark = { kind: 'curve', vs: c.vs, vt: c.vt }; spot = c.vs / c.vt; T.last = { vs: c.vs, vt: c.vt }; }
    else if (c && c.complete) {
      T.graduated = T.graduated || now; const a = ammPx.get(mint);
      if (!a || now - a.at > 15e3) { pf(`https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=5`).then((j) => { const x = j?.trades?.map(normT).find((t) => t.prog === 'pump_amm'); if (x) ammPx.set(mint, { priceSol: x.priceSol, at: Date.now(), tradeAt: x.at }); }); }
      mark = E.graduationMark({ graduatedAt: T.graduated, last: T.last, amm: a, now });
      if (mark) spot = mark.kind === 'amm' ? mark.priceSol : (T.last.vs / T.last.vt) * E.GRAD_HAIRCUT;
    }
    if (!mark) {
      // Complete curve but still inside GRAD_WAIT (no AMM yet): heartbeat lastPriceAt so
      // sweep does not void before graduationMark returns grad_fallback.
      if (c && c.complete) {
        heartbeatGradWait(S.open, mint, now);
        if (T) T.lastPriceAt = now;
      }
      continue;
    }
    if (T) { const age = now - T.at; const mult = spot / T.entrySpot; if (now - T.lastPriceAt > E.MAX_BLIND_MS) T.gap = true; T.lastPriceAt = now;
      if (age <= PEAK_WIN_MS) T.peakMult = Math.max(T.peakMult, Math.round(mult * 1000) / 1000);
      if (T.m5 == null && age >= 5 * 60e3) T.m5 = Math.round(mult * 1000) / 1000; if (T.m15 == null && age >= 15 * 60e3) T.m15 = Math.round(mult * 1000) / 1000; if (T.m60 == null && age >= PEAK_WIN_MS) T.m60 = Math.round(mult * 1000) / 1000; }
    applyOpenMark(S.open, mint, mark, now);
  }
}

// Apply a usable mark to open paper legs. Never blind-void when we have a mark: a stale
// lastPriceAt with grad_fallback/amm ready used to discard graduated winners before
// grad_exit (ops 2026-11-07: GEO peak 4.6x, time60 voided; time60 0 exits / many voids).
function applyOpenMark(open, mint, mark, now, exits = E.EXITS) {
  if (!mark || !Array.isArray(open)) return [];
  const hit = [];
  for (const p of open) {
    if (p.mint !== mint || p.done) continue;
    const val = E.markValue(p, mark);
    p.lastPriceAt = now;
    p.lastVal = val;
    p.markKind = mark.kind;
    const ex = exits.find((e) => e.id === p.v);
    const why = E.exitCheck(p, ex, val, now) || (mark.final ? 'grad_exit' : null);
    if (why) {
      p.done = why;
      p.exitAt = now;
      p.pnlSol = val - p.cost;
      p.pnlPct = Math.round((val / p.cost - 1) * 10000) / 100;
      hit.push(p);
    }
  }
  return hit;
}
function heartbeatGradWait(open, mint, now) {
  if (!Array.isArray(open)) return 0;
  let n = 0;
  for (const p of open) {
    if (p.mint !== mint || p.done) continue;
    p.lastPriceAt = now;
    n++;
  }
  return n;
}

// Ops evidence 2026-11-07 vigilancia: after a ~6304s box pause, sweep voided time15/time60
// HOUR and ₽ as "price unwatched >60s" — same path as a mid-run price-feed gap — so the
// voided counter and log looked like market-data failures. Attribute pause-driven voids
// separately (void_pause / voidedPause) and emit one batched log line per storm.
function voidOpenAfterBoxPause(open, { now = Date.now(), gapMs, blindMs = E.MAX_BLIND_MS } = {}) {
  if (!(gapMs > blindMs) || !Array.isArray(open)) return [];
  const gapSec = Math.round(gapMs / 1000);
  const marked = [];
  for (const p of open) {
    if (p.done) continue;
    p.done = 'void_pause';
    p.pauseGapSec = gapSec;
    p.voidAt = now;
    marked.push(p);
  }
  return marked;
}
function formatPauseVoidLog(marked, gapSec) {
  const parts = marked.map((p) => `${p.v} ${p.sym || '?'}`);
  return `[early] VOID box pause ${gapSec}s: ${parts.join(', ')} (${marked.length})`;
}
function sweep() { // move finished positions, void blind ones
  if (done.size > 5000) done.clear();
  const now = Date.now(); const keep = []; const pauseVoids = [];
  for (const p of S.open) {
    if (!p.done && now - p.lastPriceAt > E.MAX_BLIND_MS) p.done = 'void';
    if (p.done === 'void_pause') {
      S.voidedPause = (S.voidedPause || 0) + 1;
      pauseVoids.push(p);
      continue;
    }
    if (p.done === 'void') { S.voided++; log('[early] VOID (price unwatched >60s)', p.v, p.sym); continue; }
    if (p.done) { S.closed.push({ v: p.v, mint: p.mint, sym: p.sym, at: p.at, exitAt: p.exitAt, why: p.done, pnlSol: Math.round(p.pnlSol * 1e6) / 1e6, pnlPct: p.pnlPct, mark: p.markKind }); log('[early] EXIT', p.v, p.sym, p.done, p.pnlPct + '%'); continue; }
    keep.push(p);
  }
  if (pauseVoids.length) {
    const gapSec = pauseVoids[0].pauseGapSec != null ? pauseVoids[0].pauseGapSec : Math.round((now - (pauseVoids[0].lastPriceAt || now)) / 1000);
    log(formatPauseVoidLog(pauseVoids, gapSec));
  }
  S.open = keep; if (S.closed.length > 3000) S.closed = S.closed.slice(-3000); if (S.triggers.length > 1000) S.triggers = S.triggers.slice(-1000);
}
function status() {
  const by = {}; for (const ex of E.EXITS) by[ex.id] = E.stats(S.closed.filter((p) => p.v === ex.id));
  const done = S.triggers.filter((t) => !t.miss);
  return { paper: true, runner: { host: 'box', pid: process.pid, savedAt: new Date().toISOString(), since: S.since, pauses, solUsd: Math.round(solUsd * 100) / 100, api, ws: { opens: wsInfo.opens, lastMsgAgoS: wsLastMsgAgoS(wsInfo.lastMsg) }, chain: { opens: chainInfo.opens, closes: chainInfo.closes, trades: chainInfo.trades, kept: chainInfo.kept, mintsBuffered: recentTrades.size, lastMsgAgoS: chainInfo.lastMsg ? Math.round((Date.now() - chainInfo.lastMsg) / 1000) : null, lastError: chainInfo.lastError } },
    rule: E.RULE, size: E.SIZE, seen: S.seen, prechecked: S.prechecked, candidates: S.candidates, watching: coins.size, skips: S.skips, voided: S.voided, voidedPause: S.voidedPause || 0,
    triggers: S.triggers.length, filled: done.length, misses: S.triggers.filter((t) => t.miss).map((t) => ({ sym: t.sym, mint: t.mint, miss: t.miss })),
    peaks: { tracked: done.length, ge2x: done.filter((t) => t.peakMult >= 2).length, ge5x: done.filter((t) => t.peakMult >= 5).length, ge10x: done.filter((t) => t.peakMult >= 10).length },
    byExit: by, open: S.open.length, recentTriggers: S.triggers.slice(-15).map((t) => ({ sym: t.sym, mint: t.mint, at: new Date(t.at).toISOString(), fillMcUsd: t.fillMcUsd, miss: t.miss, peakMult: t.peakMult, m5: t.m5, m15: t.m15, m60: t.m60, graduated: !!t.graduated, gap: t.gap, f: t.f })),
    nearMisses: S.near.slice(-10) };
}
function save() { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(S)); fs.renameSync(STATE + '.tmp', STATE); fs.writeFileSync(STATUS, JSON.stringify(status(), null, 1)); } catch (e) { log('[early] save', e.message); } }

let busy = false;
async function tick() {
  const now = Date.now();
  if (now - lastTick > E.MAX_BLIND_MS) {
    const gapMs = now - lastTick;
    pauses++; log('[early] box pause detected', Math.round(gapMs / 1000) + 's');
    // Attribute open-position voids to the pause before monitor/sweep can relabel them as
    // generic "price unwatched" (ops 2026-11-07: time15/time60 HOUR+₽ after 6304s pause).
    voidOpenAfterBoxPause(S.open, { now, gapMs });
    // Half-open sockets survive a VM pause without firing close; tear chain down so connectChain() resubscribes now.
    if (chainWs) { try { chainWs.terminate(); } catch {} }
  }
  lastTick = now;
  if (busy) return; busy = true;
  try {
    pruneRecent(now);
    const due = [...coins.values()].filter((c) => c.next <= now && !c.inflight);
    for (const c of coins.values()) if (now - c.cr > (E.RULE.maxAgeS + 30) * 1000) { coins.delete(c.mint); done.add(c.mint); skip(c.stage === 'pre' ? 'never_reached_5k' : 'stale'); }
    for (const c of due) { if (!coins.has(c.mint)) continue; c.inflight = true; check(c).catch((e) => log('[early] check', e.message)).finally(() => { c.inflight = false; }); }
    await monitor(); sweep();
  } catch (e) { log('[early] tick', e.message); } finally { busy = false; }
}
function startEarlyRunner() {
  restoreList403Backoff();
  log('[early] PAPER test start; rule', JSON.stringify(E.RULE), 'exits', E.EXITS.map((e) => e.id).join(','));
  sweep(); // positions from before a restart are voided here if their price went unwatched > 60 s
  syncAlma(); setInterval(syncAlma, 30 * 60e3); connect(); connectChain(); setInterval(tick, 3000); listings(); setInterval(() => listings().catch(() => {}), 8000); setInterval(save, 30e3); save();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });
}
if (require.main === module) startEarlyRunner();
module.exports = { readPersistedListBlockedUntil, applyList403, LIST_403_BACKOFF_MS, restoreList403Backoff, voidOpenAfterBoxPause, formatPauseVoidLog, wsLastMsgAgoS, portalWsShouldReconnect, applyOpenMark, heartbeatGradWait, startEarlyRunner };
