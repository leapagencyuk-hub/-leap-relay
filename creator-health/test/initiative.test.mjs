import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { accruedBetween, firstLiveDate, assess, newCreatorZone, RULES } from '../lib/initiative.mjs';
import { buildPortal } from '../lib/portal.mjs';
import { directorPage, coachPage } from '../lib/portalhtml.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(`${d}T00:00:00Z`) + n * 86400000);

/**
 * A creator with one observation per day from `join`, each carrying the
 * month-to-date counters as the export would. `perDay` may be a function of
 * the day index so a creator can go LIVE on some days and not others.
 */
const creator = (username, { join, days, diamondsPerDay = 0, liveOn = () => true, over = {} } = {}) => {
  const obs = [];
  let month = join.slice(0, 7);
  let dia = 0; let live = 0; let hours = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(join, i);
    if (date.slice(0, 7) !== month) { month = date.slice(0, 7); dia = 0; live = 0; hours = 0; }
    const went = liveOn(i);
    if (went) { live += 1; hours += 2; dia += typeof diamondsPerDay === 'function' ? diamondsPerDay(i) : diamondsPerDay; }
    obs.push({ date, periodStart: `${month}-01`, mtd: { diamonds: dia, liveHours: hours, validLiveDays: live } });
  }
  return { key: `id:${username}`, username, manager: 'josh@leap.com', group: 'Team Alpha',
    joinDate: join, quitOn: null, obs, levels: {}, ...over };
};

test('a counter accrues across a month boundary instead of resetting with it', () => {
  // Joined on the 20th, so the window straddles the 1st and the export's
  // counters start again underneath it.
  const c = creator('straddle', { join: '2026-09-20', days: 30, diamondsPerDay: 100 });
  assert.equal(accruedBetween(c, '2026-09-20', '2026-09-30', 'diamonds'), 1100, '11 days in September');
  assert.equal(accruedBetween(c, '2026-09-20', '2026-10-19', 'diamonds'), 3000, 'the whole 30-day window');
  assert.equal(accruedBetween(c, '2026-09-20', '2026-10-19', 'validLiveDays'), 30);
  // And a window opening mid-month does not count what they did before it.
  assert.equal(accruedBetween(c, '2026-09-25', '2026-09-30', 'diamonds'), 600);
});

test('a creator who does everything passes all three', () => {
  const c = creator('good', { join: '2026-09-20', days: 37, diamondsPerDay: 400 });
  const a = assess(c, '2026-10-26', { config, watchFrom: '2026-08-31' });
  assert.equal(a.status, 'passed');
  assert.equal(a.graduated, true);
  assert.ok(a.reqs.every((r) => r.state === 'passed'));
  assert.equal(firstLiveDate(c, '2026-09-20', '2026-10-26'), '2026-09-20');
});

test('passing 10,000 diamonds ends the 90 days there and then', () => {
  // Hard first week, then stops entirely. They never reach 10 LIVE days, and
  // under the policy that no longer matters: the 10-day rule stops applying.
  const c = creator('sprinter', {
    join: '2026-10-01', days: 26, diamondsPerDay: 2000, liveOn: (i) => i < 6,
  });
  const a = assess(c, '2026-10-26', { config, watchFrom: '2026-08-31' });
  assert.equal(a.graduated, true);
  assert.equal(a.status, 'passed');
  assert.equal(a.graduatedOn, '2026-10-05', 'the day the running total crossed');
  const liveDays = a.reqs.find((r) => r.key === 'liveDays');
  assert.equal(liveDays.done, 6, 'they really did only manage six');
  assert.equal(liveDays.state, 'passed', 'and it is cleared anyway, because they graduated');
});

test('a creator who never went LIVE fails the 7-day rule once it is behind them', () => {
  const c = creator('nostart', { join: '2026-10-01', days: 26, liveOn: () => false });
  const a = assess(c, '2026-10-26', { config, watchFrom: '2026-08-31' });
  const first = a.reqs.find((r) => r.key === 'firstLive');
  assert.equal(first.state, 'failed');
  assert.equal(a.status, 'failed');
  assert.equal(a.firstLive, null);
});

test('running out of days is called before the deadline, not after', () => {
  // Day 26 of 30, LIVE twice. Eight more days needed, four left. It is over,
  // and the owner should be told now rather than in a post-mortem.
  const c = creator('doomed', { join: '2026-10-01', days: 26, diamondsPerDay: 50, liveOn: (i) => i < 2 });
  const a = assess(c, '2026-10-26', { config, watchFrom: '2026-08-31' });
  const q = a.reqs.find((r) => r.key === 'liveDays');
  assert.equal(q.state, 'pending', 'the deadline has not actually passed');
  assert.equal(q.impossible, true);
  assert.equal(q.stillNeeded, 8);
  assert.equal(a.status, 'failing');
});

test('a deadline inside a week reads as at risk', () => {
  // Day 25 of 30 with 7 LIVE days. Three more needed, five days left: tight,
  // still possible, and worth a message today rather than on the deadline.
  const c = creator('tight', { join: '2026-10-01', days: 26, diamondsPerDay: 100, liveOn: (i) => i % 4 === 0 });
  const a = assess(c, '2026-10-26', { config, watchFrom: '2026-08-31' });
  const q = a.reqs.find((r) => r.key === 'liveDays');
  assert.equal(q.done, 7);
  assert.equal(q.stillNeeded, 3);
  assert.equal(q.impossible, false, 'three days in five is tight, not lost');
  assert.equal(a.soonestDeadline, 5);
  assert.equal(a.status, 'at risk');
});

test('nobody is failed on history the system never had', () => {
  // Joined in July, but the first observation we hold is 31 August. Their
  // first 7 and first 30 days are unrecoverable, so neither can be judged.
  // Observations begin on 31 August whatever the join date says, which is
  // exactly the shape of a creator who signed before this system existed.
  const blind = (username, { perDay = 0, live = false } = {}) => {
    const c = creator(username, { join: '2026-09-01', days: 40, diamondsPerDay: perDay, liveOn: () => live });
    c.joinDate = '2026-07-10';
    return c;
  };

  // The windows nobody watched are reported as unknown, never as failed. This
  // is the guarantee the whole section rests on: a creator comes off the
  // network over this, and not on evidence we do not hold.
  const broke = blind('older');
  const a = assess(broke, '2026-10-26', { config, watchFrom: '2026-08-31' });
  assert.equal(a.blind, true);
  assert.equal(a.reqs.find((r) => r.key === 'firstLive').state, 'unknown');
  assert.equal(a.reqs.find((r) => r.key === 'liveDays').state, 'unknown');

  // The 90-day diamond rule is a running total, so it survives the blind spot
  // and is still a real test. This creator fails on that alone, which is
  // correct: it is the one requirement we can actually stand behind.
  assert.equal(a.reqs.find((r) => r.key === 'diamonds').state, 'failed');
  assert.equal(a.status, 'failed');
  assert.deepEqual(a.reqs.filter((r) => r.state === 'failed').map((r) => r.key), ['diamonds'],
    'failed on a window nobody watched');

  // And a blind creator who cleared the diamonds is not failed at all, even
  // though we never saw whether they went LIVE in their first week.
  const earned = assess(blind('olderbutpaid', { perDay: 400, live: true }), '2026-10-26',
    { config, watchFrom: '2026-08-31' });
  assert.equal(earned.graduated, true);
  assert.equal(earned.status, 'passed');
  assert.equal(earned.reqs.filter((r) => r.state === 'failed').length, 0);
});

test('the zone holds recent joiners only, worst first, with passers set aside', () => {
  const rows = [
    creator('failing', { join: '2026-10-01', days: 26, liveOn: () => false }),
    creator('fine', { join: '2026-10-10', days: 17, diamondsPerDay: 900 }),
    creator('ancient', { join: '2026-05-01', days: 200, diamondsPerDay: 500 }),
  ];
  const zone = newCreatorZone({ creators: rows, asOf: '2026-10-26', config });
  assert.deepEqual(zone.rows.map((r) => r.username), ['failing', 'fine'], 'the old creator is out of the window');
  assert.equal(zone.summary.failed, 1);
  assert.equal(zone.summary.passed, 1);
  assert.deepEqual(zone.passed.map((r) => r.username), ['fine']);
  assert.equal(zone.rows[0].username, 'failing', 'worst first');
});

test('a creator who left is not chased for a rule they are no longer under', () => {
  const gone = creator('quit', { join: '2026-10-01', days: 26, liveOn: () => false });
  gone.quitOn = '2026-10-15';
  assert.equal(newCreatorZone({ creators: [gone], asOf: '2026-10-26', config }).rows.length, 0);
});

test('the zone is on the owner page and on no coach page', () => {
  const rows = [creator('newbie', { join: '2026-10-01', days: 26, liveOn: () => false })];
  const portal = buildPortal({
    result: { creators: rows, metricsByKey: new Map(), alerts: [], ramp: [], activation: [], asOf: '2026-10-26' },
    config,
  });
  const owner = directorPage(portal, [], {});
  assert.ok(owner.includes('New creator zone'));
  assert.ok(owner.includes('@newbie'));

  // Removing somebody from the network is not a coach's call, so the section
  // exists on exactly one page.
  for (const [who, view] of portal.byCoach) {
    assert.equal(coachPage(view, { config }).includes('New creator zone'), false, `${who} can see the zone`);
  }
});

test('starting late and never starting are not called the same thing', () => {
  // Two different failures with two different conversations behind them, and
  // a card that labelled both "never went LIVE" would send a coach after the
  // wrong one.
  const rows = [
    creator('never', { join: '2026-10-01', days: 26, liveOn: () => false }),
    creator('late', { join: '2026-10-01', days: 26, diamondsPerDay: 200, liveOn: (i) => i >= 9 }),
  ];
  const portal = buildPortal({
    result: { creators: rows, metricsByKey: new Map(), alerts: [], ramp: [], activation: [], asOf: '2026-10-26' },
    config,
  });
  const page = directorPage(portal, [], {});
  assert.ok(page.includes('never went LIVE'));
  assert.ok(page.includes('day 10, too late'), 'a late starter is reported as late, not as absent');

  // Counted the way a person counts: going LIVE the day you join is day one.
  const sameDay = assess(creator('sameday', { join: '2026-10-01', days: 26, diamondsPerDay: 100 }),
    '2026-10-26', { config, watchFrom: '2026-08-31' });
  assert.equal(sameDay.firstLive, '2026-10-01');
  assert.ok(directorPage(buildPortal({
    result: { creators: [creator('sameday', { join: '2026-10-01', days: 26, diamondsPerDay: 100 })],
      metricsByKey: new Map(), alerts: [], ramp: [], activation: [], asOf: '2026-10-26' },
    config,
  }), [], {}).includes('day 1'));
});

test('a cleared count stops at the bar instead of reading as a broken fraction', () => {
  // 15 LIVE days against a bar of 10 is cleared, not "15 of 10".
  const c = creator('keen', { join: '2026-10-12', days: 15, diamondsPerDay: 100 });
  const portal = buildPortal({
    result: { creators: [c], metricsByKey: new Map(), alerts: [], ramp: [], activation: [], asOf: '2026-10-26' },
    config,
  });
  const page = directorPage(portal, [], {});
  assert.ok(page.includes('of 10'));
  assert.equal(page.includes('15</b> of 10'), false, 'the count ran past the bar it was measured against');
});
