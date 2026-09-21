// Discord: posting, and the shape of what gets posted.
//
// Deliberately the same approach creator-health takes — no library, four REST
// endpoints, `fetch` and the rate limiter. The two services then behave
// identically when Discord is slow, and there is one thing to understand
// instead of two.
import crypto from 'node:crypto';

const API = 'https://discord.com/api/v10';
export const COLOR = { andy: 0x5b8def, warn: 0xf76b15, error: 0xe5484d, quiet: 0x8b8d98 };

// Discord truncates a message at 2000 characters and an embed description at
// 4096. Andy answers well inside that, but a long one must be split rather
// than silently cut off mid-sentence.
export const MESSAGE_LIMIT = 2000;

async function request(method, route, { token, body = null, retries = 3 } = {}) {
  let lastError = null;
  let networkFailures = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(route.startsWith('http') ? route : `${API}${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bot ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) {
        const info = await res.json().catch(() => ({}));
        await new Promise((r) => setTimeout(r, Math.min((info.retry_after ?? 1) * 1000 + 250, 30000)));
        lastError = 'rate limited';
        continue;
      }
      if (res.status === 204) return { ok: true, body: null };
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (res.ok) return { ok: true, body: parsed };
      if (res.status < 500) return { ok: false, status: res.status, error: text.slice(0, 300) };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
      if (++networkFailures >= 2) return { ok: false, error: `network: ${lastError}` };
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return { ok: false, error: lastError };
}

export class Discord {
  constructor({ token = null, applicationId = null } = {}) {
    this.token = token;
    this.applicationId = applicationId;
  }

  postToChannel(channelId, payload) {
    return request('POST', `/channels/${channelId}/messages`, { token: this.token, body: payload });
  }

  /** The follow-up to a deferred interaction. The token, not the bot, authorises it. */
  followUp(interactionToken, payload) {
    return request('POST', `/webhooks/${this.applicationId}/${interactionToken}`, { body: payload });
  }

  editOriginal(interactionToken, payload) {
    return request('PATCH', `/webhooks/${this.applicationId}/${interactionToken}/messages/@original`, { body: payload });
  }

  createThread(channelId, messageId, name) {
    return request('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
      token: this.token,
      body: { name: name.slice(0, 100), auto_archive_duration: 1440 },
    });
  }

  registerCommands(guildId, commands) {
    const route = guildId
      ? `/applications/${this.applicationId}/guilds/${guildId}/commands`
      : `/applications/${this.applicationId}/commands`;
    return request('PUT', route, { token: this.token, body: commands });
  }

  me() { return request('GET', '/users/@me', { token: this.token }); }
}

/**
 * Verify Discord's Ed25519 signature against the raw request bytes.
 *
 * Must be the raw body: re-serialising the JSON reorders keys and the signature
 * stops matching. Discord will not accept an interactions endpoint that does
 * not reject a bad signature with a 401.
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifySignature(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]),
      key,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * An answer, as Discord messages.
 *
 * The answer is plain text rather than an embed — an embed renders as a quoted
 * block and reads like a bot announcement, where Andy should read like a
 * colleague replying. The sources go in a small embed underneath, which keeps
 * them out of the way but clickable.
 */
export function answerMessages(result) {
  const parts = splitForDiscord(result.text || '_No answer._');
  const messages = parts.map((content) => ({ content, allowed_mentions: { parse: [] } }));

  const footer = [];
  if (result.citations?.length) {
    const lines = result.citations.slice(0, 10).map((c) => {
      const where = [c.heading, c.page > 1 ? `p${c.page}` : null].filter(Boolean).join(' · ');
      const label = `\`#${c.id}\` ${c.title}${where ? ` — ${where}` : ''}`;
      return c.link ? `${label} · [open](${c.link})` : label;
    });
    if (result.citations.length > 10) lines.push(`…and ${result.citations.length - 10} more`);
    footer.push({
      color: COLOR.quiet,
      title: `Sources (${result.citations.length})`,
      description: lines.join('\n').slice(0, 4000),
    });
  } else if (result.used?.some((u) => u.tool === 'search_knowledge')) {
    footer.push({
      color: COLOR.warn,
      description: '_Nothing in the library covered this — answered from the creator data and general knowledge._',
    });
  }

  if (footer.length) messages[messages.length - 1].embeds = footer;
  return messages;
}

/** Split on paragraph then line boundaries, never mid-sentence. */
export function splitForDiscord(text, limit = MESSAGE_LIMIT) {
  const clean = String(text).trim();
  if (clean.length <= limit) return [clean];

  const parts = [];
  let current = '';
  for (const block of clean.split(/\n\n+/)) {
    if (current && current.length + block.length + 2 > limit) { parts.push(current); current = ''; }
    if (block.length > limit) {
      // One paragraph longer than a whole message: fall back to lines, then
      // to hard width, so nothing is ever dropped.
      for (const line of block.split('\n')) {
        if (current && current.length + line.length + 1 > limit) { parts.push(current); current = ''; }
        if (line.length > limit) {
          for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
          continue;
        }
        current = current ? `${current}\n${line}` : line;
      }
      continue;
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

export function errorMessage(message) {
  return { embeds: [{ color: COLOR.error, description: message.slice(0, 4000) }] };
}
