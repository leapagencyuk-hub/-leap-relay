// Signing in with Discord.
//
// The portal started as a signed link per coach. That works, but a link IS the
// credential, and these links live in Discord channels — so anyone in the room
// could open the page the link was minted for. Keeping a coach's wage out of a
// shared room meant stripping the money from anything linkable, which made the
// most useful part of the portal the part a coach could not reach from a card.
//
// Logging in fixes it at the root. Every card points at the same plain /portal.
// Discord says who you are, and the server decides what you see. A coach sees
// their roster and their pay; a director sees everyone; anybody else sees a
// page telling them they are not on the list.
//
// Scope is `identify` and nothing else: we want the user's id, not their email,
// not their guilds, not their connections. The id is already in routes.json as
// the mention we ping them with, so the mapping exists before anyone logs in.
import crypto from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url');

export const SESSION_COOKIE = 'leap_portal';
const DISCORD_API = 'https://discord.com/api/v10';

/** The OAuth app, or null when it has not been configured. */
export function discordApp(env = process.env) {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Where this deployment is reachable, which Discord must be told to match. */
export function redirectUri(config = {}, env = process.env, host = null) {
  const base = env.PORTAL_BASE_URL ?? config.portal?.baseUrl ?? (host ? `https://${host}` : '');
  return `${String(base).replace(/\/+$/, '')}/portal/callback`;
}

/**
 * The login URL.
 *
 * `state` is signed rather than stored. There is no session table and no
 * database here, so a random value with nowhere to live is a value we cannot
 * check on the way back — and an unchecked state is no CSRF protection at all.
 */
export function authorizeUrl({ clientId, redirect, secret, returnTo = '/portal' }) {
  const state = mintState(returnTo, secret);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url').slice(0, 22);
}

/** A signed, short-lived state value carrying where to land afterwards. */
export function mintState(returnTo, secret, now = Date.now()) {
  // Ten minutes is long enough to sign in and short enough that a state lifted
  // from a browser history is useless.
  const body = `${now + 10 * 60 * 1000}|${returnTo}`;
  return `${b64url(body)}.${hmac(b64url(body), secret)}`;
}

export function readState(state, secret, now = Date.now()) {
  if (typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expect = hmac(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [expiry, ...rest] = unb64url(body).toString('utf8').split('|');
  if (!(Number(expiry) > now)) return null;
  const returnTo = rest.join('|');
  // Only ever a path on this host. An open redirect here would let somebody
  // bounce a signed-in coach to a page of their choosing.
  return { returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/portal' };
}

/** The session cookie: a Discord id, signed, with an expiry. */
export function mintSession(discordId, secret, { days = 14, now = Date.now() } = {}) {
  const body = b64url(`${now + days * 86400000}|${discordId}`);
  return `${body}.${hmac(body, secret)}`;
}

export function readSession(value, secret, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expect = hmac(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [expiry, discordId] = unb64url(body).toString('utf8').split('|');
  if (!(Number(expiry) > now)) return null;
  return discordId || null;
}

/** Parse one Cookie header. */
export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Trade the code for an identity. Only the id is kept. */
export async function exchangeCode(code, { clientId, clientSecret, redirect, fetchImpl = fetch }) {
  const res = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
    }),
  });
  if (!res.ok) return { ok: false, status: res.status, error: await res.text().catch(() => '') };
  const token = await res.json();
  const who = await fetchImpl(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!who.ok) return { ok: false, status: who.status, error: 'could not read the Discord profile' };
  const user = await who.json();
  return { ok: true, id: String(user.id), username: user.global_name || user.username || null };
}

const idFromMention = (m) => {
  const hit = /^<@!?(\d{17,20})>$/.exec(String(m ?? '').trim());
  return hit ? hit[1] : (/^\d{17,20}$/.test(String(m ?? '').trim()) ? String(m).trim() : null);
};

/**
 * Who this Discord id is allowed to be.
 *
 * Three sources, most explicit first:
 *   config.portal.directors   — ids that see the whole network
 *   config.portal.discordIds  — id to coach address, for anything the routes
 *                               cannot express (a coach pinged as a role, a
 *                               second account, somebody covering a team)
 *   routes.json coach mentions — the mapping that already exists, because the
 *                               id we ping a coach with is the id they log in
 *                               with. Nothing new to maintain.
 *
 * An id in none of them gets nothing. There is no default role: an unknown
 * Discord account seeing a roster is the failure this whole module exists to
 * prevent.
 */
export function resolveAccess(discordId, { config = {}, discordConfig = null } = {}) {
  const id = String(discordId ?? '').trim();
  if (!/^\d{17,20}$/.test(id)) return null;

  const directors = (config.portal?.directors ?? []).map((d) => idFromMention(d) ?? String(d).trim());
  if (directors.includes(id)) {
    // `subject` stays '*' because a director's view is the whole network, but
    // the id and a name come too: anything a director writes has to be
    // attributed to the person who wrote it, not to a wildcard.
    return {
      role: 'director',
      subject: '*',
      id,
      name: config.portal?._directorNames?.[id] ?? null,
    };
  }

  const explicit = config.portal?.discordIds ?? {};
  for (const [key, coach] of Object.entries(explicit)) {
    if ((idFromMention(key) ?? key) === id) {
      return { role: 'coach', subject: String(coach).toLowerCase(), id };
    }
  }

  for (const [email, entry] of Object.entries(discordConfig?.coaches ?? {})) {
    const fromMention = idFromMention(entry.mention);
    const fromUserId = idFromMention(entry.userId);
    if (fromMention === id || fromUserId === id) {
      return { role: 'coach', subject: email.toLowerCase(), id };
    }
  }
  return null;
}

/** The Set-Cookie header for a session, and for signing out. */
export function sessionCookie(value, { days = 14, secure = true } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value ?? '')}`,
    'Path=/portal',
    'HttpOnly',
    'SameSite=Lax',
    value ? `Max-Age=${days * 86400}` : 'Max-Age=0',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
