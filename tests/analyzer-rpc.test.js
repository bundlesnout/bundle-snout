// Offline: analyzer.rpc retries transient "Failed to query long-term storage" like rips.js,
// and still fails immediately on a permanent JSON-RPC error.
process.env.RPC_MIN_GAP_MS = '0';
const assert = require('assert');

const origFetch = global.fetch;
let n = 0;
global.fetch = async () => {
  n++;
  if (n === 1) {
    return { ok: true, status: 200, json: async () => ({ error: { code: -32019, message: 'Failed to query long-term storage; please try again' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ result: 9 }) };
};

const { rpc } = require('../analyzer');

(async () => {
  const v = await rpc('getSignaturesForAddress', ['x', {}]);
  assert.strictEqual(v, 9);
  assert.strictEqual(n, 2, 'should retry once after long-term storage');

  n = 0;
  global.fetch = async () => {
    n++;
    return { ok: true, status: 200, json: async () => ({ error: { code: -32000, message: 'Account not found' } }) };
  };
  let threw = false;
  try { await rpc('getAccountInfo', ['x']); } catch (e) {
    threw = /Account not found/.test(e.message);
  }
  assert.ok(threw, 'permanent RPC error should throw');
  assert.strictEqual(n, 1, 'permanent RPC error should not retry');
  // Size cap: an oversized streamed body is aborted with a non-retryable 'response too large' error.
  n = 0;
  const big = new TextEncoder().encode('{"result":[' + '"x",'.repeat(300000) + '"x"]}');
  global.fetch = async () => { n++; return new Response(big, { status: 200 }); };
  let tooLarge = false;
  try { await rpc('getProgramAccounts', ['p', {}], 4, { maxBytes: 100000 }); } catch (e) { tooLarge = e.tooLarge && /too large/.test(e.message); }
  assert.ok(tooLarge, 'oversized body should throw tooLarge');
  assert.strictEqual(n, 1, 'too-large should not retry');
  global.fetch = async () => new Response(JSON.stringify({ result: [1, 2] }), { status: 200 });
  assert.deepStrictEqual(await rpc('getProgramAccounts', ['p', {}], 4, { maxBytes: 100000 }), [1, 2]);
  global.fetch = async () => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } });
  tooLarge = false;
  try { await rpc('getProgramAccounts', ['p', {}], 4, { maxBytes: 100000 }); } catch (e) { tooLarge = !!e.tooLarge; }
  assert.ok(tooLarge, 'content-length over cap should throw');
  console.log('ok analyzer long-term storage retry');
})().catch((e) => { console.error('FAIL analyzer-rpc', e); process.exit(1); }).finally(() => { global.fetch = origFetch; });
