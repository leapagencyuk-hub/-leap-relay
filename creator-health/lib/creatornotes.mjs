// What a coach did about this creator.
//
// Sur3shot's idea, and the obvious missing half of the portal: the page could
// tell a coach who to ring and could not tell them whether anybody already had.
// On a team with two coaches, or on a creator a director has already spoken to,
// that means the same person gets chased twice and somebody else gets missed.
//
// Two kinds of entry, deliberately:
//
//   contacted — a tick. "I have spoken to them." One a day per coach, because
//               a tick pressed four times is not four conversations.
//   note      — a sentence. What was said, what they agreed, what is going on
//               that the numbers cannot see.
//
// Unlike the portal visit log, this is written ON PURPOSE by the person it is
// about. That is the difference between a work log and surveillance, and it is
// why this one carries what was said and the other one carries nothing.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'creator-notes.json';
export const MAX_NOTE = 600;

export const KIND = { CONTACTED: 'contacted', NOTE: 'note' };

function filePath(dataDir) { return path.join(dataDir, FILE); }

export function readNotes(dataDir) {
  try {
    const p = filePath(dataDir);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

function write(dataDir, all) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${filePath(dataDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, filePath(dataDir));
}

/**
 * Record one entry against a creator.
 *
 * Returns the creator's whole history so the page can redraw without a second
 * read. A tick on a day that already has one from the same coach is a no-op
 * rather than a second line.
 */
export function addEntry(dataDir, creatorKey, {
  kind = KIND.NOTE, coach, coachName = null, text = '', at = new Date().toISOString(),
}) {
  if (!creatorKey || !coach) return null;
  const body = String(text ?? '').trim().slice(0, MAX_NOTE);
  if (kind === KIND.NOTE && !body) return null;

  const all = readNotes(dataDir);
  const list = all[creatorKey] ?? [];
  const day = at.slice(0, 10);
  if (kind === KIND.CONTACTED
    && list.some((e) => e.kind === KIND.CONTACTED && e.coach === coach && e.at.slice(0, 10) === day)) {
    return list;
  }
  list.push({ at, kind, coach, coachName, ...(body ? { text: body } : {}) });
  // A creator's history is a working record, not an archive. The last fifty
  // entries is more than anybody reads and keeps the file from growing without
  // limit over a year.
  all[creatorKey] = list.slice(-50);
  try { write(dataDir, all); } catch { /* a lost note must not break the page */ }
  return all[creatorKey];
}

/** This creator's history, newest first. */
export function historyFor(all, creatorKey) {
  return [...(all?.[creatorKey] ?? [])].reverse();
}

const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

/** The one line a card shows: has anybody dealt with this, and when. */
export function lastTouch(all, creatorKey, asOf) {
  const list = all?.[creatorKey] ?? [];
  if (!list.length) return null;
  const last = list[list.length - 1];
  const contacted = [...list].reverse().find((e) => e.kind === KIND.CONTACTED) ?? null;
  return {
    at: last.at,
    by: last.coachName ?? last.coach,
    kind: last.kind,
    text: last.text ?? null,
    entries: list.length,
    daysSince: Math.max(0, daysBetween(last.at.slice(0, 10), asOf)),
    contactedAt: contacted?.at ?? null,
    contactedDaysSince: contacted ? Math.max(0, daysBetween(contacted.at.slice(0, 10), asOf)) : null,
  };
}

/**
 * How much of a coach's list they have actually worked.
 *
 * Against the creators the portal put in front of them, not against their whole
 * roster: a coach with 234 creators has not failed by not ringing 234 people.
 */
export function workedSummary({ view, notes, asOf, withinDays = 7 }) {
  const needing = [...view.attention, ...view.protect, ...view.chase, ...view.upside];
  const seen = new Set();
  const list = needing.filter((r) => (seen.has(r.key) ? false : seen.add(r.key)));
  const touched = list.filter((r) => {
    const t = lastTouch(notes, r.key, asOf);
    return t?.contactedDaysSince != null && t.contactedDaysSince <= withinDays;
  });
  return {
    needing: list.length,
    worked: touched.length,
    withinDays,
    pct: list.length ? touched.length / list.length : null,
  };
}
