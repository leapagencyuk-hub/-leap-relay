// Maps a raw TikTok "Creator data" export row onto a stable internal shape.
// The export is MONTH-TO-DATE cumulative, not daily: "Data period" reads
// "2026-09-01 ~ 2026-09-15", so every counter resets on the 1st. Everything
// downstream depends on that, so the period is parsed here and carried along.

export const COLUMNS = {
  period: 'Data period',
  creatorId: 'Creator ID',
  username: "Creator's username",
  group: 'Group',
  manager: 'Creator Network manager',
  joinTime: 'Join time',
  daysSinceJoining: 'Days since joining',
  diamonds: 'Diamonds',
  liveDuration: 'LIVE duration',
  validLiveDays: 'Valid go LIVE days',
  newFollowers: 'New followers',
  liveStreams: 'LIVE streams',
  diamondsLastMonth: 'Diamonds last month',
  liveDurationLastMonth: 'LIVE duration (hours) last month',
  validLiveDaysLastMonth: 'Valid go LIVE days last month',
  matches: 'Matches',
  diamondsFromMatches: 'Diamonds from matches',
  diamondsFromMultiGuest: 'Diamonds from multi-guest',
  graduationStatus: 'Graduation status',
  tierStatus: 'Tier status',
  newFans: 'New fans',
  fanClubDiamonds: 'Fan Club total Diamonds',
  fanContribution: 'Fan contribution %',
  totalFans: 'Total fans',
  activeFanClubFans: 'Active fans from Fan Club',
  status: 'Status',
  newLiveCreator: 'New LIVE creators',
};

// Rows for creators who left have their ID masked to a sentence and their join
// time blanked, so the numeric ID cannot be the only identity key.
const QUIT_ID_SENTINEL = /has quit the network/i;

export function parseNumber(value) {
  if (value == null || value === '' || value === '-') return null;
  const n = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/** "126h 27m 31s" -> 126.4586 (hours). Also accepts a bare number of hours. */
export function parseDurationHours(value) {
  if (value == null || value === '' || value === '-') return null;
  const s = String(value).trim();
  if (/^[\d.]+$/.test(s)) return Number(s);
  const h = /(\d+)\s*h/.exec(s);
  const m = /(\d+)\s*m/.exec(s);
  const sec = /(\d+)\s*s/.exec(s);
  if (!h && !m && !sec) return null;
  return (h ? +h[1] : 0) + (m ? +m[1] : 0) / 60 + (sec ? +sec[1] : 0) / 3600;
}

/** "94.618%" and "0.94618" both mean 94.6% in this export; normalise to 0..1. */
export function parseRatio(value) {
  const n = parseNumber(value);
  if (n == null) return null;
  return String(value).includes('%') ? n / 100 : n;
}

/** "2026-04-11 09:21:18 (UTC+0)" -> "2026-04-11" */
export function parseDateOnly(value) {
  if (!value || value === '-') return null;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

/** "2026-09-01 ~ 2026-09-15" -> { start, end } (end is the snapshot's as-of date). */
export function parsePeriod(value) {
  const dates = String(value ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (dates.length < 2) return null;
  return { start: dates[0], end: dates[dates.length - 1] };
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Normalise one export row. Returns null for rows with no usable identity. */
export function normalizeRow(raw) {
  const get = (key) => {
    const v = raw[COLUMNS[key]];
    return typeof v === 'string' ? v.trim() : v;
  };
  const username = String(get('username') ?? '').trim();
  const rawId = String(get('creatorId') ?? '').trim();
  if (!username && !rawId) return null;

  const quitById = QUIT_ID_SENTINEL.test(rawId);
  const quit = quitById || String(get('status') ?? '').toLowerCase() === 'quit';
  const creatorId = quitById || !rawId ? null : rawId;
  const period = parsePeriod(get('period'));

  return {
    // identity
    creatorId,
    username,
    // as-of
    periodStart: period?.start ?? null,
    asOf: period?.end ?? null,
    // attribution
    group: get('group') || null,
    manager: String(get('manager') ?? '').toLowerCase() || null,
    joinDate: parseDateOnly(get('joinTime')),
    daysSinceJoining: parseNumber(get('daysSinceJoining')),
    // month-to-date cumulative counters
    mtd: {
      diamonds: parseNumber(get('diamonds')) ?? 0,
      liveHours: parseDurationHours(get('liveDuration')) ?? 0,
      validLiveDays: parseNumber(get('validLiveDays')) ?? 0,
      liveStreams: parseNumber(get('liveStreams')) ?? 0,
      newFollowers: parseNumber(get('newFollowers')) ?? 0,
      newFans: parseNumber(get('newFans')) ?? 0,
      fanClubDiamonds: parseNumber(get('fanClubDiamonds')) ?? 0,
      // Campaign participation. "Matches" is the clearest evidence in the whole
      // export that a creator has or has not been pushing, and it is the one
      // cause on the coaches' list the data can confirm outright.
      matches: parseNumber(get('matches')) ?? 0,
      diamondsFromMatches: parseNumber(get('diamondsFromMatches')) ?? 0,
      diamondsFromMultiGuest: parseNumber(get('diamondsFromMultiGuest')) ?? 0,
    },
    // point-in-time levels (not cumulative within the month)
    level: {
      totalFans: parseNumber(get('totalFans')),
      activeFanClubFans: parseNumber(get('activeFanClubFans')),
      fanContribution: parseRatio(get('fanContribution')),
    },
    // last full month, for month-start comparisons before deltas exist
    lastMonth: {
      diamonds: parseNumber(get('diamondsLastMonth')),
      liveHours: parseDurationHours(get('liveDurationLastMonth')),
      validLiveDays: parseNumber(get('validLiveDaysLastMonth')),
    },
    // flags
    quit,
    graduationStatus: get('graduationStatus') || null,
    tierStatus: get('tierStatus') || null,
    isNewLiveCreator: String(get('newLiveCreator') ?? '').toLowerCase() === 'yes',
  };
}

/**
 * Normalise a whole export.
 *
 * Quit rows share one masked ID, so they are keyed by username and reconciled
 * against previously seen creators by the caller. Active duplicates keep the
 * row with the highest diamond count, which is what the export does on the rare
 * occasion a creator is listed twice mid-transfer between groups.
 */
export function normalizeExport(records) {
  const active = new Map();
  const quit = [];
  let asOf = null;
  let periodStart = null;
  let skipped = 0;

  for (const raw of records) {
    const row = normalizeRow(raw);
    if (!row) { skipped++; continue; }
    if (row.asOf && (!asOf || row.asOf > asOf)) asOf = row.asOf;
    if (row.periodStart && (!periodStart || row.periodStart < periodStart)) periodStart = row.periodStart;
    if (row.quit) { quit.push(row); continue; }
    const key = row.creatorId ?? `@${row.username}`;
    const prev = active.get(key);
    if (!prev || row.mtd.diamonds > prev.mtd.diamonds) active.set(key, row);
  }

  return { asOf, periodStart, active: [...active.values()], quit, skipped };
}
