// Box-only: readBoardCache must log once when a previously-stale browser board
// cache becomes fresh again (mtime newer than last stale observation).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-board-'));
const board = path.join(dir, 'featured-board.json');
process.env.FEATURED_BOARD_CACHE = board;
process.env.FEATURED_BOARD_CACHE_MAX_MS = String(60e3); // 1 min
process.env.FEATURED_BOARD_CACHE_STALE_MAX_MS = String(3 * 60 * 60e3);

const { readBoardCache, _resetBoardCacheStaleObs } = require('../scripts/featured-runner');

function writeBoard(mtimeMs) {
  fs.writeFileSync(board, JSON.stringify({ entries: [{ m: 'Xpump', n: 'X' }] }));
  const t = mtimeMs / 1000;
  fs.utimesSync(board, t, t);
}

const logs = [];
const orig = console.log;
console.log = (...a) => { logs.push(a.map(String).join(' ')); };

_resetBoardCacheStaleObs();
const now = Date.now();
writeBoard(now - 90 * 60e3); // 90 min old → stale (>1 min max)
assert.ok(readBoardCache());
assert.ok(logs.some((l) => /board cache stale/.test(l)), 'expected stale log');

logs.length = 0;
writeBoard(now - 10e3); // fresh rewrite (browser refresh)
assert.ok(readBoardCache());
assert.ok(logs.some((l) => /board cache fresh again/.test(l)), 'expected fresh-again log: ' + logs.join('|'));

logs.length = 0;
assert.ok(readBoardCache());
assert.ok(!logs.some((l) => /board cache fresh again/.test(l)), 'fresh-again must log only once');

console.log = orig;
fs.rmSync(dir, { recursive: true, force: true });
console.log('featured-runner-cache.test.js ok');
