#!/usr/bin/env node
// Command line entry point.
//
//   node cli.mjs ingest <file.xlsx> [--force]   store a daily export
//   node cli.mjs report [--as-of DATE] [--json] [--coach EMAIL] [--dry]
//   node cli.mjs coach <email> [--as-of DATE]   one coach's message
//   node cli.mjs creator <username>             one creator's full history
//   node cli.mjs rebuild                        re-derive the series
//   node cli.mjs status                         what is stored
//   node cli.mjs run [--dry] [--force-overview] daily run: cases + Discord
//   node cli.mjs graduation [--limit N]      the 200k chase as it stands
//   node cli.mjs cases [--coach E] [--all]      the open caseload
//   node cli.mjs case <id>                      one case and its history
//   node cli.mjs effectiveness                  which interventions work
//   node cli.mjs teams                          how each team's caseload resolves
//   node cli.mjs snooze <id> <days> [reason]    quiet a creator (holiday, break)
//   node cli.mjs close <id> [note]              close a case by hand
//   node cli.mjs discord-register               register the slash commands
//   node cli.mjs discord-scaffold [--write]     build routes.json from the live data
//   node cli.mjs discord-check                  which teams have nowhere to post
//   node cli.mjs discord-env                    env-var form, for deploying
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, ingestFile, rebuildSeries, analyse, buildDigests,
  renderNetworkSummary, toJson, runDaily, CaseStore, effectiveness,
} from './lib/pipeline.mjs';
import { Store as SeriesStore } from './lib/store.mjs';
import { Store } from './lib/store.mjs';
import { computeMetrics, tierOf } from './lib/metrics.mjs';
import { STATUS, isOpen, teamOutcomes, snooze, resolve } from './lib/cases.mjs';
import { PLAYBOOK, VERDICT_LABEL } from './lib/playbook.mjs';
import { loadRoutes } from './lib/notify.mjs';
import { coverage, routeFor } from './lib/dispatch.mjs';
import { groupKey } from './lib/notify.mjs';
import { COMMANDS } from './lib/interactions.mjs';
import { graduationEvents } from './lib/graduation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const configPath = option('config', path.join(here, 'config.json'));
const config = loadConfig(configPath);
const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

function cmdIngest() {
  const file = positional[0];
  if (!file) die('usage: cli.mjs ingest <file.xlsx>');
  if (!fs.existsSync(file)) die(`no such file: ${file}`);
  const res = ingestFile(file, config, { force: flag('force') });
  if (!res.applied) {
    console.log(`skipped ${res.asOf}: ${res.reason} (use --force to replace)`);
    return;
  }
  const s = res.snapshot;
  console.log(`ingested ${path.basename(file)}`);
  console.log(`  as of        ${s.asOf} (period ${s.periodStart} ~ ${s.asOf})`);
  console.log(`  active rows  ${s.active.length}`);
  console.log(`  quit rows    ${s.quit.length}`);
  const info = rebuildSeries(config);
  console.log(`  series now   ${info.creators} creators over ${info.snapshots} snapshot(s)`);
}

function cmdReport() {
  const result = analyse(config, { asOf: option('as-of'), persist: !flag('dry') });
  const digests = buildDigests(result, config);

  if (flag('json')) {
    console.log(JSON.stringify({ ...toJson(result), digests }, null, 2));
    return;
  }

  console.log(renderNetworkSummary({ ...result, config }));
  console.log(`\n${'='.repeat(64)}\n`);
  const only = option('coach');
  for (const d of digests) {
    if (only && d.coach !== only) continue;
    console.log(d.text);
    console.log(`\n${'-'.repeat(64)}\n`);
  }
  if (!digests.length) console.log('Nothing to report — no creator crossed a threshold today.');
}

function cmdCoach() {
  const coach = positional[0];
  if (!coach) die('usage: cli.mjs coach <manager-email>');
  const result = analyse(config, { asOf: option('as-of'), persist: false });
  const d = buildDigests(result, config).find((x) => x.coach === coach.toLowerCase());
  console.log(d ? d.text : `Nothing to send ${coach} today.`);
}

function cmdCreator() {
  const name = positional[0];
  if (!name) die('usage: cli.mjs creator <username>');
  const store = new Store(config.dataDir);
  const series = store.readSeries();
  const c = Object.values(series.creators).find(
    (x) => x.username.toLowerCase() === name.toLowerCase() || x.creatorId === name);
  if (!c) die(`creator not found: ${name}`);
  const asOf = option('as-of', series.lastAsOf);
  const m = computeMetrics(c, asOf);
  console.log(`@${c.username}  id=${c.creatorId ?? '—'}  ${c.group ?? 'no group'}  coach=${c.manager ?? '—'}`);
  console.log(`joined ${c.joinDate ?? '—'} (day ${m.daysSinceJoining ?? '—'})  tracked since ${c.firstSeen}${c.quitOn ? `  QUIT ${c.quitOn}` : ''}`);
  console.log(`tier ${tierOf(m, config.tiers)}  history ${m.historyDays}d  dark streak ${m.darkStreak}d`);
  console.log('');
  const row = (label, cur, prev) => console.log(
    `  ${label.padEnd(20)} ${String(Math.round(cur)).padStart(10)}  prev7 ${String(Math.round(prev)).padStart(10)}`);
  row('diamonds 7d', m.curr7.diamonds, m.prev7.diamonds);
  row('live hours 7d', m.curr7.liveHours, m.prev7.liveHours);
  row('live days 7d', m.curr7.validLiveDays, m.prev7.validLiveDays);
  row('fan club dmd 7d', m.curr7.fanClubDiamonds, m.prev7.fanClubDiamonds);
  console.log(`  diamonds/hour        7d ${m.diamondsPerHour7 ? Math.round(m.diamondsPerHour7) : '—'}   28d ${m.diamondsPerHour28 ? Math.round(m.diamondsPerHour28) : '—'}`);
  console.log(`  active fan club      ${m.fanClub.activeFans ?? '—'} (7d ${m.fanClub.activeFansChange7 == null ? '—' : `${Math.round(m.fanClub.activeFansChange7 * 100)}%`})`);
  console.log('\n  observations:');
  for (const o of c.obs.slice(-14)) {
    console.log(`    ${o.date} span=${o.span}${o.partial ? ' partial' : ''}${o.restated ? ' restated' : ''}  +${Math.round(o.delta.diamonds)} diamonds, +${o.delta.liveHours.toFixed(1)}h, +${o.delta.validLiveDays} live days`);
  }
}

function cmdRebuild() {
  const info = rebuildSeries(config);
  console.log(`rebuilt: ${info.creators} creators from ${info.snapshots} snapshots, latest ${info.lastAsOf}`);
}

function cmdStatus() {
  const store = new Store(config.dataDir);
  const dates = store.listSnapshotDates();
  const series = store.readSeries();
  console.log(`data dir   ${config.dataDir}`);
  console.log(`snapshots  ${dates.length}${dates.length ? ` (${dates[0]} ${dates[dates.length - 1]})` : ''}`);
  console.log(`creators   ${Object.keys(series.creators).length}`);
  if (!dates.length) return;

  const missing = [];
  for (let d = dates[0]; d < dates.at(-1);) {
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    if (!dates.includes(d) && d < dates.at(-1)) missing.push(d);
  }
  console.log(`missing    ${missing.length ? `${missing.length} day(s) with no upload` : 'none'}`);

  // Week-on-week needs real daily readings in both windows, so say plainly how
  // close the data is to supporting decline detection rather than leaving the
  // first fortnight looking broken.
  const need = config.decline.eligibility.minExactDaysPerWindow ?? 5;
  const sample = Object.values(series.creators).filter((c) => !c.quitOn).slice(0, 200);
  const ready = sample.filter((c) => {
    const m = computeMetrics(c, series.lastAsOf);
    return m.exact.curr7 >= need && m.exact.prev7 >= need;
  }).length;
  const exactDays = new Set();
  for (const c of sample) for (const o of c.obs) if (o.span === 1 && !o.partial) exactDays.add(o.date);
  console.log('');
  if (ready > sample.length * 0.5) {
    console.log(`decline detection  ON — ${ready}/${sample.length} sampled creators have enough daily readings`);
  } else {
    const have = exactDays.size;
    const short = Math.max(1, (need * 2) - have);
    console.log(`decline detection  NOT YET — needs ${need} real daily readings in each of two`);
    console.log(`                   consecutive weeks. ${have} exact day(s) so far;`);
    console.log(`                   about ${short} more daily upload(s) to go.`);
    console.log(`                   The 200k tracker and month-on-month work already.`);
  }
}

// --- the daily run and the caseload -----------------------------------------

const STATE_LABEL = {
  [STATUS.OPEN]: 'open', [STATUS.ACKNOWLEDGED]: 'picked up', [STATUS.ACTIONED]: 'actioned',
  [STATUS.RESOLVED]: 'resolved', [STATUS.SNOOZED]: 'snoozed', [STATUS.LOST]: 'left',
};

async function cmdRun() {
  const dry = flag('dry');
  const { result, changes, delivery, cases } = await runDaily(config, configPath, {
    asOf: option('as-of'), dryRun: dry, forceSummary: flag('force-overview'),
  });

  console.log(`daily run — ${result.asOf}${dry ? '  (dry run, nothing sent or saved)' : ''}`);
  console.log(`  opened        ${changes.opened.length} (${changes.opened.filter((c) => c.kind === 'decline').length} declines, ${changes.opened.filter((c) => c.kind === 'opportunity').length} opportunities)`);
  console.log(`  worsened      ${changes.worsened.length}`);
  console.log(`  follow-ups    ${changes.dueFollowUps.length}`);
  console.log(`  escalated     ${changes.escalated.length}`);
  console.log(`  auto-resolved ${changes.autoResolved.length}`);
  if (changes.deferred?.length) {
    console.log(`  deferred      ${changes.deferred.length} (coaches at their case limit)`);
  }
  console.log(`  caseload      ${cases.open} open · ${cases.acknowledged} picked up · ${cases.actioned} actioned · ${cases.snoozed} snoozed`);

  if (delivery.skipped) {
    console.log(`\n  Discord: skipped — ${delivery.skipped}`);
  } else if (!delivery.sent.length) {
    console.log('\n  Discord: nothing configured (see routes.example.json)');
  } else {
    if (delivery.warning) console.log(`\n  Discord: ${delivery.warning}`);
    const failed = delivery.sent.filter((x) => !x.ok);
    // A skipped overview is not a delivery, and counting it as one makes a
    // quiet second run look like it posted something.
    const skipped = delivery.sent.filter((x) => x.ok && x.skipped);
    const delivered = delivery.sent.filter((x) => x.ok && !x.skipped);
    console.log(`\n  Discord: ${delivered.length} message(s)${dry ? ' previewed' : ' sent'}${failed.length ? `, ${failed.length} failed` : ''}`);
    for (const x of skipped) console.log(`    · ${x.label} skipped — ${x.skipped}`);
    for (const f of failed.slice(0, 5)) console.log(`    ${f.label} ${f.coach}: ${f.error}`);
  }
  if (dry && flag('preview')) {
    for (const p of delivery.previews.slice(0, Number(option('limit', 3)))) {
      console.log(`\n--- ${p.label} ${p.coach} ---`);
      console.log(JSON.stringify(p.payload, null, 2));
    }
  }
}

function cmdCases() {
  const store = new CaseStore(config.dataDir);
  const coach = option('coach');
  const rows = store.all()
    .filter((c) => (flag('all') ? true : isOpen(c)))
    .filter((c) => !coach || c.coach === coach.toLowerCase())
    .sort((a, b) => b.valueAtRisk - a.valueAtRisk || a.openedOn.localeCompare(b.openedOn));
  if (!rows.length) return console.log(coach ? `No cases for ${coach}.` : 'No open cases.');
  console.log(`${rows.length} case${rows.length === 1 ? '' : 's'}\n`);
  for (const c of rows) {
    const book = PLAYBOOK[c.playbookId];
    console.log(`${(STATE_LABEL[c.status] ?? c.status).padEnd(10)} ${c.id.padEnd(16)} @${c.username.padEnd(22)} ${(book?.title ?? c.playbookId).padEnd(28)} ${c.coach}`);
    console.log(`   opened ${c.openedOn}${c.followUpOn ? ` · follow-up ${c.followUpOn}` : ''}${c.valueAtRisk ? ` · ~${c.valueAtRisk.toLocaleString('en-GB')} at risk` : ''}${c.outcome ? ` · ${VERDICT_LABEL[c.outcome.verdict]}` : ''}`);
  }
}

function cmdCase() {
  const id = positional[0];
  if (!id) die('usage: cli.mjs case <case-id>');
  const store = new CaseStore(config.dataDir);
  const c = store.get(id);
  if (!c) die(`no such case: ${id}`);
  const book = PLAYBOOK[c.playbookId];
  console.log(`${c.id}  @${c.username}  ${c.kind}`);
  console.log(`  coach     ${c.coach}   group ${c.group ?? '—'}`);
  console.log(`  status    ${STATE_LABEL[c.status] ?? c.status}${c.followUpOn ? ` (follow-up ${c.followUpOn})` : ''}`);
  console.log(`  opened    ${c.openedOn}   signals: ${c.signals.join(', ')}`);
  console.log(`  concern   ${book?.title ?? c.playbookId} — ${book?.concern ?? ''}`);
  for (const cause of c.causes ?? []) {
    const tag = cause.kind === 'lever' ? 'lever' : cause.confidence;
    console.log(`\n  [${tag}] ${cause.label}`);
    for (const e of cause.evidence) console.log(`     · ${e}`);
    if (cause.kind !== 'lever') {
      for (const a of cause.ask) console.log(`     ? ${a}`);
    }
  }
  if (c.outcome) console.log(`  outcome   ${VERDICT_LABEL[c.outcome.verdict] ?? c.outcome.verdict} on ${c.outcome.on}`);
  console.log('\n  history:');
  for (const h of c.history) {
    console.log(`    ${h.at.slice(0, 16).replace('T', ' ')}  ${h.event.padEnd(14)} ${h.by}${h.note ? ` — ${h.note}` : ''}`);
  }
}

function cmdEffectiveness() {
  const store = new CaseStore(config.dataDir);
  const { byPlaybook, byCoach } = effectiveness(store);
  const entries = Object.entries(byPlaybook);
  if (!entries.length) {
    return console.log('No graded outcomes yet. Cases are graded once their follow-up window closes.');
  }
  const anyLogged = Object.values(byPlaybook).some((p) => p.acted.total > 0);
  console.log('Which interventions work\n');
  if (!anyLogged) {
    // Without button clicks nothing records that a coach acted, so every case
    // lands in "left alone" and the lift column would be a lie.
    console.log('   No coach actions are being logged, so there is no control group and');
    console.log('     nothing here separates coaching from natural recovery. What you are');
    console.log('     seeing is the recovery rate after a creator was flagged, whoever did');
    console.log('     what. For per-team outcomes use: cli.mjs teams\n');
  } else {
    console.log('  "coached" is cases where a coach logged an action. "left alone" is the');
    console.log('  rest — the share that came back without anyone doing anything. The gap');
    console.log('  between them is what the coaching is actually worth.\n');
  }
  const pc = (x) => (x == null ? '   —' : `${Math.round(x * 100)}%`.padStart(4));
  console.log(`  ${'intervention'.padEnd(28)} ${'coached'.padStart(8)} ${'rate'.padStart(5)}  ${'left alone'.padStart(10)} ${'rate'.padStart(5)}  ${'lift'.padStart(5)}`);
  for (const [id, p] of entries.sort((a, b) => (b[1].acted.total + b[1].untouched.total) - (a[1].acted.total + a[1].untouched.total))) {
    const title = PLAYBOOK[id]?.title ?? id;
    console.log(`  ${title.padEnd(28)} ${String(p.acted.total).padStart(8)} ${pc(p.successRate)}  ${String(p.untouched.total).padStart(10)} ${pc(p.baselineRate)}  ${p.lift == null ? '    —' : `${p.lift > 0 ? '+' : ''}${Math.round(p.lift * 100)}%`.padStart(5)}`);
  }
  console.log('\nBy coach\n');
  console.log(`  ${'coach'.padEnd(34)} cases  picked up  actioned  fixed after acting  median pickup`);
  for (const [coach, b] of Object.entries(byCoach).sort((a, b) => b[1].cases - a[1].cases)) {
    console.log(`  ${coach.padEnd(34)} ${String(b.cases).padStart(5)}  ${String(b.acknowledged).padStart(9)}  ${String(b.actioned).padStart(8)}  ${String(b.recoveredAfterAction).padStart(18)}  ${(b.medianPickupDays == null ? '—' : `${b.medianPickupDays}d`).padStart(13)}`);
  }
}

async function cmdDiscordRegister() {
  const { discord } = loadRoutes(path.dirname(configPath));
  if (!discord.botToken || !discord.applicationId) {
    die('DISCORD_BOT_TOKEN and DISCORD_APP_ID must be set (see routes.example.json)');
  }
  const res = await fetch(`https://discord.com/api/v10/applications/${discord.applicationId}/commands`, {
    method: 'PUT',
    headers: { authorization: `Bot ${discord.botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(COMMANDS),
  });
  const body = await res.text();
  if (!res.ok) die(`Discord refused the registration (HTTP ${res.status}): ${body.slice(0, 300)}`);
  console.log(`registered ${COMMANDS.length} slash command(s): ${COMMANDS.map((c) => `/${c.name}`).join(', ')}`);
}

/**
 * Write a routes.json skeleton from the teams that actually exist in the data,
 * so nobody has to hand-transcribe a server's worth of channel IDs and guess
 * at the spellings the export uses.
 */
function cmdDiscordScaffold() {
  const series = new Store(config.dataDir).readSeries();
  const creators = Object.values(series.creators);
  const { groups } = coverage(creators, { groups: {} });
  const existing = fs.existsSync(path.join(path.dirname(configPath), 'routes.json'))
    ? JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'routes.json'), 'utf8'))
    : {};
  const prevGroups = existing.discord?.groups ?? {};
  const prevCoaches = existing.discord?.coaches ?? {};

  const webhookMode = flag('webhooks') || existing.discord?.mode === 'webhook';
  const slot = (g) => (webhookMode
    ? { webhook: `PASTE_WEBHOOK_URL  (${g.creators} creators)` }
    : { channelId: `PASTE_CHANNEL_ID  (${g.creators} creators)` });

  const out = {
    discord: {
      enabled: true,
      mode: webhookMode ? 'webhook' : 'bot',
      routeBy: 'group',
      ...(webhookMode
        ? { _webhooks: 'Channel Edit Channel Integrations Webhooks New Webhook Copy URL.' }
        : {
          botToken: 'env:DISCORD_BOT_TOKEN',
          publicKey: 'env:DISCORD_PUBLIC_KEY',
          applicationId: 'env:DISCORD_APP_ID',
        }),
      escalation: existing.discord?.escalationWebhook ?? existing.discord?.escalationChannelId
        ? undefined : undefined,
      ...(webhookMode
        ? {
          escalationWebhook: existing.discord?.escalationWebhook ?? 'PASTE_MANAGERS_WEBHOOK_URL',
          summaryWebhook: existing.discord?.summaryWebhook ?? 'PASTE_SUMMARY_WEBHOOK_URL',
        }
        : {
          escalationChannelId: existing.discord?.escalationChannelId ?? 'PASTE_MANAGERS_CHANNEL_ID',
          summaryChannelId: existing.discord?.summaryChannelId ?? 'PASTE_SUMMARY_CHANNEL_ID',
        }),
      groups: {},
      coaches: {},
    },
  };
  delete out.discord.escalation;
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  for (const g of groups) {
    // Teams on the ignore list need no channel — say so rather than leaving a
    // placeholder that looks like unfinished work.
    if (ignored.has(groupKey(g.label))) continue;
    out.discord.groups[g.label] = prevGroups[g.label] ?? slot(g);
  }
  if (ignored.size) {
    out.discord._ignoredTeams = `Not routed, by choice (config.json monitoring.ignoreGroups): ${
      groups.filter((g) => ignored.has(groupKey(g.label))).map((g) => `${g.label} (${g.creators})`).join(', ')}`;
  }
  // Coaches carry the @mention only: the channel comes from their team.
  const coaches = new Set(creators.filter((c) => !c.quitOn && c.manager).map((c) => c.manager));
  for (const email of [...coaches].sort()) {
    out.discord.coaches[email] = prevCoaches[email] ?? { mention: 'PASTE_DISCORD_USER_MENTION' };
  }

  const json = JSON.stringify(out, null, 2);
  if (!flag('write')) {
    console.log(json);
    console.log(`\n# ${groups.length} team(s), ${coaches.size} coach(es).`);
    console.log('# Re-run with --write to save to routes.json (existing IDs are kept).');
    return;
  }
  fs.writeFileSync(path.join(path.dirname(configPath), 'routes.json'), `${json}\n`);
  console.log(`wrote routes.json — ${groups.length} team(s), ${coaches.size} coach(es)`);
  console.log('Fill in the channel IDs, then run: node cli.mjs discord-check');
}

/**
 * Turn a filled-in routes.json into environment variables plus a routes file
 * that holds no secrets.
 *
 * routes.json is gitignored — correctly, it holds webhook URLs, and anyone with
 * one can post to that channel. But that means it is not in the repo and does
 * not reach a deploy. This prints the two halves: the variables to set on the
 * host, and a routes file safe to commit that refers to them.
 */
function cmdDiscordEnv() {
  const file = path.join(path.dirname(configPath), 'routes.json');
  if (!fs.existsSync(file)) die('no routes.json — run: cli.mjs discord-scaffold --write');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = raw.discord ?? {};
  const env = [];
  const safe = JSON.parse(JSON.stringify(raw));

  const varName = (label) => `DISCORD_WEBHOOK_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  const lift = (obj, key, name) => {
    const v = obj?.[key];
    if (typeof v !== 'string' || v.startsWith('env:') || v.startsWith('PASTE_')) return;
    env.push([name, v]);
    obj[key] = `env:${name}`;
  };

  lift(safe.discord, 'summaryWebhook', 'DISCORD_WEBHOOK_OVERVIEW');
  lift(safe.discord, 'escalationWebhook', 'DISCORD_WEBHOOK_ESCALATION');
  lift(safe.discord, 'inactiveWebhook', 'DISCORD_WEBHOOK_INACTIVE');
  lift(safe.discord, 'botToken', 'DISCORD_BOT_TOKEN');
  for (const [label, entry] of Object.entries(safe.discord?.groups ?? {})) {
    lift(entry, 'webhook', varName(label));
  }
  for (const [label, entry] of Object.entries(safe.discord?.teamSummaries ?? {})) {
    lift(entry, 'webhook', `DISCORD_SUMMARY_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`);
  }
  for (const [email, entry] of Object.entries(safe.discord?.coaches ?? {})) {
    lift(entry, 'webhook', varName(email.split('@')[0]));
  }
  void d;

  if (!env.length) {
    console.log('Nothing to lift — routes.json already refers to environment variables only.');
    return;
  }
  console.log('# Set these on the host (Render: Environment Add Environment Variable).');
  console.log('# Treat them like passwords: a webhook URL is enough to post to that channel.\n');
  for (const [k, v] of env) console.log(`${k}=${v}`);
  console.log(`\n# --- routes.deploy.json (safe to commit: no secrets) ---`);
  console.log(JSON.stringify(safe, null, 2));
  if (flag('write')) {
    fs.writeFileSync(path.join(path.dirname(configPath), 'routes.deploy.json'), `${JSON.stringify(safe, null, 2)}\n`);
    console.log('\n# wrote routes.deploy.json');
  }
}

/** Does every team actually have somewhere for its cards to land? */
function cmdDiscordCheck() {
  const { discord } = loadRoutes(path.dirname(configPath));
  const creators = Object.values(new Store(config.dataDir).readSeries().creators);
  const report = coverage(creators, discord);

  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  console.log(`routing by: ${discord.routeBy ?? 'group'}\n`);
  console.log(`  ${'team'.padEnd(20)} ${'creators'.padStart(8)}  destination`);
  let ignoredCreators = 0;
  const live = [];
  for (const g of report.groups) {
    if (ignored.has(groupKey(g.label))) {
      ignoredCreators += g.creators;
      console.log(`  ${g.label.padEnd(20)} ${String(g.creators).padStart(8)}  — not monitored`);
      continue;
    }
    live.push(g);
    const sample = creators.find((c) => !c.quitOn && (c.group ?? '') === (g.label === '(no group)' ? null : g.label));
    const route = routeFor({ coach: sample?.manager, group: g.label }, discord);
    const dest = route.webhook ? `webhook …${route.webhook.slice(-6)}`
      : route.channelId ? `channel ${route.channelId}`
        : route.userId ? 'DM' : ' NOWHERE';
    const via = route.matchedGroup ? '' : route.matchedCoach ? ' (via coach)' : route.viaDefault ? ' (default)' : '';
    console.log(`  ${g.label.padEnd(20)} ${String(g.creators).padStart(8)}  ${dest}${via}`);
    if (g.coaches.length > 1) {
      console.log(`  ${''.padEnd(20)} ${''.padStart(8)}  ${g.coaches.length} coaches share this channel: ${g.coaches.join(', ')}`);
    }
  }

  const noMention = [...new Set(creators
    .filter((c) => !c.quitOn && c.manager && !ignored.has(groupKey(c.group)))
    .map((c) => c.manager))]
    .filter((e) => !discord.coaches?.[e]?.mention);
  const missing = report.unrouted.filter((g) => !ignored.has(groupKey(g.label)));
  const missingCreators = missing.reduce((n, g) => n + g.creators, 0);
  console.log('');
  if (missing.length) {
    console.log(` ${missing.length} monitored team(s) with no channel, covering ${missingCreators} creators:`);
    for (const g of missing) console.log(`     ${g.label} (${g.creators})`);
    console.log('   They fall back to the default channel, or go nowhere if there is not one.');
  } else {
    console.log(`every monitored team has a destination (${live.length} team(s))`);
  }
  const sum = Object.values(discord.teamSummaries ?? {}).filter((g) => g.webhook || g.channelId).length;
  console.log(sum
    ? `\ndaily team summary: ${sum} of ${live.length} monitored team(s) have a channel`
    : '\ndaily team summary: no channels set — no summaries are posted');
  console.log(discord.inactiveWebhook
    ? `\ncreators earning nothing: one shared channel, webhook …${discord.inactiveWebhook.slice(-6)}`
    : '\ncreators earning nothing: no shared channel set — they go to the team channels');
  if (ignoredCreators) {
    console.log(`\nℹ ${ignoredCreators} creator(s) in ${ignored.size} team(s) are not monitored by choice.`);
    console.log('   Their data still accrues — remove them from monitoring.ignoreGroups to switch them on.');
  }
  if (noMention.length) {
    console.log(`\nℹ ${noMention.length} coach(es) with no @mention set — their cards post without a ping:`);
    for (const e of noMention) console.log(`     ${e}`);
  }
}

/** The 200k chase, as it stands, without waiting for a post. */
function cmdGraduation() {
  const { ramp, asOf } = analyse(config, { asOf: option('as-of'), persist: false });
  const store = new CaseStore(config.dataDir);
  // persist:false so looking never spends a milestone card.
  const { rows } = graduationEvents({ ramp, store, asOf, config, persist: false });
  if (!rows.length) return console.log('Nobody inside their 90-day window.');

  const done = rows.filter((r) => r.done);
  const live = rows.filter((r) => !r.done).sort((a, b) => a.remaining - b.remaining);
  console.log(`200k graduation as of ${asOf} — ${rows[0].daysLeft} day(s) left in the month\n`);
  console.log(`  ${done.length} graduated, ${live.length} still chasing, of ${rows.length} inside their 90 days`);
  const band = (lo, hi) => live.filter((r) => r.remaining > lo && r.remaining <= hi).length;
  console.log(`  within 10k: ${band(0, 10000)} · 25k: ${band(10000, 25000)} · 50k: ${band(25000, 50000)} · 100k: ${band(50000, 100000)}\n`);

  const limit = Number(option('limit', 20));
  console.log(`  ${'creator'.padEnd(22)}${'to go'.padStart(10)}${'doing'.padStart(9)}${'needs'.padStart(9)}${'day'.padStart(6)}  team`);
  for (const r of live.slice(0, limit)) {
    console.log(`  ${('@' + r.username).padEnd(22)}${r.remaining.toLocaleString().padStart(10)}`
      + `${r.perDay.toLocaleString().padStart(9)}${(r.requiredPerDay ?? 0).toLocaleString().padStart(9)}`
      + `${String(r.day).padStart(6)}  ${r.group ?? '—'}`);
  }
  if (done.length) {
    console.log(`\n  graduated this month: ${done.map((r) => `@${r.username} (${r.monthToDate.toLocaleString()})`).join(', ')}`);
  }
}

function cmdTeams() {
  const store = new CaseStore(config.dataDir);
  const asOf = new SeriesStore(config.dataDir).readSeries().lastAsOf
    ?? new Date().toISOString().slice(0, 10);
  const rows = teamOutcomes(store, { now: asOf });
  if (!rows.length) return console.log('No decline cases yet.');

  console.log(`How each team's flagged creators actually turned out (as of ${asOf})\n`);
  console.log(`  ${'team'.padEnd(18)} ${'opened'.padStart(6)} ${'open'.padStart(5)} ${'fixed'.padStart(6)} ${'stale'.padStart(6)} ${'left'.padStart(5)}  ${'fixed%'.padStart(7)}  median days  oldest open`);
  for (const r of rows) {
    const pc = (x) => (x == null ? '     —' : `${Math.round(x * 100)}%`.padStart(6));
    console.log(`  ${r.team.slice(0, 18).padEnd(18)} ${String(r.opened).padStart(6)} ${String(r.open).padStart(5)} ${String(r.recovered).padStart(6)} ${String(r.wentStale).padStart(6)} ${String(r.lost).padStart(5)}  ${pc(r.recoveryRate)}  ${String(r.medianDaysToRecover ?? '—').padStart(11)}  ${String(r.oldestOpenDays || '—').padStart(11)}`);
  }
  console.log('');
  console.log('  fixed  = the creator came back to their normal');
  console.log('  stale  = the case ran to the limit still down — nothing worked, or nothing was tried');
  const worrying = rows.filter((r) => r.closed >= 3 && (r.staleRate ?? 0) > 0.6);
  if (worrying.length) {
    console.log(`\n ${worrying.length} team(s) where most flagged creators never recovered:`);
    for (const r of worrying) {
      console.log(`     ${r.team} — ${r.wentStale}/${r.closed} went stale (${r.coaches.join(', ')})`);
    }
  }
}

function cmdSnooze() {
  const [id, days, ...rest] = positional;
  if (!id || !days) die('usage: cli.mjs snooze <case-id> <days> [reason]');
  const store = new CaseStore(config.dataDir);
  const asOf = new SeriesStore(config.dataDir).readSeries().lastAsOf
    ?? new Date().toISOString().slice(0, 10);
  const res = snooze(store, id, option('by', 'cli'), Number(days), rest.join(' ') || null, asOf);
  if (!res.ok) die(res.error);
  console.log(`${id} @${res.case.username} snoozed until ${res.case.snoozedUntil}`);
}

function cmdClose() {
  const [id, ...rest] = positional;
  if (!id) die('usage: cli.mjs close <case-id> [note]');
  const store = new CaseStore(config.dataDir);
  const res = resolve(store, id, option('by', 'cli'), rest.join(' ') || 'closed from the CLI');
  if (!res.ok) die(res.error);
  console.log(`${id} @${res.case.username} closed`);
}

const commands = {
  ingest: cmdIngest, report: cmdReport, coach: cmdCoach,
  creator: cmdCreator, rebuild: cmdRebuild, status: cmdStatus,
  run: cmdRun, cases: cmdCases, case: cmdCase,
  effectiveness: cmdEffectiveness, 'discord-register': cmdDiscordRegister,
  'discord-scaffold': cmdDiscordScaffold, 'discord-check': cmdDiscordCheck,
  'discord-env': cmdDiscordEnv,
  teams: cmdTeams, graduation: cmdGraduation, snooze: cmdSnooze, close: cmdClose,
};

if (!command || !commands[command]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').slice(2, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(command ? 1 : 0);
}
try {
  await commands[command]();
} catch (err) {
  // A stack trace is no use to whoever runs this every morning.
  console.error(`error: ${err.message}`);
  if (process.env.CH_DEBUG) console.error(err.stack);
  process.exit(1);
}
