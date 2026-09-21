// Network-level findings: the ones that are a programme, not a conversation.
//
// Some numbers only mean something in aggregate. On LEAP's data 425 of 503
// earning creators have never done a match — as a per-creator nudge that is 425
// separate conversations nobody will have, and as a network figure it is one
// decision about how campaigns are run.
//
// These go to the management channel weekly, not to team channels daily.

const iso = (d) => d.toISOString().slice(0, 10);

/** Creators who earn but have never taken part in a match. */
export function campaignGap(creators, metricsByKey, config) {
  const cfg = config.programmes;
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    if (m.lastMatch || m.matches28 > 0) continue;
    if (m.curr28.diamonds < cfg.campaign.minDiamonds28) continue;
    if (m.curr28.liveHours < cfg.campaign.minHours28) continue;
    rows.push({
      creator: c,
      diamonds28: Math.round(m.curr28.diamonds),
      hours28: Number(m.curr28.liveHours.toFixed(1)),
      perHour: m.diamondsPerHour28 ? Math.round(m.diamondsPerHour28) : null,
      // Rate times hours already proven: the creators with a real room who have
      // simply never been put in front of anyone else's.
      upside: Math.round((m.diamondsPerHour28 ?? 0) * m.curr28.liveHours),
    });
  }
  rows.sort((a, b) => b.upside - a.upside);
  return rows;
}

/** Creators whose income rests almost entirely on their fan club. */
export function concentrationRisk(creators, metricsByKey, config) {
  const cfg = config.programmes;
  const rows = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    const m = metricsByKey.get(c.key);
    if (!m) continue;
    const share = m.fanClub.contribution ?? 0;
    if (share < cfg.concentration.minShare) continue;
    if (m.curr28.diamonds < cfg.concentration.minDiamonds28) continue;
    const members = m.fanClub.activeFans ?? 0;
    rows.push({
      creator: c,
      share,
      members,
      diamonds28: Math.round(m.curr28.diamonds),
      // What one member walking away costs, as an average. Crude, and enough to
      // show that a handful of people carry the income.
      perMember: members > 0 ? Math.round((m.curr28.diamonds * share) / members) : null,
      exposure: Math.round(m.curr28.diamonds * share),
    });
  }
  rows.sort((a, b) => b.exposure - a.exposure);
  return rows;
}

/**
 * Is it time for the weekly programme post?
 *
 * Weekly rather than daily because neither of these changes day to day, and a
 * figure that never moves stops being read.
 */
export function programmesDue(config, store, asOf) {
  const cfg = config.programmes;
  if (!cfg?.enabled) return false;
  const day = new Date(`${asOf}T00:00:00Z`).getUTCDay();
  if (day !== (cfg.weekday ?? 1)) return false;
  return store.data.lastProgrammesOn !== asOf;
}

/**
 * How stale the data is.
 *
 * The whole system rests on somebody uploading a file each morning. Nothing
 * else in it notices when that stops, and a quiet week degrades every
 * comparison without a single error.
 */
export function uploadStaleness(lastAsOf, config, now = new Date()) {
  if (!lastAsOf) return { level: 'none', days: null, message: 'No export has ever been uploaded.' };
  // The export covers the day before it is produced, so one day behind is normal.
  const days = Math.round((Date.parse(`${iso(now)}T00:00:00Z`) - Date.parse(`${lastAsOf}T00:00:00Z`)) / 86400000);
  const cfg = config.uploads ?? {};
  const warnAt = cfg.warnAfterDays ?? 2;
  const urgentAt = cfg.urgentAfterDays ?? 4;
  if (days >= urgentAt) {
    return {
      level: 'urgent', days,
      message: `No export for ${days} days. Week-on-week comparisons are degrading and the 200k month is being tracked blind.`,
    };
  }
  if (days >= warnAt) {
    return { level: 'warn', days, message: `No export for ${days} days — today's numbers are out of date.` };
  }
  return { level: 'ok', days, message: null };
}
