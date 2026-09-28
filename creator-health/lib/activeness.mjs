// The activeness gate, and who is about to miss it.
//
// From the 2026 Fee Policy deck, the rank-up incentive's eligibility line reads
// in full: "Creators who went LIVE for 15 hours on over 7 days that month."
// Both halves, in one calendar month. Miss either and the creator earns the
// network nothing from the rank-up incentive, however many Diamonds they make.
//
// That is a cliff, not a slope, and it resets on the 1st. A creator on 14 hours
// and 7 days on the 29th is worth a phone call; the same creator on the 2nd is
// not worth mentioning. So this is built around the gap AND the days left, and
// the pings are loudest at the end of the month.
//
// Two definitions the deck marks as new for 2026, both of which the export
// already reports for us:
//
//   Valid go LIVE days   days in the month with at least 1 hour of LIVE,
//                        excluding static LIVE streams
//   Valid go LIVE hours  total LIVE duration in the month, excluding static
//                        LIVE streams
//
// Requirements scale for creators who were not in the network for the whole
// month: requirement x (days in CN this month / total days this month). The
// deck's example is a creator who joined on 16 April — 15 of 30 days, so 50%,
// so 10 days and 40 hours instead of the full-month level.
import { monthMtd } from './policy.mjs';

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/**
 * One creator's standing against the gate.
 *
 * `scale` is the pro-rata factor for somebody who joined mid-month. It applies
 * to the requirement, never to what they have actually done.
 */
export function gateFor(creator, asOf, config) {
  if (!creator?.obs?.length) return null;
  const cfg = config.activeness ?? {};
  const reqHours = cfg.hours ?? 15;
  // "over 7 days" is 8 or more, not 7.
  const reqDays = (cfg.days ?? 7) + 1;
  const month = asOf.slice(0, 7);
  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const daysLeft = Math.max(0, monthLength - dayOfMonth);

  const mtd = monthMtd(creator, month);
  if (!mtd) return null;

  // Days in the network this month, for the pro-rata scaling.
  const joinedThisMonth = creator.joinDate && creator.joinDate.slice(0, 7) === month;
  const daysInCN = joinedThisMonth
    ? monthLength - Number(creator.joinDate.slice(8, 10)) + 1
    : monthLength;
  const scale = Math.min(1, daysInCN / monthLength);

  const needHours = Math.round(reqHours * scale * 10) / 10;
  const needDays = Math.ceil(reqDays * scale);
  const hours = mtd.liveHours ?? 0;
  const days = mtd.validLiveDays ?? 0;

  const hoursShort = Math.max(0, needHours - hours);
  const daysShort = Math.max(0, needDays - days);
  const cleared = hoursShort === 0 && daysShort === 0;

  // Can they still do it? Days are the hard constraint — one day is one day,
  // and no amount of streaming makes two. Hours have to fit in the days left at
  // a session length somebody actually does.
  const perDay = cfg.plausibleHoursPerDay ?? 3;
  const reachable = cleared
    || (daysShort <= daysLeft && hoursShort <= daysLeft * perDay);

  return {
    creator,
    username: creator.username,
    group: creator.group ?? null,
    coach: creator.manager ?? null,
    month, daysLeft, dayOfMonth, scale, prorated: scale < 1,
    hours: Math.round(hours * 10) / 10,
    days: Math.round(days),
    needHours, needDays,
    hoursShort: Math.round(hoursShort * 10) / 10,
    daysShort,
    cleared, reachable,
    diamonds: Math.round(mtd.diamonds ?? 0),
    // What the gate is worth to the network for this creator, at the base 4%
    // rank-up ratio. Only meaningful if they also move a tier, so it is an
    // upper bound and the card says so.
    atStake: Math.round((mtd.diamonds ?? 0) * (config.policy?.rankUpBaseRatio ?? 0.04)),
  };
}

/** Every monitored creator's standing, ignoring teams nobody coaches. */
export function activenessRows({ creators, asOf, config, groupKey }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const g = gateFor(c, asOf, config);
    // A creator who has not been LIVE at all this month is an activation case,
    // not an activeness one. Pinging a coach that someone at zero is "15 hours
    // short" tells them nothing they do not already know.
    if (!g || (g.diamonds === 0 && g.days === 0)) continue;
    rows.push(g);
  }
  return rows;
}

/**
 * Who to ping today.
 *
 * Three things have to be true: they have not cleared it, they still can, and
 * the month is close enough that it is urgent. Everything else is the overview's
 * job — a coach does not need a card about a creator with three weeks to go.
 */
export function activenessPings({ rows, store, asOf, config }) {
  const cfg = config.activeness ?? {};
  const window = cfg.pingWithinDays ?? 7;
  const minDiamonds = cfg.minDiamonds ?? 5000;
  const cap = cfg.maxPingsPerRun ?? 12;
  const month = asOf.slice(0, 7);

  const due = rows.filter((r) => {
    if (r.cleared || !r.reachable || r.daysLeft <= 0) return false;
    // Below this the gate is not what is holding the creator back, and the
    // rank-up bonus it protects is worth a few dozen diamonds.
    if (r.diamonds < minDiamonds) return false;
    // Two reasons to ping. The month is nearly over, or the creator has to go
    // LIVE on very nearly every remaining day — which is urgent whenever it
    // becomes true, not only in the last week.
    const cornered = r.daysShort > 0 && r.daysShort >= r.daysLeft - 1;
    return cornered || r.daysLeft <= window;
  });

  // Once a day per creator, however often the run repeats.
  const fresh = due.filter((r) => store.data.activenessPing?.[month]?.[r.creator.key] !== asOf);

  // Most money first. A channel of twelve cards a coach reads beats ninety-six
  // they scroll past, and the overview carries everyone either way.
  fresh.sort((a, b) => (b.atStake - a.atStake) || (a.daysShort - b.daysShort));
  return fresh.slice(0, cap);
}

export function recordPings(store, asOf, rows) {
  const month = asOf.slice(0, 7);
  store.data.activenessPing ??= {};
  store.data.activenessPing[month] ??= {};
  for (const r of rows) store.data.activenessPing[month][r.creator.key] = asOf;
}

/** The network picture, for the overview channel. */
export function activenessSummary(rows, config) {
  const minDiamonds = config.activeness?.minDiamonds ?? 5000;
  const cleared = rows.filter((r) => r.cleared);
  const open = rows.filter((r) => !r.cleared);
  const reachable = open.filter((r) => r.reachable);
  const lost = open.filter((r) => !r.reachable);
  const byTeam = new Map();
  for (const r of rows) {
    const k = r.group ?? 'Not in a group';
    const e = byTeam.get(k) ?? { team: k, total: 0, cleared: 0, reachable: 0, worthChasing: 0, lost: 0, atStake: 0 };
    e.total++;
    if (r.cleared) e.cleared++;
    else if (r.reachable) {
      e.reachable++;
      e.atStake += r.atStake;
      // The count a coach acts on. A team can have ninety creators who could
      // still clear the gate and only four whose bonus is worth the evening.
      if (r.diamonds >= minDiamonds) e.worthChasing++;
    } else { e.lost++; }
    byTeam.set(k, e);
  }
  return {
    daysLeft: rows[0]?.daysLeft ?? 0,
    month: rows[0]?.month ?? null,
    total: rows.length,
    cleared: cleared.length,
    reachable: reachable.length,
    lost: lost.length,
    // What is still winnable, and what has already gone. Both at the base 4%.
    atStake: reachable.reduce((n, r) => n + r.atStake, 0),
    forfeited: lost.reduce((n, r) => n + r.atStake, 0),
    // One day or one hour short is the cheapest money on the board.
    oneDayShort: open.filter((r) => r.reachable && r.daysShort === 1 && r.diamonds >= minDiamonds)
      .sort((a, b) => b.diamonds - a.diamonds),
    hoursOnly: open.filter((r) => r.reachable && r.daysShort === 0 && r.hoursShort > 0
      && r.diamonds >= minDiamonds)
      .sort((a, b) => b.diamonds - a.diamonds),
    // How much of the "still winnable" pile is actually worth a coach's time.
    worthChasing: open.filter((r) => r.reachable && r.diamonds >= minDiamonds).length,
    minDiamonds,
    teams: [...byTeam.values()].sort((a, b) => b.atStake - a.atStake),
  };
}

/** Posted once a day, and only once. */
export function activenessDue(config, store, asOf) {
  if (config.activeness?.enabled === false) return false;
  return store.data.lastActivenessOn !== asOf;
}
