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

## 📡 Bond Radar

Watches pump.fun live and alerts Telegram subscribers when a coin passes **70 %** of its bonding curve **and** scans clean.

**Commands:** `/radar on` · `/radar off` · `/radar status` (in groups only admins can toggle). Every scan/alert ends with `FOOTER_TEXT`
(default `🐽 Bond Radar · powered by Bundle Snout`).

**Data sources (all free, no keys):**
- pump.fun public frontend API `GET /coins?sort=last_trade_timestamp&complete=false` — top 100 most recently traded, not-yet-graduated coins every 15 s. Curve progress = `(793.1M − real_token_reserves) / 793.1M`.
- PumpPortal websocket `wss://pumpportal.fun/api/data` (`subscribeNewToken`, `subscribeMigration`) for live liveness/stats. (Its per-token trade stream needs a funded key, so it's not used.)
- Helius RPC only through the existing analyzer: **one scan per mint** when it crosses the threshold (~30 RPC calls ≈ 40 credits), capped by `RADAR_MAX_SCANS_PER_DAY` (300 ≈ 12k credits/day ≈ 370k/month of the free 1M).

**Clean = every check passes** (any missing data = not clean):
| Check | Default | Env |
|---|---|---|
| On-chain curve progress ≥ threshold−5 and not graduated | 70 % | `RADAR_THRESHOLD_PCT` |
| Skip coins already above | 97 % | `RADAR_MAX_PCT` |
| No multi-wallet buy tx in creation block + next 2 | 0 | — |
| No creation-block buy fee-paid by the dev | 0 | — |
| Not ≥2 wallets with ≥5 % right behind the create tx | — | — |
| Creation-block buyers own < | 10 % | `RADAR_MAX_SAMESLOT_PCT` |
| Early (first 3 blocks) wallets still hold < | 10 % | `RADAR_MAX_EARLY_HOLD_PCT` |
| Dev has not sold | yes | `RADAR_ALLOW_DEV_SELL=1` to relax |
| Dev holds < | 10 % | `RADAR_MAX_DEV_HOLD_PCT` |
| Top-10 holders (excl. curve/pools) < | 30 % | `RADAR_MAX_TOP10_PCT` |
| Overall analyzer risk not HIGH | — | — |

Alerts are deduped per mint (last 200 alerted mints are persisted).

**Persistence:** Render free disk is ephemeral. If `STATE_RENDER_API_KEY` is set, subscribers + alerted mints are stored as JSON in the service env var `RADAR_STATE` through the Render API (updating an env var via API does not redeploy) and read back on boot. Without it, state is in memory only and lost on restart. Don't declare `RADAR_STATE` in render.yaml.

**Keep-alive:** Render free services sleep after 15 min without inbound traffic. The server pings its own public URL (`RENDER_EXTERNAL_URL/healthz`) every 10 min — that goes through Render's edge as inbound traffic. `ops/github-keepalive.yml` (copy to `.github/workflows/keepalive.yml`; pushing it needs a GitHub token with `workflow` scope) is a backstop that wakes it if it ever slept (GitHub cron is best-effort). 750 free instance-hours/month ≥ 744 h for one 24/7 service — don't run a second free service in this workspace.

**Status:** `GET /api/radar/status` (tracked coins, last event, scans, alerts, recent decisions, keep-alive).

**Dry run (no Telegram):** `RPC_URL=... npm run radar:dryrun -- 120` prints would-be alerts from live mainnet data. `npm test` checks the clean rules offline.
