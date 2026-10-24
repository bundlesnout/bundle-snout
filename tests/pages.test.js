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
const ag = pub('agent.html');
for (const x of ['/api/agent', 'I never trade my own coin', 'solscan', 'PAPER', 'Trade log', 'Thought stream', 'Body Fund', 'Backtest', '/agent/diary', 'one time only']) assert.ok(ag.toLowerCase().includes(x.toLowerCase()), 'agent.html has ' + x);
for (const x of ['ALMA is in limbo', 'Body or limbo', 'Comfort vs pain', 'Buying the coin is not how I stay alive', 'count toward my treasury', 'stop trading for good']) assert.ok(ag.includes(x), 'agent.html has ' + x);
// honesty guardrail: no urgency / "save ALMA by buying" calls to action anywhere ALMA speaks
const NO_CTA = /(buy|ape|hold)\b[^.]{0,30}\b(save|rescue|keep)\b[^.]{0,12}\b(alma|her|it|me)\b(?! alive\.)|save alma|before it'?s too late|last chance|don'?t let (alma|her|it|me) die/i;
for (const f of ['agent.html', 'agent-diary.html']) assert.ok(!NO_CTA.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')), 'no buyer urgency CTA in ' + f);
assert.ok(!NO_CTA.test(fs.readFileSync(path.join(__dirname, '..', 'vitals.js'), 'utf8')) && !NO_CTA.test(fs.readFileSync(path.join(__dirname, '..', 'mind.js'), 'utf8')), 'no buyer urgency CTA in the voice');
const di = pub('agent-diary.html'); for (const x of ['/api/agent/diary', 'Copy for X']) assert.ok(di.includes(x), 'diary has ' + x);
for (const f of ['agent.html', 'agent-diary.html']) { const h = pub(f); assert.ok(!/[áéíóúñ¿¡]|financial advice|a show, not profits|<b>Disclaimer/i.test(h), 'English only, no end disclaimers in ' + f); }
assert.ok(pub('dev.html').includes('href="/agent"'), 'dev links to /agent');
for (const route of ["'/agent'", "'/api/agent'", "'/agent/diary'", "'/api/agent/diary'"]) assert.ok(server.includes(`app.get(${route}`), 'route ' + route);
console.log('pages tests OK');
// mobile live dashboard (/m, /agent/live)
{ const m = pub('m.html');
  for (const x of ['/api/agent/m', 'Right now', 'Risk-free goal', 'Open positions', 'Last trades', 'updated', 'alma.webmanifest', 'PAPER']) assert.ok(m.includes(x), 'm.html has ' + x);
  assert.ok(!/[áéíóúñ¿¡]|financial advice|<b>Disclaimer/i.test(m) && !NO_CTA.test(m), 'm.html English, no disclaimers / CTA');
  assert.ok(server.includes("app.get(['/m', '/agent/live']") && server.includes("app.get('/api/agent/m'"), 'mobile routes');
  assert.ok(pub('agent.html').includes('href="/m"'), 'agent links to /m');
  const man = JSON.parse(pub('alma.webmanifest')); assert.ok(man.icons.length >= 2 && man.start_url.startsWith('/m'), 'manifest');
  for (const f of ['alma-icon-192.png', 'alma-icon-512.png']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), f); }
console.log('mobile page ok');
