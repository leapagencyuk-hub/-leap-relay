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
// WHY IT IS NOT WON BY WHOEVER IS BIGGEST
//
// The obvious way to build this is to add the four up and take the top. That
// board is won by the same person every week for ever. In one week LEAP's
// network produced 8,010,974 diamonds; the top creator had 1.7 million of them
// against a median of 75. Nobody else can ever catch that, so nobody else has
// any reason to read the card.
//
// So the question this board asks is not "who is biggest" but "who is GROWING",
// and growth is measured against that creator's own recent normal — their own
// last few weeks, pillar by pillar. Someone who usually does 4,000 diamonds a
// week and does 12,000 has tripled. Someone who usually does 1.6 million and
// does 1.7 million has not. The second is a much bigger creator and the first
// had a much better week, and this award is for the better week.
//
// TWO SMALL PRINTS THAT MAKE IT HONEST
//
// A ratio on tiny numbers is meaningless: 2 diamonds to 20 is not a tenfold
// week, it is noise. So every ratio is damped by the network's own typical
// baseline for that pillar — (now + k) / (base + k), with k the median. A
// creator whose normal is far below typical has their ratio pulled towards 1,
// and one whose numbers are real keeps theirs. It also makes 0 to something
// finite rather than infinite, which is the other way this breaks.
//
// And growing is not the whole of it. LEAP's words: "are they growing, and
// doing well". So the score is mostly growth against their own baseline and
// partly where they came in the network this week, weighted three to one. A
// creator who tripled from nothing cannot take it off a creator who grew
// strongly on real numbers, and a giant standing still cannot take it at all.
//
// The pillars are not equal, because LEAP does not value them equally: fan club
// growth counts for most, diamonds and LIVE hours close behind, followers least
// but never nothing. All of it is in config.json.
//
// You cannot win it without going LIVE. A week of follower growth and no
// streaming is not a creator of the week in a LIVE agency.
//
// WHAT THE CARD IS ALLOWED TO SAY
//
// None of the four numbers. A creator's diamonds, followers and fan club are
// their own business and the whole network reads this channel: publishing them
// tells 800 people what everybody earns, and turns an award into a leak.
//
// So the board computes everything and publishes almost none of it. What goes
// out is a score out of 100 and how many places somebody has moved since the
// last board. The score is comparable without being revealing — it is built
// from positions, so it carries no quantity at all. The workings stay here, on
// the rows, for `cli.mjs creatorweek` and the upload page, which are LEAP's.
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

/** Middle value, for the damping constant. Empty gives 0. */
function median(xs) {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The week's standings.
 *
 * `asOf` is the day the data runs to. Everything is derived from the series, so
 * running it twice gives the same answer and a rebuilt database changes nothing.
 */
export function creatorWeekBoard({ creators, asOf, store = null, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const cfg = config.creatorWeek ?? {};
  const weights = cfg.weights ?? {};
  // Mostly "are they growing", partly "are they doing well".
  const growthWeight = cfg.growthWeight ?? 3;
  const standingWeight = cfg.standingWeight ?? 1;
  // How well a creator has to be doing before growth counts for anything.
  // Expressed as a position in the network rather than a number of diamonds,
  // so it scales with the roster and never needs revisiting.
  const minStanding = cfg.minStanding ?? 0.75;
  // How many of their own previous weeks make up "their normal".
  const baselineWeeks = Math.max(1, cfg.baselineWeeks ?? 3);

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

    // Their own normal for this stretch of a week: the SAME DAYS of each of
    // the previous few weeks, averaged. On a Wednesday that is last
    // Monday-to-Wednesday, and the one before, and the one before that.
    //
    // Not the last nine days, which is what this used to do. Streaming runs on
    // a weekly rhythm — a Saturday is not a Monday — so measuring somebody's
    // Monday against a block that was mostly weekend flatters half the network
    // and punishes the other half, for nothing but which day it happens to be.
    const base = {};
    for (const p of PILLARS) base[p.key] = 0;
    for (let w = 1; w <= baselineWeeks; w++) {
      const backStart = shiftDays(weekStart, -7 * w);
      const backEnd = shiftDays(backStart, days - 1);
      const had = gains(byDay, backEnd, days);
      for (const p of PILLARS) base[p.key] += had[p.key];
    }
    for (const p of PILLARS) base[p.key] /= baselineWeeks;

    entries.push({
      key: c.key,
      username: c.username,
      group: c.group ?? null,
      now,
      base,
      observed: observedDays(byDay, asOf, days),
    });
  }

  // The damping constant per pillar: the network's own typical baseline. A
  // creator whose normal is far below it has their ratio pulled back towards 1,
  // so two diamonds becoming twenty is not read as a tenfold week.
  const damp = {};
  for (const p of PILLARS) {
    const m = median(entries.map((e) => e.base[p.key]));
    // A pillar where almost nobody has any history yet falls back to this
    // week's own middle, and then to 1, so the ratio never divides by nothing.
    damp[p.key] = m > 0 ? m : (median(entries.map((e) => e.now[p.key])) || 1);
  }
  for (const e of entries) {
    e.ratio = {};
    for (const p of PILLARS) {
      const k = damp[p.key];
      e.ratio[p.key] = (e.now[p.key] + k) / (e.base[p.key] + k);
    }
  }

  // Two rankings, both by position so that no single enormous number decides
  // anything: how much each creator grew on their own normal, and where they
  // came in the network this week.
  const growthPoints = {};
  const standingPoints = {};
  for (const p of PILLARS) {
    growthPoints[p.key] = rankPoints(entries.map((e) => e.ratio[p.key]));
    standingPoints[p.key] = rankPoints(entries.map((e) => e.now[p.key]));
  }
  entries.forEach((e, i) => {
    e.growthScores = Object.fromEntries(PILLARS.map((p) => [p.key, growthPoints[p.key][i]]));
    e.scores = Object.fromEntries(PILLARS.map((p) => [p.key, standingPoints[p.key][i]]));
    e.growth = blend(e.growthScores, weights);
    e.standing = blend(e.scores, weights);
    e.score = (e.growth * growthWeight + e.standing * standingWeight)
      / (growthWeight + standingWeight || 1);
  });

  // Growing is not enough on its own. Before this, a creator 136th of 326 on
  // diamonds and 133rd on hours came SIXTH, because they had grown from almost
  // nothing — which is a real achievement and is not Creator of the Week. The
  // award is for somebody who is both doing well and growing, so anyone
  // outside the top of the network is ranked but not eligible to win it.
  //
  // Taken as a SHARE OF THE FIELD rather than a score to beat. Those are the
  // same thing only when scores are spread evenly, and they are not: where a
  // pillar is a near-universal tie the whole scale compresses, every score
  // lands under any fixed threshold, and a bar nobody clears is a bar that
  // excludes the field and hands the award to exactly the creator it was
  // written to stop. Top quarter of whoever turned up cannot do that.
  //
  // And a position only means something once there is a network: on a field of
  // three, "the top quarter" is one creator and the rule decides the award by
  // itself. So it applies only above a sensible field size, which also keeps
  // the first week of a new network, or a small sub-roster, behaving.
  const floorApplies = entries.length >= (cfg.minField ?? 20) && minStanding > 0;
  const keep = floorApplies
    ? Math.max(1, Math.ceil(entries.length * (1 - minStanding)))
    : entries.length;
  const byStanding = [...entries].sort((a, b) => b.standing - a.standing);
  const contenders = new Set(byStanding.slice(0, keep));
  for (const e of entries) e.eligible = contenders.has(e);
  const ranked = entries.filter((e) => e.eligible);

  const rows = ranked.sort((a, b) =>
    b.score - a.score
    // A dead heat goes to the bigger grower, then the harder worker, so the
    // order is never down to the sort's mood.
    || b.growth - a.growth
    || b.now.liveHours - a.now.liveHours
    || a.username.localeCompare(b.username));
  rows.forEach((r, i) => { r.rank = i + 1; });

  // Where everybody stood when the board last went up, so the card can show
  // movement. Only within the same week: on Monday nobody has moved yet.
  const was = previousRanks(store, weekStart, asOf);
  for (const r of rows) {
    const before = was?.[r.username] ?? null;
    // Positive is a climb. Null means they were not on the last board at all.
    r.move = before == null ? null : before - r.rank;
    r.isNew = was != null && before == null;
    // The only figure the card publishes. Built from positions, so it says
    // where a creator stands without saying what anybody did.
    r.points = Math.round(r.score * 100);
  }

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
    // Everybody who went LIVE, which is the field; `contending` is how many of
    // them clear the bar and can actually win it.
    entered: entries.length,
    contending: rows.length,
    minStanding: floorApplies ? minStanding : null,
    winner: rows[0] ?? null,
    total,
    baselineWeeks,
    // How much of the week we actually have readings for, so a board built on
    // one upload covering five days can say so instead of implying five uploads.
    observedDays: rows.length ? Math.max(...rows.map((r) => r.observed)) : 0,
  };
}

/**
 * The ranking to measure movement against.
 *
 * Two boards are kept, not one. The button can be pressed any number of times
 * a day and each press would otherwise overwrite the thing it is comparing
 * against, so today's board is compared with the last board from a DIFFERENT
 * day — which is what "up two places since yesterday" means.
 */
function previousRanks(store, weekStart, asOf) {
  const s = store?.data?.creatorWeek;
  if (!s || s.weekStart !== weekStart) return null;   // a new week starts level
  return (s.on !== asOf ? s.ranks : s.prevRanks) ?? null;
}

/**
 * Remember where everybody came, so the next board can show the movement.
 *
 * Pressing the button again on the same day changes nothing: the day's ranking
 * was already recorded and the one before it is still the comparison.
 */
export function recordWeekBoard(store, board) {
  const s = store.data.creatorWeek;
  const sameWeek = s?.weekStart === board.weekStart;
  if (sameWeek && s.on === board.asOf) return;
  store.data.creatorWeek = {
    weekStart: board.weekStart,
    on: board.asOf,
    ranks: Object.fromEntries(board.rows.map((r) => [r.username, r.rank])),
    prevOn: sameWeek ? s.on : null,
    prevRanks: sameWeek ? s.ranks : null,
  };
}

/** Posted once a day, and only once. */
export function creatorWeekDue(config, store, asOf) {
  if (config.creatorWeek?.enabled === false) return false;
  return store.data.lastCreatorWeekOn !== asOf;
}
