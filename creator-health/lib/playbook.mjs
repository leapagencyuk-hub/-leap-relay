// The area of concern, and how we will know whether it got better.
//
// Deliberately not a set of instructions. The coaches already know how to fix
// these things — what costs them time is working out which creator needs
// attention and which of the usual causes it is this time. So each entry names
// the area, sets a follow-up window, and defines what better looks like. The
// specific questions come from `causes.mjs`, which reads the data for the
// signature of each cause and ranks them.
//
// The windows differ per signal on purpose. Attendance can recover inside a
// week because it is a scheduling decision. Conversion cannot — it needs
// content changes that take a fortnight to show up in the numbers.

const HOURS_RECOVERY = 0.85;

/** Baseline captured when a case opens, so the test is against pre-slide levels. */
export function captureBaseline(metrics) {
  return {
    weeklyDiamonds: Math.round(metrics.profile.diamonds?.baseline ?? metrics.prev7.diamonds),
    weeklyHours: Number((metrics.profile.liveHours?.baseline ?? metrics.prev7.liveHours).toFixed(2)),
    weeklyLiveDays: Number((metrics.profile.validLiveDays?.baseline ?? metrics.prev7.validLiveDays).toFixed(2)),
    diamondsPerHour: metrics.diamondsPerHour28 ? Math.round(metrics.diamondsPerHour28) : null,
    activeFanClubFans: metrics.fanClub.activeFans,
    atOpen: {
      weeklyDiamonds: Math.round(metrics.curr7.diamonds),
      weeklyHours: Number(metrics.curr7.liveHours.toFixed(2)),
      weeklyLiveDays: Number(metrics.curr7.validLiveDays.toFixed(2)),
      darkStreak: metrics.darkStreak,
    },
  };
}

/**
 * Verdict helper: compare where they are now against where they were before the
 * slide, and against where they were when we opened the case.
 *
 * "Improved but not recovered" is a real and common outcome, and collapsing it
 * into a pass/fail would throw away the most useful thing the coach can learn.
 */
function grade(now, baseline, atOpen, threshold = HOURS_RECOVERY) {
  if (baseline <= 0) return now > 0 ? 'recovered' : 'no_change';
  const vsBaseline = now / baseline;
  if (vsBaseline >= threshold) return 'recovered';
  if (atOpen > 0 && now >= atOpen * 1.2) return 'improved';
  if (atOpen > 0 && now <= atOpen * 0.8) return 'worse';
  if (now <= atOpen) return 'no_change';
  return 'improved';
}

export const PLAYBOOK = {
  DARK: {
    id: 'DARK',
    title: 'Off air',
    followUpDays: 7,
    priority: 100,
    concern: 'They have stopped going live entirely. Everything else is secondary until you know why.',
    success: 'Back live on at least half their usual days within a week.',
    test: (m, c) => grade(m.curr7.validLiveDays, c.baseline.weeklyLiveDays * 0.5,
      c.baseline.atOpen.weeklyLiveDays, 1),
  },
  LIVE_DAYS_DOWN: {
    id: 'LIVE_DAYS_DOWN',
    title: 'Dropping LIVE days',
    followUpDays: 7,
    priority: 90,
    concern: 'They are turning up fewer days than they used to. Attendance goes before earnings do.',
    success: 'LIVE days back within one of their normal week.',
    test: (m, c) => grade(m.curr7.validLiveDays, c.baseline.weeklyLiveDays - 1,
      c.baseline.atOpen.weeklyLiveDays, 1),
  },
  HOURS_DOWN: {
    id: 'HOURS_DOWN',
    title: 'Shorter sessions',
    followUpDays: 10,
    priority: 70,
    concern: 'Sessions are getting shorter. Usually the first sign of something else.',
    success: 'Weekly LIVE hours back to 85% of normal.',
    test: (m, c) => grade(m.curr7.liveHours, c.baseline.weeklyHours, c.baseline.atOpen.weeklyHours),
  },
  SUSTAINED_HOURS_DOWN: {
    id: 'SUSTAINED_HOURS_DOWN',
    title: 'Sessions short for weeks',
    followUpDays: 10,
    priority: 75,
    concern: 'Short sessions have become their normal. This is now a habit, not a bad week.',
    success: 'Weekly LIVE hours back to 85% of their old normal.',
    test: (m, c) => grade(m.curr7.liveHours, c.baseline.weeklyHours, c.baseline.atOpen.weeklyHours),
  },
  EFFICIENCY_DOWN: {
    id: 'EFFICIENCY_DOWN',
    title: 'Room not converting',
    followUpDays: 14,
    priority: 60,
    concern: 'The hours are there and the money is not. Something in the room has changed.',
    success: 'Diamonds per LIVE hour back to 85% of normal.',
    test: (m, c) => grade(m.diamondsPerHour7 ?? 0, c.baseline.diamondsPerHour ?? 0,
      (c.baseline.atOpen.weeklyDiamonds || 0) / Math.max(0.5, c.baseline.atOpen.weeklyHours)),
  },
  FANCLUB_FANS_DOWN: {
    id: 'FANCLUB_FANS_DOWN',
    title: 'Fan club thinning',
    followUpDays: 14,
    priority: 50,
    concern: 'Their fan club is shrinking. Spending follows membership within a fortnight.',
    success: 'Active fan-club membership back to where it was when we flagged it.',
    test: (m, c) => grade(m.fanClub.activeFans ?? 0, c.baseline.activeFanClubFans ?? 0,
      c.baseline.activeFanClubFans ?? 0, 1),
  },
  FANCLUB_DIAMONDS_DOWN: {
    id: 'FANCLUB_DIAMONDS_DOWN',
    title: 'Fan club spending less',
    followUpDays: 14,
    priority: 55,
    concern: 'Their regulars are spending less. Worth knowing whether it is the same people or fewer of them.',
    success: 'Fan club diamonds back to 85% of normal.',
    test: (m, c) => grade(m.curr7.fanClubDiamonds, c.baseline.weeklyDiamonds * 0.8,
      c.baseline.atOpen.weeklyDiamonds * 0.8),
  },
  CONCENTRATION_RISK: {
    id: 'CONCENTRATION_RISK',
    title: 'Income resting on too few people',
    followUpDays: 21,
    priority: 40,
    concern: 'Almost all their income rests on a handful of people, and that group is shrinking.',
    success: 'Fan club share of diamonds falling while total diamonds hold.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  DIAMONDS_DOWN: {
    id: 'DIAMONDS_DOWN',
    title: 'Earnings down',
    followUpDays: 10,
    priority: 65,
    concern: 'Earnings are down with no single obvious cause in the numbers.',
    success: 'Weekly diamonds back to 85% of normal.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  SUSTAINED_DIAMONDS_DOWN: {
    id: 'SUSTAINED_DIAMONDS_DOWN',
    title: 'Earnings down for weeks',
    followUpDays: 14,
    priority: 80,
    concern: 'Earnings have been down for weeks. This is their new normal unless something changes.',
    success: 'Weekly diamonds back to 85% of their old normal.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  MONTH_DOWN: {
    id: 'MONTH_DOWN',
    title: 'Down on last month',
    followUpDays: 14,
    priority: 85,
    concern: 'They are well behind the pace they set last month. A whole month of ground is harder to make back than a bad week.',
    success: 'This month\'s pace back within 15% of last month\'s.',
    // Measured on the same footing the alert was raised on: two complete
    // months, prorated. A weekly test here would judge the creator on data the
    // alert never looked at.
    test: (m) => {
      const change = m.monthOnMonth?.diamonds?.change;
      if (change == null) return 'no_change';
      if (change >= -0.15) return 'recovered';
      if (change >= -0.3) return 'improved';
      if (change <= -0.7) return 'worse';
      return 'no_change';
    },
  },
  MONTH_HOURS_DOWN: {
    id: 'MONTH_HOURS_DOWN',
    title: 'Fewer hours than last month',
    followUpDays: 10,
    priority: 78,
    concern: 'They are putting in materially less time than they did last month, and earnings follow hours.',
    success: 'LIVE hours back within 15% of last month\'s pace.',
    test: (m) => {
      const change = m.monthOnMonth?.liveHours?.change;
      if (change == null) return 'no_change';
      if (change >= -0.15) return 'recovered';
      if (change >= -0.3) return 'improved';
      return 'no_change';
    },
  },
  OPPORTUNITY: {
    id: 'OPPORTUNITY',
    title: 'Inside 90 days, reachable',
    followUpDays: 14,
    priority: 30,
    concern: 'Inside their first 90 days and behind the 200k pace, but the numbers say they can still get there.',
    success: 'Daily run rate at or above what the target needs.',
    test: (m, c) => {
      const required = c.context?.requiredPerDay ?? 0;
      if (required <= 0) return 'recovered';
      return grade(m.dailyDiamonds7, required, c.context?.currentPerDayAtOpen ?? 0, 1);
    },
  },
};

/** The intervention for a case, chosen by the highest-priority signal present. */
export function playbookFor(signalCodes) {
  let best = null;
  for (const code of signalCodes) {
    const entry = PLAYBOOK[code];
    if (entry && (!best || entry.priority > best.priority)) best = entry;
  }
  return best ?? PLAYBOOK.DIAMONDS_DOWN;
}

export const VERDICT_LABEL = {
  recovered: 'Recovered',
  improved: 'Improving, not there yet',
  no_change: 'No change',
  worse: 'Worse',
  quit: 'Creator left the network',
};
