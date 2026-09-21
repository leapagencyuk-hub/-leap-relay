import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActivation, ACTIVATION_STAGE, ACTIVATION_PLAYBOOK } from '../lib/activation.mjs';
import { uploadStaleness, campaignGap, concentrationRisk, programmesDue } from '../lib/programmes.mjs';

const config = {
  activation: {
    enabled: true, newWindowDays: 90, minDiamonds: 100, dormantWasEarning: 5000,
    stages: { noStart: 7, decide: 30 }, maxOpenPerCoach: 3, dormantMaxPerCoach: 1,
  },
  programmes: {
    enabled: true, weekday: 1, listSize: 12,
    campaign: { minDiamonds28: 5000, minHours28: 8 },
    concentration: { minShare: 0.9, minDiamonds28: 20000 },
  },
  uploads: { warnAfterDays: 2, urgentAfterDays: 4 },
};

const metrics = ({ day = 10, mtd = 0, lastMonth = 0, liveDays = 0, hours = 0,
  diamonds28 = 0, perHour = null, share = 0, members = 0, lastMatch = null, matches28 = 0 } = {}) => ({
  daysSinceJoining: day,
  curr28: { diamonds: diamonds28, liveHours: hours, validLiveDays: liveDays },
  monthOnMonth: { diamonds: { monthToDate: mtd, lastMonthTotal: lastMonth }, validLiveDays: { lastMonthTotal: 0 } },
  monthlyDiamonds: { '2026-08': lastMonth },
  diamondsPerHour28: perHour,
  fanClub: { contribution: share, activeFans: members },
  darkStreak: 0, lastMatch, matches28,
  curr7: { diamonds: 0, liveHours: 0, validLiveDays: 0 },
  profile: { diamonds: {}, liveHours: {}, validLiveDays: {} },
});

const run = (list) => evaluateActivation(
  list.map((x) => x.creator),
  new Map(list.map((x) => [x.creator.key, x.m])),
  config,
);
const creator = (key, extra = {}) => ({ key, username: key, quitOn: null, group: 'Team Test', manager: 'c@leap', ...extra });

test('a creator in their first week is left alone', () => {
  const out = run([{ creator: creator('a'), m: metrics({ day: 3 }) }]);
  assert.equal(out.length, 0, 'chasing someone on day three is noise');
});

test('signed and never gone live is separated from live but not earning', () => {
  const out = run([
    { creator: creator('never'), m: metrics({ day: 10, liveDays: 0 }) },
    { creator: creator('stalled'), m: metrics({ day: 10, liveDays: 4 }) },
  ]);
  assert.equal(out.find((r) => r.creator.key === 'never').stage, ACTIVATION_STAGE.NO_START);
  assert.equal(out.find((r) => r.creator.key === 'stalled').stage, ACTIVATION_STAGE.STALLED);
});

test('past the decision point the stage changes, whatever they have done', () => {
  const out = run([
    { creator: creator('old-never'), m: metrics({ day: 45, liveDays: 0 }) },
    { creator: creator('old-stalled'), m: metrics({ day: 45, liveDays: 6 }) },
  ]);
  assert.ok(out.every((r) => r.stage === ACTIVATION_STAGE.DECIDE));
});

test('a creator who is earning is not on the list at all', () => {
  assert.equal(run([{ creator: creator('fine'), m: metrics({ day: 20, mtd: 50000 }) }]).length, 0);
});

test('an established creator who stops is a full stop, not a slow decline', () => {
  const [row] = run([{ creator: creator('gone'), m: metrics({ day: 400, mtd: 0, lastMonth: 200000 }) }]);
  assert.equal(row.stage, ACTIVATION_STAGE.DORMANT);
  assert.equal(row.lastMonth, 200000);
});

test('the newest creators surface first, because they are the winnable ones', () => {
  const out = run([
    { creator: creator('old'), m: metrics({ day: 80, liveDays: 0 }) },
    { creator: creator('new'), m: metrics({ day: 8, liveDays: 0 }) },
    { creator: creator('dormant'), m: metrics({ day: 400, mtd: 0, lastMonth: 90000 }) },
  ]);
  assert.deepEqual(out.map((r) => r.creator.key), ['new', 'old', 'dormant']);
});

test('every activation stage tells a coach what to ask', () => {
  for (const [stage, book] of Object.entries(ACTIVATION_PLAYBOOK)) {
    assert.ok(book.title && book.concern, `${stage} names the situation`);
    assert.ok(book.ask.length >= 2, `${stage} supplies questions`);
    assert.ok(book.success, `${stage} says what good looks like`);
  }
});

// --- network programmes ------------------------------------------------------

test('the campaign gap is only creators with a room to bring to it', () => {
  const list = [
    { creator: creator('big'), m: metrics({ diamonds28: 500000, hours28: 40, hours: 40, perHour: 12000 }) },
    { creator: creator('tiny'), m: metrics({ diamonds28: 100, hours: 20, perHour: 5 }) },
    { creator: creator('matched'), m: metrics({ diamonds28: 500000, hours: 40, perHour: 12000, matches28: 3, lastMatch: { days: 2 } }) },
  ];
  const out = campaignGap(list.map((x) => x.creator), new Map(list.map((x) => [x.creator.key, x.m])), config);
  assert.deepEqual(out.map((r) => r.creator.key), ['big'], 'too small, or already matching, is excluded');
});

test('concentration risk needs both a high share and real money behind it', () => {
  const list = [
    { creator: creator('exposed'), m: metrics({ diamonds28: 400000, share: 0.97, members: 50 }) },
    { creator: creator('spread'), m: metrics({ diamonds28: 400000, share: 0.4, members: 900 }) },
    { creator: creator('small'), m: metrics({ diamonds28: 900, share: 0.99, members: 3 }) },
  ];
  const out = concentrationRisk(list.map((x) => x.creator), new Map(list.map((x) => [x.creator.key, x.m])), config);
  assert.deepEqual(out.map((r) => r.creator.key), ['exposed']);
  assert.equal(out[0].perMember, Math.round((400000 * 0.97) / 50));
});

test('programmes post weekly, and only once', () => {
  const store = { data: {} };
  assert.equal(programmesDue(config, store, '2026-09-13'), false, 'a Sunday');
  assert.equal(programmesDue(config, store, '2026-09-14'), true, 'a Monday');
  store.data.lastProgrammesOn = '2026-09-14';
  assert.equal(programmesDue(config, store, '2026-09-14'), false, 'already posted');
});

// --- uploads stopping --------------------------------------------------------

test('a stale upload escalates rather than going unnoticed', () => {
  const on = (d) => new Date(`${d}T09:00:00Z`);
  assert.equal(uploadStaleness('2026-09-20', config, on('2026-09-21')).level, 'ok',
    'the export always covers the day before — one day behind is normal');
  assert.equal(uploadStaleness('2026-09-20', config, on('2026-09-22')).level, 'warn');
  assert.equal(uploadStaleness('2026-09-20', config, on('2026-09-25')).level, 'urgent');
  assert.match(uploadStaleness('2026-09-20', config, on('2026-09-25')).message, /200k month is being tracked blind/);
  assert.equal(uploadStaleness(null, config, on('2026-09-21')).level, 'none');
});
