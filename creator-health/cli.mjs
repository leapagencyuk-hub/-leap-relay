#!/usr/bin/env node
// Command line entry point.
//
//   node cli.mjs ingest <file.xlsx> [--force]   store a daily export
//   node cli.mjs report [--as-of DATE] [--json] [--coach EMAIL] [--dry]
//   node cli.mjs coach <email> [--as-of DATE]   one coach's message
//   node cli.mjs creator <username>             one creator's full history
//   node cli.mjs rebuild                        re-derive the series
//   node cli.mjs status                         what is stored
//   node cli.mjs run [--dry]                    daily run: cases + Discord
//   node cli.mjs cases [--coach E] [--all]      the open caseload
//   node cli.mjs case <id>                      one case and its history
//   node cli.mjs effectiveness                  which interventions work
//   node cli.mjs discord-register               register the slash commands
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, ingestFile, rebuildSeries, analyse, buildDigests,
  renderNetworkSummary, toJson, runDaily, CaseStore, effectiveness,
} from './lib/pipeline.mjs';
import { Store } from './lib/store.mjs';
import { computeMetrics, tierOf } from './lib/metrics.mjs';
import { STATUS, isOpen } from './lib/cases.mjs';
import { PLAYBOOK, VERDICT_LABEL } from './lib/playbook.mjs';
import { loadRoutes } from './lib/notify.mjs';
import { COMMANDS } from './lib/interactions.mjs';

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
  console.log(`snapshots  ${dates.length}${dates.length ? ` (${dates[0]} → ${dates[dates.length - 1]})` : ''}`);
  console.log(`creators   ${Object.keys(series.creators).length}`);
  if (dates.length > 1) {
    const missing = [];
    for (let d = dates[0]; d < dates[dates.length - 1];) {
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      if (!dates.includes(d) && d < dates[dates.length - 1]) missing.push(d);
    }
    console.log(`gaps       ${missing.length ? missing.join(', ') : 'none'}`);
  }
}

// --- the daily run and the caseload -----------------------------------------

const STATE_ICON = {
  [STATUS.OPEN]: '⏳', [STATUS.ACKNOWLEDGED]: '🙋', [STATUS.ACTIONED]: '✅',
  [STATUS.RESOLVED]: '🎉', [STATUS.SNOOZED]: '😴', [STATUS.LOST]: '⚪',
};

async function cmdRun() {
  const dry = flag('dry');
  const { result, changes, delivery, cases } = await runDaily(config, configPath, {
    asOf: option('as-of'), dryRun: dry,
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
    console.log(`\n  Discord: ${delivery.sent.length} message(s)${dry ? ' previewed' : ' sent'}${failed.length ? `, ${failed.length} failed` : ''}`);
    for (const f of failed.slice(0, 5)) console.log(`    ✗ ${f.label} → ${f.coach}: ${f.error}`);
  }
  if (dry && flag('preview')) {
    for (const p of delivery.previews.slice(0, Number(option('limit', 3)))) {
      console.log(`\n--- ${p.label} → ${p.coach} ---`);
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
    console.log(`${STATE_ICON[c.status] ?? '•'} ${c.id.padEnd(16)} @${c.username.padEnd(22)} ${(book?.title ?? c.playbookId).padEnd(28)} ${c.coach}`);
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
  console.log(`  status    ${STATE_ICON[c.status] ?? ''} ${c.status}${c.followUpOn ? ` (follow-up ${c.followUpOn})` : ''}`);
  console.log(`  opened    ${c.openedOn}   signals: ${c.signals.join(', ')}`);
  console.log(`  playbook  ${book?.title ?? c.playbookId}`);
  console.log(`            ${book?.ask ?? ''}`);
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
  console.log('Which interventions work\n');
  console.log('  "coached" is cases where a coach logged an action. "left alone" is the');
  console.log('  rest — the share that came back without anyone doing anything. The gap');
  console.log('  between them is what the coaching is actually worth.\n');
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

const commands = {
  ingest: cmdIngest, report: cmdReport, coach: cmdCoach,
  creator: cmdCreator, rebuild: cmdRebuild, status: cmdStatus,
  run: cmdRun, cases: cmdCases, case: cmdCase,
  effectiveness: cmdEffectiveness, 'discord-register': cmdDiscordRegister,
};

if (!command || !commands[command]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').slice(2, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
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
