import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leaderboard, recordBoard, leaderboardDue } from '../lib/leaderboard.mjs';
import { leaderboardEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';

const ASOF = '2026-09-20';   // day 20 of 30
const config = {
  leaderboard: { enabled: true, show: 10 },
  monitoring: { ignoreGroups: [] },
};

const who = (username, joinDate, { coach = 'josh@leap', group = 'Team Alpha',
  diamonds = 0, liveDays = 0 } = {}) => ({
  key: username, username, joinDate, quitOn: null, group, manager: coach,
  obs: [{ date: '2026-09-20', mtd: { diamonds, liveDays, validLiveDays: liveDays } }],
});
const store = () => new CaseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lb-')));

test('a recruit is somebody who joined this calendar month, credited to their manager', () => {
  const creators = [
    who('a', '2026-09-02', { coach: 'josh@leap' }),
    who('b', '2026-09-11', { coach: 'josh@leap' }),
    who('c', '2026-09-19', { coach: 'amy@leap' }),
    who('lastmonth', '2026-08-28', { coach: 'josh@leap' }),
    who('nojoindate', null, { coach: 'josh@leap' }),
  ];
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.equal(b.total, 3);
  assert.deepEqual(b.rows.map((r) => [r.name, r.count]), [['josh', 2], ['amy', 1]]);
});

test('ties break on who actually started them', () => {
  const creators = [
    who('a1', '2026-09-02', { coach: 'josh@leap', liveDays: 3 }),
    who('a2', '2026-09-03', { coach: 'josh@leap' }),
    who('b1', '2026-09-02', { coach: 'amy@leap', liveDays: 4 }),
    who('b2', '2026-09-03', { coach: 'amy@leap', liveDays: 2 }),
  ];
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.deepEqual(b.rows.map((r) => r.name), ['amy', 'josh'],
    'same count, but amy started both — the tiebreak points the right way');
});

test('teams nobody coaches are not in the competition', () => {
  const creators = [
    who('mine', '2026-09-02', { coach: 'josh@leap' }),
    who('partner', '2026-09-02', { coach: 'surge@x', group: 'Surge Agency' }),
  ];
  const b = leaderboard({
    creators, asOf: ASOF,
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.equal(b.total, 1);
  assert.deepEqual(b.rows.map((r) => r.name), ['josh']);
});

test('the board shows movement against the last one posted', () => {
  const s = store();
  const day1 = [
    who('a', '2026-09-02', { coach: 'josh@leap' }),
    who('b', '2026-09-03', { coach: 'josh@leap' }),
    who('c', '2026-09-04', { coach: 'amy@leap' }),
  ];
  const first = leaderboard({ creators: day1, asOf: ASOF, store, config });
  assert.equal(first.rows[0].move, null, 'nothing to compare against on the first board');
  recordBoard(s, first);

  // Amy signs three overnight and takes the lead.
  const day2 = [...day1,
    who('d', '2026-09-20', { coach: 'amy@leap' }),
    who('e', '2026-09-20', { coach: 'amy@leap' }),
    who('f', '2026-09-20', { coach: 'amy@leap' }),
    who('g', '2026-09-20', { coach: 'newcoach@leap' }),
  ];
  const second = leaderboard({ creators: day2, asOf: '2026-09-21', store: s, config });
  const amy = second.rows.find((r) => r.name === 'amy');
  const josh = second.rows.find((r) => r.name === 'josh');
  const fresh = second.rows.find((r) => r.name === 'newcoach');
  assert.equal(amy.rank, 1);
  assert.equal(amy.move, 1, 'climbed one place');
  assert.equal(amy.gained, 3, 'and signed three since the last board');
  assert.equal(josh.move, -1);
  assert.equal(fresh.isNew, true);
  assert.match(leaderboardEmbed(second, { config }).embeds[0].fields[0].value, /\+3 today/);
  fs.rmSync(s.path, { force: true });
});

test('a board from a different month is not used for movement', () => {
  const s = store();
  s.data.leaderboard = { month: '2026-08', ranks: { 'josh@leap': 5 }, counts: { 'josh@leap': 40 } };
  const b = leaderboard({ creators: [who('a', '2026-09-02')], asOf: ASOF, store: s, config });
  assert.equal(b.rows[0].move, null, 'the board resets on the 1st, and so does the movement');
  assert.equal(b.rows[0].isNew, false);
  fs.rmSync(s.path, { force: true });
});

test('the month is projected on last month shape, not a straight line', () => {
  // 20 signed by day 20. Last month: 20 by day 20, 22 in total — front-loaded.
  const creators = [
    ...Array.from({ length: 20 }, (_, i) => who(`n${i}`, '2026-09-02')),
    ...Array.from({ length: 20 }, (_, i) => who(`o${i}`, '2026-08-02')),
    ...Array.from({ length: 2 }, (_, i) => who(`p${i}`, '2026-08-25')),
  ];
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.equal(b.lastToSamePoint, 20);
  assert.equal(b.lastMonthTotal, 22);
  assert.equal(b.projected, 22, 'a straight line would have said 30');
  assert.equal(b.projectedFrom, 'last month');
});

test('with no last month to compare, a straight line is all the data supports', () => {
  const creators = Array.from({ length: 10 }, (_, i) => who(`n${i}`, '2026-09-02'));
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.equal(b.projected, 15);
  assert.equal(b.projectedFrom, 'pace');
  assert.equal(b.change, null);
});

test('the board says how many of the signings actually started', () => {
  const creators = [
    who('started', '2026-09-02', { liveDays: 4, diamonds: 5000 }),
    who('live_no_earnings', '2026-09-03', { liveDays: 2 }),
    who('never', '2026-09-04'),
  ];
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.equal(b.started, 2);
  assert.equal(b.earning, 1);
  assert.equal(Math.round(b.startedRate * 100), 67);
  assert.deepEqual(b.notStarted.map((r) => r.username), ['never']);
  const e = leaderboardEmbed(b, { config }).embeds[0];
  assert.match(e.fields.at(-1).value, /2 of 3/);
  assert.match(e.fields.at(-1).value, /count against the graduation rate/,
    'volume without activation is the trap this board could otherwise create');
});

test('the best signing of the month is named, with who brought them in', () => {
  const creators = [
    who('small', '2026-09-02', { coach: 'josh@leap', diamonds: 500, liveDays: 2 }),
    who('star', '2026-09-03', { coach: 'amy@leap', diamonds: 180000, liveDays: 15 }),
  ];
  const b = leaderboard({ creators, asOf: ASOF, config });
  assert.equal(b.standout.username, 'star');
  assert.match(leaderboardEmbed(b, { config }).embeds[0].fields[1].value, /amy/);
});

test('the board posts once a day, however often the run is repeated', () => {
  const s = store();
  assert.equal(leaderboardDue(config, s, ASOF), true);
  s.data.lastLeaderboardOn = ASOF;
  assert.equal(leaderboardDue(config, s, ASOF), false);
  assert.equal(leaderboardDue(config, s, '2026-09-21'), true);
  assert.equal(leaderboardDue({ leaderboard: { enabled: false } }, s, '2026-09-21'), false);
  fs.rmSync(s.path, { force: true });
});
