// Creator profile links and avatars.
//
// The export carries no avatar, so the link is the reliable part: a coach can
// click straight through to the creator's profile and see what they have
// actually been posting, which is the thing the export cannot tell them.
//
// The avatar is best effort. TikTok's public oEmbed endpoint returns an author
// thumbnail, but it is rate limited and unfriendly to datacentre IPs, so every
// lookup is cached (successes and failures alike), capped per run, and failure
// costs nothing but a card without a picture.
import fs from 'node:fs';
import path from 'node:path';

const handle = (username) => String(username ?? '').replace(/^@/, '').trim();

export const profileUrl = (username) =>
  `https://www.tiktok.com/@${encodeURIComponent(handle(username))}`;

/**
 * An avatar URL that Discord resolves itself.
 *
 * The first attempt fetched TikTok's oEmbed endpoint from our side, cached the
 * result, and produced no picture at all in production. Handing Discord a URL
 * that resolves the handle on request removes our network from the path
 * entirely: no lookup, no cache, no rate limit, and a failure is just a card
 * without a picture.
 */
export const avatarUrl = (username, config = {}) => {
  const h = handle(username);
  if (!h) return null;
  const manual = config.manual?.[h.toLowerCase()];
  if (manual) return manual;
  if (config.enabled === false) return null;
  const template = config.urlTemplate ?? 'https://unavatar.io/tiktok/{handle}';
  return template.replace('{handle}', encodeURIComponent(h));
};

const DAY = 86400000;

export class Avatars {
  constructor(dataDir, config = {}) {
    this.path = path.join(dataDir, 'avatars.json');
    this.enabled = config.enabled !== false;
    this.ttlDays = config.ttlDays ?? 30;
    this.retryDays = config.retryFailedAfterDays ?? 7;
    this.perRun = config.maxLookupsPerRun ?? 25;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.manual = config.manual ?? {};
    this.data = fs.existsSync(this.path)
      ? JSON.parse(fs.readFileSync(this.path, 'utf8'))
      : {};
    this.looked = 0;
  }

  save() {
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.path);
  }

  /** A cached or manually configured avatar, without going near the network. */
  get(username) {
    const key = String(username ?? '').toLowerCase();
    if (this.manual[key]) return this.manual[key];
    const hit = this.data[key];
    return hit?.ok ? hit.url : null;
  }

  stale(username) {
    const key = String(username ?? '').toLowerCase();
    if (this.manual[key]) return false;
    const hit = this.data[key];
    if (!hit) return true;
    const age = Date.now() - hit.at;
    return hit.ok ? age > this.ttlDays * DAY : age > this.retryDays * DAY;
  }

  /**
   * Look one up, within the per-run budget.
   *
   * Never throws and never blocks a card: a missing picture is a cosmetic loss,
   * and a daily run that stalls on a rate limit is not.
   */
  async fetch(username) {
    const key = String(username ?? '').toLowerCase();
    if (!this.enabled || !key) return null;
    if (this.manual[key]) return this.manual[key];
    if (!this.stale(key)) return this.get(key);
    if (this.looked >= this.perRun) return this.get(key);
    this.looked++;

    try {
      const res = await fetch(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(profileUrl(key))}`,
        { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const url = body.thumbnail_url || body.author_thumbnail || null;
      this.data[key] = url ? { ok: true, url, at: Date.now() } : { ok: false, at: Date.now() };
      return url;
    } catch {
      // Cached as a failure so the next run does not try again immediately.
      this.data[key] = { ok: false, at: Date.now() };
      return null;
    }
  }

  /** Warm the cache for the creators about to be posted about. */
  async warm(usernames) {
    if (!this.enabled) return;
    for (const u of [...new Set(usernames)]) {
      if (this.looked >= this.perRun) break;
      if (this.stale(u)) await this.fetch(u);
    }
    this.save();
  }
}
