import test from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, nextTier, rankUpFor, rankUpBoard, DEFAULT_TIERS } from '../lib/tiers.mjs';
import { rankUpFields } from '../lib/discord.mjs';

const config = {
  rankUp: { enabled: true, advanced: false, coachSharePerDiamondUsd: 0.0001, stretch: 2, tiers: DEFAULT_TIERS },
  revenue: { usdToGbp: 0.754073884 },
  leaped: { currency: 'GBP' },
  coaches: { names: { 'josh@leap': 'Sur3shot' } },
  monitoring: { ignoreGroups: [] },
};
const ASOF = '2026-09-20';

const who = (username, { diamonds = 0, lastMonth = 0, coach = 'josh@leap',
  group = 'Team Alpha', quitOn = null, date = ASOF } = {}) => ({
  key: username, username, quitOn, group, manager: coach, joinDate: '2026-01-01',
  obs: [{ date, mtd: { diamonds }, lastMonthDiamonds: lastMonth }],
});

test('the tier table is TikTok\'s, thresholds and ratios both', () => {
  const cases = [
    [0, 1, 0.065, 0.075], [99999, 1, 0.065, 0.075],
    [100000, 2, 0.065, 0.075], [200000, 3, 0.065, 0.075],
    [300000, 4, 0.065, 0.075], [500000, 5, 0.065, 0.075],
    [700000, 6, 0.055, 0.065], [1000000, 7, 0.045, 0.055],
    [1600000, 8, 0.035, 0.045], [2500000, 9, 0.03, 0.04],
  ];
  for (const [d, tier, base, adv] of cases) {
    const t = tierOf(d, config);
    assert.equal(t.tier, tier, `${d} diamonds`);
    assert.equal(t.base, base);
    assert.equal(t.advanced, adv);
    // Every row's advanced ratio is its base plus exactly one point. That is
    // the rule Backstage states as "X%" and "X+1%", and it is worth pinning:
    // a table typed in by hand is where a stray digit would live.
    assert.ok(Math.abs(adv - base - 0.01) < 1e-9, `tier ${tier} advanced is base + 1%`);
  }
});

test('tier 10 pays nothing and has nothing above it', () => {
  const t = tierOf(5000000, config);
  assert.equal(t.tier, 10);
  assert.equal(t.base, null);
  assert.equal(nextTier(t, config), null);
  const r = rankUpFor(who('ceiling', { diamonds: 6000000, lastMonth: 5200000 }), ASOF, config);
  assert.equal(r.target, null, 'no chase to show');
  assert.equal(r.worthIfCrossed, 0);
});

test('the tier comes from last month, not this month', () => {
  // 900,000 this month would be Tier 6 on its own. The tier that decides the
  // ratio is last month's 120,000, which is Tier 2.
  const r = rankUpFor(who('climber', { diamonds: 900000, lastMonth: 120000 }), ASOF, config);
  assert.equal(r.fromTier, 2);
  assert.equal(r.toTier, 6);
  assert.equal(r.ratio, 0.065, 'the ratio is the tier they started in');
  assert.ok(r.rankedUp);
});

test('holding a tier is not ranking up, however big the creator', () => {
  const r = rankUpFor(who('plateaued', { diamonds: 1_100_000, lastMonth: 1_050_000 }), ASOF, config);
  assert.equal(r.fromTier, 7);
  assert.equal(r.toTier, 7);
  assert.equal(r.rankedUp, false);
  assert.equal(r.maintained, true);
  assert.equal(r.worth, 0, 'maintenance is worth nothing until we have the ratios');
});

test('dropping a tier is not ranking up either', () => {
  const r = rankUpFor(who('slipped', { diamonds: 250000, lastMonth: 900000 }), ASOF, config);
  assert.equal(r.rankedUp, false);
  assert.equal(r.maintained, false);
  assert.equal(r.worth, 0);
});

test('a rank-up pays 1% of the whole month, not of the part above the line', () => {
  // The real August row: gdubz360streams, 1,006,213 off a July tier of
  // 800,483. The sheet pays GBP 75.8758945 — the whole month, not the 6,213
  // above the 1,000,000 threshold.
  const r = rankUpFor(who('gdubz360streams', { diamonds: 1006213, lastMonth: 800483 }), ASOF, config);
  assert.equal(r.fromTier, 6);
  assert.equal(r.toTier, 7);
  assert.ok(r.rankedUp);
  assert.ok(Math.abs(r.worth - 75.875894) < 0.005, `got ${r.worth}`);
});

test('a creator in their first month starts at tier 1, like TikTok treats them', () => {
  const r = rankUpFor(who('newbie', { diamonds: 150000, lastMonth: 0 }), ASOF, config);
  assert.equal(r.fromTier, 1);
  assert.ok(r.rankedUp, 'crossing 100,000 out of nothing is a rank-up');
});

test('the chase is the gap to the next tier, and the pace it needs', () => {
  // 20 September, so 10 days left. 260,000 against a Tier 4 line of 300,000.
  const r = rankUpFor(who('nearly', { diamonds: 260000, lastMonth: 210000 }), ASOF, config);
  assert.equal(r.fromTier, 3);
  assert.equal(r.target, 300000);
  assert.equal(r.gap, 40000);
  assert.equal(r.daysLeft, 10);
  assert.equal(r.needPerDay, 4000);
  assert.ok(r.reachable, '4,000 a day against 13,000 a day so far');
});

test('a chase nobody can win is not shown as a chase', () => {
  // 12,000 so far, 88,000 to go in 10 days: 8,800 a day against 600. Asking
  // for fifteen times the pace is not coaching, it is noise.
  const r = rankUpFor(who('miles_off', { diamonds: 12000, lastMonth: 5000 }), ASOF, config);
  assert.equal(r.gap, 88000);
  assert.equal(r.reachable, false);
});

test('worthIfCrossed is the step a coach is being asked to go and get', () => {
  const r = rankUpFor(who('nearly', { diamonds: 260000, lastMonth: 210000 }), ASOF, config);
  assert.equal(r.worth, 0, 'worth nothing right now');
  // Crossing means at least 300,000, at 1% of the diamond dollar value.
  assert.ok(Math.abs(r.worthIfCrossed - 300000 * 0.0001 * 0.754073884) < 0.005);
});

test('the board splits banked from winnable, and ignores partner agencies', () => {
  const board = rankUpBoard({
    creators: [
      who('banked', { diamonds: 400000, lastMonth: 120000 }),
      who('winnable', { diamonds: 260000, lastMonth: 210000 }),
      who('hopeless', { diamonds: 12000, lastMonth: 5000 }),
      who('quit', { diamonds: 900000, lastMonth: 0, quitOn: '2026-09-04' }),
      who('partner', { diamonds: 900000, lastMonth: 0, group: 'Surge Agency', coach: 'surge@x' }),
    ],
    asOf: ASOF,
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.deepEqual(board.ranked.map((r) => r.username), ['banked']);
  assert.deepEqual(board.close.map((r) => r.username), ['winnable']);
  const e = board.byCoach.get('josh@leap');
  assert.equal(e.name, 'Sur3shot');
  assert.ok(e.worth > 0 && e.upside > 0);
});

test('close is ordered by what it is worth, not by how near it looks', () => {
  const board = rankUpBoard({
    creators: [
      // 2,000 off Tier 2 — nearest, but only worth 100,000 diamonds.
      who('tiny_gap', { diamonds: 98000, lastMonth: 40000 }),
      // 60,000 off Tier 6 — further, but worth seven times as much.
      who('big_prize', { diamonds: 640000, lastMonth: 520000 }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(board.close.map((r) => r.username), ['big_prize', 'tiny_gap']);
});

test('the bracket card names the creator, the gap, the money and the pace', () => {
  const board = rankUpBoard({
    creators: [
      who('banked', { diamonds: 400000, lastMonth: 120000 }),
      who('nearly', { diamonds: 260000, lastMonth: 210000 }),
    ],
    asOf: ASOF, config,
  });
  const body = rankUpFields(board, ['josh@leap'], { config }).map((f) => f.value).join('\n');
  assert.match(body, /banked/);
  assert.match(body, /Tier 2 to 4/);
  assert.match(body, /nearly/);
  assert.match(body, /40,000 short of 300,000/);
  assert.match(body, /4,000 a day for the last 10 days/);
  assert.match(body, /1% of their whole month/, 'and says how it pays');
});

test('a long bracket list is cut on whole lines, never mid-sentence', () => {
  // Each entry wraps onto a second line, so a plain slice at Discord's 1024
  // would land inside a sentence about somebody's money.
  const creators = Array.from({ length: 30 }, (_, i) =>
    who(`chaser_with_a_long_name_${i}`, { diamonds: 260000 + i, lastMonth: 210000 }));
  const board = rankUpBoard({ creators, asOf: ASOF, config });
  const field = rankUpFields(board, ['josh@leap'], { config, limit: 30 })[0];
  assert.ok(field.value.length <= 1024);
  for (const line of field.value.split('\n')) {
    // Every wrapped line ends with a complete pace clause, not a bare number.
    if (line.trim().startsWith('4,')) assert.match(line, /a day so far$/);
  }
});

test('no rank-ups and nothing in reach means no card at all', () => {
  const board = rankUpBoard({
    creators: [who('flat', { diamonds: 12000, lastMonth: 11000 })], asOf: ASOF, config,
  });
  assert.deepEqual(rankUpFields(board, ['josh@leap'], { config }), []);
  assert.deepEqual(rankUpFields(null, ['josh@leap'], { config }), []);
});

test('a creator with no reading this month is not guessed at', () => {
  assert.equal(rankUpFor({ username: 'ghost', obs: [] }, ASOF, config), null);
  assert.equal(rankUpFor({ username: 'ghost' }, ASOF, config), null);
});

test('the advanced ratio is a network setting, and never changes the coach\'s 1%', () => {
  const c = who('climber', { diamonds: 900000, lastMonth: 120000 });
  const base = rankUpFor(c, ASOF, config);
  const adv = rankUpFor(c, ASOF, { ...config, rankUp: { ...config.rankUp, advanced: true } });
  assert.equal(base.ratio, 0.065);
  assert.equal(adv.ratio, 0.075);
  assert.equal(base.worth, adv.worth, 'what the coach gets does not move');
});
