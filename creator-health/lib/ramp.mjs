// The "200k diamonds in the first 90 days" tracker.
//
// The export only ever reports month-to-date diamonds, so no column tells you
// what a creator has earned since they joined. That figure has to be accrued by
// this tool, one daily snapshot at a time. For creators who joined before the
// tool started watching, the months we never saw are declared as blind days
// rather than quietly guessed at.
import { allocateDaily, shiftDays, diffDays } from './metrics.mjs';

/** Interpolated share of the target a creator should have reached by `day`. */
export function curveTarget(day, cfg) {
  const pts = cfg.curve;
  if (day <= pts[0].day) return 0;
  for (let i = 1; i < pts.length; i++) {
    if (day <= pts[i].day) {
      const a = pts[i - 1], b = pts[i];
      const t = (day - a.day) / (b.day - a.day);
      return Math.round((a.pct + t * (b.pct - a.pct)) * cfg.targetDiamonds);
    }
  }
  return cfg.targetDiamonds;
}

/** Diamonds accrued since the join date, plus an honest account of the gaps. */
function accrueSinceJoin(creator, endDate) {
  const byDay = allocateDaily(creator);
  const joinDate = creator.joinDate;
  if (!joinDate) return null;

  let observed = 0;
  let observedDays = 0;
  const totalDays = Math.max(0, diffDays(joinDate, endDate));
  for (let i = 0; i <= totalDays; i++) {
    const d = shiftDays(joinDate, i);
    const v = byDay.get(d);
    if (v) { observed += v.diamonds ?? 0; observedDays++; }
  }

  // The first snapshot we ever saw for this creator also reports the previous
  // full month's diamonds, which recovers one month of otherwise blind history.
  const first = creator.obs[0];
  const firstCovered = first ? shiftDays(first.date, -(first.span - 1)) : endDate;
  let estimatedPrior = 0;
  let estimatedFrom = null;
  if (first && firstCovered > joinDate && first.lastMonthDiamonds != null) {
    const priorMonthEnd = shiftDays(first.periodStart, -1);
    const priorMonthStart = `${priorMonthEnd.slice(0, 7)}-01`;
    if (priorMonthEnd >= joinDate) {
      estimatedPrior = first.lastMonthDiamonds;
      estimatedFrom = priorMonthStart > joinDate ? priorMonthStart : joinDate;
    }
  }

  const coveredStart = estimatedFrom ?? firstCovered;
  const blindDays = Math.max(0, diffDays(joinDate, coveredStart));

  return {
    observed,
    observedDays,
    estimatedPrior,
    total: observed + estimatedPrior,
    blindDays,
    exact: blindDays === 0,
  };
}

const STATUS = {
  ACHIEVED: 'ACHIEVED',
  ON_TRACK: 'ON_TRACK',
  AT_RISK: 'AT_RISK',
  OFF_TRACK: 'OFF_TRACK',
  MISSED: 'MISSED',
  GRADUATED: 'GRADUATED',
};

/**
 * Work out which lever closes the gap, and whether it is closeable at all.
 *
 * Three levers, in the order a coach should try them:
 *   days   - show up more often (cheapest, biggest early win)
 *   hours  - longer sessions (limited by what is sustainable)
 *   rate   - earn more per hour (slowest to move, needs real coaching)
 */
function planFor(m, requiredPerDay, cfg) {
  const perHour = m.diamondsPerHour28;
  const currentPerDay = m.dailyDiamonds7;
  const daysPerWeek = Math.min(7, m.activeDays28 / 4);
  const hoursPerSession = m.hoursPerActiveDay28;

  if (!perHour || perHour <= 0 || !hoursPerSession) {
    return { lever: 'activate', feasible: false, ask: 'Not enough LIVE history yet — the first job is a consistent schedule, not a target.' };
  }

  const requiredHoursPerDay = requiredPerDay / perHour;
  const currentHoursPerDay = (hoursPerSession * daysPerWeek) / 7;
  const extraHoursPerDay = requiredHoursPerDay - currentHoursPerDay;

  if (extraHoursPerDay <= 0) {
    return { lever: 'hold', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Already at the rate needed — hold ${hoursPerSession.toFixed(1)}h a session, ${daysPerWeek.toFixed(1)} days a week.` };
  }

  // Prefer adding days before adding hours to an existing session.
  const dayHeadroom = Math.max(0, cfg.sustainableDaysPerWeek - daysPerWeek);
  const gainFromDays = (dayHeadroom * hoursPerSession * perHour) / 7;

  if (gainFromDays >= requiredPerDay - currentPerDay) {
    const daysNeeded = ((requiredPerDay - currentPerDay) * 7) / (hoursPerSession * perHour);
    return {
      lever: 'days', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Add ${Math.ceil(daysNeeded * 10) / 10} LIVE day${daysNeeded > 1 ? 's' : ''} a week at their usual ${hoursPerSession.toFixed(1)}h. That alone covers the gap.`,
    };
  }

  if (requiredHoursPerDay <= cfg.maxHoursPerDay) {
    return {
      lever: 'hours', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Needs about ${requiredHoursPerDay.toFixed(1)}h LIVE a day (currently ${currentHoursPerDay.toFixed(1)}h) at their ${Math.round(perHour).toLocaleString()} diamonds/hour. Build to ${cfg.sustainableDaysPerWeek} days a week first, then lengthen sessions.`,
    };
  }

  const rateNeeded = requiredPerDay / cfg.sustainableHoursPerDay;
  return {
    lever: 'rate', feasible: rateNeeded <= perHour * 3,
    requiredHoursPerDay, currentHoursPerDay,
    ask: `Hours alone will not get there — would need ${requiredHoursPerDay.toFixed(1)}h a day. At a sustainable ${cfg.sustainableHoursPerDay}h they need ${Math.round(rateNeeded).toLocaleString()} diamonds/hour vs ${Math.round(perHour).toLocaleString()} today. Focus on gifting strategy, fan club and matches, not more hours.`,
  };
}

/** Evaluate the 0-90 day cohort against the 200k target. */
export function evaluateRamp(creators, metricsByKey, config) {
  const cfg = config.ramp;
  const rows = [];

  for (const c of creators) {
    if (c.quitOn) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    const day = m.daysSinceJoining;
    if (day == null || day > cfg.windowDays + 14) continue;

    const acc = accrueSinceJoin(c, m.endDate);
    if (!acc) continue;

    const daysLeft = Math.max(0, cfg.windowDays - day);
    const target = curveTarget(Math.min(day, cfg.windowDays), cfg);
    const requiredPerDay = daysLeft > 0 ? Math.max(0, (cfg.targetDiamonds - acc.total) / daysLeft) : 0;
    const projected = acc.total + m.dailyDiamonds7 * daysLeft;

    let status;
    if (acc.total >= cfg.targetDiamonds) status = STATUS.ACHIEVED;
    else if (day > cfg.windowDays) status = STATUS.MISSED;
    else if (acc.total >= target) status = STATUS.ON_TRACK;
    else if (acc.total >= target * cfg.atRiskRatio) status = STATUS.AT_RISK;
    else status = STATUS.OFF_TRACK;

    const plan = planFor(m, requiredPerDay, cfg);

    // Potential is about headroom, not current output: a creator converting well
    // in very few hours is the easiest one to move.
    const headroomHours = Math.max(0, cfg.sustainableHoursPerDay - (plan.currentHoursPerDay ?? 0));
    const potential = (m.diamondsPerHour28 ?? 0) * headroomHours * daysLeft;

    rows.push({
      creator: c, metrics: m, day, daysLeft,
      earned: Math.round(acc.total),
      observedOnly: Math.round(acc.observed),
      estimatedPrior: Math.round(acc.estimatedPrior),
      blindDays: acc.blindDays,
      exact: acc.exact,
      curveTarget: Math.round(target),
      pctOfTarget: acc.total / cfg.targetDiamonds,
      requiredPerDay: Math.round(requiredPerDay),
      currentPerDay: Math.round(m.dailyDiamonds7),
      projected: Math.round(projected),
      willHit: projected >= cfg.targetDiamonds,
      status,
      plan,
      potential: Math.round(potential),
      diamondsPerHour: m.diamondsPerHour28 ? Math.round(m.diamondsPerHour28) : null,
    });
  }

  rows.sort((a, b) => b.potential - a.potential || b.earned - a.earned);
  return rows;
}

/**
 * The creators worth a coach's time this week: behind the curve, but with the
 * conversion rate and unused hours to close the gap.
 */
export function spotlight(rows, config) {
  const cfg = config.ramp;
  return rows
    .filter((r) => r.daysLeft > 7 && !r.willHit && r.plan.feasible && r.potential > 0)
    .filter((r) => r.earned + r.potential >= cfg.targetDiamonds * 0.5)
    .slice(0, cfg.spotlightCount);
}

export { STATUS as RAMP_STATUS };
