// Leaped creators, and the wage bill that follows from them.
//
// A creator is "leaped" the moment their cumulative totals pass 5 LIVE hours
// AND 5,000 diamonds. It happens once in a creator's life, whenever it happens
// — a creator who signed in July and only clears the bar in September leaps in
// September, and September's payroll carries the ten pounds.
//
// This is money, so three rules matter more than anything else here:
//
//   1. A leap is recorded once and never rewritten. The date, the month it was
//      credited to and the amount are frozen at the moment it is first seen, so
//      a later config change or a re-run cannot move somebody's pay.
//
//   2. Running twice in a day cannot pay twice. The record is the guard, not
//      the once-a-day post.
//
//   3. We never credit a leap we did not witness. When this first runs there
//      are already creators far past the bar who cleared it months before any
//      of this existed — 260 of them on the day it was written. Paying those
//      out would be thousands of pounds of back-pay for work no data here can
//      show. They are recorded as leaped so they are never paid for twice, and
//      explicitly marked as carried over rather than credited.
//
// The test for (3) is whether the creator was already past the bar using only
// the months BEFORE the current one. If they were, the leap happened at some
// unknown earlier point and is carried over. If they were not, they crossed
// while we were watching and this month owes them.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';
import { coachName } from './coaches.mjs';

/** Cumulative LIVE hours and diamonds across every month we hold, up to a limit. */
export function totalsThrough(creator, months, before = null) {
  let hours = 0;
  let diamonds = 0;
  for (const m of months) {
    if (before && m >= before) continue;
    const x = monthMtd(creator, m);
    hours += x?.liveHours ?? 0;
    diamonds += x?.diamonds ?? 0;
  }
  return { hours, diamonds };
}

const clears = (t, cfg) => t.hours >= (cfg.hours ?? 5) && t.diamonds >= (cfg.diamonds ?? 5000);

/** Every calendar month the store holds an observation for, oldest first. */
export function monthsSeen(creators) {
  const set = new Set();
  for (const c of creators) for (const o of c.obs ?? []) set.add(o.date.slice(0, 7));
  return [...set].sort();
}

/**
 * Who has leaped, who just did, and what the month owes.
 *
 * `persist` false for a dry run, so a preview cannot create a payroll record.
 */
export function leapedState({ creators, asOf, store, config, persist = true }) {
  const cfg = config.leaped ?? {};
  const fee = cfg.fee ?? 10;
  const currency = cfg.currency ?? 'GBP';
  const month = asOf.slice(0, 7);
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const months = monthsSeen(creators);

  // The very first run has no history, so every creator who crossed during this
  // month is recorded today whatever day they actually did it. That is a
  // catch-up, not seventy-three creators leaping this morning, and the card has
  // to say so or it reads as nonsense.
  const firstRun = !store.data.leaped;
  store.data.leaped ??= {};
  const records = store.data.leaped;

  // Leaps found on this pass, kept separately so a dry run can still report the
  // bill it would create. In a real run these are also in `records`, so the two
  // are merged by key rather than concatenated.
  const pending = new Map();
  const newlyLeaped = [];
  const carriedOver = [];
  const all = [];
  const close = [];

  for (const c of creators) {
    // Partner agencies are not LEAP's payroll. Same list the boards use.
    if (ignored.has(groupKey(c.group))) continue;

    const existing = records[c.key];
    if (existing) {
      all.push({ ...existing, creator: c, username: c.username, group: c.group ?? null,
        coach: c.manager ?? null, name: coachName(c.manager, config) });
      continue;
    }

    const now = totalsThrough(c, months);
    if (!clears(now, cfg)) {
      // Near enough that a coach could still get them over it.
      const needHours = Math.max(0, (cfg.hours ?? 5) - now.hours);
      const needDiamonds = Math.max(0, (cfg.diamonds ?? 5000) - now.diamonds);
      // Worth naming only if a coach could plausibly close the gap: within
      // reach on diamonds, and not needing a whole extra week of hours.
      const closeOnHours = needHours <= (cfg.closeHoursWithin ?? 3);
      if (now.hours > 0 && needDiamonds <= (cfg.closeWithin ?? 1500) && closeOnHours) {
        close.push({
          creator: c, username: c.username, group: c.group ?? null,
          coach: c.manager ?? null, name: coachName(c.manager, config),
          hours: Math.round(now.hours * 10) / 10, diamonds: Math.round(now.diamonds),
          needHours: Math.round(needHours * 10) / 10, needDiamonds: Math.round(needDiamonds),
        });
      }
      continue;
    }

    // Were they already past the bar before this month began?
    const before = totalsThrough(c, months, month);
    const witnessed = !clears(before, cfg);

    const record = {
      creatorKey: c.key,
      username: c.username,
      group: c.group ?? null,
      coach: c.manager ?? null,
      on: asOf,
      // The month the fee belongs to. Null for a carried-over leap: it happened
      // before any of this, and nobody can say when.
      month: witnessed ? month : null,
      credited: witnessed,
      carriedOver: !witnessed,
      fee: witnessed ? fee : 0,
      currency,
      atHours: Math.round(now.hours * 10) / 10,
      atDiamonds: Math.round(now.diamonds),
    };
    if (persist) records[c.key] = record;
    pending.set(c.key, record);

    const row = { ...record, creator: c, name: coachName(c.manager, config) };
    all.push(row);
    (witnessed ? newlyLeaped : carriedOver).push(row);
  }

  // This month's bill: every credited leap on the books, not only today's, so
  // the overview is right on a day when nobody leaped.
  const merged = new Map(Object.values(records).map((r) => [r.creatorKey, r]));
  for (const [k, r] of pending) merged.set(k, r);
  const thisMonth = [...merged.values()]
    .filter((r) => r.credited && r.month === month)
    .map((r) => ({ ...r, name: coachName(r.coach, config) }));

  const byCoach = new Map();
  for (const r of thisMonth) {
    const k = r.coach ?? 'unassigned';
    const e = byCoach.get(k) ?? { coach: k, name: coachName(k, config), count: 0, owed: 0, creators: [] };
    e.count++;
    e.owed += r.fee;
    e.creators.push(r.username);
    byCoach.set(k, e);
  }

  return {
    asOf, month, fee, currency, firstRun,
    // Leaped today, and worth paying for.
    today: newlyLeaped.filter((r) => r.on === asOf),
    // Already past the bar when this started. Recorded so they are never paid
    // for twice, never counted as this month's work.
    carriedOver,
    thisMonth,
    owed: thisMonth.reduce((n, r) => n + r.fee, 0),
    coaches: [...byCoach.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    totalLeaped: merged.size,
    // Sorted by how little is left to do.
    close: close.sort((a, b) => a.needDiamonds - b.needDiamonds),
    threshold: { hours: cfg.hours ?? 5, diamonds: cfg.diamonds ?? 5000 },
  };
}

/** Posted once a day, and only once. */
export function leapedDue(config, store, asOf) {
  if (config.leaped?.enabled === false) return false;
  return store.data.lastLeapedOn !== asOf;
}
