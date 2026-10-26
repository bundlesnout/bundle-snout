// SCALP_STATE must stay under Linux's 128 KiB per-env-string limit, or Render cannot start the service at all.
const assert = require('assert'); const zlib = require('zlib');
process.env.SCALP_MAX_STATE_B64 = '6000';
const { createScalper } = require('../scalp');
(async () => {
  let got = null; const sc = createScalper({ store: { name: 'fake', get: async () => null, put: async (v) => { got = v; } }, log: () => {} });
  let i = 0; for (const v of sc.variants.values()) { i++; v.n = i % 97 + 1; v.wins = 1; v.net = Math.random(); v.reasons = { tp: i, sl: i * 3, time: i * 7, ['r' + i]: Math.random() }; }
  await sc.save();
  assert.ok(got && got.length <= 6000, 'snapshot capped: ' + (got && got.length));
  const j = JSON.parse(zlib.gunzipSync(Buffer.from(got, 'base64')).toString());
  const kept = Object.values(j.v); assert.ok(kept.length >= 50, 'kept variants ' + kept.length);
  const minKept = Math.min(...kept.map((a) => a[0])); const dropped = [...sc.variants.values()].filter((v) => !j.v[v.key]);
  assert.ok(dropped.every((v) => v.n <= minKept), 'the most-traded variants are kept');
  console.log('scalp state cap ok (' + got.length + ' bytes, ' + kept.length + ' variants kept)');
})().catch((e) => { console.error(e); process.exit(1); });
