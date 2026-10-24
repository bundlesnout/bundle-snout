// Shared Telegram logic (used by polling bot.js and webhook mode in server.js). Read-only bot.
const { analyze } = require('./analyzer');
const { format, formatAlert, footer, esc } = require('./format');
const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBot(token, { radar = null, store = null } = {}) {
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
  const HELP = '🐽 <b>Bundle Sniffer</b>\n\nEnvía <code>/sniff &lt;mint&gt;</code> o pega el mint de un token de pump.fun.\nSend <code>/sniff &lt;mint&gt;</code> or just paste a pump.fun mint.\n\n📡 <b>Bond Radar</b>: <code>/radar on</code> · <code>/radar off</code> · <code>/radar status</code>\nComo mucho 1 pick cada ~40 min: la moneda que pasa todos los filtros (bundle, bots, wash, clusters, dev) con mejor nota, y por qué. Historial público: /radar en la web. / At most one pick per ~40 min, with the reasons.\n\nSolo lectura: nunca pido claves ni toco fondos. / Read-only: never asks for keys or touches funds.\n\n' + footer();

  async function handleRadar(msg, arg) {
    const chat = msg.chat.id;
    if (!radar || !store) return send(chat, '📡 Bond Radar no está activo en este servidor. / Bond Radar is not enabled on this server.');
    const subs = store.data.subs; const on = subs.includes(chat);
    if (arg === 'on') {
      if (msg.chat.type !== 'private' && !(await isAdmin(chat, msg.from?.id))) return send(chat, 'Solo un admin del grupo puede activar el radar. / Only a group admin can enable the radar.');
      if (!on) { subs.push(chat); store.save(); }
      const cfg = radar.status().config;
      return send(chat, `📡 <b>Bond Radar ON</b>\nRecibirás como mucho 1 pick cada ~40 min: la moneda (&gt;${cfg.thresholdPct}% de curva) que pasa bundle, bots, wash, clusters y dev con la mejor nota, explicando por qué.${(process.env.RADAR_MODE || 'demo') !== 'live' ? '\n⚠️ Modo demo: ahora mismo los picks solo se registran en la web (/radar), no se envían.' : ''}\nAt most one pick per ~40 min, with the reasons.\n\n<code>/radar off</code> para parar / to stop.\n\n${footer()}`);
    }
    if (arg === 'off') {
      if (msg.chat.type !== 'private' && !(await isAdmin(chat, msg.from?.id))) return send(chat, 'Solo un admin del grupo puede desactivar el radar. / Only a group admin can disable the radar.');
      if (on) { subs.splice(subs.indexOf(chat), 1); store.save(); }
      return send(chat, `📡 Bond Radar <b>OFF</b>. <code>/radar on</code> para volver / to resume.\n\n${footer()}`);
    }
    const s = radar.status();
    const ago = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 1000)}s` : '—');
    return send(chat, [
      `📡 <b>Bond Radar</b> — ${s.running ? '🟢 activo / running' : '🔴 parado / stopped'}`,
      `Tu suscripción / your subscription: <b>${on ? 'ON' : 'OFF'}</b>`,
      `Monedas vigiladas / tracked coins: <b>${s.trackedCoins}</b> (≥${s.config.thresholdPct}%: ${s.aboveThreshold})`,
      `Último evento / last event: hace ${ago(s.lastEventAt)} · nuevas vistas / new tokens seen: ${s.ws.newTokens}`,
      `Escaneos hoy / scans today: ${s.scans.today}/${s.config.maxScansPerDay} · limpias / clean: ${s.scans.clean} · avisos / alerts: ${s.alerts.sent}`,
      '', footer(),
    ].join('\n'));
  }
  async function isAdmin(chat, user) {
    try { const m = await tg('getChatMember', { chat_id: chat, user_id: user }); return ['creator', 'administrator'].includes(m.status); } catch { return false; }
  }

  // Send a radar alert to every subscriber (~20 msg/s, drops chats that blocked/removed the bot).
  async function broadcast(report) {
    if (!store) return 0;
    const text = formatAlert(report); let ok = 0;
    for (const chat of [...store.data.subs]) {
      try { await send(chat, text); ok++; }
      catch (e) {
        if (/blocked|kicked|not found|deactivated|have no rights|chat not found/i.test(e.message)) { store.data.subs.splice(store.data.subs.indexOf(chat), 1); store.save(); }
        console.error('[radar] send to', chat, e.message);
      }
      await sleep(50);
    }
    return ok;
  }

  async function broadcastPick(pick) {
    if (!store) return 0;
    const text = `🎯 <b>Bond Radar — pick</b>\n<code>${esc(pick.mint)}</code>\n${esc(pick.rationale)}\nMC entrada: $${Math.round(pick.entryMcUsd || 0).toLocaleString('en-US')}${footer()}`;
    let ok = 0;
    for (const chat of [...store.data.subs]) {
      try { await send(chat, text); ok++; }
      catch (e) {
        if (/blocked|kicked|not found|deactivated|have no rights|chat not found/i.test(e.message)) { store.data.subs.splice(store.data.subs.indexOf(chat), 1); store.save(); }
        console.error('[radar] send to', chat, e.message);
      }
      await sleep(50);
    }
    return ok;
  }

  async function handleMessage(msg) {
    const text = msg.text || ''; const chat = msg.chat.id;
    if (/^\/(start|help)\b/.test(text)) return send(chat, HELP);
    const rm = text.match(/^\/radar(?:@\w+)?(?:\s+(\w+))?/i);
    if (rm) return handleRadar(msg, (rm[1] || 'status').toLowerCase());
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
  return { tg, handleUpdate, broadcast, broadcastPick };
}
// Telegram only accepts [A-Za-z0-9_-]{1,256}; Render's generateValue is base64, so normalise to hex if needed.
function webhookSecret(raw) {
  if (!raw) return '';
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : require('crypto').createHash('sha256').update(raw).digest('hex');
}
module.exports = { createBot, webhookSecret };
