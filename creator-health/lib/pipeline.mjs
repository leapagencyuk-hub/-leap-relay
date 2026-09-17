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

export { renderNetworkSummary, toJson };
