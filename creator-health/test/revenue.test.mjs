import test from 'node:test';
import assert from 'node:assert/strict';
import { coachRevenue } from '../lib/revenue.mjs';
import { revenueFields, teamSummaryEmbed } from '../lib/discord.mjs';

const config = {
  revenue: {
    enabled: true, baseWage: 0, baseWageByCoach: { 'josh@leap': 350, 'amy@leap': 100 },
    alphaFloorDiamonds: 100000, incrementalPerDiamondUsd: 0.0001, goalsMultiplier: 2,
    usdToGbp: 0.754074,
  },
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

test('the alpha group task bonus reproduces the wages sheet, to the penny', () => {
  // WAGES CALCUATOR, July, SHOTTY / gdubz360streams: 1,006,213 diamonds shows
  // 100.6213 USD and 75.8758945 GBP. That row is the spec.
  const rev = coachRevenue({
    creators: [who('gdubz360streams', { diamonds: 1006213 })], asOf: ASOF, config,
  });
  assert.equal(Math.round(rev.rows[0].alphaBonus * 10000) / 10000, 75.8759);
});

test('it is paid on creators past the floor only', () => {
  const rev = coachRevenue({
    creators: [
      who('big', { diamonds: 1000000 }),
      who('under', { diamonds: 99999 }),
      who('exactly_on', { diamonds: 100000 }),
    ],
    asOf: ASOF, config,
  });
  const r = rev.rows[0];
  assert.equal(r.diamonds, 1199999, 'the roster total is everyone');
  assert.equal(r.qualifying, 2);
  assert.equal(r.qualifyingDiamonds, 1100000);
  assert.equal(r.alphaBonus, 1100000 * 0.0001 * 0.754074);
});

test('the manager diamond share is left out rather than invented', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 1000000 })], asOf: ASOF, config });
  const r = rev.rows[0];
  assert.equal(r.managerDiamondShare, null);
  assert.equal(r.accountedFor, r.base + r.recruitBonus + r.alphaBonus,
    'the total is a floor, and only of what this data can account for');
  const block = revenueFields(rev, rev.rows, { config });
  assert.match(block[1].value, /not calculated/);
  assert.match(block[0].value, /floor, not a total/);
});

test('each coach gets their own fixed amount, and nobody gets an invented one', () => {
  const rev = coachRevenue({
    creators: [
      who('a', { coach: 'josh@leap' }),
      who('b', { coach: 'amy@leap' }),
      who('c', { coach: 'notonthesheet@leap' }),
    ],
    asOf: ASOF, config,
  });
  assert.equal(rev.byCoach.get('josh@leap').base, 350);
  assert.equal(rev.byCoach.get('amy@leap').base, 100);
  assert.equal(rev.byCoach.get('notonthesheet@leap').base, 0,
    'not on the sheet is not on a fixed amount');
  // And the line does not appear at all for them.
  const block = revenueFields(rev, [rev.byCoach.get('notonthesheet@leap')], { config })[1].value;
  assert.ok(!/Extra revenue/.test(block));
});

test('Backstage goals double the alpha share, and sit on a second line', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 1000000 })], asOf: ASOF, config });
  const r = rev.rows[0];
  assert.equal(r.alphaWithGoals, r.alphaBonus * 2);
  assert.equal(r.accountedForWithGoals, r.accountedFor + r.alphaBonus);
  assert.ok(r.accountedForWithGoals > r.accountedFor);
  const block = revenueFields(rev, rev.rows, { config })[1].value;
  assert.match(block, /ACCOUNTED FOR SO FAR/);
  assert.match(block, /with Backstage goals/);
  assert.match(block, /Everyone is on \*\*10%\*\*/);
  assert.match(block, /a further 10%/);
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
