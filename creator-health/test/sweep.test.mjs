import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepDuplicates, titleOf } from '../lib/sweep.mjs';

const TITLE = 'Growth leaderboard — September';

/** A client that answers from a fixed channel and records what it deleted. */
function fakeClient(messages, { token = 'bot-token', listOk = true } = {}) {
  const deleted = [];
  return {
    token,
    deleted,
    async listMessages() {
      return listOk ? { ok: true, body: messages } : { ok: false, error: 'Missing Access' };
    },
    async deleteMessage(_channelId, id) {
      deleted.push(id);
      return { ok: true };
    },
  };
}

const msg = (id, title, extra = {}) => ({
  id, webhook_id: null, author: { id: 'bot-user', bot: true },
  embeds: title ? [{ title }] : [], ...extra,
});

test('it removes our older copies and keeps the one just posted', async () => {
  const client = fakeClient([
    msg('300', TITLE), // the new one
    msg('200', TITLE),
    msg('100', TITLE),
  ]);
  const out = await sweepDuplicates(client, {
    channelId: '1', title: TITLE, keepId: '300', botUserId: 'bot-user',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.removed, ['200', '100']);
  assert.deepEqual(client.deleted, ['200', '100']);
});

test('it never touches a card with a different title', async () => {
  // A creator's own card is titled after the creator, so it can never collide
  // with a board. This is the rule that makes the sweep safe to run at all.
  const client = fakeClient([
    msg('300', TITLE),
    msg('250', 'New creator leaderboard — September'),
    msg('240', '@somecreator has gone dark'),
    msg('200', TITLE),
  ]);
  const out = await sweepDuplicates(client, {
    channelId: '1', title: TITLE, keepId: '300', botUserId: 'bot-user',
  });
  assert.deepEqual(out.removed, ['200']);
});

test('it never touches a message a person wrote', async () => {
  const client = fakeClient([
    msg('300', TITLE),
    // Somebody quoting the board back, or a copy pasted by a coach.
    { id: '250', author: { id: 'a-human', bot: false }, embeds: [{ title: TITLE }] },
  ]);
  const out = await sweepDuplicates(client, {
    channelId: '1', title: TITLE, keepId: '300', botUserId: 'bot-user',
  });
  assert.deepEqual(out.removed, []);
  assert.deepEqual(client.deleted, []);
});

test('a webhook post of the same card is ours, and is swept', async () => {
  // A card can change route between runs — a webhook env var appearing or
  // going missing. The older copy is still ours either way.
  const client = fakeClient([
    msg('300', TITLE),
    { id: '200', webhook_id: '999', author: { id: 'some-webhook', bot: true }, embeds: [{ title: TITLE }] },
  ]);
  const out = await sweepDuplicates(client, {
    channelId: '1', title: TITLE, keepId: '300', botUserId: 'bot-user',
  });
  assert.deepEqual(out.removed, ['200']);
});

test('it says why it could not look, rather than reporting a clean channel', async () => {
  // A sweep that silently does nothing is the bug it exists to fix.
  const noToken = await sweepDuplicates({ token: null }, { channelId: '1', title: TITLE, keepId: '300' });
  assert.equal(noToken.ok, false);
  assert.match(noToken.reason, /bot token/);

  const noChannel = await sweepDuplicates(fakeClient([]), { channelId: null, title: TITLE, keepId: '300' });
  assert.equal(noChannel.ok, false);
  assert.match(noChannel.reason, /webhook/);

  const denied = await sweepDuplicates(fakeClient([], { listOk: false }), {
    channelId: '1', title: TITLE, keepId: '300',
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /Missing Access/);
});

test('a message with no embeds is left alone', async () => {
  const client = fakeClient([msg('300', TITLE), { id: '200', author: { bot: true }, embeds: [] }]);
  const out = await sweepDuplicates(client, { channelId: '1', title: TITLE, keepId: '300' });
  assert.deepEqual(out.removed, []);
});

test('titleOf reads the title the card will actually show', () => {
  assert.equal(titleOf({ embeds: [{ title: TITLE }] }), TITLE);
  assert.equal(titleOf({ embeds: [] }), null);
  assert.equal(titleOf(null), null);
});

test('through dispatch: a channel full of old copies is cleaned on a redo', async () => {
  // The whole point, end to end. The channel holds four copies of yesterday's
  // board that our notes know nothing about, because the store only ever held
  // the newest id. A redo must leave one.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { dispatch } = await import('../lib/dispatch.mjs');
  const { CaseStore } = await import('../lib/cases.mjs');
  const { loadRoutes } = await import('../lib/notify.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
    discord: {
      enabled: true, mode: 'bot', botToken: 'bot-token',
      overviewChannelId: '900000000000005001', summaryChannelId: '900000000000005001',
      groups: { 'Team Alpha': { channelId: '900000000000005002' } },
    },
  }));
  const discord = loadRoutes(dir).discord;

  const OVERVIEW = 'LEAP creator overview — 2026-09-20';
  // Four orphans, plus a creator card and a human message that must survive.
  let channel = [
    { id: '404', author: { id: 'bot-user', bot: true }, embeds: [{ title: OVERVIEW }] },
    { id: '403', author: { id: 'bot-user', bot: true }, embeds: [{ title: OVERVIEW }] },
    { id: '402', author: { id: 'bot-user', bot: true }, embeds: [{ title: '@somecreator has gone dark' }] },
    { id: '401', author: { id: 'a-human', bot: false }, embeds: [{ title: OVERVIEW }] },
  ];
  const deleted = [];
  const orig = globalThis.fetch;
  let nextId = 900;
  globalThis.fetch = async (url, opts) => {
    const route = String(url).replace('https://discord.com/api/v10', '');
    if (opts.method === 'GET' && route === '/users/@me') {
      return new Response('{"id":"bot-user"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (opts.method === 'GET') {
      return new Response(JSON.stringify(channel), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (opts.method === 'DELETE') {
      const id = route.split('/').pop();
      deleted.push(id);
      channel = channel.filter((m) => m.id !== id);
      return new Response(null, { status: 204 });
    }
    const id = String(++nextId);
    channel = [{ id, author: { id: 'bot-user', bot: true }, embeds: [{ title: OVERVIEW }] }, ...channel];
    return new Response(JSON.stringify({ id, channel_id: '900000000000005001' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const out = await dispatch({
      asOf: '2026-09-20', store: new CaseStore(dir), discordConfig: discord, dryRun: false,
      changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
      alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
      forceSummary: true, force: ['all'], config: { dataDir: dir },
    });
    assert.ok(out.swept.some((s) => s.removed > 0), 'the sweep found the orphans');
    assert.ok(deleted.includes('404') && deleted.includes('403'), 'both our old copies went');
    assert.ok(!deleted.includes('402'), 'the creator card stayed');
    assert.ok(!deleted.includes('401'), 'the human message stayed');
    const left = channel.filter((m) => m.embeds?.[0]?.title === OVERVIEW);
    assert.equal(left.filter((m) => m.author.bot).length, 1, 'one of ours left in the channel');
  } finally {
    globalThis.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
