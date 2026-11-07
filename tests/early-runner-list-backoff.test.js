// Box-only: early list API 403 backoff must persist across restarts (ops 2026-11-06:
// box-ensure restart ~8s after pause re-hit Cloudflare and double-logged "list API 403").
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-list-'));
const statusPath = path.join(dir, 'early-status.json');

const { readPersistedListBlockedUntil, applyList403, LIST_403_BACKOFF_MS } = require('../scripts/early-runner');

const now = Date.now();
const future = new Date(now + 20 * 60e3).toISOString();
fs.writeFileSync(statusPath, JSON.stringify({
  runner: { api: { listNextTryAt: future, listBlocked403: 3, listErr: 5, listLast: 'HTTP 403' } },
}));

const r = readPersistedListBlockedUntil(statusPath, now);
assert.ok(r.until > now, 'until in future');
assert.strictEqual(r.iso, future);
assert.strictEqual(r.api.listBlocked403, 3);

const expired = new Date(now - 60e3).toISOString();
fs.writeFileSync(statusPath, JSON.stringify({ runner: { api: { listNextTryAt: expired } } }));
assert.strictEqual(readPersistedListBlockedUntil(statusPath, now).until, 0, 'expired backoff ignored');

assert.strictEqual(readPersistedListBlockedUntil(path.join(dir, 'missing.json'), now).until, 0);

const logs = [];
const b = applyList403({ now, backoffMs: LIST_403_BACKOFF_MS, logFn: (...a) => logs.push(a.join(' ')) });
assert.ok(/list API 403/.test(logs[0]));
assert.strictEqual(b.until, now + LIST_403_BACKOFF_MS);
assert.strictEqual(b.iso, new Date(now + LIST_403_BACKOFF_MS).toISOString());
assert.strictEqual(LIST_403_BACKOFF_MS, 30 * 60e3);

fs.rmSync(dir, { recursive: true, force: true });
console.log('early-runner-list-backoff.test.js ok');
