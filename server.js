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

if (BOT_MODE === 'webhook') {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { createBot, webhookSecret } = require('./telegram');
  const SECRET = webhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!TOKEN || !SECRET) { console.error('Webhook mode needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.'); process.exit(1); }
  const bot = createBot(TOKEN);
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
