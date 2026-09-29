// Pull the LEAP rankings: who climbed a league, and who dropped out of one.
//
// On demand rather than daily, because that is how it is meant to be read — a
// director presses the button and gets where the network stands right now,
// against where it finished last month.
//
// Both cards replace their own previous post, so each channel holds one
// current answer instead of a stack of them. That is the same mechanism the
// daily cards use, with the month as the period: the closing set for a month
// survives into the next one rather than being deleted by a board showing a
// month that has barely started.
import path from 'node:path';
import { Store } from './store.mjs';
import { CaseStore } from './cases.mjs';
import { loadRoutes } from './notify.mjs';
import { Discord, rankUpLeagueEmbed, deRankLeagueEmbed } from './discord.mjs';
import { leagueBoard } from './leagues.mjs';
import { supersedes } from './dispatch.mjs';
import { sweeper, sweepDuplicates } from './sweep.mjs';

/** Prefer the webhook, keep the channel id so the sweep has somewhere to look. */
function routeFor(discord, hook, channel) {
  if (discord[hook]) return { webhook: discord[hook], channelId: discord[channel] ?? null };
  if (discord[channel] && discord.botToken) return { channelId: discord[channel] };
  return null;
}

/**
 * Work out the rankings and post them.
 *
 * `asOf` defaults to the latest data we hold. Nothing is remembered between
 * runs beyond the ids of the messages posted, so pressing the button twice
 * gives the same answer.
 */
export async function pullRankings(config, configPath, { asOf = null, dryRun = false } = {}) {
  const series = new Store(config.dataDir).readSeries();
  const when = asOf ?? series.lastAsOf;
  if (!when) throw new Error('no snapshots ingested yet');

  const creators = Object.values(series.creators);
  const board = leagueBoard({ creators, asOf: when, config });

  const discord = loadRoutes(path.dirname(configPath)).discord;
  const up = routeFor(discord, 'leagueUpWebhook', 'leagueUpChannelId');
  const down = routeFor(discord, 'leagueDownWebhook', 'leagueDownChannelId');

  const result = {
    asOf: when,
    month: board.month,
    daysLeft: board.daysLeft,
    rankedUp: board.rankedUp.length,
    deRanked: board.deRanked.length,
    slipping: board.slipping.length,
    held: board.held,
    standings: board.standings,
    posted: [],
    failed: [],
    replaced: 0,
    dryRun,
  };
  if (dryRun) return { ...result, board };

  const client = new Discord({ token: discord.botToken });
  const store = new CaseStore(config.dataDir);
  const sweep = await sweeper(discord);

  /**
   * Post every page of a card, and remove every page of the last one.
   *
   * A long month needs more than one message, so the stored id is a list.
   * Older stores hold a single id; both shapes are read.
   */
  const post = async (label, route, payloads, slot) => {
    if (!route) { result.failed.push({ label, error: 'no channel configured' }); return; }

    const prevEntry = store.data.lastMessage?.[slot] ?? null;
    const prevIds = prevEntry?.ids ?? (prevEntry?.id ? [prevEntry.id] : []);
    const prevPeriod = prevEntry?.period ?? null;

    const ids = [];
    for (const payload of payloads) {
      const res = route.webhook
        ? await client.postToWebhook(route.webhook, payload)
        : await client.postToChannel(route.channelId, payload);
      if (!res.ok) { result.failed.push({ label, error: res.error }); continue; }
      result.posted.push(label);
      if (res.body?.id) ids.push(res.body.id);
    }
    if (!ids.length) return;

    store.data.lastMessage ??= {};
    store.data.lastMessage[slot] = { ids, period: board.month };

    // Within a month only: the closing set for a month is a result and
    // survives into the next one.
    if (supersedes({ id: prevIds[0], period: prevPeriod }, board.month, ids[0])) {
      for (const id of prevIds) {
        if (ids.includes(id)) continue;
        const gone = route.webhook
          ? await client.deleteWebhookMessage(route.webhook, id)
          : await client.deleteMessage(route.channelId, id);
        if (gone.ok) result.replaced++;
        else result.failed.push({ label: `${label}-cleanup`, error: gone.error });
      }
    }

    // And the copies our own notes never knew about. Each page has its own
    // title, so a page is only ever swept by its own earlier copy.
    if (sweep && route.channelId) {
      for (let i = 0; i < payloads.length; i++) {
        if (!ids[i]) continue;
        const out = await sweepDuplicates(sweep.client, {
          channelId: route.channelId,
          title: payloads[i].embeds?.[0]?.title ?? null,
          keepId: ids[i],
          botUserId: sweep.botUserId,
        });
        if (out.ok) result.replaced += out.removed.length;
      }
    }
  };

  await post('league-up', up, rankUpLeagueEmbed(board, { config }), 'leagueUp');
  await post('league-down', down, deRankLeagueEmbed(board, { config }), 'leagueDown');
  store.save();

  return result;
}

/** One line a person can read. */
export function rankingsSummary(r) {
  const parts = [
    `${r.rankedUp} ranked up`,
    `${r.deRanked} de-ranked`,
    `${r.slipping} still winnable`,
  ];
  return `${r.month}: ${parts.join(', ')} (${r.daysLeft} days left).`
    + (r.failed.length ? ` ${r.failed.length} failed to post.` : '');
}
