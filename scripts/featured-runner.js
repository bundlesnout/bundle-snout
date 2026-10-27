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
  const r = await fetch('https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('recent coins HTTP ' + r.status); const L = await r.json();
  return (Array.isArray(L) ? L : []).filter((c) => c && c.mint && /pump$/.test(c.mint) && (c.quote_mint == null || c.quote_mint === '11111111111111111111111111111111') && (c.program == null || c.program === 'pump'))
    .map((c) => ({ mint: c.mint, mcUsd: Number(c.usd_market_cap) || 0, lastAt: Number(c.last_trade_timestamp) || 0, complete: !!c.complete, creator: c.creator || null }));
}
const F = createFeatured({ getState: () => state, baseline, excluded: (m) => EXCLUDE.has(m) || almaEx.has(m), isProtected: (w) => !!w && PROTECTED.has(w), devSold: (m) => devSold.has(m),
  familyExtra: () => Number(process.env.FAMILY_EXTRA || 24), log: console.log });
function save() {
  try { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE);
    const st = F.status(); st.runner = { host: 'box', savedAt: new Date().toISOString(), pid: process.pid }; fs.writeFileSync(STATUS, JSON.stringify(st, null, 1)); } catch (e) { console.error('[featured] save', e.message); }
}
(async () => {
  await syncAlma(); setInterval(syncAlma, 30 * 60e3);
  F.start(); setInterval(save, 60e3); save();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { F.stop(); save(); process.exit(0); });
})();
