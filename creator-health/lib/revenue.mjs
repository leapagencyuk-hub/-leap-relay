// A coach's rough monthly earnings, for the bottom of their daily summary.
//
// THIS IS AN ESTIMATE AND THE CARD SAYS SO IN AS MANY WORDS. The percentages
// behind the incremental share move during a month, and the exact figure is the
// directors' to give. What this is for is a coach being able to see, every
// morning, roughly what their work is worth and which lever moves it — not to
// settle anybody's pay.
//
// Three parts:
//
//   recruited     creators who joined this calendar month, credited to their
//                 Creator Network manager. A count, not money.
//
//   leaped        creators who passed 5 LIVE hours and 5,000 diamonds this
//                 month, at the fee in config.leaped. Comes straight from
//                 `leaped.mjs` so there is one definition of a leap and one
//                 set of records behind the pay, not two that can drift.
//
//   base          a fixed monthly wage every coach already has, shown so the
//                 estimate reflects what actually reaches them rather than
//                 only the part that moves.
//
//   incremental   a share of the creator's diamond value. LEAP's finance
//                 sheet works it as diamonds x $0.01 a diamond x a 1% share,
//                 which reproduces its own per-creator figures exactly — one
//                 row there reads 1,006,213 diamonds to £75.8758945, and this
//                 gives £75.8759. Hitting Backstage goals takes the share from
//                 10% to 20%, i.e. doubles it, which is why both lines show.
//
//   rank-up       10% of what TikTok pays the network for that creator ranking
//                 up. The finance sheet calls it "TIKTOK VALUE": diamonds x a
//                 bonus ratio x $0.01. The ratio is per creator per month and
//                 comes off Backstage — 0.065 in nearly every row of the sheet,
//                 so that is the default here, and it is an ESTIMATE.
//
// Only creators past a floor count towards the last two. The finance sheet
// lists nobody under 100,000 diamonds in a month, and applying the share to
// every creator on a roster overstates it badly.
//
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
  const base = cfg.baseWage ?? 0;
  const floor = cfg.incrementalFloorDiamonds ?? 100000;
  // Hitting Backstage goals takes the incremental share from 10% to 20%.
  const goalsMultiplier = cfg.goalsMultiplier ?? 2;
  const rankUpRatio = cfg.rankUpRatio ?? 0.065;
  const rankUpShare = cfg.rankUpShare ?? 0.10;
  const usdPerDiamondGross = cfg.usdPerDiamond ?? 0.01;
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
    const leapedPay = leapedCount * fee;
    const incremental = e.qualifyingDiamonds * perDiamond;
    // What TikTok pays the network for these creators ranking up, and the
    // coach's tenth of it.
    const rankUpValue = e.qualifyingDiamonds * rankUpRatio * usdPerDiamondGross * usdToGbp;
    const rankUp = rankUpValue * rankUpShare;
    const earned = leapedPay + incremental + rankUp;
    const total = base + earned;
    // With Backstage goals the incremental share doubles; nothing else moves.
    const withGoals = total + incremental * (goalsMultiplier - 1);
    return {
      ...e,
      teams: [...e.teams],
      diamonds: Math.round(e.diamonds),
      qualifyingDiamonds: Math.round(e.qualifyingDiamonds),
      leapedCount,
      leapedPay,
      incremental,
      incrementalWithGoals: incremental * goalsMultiplier,
      rankUpValue,
      rankUp,
      base,
      earned,
      total,
      withGoals,
    };
  }).sort((a, b) => b.total - a.total);

  return {
    month, asOf, currency, fee, perDiamond, usdPerDiamond, usdToGbp, base, floor,
    goalsMultiplier, rankUpRatio, rankUpShare,
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
