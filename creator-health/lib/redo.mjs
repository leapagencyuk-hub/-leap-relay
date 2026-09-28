// Repost today, fresh.
//
// The daily cards already replace themselves: each recurring post records its
// message id, and the next one deletes the copy before it so a channel holds
// what is true now rather than a month of stale versions. What that mechanism
// will not do on its own is run twice in a day — the once-a-day guard is right
// for the scheduled run and wrong when somebody has deliberately asked.
//
// So a redo is a normal daily run with every once-a-day guard lifted. Each
// recurring card goes up with the current numbers and takes its own earlier
// copy down with it, which is the "delete everything and post it again" that
// was asked for, in the order that survives a failure: the new card is posted
// BEFORE the old one is removed, so a run that dies halfway leaves a channel
// holding a stale card rather than an empty one.
//
// WHAT A REDO DOES NOT TOUCH, deliberately:
//
//   Per-creator work cards — a decline, an activation, an opportunity. Those
//   are not a view of today, they are an open job with somebody's name on it
//   and buttons that still work. A redo cannot recreate them either: they are
//   raised by a change in the data, and on a second run today nothing has
//   changed, so deleting them would remove work nobody could get back.
//
//   Event cards — a creator graduating, a creator leaping. Those record a
//   thing that happened at a moment, and there is no newer version of them.
//
// Everything a coach reads as "today's picture" is recurring and is replaced:
// the ten team summaries, both leaderboards, the inactive and activeness
// overviews, the leaped overview, the policy card and the management overview.
import { runDaily } from './pipeline.mjs';

/**
 * Run today again, replacing every recurring card.
 *
 * Returns what went up and what came down, so whoever pressed the button can
 * see the old cards actually went rather than hoping they did.
 */
export async function redoToday(config, configPath, { asOf = null } = {}) {
  const { result, delivery } = await runDaily(config, configPath, {
    asOf,
    dryRun: false,
    // Both guards off: this is the deliberate ask the guards exist to let
    // through.
    forceSummary: true,
    force: ['all'],
  });

  const posted = delivery.sent.filter((x) => x.ok && !x.skipped);
  const failed = delivery.sent.filter((x) => !x.ok);
  const replaced = delivery.replaced ?? [];
  // Older copies found by reading the channel, rather than from our own notes.
  const swept = (delivery.swept ?? []).reduce((n, s) => n + s.removed, 0);

  const byLabel = new Map();
  for (const p of posted) byLabel.set(p.label, (byLabel.get(p.label) ?? 0) + 1);

  return {
    asOf: result.asOf,
    posted: posted.length,
    replaced: replaced.length,
    swept,
    failed: failed.map((f) => ({ label: f.label, coach: f.coach, error: f.error })),
    byLabel: [...byLabel].sort((a, b) => b[1] - a[1]),
    skipped: delivery.skipped ?? null,
    warning: delivery.warning ?? null,
  };
}

/** One line a caller can put straight in front of a person. */
export function redoSummary(r) {
  if (r.skipped) return `Nothing posted — ${r.skipped}`;
  const parts = [`${r.posted} card${r.posted === 1 ? '' : 's'} reposted for ${r.asOf}`];
  const gone = (r.replaced ?? 0) + (r.swept ?? 0);
  if (gone) parts.push(`${gone} older ${gone === 1 ? 'copy' : 'copies'} removed`);
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  return `${parts.join(', ')}.`;
}
