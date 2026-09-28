import test from 'node:test';
import assert from 'node:assert/strict';
import { coachRevenue } from '../lib/revenue.mjs';
import { revenueFields, teamSummaryEmbed } from '../lib/discord.mjs';

const config = {
  revenue: { enabled: true, baseWage: 150, incrementalPerDiamondUsd: 0.00005, usdToGbp: 0.75, goalBonusPct: 0.10, bonusOnBase: false },
  leaped: { fee: 10, currency: 'GBP' },
  coaches: { names: { 'josh@leap': 'Sur3shot' }, excludeFromBoards: ['amy@leap'] },
  monitoring: { ignoreGroups: [] },
};
const ASOF = '2026-09-20';

const who = (username, { coach = 'josh@leap', group = 'Team Alpha', joinDate = '2026-01-01',
  diamonds = 0, quitOn = null } = {}) => ({
  key: username, username, quitOn, group, manager: coach, joinDate,
  obs: [{ date: '2026-09-20', mtd: { diamonds } }],
});
const leapedFor = (pairs) => ({ thisMonth: pairs.map(([coach, username]) => ({ coach, username, fee: 10 })) });

test('the three parts add up, and the bonus is a ceiling not a total', () => {
  const rev = coachRevenue({
    creators: [
      who('a', { diamonds: 1000000, joinDate: '2026-09-02' }),
      who('b', { diamonds: 2000000 }),
    ],
    asOf: ASOF, config, leaped: leapedFor([['josh@leap', 'a'], ['josh@leap', 'b']]),
  });
  const r = rev.rows[0];
  assert.equal(r.recruited, 1, 'only the one who joined this month');
  assert.equal(r.leapedCount, 2);
  assert.equal(r.leapedPay, 20);
  assert.equal(r.diamonds, 3000000);
  assert.equal(r.incremental, 3000000 * 0.0000375);
  assert.equal(r.base, 150);
  assert.equal(r.earned, 132.5, 'what they made on top of the fixed wage');
  assert.equal(r.total, 150 + 132.5);
  assert.ok(r.withBonus > r.total, 'the bonus is not earned yet, so it sits above the estimate');
});

test('the goal bonus is taken on what was earned, not on the fixed wage', () => {
  const creators = [who('a', { diamonds: 2000000 })];   // GBP 75 incremental
  const off = coachRevenue({ creators, asOf: ASOF, config }).rows[0];
  assert.equal(off.total, 225);
  assert.equal(off.withBonus, 225 + 7.5, '10% of the 75 earned, not of the 225');

  const on = coachRevenue({
    creators, asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, bonusOnBase: true } },
  }).rows[0];
  // 225 * 1.1 is 247.50000000000003; adding the share is exact, which is why
  // the code is written that way round.
  assert.equal(on.withBonus, 247.5, 'unless somebody says otherwise');
});

test('with no base wage set, nothing about the base is printed', () => {
  const rev = coachRevenue({
    creators: [who('a', { diamonds: 2000000 })], asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, baseWage: 0 } },
  });
  assert.equal(rev.rows[0].base, 0);
  assert.equal(rev.rows[0].total, 75);
  const block = revenueFields(rev, rev.rows, { config })[1].value;
  assert.ok(!/Base wage/.test(block));
  assert.ok(!/base wage/.test(block), 'including the footnote about it');
});

test('the per-diamond rate is the USD rate converted, not a second number to drift', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 100 })], asOf: ASOF, config });
  assert.equal(rev.perDiamond, 0.0000375, 'and not 0.000037500000000000003');
  const euro = coachRevenue({
    creators: [who('a', { diamonds: 1000000 })], asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, usdToGbp: 0.8 } },
  });
  assert.equal(euro.perDiamond, 0.00004, 'changing the exchange rate moves one number');
  assert.equal(euro.rows[0].incremental, 40);
  assert.equal(euro.rows[0].total, 190, 'and the base rides on top of it');
});

test('all-time onboarded counts creators who have since left', () => {
  const rev = coachRevenue({
    creators: [who('here'), who('gone', { quitOn: '2026-09-10' })],
    asOf: ASOF, config,
  });
  assert.equal(rev.rows[0].onboardedAllTime, 2, 'they still onboarded them');
  assert.equal(rev.rows[0].roster, 1);
});

test('partner agencies are not in anybody\'s revenue', () => {
  const rev = coachRevenue({
    creators: [
      who('mine', { diamonds: 100000 }),
      who('partner', { coach: 'surge@x', group: 'Surge Agency', diamonds: 900000 }),
    ],
    asOf: ASOF, config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.deepEqual(rev.rows.map((r) => r.name), ['Sur3shot']);
});

test('the all-staff board honours the leaderboard exclusions, but the pay block does not', () => {
  const rev = coachRevenue({
    creators: [
      who('a', { coach: 'josh@leap', joinDate: '2026-09-02', diamonds: 100000 }),
      who('b', { coach: 'amy@leap', joinDate: '2026-09-03', diamonds: 500000 }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(rev.recruitBoard.map((r) => r.name), ['Sur3shot'],
    'amy is off the boards');
  assert.ok(rev.byCoach.has('amy@leap'), 'but still has earnings of her own — pay is not a contest');
});

test('the warning is the first thing in the block, and says what it has to', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 100000 })], asOf: ASOF, config });
  const fields = revenueFields(rev, rev.rows, { config });
  assert.match(fields[0].name, /rough estimate only/i);
  const warning = fields[0].value.toUpperCase();
  assert.match(warning, /ROUGH ESTIMATE OF YOUR INCOME, NOT EXACT/);
  assert.match(warning, /TALK TO THE DIRECTORS/);
  assert.match(fields[0].value, /move\s+through the month/);
});

test('a team summary shows the coaches who work that team, not the whole network', () => {
  const rev = coachRevenue({
    creators: [
      who('a', { coach: 'josh@leap', group: 'Team Alpha', diamonds: 100000 }),
      who('b', { coach: 'amy@leap', group: 'Team Alpha', diamonds: 200000 }),
      who('c', { coach: 'bob@leap', group: 'Team Bravo', diamonds: 300000 }),
    ],
    asOf: ASOF, config,
  });
  const alpha = rev.rows.filter((r) => r.teams.includes('Team Alpha'));
  assert.deepEqual(alpha.map((r) => r.name).sort(), ['Sur3shot', 'amy']);
  assert.ok(!alpha.some((r) => r.name === 'bob'));
});

test('no revenue block at all when there is nothing to show', () => {
  assert.deepEqual(revenueFields(null, [], { config }), []);
  assert.deepEqual(revenueFields({ rows: [] }, [], { config }), []);
});

test('the block renders inside the summary, last', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 100000 })], asOf: ASOF, config });
  const summary = {
    team: 'Team Alpha', asOf: ASOF, daysLeft: 10,
    roster: { total: 1, earning: 1, meetingFrequency: 0, target: 15 },
    month: { toDate: 100000, comparableToDate: 0, lastToSamePoint: null, change: null, comparable: 0, previousMonth: '2026-08' },
    top: [], rising: [], readyToPush: [], slipping: [], slippingTotal: 0,
    frequency: { target: 15, meeting: 0, below: 1, closest: [] },
    graduation: { total: 0, graduated: 0, within10k: [], within25k: [], within50k: [], within100k: [], further: 0, closest: [], bestPlaced: [] },
    revenue: rev, revenueCoaches: rev.rows,
  };
  const fields = teamSummaryEmbed(summary, { config }).embeds[0].fields;
  const idx = fields.findIndex((f) => /rough estimate only/i.test(f.name));
  assert.ok(idx > 0, 'it exists');
  assert.ok(idx >= fields.findIndex((f) => /habit/i.test(f.name)),
    'and comes after the coaching, not before it');
});
