// The two network-level numbers TikTok judges LEAP on, computed the way the
// 2026 Creator Network Policies & Rules deck defines them.
//
// These are not creator metrics. They decide the network's own benefits tier,
// and a coach cannot move them directly — but every creator card in this system
// adds up to them, so they belong on the management overview.
//
//
// NEW CREATOR GRADUATION RATE
//
//   Numerator   creators who joined in the last 3 calendar months AND reached
//               the graduation threshold in the current calendar month
//   Denominator creators who joined in the last 3 calendar months AND reached
//               the 0.5% threshold in the current calendar month
//
// Both changed for 2026: the window moved from "90 days" to "the last 3
// calendar months", and rookie status was dropped. The 0.5% threshold is the
// part that decides who is even counted — the deck's example is a region with
// an 80,000 benchmark, giving 80,000 x 0.5% = 400. At LEAP's 200,000 benchmark
// it is 1,000, and measuring it that way reproduces Backstage's own "evaluated"
// count where a plain 90-day cohort was three times too big.
//
// A creator who quits stays in both halves. The deck is explicit about why:
// "to prevent Creator Networks from artificially inflating the graduation rate
// by mass [removal]". So this deliberately ignores `quitOn`, which every other
// module in this system respects.
//
// The tier that rate lands in sets the network's benefits:
//
//   High   more premium invitation quotas, extra priority support
//   Mid    standard premium invitation quotas, standard support
//   Low    NO premium invitations, -1% bonus ratio this month,
//          limited regular invitations next month
//
//
// MATURE CREATOR RANK-UP AND MAINTENANCE RATE
//
//   Denominator creators in the network last month whose Diamonds last month
//               were above the graduation threshold
//   Numerator   of those, the ones who ranked up or held their tier this month
//
// Two thresholds hang off it, and they are different numbers for different
// rewards: >=30% earns +1% on the rank-up bonus ratio, and >=50% is a condition
// of the premium invitation reward on Backstage.
//
//
// The graduation threshold is REGIONAL. 200,000 is LEAP's; the deck's worked
// example uses 80,000. It lives in config so another region is a config change.
//
// Note that `monitoring.ignoreGroups` is NOT applied here, unlike everywhere
// else. That list is our own decision about which teams a coach works; TikTok
// counts every creator in the network regardless, so excluding them would give
// us a number that disagrees with the one our benefits are set from.
import { groupKey } from './notify.mjs';

/** The last observation inside a calendar month, as the export reported it. */
export function monthMtd(creator, month) {
  const obs = creator?.obs;
  if (!obs?.length) return null;
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].date.slice(0, 7) === month) return obs[i].mtd ?? null;
  }
  return null;
}

export const previousMonth = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** First day of the calendar month `n - 1` months before the one `asOf` is in. */
export function cohortStart(asOf, months = 3) {
  let key = asOf.slice(0, 7);
  for (let i = 1; i < months; i++) key = previousMonth(key);
  return `${key}-01`;
}

/** Which of the deck's Diamond tiers a month's total falls in. */
export function tierOf(diamonds, bands) {
  return bands.filter((b) => diamonds >= b).length + 1;
}

/**
 * The rate that sets the network's benefits tier.
 *
 * `quitOn` is deliberately not filtered. See the header.
 */
export function graduationRate({ creators, asOf, config }) {
  const threshold = config.ramp?.targetDiamonds ?? 200000;
  const floor = threshold * (config.policy?.graduationFloorRatio ?? 0.005);
  const month = asOf.slice(0, 7);
  const since = cohortStart(asOf, config.policy?.cohortMonths ?? 3);

  const cohort = creators.filter((c) => c.joinDate && c.joinDate >= since);
  const denominator = cohort.filter((c) => (monthMtd(c, month)?.diamonds ?? 0) >= floor);
  const numerator = denominator.filter((c) => (monthMtd(c, month)?.diamonds ?? 0) >= threshold);

  return {
    month, since, threshold, floor,
    joined: cohort.length,
    denominator: denominator.length,
    numerator: numerator.length,
    rate: denominator.length ? numerator.length / denominator.length : null,
    graduated: numerator.map((c) => ({
      username: c.username, group: c.group, coach: c.manager,
      diamonds: Math.round(monthMtd(c, month).diamonds),
    })),
    // Named because they are the only creators who can still change this month's
    // rate, and there are never many of them.
    closest: denominator
      .filter((c) => (monthMtd(c, month)?.diamonds ?? 0) < threshold)
      .map((c) => ({
        username: c.username, group: c.group, coach: c.manager,
        diamonds: Math.round(monthMtd(c, month).diamonds),
        remaining: Math.round(threshold - monthMtd(c, month).diamonds),
      }))
      .sort((a, b) => a.remaining - b.remaining),
  };
}

/** Mature creators who held or raised their tier. Two thresholds hang off it. */
export function matureRankUpRate({ creators, asOf, config }) {
  const threshold = config.ramp?.targetDiamonds ?? 200000;
  const bands = config.policy?.tierBands ?? [40000, 80000, 150000, 250000];
  const month = asOf.slice(0, 7);
  const prev = previousMonth(month);

  const denominator = creators.filter((c) => (monthMtd(c, prev)?.diamonds ?? 0) >= threshold);
  const rows = denominator.map((c) => {
    const was = monthMtd(c, prev).diamonds;
    const now = monthMtd(c, month)?.diamonds ?? 0;
    const wasTier = tierOf(was, bands);
    const nowTier = tierOf(now, bands);
    return {
      username: c.username, group: c.group, coach: c.manager,
      was: Math.round(was), now: Math.round(now), wasTier, nowTier,
      held: nowTier >= wasTier,
      // What it would take to climb back into last month's band.
      toHold: Math.max(0, (bands[wasTier - 2] ?? 0) - now),
    };
  });
  const held = rows.filter((r) => r.held);

  return {
    month, prev, threshold, bands,
    denominator: rows.length,
    numerator: held.length,
    rate: rows.length ? held.length / rows.length : null,
    // Creators who have dropped a band but are closest to climbing back. Moving
    // two of these is worth more than any single creator card, because the rate
    // is a ratio over a small denominator.
    dropped: rows.filter((r) => !r.held).sort((a, b) => a.toHold - b.toHold),
  };
}

/**
 * How many more mature creators have to hold their tier to clear a threshold.
 *
 * The denominator is small — a few dozen — so a threshold is usually one or two
 * creators away, which is a completely different instruction to a coach than a
 * percentage is.
 */
export function creatorsToReach(numerator, denominator, target) {
  if (!denominator) return null;
  const needed = Math.ceil(target * denominator);
  return Math.max(0, needed - numerator);
}

/** Everything the management overview reports about where the network stands. */
export function policyStanding({ creators, asOf, config }) {
  const grad = graduationRate({ creators, asOf, config });
  const mature = matureRankUpRate({ creators, asOf, config });
  const bonusAt = config.policy?.rankUpBonusThreshold ?? 0.30;
  const inviteAt = config.policy?.premiumInviteThreshold ?? 0.50;

  return {
    graduation: grad,
    mature: {
      ...mature,
      bonusAt,
      inviteAt,
      clearsBonus: mature.rate != null && mature.rate >= bonusAt,
      clearsInvite: mature.rate != null && mature.rate >= inviteAt,
      toBonus: creatorsToReach(mature.numerator, mature.denominator, bonusAt),
      toInvite: creatorsToReach(mature.numerator, mature.denominator, inviteAt),
    },
    // The termination rule needs all three breached. Reporting it as three
    // independent lines is how someone reads "we are fine" correctly rather
    // than panicking at one red number.
    standing: inactiveOperations({ creators, asOf, config, graduation: grad }),
  };
}

/**
 * The inactive-operations rule, which is the one that ends in termination.
 *
 * All three criteria have to breach together. The deck's second worked example
 * exists to make exactly this point: "Any metric exceeds the requirements — no
 * consequence triggered."
 */
export function inactiveOperations({ creators, asOf, config, graduation = null }) {
  const cfg = config.policy ?? {};
  const minNew = cfg.minNewCreatorsPerQuarter ?? 60;
  const minDiamonds = cfg.minDiamondsPerQuarter ?? 500000;
  const months = [];
  let key = asOf.slice(0, 7);
  for (let i = 0; i < 3; i++) { months.unshift(key); key = previousMonth(key); }

  const since = cohortStart(asOf, 3);
  const newCreators = creators.filter((c) => c.joinDate && c.joinDate >= since).length;
  const diamonds = creators.reduce((n, c) =>
    n + months.reduce((m, k) => m + (monthMtd(c, k)?.diamonds ?? 0), 0), 0);

  const breaches = {
    newCreators: newCreators < minNew,
    diamonds: diamonds < minDiamonds,
    // Needs three consecutive Low months, which we cannot see from one export;
    // the rate we do have is reported so the reader can judge it.
    lowTier: null,
  };
  return {
    months, newCreators, minNew,
    diamonds: Math.round(diamonds), minDiamonds,
    breaches,
    // Two of three clear means the rule cannot fire, whatever the third is.
    safe: !breaches.newCreators || !breaches.diamonds,
    rate: graduation?.rate ?? null,
  };
}
