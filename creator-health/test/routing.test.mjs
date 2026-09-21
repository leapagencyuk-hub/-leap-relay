import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoutes, groupKey, isChannelId, isWebhookUrl } from '../lib/notify.mjs';
import { routeFor, coverage, preflight } from '../lib/dispatch.mjs';

const ID = (n) => String(n).padStart(18, '1');

function routesFrom(discord) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-routes-'));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({ discord }));
  const loaded = loadRoutes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return loaded.discord;
}

test('team names are matched despite the export\'s inconsistent casing', () => {
  // The export really does contain "TEAM GOLF" and "Team Indigo " with a space.
  assert.equal(groupKey('TEAM GOLF'), groupKey('Team Golf'));
  assert.equal(groupKey('Team Indigo '), groupKey('team indigo'));
  assert.equal(groupKey('Team  Alpha'), groupKey('Team Alpha'));
  assert.equal(groupKey(null), '');
});

test('a scaffolded placeholder is never mistaken for a real channel', () => {
  assert.equal(isChannelId('123456789012345678'), true);
  assert.equal(isChannelId('PASTE_CHANNEL_ID  (48 creators)'), false);
  assert.equal(isChannelId('12345'), false, 'too short to be a snowflake');
  assert.equal(isChannelId(null), false);
  assert.equal(isWebhookUrl('https://discord.com/api/webhooks/1/abc'), true);
  assert.equal(isWebhookUrl('PASTE_WEBHOOK_URL'), false);

  const cfg = routesFrom({ groups: { 'Team Ratty': { channelId: 'PASTE_CHANNEL_ID' } } });
  assert.equal(cfg.groups[groupKey('Team Ratty')].channelId, null);
});

test('the card goes to the team channel and pings the creator\'s own coach', () => {
  // Team Alpha really does have two coaches in the live data, and pinging the
  // wrong one for six creators would be worse than not pinging at all.
  const cfg = routesFrom({
    routeBy: 'group',
    groups: { 'Team Alpha': { channelId: ID(7), mention: '<@team>' } },
    coaches: {
      'josh@leap': { mention: '<@josh>' },
      'amy@leap': { mention: '<@amy>' },
    },
  });
  const josh = routeFor({ coach: 'josh@leap', group: 'Team Alpha' }, cfg);
  const amy = routeFor({ coach: 'amy@leap', group: 'Team Alpha' }, cfg);
  assert.equal(josh.channelId, ID(7));
  assert.equal(amy.channelId, ID(7), 'same channel');
  assert.equal(josh.mention, '<@josh>');
  assert.equal(amy.mention, '<@amy>', 'but their own coach is pinged');
});

test('a team with no channel falls back to its coach, then to the default', () => {
  const cfg = routesFrom({
    routeBy: 'group',
    groups: {},
    coaches: { 'sol@leap': { channelId: ID(3) } },
    defaultChannelId: ID(9),
  });
  assert.equal(routeFor({ coach: 'sol@leap', group: 'Stay Social' }, cfg).channelId, ID(3));
  assert.equal(routeFor({ coach: 'nobody@leap', group: 'Team Ratty' }, cfg).channelId, ID(9));
  assert.equal(routeFor({ coach: 'nobody@leap', group: 'Team Ratty' }, cfg).viaDefault, true);
});

test('routeBy coach flips the preference', () => {
  const cfg = routesFrom({
    routeBy: 'coach',
    groups: { 'Team Alpha': { channelId: ID(7) } },
    coaches: { 'josh@leap': { channelId: ID(4) } },
  });
  assert.equal(routeFor({ coach: 'josh@leap', group: 'Team Alpha' }, cfg).channelId, ID(4));
});

test('coverage names the teams that would go nowhere', () => {
  const cfg = routesFrom({
    groups: {
      'Team Alpha': { channelId: ID(7) },
      'Stay Social': { channelId: 'PASTE_CHANNEL_ID' },
    },
  });
  const creators = [
    ...Array.from({ length: 5 }, (_, i) => ({ username: `a${i}`, group: 'Team Alpha', manager: 'josh@leap', quitOn: null })),
    ...Array.from({ length: 3 }, (_, i) => ({ username: `s${i}`, group: 'Stay Social', manager: 'sol@leap', quitOn: null })),
    { username: 'z', group: 'Team Ratty', manager: 'row@leap', quitOn: null },
    { username: 'gone', group: 'Team Ratty', manager: 'row@leap', quitOn: '2026-09-01' },
  ];
  const report = coverage(creators, cfg);
  assert.equal(report.groups.find((g) => g.label === 'Team Alpha').routed, true);
  assert.equal(report.groups.find((g) => g.label === 'Stay Social').routed, false,
    'a placeholder is not a destination');
  assert.equal(report.unrouted.length, 2);
  assert.equal(report.unroutedCreators, 4, 'the creator who left is not counted');
});

test('coverage reports a team shared by more than one coach', () => {
  const creators = [
    { username: 'a', group: 'Team Alpha', manager: 'josh@leap', quitOn: null },
    { username: 'b', group: 'Team Alpha', manager: 'amy@leap', quitOn: null },
  ];
  const alpha = coverage(creators, routesFrom({})).groups.find((g) => g.label === 'Team Alpha');
  assert.deepEqual(alpha.coaches.sort(), ['amy@leap', 'josh@leap']);
});

test('preflight accepts a server configured only by team', () => {
  const cfg = routesFrom({ mode: 'bot', botToken: 'x', groups: { 'Team Alpha': { channelId: ID(7) } } });
  assert.equal(preflight(cfg).ok, true);

  const empty = routesFrom({ mode: 'bot', botToken: 'x', groups: { 'Team Alpha': { channelId: 'PASTE_CHANNEL_ID' } } });
  assert.equal(preflight(empty).ok, false, 'placeholders alone are not a configuration');
});

// --- the once-a-day overview ------------------------------------------------

import { dispatch } from '../lib/dispatch.mjs';
import { CaseStore } from '../lib/cases.mjs';

const emptyRun = (store, discord, asOf, extra = {}) => dispatch({
  asOf, store, discordConfig: discord,
  changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
  alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
  ...extra,
});

test('the overview posts once a day, however often the run is repeated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ov-'));
  const store = new CaseStore(dir);
  const discord = routesFrom({
    mode: 'webhook',
    summaryWebhook: 'https://discord.com/api/webhooks/1/token',
    groups: { 'Team Alpha': { webhook: 'https://discord.com/api/webhooks/2/token' } },
  });

  // dryRun renders without sending, but the guard is what is under test, so
  // drive it through the same path twice and check the second is skipped.
  const first = await emptyRun(store, discord, '2026-09-20', { dryRun: true });
  assert.equal(first.previews.filter((p) => p.label === 'overview').length, 1);

  store.data.lastOverviewOn = '2026-09-20';
  const second = await emptyRun(store, discord, '2026-09-20', { dryRun: true });
  assert.equal(second.sent.find((x) => x.label === 'overview')?.skipped, 'already posted today');
  assert.equal(second.previews.filter((p) => p.label === 'overview').length, 0);

  // A new day posts again.
  const nextDay = await emptyRun(store, discord, '2026-09-21', { dryRun: true });
  assert.equal(nextDay.previews.filter((p) => p.label === 'overview').length, 1);

  // And it can be forced when someone really does want it re-sent.
  const forced = await emptyRun(store, discord, '2026-09-20', { dryRun: true, forceSummary: true });
  assert.equal(forced.previews.filter((p) => p.label === 'overview').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('webhook mode is accepted without a bot token, and refused without URLs', () => {
  const withHooks = routesFrom({ mode: 'webhook', groups: { 'Team Alpha': { webhook: 'https://discord.com/api/webhooks/1/t' } } });
  assert.equal(preflight(withHooks).ok, true);
  const without = routesFrom({ mode: 'webhook', groups: { 'Team Alpha': { webhook: 'PASTE_WEBHOOK_URL' } } });
  assert.equal(preflight(without).ok, false);
  assert.match(preflight(without).reason, /no webhook URLs/);
});

test('a webhook wins over a channel id, matching how delivery actually works', () => {
  const cfg = routesFrom({
    groups: { 'Team Alpha': { webhook: 'https://discord.com/api/webhooks/1/t', channelId: '123456789012345678' } },
  });
  const route = routeFor({ coach: 'josh@leap', group: 'Team Alpha' }, cfg);
  assert.ok(route.webhook, 'both are kept so a later switch to a bot needs only a token');
  assert.equal(route.channelId, '123456789012345678');
});
