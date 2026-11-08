// Offline: publicRpc retries the same transient "Failed to query long-term storage" public-RPC
// blip that rips.js and analyzer.rpc already retry, and still fails immediately on a permanent error.
const assert = require('assert');
const { publicRpc } = require('../public-rpc');

(async () => {
  let n = 0;
  const fetchRetry = async () => {
    n++;
    if (n === 1) {
      return { ok: true, status: 200, json: async () => ({ error: { code: -32019, message: 'Failed to query long-term storage; please try again' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ result: { value: 42 } }) };
  };
  const v = await publicRpc('https://example.invalid', 'getSignaturesForAddress', ['x', {}], { fetchFn: fetchRetry, retryMs: 0 });
  assert.strictEqual(v.value, 42);
  assert.strictEqual(n, 2, 'should retry once after long-term storage');

  n = 0;
  const fetchPerm = async () => {
    n++;
    return { ok: true, status: 200, json: async () => ({ error: { code: -32000, message: 'Account not found' } }) };
  };
  let threw = false;
  try { await publicRpc('https://example.invalid', 'getAccountInfo', ['x'], { fetchFn: fetchPerm, retryMs: 0 }); } catch (e) {
    threw = /Account not found/.test(e.message);
  }
  assert.ok(threw, 'permanent RPC error should throw');
  assert.strictEqual(n, 1, 'permanent RPC error should not retry');

  n = 0;
  const fetch429 = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, json: async () => ({ error: { message: 'Too many requests' } }) };
    return { ok: true, status: 200, json: async () => ({ result: 7 }) };
  };
  const v2 = await publicRpc('https://example.invalid', 'getBalance', ['x'], { fetchFn: fetch429, retryMs: 0 });
  assert.strictEqual(v2, 7);
  assert.strictEqual(n, 2, 'should retry HTTP 429');

  console.log('ok public-rpc long-term storage retry');
})().catch((e) => { console.error('FAIL public-rpc', e); process.exit(1); });
