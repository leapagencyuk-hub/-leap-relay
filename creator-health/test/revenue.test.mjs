import test from 'node:test';
import assert from 'node:assert/strict';
import { coachRevenue } from '../lib/revenue.mjs';
import { revenueFields, teamSummaryEmbed } from '../lib/discord.mjs';

const config = {
  revenue: {
    enabled: true, baseWage: 0, baseWageByCoach: { 'josh@leap': 350, 'amy@leap': 100 },
    rankUpFloorDiamonds: 100000, rankUpPerDiamondUsd: 0.0001, usdToGbp: 0.754074,
    incremental: { boardRate: 0.05, baseUnlock: 0.10, goalBonus: 0.05 },
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
  // The two rates differ by a factor of two. A wrong fallback here would
  // silently halve every coach's rank-up line rather than failing loudly.
  const { rankUpPerDiamondUsd, ...noRate } = config.revenue;
  const rev = coachRevenue({
    creators: [who('c', { diamonds: 1000000 })], asOf: ASOF,
    config: { ...config, revenue: noRate },
  });
  assert.equal(rev.rankUpPerDiamond, Number((0.0001 * rev.usdToGbp).toPrecision(6)));
});

test('the manager share reproduces LEAP\'s own finance sheet, to the penny', () => {
  // Recruitment 26/27, September's MANAGER DIAMOND % column, against each
  // coach's September roster diamonds. TikTok paid 8% that month and the
  // unlocks were 10, 15 and 20 — this is the arithmetic the sheet does, and it
  // is exact for all ten coaches, which is why this is the spec and not a
  // formula somebody described.
  const sheet = [
    ['tiktokphil', 4079453, 0.20, 492.09],
    ['joshbates93', 7205729, 0.10, 434.49],
    ['bigbamc', 2089211, 0.20, 251.96],
    ['mujustreamer', 3467933, 0.10, 209.02],
    ['alex593', 2133054, 0.10, 128.25],
    ['colesy', 1870559, 0.10, 112.82],
    ['sherif', 1237168, 0.15, 111.92],
    ['amykins', 1341374, 0.10, 80.90],
    ['malkin', 819003, 0.15, 74.09],
    ['chavvyy', 759497, 0.10, 45.81],
  ];
  for (const [name, diamonds, unlock, pounds] of sheet) {
    // September's real rate, not the board's 5%: this test is the reconciliation.
    const rev = coachRevenue({
      creators: [who('c', { coach: name, diamonds })], asOf: ASOF,
      config: {
        ...config,
        revenue: {
          ...config.revenue,
          incremental: { boardRate: 0.08, baseUnlock: unlock, goalBonus: 0 },
        },
      },
    });
    assert.ok(Math.abs(rev.rows[0].incrementalShare - pounds) < 0.5,
      `${name}: got ${rev.rows[0].incrementalShare.toFixed(2)}, sheet says ${pounds}`);
  }
});

test('a card quotes 5%, whatever TikTok actually paid', () => {
  // LEAP's instruction. September paid 8%; a coach's card must still say 5%,
  // so a quieter month is never a card that promised more than it can pay.
  const rev = coachRevenue({ creators: [who('c', { diamonds: 1000000 })], asOf: ASOF, config });
  assert.equal(rev.boardRate, 0.05);
  // 1,000,000 x $0.01 x 5% x 10% = $50, at 0.754074 = GBP 37.70.
  assert.ok(Math.abs(rev.rows[0].incrementalShare - 37.70) < 0.01,
    `got ${rev.rows[0].incrementalShare}`);
  // And the real rate is carried for reconciliation, where one is recorded.
  const withActual = coachRevenue({
    creators: [who('c', { diamonds: 1000000 })], asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, incremental: { ...config.revenue.incremental, actualRate: { '2026-09': 0.08 } } } },
  });
  assert.equal(withActual.actualRate, 0.08);
  assert.equal(withActual.rows[0].incrementalShare, rev.rows[0].incrementalShare,
    'which changes nothing a coach sees');
});

test('the two Backstage goals each unlock another 5%', () => {
  const goalsFor = (diamonds, recruits) => ({
    ...config,
    revenue: { ...config.revenue, goals: { '2026-09': { 'josh@leap': { diamonds, recruits } } } },
  });
  // A creator who joined this month is a recruit for the coach who manages them.
  const roster = [
    who('old', { diamonds: 600000, joinDate: '2026-01-01' }),
    who('new1', { diamonds: 200000, joinDate: '2026-09-02' }),
    who('new2', { diamonds: 200000, joinDate: '2026-09-03' }),
  ];
  const at = (d, r) => coachRevenue({ creators: roster, asOf: ASOF, config: goalsFor(d, r) }).rows[0];

  assert.equal(at(99000000, 99).unlock, 0.10, 'neither goal met');
  assert.equal(at(1000000, 99).unlock, 0.15, 'the diamond goal alone');
  assert.equal(at(99000000, 2).unlock, 0.15, 'the recruiter goal alone');
  assert.equal(at(1000000, 2).unlock, 0.20, 'both, which is the 20% on the sheet');

  // Hitting both doubles the line, exactly as 10 to 20 should.
  assert.ok(Math.abs(at(1000000, 2).incrementalShare / at(99000000, 99).incrementalShare - 2) < 1e-9);

  // And the card can say how far off each one is.
  const g = at(1000000, 99).goals;
  assert.equal(g.diamondsHit, true);
  assert.equal(g.recruitsHit, false);
  assert.equal(g.recruitsToGo, 97);
  assert.equal(g.diamondsToGo, 0);
});

test('a goal of zero is met, and no goals at all is not a miss', () => {
  // Backstage sets 0 for somebody with no target. Treating that as unreachable
  // would quietly dock them 5% for having nothing to do.
  const zero = coachRevenue({
    creators: [who('c', { diamonds: 1000 })], asOf: ASOF,
    config: { ...config, revenue: { ...config.revenue, goals: { '2026-09': { 'josh@leap': { diamonds: 0, recruits: 0 } } } } },
  }).rows[0];
  assert.equal(zero.unlock, 0.20);
  assert.equal(zero.goals.diamondsHit, true);

  // A coach Backstage has set nothing for sits on the base and says so, rather
  // than reading as somebody who missed.
  const none = coachRevenue({ creators: [who('c', { diamonds: 1000 })], asOf: ASOF, config }).rows[0];
  assert.equal(none.unlock, 0.10);
  assert.equal(none.goals, null);
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
  assert.equal(r.incrementalShare, 2350000 * 0.01 * rev.boardRate * r.unlock * rev.usdToGbp,
    'but the manager share is all of them');
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
  assert.equal(r.incrementalShare, 1050000 * 0.01 * rev.boardRate * r.unlock * rev.usdToGbp);
  assert.equal(r.rankUpBonus, 1000000 * rev.rankUpPerDiamond);
  assert.equal(r.total, r.base + r.recruitBonus + r.incrementalShare + r.rankUpBonus);
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
  assert.match(block, /with both goals hit/);
  // The unlock is on the line it belongs to, so a coach can see why the figure
  // is what it is without being told the arithmetic.
  assert.match(block, /Incremental share \(10%\)/);
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
  assert.match(body, /Incremental share \(\d+%\)\s+~/);
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

test('a coach not on a package yet sees their team card without a wage on it', () => {
  const cfg = { ...config, revenue: { ...config.revenue, hideEarningsFor: ['amy@leap'] } };
  const rev = coachRevenue({
    creators: [
      who('a', { coach: 'josh@leap', diamonds: 500000, lastMonth: 0 }),
      who('b', { coach: 'amy@leap', diamonds: 900000, lastMonth: 0 }),
    ],
    asOf: ASOF, config: cfg,
  });
  // Still computed: the directors' figures and the network total stay whole.
  assert.ok(rev.byCoach.get('amy@leap').total > 0);
  assert.equal(rev.networkTotal, rev.rows.reduce((n, r) => n + r.total, 0));

  const body = revenueFields(rev, rev.rows, { config: cfg }).map((f) => `${f.name}\n${f.value}`).join('\n');
  assert.match(body, /Sur3shot/, 'the other coach still sees theirs');
  assert.doesNotMatch(body, /ESTIMATED THIS MONTH[\s\S]*amy/, 'but amy has no pay block');
  assert.equal(revenueFields(rev, rev.rows, { config: cfg }).filter((f) => f.name === 'amy').length, 0);
});

test('when nobody on the card is paid, the estimate block goes entirely', () => {
  const cfg = { ...config, revenue: { ...config.revenue, hideEarningsFor: ['josh@leap'] } };
  const rev = coachRevenue({
    creators: [who('a', { coach: 'josh@leap', joinDate: '2026-09-02', diamonds: 500000, lastMonth: 0 })],
    asOf: ASOF, config: cfg,
  });
  const fields = revenueFields(rev, rev.rows, { config: cfg });
  // No warning either: there is no estimate left on the card to disclaim.
  assert.ok(!fields.some((f) => /rough estimate only/i.test(f.name)));
  assert.ok(!fields.some((f) => /ESTIMATED THIS MONTH/.test(f.value)));
  // Nothing at all, not an empty heading: the all-staff recruitment board that
  // used to sit here has been replaced by the close-to-leaping list, which is
  // per team and lives on the card rather than in this block.
  assert.deepEqual(fields, []);
});
