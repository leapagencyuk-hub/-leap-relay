import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leapedState, leapedDue, totalsThrough, monthsSeen } from '../lib/leaped.mjs';
import { leapedEmbed, leapedOverviewEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';

const config = {
  leaped: { enabled: true, hours: 5, diamonds: 5000, fee: 10, currency: 'GBP', closeWithin: 1500, closeHoursWithin: 3 },
  coaches: { names: { 'josh@leap': 'Sur3shot' } },
  monitoring: { ignoreGroups: [] },
};
const store = () => new CaseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-leap-')));

/** A creator with a month-end reading per month given. */
const who = (username, months, { coach = 'josh@leap', group = 'Team Alpha' } = {}) => ({
  key: username, username, quitOn: null, group, manager: coach, joinDate: '2026-08-01',
  obs: Object.entries(months).map(([m, [liveHours, diamonds]]) =>
    ({ date: `${m}-28`, mtd: { liveHours, diamonds } })),
});

test('both halves of the bar have to be cleared, cumulatively', () => {
  const s = leapedState({
    creators: [
      who('cleared', { '2026-09': [6, 6000] }),
      who('hours_short', { '2026-09': [4, 90000] }),
      who('diamonds_short', { '2026-09': [200, 4999] }),
      who('exactly_on', { '2026-09': [5, 5000] }),
      // Neither month clears it alone; together they do.
      who('across_months', { '2026-08': [3, 3000], '2026-09': [3, 3000] }),
    ],
    asOf: '2026-09-20', store: store(), config,
  });
  assert.deepEqual(s.thisMonth.map((r) => r.username).sort(),
    ['across_months', 'cleared', 'exactly_on']);
  assert.equal(s.owed, 30);
});

test('a creator already past the bar before this month is never paid for', () => {
  const s = store();
  const out = leapedState({
    creators: [
      who('old_hand', { '2026-08': [50, 90000], '2026-09': [20, 30000] }),
      who('crossed_now', { '2026-08': [2, 1000], '2026-09': [6, 6000] }),
    ],
    asOf: '2026-09-20', store: s, config,
  });
  assert.deepEqual(out.thisMonth.map((r) => r.username), ['crossed_now']);
  assert.equal(out.owed, 10, 'ten pounds, not twenty');
  assert.deepEqual(out.carriedOver.map((r) => r.username), ['old_hand']);
  // Recorded all the same, so they can never be paid for later either.
  assert.equal(s.data.leaped.old_hand.credited, false);
  assert.equal(s.data.leaped.old_hand.month, null);
  assert.equal(s.data.leaped.old_hand.fee, 0);
  fs.rmSync(s.path, { force: true });
});

test('running twice in a day cannot pay twice', () => {
  const s = store();
  const creators = [who('a', { '2026-08': [1, 100], '2026-09': [6, 6000] })];
  const first = leapedState({ creators, asOf: '2026-09-20', store: s, config });
  assert.equal(first.owed, 10);
  const second = leapedState({ creators, asOf: '2026-09-20', store: s, config });
  assert.equal(second.owed, 10, 'the same tenner, not another one');
  assert.equal(second.today.length, 0, 'and nothing new to announce');
  fs.rmSync(s.path, { force: true });
});

test('a leap is frozen: a later fee change does not move anybody\'s pay', () => {
  const s = store();
  const creators = [who('a', { '2026-08': [1, 100], '2026-09': [6, 6000] })];
  leapedState({ creators, asOf: '2026-09-20', store: s, config });
  const after = leapedState({
    creators, asOf: '2026-09-21', store: s,
    config: { ...config, leaped: { ...config.leaped, fee: 25 } },
  });
  assert.equal(after.owed, 10, 'they leaped at ten pounds and they are paid ten pounds');
  assert.equal(s.data.leaped.a.on, '2026-09-20', 'and the date they did it does not move');
  fs.rmSync(s.path, { force: true });
});

test('a preview cannot create a payroll record', () => {
  const s = store();
  const creators = [who('a', { '2026-08': [1, 100], '2026-09': [6, 6000] })];
  const dry = leapedState({ creators, asOf: '2026-09-20', store: s, config, persist: false });
  assert.equal(dry.owed, 10, 'the preview still shows what it would be');
  assert.deepEqual(Object.keys(s.data.leaped), [], 'but nothing is written down');
  fs.rmSync(s.path, { force: true });
});

test('partner agencies are not LEAP payroll', () => {
  const s = leapedState({
    creators: [
      who('mine', { '2026-09': [6, 6000] }),
      who('partner', { '2026-09': [6, 6000] }, { group: 'Surge Agency', coach: 'surge@x' }),
    ],
    asOf: '2026-09-20', store: store(),
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.deepEqual(s.thisMonth.map((r) => r.username), ['mine']);
  assert.equal(s.owed, 10);
});

test('the bill is per coach, by their nickname', () => {
  const s = leapedState({
    creators: [
      who('a', { '2026-09': [6, 6000] }, { coach: 'josh@leap' }),
      who('b', { '2026-09': [6, 6000] }, { coach: 'josh@leap' }),
      who('c', { '2026-09': [6, 6000] }, { coach: 'amy@leap' }),
    ],
    asOf: '2026-09-20', store: store(), config,
  });
  assert.deepEqual(s.coaches.map((c) => [c.name, c.count, c.owed]),
    [['Sur3shot', 2, 20], ['amy', 1, 10]]);
  assert.match(JSON.stringify(leapedOverviewEmbed({ ...s, carriedOverTotal: 0 })), /£20/);
});

test('the closest list names only gaps a coach could actually close', () => {
  const s = leapedState({
    creators: [
      who('nearly', { '2026-09': [6, 4800] }),
      who('miles_off', { '2026-09': [6, 200] }),
      who('needs_an_hour', { '2026-09': [4.5, 9000] }),
      who('needs_a_fortnight', { '2026-09': [0.5, 9000] }),
    ],
    asOf: '2026-09-20', store: store(), config,
  });
  assert.deepEqual(s.close.map((r) => r.username).sort(), ['nearly', 'needs_an_hour']);
  const field = leapedOverviewEmbed({ ...s, carriedOverTotal: 0 }).embeds[0].fields
    .find((f) => f.name.startsWith('Closest'));
  assert.match(field.value, /needs 200 diamonds/);
  assert.match(field.value, /needs 0\.5h LIVE/);
  assert.ok(!/needs 0 /.test(field.value), '"needs 0 more" reads as a bug');
});

test('the first run is a catch-up, and says so', () => {
  const s = store();
  const creators = [who('a', { '2026-08': [1, 100], '2026-09': [6, 6000] })];
  const first = leapedState({ creators, asOf: '2026-09-20', store: s, config });
  assert.equal(first.firstRun, true);
  assert.match(leapedOverviewEmbed({ ...first, carriedOverTotal: 0 }).embeds[0]
    .fields.find((f) => /Caught up|Leaped today/.test(f.name)).name, /Caught up/);

  const next = leapedState({
    creators: [...creators, who('b', { '2026-08': [1, 100], '2026-09': [6, 6000] })],
    asOf: '2026-09-21', store: s, config,
  });
  assert.equal(next.firstRun, false);
  assert.match(leapedOverviewEmbed({ ...next, carriedOverTotal: 0 }).embeds[0]
    .fields.find((f) => /Caught up|Leaped today/.test(f.name)).name, /Leaped today/);
  fs.rmSync(s.path, { force: true });
});

test('one leap gets its own card, several get one between them', () => {
  const row = (u) => ({ username: u, group: 'Team Alpha', name: 'Sur3shot', month: '2026-09',
    fee: 10, on: '2026-09-20', atHours: 7.2, atDiamonds: 6100 });
  const opts = { threshold: { hours: 5, diamonds: 5000 }, currency: 'GBP', fee: 10 };
  const single = leapedEmbed([row('a')], opts).embeds[0];
  assert.match(single.title, /Leaped — £10/);
  assert.match(single.fields.find((f) => f.name === 'Added to').value, /September payroll/);
  const many = leapedEmbed([row('a'), row('b'), row('c')], opts).embeds[0];
  assert.match(many.title, /3 creators leaped — £30/);
});

test('totals are cumulative, and can be taken up to a month', () => {
  const c = who('a', { '2026-07': [1, 100], '2026-08': [2, 200], '2026-09': [4, 400] });
  const months = monthsSeen([c]);
  assert.deepEqual(months, ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(totalsThrough(c, months), { hours: 7, diamonds: 700 });
  assert.deepEqual(totalsThrough(c, months, '2026-09'), { hours: 3, diamonds: 300 });
});

test('the overview posts once a day, however often the run is repeated', () => {
  const s = store();
  assert.equal(leapedDue(config, s, '2026-09-20'), true);
  s.data.lastLeapedOn = '2026-09-20';
  assert.equal(leapedDue(config, s, '2026-09-20'), false);
  assert.equal(leapedDue(config, s, '2026-09-21'), true);
  assert.equal(leapedDue({ leaped: { enabled: false } }, s, '2026-09-21'), false);
  fs.rmSync(s.path, { force: true });
});
