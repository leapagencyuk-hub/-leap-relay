// Links a coach can open.
//
// The portal has to work from a Discord message on a phone, which rules out a
// login: nobody is typing a password to read a card about @bangeduptoes. So the
// link itself is the credential, and it has to be unguessable and unforgeable.
//
// A token is the subject and the role, signed with a server secret. No expiry:
// these links sit in Discord channels for months and a coach opening last
// Tuesday's ping should still land somewhere useful. Rotating PORTAL_SECRET
// invalidates every link at once, which is the revocation story.
//
// FAIL CLOSED. With no secret set there is no portal at all, every route
// answers 503, and nothing is served. A portal is a data surface with real
// earnings on it; the one thing worse than not having it is having it open.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Three audiences, and the difference between the first two is money.
//
// COACH is personal: it carries that coach's pay, so the link is personal too
// and must only ever reach them. TEAM is the same roster with every earnings
// line stripped, which is what makes it safe to put in a card that lands in a
// shared channel. A card posted to a team room cannot carry a COACH link —
// everyone else in the room would be able to open that coach's wage.
export const ROLE = { COACH: 'c', DIRECTOR: 'd', TEAM: 't' };

/** The signing secret, or null when the portal is switched off. */
export function portalSecret(env = process.env) {
  const s = env.PORTAL_SECRET;
  return typeof s === 'string' && s.length >= 16 ? s : null;
}

function sign(payload, secret) {
  // 16 bytes is 128 bits of forgery resistance, which is plenty for a link and
  // keeps the URL short enough to read out loud.
  return b64url(crypto.createHmac('sha256', secret).update(payload).digest().subarray(0, 16));
}

/**
 * A link token for one subject.
 * `subject` is the coach's email address, or '*' for a director.
 */
export function mintToken(subject, role, secret) {
  if (!secret) return null;
  const payload = b64url(`${role}|${String(subject).toLowerCase()}`);
  return `${payload}.${sign(payload, secret)}`;
}

/** The subject and role a token carries, or null if it is not ours. */
export function readToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  // Constant time: a length mismatch here would otherwise leak the signature
  // one character at a time to anybody willing to time the responses.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const decoded = unb64url(payload).toString('utf8');
  const bar = decoded.indexOf('|');
  if (bar < 0) return null;
  const role = decoded.slice(0, bar);
  const subject = decoded.slice(bar + 1);
  if (role !== ROLE.COACH && role !== ROLE.DIRECTOR && role !== ROLE.TEAM) return null;
  if (!subject) return null;
  return { role, subject };
}

/** Every coach's link, for pasting into Discord. Directors get one too. */
export function allLinks(coaches, baseUrl, secret) {
  if (!secret) return null;
  const root = String(baseUrl ?? '').replace(/\/+$/, '');
  const link = (subject, role) => `${root}/portal/${mintToken(subject, role, secret)}`;
  return {
    director: link('*', ROLE.DIRECTOR),
    coaches: coaches.map((c) => ({ coach: c.coach, name: c.name, url: link(c.coach, ROLE.COACH) })),
  };
}

/** A team's link. Same roster, no earnings — safe in a shared channel. */
export function teamLink(team, baseUrl, secret) {
  if (!secret || !team) return null;
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}/portal/${mintToken(team, ROLE.TEAM, secret)}`;
}
