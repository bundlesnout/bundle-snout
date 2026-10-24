const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const icon = { high: '🔴', medium: '🟠', ok: '🟢', unknown: '⚪' };
const lvlIcon = { ALTO: '🔴', MEDIO: '🟠', BAJO: '🟢' };

const WEB = process.env.PUBLIC_URL || '';
// Footer appended to every scan / alert. Configurable so a ticker/CA can be added later.
const footer = () => esc(process.env.FOOTER_TEXT || '🐽 Bond Radar · powered by Bundle Snout');
function format(r) {
  const c = r.curve, b = r.bundle, d = r.dev, h = r.holders;
  const L = [];
  L.push(`🐽 <b>${esc(r.name)} ($${esc(r.symbol)})</b>`);
  L.push(`<code>${r.mint}</code>`);
  L.push(`${lvlIcon[r.risk.level]} <b>Riesgo / Risk: ${r.risk.level} / ${r.risk.levelEn}</b>`);
  L.push('');
  if (c) L.push(c.complete ? '🎓 Graduado a PumpSwap / Graduated' : `📈 Curva / Curve: <b>${c.progressPct}%</b> · faltan / left: <b>${c.quoteRemainingToGraduate.toFixed(2)} ${esc(c.quote)}</b>`);
  if (r.dex?.marketCapUsd != null) L.push(`💰 MC: $${Math.round(r.dex.marketCapUsd).toLocaleString('en-US')}`);
  if (b) L.push(`📦 Bloque creación / creation block: ${b.sameSlotWallets} wallets (${b.sameSlotPctSupply}%) · multi-wallet tx: ${b.multiWalletTxs} · +2 bloques: ${b.next2SlotBuyers} (${b.next2SlotPctSupply}%)`);
  if (d) L.push(`👤 Dev: vendió / sold ${d.soldPctOfBought ?? 0}% · tiene / holds ${d.holdingPctSupply}%`);
  L.push(`🐳 Top 10: ${h.top10Pct}%${h.holderCount != null ? ` · ${h.holderCount} holders` : ''}`);
  L.push('');
  r.risk.flags.forEach((f) => L.push(`${icon[f.level]} ${esc(f.es)}`));
  L.push('');
  L.push(`<i>${esc(r.risk.disclaimer.es)} / ${esc(r.risk.disclaimer.en)}</i>`);
  if (WEB) L.push(`🔗 ${WEB}/?mint=${r.mint}`);
  L.push('', footer());
  return L.join('\n');
}

// Bond Radar alert: coin near graduation that passed every clean check.
function formatAlert(r) {
  const c = r.curve, b = r.bundle, d = r.dev, h = r.holders;
  const L = [];
  L.push('📡 <b>BOND RADAR</b> — limpia y cerca de bondear / clean & close to bonding');
  L.push(`🐽 <b>${esc(r.name)} ($${esc(r.symbol)})</b>`);
  L.push(`<code>${r.mint}</code>`);
  L.push('');
  L.push(`📈 Curva / Curve: <b>${c.progressPct}%</b> · faltan / left: <b>${c.quoteRemainingToGraduate.toFixed(2)} ${esc(c.quote)}</b>`);
  if (r.dex?.marketCapUsd != null) L.push(`💰 MC: $${Math.round(r.dex.marketCapUsd).toLocaleString('en-US')}`);
  L.push(`✅ Sin bundle / no bundle: ${b.sameSlotWallets} wallets en bloque de creación (${b.sameSlotPctSupply}%), 0 multi-wallet tx, 0 pagadas por dev`);
  L.push(`✅ Dev no ha vendido / dev hasn't sold · tiene / holds ${d.holdingPctSupply}%`);
  L.push(`✅ Top 10: ${h.top10Pct}%${h.holderCount != null ? ` · ${h.holderCount} holders` : ''}`);
  L.push('');
  L.push(`🔗 https://pump.fun/coin/${r.mint}`);
  if (WEB) L.push(`🔍 ${WEB}/?mint=${r.mint}`);
  L.push(`<i>${esc(r.risk.disclaimer.es)} / ${esc(r.risk.disclaimer.en)}</i>`);
  L.push('', footer());
  return L.join('\n');
}

module.exports = { format, formatAlert, footer, esc };
