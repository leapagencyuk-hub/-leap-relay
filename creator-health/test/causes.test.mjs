import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCauses, CAUSES, KIND } from '../lib/causes.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
import { applySnapshot } from '../lib/store.mjs';
import { evaluateDecline } from '../lib/rules.mjs';

// Metrics shaped like the real thing, with knobs for each cause's signature.
function m({
  diamonds7 = 10000, diamondsPrev7 = 10000, hours7 = 20, hoursPrev7 = 20,
  liveDays7 = 5, liveDaysPrev7 = 5, followers7 = 500, followersPrev7 = 500,
  fanClubNow = 40, fanClubChange14 = 0, fanClubSpendChange = 0,
  darkStreak = 0, baselineDiamonds = 10000, baselineHours = 20, baselineDays = 5,
  matches28 = 3, lastMatch = { days: 2, earliestDays: 2, exact: true, on: '2026-09-18' },
  matchShare28 = 0.05, daysSinceJoining = 400, perHour28 = 500,
  totalFansChange14 = 0.05, contribution = 0.5,
} = {}) {
  const chg = (a, b) => (b === 0 ? (a > 0 ? null : 0) : (a - b) / b);
  return {
    curr7: { diamonds: diamonds7, liveHours: hours7, validLiveDays: liveDays7, newFollowers: followers7, fanClubDiamonds: diamonds7 * 0.8, matches: matches28 / 4 },
    prev7: { diamonds: diamondsPrev7, liveHours: hoursPrev7, validLiveDays: liveDaysPrev7, newFollowers: followersPrev7, fanClubDiamonds: diamondsPrev7 * 0.8 },
    curr28: { diamonds: diamonds7 * 4, liveHours: hours7 * 4, matches: matches28 },
    change7: {
      diamonds: chg(diamonds7, diamondsPrev7), liveHours: chg(hours7, hoursPrev7),
      newFollowers: chg(followers7, followersPrev7),
    },
    profile: {
      diamonds: { baseline: baselineDiamonds }, liveHours: { baseline: baselineHours },
      validLiveDays: { baseline: baselineDays },
    },
    darkStreak,
    diamondsPerHour28: perHour28,
    diamondsPerHour7: hours7 > 0 ? diamonds7 / hours7 : null,
    fanClub: {
      activeFans: fanClubNow, activeFansChange14: fanClubChange14, activeFansChange7: fanClubChange14,
      diamondsChange7: fanClubSpendChange, totalFansChange14, contribution,
    },
    matches28, matches7: 0, matchShare28, lastMatch, daysSinceJoining,
  };
}
const ids = (metrics) => rankCauses(metrics).map((c) => c.id);

test('every cause is well formed and says what to ask', () => {
  for (const c of CAUSES) {
    assert.ok(c.id && c.label, `${c.id} has an identity`);
    assert.ok([KIND.CAUSE, KIND.LEVER].includes(c.kind), `${c.id} is a cause or a lever`);
    assert.ok(Array.isArray(c.ask) && c.ask.length, `${c.id} supplies questions`);
    assert.ok(Array.isArray(c.check) && c.check.length, `${c.id} says what to check first`);
    assert.equal(typeof c.detect, 'function');
  }
});

test('fewer hours is recognised from attendance, not earnings', () => {
  assert.ok(ids(m({ hours7: 8, hoursPrev7: 20, liveDays7: 2, liveDaysPrev7: 5 })).includes('FEWER_HOURS'));
});

test('losing gifters and gifters running out of money are told apart', () => {
  // The people left: membership collapsed.
  const lost = ids(m({ fanClubNow: 20, fanClubChange14: -0.5, fanClubSpendChange: -0.5 }));
  assert.ok(lost.includes('LOST_GIFTERS'));
  assert.ok(!lost.includes('GIFTERS_TAPPED_OUT'));

  // Same people, smaller gifts: membership flat, spending down.
  const tapped = ids(m({ fanClubNow: 40, fanClubChange14: 0, fanClubSpendChange: -0.5 }));
  assert.ok(tapped.includes('GIFTERS_TAPPED_OUT'));
  assert.ok(!tapped.includes('LOST_GIFTERS'));
});

test('no goals is only raised when the hours held up', () => {
  // Conversion halved, hours unchanged: the time is there, the asks are not.
  assert.ok(ids(m({ diamonds7: 5000, diamondsPrev7: 10000, baselineDiamonds: 10000, hours7: 20, hoursPrev7: 20 }))
    .includes('NO_GOALS'));
  // Conversion down because they barely streamed: that is an hours problem.
  assert.ok(!ids(m({ diamonds7: 2000, hours7: 4, hoursPrev7: 20, baselineHours: 20 }))
    .includes('NO_GOALS'));
});

test('never having campaigned is a lever, not a cause of a drop', () => {
  const never = rankCauses(m({ matches28: 0, lastMatch: null, matchShare28: 0, hours7: 10 }));
  const entry = never.find((c) => c.id === 'NEVER_CAMPAIGNS');
  assert.ok(entry, 'raised');
  assert.equal(entry.kind, KIND.LEVER, 'as an opportunity, since nothing changed');
  assert.ok(!never.some((c) => c.id === 'STOPPED_CAMPAIGNS'));
});

test('having campaigned and stopped is a cause', () => {
  const stopped = rankCauses(m({ matches28: 0, matches7: 0, matchShare28: 0.3, lastMatch: { days: 30, earliestDays: 30, exact: true, on: '2026-08-21' } }));
  const entry = stopped.find((c) => c.id === 'STOPPED_CAMPAIGNS');
  assert.ok(entry);
  assert.equal(entry.kind, KIND.CAUSE);
  assert.equal(entry.confidence, 'likely');
});

test('drama is only raised when the hours held — otherwise the hours are the story', () => {
  const collapsedButStreaming = ids(m({
    diamonds7: 2000, diamondsPrev7: 10000, followers7: 50, followersPrev7: 500,
    hours7: 20, hoursPrev7: 20,
  }));
  assert.ok(collapsedButStreaming.includes('DRAMA'));

  const stoppedStreaming = ids(m({
    diamonds7: 2000, diamondsPrev7: 10000, followers7: 50, followersPrev7: 500,
    hours7: 4, hoursPrev7: 20,
  }));
  assert.ok(!stoppedStreaming.includes('DRAMA'), 'the hours explain it');
});

test('a clean stop after a reliable run reads as a possible break', () => {
  const away = rankCauses(m({ darkStreak: 5, baselineDays: 5, hours7: 0, hoursPrev7: 20, liveDays7: 0 }));
  const holiday = away.find((c) => c.id === 'HOLIDAY');
  assert.ok(holiday);
  assert.ok(holiday.resolution.includes('snooze'), 'says what to do if they are away');
});

test('there is always something to ask, even when nothing is detectable', () => {
  const quiet = rankCauses(m({}));
  assert.ok(quiet.length >= 1);
  assert.ok(quiet[0].ask.length, 'the fallback still gives the coach questions');
});

test('confidence never overstates what the data can see', () => {
  // The algorithm gap is a hypothesis about a newer creator, never a finding.
  const gap = rankCauses(m({ daysSinceJoining: 60, perHour28: 300, hours7: 10 }))
    .find((c) => c.id === 'ALGORITHM_GAP');
  assert.ok(gap);
  assert.notEqual(gap.confidence, 'likely');
});

test('a broken metric in one cause does not take the whole ranking down', () => {
  const broken = { curr7: {}, prev7: {}, curr28: {}, change7: {}, profile: {}, fanClub: {} };
  const out = rankCauses(broken);
  assert.ok(Array.isArray(out) && out.length, 'still returns something usable');
});

// --- the coarse-data gate ----------------------------------------------------

function snap(asOf, periodStart, mtd) {
  return {
    asOf, periodStart, quit: [], skipped: 0,
    active: [{
      creatorId: '1', username: 'x', periodStart, asOf, group: 'A', manager: 'coach@leap',
      joinDate: '2026-01-01', daysSinceJoining: 260,
      mtd: { diamonds: 0, liveHours: 0, validLiveDays: 0, liveStreams: 0, newFollowers: 0,
        newFans: 0, fanClubDiamonds: 0, matches: 0, diamondsFromMatches: 0, diamondsFromMultiGuest: 0, ...mtd },
      level: { totalFans: 100, activeFanClubFans: 10, fanContribution: 0.9 },
      lastMonth: { diamonds: 100000, liveHours: 40, validLiveDays: 20 },
      quit: false, graduationStatus: null, tierStatus: null, isNewLiveCreator: false,
    }],
  };
}

test('a back-filled month is not mistaken for a week of real days', () => {
  const series = { creators: {}, lastAsOf: null };
  // One snapshot covering the whole month, then two daily ones.
  applySnapshot(series, snap('2026-09-20', '2026-09-01', { diamonds: 200000, liveHours: 60, validLiveDays: 18 }));
  applySnapshot(series, snap('2026-09-21', '2026-09-01', { diamonds: 203000, liveHours: 61, validLiveDays: 19 }));
  const c = series.creators['id:1'];
  const metrics = computeMetrics(c, '2026-09-21');

  assert.equal(metrics.exact.curr7, 1, 'only the one real daily reading counts');
  assert.equal(metrics.exact.prev7, 0);
  assert.ok(metrics.historyDays > metrics.exact.curr7, 'coverage is wider than exact coverage');
});

test('decline rules stay silent until both weeks are real', () => {
  const config = {
    tiers: { core: 100000, growing: 20000, emerging: 2000 },
    decline: {
      minHistoryDays: 10,
      eligibility: { minPrev7LiveHours: 2, minPrev28Diamonds: 2000, minActiveDays28: 4, minExactDaysPerWindow: 5 },
      byTier: { core: null, growing: null, emerging: null, dormant: null },
      fanClub: { activeFansDrop: 0.2, activeFansFloor: 5, diamondsDrop: 0.3, concentrationRisk: 0.85 },
      efficiencyDrop: 0.3, cooldownDays: 5, recoveryThreshold: 0.9, volatilityMultiple: 1.4,
    },
  };
  const series = { creators: {}, lastAsOf: null };
  applySnapshot(series, snap('2026-09-20', '2026-09-01', { diamonds: 200000, liveHours: 60, validLiveDays: 18 }));
  applySnapshot(series, snap('2026-09-21', '2026-09-01', { diamonds: 200000, liveHours: 60, validLiveDays: 18 }));
  const creators = Object.values(series.creators);
  const metricsByKey = new Map(creators.map((c) => [c.key, computeMetrics(c, '2026-09-21')]));

  const { alerts, skipped } = evaluateDecline(creators, metricsByKey, config, { open: {} });
  assert.equal(alerts.length, 0, 'no alert from an artifact of even spreading');
  assert.ok(skipped.coarse >= 1, 'and it is reported as coarse rather than silently dropped');
});
