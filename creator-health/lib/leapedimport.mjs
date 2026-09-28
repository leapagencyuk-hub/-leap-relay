// Seed the leap records from LEAP's own manual marks.
//
// WHY THIS EXISTS
//
// A leap is cumulative and for life: 5 LIVE hours and 5,000 diamonds at any
// point in a creator's time with us. This system can only add up what it has
// watched, and it started watching on 31 August. Every creator who cleared the
// bar before that reads as not having cleared it, so the first time they earn
// a diamond under our eye they look like a brand new leap and bill £10 that
// LEAP already paid by hand.
//
// That is not a small rounding: of the 73 leaps the September card was about to
// bill, 67 were already marked off manually. £670 of £730.
//
// LEAP tracked it in the Notes column of the Manage creators export — the word
// LEAP against a creator's name. That column is the record of what has already
// been paid, so it is the truth about the past and this reads it in.
//
// HOW IT WRITES THEM
//
// As carried-over records: `credited: false`, `fee: 0`, `month: null`. The
// creator is on the books as leaped, so they can never leap again and never
// bill again, and no month's payroll claims them — because no month of ours
// paid for them. It is the same shape leaped.mjs already uses for anyone who
// cleared the bar before its first run, so nothing downstream needs to know
// where a record came from.
//
// THE ONE PLACE IT OVERRIDES THE FREEZE RULE, AND ONLY ONCE
//
// A leap record is frozen on first sight, because a leap that has been paid
// must not change value because a file was re-read. This breaks that in
// exactly one case: the FIRST import, on a record we credited for a creator
// LEAP had already marked by hand.
//
// That record is not a payment, it is a mistake — we billed for a leap that
// happened before we were watching and was settled outside this system. LEAP's
// mark is the authority there, because it predates anything here.
//
// After that first import the authority flips, and this is the part that
// matters going forward. LEAP will keep marking creators by hand as they leap.
// From now on we have watched those creators cross the bar ourselves, so a
// mark on somebody we credited this month is LEAP agreeing with us, not
// correcting us. Treating it as a correction would quietly delete a real £10
// every time somebody uploads the management export.
//
// So the first import backfills and corrects; every one after it only adds
// creators we have never seen leap, and leaves our own credits alone.
// `leapedImportedOn` is what remembers which of the two this is.
import { readSheetRows } from './xlsx.mjs';

/** The note that means "already leaped". LEAP write it a few different ways. */
const LEAPED_NOTE = /^leap(ed)?$/i;

/**
 * Is this a Manage creators export rather than the daily Creator data one?
 *
 * The two are both .xlsx exports of the same network and easy to confuse. This
 * one has a Notes column and puts its header on the second row, because the
 * first carries the export timestamp. Sniffing it means somebody can drop
 * either file on the same page and get the right thing done with it.
 */
export function isManageExport(filePath) {
  try {
    const rows = readSheetRows(filePath);
    const header = rows.findIndex((r) => r?.includes("Creator's username"));
    return header >= 0 && rows[header].includes('Notes');
  } catch {
    return false;
  }
}

/**
 * Read the manual marks out of a Manage creators export.
 *
 * That export is not the Creator data one: its header sits on the second row
 * because the first carries the export timestamp, and its columns are the
 * management view rather than the daily numbers.
 */
export function readManualLeaps(filePath) {
  const rows = readSheetRows(filePath);
  const headerRow = rows.findIndex((r) => r?.includes("Creator's username"));
  if (headerRow < 0) {
    throw new Error('not a Manage creators export — no "Creator\'s username" column');
  }
  const H = rows[headerRow];
  const at = (name) => H.indexOf(name);
  const iUser = at("Creator's username");
  const iNote = at('Notes');
  const iId = H.findIndex((h) => /^Creator ID/i.test(String(h ?? '')));
  if (iNote < 0) throw new Error('no Notes column — nothing to import');

  const exportedAt = String(rows[0]?.[0] ?? '').replace(/^Exported at\s*:?\s*/i, '').slice(0, 10) || null;

  const marks = [];
  for (const r of rows.slice(headerRow + 1)) {
    const username = r?.[iUser];
    if (!username) continue;
    if (!LEAPED_NOTE.test(String(r[iNote] ?? '').trim())) continue;
    marks.push({
      username: String(username).trim(),
      creatorId: iId >= 0 && r[iId] ? String(r[iId]).trim() : null,
    });
  }
  return { exportedAt, marks, scanned: rows.length - headerRow - 1 };
}

/**
 * Write the marks into the leap records, without disturbing what is there.
 *
 * Matching is by creator id first and username second. The id is stable across
 * a rename; the username is what a person recognises, and is the only handle
 * for a row whose id did not come through.
 */
export function importManualLeaps({ marks, creators, store, exportedAt = null, persist = true }) {
  store.data.leaped ??= {};
  const records = store.data.leaped;
  // The first import backfills a history we never saw. Every later one is a
  // routine top-up against records we made ourselves.
  const firstImport = !store.data.leapedImportedOn;

  const byId = new Map();
  const byName = new Map();
  for (const c of creators) {
    if (c.creatorId) byId.set(String(c.creatorId), c);
    byName.set(String(c.username).toLowerCase(), c);
  }

  const added = [];
  const corrected = [];
  const kept = [];
  const already = [];
  const unmatched = [];

  for (const m of marks) {
    const c = (m.creatorId && byId.get(m.creatorId)) || byName.get(m.username.toLowerCase()) || null;
    if (!c) { unmatched.push(m.username); continue; }

    const existing = records[c.key];
    if (existing) {
      // Already carried over, or already correct: nothing to do.
      if (!existing.credited) { already.push(c.username); continue; }
      // We watched this one cross the bar and billed for it. A mark on them is
      // LEAP agreeing, not correcting, so the credit stands.
      if (!firstImport) { kept.push(c.username); continue; }
      // First import only: we billed for a leap LEAP had already paid. Correct
      // it, and keep what it claimed so the correction is legible afterwards.
      const fixed = {
        ...existing,
        month: null,
        credited: false,
        carriedOver: true,
        fee: 0,
        source: 'manual',
        correctedOn: exportedAt,
        wasCredited: { month: existing.month, fee: existing.fee },
      };
      if (persist) records[c.key] = fixed;
      corrected.push(fixed);
      continue;
    }

    const record = {
      creatorKey: c.key,
      username: c.username,
      group: c.group ?? null,
      coach: c.manager ?? null,
      // The date LEAP's own export was taken. We cannot know when each one
      // actually crossed, and inventing a date would put a leap in a month
      // whose payroll is already closed.
      on: exportedAt,
      month: null,
      credited: false,
      carriedOver: true,
      fee: 0,
      currency: 'GBP',
      atHours: null,
      atDiamonds: null,
      // So a later question about a strange record has an answer.
      source: 'manual',
    };
    if (persist) records[c.key] = record;
    added.push(record);
  }

  if (persist) {
    store.data.leapedImportedOn = exportedAt ?? new Date().toISOString().slice(0, 10);
  }
  return { added, corrected, kept, already, unmatched, exportedAt, firstImport };
}

/** One line a person can read. */
export function importSummary({ added, corrected, kept, already, unmatched }) {
  const parts = [`${added.length} carried over`];
  if (corrected?.length) {
    const money = corrected.reduce((n, r) => n + (r.wasCredited?.fee ?? 0), 0);
    parts.push(`${corrected.length} corrected off this month's bill (£${money.toFixed(2)})`);
  }
  if (kept?.length) parts.push(`${kept.length} we billed ourselves, left alone`);
  if (already.length) parts.push(`${already.length} already on the books`);
  if (unmatched.length) parts.push(`${unmatched.length} not in the creator data`);
  return `${parts.join(', ')}.`;
}
