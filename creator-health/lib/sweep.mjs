// Remove our own older copies of a card we have just reposted.
//
// WHY THE STORED MESSAGE ID IS NOT ENOUGH
//
// Each recurring card remembers the id of its last post and deletes that one
// when the next goes up. That keeps a channel clean from the day it starts
// working, and does nothing at all about copies that piled up before it did.
//
// Anything posted while the cleanup was broken is orphaned: the store only
// ever held the newest id, so every copy behind it is invisible to the code
// that would remove it. Pressing redo posts a fresh card, deletes the one
// message it can name, and leaves the rest sitting there — which reads, from
// the channel, as redo not deleting anything.
//
// So this looks at the channel instead of at our own notes.
//
// WHAT IT IS ALLOWED TO TOUCH
//
// Only a message that is all three of these:
//
//   1. posted by us — the bot's own user id, or a webhook, never a person;
//   2. carrying an embed whose title is EXACTLY the title of the card we have
//      just posted;
//   3. older than that card.
//
// Matching on the exact title of the card in hand is the safety rule. A team
// summary is "Team Alpha — daily summary" every day, so yesterday's copies are
// found; a creator's own card is titled after the creator and can never
// collide with a board. Nothing is deleted speculatively, and nothing is
// deleted that we did not just replace.
//
// It needs a bot token and Read Message History. Without either it reports
// that it could not run rather than reporting success, because a sweep that
// silently does nothing is the bug it exists to fix.
import { Discord } from './discord.mjs';

/** The title Discord will show for a payload we are about to post. */
export function titleOf(payload) {
  const embed = payload?.embeds?.[0];
  return embed?.title ?? null;
}

/**
 * Delete our older copies of `title` in `channelId`, keeping `keepId`.
 *
 * Returns what it removed, and — when it could not look — why not, so the
 * caller can say so instead of implying the channel is clean.
 */
export async function sweepDuplicates(client, { channelId, title, keepId, botUserId = null, limit = 100 }) {
  if (!channelId) return { ok: false, reason: 'no channel id: this card posts through a webhook, which cannot list a channel', removed: [] };
  if (!client?.token) return { ok: false, reason: 'no bot token, so the channel cannot be read', removed: [] };
  if (!title) return { ok: false, reason: 'the card has no title to match on', removed: [] };

  const res = await client.listMessages(channelId, { limit });
  if (!res.ok) return { ok: false, reason: `could not read the channel: ${res.error}`, removed: [] };

  const ours = (m) => {
    // A webhook post carries webhook_id; a bot post is authored by the bot.
    if (m.webhook_id) return true;
    if (botUserId && m.author?.id === botUserId) return true;
    return Boolean(m.author?.bot);
  };

  const removed = [];
  const failed = [];
  for (const m of res.body ?? []) {
    if (m.id === keepId) continue;
    if (!ours(m)) continue;
    if ((m.embeds ?? []).every((e) => e.title !== title)) continue;
    const gone = await client.deleteMessage(channelId, m.id);
    if (gone.ok) removed.push(m.id);
    else failed.push({ id: m.id, error: gone.error });
  }
  return { ok: true, removed, failed, scanned: (res.body ?? []).length };
}

/**
 * A client for sweeping, and the bot's own id, worked out once per run.
 *
 * The id is only needed to tell our posts from another bot's in the same
 * channel; if the lookup fails we fall back to "any bot", which is still not a
 * person and still has to match the exact title of the card we just posted.
 */
export async function sweeper(discordConfig) {
  if (!discordConfig?.botToken) return null;
  const client = new Discord({ token: discordConfig.botToken });
  const me = await client.whoAmI();
  return { client, botUserId: me.ok ? me.body?.id ?? null : null };
}
