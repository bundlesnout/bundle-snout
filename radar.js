// Bond Radar — watches pump.fun for coins approaching graduation and alerts when they scan clean.
// Free sources only:
//  * pump.fun public frontend API (no key): recently-traded, not-yet-graduated coins incl. curve reserves -> progress.
//  * PumpPortal data websocket (no key): live new-token + migration events (liveness/stats; trade streams need a paid key).
// Helius is only used by the existing analyzer, once per mint that crosses the threshold, under a daily budget.
const WebSocket = require('ws');
const { analyze } = require('./analyzer');

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const CFG = () => ({
  thresholdPct: num('RADAR_THRESHOLD_PCT', 70),
  pollMs: num('RADAR_POLL_MS', 15000),
  pageLimit: num('RADAR_PAGE_LIMIT', 50),
  pages: num('RADAR_PAGES', 2),
  maxScansPerDay: num('RADAR_MAX_SCANS_PER_DAY', 300),
  maxPct: num('RADAR_MAX_PCT', 97), // skip coins that are basically graduating already
  // clean thresholds
  maxTop10Pct: num('RADAR_MAX_TOP10_PCT', 30),
  maxSameSlotPct: num('RADAR_MAX_SAMESLOT_PCT', 10),
  maxEarlyHoldPct: num('RADAR_MAX_EARLY_HOLD_PCT', 10),
  maxDevHoldPct: num('RADAR_MAX_DEV_HOLD_PCT', 10),
  allowDevSell: process.env.RADAR_ALLOW_DEV_SELL === '1',
  useWs: process.env.RADAR_WS !== '0',
});
const API = process.env.PUMP_API || 'https://frontend-api-v3.pump.fun';
const WS_URL = process.env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data';
const INITIAL_REAL = 793_100_000e6; // default initial real token reserves (raw, 6 decimals)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { clean, reasons[] } — every check must pass. Missing data = not clean.
function cleanCheck(r, cfg = CFG()) {
  const fail = [];
  const b = r.bundle, d = r.dev, h = r.holders, c = r.curve;
  if (!r.isPumpFun || !c) fail.push('not a pump.fun bonding curve');
  else if (c.complete) fail.push('already graduated');
  else if (c.progressPct < cfg.thresholdPct - 5) fail.push(`on-chain progress ${c.progressPct}% < threshold`);
  if (!b) fail.push('bundle check unavailable (creation tx not found)');
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

function progressFromApi(c) {
  if (c.complete) return 100;
  const rt = Number(c.real_token_reserves);
  if (!Number.isFinite(rt)) return null;
  return Math.max(0, Math.round(((INITIAL_REAL - rt) / INITIAL_REAL) * 1000) / 10);
}

function createRadar({ onAlert, isAlerted = () => false, markAlerted = () => {}, log = console.log } = {}) {
  const cfg = CFG();
  const tracked = new Map();   // mint -> { name, symbol, progress, mcUsd, lastTradeAt, firstSeenAt, lastSeenAt }
  const decided = new Map();   // mint -> { at, clean, reasons, progress }
  const queue = []; const queued = new Set(); // queued also covers the in-flight mint until it is decided
  const st = {
    startedAt: new Date().toISOString(), running: false,
    poll: { count: 0, ok: 0, fail: 0, lastAt: null, lastOkAt: null, lastError: null, lastCoins: 0 },
    ws: { connected: false, connects: 0, lastEventAt: null, newTokens: 0, migrations: 0, lastError: null, lastNewMint: null },
    scans: { today: 0, day: new Date().toISOString().slice(0, 10), total: 0, errors: 0, clean: 0, dirty: 0, skippedBudget: 0 },
    alerts: { sent: 0, lastAt: null, lastMint: null },
    recent: [],
  };
  let ws = null, wsBackoff = 1000, pollTimer = null, stopped = false, working = false;

  function upsert(c) {
    const now = Date.now();
    const p = progressFromApi(c);
    const t = tracked.get(c.mint) || { firstSeenAt: now };
    Object.assign(t, { mint: c.mint, name: c.name, symbol: c.symbol, progress: p, mcUsd: c.usd_market_cap ?? null, lastTradeAt: c.last_trade_timestamp || null, lastSeenAt: now, complete: !!c.complete });
    tracked.set(c.mint, t);
    if (p != null && p >= cfg.thresholdPct && p < 100 && !c.complete) consider(t);
  }
  function consider(t) {
    if (decided.has(t.mint) || queued.has(t.mint) || isAlerted(t.mint)) return;
    queued.add(t.mint); queue.push(t.mint);
    log(`[radar] ${t.symbol || '?'} ${t.mint} crossed ${cfg.thresholdPct}% (api ${t.progress}%) -> queued`);
    work();
  }

  async function poll() {
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
      st.poll.ok++; st.poll.lastOkAt = new Date().toISOString(); st.poll.lastCoins = n; st.poll.lastError = null;
    } catch (e) { st.poll.fail++; st.poll.lastError = e.message; log('[radar] poll error:', e.message); }
    // prune: coins not seen for 3h; cap memory
    const cutoff = Date.now() - 3 * 3600e3;
    for (const [m, t] of tracked) if (t.lastSeenAt < cutoff) tracked.delete(m);
    if (decided.size > 5000) for (const k of [...decided.keys()].slice(0, 1000)) decided.delete(k);
  }

  async function work() {
    if (working) return; working = true;
    try {
      while (queue.length && !stopped) {
        const mint = queue.shift();
        const day = new Date().toISOString().slice(0, 10);
        if (st.scans.day !== day) { st.scans.day = day; st.scans.today = 0; for (const [m, v] of decided) if (v.budget) decided.delete(m); }
        if (st.scans.today >= cfg.maxScansPerDay) { st.scans.skippedBudget++; decided.set(mint, { at: Date.now(), clean: false, reasons: ['daily scan budget reached'], budget: true }); queued.delete(mint); continue; }
        if ((tracked.get(mint)?.progress ?? 0) > cfg.maxPct) { decided.set(mint, { at: Date.now(), clean: false, reasons: ['too close to graduation to be useful'] }); queued.delete(mint); continue; }
        st.scans.today++; st.scans.total++;
        const t = tracked.get(mint) || { mint };
        let rep;
        try { rep = await analyze(mint).finally(() => queued.delete(mint)); }
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
          if (!isAlerted(mint)) {
            markAlerted(mint);
            st.alerts.sent++; st.alerts.lastAt = new Date().toISOString(); st.alerts.lastMint = mint;
            try { await onAlert?.(rep, t); } catch (e) { log('[radar] onAlert error:', e.message); }
          }
        } else st.scans.dirty++;
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
      if (j.txType === 'create' && j.mint) { st.ws.newTokens++; st.ws.lastEventAt = new Date().toISOString(); st.ws.lastNewMint = j.mint; }
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
      log(`[radar] started: threshold ${cfg.thresholdPct}%, poll ${cfg.pollMs}ms, ${cfg.pages}x${cfg.pageLimit} coins, budget ${cfg.maxScansPerDay} scans/day`);
      poll(); pollTimer = setInterval(poll, cfg.pollMs); connectWs();
    },
    stop() { stopped = true; st.running = false; clearInterval(pollTimer); try { ws?.close(); } catch {} },
    status() {
      const list = [...tracked.values()];
      const lastEvt = [st.poll.lastOkAt, st.ws.lastEventAt].filter(Boolean).sort().pop() || null;
      return {
        running: st.running, startedAt: st.startedAt, config: cfg, trackedCoins: list.length,
        aboveThreshold: list.filter((t) => t.progress >= cfg.thresholdPct && !t.complete).length,
        lastEventAt: lastEvt, poll: st.poll, ws: st.ws, scans: st.scans, alerts: st.alerts, queue: queue.length,
        hottest: list.filter((t) => !t.complete && t.progress != null).sort((a, b) => b.progress - a.progress).slice(0, 5).map((t) => ({ mint: t.mint, symbol: t.symbol, progress: t.progress, decided: decided.has(t.mint) ? (decided.get(t.mint).clean ? 'clean' : 'dirty') : null })),
        recentDecisions: st.recent.slice(0, 10),
      };
    },
  };
}

module.exports = { createRadar, cleanCheck, progressFromApi, CFG };
