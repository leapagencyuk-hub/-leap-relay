// The coach growth board.
//
// The problem this has to solve is that a raw growth percentage is not a
// ranking. On today's data it would read:
//
//   itsmalkintiktok  +202%    9 creators, 7 comparable
//   tiktokphil       +110%   51 creators, 36 comparable
//   bigbamc.tt        +71%  118 creators, 70 comparable
//   joshbates93        +3%  227 creators, 181 comparable
//
// The top line is one creator going from nothing to 151,000. It is a good
// month, but it is not evidence that the coach outperformed the one holding 181
// creators steady, and a board that says so will be ignored by everyone below
// the smallest team on it.
//
// So the number shown is the coach's real growth, and the ORDER is that growth
// pulled toward the network's own growth in proportion to how little evidence
// there is behind it:
//
//   weighted = (n * observed + k * network) / (n + k)
//
// with n the coach's comparable creators and k a prior weight. A coach with 181
// comparable creators barely moves; a coach with 5 moves most of the way to the
// network average and has to be extraordinary to stay on top. That is the same
// idea as a minimum-innings qualifier in a batting average, done continuously
// so nobody is excluded outright for having a small team.
//
// Comparable means present and earning in BOTH months, so a team does not look
// like it collapsed because half of it is new, and last month is prorated to
// the same day so a mid-month board compares like with like.
import { groupKey } from './notify.mjs';
import { monthMtd, previousMonth } from './policy.mjs';
import { coachName, offTheBoards } from './coaches.mjs';

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/**
 * One board.
 *
 * `metricsByKey` is optional; without it the habit and conversion call-outs are
 * left off rather than guessed at.
 */
export function growthBoard({ creators, metricsByKey = new Map(), asOf, store = null, config = {} }) {
  const cfg = config.growthBoard ?? {};
  const prior = cfg.priorWeight ?? 25;
  const minComparable = cfg.minComparable ?? 3;
  const habitTarget = config.growth?.liveDaysTarget ?? 15;
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));

  const month = asOf.slice(0, 7);
  const prev = previousMonth(month);
  const prevName = new Date(`${prev}-01T00:00:00Z`)
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const dayOfMonth = Number(asOf.slice(8, 10));
  const monthLength = daysInMonth(month);
  // Last month, prorated to the same point. A board on the 20th compares 20
  // days against 20 days' worth, not against a whole month.
  const scale = Math.min(1, dayOfMonth / daysInMonth(prev));

  const byCoach = new Map();
  for (const c of creators) {
    if (c.quitOn || ignored.has(groupKey(c.group))) continue;
    // Off the boards means off them entirely: out of the rows, out of the
    // call-outs, and out of the network figure everyone else is ranked against.
    if (offTheBoards(c.manager, config)) continue;
    const key = c.manager ?? 'unassigned';
    const e = byCoach.get(key) ?? {
      coach: key, name: coachName(key, config),
      roster: 0, earning: 0, comparable: 0,
      // `now` is the whole team, for context. `comparableNow` is the only
      // figure the growth ratio may use — see below.
      now: 0, comparableNow: 0, thenPace: 0, habit: 0, teams: new Set(),
    };
    e.roster++;
    if (c.group) e.teams.add(c.group);

    const now = monthMtd(c, month)?.diamonds ?? 0;
    const then = monthMtd(c, prev)?.diamonds ?? 0;
    e.now += now;
    if (now > 0) {
      e.earning++;
      if ((metricsByKey.get(c.key)?.activeDays28 ?? 0) >= habitTarget) e.habit++;
    }
    // Both sides of the ratio have to be the same creators. Setting the whole
    // team's September against only the comparable creators' August reads as
    // explosive growth that is really just the creators who are new.
    if (then > 0) { e.comparable++; e.comparableNow += now; e.thenPace += then * scale; }
    byCoach.set(key, e);
  }

  const all = [...byCoach.values()].map((e) => ({
    ...e,
    teams: [...e.teams],
    growth: e.thenPace > 0 ? (e.comparableNow - e.thenPace) / e.thenPace : null,
    habitRate: e.earning ? e.habit / e.earning : null,
    earningRate: e.roster ? e.earning / e.roster : null,
  }));

  // The network's own growth is the prior. A coach with thin evidence is
  // assumed to be doing what the network is doing until they prove otherwise.
  const totalNow = all.reduce((n, e) => n + e.comparableNow, 0);
  const totalThen = all.reduce((n, e) => n + e.thenPace, 0);
  const network = totalThen > 0 ? (totalNow - totalThen) / totalThen : 0;

  const ranked = all
    .filter((e) => e.growth != null && e.comparable >= minComparable)
    .map((e) => ({
      ...e,
      weighted: (e.comparable * e.growth + prior * network) / (e.comparable + prior),
      // Flagged on the card, because a reader should be told when a number is
      // built on five creators rather than a hundred. This is a much lower bar
      // than the prior weight: twenty-odd creators is a real team, it just
      // carries less evidence than two hundred.
      thin: e.comparable < (cfg.thinBelow ?? 10),
    }))
    .sort((a, b) => b.weighted - a.weighted);

  const previous = store?.data?.growthBoard?.month === month ? store.data.growthBoard : null;
  const rows = ranked.map((e, i) => {
    const rank = i + 1;
    const was = previous?.ranks?.[e.coach] ?? null;
    return { ...e, rank, move: was == null ? null : was - rank, isNew: previous != null && was == null };
  });

  const best = (key) => all.filter((e) => e[key] != null && e.earning >= minComparable)
    .sort((a, b) => b[key] - a[key])[0] ?? null;

  return {
    month, prev, prevName, asOf, dayOfMonth, monthLength,
    daysLeft: Math.max(0, monthLength - dayOfMonth),
    network,
    networkNow: Math.round(totalNow),
    networkThen: Math.round(totalThen),
    rows,
    // Two scale-free call-outs that are about coaching rather than roster size.
    bestHabit: best('habitRate'),
    bestConversion: best('earningRate'),
    habitTarget,
    // Coaches with too little in both months to rank. Named so nobody thinks
    // they were dropped.
    unranked: all.filter((e) => e.growth == null || e.comparable < minComparable)
      .map((e) => e.name),
  };
}

/** Remember today's order, so tomorrow's board can show the movement. */
export function recordGrowthBoard(store, board) {
  store.data.growthBoard = {
    month: board.month,
    on: board.asOf,
    ranks: Object.fromEntries(board.rows.map((r) => [r.coach, r.rank])),
  };
}

/** Posted once a day, and only once. */
export function growthBoardDue(config, store, asOf) {
  if (config.growthBoard?.enabled === false) return false;
  return store.data.lastGrowthBoardOn !== asOf;
}
