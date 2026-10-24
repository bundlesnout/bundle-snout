// $TANKLOOP landing page (/tankloop). Isolated module: CA comes from env TANKLOOP_CA (empty = pre-launch).
const path = require('path');
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function config() {
  const ca = (process.env.TANKLOOP_CA || '').trim();
  const ok = MINT_RE.test(ca);
  return { ticker: 'TANKLOOP', name: 'Tank Loop', ca: ok ? ca : null, pumpUrl: ok ? `https://pump.fun/coin/${ca}` : null,
    dexUrl: ok ? `https://dexscreener.com/solana/${ca}` : null, x: 'https://x.com/SpaniardDev' };
}
function register(app) {
  app.get('/tankloop', (_, res) => res.sendFile(path.join(__dirname, 'public', 'tankloop.html')));
  app.get('/api/tankloop/config', (_, res) => { res.set('cache-control', 'no-store'); res.json(config()); });
}
module.exports = { register, config };
