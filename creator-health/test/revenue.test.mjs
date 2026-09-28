import test from 'node:test';
import assert from 'node:assert/strict';
import { coachRevenue } from '../lib/revenue.mjs';
import { revenueFields, teamSummaryEmbed } from '../lib/discord.mjs';

const config = {
  revenue: {
    enabled: true, baseWage: 0, baseWageByCoach: { 'josh@leap': 350, 'amy@leap': 100 },
    rankUpFloorDiamonds: 100000, rankUpPerDiamondUsd: 0.0001,
    incrementalPerDiamondUsd: 0.00005, goalsMultiplier: 2, usdToGbp: 0.754074,
  },
  leaped: { fee: 10, currency: 'GBP' },
  coaches: { names: { 'josh@leap': 'Sur3shot' }, excludeFromBoards: ['amy@leap'] },
  monitoring: { ignoreGroups: [] },
};
const ASOF = '2026-09-20';

// `lastMonth` is what the export's "Diamonds last month" column says, which is
// what sets the creator's tier. Default 0 puts them in Tier 1, so any creator
// given 100,000+ diamonds has ranked up — which is what these tests want.
const who = (username, { coach = 'josh@leap', group = 'Team Alpha', joinDate = '2026-01-01',
  diamonds = 0, lastMonth = 0, quitOn = null } = {}) => ({
  key: username, username, quitOn, group, manager: coach, joinDate,
  obs: [{ date: '2026-09-20', mtd: { diamonds }, lastMonthDiamonds: lastMonth }],
});
const leapedFor = (pairs) => ({ thisMonth: pairs.map(([coach, username]) => ({ coach, username, fee: 10 })) });

test('the rank-up bonus reproduces the wages sheet, to the penny', () => {
  // WAGES CALCUATOR, July, SHOTTY / gdubz360streams: 1,006,213 diamonds shows
  // 100.6213 USD and 75.8758945 GBP. That row is the spec.
  const rev = coachRevenue({
    creators: [who('gdubz360streams', { diamonds: 1006213 })], asOf: ASOF, config,
  });
  assert.equal(Math.round(rev.rows[0].rankUpBonus * 10000) / 10000, 75.8759);
});

test('rank ups reproduce real WAGES CALCUATOR rows across months and rates', () => {
  // Real rows off the tab, spanning February to July and three different
  // TIKTOK % tiers, to pin that the rate does NOT vary with that column. Each
  // pair is the sheet's own DIAMONDS and its own POUND cell, at the sheet's own
  // FX cell of 0.754073884.
  const sheet = [
    [1743923, 131.504679],   // Feb, MUJU / BOOSTY, 4.5%
    [1366305, 103.029492],   // Mar, MUJU / casperchronicles, 7.5%
    [1006213, 75.875894],    // Jul, SHOTTY / gdubz360streams
    [102320, 7.715684],      // Mar, MUJU / kosmicx_, the smallest row that month
  ];
  const exact = { ...config, revenue: { ...config.revenue, usdToGbp: 0.754073884 } };
  for (const [diamonds, pounds] of sheet) {
    const rev = coachRevenue({ creators: [who('c', { diamonds })], asOf: ASOF, config: exact });
    assert.ok(Math.abs(rev.rows[0].rankUpBonus - pounds) < 0.005,
      `${diamonds} diamonds: got ${rev.rows[0].rankUpBonus}, sheet says ${pounds}`);
  }
});

test('a missing rank-up rate falls back to the sheet rate, not the incremental one', () => {
  // The two USD rates differ by a factor of two. A fallback of 0.00005 here
  // would silently halve every coach's rank-up line rather than failing loudly.
  const { rankUpPerDiamondUsd, ...noRate } = config.revenue;
  const rev = coachRevenue({
    creators: [who('c', { diamonds: 1000000 })], asOf: ASOF,
    config: { ...config, revenue: noRate },
  });
  assert.equal(rev.rankUpPerDiamond, Number((0.0001 * rev.usdToGbp).toPrecision(6)));
  assert.equal(rev.incrementalUsdPerDiamond * 2, 0.0001);
});

test('the incremental rate is the figure LEAP quoted, not one derived from it', () => {
  // recruiter_commission_gbp = diamonds x 0.0000375. Deriving it from the
  // sheet's own FX cell would give 0.0000377 and disagree with the number the
  // recruiters were handed, on a line that is explicitly a rough estimate.
  const rev = coachRevenue({ creators: [who('c', { diamonds: 1000000 })], asOf: ASOF, config });
  assert.equal(rev.incrementalPerDiamond, 0.0000375);
  assert.equal(rev.incrementalUsdPerDiamond, 0.00005);
  assert.equal(rev.rows[0].incrementalShare, 37.5, 'a round million is a round GBP 37.50');
});

test('it is paid on creators whose tier went up, not on a diamond floor', () => {
  const rev = coachRevenue({
    creators: [
      // Tier 1 last month, Tier 7 now: ranked up.
      who('climber', { diamonds: 1000000, lastMonth: 0 }),
      // Huge, but Tier 7 last month and Tier 7 now: held, so pays nothing,
      // even though a 100,000 floor would have paid on it.
      who('plateaued', { diamonds: 1100000, lastMonth: 1050000 }),
      // Big last month, far smaller now: dropped a tier, pays nothing.
      who('slipped', { diamonds: 250000, lastMonth: 900000 }),
    ],
    asOf: ASOF, config,
  });
  const r = rev.rows[0];
  assert.equal(r.diamonds, 2350000, 'the roster total is everyone');
  assert.equal(r.rankUps, 1, 'only the one who moved up');
  assert.equal(r.rankUpDiamonds, 1000000);
  assert.equal(r.rankUpBonus, 1000000 * rev.rankUpPerDiamond);
  assert.equal(r.incrementalShare, 2350000 * rev.incrementalPerDiamond, 'but the manager share is all of them');
});

test('ranking up pays on the creator\'s whole month, not the threshold crossed', () => {
  // gdubz360streams, August: 1,006,213 diamonds off a July tier of 800,483, so
  // Tier 6 to Tier 7. The sheet pays the full 1,006,213, not the 1,000,000.
  const rev = coachRevenue({
    creators: [who('gdubz360streams', { diamonds: 1006213, lastMonth: 800483 })],
    asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, usdToGbp: 0.754073884 } },
  });
  assert.equal(rev.rows[0].rankUps, 1);
  assert.ok(Math.abs(rev.rows[0].rankUpBonus - 75.875894) < 0.005);
});

test('the two diamond shares use different populations', () => {
  const rev = coachRevenue({
    creators: [
      who('big', { diamonds: 1000000, lastMonth: 0 }),
      who('small', { diamonds: 50000, lastMonth: 40000 }),
    ],
    asOf: ASOF, config,
  });
  const r = rev.rows[0];
  // The manager share is the whole roster; rank ups are only the creator who
  // moved up. Using one population for both misses the month in both
  // directions.
  assert.equal(r.incrementalShare, 1050000 * rev.incrementalPerDiamond);
  assert.equal(r.rankUpBonus, 1000000 * rev.rankUpPerDiamond);
  assert.equal(r.total, r.base + r.recruitBonus + r.incrementalShare + r.rankUpBonus);
});

test('the GBP rate the recruiters were given comes out of the USD one', () => {
  // recruiter_commission_gbp = diamonds x 0.0000375, at roughly $1 to GBP 0.75.
  const rev = coachRevenue({
    creators: [who('a', { diamonds: 1000000 })], asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, usdToGbp: 0.75 } },
  });
  assert.equal(rev.incrementalPerDiamond, 0.0000375);
  assert.equal(rev.rows[0].incrementalShare, 37.5);
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

test('Backstage goals double the incremental share, and sit on a second line', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 1000000, lastMonth: 0 })], asOf: ASOF, config });
  const r = rev.rows[0];
  assert.equal(r.incrementalWithGoals, r.incrementalShare * 2);
  assert.equal(r.totalWithGoals, r.total + r.incrementalShare);
  assert.equal(r.rankUpBonus, 1000000 * rev.rankUpPerDiamond, 'rank ups do not move');
  // The goals line is a figure on the card, not a paragraph explaining itself.
  const block = revenueFields(rev, rev.rows, { config })[1].value;
  assert.match(block, /ESTIMATED THIS MONTH/);
  assert.match(block, /with Backstage goals/);
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

test('the card is figures, not workings — the prose is gone', () => {
  const rev = coachRevenue({
    creators: [who('a', { diamonds: 1000000, lastMonth: 0 }), who('b', { diamonds: 80000, lastMonth: 38000 })],
    asOf: ASOF, config,
  });
  const body = revenueFields(rev, rev.rows, { config })[1].value;
  assert.match(body, /Incremental share\s+~/);
  // The rates, the sheet's column name and the explanation of how each line is
  // worked out belong in the code, not on a coach's morning card.
  for (const workings of [/0\.0000375/, /MANAGER DIAMOND/, /whole roster/, /roughest number/,
    /Everyone is on/, /a further 10%/, /15th of next month/]) {
    assert.doesNotMatch(body, workings, `${workings} is workings-out, not a figure`);
  }
  // What is left is the summary line: diamonds, rank-ups, what is still winnable.
  assert.match(body, /1,080,000 diamonds · 1 rank-up · 1 more in reach, ~£\d/);
});

test('the warning is the first thing in the block, and says what it has to', () => {
  const rev = coachRevenue({ creators: [who('a', { diamonds: 100000 })], asOf: ASOF, config });
  const fields = revenueFields(rev, rev.rows, { config });
  assert.match(fields[0].name, /rough estimate only/i);
  const warning = fields[0].value.toUpperCase();
  assert.match(warning, /ROUGH ESTIMATE OF YOUR INCOME, NOT EXACT/);
  assert.match(warning, /TALK TO THE DIRECTORS/);
  // It is the only prose left on the block, so it stays short enough to read.
  assert.ok(fields[0].value.length < 220, `warning is ${fields[0].value.length} chars`);
});

test('the card calls it Rank ups, which is what the coaches call it', () => {
  // LEAP's own name for this. Recruitment 26/27 labels the row ALPHA GROUP TASK
  // BONUS, but nobody says that out loud, and a card nobody can read is worse
  // than one that disagrees with a spreadsheet column heading.
  const rev = coachRevenue({
    creators: [who('big', { diamonds: 900000 }), who('small', { diamonds: 40000 })],
    asOf: ASOF, config,
  });
  const body = revenueFields(rev, rev.rows, { config }).map((f) => f.value).join('\n');
  assert.match(body, /Rank ups\s+~/, 'the line is labelled Rank ups');
  assert.doesNotMatch(body, /alpha/i, 'and nothing on the card says alpha');
  assert.match(body, /940,000 diamonds · 1 rank-up/, 'one rank-up, not "1 rank-ups"');
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
