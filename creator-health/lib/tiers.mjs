// The rank-up task: creator tiers, and what moving up one is worth to a coach.
//
// WHAT THE TASK IS, from the 2026 Positive Incentives deck:
//
//   "Rank-up incentive is designed to encourage creators to continuously rank
//    up their tiers, while guiding high-performing creators to maintain stable
//    performance. For Creator Networks, this means keeping creators' revenue
//    stable and guiding them to move up to higher tiers, so both ranking up and
//    tier maintenance can bring incentives."
//
//   Two changes for 2026. First, it is a MONTHLY incentive on rank-up or
//   maintenance results, not the one-time breakthrough bonus it used to be.
//   Second, it is no longer limited to new creators — every creator in the
//   network is eligible.
//
//   "The incentive amount is determined by Diamonds in the network for the
//    month and the bonus ratio."
//
// HOW A TIER IS DECIDED
//
//   By LAST month's diamonds, not this month's. That is the whole shape of the
//   thing: the tier is fixed on the 1st and cannot move, and what the creator
//   does this month decides whether they rank up out of it.
//
//   Lower tiers pay a HIGHER ratio, so a creator who was small last month and
//   goes big this month is worth far more than a big creator staying big. Tier
//   10 pays nothing at all.
//
// WHAT THE COACH GETS
//
//   A flat 1% of the diamond dollar value — diamonds x $0.01 x 1% — on every
//   creator who ranks up. It does NOT vary with the tier ratio: the ratio is
//   what TikTok pays LEAP, the 1% is what LEAP pays the coach out of it. Both
//   are in the WAGES CALCUATOR tab, which is the rank-up calculator.
//
//   It is paid on the creator's WHOLE month, not on the threshold they crossed.
//   Verified: gdubz360streams did 1,006,213 diamonds in August off a July tier
//   of 800,483, ranking 6 -> 7, and the sheet pays £75.8758945 — the full
//   1,006,213, not the 1,000,000 threshold.
//
// HOW THIS WAS VERIFIED
//
//   Against the WAGES CALCUATOR block labelled JULY, which holds AUGUST data
//   (the tab's month headings run one behind the data in them — the block's
//   diamonds match the August export exactly for 23 of its 27 rows, the rest
//   off by a few hundred from being pulled on a different day).
//
//   - The ratio in the sheet's TIKTOK % column matches this table, read off
//     the creator's JULY diamonds, for 25 of 26 rows. The one miss is drzy_mc,
//     on 4.5% where July's 148,377 puts them in Tier 2 at 6.5%.
//
//   - All 26 of those rows RANKED UP. None maintained, none dropped. That is
//     the rule, and it is not the "past 100,000 diamonds" floor this module
//     replaces: the old rule paid on 66 creators in August where the sheet
//     pays on 26, overstating a coach's rank-up line by about two and a half
//     times. The floor looked real only because ranking up out of Tier 1 means
//     crossing exactly 100,000 — the smallest creator the sheet has ever
//     listed is 100,503.
//
//   Twelve creators ranked up in August without being paid. Nine of them
//   belong to coaches with no rows in that block at all, so the sheet is
//   unfinished there rather than the rule being narrower.
//
// WHY THIS NEEDS NO HISTORY, AND WHAT MAKES IT SAFE DAY TO DAY
//
//   Every export carries BOTH halves of the sum on every row: "Diamonds" is
//   this month to date, "Diamonds last month" is the tier basis. So a rank-up
//   is computable from a single file, on the first upload, with an empty
//   store. Checked across the July, August and three September exports: the
//   last-month column is present on every row of every one of them.
//
//   Three properties of the data make the daily number trustworthy, all
//   checked rather than assumed:
//
//   1. The tier cannot move mid-month. The last-month column is byte for byte
//      identical across 15, 16 and 21 September — 888 and 887 creators, zero
//      changes. So a creator's target is fixed on the 1st and a coach chasing
//      it is never chasing a moving line.
//
//   2. Month-to-date only goes up, so a rank-up cannot be taken back. Across
//      the same three September exports, not one creator's diamonds fell. Once
//      `rankedUp` is true it stays true for the rest of the month, which is
//      why the card can say "banked" and mean it.
//
//   3. The month closes itself. Next month's last-month column equals this
//      month's final figure exactly — 806 creators compared across the August
//      and September exports, zero disagreements. So the 1st of the month both
//      settles the month just gone and sets every new tier, in one file.
//
//   What this does NOT survive is a missed upload spanning a month boundary:
//   the last export of a month is the settlement, and if the last one we hold
//   is the 28th then the last three days are missing from the rank-ups we
//   report. The next month's file still carries the true total in its
//   last-month column, so the gap is visible and recoverable, but it has to be
//   reingested rather than inferred.
//
// TIER MAINTENANCE IS NOT IMPLEMENTED
//
//   Backstage shows a second "Ratio for maintaining tiers" column, 0% for the
//   bottom tiers and a lower rate above them. We do not have those numbers —
//   the table we were given is the rank-up column only — and LEAP has never
//   paid a maintenance row. `maintained` is reported so it is visible, and is
//   deliberately worth nothing until somebody fills in the ratios.
import { monthMtd } from './policy.mjs';
import { groupKey } from './notify.mjs';
import { coachName } from './coaches.mjs';

/** Tier thresholds and the rank-up ratio, base and advanced. */
export const DEFAULT_TIERS = [
  { tier: 1, min: 0, base: 0.065, advanced: 0.075 },
  { tier: 2, min: 100000, base: 0.065, advanced: 0.075 },
  { tier: 3, min: 200000, base: 0.065, advanced: 0.075 },
  { tier: 4, min: 300000, base: 0.065, advanced: 0.075 },
  { tier: 5, min: 500000, base: 0.065, advanced: 0.075 },
  { tier: 6, min: 700000, base: 0.055, advanced: 0.065 },
  { tier: 7, min: 1000000, base: 0.045, advanced: 0.055 },
  { tier: 8, min: 1600000, base: 0.035, advanced: 0.045 },
  { tier: 9, min: 2500000, base: 0.03, advanced: 0.04 },
  // Nothing above this pays, so there is nothing to chase.
  { tier: 10, min: 5000000, base: null, advanced: null },
];

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** The table sorted high to low, so the first match is the right tier. */
function tableOf(config) {
  const rows = config?.rankUp?.tiers ?? DEFAULT_TIERS;
  return [...rows].sort((a, b) => b.min - a.min);
}

/**
 * Which tier a month's diamonds put a creator in.
 *
 * Anything that is not a real number reads as 0, which is Tier 1. That is the
 * right answer and not a fallback: TikTok writes "-" in the last-month column
 * for a creator who was not in the network last month, the normaliser turns
 * that into null, and a creator with no last month starts at the bottom. The
 * August sheet pays on exactly those creators, so it matters that they land in
 * Tier 1 deliberately rather than by where the table happens to be sorted.
 */
export function tierOf(diamonds, config = {}) {
  const d = Number.isFinite(diamonds) ? diamonds : 0;
  const table = tableOf(config);
  return table.find((t) => d >= t.min) ?? table[table.length - 1];
}

/** The tier above this one, or null at the top. */
export function nextTier(tier, config = {}) {
  const table = tableOf(config).slice().sort((a, b) => a.min - b.min);
  return table.find((t) => t.tier === tier.tier + 1) ?? null;
}

/**
 * Last month's diamonds for a creator, as the export reports them.
 *
 * Read off the observation rather than worked out from our own history: the
 * export carries the figure on every row, so this is right on a creator's
 * first day in the system, where our own history is empty.
 */
export function lastMonthDiamonds(creator, month) {
  const obs = creator?.obs;
  if (!obs?.length) return null;
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].date.slice(0, 7) === month) return obs[i].lastMonthDiamonds ?? null;
  }
  return null;
}

/**
 * TikTok's own verdict for the month, if the export carried one.
 *
 * "Ranked up", "Maintained", "Not maintained", or "-" for a creator it has no
 * opinion on. Read off the observation so a question about a past month gets
 * that month's answer rather than today's.
 */
export function tierStatusFor(creator, month) {
  const obs = creator?.obs;
  if (!obs?.length) return null;
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].date.slice(0, 7) === month) {
      const v = String(obs[i].tierStatus ?? '').trim();
      return ['Ranked up', 'Maintained', 'Not maintained'].includes(v) ? v : null;
    }
  }
  return null;
}

/**
 * One creator's rank-up standing for the month.
 *
 * `null` for a creator we have no reading on this month. A creator at the top
 * tier comes back with `target: null` — there is nothing above them, and
 * showing a coach a chase that cannot be won is worse than showing nothing.
 */
export function rankUpFor(creator, asOf, config = {}) {
  const month = asOf.slice(0, 7);
  const mtd = monthMtd(creator, asOf);
  if (!mtd) return null;

  const cfg = config.rankUp ?? {};
  const diamonds = mtd.diamonds ?? 0;
  const before = lastMonthDiamonds(creator, month);
  // Without last month there is no tier, so there is no task. A creator in
  // their first calendar month reads as 0, which is Tier 1 — correct, because
  // that is exactly how TikTok treats them.
  const from = tierOf(before ?? 0, config);
  const now = tierOf(diamonds, config);
  const next = nextTier(from, config);

  // TikTok's own answer wins wherever it exists. Comparing tiers ourselves is
  // close but consistently generous: across July, August and September its
  // "Ranked up" list was a strict subset of ours every month — we never missed
  // one, and we added 4, 3 and 2 that it does not pay for. Those are creators
  // we would have billed a coach for, so the column is not a nicety.
  const stated = tierStatusFor(creator, month);
  const rankedUp = stated ? stated === 'Ranked up' : now.tier > from.tier;
  const maintained = stated ? stated === 'Maintained' : now.tier === from.tier;
  const ratio = (cfg.advanced ? from.advanced : from.base) ?? null;

  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const daysLeft = Math.max(0, monthLength - dayOfMonth);
  const perDay = dayOfMonth > 0 ? diamonds / dayOfMonth : 0;

  const target = next ? next.min : null;
  const gap = target == null ? null : Math.max(0, target - diamonds);
  const needPerDay = gap == null || daysLeft <= 0 ? null : gap / daysLeft;
  // Same rule the graduation chase uses: a creator has to be inside twice their
  // own pace, or it is not a chase, it is a wish.
  const stretch = needPerDay == null || perDay <= 0 ? null : needPerDay / perDay;
  const reachable = rankedUp || (gap === 0) || (stretch != null && stretch <= (cfg.stretch ?? 2));

  const share = cfg.coachSharePerDiamondUsd ?? 0.0001;
  const fx = config.revenue?.usdToGbp ?? 0.754073884;
  const perDiamond = Number((share * fx).toPrecision(6));

  return {
    creator, username: creator.username, coach: creator.manager ?? 'unassigned',
    group: creator.group ?? null, month, asOf, daysLeft, dayOfMonth,
    lastMonth: before, diamonds, perDay,
    fromTier: from.tier, toTier: now.tier, ratio,
    rankedUp, maintained,
    target, gap, needPerDay, stretch, reachable,
    // What it is worth to the coach: their whole month, once they have ranked
    // up. Before that it is worth nothing at all, which is the point.
    worth: rankedUp ? diamonds * perDiamond : 0,
    // What crossing would be worth, at the diamonds crossing implies. This is
    // the number that moves somebody: it is a step from zero, not a trickle.
    worthIfCrossed: target == null ? 0 : Math.max(diamonds, target) * perDiamond,
    perDiamond,
  };
}

/**
 * The whole network's rank-up standing, split into what is done and what is
 * still winnable.
 *
 * `close` is ordered by what it is worth to the coach rather than by how near
 * it is: a creator 40,000 off Tier 5 is a better use of a coach's week than one
 * 2,000 off Tier 2, even though the second looks more urgent.
 */
export function rankUpBoard({ creators, asOf, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const r = rankUpFor(c, asOf, config);
    if (r) rows.push({ ...r, name: coachName(r.coach, config) });
  }

  const ranked = rows.filter((r) => r.rankedUp).sort((a, b) => b.worth - a.worth);
  const close = rows
    .filter((r) => !r.rankedUp && r.reachable && r.target != null && r.daysLeft > 0)
    .sort((a, b) => b.worthIfCrossed - a.worthIfCrossed);

  const byCoach = new Map();
  for (const r of rows) {
    const e = byCoach.get(r.coach) ?? {
      coach: r.coach, name: r.name, ranked: [], close: [], maintained: 0,
      worth: 0, upside: 0,
    };
    if (r.rankedUp) { e.ranked.push(r); e.worth += r.worth; }
    else {
      if (r.maintained) e.maintained++;
      if (r.reachable && r.target != null && r.daysLeft > 0) {
        e.close.push(r);
        e.upside += r.worthIfCrossed;
      }
    }
    byCoach.set(r.coach, e);
  }
  for (const e of byCoach.values()) {
    e.ranked.sort((a, b) => b.worth - a.worth);
    e.close.sort((a, b) => b.worthIfCrossed - a.worthIfCrossed);
  }

  return {
    month: asOf.slice(0, 7), asOf, rows, ranked, close, byCoach,
    daysLeft: rows[0]?.daysLeft ?? 0,
    networkWorth: ranked.reduce((n, r) => n + r.worth, 0),
    networkUpside: close.reduce((n, r) => n + r.worthIfCrossed, 0),
  };
}
