// Offline test of /radar commands + footer with a mocked Telegram API (no network to Telegram).
const assert = require('assert');
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    const method = String(url).split('/').pop(); const body = JSON.parse(opt.body);
    sent.push({ method, body });
    if (method === 'getChatMember') return { json: async () => ({ ok: true, result: { status: body.user_id === 1 ? 'administrator' : 'member' } }) };
    return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  }
  return realFetch(url, opt);
};
process.env.FOOTER_TEXT = '🐽 TEST FOOTER $X';
const { createBot } = require('../telegram');
const { formatAlert } = require('../format');
const store = { data: { subs: [], alerted: [] }, saves: 0, save() { this.saves++; } };
const radar = { status: () => ({ running: true, trackedCoins: 42, aboveThreshold: 3, lastEventAt: new Date().toISOString(), ws: { newTokens: 9 }, scans: { today: 5, clean: 1 }, alerts: { sent: 1 }, config: { thresholdPct: 70, maxTop10Pct: 30, maxScansPerDay: 300 } }) };
const bot = createBot('TEST', { radar, store });
const msg = (text, chat = { id: 111, type: 'private' }, from = { id: 1 }) => ({ update_id: Math.random(), message: { message_id: 5, text, chat, from } });
const wait = () => new Promise((r) => setTimeout(r, 30));
(async () => {
  bot.handleUpdate(msg('/radar on')); await wait();
  assert.deepStrictEqual(store.data.subs, [111]); assert(sent.at(-1).body.text.includes('Bond Radar ON')); assert(sent.at(-1).body.text.endsWith('🐽 TEST FOOTER $X'));
  bot.handleUpdate(msg('/radar@Sniffscan26bot status')); await wait();
  assert(sent.at(-1).body.text.includes('<b>42</b>') && sent.at(-1).body.text.includes('ON'));
  bot.handleUpdate(msg('/radar on', { id: -500, type: 'supergroup' }, { id: 2 })); await wait();
  assert(!store.data.subs.includes(-500), 'non-admin cannot subscribe group');
  bot.handleUpdate(msg('/radar on', { id: -500, type: 'supergroup' }, { id: 1 })); await wait();
  assert(store.data.subs.includes(-500));
  bot.handleUpdate(msg('/radar off')); await wait();
  assert.deepStrictEqual(store.data.subs, [-500]);
  // broadcast
  const rep = JSON.parse(require('fs').readFileSync(__dirname + '/Bo8T2nESUEwfZU4rygeb8n4d2Hm5DtsKLaYtP7tEpump.json'));
  rep.curve.complete = false; rep.curve.progressPct = 75; rep.dev = { holdingPctSupply: 1 };
  const n0 = sent.length; const ok = await bot.broadcast(rep);
  assert.strictEqual(ok, 1); assert.strictEqual(sent[n0].body.chat_id, -500); assert(sent[n0].body.text.includes('BOND RADAR'));
  assert(formatAlert(rep).endsWith('🐽 TEST FOOTER $X'));
  console.log('telegram /radar tests passed; saves:', store.saves);
})().catch((e) => { console.error(e); process.exit(1); });
