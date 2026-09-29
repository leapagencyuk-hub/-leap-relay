// Refresh the Hardest Worker Challenge board on demand.
//
// The board already goes up once a day on its own. This is the button beside
// it, for the times somebody wants it refreshed now: after a file has just
// been uploaded, after a change to how the card reads, or simply because the
// channel is being looked at and yesterday's numbers are on screen.
//
// It is deliberately NOT a redo. A redo reposts every daily card into fourteen
// channels and re-pings every coach; this touches one message in one channel,
// the creator-facing one, and nothing else in the system moves.
//
// It shares the daily run's slot on purpose. Both write `lastMessage.hardestWorker`
// and both delete what was there, so pressing the button and then leaving the
// daily run to fire cannot leave two boards standing.
import path from 'node:path';
import { Store } from './store.mjs';
import { CaseStore } from './cases.mjs';
import { loadRoutes } from './notify.mjs';
import { Discord, hardestWorkerEmbed, creatorWeekEmbed } from './discord.mjs';
import { hardestWorkerBoard } from './hardestworker.mjs';
import { creatorWeekBoard } from './creatorweek.mjs';
import { sweeper, sweepDuplicates } from './sweep.mjs';

/**
 * The two creator-facing boards, and where each one lives.
 *
 * Both work identically — compute, post, remove the last one — so they share
 * one refresher rather than two near-copies that drift apart.
 */
const BOARDS = {
  hardestWorker: {
    label: 'hardest-worker',
    hook: 'hardestWorkerWebhook',
    channel: 'hardestWorkerChannelId',
    slot: 'hardestWorker',
    stamp: 'lastHardestWorkerOn',
    name: 'Hardest Worker Challenge',
    build: (creators, asOf, config) => hardestWorkerBoard({ creators, asOf, config }),
    render: hardestWorkerEmbed,
    empty: (b) => `nobody has been LIVE in ${b.month} yet`,
  },
  creatorWeek: {
    label: 'creator-week',
    hook: 'creatorWeekWebhook',
    channel: 'creatorWeekChannelId',
    slot: 'creatorWeek',
    stamp: 'lastCreatorWeekOn',
    name: 'Creator of the Week',
    build: (creators, asOf, config) => creatorWeekBoard({ creators, asOf, config }),
    render: creatorWeekEmbed,
    empty: (b) => `nobody has been LIVE in the week of ${b.weekStart} yet`,
  },
};

/**
 * Work out the board and put it in the channel, replacing the one there.
 *
 * `asOf` defaults to the latest data we hold. Nothing is remembered beyond the
 * id of the message posted, so pressing it twice gives the same answer.
 */
export async function refreshChallenge(config, configPath, { asOf = null, dryRun = false, board: which = 'hardestWorker' } = {}) {
  const spec = BOARDS[which];
  if (!spec) throw new Error(`no such board: ${which}`);
  const series = new Store(config.dataDir).readSeries();
  const when = asOf ?? series.lastAsOf;
  if (!when) throw new Error('no snapshots ingested yet');

  const board = spec.build(Object.values(series.creators), when, config);

  const discord = loadRoutes(path.dirname(configPath)).discord;
  const route = discord[spec.hook]
    ? { webhook: discord[spec.hook], channelId: discord[spec.channel] ?? null }
    : (discord[spec.channel] && discord.botToken)
      ? { channelId: discord[spec.channel] } : null;

  const result = {
    board: which,
    name: spec.name,
    asOf: when,
    period: board.month ?? `${board.weekStart} to ${board.weekEnd}`,
    daysLeft: board.daysLeft,
    finished: board.finished,
    entered: board.entered,
    winner: board.winner?.username ?? null,
    top: board.top.map((r) => ({
      rank: r.rank,
      username: r.username,
      // The Hardest Worker board is hours; Creator of the Week is four figures.
      hours: r.hours ?? r.now?.liveHours ?? null,
      grew: r.now ? { ...r.now } : null,
    })),
    posted: false,
    replaced: 0,
    failed: [],
    dryRun,
  };

  // An empty board in a creator channel is worse than no board at all. It
  // happens at the start of a month or a week, before anybody has been LIVE.
  if (!board.entered) return { ...result, skipped: spec.empty(board) };
  if (!route) return { ...result, skipped: `no channel configured for ${spec.name}` };

  const payload = spec.render(board, { config });
  if (dryRun) return { ...result, payload };

  const client = new Discord({ token: discord.botToken });
  const store = new CaseStore(config.dataDir);

  // Post first, delete second. A failed post then leaves yesterday's board in
  // the channel, which is out of date but readable; the other order leaves the
  // creator channel empty.
  const res = route.webhook
    ? await client.postToWebhook(route.webhook, payload)
    : await client.postToChannel(route.channelId, payload);
  if (!res.ok) return { ...result, failed: [{ label: spec.label, error: res.error }] };
  result.posted = true;

  const prev = store.data.lastMessage?.[spec.slot] ?? null;
  const prevId = prev?.ids?.[0] ?? prev?.id ?? null;
  if (res.body?.id) {
    store.data.lastMessage ??= {};
    // The same shape the daily run writes, so either can replace the other.
    store.data.lastMessage[spec.slot] = { id: res.body.id, period: null };
    store.data[spec.stamp] = when;
  }

  if (prevId && prevId !== res.body?.id) {
    const gone = route.webhook
      ? await client.deleteWebhookMessage(route.webhook, prevId)
      : route.channelId
        ? await client.deleteMessage(route.channelId, prevId)
        : { ok: false, error: 'no webhook or channel to delete through' };
    if (gone.ok) result.replaced++;
    else result.failed.push({ label: 'hardest-worker-cleanup', error: gone.error });
  }

  // And any copy our own notes never knew about — a board posted before the
  // store was rebuilt, or by hand.
  const sweep = await sweeper(discord);
  if (sweep && route.channelId && res.body?.id) {
    const out = await sweepDuplicates(sweep.client, {
      channelId: route.channelId,
      title: payload.embeds?.[0]?.title ?? null,
      keepId: res.body.id,
      botUserId: sweep.botUserId,
    });
    if (out.ok) result.replaced += out.removed.length;
    else result.sweepNote = out.reason;
  }

  store.save();
  return result;
}

/** One line a person can read, whichever board it was. */
export function challengeSummary(r) {
  if (r.skipped) return `Nothing posted — ${r.skipped}`;
  if (!r.posted) return `Failed to post — ${r.failed[0]?.error ?? 'unknown error'}`;
  const top = r.top[0] ?? null;
  // The Hardest Worker board is one number and the lead reads better with it;
  // Creator of the Week is a blend of five and a single figure would mislead.
  const on = r.board === 'hardestWorker' && top?.hours != null ? ` on ${top.hours.toFixed(2)} hours` : '';
  const lead = r.winner ? `${r.winner} ${r.finished ? 'wins' : 'leads'}${on}` : 'nobody on the board';
  const when = r.finished ? 'final standings' : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} to go`;
  return `${r.name} — ${r.period}: ${r.entered} creator${r.entered === 1 ? '' : 's'} ranked, ${lead} (${when}).`
    + (r.replaced ? ` ${r.replaced} older cop${r.replaced === 1 ? 'y' : 'ies'} removed.` : '')
    + (r.failed.length ? ` ${r.failed.length} problem${r.failed.length === 1 ? '' : 's'}.` : '');
}
