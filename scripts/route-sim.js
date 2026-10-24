const { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const E = require('../exec'); const ex = E.createExecutor();
(async () => {
  const who = process.argv[3] || '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; const mint = process.argv[2]; const size = Number(process.argv[4] || 0.01);
  console.log('payer bal', (await ex.conn.getBalance(new PublicKey(who))) / 1e9);
  const micro = await ex.priorityMicro(); console.log('median priority µL/CU', micro);
  const b = await ex.plan({ side: 'buy', mint, user: who, amount: size });
  console.log('BUY plan', JSON.stringify({ venue: b.venue, feeBps: b.feeBps, vs: b.vs, expTok: b.expectedTok, minTok: b.minTok, impact: b.impactPct, slip: b.slippage }));
  // sell the expected token amount (min) in the same tx and close the ATA
  const { BN } = { BN: require('bn.js') }; const SPL = require('@solana/spl-token'); const P = require('@pump-fun/pump-sdk');
  const st = await ex.pumpState(); const v = await ex.venue(mint);
  const tokRaw = new BN(Math.floor(b.expectedTok * 1e6));
  const mi = await ex.conn.getAccountInfo(new PublicKey(mint));
  const sellIx = await new P.PumpSdk().getSellV3InstructionRaw({ user: new PublicKey(who), mint: new PublicKey(mint), amount: tokRaw, quoteAmount: new BN(1), tokenProgram: mi.owner, quoteMint: v.curve.quoteMint });
  const ixs = [...b.ixs, sellIx, SPL.createCloseAccountInstruction(new PublicKey(b.ata), new PublicKey(who), new PublicKey(who), [], mi.owner)];
  const { blockhash } = await ex.conn.getLatestBlockhash();
  const mk = (cu) => new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(who), recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs] }).compileToV0Message());
  const vacc = P.userVolumeAccumulatorPda(new PublicKey(who));
  const pre = await ex.conn.getBalance(new PublicKey(who)); const vaccPre = await ex.conn.getAccountInfo(vacc);
  const sim = await ex.simulate(mk(400000), [who, b.ata, vacc.toBase58()]);
  console.log('sim err', JSON.stringify(sim.err), 'units', sim.unitsConsumed); if (sim.err) console.log(sim.logs.slice(-8).join('\n'));
  const post = sim.accounts[0].lamports; const ataAfter = sim.accounts[1]; const vaccAfter = sim.accounts[2];
  console.log('SOL delta (excl. tx fee)', (post - pre) / 1e9, 'ATA still open?', !!ataAfter && ataAfter.lamports, 'vol acc created now?', !vaccPre && !!vaccAfter, vaccAfter && vaccAfter.lamports); const once = (!vaccPre && vaccAfter) ? vaccAfter.lamports : 0; console.log('round trip excl one-time acc %', ((pre - post - once) / 1e9 / size * 100).toFixed(3));
  console.log('round trip % (curve+impact, ATA rent still locked)', ((pre - post) / 1e9 / size * 100).toFixed(3));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
