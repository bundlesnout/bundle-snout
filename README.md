# Bundle Sniffer (read-only pump.fun checker)
- analyzer.js  — core. CLI: `node analyzer.js <mint>` (JSON). Env: RPC_URL (default public mainnet-beta), MAX_SIG_PAGES, RPC_MIN_GAP_MS.
- server.js + public/index.html — web UI. `PORT=8787 node server.js` → http://localhost:8787/?mint=<mint>
- bot.js + format.js — Telegram bot (long polling, no deps). `TELEGRAM_BOT_TOKEN=... [PUBLIC_URL=...] node bot.js`
- setup_bot.js — sets commands/descriptions via Bot API.
- tests/*.json — real outputs. screenshot.png — UI sample.
Signals: creation block + next 2 slots via getBlock (multi-wallet buy txs, buys right after the create tx, dev-paid buys), dev trades via dev ATA history, top-10 via getProgramAccounts (excludes curve/pools/program-owned owners), curve progress from BondingCurve account (pump IDL), remaining quote = k/(vT-realT) - vQ.
Never signs or sends transactions.

## Despliegue gratis (Render Free + webhook de Telegram)

Un solo proceso (`npm start` → `server.js`) sirve la web, la API y el webhook del bot.
Render Free se duerme tras 15 min sin tráfico; un mensaje de Telegram (POST al webhook) lo despierta (~1 min de arranque, Telegram reintenta la entrega).

1. Sube este repo a GitHub (`git push`).
2. Render → New → Blueprint → elige el repo (usa `render.yaml`, plan `free`).
3. Rellena las variables secretas: `TELEGRAM_BOT_TOKEN`, `RPC_URL` (Helius gratis: `https://mainnet.helius-rpc.com/?api-key=...`).
   `TELEGRAM_WEBHOOK_SECRET` lo genera Render; `PUBLIC_URL` se toma de `RENDER_EXTERNAL_URL` automáticamente.
4. Al arrancar con `BOT_MODE=webhook`, el servidor llama a `setWebhook` solo. Comprueba con `npm run webhook:info`.
5. Apaga cualquier bot en modo polling (`npm run bot`): polling y webhook no pueden convivir (polling borra el webhook).

Modos: `BOT_MODE=webhook` (producción) · `BOT_MODE=off` (solo web) · `npm run bot` (polling local).
Seguridad: el webhook rechaza (401) peticiones sin la cabecera `X-Telegram-Bot-Api-Secret-Token` correcta.
