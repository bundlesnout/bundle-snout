// Bond Radar pick engine + public track record.
// Candidates (every coin the radar scanned) are kept for a rolling window. A coin "qualifies" when it passed the basic
// clean checks, has no deep hard-fail and scores >= RADAR_PICK_MIN_SCORE. The first qualifier opens a short contest;
// when it ends the best qualifier becomes the ONE pick, with a plain-language rationale comparing it to the rest.
// Picks are then tracked on DexScreener (free) for current/peak market cap, milestones, migration and rugs.
const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const PCFG = () => ({
  mode: (process.env.RADAR_MODE || 'demo').toLowerCase(),
  minScore: num('RADAR_PICK_MIN_SCORE', 70),
  contestMin: num('RADAR_PICK_CONTEST_MIN', 10),
  cooldownMin: num('RADAR_PICK_COOLDOWN_MIN', 30),
  windowMin: num('RADAR_PICK_WINDOW_MIN', 60),
  trackMs: num('RADAR_TRACK_MS', 180000),
  keepPicks: num('RADAR_KEEP_PICKS', 30),
});
const madrid = (d) => new Date(d).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const usd = (x) => (x == null ? '?' : '$' + Math.round(x).toLocaleString('en-US'));
const pct = (x) => Math.round((x || 0) * 100) + '%';
const LABEL = {
  uniqueBuyers: 'pocos compradores únicos', buyerVelocity: 'entran pocos compradores nuevos por minuto', sizeVariety: 'tamaños de compra poco variados',
  netInflow10m: 'poca entrada neta de SOL', momentum: 'la actividad se está enfriando', noUniformBots: 'compras diminutas/idénticas (bot de volumen)',
  noRegularBots: 'wallets con ritmo de reloj (bots)', noWash: 'mucho volumen de wallets que compran y venden (wash)', noCluster: 'holders financiados por la misma wallet',
  noFresh: 'muchas wallets recién creadas', devHistory: 'historial del dev dudoso o desconocido', socials: 'sin redes sociales',
};
const MAX = { uniqueBuyers: 10, buyerVelocity: 10, sizeVariety: 8, netInflow10m: 7, momentum: 5, noUniformBots: 8, noRegularBots: 7, noWash: 10, noCluster: 10, noFresh: 10, devHistory: 10, socials: 5 };
const weakest = (parts, n = 2) => { const w = Object.entries(parts || {}).map(([k, v]) => [k, v / MAX[k]]).filter(([k, r]) => r < 0.7 && k !== 'socials').sort((a, b) => a[1] - b[1]).slice(0, n).map(([k]) => LABEL[k]); return w.length ? w : ['sin un punto débil claro, solo menor nota total']; };

const BASIC = [[/dev sold/, 'el dev vendió'], [/top-10/, 'top 10 concentrado'], [/right behind the create/, 'snipers justo tras el create'], [/creation block bought/, 'bloque de creación con mucho supply'],
  [/multi-wallet/, 'tx multi-wallet (bundle)'], [/fee-paid by dev/, 'compras pagadas por el dev'], [/early wallets/, 'wallets tempranas aún cargadas'], [/dev holds/, 'el dev tiene demasiado'],
  [/bundle check unavailable/, 'sin datos del bloque de creación'], [/progress/, 'curva por debajo del umbral'], [/overall risk/, null]];
const basicLabel = (m) => { for (const [re, l] of BASIC) if (re.test(m)) return l; return m; };

function rationale(best, window) {
  const r = best.rep, d = best.deep, t = d.trades, c = d.clusters, dv = d.dev, so = d.socials;
  const L = [];
  L.push(`Elegida: ${r.name} ($${r.symbol}) — ${d.score}/100, ${madrid(Date.now())} (hora de Madrid). Curva ${r.curve.progressPct}% (faltan ${r.curve.quoteRemainingToGraduate.toFixed(1)} ${r.curve.quote}).`);
  L.push(`• Demanda: ${t.uniqueBuyers} compradores únicos en las últimas ${t.sampled} operaciones (${pct(t.uniqueBuyerRatio)} únicos), ${t.newBuyersSecondHalf} nuevos en la mitad más reciente; tamaños variados (CV ${t.buySizeCV}, media ${t.avgBuySol} SOL); ${t.netSol10 >= 0 ? '+' : ''}${t.netSol10} SOL netos en 10 min; actividad x${t.momentum} vs los 10 min anteriores.`);
  L.push(`• Bots: ${t.botWallets} wallets con ritmo de reloj (${pct(t.botTxShare)} de trades), ${pct(Math.max(t.tinyShare, t.modeShare))} compras diminutas/idénticas, ${pct(t.washVolShare)} del volumen de wallets que compran y venden.`);
  L.push(`• Holders: ${c.walletsChecked} wallets (top 10 + tempranas) revisadas: ${c.freshWallets} creadas <1h antes del lanzamiento, ${c.largestCluster.size >= 2 ? `mayor grupo con el mismo financiador: ${c.largestCluster.size} wallets (${c.largestCluster.pct}%)` : 'ningún grupo con el mismo financiador'}, ${c.devFundedHolders} financiadas por el dev. Top 10: ${r.holders.top10Pct}%.`);
  L.push(`• Dev: no ha vendido, tiene ${r.dev.holdingPctSupply}%; ${dv.priorLaunches ? `${dv.priorLaunches} lanzamientos previos vistos, ${dv.priorDead} muertos, ${dv.priorGraduated} graduados` : dv.walletSigs < 10 ? 'wallet nueva sin historial (no se puede juzgar)' : 'sin lanzamientos previos en su historial reciente'}. Bundle: ${r.bundle.sameSlotWallets} wallet(s) en el bloque de creación (${r.bundle.sameSlotPctSupply}%), 0 tx multi-wallet.`);
  L.push(`• Redes: ${['twitter', 'telegram', 'website'].filter((k) => so[k]).join(', ') || 'ninguna'}.`);
  const others = window.filter((x) => x.mint !== r.mint);
  const basic = others.filter((x) => x.stage === 'basic'); const deep = others.filter((x) => x.stage === 'deep');
  const reasonCount = new Map(); basic.forEach((x) => [...new Set((x.reasons || []).map(basicLabel).filter(Boolean))].slice(0, 2).forEach((k) => reasonCount.set(k, (reasonCount.get(k) || 0) + 1)));
  const top = [...reasonCount].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`).join('; ');
  L.push(`Frente a las otras ${others.length} candidatas de los últimos ${PCFG().windowMin} min: ${basic.length} cayeron en el filtro básico${top ? ` (${top})` : ''}.`);
  deep.sort((a, b) => b.score - a.score).slice(0, 4).forEach((x) => L.push(`  – $${x.symbol}: ${x.hardFails?.length ? 'descartada: ' + x.hardFails[0] : `${x.score}/100, más floja en: ${weakest(x.parts).join(', ')}`}`));
  L.push('Señales automáticas on-chain; no es consejo financiero ni garantía.');
  return L.join('\n').slice(0, 1800);
}

async function dexBatch(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('DexScreener HTTP ' + r.status);
    for (const p of await r.json()) {
      const m = p.baseToken?.address; if (!m) continue;
      const cur = out.get(m) || { mcUsd: 0, priceUsd: null, migrated: false };
      const mc = p.marketCap ?? p.fdv ?? 0;
      if (mc > cur.mcUsd) { cur.mcUsd = mc; cur.priceUsd = p.priceUsd ? Number(p.priceUsd) : null; }
      if (p.dexId && p.dexId !== 'pumpfun') cur.migrated = true;
      out.set(m, cur);
    }
  }
  return out;
}

function createPicker({ store, onPick = async () => {}, log = console.log }) {
  const cfg = PCFG();
  const window = []; // { at, mint, symbol, stage, reasons, score, parts, hardFails, rep?, deep? }
  if (!store.data.picks) store.data.picks = [];
  let contestEndsAt = null, contestTimer = null, lastPickAt = store.data.picks.length ? Date.parse(store.data.picks[store.data.picks.length - 1].at) : 0;
  const st = { candidates: 0, qualifiers: 0, contests: 0, trackPolls: 0, trackErrors: 0, lastTrackAt: null, lastTrackError: null };

  function prune() { const cut = Date.now() - cfg.windowMin * 60e3; while (window.length && window[0].at < cut) window.shift(); }
  function addCandidate(c) {
    prune(); st.candidates++;
    window.push({ at: Date.now(), ...c });
    const q = c.stage === 'deep' && !c.hardFails.length && c.score >= cfg.minScore;
    if (!q) return;
    st.qualifiers++;
    if (Date.now() - lastPickAt < cfg.cooldownMin * 60e3) { log(`[picks] ${c.symbol} qualifies (${c.score}) but cooldown active`); return; }
    if (!contestEndsAt) {
      contestEndsAt = Date.now() + cfg.contestMin * 60e3; st.contests++;
      log(`[picks] contest opened by ${c.symbol} (${c.score}); closes in ${cfg.contestMin} min`);
      contestTimer = setTimeout(closeContest, cfg.contestMin * 60e3);
    }
  }
  async function closeContest() {
    const start = contestEndsAt - cfg.contestMin * 60e3; contestEndsAt = null; prune();
    const qs = window.filter((x) => x.at >= start && x.stage === 'deep' && !x.hardFails.length && x.score >= cfg.minScore);
    if (!qs.length) return;
    const best = qs.sort((a, b) => b.score - a.score)[0];
    let entry = null;
    try { entry = (await dexBatch([best.mint])).get(best.mint) || null; } catch {}
    const pick = {
      id: `${Date.now().toString(36)}-${best.mint.slice(0, 6)}`, at: new Date().toISOString(), mode: cfg.mode, mint: best.mint, symbol: best.symbol, name: best.rep.name,
      score: best.score, parts: best.parts, progress: best.rep.curve.progressPct,
      entryMcUsd: entry?.mcUsd || best.rep.dex?.marketCapUsd || null, entryPriceUsd: entry?.priceUsd ?? best.rep.dex?.priceUsd ?? null, entrySource: entry ? 'dexscreener@pick' : 'dexscreener@scan',
      curMcUsd: null, peakMcUsd: null, peakAt: null, curMultiple: 1, peakMultiple: 1, milestones: {}, migrated: false, rugAt: null,
      candidatesCompared: window.length - 1, rationale: rationale(best, window),
    };
    pick.curMcUsd = pick.peakMcUsd = pick.entryMcUsd; pick.peakAt = pick.at;
    lastPickAt = Date.now();
    store.data.picks.push(pick); if (store.data.picks.length > cfg.keepPicks) store.data.picks.splice(0, store.data.picks.length - cfg.keepPicks);
    store.save();
    log(`[picks] PICK ${pick.symbol} ${pick.mint} score ${pick.score} entry ${usd(pick.entryMcUsd)}\n${pick.rationale}`);
    try { await onPick(pick); } catch (e) { log('[picks] onPick error', e.message); }
  }

  let lastTrackSave = 0;
  async function track() {
    const now = Date.now();
    const active = store.data.picks.filter((p) => now - Date.parse(p.at) < 7 * 86400e3 && p.entryMcUsd);
    if (!active.length) return;
    st.trackPolls++; st.lastTrackAt = new Date().toISOString();
    try {
      const data = await dexBatch(active.map((p) => p.mint)); let changed = false;
      for (const p of active) {
        const d = data.get(p.mint); if (!d) continue;
        const mult = d.mcUsd / p.entryMcUsd;
        p.curMcUsd = Math.round(d.mcUsd); p.curAt = new Date().toISOString(); p.curMultiple = Math.round(mult * 100) / 100;
        if (d.mcUsd > (p.peakMcUsd || 0)) { p.peakMcUsd = Math.round(d.mcUsd); p.peakAt = p.curAt; p.peakMultiple = Math.round(mult * 100) / 100; }
        for (const x of [2, 5, 10]) if (mult >= x && !p.milestones['x' + x]) { p.milestones['x' + x] = p.curAt; changed = true; log(`[picks] ${p.symbol} hit ${x}x`); }
        if (d.migrated && !p.migrated) { p.migrated = true; p.migratedAt = p.curAt; changed = true; }
        if (mult <= 0.2 && !p.rugAt) { p.rugAt = p.curAt; changed = true; }
      }
      st.lastTrackError = null;
      if (changed || now - lastTrackSave > 15 * 60e3) { lastTrackSave = now; store.save(); }
    } catch (e) { st.trackErrors++; st.lastTrackError = e.message; }
  }
  setInterval(track, cfg.trackMs).unref(); setTimeout(track, 15000).unref();

  return {
    addCandidate, closeContest, track,
    status: () => ({ config: cfg, ...st, contestOpenUntil: contestEndsAt ? new Date(contestEndsAt).toISOString() : null, lastPickAt: lastPickAt ? new Date(lastPickAt).toISOString() : null, windowSize: window.length,
      window: window.slice(-15).map((x) => ({ at: new Date(x.at).toISOString(), mint: x.mint, symbol: x.symbol, stage: x.stage, score: x.score ?? null, why: x.stage === 'basic' ? (x.reasons || []).slice(0, 2) : x.hardFails?.length ? x.hardFails : weakest(x.parts) })) }),
    picks: () => store.data.picks,
  };
}
module.exports = { createPicker, rationale, PCFG };
