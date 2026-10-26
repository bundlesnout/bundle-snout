// Deploy handover: a new instance waits for the old instance's final save instead of restoring a stale snapshot.
const assert = require('assert');
delete process.env.AGENT_SECRET_KEY; delete process.env.AGENT_MODE; delete process.env.AGENT_ENABLED;
process.env.AGENT_HANDOVER_SEC = '1'; process.env.AGENT_HANDOVER_POLL_MS = '50';
const { createAgent } = require('../agent');
(async () => {
  let t = Date.parse('2026-10-24T12:00:00Z'); const now = () => t;
  let saved = null; const store = { name: 'mem', get: async () => saved, put: async (v) => { saved = v; } };
  const scalper = { mints: new Map(), symbol: () => null, solUsd: () => 180, streamInfo: () => ({ connected: true, mintsTracked: 0 }) };
  const mk = () => createAgent({ scalper, store, now, log: () => {}, analyze: async () => ({}), cleanCheck: () => ({ ok: false, reasons: ['x'] }) });
  const old = mk(); await old.start(); old.st.paperCash = 0.09; await old.save(); // periodic (non-final) save
  const staleAt = JSON.parse(require('zlib').gunzipSync(Buffer.from(saved.slice(3), 'base64'))).savedAt;
  // old instance keeps trading, then gets SIGTERM 0.2 s after the new one booted
  t += 120e3; old.st.paperCash = 0.0777;
  setTimeout(() => { old.saveFinal(); }, 200);
  const nu = mk(); await nu.start();
  assert.strictEqual(nu.st.paperCash, 0.0777, 'restored the final save, not the stale one');
  assert.ok(nu.st.handover && nu.st.handover.gotFinalSave, JSON.stringify(nu.st.handover));
  assert.strictEqual(nu.st.handover.staleSavedAt, staleAt);
  assert.ok(nu.status().persistence.handover.gotFinalSave);
  nu.stop();
  // final snapshot: next boot does not wait
  const t1 = Date.now(); const n2 = mk(); await n2.start(); assert.ok(Date.now() - t1 < 40, 'no wait after a final save'); assert.ok(!n2.st.handover); n2.stop();
  // crash (no final save): waits at most handoverSec, then restores what it has
  await n2.save(); t += 60e3; const t2 = Date.now(); const n3 = mk(); await n3.start();
  assert.ok(Date.now() - t2 >= 900, 'waited'); assert.strictEqual(n3.st.handover.gotFinalSave, false); n3.stop();
  // an old snapshot (instance long gone) is restored at once
  await n3.save(); t += 30 * 60e3; const t3 = Date.now(); const n4 = mk(); await n4.start(); assert.ok(Date.now() - t3 < 40); n4.stop();
  // no trading before start finished
  const n5 = mk(); n5.onTrade({ mint: 'X' }, { trades: [] }); assert.strictEqual(n5.st.regime.buckets?.length || 0, 0);
  console.log('handover ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
