// Sets bot commands/descriptions. Reads TELEGRAM_BOT_TOKEN from env; never prints it.
const T = process.env.TELEGRAM_BOT_TOKEN;
if (!T) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
const call = async (m, body) => { const r = await fetch(`https://api.telegram.org/bot${T}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const j = await r.json(); console.log(m, j.ok, j.ok ? (j.result?.username || '') : j.description); return j; };
(async () => {
  await call('getMe');
  const cmds = { es: [{ command: 'sniff', description: 'Analiza un token de pump.fun: /sniff <mint>' }, { command: 'help', description: 'Cómo usar el bot' }], en: [{ command: 'sniff', description: 'Analyze a pump.fun token: /sniff <mint>' }, { command: 'help', description: 'How to use the bot' }] };
  await call('setMyCommands', { commands: cmds.en });
  await call('setMyCommands', { commands: cmds.es, language_code: 'es' });
  const desc = { en: 'Bundle Sniffer: paste a pump.fun token mint and get bundle signals, dev sells, top-10 holder concentration and bonding-curve progress. Read-only: never asks for keys or touches funds. Not financial advice.', es: 'Bundle Sniffer: pega el mint de un token de pump.fun y verás señales de bundle, ventas del dev, concentración del top 10 y progreso de la curva. Solo lectura: nunca pide claves ni toca fondos. No es consejo financiero.' };
  await call('setMyDescription', { description: desc.en });
  await call('setMyDescription', { description: desc.es, language_code: 'es' });
  await call('setMyShortDescription', { short_description: 'Read-only pump.fun bundle & dev-sell checker. /sniff <mint>' });
  await call('setMyShortDescription', { short_description: 'Detector de bundles y ventas del dev en pump.fun. /sniff <mint>', language_code: 'es' });
  await call('getWebhookInfo');
})();
