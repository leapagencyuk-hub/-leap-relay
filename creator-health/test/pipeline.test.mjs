import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDurationHours, parseRatio, parsePeriod, normalizeExport } from '../lib/normalize.mjs';
import { Store, applySnapshot } from '../lib/store.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
import { attemptMonths, evaluateRamp } from '../lib/ramp.mjs';
import { readSheetObjects } from '../lib/xlsx.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-'));

test('parses the export\'s duration and ratio formats', () => {
  assert.equal(parseDurationHours('126h 27m 31s').toFixed(4), '126.4586');
  assert.equal(parseDurationHours('1h 30m 0s'), 1.5);
  assert.equal(parseDurationHours('-'), null);
  assert.equal(parseRatio('0.94618'), 0.94618);
  assert.equal(parseRatio('94.618%').toFixed(5), '0.94618');
  assert.deepEqual(parsePeriod('2026-09-01 ~ 2026-09-15'), { start: '2026-09-01', end: '2026-09-15' });
});

// Build a snapshot the way normalizeExport would, without an xlsx round-trip.
function snap(asOf, periodStart, mtd, extra = {}) {
  return {
    asOf, periodStart, quit: [], skipped: 0,
    active: [{
      creatorId: '1', username: 'x', periodStart, asOf,
      group: 'A', manager: 'coach@leap', joinDate: '2026-08-20',
      daysSinceJoining: null,
      mtd: { diamonds: 0, liveHours: 0, validLiveDays: 0, liveStreams: 0, newFollowers: 0, newFans: 0, fanClubDiamonds: 0, ...mtd },
      level: { totalFans: 100, activeFanClubFans: 10, fanContribution: 0.9 },
      lastMonth: { diamonds: null, liveHours: null, validLiveDays: null },
      quit: false, graduationStatus: null, tierStatus: null, isNewLiveCreator: false,
      ...extra,
    }],
  };
}

test('month-to-date counters become daily deltas', () => {
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-14', '2026-09-01', { diamonds: 1000, liveHours: 10, validLiveDays: 5 }));
  applySnapshot(series, snap('2026-09-15', '2026-09-01', { diamonds: 1250, liveHours: 12, validLiveDays: 6 }));
  const obs = series.creators['id:1'].obs;
  assert.equal(obs.length, 2);
  assert.equal(obs[0].partial, true, 'first sighting covers the month so far');
  assert.equal(obs[0].span, 14, 'first span runs from the period start');
  assert.equal(obs[1].partial, false);
  assert.equal(obs[1].span, 1);
  assert.equal(obs[1].delta.diamonds, 250, 'delta is the day, not the running total');
  assert.equal(obs[1].delta.validLiveDays, 1);
});

test('the month rollover does not read as a collapse', () => {
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-29', '2026-09-01', { diamonds: 900000 }));
  applySnapshot(series, snap('2026-09-30', '2026-09-01', { diamonds: 950000 }));
  // October 1st: the export resets to a small month-to-date number.
  applySnapshot(series, snap('2026-10-01', '2026-10-01', { diamonds: 4000 }));
  const obs = series.creators['id:1'].obs;
  const last = obs[obs.length - 1];
  assert.equal(last.delta.diamonds, 4000, 'the new month starts from zero, not from -946,000');
  assert.equal(last.restated, false);
  assert.equal(last.span, 1);
  assert.ok(obs.every((o) => o.delta.diamonds >= 0), 'no negative days anywhere');
});

test('a missed upload is spread across the days it covers', () => {
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-10', '2026-09-01', { diamonds: 1000 }));
  applySnapshot(series, snap('2026-09-13', '2026-09-01', { diamonds: 1600, liveHours: 6 }));
  const c = series.creators['id:1'];
  const last = c.obs.at(-1);
  assert.equal(last.span, 3, 'covers the 11th, 12th and 13th');
  assert.equal(last.delta.diamonds, 600, 'the whole gap is accounted for, none of it lost');

  // 600 shared across three days, plus four days of the opening observation
  // (1000 over the 1st-10th = 100/day) that fall inside the same 7-day window.
  const m = computeMetrics(c, '2026-09-13');
  assert.equal(Math.round(m.curr7.diamonds), 1000);
  assert.equal(Math.round(m.curr7.diamonds - m.prev7.diamonds * 0), 1000);
  const m3 = computeMetrics(c, '2026-09-13');
  assert.equal(Math.round(m3.curr28.diamonds), 1600, 'nothing is double counted over the full month');
});

test('a restated total is clamped and flagged rather than going negative', () => {
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-10', '2026-09-01', { diamonds: 5000 }));
  applySnapshot(series, snap('2026-09-11', '2026-09-01', { diamonds: 4800 }));
  const last = series.creators['id:1'].obs.at(-1);
  assert.equal(last.delta.diamonds, 0);
  assert.equal(last.restated, true);
});

test('re-applying the same day changes nothing', () => {
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-14', '2026-09-01', { diamonds: 1000 }));
  applySnapshot(series, snap('2026-09-15', '2026-09-01', { diamonds: 1250 }));
  const before = JSON.stringify(series.creators['id:1'].obs);
  applySnapshot(series, snap('2026-09-15', '2026-09-01', { diamonds: 1250 }));
  assert.equal(JSON.stringify(series.creators['id:1'].obs), before);
});

test('a dark streak counts consecutive days with no valid LIVE day', () => {
  const series = { creators: {}, lastAsOf: null };
  let d = 1000, h = 10, days = 5;
  applySnapshot(series, snap('2026-09-10', '2026-09-01', { diamonds: d, liveHours: h, validLiveDays: days }));
  for (const date of ['2026-09-11', '2026-09-12', '2026-09-13']) {
    applySnapshot(series, snap(date, '2026-09-01', { diamonds: d, liveHours: h, validLiveDays: days }));
  }
  const m = computeMetrics(series.creators['id:1'], '2026-09-13');
  assert.equal(m.darkStreak, 3);
});

test('the attempt months are the calendar months their first 90 days touch', () => {
  // Joining mid-month still gives that month as an attempt, but a creator who
  // joins on the 28th has three days of it — counted, not called viable.
  const mid = attemptMonths('2026-09-10', 90);
  assert.deepEqual(mid.map((m) => m.key), ['2026-09', '2026-10', '2026-11', '2026-12']);
  assert.equal(mid[0].available, 21, 'the 10th to the 30th');
  assert.equal(mid[0].viable, true);

  const late = attemptMonths('2026-09-28', 90);
  assert.equal(late[0].available, 3);
  assert.equal(late[0].viable, false, 'three days is not a real attempt');

  assert.deepEqual(attemptMonths('2026-12-01', 90).map((m) => m.key),
    ['2026-12', '2027-01', '2027-02', '2027-03'], 'the window rolls over the year end');
});

test('the monthly target resets, so a bad month is not carried forward', () => {
  const config = {
    ramp: {
      targetDiamonds: 200000, windowDays: 90, atRiskRatio: 0.6,
      sustainableHoursPerDay: 4, maxHoursPerDay: 6, sustainableDaysPerWeek: 6,
      spotlightCount: 20, minRecentLiveDays: 2, minDaysLeftToPush: 7, reachableRatio: 0.6,
    },
  };
  const creator = { key: 'id:1', username: 'x', joinDate: '2026-08-01', quitOn: null, group: 'T', manager: 'c@leap' };
  // August was a write-off; September is halfway through and on pace.
  const metrics = {
    endDate: '2026-09-15', daysSinceJoining: 45,
    curr7: { diamonds: 50000, liveHours: 20, validLiveDays: 5 },
    curr28: { diamonds: 200000, liveHours: 80 },
    dailyDiamonds7: 7000, diamondsPerHour28: 2500, diamondsPerHour7: 2500,
    hoursPerActiveDay28: 4, historyDays: 28,
    monthlyDiamonds: { '2026-08': 20000, '2026-09': 105000 },
    monthlyCoverage: { '2026-08': 31, '2026-09': 15 },
    monthOnMonth: { diamonds: { monthToDate: 105000 } },
  };
  const [row] = evaluateRamp([creator], new Map([['id:1', metrics]]), config);

  assert.equal(row.month, '2026-09');
  assert.equal(row.monthToDate, 105000, 'August does not count against September');
  assert.equal(row.paceTarget, 100000, 'halfway through a 30-day month');
  assert.equal(row.projected, 210000);
  assert.equal(row.status, 'ON_TRACK');
  assert.equal(row.bestMonth.key, '2026-08');
  assert.equal(row.attemptsLeft, 1, 'October is still inside the 90 days');
});

test('landing 200k in any month counts, even if later months are worse', () => {
  const config = {
    ramp: {
      targetDiamonds: 200000, windowDays: 90, atRiskRatio: 0.6,
      sustainableHoursPerDay: 4, maxHoursPerDay: 6, sustainableDaysPerWeek: 6,
      spotlightCount: 20, minRecentLiveDays: 2, minDaysLeftToPush: 7, reachableRatio: 0.6,
    },
  };
  const creator = { key: 'id:1', username: 'x', joinDate: '2026-08-01', quitOn: null };
  const metrics = {
    endDate: '2026-09-15', daysSinceJoining: 45,
    curr7: { diamonds: 1000, liveHours: 5, validLiveDays: 2 },
    curr28: { diamonds: 5000, liveHours: 20 },
    dailyDiamonds7: 143, diamondsPerHour28: 250, diamondsPerHour7: 200,
    hoursPerActiveDay28: 2, historyDays: 28,
    monthlyDiamonds: { '2026-08': 240000, '2026-09': 2000 },
    monthlyCoverage: { '2026-08': 31, '2026-09': 15 },
    monthOnMonth: { diamonds: { monthToDate: 2000 } },
  };
  const [row] = evaluateRamp([creator], new Map([['id:1', metrics]]), config);
  assert.equal(row.status, 'ACHIEVED');
  assert.equal(row.achievedIn, '2026-08');
});

test('a month we barely watched is not recorded as a failed attempt', () => {
  const config = {
    ramp: {
      targetDiamonds: 200000, windowDays: 90, atRiskRatio: 0.6,
      sustainableHoursPerDay: 4, maxHoursPerDay: 6, sustainableDaysPerWeek: 6,
      spotlightCount: 20, minRecentLiveDays: 2, minDaysLeftToPush: 7, reachableRatio: 0.6,
    },
  };
  const creator = { key: 'id:1', username: 'x', joinDate: '2026-08-01', quitOn: null };
  const metrics = {
    endDate: '2026-09-15', daysSinceJoining: 45,
    curr7: { diamonds: 10000, liveHours: 10, validLiveDays: 4 },
    curr28: { diamonds: 40000, liveHours: 40 },
    dailyDiamonds7: 1429, diamondsPerHour28: 1000, diamondsPerHour7: 1000,
    hoursPerActiveDay28: 2.5, historyDays: 28,
    monthlyDiamonds: { '2026-08': 3000, '2026-09': 20000 },
    monthlyCoverage: { '2026-08': 2, '2026-09': 15 },
    monthOnMonth: { diamonds: { monthToDate: 20000 } },
  };
  const [row] = evaluateRamp([creator], new Map([['id:1', metrics]]), config);
  assert.equal(row.pastAttempts.find((a) => a.key === '2026-08').observed, false,
    'two days of coverage cannot judge a month');
});

test('the month rollover falls back to the export when our own history is partial', () => {
  // LEAP started collecting mid-September, so on 1 October the previous month
  // is only two thirds observed. Using it as a baseline would understate every
  // creator's September and make October look like a recovery.
  const mk = (asOf, periodStart, diamonds, lastMonthDiamonds) => ({
    asOf, periodStart, quit: [], skipped: 0,
    active: [{
      creatorId: '1', username: 'x', periodStart, asOf, group: 'A', manager: 'c@leap',
      joinDate: '2025-01-01', daysSinceJoining: 600,
      mtd: { diamonds, liveHours: 50, validLiveDays: 10, liveStreams: 10, newFollowers: 0,
        newFans: 0, fanClubDiamonds: 0, matches: 0, diamondsFromMatches: 0, diamondsFromMultiGuest: 0 },
      level: { totalFans: 100, activeFanClubFans: 10, fanContribution: 0.9 },
      lastMonth: { diamonds: lastMonthDiamonds, liveHours: 100, validLiveDays: 20 },
      quit: false, graduationStatus: null, tierStatus: null, isNewLiveCreator: false,
    }],
  });
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, mk('2026-08-31', '2026-08-01', 800000, 700000));
  applySnapshot(series, mk('2026-09-14', '2026-09-01', 300000, 800000));
  applySnapshot(series, mk('2026-09-20', '2026-09-01', 450000, 800000));
  applySnapshot(series, mk('2026-10-08', '2026-10-01', 90000, 620000));

  const m = computeMetrics(series.creators['id:1'], '2026-10-08');
  const d = m.monthOnMonth.diamonds;
  assert.equal(m.monthOnMonth.previousMonth, '2026-09');
  assert.equal(d.source, 'export', 'a 20-of-30-day September is not a baseline');
  assert.equal(d.lastMonthTotal, 620000, "TikTok's own September total is used instead");
  assert.equal(Math.round(d.lastMonthToSamePoint), 165333, 'prorated to the 8th');
  assert.ok(d.change < -0.4, 'and the comparison is still honest');

  // A fully observed month is preferred over the export column.
  const august = computeMetrics(series.creators['id:1'], '2026-09-20').monthOnMonth.diamonds;
  assert.equal(august.source, 'observed', 'August was watched end to end');
});

test('quit rows are matched by username because their ID is masked', () => {
  const records = [
    { 'Data period': '2026-09-01 ~ 2026-09-15', 'Creator ID': '1', "Creator's username": 'alive', Diamonds: '100', Status: '' },
    { 'Data period': '2026-09-01 ~ 2026-09-15', 'Creator ID': 'The creator has quit the network', "Creator's username": 'gone', Diamonds: '50', Status: 'Quit' },
    { 'Data period': '2026-09-01 ~ 2026-09-15', 'Creator ID': 'The creator has quit the network', "Creator's username": 'alsogone', Diamonds: '20', Status: 'Quit' },
  ];
  const s = normalizeExport(records);
  assert.equal(s.active.length, 1);
  assert.equal(s.quit.length, 2, 'the shared masked ID must not collapse them into one');
  assert.equal(s.active[0].creatorId, '1');
  assert.equal(s.quit[0].creatorId, null);
});

test('reads a real export end to end', { skip: !process.env.SAMPLE_XLSX }, () => {
  const { headers, records } = readSheetObjects(process.env.SAMPLE_XLSX);
  assert.ok(headers.includes('Creator ID'));
  const s = normalizeExport(records);
  assert.ok(s.asOf && s.periodStart);
  assert.ok(s.active.length > 0);
  const dir = tmp();
  const store = new Store(dir);
  store.writeSnapshot(s);
  assert.deepEqual(store.listSnapshotDates(), [s.asOf]);
  assert.equal(store.readSnapshot(s.asOf).active.length, s.active.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('asking about a day gets that day, not today', async () => {
  // The bug this pins: every board derives its month from `asOf` and used to
  // pass the MONTH to monthMtd, which returns the last reading in that month
  // whenever it was taken. So a board asked for the 20th answered with the
  // 29th's figures and looked entirely plausible doing it. The daily run was
  // never wrong — its asOf is always the newest data — but --as-of and every
  // ?as-of= endpoint was, silently.
  const { monthMtd } = await import('../lib/policy.mjs');
  const creator = {
    username: 'climber',
    obs: [
      { date: '2026-08-31', mtd: { diamonds: 50, liveHours: 5 } },
      { date: '2026-09-20', mtd: { diamonds: 100, liveHours: 10 } },
      { date: '2026-09-25', mtd: { diamonds: 200, liveHours: 20 } },
      { date: '2026-09-29', mtd: { diamonds: 300, liveHours: 30 } },
    ],
  };
  assert.equal(monthMtd(creator, '2026-09-20').diamonds, 100);
  assert.equal(monthMtd(creator, '2026-09-24').diamonds, 100, 'the 24th has no reading; the 20th stands');
  assert.equal(monthMtd(creator, '2026-09-25').diamonds, 200);
  assert.equal(monthMtd(creator, '2026-09-29').diamonds, 300);
  // A bare month still means the month's last reading, which closed months need.
  assert.equal(monthMtd(creator, '2026-09').diamonds, 300);
  assert.equal(monthMtd(creator, '2026-08').diamonds, 50);
  // Before the month's first reading there is nothing to report, not August's.
  assert.equal(monthMtd(creator, '2026-09-10'), null);
  assert.equal(monthMtd(creator, null), null);
});

test('every board moves day to day, which is the whole point of a daily card', async () => {
  const [{ hardestWorkerBoard }, { leagueMoveFor }, { rankUpFor }, { coachRevenue }] = await Promise.all([
    import('../lib/hardestworker.mjs'), import('../lib/leagues.mjs'),
    import('../lib/tiers.mjs'), import('../lib/revenue.mjs'),
  ]);
  const mk = (n) => ({
    key: n, username: n, quitOn: null, group: 'Team Alpha', manager: 'josh@leap', joinDate: '2026-01-01',
    obs: [
      { date: '2026-09-20', mtd: { diamonds: 100000, liveHours: 10, validLiveDays: 5, liveStreams: 5 }, lastMonthDiamonds: 40000, tierStatus: 'Maintained' },
      { date: '2026-09-29', mtd: { diamonds: 900000, liveHours: 90, validLiveDays: 20, liveStreams: 20 }, lastMonthDiamonds: 40000, tierStatus: 'Ranked up' },
    ],
  });
  const cfg = {
    monitoring: { ignoreGroups: [] }, coaches: { names: {} }, hardestWorker: {}, leagues: {},
    rankUp: { advanced: true, coachSharePerDiamondUsd: 0.0001 },
    revenue: { enabled: true, baseWage: 0, rankUpPerDiamondUsd: 0.0001, incrementalPerDiamondGbp: 0.0000375, usdToGbp: 0.754074, goalsMultiplier: 2 },
    leaped: { fee: 10 },
  };
  const creators = [mk('a')];

  const early = hardestWorkerBoard({ creators, asOf: '2026-09-20', config: cfg });
  const late = hardestWorkerBoard({ creators, asOf: '2026-09-29', config: cfg });
  assert.equal(early.rows[0].hours, 10);
  assert.equal(late.rows[0].hours, 90);

  assert.equal(leagueMoveFor(creators[0], '2026-09-20', cfg).diamonds, 100000);
  assert.equal(leagueMoveFor(creators[0], '2026-09-29', cfg).diamonds, 900000);

  assert.equal(rankUpFor(creators[0], '2026-09-20', cfg).diamonds, 100000);
  assert.equal(rankUpFor(creators[0], '2026-09-29', cfg).diamonds, 900000);

  // And the money, which is the one that matters.
  const r20 = coachRevenue({ creators, asOf: '2026-09-20', config: cfg, leaped: null }).rows[0];
  const r29 = coachRevenue({ creators, asOf: '2026-09-29', config: cfg, leaped: null }).rows[0];
  assert.equal(r20.diamonds, 100000);
  assert.equal(r29.diamonds, 900000);
  assert.ok(r29.incrementalShare > r20.incrementalShare * 8, 'the share follows the diamonds');
});
