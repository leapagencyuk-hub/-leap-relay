// Creators who never started.
//
// The decline rules deliberately ignore these: a creator with no pattern cannot
// deviate from one, so alerting on them would bury the real signal. The effect
// is that a third of the network is invisible to the tool — including, on
// LEAP's own data, 176 creators signed in the last 90 days who have never
// earned a diamond.
//
// That is not a coaching problem and it is not a decline. It is onboarding, and
// it is worth more than the decline caseload: a saved creator returns to their
// old level, an activated one is income that did not exist.

const STAGE = {
  SETTLING: 'SETTLING',     // too early to chase
  NO_START: 'NO_START',     // signed, never went live
  STALLED: 'STALLED',       // went live, earned nothing
  DECIDE: 'DECIDE',         // long enough that it needs a decision
  DORMANT: 'DORMANT',       // established creator who has gone quiet entirely
};

// Each stage leads with one thing to do. Four questions and no instruction
// reads as homework; one action and three prompts reads as a job.
export const ACTIVATION_PLAYBOOK = {
  [STAGE.NO_START]: {
    title: 'Signed but never went live',
    concern: 'Every day here makes the first stream harder.',
    first: 'Call them and put a date and a time for their first stream in the diary before you hang up.',
    ask: [
      'Do they know how to go live, and what the requirements are?',
      'Anything practical in the way — phone, wifi, a private space?',
      'Are they nervous? Most are, and nobody tells them that.',
    ],
    check: 'Has anyone actually spoken to them since they signed?',
    success: 'One valid LIVE day.',
  },
  [STAGE.STALLED]: {
    title: 'Streaming but earning nothing',
    concern: 'This is the point most people quit.',
    first: 'Watch ten minutes of a recent stream before you call, then ask how many people are actually in the room.',
    ask: [
      'Zero viewers or zero gifters? Different problems.',
      'Do they tell anyone they are going live?',
      'Do they ever ask, by name? Many never make a single callout.',
    ],
    check: 'What time they stream, and whether anyone else is live then to match with',
    success: 'Any meaningful earnings within a week.',
  },
  [STAGE.DECIDE]: {
    title: 'Needs a decision',
    concern: 'Weeks in with nothing to show. Either something changes now or the slot is better used.',
    first: 'Ask plainly whether they still want this. It is kinder than chasing quietly for another month.',
    ask: [
      'If yes: what is the one thing stopping them, and can we fix it this week?',
      'If no: close it off so the roster reflects reality.',
      'Either way, agree it today rather than leaving it open.',
    ],
    check: 'Everything tried so far, so this is not the same conversation again',
    success: 'Either activity, or an honest close.',
  },
  [STAGE.DORMANT]: {
    title: 'Established creator gone quiet',
    concern: 'They used to earn and now earn nothing. This is a full stop, not a slide.',
    first: 'Find out whether they are still with us at all. Often they left and nobody updated the roster.',
    ask: [
      'What changed? A full stop usually has one cause and they will tell you it.',
      'Is there a route back, or should we close this properly?',
      'If there is: what would week one look like?',
    ],
    check: 'Their best month, so the conversation starts from what they can do',
    success: 'Back to any regular streaming.',
  },
};

/**
 * Stage every creator who is not earning.
 *
 * Ordered so the winnable ones surface first: a creator two weeks in is far
 * more likely to start than one who has been dormant for months, and a coach's
 * attention should go where it converts.
 */
export function evaluateActivation(creators, metricsByKey, config) {
  const cfg = config.activation;
  if (!cfg?.enabled) return [];
  const rows = [];

  for (const c of creators) {
    if (c.quitOn) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;

    const day = m.daysSinceJoining;
    const thisMonth = m.monthOnMonth?.diamonds?.monthToDate ?? 0;
    const lastMonth = m.monthOnMonth?.diamonds?.lastMonthTotal ?? 0;
    if (thisMonth > cfg.minDiamonds) continue;

    const everLive = m.curr28.validLiveDays > 0 || m.monthOnMonth?.validLiveDays?.lastMonthTotal > 0;
    const isNew = day != null && day <= cfg.newWindowDays;

    let stage = null;
    if (isNew) {
      if (day < cfg.stages.noStart) stage = STAGE.SETTLING;
      else if (!everLive) stage = day >= cfg.stages.decide ? STAGE.DECIDE : STAGE.NO_START;
      else stage = day >= cfg.stages.decide ? STAGE.DECIDE : STAGE.STALLED;
    } else if (lastMonth > cfg.dormantWasEarning) {
      // Earned real money last month, nothing this month: a full stop, not a slide.
      stage = STAGE.DORMANT;
    } else if (!everLive) {
      stage = STAGE.DORMANT;
    }
    if (!stage || stage === STAGE.SETTLING) continue;

    rows.push({
      creator: c,
      metrics: m,
      stage,
      day,
      everLive,
      thisMonth: Math.round(thisMonth),
      lastMonth: Math.round(lastMonth),
      bestMonth: Math.round(Math.max(0, ...Object.values(m.monthlyDiamonds ?? {}))),
      daysDark: m.darkStreak,
      // Newest first among the new, then established creators by what they used
      // to be worth. Attention should go where it is most likely to convert.
      priority: stage === STAGE.DORMANT
        ? Math.min(500, lastMonth / 1000)
        : 1000 - (day ?? 0),
    });
  }

  rows.sort((a, b) => b.priority - a.priority);
  return rows;
}

export { STAGE as ACTIVATION_STAGE };
