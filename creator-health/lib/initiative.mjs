// The LEAP Initiative: what a new creator has to do, and whether they did it.
//
// Three requirements, spread across a creator's first 90 days:
//
//   LIVE within 7 days        they have started at all
//   LIVE on 10 days in 30     they have a habit, not a one-off
//   10,000 diamonds in 90     they can earn
//
// And one rule that overrides the rest: pass 10,000 diamonds at ANY point and
// the 90 days end there. They become a Creator, the 10-day requirement stops
// applying, and they leave the zone. A creator who goes hard in week one never
// has to think about the clock again, so the system should not keep counting
// at them either.
//
// WHY THIS IS SEPARATE FROM EVERYTHING ELSE THAT WATCHES NEW CREATORS.
// Three things already look at this population and none of them is this:
// activation asks whether they earned 100 diamonds, leaped asks whether their
// lifetime totals cleared 5 hours and 5,000, and ramp asks whether they landed
// 200,000 in a calendar month. Those are a health check, a recruit bonus and a
// growth target. This is the membership rule, and it is the only one of the
// four that ends with somebody leaving the network.
//
// WHAT WE CANNOT KNOW. The requirements run on WINDOWS FROM THE JOIN DATE, not
// on calendar months, so they need daily history from the day a creator
// signed. This system started watching on 31 August. For anyone who joined
// before that the 7-day and 30-day tests cannot be rebuilt, and they are
// reported as `unknown` rather than guessed at. A creator is never failed on
// evidence we do not hold.
import { monthMtd } from './policy.mjs';
import { coachName } from './coaches.mjs';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => iso(ts(d) + n * DAY);
const between = (a, b) => Math.round((ts(b) - ts(a)) / DAY);
const daysInMonth = (key) =>
  new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const monthOf = (d) => d.slice(0, 7);
const nextMonth = (key) => {
  const y = Number(key.slice(0, 4)); const m = Number(key.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

export const RULES = {
  firstLiveWithinDays: 7,
  liveDaysWithinDays: 30,
  liveDaysNeeded: 10,
  diamondsWithinDays: 90,
  diamondsNeeded: 10000,
};

const rulesOf = (config) => ({ ...RULES, ...(config?.initiative ?? {}) });

/**
 * A counter accrued over a window that may cross month boundaries.
 *
 * The export resets every counter on the 1st, so a window from the 20th of one
 * month to the 19th of the next is two part-months added together, each one
 * measured from where it stood the day before the window opened.
 */
export function accruedBetween(creator, start, end, field) {
  if (!creator?.obs?.length || !start || !end || end < start) return 0;
  let total = 0;
  for (let key = monthOf(start); key <= monthOf(end); key = nextMonth(key)) {
    const monthStart = `${key}-01`;
    const monthEnd = `${key}-${String(daysInMonth(key)).padStart(2, '0')}`;
    const from = start > monthStart ? start : monthStart;
    const to = end < monthEnd ? end : monthEnd;
    const at = monthMtd(creator, to)?.[field];
    if (at == null) continue;
    // Opening mid-month means subtracting what they had already done that
    // month before the window began. Opening on the 1st means there is
    // nothing to subtract, and asking for the day before would reach into
    // the previous month's counter.
    const base = from === monthStart ? 0 : (monthMtd(creator, addDays(from, -1))?.[field] ?? 0);
    total += Math.max(0, at - base);
  }
  return total;
}

/** The first day inside the window on which they went LIVE, if they did. */
export function firstLiveDate(creator, start, end) {
  for (const o of creator?.obs ?? []) {
    if (o.date < start || o.date > end) continue;
    if (accruedBetween(creator, start, o.date, 'validLiveDays') >= 1) return o.date;
  }
  return null;
}

const PASS = 'passed';
const FAIL = 'failed';
const PENDING = 'pending';
const UNKNOWN = 'unknown';

/**
 * Where one creator stands against all three requirements.
 *
 * `watchFrom` is the earliest day of data we hold. A requirement whose window
 * opened before it is reported as unknown: the creator is not failed on a
 * window nobody watched.
 */
export function assess(creator, asOf, { config = {}, watchFrom = null } = {}) {
  const r = rulesOf(config);
  const join = creator?.joinDate;
  if (!join) return null;
  const age = between(join, asOf);
  const blind = watchFrom != null && join < watchFrom;

  const diamonds = accruedBetween(creator, join, asOf, 'diamonds');
  const graduated = diamonds >= r.diamondsNeeded;

  const req = (key, label, deadlineDays, met, detail) => {
    const deadline = addDays(join, deadlineDays);
    const daysLeft = between(asOf, deadline);
    // Graduating clears whatever is still open. The policy ends the 90 days
    // there and then, so nothing outstanding can still be failed.
    const state = met ? PASS
      : graduated ? PASS
        : blind && key !== 'diamonds' ? UNKNOWN
          : daysLeft < 0 ? FAIL : PENDING;
    return { key, label, deadline, daysLeft, state, ...detail };
  };

  const liveDays30 = accruedBetween(creator, join, addDays(join, r.liveDaysWithinDays), 'validLiveDays');
  const liveDaysNow = accruedBetween(creator, join, asOf, 'validLiveDays');
  const first = firstLiveDate(creator, join, asOf);
  const daysLeft30 = between(asOf, addDays(join, r.liveDaysWithinDays));
  const stillNeeded = Math.max(0, r.liveDaysNeeded - Math.min(liveDays30, liveDaysNow));

  const reqs = [
    req('firstLive', `LIVE within ${r.firstLiveWithinDays} days`, r.firstLiveWithinDays,
      first != null && between(join, first) <= r.firstLiveWithinDays,
      { firstLive: first }),
    req('liveDays', `LIVE on ${r.liveDaysNeeded} days in ${r.liveDaysWithinDays}`, r.liveDaysWithinDays,
      Math.min(liveDays30, liveDaysNow) >= r.liveDaysNeeded,
      { done: Math.round(Math.min(liveDays30, liveDaysNow)), needed: r.liveDaysNeeded, stillNeeded,
        // More days needed than there are days left is already lost, whatever
        // the deadline says. Saying so early is the difference between a
        // warning and a post-mortem.
        impossible: stillNeeded > Math.max(0, daysLeft30) }),
    req('diamonds', `${r.diamondsNeeded.toLocaleString('en-GB')} diamonds in ${r.diamondsWithinDays}`,
      r.diamondsWithinDays, graduated,
      { done: Math.round(diamonds), needed: r.diamondsNeeded,
        stillNeeded: Math.max(0, r.diamondsNeeded - Math.round(diamonds)) }),
  ];

  const failed = reqs.filter((x) => x.state === FAIL);
  const pending = reqs.filter((x) => x.state === PENDING);
  const soonest = pending.length ? Math.min(...pending.map((x) => x.daysLeft)) : null;
  const doomed = pending.some((x) => x.impossible);

  const status = graduated ? 'passed'
    : failed.length ? 'failed'
      : doomed ? 'failing'
        : reqs.some((x) => x.state === UNKNOWN) && !pending.length ? 'unknown'
          : soonest != null && soonest <= 7 ? 'at risk'
            : 'on track';

  return {
    key: creator.key, username: creator.username, group: creator.group ?? null,
    coach: creator.manager ?? null, name: coachName(creator.manager, config),
    joinDate: join, ageDays: age, blind,
    diamonds: Math.round(diamonds), liveDays: Math.round(liveDaysNow), firstLive: first,
    graduated, graduatedOn: graduated ? (firstPast(creator, join, asOf, r.diamondsNeeded) ?? null) : null,
    reqs, status, soonestDeadline: soonest,
  };
}

/** The day their running total first crossed the bar, for the record. */
function firstPast(creator, join, asOf, needed) {
  for (const o of creator?.obs ?? []) {
    if (o.date < join || o.date > asOf) continue;
    if (accruedBetween(creator, join, o.date, 'diamonds') >= needed) return o.date;
  }
  return null;
}

/**
 * The New Creator Zone: everyone currently measured against the Initiative.
 *
 * Scoped by how recently they joined rather than by their 90-day window,
 * because the early requirements need daily history and we only have it from
 * 31 August. Widen `zoneDays` towards 90 as the history grows.
 */
export function newCreatorZone({ creators, asOf, config = {} }) {
  const cfg = config.initiative ?? {};
  if (cfg.enabled === false) return null;
  const zoneDays = cfg.zoneDays ?? 30;
  const r = rulesOf(config);
  const watchFrom = creators.reduce((min, c) => {
    const first = c.obs?.length ? c.obs[0].date : null;
    return first && (!min || first < min) ? first : min;
  }, null);

  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (!c.joinDate) continue;
    const age = between(c.joinDate, asOf);
    if (age < 0 || age > zoneDays) continue;
    const row = assess(c, asOf, { config, watchFrom });
    if (row) rows.push(row);
  }

  const order = { failed: 0, failing: 1, 'at risk': 2, 'on track': 3, unknown: 4, passed: 5 };
  rows.sort((a, b) => (order[a.status] - order[b.status])
    || ((a.soonestDeadline ?? 999) - (b.soonestDeadline ?? 999))
    || a.username.localeCompare(b.username));

  const by = (s) => rows.filter((x) => x.status === s);
  return {
    asOf, zoneDays, watchFrom, rules: r,
    rows,
    passed: by('passed'),
    summary: {
      total: rows.length,
      passed: by('passed').length,
      failed: by('failed').length,
      failing: by('failing').length,
      atRisk: by('at risk').length,
      onTrack: by('on track').length,
      unknown: by('unknown').length,
    },
  };
}
