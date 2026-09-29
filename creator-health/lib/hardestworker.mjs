// LEAP's Hardest Worker Challenge.
//
// The one board in this system that creators read themselves. Everything else
// here is written for a coach or a director — this goes to the creator server,
// so it carries no coach names, no team names, no diamonds and no money. Hours
// streamed and nothing else, because that is the whole competition: whoever put
// the most hours in this month is top, and anyone can check their own number.
//
// WHAT IS COUNTED
//
// "LIVE duration" from the export, month to date. Not valid LIVE days, not
// diamonds — the challenge is hours, and hours is what the card shows. The
// export is cumulative within the month and resets on the 1st, so the month to
// date figure is the standing with no arithmetic of our own on top of it.
//
// It was being made by hand once a week. Daily is the point of automating it:
// a creator who put six hours in yesterday can see themselves move tomorrow
// morning, which is the thing a weekly board cannot do.
//
// THE MONTH ENDS IN TWO STEPS
//
// On the last day of the month the card crowns the winner instead of just
// listing the standings — that is the result, and it stands overnight.
//
// On the 1st it is gone: the new month's board replaces it, from zero. That is
// deliberate and is why this board passes no period to the replace mechanism
// while the coach-facing boards do. Their closing edition is a record somebody
// may want to scroll back to; this one is a competition that has been won,
// announced, and started again.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Hours as the hand-made card wrote them: two decimals, no rounding up to a lie. */
export const hrs = (h) => (Math.round((h ?? 0) * 100) / 100).toFixed(2);

/**
 * The standings.
 *
 * Everyone in the network who has streamed at all this month, in order. The
 * card prints the top few; the board holds the lot, so a creator asking "where
 * am I" can be answered without running anything again.
 */
export function hardestWorkerBoard({ creators, asOf, config = {} }) {
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const month = asOf.slice(0, 7);
  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));

  const rows = [];
  for (const c of creators) {
    // Somebody who has left the network is not in the competition, and neither
    // is a partner agency's roster — they are in the export, not in LEAP.
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const mtd = monthMtd(c, month);
    if (!mtd) continue;
    const hours = mtd.liveHours ?? 0;
    // Nobody wants to be shown on a leaderboard on nought hours, and a tail of
    // hundreds of zeros makes the real list impossible to find.
    if (hours <= 0) continue;
    rows.push({
      username: c.username,
      hours,
      // Kept off the card, used to break ties: two creators on the same hours
      // are separated by who did more with them.
      diamonds: Math.round(mtd.diamonds ?? 0),
      streams: Math.round(mtd.liveStreams ?? 0),
      liveDays: Math.round(mtd.validLiveDays ?? 0),
    });
  }

  rows.sort((a, b) => b.hours - a.hours || b.diamonds - a.diamonds
    || a.username.localeCompare(b.username));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const show = config.hardestWorker?.show ?? 10;
  const totalHours = rows.reduce((t, r) => t + r.hours, 0);

  return {
    month, asOf, dayOfMonth, monthLength,
    daysLeft: Math.max(0, monthLength - dayOfMonth),
    // The result is in on the last day of the month, and only then.
    finished: dayOfMonth >= monthLength,
    rows,
    top: rows.slice(0, show),
    entered: rows.length,
    totalHours,
    winner: rows[0] ?? null,
    // What second place would have to find. Only meaningful while there is
    // still time to find it.
    lead: rows.length > 1 ? rows[0].hours - rows[1].hours : null,
  };
}

/** Posted once a day, and only once. */
export function hardestWorkerDue(config, store, asOf) {
  if (config.hardestWorker?.enabled === false) return false;
  return store.data.lastHardestWorkerOn !== asOf;
}
