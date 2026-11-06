// Box-side runner of the featured-board paper test (featured.js). pump.fun's Cloudflare refuses Render's IP for the board
// endpoint, so the same test runs here, where the board loads like it does in a browser. Paper only: no wallet, no keys,
// no Helius credits (board + recently-traded list from pump.fun, prices from the public Solana RPC).
// State: FEATURED_STATE (default /workspace/agentdata/featured-state.json), status: FEATURED_STATUS (…/featured-status.json).
const fs = require('fs'); const path = require('path');
const { createFeatured } = require('../featured');
const STATE = process.env.FEATURED_STATE || '/workspace/agentdata/featured-state.json';
const STATUS = process.env.FEATURED_STATUS || path.join(path.dirname(STATE), 'featured-status.json');
const EXCLUDE = new Set((process.env.AGENT_EXCLUDE_CA || '').split(',').map((x) => x.trim()).filter(Boolean));
const PROTECTED = new Set(['9piBCsKoxYEs3MaE1eV6ZAEfGbyWDqEv23mRYo71X7ys', '76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm', ...(process.env.AGENT_PROTECTED_WALLETS || '').split(',').filter(Boolean)]);
const UA = { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (ALMA paper test)' };
const ALMA = process.env.ALMA_URL || 'https://bundle-snout.onrender.com/api/agent';

let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const devSold = new Set(); let almaEx = new Set();
async function syncAlma() { // ALMA's own excluded coins (its coin, RIPS) so the box never picks what ALMA never trades
  try { const r = await fetch(ALMA, { signal: AbortSignal.timeout(20000) }); const j = await r.json(); const ex = j?.rules?.neverTrades || j?.rules?.hard?.neverTrades; if (Array.isArray(ex)) almaEx = new Set(ex); const pw = j?.rules?.protectedWallets || j?.rules?.hard?.protectedWallets; if (Array.isArray(pw)) pw.forEach((w) => PROTECTED.add(w)); } catch {}
}
async function baseline() {
  // pump.fun's HTTP APIs are often Cloudflare-403 from this box; DexScreener stays reachable for a weaker but usable baseline.
  try {
    const r = await fetch('https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { headers: UA, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const L = await r.json();
      const out = (Array.isArray(L) ? L : []).filter((c) => c && c.mint && /pump$/.test(c.mint) && (c.quote_mint == null || c.quote_mint === '11111111111111111111111111111111') && (c.program == null || c.program === 'pump'))
        .map((c) => ({ mint: c.mint, mcUsd: Number(c.usd_market_cap) || 0, lastAt: Number(c.last_trade_timestamp) || 0, complete: !!c.complete, creator: c.creator || null }));
      if (out.length) return out;
    }
  } catch {}
  const r2 = await fetch('https://api.dexscreener.com/latest/dex/search?q=pump.fun', { signal: AbortSignal.timeout(10000) });
  if (!r2.ok) throw new Error('baseline HTTP ' + r2.status);
  const j = await r2.json(); const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
  const now = Date.now();
  return pairs.filter((p) => p && p.chainId === 'solana' && p.dexId === 'pumpfun' && p.baseToken?.address && /pump$/i.test(p.baseToken.address))
    .map((p) => ({ mint: p.baseToken.address, mcUsd: Number(p.marketCap || p.fdv) || 0, lastAt: now, complete: false, creator: null }));
}
// Last mtime observed while age>maxMs. After a browser refresh the file mtime jumps and age
// drops under maxMs; log that transition once so Vigilancia does not keep reading a stale-only
// tail (ops evidence 2026-11-06: log still said "stale 120 min" after NEED_BROWSER_FETCH clear).
let lastStaleBoardMtime = 0;
// Ops evidence 2026-11-06 vigilancia: stale log fired every ~60s refresh while waiting for
// browser board fetch, flooding featured-runner.log so the tail looked "stuck" on stale.
// Log once per 15 min age bucket (and on first stale observation) until fresh again.
let lastStaleLogKey = '';
function readBoardCache() {
  // Fresh target ~45 min (FEATURED_BOARD_CACHE_MAX_MS). During long Cloudflare 403s + box pauses,
  // Vigilancia often cannot refresh within 45 min; prefer a browser snapshot up to 3 h old over an
  // empty board so the featured side of the A/B test keeps collecting (ops evidence 2026-11-05/06).
  const p = process.env.FEATURED_BOARD_CACHE || '/workspace/agentdata/featured-board.json';
  const maxMs = Number(process.env.FEATURED_BOARD_CACHE_MAX_MS || 45 * 60e3);
  const staleMaxMs = Number(process.env.FEATURED_BOARD_CACHE_STALE_MAX_MS || 3 * 60 * 60e3);
  try {
    const st = fs.statSync(p);
    const age = Date.now() - st.mtimeMs;
    if (age > staleMaxMs) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entries = Array.isArray(j?.entries) ? j.entries : null;
    if (!entries || !entries.length) return null;
    if (age > maxMs) {
      lastStaleBoardMtime = st.mtimeMs;
      const bucket = Math.floor(age / (15 * 60e3));
      const key = st.mtimeMs + ':' + bucket;
      if (key !== lastStaleLogKey) {
        lastStaleLogKey = key;
        console.log('[featured] board cache stale', Math.round(age / 60000), 'min (still under staleMax); using until browser refresh');
      }
    } else {
      if (lastStaleBoardMtime && st.mtimeMs > lastStaleBoardMtime) {
        console.log('[featured] board cache fresh again', Math.round(age / 60000), 'min age (browser refresh applied)');
        lastStaleBoardMtime = 0;
        lastStaleLogKey = '';
      }
      // Sibling browser fetch writes the cache while box-ensure left NEED_BROWSER_FETCH set.
      // Clear only when the board file is at least as new as the flag: otherwise a 35–45 min
      // cache is "fresh" to FEATURED_BOARD_CACHE_MAX_MS but box-ensure still requested a refresh
      // (threshold 35 min), and wiping the flag cancelled the pending browser fetch
      // (ops evidence 2026-11-06 vigilancia: ensure→NEED_BROWSER_FETCH vs runner age<45m clear).
      try {
        const flag = path.join(path.dirname(p), 'NEED_BROWSER_FETCH');
        if (fs.existsSync(flag) && st.mtimeMs >= fs.statSync(flag).mtimeMs) {
          fs.unlinkSync(flag);
          console.log('[featured] cleared NEED_BROWSER_FETCH (fresh board cache)');
        }
      } catch {}
    }
    return entries;
  } catch { return null; }
}
function _resetBoardCacheStaleObs() { lastStaleBoardMtime = 0; lastStaleLogKey = ''; }

// Ops evidence 2026-11-06 vigilancia: board sat ~113 min stale between 2h routine browser
// fetches; status only had fromCache/lastError so ops had to stat files separately.
// Surface cache age + NEED_BROWSER_FETCH on every status save for monitoring.
function enrichBoardCacheStatus(st) {
  if (!st || typeof st !== 'object') return st;
  const p = process.env.FEATURED_BOARD_CACHE || '/workspace/agentdata/featured-board.json';
  const maxMs = Number(process.env.FEATURED_BOARD_CACHE_MAX_MS || 45 * 60e3);
  const staleMaxMs = Number(process.env.FEATURED_BOARD_CACHE_STALE_MAX_MS || 3 * 60 * 60e3);
  const flag = path.join(path.dirname(p), 'NEED_BROWSER_FETCH');
  const metaPath = path.join(path.dirname(p), 'featured-board.meta.json');
  const info = { path: p, maxSec: Math.round(maxMs / 1000), staleMaxSec: Math.round(staleMaxMs / 1000), needBrowserFetch: false };
  try { info.needBrowserFetch = fs.existsSync(flag); } catch {}
  try {
    const stt = fs.statSync(p);
    const ageSec = Math.max(0, Math.round((Date.now() - stt.mtimeMs) / 1000));
    info.ageSec = ageSec;
    info.mtime = new Date(stt.mtimeMs).toISOString();
    info.stale = ageSec > Math.round(maxMs / 1000);
    info.usable = ageSec <= Math.round(staleMaxMs / 1000);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && typeof meta === 'object') {
        if (meta.savedAt) info.metaSavedAt = meta.savedAt;
        if (meta.entries != null) info.metaEntries = meta.entries;
        if (meta.source) info.source = meta.source;
      }
    } catch {}
  } catch {
    info.ageSec = null;
    info.mtime = null;
    info.stale = true;
    info.usable = false;
  }
  // Ops evidence 2026-11-06 vigilancia: after box-ensure restart, first save()
  // (before refreshBoard resolves) wrote board.entries=0 fromCache=false while
  // featured-board.json still had ~92 usable entries / age ~2h — misleading ops.
  // Hydrate empty board status from the usable cache file and treat stale age as
  // needBrowserFetch even before NEED_BROWSER_FETCH is written.
  if (info.usable && info.ageSec != null) {
    let n = Number(info.metaEntries) || 0;
    if (!(n > 0)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        n = Array.isArray(j?.entries) ? j.entries.length : 0;
        if (n > 0) info.metaEntries = n;
      } catch {}
    }
    info.cacheEntries = n > 0 ? n : 0;
  } else {
    info.cacheEntries = 0;
  }
  const needsFetch = !!(info.needBrowserFetch || info.stale);
  info.needBrowserFetch = needsFetch;
  st.boardCache = info;
  if (st.board && typeof st.board === 'object') {
    st.board.cacheAgeSec = info.ageSec;
    st.board.cacheStale = !!info.stale;
    st.board.needBrowserFetch = needsFetch;
    if (!(st.board.entries > 0) && info.cacheEntries > 0) {
      st.board.entries = info.cacheEntries;
      st.board.fromCache = true;
      if (!/using browser board cache/.test(String(st.board.lastError || ''))) {
        st.board.lastError = 'using browser board cache';
      }
    }
  }
  return st;
}


// Ops evidence 2026-11-07 vigilancia: box-ensure restarts featured after a box pause
// (board.lastAt frozen >10 min). In-memory RT.blockedUntil was wiped so the new process
// immediately re-hit Cloudflare (blocked403++) even when status.board.nextTryAt was still
// in the future — same class of bug early-runner fixed with listNextTryAt persistence.
// Restore board 403 backoff from featured-status.json before start() so the first
// refreshBoard uses the browser cache and skips the live movers fetch.
function readPersistedBoardBlockedUntil(statusPath = STATUS, nowMs = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const iso = j?.board?.nextTryAt;
    if (!iso) return { until: 0 };
    const until = Date.parse(iso);
    if (!Number.isFinite(until) || until <= nowMs) return { until: 0 };
    return {
      until,
      iso,
      blocked403: Number(j.board.blocked403) || 0,
      lastError: j.board.lastError || null,
      fromCache: !!j.board.fromCache,
    };
  } catch {
    return { until: 0 };
  }
}
function restoreBoard403Backoff(F, statusPath = STATUS, nowMs = Date.now(), logFn = console.log) {
  if (!F || !F.RT) return false;
  const r = readPersistedBoardBlockedUntil(statusPath, nowMs);
  if (!(r.until > nowMs)) return false;
  F.RT.blockedUntil = r.until;
  if (r.blocked403 > 0) F.RT.blocked403 = Math.max(F.RT.blocked403 || 0, r.blocked403);
  F.RT.boardFromCache = true;
  const note = r.lastError && /403|backoff|cache/i.test(String(r.lastError))
    ? String(r.lastError).slice(0, 160)
    : 'board blocked (403 backoff); using browser board cache';
  F.RT.lastBoardError = note;
  logFn('[featured] board 403 backoff restored until', r.iso, `(${Math.round((r.until - nowMs) / 60000)} min left; skip live board fetch)`);
  return true;
}

function startFeaturedRunner() {
  const F = createFeatured({ getState: () => state, baseline, readBoardCache, excluded: (m) => EXCLUDE.has(m) || almaEx.has(m), isProtected: (w) => !!w && PROTECTED.has(w), devSold: (m) => devSold.has(m),
    familyExtra: () => Number(process.env.FAMILY_EXTRA || 24), log: console.log });
  function save() {
    try { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE);
      const st = F.status(); st.runner = { host: 'box', savedAt: new Date().toISOString(), pid: process.pid };
      enrichBoardCacheStatus(st);
      fs.writeFileSync(STATUS, JSON.stringify(st, null, 1)); } catch (e) { console.error('[featured] save', e.message); }
  }
  (async () => {
    await syncAlma(); setInterval(syncAlma, 30 * 60e3);
    // Restore CF backoff before start() so the first refreshBoard does not re-hit movers.
    restoreBoard403Backoff(F);
    F.start(); setInterval(save, 60e3); save();
    // First board refresh is async inside start(); persist once it has had time to apply cache/live result.
    // Also save at 2s so a fresh 403 backoff (if restore missed / expired) lands in status before a quick restart.
    setTimeout(save, 2000);
    setTimeout(save, 15000);
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { F.stop(); save(); process.exit(0); });
  })();
  return F;
}
if (require.main === module) startFeaturedRunner();
module.exports = { readBoardCache, _resetBoardCacheStaleObs, enrichBoardCacheStatus, readPersistedBoardBlockedUntil, restoreBoard403Backoff, startFeaturedRunner };
