// Turning a TikTok handle into a Discord ping.
//
// THE PROBLEM. Writing "@ybwils" into a webhook message produces the text
// "@ybwils" and nothing else. Discord only raises a notification for
// `<@123456789012345678>` — a numeric user id. A TikTok handle means nothing
// to it, so a rank-up poster that reads perfectly still never reaches the
// creator it is about.
//
// THE FIX. A bot token can search the guild's member list, and LEAP's creators
// almost always carry their TikTok handle as their Discord name. So: search by
// handle, match carefully, remember the answer.
//
// WHY MATCHING IS DONE CAREFULLY. Pinging the wrong person is worse than
// pinging nobody — a stranger gets told they ranked up, and the creator who
// actually did sees somebody else's name on their poster. So a match has to be
// exact on one of the three names Discord exposes, after normalising away the
// punctuation people decorate handles with. A fuzzy or partial hit is treated
// as no match at all.
//
// WHAT IT COSTS. One search per unresolved creator, cached afterwards, so a
// month of rank-ups is a handful of requests. Misses are cached too: a creator
// who is not in the server should not be looked up again every single day.
const API = 'https://discord.com/api/v10';

/**
 * Strip a handle to the characters people actually keep the same.
 *
 * TikTok handles and Discord names diverge by decoration far more than by
 * spelling: "@ybwils", "YbWiLs", "yb_wils", "ᴛᴛᴠ ybwils" are one person. The
 * letters and digits are the part that survives, so that is what is compared.
 */
export function normaliseHandle(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')                  // ᴛᴛᴠ and friends fold to plain letters
    .replace(/[^a-z0-9]/g, '');
}

/** Every name Discord might be holding a creator under. */
function namesOf(member) {
  const u = member?.user ?? {};
  return [u.username, u.global_name, member?.nick].filter(Boolean);
}

/**
 * Find the Discord user id for a TikTok handle, or null.
 *
 * `fetchImpl` is injected so this is testable without a token or a network.
 */
export async function resolveDiscordId(handle, {
  guildId, token, cache = {}, fetchImpl = fetch, limit = 10,
} = {}) {
  const key = normaliseHandle(handle);
  if (!key) return { id: null, reason: 'empty handle' };
  // Cached, including a cached miss. `null` is a real answer here.
  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    return { id: cache[key], reason: cache[key] ? 'cached' : 'cached miss', cached: true };
  }
  if (!guildId || !token) return { id: null, reason: 'no bot token or guild id' };

  let res;
  try {
    res = await fetchImpl(
      `${API}/guilds/${guildId}/members/search?query=${encodeURIComponent(handle)}&limit=${limit}`,
      { headers: { authorization: `Bot ${token}` } },
    );
  } catch (err) {
    // A network failure is NOT a miss: caching it would mean never trying this
    // creator again because the wifi dropped once.
    return { id: null, reason: `network: ${err.message}` };
  }
  if (res.status === 429) return { id: null, reason: 'rate limited' };
  if (!res.ok) return { id: null, reason: `HTTP ${res.status}` };
  const members = await res.json().catch(() => null);
  if (!Array.isArray(members)) return { id: null, reason: 'unreadable response' };

  const exact = members.filter((m) => namesOf(m).some((n) => normaliseHandle(n) === key));
  // Two people answering to the same name is not a match, it is a coin toss.
  if (exact.length !== 1) {
    cache[key] = null;
    return { id: null, reason: exact.length ? `${exact.length} members match` : 'no exact match', candidates: members.length };
  }
  const id = exact[0].user?.id ?? null;
  cache[key] = id;
  return { id, reason: 'matched', matchedOn: namesOf(exact[0])[0] ?? null };
}

/**
 * The mention to put in a message: a real ping when we know the id, the plain
 * handle when we do not.
 *
 * Never invents an id. A wrong ping is worse than a flat one.
 */
export function mentionFor(handle, id) {
  return id ? `<@${id}>` : `@${String(handle ?? '').replace(/^@/, '')}`;
}

/** Which guild a channel belongs to, so the guild id need not be configured. */
export async function guildOfChannel(channelId, { token, fetchImpl = fetch } = {}) {
  if (!channelId || !token) return null;
  try {
    const res = await fetchImpl(`${API}/channels/${channelId}`, { headers: { authorization: `Bot ${token}` } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.guild_id ?? null;
  } catch {
    return null;
  }
}
