// The 200k graduation chase.
//
// What the rule actually is, confirmed against TikTok's own Backstage figures
// rather than inferred. Graduation progress is the CURRENT CALENDAR MONTH's
// diamonds against 200,000. It resets to zero on the 1st.
//
// The check that settles it: on 20 September, @gibboooo14's month-to-date was
// 87,519 and Backstage showed 87,525 — the same number. That creator's August
// total was 359,386, so a cumulative or best-ever reading would have shown them
// long since graduated. And across the eight creators readable from the
// Backstage screenshot, every figure sits just above that creator's 20
// September month-to-date, six days earlier. Counting our own cohort the same
// way gives 2 creators past 200,000 this month, which is exactly the "2 Reached
// graduation" Backstage reports.
//
// A creator gets up to three of these monthly attempts, because the 90-day
// window spans three calendar months — which is what `ramp.mjs` models. Missing
// September is not missing the target; it is missing one of three goes at it.
//
// TikTok's own deck (Creator Network Policies & Rules 2026) states the rest:
// the assessment cycle is a full calendar month, the "rookie" identity is gone,
// a creator who exits does not count against the calculation, and the network's
// own graduation RATE sets its benefits tier (Low / Mid / High), with priority
// support and premium invitations at High.

/**
 * The ladder, in diamonds still to find.
 *
 * Coarse at the top and fine at the bottom on purpose: 100,000 off with three
 * weeks to go is a plan, 10,000 off with three days to go is a phone call.
 */
export const MILESTONES = [
  { key: 'M100K', remaining: 100000, label: '100,000 to go' },
  { key: 'M50K', remaining: 50000, label: '50,000 to go' },
  { key: 'M25K', remaining: 25000, label: '25,000 to go' },
  { key: 'M10K', remaining: 10000, label: '10,000 to go' },
  { key: 'DONE', remaining: 0, label: 'Graduated' },
];

const monthKey = (asOf) => asOf.slice(0, 7);

/** Where one creator stands, in the terms a coach would use. */
export function progressFor(row, config = {}) {
  const target = config.ramp?.targetDiamonds ?? 200000;
  const remaining = Math.max(0, target - row.monthToDate);
  const daysLeft = row.daysLeftInMonth ?? 0;
  const perDay = row.currentPerDay ?? 0;
  const requiredPerDay = daysLeft > 0 ? remaining / daysLeft : null;
  return {
    creator: row.creator,
    username: row.creator.username,
    coach: row.creator.manager ?? null,
    group: row.creator.group ?? null,
    monthToDate: Math.round(row.monthToDate),
    target,
    remaining: Math.round(remaining),
    done: remaining <= 0,
    daysLeft,
    day: row.day,
    month: row.month,
    perDay: Math.round(perDay),
    requiredPerDay: requiredPerDay == null ? null : Math.round(requiredPerDay),
    // How much harder than this week they would have to work to land it.
    stretch: requiredPerDay != null && perDay > 0 ? requiredPerDay / perDay : null,
    // Built from this week's rate, the same rate quoted as "doing". `ramp` also
    // carries a projection, but that one extrapolates the whole month to date,
    // so printing the two side by side has the card contradict itself.
    projected: Math.round(row.monthToDate + perDay * daysLeft),
    attemptsLeft: row.attemptsLeft ?? 0,
    // `bestMonth` is a record, not a number: the month key and what they did.
    bestMonth: row.bestMonth?.diamonds ?? 0,
    bestMonthKey: row.bestMonth?.key ?? null,
    diamondsPerHour: row.diamondsPerHour ?? null,
  };
}

/** The deepest rung a creator has reached. Null before the first one. */
export function milestoneReached(remaining, done) {
  if (done) return MILESTONES.at(-1);
  for (let i = MILESTONES.length - 2; i >= 0; i--) {
    if (remaining <= MILESTONES[i].remaining) return MILESTONES[i];
  }
  return null;
}

/** Everything fired for this creator this month, oldest first. */
function firedFor(store, month, key) {
  return store.data.graduation?.[month]?.[key] ?? [];
}

function recordFired(store, month, key, milestoneKey) {
  store.data.graduation ??= {};
  store.data.graduation[month] ??= {};
  store.data.graduation[month][key] ??= [];
  if (!store.data.graduation[month][key].includes(milestoneKey)) {
    store.data.graduation[month][key].push(milestoneKey);
  }
}

/** Last pushed on, so the final-days ping goes out once a day and not per run. */
function lastPush(store, month, key) {
  return store.data.graduationPush?.[month]?.[key] ?? null;
}

function recordPush(store, month, key, asOf) {
  store.data.graduationPush ??= {};
  store.data.graduationPush[month] ??= {};
  store.data.graduationPush[month][key] = asOf;
}

/**
 * What to tell coaches today.
 *
 * Two kinds of event, deliberately kept apart:
 *
 *   milestones — a creator crossed a rung for the first time this month. Fires
 *                once per rung per month, so a creator hovering either side of
 *                50,000 does not generate a card a day.
 *
 *   finalPush  — the month is nearly over and they are close enough to land it.
 *                This one repeats daily by design. A gap of 25,000 on day 12 is
 *                a plan; the same gap on day 28 is the last chance this creator
 *                gets at one of only three attempts, and it is worth saying
 *                every morning until the month ends.
 *
 * `persist` is false for a dry run, so a preview never burns the one card a
 * milestone gets.
 */
export function graduationEvents({ ramp, store, asOf, config, persist = true }) {
  const cfg = config.graduation ?? {};
  if (cfg.enabled === false) return { milestones: [], finalPush: [], rows: [] };
  const month = monthKey(asOf);
  const windowDays = config.ramp?.windowDays ?? 90;
  const pushDays = cfg.finalPushDays ?? 5;
  const pushReach = cfg.finalPushReach ?? 50000;
  const pushStretch = cfg.finalPushStretch ?? 4;

  const rows = ramp
    .filter((r) => r.creator && !r.creator.quitOn)
    // Two exclusions, both of which cost us a false graduation against
    // Backstage's count when they were missing.
    //
    // Past day 90: `ramp` keeps a grace period past the window so the report
    // can still show a creator, and a 200k month landed after the window still
    // reads as ACHIEVED there. It is not a graduation, and firing "100,000 to
    // go" at a coach for a creator with no attempt left is pure noise.
    //
    // Already graduated: once a creator lands a 200k month they are a mature
    // creator, not a candidate. Chasing them again would double-count them and
    // spend a coach's morning on someone who has already done it.
    .filter((r) => r.day <= windowDays && r.achievedIn == null)
    .map((r) => progressFor(r, config));

  const milestones = [];
  const finalPush = [];

  for (const p of rows) {
    const key = p.creator.key;
    const already = firedFor(store, month, key);

    // Every rung they have reached but not yet been told about. Reporting only
    // the deepest would silently swallow the others when a creator jumps two
    // rungs in a day, and the one that matters is the deepest anyway.
    const due = MILESTONES.filter((m) => (p.done ? true : p.remaining <= m.remaining)
      && !(m.key === 'DONE' && !p.done)
      && !already.includes(m.key));

    if (due.length) {
      const deepest = due.at(-1);
      milestones.push({ ...p, milestone: deepest, alsoCrossed: due.slice(0, -1) });
      if (persist) for (const m of due) recordFired(store, month, key, m.key);
      continue;   // a rung card already says everything the push card would
    }

    // The closing days. Close enough to be worth chasing, and not so far off
    // that the ping is a lie.
    const reachable = p.remaining <= pushReach
      && (p.stretch == null || p.stretch <= pushStretch);
    if (!p.done && p.daysLeft > 0 && p.daysLeft <= pushDays && reachable) {
      if (lastPush(store, month, key) === asOf) continue;
      finalPush.push(p);
      if (persist) recordPush(store, month, key, asOf);
    }
  }

  // Closest first: the coach's day is finite, and 6,000 short is a better use
  // of it than 90,000 short.
  const byGap = (a, b) => a.remaining - b.remaining;
  return { milestones: milestones.sort(byGap), finalPush: finalPush.sort(byGap), rows };
}

/**
 * The team's ladder, for the daily summary.
 *
 * Counts, not names, above the close ones: a coach needs to know the shape of
 * the chase before they need the list.
 */
export function graduationLadder(rows, group) {
  const mine = rows.filter((r) => (r.group ?? 'Not in a group') === group);
  const band = (lo, hi) => mine.filter((r) => !r.done && r.remaining > lo && r.remaining <= hi);
  return {
    total: mine.length,
    graduated: mine.filter((r) => r.done).length,
    within10k: band(0, 10000),
    within25k: band(10000, 25000),
    within50k: band(25000, 50000),
    within100k: band(50000, 100000),
    further: mine.filter((r) => !r.done && r.remaining > 100000).length,
    // Named because they are the ones a coach can still change the outcome for.
    closest: mine.filter((r) => !r.done && r.remaining <= 100000)
      .sort((a, b) => a.remaining - b.remaining),
    // Most teams have nobody inside 100,000, and "130 further off" is a number
    // a coach cannot do anything with. These are the best placed on the team,
    // named so there is always a candidate to work on rather than a count.
    bestPlaced: mine.filter((r) => !r.done && r.remaining > 100000)
      .sort((a, b) => b.monthToDate - a.monthToDate)
      .slice(0, 3),
  };
}
