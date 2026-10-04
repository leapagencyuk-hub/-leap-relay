// The Star Light campaign roster, read from Backstage's "Activity Host Rank"
// export.
//
// WHAT THIS FILE IS
//
//   Backstage exports one Activity Host Rank sheet per campaign, named by the
//   campaign's numeric id. LEAP is running two, so there are two sheets, and
//   which sheet a creator is in IS their campaign — there is no campaign column.
//   They are told apart by their columns:
//
//     Campaign A ("the 70", 64 rows)   no "Active interaction days" column
//     Campaign B ("the 204", 129 rows) has "Active interaction days"
//
//   That matches the brief: A's ladder is minutes and days only, B's adds
//   interaction days, and Backstage only exports the column a campaign scores.
//
// WHAT IT SETTLED
//
//   Two of the brief's open items, from the files themselves:
//
//   1. The 70 WERE excluded from Campaign B. Of 193 rows across both sheets,
//      exactly one creator appears in both (ginaribena6095). So the exclusion
//      was applied and leaked once, rather than being skipped.
//
//   2. "Go-LIVE days during Event" is the same counter as the creator export's
//      "Valid go LIVE days" — a day needs a full hour on it. The sheets prove
//      the cut: kc.is.live and 9erz.tj both read 1h0min and 1 day, while
//      irishcarscene2.0_ reads 0h38min and 0 days. Sixty minutes counts,
//      thirty-eight do not.
//
//      That is why the daily card does not depend on this file for its day
//      counts. The creator export we already pull every morning carries the
//      same number, so the chase stays current between uploads of this sheet.
//
//   And it exposed one thing the brief did not have:
//
//   3. "Active interaction days" is NOT bounded by LIVE days, so it is not
//      "days you interacted while LIVE". kbx5463, shiey0_6 and gamergirlamy94
//      all read 0 LIVE days and 4 interaction days, while nosgamingxsx reads 3
//      LIVE days, 22h50min and 0 interaction days. So a creator can put the
//      hours in and score nothing on interaction — which is a specific, fixable
//      coaching job, and the card names those creators because nothing else we
//      have would.
//
// WHAT IS TAKEN FROM HERE, AND WHAT IS NOT
//
//   Taken: who is in the campaign, which campaign they are in, their
//   interaction days, and Backstage's own completed stage.
//   Not taken: the day and hour counts, which come from the daily export.
//
//   Everything from here carries the sheet's own date, because this file is
//   uploaded by hand and will go stale while the export does not. The card
//   shows both dates rather than implying one freshness for both.
import fs from 'node:fs';
import path from 'node:path';
import { readSheetObjects } from './xlsx.mjs';
import { parseNumber, parseDurationHours } from './normalize.mjs';

const ROSTER_FILE = 'starlight-roster.json';

const COLUMNS = {
  username: 'UserName',
  nickname: 'Nickname',
  stage: 'Completed stage',
  completedAt: 'Completion time(UTC+0)',
  diamonds: 'Diamonds',
  duration: 'LIVE duration',
  days: 'Go-LIVE days during Event',
  interactionDays: 'Active interaction days',
};

export const handle = (u) => String(u ?? '').trim().replace(/^@/, '').toLowerCase();

/** Does this sheet look like an Activity Host Rank export? */
export function isActivityHostRank(headers) {
  return headers.includes(COLUMNS.username) && headers.includes(COLUMNS.days);
}

/**
 * The same question for a file on disk, so the one upload page can sniff it.
 *
 * Three different .xlsx exports come off Backstage and they are easy to
 * confuse. Rather than make somebody pick the right button, each is recognised
 * by a column only it has — this one by "Go-LIVE days during Event", which the
 * daily Creator data export and the Manage creators export do not carry.
 */
export function isActivityHostRankFile(filePath) {
  try {
    return isActivityHostRank(readSheetObjects(filePath).headers);
  } catch {
    return false;
  }
}

/**
 * Pull the campaign id and the sheet's date out of the filename.
 *
 * Backstage names them "Activity_Host_Rank_-_<id>_<yyyy>_<mm>_<dd>_<hh>_<mm>_UTC0.xlsx".
 * The id is what tells two campaigns apart across re-uploads, so a sheet whose
 * name has been changed is still accepted — it just falls back to the column
 * shape for its campaign, and to today for its date.
 */
export function describeFile(filename) {
  const base = path.basename(String(filename ?? ''));
  const id = /Activity[_ ]Host[_ ]Rank[_ -]+(\d{6,})/i.exec(base)?.[1] ?? null;
  const date = /(\d{4})[_-](\d{2})[_-](\d{2})/.exec(base);
  return { id, asOf: date ? `${date[1]}-${date[2]}-${date[3]}` : null };
}

/**
 * Read one Activity Host Rank sheet.
 *
 * `campaign` is worked out from the columns, not guessed from the row count:
 * the sheet with interaction days is B, the one without is A. A named override
 * wins, for the day LEAP runs a third campaign.
 */
export function readRosterFile(filePath, { campaign = null } = {}) {
  const { headers, records } = readSheetObjects(filePath);
  if (!isActivityHostRank(headers)) {
    throw new Error(`${path.basename(filePath)} does not look like an Activity Host Rank export (no "${COLUMNS.days}" column)`);
  }
  const hasInteraction = headers.includes(COLUMNS.interactionDays);
  const { id, asOf } = describeFile(filePath);
  const which = campaign ?? (hasInteraction ? 'B' : 'A');

  const creators = [];
  for (const row of records) {
    const username = handle(row[COLUMNS.username]);
    if (!username) continue;
    creators.push({
      username,
      nickname: row[COLUMNS.nickname] ?? null,
      campaign: which,
      campaignId: id,
      // Backstage's own ticket count. Kept beside ours rather than instead of
      // it, so a disagreement is visible instead of silently resolved.
      stage: parseNumber(row[COLUMNS.stage]) ?? 0,
      completedAt: row[COLUMNS.completedAt] === '-' ? null : (row[COLUMNS.completedAt] ?? null),
      diamonds: parseNumber(row[COLUMNS.diamonds]) ?? 0,
      days: parseNumber(row[COLUMNS.days]) ?? 0,
      hours: parseDurationHours(row[COLUMNS.duration]) ?? 0,
      // Only campaign B scores this, and only B's sheet carries it. Null means
      // "not scored", which is different from zero.
      interactionDays: hasInteraction ? (parseNumber(row[COLUMNS.interactionDays]) ?? 0) : null,
    });
  }
  return { campaign: which, campaignId: id, asOf, scoresInteraction: hasInteraction, count: creators.length, creators };
}

const rosterPath = (dataDir) => path.join(dataDir, ROSTER_FILE);

export function readRoster(dataDir) {
  const p = rosterPath(dataDir);
  if (!fs.existsSync(p)) return { campaigns: {}, creators: {}, updatedAt: null };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Store a sheet into the roster.
 *
 * Keyed by campaign, and a re-upload REPLACES that campaign wholesale rather
 * than merging. That is deliberate: a creator Backstage has dropped from a
 * campaign has to disappear from the card, and a merge would keep chasing them
 * forever.
 */
export function saveRosterFile(dataDir, filePath, { campaign = null } = {}) {
  const read = readRosterFile(filePath, { campaign });
  const roster = readRoster(dataDir);
  // The sheet's export date, from its own filename. Falling back to today is
  // right for a file uploaded the day it was pulled and wrong for one pulled
  // last week, so which of the two happened is reported rather than hidden —
  // the card prints this date as the age of its interaction numbers.
  const asOfFrom = read.asOf ? 'filename' : 'upload date';
  const asOf = read.asOf ?? new Date().toISOString().slice(0, 10);
  const before = roster.creators ?? {};

  // Who this sheet has taken off another campaign's list, worked out before the
  // index is rewritten. The index is keyed by username and so cannot hold a
  // creator twice; the only place a move is visible is the comparison.
  const movedCampaign = read.creators
    .filter((c) => before[c.username] && before[c.username].campaign !== read.campaign)
    .map((c) => ({ username: c.username, from: before[c.username].campaign, to: read.campaign }));

  roster.campaigns = roster.campaigns ?? {};
  roster.campaigns[read.campaign] = {
    campaign: read.campaign,
    campaignId: read.campaignId,
    asOf,
    scoresInteraction: read.scoresInteraction,
    count: read.count,
    asOfFrom,
    sourceFile: path.basename(filePath),
    // The membership list is kept per campaign, not just in the flat index,
    // because that is the only way a creator in two campaigns stays visible:
    // the index would quietly keep one and drop the other.
    members: read.creators.map((c) => c.username).sort(),
  };

  // Rebuild the flat index from every campaign we hold, so a creator Backstage
  // has dropped from a campaign goes with it rather than being chased forever.
  const keep = {};
  for (const [name, entry] of Object.entries(before)) {
    if (entry.campaign !== read.campaign) keep[name] = entry;
  }
  for (const c of read.creators) keep[c.username] = { ...c, asOf };
  roster.creators = keep;
  roster.updatedAt = new Date().toISOString();

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rosterPath(dataDir), JSON.stringify(roster, null, 2));
  return {
    campaign: read.campaign,
    campaignId: read.campaignId,
    asOf,
    asOfFrom,
    count: read.count,
    total: Object.keys(keep).length,
    movedCampaign,
    inBoth: overlaps(roster),
  };
}

/**
 * Creators listed in more than one campaign.
 *
 * The brief's rule is that a creator takes tickets from one campaign only, so
 * this has to be reported rather than resolved — which campaign to drop them
 * from is Perry's call and Backstage's to action, not ours. Read off the
 * per-campaign membership lists, because the flat index cannot hold a
 * duplicate by construction.
 */
export function overlaps(roster) {
  const lists = Object.values(roster.campaigns ?? {})
    .filter((c) => Array.isArray(c.members));
  const seen = new Map();
  for (const c of lists) {
    for (const u of c.members) {
      const got = seen.get(u) ?? [];
      got.push(c.campaign);
      seen.set(u, got);
    }
  }
  return [...seen.entries()]
    .filter(([, camps]) => new Set(camps).size > 1)
    .map(([username, camps]) => ({ username, campaigns: [...new Set(camps)].sort() }));
}

/** How healthy the roster is, for the card footer and /selftest. */
export function rosterHealth(roster, asOf) {
  const campaigns = Object.values(roster.campaigns ?? {});
  const oldest = campaigns.length ? campaigns.map((c) => c.asOf).sort()[0] : null;
  const staleDays = oldest && asOf
    ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86400000)
    : null;
  return {
    loaded: campaigns.length > 0,
    campaigns: campaigns.map((c) => ({ campaign: c.campaign, count: c.count, asOf: c.asOf })),
    creators: Object.keys(roster.creators ?? {}).length,
    oldest,
    staleDays,
  };
}
