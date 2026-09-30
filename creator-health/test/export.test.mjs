import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'server.mjs');

/** Boot a real server on a throwaway data directory, and always kill it. */
async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'config.json'), 'utf8'));
  cfg.dataDir = path.join(dir, 'data');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  // No routes.json: Discord stays unconfigured, which this test wants.
  const port = 8900 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env, ...env,
      CH_CONFIG: path.join(dir, 'config.json'),
      PORT: String(port),
      // The boot run would post nothing with no routes, but waiting it out
      // keeps the test to the one thing it is about.
      CH_BOOT_DELAY_MS: '600000',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the export needs the token, and carries the whole series', async () => {
  await withServer({ UPLOAD_TOKEN: 'secret' }, async (base) => {
    // Every creator's diamonds, followers and earnings history in one file.
    // Without the token it must not come out.
    const denied = await fetch(`${base}/export`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, 'unauthorised');

    const ok = await fetch(`${base}/export?token=secret`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(Array.isArray(body.snapshots), 'the snapshot dates come with it');
    assert.ok(body.series && typeof body.series.creators === 'object',
      'and the series itself, not a summary of it');
    // The case store is where payroll lives — which creators have leaped, in
    // which month, for how much. It cannot be rebuilt from the exports, so a
    // backup without it is not a backup.
    assert.ok(body.state && typeof body.state === 'object', 'the persisted state comes too');
    assert.ok('leaped' in body.state || 'cases' in body.state,
      'including the records a coach is paid from');
    assert.match(body.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

    // A Bearer header works as well as the query string, so it can be pulled
    // by something that does not want the token in a URL or a proxy log.
    const viaHeader = await fetch(`${base}/export`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(viaHeader.status, 200);
  });
});

test('a host with no token set serves it to anybody, and that is the warning', async () => {
  // Not a feature to rely on — this is what LEAP's own host was doing, and the
  // test exists so nobody reads the 401 above and assumes they are covered.
  await withServer({ UPLOAD_TOKEN: '' }, async (base) => {
    assert.equal((await fetch(`${base}/export`)).status, 200);
    assert.equal((await fetch(`${base}/status.json`).then((r) => r.json())).protected, false,
      'and /status.json says so, which is how you check from outside');
  });
});
