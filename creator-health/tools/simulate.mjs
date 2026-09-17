#!/usr/bin/env node
// Generates a synthetic history so the rules can be exercised before the real
// daily uploads have accumulated. It seeds from a real export, gives every
// creator a plausible daily rhythm, then pushes a slice of them into decline.
//
//   node tools/simulate.mjs <real-export.xlsx> [--days 60] [--out ./data-sim] [--seed 7]
//
// The output is snapshot files in the normal format, so `cli.mjs report
// --config` against the simulated data dir behaves exactly like production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSheetObjects } from '../lib/xlsx.mjs';
import { normalizeExport } from '../lib/normalize.mjs';
import { Store } from '../lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const source = argv.find((a) => !a.startsWith('--') && a.endsWith('.xlsx'));
if (!source) { console.error('usage: simulate.mjs <export.xlsx> [--days 60] [--out DIR]'); process.exit(1); }

const DAYS = Number(opt('days', 60));
const OUT = path.resolve(here, '..', opt('out', './data-sim'));
let seed = Number(opt('seed', 7));
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const jitter = (spread) => 1 + (rand() - 0.5) * 2 * spread;

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (d) => Date.parse(`${d}T00:00:00Z`);
const shift = (d, n) => iso(ts(d) + n * 86400000);
const monthStart = (d) => `${d.slice(0, 7)}-01`;

const { records } = readSheetObjects(source);
const snap = normalizeExport(records);
const observedDays = Math.max(1, Math.round((ts(snap.asOf) - ts(snap.periodStart)) / 86400000) + 1);
const endDate = snap.asOf;
const startDate = shift(endDate, -(DAYS - 1));

// Each creator gets a profile: their observed month-to-date output spread over
// the days it covers, plus how often they actually go live.
const profiles = snap.active.map((row) => {
  const liveRatio = Math.min(1, Math.max(0.05, (row.mtd.validLiveDays || 0) / observedDays));
  const perLiveDay = row.mtd.validLiveDays > 0 ? row.mtd.diamonds / row.mtd.validLiveDays : 0;
  const hoursPerLiveDay = row.mtd.validLiveDays > 0 ? row.mtd.liveHours / row.mtd.validLiveDays : 0;
  return {
    row,
    liveRatio,
    perLiveDay,
    hoursPerLiveDay: hoursPerLiveDay || 1.5,
    fanShare: row.mtd.diamonds > 0 ? row.mtd.fanClubDiamonds / row.mtd.diamonds : 0.9,
    followersPerDay: (row.mtd.newFollowers || 0) / observedDays,
    fansPerDay: (row.mtd.newFans || 0) / observedDays,
    streamsPerLiveDay: row.mtd.validLiveDays > 0 ? row.mtd.liveStreams / row.mtd.validLiveDays : 1,
    totalFans: row.level.totalFans ?? 0,
    activeFans: row.level.activeFanClubFans ?? 0,
    // A realistic slice of the network slides at any one time.
    decline: null,
  };
});

// Push ~10% of the creators who actually earn into a decline that begins
// somewhere in the last three weeks, so alerts land at different stages.
const earners = profiles.filter((p) => p.perLiveDay > 200 && p.liveRatio > 0.3);
const declining = Math.round(earners.length * 0.1);
for (let i = 0; i < declining; i++) {
  const p = earners[Math.floor(rand() * earners.length)];
  if (p.decline) continue;
  p.decline = {
    startsOn: shift(endDate, -Math.floor(2 + rand() * 19)),
    // three shapes: stops going live, shortens sessions, or the room goes quiet
    kind: ['attendance', 'hours', 'conversion'][Math.floor(rand() * 3)],
    depth: 0.4 + rand() * 0.45,
  };
}

function dailyFor(p, date) {
  let liveChance = p.liveRatio;
  let hours = p.hoursPerLiveDay;
  let rate = p.perLiveDay / (p.hoursPerLiveDay || 1);
  if (p.decline && date >= p.decline.startsOn) {
    const elapsed = (ts(date) - ts(p.decline.startsOn)) / 86400000;
    const ramp = Math.min(1, (elapsed + 1) / 7);
    const f = 1 - p.decline.depth * ramp;
    if (p.decline.kind === 'attendance') liveChance *= f;
    else if (p.decline.kind === 'hours') hours *= f;
    else rate *= f;
  }
  const isLive = rand() < liveChance;
  if (!isLive) return { diamonds: 0, liveHours: 0, validLiveDays: 0, liveStreams: 0,
    newFollowers: Math.round(p.followersPerDay * 0.2 * jitter(0.5)), newFans: 0, fanClubDiamonds: 0 };
  const h = Math.max(0.2, hours * jitter(0.35));
  const d = Math.max(0, Math.round(h * rate * jitter(0.5)));
  return {
    diamonds: d,
    liveHours: h,
    validLiveDays: 1,
    liveStreams: Math.max(1, Math.round(p.streamsPerLiveDay * jitter(0.3))),
    newFollowers: Math.round(p.followersPerDay * jitter(0.6)),
    newFans: Math.round(p.fansPerDay * jitter(0.8)),
    fanClubDiamonds: Math.round(d * p.fanShare * jitter(0.08)),
  };
}

// Walk forward day by day, accumulating month-to-date exactly as the real
// export does, and write one snapshot per day.
const store = new Store(OUT);
const mtd = new Map();
const monthTotals = new Map();
const fanState = new Map(profiles.map((p) => [p.row.username, { total: p.totalFans, active: p.activeFans }]));
let currentMonth = null;
let lastMonthDiamonds = new Map();

const FIELDS = ['diamonds', 'liveHours', 'validLiveDays', 'liveStreams', 'newFollowers', 'newFans', 'fanClubDiamonds'];

for (let i = 0; i < DAYS; i++) {
  const date = shift(startDate, i);
  const ms = monthStart(date);
  if (ms !== currentMonth) {
    lastMonthDiamonds = new Map(monthTotals);
    monthTotals.clear();
    mtd.clear();
    currentMonth = ms;
  }
  const active = [];
  for (const p of profiles) {
    const u = p.row.username;
    const day = dailyFor(p, date);
    const acc = mtd.get(u) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]));
    for (const f of FIELDS) acc[f] += day[f];
    mtd.set(u, acc);
    monthTotals.set(u, (monthTotals.get(u) ?? 0) + day.diamonds);

    const fans = fanState.get(u);
    fans.total += day.newFollowers > 0 ? Math.round(day.newFans) : 0;
    // Active fan-club membership drifts with how the week has gone.
    const drift = day.validLiveDays ? 1 + (rand() - 0.35) * 0.06 : 1 - rand() * 0.04;
    fans.active = Math.max(0, Math.round(fans.active * drift));

    const joinDate = p.row.joinDate;
    active.push({
      creatorId: p.row.creatorId,
      username: u,
      periodStart: ms,
      asOf: date,
      group: p.row.group,
      manager: p.row.manager,
      joinDate,
      daysSinceJoining: joinDate ? Math.round((ts(date) - ts(joinDate)) / 86400000) : null,
      mtd: { ...acc },
      level: {
        totalFans: fans.total,
        activeFanClubFans: fans.active,
        fanContribution: acc.diamonds > 0 ? acc.fanClubDiamonds / acc.diamonds : null,
      },
      lastMonth: {
        diamonds: lastMonthDiamonds.get(u) ?? null,
        liveHours: null,
        validLiveDays: null,
      },
      quit: false,
      graduationStatus: p.row.graduationStatus,
      tierStatus: p.row.tierStatus,
      isNewLiveCreator: p.row.isNewLiveCreator,
    });
  }
  store.writeSnapshot({ asOf: date, periodStart: ms, active, quit: [], skipped: 0,
    sourceFile: `simulated from ${path.basename(source)}`, ingestedAt: new Date().toISOString() });
}

// Record which creators were pushed and when, so detection can be scored.
fs.writeFileSync(path.join(OUT, 'truth.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  endDate,
  declines: profiles.filter((p) => p.decline).map((p) => ({
    username: p.row.username,
    manager: p.row.manager,
    startsOn: p.decline.startsOn,
    daysIn: Math.round((ts(endDate) - ts(p.decline.startsOn)) / 86400000),
    kind: p.decline.kind,
    depth: Number(p.decline.depth.toFixed(2)),
    baselinePerLiveDay: Math.round(p.perLiveDay),
  })),
}, null, 2));

console.log(`simulated ${DAYS} daily snapshots for ${profiles.length} creators`);
console.log(`  ${startDate} → ${endDate}`);
console.log(`  ${profiles.filter((p) => p.decline).length} creators pushed into decline`);
console.log(`  written to ${OUT}`);
console.log(`\nnext: node cli.mjs rebuild --config ./config.sim.json && node cli.mjs report --config ./config.sim.json`);
