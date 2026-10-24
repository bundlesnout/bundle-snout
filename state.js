// Tiny persistence for Bond Radar (subscribers + alerted mints).
// Render free has an ephemeral disk, so the "render" backend stores one JSON blob in a service env var
// (RADAR_STATE) through the Render API. Updating an env var via the API does NOT trigger a deploy;
// we read it back from the API on boot. Fallback: in-memory only (lost on restart).
const KEY = process.env.STATE_ENV_KEY || 'RADAR_STATE';
const API_KEY = process.env.STATE_RENDER_API_KEY || '';
const SERVICE = process.env.RENDER_SERVICE_ID || process.env.STATE_RENDER_SERVICE_ID || '';
const BACKEND = (process.env.STATE_BACKEND || (API_KEY && SERVICE ? 'render' : 'memory')).toLowerCase();

function createStore() {
  let data = { v: 1, subs: [], alerted: [], picks: [] };
  let timer = null; let lastSaveAt = null; let lastSaveError = null; let loadedFrom = 'empty';
  const url = `https://api.render.com/v1/services/${SERVICE}/env-vars/${KEY}`;
  const headers = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'application/json' };

  async function load() {
    let raw = null;
    if (BACKEND === 'render') {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (r.ok) { raw = (await r.json()).value; loadedFrom = 'render-api'; }
        else if (r.status !== 404) lastSaveError = `load HTTP ${r.status}`;
      } catch (e) { lastSaveError = 'load ' + e.message; }
    }
    if (raw == null && process.env[KEY]) { raw = process.env[KEY]; loadedFrom = 'process.env'; }
    if (raw) { try { const j = JSON.parse(raw); data = { v: 1, subs: j.subs || [], alerted: j.alerted || [], picks: j.picks || [] }; } catch { loadedFrom = 'corrupt->empty'; } }
    return data;
  }
  async function flush() {
    timer = null;
    if (BACKEND !== 'render') return;
    try {
      const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ value: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      lastSaveAt = new Date().toISOString(); lastSaveError = null;
    } catch (e) { lastSaveError = e.message; console.error('[state] save failed:', e.message); }
  }
  function save() { if (!timer) timer = setTimeout(flush, 3000); }
  return {
    load, save, flush,
    get data() { return data; },
    status: () => ({ backend: BACKEND, key: KEY, loadedFrom, lastSaveAt, lastSaveError, subscribers: data.subs.length, alertedRemembered: data.alerted.length, picks: (data.picks || []).length, bytes: JSON.stringify(data).length }),
  };
}
module.exports = { createStore };
