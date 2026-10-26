// AGENT_STATE must stay under Linux's 128 KiB per-env-string limit, or Render cannot start the service at all.
const assert = require('assert');
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE; delete process.env.AGENT_ENABLED;
process.env.AGENT_MAX_STATE_B64 = '20000';
const zlib = require('zlib');
const { createAgent } = require('../agent');
(async () => {
  let t = Date.parse('2026-10-24T12:00:00Z'); const now = () => t;
  let saved = null; const store = { name: 'mem', get: async () => saved, put: async (v) => { saved = v; } };
  const scalper = { mints: new Map(), symbol: () => null, solUsd: () => 180, streamInfo: () => ({ connected: true, mintsTracked: 0 }) };
  const mk = () => createAgent({ scalper, store, now, log: () => {}, analyze: async () => ({}), cleanCheck: () => ({ ok: false, reasons: ['x'] }) });
  const a = mk(); await a.start();
  await a.save(); assert.ok(saved.length < 20000); assert.strictEqual(a.status().persistence.stateTrimmed, null);
  // random (incompressible) history well over the cap
  const rnd = () => require('crypto').randomBytes(24).toString('base64');
  a.st.dayStats.missed = { budget: 1, mints: Array.from({ length: 600 }, rnd) };
  for (let i = 0; i < 150; i++) a.st.trades.push({ side: 'SELL', mint: rnd(), symbol: 'X', pnlSol: -0.001, pnlPct: -5, at: new Date(t).toISOString() });
  a.st.paperCash = 0.0912; await a.save();
  assert.ok(saved.length <= 20000, 'trimmed to the cap: ' + saved.length);
  const p = a.status().persistence; assert.ok(p.stateTrimmed && p.stateBytes <= 20000, JSON.stringify(p));
  const j = JSON.parse(zlib.gunzipSync(Buffer.from(saved.slice(3), 'base64')));
  assert.ok(j.dayStats.missed.mints.length <= 40); assert.strictEqual(j.paperCash, 0.0912, 'core state kept');
  a.stop(); const b = mk(); await b.start(); assert.strictEqual(b.st.paperCash, 0.0912, 'trimmed snapshot restores'); b.stop();
  console.log('agentstate ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
