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
    if (age > maxMs) console.log('[featured] board cache stale', Math.round(age / 60000), 'min (still under staleMax); using until browser refresh');
    else {
      // Sibling browser fetch writes the cache while box-ensure left NEED_BROWSER_FETCH set.
      // Clear it as soon as we actually consume a fresh snapshot so Vigilancia does not keep
      // treating a completed fetch as still pending (ops evidence 2026-11-06).
      try {
        const flag = path.join(path.dirname(p), 'NEED_BROWSER_FETCH');
        if (fs.existsSync(flag)) { fs.unlinkSync(flag); console.log('[featured] cleared NEED_BROWSER_FETCH (fresh board cache)'); }
      } catch {}
    }
    return entries;
  } catch { return null; }
}
const F = createFeatured({ getState: () => state, baseline, readBoardCache, excluded: (m) => EXCLUDE.has(m) || almaEx.has(m), isProtected: (w) => !!w && PROTECTED.has(w), devSold: (m) => devSold.has(m),
  familyExtra: () => Number(process.env.FAMILY_EXTRA || 24), log: console.log });
function save() {
  try { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE);
    const st = F.status(); st.runner = { host: 'box', savedAt: new Date().toISOString(), pid: process.pid }; fs.writeFileSync(STATUS, JSON.stringify(st, null, 1)); } catch (e) { console.error('[featured] save', e.message); }
}
(async () => {
  await syncAlma(); setInterval(syncAlma, 30 * 60e3);
  F.start(); setInterval(save, 60e3); save();
  // First board refresh is async inside start(); persist once it has had time to apply cache/live result.
  setTimeout(save, 15000);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { F.stop(); save(); process.exit(0); });
})();
