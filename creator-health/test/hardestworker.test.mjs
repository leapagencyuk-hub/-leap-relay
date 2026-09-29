import test from 'node:test';
import assert from 'node:assert/strict';
import { hardestWorkerBoard, hardestWorkerDue, hrs } from '../lib/hardestworker.mjs';
import { hardestWorkerEmbed } from '../lib/discord.mjs';
import { supersedes } from '../lib/dispatch.mjs';

const config = {
  hardestWorker: { show: 10 },
  monitoring: { ignoreGroups: ['Surge Agency'] },
  coaches: { names: { 'josh@leap': 'Sur3shot' } },
};
const ASOF = '2026-09-28';

const who = (username, { hours = 0, diamonds = 0, group = 'Team Alpha',
  quitOn = null, date = ASOF, streams = 0, liveDays = 0 } = {}) => ({
  key: username, username, quitOn, group, manager: 'josh@leap', joinDate: '2026-01-01',
  obs: [{ date, mtd: { liveHours: hours, diamonds, liveStreams: streams, validLiveDays: liveDays } }],
});

test('the board is hours streamed this month, most first', () => {
  const b = hardestWorkerBoard({
    creators: [
      who('coregaming2811', { hours: 225.41 }),
      who('mr_chooksy', { hours: 247.45 }),
      who('gingerghostgaming', { hours: 224.42 }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(b.top.map((r) => r.username),
    ['mr_chooksy', 'coregaming2811', 'gingerghostgaming']);
  assert.deepEqual(b.top.map((r) => r.rank), [1, 2, 3]);
  assert.equal(b.winner.username, 'mr_chooksy');
  assert.equal(b.entered, 3);
  // The gap the chasing pack has to close, for anyone who wants to know.
  assert.equal(Math.round(b.lead * 100) / 100, 22.04);
});

test('hours are written the way LEAP writes them, to two decimals', () => {
  // The hand-made card said "247.45 hrs". The export gives hours as a float off
  // "126h 27m 31s", so it has to be cut somewhere, and this is where.
  assert.equal(hrs(247.4512), '247.45');
  assert.equal(hrs(163.25), '163.25');
  assert.equal(hrs(200), '200.00');
  assert.equal(hrs(0), '0.00');
  assert.equal(hrs(null), '0.00');
});

test('nobody is listed on nothing, and nobody who left is listed at all', () => {
  const b = hardestWorkerBoard({
    creators: [
      who('streamed', { hours: 40 }),
      // A creator who has not been LIVE this month is not "last on the
      // leaderboard", they are simply not in it. There are hundreds of them.
      who('signed_up_only', { hours: 0, diamonds: 0 }),
      who('left_in_august', { hours: 300, quitOn: '2026-08-14' }),
      // A partner agency's roster is in the export but not in LEAP's challenge.
      who('someone_elses', { hours: 500, group: 'Surge Agency' }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(b.rows.map((r) => r.username), ['streamed']);
});

test('a creator with no reading this month is not carried over from last', () => {
  const stale = who('last_month_only', { hours: 300, date: '2026-08-31' });
  const b = hardestWorkerBoard({ creators: [stale], asOf: ASOF, config });
  assert.equal(b.entered, 0, 'August hours are not September hours');
});

test('equal hours are split on what was done with them', () => {
  const b = hardestWorkerBoard({
    creators: [
      who('quiet', { hours: 100, diamonds: 1000 }),
      who('busy', { hours: 100, diamonds: 90000 }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(b.rows.map((r) => r.username), ['busy', 'quiet']);
});

test('the card is LEAP\'s own, in LEAP\'s own words', () => {
  const b = hardestWorkerBoard({
    creators: [
      who('mr_chooksy', { hours: 247.45 }),
      who('coregaming2811', { hours: 225.41 }),
      who('baddadgamer20', { hours: 163.25 }),
    ],
    asOf: ASOF, config,
  });
  const e = hardestWorkerEmbed(b, { config }).embeds[0];

  assert.equal(e.title, '🏆 LEAP\'s Hardest Worker Challenge – September');
  assert.match(e.description, /^Welcome to our monthly Hardest Worker Challenge!/);
  assert.match(e.description, /how many hours each creator has streamed so far this month/);
  // The one line that changed from the hand-made card, because that is the
  // whole point of automating it.
  assert.match(e.description, /\*\*updated every day\*\*/);
  assert.doesNotMatch(e.description, /every week/);

  assert.equal(e.fields[0].name, 'September leaderboard');
  assert.equal(e.fields[0].value, [
    '1. mr_chooksy — 247.45 hrs',
    '2. coregaming2811 — 225.41 hrs',
    '3. baddadgamer20 — 163.25 hrs',
  ].join('\n'));

  assert.match(e.footer.text, /^Updated daily · 2 days left in September/);
  assert.match(e.footer.text, /Keep streaming to stay on top!/);
});

test('the card shows a creator nothing about any other creator\'s business', () => {
  // This one goes to the creator server. Coaches, teams, diamonds and money are
  // all on the coach cards and none of them belong here.
  const b = hardestWorkerBoard({
    creators: [who('someone', { hours: 120, diamonds: 812345, streams: 60, liveDays: 22 })],
    asOf: ASOF, config,
  });
  const e = hardestWorkerEmbed(b, { config }).embeds[0];
  const whole = JSON.stringify(e);
  assert.doesNotMatch(whole, /diamond/i);
  assert.doesNotMatch(whole, /812,?345/);
  assert.doesNotMatch(whole, /Sur3shot|josh@leap|coach/i);
  assert.doesNotMatch(whole, /Team Alpha/);
  assert.doesNotMatch(whole, /£|\$/);
});

test('on the last day of the month the card crowns the winner', () => {
  const creators = [
    who('mr_chooksy', { hours: 268.10, date: '2026-09-30' }),
    who('coregaming2811', { hours: 244.02, date: '2026-09-30' }),
    who('gingerghostgaming', { hours: 240.55, date: '2026-09-30' }),
  ];
  const b = hardestWorkerBoard({ creators, asOf: '2026-09-30', config });
  assert.equal(b.finished, true);
  assert.equal(b.daysLeft, 0);

  const e = hardestWorkerEmbed(b, { config }).embeds[0];
  assert.match(e.title, /September winner$/);
  assert.match(e.description, /the hardest worker of the month is \*\*mr_chooksy\*\* on \*\*268\.10 hours\*\*/);
  // The two behind them get named too: a leaderboard that only ever celebrates
  // first place stops being worth chasing at about fourth.
  assert.match(e.description, /coregaming2811 and gingerghostgaming right behind them/);
  assert.equal(e.fields[0].name, 'September final leaderboard');
  assert.match(e.footer.text, /resets on the 1st/);
  // And it stops asking people to climb, because by now nobody can.
  assert.doesNotMatch(e.description, /climb the ranks/);
});

test('a short month ends on its own last day, not the 31st', () => {
  const on = (d) => hardestWorkerBoard({
    creators: [who('x', { hours: 10, date: d })], asOf: d, config,
  });
  assert.equal(on('2026-09-29').finished, false, '29 September is not the end of September');
  assert.equal(on('2026-09-30').finished, true);
  assert.equal(on('2026-02-28').finished, true, 'February 2026 is 28 days');
  assert.equal(on('2026-02-27').finished, false);
  assert.equal(on('2026-01-31').finished, true);
});

test('the winner card copes with a month only one person entered', () => {
  const b = hardestWorkerBoard({
    creators: [who('alone', { hours: 12, date: '2026-09-30' })], asOf: '2026-09-30', config,
  });
  const e = hardestWorkerEmbed(b, { config }).embeds[0];
  assert.match(e.description, /\*\*alone\*\* on \*\*12\.00 hours\*\*/);
  assert.doesNotMatch(e.description, /right behind/);
  assert.equal(b.lead, null);
});

test('the card prints as many as it is told to and still fits Discord', () => {
  const creators = Array.from({ length: 120 }, (_, i) =>
    who(`a_creator_with_quite_a_long_name_${String(i).padStart(3, '0')}`, { hours: 300 - i }));
  const b = hardestWorkerBoard({
    creators, asOf: ASOF, config: { ...config, hardestWorker: { show: 100 } },
  });
  assert.equal(b.entered, 120, 'everyone who streamed is ranked');
  assert.equal(b.top.length, 100, 'the card is told to print 100');

  const e = hardestWorkerEmbed(b, { config: { ...config, hardestWorker: { show: 100 } } }).embeds[0];
  assert.ok(e.fields[0].value.length <= 1024, `field is ${e.fields[0].value.length}`);
  // Cut at a whole row, never mid-name.
  for (const l of e.fields[0].value.split('\n')) assert.match(l, /^\d+\. \S+ — [\d.]+ hrs$/);
});

test('a month nobody has started yet says so rather than showing a blank', () => {
  const b = hardestWorkerBoard({ creators: [who('nobody', { hours: 0 })], asOf: '2026-10-01', config });
  assert.equal(b.entered, 0);
  const e = hardestWorkerEmbed(b, { config }).embeds[0];
  assert.match(e.fields[0].value, /First one on the board takes top spot/);
});

test('the board is posted once a day, and again when asked', () => {
  const store = { data: { lastHardestWorkerOn: null } };
  assert.equal(hardestWorkerDue(config, store, ASOF), true);
  store.data.lastHardestWorkerOn = ASOF;
  assert.equal(hardestWorkerDue(config, store, ASOF), false);
  assert.equal(hardestWorkerDue(config, store, '2026-09-29'), true, 'tomorrow is due again');
  assert.equal(hardestWorkerDue({ hardestWorker: { enabled: false } }, { data: {} }, ASOF), false);
});

test('this is the one board that does NOT keep last month\'s closing edition', () => {
  // The coach boards pass their month, so September's final standings survive
  // into October. LEAP asked for the opposite here: on the 1st it all clears.
  // That is expressed by passing no period at all.
  const septemberWinner = { id: '111', period: null };
  assert.equal(supersedes(septemberWinner, null, '222'), true,
    'October\'s first board removes September\'s winner');
});

test('the month rolls over in the channel: one message, replaced', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { dispatch } = await import('../lib/dispatch.mjs');
  const { CaseStore } = await import('../lib/cases.mjs');
  const { loadRoutes } = await import('../lib/notify.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardest-'));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
    discord: {
      enabled: true, mode: 'webhook',
      hardestWorkerWebhook: 'https://discord.com/api/webhooks/1/creator-server',
      hardestWorkerChannelId: '1374064861897687201',
    },
  }));
  const discord = loadRoutes(dir).discord;

  const posts = [];
  const deletes = [];
  const orig = globalThis.fetch;
  let nextId = 900;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts.method === 'DELETE') { deletes.push(u); return new Response(null, { status: 204 }); }
    if (opts.method === 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    posts.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: String(++nextId), channel_id: '1374064861897687201' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const store = new CaseStore(dir);
  const run = (asOf, creators) => dispatch({
    asOf, store, discordConfig: discord, dryRun: false, creators,
    changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
    alerts: [], spotlight: [], ramp: [], stats: { tracked: creators.length, quit: 0 },
    config: { dataDir: dir, ...config },
  });

  try {
    // The 30th: September's result.
    await run('2026-09-30', [who('mr_chooksy', { hours: 268.10, date: '2026-09-30' })]);
    assert.equal(deletes.length, 0, 'nothing to remove on the first post');
    assert.match(posts.at(-1).embeds[0].title, /September winner$/);

    // The 1st: October, from zero, and September's winner comes down.
    await run('2026-10-01', [who('someone_new', { hours: 6.5, date: '2026-10-01' })]);
    assert.equal(deletes.length, 1, 'September\'s card is gone from the creator channel');
    assert.match(deletes[0], /\/messages\/901$/);
    const october = posts.at(-1).embeds[0];
    assert.equal(october.title, '🏆 LEAP\'s Hardest Worker Challenge – October');
    assert.equal(october.fields[0].value, '1. someone_new — 6.50 hrs');
    assert.match(october.footer.text, /30 days left in October/);
  } finally {
    globalThis.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the button beside the board ------------------------------------------

/** A throwaway project on disk: a store, a routes file and a series. */
async function sandbox({ creators, asOf, routes = null }) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'series.json'), JSON.stringify({
    lastAsOf: asOf, creators: Object.fromEntries(creators.map((c) => [c.key, c])),
  }));
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
    discord: routes ?? {
      enabled: true, mode: 'webhook',
      hardestWorkerWebhook: 'https://discord.com/api/webhooks/1/creator-server',
      hardestWorkerChannelId: '1374064861897687201',
    },
  }));
  return { dir, configPath: path.join(dir, 'config.json'), config: { ...config, dataDir: path.join(dir, 'data') } };
}

/** Stand in for Discord, remembering what is left standing in the channel. */
function fakeDiscord() {
  const channel = new Map();
  const log = [];
  let next = 500;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === 'DELETE') {
      const id = String(url).split('/').pop();
      const had = channel.delete(id);
      log.push(`DELETE ${id}${had ? '' : ' (already gone)'}`);
      return new Response(null, { status: had ? 204 : 404 });
    }
    if (opts.method === 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    const id = String(++next);
    channel.set(id, JSON.parse(opts.body).embeds[0].title);
    log.push(`POST ${id}`);
    return new Response(JSON.stringify({ id, channel_id: '1374064861897687201' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { channel, log, restore: () => { globalThis.fetch = orig; } };
}

test('the button posts the board now and takes the old one down', async () => {
  const fs = await import('node:fs');
  const { refreshChallenge, challengeSummary } = await import('../lib/challenge.mjs');
  const { dir, config: cfg, configPath } = await sandbox({
    asOf: ASOF,
    creators: [who('mr_chooksy', { hours: 247.45 }), who('coregaming2811', { hours: 225.41 })],
  });
  const d = fakeDiscord();
  try {
    const first = await refreshChallenge(cfg, configPath, {});
    assert.equal(first.posted, true);
    assert.equal(first.replaced, 0, 'nothing was there to remove');
    assert.equal(first.entered, 2);
    assert.equal(first.winner, 'mr_chooksy');
    assert.match(challengeSummary(first), /^2026-09: 2 creators ranked, mr_chooksy leads on 247\.45 hours \(2 days to go\)\.$/);

    // Pressed again five minutes later: one card in the channel, not two.
    const second = await refreshChallenge(cfg, configPath, {});
    assert.equal(second.replaced, 1);
    assert.equal(d.channel.size, 1, 'the channel holds exactly one board');
    assert.match(challengeSummary(second), /1 older copy removed\.$/);
  } finally {
    d.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the button and the daily run share one slot, so they cannot both stand', async () => {
  // The bug this exists to stop: the button writing its own note, the daily
  // run writing a different one, and the channel quietly holding two boards.
  const fs = await import('node:fs');
  const { refreshChallenge } = await import('../lib/challenge.mjs');
  const { dispatch } = await import('../lib/dispatch.mjs');
  const { CaseStore } = await import('../lib/cases.mjs');
  const { loadRoutes } = await import('../lib/notify.mjs');
  const creators = [who('mr_chooksy', { hours: 247.45 })];
  const { dir, config: cfg, configPath } = await sandbox({ asOf: ASOF, creators });
  const d = fakeDiscord();
  try {
    await refreshChallenge(cfg, configPath, {});
    assert.equal(d.channel.size, 1);

    await dispatch({
      asOf: ASOF, store: new CaseStore(cfg.dataDir), discordConfig: loadRoutes(dir).discord,
      dryRun: false, creators, force: ['all'], config: cfg,
      changes: { opened: [], worsened: [], escalated: [], dueFollowUps: [], autoResolved: [] },
      alerts: [], spotlight: [], ramp: [], stats: { tracked: 1, quit: 0 },
    });
    assert.equal(d.channel.size, 1, 'the run replaced the button\'s card rather than adding to it');

    // And back the other way.
    await refreshChallenge(cfg, configPath, {});
    assert.equal(d.channel.size, 1, 'the button replaced the run\'s card');
  } finally {
    d.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the button posts nothing into a creator channel when there is nothing to post', async () => {
  const fs = await import('node:fs');
  const { refreshChallenge, challengeSummary } = await import('../lib/challenge.mjs');
  const { dir, config: cfg, configPath } = await sandbox({
    asOf: '2026-10-01', creators: [who('nobody', { hours: 0, date: '2026-10-01' })],
  });
  const d = fakeDiscord();
  try {
    const out = await refreshChallenge(cfg, configPath, {});
    assert.equal(out.posted, false);
    assert.equal(d.log.length, 0, 'Discord was not called at all');
    assert.match(challengeSummary(out), /Nothing posted — nobody has been LIVE in 2026-10 yet/);
  } finally {
    d.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run renders the card without touching the channel', async () => {
  const fs = await import('node:fs');
  const { refreshChallenge } = await import('../lib/challenge.mjs');
  const { dir, config: cfg, configPath } = await sandbox({
    asOf: ASOF, creators: [who('mr_chooksy', { hours: 247.45 })],
  });
  const d = fakeDiscord();
  try {
    const out = await refreshChallenge(cfg, configPath, { dryRun: true });
    assert.equal(out.posted, false);
    assert.equal(d.log.length, 0);
    assert.equal(out.payload.embeds[0].fields[0].value, '1. mr_chooksy — 247.45 hrs');
  } finally {
    d.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unconfigured channel is said plainly, not posted into somebody else\'s', async () => {
  const fs = await import('node:fs');
  const { refreshChallenge, challengeSummary } = await import('../lib/challenge.mjs');
  const { dir, config: cfg, configPath } = await sandbox({
    asOf: ASOF, creators: [who('mr_chooksy', { hours: 247.45 })],
    routes: { enabled: true, mode: 'webhook', summaryWebhook: 'https://discord.com/api/webhooks/9/coaches' },
  });
  const d = fakeDiscord();
  try {
    const out = await refreshChallenge(cfg, configPath, {});
    assert.equal(out.posted, false);
    assert.equal(d.log.length, 0);
    assert.match(challengeSummary(out), /no channel configured for the Hardest Worker Challenge/);
  } finally {
    d.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing ingested it says so rather than posting an empty month', async () => {
  const { refreshChallenge } = await import('../lib/challenge.mjs');
  const fs = await import('node:fs');
  const { dir, config: cfg, configPath } = await sandbox({ asOf: null, creators: [] });
  try {
    await assert.rejects(() => refreshChallenge(cfg, configPath, {}), /no snapshots ingested yet/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
