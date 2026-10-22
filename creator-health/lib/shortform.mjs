// Short form: when did this creator last post?
//
// Perry's own note to the roster, 13 October: "As a full-time streamer, 70% of
// my traffic comes from short form... if you're not posting short form, this
// could be why your viewers are low." It is the single biggest lever the
// Creator data export cannot see, because the export is about LIVE and says
// nothing about the feed.
//
// This has to come off the public profile, and that is the awkward part.
// TikTok no longer puts the video list in the server-rendered HTML — it is an
// XHR signed with X-Dynosaur, X-Gnarly and X-Bogus, all computed by their own
// obfuscated JavaScript. A plain fetch cannot do it and reimplementing the
// signer is an arms race nobody wins. So it needs a real browser.
//
// Which is why this is ON DEMAND, not a crawl. A coach presses a button for
// one creator, one browser starts, reads the dates, and shuts down. Checking
// 877 profiles every morning would be both rude to TikTok and far beyond what
// a 512MB box can carry; checking one, when somebody is about to make a call,
// costs a few seconds and happens perhaps twenty times a day.
//
// Everything here fails soft. Playwright may not be installed, the host may
// have no Chromium, TikTok may show a captcha. In all of those cases the
// answer is "could not check", the page says so plainly, and nothing else in
// the service notices.
import fs from 'node:fs';
import path from 'node:path';

const CACHE = 'shortform.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Same hardening as the avatar cache: a handle becomes a cache key and must
// survive being one. Stripping slashes stops a traversal; collapsing dots keeps
// the key readable, so "../../etc/passwd" is "etcpasswd" and not "....etcpasswd".
export const handleKey = (u) => String(u ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9._-]/g, '')
  .replace(/\.{2,}/g, '.')
  .replace(/^[.\-]+/, '')
  .slice(0, 64);

function cachePath(dataDir) { return path.join(dataDir, CACHE); }

export function readCache(dataDir) {
  try {
    const p = cachePath(dataDir);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

function writeCache(dataDir, cache) {
  const p = cachePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, p);
}

/** What we already hold for this creator, if it is still fresh enough. */
export function cachedShortForm(dataDir, username, { maxAgeHours = 12, now = Date.now() } = {}) {
  const hit = readCache(dataDir)[handleKey(username)];
  if (!hit?.checkedAt) return null;
  if (now - hit.checkedAt > maxAgeHours * 3600000) return { ...hit, stale: true };
  return hit;
}

/**
 * Turn a list of post timestamps into the thing a coach needs to know.
 *
 * The threshold is Perry's: more than three days without posting is bad, and
 * the target is every day. Kept here rather than in the page so the number has
 * one home.
 */
export function readPosts(times, { now = Date.now(), badAfterDays = 3 } = {}) {
  const secs = [...new Set((times ?? []).filter((t) => Number.isFinite(t)))].sort((a, b) => b - a);
  if (!secs.length) {
    return { ok: true, posts: 0, lastPostAt: null, daysSince: null, last7: 0, last30: 0, verdict: 'none' };
  }
  const day = 86400000;
  const lastMs = secs[0] * 1000;
  const daysSince = Math.floor((now - lastMs) / day);
  const since = (d) => secs.filter((t) => now - t * 1000 <= d * day).length;
  return {
    ok: true,
    posts: secs.length,
    lastPostAt: new Date(lastMs).toISOString().slice(0, 10),
    daysSince,
    last7: since(7),
    last30: since(30),
    verdict: daysSince > badAfterDays ? 'cold' : daysSince >= 2 ? 'slowing' : 'good',
  };
}

/** The sentence a coach reads, and the one they can act on. */
export function shortFormAdvice(r) {
  if (!r?.ok) return null;
  if (r.verdict === 'none') {
    return {
      headline: 'No short form at all',
      detail: 'Nothing on their profile. Short form is how people find a LIVE — 70% of a full-time streamer\'s traffic comes from it. This is the cheapest thing they could change this week.',
    };
  }
  if (r.verdict === 'cold') {
    return {
      headline: `Last posted ${r.daysSince} days ago`,
      detail: `${r.last7} post${r.last7 === 1 ? '' : 's'} in the last 7 days. Anything past three days is too long — the feed stops carrying them and the LIVE loses its front door.`,
    };
  }
  if (r.verdict === 'slowing') {
    return {
      headline: `Last posted ${r.daysSince} days ago`,
      detail: `${r.last7} in the last 7 days. Not cold, but the target is every day — 15 to 30 seconds of LIVE-inspired clip is enough.`,
    };
  }
  return {
    headline: r.daysSince === 0 ? 'Posted today' : 'Posted yesterday',
    detail: `${r.last7} in the last 7 days, ${r.last30} in the last 30. This is the half most creators skip — tell them it is working.`,
  };
}

/** The message a coach can send about it. No figures about anyone but them. */
export function shortFormMessage(username, r) {
  const at = `@${String(username ?? '').replace(/^@/, '')}`;
  if (r?.verdict === 'good') {
    return `${at} 🔥 noticed you've been posting properly — keep it up, that's exactly what feeds your LIVE.\n\nThe clips that work best are the ones that make someone want to come and watch you right now. More of those 💙`;
  }
  return `${at} 👀 quick one that'll make a real difference — short form.\n\n15 to 30 seconds, straight from your LIVE. "Every time someone joins my live, this happens", "I'm playing this game in my live" — that kind of thing. It doesn't have to be fancy, it just has to make someone want to come in.\n\nPeople watch the clip, tap into your LIVE, and the algorithm pushes both further. Posting every day is the goal.\n\nIf you want a hand with editing, say the word 💙`;
}

/**
 * Go and look. One creator, one browser, torn down afterwards.
 *
 * Serialised by the caller: two Chromiums on a small box is how the whole
 * service gets killed by the OOM reaper, which would take the monitoring down
 * with it to answer a question about one creator's feed.
 */
export async function checkShortForm(dataDir, username, {
  now = Date.now(), timeoutMs = 45000, badAfterDays = 3,
} = {}) {
  let browser = null;
  try {
    // Imported here rather than at the top so the service starts, and every
    // other page works, on a host where playwright is not installed at all.
    // Resolved in the order a host is likely to have it: an explicit path for
    // a box where the browser lives somewhere unusual, then the two package
    // names. All three may fail, and that is a supported outcome.
    const mod = process.env.PLAYWRIGHT_MODULE
      ? await import(process.env.PLAYWRIGHT_MODULE)
      : await import('playwright').catch(() => import('playwright-core'));
    // Playwright ships as CommonJS, so an ESM import puts it on .default on
    // some installs and at the top level on others. Take whichever is there.
    const pw = mod?.chromium ? mod : mod?.default;
    if (!pw?.chromium) throw new Error('no chromium in the playwright module');
    const launch = {
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        // A small box cannot afford a process per tab.
        '--single-process', '--no-zygote',
      ],
    };
    if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
    browser = await pw.chromium.launch(launch);
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const times = [];
    page.on('response', async (res) => {
      if (!/item_list/.test(res.url())) return;
      try {
        const body = await res.json();
        for (const item of body.itemList ?? []) {
          if (Number.isFinite(item?.createTime)) times.push(item.createTime);
        }
      } catch { /* a response we cannot read is not a failure of the check */ }
    });

    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
      waitUntil: 'domcontentloaded', timeout: timeoutMs,
    });
    // The list arrives after the page does, and in batches. Stopping at the
    // first batch gave "3 posts in the last 30 days" for a creator with 53 —
    // the day count was right and every other number was wrong. So wait for the
    // batches to stop arriving rather than for the first one, with a hard
    // ceiling so a slow profile cannot hold the request open.
    const ceiling = Date.now() + Math.min(timeoutMs, 20000);
    let settledAt = null;
    let seen = -1;
    while (Date.now() < ceiling) {
      if (times.length !== seen) { seen = times.length; settledAt = Date.now(); }
      // Quiet for a second and a half, with something in hand: that is the lot.
      else if (times.length && Date.now() - settledAt > 1500) break;
      await page.waitForTimeout(300);
    }

    const out = { ...readPosts(times, { now, badAfterDays }), checkedAt: now, username };
    const cache = readCache(dataDir);
    cache[handleKey(username)] = out;
    writeCache(dataDir, cache);
    return out;
  } catch (err) {
    // Said plainly rather than swallowed: a coach who presses a button and
    // gets nothing assumes the creator is fine.
    return { ok: false, reason: String(err?.message ?? err).slice(0, 160), checkedAt: now, username };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
