import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshot } from '../lib/store.mjs';

/** A snapshot with the named creators active, and the named ones in the quit list. */
const snap = (asOf, active, quit = []) => ({
  asOf,
  periodStart: `${asOf.slice(0, 7)}-01`,
  active: active.map((u) => ({
    creatorId: `id-${u}`, username: u, group: 'Team Hotel', manager: 'malkin@leap',
    joinDate: '2026-04-18', daysSinceJoining: 1,
    periodStart: `${asOf.slice(0, 7)}-01`, asOf,
    mtd: { diamonds: 1000, liveHours: 5, validLiveDays: 2, liveStreams: 2, newFollowers: 10, newFans: 1,
      fanClubDiamonds: 900, matches: 0, diamondsFromMatches: 0, diamondsFromMultiGuest: 0 },
    level: { totalFans: 100, activeFanClubFans: 10, fanContribution: 0.9 },
    lastMonth: { diamonds: 0, liveHours: 0, validLiveDays: 0, newFollowers: 0 },
    quit: false, graduationStatus: null, tierStatus: null, isNewLiveCreator: false,
  })),
  quit: quit.map((u) => ({ username: u })),
});

const build = (snaps, opts) => {
  const series = { updatedAt: null, lastAsOf: null, creators: {} };
  for (const s of snaps) applySnapshot(series, s, opts);
  return series;
};
const find = (series, u) => Object.values(series.creators).find((c) => c.username === u);

test('a creator who stops appearing is treated as gone, dated to when we last saw them', () => {
  // The real case: pinkiedelight94 was on Team Hotel's summary three days after
  // their last reading, with September's diamonds beside their name, because
  // nothing here noticed they had dropped out of the export.
  const series = build([
    snap('2026-09-29', ['stays', 'leaves']),
    snap('2026-09-30', ['stays', 'leaves']),
    snap('2026-10-01', ['stays']),
    snap('2026-10-02', ['stays']),
  ]);
  const gone = find(series, 'leaves');
  assert.equal(gone.quitOn, '2026-09-30', 'dated to the last day we saw them, not to today');
  assert.equal(gone.quitSource, 'absent');
  assert.equal(find(series, 'stays').quitOn, null);
});

test('one missing export is tolerated; two in a row is not', () => {
  const after1 = build([snap('2026-10-01', ['a', 'b']), snap('2026-10-02', ['a'])]);
  assert.equal(find(after1, 'b').quitOn, null, 'one miss could be a glitchy export');

  const after2 = build([snap('2026-10-01', ['a', 'b']), snap('2026-10-02', ['a']), snap('2026-10-03', ['a'])]);
  assert.equal(find(after2, 'b').quitOn, '2026-10-01');
});

test('coming back clears it, and the counter resets', () => {
  const series = build([
    snap('2026-10-01', ['a', 'b']),
    snap('2026-10-02', ['a']),
    snap('2026-10-03', ['a']),          // b is now marked gone
    snap('2026-10-04', ['a', 'b']),     // and then turns up again
  ]);
  const b = find(series, 'b');
  assert.equal(b.quitOn, null, 'back on the books');
  assert.equal(b.quitSource, null);
  assert.equal(b.missedSnapshots, 0);
});

test('TikTok saying they quit is recorded as that, not as an absence', () => {
  const series = build([
    snap('2026-09-29', ['a', 'b']),
    snap('2026-09-30', ['a'], ['b']),
  ]);
  const b = find(series, 'b');
  assert.equal(b.quitOn, '2026-09-30');
  assert.equal(b.quitSource, 'export', 'the export told us, so say so');
});

test('re-ingesting an older export does not wipe the roster', () => {
  // Everybody is absent from a back-dated snapshot. Counting that as a miss
  // would mark the entire current network as gone on one careless upload.
  const series = build([
    snap('2026-10-01', ['a', 'b', 'c']),
    snap('2026-10-02', ['a', 'b', 'c']),
  ]);
  // Two of them, so the counter would cross the bar if they were counted at all.
  applySnapshot(series, snap('2026-08-30', ['a']), { goneAfter: 2 });
  applySnapshot(series, snap('2026-08-31', ['a']), { goneAfter: 2 });
  for (const u of ['a', 'b', 'c']) assert.equal(find(series, u).quitOn, null, `${u} is still here`);
  assert.equal(find(series, 'b').missedSnapshots, 0, 'and nothing was counted against them');
  assert.equal(series.lastAsOf, '2026-10-02', 'the back-dated file did not move the clock');
});

test('how long to wait is LEAP\'s to set', () => {
  const snaps = [snap('2026-10-01', ['a', 'b']), snap('2026-10-02', ['a']), snap('2026-10-03', ['a'])];
  assert.equal(find(build(snaps, { goneAfter: 1 }), 'b').quitOn, '2026-10-01', 'strict: one miss is enough');
  assert.equal(find(build(snaps, { goneAfter: 5 }), 'b').quitOn, null, 'patient: still waiting');
});

test('being gone is the same question every board already asks', async () => {
  // The point of setting quitOn rather than inventing a second flag: twenty-six
  // places filter on it, and a second way of being gone is a second thing for
  // them to drift apart on.
  const { hardestWorkerBoard } = await import('../lib/hardestworker.mjs');
  const { creatorWeekBoard } = await import('../lib/creatorweek.mjs');
  const series = build([
    snap('2026-10-01', ['here', 'left']),
    snap('2026-10-02', ['here']),
    snap('2026-10-03', ['here']),
  ]);
  const creators = Object.values(series.creators);
  const config = { monitoring: { ignoreGroups: [] }, coaches: { names: {} }, hardestWorker: {}, creatorWeek: {} };
  assert.deepEqual(
    hardestWorkerBoard({ creators, asOf: '2026-10-03', config }).rows.map((r) => r.username), ['here']);
  assert.deepEqual(
    creatorWeekBoard({ creators, asOf: '2026-10-03', config }).rows.map((r) => r.username), ['here']);
});
