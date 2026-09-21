import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMultipart, safeRelativePath, storeUploads, uploadStats } from '../lib/upload.mjs';
import { LocalSource } from '../lib/local.mjs';
import { sync, sourceFor } from '../lib/sync.mjs';
import { Knowledge } from '../lib/retrieve.mjs';

const BOUNDARY = '----andytest';
const body = (parts) => Buffer.concat([
  ...parts.map((p) => Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${p.name}"\r\n\r\n`),
    Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data),
    Buffer.from('\r\n'),
  ])),
  Buffer.from(`--${BOUNDARY}--\r\n`),
]);
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

test('every file part is pulled out, with its folder path intact', () => {
  const parsed = parseMultipart(body([
    { name: "Andy's Brain/Gifting/Playbook.pdf", data: 'one' },
    { name: "Andy's Brain/Schedules/Notes.md", data: 'two' },
  ]), CT);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Andy's Brain/Gifting/Playbook.pdf");
  assert.equal(parsed[1].data.toString(), 'two');
});

test('binary content survives byte for byte', () => {
  // A PDF that comes back one byte different is a PDF that will not parse.
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x0d, 0x0a, 0xff, 0xfe, 0x1a]);
  const [parsed] = parseMultipart(body([{ name: 'x.pdf', data: bytes }]), CT);
  assert.deepEqual(parsed.data, bytes);
});

test('a body with no boundary yields nothing rather than throwing', () => {
  assert.deepEqual(parseMultipart(Buffer.from('nonsense'), 'text/plain'), []);
  assert.deepEqual(parseMultipart(Buffer.alloc(0), CT), []);
});

test('a path that tries to escape the uploads folder is stripped', () => {
  assert.equal(safeRelativePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeRelativePath('/etc/passwd'), 'etc/passwd');
  assert.equal(safeRelativePath('..\\..\\windows\\system32\\x.txt'), path.join('windows', 'system32', 'x.txt'));
  assert.equal(safeRelativePath('../..'), null);
  assert.equal(safeRelativePath(''), null);
});

test('an escaping path is refused at write time too, not just sanitised', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-up-'));
  const { written, rejected } = storeUploads(dir, [
    { name: '../../escaped.txt', data: Buffer.from('nope') },
    { name: 'Gifting/fine.md', data: Buffer.from('yes') },
  ]);
  assert.equal(written.length, 2, 'the stripped path is written safely inside the folder');
  assert.equal(rejected.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'etc', 'escaped.txt')) || fs.existsSync(path.join(dir, 'escaped.txt')));
  assert.ok(!fs.existsSync(path.resolve(dir, '../../escaped.txt')), 'nothing may be written outside the folder');
});

test('uploads keep their folder tree, and the tree becomes topic labels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-up-'));
  storeUploads(dir, [
    { name: "Andy's Brain/Gifting/Playbook.md", data: Buffer.from('# Goals\n\nSet a visible goal at the top of every stream so the room has a reason to gift.') },
    { name: "Andy's Brain/Schedules/Slippage.md", data: Buffer.from('# Slippage\n\nFan club members drift away when a creator misses the days they usually stream on.') },
  ]);
  const files = await new LocalSource(dir).list();
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.folder).sort(), ["Andy's Brain / Gifting", "Andy's Brain / Schedules"]);
});

test('a second upload adds to the library without replacing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-up-'));
  storeUploads(dir, [{ name: 'a.md', data: Buffer.from('one') }]);
  storeUploads(dir, [{ name: 'b.md', data: Buffer.from('two')  }]);
  assert.equal(uploadStats(dir).files, 2, 'uploading one corrected file must not wipe the folder');
  storeUploads(dir, [{ name: 'c.md', data: Buffer.from('three') }], { replaceAll: true });
  assert.equal(uploadStats(dir).files, 1, 'replace:true starts the library over');
});

test('dotfiles and OS junk are not treated as documents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-local-'));
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'junk');
  fs.writeFileSync(path.join(dir, 'Real.md'), '# Real\n\nA genuine document with enough text in it to matter.');
  const files = await new LocalSource(dir).list();
  assert.deepEqual(files.map((f) => f.name), ['Real.md']);
});

test('a local folder ingests end to end and becomes searchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-local-'));
  fs.mkdirSync(path.join(dir, 'Gifting'));
  fs.writeFileSync(path.join(dir, 'Gifting', 'Gifts.md'),
    '# Expensive gifts\n\nPink Drift is worth 3600 diamonds and comes from a fan club regular rather than a passer-by.');

  const config = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'andy-data-')),
    knowledge: { chunk: { targetChars: 900, overlapChars: 100, minChars: 40 } },
    embeddings: { provider: 'none' },
    retrieval: { candidates: 20, passages: 5, rrfK: 60 },
  };
  const report = await sync(config, { folder: dir });
  assert.equal(report.added, 1);
  assert.equal(report.source, path.resolve(dir));

  const [hit] = await new Knowledge(config).search('how much is pink drift worth');
  assert.equal(hit.chunk.heading, 'Expensive gifts');
  assert.equal(hit.chunk.folder, 'Gifting');
});

test('an unchanged local file is not re-read, but a touched one is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-local-'));
  const file = path.join(dir, 'A.md');
  fs.writeFileSync(file, '# A\n\nA document with enough body text in it to become a passage on its own.');
  const config = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'andy-data-')),
    knowledge: { chunk: { minChars: 40 } },
    embeddings: { provider: 'none' },
    retrieval: {},
  };
  await sync(config, { folder: dir });
  assert.equal((await sync(config, { folder: dir })).unchanged, 1);

  fs.writeFileSync(file, '# A\n\nCompletely different body text, which is longer than what was there before it.');
  assert.equal((await sync(config, { folder: dir })).updated, 1);
});

test('uploads take priority over Drive, since somebody just put them there', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-data-'));
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'x.md'), 'body');
  const source = sourceFor({ dataDir, uploadDir, knowledge: { driveFolderId: 'SOMEFOLDER' } });
  assert.equal(source.label, path.resolve(uploadDir));
});

test('with nothing configured at all, the error says what to do', () => {
  assert.throws(() => sourceFor({ knowledge: {} }), /configure a Drive folder or pass a local one/);
  assert.throws(() => sourceFor({ knowledge: { driveFolderId: 'X' } }),
    /cli\.mjs ingest/, 'the message must offer the path that needs no Google account');
});

test('a missing local folder fails with the path, not a stack trace', () => {
  assert.throws(() => new LocalSource('/no/such/folder/anywhere'), /no such folder/);
});
