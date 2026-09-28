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
//                           the sheet has Sureshot on 350 and Malkin on 300.
//
//   new recruit bonus       10 for each recruit who qualifies. Read from the
//                           leaped records so there is one definition of a
//                           qualifying recruit, not two that can drift.
//
//   alpha group task bonus  VERIFIED against the WAGES CALCUATOR sheet:
//                           diamonds x $0.01 a diamond x a 1% share x FX, over
//                           creators past 100,000 diamonds in the month. That
//                           sheet's July totals appear unchanged as August's
//                           Alpha Group Task Bonus for all six coaches with
//                           data, and one row reads 1,006,213 diamonds to
//                           £75.8758945 where this gives £75.8759.
//
//   manager diamond %       0.00005 USD a diamond, across the coach's WHOLE
//                           roster rather than only the creators past the
//                           floor. This is the recruiter commission formula:
//                           at roughly $1 to £0.75 it is the 0.0000375 a
//                           diamond quoted in GBP.
//
// The two diamond shares are not the same thing and do not use the same
// population, which is the trap here: the alpha group task bonus is paid on
// creators past 100,000 in the month, and the manager share is paid across
// everybody. Working one out and calling it the other understates a coach's
// month by a third.
//
// Everybody is on the same 10% manager share, with a further 10% unlocked by
// hitting goals on Backstage — so that share doubles, and nothing else moves.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';
import { coachName, offTheBoards } from './coaches.mjs';

/**
 * Per-coach earnings for the month, keyed by the coach's address.
 *
 * `leaped` is the state from `leapedState`, passed in rather than recomputed:
 * the payroll records are the source of truth for what a leap is worth, and
 * working it out twice is how two numbers that should agree stop agreeing.
 */
export function coachRevenue({ creators, asOf, config, leaped = null }) {
  const cfg = config.revenue ?? {};
  const usdPerDiamond = cfg.incrementalPerDiamondUsd ?? 0.00005;
  const usdToGbp = cfg.usdToGbp ?? 0.75;
  // 0.00005 * 0.75 is 0.000037500000000000003 in binary floating point, and
  // that is not a number to print on a card about somebody's money.
  const perDiamond = Number((usdPerDiamond * usdToGbp).toPrecision(6));
  const fee = config.leaped?.fee ?? 10;
  const currency = config.leaped?.currency ?? 'GBP';
  const defaultBase = cfg.baseWage ?? 0;
  const perCoachBase = cfg.baseWageByCoach ?? {};
  const floor = cfg.alphaFloorDiamonds ?? 100000;
  // Rounded for the same reason as the rate above: 0.00005 * 0.75 is
  // 0.000037500000000000003 in binary floating point, and 0.0000375 is the
  // number the recruiters were actually given.
  const managerPerDiamond = Number(((cfg.managerPerDiamondUsd ?? 0.00005) * usdToGbp).toPrecision(6));
  // Everyone is on 10%; hitting Backstage goals unlocks a further 10%.
  const goalsMultiplier = cfg.goalsMultiplier ?? 2;
  const month = asOf.slice(0, 7);
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));

  const leapedByCoach = new Map();
  for (const r of leaped?.thisMonth ?? []) {
    leapedByCoach.set(r.coach, (leapedByCoach.get(r.coach) ?? 0) + 1);
  }

  const byCoach = new Map();
  for (const c of creators) {
    if (ignored.has(groupKey(c.group))) continue;
    const key = c.manager ?? 'unassigned';
    const e = byCoach.get(key) ?? {
      coach: key, name: coachName(key, config),
      recruited: 0, onboardedAllTime: 0, roster: 0, diamonds: 0,
      qualifying: 0, qualifyingDiamonds: 0, teams: new Set(),
    };
    // All-time includes creators who have since left: the coach still onboarded
    // them, and a number that shrinks when somebody quits reads as a penalty.
    e.onboardedAllTime++;
    if (!c.quitOn) e.roster++;
    if (c.joinDate?.slice(0, 7) === month) e.recruited++;
    const d = monthMtd(c, month)?.diamonds ?? 0;
    e.diamonds += d;
    // The share is only paid on creators past the floor, so it is counted
    // separately from the roster's total output.
    if (d >= floor) { e.qualifying++; e.qualifyingDiamonds += d; }
    if (c.group) e.teams.add(c.group);
    byCoach.set(key, e);
  }

  const rows = [...byCoach.values()].map((e) => {
    const leapedCount = leapedByCoach.get(e.coach) ?? 0;
    const recruitBonus = leapedCount * fee;
    const alphaBonus = e.qualifyingDiamonds * perDiamond;
    // Across the whole roster, not only the creators past the floor.
    const managerShare = e.diamonds * managerPerDiamond;
    // No default: a coach who is not on the sheet is not on a fixed amount, and
    // putting one on their card is worse than leaving the line off.
    const base = perCoachBase[e.coach] ?? defaultBase;
    // Goals unlock a further 10% on the manager share; the alpha bonus is fixed.
    const managerWithGoals = managerShare * goalsMultiplier;
    const total = base + recruitBonus + alphaBonus + managerShare;
    return {
      ...e,
      teams: [...e.teams],
      diamonds: Math.round(e.diamonds),
      qualifyingDiamonds: Math.round(e.qualifyingDiamonds),
      leapedCount,
      recruitBonus,
      alphaBonus,
      managerShare,
      managerWithGoals,
      base,
      total,
      // Not earned yet, so it is a second line and never the figure.
      totalWithGoals: total + (managerWithGoals - managerShare),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    month, asOf, currency, fee, perDiamond, managerPerDiamond, usdToGbp, floor, goalsMultiplier,
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
