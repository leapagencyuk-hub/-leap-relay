// Decline detection.
//
// The ordering of the signals matters more than any single threshold. When a
// creator starts to slide, the observable metrics move in this sequence:
//
//   1. they skip a LIVE day            (same day)
//   2. their sessions get shorter      (day 0-3)
//   3. fan-club engagement thins out   (day 3-7)
//   4. diamonds fall                   (day 7-14)
//
// Waiting for diamonds means reacting two weeks late, so schedule (1)-(3) as
// early warnings in their own right and reserve the loudest alerts for the
// combinations that have actually predicted a fall.
import { tierOf } from './metrics.mjs';

const SEVERITY_ORDER = { watch: 1, warn: 2, urgent: 3 };
// Earliest-moving signals first: this is both the detection order and the
// order a coach should read them in.
const SIGNAL_ORDER = [
  'DARK', 'LIVE_DAYS_DOWN', 'HOURS_DOWN', 'SUSTAINED_HOURS_DOWN',
  'FANCLUB_FANS_DOWN', 'CONCENTRATION_RISK',
  'EFFICIENCY_DOWN', 'FANCLUB_DIAMONDS_DOWN', 'DIAMONDS_DOWN', 'SUSTAINED_DIAMONDS_DOWN',
];
const LEADING = ['DARK', 'LIVE_DAYS_DOWN', 'HOURS_DOWN', 'SUSTAINED_HOURS_DOWN'];
const LAGGING = ['DIAMONDS_DOWN', 'FANCLUB_DIAMONDS_DOWN', 'SUSTAINED_DIAMONDS_DOWN'];
const pct = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const round = (x, n = 0) => (x == null ? null : Number(x.toFixed(n)));
/** Whole numbers in coach-facing text always carry thousands separators. */
const fmt = (x, n = 0) => (x == null ? '—' : Number(x.toFixed(n)).toLocaleString('en-GB'));

/**
 * Raise a threshold to clear a creator's own noise floor.
 *
 * A steady creator trips at the configured threshold. A volatile one has to
 * fall further before we believe it, because for them a big swing is Tuesday.
 */
function noiseAdjusted(baseThreshold, vol, multiple) {
  if (!vol || vol.cv == null) return baseThreshold;
  return Math.max(baseThreshold, Math.min(vol.cv * multiple, 0.85));
}

function signalsFor(m, tier, cfg) {
  const t = cfg.byTier[tier];
  const out = [];
  if (!t) return out;
  const k = cfg.volatilityMultiple;

  // --- 1. attendance -------------------------------------------------------
  // "Days off air" only means something relative to a creator's own rhythm:
  // two quiet days is an emergency for someone live six days a week and
  // completely normal for someone live once a week.
  const daysPerWeek = m.activeDays28 / 4;
  const normalGap = m.activeDays28 > 0 ? 28 / m.activeDays28 : Infinity;
  const darkThreshold = Math.max(t.darkDays, Math.ceil(normalGap * 2));
  if (m.darkStreak >= darkThreshold) {
    out.push({
      code: 'DARK',
      severity: m.darkStreak >= darkThreshold * 2 ? 'urgent' : 'warn',
      label: `${m.darkStreak} days with no LIVE`,
      detail: `Last valid LIVE day was ${m.darkStreak} days ago — they normally go live ${round(daysPerWeek, 1)} days a week.`,
    });
  }
  const liveDaysLost = m.prev7.validLiveDays - m.curr7.validLiveDays;
  const daysNoise = m.profile.validLiveDays?.sd ?? 0;
  if (liveDaysLost >= Math.max(t.liveDaysDrop, daysNoise * k) && m.prev7.validLiveDays >= 3) {
    out.push({
      code: 'LIVE_DAYS_DOWN',
      severity: 'warn',
      label: `${round(liveDaysLost, 1)} fewer LIVE days this week`,
      detail: `${fmt(m.curr7.validLiveDays, 1)} valid LIVE days in the last 7, down from ${fmt(m.prev7.validLiveDays, 1)}.`,
    });
  }

  // --- 2. session length ---------------------------------------------------
  const hoursDrop = noiseAdjusted(t.hoursDrop, m.profile.liveHours, k);
  if (m.change7.liveHours != null && m.change7.liveHours <= -hoursDrop && m.prev7.liveHours >= t.hoursFloor) {
    out.push({
      code: 'HOURS_DOWN',
      severity: m.change7.liveHours <= -hoursDrop * 1.8 ? 'urgent' : 'warn',
      label: `LIVE hours ${pct(m.change7.liveHours)}`,
      detail: `${fmt(m.curr7.liveHours, 1)}h in the last 7 days vs ${fmt(m.prev7.liveHours, 1)}h the week before.`,
    });
  }

  // --- 3. fan club ---------------------------------------------------------
  const fc = cfg.fanClub;
  const af = m.fanClub.activeFansChange7;
  if (af != null && af <= -fc.activeFansDrop && (m.fanClub.activeFans ?? 0) >= fc.activeFansFloor) {
    out.push({
      code: 'FANCLUB_FANS_DOWN',
      severity: 'watch',
      label: `Active Fan Club members ${pct(af)}`,
      detail: `${fmt(m.fanClub.activeFans)} active fan-club members, down ${pct(af)} in a week. Fan club spend usually follows within a fortnight.`,
    });
  }
  if (m.fanClub.diamondsChange7 != null && m.fanClub.diamondsChange7 <= -fc.diamondsDrop && m.prev7.fanClubDiamonds >= t.diamondsFloor / 2) {
    out.push({
      code: 'FANCLUB_DIAMONDS_DOWN',
      severity: 'warn',
      label: `Fan Club diamonds ${pct(m.fanClub.diamondsChange7)}`,
      detail: `Fan club gave ${fmt(m.curr7.fanClubDiamonds)} this week vs ${fmt(m.prev7.fanClubDiamonds)} last week.`,
    });
  }
  if ((m.fanClub.contribution ?? 0) >= fc.concentrationRisk && af != null && af < 0) {
    out.push({
      code: 'CONCENTRATION_RISK',
      severity: 'watch',
      label: `${Math.round(m.fanClub.contribution * 100)}% of diamonds come from the Fan Club`,
      detail: 'Earnings rest on a handful of members and that group is shrinking. One person leaving takes a visible share of income with them.',
    });
  }

  // --- 4. conversion and output -------------------------------------------
  // Measured against weeks 3-8 rather than the 28-day average, which a slide
  // already in progress would have dragged down with it.
  const baseHours = m.profile.liveHours?.baseline;
  const baseDiamonds = m.profile.diamonds?.baseline;
  const baseRate = baseHours > 0.5 ? baseDiamonds / baseHours : m.diamondsPerHour28;
  if (m.diamondsPerHour7 != null && baseRate > 0 && m.curr7.liveHours >= t.hoursFloor) {
    const drop = (m.diamondsPerHour7 - baseRate) / baseRate;
    if (drop <= -cfg.efficiencyDrop) {
      out.push({
        code: 'EFFICIENCY_DOWN',
        severity: 'warn',
        label: `Diamonds per LIVE hour ${pct(drop)}`,
        detail: `Earning ${fmt(m.diamondsPerHour7)} per hour this week against ${fmt(baseRate)} before this started — the hours are there, the room is not converting.`,
      });
    }
  }
  const dd = m.change7.diamonds;
  const lost = m.prev7.diamonds - m.curr7.diamonds;
  const diamondsDrop = noiseAdjusted(t.diamondsDrop, m.profile.diamonds, k);
  if (dd != null && dd <= -diamondsDrop && lost >= t.diamondsFloor) {
    out.push({
      code: 'DIAMONDS_DOWN',
      severity: dd <= -diamondsDrop * 1.8 ? 'urgent' : 'warn',
      label: `Diamonds ${pct(dd)}`,
      detail: `${fmt(m.curr7.diamonds)} this week vs ${fmt(m.prev7.diamonds)} last week — ${fmt(lost)} fewer.`,
    });
  }

  // --- 5. sustained decline against their own normal -----------------------
  // Week-on-week only catches the moment something changes. Once a creator has
  // settled at a lower level, this week looks identical to last week and the
  // whole slide goes silent. Comparing against weeks 3-8 catches those.
  const sustained = (field, code, floor, label) => {
    const p = m.profile[field];
    if (!p?.baseline || p.baseline <= 0) return;
    const now = m.curr7[field];
    const change = (now - p.baseline) / p.baseline;
    const absolute = p.baseline - now;
    if (change > -noiseAdjusted(t[`${code}Drop`], p, k)) return;
    if (absolute < floor) return;
    out.push({
      code: code === 'diamonds' ? 'SUSTAINED_DIAMONDS_DOWN' : 'SUSTAINED_HOURS_DOWN',
      severity: 'warn',
      label: `${label} ${pct(change)} below their normal`,
      detail: `${fmt(now, field === 'liveHours' ? 1 : 0)} this week against a ${fmt(p.baseline, field === 'liveHours' ? 1 : 0)} weekly average before this started — this has been running for weeks, not days.`,
    });
  };
  sustained('diamonds', 'diamonds', t.diamondsFloor, 'Diamonds');
  sustained('liveHours', 'hours', t.hoursFloor, 'LIVE hours');

  out.sort((a, b) => SIGNAL_ORDER.indexOf(a.code) - SIGNAL_ORDER.indexOf(b.code));
  return out;
}

/**
 * Turn the signal list into a single status.
 *
 * A lone early-warning signal is a nudge, not an alarm: two or more that agree,
 * or any confirmed drop in output, is what gets a coach's attention.
 */
function gradeSignals(signals) {
  if (!signals.length) return null;
  const top = signals.reduce((a, s) => (SEVERITY_ORDER[s.severity] > SEVERITY_ORDER[a] ? s.severity : a), 'watch');
  const leading = signals.some((s) => LEADING.includes(s.code));
  const lagging = signals.some((s) => LAGGING.includes(s.code));

  // A single metric moving is week-to-week noise more often than it is a
  // problem. Two that agree, or one severe enough to stand on its own, is the
  // point at which a coach should hear about it.
  if (leading && lagging) return 'urgent';
  if (top === 'urgent' && signals.length >= 2) return 'urgent';
  if (top === 'urgent' || signals.length >= 2) return 'warn';
  return 'watch';
}

/** Diamonds the network loses over the next 28 days if this week's rate holds. */
function valueAtRisk(m) {
  if (m.curr28.diamonds <= 0) return 0;
  const projected = m.dailyDiamonds7 * 28;
  return Math.max(0, Math.round(m.curr28.diamonds - projected));
}

/** The lever with the most headroom, phrased as something a coach can say. */
export function suggestAction(m, signals) {
  const codes = new Set(signals.map((s) => s.code));
  const perHour = m.diamondsPerHour28;
  if (codes.has('DARK')) {
    return `Call them today — find out what changed. ${m.darkStreak} days off air at their normal rate is about ${Math.round(m.dailyDiamonds28 * m.darkStreak).toLocaleString()} diamonds already gone. Agree a fixed schedule for the next 7 days.`;
  }
  if (codes.has('LIVE_DAYS_DOWN')) {
    const back = Math.round(m.prev7.validLiveDays - m.curr7.validLiveDays);
    const worth = perHour && m.hoursPerActiveDay28 ? Math.round(perHour * m.hoursPerActiveDay28 * back) : null;
    return `They have dropped ${back} LIVE day${back === 1 ? '' : 's'} a week. Getting those back is worth about ${worth ? worth.toLocaleString() : '—'} diamonds a week. Ask what is blocking those days before talking about content.`;
  }
  if (codes.has('HOURS_DOWN')) {
    const gap = m.prev7.liveHours - m.curr7.liveHours;
    return `Sessions have shortened by ${gap.toFixed(1)}h over the week. Usually burnout, a schedule clash, or a room that has gone quiet. Ask which, then rebuild to ${(m.hoursPerActiveDay28 ?? 2).toFixed(1)}h a session rather than adding days.`;
  }
  if (codes.has('EFFICIENCY_DOWN')) {
    const eff = signals.find((s) => s.code === 'EFFICIENCY_DOWN');
    return `Hours are holding but conversion is down (${eff.label.toLowerCase()}). Review a recent LIVE together: goals on screen, gift callouts, and whether the format changed.`;
  }
  if (codes.has('FANCLUB_FANS_DOWN') || codes.has('FANCLUB_DIAMONDS_DOWN') || codes.has('CONCENTRATION_RISK')) {
    return `Fan club is thinning (${m.fanClub.activeFans ?? '—'} active members${m.fanClub.contribution ? `, ${Math.round(m.fanClub.contribution * 100)}% of their income` : ''}). Get them running a members-only segment this week and personally messaging the top members who have gone quiet.`;
  }
  return `Diamonds are down ${pct(m.change7.diamonds)} week on week with no single obvious cause. Worth a check-in call to catch it before the trend sets.`;
}

/**
 * Evaluate every creator for a given as-of date.
 * `state` carries alert history so a coach is not pinged daily about the same
 * slide, and so recoveries can be reported once.
 */
export function evaluateDecline(creators, metricsByKey, config, state = { open: {} }) {
  const cfg = config.decline;
  const alerts = [];
  const recoveries = [];
  const skipped = { dormant: 0, ineligible: 0, tooNew: 0, quit: 0 };

  for (const c of creators) {
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    const prior = state.open[c.key];

    if (c.quitOn) {
      skipped.quit++;
      if (prior) delete state.open[c.key];
      continue;
    }
    if (m.historyDays < cfg.minHistoryDays || !m.hasFullPrev7) { skipped.tooNew++; continue; }

    const tier = tierOf(m, config.tiers);
    if (tier === 'dormant') { skipped.dormant++; continue; }
    // No established pattern, nothing to deviate from. These creators belong on
    // the activation list, not the decline list.
    if (m.activeDays28 < cfg.eligibility.minActiveDays28) { skipped.ineligible++; continue; }
    if (m.prev7.liveHours < cfg.eligibility.minPrev7LiveHours
        && m.curr28.diamonds < cfg.eligibility.minPrev28Diamonds) { skipped.ineligible++; continue; }

    const signals = signalsFor(m, tier, cfg);
    const severity = gradeSignals(signals);

    if (!severity) {
      // Recovered: was flagged, now clean and back to most of the prior rate.
      if (prior && m.dailyDiamonds7 * 7 >= prior.curr7Diamonds * cfg.recoveryThreshold) {
        recoveries.push({ creator: c, metrics: m, since: prior.firstSeenOn });
        delete state.open[c.key];
      }
      continue;
    }

    const escalated = !prior || SEVERITY_ORDER[severity] > SEVERITY_ORDER[prior.severity];
    const daysSinceNotified = prior ? daysBetween(prior.notifiedOn, m.endDate) : Infinity;
    const notify = escalated || daysSinceNotified >= cfg.cooldownDays;

    const alert = {
      creator: c,
      metrics: m,
      tier,
      severity,
      signals,
      valueAtRisk: valueAtRisk(m),
      action: suggestAction(m, signals),
      isNew: !prior,
      escalated: Boolean(prior) && escalated,
      notify,
      openSince: prior?.firstSeenOn ?? m.endDate,
    };
    alerts.push(alert);

    state.open[c.key] = {
      severity,
      firstSeenOn: prior?.firstSeenOn ?? m.endDate,
      notifiedOn: notify ? m.endDate : prior.notifiedOn,
      curr7Diamonds: prior?.curr7Diamonds ?? m.curr7.diamonds,
      codes: signals.map((s) => s.code),
    };
  }

  alerts.sort((a, b) =>
    SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.valueAtRisk - a.valueAtRisk);
  return { alerts, recoveries, skipped };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
