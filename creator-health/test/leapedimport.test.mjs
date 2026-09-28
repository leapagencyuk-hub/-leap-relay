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
