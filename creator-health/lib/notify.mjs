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
/**
 * Routing config, local first.
 *
 * `routes.json` holds real webhook URLs and is gitignored, so it never reaches
 * a deploy. `routes.deploy.json` is the committed twin that refers to
 * environment variables instead — without this fallback a deployed service
 * starts with no Discord config at all and silently posts nothing.
 */
export function loadRoutes(configDir) {
  const p = [
    path.join(configDir, 'routes.json'),
    path.join(configDir, 'routes.deploy.json'),
  ].find((f) => fs.existsSync(f));
  if (!p) return { default: null, coaches: {}, summary: null, discord: emptyDiscord() };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Environment variables win, so no token or webhook URL is ever committed.
  const expand = (r) => (r?.url?.startsWith('env:') ? { ...r, url: process.env[r.url.slice(4)] } : r);
  return {
    default: expand(raw.default),
    summary: expand(raw.summary) ?? expand(raw.default),
    coaches: Object.fromEntries(Object.entries(raw.coaches ?? {}).map(([k, v]) => [k.toLowerCase(), expand(v)])),
    discord: loadDiscordConfig(raw.discord),
  };
}

const fromEnv = (v) => (typeof v === 'string' && v.startsWith('env:') ? process.env[v.slice(4)] ?? null : v ?? null);
/** Scaffolded placeholders must not be mistaken for real values. */
const placeholderOrNull = (v) => (typeof v === 'string' && !/^PASTE_/.test(v.trim()) ? v : null);
const emptyDiscord = () => ({ enabled: false, coaches: {} });

/** Resolve the Discord block, pulling every secret from the environment. */
/**
 * Group names arrive from the export with inconsistent case and stray spaces
 * ("TEAM GOLF", "Team Indigo "), so every lookup goes through this.
 */
export const groupKey = (name) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Discord snowflakes are 17-20 digits. Anything else — most often a
 * `PASTE_CHANNEL_ID` placeholder left behind in a half-filled routes.json — is
 * treated as unset, so a coverage check cannot report a team as routed when
 * its card would bounce.
 */
export const isChannelId = (v) => typeof v === 'string' && /^\d{17,20}$/.test(v.trim());
export const isWebhookUrl = (v) => typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim());
const channelOrNull = (v) => (isChannelId(v) ? v.trim() : null);
const webhookOrNull = (v) => (isWebhookUrl(v) ? v.trim() : null);

export function loadDiscordConfig(raw) {
  if (!raw) return emptyDiscord();
  const coaches = {};
  for (const [email, entry] of Object.entries(raw.coaches ?? {})) {
    coaches[email.toLowerCase()] = {
      channelId: channelOrNull(fromEnv(entry.channelId)),
      userId: channelOrNull(fromEnv(entry.userId)),
      webhook: webhookOrNull(fromEnv(entry.webhook)),
      mention: placeholderOrNull(entry.mention),
    };
  }
  const groups = {};
  for (const [name, entry] of Object.entries(raw.groups ?? {})) {
    groups[groupKey(name)] = {
      label: name,
      channelId: channelOrNull(fromEnv(entry.channelId)),
      webhook: webhookOrNull(fromEnv(entry.webhook)),
      mention: placeholderOrNull(entry.mention),
    };
  }
  return {
    enabled: raw.enabled !== false,
    mode: raw.mode ?? 'webhook',
    // A server with one channel per team routes by group; one channel per coach
    // routes by coach. Group is the default because that is how LEAP's server
    // is laid out.
    routeBy: raw.routeBy ?? 'group',
    // Set false until the interactions endpoint is deployed and saved in the
    // Discord portal; cards then post without buttons rather than with dead ones.
    interactionsReady: raw.interactionsReady !== false,
    groups,
    botToken: fromEnv(raw.botToken),
    publicKey: fromEnv(raw.publicKey),
    applicationId: fromEnv(raw.applicationId),
    defaultChannelId: channelOrNull(fromEnv(raw.defaultChannelId)),
    defaultWebhook: webhookOrNull(fromEnv(raw.defaultWebhook)),
    escalationChannelId: channelOrNull(fromEnv(raw.escalationChannelId)),
    summaryChannelId: channelOrNull(fromEnv(raw.summaryChannelId)),
    escalationWebhook: webhookOrNull(fromEnv(raw.escalationWebhook)),
    summaryWebhook: webhookOrNull(fromEnv(raw.summaryWebhook)),
    coaches,
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
