// Shared Telegram logic (used by polling bot.js and webhook mode in server.js). Read-only bot.
const { analyze } = require('./analyzer');
const { format, esc } = require('./format');
const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBot(token) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const API = `https://api.telegram.org/bot${token}`;
  const cache = new Map(); const perUser = new Map(); const seen = new Set(); let busy = 0;

  async function tg(method, body, timeoutMs = 65000) {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j.ok) { if (j.parameters?.retry_after) await sleep(j.parameters.retry_after * 1000); throw new Error(`${method}: ${j.description}`); }
    return j.result;
  }
  const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  const HELP = '🐽 <b>Bundle Sniffer</b>\n\nEnvía <code>/sniff &lt;mint&gt;</code> o pega el mint de un token de pump.fun.\nSend <code>/sniff &lt;mint&gt;</code> or just paste a pump.fun mint.\n\nSolo lectura: nunca pido claves ni toco fondos. / Read-only: never asks for keys or touches funds.';

  async function handleMessage(msg) {
    const text = msg.text || ''; const chat = msg.chat.id;
    if (/^\/(start|help)\b/.test(text)) return send(chat, HELP);
    const m = text.match(MINT_RE);
    if (!m) { if (/^\/sniff/.test(text)) return send(chat, 'Uso / usage: <code>/sniff &lt;mint&gt;</code>'); if (msg.chat.type === 'private') return send(chat, HELP); return; }
    const mint = m[0]; const now = Date.now();
    if (now - (perUser.get(msg.from?.id) || 0) < 8000) return send(chat, '⏳ Espera unos segundos / wait a few seconds');
    perUser.set(msg.from?.id, now);
    const c = cache.get(mint);
    if (c && now - c.at < 60000) return send(chat, format(c.data), { reply_to_message_id: msg.message_id });
    if (busy >= 2) return send(chat, '⏳ Ocupado, reintenta en unos segundos / busy, retry');
    busy++;
    const wait = await send(chat, '🐽 Olfateando la cadena… / sniffing…', { reply_to_message_id: msg.message_id });
    try {
      const r = await analyze(mint); cache.set(mint, { at: Date.now(), data: r });
      await tg('editMessageText', { chat_id: chat, message_id: wait.message_id, text: format(r), parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      await tg('editMessageText', { chat_id: chat, message_id: wait.message_id, text: '❌ ' + esc(e.message), parse_mode: 'HTML' }).catch(() => {});
    } finally { busy--; }
  }

  // Idempotent update handler (Telegram may redeliver the same update_id).
  function handleUpdate(u) {
    if (!u || seen.has(u.update_id)) return;
    seen.add(u.update_id); if (seen.size > 5000) seen.delete(seen.values().next().value);
    if (u.message) {
      console.log(new Date().toISOString(), 'msg from chat', u.message.chat.id, JSON.stringify((u.message.text || '').slice(0, 60)));
      handleMessage(u.message).catch((e) => console.error('handle', e.message));
    }
  }
  return { tg, handleUpdate };
}
// Telegram only accepts [A-Za-z0-9_-]{1,256}; Render's generateValue is base64, so normalise to hex if needed.
function webhookSecret(raw) {
  if (!raw) return '';
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : require('crypto').createHash('sha256').update(raw).digest('hex');
}
module.exports = { createBot, webhookSecret };
