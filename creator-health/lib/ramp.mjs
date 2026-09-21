// The 200,000 diamond target.
//
// It is a MONTHLY target, not a cumulative one. A creator has to land 200,000
// diamonds inside a single calendar month, and their first 90 days give them
// roughly three attempts at it. Missing September does not carry a deficit into
// October: the counter resets on the 1st and they start again.
//
// That reset is also why this is more reliable than a running total would be.
// Every attempt is measured inside one month, which is exactly the window the
// export reports, so nothing has to be accrued across a period we never saw.

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (d) => Date.parse(`${d}T00:00:00Z`);
const monthKey = (d) => d.slice(0, 7);
const daysInMonth = (key) =>
  new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const addDays = (d, n) => iso(ts(d) + n * 86400000);
const nextMonth = (key) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * The calendar months a creator can use for their attempt.
 *
 * Their window runs from the join date to 90 days later, and any month that
 * overlaps it is a month they could win in. A creator joining on the 28th gets
 * three days of that first month — technically an attempt, realistically not
 * one, which `viable` marks.
 */
export function attemptMonths(joinDate, windowDays) {
  const end = addDays(joinDate, windowDays);
  const months = [];
  for (let key = monthKey(joinDate); key <= monthKey(end); key = nextMonth(key)) {
    const total = daysInMonth(key);
    const firstDay = key === monthKey(joinDate) ? Number(joinDate.slice(8, 10)) : 1;
    const lastDay = key === monthKey(end) ? Number(end.slice(8, 10)) : total;
    const available = lastDay - firstDay + 1;
    months.push({ key, available, daysInMonth: total, viable: available >= 20 });
  }
  return months;
}

const STATUS = {
  ACHIEVED: 'ACHIEVED',   // already landed a 200k month
  ON_TRACK: 'ON_TRACK',   // this month's pace clears it
  AT_RISK: 'AT_RISK',     // behind pace but still reachable this month
  OFF_TRACK: 'OFF_TRACK', // will not happen this month
  MISSED: 'MISSED',       // window closed without a 200k month
};

/**
 * Which lever closes the gap, measured over the days left in this month.
 *
 * Everything "current" comes from the last 7 days so the plan agrees with the
 * projection printed beside it; conversion rate is the one figure worth taking
 * from a longer window, since it is a property of their room rather than of
 * last week.
 */
function planFor(m, requiredPerDay, cfg) {
  const currentPerDay = m.dailyDiamonds7;
  const currentHoursPerDay = m.curr7.liveHours / 7;
  const daysPerWeek = Math.min(7, m.curr7.validLiveDays);
  const perHour = (m.historyDays >= 14 ? m.diamondsPerHour28 : null)
    ?? m.diamondsPerHour7 ?? m.diamondsPerHour28;
  const hoursPerSession = daysPerWeek > 0 ? m.curr7.liveHours / daysPerWeek : m.hoursPerActiveDay28;

  if (!perHour || perHour <= 0 || !hoursPerSession) {
    return { lever: 'activate', feasible: false, ask: 'Not enough LIVE history yet. The first job is a consistent schedule, not a target.' };
  }

  const requiredHoursPerDay = requiredPerDay / perHour;
  const gapPerDay = requiredPerDay - currentPerDay;
  if (gapPerDay <= 0) {
    return {
      lever: 'hold', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Already at the rate needed. Hold ${hoursPerSession.toFixed(1)}h a session, ${daysPerWeek.toFixed(1)} days a week, for the rest of the month.`,
    };
  }

  // Adding days is cheaper than lengthening sessions, which is cheaper than
  // changing how the room converts.
  const dayHeadroom = Math.max(0, cfg.sustainableDaysPerWeek - daysPerWeek);
  const gainFromDays = (dayHeadroom * hoursPerSession * perHour) / 7;
  if (gainFromDays >= gapPerDay) {
    const daysNeeded = Math.max(1, Math.ceil((gapPerDay * 7) / (hoursPerSession * perHour)));
    return {
      lever: 'days', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Add ${daysNeeded} LIVE day${daysNeeded > 1 ? 's' : ''} a week at their usual ${hoursPerSession.toFixed(1)}h. That alone covers the gap.`,
    };
  }
  if (requiredHoursPerDay <= cfg.maxHoursPerDay) {
    return {
      lever: 'hours', feasible: true, requiredHoursPerDay, currentHoursPerDay,
      ask: `Needs about ${requiredHoursPerDay.toFixed(1)}h LIVE a day (currently ${currentHoursPerDay.toFixed(1)}h) at their ${Math.round(perHour).toLocaleString('en-GB')} diamonds/hour. Build to ${cfg.sustainableDaysPerWeek} days a week first, then lengthen sessions.`,
    };
  }
  const rateNeeded = requiredPerDay / cfg.sustainableHoursPerDay;
  return {
    lever: 'rate', feasible: rateNeeded <= perHour * 3,
    requiredHoursPerDay, currentHoursPerDay,
    ask: `Hours alone will not get there this month: it would take ${requiredHoursPerDay.toFixed(1)}h a day. At a sustainable ${cfg.sustainableHoursPerDay}h they need ${Math.round(rateNeeded).toLocaleString('en-GB')} diamonds/hour against ${Math.round(perHour).toLocaleString('en-GB')} today. Work on gifting strategy, fan club and matches rather than more hours.`,
  };
}

/** Evaluate every creator inside their first 90 days against the monthly target. */
export function evaluateRamp(creators, metricsByKey, config) {
  const cfg = config.ramp;
  const rows = [];

  for (const c of creators) {
    if (c.quitOn || !c.joinDate) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    const day = m.daysSinceJoining;
    if (day == null || day > cfg.windowDays + 14) continue;

    const months = attemptMonths(c.joinDate, cfg.windowDays);
    const thisMonth = monthKey(m.endDate);
    const attempt = months.find((x) => x.key === thisMonth);

    // Every month they have already had a go at.
    const past = months.filter((x) => x.key < thisMonth).map((x) => ({
      ...x,
      diamonds: Math.round(m.monthlyDiamonds?.[x.key] ?? 0),
      // A month we barely watched cannot be called a miss.
      observed: (m.monthlyCoverage?.[x.key] ?? 0) >= x.available * 0.8,
    }));
    const best = past.reduce((a, b) => (b.diamonds > (a?.diamonds ?? -1) ? b : a), null);
    const achieved = past.find((x) => x.diamonds >= cfg.targetDiamonds) ?? null;

    const dayOfMonth = Number(m.endDate.slice(8, 10));
    const monthLength = daysInMonth(thisMonth);
    const daysLeftInMonth = attempt
      ? Math.max(0, Math.min(monthLength, dayOfMonth + (cfg.windowDays - day)) - dayOfMonth)
      : 0;
    const mtd = Math.round(m.monthOnMonth?.diamonds?.monthToDate ?? 0);
    const paceTarget = Math.round(cfg.targetDiamonds * (dayOfMonth / monthLength));
    const projected = dayOfMonth > 0 ? Math.round((mtd / dayOfMonth) * monthLength) : 0;
    const requiredPerDay = daysLeftInMonth > 0
      ? Math.max(0, Math.round((cfg.targetDiamonds - mtd) / daysLeftInMonth))
      : 0;
    const attemptsLeft = months.filter((x) => x.key > thisMonth && x.viable).length;

    let status;
    if (achieved || mtd >= cfg.targetDiamonds) status = STATUS.ACHIEVED;
    else if (day > cfg.windowDays) status = STATUS.MISSED;
    else if (projected >= cfg.targetDiamonds) status = STATUS.ON_TRACK;
    else if (mtd >= paceTarget * cfg.atRiskRatio) status = STATUS.AT_RISK;
    else status = STATUS.OFF_TRACK;

    const plan = planFor(m, requiredPerDay, cfg);
    const headroomHours = Math.max(0, cfg.sustainableHoursPerDay - (plan.currentHoursPerDay ?? 0));
    const potential = (m.diamondsPerHour28 ?? 0) * headroomHours * daysLeftInMonth;

    rows.push({
      creator: c, metrics: m, day,
      month: thisMonth,
      dayOfMonth, monthLength, daysLeftInMonth,
      daysLeftInWindow: Math.max(0, cfg.windowDays - day),
      attemptsLeft,
      monthToDate: mtd,
      paceTarget,
      projected,
      willHit: projected >= cfg.targetDiamonds,
      requiredPerDay,
      currentPerDay: Math.round(m.dailyDiamonds7),
      bestMonth: best ? { key: best.key, diamonds: best.diamonds, observed: best.observed } : null,
      achievedIn: achieved?.key ?? null,
      pastAttempts: past,
      status,
      plan,
      potential: Math.round(potential),
      diamondsPerHour: m.diamondsPerHour28 ? Math.round(m.diamondsPerHour28) : null,
    });
  }

  rows.sort((a, b) => b.potential - a.potential || b.monthToDate - a.monthToDate);
  return rows;
}

/**
 * The creators worth a coach's week: behind on this month's pace, but with the
 * conversion rate and the unused hours to still land it before the 1st.
 */
export function spotlight(rows, config) {
  const cfg = config.ramp;
  return rows
    .filter((r) => r.status !== STATUS.ACHIEVED && r.status !== STATUS.MISSED)
    .filter((r) => r.daysLeftInMonth >= cfg.minDaysLeftToPush && !r.willHit && r.plan.feasible)
    // Still actually streaming. A creator who has gone quiet scores highest on
    // raw headroom precisely because they are doing nothing, which would put
    // the most dormant creators at the top of a list meant for the most
    // promising ones. They need the decline path, not a growth target.
    .filter((r) => r.metrics.curr7.validLiveDays >= cfg.minRecentLiveDays && r.metrics.curr7.diamonds > 0)
    // And it has to be reachable: the ask must not exceed what the month allows.
    .filter((r) => r.monthToDate + r.potential >= cfg.targetDiamonds * cfg.reachableRatio)
    .slice(0, cfg.spotlightCount);
}

export { STATUS as RAMP_STATUS };
