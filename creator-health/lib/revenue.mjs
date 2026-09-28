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
//   incremental   the coach's creators' diamonds this month times a rate.
//                 0.00005 USD per diamond, converted at the rate in config, so
//                 changing the exchange rate changes one number rather than
//                 two. 0.00005 x 0.75 is the 0.0000375 per diamond in GBP.
//
// Plus a further 10% available for hitting Backstage goals, shown as a ceiling
// rather than folded into the total, because it is not earned yet.
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
  const bonus = cfg.goalBonusPct ?? 0.10;
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
      recruited: 0, onboardedAllTime: 0, roster: 0, diamonds: 0, teams: new Set(),
    };
    // All-time includes creators who have since left: the coach still onboarded
    // them, and a number that shrinks when somebody quits reads as a penalty.
    e.onboardedAllTime++;
    if (!c.quitOn) e.roster++;
    if (c.joinDate?.slice(0, 7) === month) e.recruited++;
    e.diamonds += monthMtd(c, month)?.diamonds ?? 0;
    if (c.group) e.teams.add(c.group);
    byCoach.set(key, e);
  }

  const rows = [...byCoach.values()].map((e) => {
    const leapedCount = leapedByCoach.get(e.coach) ?? 0;
    const leapedPay = leapedCount * fee;
    const incremental = e.diamonds * perDiamond;
    const total = leapedPay + incremental;
    return {
      ...e,
      teams: [...e.teams],
      diamonds: Math.round(e.diamonds),
      leapedCount,
      leapedPay,
      incremental,
      total,
      // Not earned yet, so it is a ceiling and never the headline.
      withBonus: total * (1 + bonus),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    month, asOf, currency, fee, perDiamond, usdPerDiamond, usdToGbp, bonus,
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
