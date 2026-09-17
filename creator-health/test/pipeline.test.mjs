import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDurationHours, parseRatio, parsePeriod, normalizeExport } from '../lib/normalize.mjs';
import { Store, applySnapshot } from '../lib/store.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
import { curveTarget, evaluateRamp } from '../lib/ramp.mjs';
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

test('the ramp curve front-loads nothing and lands on the target', () => {
  const cfg = { targetDiamonds: 200000, curve: [
    { day: 0, pct: 0 }, { day: 30, pct: 0.15 }, { day: 60, pct: 0.45 }, { day: 90, pct: 1 }] };
  assert.equal(curveTarget(0, cfg), 0);
  assert.equal(curveTarget(30, cfg), 30000);
  assert.equal(curveTarget(60, cfg), 90000);
  assert.equal(curveTarget(90, cfg), 200000);
  assert.equal(curveTarget(45, cfg), 60000, 'interpolates between milestones');
  assert.ok(curveTarget(15, cfg) < curveTarget(75, cfg) / 2, 'later days carry more of the target');
});

test('the ramp tracker declares blind days instead of inventing them', () => {
  const series = { creators: {}, lastAsOf: null };
  // Joined in July; we only start seeing them in September.
  applySnapshot(series, snap('2026-09-10', '2026-09-01', { diamonds: 20000 },
    { joinDate: '2026-07-15', daysSinceJoining: 57 }));
  applySnapshot(series, snap('2026-09-11', '2026-09-01', { diamonds: 22000 },
    { joinDate: '2026-07-15', daysSinceJoining: 58 }));
  const c = series.creators['id:1'];
  const metricsByKey = new Map([[c.key, computeMetrics(c, '2026-09-11')]]);
  const [row] = evaluateRamp([c], metricsByKey, {
    ramp: { targetDiamonds: 200000, windowDays: 90, atRiskRatio: 0.6,
      curve: [{ day: 0, pct: 0 }, { day: 30, pct: 0.15 }, { day: 60, pct: 0.45 }, { day: 90, pct: 1 }],
      sustainableHoursPerDay: 4, maxHoursPerDay: 6, sustainableDaysPerWeek: 6, spotlightCount: 20 },
  });
  assert.equal(row.exact, false);
  assert.ok(row.blindDays > 0, 'the months before tracking are reported, not guessed');
  assert.equal(row.earned, 22000, 'only what was actually observed is counted');
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
