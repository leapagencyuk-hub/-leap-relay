// Persistence. Snapshots are the source of truth and are never rewritten; the
// per-creator series is a derived cache that `rebuild` can regenerate from them.
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

export const CUMULATIVE_FIELDS = [
  'diamonds', 'liveHours', 'validLiveDays', 'liveStreams',
  'newFollowers', 'newFans', 'fanClubDiamonds',
  'matches', 'diamondsFromMatches', 'diamondsFromMultiGuest',
];
export const LEVEL_FIELDS = ['totalFans', 'activeFanClubFans', 'fanContribution'];

export class Store {
  constructor(root) {
    this.root = root;
    this.snapshotDir = path.join(root, 'snapshots');
    this.seriesPath = path.join(root, 'series.json');
    fs.mkdirSync(this.snapshotDir, { recursive: true });
  }

  snapshotPath(asOf) { return path.join(this.snapshotDir, `${asOf}.json.gz`); }

  hasSnapshot(asOf) { return fs.existsSync(this.snapshotPath(asOf)); }

  listSnapshotDates() {
    return fs.readdirSync(this.snapshotDir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => f.replace('.json.gz', ''))
      .sort();
  }

  writeSnapshot(snapshot) {
    fs.writeFileSync(this.snapshotPath(snapshot.asOf), gzipSync(JSON.stringify(snapshot)));
  }

  readSnapshot(asOf) {
    return JSON.parse(gunzipSync(fs.readFileSync(this.snapshotPath(asOf))).toString('utf8'));
  }

  readSeries() {
    if (!fs.existsSync(this.seriesPath)) return { updatedAt: null, lastAsOf: null, creators: {} };
    return JSON.parse(fs.readFileSync(this.seriesPath, 'utf8'));
  }

  writeSeries(series) {
    const tmp = `${this.seriesPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(series));
    fs.renameSync(tmp, this.seriesPath);
  }
}

/**
 * Stable key for a creator.
 *
 * The numeric Creator ID is the real identity and survives username changes, so
 * it wins whenever the export provides one. Quit rows have it masked, so those
 * fall back to the username and are reconciled against the registry by caller.
 */
export function creatorKey(row) {
  return row.creatorId ? `id:${row.creatorId}` : `@${row.username}`;
}

function emptyCreator(row, key) {
  return {
    key,
    creatorId: row.creatorId ?? null,
    username: row.username,
    aliases: [],
    group: row.group,
    manager: row.manager,
    joinDate: row.joinDate,
    firstSeen: row.asOf,
    lastSeen: row.asOf,
    quitOn: null,
    graduationStatus: row.graduationStatus,
    tierStatus: row.tierStatus,
    isNewLiveCreator: row.isNewLiveCreator,
    // observations: one entry per snapshot, each covering `span` days ending on `date`
    obs: [],
    // point-in-time levels, keyed by date
    levels: {},
  };
}

/**
 * Fold one normalized snapshot into the series, converting month-to-date
 * cumulative counters into per-observation deltas.
 *
 * Three cases, all resolved by comparing the snapshot's period start with the
 * creator's previous observation:
 *   same month   -> delta = mtd_now - mtd_prev, span = days since prev snapshot
 *   new month    -> delta = mtd_now, span = days since the month's period start
 *   first sighting -> delta = mtd_now, span = days since period start, flagged
 *                     `partial` because we never saw this creator's month begin
 */
export function applySnapshot(series, snapshot, { goneAfter = 2 } = {}) {
  const { asOf, periodStart } = snapshot;
  // Judged only on a NEW snapshot. Re-ingesting an older export, or a rebuild
  // replaying them in order, must not make the whole current roster look absent.
  const isNewest = !series.lastAsOf || asOf > series.lastAsOf;
  const quitUsernames = new Set(snapshot.quit.map((r) => r.username));
  const byUsername = new Map();
  for (const [key, c] of Object.entries(series.creators)) byUsername.set(c.username, key);

  for (const row of snapshot.active) {
    let key = creatorKey(row);
    // A creator who renamed keeps their ID, so the key is stable. A creator we
    // only ever saw by username who now has an ID gets merged into the ID key.
    if (row.creatorId && !series.creators[key] && byUsername.has(row.username)) {
      const oldKey = byUsername.get(row.username);
      if (oldKey.startsWith('@')) {
        series.creators[key] = { ...series.creators[oldKey], key, creatorId: row.creatorId };
        delete series.creators[oldKey];
      }
    }
    const c = (series.creators[key] ??= emptyCreator(row, key));

    if (c.username !== row.username) {
      if (!c.aliases.includes(c.username)) c.aliases.push(c.username);
      c.username = row.username;
    }
    Object.assign(c, {
      group: row.group, manager: row.manager,
      // Kept current so month-on-month has a denominator from day one.
      lastMonth: row.lastMonth,
      joinDate: row.joinDate ?? c.joinDate,
      lastSeen: asOf, quitOn: null, quitSource: null, missedSnapshots: 0,
      graduationStatus: row.graduationStatus,
      tierStatus: row.tierStatus,
      isNewLiveCreator: row.isNewLiveCreator,
    });

    const prev = c.obs.length ? c.obs[c.obs.length - 1] : null;
    if (prev && prev.date >= asOf) continue; // snapshot already applied or out of order

    const sameMonth = prev && prev.periodStart === periodStart;
    const baseDate = sameMonth ? prev.date : previousDay(periodStart);
    const span = Math.max(1, daysApart(baseDate, asOf));
    const delta = {};
    let restated = false;
    for (const f of CUMULATIVE_FIELDS) {
      const now = row.mtd[f] ?? 0;
      const before = sameMonth ? (prev.mtd?.[f] ?? 0) : 0;
      const d = now - before;
      if (d < 0) restated = true;
      delta[f] = Math.max(0, d);
    }

    c.obs.push({
      date: asOf,
      periodStart,
      span,
      // `partial` means the span predates our first sighting of this creator, so
      // the totals are real but cannot be attributed to individual days we saw.
      partial: !prev,
      restated,
      delta,
      mtd: row.mtd,
      // Kept for the ramp tracker: on a creator's first snapshot this is the
      // only window we get onto the month before we started watching them.
      lastMonthDiamonds: row.lastMonth.diamonds ?? null,
      // TikTok's own verdict on the rank-up task this month. Stored per
      // observation rather than only on the creator, so asking about a past
      // month gets that month's answer instead of today's.
      tierStatus: row.tierStatus ?? null,
    });
    c.levels[asOf] = {
      totalFans: row.level.totalFans,
      activeFanClubFans: row.level.activeFanClubFans,
      fanContribution: row.level.fanContribution,
      daysSinceJoining: row.daysSinceJoining,
    };
  }

  // Quit rows arrive with identity stripped, so match them back by username.
  for (const username of quitUsernames) {
    const key = byUsername.get(username) ?? `@${username}`;
    const c = series.creators[key];
    if (c && !c.quitOn) { c.quitOn = asOf; c.quitSource = 'export'; }
  }

  // Creators who have simply STOPPED APPEARING.
  //
  // TikTok lists a departure in the quit section only sometimes. The rest
  // vanish from the export with no row of any kind, and nothing here noticed:
  // `quitOn` stayed null, so every filter downstream still counted them, and
  // the rolling 28-day windows kept their history alive. A creator who left on
  // the 1st went on being named on their team's summary for weeks, with last
  // month's figures beside their name.
  //
  // Two consecutive misses is the bar. Across the thirteen daily snapshots we
  // hold, NO creator has ever gone missing and come back — once they are out of
  // the export they stay out — so one tolerated miss is for a glitchy export,
  // not for a real absence.
  //
  // `quitOn` is set rather than some new flag because twenty-six places already
  // ask that question, and a second way of being gone is a second thing for
  // them to drift apart on. `quitSource` keeps the distinction for anyone who
  // needs it, and reappearing clears both.
  if (isNewest) {
    for (const c of Object.values(series.creators)) {
      if (c.lastSeen === asOf) { c.missedSnapshots = 0; continue; }
      c.missedSnapshots = (c.missedSnapshots ?? 0) + 1;
      if (!c.quitOn && c.missedSnapshots >= goneAfter) {
        // Dated to the last day we actually saw them, not to today.
        c.quitOn = c.lastSeen ?? asOf;
        c.quitSource = 'absent';
      }
    }
  }

  series.lastAsOf = !series.lastAsOf || asOf > series.lastAsOf ? asOf : series.lastAsOf;
  series.updatedAt = new Date().toISOString();
  return series;
}

function daysApart(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function previousDay(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
