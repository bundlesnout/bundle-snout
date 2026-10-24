// Dry run: watch live pump.fun data for N seconds and PRINT the Bond Radar decisions and picks.
// Never touches Telegram (no token used, no webhook calls) and never writes Render state. Usage:
//   RPC_URL=... node scripts/radar-dryrun.js [seconds=600]
// Shorter contest for testing: RADAR_PICK_CONTEST_MIN (default here 3) / RADAR_PICK_COOLDOWN_MIN (default here 10).
process.env.STATE_BACKEND = 'memory';
delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.STATE_RENDER_API_KEY; delete process.env.RENDER_API_KEY;
process.env.RADAR_PICK_CONTEST_MIN ||= '3'; process.env.RADAR_PICK_COOLDOWN_MIN ||= '10'; process.env.RADAR_TRACK_MS ||= '60000';
const fs = require('fs');
const { createRadar } = require('../radar');
const { createPicker } = require('../picks');
const secs = Number(process.argv[2] || 600);
const out = process.env.DRYRUN_OUT || 'dryrun-picks.json';
const store = { data: { subs: [], alerted: [], picks: [] }, save() { fs.writeFileSync(out, JSON.stringify(this.data.picks, null, 2)); } };
const picker = createPicker({ store, onPick: async (p) => console.log('\n================ PICK (demo, not sent) ================\n' + p.rationale + `\nentry MC ${p.entryMcUsd} (${p.entrySource})\n=======================================================\n`) });
const alerted = new Set();
const radar = createRadar({ picker, isAlerted: (m) => alerted.has(m), markAlerted: (m) => alerted.add(m) });
radar.start();
const t0 = Date.now();
const iv = setInterval(() => { const s = radar.status(); console.log(`[dryrun ${Math.round((Date.now() - t0) / 1000)}s] tracked=${s.trackedCoins} ≥thr=${s.aboveThreshold} queue=${s.queue} scans=${s.scans.total} clean=${s.scans.clean} deep=${s.scans.deepTotal} credits=${s.credits.today} contest=${s.picks.contestOpenUntil || '-'} picks=${store.data.picks.length}`); }, 30000);
setTimeout(async () => {
  clearInterval(iv);
  const s = radar.status(); radar.stop();
  console.log('\nSUMMARY', JSON.stringify({ scans: s.scans, credits: s.credits, picker: s.picks, decisions: s.recentDecisions.map((d) => ({ symbol: d.symbol, progress: d.progress, clean: d.clean, score: d.score, hardFails: d.hardFails, reasons: d.reasons })), picks: store.data.picks }, null, 2));
  process.exit(0);
}, secs * 1000);
