// Turns a creator's observation list into the rolling windows the rules read.
import { CUMULATIVE_FIELDS } from './store.mjs';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (d) => Date.parse(`${d}T00:00:00Z`);
export const shiftDays = (d, n) => iso(ts(d) + n * DAY);
export const diffDays = (a, b) => Math.round((ts(b) - ts(a)) / DAY);

/**
 * Spread every observation evenly across the days it covers.
 *
 * A daily upload gives span=1 and the allocation is exact. A missed upload gives
 * span=2+ and the two days share the total, which keeps 7- and 28-day windows
 * correct even though the individual days are a guess.
 */
export function allocateDaily(creator) {
  const byDay = new Map();
  for (const o of creator.obs) {
    const share = {};
    for (const f of CUMULATIVE_FIELDS) share[f] = (o.delta[f] ?? 0) / o.span;
    for (let i = 0; i < o.span; i++) {
      const d = shiftDays(o.date, -i);
      const cur = byDay.get(d) ?? { observed: !o.partial && o.span === 1 };
      for (const f of CUMULATIVE_FIELDS) cur[f] = (cur[f] ?? 0) + share[f];
      byDay.set(d, cur);
    }
  }
  return byDay;
}

/** Sum of a field over the `days` days ending on `endDate` inclusive. */
export function windowSum(byDay, endDate, days, field) {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const v = byDay.get(shiftDays(endDate, -i));
    if (v) total += v[field] ?? 0;
  }
  return total;
}

function windowAll(byDay, endDate, days) {
  const out = {};
  for (const f of CUMULATIVE_FIELDS) out[f] = windowSum(byDay, endDate, days, f);
  return out;
}

/** Days of history we actually hold for this creator, capped at `days`. */
function coverage(byDay, endDate, days) {
  let n = 0;
  for (let i = 0; i < days; i++) if (byDay.has(shiftDays(endDate, -i))) n++;
  return n;
}

/**
 * Days in a window that came from a single-day observation.
 *
 * This is the difference between a real comparison and an arithmetic artifact.
 * A snapshot covering fourteen days is spread evenly across them, which totals
 * correctly but flattens every day to the same value. Comparing a week of that
 * against a week of real daily readings produces a swing that says nothing
 * about the creator — so week-on-week rules refuse to fire until both windows
 * are mostly made of days we actually observed.
 */
function exactCoverage(byDay, endDate, days) {
  let n = 0;
  for (let i = 0; i < days; i++) {
    const v = byDay.get(shiftDays(endDate, -i));
    if (v?.observed) n++;
  }
  return n;
}

function previousMonthKey(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Totals per calendar month. Passing a null field counts days instead, which
 * is how we tell a genuinely quiet month from one we simply did not watch.
 */
function monthlyTotals(byDay, field) {
  const out = {};
  for (const [day, v] of byDay) {
    const key = day.slice(0, 7);
    out[key] = (out[key] ?? 0) + (field ? (v[field] ?? 0) : 1);
  }
  return out;
}

/** Everything we hold for one calendar month, with how much of it we saw. */
function monthTotals(byDay, monthKey) {
  const totals = Object.fromEntries(CUMULATIVE_FIELDS.map((f) => [f, 0]));
  let coveredDays = 0;
  for (const [day, v] of byDay) {
    if (!day.startsWith(monthKey)) continue;
    coveredDays++;
    for (const f of CUMULATIVE_FIELDS) totals[f] += v[f] ?? 0;
  }
  return { totals, coveredDays };
}

function daysInMonth(iso) {
  return new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).getUTCDate();
}

function daysInPreviousMonth(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 0)).getUTCDate();
}

/**
 * How long since this field last moved, read from the observations rather than
 * the daily allocation.
 *
 * Spreading a multi-day observation evenly is right for rolling sums but wrong
 * for recency: one match inside a 31-day snapshot becomes "a match every day",
 * and the answer to "when did they last push?" turns into noise. Reading the
 * observations instead gives a real answer, with `exact` false when the
 * observation covers more than a day and we can only bound it.
 */
function lastMovement(creator, endDate, field) {
  for (let i = creator.obs.length - 1; i >= 0; i--) {
    const o = creator.obs[i];
    if (o.date > endDate) continue;
    if ((o.delta[field] ?? 0) > 0) {
      return {
        days: diffDays(o.date, endDate),
        // With a span we only know it happened somewhere in that window.
        earliestDays: diffDays(o.date, endDate) + o.span - 1,
        exact: o.span === 1,
        on: o.date,
      };
    }
  }
  return null;
}

/** Consecutive most-recent days with no valid LIVE day recorded. */
function darkStreak(byDay, endDate, limit = 30) {
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const v = byDay.get(shiftDays(endDate, -i));
    if (!v) break;
    if ((v.validLiveDays ?? 0) > 0.001) break;
    n++;
  }
  return n;
}

/** Weekly totals ending on `endDate`, most recent first. */
function weeklyTotals(byDay, endDate, weeks, field) {
  const totals = [];
  for (let w = 0; w < weeks; w++) {
    const end = shiftDays(endDate, -7 * w);
    if (!byDay.has(end) && !byDay.has(shiftDays(end, -6))) break;
    totals.push(windowSum(byDay, end, 7, field));
  }
  return totals;
}

/**
 * A creator's own normal, and how noisy that normal is.
 *
 * `baseline` deliberately skips the two most recent weeks. A decline that
 * started a month ago has already dragged the recent weeks down with it, so
 * comparing against them hides exactly the problem we are looking for. Weeks
 * 3-8 are the last period we can treat as "how they were before this".
 *
 * `cv` exists because creators differ wildly in steadiness: a -35% week is
 * routine for someone whose income swings with whichever gifter shows up, and
 * alarming for someone who bills like clockwork. Judging each creator against
 * their own variance is what keeps the alert list free of people who are fine.
 */
function profile(byDay, endDate, field) {
  const totals = weeklyTotals(byDay, endDate, 8, field);
  if (totals.length < 3) return null;
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const older = totals.slice(2);
  const baseline = older.length >= 2 ? older.reduce((a, b) => a + b, 0) / older.length : null;
  if (mean <= 0) return { mean, sd: 0, cv: null, baseline, weeks: totals.length };
  const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (totals.length - 1);
  return { mean, sd: Math.sqrt(variance), cv: Math.sqrt(variance) / mean, baseline, weeks: totals.length };
}

function levelAt(creator, endDate, daysBack) {
  // Levels are point-in-time, so walk back to the nearest snapshot at or before
  // the target day rather than interpolating.
  const target = shiftDays(endDate, -daysBack);
  let best = null;
  for (const d of Object.keys(creator.levels)) {
    if (d <= target && (!best || d > best)) best = d;
  }
  return best ? creator.levels[best] : null;
}

const pctChange = (now, before) => {
  if (before == null || before === 0) return now > 0 ? null : 0;
  return (now - before) / before;
};

/**
 * Everything the rules need for one creator on one as-of date.
 * `curr7` vs `prev7` is the decline signal; the 28-day windows set the tier and
 * the run-rates; the level deltas expose fan-club erosion.
 */
export function computeMetrics(creator, endDate) {
  const byDay = allocateDaily(creator);
  const observedDays = [...byDay.entries()].filter(([, v]) => v.observed).length;
  const curr7 = windowAll(byDay, endDate, 7);
  const prev7 = windowAll(byDay, shiftDays(endDate, -7), 7);
  const curr14 = windowAll(byDay, endDate, 14);
  const curr28 = windowAll(byDay, endDate, 28);
  const prev28 = windowAll(byDay, shiftDays(endDate, -28), 28);

  // Month on month, prorated.
  //
  // Comparing month-to-date on the 8th against a full previous month would read
  // as a 70% collapse for a creator doing exactly what they always do, so the
  // previous month is scaled to the same point in the month before comparing.
  //
  // Two sources, in order of preference: the previous month accrued from our own
  // snapshots, which is exact and lets us compare any two months; or the
  // export's own "last month" columns, which are all that exist before this tool
  // has seen a full month go by.
  const lastObsForMonth = creator.obs[creator.obs.length - 1] ?? null;
  const monthOnMonth = (() => {
    if (!lastObsForMonth) return null;
    const dayOfMonth = Number(endDate.slice(8, 10));
    const prevMonth = previousMonthKey(endDate);
    const prevDays = daysInPreviousMonth(endDate);
    const scale = Math.min(1, dayOfMonth / prevDays);
    const observed = monthTotals(byDay, prevMonth);
    const hasObserved = observed.coveredDays >= prevDays * 0.8;

    const build = (field, exportedTotal) => {
      const total = hasObserved ? observed.totals[field] : exportedTotal;
      if (total == null) return null;
      const pace = total * scale;
      const now = lastObsForMonth.mtd?.[field] ?? 0;
      return {
        monthToDate: Math.round(now * 100) / 100,
        lastMonthTotal: Math.round(total * 100) / 100,
        lastMonthToSamePoint: Math.round(pace * 100) / 100,
        change: pace > 0 ? (now - pace) / pace : null,
        projectedMonth: dayOfMonth > 0 ? Math.round((now / dayOfMonth) * daysInMonth(endDate)) : null,
        source: hasObserved ? 'observed' : 'export',
      };
    };
    return {
      dayOfMonth,
      previousMonth: prevMonth,
      diamonds: build('diamonds', creator.lastMonth?.diamonds ?? null),
      liveHours: build('liveHours', creator.lastMonth?.liveHours ?? null),
      validLiveDays: build('validLiveDays', creator.lastMonth?.validLiveDays ?? null),
      newFollowers: build('newFollowers', creator.lastMonth?.newFollowers ?? null),
    };
  })();

  const fansNow = levelAt(creator, endDate, 0);
  const fans7 = levelAt(creator, endDate, 7);
  const fans14 = levelAt(creator, endDate, 14);

  const activeDays28 = curr28.validLiveDays;
  const lastObs = creator.obs[creator.obs.length - 1] ?? null;

  return {
    endDate,
    historyDays: coverage(byDay, endDate, 28),
    // Days we have an exact daily reading for, as opposed to days covered only
    // by a multi-day span. Coarse coverage still totals correctly but cannot
    // answer questions about individual days.
    exactDays: observedDays,
    exact: {
      curr7: exactCoverage(byDay, endDate, 7),
      prev7: exactCoverage(byDay, shiftDays(endDate, -7), 7),
      curr28: exactCoverage(byDay, endDate, 28),
    },
    hasFullPrev7: coverage(byDay, shiftDays(endDate, -7), 7) >= 5,
    curr7, prev7, curr14, curr28, prev28,
    change7: Object.fromEntries(
      CUMULATIVE_FIELDS.map((f) => [f, pctChange(curr7[f], prev7[f])]),
    ),
    darkStreak: darkStreak(byDay, endDate),
    profile: {
      diamonds: profile(byDay, endDate, 'diamonds'),
      liveHours: profile(byDay, endDate, 'liveHours'),
      validLiveDays: profile(byDay, endDate, 'validLiveDays'),
    },
    // Efficiency and intensity: the two levers a coach can actually pull.
    diamondsPerHour28: curr28.liveHours > 0.5 ? curr28.diamonds / curr28.liveHours : null,
    diamondsPerHour7: curr7.liveHours > 0.5 ? curr7.diamonds / curr7.liveHours : null,
    hoursPerActiveDay28: activeDays28 > 0 ? curr28.liveHours / activeDays28 : null,
    activeDays28,
    activeDays7: curr7.validLiveDays,
    dailyDiamonds7: curr7.diamonds / 7,
    dailyDiamonds28: curr28.diamonds / 28,
    fanClub: {
      activeFans: fansNow?.activeFanClubFans ?? null,
      activeFansChange7: pctChange(fansNow?.activeFanClubFans, fans7?.activeFanClubFans),
      activeFansChange14: pctChange(fansNow?.activeFanClubFans, fans14?.activeFanClubFans),
      totalFans: fansNow?.totalFans ?? null,
      totalFansChange14: pctChange(fansNow?.totalFans, fans14?.totalFans),
      contribution: fansNow?.fanContribution ?? null,
      diamondsChange7: pctChange(curr7.fanClubDiamonds, prev7.fanClubDiamonds),
      share7: curr7.diamonds > 0 ? curr7.fanClubDiamonds / curr7.diamonds : null,
    },
    monthOnMonth,
    // Per calendar month, because the 200k target is a monthly one: a creator
    // has to land 200,000 inside a single month, not accumulate it over three.
    monthlyDiamonds: monthlyTotals(byDay, 'diamonds'),
    monthlyCoverage: monthlyTotals(byDay, null),
    // Campaign participation. Coaches ask "when did they last push?" — this is
    // the answer, plus how much of their income it is worth.
    lastMatch: lastMovement(creator, endDate, 'matches'),
    lastMultiGuest: lastMovement(creator, endDate, 'diamondsFromMultiGuest'),
    matches28: Math.round(curr28.matches),
    matches7: Math.round(curr7.matches),
    diamondsFromMatches28: Math.round(curr28.diamondsFromMatches),
    matchShare28: curr28.diamonds > 0 ? curr28.diamondsFromMatches / curr28.diamonds : null,
    daysSinceJoining: fansNow?.daysSinceJoining
      ?? (creator.joinDate ? diffDays(creator.joinDate, endDate) : null),
    lastObsPartial: lastObs?.partial ?? true,
    stale: lastObs ? diffDays(lastObs.date, endDate) : null,
  };
}

/** Bucket by recent output. Thresholds are per 28 days. */
export function tierOf(metrics, tiers) {
  const d = metrics.curr28.diamonds;
  if (d >= tiers.core) return 'core';
  if (d >= tiers.growing) return 'growing';
  if (d >= tiers.emerging) return 'emerging';
  return 'dormant';
}
