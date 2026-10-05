// A partner agency's revenue, from the Agency Partner Programme Agreement.
//
// WHAT A PARTNER AGENCY IS
//
//   LEAP is the registered TikTok LIVE agency. A partner agency recruits and
//   manages its own creators, who stay contractually under LEAP's registration,
//   and LEAP provides the infrastructure, Backstage access, payment processing
//   and compliance (Agreement, clauses 2.1 to 2.4). LEAP collects the money
//   from TikTok and settles a share of it monthly.
//
//   So a partner's revenue is not a coach's. A coach is paid a wage plus a
//   small unlocked slice of LEAP's incremental incentive; a partner is paid a
//   SHARE OF THE AGENCY REVENUE THEIR OWN CREATORS GENERATE, and pays its own
//   staff out of it (clause 6).
//
// THE SHARE LADDER (clause 5)
//
//   Seedling 80%, Growth 85%, Performance 90%, Elite 95%, reviewed monthly on
//   "creator growth, diamond growth, compliance, retention, operational
//   standards and overall contribution". The tier is a judgement LEAP makes,
//   not something this computes, so it is config.
//
// WHAT AGENCY REVENUE IS
//
//   The same two components the coach cards already use, verified to the cent
//   against Backstage's own per-creator page:
//
//     incremental share    roster diamonds x $0.01 x TikTok's incremental rate
//     rank-up bonus        for each creator who moved up a tier this month,
//                          their WHOLE month's diamonds x $0.01 x the ratio of
//                          the tier they LEFT
//
//   Quoted at the 5% board rate, like every other card, rather than at what
//   TikTok actually paid. That is a standing decision — under-promise, so a
//   good month is a surprise rather than a card that lied — and the card names
//   the rate it used so nobody has to guess.
//
//   WORTH KNOWING, because a partner will do this arithmetic: the Agreement's
//   own worked example in clause 5 is "30M diamonds agency revenue generates
//   $42,000", which is $0.0014 a diamond. This model reaches that only at
//   TikTok's 8% incremental rate AND with about 80% of diamonds coming from
//   creators who ranked up. At the 5% board rate it cannot reach it at all —
//   rank-ups would have to cover 120% of diamonds. So the example in the signed
//   document is an optimistic month, not a baseline, and a partner comparing it
//   to this card will see roughly a third of it. That gap is the directors' to
//   explain; this module's job is not to paper over it.
//
// BEFORE TAX, ALWAYS
//
//   Clause 6: Corporation Tax, VAT where applicable and agreed statutory
//   deductions are accounted for BEFORE settlement. Every figure this module
//   produces is therefore before all of that, and `beforeTax` is on the result
//   so a card cannot render one without saying so.
//
// WHO COUNTS
//
//   Every creator in the partner's group who has a reading for the month,
//   INCLUDING anybody who has since left. A creator who quit on the 4th still
//   earned diamonds on the 1st to the 3rd and the partner is owed its share of
//   them. That is the opposite of the coaching cards, which forget a departed
//   creator immediately, and the difference is deliberate: one is about who to
//   chase today, this one is about money already earned.
import { monthMtd, previousMonth } from './policy.mjs';
import { groupKey } from './notify.mjs';
// The creator tier table and its lookups already live in tiers.mjs, verified
// against Backstage. Reused rather than restated, so a change to the ratios
// cannot leave a partner's settlement on a stale copy of them.
import { tierOf as creatorTierOf, nextTier, lastMonthDiamonds } from './tiers.mjs';

/** Clause 5's ladder. */
export const PARTNER_TIERS = [
  { name: 'Seedling', share: 0.80 },
  { name: 'Growth', share: 0.85 },
  { name: 'Performance', share: 0.90 },
  { name: 'Elite', share: 0.95 },
];

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

const round2 = (x) => Math.round(x * 100) / 100;

/** The tier a partner is on, and the one above it. */
export function partnerTierOf(partner, config = {}) {
  const ladder = config.partners?.tiers ?? PARTNER_TIERS;
  const i = Math.max(0, ladder.findIndex((t) => t.name.toLowerCase() === String(partner?.tier ?? '').toLowerCase()));
  return { ladder, current: ladder[i], next: ladder[i + 1] ?? null, index: i };
}

/**
 * One partner's month.
 *
 * `asOf` is the last reading we hold, which runs a day behind TikTok's export,
 * so "today" on this card means the most recent day we have numbers for and the
 * card says which day that is.
 */
export function partnerRevenue({ creators, asOf, config = {}, partner }) {
  const cfg = config.revenue ?? {};
  const inc = cfg.incremental ?? {};
  const boardRate = inc.boardRate ?? 0.05;
  const usdToGbp = cfg.usdToGbp ?? 0.754074;
  const advanced = config.rankUp?.advanced !== false;

  const month = asOf.slice(0, 7);
  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const prev = previousMonth(month);
  const key = groupKey(partner.group);
  const { current, next, ladder } = partnerTierOf(partner, config);

  // Departed creators included on purpose — see the header.
  const roster = creators.filter((c) => groupKey(c.group) === key);

  const rows = [];
  for (const c of roster) {
    const now = monthMtd(c, asOf);
    if (!now) continue;
    const diamonds = Math.round(now.diamonds ?? 0);
    const base = Math.round(lastMonthDiamonds(c, month) ?? 0);
    const from = creatorTierOf(base, config);
    const to = creatorTierOf(diamonds, config);
    const rankedUp = to.tier > from.tier;
    const ratio = (advanced ? from.advanced : from.base) ?? 0;
    // Paid on the whole month, not on the threshold crossed. Verified against
    // the WAGES CALCUATOR tab — see the header of lib/tiers.mjs.
    const rankUpUsd = rankedUp ? diamonds * 0.01 * ratio : 0;

    // What the next rung would be worth if they got there. The jump is not the
    // gap: crossing it pays on EVERYTHING, so a creator 40,000 short of 100,000
    // unlocks a bonus on all 100,000.
    const up = nextTier(from, config);
    const target = up?.min ?? null;
    const gap = target == null ? null : Math.max(0, target - diamonds);
    const ifRankedUp = target == null ? 0 : Math.max(diamonds, target) * 0.01 * ratio;

    // Can they actually get there? At their own rate over this month, with the
    // days that are left. A creator on 573 diamonds needing 99,427 is not a
    // lever, and listing them beside somebody 41,622 away makes the real one
    // look like noise.
    const ownPerDay = dayOfMonth > 0 ? diamonds / dayOfMonth : 0;
    const daysLeft = Math.max(0, monthLength - dayOfMonth);
    const reachable = gap != null && gap > 0
      && ownPerDay > 0 && gap <= ownPerDay * daysLeft * (config.partners?.reachStretch ?? 1.5);

    rows.push({
      username: c.username,
      manager: c.manager ?? null,
      diamonds,
      lastMonth: base,
      liveHours: Math.round((now.liveHours ?? 0) * 10) / 10,
      liveDays: Math.round(now.validLiveDays ?? 0),
      fromTier: from.tier,
      toTier: to.tier,
      rankedUp,
      ratio,
      rankUpUsd,
      // Rank-up headroom, and what closing it is worth to the partner.
      target,
      gap,
      reachable,
      ownPerDay: Math.round(ownPerDay),
      ifRankedUpUsd: ifRankedUp,
      ifRankedUpGbp: round2(ifRankedUp * usdToGbp * current.share),
      left: Boolean(c.quitOn),
      leftOn: c.quitOn ?? null,
    });
  }

  const diamonds = rows.reduce((t, r) => t + r.diamonds, 0);
  const incrementalUsd = diamonds * 0.01 * boardRate;
  const rankUpUsd = rows.reduce((t, r) => t + r.rankUpUsd, 0);
  const agencyUsd = incrementalUsd + rankUpUsd;

  const settle = (usd, share) => ({
    usd: round2(usd * share),
    gbp: round2(usd * share * usdToGbp),
  });

  // The breakdown is a column a partner adds up, so the parts have to sum to
  // the total they are printed above. Rounding each component independently and
  // the total separately left "incremental 33.04 + rank-up 0.00 = 33.03" on the
  // card, which reads as a mistake because it is one. So the agency figure is
  // the sum of the rounded parts, not a separately rounded sum.
  const incrementalGbp = round2(incrementalUsd * usdToGbp);
  const rankUpGbp = round2(rankUpUsd * usdToGbp);
  const agencyGbp = round2(incrementalGbp + rankUpGbp);

  // Yesterday's earnings, from the single-day delta rather than a month average:
  // "how much did we make today" has to be the actual day.
  const today = dayTotal(roster, asOf);
  const prevDay = dayTotal(roster, shiftDay(asOf, -1));

  // Where the month lands, and why this is harder than it looks on a roster
  // this small.
  //
  // A straight line off the mean is badly wrong: Stay Social's first four days
  // of October were 16k, 56k, 8k and 7k, so one creator's big night is most of
  // the month and the mean projected 679,000 against 134,000 last month — a
  // 407% rise off a single evening.
  //
  // Shaping on last month, which is what the recruitment board does, is worse
  // here and for a different reason: most of this roster joined partway through
  // September, so the same point last month holds almost nothing and the ratio
  // came out at forty times. That method needs a comparable roster and this one
  // is not comparable.
  //
  // So the projection runs off the MEDIAN day, which one big night cannot move,
  // and last-month shaping is used only when the same point last month is a
  // real share of it. `from` says which ran and `young` says the month is too
  // new to trust either, so the card can soften it rather than quoting a number
  // it should not.
  const daily = dailyTotals(roster, month, dayOfMonth);
  const medianDay = median(daily);
  const prevLength = daysInMonth(prev);
  const prevToSamePoint = Math.round(roster.reduce((t, c) => {
    const at = monthMtd(c, `${prev}-${String(Math.min(dayOfMonth, prevLength)).padStart(2, '0')}`);
    return t + (at?.diamonds ?? 0);
  }, 0));
  const perDay = dayOfMonth > 0 ? diamonds / dayOfMonth : 0;

  const lastMonthRows = roster.map((c) => monthMtd(c, `${prev}-${prevLength}`)).filter(Boolean);
  const lastMonthDiamondsTotal = Math.round(lastMonthRows.reduce((t, r) => t + (r.diamonds ?? 0), 0));

  // Comparable only when last month had actually got going by this point. Ten
  // per cent is the line: below it the ratio is dividing by noise.
  const comparable = lastMonthDiamondsTotal > 0
    && prevToSamePoint >= lastMonthDiamondsTotal * (config.partners?.shapeMinShare ?? 0.1);
  const projectedDiamonds = comparable
    ? Math.round(diamonds * (lastMonthDiamondsTotal / prevToSamePoint))
    : Math.round(medianDay * monthLength);
  // Projected rank-ups are deliberately NOT guessed: a bonus that depends on
  // crossing a threshold either happens or it does not, and modelling a
  // fraction of one would put money on the card nobody is owed.
  const projectedAgencyUsd = projectedDiamonds * 0.01 * boardRate + rankUpUsd;

  return {
    partner: partner.name ?? partner.group,
    group: partner.group,
    asOf, month, dayOfMonth, monthLength,
    daysLeft: Math.max(0, monthLength - dayOfMonth),
    tier: current, nextTier: next, ladder,
    // Nothing on this card is net of anything. Clause 6 puts Corporation Tax,
    // VAT and statutory deductions ahead of settlement, so the flag exists to
    // make a card that forgets to say so impossible to write.
    beforeTax: true,
    boardRate, usdToGbp,
    creators: rows.length,
    live: rows.filter((r) => !r.left).length,
    earning: rows.filter((r) => r.diamonds > 0).length,
    dormant: rows.filter((r) => r.diamonds === 0 && !r.left),
    diamonds,
    liveHours: round2(rows.reduce((t, r) => t + r.liveHours, 0)),
    liveDays: rows.reduce((t, r) => t + r.liveDays, 0),
    incrementalUsd: round2(incrementalUsd),
    rankUpUsd: round2(rankUpUsd),
    agencyUsd: round2(agencyUsd),
    incrementalGbp,
    rankUpGbp,
    agencyGbp,
    settlement: settle(agencyUsd, current.share),
    // What each rung of clause 5's ladder would pay on exactly this month's
    // numbers. The point of the card: what moving up is worth.
    atEachTier: ladder.map((t) => ({ ...t, ...settle(agencyUsd, t.share), current: t.name === current.name })),
    nextTierGain: next ? round2((agencyUsd * next.share - agencyUsd * current.share) * usdToGbp) : null,
    today: {
      date: asOf,
      diamonds: today,
      ...settle(today * 0.01 * boardRate, current.share),
      // Yesterday, for a direction rather than a bare number.
      previousDiamonds: prevDay,
    },
    perDayDiamonds: Math.round(perDay),
    medianDayDiamonds: Math.round(medianDay),
    perDayGbp: round2(perDay * 0.01 * boardRate * current.share * usdToGbp),
    projected: {
      diamonds: projectedDiamonds,
      ...settle(projectedAgencyUsd, current.share),
      from: comparable ? 'last month' : 'median day',
      // Under a week of readings, any projection is a guess dressed up. The
      // card says so rather than printing a confident figure.
      young: dayOfMonth < (config.partners?.projectAfterDay ?? 7),
      // Only the incremental half is projected; any rank-up already earned is
      // carried at its real value and none is invented.
      rankUpsProjected: false,
    },
    lastMonth: {
      month: prev,
      diamonds: lastMonthDiamondsTotal,
      ...settle(lastMonthDiamondsTotal * 0.01 * boardRate, current.share),
    },
    change: lastMonthDiamondsTotal > 0
      ? (projectedDiamonds - lastMonthDiamondsTotal) / lastMonthDiamondsTotal : null,
    rows: rows.sort((a, b) => b.diamonds - a.diamonds),
    // The nearest rank-up is the single biggest lever on this card, because it
    // pays on a creator's whole month rather than on the diamonds above the
    // line.
    // In reach only. The ones that are not are still on the per-creator list,
    // so nobody disappears; they are just not presented as money on the table.
    nearestRankUp: rows.filter((r) => r.reachable && !r.left)
      .sort((a, b) => a.gap - b.gap).slice(0, 5),
    outOfReach: rows.filter((r) => r.gap != null && r.gap > 0 && !r.reachable && !r.left).length,
    rankedUp: rows.filter((r) => r.rankedUp),
  };
}

/** One entry per day of the month so far, for a median that a spike cannot move. */
function dailyTotals(roster, month, upTo) {
  const byDay = new Map();
  for (const c of roster) {
    for (const o of c.obs ?? []) {
      if (o.date.slice(0, 7) !== month) continue;
      if (Number(o.date.slice(8, 10)) > upTo) continue;
      if (o.span !== 1 || o.partial) continue;
      byDay.set(o.date, (byDay.get(o.date) ?? 0) + (o.delta?.diamonds ?? 0));
    }
  }
  return [...byDay.values()];
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Diamonds the whole roster earned on one day. */
function dayTotal(roster, date) {
  let total = 0;
  for (const c of roster) {
    for (const o of c.obs ?? []) {
      if (o.date !== date) continue;
      // Only a true single-day reading. A multi-day span spreads its delta and
      // would make "today" an average dressed up as a day.
      if (o.span === 1 && !o.partial) total += o.delta?.diamonds ?? 0;
    }
  }
  return Math.round(total);
}

const shiftDay = (date, by) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * 86400000).toISOString().slice(0, 10);

/** Every configured partner agency, biggest first. */
export function partnerRevenues({ creators, asOf, config = {} }) {
  const partners = config.partners?.agencies ?? [];
  return partners
    .filter((p) => p.enabled !== false)
    .map((partner) => partnerRevenue({ creators, asOf, config, partner }))
    .sort((a, b) => b.diamonds - a.diamonds);
}

/** Posted once a day, and only once. */
export function partnerDue(config, store, asOf) {
  if (config.partners?.enabled === false) return false;
  if (!(config.partners?.agencies ?? []).some((p) => p.enabled !== false)) return false;
  return store.data.lastPartnerOn !== asOf;
}
