// Box-only: readBoardCache must log once when a previously-stale browser board
// cache becomes fresh again (mtime newer than last stale observation), and must
// throttle "board cache stale" to once per 15 min age bucket (ops 2026-11-06).
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
const staleMtime = now - 90 * 60e3;
writeBoard(staleMtime); // 90 min old → stale (>1 min max)
assert.ok(readBoardCache());
assert.ok(logs.some((l) => /board cache stale/.test(l)), 'expected stale log');
logs.length = 0;
assert.ok(readBoardCache());
assert.ok(!logs.some((l) => /board cache stale/.test(l)), 'stale must not re-log same 15min bucket');

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

// boardCache age + NEED_BROWSER_FETCH surfaced on status (ops 2026-11-06: ~113 min stale).
const { enrichBoardCacheStatus } = require('../scripts/featured-runner');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-enrich-'));
const board2 = path.join(dir2, 'featured-board.json');
const meta2 = path.join(dir2, 'featured-board.meta.json');
const flag2 = path.join(dir2, 'NEED_BROWSER_FETCH');
process.env.FEATURED_BOARD_CACHE = board2;
process.env.FEATURED_BOARD_CACHE_MAX_MS = String(60e3);
process.env.FEATURED_BOARD_CACHE_STALE_MAX_MS = String(3 * 60 * 60e3);
fs.writeFileSync(board2, JSON.stringify({ entries: [{ m: 'Ypump' }] }));
const staleAt = (Date.now() - 90 * 60e3) / 1000;
fs.utimesSync(board2, staleAt, staleAt);
fs.writeFileSync(meta2, JSON.stringify({ savedAt: '2026-11-06T15:00:00.000Z', entries: 1, source: 'browser' }));
fs.writeFileSync(flag2, '{"reason":"test"}\n');
const st = enrichBoardCacheStatus({ board: { fromCache: true } });
assert.ok(st.boardCache, 'boardCache present');
assert.ok(st.boardCache.ageSec >= 89 * 60, 'ageSec ~90min got ' + st.boardCache.ageSec);
assert.strictEqual(st.boardCache.stale, true);
assert.strictEqual(st.boardCache.usable, true);
assert.strictEqual(st.boardCache.needBrowserFetch, true);
assert.strictEqual(st.boardCache.metaEntries, 1);
assert.strictEqual(st.board.cacheAgeSec, st.boardCache.ageSec);
assert.strictEqual(st.board.cacheStale, true);
assert.strictEqual(st.board.needBrowserFetch, true);
fs.unlinkSync(flag2);
const st2 = enrichBoardCacheStatus({ board: {} });
assert.strictEqual(st2.boardCache.needBrowserFetch, false);
assert.strictEqual(st2.board.needBrowserFetch, false);
fs.rmSync(dir2, { recursive: true, force: true });
console.log('featured-runner-cache enrichBoardCacheStatus ok');
