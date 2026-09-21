import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Drive, readServiceAccount, getAccessToken } from '../lib/drive.mjs';
import { loadConfig } from '../lib/config.mjs';

/** A real RSA keypair, so the JWT signing path is actually exercised. */
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT = {
  client_email: 'andy@leap-brain.iam.gserviceaccount.com',
  private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};

/** Drive with its one network method replaced, so the diagnosis logic is testable. */
function driveThatFails(status) {
  const drive = new Drive(ACCOUNT);
  drive.request = async () => { const err = new Error(`HTTP ${status}`); err.status = status; throw err; };
  return drive;
}

test('the service account is read from raw JSON and from base64', () => {
  const raw = JSON.stringify(ACCOUNT);
  assert.equal(readServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: raw }).client_email, ACCOUNT.client_email);
  assert.equal(
    readServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(raw).toString('base64') }).client_email,
    ACCOUNT.client_email,
    'a base64 key must work, because pasting raw JSON into a dashboard field often mangles it',
  );
});

test('no service account is null, not a crash', () => {
  assert.equal(readServiceAccount({}), null);
});

test('a JSON key missing its fields is rejected with a readable reason', () => {
  assert.throws(() => readServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}' }),
    /client_email\/private_key/);
});

test('an unshared folder is diagnosed as unshared, not as a missing folder', async () => {
  const result = await driveThatFails(404).checkFolder('1wI02oc8n8ZrYxxpPVwfCvSVIHAZoMeVN');
  assert.equal(result.ok, false);
  assert.match(result.reason, /has not been shared with andy@leap-brain\.iam\.gserviceaccount\.com/,
    'a bare 404 must name the sharing problem — it is the most common way this setup fails');
});

test('a 403 points at the Drive API not being enabled', async () => {
  const result = await driveThatFails(403).checkFolder('x');
  assert.match(result.reason, /Drive API is not enabled/);
});

test('pointing at a file instead of a folder says so', async () => {
  const drive = new Drive(ACCOUNT);
  drive.request = async () => ({ id: 'x', name: 'Deck.pdf', mimeType: 'application/pdf' });
  const result = await drive.checkFolder('x');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a folder/);
});

test('a reachable folder reports its name and the account that reached it', async () => {
  const drive = new Drive(ACCOUNT);
  drive.request = async () => ({ id: 'x', name: "Andy's Brain", mimeType: 'application/vnd.google-apps.folder' });
  assert.deepEqual(await drive.checkFolder('x'), { ok: true, name: "Andy's Brain", account: ACCOUNT.client_email });
});

test('sub-folders are walked and their names become the topic trail', async () => {
  const drive = new Drive(ACCOUNT);
  const pages = {
    root: { files: [
      { id: 'sub', name: 'Gifting', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'f1', name: 'Top.pdf', mimeType: 'application/pdf', modifiedTime: 'T', size: '10', md5Checksum: 'a' },
    ] },
    sub: { files: [{ id: 'f2', name: 'Deep.pdf', mimeType: 'application/pdf', modifiedTime: 'T', size: '10', md5Checksum: 'b' }] },
  };
  drive.request = async (url) => pages[new URL(url).searchParams.get('q').match(/'(\w+)'/)[1]];

  const files = await drive.listFolder('root');
  assert.deepEqual(files.map((f) => f.name).sort(), ['Deep.pdf', 'Top.pdf']);
  assert.equal(files.find((f) => f.name === 'Deep.pdf').folder, 'Gifting');
  assert.equal(files.find((f) => f.name === 'Top.pdf').folder, null);
});

test('a shortcut loop does not walk forever', async () => {
  const drive = new Drive(ACCOUNT);
  let requests = 0;
  drive.request = async () => {
    requests++;
    // A folder whose only child is a shortcut back to itself.
    return { files: [{ id: 's', name: 'Loop', mimeType: 'application/vnd.google-apps.shortcut',
      shortcutDetails: { targetId: 'root', targetMimeType: 'application/vnd.google-apps.folder' } }] };
  };
  assert.deepEqual(await drive.listFolder('root'), []);
  assert.ok(requests <= 2, `walked ${requests} times — a cycle should stop immediately`);
});

test('a 4xx is not retried, so a misconfiguration fails fast', async () => {
  const drive = new Drive(ACCOUNT);
  let attempts = 0;
  drive.token = async () => 'token';
  globalThis.fetch = async () => { attempts++; return new Response('nope', { status: 404 }); };
  await assert.rejects(() => drive.request('https://example.com/x'));
  assert.equal(attempts, 1, 'a 404 will not fix itself on the fourth try');
});

test('the shipped config points at the brain folder, and the env var still wins', async () => {
  assert.equal(loadConfig().knowledge.driveFolderId, '1wI02oc8n8ZrYxxpPVwfCvSVIHAZoMeVN');
  process.env.ANDY_DRIVE_FOLDER_ID = 'somewhere-else';
  assert.equal(loadConfig().knowledge.driveFolderId, 'somewhere-else');
  delete process.env.ANDY_DRIVE_FOLDER_ID;
});

test('the JWT sent to Google is signed and correctly scoped', async () => {
  let sent = null;
  globalThis.fetch = async (url, options) => {
    sent = { url, body: Object.fromEntries(options.body) };
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  };
  const { token } = await getAccessToken(ACCOUNT);
  assert.equal(token, 'tok');
  assert.equal(sent.body.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');

  const [head, claim, signature] = sent.body.assertion.split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'RS256');
  const parsed = JSON.parse(Buffer.from(claim, 'base64url'));
  assert.equal(parsed.iss, ACCOUNT.client_email);
  assert.equal(parsed.scope, 'https://www.googleapis.com/auth/drive.readonly',
    'read-only: Andy must never be able to change the folder it reads');
  assert.ok(parsed.exp > parsed.iat);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claim}`),
    crypto.createPublicKey(ACCOUNT.private_key), Buffer.from(signature, 'base64url')));
});
