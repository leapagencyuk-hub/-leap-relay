// What to actually do about each kind of slide, and how we will know whether it
// worked.
//
// Every entry pairs an intervention with a measurable success test and a
// follow-up window. That pairing is the whole point: an alert that only says
// "this creator is down" produces a conversation, while an alert that says
// "do this, we will check in 7 days, and here is what better looks like"
// produces a result you can count.
//
// The windows are deliberately different per signal. Attendance can recover
// inside a week because it is a scheduling decision. Conversion cannot — it
// needs content changes that take a fortnight to show up in the numbers.

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
    ask: 'Phone call today, not a message. Find out what changed, then agree a fixed schedule for the next 7 days and put it in writing.',
    watchFor: 'A named reason. "Busy" is not a reason — illness, a second job, a family situation and burnout all need different help.',
    success: 'Back live on at least half their usual days within a week.',
    test: (m, c) => grade(m.curr7.validLiveDays, c.baseline.weeklyLiveDays * 0.5,
      c.baseline.atOpen.weeklyLiveDays, 1),
  },
  LIVE_DAYS_DOWN: {
    id: 'LIVE_DAYS_DOWN',
    title: 'Dropping LIVE days',
    followUpDays: 7,
    priority: 90,
    ask: 'Ask what is blocking the missing days before talking about content. Rebuild the schedule around the days they can actually commit to, even if that is fewer days than before.',
    watchFor: 'A schedule that stopped fitting their life. A creator keeping three reliable days beats one failing at six.',
    success: 'LIVE days back within one of their normal week.',
    test: (m, c) => grade(m.curr7.validLiveDays, c.baseline.weeklyLiveDays - 1,
      c.baseline.atOpen.weeklyLiveDays, 1),
  },
  HOURS_DOWN: {
    id: 'HOURS_DOWN',
    title: 'Shorter sessions',
    followUpDays: 10,
    priority: 70,
    ask: 'Sessions shortening is usually burnout, a schedule clash, or a room that has gone quiet. Find out which, then rebuild session length before adding any days.',
    watchFor: 'If they are ending early because the room is dead, this is really a conversion problem — treat it as one.',
    success: 'Weekly LIVE hours back to 85% of normal.',
    test: (m, c) => grade(m.curr7.liveHours, c.baseline.weeklyHours, c.baseline.atOpen.weeklyHours),
  },
  SUSTAINED_HOURS_DOWN: {
    id: 'SUSTAINED_HOURS_DOWN',
    title: 'Sessions short for weeks',
    followUpDays: 10,
    priority: 75,
    ask: 'This has been running for weeks, so the new pattern is now their habit. Rebuilding it needs a specific commitment for specific days, not general encouragement.',
    watchFor: 'Treat this as a reset rather than a recovery — agree the schedule you want from here, not the one they used to do.',
    success: 'Weekly LIVE hours back to 85% of their old normal.',
    test: (m, c) => grade(m.curr7.liveHours, c.baseline.weeklyHours, c.baseline.atOpen.weeklyHours),
  },
  EFFICIENCY_DOWN: {
    id: 'EFFICIENCY_DOWN',
    title: 'Room not converting',
    followUpDays: 14,
    priority: 60,
    ask: 'The hours are there and the diamonds are not. Watch a recent LIVE together and check the basics: goals on screen, gift callouts by name, whether the format changed, and whether they are streaming at their usual time.',
    watchFor: 'A format or time-slot change they made themselves is the most common cause and the easiest to reverse.',
    success: 'Diamonds per LIVE hour back to 85% of normal.',
    test: (m, c) => grade(m.diamondsPerHour7 ?? 0, c.baseline.diamondsPerHour ?? 0,
      (c.baseline.atOpen.weeklyDiamonds || 0) / Math.max(0.5, c.baseline.atOpen.weeklyHours)),
  },
  FANCLUB_FANS_DOWN: {
    id: 'FANCLUB_FANS_DOWN',
    title: 'Fan club thinning',
    followUpDays: 14,
    priority: 50,
    ask: 'Get a members-only segment running this week, and have them personally message the top members who have gone quiet. Fan club decay shows up in spending a fortnight later, so this is the window to act.',
    watchFor: 'Ask whether a specific big supporter has gone. Losing one whale reads the same in the data as losing interest, and needs a completely different response.',
    success: 'Active fan-club membership back to where it was when we flagged it.',
    test: (m, c) => grade(m.fanClub.activeFans ?? 0, c.baseline.activeFanClubFans ?? 0,
      c.baseline.activeFanClubFans ?? 0, 1),
  },
  FANCLUB_DIAMONDS_DOWN: {
    id: 'FANCLUB_DIAMONDS_DOWN',
    title: 'Fan club spending less',
    followUpDays: 14,
    priority: 55,
    ask: 'Their regulars are spending less. Have them run a members-only segment and thank the top supporters by name on stream this week.',
    watchFor: 'Check whether the drop is spread across members or one person stopping. The data cannot tell you; the creator can.',
    success: 'Fan club diamonds back to 85% of normal.',
    test: (m, c) => grade(m.curr7.fanClubDiamonds, c.baseline.weeklyDiamonds * 0.8,
      c.baseline.atOpen.weeklyDiamonds * 0.8),
  },
  CONCENTRATION_RISK: {
    id: 'CONCENTRATION_RISK',
    title: 'Income resting on too few people',
    followUpDays: 21,
    priority: 40,
    ask: 'Almost all of their income comes from a handful of people, and that group is shrinking. The work here is widening the base: new-viewer hooks, a lower entry gift tier, and matches to reach new rooms.',
    watchFor: 'This is not urgent this week but it is how a top creator collapses in a month. Book it in rather than firefighting it later.',
    success: 'Fan club share of diamonds falling while total diamonds hold.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  DIAMONDS_DOWN: {
    id: 'DIAMONDS_DOWN',
    title: 'Earnings down',
    followUpDays: 10,
    priority: 65,
    ask: 'Diamonds are down with no single obvious cause in the numbers. A check-in call is the fastest way to find out what the data cannot see.',
    watchFor: 'Ask about anything that changed off-platform: their mood, their schedule, another network approaching them.',
    success: 'Weekly diamonds back to 85% of normal.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  SUSTAINED_DIAMONDS_DOWN: {
    id: 'SUSTAINED_DIAMONDS_DOWN',
    title: 'Earnings down for weeks',
    followUpDays: 14,
    priority: 80,
    ask: 'This has been running for weeks and has become their new normal. Treat it as a rebuild: agree one specific change, and review it together in a fortnight.',
    watchFor: 'If several weeks of coaching have not moved it, the honest question is whether the format itself has stopped working.',
    success: 'Weekly diamonds back to 85% of their old normal.',
    test: (m, c) => grade(m.curr7.diamonds, c.baseline.weeklyDiamonds, c.baseline.atOpen.weeklyDiamonds),
  },
  OPPORTUNITY: {
    id: 'OPPORTUNITY',
    title: 'Inside 90 days, reachable',
    followUpDays: 14,
    priority: 30,
    ask: 'Agree the specific lever with them and put a number on it. A creator who knows they need two more LIVE days a week will do it; one told to "push harder" will not.',
    watchFor: 'Check the ask is actually sustainable. Burning them out at day 50 loses the target and the creator.',
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
