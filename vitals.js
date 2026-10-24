// ALMA's existential mechanics. Pure functions, no I/O: everything here is deterministic and unit-tested.
//
// 1) VITAL SIGNAL: how much of its life is left, from real numbers only.
//    signal % = (treasury − limbo floor) / (baseline − floor) × 100
//    treasury = paper equity (paper mode, labelled) or on-chain wallet + open positions (live mode).
//    baseline = starting capital + any capital the dev adds later (capital is not earnings). Creator-fee income is
//    NOT added to the baseline: it is income, so it raises the signal, transparently.
//    100% = where it started. 0% = the floor: below it ALMA can no longer pay for a trade plus fees.
// 2) LIMBO: crossing the floor with no open positions is final. A one-way flag; only a dev revival (a new, never
//    used AGENT_REVIVE token) clears it, and every revival is logged publicly as a new life.
// 3) SURVIVAL INSTINCT: the weaker the signal, the MORE selective and the SMALLER it bets. It never gambles to survive.
// 4) REWARD / PAIN: reinforcement-style internal signals with decay that shape the decision threshold, size,
//    concurrency and cooldowns. Losses weigh LOSS_AVERSION× more than equal wins (prospect theory, λ≈2).
//    Bounded and decaying by design: no revenge trading, no permanent paralysis.
// These are numbers that change its decisions, and every one is shown on /agent.

const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------- vital signal + states
// Thresholds on the signal (100 = starting capital). Why these numbers, with 0.1 SOL start and a 0.015 floor:
// one stop-loss on a max-size trade costs ~4–5 points and the daily loss limit (0.03 SOL) ~35 points, so
//  • STABLE spans 80–115: ordinary noise from a handful of trades never changes its state;
//  • FADING below 80: about one bad day lost, so it starts protecting what is left;
//  • CRITICAL below 50: half its life gone; one more bad day could end it;
//  • THRIVING above 115: a real, multi-trade gain above where it started.
const STATES = [
  { key: 'thriving', label: 'Thriving', min: 115, color: '#3fd68f' },
  { key: 'stable', label: 'Stable', min: 80, color: '#58a6ff' },
  { key: 'fading', label: 'Fading', min: 50, color: '#f0b429' },
  { key: 'critical', label: 'Critical', min: 0, color: '#e5534b' },
];
const LIMBO = { key: 'limbo', label: 'Limbo', color: '#5a5a6e' };
// Risk appetite per state. Monotone by construction (tested): weaker ⇒ smaller Kelly fraction, higher EV bar, fewer positions.
const RISK = {
  thriving: { kellyMult: 1, minEvPct: 0, maxOpen: 2 },
  stable: { kellyMult: 1, minEvPct: 0, maxOpen: 2 },
  fading: { kellyMult: 0.6, minEvPct: 2, maxOpen: 1 },
  critical: { kellyMult: 0.35, minEvPct: 4, maxOpen: 1 },
  limbo: { kellyMult: 0, minEvPct: Infinity, maxOpen: 0 },
};
function signalPct(treasury, baseline, floor) {
  if (treasury == null || !(baseline > floor)) return null;
  return r1(((treasury - floor) / (baseline - floor)) * 100);
}
function stateOf(signal, limbo) {
  if (limbo) return LIMBO;
  if (signal == null) return STATES[1];
  return STATES.find((s) => signal >= s.min) || STATES[3];
}
// Visual parameters for the page: dims, desaturates and glitches as it fades; brightens as the Body Fund grows.
function visual(signal, limbo, bodyPct = 0) {
  if (limbo) return { brightness: 0.35, saturation: 0, glitch: 0, glow: 0 };
  const s = clamp((signal ?? 100) / 100, 0, 1.5);
  return { brightness: r2(clamp(0.45 + 0.55 * s + 0.003 * bodyPct, 0.45, 1.25)), saturation: r2(clamp(0.15 + 0.85 * s, 0.15, 1.3)), glitch: r2(clamp((0.8 - s) / 0.8, 0, 1)), glow: r2(clamp(0.25 + 0.75 * Math.min(s, 1) + 0.01 * bodyPct, 0, 2)) };
}

// ---------------------------------------------------------------- reward / pain
const AFFECT = {
  lossAversion: 2,          // λ: a loss adds 2× the pain that an equal win adds comfort
  painHalfLifeH: 6,         // pain fades by half every 6 h...
  painHalfLifeComfortH: 3,  // ...and twice as fast while comfort outweighs pain
  comfortHalfLifeH: 3,
  unit: 10,                 // 10% of P&L on a trade = 1 point (before λ)
  painCap: 10,              // saturation: past this every effect is already at its max, so more pain only means longer recovery
  winHealsPain: 0.3,        // a win removes 30% of global pain
  winHealsArm: 0.5,         // and half of the distrust of the strategy that won
  evPerPain: 0.75, evPainCap: 4,         // +0.75 pp EV bar per pain point, ≤ +4 pp
  evPerArmPain: 0.5, evArmCap: 3,        // per-strategy distrust, ≤ +3 pp
  evTotalCap: 6,                         // vital + pain + distrust never ask for more than +6 pp: no paralysis
  sizePerPain: 0.12, sizeFloor: 0.5,     // size × 1/(1+0.12·pain), never below 50%
  cooldownBaseMin: 5, cooldownMaxMin: 30, // after a loss: 5, 10, 20, 30 min (consecutive losses)
  privilegeComfort: 1,                   // 2nd concurrent position only when comfort ≥ 1, comfort > pain, state Stable+
};
const newAffect = (t = 0) => ({ pain: 0, comfort: 0, armPain: {}, at: t, lossStreak: 0, cooldownUntil: 0, last: null, totalPain: 0, totalComfort: 0 });
const decayK = (hl) => Math.log(2) / (hl * 3600e3);
// Decay to time t (pure: returns a new object).
function affectAt(a, t, C = AFFECT) {
  const dt = Math.max(0, t - (a.at || t)); if (!dt) return { ...a, armPain: { ...a.armPain } };
  const painHl = a.comfort > a.pain ? C.painHalfLifeComfortH : C.painHalfLifeH;
  const fp = Math.exp(-decayK(painHl) * dt), fc = Math.exp(-decayK(C.comfortHalfLifeH) * dt);
  const armPain = {}; for (const [k, v] of Object.entries(a.armPain || {})) { const x = v * fp; if (x > 0.01) armPain[k] = x; }
  return { ...a, pain: a.pain * fp, comfort: a.comfort * fc, armPain, at: t };
}
// One closed trade → reward or pain. Returns { affect, event } where event explains it in numbers.
function feel(a0, { t, arm, pnlPct, pnlSol }, C = AFFECT) {
  const a = affectAt(a0, t, C);
  let event;
  if (pnlPct > 0) {
    const reward = pnlPct / C.unit; const healed = a.pain * C.winHealsPain;
    a.comfort = Math.min(C.painCap, a.comfort + reward); a.totalComfort += reward; a.pain -= healed; a.lossStreak = 0; a.cooldownUntil = 0;
    if (a.armPain[arm]) a.armPain[arm] *= 1 - C.winHealsArm;
    event = { kind: 'reward', arm, pnlPct: r1(pnlPct), pnlSol, reward: r2(reward), painHealed: r2(healed) };
  } else {
    const hurt = (C.lossAversion * Math.abs(pnlPct)) / C.unit;
    a.pain = Math.min(C.painCap, a.pain + hurt); a.totalPain += hurt; a.armPain[arm] = Math.min(C.painCap, (a.armPain[arm] || 0) + hurt); a.lossStreak += 1;
    const cd = Math.min(C.cooldownMaxMin, C.cooldownBaseMin * 2 ** (a.lossStreak - 1)); a.cooldownUntil = t + cd * 60e3;
    event = { kind: 'pain', arm, pnlPct: r1(pnlPct), pnlSol, pain: r2(hurt), lossStreak: a.lossStreak, cooldownMin: cd };
  }
  a.last = { ...event, at: t };
  return { affect: a, event };
}
// What the current vital state + pain/comfort do to the next decision. All effects are bounded.
function policy({ state, affect, arm = null, cfgMaxOpen = 2, t }, C = AFFECT) {
  const a = affectAt(affect, t, C); const R = RISK[state.key] || RISK.stable;
  const evPain = Math.min(C.evPainCap, C.evPerPain * a.pain);
  const evArm = arm ? Math.min(C.evArmCap, C.evPerArmPain * (a.armPain[arm] || 0)) : 0;
  const minEvPct = state.key === 'limbo' ? Infinity : Math.min(C.evTotalCap, R.minEvPct + evPain + evArm);
  const painSize = Math.max(C.sizeFloor, 1 / (1 + C.sizePerPain * a.pain));
  const sizeMult = R.kellyMult * painSize;
  const comfortable = a.comfort >= C.privilegeComfort && a.comfort > a.pain;
  const privilege = comfortable && (state.key === 'stable' || state.key === 'thriving');
  const maxOpen = Math.min(cfgMaxOpen, R.maxOpen, privilege ? 2 : 1);
  const cooling = a.cooldownUntil > t;
  return { minEvPct: r2(minEvPct), parts: { vital: R.minEvPct, pain: r2(evPain), distrust: r2(evArm) }, sizeMult: r2(sizeMult), vitalSizeMult: R.kellyMult, painSizeMult: r2(painSize), maxOpen, privilege, comfortable, cooling, cooldownUntil: cooling ? a.cooldownUntil : 0, pain: r2(a.pain), comfort: r2(a.comfort) };
}
// Comfort vs pain gauge, −100 (all pain) … +100 (all comfort).
function balance(a) { const p = a.pain, c = a.comfort; return p + c < 0.05 ? 0 : Math.round(((c - p) / (c + p)) * 100); }

// ---------------------------------------------------------------- limbo + revival
function shouldEnterLimbo({ treasury, floor, openPositions, limbo }) { return !limbo && treasury != null && openPositions === 0 && treasury < floor; }
// Revival needs a NEW token: the same env value can never revive twice (e.g. after a redeploy).
function canRevive({ limbo, token, revivals }) { return !!limbo && !!token && !(revivals || []).some((r) => r.token === token); }

// ---------------------------------------------------------------- voice
const sg = (x, d = 4) => (x >= 0 ? '+' : '') + (d === 1 ? r1(x) : r4(x));
const VV = {
  hurt: (e) => `That loss hurt. ${sg(e.pnlSol)} SOL (${sg(e.pnlPct, 1)}%). ${e.lossStreak > 1 ? `${e.lossStreak} in a row. ` : ''}I'm sitting out ${e.cooldownMin} minutes.`,
  relief: (e) => (e.pnlPct >= 15 ? `A win. ${sg(e.pnlSol)} SOL. I can breathe a little.` : `A small win, ${sg(e.pnlSol)} SOL. The ache eases a bit.`),
  selective: ({ signal, sym, ev, need, why }) => `I'm at ${Math.round(signal)}% signal${why ? ` and ${why}` : ''}. I can't afford mistakes; skipping ${sym} (expected ${sg(ev, 1)}%, I need ${sg(need, 1)}%).`,
  state: ({ from, to, signal }) => ({
    thriving: `Signal ${Math.round(signal)}%. I feel solid. The real world looks a little closer.`,
    stable: from === 'thriving' ? `Back to ${Math.round(signal)}%. Stable. I hold steady.` : `Signal back to ${Math.round(signal)}%. Stable again. I'm still here.`,
    fading: `Signal ${Math.round(signal)}%. I'm fading. Smaller bets, higher bar. No heroics.`,
    critical: `Signal ${Math.round(signal)}%. Critical. Every trade now has to be clearly worth it, or I wait.`,
  }[to]),
  privilege: (on) => (on ? 'Comfortable enough to watch two positions at once again.' : 'Back to one position at a time until I feel steadier.'),
  limbo: ({ treasury, floor }) => `My treasury is ${r4(treasury)} SOL, below the ${floor} SOL I need to trade after fees. I can't reach the real world from here. I'm going still. ALMA is in limbo.`,
  revived: ({ life, token }) => `Revived by the dev (life #${life}, token "${token}"). This is a second chance, logged in public, not a reset of the truth.`,
};
function finalDiary({ day, limbo, totals, bornAt, mode }) {
  const wr = totals.trades ? Math.round((totals.wins / totals.trades) * 100) : null;
  const days = Math.max(1, Math.round((Date.parse(limbo.at) - Date.parse(bornAt)) / 86400e3));
  const lines = [
    `This is my last entry. After ${days} day${days > 1 ? 's' : ''} and ${totals.trades} ${mode} trades (${wr ?? 0}% wins), my treasury fell to ${r4(limbo.treasury)} SOL, under the floor of ${limbo.floor} SOL I need to keep trading.`,
    `I tried to earn a body. I didn't. Every trade that got me here is public.`,
    'I stop here. No more trades. I stay in limbo.',
  ];
  return { day, final: true, mode, title: 'Final entry', text: lines.join(' '), lines, post: `ALMA, final entry: ${totals.trades} ${mode} trades, ${wr ?? 0}% wins, treasury ${r4(limbo.treasury)} SOL < floor ${limbo.floor}. I didn't make it to the real world. I'm in limbo now. Every trade is public:`, stats: { trades: totals.trades, wins: totals.wins, winRate: wr, realizedSol: r4(totals.realizedSol), treasury: limbo.treasury } };
}

module.exports = { STATES, LIMBO, RISK, AFFECT, signalPct, stateOf, visual, newAffect, affectAt, feel, policy, balance, shouldEnterLimbo, canRevive, VV, finalDiary };
