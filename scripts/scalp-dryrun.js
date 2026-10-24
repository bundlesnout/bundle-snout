// Paper-trading dry run against the live public pump.fun log stream. No wallet, no Render writes, no Telegram.
// Usage: node scripts/scalp-dryrun.js [seconds=900]
process.env.STATE_BACKEND = 'memory';
const fs = require('fs');
const { createScalper } = require('../scalp');
const secs = Number(process.argv[2] || 900);
const sc = createScalper({ store: null });
sc.start();
const t0 = Date.now();
const line = () => { const s = sc.status(); const p = s.primary, top = s.scalp.top10[0];
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] msgs=${s.stream.msgs} trades=${s.stream.trades} MB=${(s.stream.bytes / 1e6).toFixed(0)} mints=${s.stream.mintsTracked} lag=${s.stream.lagMs}ms cpu=${(process.cpuUsage().user / 1e6 / ((Date.now() - t0) / 1000) * 100).toFixed(0)}% rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB sig=${JSON.stringify(s.signals)} entries=${s.entries} open=${s.openPositions} closes=${s.closes} | primary n=${p.trades} win=${p.winRate}% net=${p.netSol} | best=${top ? top.key + ' n=' + top.trades + ' net=' + top.netSol : '-'}`); };
const iv = setInterval(line, 60000);
setTimeout(() => { clearInterval(iv); line(); const s = sc.status(); sc.stop();
  fs.writeFileSync(process.env.DRYRUN_OUT || 'scalp-dryrun.json', JSON.stringify({ status: s, trades: sc.trades(), all: [...sc.variants.values()].filter((v) => v.n).map((v) => sc.variant(v.key)) }, null, 2));
  console.log(JSON.stringify({ primary: s.primary, ridePrimary: s.ridePrimary, scalpTotals: s.scalp.totals, top10: s.scalp.top10.map((v) => [v.key, v.trades, v.winRate, v.netSol, v.maxDrawdownSol]), worst3: s.scalp.worst3.map((v) => [v.key, v.trades, v.netSol]), ride: s.ride, recent: sc.trades().scalp.slice(0, 8) }, null, 1));
  process.exit(0); }, secs * 1000);
