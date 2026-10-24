// Record pump.fun bonding-curve trades from the free public RPC log stream to JSONL (for offline backtests).
// Usage: node scripts/record-trades.js out.jsonl [minutes]
const fs = require('fs'); const WebSocket = require('ws');
const { tradesFromMessage } = require('../scalp');
const out = fs.createWriteStream(process.argv[2] || 'trades.jsonl', { flags: 'a' }); const mins = Number(process.argv[3] || 60);
const end = Date.now() + mins * 60e3; let n = 0;
function connect() {
  const ws = new WebSocket(process.env.SCALP_WS_URL || 'wss://api.mainnet-beta.solana.com', { perMessageDeflate: false });
  ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] }, { commitment: 'confirmed' }] })));
  ws.on('message', (b) => { const at = Date.now(); for (const t of tradesFromMessage(b.toString())) { n++; out.write(JSON.stringify([at, t.mint, +t.sol.toFixed(6), +t.tok.toFixed(2), t.buy ? 1 : 0, t.user, +t.vs.toFixed(6), +t.vt.toFixed(2), t.realTok === 0 ? 1 : 0]) + '\n'); } });
  ws.on('close', () => { if (Date.now() < end) setTimeout(connect, 2000); }); ws.on('error', () => {});
}
connect(); setInterval(() => { console.log(new Date().toISOString(), 'trades', n); if (Date.now() > end) { out.end(); process.exit(0); } }, 60e3);
