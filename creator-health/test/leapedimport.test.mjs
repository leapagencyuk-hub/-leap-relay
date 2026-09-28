import test from 'node:test';
import assert from 'node:assert/strict';
import { importManualLeaps, importSummary } from '../lib/leapedimport.mjs';

const creators = [
  { key: 'id:1', creatorId: '1', username: 'alreadypaid', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:2', creatorId: '2', username: 'newmark', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:3', creatorId: '3', username: 'genuinelynew', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:4', creatorId: '4', username: 'Renamed', group: 'Team Alpha', manager: 'josh@leap' },
];
const storeWith = (leaped) => ({ data: { leaped } });

test('a creator we billed but LEAP had already paid is corrected, not left', () => {
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
    'id:3': { creatorKey: 'id:3', username: 'genuinelynew', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });
  const out = importManualLeaps({
    marks: [{ username: 'alreadypaid', creatorId: '1' }],
    creators, store, exportedAt: '2026-09-28',
  });

  assert.equal(out.corrected.length, 1);
  const fixed = store.data.leaped['id:1'];
  assert.equal(fixed.credited, false, 'no longer bills');
  assert.equal(fixed.carriedOver, true);
  assert.equal(fixed.fee, 0);
  assert.equal(fixed.month, null, 'and belongs to no month, so no payroll claims it');
  assert.deepEqual(fixed.wasCredited, { month: '2026-09', fee: 10 });
  assert.equal(fixed.source, 'manual');

  // The one LEAP did NOT mark is untouched: that is a real leap we found.
  assert.deepEqual(store.data.leaped['id:3'], {
    creatorKey: 'id:3', username: 'genuinelynew', credited: true, carriedOver: false, month: '2026-09', fee: 10,
  });
});

test('a marked creator with no record goes on the books worth nothing', () => {
  const store = storeWith({});
  importManualLeaps({ marks: [{ username: 'newmark', creatorId: '2' }], creators, store, exportedAt: '2026-09-28' });
  const r = store.data.leaped['id:2'];
  assert.equal(r.carriedOver, true);
  assert.equal(r.fee, 0);
  assert.equal(r.month, null);
  assert.equal(r.on, '2026-09-28', 'dated to the export, because nobody can say when they crossed');
  assert.equal(r.credited, false);
});

test('running it twice changes nothing the second time', () => {
  const store = storeWith({});
  const marks = [{ username: 'newmark', creatorId: '2' }];
  importManualLeaps({ marks, creators, store, exportedAt: '2026-09-28' });
  const after = JSON.stringify(store.data.leaped);
  const second = importManualLeaps({ marks, creators, store, exportedAt: '2026-09-29' });
  assert.equal(JSON.stringify(store.data.leaped), after, 'byte for byte');
  assert.equal(second.added.length, 0);
  assert.equal(second.corrected.length, 0);
  assert.deepEqual(second.already, ['newmark']);
});

test('a dry run reports the bill it would correct without writing it', () => {
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });
  const before = JSON.stringify(store.data.leaped);
  const out = importManualLeaps({
    marks: [{ username: 'alreadypaid', creatorId: '1' }, { username: 'newmark', creatorId: '2' }],
    creators, store, exportedAt: '2026-09-28', persist: false,
  });
  assert.equal(JSON.stringify(store.data.leaped), before, 'nothing written');
  assert.equal(out.corrected.length, 1, 'but the correction is still reported');
  assert.equal(out.added.length, 1);
  assert.match(importSummary(out), /1 carried over, 1 corrected off this month's bill/);
});

test('matching survives a rename, and says who it could not place', () => {
  const store = storeWith({});
  const out = importManualLeaps({
    marks: [
      // Same creator, old username: the id is what makes this work.
      { username: 'old_name', creatorId: '4' },
      { username: 'hasleftthenetwork', creatorId: '999' },
    ],
    creators, store, exportedAt: '2026-09-28',
  });
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0].username, 'Renamed', 'matched by id, stored under the current name');
  assert.deepEqual(out.unmatched, ['hasleftthenetwork']);
});

test('a mark with no id still matches on the name, ignoring case', () => {
  const store = storeWith({});
  const out = importManualLeaps({
    marks: [{ username: 'RENAMED', creatorId: null }], creators, store, exportedAt: '2026-09-28',
  });
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0].creatorKey, 'id:4');
});

test('a Manage creators export is told apart from the daily one', async () => {
  const { isManageExport } = await import('../lib/leapedimport.mjs');
  const U = '/root/.claude/uploads/3378091d-2cac-5574-a51b-2f4baa3af4e6/';
  const fs = await import('node:fs');
  const manage = `${U}4d8e4ce3-Manage_creators_2026_09_28_15_07_UTC0.xlsx`;
  const daily = `${U}b5d60edf-Creator_data_2026_09_21_08_18_UTC0.xlsx`;
  // Skipped where the fixtures are not present, so the suite still runs alone.
  if (!fs.existsSync(manage) || !fs.existsSync(daily)) return;
  assert.equal(isManageExport(manage), true);
  assert.equal(isManageExport(daily), false, 'the daily export must not be read as leap marks');
  assert.equal(isManageExport('/nope/missing.xlsx'), false);
});

test('the correction happens once, and never eats a credit we earned later', () => {
  // The bug this covers: LEAP keeps marking creators by hand as they leap.
  // Without this, every later upload of the management export would quietly
  // delete a real £10 for every creator we had legitimately billed.
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });

  // First import: backfills, and corrects what we billed in ignorance.
  const first = importManualLeaps({
    marks: [{ username: 'alreadypaid', creatorId: '1' }], creators, store, exportedAt: '2026-09-28',
  });
  assert.equal(first.firstImport, true);
  assert.equal(first.corrected.length, 1);
  assert.equal(store.data.leapedImportedOn, '2026-09-28', 'and remembers that it ran');

  // Now we watch somebody cross the bar ourselves and bill for it.
  store.data.leaped['id:3'] = {
    creatorKey: 'id:3', username: 'genuinelynew', credited: true, carriedOver: false, month: '2026-10', fee: 10,
  };

  // LEAP marks them too, as they would. That is agreement, not a correction.
  const second = importManualLeaps({
    marks: [{ username: 'genuinelynew', creatorId: '3' }], creators, store, exportedAt: '2026-10-31',
  });
  assert.equal(second.firstImport, false);
  assert.equal(second.corrected.length, 0, 'nothing corrected on a later import');
  assert.deepEqual(second.kept, ['genuinelynew']);
  assert.equal(store.data.leaped['id:3'].credited, true, 'the credit stands');
  assert.equal(store.data.leaped['id:3'].fee, 10);
});

test('a later import still picks up creators we have never seen leap', () => {
  const store = storeWith({});
  store.data.leapedImportedOn = '2026-09-28';
  const out = importManualLeaps({
    marks: [{ username: 'newmark', creatorId: '2' }], creators, store, exportedAt: '2026-10-31',
  });
  assert.equal(out.firstImport, false);
  assert.equal(out.added.length, 1, 'a top-up still works');
  assert.equal(store.data.leaped['id:2'].fee, 0);
});
