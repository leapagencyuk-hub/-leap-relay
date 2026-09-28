import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { growthBoard, recordGrowthBoard, growthBoardDue } from '../lib/growthboard.mjs';
import { growthBoardEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';

// Day 20 of 30, so August is prorated to 20/31 of itself.
const ASOF = '2026-09-20';
const SCALE = 20 / 31;
const config = {
  growthBoard: { enabled: true, priorWeight: 25, minComparable: 3, thinBelow: 10, show: 12 },
  growth: { liveDaysTarget: 15 },
  monitoring: { ignoreGroups: [] },
};

const who = (username, coach, aug, sep, { group = 'Team Alpha', quitOn = null } = {}) => ({
  key: username, username, coach, quitOn, group, manager: coach, joinDate: '2026-01-01',
  obs: [
    ...(aug == null ? [] : [{ date: '2026-08-31', mtd: { diamonds: aug } }]),
    { date: '2026-09-20', mtd: { diamonds: sep } },
  ],
});
/** n creators for one coach, each flat at the given level. */
const team = (coach, n, aug, sep) =>
  Array.from({ length: n }, (_, i) => who(`${coach}_${i}`, coach, aug, sep));
const store = () => new CaseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-gb-')));

test('growth is measured against last month prorated to the same day', () => {
  // 10,000 in August, prorated to day 20 is 6,451. Doing 12,902 is exactly +100%.
  const creators = team('solo@leap', 5, 10000, Math.round(10000 * SCALE * 2));
  const b = growthBoard({ creators, asOf: ASOF, config });
  assert.equal(Math.round(b.rows[0].growth * 100), 100,
    'a whole month against twenty days would have said -17%');
});

test('a big percentage on a small team does not automatically lead', () => {
  const creators = [
    // A body of flat coaches, so the network prior is modest rather than being
    // set by whichever of the two contenders is bigger.
    ...Array.from({ length: 20 }, (_, i) => team(`flat${i}@leap`, 10, 10000, Math.round(10000 * SCALE))).flat(),
    // 5 creators tripling: +200%.
    ...team('tiny@leap', 5, 10000, Math.round(10000 * SCALE * 3)),
    // 80 creators up 70%.
    ...team('big@leap', 80, 10000, Math.round(10000 * SCALE * 1.7)),
  ];
  const b = growthBoard({ creators, asOf: ASOF, config });
  assert.deepEqual(b.rows.slice(0, 2).map((r) => r.name), ['big', 'tiny']);
  assert.equal(Math.round(b.rows[1].growth * 100), 200, 'the number shown is still the real one');
  assert.ok(b.rows[0].weighted > b.rows[1].weighted);
  assert.equal(b.rows[1].thin, true);
  assert.match(growthBoardEmbed(b, { config }).embeds[0].fields[0].value, /small team/);
});

test('but an extraordinary small team can still win', () => {
  const creators = [
    ...Array.from({ length: 20 }, (_, i) => team(`flat${i}@leap`, 10, 10000, Math.round(10000 * SCALE))).flat(),
    ...team('tiny@leap', 8, 10000, Math.round(10000 * SCALE * 20)),   // +1900%
    ...team('big@leap', 80, 10000, Math.round(10000 * SCALE * 1.2)),  // +20%
  ];
  const b = growthBoard({ creators, asOf: ASOF, config });
  assert.equal(b.rows[0].name, 'tiny', 'the weighting is a handicap, not a ban');
});

test('only creators earning in both months are compared', () => {
  const creators = [
    who('both', 'a@leap', 10000, Math.round(10000 * SCALE)),
    who('brandnew', 'a@leap', null, 500000),
    who('wasnt_earning', 'a@leap', 0, 400000),
    ...team('a@leap', 2, 10000, Math.round(10000 * SCALE)),
  ];
  const b = growthBoard({ creators, asOf: ASOF, config });
  const r = b.rows[0];
  assert.equal(r.comparable, 3, 'the two new ones are not part of the comparison');
  assert.equal(r.roster, 5, 'but they are still on the roster');
  assert.equal(Math.round(r.growth * 100), 0, 'flat, not inflated by creators who had no last month');
});

test('a coach with too little history is not ranked, and is named rather than dropped silently', () => {
  const creators = [
    ...team('enough@leap', 5, 10000, 20000),
    ...team('thin@leap', 2, 10000, 20000),
    ...team('allnew@leap', 6, null, 20000),
  ];
  const b = growthBoard({ creators, asOf: ASOF, config });
  assert.deepEqual(b.rows.map((r) => r.name), ['enough']);
  assert.deepEqual(b.unranked.sort(), ['allnew', 'thin']);
});

test('teams nobody coaches are out, and so are creators who left', () => {
  const creators = [
    ...team('mine@leap', 4, 10000, 20000),
    ...team('partner@x', 4, 10000, 20000).map((c) => ({ ...c, group: 'Surge Agency' })),
    ...team('gone@leap', 4, 10000, 20000).map((c) => ({ ...c, quitOn: '2026-09-10' })),
  ];
  const b = growthBoard({
    creators, asOf: ASOF,
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.deepEqual(b.rows.map((r) => r.name), ['mine']);
});

test('the network growth is the prior everyone is pulled toward', () => {
  const creators = [
    ...team('flat@leap', 50, 10000, Math.round(10000 * SCALE)),
    ...team('up@leap', 4, 10000, Math.round(10000 * SCALE * 2)),
  ];
  const b = growthBoard({ creators, asOf: ASOF, config });
  const up = b.rows.find((r) => r.name === 'up');
  assert.equal(Math.round(up.growth * 100), 100);
  // Four creators at +100% against a network barely moving. The ranked figure
  // should sit far nearer the network than the raw number it came from.
  const toNetwork = Math.abs(up.weighted - b.network);
  const toRaw = Math.abs(up.weighted - up.growth);
  assert.ok(toNetwork < toRaw / 3,
    `weighted ${up.weighted.toFixed(3)} sits ${toNetwork.toFixed(3)} from the network `
    + `and ${toRaw.toFixed(3)} from its own raw figure — it should be much closer to the network`);
});

test('the board shows movement against the last one posted', () => {
  const s = store();
  const day1 = [
    ...team('a@leap', 10, 10000, Math.round(10000 * SCALE * 2)),
    ...team('b@leap', 10, 10000, Math.round(10000 * SCALE * 1.5)),
  ];
  const first = growthBoard({ creators: day1, asOf: ASOF, store: s, config });
  assert.deepEqual(first.rows.map((r) => r.name), ['a', 'b']);
  assert.equal(first.rows[0].move, null);
  recordGrowthBoard(s, first);

  // b overtakes.
  const day2 = [
    ...team('a@leap', 10, 10000, Math.round(10000 * SCALE * 2)),
    ...team('b@leap', 10, 10000, Math.round(10000 * SCALE * 3)),
  ];
  const second = growthBoard({ creators: day2, asOf: '2026-09-21', store: s, config });
  assert.deepEqual(second.rows.map((r) => r.name), ['b', 'a']);
  assert.equal(second.rows[0].move, 1);
  assert.equal(second.rows[1].move, -1);
  fs.rmSync(s.path, { force: true });
});

test('a board from another month does not carry movement into this one', () => {
  const s = store();
  s.data.growthBoard = { month: '2026-08', ranks: { 'a@leap': 9 } };
  const b = growthBoard({ creators: team('a@leap', 5, 10000, 20000), asOf: ASOF, store: s, config });
  assert.equal(b.rows[0].move, null);
  assert.equal(b.rows[0].isNew, false);
  fs.rmSync(s.path, { force: true });
});

test('the call-outs are rates, so they are not about roster size', () => {
  const metricsByKey = new Map();
  const creators = [
    ...team('small_but_good@leap', 4, 10000, 20000),
    ...team('big@leap', 40, 10000, 20000),
  ];
  // Every one of the small coach's creators streams regularly; none of the big one's do.
  for (const c of creators) {
    metricsByKey.set(c.key, { activeDays28: c.manager === 'small_but_good@leap' ? 20 : 2 });
  }
  const b = growthBoard({ creators, metricsByKey, asOf: ASOF, config });
  assert.equal(b.bestHabit.name, 'small_but_good');
  assert.equal(b.bestHabit.habitRate, 1);
  assert.match(growthBoardEmbed(b, { config }).embeds[0].fields[1].name, /Not about size/);
});

test('the board posts once a day, however often the run is repeated', () => {
  const s = store();
  assert.equal(growthBoardDue(config, s, ASOF), true);
  s.data.lastGrowthBoardOn = ASOF;
  assert.equal(growthBoardDue(config, s, ASOF), false);
  assert.equal(growthBoardDue(config, s, '2026-09-21'), true);
  assert.equal(growthBoardDue({ growthBoard: { enabled: false } }, s, '2026-09-21'), false);
  fs.rmSync(s.path, { force: true });
});
