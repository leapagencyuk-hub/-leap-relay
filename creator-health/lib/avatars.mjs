// Creator profile pictures.
//
// The Creator data export does not carry one, so they come from the public
// TikTok profile page and are cached on disk. Two reasons they are stored as
// bytes rather than as URLs: TikTok's avatar URLs are signed and expire within
// a day, and the portal's own page would then be pointing at a CDN the browser
// may not be allowed to reach. Holding the image means the portal serves it
// itself and a coach never sees a broken square.
//
// This is deliberately polite. One request per creator at a time, only for
// creators actually on a page, only when the cached copy is old, and a hard cap
// per run. A portal that scrapes 877 profiles every time somebody opens it
// would deserve everything it got.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'avatars';
const INDEX = 'avatars.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// A TikTok handle becomes a filename, so it has to survive being one.
// Stripping the slashes is already enough to stop a traversal — nothing can
// escape a directory without one — but letting runs of dots through means a
// handle can still read as `..` in a path, and a filename nobody can reason
// about at a glance is not worth the dot.
const safe = (username) => String(username ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9._-]/g, '')
  .replace(/\.{2,}/g, '.')
  .replace(/^[.\-]+/, '')
  .slice(0, 64);

function indexPath(dataDir) { return path.join(dataDir, INDEX); }
function fileFor(dataDir, username) { return path.join(dataDir, DIR, `${safe(username)}.jpg`); }

export function readIndex(dataDir) {
  const p = indexPath(dataDir);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; } catch { return {}; }
}

function writeIndex(dataDir, index) {
  const p = indexPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, p);
}

/** The bytes we hold for one creator, or null. */
export function avatarBytes(dataDir, username) {
  const f = fileFor(dataDir, username);
  try { return fs.existsSync(f) ? fs.readFileSync(f) : null; } catch { return null; }
}

/** Whether we hold a picture for this creator at all. */
export function hasAvatar(dataDir, username) {
  return fs.existsSync(fileFor(dataDir, username));
}

/** Pull one avatar URL out of a profile page. */
export function parseAvatar(html) {
  // The page embeds its state as JSON, so the field is a plain string with
  // escaped slashes rather than anything that needs a parser.
  //
  // Smallest first, and that order is the point. The portal draws these at
  // 54px; avatarLarger is 1080x1080 and about 170KB, so a page with twenty
  // creators on it pulled three and a half megabytes of faces onto a coach's
  // phone to render circles the size of a thumbnail. avatarThumb is 100x100
  // and a few KB.
  //
  // The size cannot simply be rewritten in the URL: the path is covered by the
  // CDN signature, so asking for :200:200 on a URL signed for :1080:1080 is
  // refused. TikTok publishes each size as its own signed URL, so take theirs.
  const src = String(html ?? '');
  const hit = /"avatarThumb":"([^"]+)"/.exec(src)
    ?? /"avatarMedium":"([^"]+)"/.exec(src)
    ?? /"avatarLarger":"([^"]+)"/.exec(src);
  if (!hit) return null;
  return hit[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
}

/**
 * Fetch the pictures we are missing, newest request first, within a budget.
 *
 * Returns what it did rather than throwing: a portal that will not render
 * because TikTok was slow is worse than a portal with some grey circles.
 */
export async function refreshAvatars(dataDir, usernames, {
  max = 25,
  maxAgeDays = 30,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const index = readIndex(dataDir);
  const stale = (u) => {
    const got = index[safe(u)]?.at;
    if (!got || !hasAvatar(dataDir, u)) return true;
    return now - got > maxAgeDays * 86400000;
  };
  const todo = [...new Set(usernames.filter(Boolean).map(String))].filter(stale).slice(0, max);
  const out = { tried: todo.length, got: 0, failed: 0 };
  if (!todo.length) return out;

  fs.mkdirSync(path.join(dataDir, DIR), { recursive: true });
  for (const username of todo) {
    try {
      const res = await fetchImpl(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`profile ${res.status}`);
      const url = parseAvatar(await res.text());
      if (!url) throw new Error('no avatar on the page');
      const img = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://www.tiktok.com/' } });
      if (!img.ok) throw new Error(`image ${img.status}`);
      const buf = Buffer.from(await img.arrayBuffer());
      // A profile page that answers with an HTML error instead of a JPEG would
      // otherwise be cached as somebody's face.
      if (buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
      fs.writeFileSync(fileFor(dataDir, username), buf);
      index[safe(username)] = { at: now, bytes: buf.length };
      out.got++;
    } catch (err) {
      // Remembered as a failure so one missing creator is not retried on every
      // single page load, but with a shorter life than a success.
      index[safe(username)] = { at: now - (maxAgeDays - 2) * 86400000, error: String(err.message ?? err) };
      out.failed++;
    }
  }
  writeIndex(dataDir, index);
  return out;
}

/** Where the portal serves this creator's picture from. */
export const avatarRoute = (username) => `/portal/avatar/${encodeURIComponent(safe(username))}`;
export { safe as avatarKey };
