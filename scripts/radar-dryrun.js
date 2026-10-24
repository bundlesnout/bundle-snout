// Dry run: watch live pump.fun data for N seconds and PRINT would-be Bond Radar alerts.
// Never touches Telegram (no token used, no webhook calls). Usage:
//   RPC_URL=... node scripts/radar-dryrun.js [seconds=120]
// Env overrides as in production, e.g. RADAR_THRESHOLD_PCT=60.
process.env.STATE_BACKEND = 'memory';
delete process.env.TELEGRAM_BOT_TOKEN;
const { createRadar } = require('../radar');
const { formatAlert } = require('../format');
const secs = Number(process.argv[2] || 120);
const alerted = new Set();
const radar = createRadar({
  isAlerted: (m) => alerted.has(m), markAlerted: (m) => alerted.add(m),
  onAlert: async (rep) => {
    console.log('\n================ WOULD-BE ALERT ================');
    console.log(formatAlert(rep).replace(/<[^>]+>/g, ''));
    console.log('================================================\n');
  },
});
radar.start();
const t0 = Date.now();
const iv = setInterval(() => { const s = radar.status(); console.log(`[dryrun ${Math.round((Date.now() - t0) / 1000)}s] tracked=${s.trackedCoins} ≥thr=${s.aboveThreshold} queue=${s.queue} scans=${s.scans.total} clean=${s.scans.clean} dirty=${s.scans.dirty} ws=${s.ws.connected} newTokens=${s.ws.newTokens} polls=${s.poll.ok}/${s.poll.count}`); }, 20000);
setTimeout(async () => {
  clearInterval(iv);
  const s = radar.status(); radar.stop();
  console.log('\nSUMMARY', JSON.stringify({ tracked: s.trackedCoins, aboveThreshold: s.aboveThreshold, polls: s.poll, ws: s.ws, scans: s.scans, alerts: s.alerts, decisions: s.recentDecisions.map((d) => ({ mint: d.mint, symbol: d.symbol, progress: d.progress, clean: d.clean, reasons: d.reasons })) }, null, 2));
  process.exit(0);
}, secs * 1000);
