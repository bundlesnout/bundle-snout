// Static checks for the public pages: required meta, absolute OG images, no broken asset references, routes wired.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const [f, img] of [['rips.html', 'rips-banner-v2.jpg'], ['dev.html', 'spaniarddev-header.jpg']]) {
  const h = pub(f);
  assert.ok(h.includes(`property="og:image" content="https://bundle-snout.onrender.com/${img}"`), f + ' og:image absolute');
  assert.ok(h.includes('name="twitter:card" content="summary_large_image"'), f + ' twitter card');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', img)), img + ' exists');
  for (const m of h.matchAll(/(?:src|href)="\/([a-z0-9-]+\.(?:jpg|png))"/g)) {
    const dyn = ['rips-logo.jpg', 'rips-favicon.png'].includes(m[1]);
    assert.ok(dyn ? server.includes(`'/${m[1]}'`) : fs.existsSync(path.join(__dirname, '..', 'public', m[1])), `${f}: /${m[1]} resolvable`);
  }
}
const r = pub('rips.html');
for (const s of ['How it works', 'Is this a giveaway?', 'Where do the fees go?', 'Why should I trust', 'Next pack', 'No packs ripped yet', 'The dev keeps the cards', 'href="/radar"', 'href="/dev"']) assert.ok(r.includes(s), 'rips.html has ' + s);
assert.ok(!/fresh wallet|dedicated wallet/i.test(r), 'no fresh-wallet claim');
assert.ok(!/pok[eé]mon|nintendo/i.test(r), 'no franchise names in the page copy');
for (const k of ['a', 'b']) for (const f of [`rips-logo-${k}.jpg`, `rips-favicon-${k}.png`]) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), f);
for (const route of ["'/rips'", "'/dev'", "'/radar'", "'/scalp'", "'/api/rips/status'", "'/api/radar/status'", "'/healthz'"]) assert.ok(server.includes(`app.get(${route}`), 'route ' + route);
const lv = pub('live.html');
for (const x of ['/api/rips/live', 'Next pack', 'First rip soon', 'LAUNCHING SOON', 'The dev keeps the cards', 'bundle-snout.onrender.com/rips', 'Live trades', 'src="/rips-logo.jpg"']) assert.ok(lv.includes(x), 'live.html has ' + x);
assert.ok(!/pok[eé]mon(?!\|)|nintendo|invest|100x|moon/i.test(lv.replace(/\/\\b\(pok\[eé\]mon\|gacha\|pack\)\\b\/gi/, '')), 'live.html: no franchise or investment copy');
assert.ok(r.includes('href="/live"'), 'rips links to /live');
for (const route of ["'/live'", "'/rips/live'", "'/api/rips/live'"]) assert.ok(server.includes(`app.get(${route}`), 'route ' + route);
console.log('pages tests OK');
