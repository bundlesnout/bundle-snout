// Deep on-chain analysis for Bond Radar candidates (only runs on coins that already passed the basic clean checks).
// Produces measurable signals + a 0-100 score + hard-fail reasons. Read-only. ~150-250 Helius credits per coin.
const { rpc, getTx, ownerDeltas, mapLimit, setCreditTag } = require('./analyzer');
const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const clamp = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const LAMPORTS = 1e9;

const mean = (a) => a.reduce((t, x) => t + x, 0) / (a.length || 1);
const cv = (a) => { if (a.length < 2) return 0; const m = mean(a); if (!m) return 0; return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m; };

// ---------- 1. trades sample (bot / wash / organic demand)
async function tradeSignals(rep) {
  const curve = rep.bondingCurve, mint = rep.mint;
  const sigs = (await rpc('getSignaturesForAddress', [curve, { limit: 1000 }])).filter((s) => !s.err && s.blockTime);
  const now = Math.floor(Date.now() / 1000);
  const last10 = sigs.filter((s) => s.blockTime >= now - 600).length, prev10 = sigs.filter((s) => s.blockTime < now - 600 && s.blockTime >= now - 1200).length;
  const sample = sigs.slice(0, num('DEEP_TX_SAMPLE', 120));
  const txs = await mapLimit(sample, 3, (s) => getTx(s.signature).catch(() => null));
  const trades = [];
  txs.forEach((tx) => {
    if (!tx || tx.meta?.err) return;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
    const ci = keys.indexOf(curve); if (ci < 0) return;
    const dSol = (tx.meta.postBalances[ci] - tx.meta.preBalances[ci]) / LAMPORTS;
    const deltas = [...ownerDeltas(tx, mint)].filter(([o]) => o !== curve && o !== rep.bondingCurve);
    if (!deltas.length || Math.abs(dSol) < 1e-6) return;
    deltas.sort((a, b) => (Math.abs(Number(b[1])) - Math.abs(Number(a[1]))));
    const [wallet, d] = deltas[0];
    trades.push({ wallet, side: d > 0n ? 'buy' : 'sell', sol: Math.abs(dSol), t: tx.blockTime, slot: tx.slot, feePayer: keys[0] });
  });
  const buys = trades.filter((t) => t.side === 'buy'), sells = trades.filter((t) => t.side === 'sell');
  const ts = trades.map((t) => t.t); const span = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 60 : 0;
  const uniq = (a) => new Set(a.map((t) => t.wallet)).size;
  // buyer growth: new buyers in the 2nd (more recent) half of the sample vs the 1st half
  const sorted = [...trades].sort((a, b) => a.t - b.t); const half = Math.floor(sorted.length / 2);
  const firstHalfBuyers = new Set(sorted.slice(0, half).filter((t) => t.side === 'buy').map((t) => t.wallet));
  const newInSecond = new Set(sorted.slice(half).filter((t) => t.side === 'buy' && !firstHalfBuyers.has(t.wallet)).map((t) => t.wallet)).size;
  // size uniformity
  const bsz = buys.map((b) => b.sol);
  const tinyShare = bsz.length ? bsz.filter((x) => x < 0.02).length / bsz.length : 0;
  const counts = new Map(); bsz.forEach((x) => { const k = x.toFixed(4); counts.set(k, (counts.get(k) || 0) + 1); });
  const modeCount = Math.max(0, ...counts.values()); const modeShare = bsz.length && modeCount >= 3 ? modeCount / bsz.length : 0;
  // per-wallet behaviour
  const byW = new Map(); trades.forEach((t) => { const w = byW.get(t.wallet) || []; w.push(t); byW.set(t.wallet, w); });
  let botTx = 0, washVol = 0; const botWallets = [], washWallets = [];
  const totalVol = trades.reduce((a, t) => a + t.sol, 0);
  for (const [w, list] of byW) {
    list.sort((a, b) => a.t - b.t);
    if (list.length >= 4) { const iv = list.slice(1).map((t, i) => t.t - list[i].t); if (cv(iv) < 0.25 && mean(iv) > 0) { botTx += list.length; botWallets.push(w); } }
    const nb = list.filter((t) => t.side === 'buy').length, ns = list.length - nb;
    if (nb >= 1 && ns >= 1 && list.length >= 3) { washVol += list.reduce((a, t) => a + t.sol, 0); washWallets.push(w); }
  }
  const slots = new Map(); buys.forEach((b) => { const s = slots.get(b.slot) || new Set(); s.add(b.wallet); slots.set(b.slot, s); });
  const sameSlotBursts = [...slots.values()].filter((s) => s.size >= 3).length;
  const recent = trades.filter((t) => t.t >= now - 600);
  const buySol10 = recent.filter((t) => t.side === 'buy').reduce((a, t) => a + t.sol, 0), sellSol10 = recent.filter((t) => t.side === 'sell').reduce((a, t) => a + t.sol, 0);
  return {
    sigsSeen: sigs.length, txPerMinLast10: r2(last10 / 10), txPerMinPrev10: r2(prev10 / 10), momentum: prev10 ? r2(last10 / prev10) : (last10 ? 2 : 0),
    sampled: trades.length, sampleMinutes: r2(span), buys: buys.length, sells: sells.length,
    uniqueBuyers: uniq(buys), uniqueSellers: uniq(sells), uniqueTraders: byW.size,
    uniqueBuyerRatio: buys.length ? r2(uniq(buys) / buys.length) : 0,
    buyersPerMin: span ? r2(uniq(buys) / span) : null, newBuyersSecondHalf: newInSecond, firstHalfBuyers: firstHalfBuyers.size,
    buySol: r2(bsz.reduce((a, x) => a + x, 0)), sellSol: r2(sells.reduce((a, t) => a + t.sol, 0)),
    buySol10: r2(buySol10), sellSol10: r2(sellSol10), netSol10: r2(buySol10 - sellSol10),
    avgBuySol: r2(mean(bsz)), buySizeCV: r2(cv(bsz)), tinyShare: r2(tinyShare), modeShare: r2(modeShare), modeSize: modeShare ? [...counts].find(([, c]) => c === modeCount)[0] : null,
    botWallets: botWallets.length, botTxShare: trades.length ? r2(botTx / trades.length) : 0,
    washWallets: washWallets.length, washVolShare: totalVol ? r2(washVol / totalVol) : 0, sameSlotBursts,
  };
}

// ---------- 2. wallet clustering (funding source + wallet age) of top holders and early buyers
async function walletInfo(w, cache) {
  if (cache.has(w)) return cache.get(w);
  const p = (async () => {
    const sigs = await rpc('getSignaturesForAddress', [w, { limit: 1000 }]).catch(() => null);
    if (!sigs) return { wallet: w, unknown: true };
    if (sigs.length >= 1000) return { wallet: w, established: true, sigs: sigs.length };
    const oldest = sigs[sigs.length - 1];
    const tx = await getTx(oldest.signature).catch(() => null);
    let funder = null;
    if (tx) {
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
      let best = 0; keys.forEach((k, i) => { const d = tx.meta.preBalances[i] - tx.meta.postBalances[i]; if (k !== w && d > best) { best = d; funder = k; } });
    }
    return { wallet: w, sigs: sigs.length, firstSeen: oldest.blockTime || null, funder };
  })();
  cache.set(w, p); return p;
}
async function clusterSignals(rep) {
  const createdAt = rep.creation?.time ? Date.parse(rep.creation.time) / 1000 : null;
  const dev = rep.dev?.wallet;
  const top = (rep.holders?.top10 || []).map((h) => ({ wallet: h.wallet, pct: h.pct, kind: 'top' }));
  const early = [...(rep.bundle?.sameSlotBuyers || []), ...(rep.bundle?.next2SlotList || [])].slice(0, 6).map((b) => ({ wallet: b.wallet, pct: b.stillHolds != null && rep.supply ? (b.stillHolds / rep.supply) * 100 : 0, kind: 'early' }));
  const map = new Map(); [...top, ...early].forEach((x) => { if (!map.has(x.wallet)) map.set(x.wallet, x); });
  const list = [...map.values()].slice(0, num('DEEP_WALLETS', 14));
  const cache = new Map();
  const infos = await mapLimit(list, 2, (x) => walletInfo(x.wallet, cache));
  const devInfo = dev ? await walletInfo(dev, cache) : null;
  infos.forEach((inf, i) => Object.assign(inf, list[i]));
  // funders that are very active (exchanges / hubs) don't count as a cluster
  const funders = [...new Set(infos.map((x) => x.funder).filter(Boolean))].slice(0, 10);
  const hub = new Set();
  await mapLimit(funders, 2, async (f) => { const s = await rpc('getSignaturesForAddress', [f, { limit: 1000 }]).catch(() => []); if (s.length >= 1000) hub.add(f); });
  const groups = new Map();
  infos.forEach((x) => { if (x.funder && !hub.has(x.funder)) { const g = groups.get(x.funder) || []; g.push(x); groups.set(x.funder, g); } });
  let maxCluster = { size: 0, pct: 0, funder: null };
  for (const [f, g] of groups) { const pct = g.reduce((a, x) => a + (x.pct || 0), 0); if (g.length >= 2 && (g.length > maxCluster.size || (g.length === maxCluster.size && pct > maxCluster.pct))) maxCluster = { size: g.length, pct: r2(pct), funder: f }; }
  const devFunded = infos.filter((x) => x.wallet !== dev && x.funder && dev && (x.funder === dev || (devInfo?.funder && x.funder === devInfo.funder && !hub.has(x.funder))));
  const checkable = infos.filter((x) => !x.unknown);
  const fresh = checkable.filter((x) => !x.established && x.firstSeen && createdAt && x.firstSeen > createdAt - 3600);
  return {
    walletsChecked: checkable.length, freshWallets: fresh.length, freshShare: checkable.length ? r2(fresh.length / checkable.length) : 0,
    freshPct: r2(fresh.reduce((a, x) => a + (x.pct || 0), 0)), establishedWallets: checkable.filter((x) => x.established).length,
    largestCluster: maxCluster, devFundedHolders: devFunded.length, devFundedPct: r2(devFunded.reduce((a, x) => a + (x.pct || 0), 0)),
    hubFunders: hub.size, devWalletSigs: devInfo?.sigs ?? null, devFirstSeen: devInfo?.firstSeen ?? null,
  };
}

// ---------- 3. dev history: previous pump.fun creations in the dev wallet and whether they died
async function devHistory(rep) {
  const dev = rep.dev?.wallet; if (!dev) return { known: false };
  const sigs = (await rpc('getSignaturesForAddress', [dev, { limit: 1000 }])).filter((s) => !s.err);
  const createSlot = rep.creation?.slot ?? Infinity;
  const before = sigs.filter((s) => s.slot < createSlot).slice(0, num('DEEP_DEV_TX', 40));
  const txs = await mapLimit(before, 3, (s) => getTx(s.signature).catch(() => null));
  const prior = [];
  txs.forEach((tx) => {
    if (!tx || !(tx.meta?.logMessages || []).some((l) => /Instruction: Create(V2)?$/.test(l))) return;
    const keys = tx.transaction.message.accountKeys;
    const m = keys.find((k) => k.signer && (k.pubkey || k) !== dev);
    if (m) prior.push(m.pubkey || m);
  });
  let dead = 0, graduated = 0; const outcomes = [];
  if (prior.length) {
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${prior.slice(0, 30).join(',')}`, { signal: AbortSignal.timeout(10000) });
      const pairs = r.ok ? await r.json() : [];
      for (const m of prior) {
        const ps = pairs.filter((p) => p.baseToken?.address === m);
        const mc = Math.max(0, ...ps.map((p) => p.marketCap ?? p.fdv ?? 0));
        const grad = ps.some((p) => p.dexId && p.dexId !== 'pumpfun');
        if (grad) graduated++; if (mc < 6000) dead++;
        outcomes.push({ mint: m, mcUsd: Math.round(mc), graduated: grad });
      }
    } catch {}
  }
  return { known: true, walletSigs: sigs.length, txScanned: before.length, priorLaunches: prior.length, priorDead: dead, priorGraduated: graduated, dumpedRatio: prior.length ? r2(dead / prior.length) : null, priorSample: outcomes.slice(0, 5) };
}

// ---------- 4. socials from token metadata JSON
async function socials(rep) {
  if (!rep.uri) return { twitter: false, telegram: false, website: false };
  const cid = rep.uri.match(/\/ipfs\/([^/?#]+)/)?.[1];
  const urls = cid ? ['https://pump.mypinata.cloud/ipfs/', 'https://gateway.pinata.cloud/ipfs/'].map((g) => g + cid) : [];
  urls.push(rep.uri);
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); if (!r.ok) continue;
      const j = await r.json();
      return { twitter: !!j.twitter, telegram: !!j.telegram, website: !!j.website, links: { twitter: j.twitter || null, telegram: j.telegram || null, website: j.website || null } };
    } catch {}
  }
  return { twitter: false, telegram: false, website: false, error: true };
}

// ---------- scoring (weights documented in README)
function score(s) {
  const t = s.trades, c = s.clusters, d = s.dev, so = s.socials;
  const parts = {
    uniqueBuyers: 10 * clamp((t.uniqueBuyerRatio - 0.3) / 0.5),
    buyerVelocity: 10 * clamp((t.buyersPerMin ?? 0) / 3),
    sizeVariety: 8 * clamp((t.buySizeCV - 0.3) / 1.0),
    netInflow10m: t.netSol10 > 0 ? 7 * clamp(t.netSol10 / 5) : 0,
    momentum: 5 * clamp((t.momentum - 0.5) / 1),
    noUniformBots: 8 * (1 - clamp(Math.max(t.tinyShare, t.modeShare) / 0.5)),
    noRegularBots: 7 * (1 - clamp(t.botTxShare / 0.4)),
    noWash: 10 * (1 - clamp(t.washVolShare / 0.4)),
    noCluster: c.largestCluster.size >= 2 ? 10 * (1 - clamp(c.largestCluster.pct / 15)) : 10,
    noFresh: 10 * (1 - clamp(c.freshShare / 0.6)),
    devHistory: !d.known ? 3 : d.priorLaunches === 0 ? (d.walletSigs < 10 ? 4 : 7) : Math.max(0, 10 * (1 - d.dumpedRatio) - (d.priorLaunches >= 5 ? 3 : 0)),
    socials: (so.twitter ? 2 : 0) + (so.telegram ? 1.5 : 0) + (so.website ? 1.5 : 0),
  };
  const fails = [];
  if (t.uniqueBuyers < num('DEEP_MIN_BUYERS', 15)) fails.push(`solo ${t.uniqueBuyers} compradores únicos en las últimas ${t.sampled} operaciones`);
  if (t.washVolShare >= 0.5) fails.push(`wash trading: ${Math.round(t.washVolShare * 100)}% del volumen de wallets que compran y venden en bucle`);
  if (t.botTxShare >= 0.5) fails.push(`${Math.round(t.botTxShare * 100)}% de las operaciones de bots con ritmo de reloj`);
  if (Math.max(t.tinyShare, t.modeShare) >= 0.6) fails.push(`bot de volumen: ${Math.round(Math.max(t.tinyShare, t.modeShare) * 100)}% de compras diminutas o idénticas`);
  if (c.largestCluster.size >= 3 && c.largestCluster.pct >= 15) fails.push(`${c.largestCluster.size} holders financiados por la misma wallet tienen el ${c.largestCluster.pct}%`);
  if (c.devFundedHolders >= 1 && c.devFundedPct >= 3) fails.push(`${c.devFundedHolders} holder(s) financiados por el dev tienen el ${c.devFundedPct}%`);
  if (c.freshShare >= 0.7) fails.push(`${Math.round(c.freshShare * 100)}% de las wallets top/tempranas son nuevas (creadas <1h antes del lanzamiento)`);
  if (d.known && d.priorLaunches >= 3 && d.dumpedRatio >= 0.8) fails.push(`dev en serie: ${d.priorDead}/${d.priorLaunches} lanzamientos previos muertos`);
  if (t.sellSol10 > 1.5 * t.buySol10 && t.sellSol10 > 2) fails.push(`presión vendedora: ${t.sellSol10} SOL vendidos vs ${t.buySol10} comprados en 10 min`);
  const total = Math.round(Object.values(parts).reduce((a, x) => a + x, 0));
  Object.keys(parts).forEach((k) => (parts[k] = r2(parts[k])));
  return { score: total, parts, hardFails: fails };
}

async function deepAnalyze(rep) {
  const t0 = Date.now(); setCreditTag('deep');
  try {
    const [trades, clusters, dev, so] = [await tradeSignals(rep), await clusterSignals(rep), await devHistory(rep), await socials(rep)];
    const s = { trades, clusters, dev, socials: so };
    return { ...s, ...score(s), ms: Date.now() - t0 };
  } finally { setCreditTag('other'); }
}

module.exports = { deepAnalyze, score };
