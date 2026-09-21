// Ties the stages together: file in, snapshot stored, series updated, rules run,
// digests out. Every stage is idempotent so the same file can be re-uploaded.
import fs from 'node:fs';
import path from 'node:path';
import { readSheetObjects } from './xlsx.mjs';
import { normalizeExport } from './normalize.mjs';
import { Store, applySnapshot } from './store.mjs';
import { computeMetrics } from './metrics.mjs';
import { evaluateDecline } from './rules.mjs';
import { evaluateRamp, spotlight as pickSpotlight } from './ramp.mjs';
import { renderCoachDigest, renderNetworkSummary, toJson } from './digest.mjs';
import { CaseStore, reconcile, effectiveness } from './cases.mjs';
import { dispatch, caseStats } from './dispatch.mjs';
import { loadRoutes } from './notify.mjs';

export function loadConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.dataDir = path.resolve(path.dirname(configPath), cfg.dataDir);
  return cfg;
}

/**
 * Stage 1-2: read an export and store it as a snapshot.
 * Returns `{ applied: false }` when that date is already held, so a repeated
 * upload of the same day is a no-op rather than a double count.
 */
export function ingestFile(filePath, config, { force = false } = {}) {
  const store = new Store(config.dataDir);
  const { headers, records } = readSheetObjects(filePath);
  if (!headers.includes('Creator ID')) {
    throw new Error(`${path.basename(filePath)} does not look like a Creator data export (no "Creator ID" column)`);
  }
  const snapshot = normalizeExport(records);
  if (!snapshot.asOf) throw new Error('could not read a "Data period" from the export');

  const already = store.hasSnapshot(snapshot.asOf);
  if (already && !force) {
    return { applied: false, asOf: snapshot.asOf, reason: 'snapshot already stored', snapshot };
  }
  store.writeSnapshot({ ...snapshot, sourceFile: path.basename(filePath), ingestedAt: new Date().toISOString() });
  rebuildSeries(config);
  return { applied: true, asOf: snapshot.asOf, snapshot };
}

/** Rebuild the derived series from every stored snapshot, oldest first. */
export function rebuildSeries(config) {
  const store = new Store(config.dataDir);
  const series = { updatedAt: null, lastAsOf: null, creators: {} };
  const dates = store.listSnapshotDates();
  for (const d of dates) applySnapshot(series, store.readSnapshot(d));
  store.writeSeries(series);
  return { snapshots: dates.length, creators: Object.keys(series.creators).length, lastAsOf: series.lastAsOf };
}

function readState(config) {
  const p = path.join(config.dataDir, 'alert-state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { open: {} };
}

function writeState(config, state) {
  fs.writeFileSync(path.join(config.dataDir, 'alert-state.json'), JSON.stringify(state, null, 2));
}

/**
 * Stage 3-5: score everyone, group by coach, render.
 * `persist: false` runs the rules without advancing the alert cooldowns, which
 * is what you want for ad-hoc reports and backtests.
 */
export function analyse(config, { asOf = null, persist = true } = {}) {
  const store = new Store(config.dataDir);
  const series = store.readSeries();
  const endDate = asOf ?? series.lastAsOf;
  if (!endDate) throw new Error('no snapshots ingested yet');
  // Past the last snapshot every rolling window is empty, so every creator
  // reads as having collapsed. Refuse rather than produce that.
  if (endDate > series.lastAsOf) {
    throw new Error(`no data for ${endDate} — the latest snapshot is ${series.lastAsOf}`);
  }

  const creators = Object.values(series.creators);
  const metricsByKey = new Map();
  for (const c of creators) metricsByKey.set(c.key, computeMetrics(c, endDate));

  const state = readState(config);
  const { alerts, recoveries, skipped } = evaluateDecline(creators, metricsByKey, config, state);
  if (persist) writeState(config, state);

  const ramp = evaluateRamp(creators, metricsByKey, config);
  const spotlight = pickSpotlight(ramp, config);

  const stats = {
    tracked: creators.filter((c) => !c.quitOn).length,
    quit: creators.filter((c) => c.quitOn).length,
    snapshots: store.listSnapshotDates().length,
    skipped,
  };

  return { asOf: endDate, creators, metricsByKey, alerts, recoveries, ramp, spotlight, stats };
}

/** Group the results by coach and render one message each. */
export function buildDigests(result, config) {
  const byCoach = new Map();
  const bucket = (coach) => {
    const key = coach ?? 'unassigned';
    if (!byCoach.has(key)) byCoach.set(key, { coach: key, alerts: [], recoveries: [], ramp: [], spotlight: [] });
    return byCoach.get(key);
  };
  for (const a of result.alerts) bucket(a.creator.manager).alerts.push(a);
  for (const r of result.recoveries) bucket(r.creator.manager).recoveries.push(r);
  for (const r of result.ramp) bucket(r.creator.manager).ramp.push(r);
  for (const r of result.spotlight) bucket(r.creator.manager).spotlight.push(r);

  const digests = [];
  for (const b of byCoach.values()) {
    const text = renderCoachDigest({ ...b, asOf: result.asOf, config });
    if (text) digests.push({ coach: b.coach, text, counts: { alerts: b.alerts.filter((a) => a.notify).length, boost: b.spotlight.length } });
  }
  digests.sort((a, b) => b.counts.alerts - a.counts.alerts);
  return digests;
}

/**
 * The daily run: score everyone, reconcile against the open caseload, post to
 * Discord.
 *
 * Kept separate from `analyse` because analysis is read-only and safe to run at
 * any time, while this advances state that coaches can see.
 */
/**
 * Is the data itself healthy enough to trust? Surfaced in the daily overview so
 * a gap in uploads is visible to whoever can fix it, rather than quietly
 * degrading the comparisons.
 */
export function dataHealth(config, asOf) {
  const store = new Store(config.dataDir);
  const dates = store.listSnapshotDates();
  const series = store.readSeries();
  let missingDays = 0;
  for (let d = dates[0]; dates.length > 1 && d < dates.at(-1);) {
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    if (!dates.includes(d) && d < dates.at(-1)) missingDays++;
  }

  const need = config.decline?.eligibility?.minExactDaysPerWindow ?? 5;
  const sample = Object.values(series.creators).filter((c) => !c.quitOn).slice(0, 200);
  const ready = sample.filter((c) => {
    const m = computeMetrics(c, asOf);
    return m.exact.curr7 >= need && m.exact.prev7 >= need;
  }).length;
  const exactDays = new Set();
  for (const c of sample) for (const o of c.obs) if (o.span === 1 && !o.partial) exactDays.add(o.date);

  return {
    lastAsOf: series.lastAsOf,
    snapshots: dates.length,
    missingDays,
    declineReady: sample.length > 0 && ready > sample.length * 0.5,
    uploadsNeeded: Math.max(1, (need * 2) - exactDays.size),
  };
}

export async function runDaily(config, configPath, { asOf = null, dryRun = false, forceSummary = false } = {}) {
  const result = analyse(config, { asOf, persist: !dryRun });
  const store = new CaseStore(config.dataDir);
  const changes = reconcile({
    asOf: result.asOf,
    alerts: result.alerts,
    spotlight: result.spotlight,
    metricsByKey: result.metricsByKey,
    creators: result.creators,
    store,
    config,
  });

  const routes = loadRoutes(path.dirname(configPath));
  const discordConfig = routes.discord;
  let delivery = { sent: [], previews: [] };
  if (discordConfig.enabled) {
    delivery = await dispatch({
      asOf: result.asOf,
      changes,
      alerts: result.alerts,
      spotlight: result.spotlight,
      ramp: result.ramp,
      stats: result.stats,
      store,
      discordConfig,
      dryRun,
      forceSummary,
      health: dataHealth(config, result.asOf),
    });
  }

  return { result, changes, delivery, cases: caseStats(store, result.asOf), store };
}

export { renderNetworkSummary, toJson, CaseStore, effectiveness, caseStats };
