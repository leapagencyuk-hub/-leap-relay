import test from 'node:test';
import assert from 'node:assert/strict';
import { redoSummary } from '../lib/redo.mjs';
import { handleInteraction, INTERACTION, RESPONSE, COMMANDS } from '../lib/interactions.mjs';
import { redoButton, parseCustomId } from '../lib/discord.mjs';
import { supersedes } from '../lib/dispatch.mjs';

const config = { dataDir: '/tmp/redo-test-does-not-need-to-exist' };

test('the redo button carries no case, and parses', () => {
  const rows = redoButton();
  const id = rows[0].components[0].custom_id;
  assert.equal(id, 'ch:redo:today');
  // It has to survive parseCustomId, which every component goes through.
  assert.deepEqual(parseCustomId(id), { action: 'redo', caseId: 'today' });
});

test('buttons are withheld when nothing is listening for them', () => {
  // An unanswered button reads "This interaction failed", which looks like a
  // broken tool rather than a missing setting.
  assert.deepEqual(redoButton({ enabled: false }), []);
});

test('pressing redo asks first, and does not post anything yet', async () => {
  const reply = await handleInteraction({
    type: INTERACTION.COMPONENT,
    data: { custom_id: 'ch:redo:today' },
    member: { user: { username: 'slow' } },
  }, { config });

  assert.equal(reply.type, RESPONSE.MESSAGE);
  assert.equal(reply.data.flags, 64, 'only the person who pressed it sees this');
  assert.match(reply.data.content, /Repost every daily card/);
  assert.match(reply.data.content, /Creator cards, graduations and leaps are left alone/);
  const confirm = reply.data.components[0].components[0];
  assert.equal(confirm.custom_id, 'ch:redogo:today');
  assert.equal(confirm.style, 4, 'the confirm is styled as the destructive one');
});

test('/redo asks the same question the button does', async () => {
  assert.ok(COMMANDS.some((c) => c.name === 'redo'), 'the command is registered');
  const reply = await handleInteraction({
    type: INTERACTION.COMMAND,
    data: { name: 'redo' },
    member: { user: { username: 'slow' } },
  }, { config });
  assert.equal(reply.data.flags, 64);
  assert.match(reply.data.content, /Repost every daily card/);
});

test('confirming without a config path says so instead of half-running', async () => {
  const reply = await handleInteraction({
    type: INTERACTION.COMPONENT,
    data: { custom_id: 'ch:redogo:today' },
    member: { user: { username: 'slow' } },
  }, { config });
  assert.equal(reply.data.flags, 64);
  assert.match(reply.data.content, /did not pass its config path/);
});

test('a redo replaces the current period, and never an older one', () => {
  // This is the guard that stops a redo eating last month's closing board: the
  // boards replace within a month only, and the final board of each month is
  // the result and survives.
  const prev = { id: '111', period: '2026-09' };
  assert.equal(supersedes(prev, '2026-09', '222'), true, 'same month, replace');
  assert.equal(supersedes(prev, '2026-10', '222'), false, 'new month, keep September');
  // A card with no period at all is always today's view and always replaced.
  assert.equal(supersedes({ id: '111', period: null }, null, '222'), true);
  // And nothing is deleted when the repost produced no new message.
  assert.equal(supersedes(prev, '2026-09', undefined), false);
});

test('the summary counts both directions and reads as English', () => {
  assert.equal(
    redoSummary({ asOf: '2026-09-20', posted: 19, replaced: 17, failed: [], byLabel: [] }),
    '19 cards reposted for 2026-09-20, 17 older copies removed.');
  assert.equal(
    redoSummary({ asOf: '2026-09-20', posted: 1, replaced: 1, failed: [], byLabel: [] }),
    '1 card reposted for 2026-09-20, 1 older copy removed.');
  assert.match(
    redoSummary({ asOf: '2026-09-20', posted: 18, replaced: 17, failed: [{ label: 'x' }], byLabel: [] }),
    /1 failed\.$/);
  assert.match(
    redoSummary({ skipped: 'no webhook URLs are set', asOf: '2026-09-20', posted: 0, replaced: 0, failed: [] }),
    /^Nothing posted — no webhook URLs are set$/);
});

test('a bot-posted card is cleaned up too, not only a webhook one', async () => {
  // The bug this covers: a route whose webhook env var is missing falls back
  // to a channel id and a bot token. It posted fine and silently never cleaned
  // up, so the channel grew a copy a day while the code reported success.
  const { Discord } = await import('../lib/discord.mjs');
  const calls = [];
  const client = new Discord({ token: 'bot-token' });
  assert.equal(typeof client.deleteMessage, 'function',
    'the bot needs a delete of its own, beside deleteWebhookMessage');

  // Both delete paths treat "already gone" as the outcome we wanted.
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(`${opts.method} ${String(url)}`);
    return new Response('{"message":"Unknown Message"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  try {
    const viaBot = await client.deleteMessage('123', '456');
    assert.equal(viaBot.ok, true);
    assert.equal(viaBot.alreadyGone, true);
    assert.match(calls[0], /^DELETE .*\/channels\/123\/messages\/456$/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('a slot that falls back from a missing webhook to a bot still cleans up', async () => {
  // The regression, end to end through dispatch. On Render the growth board's
  // webhook env var was unset, so the route fell back to a channel id and the
  // bot posted it. The cleanup was guarded on `route.webhook`, so it never
  // ran: the channel grew a copy a day while every run reported success.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { dispatch } = await import('../lib/dispatch.mjs');
  const { CaseStore } = await import('../lib/cases.mjs');
  const { loadRoutes } = await import('../lib/notify.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redo-bot-'));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
    discord: {
      enabled: true, mode: 'bot', botToken: 'bot-token',
      // No webhook anywhere: every card takes the channel path.
      overviewChannelId: '900000000000000001',
      summaryChannelId: '900000000000000001',
      groups: { 'Team Alpha': { channelId: '900000000000000002' } },
    },
  }));
  const discord = loadRoutes(dir).discord;

  const calls = [];
  const orig = globalThis.fetch;
  let nextId = 700;
  globalThis.fetch = async (url, opts) => {
    calls.push(`${opts.method} ${String(url).replace('https://discord.com/api/v10', '')}`);
    if (opts.method === 'DELETE') return new Response('', { status: 204 });
    return new Response(JSON.stringify({ id: String(++nextId), channel_id: '900000000000000001' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const run = () => dispatch({
    asOf: '2026-09-20', store: new CaseStore(dir), discordConfig: discord, dryRun: false,
    changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
    forceSummary: true, force: ['all'], config: { dataDir: dir },
  });

  try {
    await run();
    const afterFirst = calls.filter((c) => c.startsWith('DELETE')).length;
    assert.equal(afterFirst, 0, 'nothing to clean up on the first run');
    await run();
    const deletes = calls.filter((c) => c.startsWith('DELETE'));
    assert.ok(deletes.length > 0, 'the second run removes what the first one posted');
    for (const d of deletes) assert.match(d, /^DELETE \/channels\/\d+\/messages\/\d+$/);
  } finally {
    globalThis.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
