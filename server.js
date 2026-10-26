// Web UI + API + (optional) Telegram webhook in one process.
// Env: PORT, RPC_URL, BOT_MODE=webhook|off (default off), TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL, WEBHOOK_AUTO_SET=1
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { analyze } = require('./analyzer');
const app = express();
const PORT = Number(process.env.PORT || 8787);
const BOT_MODE = (process.env.BOT_MODE || 'off').toLowerCase();
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (!process.env.PUBLIC_URL && PUBLIC_URL) process.env.PUBLIC_URL = PUBLIC_URL; // used by format.js links
const cache = new Map(); const TTL = 60_000;
let busy = 0; const MAX_BUSY = 2;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/analyze/:mint', async (req, res) => {
  const mint = req.params.mint.trim();
  if (!MINT_RE.test(mint)) return res.status(400).json({ error: 'Mint inválido / invalid mint' });
  const c = cache.get(mint);
  if (c && Date.now() - c.at < TTL) return res.json({ ...c.data, cached: true });
  if (busy >= MAX_BUSY) return res.status(429).json({ error: 'Ocupado, reintenta en unos segundos / Busy, retry in a few seconds' });
  busy++;
  try { const data = await analyze(mint); cache.set(mint, { at: Date.now(), data }); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
  finally { busy--; }
});
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/health', (_, res) => { res.set('cache-control', 'no-store'); const a = agent?.activity?.(); res.json({ ok: true, uptimeSec: Math.round(process.uptime()), agent: a ? { activity: a.key, loopRunning: a.loop.running, scannedLastMin: a.scannedLastMin, streamConnected: a.stream.connected } : null }); });

// ---- Bond Radar (watcher) + persistence
const { createRadar } = require('./radar');
const { createStore } = require('./state');
const store = createStore();
let bot = null; let radar = null;
const { createPicker } = require('./picks');
let picker = null;
// ---- Bot-Volume Scalper + Ride-to-Bonding (PAPER TRADING ONLY; free public Solana RPC log stream, 0 Helius credits)
const createdSyms = new Map(); // mint -> symbol, fed by the radar's PumpPortal create stream
const mref = new Map(); // mint -> scalper's live market object (last ~5 min of trades), for the /m price charts
setInterval(() => { const t = Date.now(); for (const [k, m] of mref) if (t - (m.lastAt || 0) > 600e3) mref.delete(k); }, 60e3).unref();
let scalper = null;
if (process.env.SCALP_ENABLED !== '0') {
  const { createScalper, renderEnvStore } = require('./scalp');
  scalper = createScalper({ store: renderEnvStore(), symbolOf: (m) => createdSyms.get(m), onTradeHook: (tr, m) => {
    mref.set(tr.mint, m);
    try { agent?.onTrade(tr, m); } catch (e) { console.error('[agent] trade hook', e.message); }
    try { postmig?.onCurveTrade(tr, m); } catch (e) { console.error('[postmig] trade hook', e.message); } // paper-only shadow (never trades)
    try { radar?.onTrade(tr, { symbol: createdSyms.get(tr.mint) || null, solUsd: scalper?.solUsd?.() }); } catch (e) { console.error('[radar] trade hook', e.message); } // Bond Radar's primary source
  } });
  scalper.start().catch((e) => console.error('[scalp] start failed', e.message));
}
const onWsEvent = (j) => { if (j.txType === 'create' && j.mint && j.symbol) { createdSyms.set(j.mint, j.symbol); if (createdSyms.size > 20000) createdSyms.delete(createdSyms.keys().next().value); } };
if (process.env.RADAR_ENABLED !== '0') {
  // RADAR_MODE=demo (default): picks are only recorded + shown on /radar. RADAR_MODE=live: picks are also sent to /radar subscribers.
  picker = createPicker({ store, onPick: async (pick) => {
    if (pick.mode !== 'live') return console.log(`[radar] demo mode: pick ${pick.symbol} recorded, not broadcast`);
    const n = bot ? await bot.broadcastPick(pick) : 0;
    console.log(`[radar] PICK ${pick.symbol} ${pick.mint} -> ${n} subscriber(s)`);
  } });
  radar = createRadar({
    picker, onWsEvent,
    isAlerted: (m) => store.data.alerted.includes(m),
    markAlerted: (m) => { store.data.alerted.push(m); if (store.data.alerted.length > 200) store.data.alerted.splice(0, store.data.alerted.length - 200); store.save(); },
  });
  store.load().then(() => {
    console.log('[state]', JSON.stringify(store.status()));
    const b = store.data.budget || {};
    const am = require('./analyzer');
    const rc = am.restoreCredits(b.credits); const rs = radar.restoreBudget(b.radar);
    if (rc || rs) console.log(`[state] restored today's budgets: ${rc} Helius credits, radar scans ${rs ? b.radar.today + ' + deep ' + b.radar.deepToday : 'none'}`);
    radar.start();
    // persist today's budget counters every 10 min (only when they changed) so a restart can't reset the daily caps
    let lastBudget = '';
    setInterval(() => {
      const snap = { credits: am.creditSnapshot(), radar: radar.budgetSnapshot() };
      const j = JSON.stringify(snap); if (j === lastBudget) return; lastBudget = j;
      store.data.budget = snap; store.save();
    }, 10 * 60e3).unref();
  });
}

// ---- keep-alive: ping our own public URL so Render's edge sees inbound traffic (free web services sleep after 15 min idle).
const keepalive = { enabled: false, target: null, intervalMin: Number(process.env.KEEPALIVE_MIN || 10), pings: 0, fails: 0, lastAt: null, lastStatus: null };
if (process.env.KEEPALIVE !== '0' && PUBLIC_URL && /^https:/.test(PUBLIC_URL)) {
  Object.assign(keepalive, { enabled: true, target: `${PUBLIC_URL}/healthz?src=self` });
  setInterval(async () => {
    keepalive.lastAt = new Date().toISOString();
    try { const r = await fetch(keepalive.target, { signal: AbortSignal.timeout(20000) }); keepalive.lastStatus = r.status; keepalive.pings++; }
    catch (e) { keepalive.fails++; keepalive.lastStatus = e.message; }
  }, keepalive.intervalMin * 60e3).unref();
}

app.get('/api/radar/picks', (_, res) => {
  res.set('cache-control', 'no-store');
  const picks = [...(store.data.picks || [])].reverse();
  const done = picks.filter((p) => p.entryMcUsd);
  const summary = { picks: picks.length, hit2x: done.filter((p) => p.milestones?.x2).length, hit5x: done.filter((p) => p.milestones?.x5).length, hit10x: done.filter((p) => p.milestones?.x10).length,
    migrated: done.filter((p) => p.migrated).length, rugged: done.filter((p) => p.rugAt).length, belowEntryNow: done.filter((p) => p.curMultiple < 1).length };
  res.json({ mode: (process.env.RADAR_MODE || 'demo').toLowerCase(), summary, picks, picker: picker ? picker.status() : null, now: new Date().toISOString() });
});
app.get('/radar', (_, res) => res.sendFile(path.join(__dirname, 'public', 'radar.html')));

app.get('/scalp', (_, res) => res.sendFile(path.join(__dirname, 'public', 'scalp.html')));
app.get('/api/scalp/status', (_, res) => { res.set('cache-control', 'no-store'); res.json(scalper ? scalper.status() : { disabled: true }); });
app.get('/api/scalp/trades', (_, res) => { res.set('cache-control', 'no-store'); res.json(scalper ? scalper.trades() : { disabled: true }); });
app.get('/api/scalp/variant/:key', (req, res) => { const v = scalper?.variant(req.params.key); v ? res.json(v) : res.sendStatus(404); });
// ---- ALMA, SpaniardDev's AI Trader Agent (/agent, /agent/diary): autonomous, public, learning (mind.js); AGENT_MODE=paper (default) | live. Rides the scalper's stream.
var agent = null;
if (process.env.AGENT_BOOT !== '0' && scalper) {
  const { createAgent } = require('./agent'); const { renderEnvStore: envStore } = require('./scalp');
  agent = createAgent({ scalper, store: envStore('AGENT_STATE') });
  agent.start().catch((e) => console.error('[agent] start failed', e.message));
}
// ALMA post-migration SHADOW arm (pre-registered forward test, alma-research/C/PREREG.md): paper-only by construction (no keys, no executor).
var postmig = null;
if (process.env.POSTMIG_SHADOW !== '0' && scalper) {
  try {
    const { createPostmig } = require('./postmig');
    postmig = createPostmig({ getState: () => { const sh = agent?.st?.shadow; if (!sh) return null; if (!sh.postmig) sh.postmig = { since: new Date().toISOString(), prereg: 'alma-research/C/PREREG.md', grads: 0, excluded: 0, settled: 0, noData: 0, byVar: {}, closed: [] }; return sh.postmig; },
      isExcluded: (mint, creator) => agent ? (agent.cfg.exclude.has(mint) || (creator != null && agent.cfg.protectedWallets.has(creator))) : creator === require('./agent').DEV_WALLET }).start();
  } catch (e) { console.error('[postmig] start failed', e.message); }
}
app.get('/api/agent/postmig', (_, res) => { res.set('cache-control', 'no-store'); res.json(postmig ? postmig.status() : { disabled: true }); });
app.get('/agent', (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));
app.get('/api/agent', (_, res) => { res.set('cache-control', 'no-store'); res.json(agent ? agent.status() : { disabled: true }); });
app.get('/agent/diary', (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent-diary.html')));
app.get('/api/agent/activity', (_, res) => { res.set('cache-control', 'no-store'); res.json(agent ? agent.activity() : { disabled: true }); }); // light, polled every few seconds by /agent
app.get('/api/agent/diary', (_, res) => { res.set('cache-control', 'no-store'); res.json(agent ? agent.diary() : { disabled: true }); });
// ---- /m (= /agent/live): mobile live dashboard, polls the slim /api/agent/m every 3 s. Wallet balance read via public RPC, cached 15 s.
const AGENT_WALLET = process.env.AGENT_WALLET_ADDRESS || '4iUUembrP2xMBeP4RbkYciZa1yFpp1YM87Uk5Y9dD1qy';
const MOBILE_RPC = process.env.MOBILE_RPC_URL || 'https://api.mainnet-beta.solana.com';
const walletBal = { sol: null, at: 0, pending: null, error: null };
function walletBalance() {
  if (Date.now() - walletBal.at < 15e3 || walletBal.pending) return walletBal.pending || Promise.resolve();
  walletBal.pending = fetch(MOBILE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(6000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [AGENT_WALLET, { commitment: 'confirmed' }] }) })
    .then((r) => r.json()).then((j) => { if (j?.result?.value == null) throw new Error(j?.error?.message || 'no result'); walletBal.sol = j.result.value / 1e9; walletBal.error = null; })
    .catch((e) => { walletBal.error = e.message; })
    .finally(() => { walletBal.at = Date.now(); walletBal.pending = null; });
  return walletBal.pending;
}
// wallet history (funding, payout, swaps) straight from the chain: signatures cached 20 s, each tx's SOL delta cached forever
const walletTx = { list: [], at: 0, pending: null, deltas: new Map() };
const rpcCall = (method, params) => fetch(MOBILE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  .then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
function walletHistory() {
  if (Date.now() - walletTx.at < 20e3 || walletTx.pending) return walletTx.pending || Promise.resolve();
  walletTx.pending = (async () => {
    const sigs = await rpcCall('getSignaturesForAddress', [AGENT_WALLET, { limit: 15 }]);
    for (const x of sigs) {
      if (x.err || walletTx.deltas.has(x.signature)) continue;
      const tx = await rpcCall('getTransaction', [x.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (!tx) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k); const i = keys.indexOf(AGENT_WALLET);
      walletTx.deltas.set(x.signature, i < 0 ? null : { sol: (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9, from: keys[0], signer: keys[0] === AGENT_WALLET });
    }
    walletTx.list = sigs.filter((x) => !x.err && walletTx.deltas.get(x.signature)).map((x) => ({ tx: x.signature, at: new Date((x.blockTime || 0) * 1000).toISOString(), ...walletTx.deltas.get(x.signature) }));
  })().catch(() => {}).finally(() => { walletTx.at = Date.now(); walletTx.pending = null; });
  return walletTx.pending;
}
function chartOf(mint, symbol, why) {
  const m = mref.get(mint); if (!m || !m.trades?.length) return null;
  const tr = m.trades; const step = Math.max(1, Math.ceil(tr.length / 150)); const pts = [];
  for (let i = 0; i < tr.length; i += step) pts.push([tr[i].at, tr[i].vs / tr[i].vt]);
  const last = tr[tr.length - 1]; if (pts[pts.length - 1][0] !== last.at) pts.push([last.at, last.vs / last.vt]);
  return { mint, symbol, why, price: last.vs / last.vt, mcSol: (last.vs / last.vt) * 1e9, lastAt: new Date(m.lastAt).toISOString(), points: pts };
}
function mobileView(s) {
  const a = s.activity || {}; const v = s.vitals || {}; const aff = v.affect || {};
  const pay = s.payout || s.riskFree || s.principal || null;
  return {
    now: s.now, mode: s.mode, state: s.state, halted: s.halted || null,
    wallet: { address: AGENT_WALLET, solscan: `https://solscan.io/account/${AGENT_WALLET}`, sol: walletBal.sol ?? s.wallet?.onChainSol ?? null,
      at: walletBal.sol != null ? new Date(walletBal.at).toISOString() : s.wallet?.onChainAt || null },
    balance: s.balance, solUsd: s.solUsd, pnl: s.pnl,
    stats: s.stats ? { closedTrades: s.stats.closedTrades, wins: s.stats.wins, winRate: s.stats.winRate, drawdownPct: s.stats.drawdownPct } : null,
    vitals: { signal: v.signal ?? null, state: v.state || null, pain: aff.pain ?? v.policy?.pain ?? null, comfort: aff.comfort ?? v.policy?.comfort ?? null, cooldownUntil: aff.cooldownUntil || null, lossStreak: aff.lossStreak ?? null },
    mood: s.mind?.mood || null, regime: s.mind?.regime ? { label: s.mind.regime.label, tradesPerMin: s.mind.regime.tradesPerMin } : null,
    activity: { key: a.key, label: a.label, headline: a.headline, detail: a.detail, scannedLastMin: a.scannedLastMin, coinsToday: a.coinsToday, candidates: a.candidates || [], log: (a.log || []).slice(0, 8), stream: a.stream || null },
    positions: s.positions || [],
    trades: (s.trades || []).slice(0, 10).map((t) => ({ side: t.side, symbol: t.symbol, mint: t.mint, arm: t.arm, sol: t.sol, pnlSol: t.pnlSol, pnlPct: t.pnlPct, reason: t.reason, tx: t.tx, at: t.at, mode: t.mode, heldMin: t.heldMin })),
    feed: feedOf(s), charts: chartsOf(s),
    payout: pay,
  };
}
function chartsOf(s) {
  const want = []; for (const p of s.positions || []) want.push([p.mint, p.symbol || createdSyms.get(p.mint), 'position']);
  for (const c of s.activity?.candidates || []) if (want.length < 2 && !want.some((w) => w[0] === c.mint)) want.push([c.mint, c.symbol || String(c.label || '').replace(/^\$/, '') || createdSyms.get(c.mint), 'watching']);
  return want.map((w) => chartOf(...w)).filter(Boolean).slice(0, 2);
}
// every transaction: ALMA's buys/sells (paper or live) + its one-time principal payout. Owner deposits/withdrawals and other
// wallet movements are private: never listed publicly (the page shows the current wallet balance instead)
function feedOf(s) {
  const trades = s.trades || []; const tokOf = new Map(trades.filter((t) => t.side === 'BUY' && t.tok).map((t) => [t.posId, t.tok]));
  const out = trades.slice(0, 40).map((t) => { const tok = t.tok || tokOf.get(t.posId); const price = tok ? t.sol / tok : null;
    return { kind: t.side, at: t.at, symbol: t.symbol, mint: t.mint, sol: t.sol, price, mcSol: price ? price * 1e9 : null, pnlSol: t.pnlSol ?? null, pnlPct: t.pnlPct ?? null, reason: t.reason, tx: t.tx || null, mode: t.mode }; });
  const known = new Set(out.map((x) => x.tx).filter(Boolean)); const pay = s.payout?.payout;
  for (const w of walletTx.list) {
    if (known.has(w.tx)) continue;
    if (!pay?.tx || pay.tx !== w.tx) continue; // only the recorded payout tx; never an amount guess
    out.push({ kind: 'PAYOUT', at: w.at, sol: Math.round(w.sol * 1e6) / 1e6, tx: w.tx, mode: 'live', from: w.signer ? null : w.from });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 30);
}
app.get(['/m', '/agent/live'], (_, res) => res.sendFile(path.join(__dirname, 'public', 'm.html')));
app.get('/api/agent/m', async (_, res) => {
  res.set('cache-control', 'no-store');
  if (!agent) return res.json({ disabled: true });
  walletHistory();
  await Promise.race([walletBalance(), new Promise((r) => setTimeout(r, 2500))]);
  try { res.json(mobileView(agent.status())); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agent/backtest', (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent-backtest.json')));
// ---- Fee Rips tracker (/rips): creator fees -> Collector Crypt packs, read on-chain from the public RPC (0 Helius credits)
let rips = null;
if (process.env.RIPS_ENABLED !== '0') { rips = require('./rips').createRips(); rips.start(); }
app.get('/rips', (_, res) => res.sendFile(path.join(__dirname, 'public', 'rips.html')));
// Coin logo chosen by env RIPS_LOGO=a (mascot, default) | b (pack burst); same URL so pages, favicon and previews follow the choice.
const ripsLogo = () => ((process.env.RIPS_LOGO || 'a').trim().toLowerCase() === 'b' ? 'b' : 'a');
app.get('/rips-logo.jpg', (_, res) => { res.set('cache-control', 'public, max-age=300'); res.sendFile(path.join(__dirname, 'public', `rips-logo-${ripsLogo()}.jpg`)); });
app.get('/rips-favicon.png', (_, res) => { res.set('cache-control', 'public, max-age=300'); res.sendFile(path.join(__dirname, 'public', `rips-favicon-${ripsLogo()}.png`)); });
// Stream screen for the pump.fun livestream (screen-share this tab): same data as /rips, fast feed from /api/rips/live
app.get('/live', (_, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/rips/live', (_, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/api/rips/live', (_, res) => { res.set('cache-control', 'no-store'); res.json(rips ? rips.live() : { disabled: true }); });
app.get('/dev', (_, res) => res.sendFile(path.join(__dirname, 'public', 'dev.html')));
require('./tankloop').register(app); // $TANKLOOP landing (/tankloop), CA via env TANKLOOP_CA
app.get('/api/rips/status', (_, res) => { res.set('cache-control', 'no-store'); res.json(rips ? rips.status() : { disabled: true }); });
// Always-on: a stray async error must not kill the trader. Unhandled rejections are logged and ignored; an uncaught
// exception saves state and exits so Render restarts the process cleanly (state is restored on boot).
process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection (ignored):', e?.stack || e));
process.once('uncaughtException', async (e) => { console.error('[process] uncaught exception, saving and restarting:', e?.stack || e); try { await Promise.race([agent?.saveFinal(), new Promise((r) => setTimeout(r, 8000))]); } catch {} process.exit(1); });
// agent first: the next instance waits for this final save (handover) before it restores and starts trading
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => { try { await agent?.saveFinal(); } catch {} try { await scalper?.save(); } catch {} try { if (radar) { store.data.budget = { credits: require('./analyzer').creditSnapshot(), radar: radar.budgetSnapshot() }; await store.flush(); } } catch {} process.exit(0); });
app.get('/api/radar/status', (_, res) => {
  res.set('cache-control', 'no-store');
  res.json({ radar: radar ? radar.status() : { running: false, disabled: true }, state: store.status(), keepalive, uptimeSec: Math.round(process.uptime()), now: new Date().toISOString() });
});

if (BOT_MODE === 'webhook') {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { createBot, webhookSecret } = require('./telegram');
  const SECRET = webhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!TOKEN || !SECRET) { console.error('Webhook mode needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.'); process.exit(1); }
  bot = createBot(TOKEN, { radar, store });
  const expected = Buffer.from(SECRET);
  app.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
    const got = Buffer.from(String(req.get('X-Telegram-Bot-Api-Secret-Token') || ''));
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return res.sendStatus(401);
    res.sendStatus(200); // ack immediately, process async
    bot.handleUpdate(req.body);
  });
  if (process.env.WEBHOOK_AUTO_SET !== '0' && PUBLIC_URL) {
    bot.tg('setWebhook', { url: `${PUBLIC_URL}/telegram/webhook`, secret_token: SECRET, allowed_updates: ['message'], drop_pending_updates: false, max_connections: 10 })
      .then(() => console.log(`Webhook set to ${PUBLIC_URL}/telegram/webhook`))
      .catch((e) => console.error('setWebhook failed:', e.message));
  } else if (!PUBLIC_URL) console.warn('PUBLIC_URL not set: webhook not registered automatically.');
}

app.listen(PORT, '0.0.0.0', () => console.log(`Bundle Sniffer on :${PORT} (bot mode: ${BOT_MODE})`));
