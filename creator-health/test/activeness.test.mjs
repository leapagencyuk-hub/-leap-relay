import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateFor, activenessRows, activenessPings, recordPings, activenessSummary } from '../lib/activeness.mjs';
import { activenessPingEmbed, activenessOverviewEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';
import { groupKey } from '../lib/notify.mjs';

const config = {
  activeness: {
    enabled: true, hours: 15, days: 7, pingWithinDays: 7,
    minDiamonds: 5000, maxPingsPerRun: 12, plausibleHoursPerDay: 3,
  },
  policy: { rankUpBaseRatio: 0.04 },
  monitoring: { ignoreGroups: [] },
};

const who = (username, { hours, days, diamonds = 20000, joinDate = '2026-01-01', group = 'Team Alpha', quitOn = null } = {}) => ({
  key: username, username, joinDate, quitOn, group, manager: 'josh@leap',
  obs: [{ date: '2026-09-20', mtd: { diamonds, liveHours: hours, validLiveDays: days } }],
});
const store = () => new CaseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-act-')));

test('"over 7 days" is eight, not seven', () => {
  const at7 = gateFor(who('seven', { hours: 20, days: 7 }), '2026-09-20', config);
  const at8 = gateFor(who('eight', { hours: 20, days: 8 }), '2026-09-20', config);
  assert.equal(at7.needDays, 8);
  assert.equal(at7.cleared, false, 'seven days is not "over 7 days"');
  assert.equal(at7.daysShort, 1);
  assert.equal(at8.cleared, true);
});

test('both halves have to be met', () => {
  assert.equal(gateFor(who('hours_only', { hours: 20, days: 4 }), '2026-09-20', config).cleared, false);
  assert.equal(gateFor(who('days_only', { hours: 9, days: 12 }), '2026-09-20', config).cleared, false);
  assert.equal(gateFor(who('both', { hours: 15, days: 8 }), '2026-09-20', config).cleared, true,
    'exactly on the line clears it');
});

test('the requirement scales for a creator who joined mid-month', () => {
  // The deck's example: joined 16 April, 15 of 30 days, so 50%.
  const g = gateFor(who('midmonth', { hours: 8, days: 4, joinDate: '2026-09-16' }), '2026-09-20', config);
  assert.equal(g.prorated, true);
  assert.equal(Math.round(g.scale * 100), 50);
  assert.equal(g.needHours, 7.5);
  assert.equal(g.needDays, 4);
  assert.equal(g.cleared, true, 'half a month in the network, half the requirement');
});

test('a gap that cannot fit in the days left is not called reachable', () => {
  // Five days short with three days left is arithmetic, not effort.
  const stuck = gateFor(who('stuck', { hours: 2, days: 3 }), '2026-09-27', config);
  assert.equal(stuck.daysLeft, 3);
  assert.equal(stuck.reachable, false);
  // One day and two hours short with three left is a phone call.
  const close = gateFor(who('close', { hours: 13, days: 7 }), '2026-09-27', config);
  assert.equal(close.reachable, true);
});

test('creators who never went LIVE are the activation channel\'s job, not this one', () => {
  const rows = activenessRows({
    creators: [who('never', { hours: 0, days: 0, diamonds: 0 }), who('live', { hours: 10, days: 5 })],
    asOf: '2026-09-20', config, groupKey,
  });
  assert.deepEqual(rows.map((r) => r.username), ['live']);
});

test('teams nobody coaches, and creators who left, are left out', () => {
  const rows = activenessRows({
    creators: [
      who('mine', { hours: 10, days: 5 }),
      who('ignored', { hours: 10, days: 5, group: 'Surge Agency' }),
      who('gone', { hours: 10, days: 5, quitOn: '2026-09-10' }),
    ],
    asOf: '2026-09-20',
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
    groupKey,
  });
  assert.deepEqual(rows.map((r) => r.username), ['mine']);
});

test('pings hold off until the closing week, then rank by what is at stake', () => {
  const rows = (daysLeft) => [
    { creator: { key: 'a' }, username: 'small', group: 'Team Alpha', coach: 'josh@leap',
      cleared: false, reachable: true, daysLeft, daysShort: 1, hoursShort: 0, diamonds: 6000, atStake: 240 },
    { creator: { key: 'b' }, username: 'big', group: 'Team Alpha', coach: 'josh@leap',
      cleared: false, reachable: true, daysLeft, daysShort: 2, hoursShort: 1, diamonds: 80000, atStake: 3200 },
    { creator: { key: 'c' }, username: 'tiny', group: 'Team Alpha', coach: 'josh@leap',
      cleared: false, reachable: true, daysLeft, daysShort: 1, hoursShort: 0, diamonds: 900, atStake: 36 },
  ];
  const s = store();
  assert.equal(activenessPings({ rows: rows(12), store: s, asOf: '2026-09-18', config }).length, 0,
    'three weeks out this is not news');
  const due = activenessPings({ rows: rows(6), store: s, asOf: '2026-09-24', config });
  assert.deepEqual(due.map((r) => r.username), ['big', 'small'],
    'most money first, and the 900-diamond creator is not what the gate is holding back');
  fs.rmSync(s.path, { force: true });
});

test('a creator who must go LIVE nearly every remaining day is pinged whenever that becomes true', () => {
  const cornered = [{
    creator: { key: 'x' }, username: 'cornered', group: 'Team Alpha', coach: 'josh@leap',
    cleared: false, reachable: true, daysLeft: 10, daysShort: 9, hoursShort: 0,
    diamonds: 40000, atStake: 1600,
  }];
  const s = store();
  const due = activenessPings({ rows: cornered, store: s, asOf: '2026-09-20', config });
  assert.deepEqual(due.map((r) => r.username), ['cornered'],
    'ten days left, nine of them mandatory — that is urgent now, not next week');
  fs.rmSync(s.path, { force: true });
});

test('one ping per creator per day, however often the run repeats', () => {
  const rows = [{
    creator: { key: 'a' }, username: 'once', group: 'Team Alpha', coach: 'josh@leap',
    cleared: false, reachable: true, daysLeft: 4, daysShort: 1, hoursShort: 0,
    diamonds: 50000, atStake: 2000,
  }];
  const s = store();
  const first = activenessPings({ rows, store: s, asOf: '2026-09-26', config });
  assert.equal(first.length, 1);
  recordPings(s, '2026-09-26', first);
  assert.equal(activenessPings({ rows, store: s, asOf: '2026-09-26', config }).length, 0);
  assert.equal(activenessPings({ rows, store: s, asOf: '2026-09-27', config }).length, 1,
    'the closing days repeat by design — a new day pings again');
  fs.rmSync(s.path, { force: true });
});

test('the channel is capped, because a dozen cards get read and a hundred do not', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    creator: { key: `k${i}` }, username: `c${i}`, group: 'Team Alpha', coach: 'josh@leap',
    cleared: false, reachable: true, daysLeft: 3, daysShort: 1, hoursShort: 0,
    diamonds: 10000 + i, atStake: 400 + i,
  }));
  const s = store();
  const due = activenessPings({ rows, store: s, asOf: '2026-09-27', config });
  assert.equal(due.length, 12);
  assert.equal(due[0].username, 'c39', 'the cap keeps the most valuable, not the first found');
  fs.rmSync(s.path, { force: true });
});

test('the overview separates what is winnable from what has already gone', () => {
  const creators = [
    who('done', { hours: 20, days: 10 }),
    who('oneday', { hours: 20, days: 7, diamonds: 30000 }),
    who('hours', { hours: 11, days: 9, diamonds: 40000 }),
    who('lost', { hours: 1, days: 1, diamonds: 9000 }),
    who('small', { hours: 20, days: 7, diamonds: 900 }),
  ];
  // Two days left: four missing hours still fit at three hours a day, six
  // missing days do not fit in any number of hours.
  const rows = activenessRows({ creators, asOf: '2026-09-28', config, groupKey });
  const s = activenessSummary(rows, config);
  assert.equal(s.total, 5);
  assert.equal(s.cleared, 1);
  assert.equal(s.lost, 1, 'no amount of streaming turns two days into seven');
  assert.deepEqual(s.oneDayShort.map((r) => r.username), ['oneday'],
    'the 900-diamond creator is below the floor and is not named');
  assert.deepEqual(s.hoursOnly.map((r) => r.username), ['hours']);
  assert.equal(s.atStake, Math.round(30000 * 0.04) + Math.round(40000 * 0.04) + Math.round(900 * 0.04));
  const e = activenessOverviewEmbed(s, { config }).embeds[0];
  assert.match(e.description, /1 of 5/);
  assert.match(e.fields.at(-1).value, /resets on the 1st/);
});

test('the ping card leads with the gap and says what it costs', () => {
  const r = gateFor(who('close', { hours: 12, days: 7, diamonds: 50000 }), '2026-09-27', config);
  const e = activenessPingEmbed(r).embeds[0];
  assert.match(e.title, /1 more LIVE day and 3 more hours/);
  assert.match(e.title, /3 days left/);
  assert.match(e.fields.find((f) => f.name === 'Why it matters').value, /2,000/,
    '50,000 x 4% is what the gate is protecting');
});
