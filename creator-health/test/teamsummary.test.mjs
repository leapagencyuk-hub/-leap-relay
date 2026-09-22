import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamSummaries, teamSummaryDue } from '../lib/teamsummary.mjs';
import { teamSummaryEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';

const ASOF = '2026-09-20';   // day 20 of 30, so ten days left

const config = {
  ramp: { targetDiamonds: 200000 },
  growth: { enabled: true, liveDaysTarget: 15, fanClubUp: 0.10, chaseStretch: 2, minBaseForPercent: 5000, minFanClub: 10, topPerSection: 5 },
  monitoring: { ignoreGroups: [] },
};

/** One creator, with only the metrics the summary reads. */
function make({ username, group = 'Team Alpha', monthToDate = 0, lastToSamePoint = null,
  liveDays = 20, perDay = 1000, fans = 50, fanChange = 0 }) {
  const creator = { key: username, username, group, manager: 'josh@leap', quitOn: null };
  const metrics = {
    activeDays28: liveDays,
    dailyDiamonds7: perDay,
    diamondsPerHour28: 400,
    curr28: { diamonds: monthToDate },
    fanClub: { activeFans: fans, activeFansChange14: fanChange },
    monthOnMonth: {
      previousMonth: '2026-08',
      diamonds: {
        monthToDate,
        lastMonthToSamePoint: lastToSamePoint,
        change: lastToSamePoint > 0 ? (monthToDate - lastToSamePoint) / lastToSamePoint : null,
      },
    },
  };
  return { creator, metrics };
}

function run(made, cfg = config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sum-'));
  const store = new CaseStore(dir);
  const out = teamSummaries({
    creators: made.map((x) => x.creator),
    metricsByKey: new Map(made.map((x) => [x.creator.key, x.metrics])),
    store, asOf: ASOF, config: cfg,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('a creator who would have to work twice as hard is not "in reach" of 200k', () => {
  const made = [
    // 130k banked, needs 7,000/day, doing 5,500 — a push, so it counts.
    make({ username: 'closeenough', monthToDate: 130000, perDay: 5500 }),
    // 57k banked, needs 14,300/day, doing 1,900 — seven times their rate.
    make({ username: 'nochance', monthToDate: 57000, perDay: 1900 }),
  ];
  const s = run(made).get('Team Alpha');
  assert.deepEqual(s.chase.short.map((r) => r.username), ['closeenough'],
    'listing a creator who cannot get there is how a list stops being read');
});

test('a creator already clearing it is listed as clearing, not as short', () => {
  const s = run([make({ username: 'flying', monthToDate: 150000, perDay: 9000 })]).get('Team Alpha');
  assert.deepEqual(s.chase.clearing.map((r) => r.username), ['flying']);
  assert.equal(s.chase.short.length, 0);
  assert.equal(s.chase.daysLeft, 10);
});

test('a percentage is only quoted on a base that can carry one', () => {
  const tiny = make({ username: 'tiny', monthToDate: 4900, lastToSamePoint: 40 });
  const real = make({ username: 'real', monthToDate: 60000, lastToSamePoint: 40000 });
  const s = run([tiny, real]).get('Team Alpha');
  const text = JSON.stringify(teamSummaryEmbed(s));
  assert.ok(!/12150%|\+1[0-9]{4}%/.test(text), 'a percentage off 40 diamonds is arithmetic, not news');
  assert.match(text, /was 40/, 'the move is still shown, in diamonds');
  assert.match(text, /\+50%/, 'a real base still gets a percentage');
});

test('a fan club going from one member to two is not a creator to push', () => {
  const noise = make({ username: 'noise', monthToDate: 400, fans: 2, fanChange: 1.0 });
  const real = make({ username: 'real', monthToDate: 60000, fans: 40, fanChange: 0.3 });
  const s = run([noise, real]).get('Team Alpha');
  assert.deepEqual(s.readyToPush.map((r) => r.username), ['real']);
});

test('the month comparison counts only creators who were here for both months', () => {
  const made = [
    make({ username: 'both', monthToDate: 60000, lastToSamePoint: 50000 }),
    make({ username: 'brandnew', monthToDate: 20000, lastToSamePoint: null }),
  ];
  const s = run(made).get('Team Alpha');
  assert.equal(s.month.toDate, 80000, 'the headline total is everyone');
  assert.equal(s.month.comparable, 1, 'but the comparison is only the ones we can compare');
  assert.equal(s.month.comparableToDate, 60000, 'and both sides of it are the same creators');
  assert.equal(s.month.lastToSamePoint, 50000);
  assert.equal(Math.round(s.month.change * 100), 20);
});

test('teams nobody coaches get no summary', () => {
  const made = [
    make({ username: 'a', group: 'Team Alpha', monthToDate: 5000 }),
    make({ username: 'b', group: 'Surge Agency', monthToDate: 5000 }),
  ];
  const out = run(made, { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } });
  assert.deepEqual([...out.keys()], ['Team Alpha']);
});

test('every list says what it left out', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    make({ username: `c${i}`, monthToDate: 300000 - i * 1000 }));
  const s = run(many).get('Team Alpha');
  const past = teamSummaryEmbed(s).embeds[0].fields.find((f) => f.name.startsWith('Already past 200k'));
  assert.match(past.name, /9$/);
  assert.match(past.value, /… and 4 more/, 'a heading of nine over a list of five reads as a bug');
});

test('the summary posts once a day, however often the run is repeated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sum-due-'));
  const store = new CaseStore(dir);
  assert.equal(teamSummaryDue(config, store, ASOF), true);
  store.data.lastTeamSummaryOn = ASOF;
  assert.equal(teamSummaryDue(config, store, ASOF), false);
  assert.equal(teamSummaryDue(config, store, '2026-09-21'), true, 'a new day posts again');
  assert.equal(teamSummaryDue({ ...config, growth: { enabled: false } }, store, '2026-09-21'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the habit section names creators close to the line, biggest first', () => {
  const made = [
    make({ username: 'meets', liveDays: 20, monthToDate: 90000 }),
    make({ username: 'nearly_big', liveDays: 13, monthToDate: 80000 }),
    make({ username: 'nearly_small', liveDays: 13, monthToDate: 900 }),
    make({ username: 'nowhere_near', liveDays: 2, monthToDate: 50000 }),
  ];
  const s = run(made).get('Team Alpha');
  assert.equal(s.frequency.meeting, 1);
  assert.deepEqual(s.frequency.closest.map((r) => r.username), ['nearly_big', 'nearly_small'],
    'two LIVE days off the line is the cheapest growth on the team; two days in total is a different problem');
});
