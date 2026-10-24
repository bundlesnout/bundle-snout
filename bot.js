// Polling mode (local / dev). Start: TELEGRAM_BOT_TOKEN=... node bot.js
// NOTE: polling deletes any webhook. Do not run this while the production webhook (server.js BOT_MODE=webhook) is live.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN no está definido. / TELEGRAM_BOT_TOKEN missing.'); process.exit(1); }
const { createBot } = require('./telegram');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { tg, handleUpdate } = createBot(TOKEN);
(async () => {
  const me = await tg('getMe');
  const info = await tg('getWebhookInfo');
  if (info.url) console.warn('WARNING: a webhook is set; polling will remove it.');
  await tg('deleteWebhook', {}).catch(() => {});
  console.log(`Bundle Sniffer bot (polling) running as @${me.username}`);
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) { offset = u.update_id + 1; handleUpdate(u); }
    } catch (e) { console.error('poll error', e.message); await sleep(3000); }
  }
})();
