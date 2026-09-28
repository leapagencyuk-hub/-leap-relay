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
//   new recruit bonus       10 for each recruit who qualifies. Read from the
//                           leaped records so there is one definition of a
//                           qualifying recruit, not two that can drift.
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
//   manager diamond %       0.00005 USD a diamond, applied here across the
//                           coach's WHOLE roster. This is the recruiter
//                           commission formula: at roughly $1 to £0.75 it is
//                           the 0.0000375 a diamond quoted in GBP.
//
//                           UNVERIFIABLE, unlike rank ups, and not for want of
//                           trying. Each figure in Recruitment 26/27's MANAGER
//                           DIAMOND % row appears exactly once in the whole
//                           workbook, so they are typed in from Backstage
//                           rather than computed from anything we hold.
//
//                           Against August, the whole roster comes out 13% to
//                           34% above what the sheet paid five of six coaches,
//                           and within 3% for the sixth. Restricting it to the
//                           creators who ranked up fits worse. Since the true
//                           figures are hand-entered, no population will
//                           reconcile exactly, so this stays the formula LEAP
//                           gave us applied to the obvious population, on a
//                           card whose first line calls it a rough estimate.
//
// The two diamond shares are not the same thing and do not use the same
// population, which is the trap here: rank ups are paid on the creators who
// ranked up, and the manager share across everybody. Working one out and
// calling it the other misses a coach's month badly in both directions.
//
// Everybody is on the same 10% manager share, with a further 10% unlocked by
// hitting goals on Backstage — so that share doubles, and nothing else moves.
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
  // Rounded for the same reason as the rate above.
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
      rankUps: 0, rankUpDiamonds: 0, closeToRankUp: 0, rankUpUpside: 0,
      teams: new Set(),
    };
    // All-time includes creators who have since left: the coach still onboarded
    // them, and a number that shrinks when somebody quits reads as a penalty.
    e.onboardedAllTime++;
    if (!c.quitOn) e.roster++;
    if (c.joinDate?.slice(0, 7) === month) e.recruited++;
    const d = monthMtd(c, month)?.diamonds ?? 0;
    e.diamonds += d;
    // Rank ups are paid on creators whose TIER went up against last month, not
    // on creators past some diamond floor. See lib/tiers.mjs: the floor this
    // replaces paid on two and a half times as many creators as LEAP's own
    // sheet does.
    const up = c.quitOn ? null : rankUpFor(c, asOf, config);
    if (up?.rankedUp) { e.rankUps++; e.rankUpDiamonds += d; }
    else if (up?.reachable && up.target != null && up.daysLeft > 0) {
      e.closeToRankUp++;
      e.rankUpUpside += up.worthIfCrossed;
    }
    if (c.group) e.teams.add(c.group);
    byCoach.set(key, e);
  }

  const rows = [...byCoach.values()].map((e) => {
    const leapedCount = leapedByCoach.get(e.coach) ?? 0;
    const recruitBonus = leapedCount * fee;
    const rankUpBonus = e.rankUpDiamonds * rankUpPerDiamond;
    // Across the whole roster, not only the creators past the floor.
    const managerShare = e.diamonds * managerPerDiamond;
    // No default: a coach who is not on the sheet is not on a fixed amount, and
    // putting one on their card is worse than leaving the line off.
    const base = perCoachBase[e.coach] ?? defaultBase;
    // Goals unlock a further 10% on the manager share; rank ups do not move.
    const managerWithGoals = managerShare * goalsMultiplier;
    const total = base + recruitBonus + rankUpBonus + managerShare;
    return {
      ...e,
      teams: [...e.teams],
      diamonds: Math.round(e.diamonds),
      rankUpDiamonds: Math.round(e.rankUpDiamonds),
      rankUpUpside: e.rankUpUpside,
      leapedCount,
      recruitBonus,
      rankUpBonus,
      managerShare,
      managerWithGoals,
      base,
      total,
      // Not earned yet, so it is a second line and never the figure.
      totalWithGoals: total + (managerWithGoals - managerShare),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    month, asOf, currency, fee, rankUpPerDiamond, managerPerDiamond, usdToGbp, goalsMultiplier,
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
