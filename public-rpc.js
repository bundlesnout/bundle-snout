// JSON-RPC against a public Solana endpoint, with retries for transient blips.
// The mobile dashboard (/api/agent/m) reads the wallet via MOBILE_RPC (public mainnet, 0 Helius
// credits). rips.js and analyzer.rpc already retry "Failed to query long-term storage"; this
// helper does the same for getSignaturesForAddress / getTransaction on that page.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publicRpc(url, method, params, { fetchFn = fetch, timeoutMs = 8000, tries = 3, retryMs = 400 } = {}) {
  let delay = retryMs;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429 || r.status === 413 || r.status >= 500) throw Object.assign(new Error('HTTP ' + r.status), { retry: true });
      const j = await r.json();
      if (j.error) {
        const msg = j.error.message || '';
        if (j.error.code === 429 || j.error.code === -32429 || /rate|too many|long-term storage/i.test(msg)) {
          throw Object.assign(new Error(msg), { retry: true });
        }
        throw new Error(msg);
      }
      return j.result;
    } catch (e) {
      if (!(e.retry || e.name === 'TimeoutError' || e.name === 'TypeError') || i === tries - 1) throw e;
      if (retryMs) await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

module.exports = { publicRpc };
