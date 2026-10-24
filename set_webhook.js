// Manual webhook control. Usage:
//   TELEGRAM_BOT_TOKEN=.. TELEGRAM_WEBHOOK_SECRET=.. PUBLIC_URL=https://xxx.onrender.com node set_webhook.js set
//   TELEGRAM_BOT_TOKEN=.. node set_webhook.js info | delete
const T = process.env.TELEGRAM_BOT_TOKEN; if (!T) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
const call = async (m, b) => (await fetch(`https://api.telegram.org/bot${T}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
(async () => {
  const cmd = process.argv[2] || 'info';
  if (cmd === 'set') {
    const url = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); const s = require('./telegram').webhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
    if (!url || !s) { console.error('PUBLIC_URL and TELEGRAM_WEBHOOK_SECRET required'); process.exit(1); }
    console.log(await call('setWebhook', { url: `${url}/telegram/webhook`, secret_token: s, allowed_updates: ['message'], drop_pending_updates: process.env.DROP_PENDING === '1' }));
  } else if (cmd === 'delete') console.log(await call('deleteWebhook', {}));
  const info = await call('getWebhookInfo'); console.log(info.result);
})();
