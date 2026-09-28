import test from 'node:test';
import assert from 'node:assert/strict';
import {
  graduationRate, matureRankUpRate, inactiveOperations, policyStanding,
  cohortStart, previousMonth, tierOf, creatorsToReach, monthMtd,
} from '../lib/policy.mjs';

const config = {
  ramp: { targetDiamonds: 200000 },
  policy: {
    cohortMonths: 3, graduationFloorRatio: 0.005,
    tierBands: [40000, 80000, 150000, 250000],
    rankUpBonusThreshold: 0.30, premiumInviteThreshold: 0.50,
    minNewCreatorsPerQuarter: 60, minDiamondsPerQuarter: 500000,
  },
};
const ASOF = '2026-09-20';

/** A creator with one month-end reading per month given. */
const who = (username, joinDate, months, quitOn = null) => ({
  key: username, username, joinDate, quitOn, group: 'Team Alpha', manager: 'josh@leap',
  obs: Object.entries(months).map(([m, diamonds]) => ({ date: `${m}-28`, mtd: { diamonds } })),
});

test('the cohort is the last three calendar months, not the last 90 days', () => {
  assert.equal(cohortStart('2026-09-20', 3), '2026-07-01');
  assert.equal(cohortStart('2026-01-05', 3), '2025-11-01');
  assert.equal(previousMonth('2026-01'), '2025-12');
  // A creator who joined on 2 July is still counted on 30 September — day 91.
  const late = graduationRate({
    creators: [who('julyjoiner', '2026-07-02', { '2026-09': 5000 })],
    asOf: '2026-09-30', config,
  });
  assert.equal(late.denominator, 1, 'the calendar month is the window, not a day count');
});

test('only creators past the 0.5% threshold are evaluated at all', () => {
  const creators = [
    who('graduated', '2026-08-01', { '2026-09': 250000 }),
    who('counted', '2026-08-01', { '2026-09': 1500 }),
    who('exactly_on', '2026-08-01', { '2026-09': 1000 }),
    who('too_small', '2026-08-01', { '2026-09': 900 }),
    who('nothing', '2026-08-01', { '2026-09': 0 }),
    who('too_old', '2026-05-01', { '2026-09': 250000 }),
  ];
  const g = graduationRate({ creators, asOf: ASOF, config });
  assert.equal(g.floor, 1000, '200,000 x 0.5%');
  assert.equal(g.denominator, 3, 'graduated, counted and exactly_on');
  assert.equal(g.numerator, 1);
  assert.equal(Math.round(g.rate * 1000) / 10, 33.3);
  assert.deepEqual(g.graduated.map((r) => r.username), ['graduated']);
  assert.deepEqual(g.closest.map((r) => r.username), ['counted', 'exactly_on'],
    'closest first, and only creators who are actually being counted');
});

test('a creator who quit still counts, because removing them is the abuse the rule exists to stop', () => {
  const creators = [
    who('stayed', '2026-08-01', { '2026-09': 5000 }),
    who('quit', '2026-08-01', { '2026-09': 5000 }, '2026-09-15'),
  ];
  const g = graduationRate({ creators, asOf: ASOF, config });
  assert.equal(g.denominator, 2,
    'the deck: "to prevent Creator Networks from artificially inflating the graduation rate"');
});

test('the mature rate counts who held their tier, and says how many more clear each line', () => {
  const creators = [
    // Above the threshold in August, so all four are in the denominator.
    who('rose', '2026-01-01', { '2026-08': 200000, '2026-09': 300000 }),
    who('held', '2026-01-01', { '2026-08': 260000, '2026-09': 260000 }),
    who('dropped_a_bit', '2026-01-01', { '2026-08': 260000, '2026-09': 200000 }),
    who('collapsed', '2026-01-01', { '2026-08': 260000, '2026-09': 1000 }),
    // Below the threshold in August, so out of the denominator entirely.
    who('not_mature', '2026-01-01', { '2026-08': 50000, '2026-09': 400000 }),
  ];
  const m = matureRankUpRate({ creators, asOf: ASOF, config });
  assert.equal(m.denominator, 4);
  assert.equal(m.numerator, 2, 'rose and held');
  assert.equal(m.rate, 0.5);
  assert.deepEqual(m.dropped.map((r) => r.username), ['dropped_a_bit', 'collapsed'],
    'closest to climbing back first');
  assert.equal(m.dropped[0].toHold, 50000, 'back into the 250,000 band');
});

test('a threshold is quoted in creators, because the denominator is small', () => {
  assert.equal(creatorsToReach(13, 29, 0.50), 2, '15 of 29 clears 50%');
  assert.equal(creatorsToReach(13, 29, 0.30), 0, 'already clear');
  assert.equal(creatorsToReach(0, 0, 0.5), null);
});

test('tier bands come from the deck worked example', () => {
  const b = config.policy.tierBands;
  assert.equal(tierOf(39999, b), 1);
  assert.equal(tierOf(40000, b), 2);
  assert.equal(tierOf(80000, b), 3);
  assert.equal(tierOf(150000, b), 4);
  assert.equal(tierOf(250000, b), 5);
});

test('the termination rule cannot fire while any one criterion is clear', () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    who(`c${i}`, '2026-08-01', { '2026-09': 20000 }));
  const big = inactiveOperations({ creators: many, asOf: ASOF, config });
  assert.equal(big.breaches.newCreators, false);
  assert.equal(big.breaches.diamonds, false);
  assert.equal(big.safe, true);

  // A network small on both counts is the one the rule is aimed at.
  const tiny = inactiveOperations({
    creators: [who('only', '2026-08-01', { '2026-09': 1000 })], asOf: ASOF, config,
  });
  assert.equal(tiny.breaches.newCreators, true);
  assert.equal(tiny.breaches.diamonds, true);
  assert.equal(tiny.safe, false);
});

test('monthMtd takes the last reading inside the month, not the first', () => {
  const c = {
    obs: [
      { date: '2026-09-05', mtd: { diamonds: 100 } },
      { date: '2026-09-20', mtd: { diamonds: 900 } },
      { date: '2026-10-02', mtd: { diamonds: 50 } },
    ],
  };
  assert.equal(monthMtd(c, '2026-09').diamonds, 900);
  assert.equal(monthMtd(c, '2026-10').diamonds, 50);
  assert.equal(monthMtd(c, '2026-08'), null);
});

test('the standing reports both lines and what each one needs', () => {
  const creators = [
    who('a', '2026-08-01', { '2026-08': 260000, '2026-09': 300000 }),
    who('b', '2026-08-01', { '2026-08': 260000, '2026-09': 1000 }),
  ];
  const p = policyStanding({ creators, asOf: ASOF, config });
  assert.equal(p.mature.rate, 0.5);
  assert.equal(p.mature.clearsBonus, true);
  assert.equal(p.mature.clearsInvite, true);
  assert.equal(p.mature.toInvite, 0);
});
