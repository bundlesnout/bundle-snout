// Bond Radar — watches pump.fun for coins approaching graduation and alerts when they scan clean.
// Free, legitimate sources only (pump.fun's frontend API sits behind a Cloudflare bot challenge and answers 403 to
// servers, so it is optional and off by default; we never try to get around that block):
//  1. Trade stream (primary, 0 credits): every pump.fun TradeEvent from the public Solana RPC log stream that the
//     scalper already decodes. Each event carries the post-trade real token reserves -> exact curve progress.
//  2. On-chain tracker: curve accounts read with getMultipleAccounts for coins found by PumpPortal (new tokens) and
//     GeckoTerminal (public API, pump-fun dex pools = bonding-curve accounts). Confirms progress and graduation.
//  3. PumpPortal data websocket (no key): live new-token + migration events.
//  4. pump.fun frontend API: only if RADAR_PUMP_API=1, with exponential backoff.
// Helius is only used by the existing analyzer, once per mint that crosses the threshold, under a daily budget.
const WebSocket = require('ws');
const analyzerMod = require('./analyzer');
const { analyze, creditStats, setCreditTag } = analyzerMod;
const rpc = (...a) => analyzerMod.rpc(...a); // late-bound so tests can stub it
const { deepAnalyze } = require('./deep');

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const CFG = () => ({
  thresholdPct: num('RADAR_THRESHOLD_PCT', 70),
  pollMs: num('RADAR_POLL_MS', 15000),
  pageLimit: num('RADAR_PAGE_LIMIT', 50),
  pages: num('RADAR_PAGES', 2),
  maxScansPerDay: num('RADAR_MAX_SCANS_PER_DAY', 250),
  maxDeepPerDay: num('RADAR_MAX_DEEP_PER_DAY', 40),
  persistDecided: num('RADAR_PERSIST_DECIDED', 250), // today's judged coins kept across restarts (RADAR_STATE env blob, ~48 bytes each)
  dailyCreditCap: num('RADAR_DAILY_CREDIT_CAP', 28000), // Helius free = 1M/month -> ~33k/day; leave headroom for /api/analyze + Telegram scans
  maxPct: num('RADAR_MAX_PCT', 97), // skip coins that are basically graduating already
  // clean thresholds
  maxTop10Pct: num('RADAR_MAX_TOP10_PCT', 30),
  maxSameSlotPct: num('RADAR_MAX_SAMESLOT_PCT', 10),
  maxEarlyHoldPct: num('RADAR_MAX_EARLY_HOLD_PCT', 10),
  maxDevHoldPct: num('RADAR_MAX_DEV_HOLD_PCT', 10),
  allowDevSell: process.env.RADAR_ALLOW_DEV_SELL === '1',
  useWs: process.env.RADAR_WS !== '0',
  // 'auto' = pump.fun API (if reachable) + on-chain tracking of coins seen on the PumpPortal stream; 'api' | 'chain' to force one
  source: (process.env.RADAR_SOURCE || 'auto').toLowerCase(),
  chainTickMs: num('RADAR_CHAIN_TICK_MS', 15000),
  pumpApi: process.env.RADAR_PUMP_API === '1',
  gecko: process.env.RADAR_GECKO !== '0',
  geckoMs: num('RADAR_GECKO_MS', 300000),      // supplementary discovery every 5 min (2 requests; free limit is ~30/min)
  geckoStaleMs: num('RADAR_GECKO_STALE_MS', 60000), // every 1 min while the trade stream is silent
  streamThrottleMs: num('RADAR_STREAM_THROTTLE_MS', 2000),
  maxTracked: num('RADAR_MAX_TRACKED', 30000),
  scanGapMs: num('RADAR_SCAN_GAP_MS', 3000),
});
const GECKO = process.env.GECKO_API || 'https://api.geckoterminal.com/api/v2';
const VIRTUAL_GAP = 279_900_000e6; // virtual - real token reserves on a standard curve (1.073B - 793.1M), raw units
const API = process.env.PUMP_API || 'https://frontend-api-v3.pump.fun';
const WS_URL = process.env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const INITIAL_REAL = 793_100_000e6; // default initial real token reserves (raw, 6 decimals)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { clean, reasons[] } — every check must pass. Missing data = not clean.
function cleanCheck(r, cfg = CFG()) {
  const fail = [];
  const b = r.bundle, d = r.dev, h = r.holders, c = r.curve;
  if (!r.isPumpFun || !c) fail.push('not a pump.fun bonding curve');
  else if (c.complete) fail.push('already graduated');
  else if (c.progressPct < cfg.thresholdPct - 5) fail.push(`on-chain progress ${c.progressPct}% < threshold`);
  if (!b) fail.push(r.history && r.history.reachedCreation === false ? `bundle check unavailable (creation tx not reached in the last ${r.history.txScanned} txs)` : 'bundle check unavailable (creation tx not found)');
  else {
    if (b.multiWalletTxs > 0) fail.push(`${b.multiWalletTxs} multi-wallet buy tx(s) in first 3 blocks`);
    if (b.sameSlotPaidByDev > 0) fail.push(`${b.sameSlotPaidByDev} creation-block buy(s) fee-paid by dev`);
    if (b.rightAfterCreateWallets >= 2 && b.rightAfterCreatePct >= 5) fail.push(`${b.rightAfterCreateWallets} wallets bought right behind the create tx (${b.rightAfterCreatePct}%)`);
    if (b.sameSlotPctSupply >= cfg.maxSameSlotPct) fail.push(`creation block bought ${b.sameSlotPctSupply}% (≥${cfg.maxSameSlotPct}%)`);
    if (b.earlyStillHoldPct != null && b.earlyStillHoldPct >= cfg.maxEarlyHoldPct) fail.push(`early wallets still hold ${b.earlyStillHoldPct}% (≥${cfg.maxEarlyHoldPct}%)`);
  }
  if (!d) fail.push('dev wallet unknown');
  else {
    if (d.hasSold && !cfg.allowDevSell) fail.push(`dev sold (${d.soldPctOfBought ?? '?'}% of buys)`);
    if (d.holdingPctSupply >= cfg.maxDevHoldPct) fail.push(`dev holds ${d.holdingPctSupply}% (≥${cfg.maxDevHoldPct}%)`);
  }
  if (h?.top10Pct == null) fail.push('top holders unavailable');
  else if (h.top10Pct >= cfg.maxTop10Pct) fail.push(`top-10 hold ${h.top10Pct}% (≥${cfg.maxTop10Pct}%)`);
  if (r.risk?.level === 'ALTO') fail.push('overall risk HIGH');
  return { clean: fail.length === 0, reasons: fail };
}

function progressFromApi(c, initReal = INITIAL_REAL) {
  if (c.complete) return 100;
  const rt = Number(c.real_token_reserves);
  if (!Number.isFinite(rt)) return null;
  return Math.max(0, Math.round(((initReal - rt) / initReal) * 1000) / 10);
}

function createRadar({ onWsEvent = null, onAlert, picker = null, isAlerted = () => false, markAlerted = () => {}, log = console.log } = {}) {
  const cfg = CFG();
  const tracked = new Map();   // mint -> { name, symbol, progress, mcUsd, lastTradeAt, firstSeenAt, lastSeenAt }
  const decided = new Map();   // mint -> { at, clean, reasons, progress }
  const queue = []; const queued = new Set(); // queued also covers the in-flight mint until it is decided
  const st = {
    startedAt: new Date().toISOString(), running: false,
    poll: { count: 0, ok: 0, fail: 0, lastAt: null, lastOkAt: null, lastError: null, lastCoins: 0 },
    ws: { connected: false, connects: 0, lastEventAt: null, newTokens: 0, migrations: 0, lastError: null, lastNewMint: null },
    scans: { today: 0, day: new Date().toISOString().slice(0, 10), total: 0, errors: 0, clean: 0, dirty: 0, skippedBudget: 0, deepToday: 0, deepTotal: 0, deepErrors: 0, deepSkippedBudget: 0, skippedCreditCap: 0 },
    alerts: { sent: 0, lastAt: null, lastMint: null },
    recent: [],
  };
  let ws = null, wsBackoff = 1000, pollTimer = null, chainTimer = null, stopped = false, working = false, apiPausedUntil = 0, apiFailStreak = 0, apiPauses = 0;
  const useApi = cfg.pumpApi && cfg.source !== 'chain', useChain = cfg.source !== 'api';
  let geckoTimer = null, pruneTimer = null, geckoLastAt = 0, lastScanEnd = 0, geckoBackoffMs = 0, geckoBackoffUntil = 0;
  st.stream = { trades: 0, mints: 0, upserts: 0, lastAt: null };
  st.gecko = { enabled: cfg.gecko && useChain, polls: 0, ok: 0, fail: 0, added: 0, lastAt: null, lastError: null };
  if (!useApi) st.poll.disabled = 'pump.fun frontend API is behind a Cloudflare bot challenge (403 for servers); set RADAR_PUMP_API=1 to try it';

  // ---- On-chain tracker: coins created while we're running (from PumpPortal), curve read in batches of 100
  // with getMultipleAccounts (1 Helius credit per batch, 49-byte data slice). Re-check interval by progress;
  // dead coins are dropped. Typical cost: a few thousand credits/day.
  const chain = new Map(); // mint -> { curve, createdAt, lastCheckAt, progress, name, symbol, initReal }
  st.chain = { tracked: 0, batches: 0, accountsRead: 0, lastAt: null, lastError: null, dropped: 0 };
  function chainAdd(j) {
    if (!useChain || !j.mint || !j.bondingCurveKey || chain.has(j.mint) || (j.pool && j.pool !== 'pump')) return;
    const vTok = Number(j.vTokensInBondingCurve) * 1e6;
    chain.set(j.mint, { mint: j.mint, curve: j.bondingCurveKey, createdAt: Date.now(), lastCheckAt: Date.now(), name: j.name, symbol: j.symbol,
      progress: Number.isFinite(vTok) ? Math.max(0, Math.round(((1_073_000_000e6 - vTok) / INITIAL_REAL) * 1000) / 10) : 0, initReal: INITIAL_REAL });
  }
  // a curve found elsewhere (GeckoTerminal): read on the next chain tick
  function chainAddCurve({ mint, curve, symbol = null, name = null }) {
    if (!useChain || !mint || !curve || chain.has(mint)) return false;
    chain.set(mint, { mint, curve, createdAt: Date.now(), lastCheckAt: 0, name, symbol, progress: 0, initReal: INITIAL_REAL });
    return true;
  }

  // ---- 1. trade stream (shared with the scalper/agent): tr = decoded TradeEvent (sol/tok units, realTok in tokens)
  function onTrade(tr, { symbol = null, solUsd = null } = {}) {
    if (!tr?.mint || stopped) return;
    st.stream.trades++; st.stream.lastAt = new Date().toISOString();
    const now = Date.now(); const t = tracked.get(tr.mint);
    if (t && t._streamAt && now - t._streamAt < cfg.streamThrottleMs) return;
    let realRaw = tr.realTok != null ? Math.round(tr.realTok * 1e6) : (Number.isFinite(tr.vt) ? Math.round(tr.vt * 1e6) - VIRTUAL_GAP : NaN);
    if (!Number.isFinite(realRaw)) return;
    realRaw = Math.max(0, realRaw);
    const complete = realRaw === 0;
    if (!t) st.stream.mints++;
    const mcUsd = solUsd && tr.vt > 0 ? Math.round((tr.vs / tr.vt) * 1e9 * solUsd) : null;
    st.stream.upserts++;
    upsert({ mint: tr.mint, symbol: symbol ?? undefined, real_token_reserves: realRaw, complete, usd_market_cap: mcUsd, last_trade_timestamp: tr.ts ? tr.ts * 1000 : now, _initReal: Math.max(INITIAL_REAL, chain.get(tr.mint)?.initReal || 0) });
    const u = tracked.get(tr.mint); if (u) u._streamAt = now;
    if (complete) tracked.delete(tr.mint);
  }

  // ---- 2b. GeckoTerminal discovery (public, no key): most active pump-fun pools; the pool address is the bonding curve
  async function geckoPoll(force = false) {
    if (!st.gecko.enabled || stopped) return;
    const now = Date.now(); const streamAge = st.stream.lastAt ? now - Date.parse(st.stream.lastAt) : Infinity;
    const every = streamAge > cfg.geckoStaleMs ? cfg.geckoStaleMs : cfg.geckoMs;
    if (!force && now - geckoLastAt < every) return;
    if (!force && now < geckoBackoffUntil) { st.gecko.skippedBackoff = (st.gecko.skippedBackoff || 0) + 1; return; }
    geckoLastAt = now; st.gecko.polls++; st.gecko.lastAt = new Date().toISOString();
    let okSorts = 0; let rateLimited = false; let lastErr = null;
    for (const sort of ['h24_tx_count_desc', 'h24_volume_usd_desc']) {
      try {
        const r = await fetch(`${GECKO}/networks/solana/dexes/pump-fun/pools?page=1&sort=${sort}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { rateLimited = true; throw new Error('GeckoTerminal HTTP 429'); }
        if (!r.ok) throw new Error('GeckoTerminal HTTP ' + r.status);
        const j = await r.json();
        for (const p of j?.data || []) {
          const curve = p?.attributes?.address; const mint = p?.relationships?.base_token?.data?.id?.replace(/^solana_/, '');
          const symbol = (p?.attributes?.name || '').split(' / ')[0] || null;
          if (chainAddCurve({ mint, curve, symbol })) st.gecko.added++;
        }
        okSorts++;
      } catch (e) { lastErr = e.message; }
      if (rateLimited) break; // don't hammer a rate-limited API with the second request
      await sleep(1500);
    }
    if (okSorts > 0 && !lastErr) { st.gecko.ok++; st.gecko.lastError = null; geckoBackoffMs = 0; geckoBackoffUntil = 0; return; }
    if (okSorts > 0) st.gecko.ok++; else st.gecko.fail++;
    st.gecko.lastError = lastErr;
    if (rateLimited) {
      // exponential backoff on 429 (shared cloud IPs get throttled): 10 min, 20, 40, capped at 60 min; log only when it changes
      const prev = geckoBackoffMs;
      geckoBackoffMs = Math.min(60 * 60e3, prev ? prev * 2 : 10 * 60e3);
      geckoBackoffUntil = Date.now() + geckoBackoffMs; st.gecko.backoffUntil = new Date(geckoBackoffUntil).toISOString(); st.gecko.rateLimited = (st.gecko.rateLimited || 0) + 1;
      if (geckoBackoffMs !== prev) log('[radar] gecko rate-limited (429), backing off', Math.round(geckoBackoffMs / 60e3), 'min');
    } else log('[radar] gecko error:', lastErr);
  }

  function prune() {
    const cutoff = Date.now() - 3 * 3600e3;
    for (const [m, t] of tracked) if (t.lastSeenAt < cutoff) tracked.delete(m);
    if (tracked.size > cfg.maxTracked) { const old = [...tracked.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt).slice(0, tracked.size - cfg.maxTracked); for (const t of old) tracked.delete(t.mint); }
    if (decided.size > 5000) for (const k of [...decided.keys()].slice(0, 1000)) decided.delete(k);
  }
  function dueMs(c, now) {
    const age = now - c.createdAt;
    if (c.progress >= 40) return 15e3;
    if (age < 10 * 60e3) return 30e3; // fast launches can run to 70%+ in minutes
    if (c.progress >= 15) return 45e3;
    return age < 3600e3 ? 120e3 : 600e3;
  }
  function dead(c, now) {
    const age = now - c.createdAt;
    return (age > 30 * 60e3 && c.progress < 3) || (age > 2 * 3600e3 && c.progress < 10) || (age > 6 * 3600e3 && c.progress < 30) || age > 24 * 3600e3;
  }
  let chainBusy = false;
  async function chainTick() {
    if (chainBusy || stopped) return; chainBusy = true;
    try {
      const now = Date.now();
      for (const [m, c] of chain) if (dead(c, now)) { chain.delete(m); st.chain.dropped++; }
      const due = [...chain.values()].filter((c) => now - c.lastCheckAt >= dueMs(c, now)).sort((a, b) => b.progress - a.progress).slice(0, 1000);
      for (let i = 0; i < due.length; i += 100) {
        const batch = due.slice(i, i + 100);
        const prevTag = setCreditTag('tracker');
        const res = await rpc('getMultipleAccounts', [batch.map((c) => c.curve), { encoding: 'base64', dataSlice: { offset: 0, length: 49 } }]).finally(() => setCreditTag(prevTag));
        st.chain.batches++; st.chain.accountsRead += batch.length; st.chain.lastAt = new Date().toISOString();
        res.value.forEach((acc, k) => {
          const c = batch[k]; c.lastCheckAt = Date.now();
          if (!acc || acc.owner !== PUMP_PROGRAM) { chain.delete(c.mint); return; }
          const d = Buffer.from(acc.data[0], 'base64'); if (d.length < 49) return;
          const realTok = Number(d.readBigUInt64LE(24)); const complete = d[48] === 1;
          if (complete) { chain.delete(c.mint); tracked.delete(c.mint); return; }
          if (realTok > c.initReal) c.initReal = realTok;
          c.progress = Math.max(0, Math.round(((c.initReal - realTok) / c.initReal) * 1000) / 10);
          upsert({ mint: c.mint, name: c.name, symbol: c.symbol, real_token_reserves: realTok, complete: false, last_trade_timestamp: null, _initReal: c.initReal });
        });
      }
      st.chain.tracked = chain.size; st.chain.lastError = null;
    } catch (e) { st.chain.lastError = e.message; log('[radar] chain tick error:', e.message); }
    finally { chainBusy = false; }
  }

  function upsert(c) {
    const now = Date.now();
    const p = progressFromApi(c, c._initReal);
    const t = tracked.get(c.mint) || { firstSeenAt: now };
    Object.assign(t, { mint: c.mint, name: c.name ?? t.name, symbol: c.symbol ?? t.symbol, progress: p, mcUsd: c.usd_market_cap ?? t.mcUsd ?? null, lastTradeAt: c.last_trade_timestamp || t.lastTradeAt || null, lastSeenAt: now, complete: !!c.complete });
    tracked.set(c.mint, t);
    if (p != null && p >= cfg.thresholdPct && p < 100 && !c.complete) consider(t);
  }
  function consider(t) {
    if (decided.has(t.mint) || queued.has(t.mint) || isAlerted(t.mint)) return;
    queued.add(t.mint); queue.push(t.mint);
    log(`[radar] ${t.symbol || '?'} ${t.mint} crossed ${cfg.thresholdPct}% (seen at ${t.progress}%) -> queued`);
    work();
  }

  async function poll() {
    if (!useApi || Date.now() < apiPausedUntil) return;
    st.poll.count++; st.poll.lastAt = new Date().toISOString();
    try {
      let n = 0;
      for (let page = 0; page < cfg.pages; page++) {
        const u = `${API}/coins?offset=${page * cfg.pageLimit}&limit=${cfg.pageLimit}&sort=last_trade_timestamp&order=DESC&includeNsfw=true&complete=false`;
        const r = await fetch(u, { headers: { accept: 'application/json', origin: 'https://pump.fun', 'user-agent': 'Mozilla/5.0 BondRadar/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('pump.fun API HTTP ' + r.status);
        const list = await r.json();
        if (!Array.isArray(list)) throw new Error('pump.fun API: unexpected payload');
        list.forEach((c) => c?.mint && upsert(c)); n += list.length;
        if (list.length < cfg.pageLimit) break;
        await sleep(400);
      }
      st.poll.ok++; st.poll.lastOkAt = new Date().toISOString(); st.poll.lastCoins = n; st.poll.lastError = null; apiFailStreak = 0; apiPauses = 0;
    } catch (e) {
      st.poll.fail++; st.poll.lastError = e.message; apiFailStreak++;
      if (apiFailStreak >= 3) { const min = apiPauseMin(apiPauses++); apiPausedUntil = Date.now() + min * 60e3; st.poll.pausedUntil = new Date(apiPausedUntil).toISOString(); st.poll.pauses = apiPauses; log(`[radar] pump.fun API failing (${e.message}); pausing it ${min} min, on-chain tracker continues`); apiFailStreak = 2; } // still failing after a pause -> next failure re-pauses at once, for longer
      else log('[radar] poll error:', e.message);
    }
  }

  async function work() {
    if (working) return; working = true;
    try {
      while (queue.length && !stopped) {
        const mint = queue.shift();
        if (lastScanEnd && Date.now() - lastScanEnd < cfg.scanGapMs) await sleep(cfg.scanGapMs - (Date.now() - lastScanEnd)); // spread CPU on Render's 0.1 vCPU
        const day = new Date().toISOString().slice(0, 10);
        if (st.scans.day !== day) { st.scans.day = day; st.scans.today = 0; st.scans.deepToday = 0; for (const [m, v] of decided) if (v.budget) decided.delete(m); }
        if (st.scans.today >= cfg.maxScansPerDay) { st.scans.skippedBudget++; decided.set(mint, { at: Date.now(), clean: false, reasons: ['daily scan budget reached'], budget: true }); queued.delete(mint); continue; }
        if (creditStats().today >= cfg.dailyCreditCap) { st.scans.skippedCreditCap++; decided.set(mint, { at: Date.now(), clean: false, reasons: ['daily Helius credit cap reached'], budget: true }); queued.delete(mint); continue; }
        if ((tracked.get(mint)?.progress ?? 0) > cfg.maxPct) { decided.set(mint, { at: Date.now(), clean: false, reasons: ['too close to graduation to be useful'] }); queued.delete(mint); continue; }
        st.scans.today++; st.scans.total++;
        const t = tracked.get(mint) || { mint };
        let rep;
        setCreditTag('scan');
        try { rep = await analyze(mint).finally(() => { queued.delete(mint); setCreditTag('other'); lastScanEnd = Date.now(); }); }
        catch (e) {
          st.scans.errors++; log(`[radar] analyze ${mint} failed: ${e.message}`);
          const prev = decided.get(mint);
          if (!prev?.errored) { decided.set(mint, { at: Date.now(), errored: true }); setTimeout(() => { if (decided.get(mint)?.errored) { decided.delete(mint); const tt = tracked.get(mint); if (tt) consider(tt); } }, 120000); }
          else decided.set(mint, { at: Date.now(), clean: false, reasons: ['analyze failed twice: ' + e.message] });
          continue;
        }
        const res = cleanCheck(rep, cfg);
        decided.set(mint, { at: Date.now(), ...res, progress: rep.curve?.progressPct });
        const rec = { at: new Date().toISOString(), mint, symbol: rep.symbol, name: rep.name, progress: rep.curve?.progressPct, risk: rep.risk?.level, top10: rep.holders?.top10Pct, devSold: rep.dev?.hasSold ?? null, clean: res.clean, reasons: res.reasons, ms: rep.meta?.ms, rpcCalls: rep.meta?.rpcCalls };
        st.recent.unshift(rec); st.recent.length = Math.min(st.recent.length, 30);
        log(`[radar] ${res.clean ? 'CLEAN ✅' : 'dirty ❌'} ${rep.symbol} ${mint} curve ${rep.curve?.progressPct}% top10 ${rep.holders?.top10Pct}%${res.clean ? '' : ' — ' + res.reasons.join('; ')}`);
        if (res.clean) {
          st.scans.clean++;
          markAlerted(mint); // remembered across restarts so we don't re-scan it
          let deep = null;
          if (st.scans.deepToday >= cfg.maxDeepPerDay) { st.scans.deepSkippedBudget++; rec.deep = 'skipped: daily deep budget'; }
          else {
            st.scans.deepToday++; st.scans.deepTotal++;
            try { deep = await deepAnalyze(rep); }
            catch (e) { st.scans.deepErrors++; rec.deep = 'error: ' + e.message; log(`[radar] deep ${mint} failed: ${e.message}`); }
          }
          if (deep) {
            Object.assign(rec, { score: deep.score, hardFails: deep.hardFails, deepMs: deep.ms, uniqueBuyers: deep.trades.uniqueBuyers, washVolShare: deep.trades.washVolShare, botTxShare: deep.trades.botTxShare, cluster: deep.clusters.largestCluster, freshShare: deep.clusters.freshShare, devPrior: deep.dev.priorLaunches });
            log(`[radar]   deep ${rep.symbol}: score ${deep.score}/100${deep.hardFails.length ? ' HARD FAIL: ' + deep.hardFails.join('; ') : ''}`);
            picker?.addCandidate({ mint, symbol: rep.symbol, stage: 'deep', score: deep.score, parts: deep.parts, hardFails: deep.hardFails, rep, deep });
            try { await onAlert?.(rep, t, deep); } catch (e) { log('[radar] onAlert error:', e.message); }
          }
        } else { st.scans.dirty++; picker?.addCandidate({ mint, symbol: rep.symbol, stage: 'basic', reasons: res.reasons }); }
      }
    } finally { working = false; }
  }

  function connectWs() {
    if (stopped || !cfg.useWs) return;
    ws = new WebSocket(WS_URL, { handshakeTimeout: 15000 });
    let pingT = null;
    ws.on('open', () => {
      st.ws.connected = true; st.ws.connects++; wsBackoff = 1000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      pingT = setInterval(() => { try { ws.ping(); } catch {} }, 30000);
    });
    ws.on('message', (buf) => {
      let j; try { j = JSON.parse(buf); } catch { return; }
      if (onWsEvent) { try { onWsEvent(j); } catch {} }
      if (j.txType === 'create' && j.mint) { chainAdd(j); st.ws.newTokens++; st.ws.lastEventAt = new Date().toISOString(); st.ws.lastNewMint = j.mint; }
      else if (j.txType === 'migrate' || (j.mint && j.pool && !j.txType)) { st.ws.migrations++; st.ws.lastEventAt = new Date().toISOString(); if (j.mint) tracked.delete(j.mint); }
    });
    const retry = (why) => {
      clearInterval(pingT); if (!st.ws.connected && why == null) return;
      st.ws.connected = false; if (why) st.ws.lastError = why;
      if (stopped) return;
      setTimeout(connectWs, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 60000);
    };
    ws.on('error', (e) => { st.ws.lastError = e.message; });
    ws.on('close', (code) => retry(`closed ${code}`));
  }

  return {
    start() {
      if (st.running) return; st.running = true; stopped = false;
      log(`[radar] started: threshold ${cfg.thresholdPct}%, poll ${cfg.pollMs}ms, ${cfg.pages}x${cfg.pageLimit} coins, budget ${cfg.maxScansPerDay} scans + ${cfg.maxDeepPerDay} deep/day, credit cap ${cfg.dailyCreditCap}/day`);
      log(`[radar] sources: trade stream${useChain ? ' + on-chain tracker' : ''}${st.gecko.enabled ? ' + GeckoTerminal' : ''}${cfg.useWs ? ' + PumpPortal' : ''}${useApi ? ' + pump.fun API' : ''}`);
      if (useApi) { poll(); pollTimer = setInterval(poll, cfg.pollMs); }
      if (useChain) chainTimer = setInterval(chainTick, cfg.chainTickMs);
      if (st.gecko.enabled) { setTimeout(() => geckoPoll(true), 20000).unref?.(); geckoTimer = setInterval(() => geckoPoll(), 15000); }
      pruneTimer = setInterval(prune, 60000); connectWs();
    },
    stop() { stopped = true; st.running = false; clearInterval(pollTimer); clearInterval(chainTimer); clearInterval(geckoTimer); clearInterval(pruneTimer); try { ws?.close(); } catch {} },
    onTrade, geckoPoll, chainTick, prune,
    // today's scan counters survive restarts (same UTC day), so the daily scan budgets hold across deploys
    // also today's decided coins (compact: [mint, clean 0/1]), so a restart doesn't rescan coins it already judged
    // (measured 2026-10-26: 27 rescans / ~1.5k Helius credits in the first 6 min after a deploy)
    budgetSnapshot: () => {
      const d0 = Date.parse(new Date().toISOString().slice(0, 10));
      const dec = [...decided.entries()].filter(([, v]) => v.at >= d0 && !v.errored && !v.budget && !v.restored).sort((a, b) => b[1].at - a[1].at).slice(0, cfg.persistDecided).map(([m, v]) => [m, v.clean ? 1 : 0]);
      const prev = (st.restoredDecided || []).filter(([m]) => !dec.some(([x]) => x === m));
      const all = dec.concat(prev).slice(0, cfg.persistDecided);
      return all.length ? { day: st.scans.day, today: st.scans.today, deepToday: st.scans.deepToday, decided: all } : { day: st.scans.day, today: st.scans.today, deepToday: st.scans.deepToday };
    },
    restoreBudget(snap) {
      if (!snap || snap.day !== new Date().toISOString().slice(0, 10) || st.scans.restored) return false;
      if (st.scans.day !== snap.day) { st.scans.day = snap.day; st.scans.today = 0; st.scans.deepToday = 0; }
      st.scans.today += Number(snap.today) || 0; st.scans.deepToday += Number(snap.deepToday) || 0; st.scans.restored = true;
      const dec = Array.isArray(snap.decided) ? snap.decided.filter((x) => Array.isArray(x) && typeof x[0] === 'string').slice(0, cfg.persistDecided) : [];
      const at = Date.now(); for (const [m, c] of dec) if (!decided.has(m)) decided.set(m, { at, clean: !!c, reasons: ['judged earlier today, before a restart'], restored: true });
      st.restoredDecided = dec; st.scans.restoredDecided = dec.length;
      return true;
    },
    status() {
      const list = [...tracked.values()];
      const lastEvt = [st.poll.lastOkAt, st.ws.lastEventAt, st.chain.lastAt, st.stream.lastAt].filter(Boolean).sort().pop() || null;
      return {
        running: st.running, startedAt: st.startedAt, config: cfg, trackedCoins: list.length,
        aboveThreshold: list.filter((t) => t.progress >= cfg.thresholdPct && !t.complete).length,
        lastEventAt: lastEvt, sources: { stream: true, chain: useChain, gecko: st.gecko.enabled, pumpportal: cfg.useWs, pumpApi: useApi }, stream: st.stream, gecko: st.gecko, poll: st.poll, chain: { ...st.chain, tracked: chain.size }, ws: st.ws, scans: st.scans, alerts: st.alerts, queue: queue.length,
        hottest: list.filter((t) => !t.complete && t.progress != null).sort((a, b) => b.progress - a.progress).slice(0, 5).map((t) => ({ mint: t.mint, symbol: t.symbol, progress: t.progress, decided: decided.has(t.mint) ? (decided.get(t.mint).clean ? 'clean' : 'dirty') : null })),
        recentDecisions: st.recent.slice(0, 10), credits: creditStats(), picks: picker ? picker.status() : null,
      };
    },
  };
}

// exponential backoff while pump.fun's API keeps refusing us (30, 60, 120, 240 min cap); resets on the first good poll
const apiPauseMin = (n) => Math.min(30 * 2 ** n, 240);
module.exports = { createRadar, apiPauseMin, cleanCheck, progressFromApi, CFG };
