// Creator of the Week.
//
// The second creator-facing board. Where the Hardest Worker Challenge asks one
// question — who put the most hours in this month — this one asks who GREW the
// most this week, across everything the export measures:
//
//   diamonds earned          the money
//   LIVE hours               the work
//   new followers            the reach
//   new fan club members     the community
//
// WHY IT IS RANKED THE WAY IT IS
//
// Those four cannot be added together. In a single week LEAP's network produced
// 8,010,974 diamonds and 2,748 fan club members; the top creator on diamonds had
// 1.7 million against a median of 75. Add the raw numbers and the board is a
// diamonds board with three decorations on it, and the same creator wins it for
// ever.
//
// So each pillar is scored by POSITION rather than size. Best in the network
// this week on a pillar scores 1, worst scores 0, everyone else sits in between
// by where they come. The four are then averaged. That makes the four genuinely
// equal, makes the score immune to one enormous outlier, and means the winner
// is the creator who moved on every front rather than the biggest creator.
//
// THE FIFTH PILLAR IS WHY IT IS WORTH ENTERING
//
// Ranked on those four alone the same handful of established creators would win
// every week, and 790 people would stop reading. So a fifth pillar, weighted the
// same, scores how much better this week was than that creator's OWN last week —
// measured on the same four pillars over the same days of the week, so comparing
// a Wednesday is comparing three days against three days.
//
// That is the pillar that makes this a weekly award instead of a permanent one:
// a mid-table creator having a breakout week can take it off a steady giant, and
// the giant takes it back by growing again rather than by being big.
//
// You cannot win it without going LIVE. A week of follower growth and no
// streaming is not a creator of the week in a LIVE agency.
//
// THE WEEK RUNS MONDAY TO SUNDAY
//
// The board is posted daily and replaces itself, like the Hardest Worker one.
// On Sunday it crowns the winner, that stands overnight, and Monday's board
// removes it and starts the next week from zero.
import { groupKey } from './notify.mjs';
import { allocateDaily, windowSum, shiftDays, diffDays } from './metrics.mjs';

/** The four things the award is measured on, in the order the card prints them. */
export const PILLARS = [
  { key: 'diamonds', field: 'diamonds', label: 'diamonds' },
  { key: 'liveHours', field: 'liveHours', label: 'LIVE hours' },
  { key: 'newFollowers', field: 'newFollowers', label: 'new followers' },
  { key: 'newFans', field: 'newFans', label: 'fan club members' },
];

/** Monday of the week `date` falls in. Weeks run Monday to Sunday. */
export function weekStartOf(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();   // 0 Sunday .. 6 Saturday
  return shiftDays(date, -(dow === 0 ? 6 : dow - 1));
}

/** Sunday is the last day of the week, and the day the winner is crowned. */
export const isWeekEnd = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/**
 * Turn a column of numbers into 0-to-1 points by position.
 *
 * Best in the network scores 1, worst scores 0. Everybody on the same number
 * gets the same points — the average of the places they jointly occupy — so the
 * four hundred creators on nought fan club members are not silently ordered by
 * whatever the sort happened to do with them.
 */
export function rankPoints(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const order = values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    const points = 1 - ((i + j) / 2) / (n - 1);
    for (let k = i; k <= j; k++) out[order[k][1]] = points;
    i = j + 1;
  }
  return out;
}

/** Everything one creator gained over the `days` days ending `endDate`. */
function gains(byDay, endDate, days) {
  const out = {};
  for (const p of PILLARS) out[p.key] = windowSum(byDay, endDate, days, p.field);
  return out;
}

/** How many of those days we actually have a reading for. */
function observedDays(byDay, endDate, days) {
  let n = 0;
  for (let i = 0; i < days; i++) if (byDay.get(shiftDays(endDate, -i))?.observed) n++;
  return n;
}

/** The weighted average of a set of pillar scores. */
function blend(scores, weights) {
  let total = 0;
  let weight = 0;
  for (const p of PILLARS) {
    const w = weights[p.key] ?? 1;
    total += (scores[p.key] ?? 0) * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

/**
 * The week's standings.
 *
 * `asOf` is the day the data runs to. Everything is derived from the series, so
 * running it twice gives the same answer and a rebuilt database changes nothing.
 */
export function creatorWeekBoard({ creators, asOf, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const cfg = config.creatorWeek ?? {};
  const weights = cfg.weights ?? {};
  const momentumWeight = cfg.momentumWeight ?? 1;

  const weekStart = weekStartOf(asOf);
  const days = diffDays(weekStart, asOf) + 1;          // Monday counts as day 1
  const prevEnd = shiftDays(weekStart, -1);            // last Sunday

  const entries = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const byDay = allocateDaily(c);
    const now = gains(byDay, asOf, days);
    // No LIVE, no award. This is a LIVE agency and the week is about streaming.
    if (now.liveHours <= 0) continue;
    entries.push({
      key: c.key,
      username: c.username,
      group: c.group ?? null,
      now,
      // The same days of last week, so a Wednesday compares three days with
      // three days rather than three with seven.
      before: gains(byDay, prevEnd, days),
      observed: observedDays(byDay, asOf, days),
    });
  }

  // Position on each pillar, this week and the same stretch of last week.
  const pointsNow = {};
  const pointsBefore = {};
  for (const p of PILLARS) {
    pointsNow[p.key] = rankPoints(entries.map((e) => e.now[p.key]));
    pointsBefore[p.key] = rankPoints(entries.map((e) => e.before[p.key]));
  }
  entries.forEach((e, i) => {
    e.scores = Object.fromEntries(PILLARS.map((p) => [p.key, pointsNow[p.key][i]]));
    e.scoreNow = blend(e.scores, weights);
    e.scoreBefore = blend(Object.fromEntries(PILLARS.map((p) => [p.key, pointsBefore[p.key][i]])), weights);
    // Bounded between -1 and 1 by construction, so no creator can run away with
    // it on a divide-by-almost-nothing.
    e.climb = e.scoreNow - e.scoreBefore;
  });

  // The fifth pillar, scored the same way as the other four.
  const momentum = rankPoints(entries.map((e) => e.climb));
  const weightSum = PILLARS.reduce((t, p) => t + (weights[p.key] ?? 1), 0);
  entries.forEach((e, i) => {
    e.momentum = momentum[i];
    e.score = (e.scoreNow * weightSum + e.momentum * momentumWeight) / (weightSum + momentumWeight);
  });

  const rows = entries.sort((a, b) =>
    b.score - a.score
    // A dead heat on position goes to whoever earned more, then to whoever
    // streamed more, so the order is never down to the sort's mood.
    || b.now.diamonds - a.now.diamonds
    || b.now.liveHours - a.now.liveHours
    || a.username.localeCompare(b.username));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const show = cfg.show ?? 10;
  const total = {};
  for (const p of PILLARS) total[p.key] = rows.reduce((t, r) => t + r.now[p.key], 0);

  return {
    asOf, weekStart, weekEnd: shiftDays(weekStart, 6), days,
    daysLeft: 7 - days,
    // Sunday: the week is done and the winner is the winner.
    finished: isWeekEnd(asOf),
    rows,
    top: rows.slice(0, show),
    entered: rows.length,
    winner: rows[0] ?? null,
    total,
    // How much of the week we actually have readings for, so a board built on
    // one upload covering five days can say so instead of implying five uploads.
    observedDays: rows.length ? Math.max(...rows.map((r) => r.observed)) : 0,
  };
}

/** Posted once a day, and only once. */
export function creatorWeekDue(config, store, asOf) {
  if (config.creatorWeek?.enabled === false) return false;
  return store.data.lastCreatorWeekOn !== asOf;
}
