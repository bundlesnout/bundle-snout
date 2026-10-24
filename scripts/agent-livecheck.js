// Exercise the LIVE trade path WITHOUT SENDING ANYTHING, with the real agent wallet on mainnet:
//  1) direct route (exec.js): build a buy on the pump.fun curve, check accounts, sign locally, run the agent's
//     simulateGuard (SOL-outflow bound) -> must pass with a funded wallet;
//  2) full round trip buy + sell_v3 + close token account in ONE simulated tx -> real cost in %;
//  3) PumpPortal fallback buy: built, signed, simulated;
//  4) principal payout transfer: built + simulated (small probe amount; the real amount is the whole balance today).
// Usage: AGENT_WALLET_FILE=.agent_wallet.json node scripts/agent-livecheck.js <curve mint> [solAmount]
const fs = require('fs');
const file = process.env.AGENT_WALLET_FILE || '.agent_wallet.json';
process.env.AGENT_SECRET_KEY = JSON.parse(fs.readFileSync(file, 'utf8')).secretKeyBase58; // in-process only, never printed
process.env.AGENT_MODE = 'live';
const { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Transaction, SystemProgram } = require('@solana/web3.js');
const BN = require('bn.js');
const { createAgent, parseSecret } = require('../agent');
const E = require('../exec');
const mint = process.argv[2]; const amt = Number(process.argv[3] || 0.01);
let ok = true; const fail = (m) => { ok = false; console.log('FAIL', m); };
(async () => {
  const kp = parseSecret(process.env.AGENT_SECRET_KEY); const pub = kp.publicKey.toBase58();
  const a = createAgent({ log: () => {} }); const ex = E.createExecutor({ rpcUrl: process.env.RPC_URL });
  const bal = await ex.conn.getBalance(kp.publicKey);
  console.log('agent wallet', pub, '| balance', bal / 1e9, 'SOL | mode', a.status().mode, '| halted', a.status().halted);
  // 1) direct buy, exactly as liveSwap builds it
  const b = await ex.build({ side: 'buy', mint, user: pub, amount: amt, slip: { volPct: 0 } });
  const keys = b.tx.message.staticAccountKeys.map((k) => k.toBase58());
  console.log('DIRECT buy', JSON.stringify({ venue: b.venue, ix: b.ix, feeBps: b.feeBps, expTok: Math.round(b.expectedTok), minTok: Math.round(b.minTok), impactPct: b.impactPct, slippageTolPct: b.slippage.tolPct, slipOk: b.slippage.ok, cuLimit: b.cuLimit, cuPrice: b.cuPrice, priorityLamports: b.priorityLamports, fit: b.fitSim }));
  if (keys[0] !== pub || !keys.includes(mint)) fail('direct tx account check');
  b.tx.sign([kp]);
  try { const g = await a._test.simulateGuard(b.tx, 'buy', amt, pub); console.log('DIRECT buy simulateGuard PASSED: outflow', g.out, 'SOL, units', g.units); } catch (e) { fail('direct buy simulation: ' + e.message.slice(0, 300)); }
  // 2) round trip in one tx
  try {
    const P = require('@pump-fun/pump-sdk'); const SPL = require('@solana/spl-token'); const v = await ex.venue(mint);
    const mi = await ex.conn.getAccountInfo(new PublicKey(mint)); const tokRaw = new BN(Math.floor(b.expectedTok * 1e6));
    const sellIx = await new P.PumpSdk().getSellV3InstructionRaw({ user: kp.publicKey, mint: new PublicKey(mint), amount: tokRaw, quoteAmount: new BN(1), tokenProgram: mi.owner, quoteMint: v.curve.quoteMint });
    const ixs = [...b.ixs, sellIx, SPL.createCloseAccountInstruction(new PublicKey(b.ata), kp.publicKey, kp.publicKey, [], mi.owner)];
    const { blockhash } = await ex.conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs] }).compileToV0Message());
    const vacc = P.userVolumeAccumulatorPda(kp.publicKey).toBase58(); const vPre = await ex.conn.getAccountInfo(new PublicKey(vacc));
    const sim = await ex.simulate(tx, [pub, b.ata, vacc]);
    if (sim.err) fail('round trip sim ' + JSON.stringify(sim.err) + ' ' + (sim.logs || []).slice(-3).join(' | '));
    else { const once = !vPre && sim.accounts[2] ? sim.accounts[2].lamports : 0; const lost = bal - sim.accounts[0].lamports - once;
      console.log('ROUND TRIP buy+sell+close (1 tx):', (lost / 1e9 / amt * 100).toFixed(3) + '% (curve fees + impact, excl. network)', '| ATA closed', !sim.accounts[1], '| one-time pump account', once / 1e9, 'SOL | units', sim.unitsConsumed); }
  } catch (e) { fail('round trip: ' + e.message); }
  // 3) PumpPortal fallback
  try { const tx = await a._test.buildPortalTx('buy', mint, amt, pub, 3); tx.sign([kp]); const g = await a._test.simulateGuard(tx, 'buy', amt, pub); console.log('PUMPPORTAL fallback buy simulateGuard PASSED: outflow', g.out, 'SOL'); }
  catch (e) { console.log('pumpportal fallback (non-fatal):', e.message.slice(0, 200)); }
  // 4) payout transfer path (probe amount, simulated only)
  try {
    const { blockhash } = await ex.conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('76FHD3T6iu1GMJNyUqShKxHepu85kD3tkg1s6QXq4HLm'), lamports: 1e6 }));
    tx.sign(kp); const g = await a._test.simulateGuard(tx, 'payout', 0.001, pub); console.log('PAYOUT transfer simulateGuard PASSED (probe 0.001 SOL): outflow', g.out);
  } catch (e) { fail('payout sim: ' + e.message.slice(0, 200)); }
  console.log(ok ? 'LIVECHECK OK' : 'LIVECHECK FAILED', '— NOTHING SENT (check only).'); process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('livecheck error', e.message); process.exit(1); });
