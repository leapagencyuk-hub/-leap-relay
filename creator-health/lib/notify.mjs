// Delivery. Each coach can be routed to their own webhook (Slack, Discord,
// Telegram bridge, an email relay — anything that accepts a JSON POST), with a
// fallback for anyone unrouted. Nothing here is Slack-specific beyond the
// default payload shape, which most tools accept.
import fs from 'node:fs';
import path from 'node:path';

/**
 * routes.json:
 * {
 *   "default": { "url": "https://hooks.slack.com/..." },
 *   "coaches": {
 *     "joshbates93@hotmail.com": { "url": "https://hooks.slack.com/...", "mention": "@josh" }
 *   },
 *   "summary": { "url": "https://hooks.slack.com/..." }
 * }
 */
export function loadRoutes(configDir) {
  const p = path.join(configDir, 'routes.json');
  if (!fs.existsSync(p)) return { default: null, coaches: {}, summary: null };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Environment variables win, so webhook URLs never have to be committed.
  const expand = (r) => (r?.url?.startsWith('env:') ? { ...r, url: process.env[r.url.slice(4)] } : r);
  return {
    default: expand(raw.default),
    summary: expand(raw.summary) ?? expand(raw.default),
    coaches: Object.fromEntries(Object.entries(raw.coaches ?? {}).map(([k, v]) => [k.toLowerCase(), expand(v)])),
  };
}

function payloadFor(route, text) {
  const body = route.mention ? `${route.mention}\n${text}` : text;
  // Slack and Discord both accept a bare {text}/{content}; send both keys so one
  // webhook config works for either.
  return JSON.stringify({ text: body, content: body });
}

async function post(url, body, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return { ok: true, status: res.status };
      // 4xx other than rate limiting will not fix itself; stop early.
      if (res.status !== 429 && res.status < 500) {
        return { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  return { ok: false, error: lastError };
}

/** Send each coach their digest. `dryRun` prints instead of posting. */
export async function sendDigests(digests, routes, { dryRun = false, summary = null } = {}) {
  const results = [];
  for (const d of digests) {
    const route = routes.coaches[d.coach] ?? routes.default;
    if (!route?.url) { results.push({ coach: d.coach, ok: false, error: 'no webhook configured' }); continue; }
    if (dryRun) { results.push({ coach: d.coach, ok: true, dryRun: true }); continue; }
    results.push({ coach: d.coach, ...(await post(route.url, payloadFor(route, d.text))) });
  }
  if (summary && routes.summary?.url) {
    results.push({ coach: '(summary)', ...(dryRun ? { ok: true, dryRun: true } : await post(routes.summary.url, payloadFor(routes.summary, summary))) });
  }
  return results;
}
