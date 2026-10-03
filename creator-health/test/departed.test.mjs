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
  ]);
  const gone = find(series, 'leaves');
  assert.equal(gone.quitOn, '2026-09-30', 'dated to the last day we saw them, not to today');
  assert.equal(gone.quitSource, 'absent');
  assert.equal(find(series, 'stays').quitOn, null);
});

test('waiting longer is available, and is not the default', () => {
  const snaps = [snap('2026-10-01', ['a', 'b']), snap('2026-10-02', ['a'])];
  assert.equal(find(build(snaps), 'b').quitOn, '2026-10-01', 'the first miss is enough');
  assert.equal(find(build(snaps, { goneAfter: 2 }), 'b').quitOn, null, 'unless LEAP asks to wait');
});

test('coming back clears it, and the counter resets', () => {
  const series = build([
    snap('2026-10-01', ['a', 'b']),
    snap('2026-10-02', ['a']),          // b is now marked gone
    snap('2026-10-03', ['a', 'b']),     // and then turns up again
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

test('the bad-file valve needs a roster before it means anything', () => {
  // Without a floor it fires on every small fixture and on a small network:
  // one of three leaving is 33%, which is not a truncated export.
  const series = build([snap('2026-10-01', ['a', 'b', 'c']), snap('2026-10-02', ['a', 'b'])]);
  assert.equal(find(series, 'c').quitOn, '2026-10-01', 'acted on, not written off as a bad file');
  assert.equal(series.suspectSnapshots, undefined);
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
  ]);
  const creators = Object.values(series.creators);
  const config = { monitoring: { ignoreGroups: [] }, coaches: { names: {} }, hardestWorker: {}, creatorWeek: {} };
  assert.deepEqual(
    hardestWorkerBoard({ creators, asOf: '2026-10-02', config }).rows.map((r) => r.username), ['here']);
  assert.deepEqual(
    creatorWeekBoard({ creators, asOf: '2026-10-02', config }).rows.map((r) => r.username), ['here']);
});

test('absence from the export is departure, on the first miss', () => {
  // LEAP's rule, in their words: "if not on creator data they gone".
  const series = build([snap('2026-10-01', ['a', 'b']), snap('2026-10-02', ['a'])]);
  assert.equal(find(series, 'b').quitOn, '2026-10-01');
  assert.equal(find(series, 'b').quitSource, 'absent');
});

test('a half-written export marks nobody, and says it was thin', () => {
  // The real danger of acting on the first miss. Setting quitOn also CLOSES a
  // creator's open cases as lost, and no reappearance undoes that. A truncated
  // upload must not be allowed to do it to the whole network.
  const full = Array.from({ length: 40 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  const series = build([snap('2026-10-01', full), snap('2026-10-02', full)]);
  // A file holding a quarter of the roster.
  applySnapshot(series, snap('2026-10-03', full.slice(0, 10)), { goneAfter: 1, maxGoneShare: 0.2 });

  for (const u of full) assert.equal(find(series, u).quitOn, null, `${u} survived the bad file`);
  // And nothing was counted against them either, so the next good export does
  // not immediately act on a miss this one invented.
  assert.equal(find(series, 'c39').missedSnapshots, 0);
  assert.deepEqual(series.suspectSnapshots, [{ asOf: '2026-10-03', absent: 30, live: 40, share: 0.75 }]);
});

test('a real month-end clear-out is well under the valve and still acts', () => {
  // 21 of 819 is 2.6%. The valve is at 20%, so the thing that prompted all of
  // this still goes through.
  const roster = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  const series = build([snap('2026-10-01', roster), snap('2026-10-02', roster)]);
  const left = roster.slice(0, 3);                       // 3%
  applySnapshot(series, snap('2026-10-03', roster.slice(3)), { goneAfter: 1, maxGoneShare: 0.2 });
  for (const u of left) assert.equal(find(series, u).quitOn, '2026-10-02', `${u} is gone`);
  assert.equal(series.suspectSnapshots, undefined, 'and the file was not called suspect');
});
