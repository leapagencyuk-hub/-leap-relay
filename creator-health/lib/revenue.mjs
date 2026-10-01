// A coach's rough monthly earnings, for the bottom of their daily summary.
//
// THIS IS AN ESTIMATE AND THE CARD SAYS SO IN AS MANY WORDS. What this is for
// is a coach seeing every morning roughly what their month is worth and which
// lever moves it — not settling anybody's pay.
//
// The components and their names come from LEAP's own Recruitment 26/27 sheet.
// Payments are made on the 15th of the FOLLOWING month, so what this shows is
// the month being built, not the money about to land.
//
//   extra revenue           a fixed monthly amount, per coach. Most are on 150;
//                           the sheet has Sureshot on 350 and CamB on 100.
//
//   new recruit bonus       10 for each creator who leaps. Read from the leaped
//                           records so there is one definition of a qualifying
//                           recruit, not two that can drift.
//
//                           EXCEPT where config.leaped.monthOverride names the
//                           month. A leap is a LIFETIME 5 hours and 5,000
//                           diamonds, and this system started watching on 31
//                           August, so for a month before it had a full history
//                           it cannot tell who crossed the bar THAT month from
//                           who had crossed it long ago. It credited 73 leaps
//                           to September where LEAP's own sheet says 40. The
//                           sheet wins, per coach. From October on there is
//                           enough history to compute it.
//
//   rank ups                Paid on creators whose TIER went up against last
//                           month. A flat 1% of the diamond dollar value,
//                           diamonds x $0.01 x 1%, on their whole month.
//                           The tier table, the verification and the reason
//                           this is NOT a "past 100,000 diamonds" floor are
//                           all in lib/tiers.mjs. Short version: the floor
//                           paid on 66 creators in August where LEAP's own
//                           sheet pays on 26.
//
//   incremental share       What Recruitment 26/27 calls MANAGER DIAMOND %:
//
//                             roster diamonds
//                               x $0.01
//                               x TikTok's incremental rate
//                               x the coach's unlock
//                               x FX
//
//                           Solved from LEAP's own sheet rather than assumed,
//                           and exact to the penny for all ten coaches in
//                           September. The rate the sheet implies is 8.00% for
//                           every one of them.
//
//                           THE UNLOCK is the part that was missing. Every
//                           coach starts on 10%. Backstage sets two monthly
//                           goals per group — a diamond target for the whole
//                           group and a recruiter target — and each one hit
//                           adds 5%. So 10, 15 or 20, decided by the month's
//                           own results rather than by anybody's status.
//
//                           THE RATE MOVES, and the cards do not follow it.
//                           TikTok paid 8% in September on 29.0m diamonds and
//                           about 4% in August on 25.3m. LEAP's instruction is
//                           that a card always quotes 5%, so a coach is never
//                           shown a number that a quieter month cannot pay.
//                           `incremental.actualRate` carries the real monthly
//                           figure for reconciling against the sheet, and no
//                           card reads it.
//
// The two diamond lines are not the same thing and do not use the same
// population, which is the trap here: rank ups are paid on the creators who
// ranked up, and the incremental share across everybody. Working one out and
// calling it the other misses a coach's month badly in both directions.
//
// The two goals are also the only forward-looking thing on a coach's card: a
// card that says "you are 4.8m of 8.4m toward another 5%" is worth more to
// somebody on the 3rd than any amount of what they have already earned.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';
import { coachName, offTheBoards } from './coaches.mjs';
import { rankUpFor } from './tiers.mjs';

/**
 * Per-coach earnings for the month, keyed by the coach's address.
 *
 * `leaped` is the state from `leapedState`, passed in rather than recomputed:
 * the payroll records are the source of truth for what a leap is worth, and
 * working it out twice is how two numbers that should agree stop agreeing.
 */
export function coachRevenue({ creators, asOf, config, leaped = null }) {
  const cfg = config.revenue ?? {};
  // The WAGES CALCUATOR tab's own rate: $0.01 a diamond at a 1% share. The two
  // diamond rates differ by a factor of two, so a wrong fallback here halves a
  // coach's rank-up line silently rather than failing.
  const rankUpUsdPerDiamond = cfg.rankUpPerDiamondUsd ?? 0.0001;
  const usdToGbp = cfg.usdToGbp ?? 0.754073884;
  // Rounded because these products land on things like 0.0000377036942 in
  // binary floating point, and that is not a number to carry through a
  // calculation about somebody's money.
  const rankUpPerDiamond = Number((rankUpUsdPerDiamond * usdToGbp).toPrecision(6));
  const fee = config.leaped?.fee ?? 10;
  const currency = config.leaped?.currency ?? 'GBP';
  const defaultBase = cfg.baseWage ?? 0;
  const perCoachBase = cfg.baseWageByCoach ?? {};
  // The manager diamond share. See the header: this is the sheet's own
  // arithmetic, not an approximation of it.
  const inc = cfg.incremental ?? {};
  const boardRate = inc.boardRate ?? 0.05;
  const baseUnlock = inc.baseUnlock ?? 0.10;
  const goalBonus = inc.goalBonus ?? 0.05;
  const month = asOf.slice(0, 7);
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));

  const goals = cfg.goals?.[month] ?? {};

  const leapedByCoach = new Map();
  for (const r of leaped?.thisMonth ?? []) {
    leapedByCoach.set(r.coach, (leapedByCoach.get(r.coach) ?? 0) + 1);
  }
  // A month LEAP worked out by hand, because we could not. Amounts, not
  // counts, so what lands on the card is exactly what the sheet says.
  const override = config.leaped?.monthOverride?.[month] ?? null;

  const byCoach = new Map();
  for (const c of creators) {
    if (ignored.has(groupKey(c.group))) continue;
    const key = c.manager ?? 'unassigned';
    const e = byCoach.get(key) ?? {
      coach: key, name: coachName(key, config),
      recruited: 0, onboardedAllTime: 0, roster: 0, diamonds: 0,
      rankUps: 0, rankUpDiamonds: 0, closeToRankUp: 0, rankUpUpside: 0,
      tikTokBonusUsd: 0,
      teams: new Set(),
    };
    // All-time includes creators who have since left: the coach still onboarded
    // them, and a number that shrinks when somebody quits reads as a penalty.
    e.onboardedAllTime++;
    if (!c.quitOn) e.roster++;
    if (c.joinDate?.slice(0, 7) === month) e.recruited++;
    const d = monthMtd(c, asOf)?.diamonds ?? 0;
    e.diamonds += d;
    // Rank ups are paid on creators whose TIER went up against last month, not
    // on creators past some diamond floor. See lib/tiers.mjs: the floor this
    // replaces paid on two and a half times as many creators as LEAP's own
    // sheet does.
    const up = c.quitOn ? null : rankUpFor(c, asOf, config);
    if (up?.rankedUp) {
      e.rankUps++;
      e.rankUpDiamonds += d;
      // What TikTok pays LEAP for this creator, which is not what LEAP pays
      // the coach. Carried so a month can be reconciled against Backstage's
      // "Estimated bonus contribution" in one glance instead of by argument:
      // diamonds x $0.01 x the creator's tier ratio, which is Backstage's own
      // arithmetic to the cent.
      e.tikTokBonusUsd += d * 0.01 * (up.ratio ?? 0);
    }
    else if (up?.reachable && up.target != null && up.daysLeft > 0) {
      e.closeToRankUp++;
      e.rankUpUpside += up.worthIfCrossed;
    }
    if (c.group) e.teams.add(c.group);
    byCoach.set(key, e);
  }

  const rows = [...byCoach.values()].map((e) => {
    const computedCount = leapedByCoach.get(e.coach) ?? 0;
    const overridden = override ? (override[e.coach] ?? 0) : null;
    const recruitBonus = overridden == null ? computedCount * fee : overridden;
    // The count shown has to match the money shown, or the card contradicts
    // itself in the same line.
    const leapedCount = overridden == null ? computedCount : Math.round(overridden / fee);
    const rankUpBonus = e.rankUpDiamonds * rankUpPerDiamond;

    // The month's two goals, and how far this coach is through them. A goal of
    // zero counts as met — Backstage sets that for somebody with no target, and
    // treating it as unreachable would quietly dock them 5%.
    const goal = goals[e.coach] ?? null;
    const diamondsHit = goal ? e.diamonds >= goal.diamonds : false;
    const recruitsHit = goal ? e.recruited >= goal.recruits : false;
    // Rounded, because 0.10 + 0.05 is 0.15000000000000002 in binary floating
    // point and that is not a percentage to print on somebody's wage card.
    const unlock = Number((baseUnlock
      + (diamondsHit ? goalBonus : 0)
      + (recruitsHit ? goalBonus : 0)).toPrecision(6));

    // Across the whole roster, not only the creators who ranked up. At the
    // board rate, never the live one.
    const incrementalShare = e.diamonds * 0.01 * boardRate * unlock * usdToGbp;
    // No default: a coach who is not on the sheet is not on a fixed amount, and
    // putting one on their card is worse than leaving the line off.
    const base = perCoachBase[e.coach] ?? defaultBase;
    // What the share would be with both goals met, so a card can show what is
    // still on the table rather than only what is banked.
    const fullUnlock = Number((baseUnlock + goalBonus * 2).toPrecision(6));
    const incrementalWithGoals = e.diamonds * 0.01 * boardRate * fullUnlock * usdToGbp;
    const total = base + recruitBonus + rankUpBonus + incrementalShare;
    return {
      ...e,
      teams: [...e.teams],
      diamonds: Math.round(e.diamonds),
      rankUpDiamonds: Math.round(e.rankUpDiamonds),
      rankUpUpside: e.rankUpUpside,
      tikTokBonusUsd: e.tikTokBonusUsd,
      leapedCount,
      recruitBonus,
      rankUpBonus,
      unlock,
      // Null where Backstage has set no goals for this coach this month, which
      // is different from a goal of zero and must not read as "missed".
      goals: goal ? {
        diamonds: goal.diamonds,
        recruits: goal.recruits,
        diamondsHit,
        recruitsHit,
        diamondsToGo: Math.max(0, goal.diamonds - e.diamonds),
        recruitsToGo: Math.max(0, goal.recruits - e.recruited),
      } : null,
      incrementalShare,
      incrementalWithGoals,
      base,
      total,
      // Not earned yet, so it is a second line and never the figure.
      totalWithGoals: total + (incrementalWithGoals - incrementalShare),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    month, asOf, currency, fee, rankUpPerDiamond,
    boardRate, baseUnlock, goalBonus, usdToGbp,
    actualRate: inc.actualRate?.[month] ?? null,
    rows,
    byCoach: new Map(rows.map((r) => [r.coach, r])),
    // The recruitment standing, which is the "all staff" board on the card. It
    // is a leaderboard, so it honours the same exclusions the other boards do —
    // a coach's own revenue block still shows, because pay is not a contest.
    recruitBoard: [...rows]
      .filter((r) => r.recruited > 0 && !offTheBoards(r.coach, config))
      .sort((a, b) => b.recruited - a.recruited || a.name.localeCompare(b.name)),
    networkTotal: rows.reduce((n, r) => n + r.total, 0),
  };
}
