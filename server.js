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

// ---- Bond Radar (watcher) + persistence
const { createRadar } = require('./radar');
const { createStore } = require('./state');
const store = createStore();
let bot = null; let radar = null;
const { createPicker } = require('./picks');
let picker = null;
// ---- Bot-Volume Scalper + Ride-to-Bonding (PAPER TRADING ONLY; free public Solana RPC log stream, 0 Helius credits)
const createdSyms = new Map(); // mint -> symbol, fed by the radar's PumpPortal create stream
let scalper = null;
if (process.env.SCALP_ENABLED !== '0') {
  const { createScalper, renderEnvStore } = require('./scalp');
  scalper = createScalper({ store: renderEnvStore(), symbolOf: (m) => createdSyms.get(m), onTradeHook: (tr, m) => agent?.onTrade(tr, m) });
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
  store.load().then(() => { console.log('[state]', JSON.stringify(store.status())); radar.start(); });
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
app.get('/agent', (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));
app.get('/api/agent', (_, res) => { res.set('cache-control', 'no-store'); res.json(agent ? agent.status() : { disabled: true }); });
app.get('/agent/diary', (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent-diary.html')));
app.get('/api/agent/diary', (_, res) => { res.set('cache-control', 'no-store'); res.json(agent ? agent.diary() : { disabled: true }); });
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
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => { try { await scalper?.save(); } catch {} try { await agent?.save(); } catch {} process.exit(0); });
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
