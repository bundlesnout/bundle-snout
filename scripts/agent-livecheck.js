// Exercise the LIVE trade path without sending anything: PumpPortal builds a real buy tx for the agent wallet,
// we verify it (fee payer, mint), sign it locally and simulate it on mainnet. With an unfunded wallet the
// simulation is expected to fail with insufficient funds. NOTHING IS EVER SENT by this script.
// Usage: AGENT_WALLET_FILE=../sniff/.agent_wallet.json node scripts/agent-livecheck.js <mint> [solAmount]
const fs = require('fs');
const file = process.env.AGENT_WALLET_FILE || '.agent_wallet.json';
process.env.AGENT_SECRET_KEY = JSON.parse(fs.readFileSync(file, 'utf8')).secretKeyBase58; // in-process only, never printed
process.env.AGENT_MODE = 'live';
const { createAgent, parseSecret } = require('../agent');
const mint = process.argv[2]; const amt = Number(process.argv[3] || 0.01);
(async () => {
  const kp = parseSecret(process.env.AGENT_SECRET_KEY); const pub = kp.publicKey.toBase58();
  const a = createAgent({ log: () => {} });
  console.log('agent wallet', pub, '| mode', a.status().mode, '| halted', a.status().halted);
  const tx = await a._test.buildPortalTx('buy', mint, amt, pub);
  console.log('PumpPortal tx OK: v' + tx.version, 'keys', tx.message.staticAccountKeys.length, 'ixs', tx.message.compiledInstructions.length, 'feePayer', tx.message.staticAccountKeys[0].toBase58() === pub ? 'agent ✓' : 'WRONG');
  tx.sign([kp]); console.log('signed locally ✓ (' + tx.serialize().length + ' bytes)');
  try { const r = await a._test.simulateGuard(tx, 'buy', amt, pub); console.log('simulation passed', r); }
  catch (e) { console.log('simulation result:', e.message.slice(0, 300)); if (e.sim) console.log('units', e.sim.unitsConsumed, 'pre lamports', e.preLamports); }
  console.log('NOT SENT (check only).');
})().catch((e) => { console.error('livecheck error', e.message); process.exit(1); });
