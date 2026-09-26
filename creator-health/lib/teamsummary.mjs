// The daily picture of one team, written for the coach who runs it.
//
// The rest of the system is a queue of individual problems. This is the other
// half: where the team stands this month, who is worth leaning into, and the
// one habit that actually separates the creators who grow from the ones who do
// not. A coach reads it once in the morning and knows where to spend the day.
//
// The benchmark in `growth` is not a guess. Measured across LEAP's own 415
// earning creators, comparing each one's September to the same point in August:
//
//   LIVE days in 28    n     grew        median change
//   under 5           89     19%         -100%
//   5-10              73     32%          -57%
//   10-15             92     42%          -20%
//   15-20             75     64%          +50%
//   20-25             52     56%          +18%
//   25-28             27     52%          +16%
//
// Fifteen LIVE days in 28 is where the network turns from shrinking to growing,
// and going past twenty adds nothing. Hours per active day barely moved between
// the two halves (3.2 against 2.9), so it is how often they go live, not how
// long they stay — which is a different conversation to have with a creator.
//
// The fan club says it first: creators whose active fan club grew more than 10%
// in a fortnight went on to grow their diamonds 66% of the time, against 31%
// for everyone else. It moves before the money does, so it is the earliest
// thing a coach can act on.
//
// Two things that look like levers are not. Doing a match made no measurable
// difference (42% grew, against 42% for those who did none), and neither did
// multi-guest (42% against 42%). They may still be worth running for reasons
// this export cannot see, but nothing here supports pushing them as a way to
// grow, so the summary reports participation and makes no claim about it.
import { groupKey } from './notify.mjs';
import { isOpen } from './cases.mjs';
import { graduationLadder } from './graduation.mjs';

const num = (x) => (Number.isFinite(x) ? x : 0);

/** Diamonds this month, and the same point last month, for one creator. */
function monthPair(m) {
  const d = m?.monthOnMonth?.diamonds;
  if (!d) return { toDate: num(m?.curr28?.diamonds), lastToSamePoint: null, change: null };
  return { toDate: num(d.monthToDate), lastToSamePoint: d.lastMonthToSamePoint, change: d.change };
}

/**
 * One row per creator, with everything the summary sorts on.
 *
 * `potential` is deliberately not a score out of ten. A coach cannot act on a
 * score; they can act on "this one is 7,000 a day short of 200k and doing
 * 5,600", so every list below carries the numbers it was sorted by.
 */
function rowsFor(creators, metricsByKey, config) {
  const target = config.growth?.liveDaysTarget ?? 15;
  const fanClubUp = config.growth?.fanClubUp ?? 0.10;
  // Percentages off a tiny base are arithmetic, not news: a creator going from
  // 40 diamonds to 4,900 is "+12,000%", which tells a coach nothing and makes
  // the whole card look automated. Below this the move is quoted in diamonds.
  const minBase = config.growth?.minBaseForPercent ?? 5000;
  const minFans = config.growth?.minFanClub ?? 10;
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    const month = monthPair(m);
    const fanChange = m.fanClub?.activeFansChange14;
    rows.push({
      creator: c,
      username: c.username,
      metrics: m,
      monthToDate: month.toDate,
      lastMonthToSamePoint: month.lastToSamePoint,
      change: month.change,
      liveDays28: num(m.activeDays28),
      meetsFrequency: num(m.activeDays28) >= target,
      perDay7: num(m.dailyDiamonds7),
      diamondsPerHour: m.diamondsPerHour28,
      fanClubActive: m.fanClub?.activeFans ?? null,
      fanClubChange: Number.isFinite(fanChange) ? fanChange : null,
      fanClubClimbing: Number.isFinite(fanChange) && fanChange > fanClubUp,
      // Enough of a fan club, and enough money, for a percentage to mean
      // something. Creators below this are the activation channel's job.
      substantial: (m.fanClub?.activeFans ?? 0) >= minFans
        && Math.max(month.toDate, num(month.lastToSamePoint)) >= minBase,
      // Quote a change as a percentage only where the base can carry one.
      quotable: num(month.lastToSamePoint) >= minBase,
      earning: month.toDate > 0,
    });
  }
  return rows;
}

/** Days left in the calendar month, which is the clock the 200k target runs on. */
function daysLeftInMonth(asOf) {
  const dayOfMonth = Number(asOf.slice(8, 10));
  const monthLength = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 0)).getUTCDate();
  return Math.max(0, monthLength - dayOfMonth);
}

/**
 * The daily summary for every team, keyed by team name.
 *
 * Teams the network is not coaching are left out, the same rule the cases and
 * the weekly roster use.
 */
export function teamSummaries({ creators, metricsByKey, store, asOf, config, graduation = [] }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const target = config.growth?.liveDaysTarget ?? 15;
  const topN = config.growth?.topPerSection ?? 5;

  const openByKey = new Map();
  for (const c of store.all()) {
    if (c.kind === 'decline' && isOpen(c)) openByKey.set(c.creatorKey, c);
  }

  const byTeam = new Map();
  for (const r of rowsFor(creators, metricsByKey, config)) {
    if (ignored.has(groupKey(r.creator.group))) continue;
    const key = r.creator.group ?? 'Not in a group';
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(r);
  }

  const out = new Map();
  for (const [team, rows] of byTeam) {
    const earning = rows.filter((r) => r.earning);
    const toDate = earning.reduce((n, r) => n + r.monthToDate, 0);
    // Only creators we can place in both months count towards the comparison,
    // so a team does not look like it collapsed because half of it is new.
    const comparable = earning.filter((r) => r.lastMonthToSamePoint != null);
    const lastToSamePoint = comparable.reduce((n, r) => n + r.lastMonthToSamePoint, 0);
    // Both sides of the comparison have to be the same creators. Setting the
    // whole team's total against a subset's last month reads as a huge rise
    // that is really just the creators who were not here in August.
    const comparableToDate = comparable.reduce((n, r) => n + r.monthToDate, 0);

    const slipping = earning
      .filter((r) => openByKey.has(r.creator.key))
      .map((r) => ({ ...r, caseId: openByKey.get(r.creator.key).id }))
      .sort((a, b) => num(a.change) - num(b.change));

    out.set(team, {
      team,
      asOf,
      roster: {
        total: rows.length,
        earning: earning.length,
        meetingFrequency: earning.filter((r) => r.meetsFrequency).length,
        target,
      },
      month: {
        toDate,
        comparableToDate,
        lastToSamePoint: comparable.length ? lastToSamePoint : null,
        change: lastToSamePoint > 0 ? (comparableToDate - lastToSamePoint) / lastToSamePoint : null,
        comparable: comparable.length,
        previousMonth: rows.find((r) => r.metrics.monthOnMonth)?.metrics.monthOnMonth.previousMonth ?? null,
      },
      top: [...earning].sort((a, b) => b.monthToDate - a.monthToDate).slice(0, topN),
      daysLeft: daysLeftInMonth(asOf),
      // The earliest thing a coach can lean into: fan club climbing, and the
      // money already following it. `substantial` keeps a fan club that went
      // from one member to two out of it — a 100% rise that means nothing.
      rising: earning
        .filter((r) => r.substantial && r.fanClubClimbing && num(r.change) > 0)
        .sort((a, b) => b.monthToDate - a.monthToDate)
        .slice(0, topN),
      // Climbing fan club, money not moved yet. These are the ones to push now,
      // because the thing that predicts growth is already happening.
      readyToPush: earning
        .filter((r) => r.substantial && r.fanClubClimbing && num(r.change) <= 0)
        .sort((a, b) => b.monthToDate - a.monthToDate)
        .slice(0, topN),
      slipping: slipping.slice(0, topN),
      slippingTotal: slipping.length,
      // The 200k chase for creators still inside their 90 days, which is a
      // different population from the team's earners and has its own clock.
      graduation: graduationLadder(graduation, team),
      // The habit, not a person: how much of the team is live often enough.
      frequency: {
        target,
        meeting: earning.filter((r) => r.meetsFrequency).length,
        below: earning.filter((r) => !r.meetsFrequency).length,
        // Named so the coach has somewhere to start, biggest earner first: a
        // creator already making money on three days a week is the cheapest
        // growth on the team.
        closest: earning
          .filter((r) => !r.meetsFrequency && r.liveDays28 >= target - 7)
          .sort((a, b) => b.monthToDate - a.monthToDate)
          .slice(0, topN),
      },
    });
  }
  return out;
}

/** Posted once a day, and only once, however often the run is repeated. */
export function teamSummaryDue(config, store, asOf) {
  if (config.growth?.enabled === false) return false;
  return store.data.lastTeamSummaryOn !== asOf;
}
