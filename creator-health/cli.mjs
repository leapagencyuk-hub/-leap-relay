#!/usr/bin/env node
// Command line entry point.
//
//   node cli.mjs ingest <file.xlsx> [--force]   store a daily export
//   node cli.mjs report [--as-of DATE] [--json] [--coach EMAIL] [--dry]
//   node cli.mjs coach <email> [--as-of DATE]   one coach's message
//   node cli.mjs creator <username>             one creator's full history
//   node cli.mjs rebuild                        re-derive the series
//   node cli.mjs status                         what is stored
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, ingestFile, rebuildSeries, analyse, buildDigests,
  renderNetworkSummary, toJson,
} from './lib/pipeline.mjs';
import { Store } from './lib/store.mjs';
import { computeMetrics, tierOf } from './lib/metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const config = loadConfig(option('config', path.join(here, 'config.json')));
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

const commands = {
  ingest: cmdIngest, report: cmdReport, coach: cmdCoach,
  creator: cmdCreator, rebuild: cmdRebuild, status: cmdStatus,
};

if (!command || !commands[command]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split("\n").slice(2, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(command ? 1 : 0);
}
commands[command]();
