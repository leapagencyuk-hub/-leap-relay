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

// --- the inactive channel ----------------------------------------------------

const TEAM_HOOK = 'https://discord.com/api/webhooks/2/team';
const INACTIVE_HOOK = 'https://discord.com/api/webhooks/3/inactive';

const caseOf = (kind, extra = {}) => ({
  id: `${kind === 'activation' ? 'A-' : ''}C-1`, kind, status: 'open',
  creatorKey: 'k1', username: 'creator1', coach: 'josh@leap', group: 'Team Alpha',
  openedOn: '2026-09-20', stage: 'STALLED', context: { day: 12, everLive: true, bestMonth: 0 },
  baseline: { weeklyDiamonds: 0, weeklyHours: 0, weeklyLiveDays: 0 },
  ...extra,
});

const runWith = (opened, discord) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inact-'));
  const store = new CaseStore(dir);
  return dispatch({
    asOf: '2026-09-20', store, discordConfig: discord, dryRun: true,
    changes: { opened, worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
};

test('creators earning nothing go to the inactive channel, not their team channel', async () => {
  const discord = routesFrom({
    mode: 'webhook',
    inactiveWebhook: INACTIVE_HOOK,
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
    coaches: { 'josh@leap': { mention: '<@1>' } },
  });
  const out = await runWith([caseOf('activation')], discord);
  const card = out.previews.find((p) => p.label === 'activation-opened');
  assert.equal(card.to, INACTIVE_HOOK);
  // The coach is still pinged, and the card still says whose team it is,
  // because one shared channel carries every team's creators.
  assert.equal(card.payload.content, '<@1>');
  assert.match(card.payload.embeds[0].author.name, /Team Alpha/);
});

test('declines still go to the team channel when an inactive channel is set', async () => {
  const discord = routesFrom({
    mode: 'webhook',
    inactiveWebhook: INACTIVE_HOOK,
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
  });
  const decline = caseOf('decline', { severity: 'urgent', playbookId: 'DIAMONDS_DOWN', valueAtRisk: 1000 });
  const window = { diamonds: 1000, liveHours: 10, validLiveDays: 5 };
  const alert = {
    creator: { key: 'k1', username: 'creator1', group: 'Team Alpha' },
    severity: 'urgent', signals: [], causes: [],
    metrics: {
      curr7: window, prev7: window, curr28: window,
      change7: { diamonds: -0.4, liveHours: -0.3 },
      monthly: {}, monthlyCoverage: {},
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inact2-'));
  const store = new CaseStore(dir);
  const out = await dispatch({
    asOf: '2026-09-20', store, discordConfig: discord, dryRun: true,
    changes: { opened: [decline], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [alert], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.previews.find((p) => p.label === 'case-opened').to, TEAM_HOOK);
});

test('without an inactive channel, activation cards fall back to the team', async () => {
  const discord = routesFrom({ mode: 'webhook', groups: { 'Team Alpha': { webhook: TEAM_HOOK } } });
  const out = await runWith([caseOf('activation')], discord);
  const card = out.previews.find((p) => p.label === 'activation-opened');
  assert.equal(card.to, TEAM_HOOK);
});

test('a channel id alone is not used without a bot token to post with', async () => {
  const discord = routesFrom({
    mode: 'webhook',
    inactiveChannelId: ID(9),
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
  });
  const out = await runWith([caseOf('activation')], discord);
  assert.equal(out.previews.find((p) => p.label === 'activation-opened').to, TEAM_HOOK);
});

test('the weekly roster goes to the inactive channel, and skips unmonitored teams', async () => {
  const discord = routesFrom({
    mode: 'webhook',
    inactiveWebhook: INACTIVE_HOOK,
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
  });
  const row = (group, username) => ({
    creator: { key: username, username, group, manager: 'josh@leap' },
    stage: 'STALLED', day: 12, lastMonth: 0,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-roster-'));
  const store = new CaseStore(dir);
  const out = await dispatch({
    // 2026-09-21 is a Monday.
    asOf: '2026-09-21', store, discordConfig: discord, dryRun: true,
    changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: 2, quit: 0 },
    activation: [row('Team Alpha', 'a'), row('Surge Agency', 'b')],
    config: {
      activation: { enabled: true, rosterWeekday: 1 },
      monitoring: { ignoreGroups: ['Surge Agency'] },
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const rosters = out.previews.filter((p) => p.label === 'activation-roster');
  assert.deepEqual(rosters.map((r) => r.coach), ['Team Alpha'],
    'a team nobody coaches had no channel before, so one shared channel must not adopt it');
  assert.equal(rosters[0].to, INACTIVE_HOOK);
});

test('the daily team summary goes to its own channel, once a day', async () => {
  const SUMMARY_HOOK = 'https://discord.com/api/webhooks/4/summary';
  const discord = routesFrom({
    mode: 'webhook',
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
    teamSummaries: { 'Team Alpha': { webhook: SUMMARY_HOOK } },
  });
  const creator = { key: 'k1', username: 'creator1', group: 'Team Alpha', manager: 'josh@leap', quitOn: null };
  const metrics = {
    activeDays28: 20, dailyDiamonds7: 3000, diamondsPerHour28: 400,
    curr28: { diamonds: 60000 },
    fanClub: { activeFans: 40, activeFansChange14: 0.2 },
    monthOnMonth: { previousMonth: '2026-08', diamonds: { monthToDate: 60000, lastMonthToSamePoint: 50000, change: 0.2 } },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tsum-'));
  const store = new CaseStore(dir);
  const call = () => dispatch({
    asOf: '2026-09-20', store, discordConfig: discord, dryRun: true,
    changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
    creators: [creator], metricsByKey: new Map([[creator.key, metrics]]),
    config: { ramp: { targetDiamonds: 200000 }, growth: { enabled: true } },
  });

  const first = await call();
  const posted = first.previews.filter((p) => p.label === 'team-summary');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].to, SUMMARY_HOOK, 'the case channel carries the queue, not the picture');

  // The guard is what is under test, so drive the same day through twice.
  store.data.lastTeamSummaryOn = '2026-09-20';
  const second = await call();
  assert.equal(second.previews.filter((p) => p.label === 'team-summary').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a team with nobody earning gets no summary', async () => {
  const discord = routesFrom({
    mode: 'webhook',
    groups: { 'Team Alpha': { webhook: TEAM_HOOK } },
    teamSummaries: { 'Team Alpha': { webhook: 'https://discord.com/api/webhooks/4/summary' } },
  });
  const creator = { key: 'k1', username: 'creator1', group: 'Team Alpha', manager: 'josh@leap', quitOn: null };
  const metrics = {
    activeDays28: 0, dailyDiamonds7: 0, diamondsPerHour28: null,
    curr28: { diamonds: 0 },
    fanClub: { activeFans: 0, activeFansChange14: null },
    monthOnMonth: { previousMonth: '2026-08', diamonds: { monthToDate: 0, lastMonthToSamePoint: 0, change: null } },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tsum2-'));
  const store = new CaseStore(dir);
  const out = await dispatch({
    asOf: '2026-09-20', store, discordConfig: discord, dryRun: true,
    changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
    creators: [creator], metricsByKey: new Map([[creator.key, metrics]]),
    config: { ramp: { targetDiamonds: 200000 }, growth: { enabled: true } },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.previews.filter((p) => p.label === 'team-summary').length, 0,
    'an empty card every morning is how a channel stops being read');
});
