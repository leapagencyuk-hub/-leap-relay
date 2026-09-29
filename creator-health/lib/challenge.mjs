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
import { Discord, hardestWorkerEmbed } from './discord.mjs';
import { hardestWorkerBoard } from './hardestworker.mjs';
import { sweeper, sweepDuplicates } from './sweep.mjs';

/**
 * Work out the board and put it in the channel, replacing the one there.
 *
 * `asOf` defaults to the latest data we hold. Nothing is remembered beyond the
 * id of the message posted, so pressing it twice gives the same answer.
 */
export async function refreshChallenge(config, configPath, { asOf = null, dryRun = false } = {}) {
  const series = new Store(config.dataDir).readSeries();
  const when = asOf ?? series.lastAsOf;
  if (!when) throw new Error('no snapshots ingested yet');

  const board = hardestWorkerBoard({ creators: Object.values(series.creators), asOf: when, config });

  const discord = loadRoutes(path.dirname(configPath)).discord;
  const route = discord.hardestWorkerWebhook
    ? { webhook: discord.hardestWorkerWebhook, channelId: discord.hardestWorkerChannelId ?? null }
    : (discord.hardestWorkerChannelId && discord.botToken)
      ? { channelId: discord.hardestWorkerChannelId } : null;

  const result = {
    asOf: when,
    month: board.month,
    daysLeft: board.daysLeft,
    finished: board.finished,
    entered: board.entered,
    winner: board.winner?.username ?? null,
    top: board.top.map((r) => ({ rank: r.rank, username: r.username, hours: r.hours })),
    posted: false,
    replaced: 0,
    failed: [],
    dryRun,
  };

  // An empty board in a creator channel is worse than no board at all. It
  // happens on the 1st, before anybody has been LIVE in the new month.
  if (!board.entered) return { ...result, skipped: `nobody has been LIVE in ${board.month} yet` };
  if (!route) return { ...result, skipped: 'no channel configured for the Hardest Worker Challenge' };

  const payload = hardestWorkerEmbed(board, { config });
  if (dryRun) return { ...result, payload };

  const client = new Discord({ token: discord.botToken });
  const store = new CaseStore(config.dataDir);

  // Post first, delete second. A failed post then leaves yesterday's board in
  // the channel, which is out of date but readable; the other order leaves the
  // creator channel empty.
  const res = route.webhook
    ? await client.postToWebhook(route.webhook, payload)
    : await client.postToChannel(route.channelId, payload);
  if (!res.ok) return { ...result, failed: [{ label: 'hardest-worker', error: res.error }] };
  result.posted = true;

  const prev = store.data.lastMessage?.hardestWorker ?? null;
  const prevId = prev?.ids?.[0] ?? prev?.id ?? null;
  if (res.body?.id) {
    store.data.lastMessage ??= {};
    // The same shape the daily run writes, so either can replace the other.
    store.data.lastMessage.hardestWorker = { id: res.body.id, period: null };
    store.data.lastHardestWorkerOn = when;
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

/** One line a person can read. */
export function challengeSummary(r) {
  if (r.skipped) return `Nothing posted — ${r.skipped}`;
  if (!r.posted) return `Failed to post — ${r.failed[0]?.error ?? 'unknown error'}`;
  const who = r.winner ? `${r.winner} leads on ${r.top[0].hours.toFixed(2)} hours` : 'nobody on the board';
  const when = r.finished ? 'final standings' : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} to go`;
  return `${r.month}: ${r.entered} creator${r.entered === 1 ? '' : 's'} ranked, ${who} (${when}).`
    + (r.replaced ? ` ${r.replaced} older cop${r.replaced === 1 ? 'y' : 'ies'} removed.` : '')
    + (r.failed.length ? ` ${r.failed.length} problem${r.failed.length === 1 ? '' : 's'}.` : '');
}
