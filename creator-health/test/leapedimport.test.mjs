import test from 'node:test';
import assert from 'node:assert/strict';
import { importManualLeaps, importSummary, restoreCorrectedLeaps } from '../lib/leapedimport.mjs';

const require_restore = () => ({ restoreCorrectedLeaps });

const creators = [
  { key: 'id:1', creatorId: '1', username: 'alreadypaid', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:2', creatorId: '2', username: 'newmark', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:3', creatorId: '3', username: 'genuinelynew', group: 'Team Alpha', manager: 'josh@leap' },
  { key: 'id:4', creatorId: '4', username: 'Renamed', group: 'Team Alpha', manager: 'josh@leap' },
];
const storeWith = (leaped) => ({ data: { leaped } });

test('a mark on a leap we credited confirms it, and never voids it', () => {
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
    'id:3': { creatorKey: 'id:3', username: 'genuinelynew', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });
  const out = importManualLeaps({
    marks: [{ username: 'alreadypaid', creatorId: '1' }],
    creators, store, exportedAt: '2026-09-28',
  });

  // LEAP writing LEAP against a creator and us crediting the coach are two
  // people noticing the same leap. The coach is owed once, and our record is
  // the one that knows which month.
  assert.equal(out.corrected.length, 0);
  assert.deepEqual(out.kept, ['alreadypaid']);
  const same = store.data.leaped['id:1'];
  assert.equal(same.credited, true, 'the credit stands');
  assert.equal(same.fee, 10);
  assert.equal(same.month, '2026-09');

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

test('a dry run reports what it would add without writing it', () => {
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });
  const before = JSON.stringify(store.data.leaped);
  const out = importManualLeaps({
    marks: [{ username: 'alreadypaid', creatorId: '1' }, { username: 'newmark', creatorId: '2' }],
    creators, store, exportedAt: '2026-09-28', persist: false,
  });
  assert.equal(JSON.stringify(store.data.leaped), before, 'nothing written');
  assert.equal(out.added.length, 1);
  assert.deepEqual(out.kept, ['alreadypaid']);
  assert.match(importSummary(out), /1 carried over, 1 we billed ourselves, left alone/);
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

test('no number of imports ever takes money off a month that earned it', () => {
  // LEAP keeps marking creators by hand as they leap. An earlier version read
  // that as "already paid" and zeroed the record, which took £670 off a month
  // that had earned it.
  const store = storeWith({
    'id:1': { creatorKey: 'id:1', username: 'alreadypaid', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
    'id:3': { creatorKey: 'id:3', username: 'genuinelynew', credited: true, carriedOver: false, month: '2026-10', fee: 10 },
  });
  const marks = [{ username: 'alreadypaid', creatorId: '1' }, { username: 'genuinelynew', creatorId: '3' }];
  for (const on of ['2026-09-28', '2026-10-31', '2026-11-30']) {
    const out = importManualLeaps({ marks, creators, store, exportedAt: on });
    assert.equal(out.corrected.length, 0, `nothing voided on the ${on} import`);
  }
  const owed = Object.values(store.data.leaped).filter((r) => r.credited).reduce((n, r) => n + r.fee, 0);
  assert.equal(owed, 20, 'both credits still stand after three imports');
});

test('restoring puts back exactly what the old correction took, month and fee', () => {
  const { restoreCorrectedLeaps } = require_restore();
  const store = storeWith({
    'id:1': {
      creatorKey: 'id:1', username: 'was_zeroed', credited: false, carriedOver: true,
      month: null, fee: 0, source: 'manual', correctedOn: '2026-09-28',
      wasCredited: { month: '2026-09', fee: 10 },
    },
    'id:2': { creatorKey: 'id:2', username: 'untouched', credited: true, carriedOver: false, month: '2026-09', fee: 10 },
  });
  const out = restoreCorrectedLeaps(store);
  assert.equal(out.restored.length, 1, 'only the one that was corrected');
  assert.equal(out.value, 10);
  const back = store.data.leaped['id:1'];
  assert.equal(back.credited, true);
  assert.equal(back.month, '2026-09');
  assert.equal(back.fee, 10);
  assert.equal(back.wasCredited, undefined, 'and stops looking corrected');
  assert.equal(back.source, 'manual-confirmed');
  // Running it again finds nothing, and the untouched record never moved.
  assert.equal(restoreCorrectedLeaps(store).restored.length, 0);
  assert.equal(store.data.leaped['id:2'].fee, 10);
});
