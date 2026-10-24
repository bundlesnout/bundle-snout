// Replay the forward-test variants (agent-variants.json) on recorded trades through the agent's own shadow code.
// Usage: node scripts/variant-replay.js file.jsonl [more...] [--from=ISO] [--to=ISO]
const fs = require('fs');
process.env.AGENT_MODE = 'paper'; delete process.env.AGENT_SECRET_KEY;
const args = process.argv.slice(2); const files = args.filter((x) => !x.startsWith('--'));
const opt = Object.fromEntries(args.filter((x) => x.startsWith('--')).map((x) => x.slice(2).split('=')));
const solCurve = (t) => t.vs >= 29.9 && t.vs <= 130 && t.vt > 250e6 && t.vt <= 1.0731e9;
const rows = []; for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line) continue; try { const [at, mint, sol, tok, buy, user, vs, vt, done] = JSON.parse(line); const tr = { at, mint, sol, tok, buy: !!buy, user, vs, vt, realTok: done ? 0 : 1 }; if (solCurve(tr)) rows.push(tr); } catch {} }
rows.sort((a, b) => a.at - b.at);
const from = opt.from ? Date.parse(opt.from) : -Infinity, to = opt.to ? Date.parse(opt.to) : Infinity;
const { createAgent } = require('../agent'); const { cleanCheck, CFG } = require('../radar');
let t = rows[0].at; const mm = new Map(); const scalper = { mints: mm, symbol: () => null };
const ag = createAgent({ scalper, now: () => t, analyze: async () => { throw new Error('no scans in replay'); }, cleanCheck, radarCfg: CFG(), rpc: null, quiet: true, params: null, fetchFn: async () => ({ json: async () => ({}) }) });
ag.cfg.enabled = false; // the agent itself does not trade: only the forward-test variants run
function feed(tr) { let m = mm.get(tr.mint); if (!m) { m = { trades: [], vs: tr.vs, vt: tr.vt }; mm.set(tr.mint, m); }
  const pvs = tr.buy ? tr.vs - tr.sol : tr.vs + tr.sol, pvt = tr.buy ? tr.vt + tr.tok : tr.vt - tr.tok;
  m.trades.push({ at: tr.at, sol: tr.sol, buy: tr.buy, user: tr.user, vs: tr.vs, vt: tr.vt, pvs, pvt });
  while (m.trades.length > 400 || (m.trades.length && m.trades[0].at < tr.at - 300e3)) m.trades.shift();
  m.vs = tr.vs; m.vt = tr.vt; m.lastAt = tr.at; m.complete = tr.realTok === 0 || tr.vt <= 279.95e6; return m; }
let nextTick = t + 5000; const sh = ag.st.shadow;
for (const tr of rows) { t = tr.at; while (nextTick <= t) { const k = t; t = nextTick; ag._test.safeTick(); t = k; nextTick += 5000; }
  const m = feed(tr); if (t < from) { m.agentShadow = t; continue; } if (t > to) break; ag.onTrade(tr, m); }
// only count closes of entries opened in the window and fully resolved (ignore still-open at the end)
const out = ag.status().shadow.variants.map((v) => ({ id: v.id, n: v.closed, win: v.winRate, avg: v.avgPct, net: v.netSol, dd: v.maxDDSol, tp: v.tpHitRatePct }));
console.log(JSON.stringify({ rows: rows.length, from: new Date(Math.max(from, rows[0].at)).toISOString(), to: new Date(Math.min(to, rows[rows.length - 1].at)).toISOString(), variants: out }));
