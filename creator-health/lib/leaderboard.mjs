// The monthly new-creator leaderboard.
//
// A recruit is a creator whose join date falls inside the current calendar
// month, credited to their Creator Network manager. The export carries no
// separate "recruiter" column, so the manager is the proxy — which is also the
// person who has to make the recruit work, so crediting them is the right
// incentive anyway.
//
// It resets on the 1st, like everything else TikTok measures.
//
// Volume is the rank, because that is the competition. But volume alone is the
// wrong thing to optimise, and this system already knows why: recruiting forty
// creators who never go LIVE produces forty activation cases and moves nothing.
// So every row carries how many of that month's recruits actually started, and
// the board reports the network's own conversion beside the totals. A coach who
// signs ten and starts nine is beating a coach who signs twenty and starts six,
// and the board should let anyone see that without being told.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';
import { coachName, offTheBoards } from './coaches.mjs';

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

const previousMonth = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const joinedIn = (c, month) => Boolean(c.joinDate) && c.joinDate.slice(0, 7) === month;

/** One recruit, with whether they have actually got going. */
function recruitRow(c, month) {
  const mtd = monthMtd(c, month);
  return {
    username: c.username,
    group: c.group ?? null,
    coach: c.manager ?? null,
    joinDate: c.joinDate,
    diamonds: Math.round(mtd?.diamonds ?? 0),
    liveDays: Math.round(mtd?.validLiveDays ?? 0),
    // "Started" is the only honest test of a recruit this early: they went LIVE.
    // Earning is the better test, but a creator who signed on the 28th has not
    // had time, and penalising their coach for the calendar is nonsense.
    started: (mtd?.validLiveDays ?? 0) > 0,
    earning: (mtd?.diamonds ?? 0) > 0,
  };
}

/**
 * The board.
 *
 * `previous` is the ranking as it stood when this was last posted, which is how
 * a daily post earns its place: the movement is the news, not the totals.
 */
export function leaderboard({ creators, asOf, store = null, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const month = asOf.slice(0, 7);
  const prevMonthKey = previousMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const monthLength = daysInMonth(month);

  // Teams nobody coaches are partner agencies, not LEAP coaches competing, and
  // some individuals are in the network without being in the competition.
  // Filtered here rather than when the rows are built, so every total on the
  // card adds up to the rows printed under it.
  const mine = creators.filter((c) =>
    !ignored.has(groupKey(c.group)) && !offTheBoards(c.manager, config));
  const recruits = mine.filter((c) => joinedIn(c, month)).map((c) => recruitRow(c, month));

  const byCoach = new Map();
  for (const r of recruits) {
    const key = r.coach ?? 'unassigned';
    const e = byCoach.get(key) ?? {
      coach: key, name: coachName(key, config), count: 0, started: 0, earning: 0,
      diamonds: 0, teams: new Set(), best: null,
    };
    e.count++;
    if (r.started) e.started++;
    if (r.earning) e.earning++;
    e.diamonds += r.diamonds;
    if (r.group) e.teams.add(r.group);
    if (!e.best || r.diamonds > e.best.diamonds) e.best = r;
    byCoach.set(key, e);
  }

  const previous = store?.data?.leaderboard?.month === month
    ? store.data.leaderboard : null;

  const rows = [...byCoach.values()]
    .map((e) => ({ ...e, teams: [...e.teams] }))
    // Volume is the competition. Ties break on who started more of them, which
    // is the tiebreak that points the right way.
    .sort((a, b) => b.count - a.count || b.started - a.started || b.diamonds - a.diamonds)
    .map((e, i) => {
      const rank = i + 1;
      const was = previous?.ranks?.[e.coach] ?? null;
      return {
        ...e,
        rank,
        // Positive means climbed. Null means they were not on the last board.
        move: was == null ? null : was - rank,
        gained: previous?.counts?.[e.coach] != null ? e.count - previous.counts[e.coach] : null,
        isNew: previous != null && was == null,
      };
    });

  const byTeam = new Map();
  for (const r of recruits) {
    const key = r.group ?? 'Not in a group';
    const e = byTeam.get(key) ?? { team: key, count: 0, started: 0 };
    e.count++;
    if (r.started) e.started++;
    byTeam.set(key, e);
  }

  // Same point last month, so "97 this month" has something to mean.
  const lastMonth = mine.filter((c) => joinedIn(c, prevMonthKey));
  const lastToSamePoint = lastMonth.filter((c) => Number(c.joinDate.slice(8, 10)) <= dayOfMonth).length;

  const started = recruits.filter((r) => r.started).length;

  return {
    month, asOf, dayOfMonth, monthLength,
    daysLeft: Math.max(0, monthLength - dayOfMonth),
    total: recruits.length,
    started,
    earning: recruits.filter((r) => r.earning).length,
    startedRate: recruits.length ? started / recruits.length : null,
    lastMonthTotal: lastMonth.length,
    lastToSamePoint,
    change: lastToSamePoint > 0 ? (recruits.length - lastToSamePoint) / lastToSamePoint : null,
    // Recruitment is front-loaded — a third of a month's signings can land on
    // the 1st — so a straight line badly overshoots. Last month had 90 by day
    // 20 and finished on 99; straight-lining the same 90 gives 135. Where we
    // have last month to shape it, project on that instead.
    projected: projectMonth(recruits.length, lastToSamePoint, lastMonth.length, dayOfMonth, monthLength),
    projectedFrom: lastToSamePoint > 0 ? 'last month' : 'pace',
    rows,
    teams: [...byTeam.values()].sort((a, b) => b.count - a.count),
    // The month's best signing, whoever brought them in. A leaderboard of counts
    // says nothing about whether anyone found somebody good.
    standout: recruits.filter((r) => r.diamonds > 0)
      .map((r) => ({ ...r, coachName: coachName(r.coach, config) }))
      .sort((a, b) => b.diamonds - a.diamonds)[0] ?? null,
    // Signed but still not LIVE, newest last: the list the winner has to work.
    notStarted: recruits.filter((r) => !r.started).sort((a, b) => a.joinDate.localeCompare(b.joinDate)),
  };
}

/**
 * Where the month lands.
 *
 * With last month to compare, scale by how much of it had arrived by this same
 * day. Without it, a straight line is all the data supports.
 */
function projectMonth(soFar, lastToSamePoint, lastMonthTotal, dayOfMonth, monthLength) {
  if (lastToSamePoint > 0 && lastMonthTotal > 0) {
    return Math.round(soFar * (lastMonthTotal / lastToSamePoint));
  }
  return dayOfMonth > 0 ? Math.round((soFar / dayOfMonth) * monthLength) : null;
}

/** Remember today's board, so tomorrow's can show the movement. */
export function recordBoard(store, board) {
  store.data.leaderboard = {
    month: board.month,
    on: board.asOf,
    ranks: Object.fromEntries(board.rows.map((r) => [r.coach, r.rank])),
    counts: Object.fromEntries(board.rows.map((r) => [r.coach, r.count])),
  };
}

/** Posted once a day, and only once. */
export function leaderboardDue(config, store, asOf) {
  if (config.leaderboard?.enabled === false) return false;
  return store.data.lastLeaderboardOn !== asOf;
}
