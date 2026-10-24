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

Watches pump.fun live. Coins past **70 %** of the bonding curve go through the basic clean checks below, survivors get a **deep on-chain analysis** (bots, wash, wallet clusters, dev history) scored 0–100, and **at most one pick per ~40 min** is chosen with a plain-language rationale. Every pick is tracked publicly at **`/radar`** (losers included) and `GET /api/radar/picks`.

**`RADAR_MODE=demo` (default):** picks are only recorded/tracked, nothing is sent to Telegram. `RADAR_MODE=live` also sends each pick to `/radar on` subscribers.

**Commands:** `/radar on` · `/radar off` · `/radar status` (in groups only admins can toggle). Every scan/alert ends with `FOOTER_TEXT`
(default `🐽 Bond Radar · powered by Bundle Snout`).

**Data sources (all free, no keys):**
- pump.fun public frontend API `GET /coins?sort=last_trade_timestamp&complete=false` — top 100 most recently traded, not-yet-graduated coins every 15 s. Curve progress = `(793.1M − real_token_reserves) / 793.1M`.
- PumpPortal websocket `wss://pumpportal.fun/api/data` (`subscribeNewToken`, `subscribeMigration`, free). Every new pump.fun coin is tracked **on-chain**: its bonding-curve account is read in batches of 100 with Helius `getMultipleAccounts` (1 credit per batch, 49-byte slice), every 15–30 s while young/hot, slower as it ages; dead coins are dropped (<3 % after 30 min, <10 % after 2 h, <30 % after 6 h, all after 24 h). ≈3–8k credits/day. (PumpPortal's per-token trade stream needs a funded key, so it's not used.)
- Sources (all free): **trade stream** (primary: every pump.fun TradeEvent from the public Solana RPC log stream shared with the scalper; post-trade real reserves give exact curve progress for any coin that trades, old or new, 0 Helius credits), **on-chain tracker** (curve accounts via getMultipleAccounts for coins from PumpPortal new-token events and **GeckoTerminal**'s public pump-fun pool list, polled every 5 min, every 1 min if the stream goes quiet), **PumpPortal** websocket. The pump.fun frontend API sits behind a Cloudflare bot challenge (403 for any server, Render or not), so it is off unless `RADAR_PUMP_API=1` (exponential backoff 30-240 min). `RADAR_SOURCE=chain` disables it, `RADAR_SOURCE=api` disables the on-chain tracker.
- Helius RPC only through the existing analyzer: **one scan per mint** when it crosses the threshold (~30 RPC calls ≈ 40 credits), capped by `RADAR_MAX_SCANS_PER_DAY` (250).

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

Scanned-clean mints are remembered (last 200, persisted) so they aren't re-scanned.

### Deep analysis (`deep.js`, only for basic-clean coins, `RADAR_MAX_DEEP_PER_DAY=40`, ≈150–250 credits each)
- **Trades:** last 1000 signatures of the bonding curve (activity now vs 10 min before) + `DEEP_TX_SAMPLE=120` most recent trades parsed: side, SOL (curve lamport delta), trader.
- **Bots / wash:** tiny (<0.02 SOL) or identical-size buys; "clockwork" wallets (≥4 trades, interval CV < 0.25); wallets that both buy and sell ≥3 times (wash share of volume); ≥3 buyers in one slot.
- **Clusters:** top-10 holders + 6 early buyers (`DEEP_WALLETS=14`): funder of each wallet (first tx, largest SOL sender; hubs/exchanges with ≥1000 txs ignored), wallets funded by the same wallet or by the dev, wallets created <1 h before launch.
- **Dev history:** previous pump.fun creates by the dev wallet (`DEEP_DEV_TX=40`), checked on DexScreener (dead < $6k MC, graduated).
- **Socials:** twitter/telegram/website in the metadata JSON (minor).

| Score part | Max | Full marks when |
|---|---|---|
| Unique-buyer ratio | 10 | ≥80 % of sampled buys from distinct wallets |
| Buyer velocity | 10 | ≥3 distinct buyers/min |
| Buy-size variety | 8 | size CV ≥ 1.3 |
| Net inflow 10 min | 7 | ≥ +5 SOL |
| Momentum | 5 | tx/min ≥1.5× previous 10 min |
| No volume bots | 8 | 0 tiny/identical buys (0 at 50 %) |
| No clockwork bots | 7 | 0 % (0 at 40 %) |
| No wash | 10 | 0 % (0 at 40 %) |
| No funder cluster | 10 | no shared funder (0 at 15 % held) |
| No fresh wallets | 10 | 0 % (0 at 60 %) |
| Dev history | 10 | prior launches not dead; no prior = 7, burner wallet = 4, unknown = 3 |
| Socials | 5 | X 2 · TG 1.5 · web 1.5 |

**Hard fails (never picked):** <15 unique buyers · wash ≥50 % · clockwork bots ≥50 % · tiny/identical buys ≥60 % · ≥3 same-funder holders with ≥15 % · dev-funded holders ≥3 % · fresh wallets ≥70 % · serial dev (≥3 launches, ≥80 % dead) · 10-min sells > 1.5× buys and > 2 SOL.

**Pick rule:** first coin with no hard fail and score ≥ `RADAR_PICK_MIN_SCORE` (70) opens a `RADAR_PICK_CONTEST_MIN` (10) contest; the best qualifier wins; then `RADAR_PICK_COOLDOWN_MIN` (30) cooldown. The rationale compares it to every candidate of the last `RADAR_PICK_WINDOW_MIN` (60).

**Track record:** entry MC/price from DexScreener at pick time; every `RADAR_TRACK_MS` (3 min) current + peak MC, multiples, 2x/5x/10x timestamps, graduated (non-pumpfun pair), rug (≤0.2× entry). 7 days per pick, last 30 picks persisted in `RADAR_STATE`.

### Helius budget (free 1M credits/month)
Basic scans ≤250/day × ~35 ≈ 9k · deep ≤40/day × ~200 ≈ 8k · on-chain tracker ≈ 6k → ≈ 23k/day ≈ 700k/month. Hard stop: `RADAR_DAILY_CREDIT_CAP` (28k/day, counted in-process: 1 per call, 10 per getProgramAccounts) — when reached the radar stops scanning until 00:00 UTC; the rest is for `/api/analyze` and Telegram `/sniff`. Credits are shown in `/api/radar/status`.

**Limitations:** the trade sample is the last ~120 trades (older history not parsed); funder = first incoming SOL (multi-hop funding, CEX withdrawals are missed); dev history only sees the dev's last 40 txs; none of this predicts price.

**Persistence:** Render free disk is ephemeral. If `STATE_RENDER_API_KEY` is set, subscribers + alerted mints are stored as JSON in the service env var `RADAR_STATE` through the Render API (updating an env var via API does not redeploy) and read back on boot. Without it, state is in memory only and lost on restart. Don't declare `RADAR_STATE` in render.yaml.

**Keep-alive:** Render free services sleep after 15 min without inbound traffic. The server pings its own public URL (`RENDER_EXTERNAL_URL/healthz`) every 10 min — that goes through Render's edge as inbound traffic. `ops/github-keepalive.yml` (copy to `.github/workflows/keepalive.yml`; pushing it needs a GitHub token with `workflow` scope) is a backstop that wakes it if it ever slept (GitHub cron is best-effort). 750 free instance-hours/month ≥ 744 h for one 24/7 service — don't run a second free service in this workspace.

**Status:** `GET /api/radar/status` (tracked coins, scans, deep scores, credits, contest, keep-alive) · `GET /api/radar/picks` · page `/radar`.

**Dry run (no Telegram):** `RPC_URL=... npm run radar:dryrun -- 120` prints decisions and demo picks from live mainnet data (contest 3 min / cooldown 10 min by default; picks → `dryrun-picks.json`). `npm test` checks clean rules, score and pick logic offline.
