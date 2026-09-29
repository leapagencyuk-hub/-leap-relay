// LEAP's own leagues, and who moved between them.
//
// Four leagues, by diamonds over a month:
//
//   Aspire   0 – 49,999      day one; learning the app and building the habit
//   Rising   50,000 – 199,999   basics down, momentum building
//   Elite    200,000 – 499,999  scaling revenue, real competition
//   Pro      500,000 +          long-term careers, the top of the network
//
// These are LEAP's, not TikTok's. TikTok's ten tiers decide what the network
// is paid and live in lib/tiers.mjs; these decide which competitions and
// campaigns a creator is in, and are the spine of the incentive structure.
// Nothing here touches anybody's pay.
//
// HOW A MOVE IS DECIDED
//
// Last month's league against this month's. Both come off the export: the
// "Diamonds last month" column and the month to date. Nothing is remembered
// between runs, so pressing the button twice gives the same answer and a
// rebuilt database changes nothing.
//
// WHY A RANK-UP IS FINAL AND A DE-RANK IS NOT
//
// Month-to-date only goes up. So the moment a creator passes 200,000 they are
// Elite and cannot stop being Elite before the month ends — a rank-up found on
// the 9th is as true as one found on the 30th, and saying so is the point of
// the channel.
//
// A drop is the opposite. On the 9th of the month everybody is below where
// they finished last month, because the month has barely started. Posting that
// as a de-rank would name most of the network every morning and mean nothing.
//
// So a creator below their league is only DE-RANKED when they can no longer
// get back: the diamonds they still need, against the rate they are actually
// running at, with the days left in the month. Anyone who could still make it
// is SLIPPING instead — which is the useful half, because there is still time
// to do something about it.
import { monthMtd } from './policy.mjs';
import { lastMonthDiamonds } from './tiers.mjs';
import { groupKey } from './notify.mjs';
import { coachName } from './coaches.mjs';

/** Low to high. `min` is the floor; a creator is in the highest one they clear. */
export const DEFAULT_LEAGUES = [
  { name: 'Aspire', min: 0 },
  { name: 'Rising', min: 50000 },
  { name: 'Elite', min: 200000 },
  { name: 'Pro', min: 500000 },
];

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

const table = (config) => {
  const rows = config?.leagues?.tiers ?? DEFAULT_LEAGUES;
  return [...rows].sort((a, b) => a.min - b.min);
};

/** Which league a month's diamonds put a creator in. */
export function leagueOf(diamonds, config = {}) {
  const d = Number.isFinite(diamonds) ? diamonds : 0;
  const rows = table(config);
  let found = rows[0];
  for (const r of rows) if (d >= r.min) found = r;
  return found;
}

/** Position in the ladder, so two leagues can be compared. */
export function leagueRank(name, config = {}) {
  return table(config).findIndex((r) => r.name === name);
}

/** The league above this one, or null at the top. */
export function nextLeague(name, config = {}) {
  const rows = table(config);
  return rows[rows.findIndex((r) => r.name === name) + 1] ?? null;
}

/**
 * One creator's league standing for the month.
 *
 * `null` for a creator with no reading this month. A creator with no last
 * month at all — new this month, or the export writes "-" — starts in the
 * bottom league, which is where a new creator belongs.
 */
export function leagueMoveFor(creator, asOf, config = {}) {
  const month = asOf.slice(0, 7);
  const mtd = monthMtd(creator, month);
  if (!mtd) return null;

  const diamonds = mtd.diamonds ?? 0;
  const before = lastMonthDiamonds(creator, month) ?? 0;
  const from = leagueOf(before, config);
  const now = leagueOf(diamonds, config);
  const fromRank = leagueRank(from.name, config);
  const nowRank = leagueRank(now.name, config);

  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const daysLeft = Math.max(0, monthLength - dayOfMonth);
  const perDay = dayOfMonth > 0 ? diamonds / dayOfMonth : 0;

  // What it would take to be back in last month's league by the 31st.
  const shortBy = Math.max(0, from.min - diamonds);
  const couldRecover = shortBy === 0 || (daysLeft > 0 && perDay * daysLeft >= shortBy);

  const up = nowRank > fromRank;
  const down = nowRank < fromRank;
  const next = nextLeague(now.name, config);

  return {
    creator, username: creator.username, group: creator.group ?? null,
    coach: creator.manager ?? 'unassigned', name: coachName(creator.manager, config),
    month, asOf, daysLeft, dayOfMonth,
    lastMonth: before, diamonds, perDay,
    from: from.name, to: now.name, jumped: Math.abs(nowRank - fromRank),
    // Month to date only goes up, so a rank-up cannot be undone this month.
    rankedUp: up,
    // Below last month's league AND out of road. Anyone who could still make
    // it back is slipping, not de-ranked.
    deRanked: down && !couldRecover,
    slipping: down && couldRecover,
    held: !up && !down,
    shortBy, couldRecover,
    // What they need to climb again, for the card to say something useful.
    toNext: next ? Math.max(0, next.min - diamonds) : null,
    nextLeague: next?.name ?? null,
  };
}

/**
 * Everybody's league standing, split into what happened and what still could.
 *
 * Sorted by diamonds within each list: the biggest creator moving is the one a
 * director wants to see first, in both directions.
 */
export function leagueBoard({ creators, asOf, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const r = leagueMoveFor(c, asOf, config);
    if (r) rows.push(r);
  }
  const by = (list) => list.sort((a, b) => b.diamonds - a.diamonds);

  const counts = {};
  for (const r of rows) counts[r.to] = (counts[r.to] ?? 0) + 1;

  return {
    month: asOf.slice(0, 7), asOf,
    daysLeft: rows[0]?.daysLeft ?? 0,
    rows,
    rankedUp: by(rows.filter((r) => r.rankedUp)),
    deRanked: by(rows.filter((r) => r.deRanked)),
    slipping: by(rows.filter((r) => r.slipping)),
    held: rows.filter((r) => r.held).length,
    // Where the network sits now, for the footer of each card.
    standings: table(config).map((l) => ({ name: l.name, min: l.min, count: counts[l.name] ?? 0 })),
  };
}
