// Forward paper test (shadow only, never trades, never touches the treasury or the bandit): RANDOM entries on coins in
// pump.fun's featured board ("movers", the site's default home sort) with a low market cap, against a RANDOM baseline of
// low-cap coins from my own trade stream that are NOT on the board. Same buckets, same exits, same costs, so the only
// difference between the two is "was it featured". Board = https://advanced-indexer.pump.fun/boards/movers (the endpoint
// pump.fun's web app polls; public, no key, no Helius credits). Prices = the bonding-curve account read straight from the
// public RPC with getMultipleAccounts (one call per poll for every open coin, 0 Helius credits).
// NOT applied here: my scanner / rug filters (bundles, snipers, holder checks). Applied: my own coin and excluded mints,
// coins created by protected wallets (the dev wallet; read from the curve account), coins whose dev I saw selling.
const { PublicKey } = require('@solana/web3.js');
const { buyQuote } = require('./exec');
const { sellValue } = require('./scalp');

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const GRAD_HAIRCUT = 0.8;
const r1 = (x) => Math.round(x * 10) / 10, r6 = (x) => Math.round(x * 1e6) / 1e6;
const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const BUCKETS = [{ id: 'lt8k', min: 2000, max: 8000, label: '$2k-$8k' }, { id: '8to20k', min: 8000, max: 20000, label: '$8k-$20k' }, { id: '20to60k', min: 20000, max: 60000, label: '$20k-$60k (still on the curve)' }];
const EXITS = [{ tp: 20, sl: 15, hold: 15 }, { tp: 50, sl: 8, hold: 5 }, { tp: 30, sl: 10, hold: 10 }];
const SOURCES = { feat: 'random coin from pump.fun featured board', rand: 'random coin from my stream that is NOT featured (baseline)' };
const VARIANTS = []; for (const src of Object.keys(SOURCES)) for (const b of BUCKETS) for (const e of EXITS) VARIANTS.push({ id: `${src}_${b.id}_${e.tp}_${e.sl}_${e.hold}`, src, bucket: b.id, ...e });

// pump.fun BondingCurve: 8 disc, vTok, vSol, realTok, realSol, supply (u64), complete (bool @48), creator (pubkey @49)
function decodeCurveFull(b) {
  if (!b || b.length < 49) return null;
  const vt = Number(b.readBigUInt64LE(8)) / 1e6, vs = Number(b.readBigUInt64LE(16)) / 1e9, realTok = Number(b.readBigUInt64LE(24)) / 1e6;
  const creator = b.length >= 81 ? new PublicKey(b.subarray(49, 81)).toBase58() : null;
  return { vs, vt, complete: b[48] === 1 || realTok === 0, creator };
}
function zFor(k) { // two-sided normal quantile for alpha 0.05/k (Bonferroni)
  const tail = (z) => { const x = z / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x); };
  const target = 0.05 / Math.max(1, k); let lo = 0, hi = 8; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (tail(mid) > target) lo = mid; else hi = mid; } return (lo + hi) / 2;
}
const newState = (t) => ({ since: new Date(t).toISOString(), refreshes: 0, boardErrors: 0, picks: 0, fills: 0, dropped: 0, skips: {}, open: [], closed: [], byVar: {} });

function createFeatured({ getState, fetchFn = (...a) => fetch(...a), now = () => Date.now(), rng = Math.random, streamMints = () => null, solUsd = () => null,
  excluded = () => false, isProtected = () => false, devSold = () => false, costs = () => ({ curveFeePct: 1.25, routeFeePct: 0, txFeeSol: 0.000024 }), familyExtra = () => 0, baseline = null, onDirty = () => {}, log = () => {} } = {}) {
  const cfg = {
    enabled: process.env.AGENT_FEATURED_TEST !== '0',
    boardUrl: process.env.AGENT_FEATURED_URL || 'https://advanced-indexer.pump.fun/boards/movers?chains=solana&limit=100',
    shown: num('AGENT_FEATURED_TOP', 30),          // pump.fun's home board shows the first 30
    refreshMs: num('AGENT_FEATURED_REFRESH_SEC', 60) * 1000,
    enterProb: num('AGENT_FEATURED_ENTER_PROB', 0.5), // per bucket per refresh: random entry times, not every refresh
    rpcUrl: process.env.AGENT_CURVE_RPC_URL || 'https://api.mainnet-beta.solana.com', pollMs: num('AGENT_FEATURED_POLL_MS', 3000),
    size: num('AGENT_FEATURED_SIZE_SOL', 0.005), fillDelayMs: 5000, maxOpenPerVar: num('AGENT_FEATURED_MAX_OPEN', 8), maxOpen: 150, keepClosed: 30,
  };
  const RT = { blockedUntil: 0, blocked403: 0, lastBoardAt: null, lastBoardN: 0, lastBoardError: null, lastFeatured: 0, featuredSet: new Set(), boardSet: new Set(), polls: 0, pollErrors: 0, lastPollError: null, backoffUntil: 0, lastPollAt: null };
  const pda = new Map();
  const bcPda = (mint) => { let k = pda.get(mint); if (!k) { k = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP)[0].toBase58(); pda.set(mint, k); if (pda.size > 2000) pda.delete(pda.keys().next().value); } return k; };
  const S = () => { const s = getState(); if (!s) return null; if (!s.open || !s.byVar) Object.assign(s, newState(now())); return s; };
  const skip = (s, why) => { s.skips[why] = (s.skips[why] || 0) + 1; };
  const iso = (t) => new Date(t).toISOString();
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  function openFor(s, mint, src, bucket, symbol, mcUsd, rank, t) {
    for (const v of VARIANTS) {
      if (v.src !== src || v.bucket !== bucket) continue;
      if (s.open.length >= cfg.maxOpen) { skip(s, 'open cap'); return; }
      if (s.open.filter((p) => p.v === v.id).length >= cfg.maxOpenPerVar) { skip(s, 'variant open cap'); continue; }
      s.open.push({ v: v.id, mint, sym: symbol || null, mc: Math.round(mcUsd), rk: rank, pickAt: t, pending: 1, tp: v.tp, sl: v.sl, hold: v.hold });
    }
    s.picks++; onDirty();
  }
  async function refreshBoard() {
    const s = S(); if (!s || !cfg.enabled) return; const t = now(); if (t < RT.blockedUntil) return;
    let entries;
    try { const r = await fetchFn(cfg.boardUrl, { headers: { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (ALMA paper test)' }, signal: AbortSignal.timeout(10000) });
      // pump.fun's Cloudflare refuses some datacenter IPs (Render's): do not keep knocking, retry every 30 min
      if (r.status === 403) { RT.blocked403++; RT.blockedUntil = t + 30 * 60e3; throw new Error('board HTTP 403 (pump.fun Cloudflare refuses this server; retrying every 30 min)'); }
      if (!r.ok) throw new Error('board HTTP ' + r.status); const j = await r.json(); entries = Array.isArray(j?.entries) ? j.entries : null; if (!entries) throw new Error('board: no entries');
    } catch (e) { s.boardErrors++; RT.lastBoardError = String(e.message).slice(0, 100); onDirty(); return; }
    s.refreshes++; RT.lastBoardAt = t; RT.lastBoardN = entries.length; RT.lastBoardError = null;
    RT.boardSet = new Set(entries.map((e) => e.m)); const shown = entries.slice(0, cfg.shown);
    RT.featuredSet = new Set(shown.map((e) => e.m));
    const usd = solUsd();
    const feat = shown.map((e, i) => ({ e, i })).filter(({ e }) => e && e.m && e.c === 'solana:mainnet' && e.pg === 'pump' && (e.pa == null || e.pa === 'SOL') && /pump$/.test(e.m) && Number(e.p) < 100 && !(e.gd > 0) && Number.isFinite(e.mc));
    RT.lastFeatured = feat.length;
    const busy = (src, bucket, mint) => s.open.some((p) => p.mint === mint && p.v.startsWith(`${src}_${bucket}_`));
    for (const b of BUCKETS) {
      // featured pick
      if (rng() < cfg.enterProb) {
        const c = feat.filter(({ e }) => e.mc >= b.min && e.mc < b.max && !excluded(e.m) && !isProtected(e.dw) && !devSold(e.m) && !busy('feat', b.id, e.m));
        if (c.length) { const { e, i } = pick(c); openFor(s, e.m, 'feat', b.id, e.t || e.n, e.mc, i + 1, t); } else skip(s, `no featured coin ${b.id}`);
      }
      // baseline pick: active coins my stream sees (traded in the last 2 min), on the curve, not on the board at all
      if (rng() < cfg.enterProb) {
        let c = [];
        if (baseline) { const L = await baselineList(); c = L.filter((x) => !x.complete && x.lastAt > t - 120e3 && x.mcUsd >= b.min && x.mcUsd < b.max && !RT.boardSet.has(x.mint) && !excluded(x.mint) && !isProtected(x.creator) && !devSold(x.mint) && !busy('rand', b.id, x.mint)).map((x) => [x.mint, x.mcUsd]); }
        else { const mints = streamMints(); if (!mints || !usd) { skip(s, 'baseline: no stream/SOL price'); continue; }
        for (const [mint, m] of mints) { if (!m || m.complete || !(m.lastAt > t - 120e3) || !m.mcSol) continue; const mc = m.mcSol * usd;
          if (mc >= b.min && mc < b.max && !RT.boardSet.has(mint) && !excluded(mint) && !m.devSoldSeen && !devSold(mint) && !busy('rand', b.id, mint)) c.push([mint, mc]); } }
        if (c.length) { const [mint, mc] = pick(c); openFor(s, mint, 'rand', b.id, null, mc, null, t); } else skip(s, `no baseline coin ${b.id}`);
      }
    }
  }
  let blCache = null; // one baseline list per board refresh
  async function baselineList() { if (blCache && blCache.at === RT.lastBoardAt) return blCache.list; let list = []; try { list = await baseline(); } catch (e) { RT.lastBaselineError = String(e.message).slice(0, 80); } blCache = { at: RT.lastBoardAt, list }; return list; }
  async function readCurves(mints) {
    const out = new Map();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const r = await fetchFn(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [chunk.map(bcPda), { encoding: 'base64', commitment: 'confirmed' }] }), signal: AbortSignal.timeout(6000) });
      if (r.status === 429) { RT.backoffUntil = now() + 15e3; throw new Error('RPC 429'); }
      const j = await r.json(); const vals = j?.result?.value; if (!Array.isArray(vals)) throw new Error('RPC: ' + (j?.error?.message || 'no value'));
      vals.forEach((v, k) => { if (v?.data?.[0]) { const c = decodeCurveFull(Buffer.from(v.data[0], 'base64')); if (c) out.set(chunk[k], c); } });
    }
    return out;
  }
  let busyPoll = false;
  async function poll() {
    const s = S(); if (!s || busyPoll || !s.open.length || now() < RT.backoffUntil) return; busyPoll = true;
    try {
      const mints = [...new Set(s.open.map((p) => p.mint))]; RT.polls++; RT.lastPollAt = now();
      let curves; try { curves = await readCurves(mints); } catch (e) { RT.pollErrors++; RT.lastPollError = String(e.message).slice(0, 80); return; }
      const t = now(); const C = costs(); const sv = { feePct: C.curveFeePct + C.routeFeePct, txFeeSol: C.txFeeSol };
      for (const p of [...s.open]) {
        const c = curves.get(p.mint);
        if (p.pending) {
          if (t < p.pickAt + cfg.fillDelayMs) continue;
          if (!c || c.complete || (c.creator && isProtected(c.creator))) { drop(s, p, !c ? 'no curve account' : c.complete ? 'graduated before fill' : 'protected creator'); continue; }
          // a SOL-quoted curve starts near 30 virtual SOL and ends near 115; anything else is a token-quoted curve my SOL cost model does not fit
          if (!(c.vs >= 25 && c.vs <= 125)) { drop(s, p, 'not a SOL-quoted curve'); continue; }
          const bq = buyQuote(c.vs, c.vt, cfg.size, { curveFeePct: C.curveFeePct, routeFeePct: C.routeFeePct, netSol: C.txFeeSol });
          Object.assign(p, { pending: 0, at: t, solIn: bq.solIn, tok: bq.tok, cost: r6(cfg.size + C.txFeeSol), vs: c.vs, vt: c.vt }); delete p.pending; s.fills++; onDirty(); continue;
        }
        if (c && !c.complete) { p.vs = c.vs; p.vt = c.vt; }
        // graduated: the curve is closed and I could only sell in the new pool, which opened near 0.80x the final curve price in my research
        const val = Math.max(0, sellValue(p.vs, p.vt, p, sv) * (c?.complete ? GRAD_HAIRCUT : 1)); const pct = ((val - p.cost) / p.cost) * 100; const age = (t - p.at) / 60e3;
        let why = null;
        if (c?.complete) why = `graduated (sold in the pool at ${GRAD_HAIRCUT}x the last curve price)`; else if (pct >= p.tp) why = `take profit +${r1(pct)}%`; else if (pct <= -p.sl) why = `stop loss ${r1(pct)}%`; else if (age >= p.hold) why = `time stop ${r1(age)} min`;
        if (why) close(s, p, val, pct, age, why, t);
      }
    } finally { busyPoll = false; }
  }
  function drop(s, p, why) { s.open = s.open.filter((x) => x !== p); s.dropped++; skip(s, 'dropped: ' + why); onDirty(); }
  function close(s, p, val, pct, age, why, t) {
    s.open = s.open.filter((x) => x !== p); const pnl = r6(val - p.cost);
    s.closed.unshift({ v: p.v, mint: p.mint, sym: p.sym, mc: p.mc, rk: p.rk, at: iso(p.at), heldMin: r1(age), pnlPct: r1(pct), why }); s.closed.length = Math.min(s.closed.length, cfg.keepClosed);
    const a = s.byVar[p.v] || (s.byVar[p.v] = { n: 0, wins: 0, tp: 0, net: 0, s1: 0, s2: 0, eq: 0, pk: 0, dd: 0, d: {} });
    a.n++; if (pnl > 0) a.wins++; if (/^take profit/.test(why)) a.tp++; a.net = r6(a.net + pnl); a.s1 = r1(a.s1 + pct); a.s2 = Math.round(a.s2 + pct * pct);
    const day = iso(t).slice(0, 10); const b = a.d[day] || (a.d[day] = [0, 0]); b[0]++; b[1] = r1(b[1] + pct); const ks = Object.keys(a.d).sort(); while (ks.length > 4) delete a.d[ks.shift()];
    a.eq = r6(a.eq + pnl); a.pk = Math.max(a.pk, a.eq); a.dd = r6(Math.max(a.dd, a.pk - a.eq)); onDirty();
  }
  function edge(a, zf) {
    const n = a.n || 0; if (n < 30) return { ci95Pct: null, edge: 'too few trades (needs 30)', ciFamilyPct: null, edgeFamily: null };
    const mean = a.s1 / n, sd = Math.sqrt(Math.max(0, (a.s2 - n * mean * mean) / (n - 1))), se = sd / Math.sqrt(n), h = 1.96 * se, hs = zf * se;
    return { ci95Pct: [r1(mean - h), r1(mean + h)], edge: mean - h > 0 ? 'positive' : mean + h < 0 ? 'negative' : 'unproven', ciFamilyPct: [r1(mean - hs), r1(mean + hs)], edgeFamily: mean - hs > 0 ? 'positive' : mean + hs < 0 ? 'negative' : 'unproven' };
  }
  function status() {
    const s = S(); if (!s) return null; const K = VARIANTS.length + (familyExtra() || 0); const zf = zFor(K);
    const variants = VARIANTS.map((v) => { const a = s.byVar[v.id] || { n: 0, wins: 0, tp: 0, net: 0, s1: 0, dd: 0, d: {} };
      const byDay = Object.keys(a.d || {}).sort().map((d) => ({ day: d, n: a.d[d][0], avgPct: r1(a.d[d][1] / a.d[d][0]) }));
      return { id: v.id, source: v.src === 'feat' ? 'featured' : 'baseline (not featured)', mcBucket: BUCKETS.find((b) => b.id === v.bucket).label, exits: `+${v.tp}% / -${v.sl}% / ${v.hold} min`, closed: a.n, wins: a.wins,
        winRate: a.n ? r1((a.wins / a.n) * 100) : null, tpHitRatePct: a.n ? r1((a.tp / a.n) * 100) : null, avgPct: a.n ? r1(a.s1 / a.n) : null, netSol: a.net, maxDDSol: a.dd, byDay, open: s.open.filter((p) => p.v === v.id && !p.pending).length, ...edge(a, zf) }; });
    // featured minus baseline, same bucket and exits: is being featured worth anything?
    const vs = Object.fromEntries(variants.map((v) => [v.id, v])); const compare = [];
    for (const b of BUCKETS) for (const e of EXITS) { const f = vs[`feat_${b.id}_${e.tp}_${e.sl}_${e.hold}`], r = vs[`rand_${b.id}_${e.tp}_${e.sl}_${e.hold}`];
      compare.push({ bucket: b.label, exits: f.exits, featuredAvgPct: f.avgPct, featuredN: f.closed, baselineAvgPct: r.avgPct, baselineN: r.closed, diffPct: f.avgPct != null && r.avgPct != null ? r1(f.avgPct - r.avgPct) : null }); }
    const pos = variants.filter((v) => v.edgeFamily === 'positive').map((v) => v.id), pos95 = variants.filter((v) => v.edge === 'positive').map((v) => v.id);
    return { note: `Paper only. Random entries on pump.fun featured-board coins (top ${cfg.shown} of the movers board, still on the bonding curve) by market-cap bucket, vs random non-featured coins from my stream in the same bucket. Entry = the curve price read ${cfg.fillDelayMs / 1000}+ s after the pick, ${cfg.size} SOL, ${costs().curveFeePct}%/side pump.fun fee + network fee each way; exits checked on the curve account every ~${cfg.pollMs / 1000} s, so a fast dump can close past the stop (filled at the price I actually saw). My scanner / rug filters are NOT run here. Needs 30+ trades per variant and several days (byDay) before it means anything; ciFamilyPct corrects for testing ${K} variants at once.`,
      enabled: cfg.enabled, board: { url: cfg.boardUrl, refreshSec: cfg.refreshMs / 1000, lastAt: RT.lastBoardAt ? iso(RT.lastBoardAt) : null, entries: RT.lastBoardN, featuredOnCurve: RT.lastFeatured, lastError: RT.lastBoardError, refreshes: s.refreshes, errors: s.boardErrors, blocked403: RT.blocked403, nextTryAt: RT.blockedUntil > now() ? iso(RT.blockedUntil) : null }, baselineSource: baseline ? 'pump.fun recently-traded coins list (not on the movers board)' : 'my trade stream (not on the movers board)', lastBaselineError: RT.lastBaselineError || null,
      priceFeed: { polls: RT.polls, errors: RT.pollErrors, lastError: RT.lastPollError, lastAt: RT.lastPollAt ? iso(RT.lastPollAt) : null },
      since: s.since, picks: s.picks, fills: s.fills, dropped: s.dropped, skips: s.skips, openNow: s.open.filter((p) => !p.pending).length, pendingNow: s.open.filter((p) => p.pending).length, familyZ: Math.round(zf * 100) / 100,
      verdict: pos.length ? `positive after the multiple-testing correction: ${pos.join(', ')} (still needs several positive days)` : pos95.length ? `${pos95.join(', ')} look positive at 95% but not after correcting for ${K} variants: likely luck so far` : 'no variant shows a positive edge yet',
      compare, variants, closed: s.closed.slice(0, 20) };
  }
  const timers = [];
  return {
    start() { if (!cfg.enabled) return; S(); refreshBoard().catch(() => {}); timers.push(setInterval(() => refreshBoard().catch((e) => { RT.lastBoardError = e.message; }), cfg.refreshMs), setInterval(() => poll().catch((e) => { RT.lastPollError = e.message; }), cfg.pollMs)); timers.forEach((x) => x.unref?.()); log(`[featured] paper test on ${cfg.boardUrl} every ${cfg.refreshMs / 1000}s, ${VARIANTS.length} variants`); },
    stop() { timers.forEach(clearInterval); timers.length = 0; }, refreshBoard, poll, status, cfg, VARIANTS, RT, decodeCurveFull,
  };
}
module.exports = { createFeatured, decodeCurveFull, FEATURED_VARIANTS: VARIANTS, BUCKETS, EXITS };
