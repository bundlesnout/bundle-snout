// Box-only: portal WS lastMsgAgoS must not treat unset lastMsg as epoch, and the
// stale heartbeat must not force-reconnect before open stamps lastMsg (ops 2026-11-07
// vigilancia: early-status showed ws.lastMsgAgoS ≈ 1.79e9 right after restart).
const assert = require('assert');
const { wsLastMsgAgoS, portalWsShouldReconnect } = require('../scripts/early-runner');

const now = 1_700_000_000_000;

assert.strictEqual(wsLastMsgAgoS(0, now), null);
assert.strictEqual(wsLastMsgAgoS(null, now), null);
assert.strictEqual(wsLastMsgAgoS(undefined, now), null);
assert.strictEqual(wsLastMsgAgoS(now - 3500, now), 4);

assert.strictEqual(portalWsShouldReconnect(0, now), false);
assert.strictEqual(portalWsShouldReconnect(null, now), false);
assert.strictEqual(portalWsShouldReconnect(now - 30e3, now), false);
assert.strictEqual(portalWsShouldReconnect(now - 91e3, now), true);
assert.strictEqual(portalWsShouldReconnect(now - 91e3, now, 120e3), false);

console.log('early-runner-portal-ws.test.js: ok');
