// Renders the evaluated results into the message a coach actually receives.
import { RAMP_STATUS } from './ramp.mjs';

const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const SEVERITY_LABEL = { urgent: 'URGENT', warn: 'WARNING', watch: 'EARLY' };
const RAMP_LABEL = {
  [RAMP_STATUS.ACHIEVED]: 'HIT IT',
  [RAMP_STATUS.ON_TRACK]: 'ON TRACK',
  [RAMP_STATUS.AT_RISK]: 'AT RISK',
  [RAMP_STATUS.OFF_TRACK]: 'OFF TRACK',
  [RAMP_STATUS.MISSED]: 'MISSED',
};

function alertBlock(a) {
  const c = a.creator;
  const m = a.metrics;
  const lines = [];
  const age = m.daysSinceJoining != null ? `, day ${m.daysSinceJoining}` : '';
  lines.push(`[${SEVERITY_LABEL[a.severity] ?? 'NOTICE'}] @${c.username} — ${c.group ?? 'no group'}${age}`);
  lines.push(`   This week: ${n(m.curr7.diamonds)} diamonds (${pct(m.change7.diamonds)}) · ${m.curr7.liveHours.toFixed(1)}h LIVE (${pct(m.change7.liveHours)}) · ${Math.round(m.curr7.validLiveDays)} LIVE days`);
  for (const s of a.signals) lines.push(`   • ${s.label} — ${s.detail}`);
  if (a.valueAtRisk > 0) lines.push(`   At risk: ~${n(a.valueAtRisk)} diamonds over the next 28 days if this holds`);
  if (a.escalated) lines.push(`   Worsened since first flagged on ${a.openSince}`);
  lines.push(`   ${a.action}`);
  return lines.join('\n');
}

function rampBlock(r) {
  const c = r.creator;
  const pctDone = Math.round((r.monthToDate / 200000) * 100);
  const short = Math.max(0, 200000 - r.projected);
  const lines = [];
  lines.push(`[${RAMP_LABEL[r.status] ?? r.status}] @${c.username} — ${r.month}, ${r.daysLeftInMonth} day(s) left in the month`);
  lines.push(`   ${n(r.monthToDate)} / 200,000 (${pctDone}%) · pace by today ${n(r.paceTarget)}`);
  lines.push(`   Doing ${n(r.currentPerDay)}/day, needs ${n(r.requiredPerDay)}/day · ${n(r.diamondsPerHour)} per LIVE hour`);
  lines.push(`   Finishes the month on ${n(r.projected)}${short > 0 ? ` — ${n(short)} short` : ' — clears it'}`);
  lines.push(`   Day ${r.day} of 90${r.attemptsLeft ? ` · ${r.attemptsLeft} more month(s) to try` : ' · last month to do it'}`);
  lines.push(`   ${r.plan.ask}`);
  return lines.join('\n');
}

/** One coach's daily message. Returns null when there is nothing worth sending. */
export function renderCoachDigest({ coach, asOf, alerts, recoveries, ramp, spotlight, config }) {
  const notify = alerts.filter((a) => a.notify);
  const maxA = config.digest.maxAlertsPerCoach;
  const maxR = config.digest.maxRampRowsPerCoach;
  const rampUrgent = ramp.filter((r) => [RAMP_STATUS.AT_RISK, RAMP_STATUS.OFF_TRACK].includes(r.status) && r.daysLeftInMonth > 0);
  const wins = ramp.filter((r) => r.status === RAMP_STATUS.ACHIEVED);

  if (!notify.length && !rampUrgent.length && !spotlight.length && !recoveries.length && !wins.length) return null;


  const out = [];
  out.push(`LEAP creator check — ${asOf}`);
  out.push(`Coach: ${coach}`);
  out.push('');

  // Confirmed slides get the full block and a phone call. Single early signals
  // get one line each — enough to send a message, not enough to interrupt a day.
  const acting = notify.filter((a) => a.severity !== 'watch');
  const early = notify.filter((a) => a.severity === 'watch');

  if (acting.length) {
    const risk = acting.reduce((s, a) => s + a.valueAtRisk, 0);
    out.push(`DECLINING — ${acting.length} creator${acting.length === 1 ? '' : 's'}, ~${n(risk)} diamonds at risk`);
    out.push('');
    for (const a of acting.slice(0, maxA)) { out.push(alertBlock(a)); out.push(''); }
    if (acting.length > maxA) out.push(`…and ${acting.length - maxA} more in the dashboard.`, '');
  }

  if (early.length) {
    out.push(`EARLY SIGNS — one signal only, worth a message not a call (${early.length})`);
    for (const a of early.slice(0, maxA)) {
      out.push(`   @${a.creator.username} — ${a.signals.map((s) => s.label).join('; ')}`);
    }
    out.push('');
  }

  if (spotlight.length) {
    out.push(`BOOST LIST — behind this month but still reachable`);
    out.push('');
    for (const r of spotlight.slice(0, maxR)) { out.push(rampBlock(r)); out.push(''); }
  }

  const remaining = rampUrgent.filter((r) => !spotlight.includes(r));
  if (remaining.length) {
    out.push(`200K TARGET — also behind (${remaining.length})`);
    for (const r of remaining.slice(0, maxR)) {
      out.push(`   [${RAMP_LABEL[r.status] ?? r.status}] @${r.creator.username} — ${n(r.monthToDate)}/200,000 this month, needs ${n(r.requiredPerDay)}/day`);
    }
    out.push('');
  }

  if (wins.length) {
    out.push(`HIT 200K: ${wins.map((r) => `@${r.creator.username} (day ${r.day})`).join(', ')}`);
    out.push('');
  }

  if (config.digest.includeRecoveries && recoveries.length) {
    out.push(`RECOVERED: ${recoveries.map((r) => `@${r.creator.username}`).join(', ')}`);
    out.push('');
  }

  return out.join('\n').trimEnd();
}

/** Network-level roll-up for whoever runs the agency. */
export function renderNetworkSummary({ asOf, alerts, ramp, spotlight, stats, config }) {
  const bySeverity = { urgent: 0, warn: 0, watch: 0 };
  for (const a of alerts) bySeverity[a.severity]++;
  const risk = alerts.reduce((s, a) => s + a.valueAtRisk, 0);
  const byStatus = {};
  for (const r of ramp) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const out = [];
  out.push(`LEAP network health — ${asOf}`);
  out.push('');
  out.push(`Creators tracked: ${stats.tracked} active, ${stats.quit} quit`);
  out.push(`Declining: ${bySeverity.urgent} urgent, ${bySeverity.warn} warning, ${bySeverity.watch} early — ~${n(risk)} diamonds at risk over 28 days`);
  out.push('');
  out.push(`200k monthly target (${ramp.length} creators inside their first 90 days):`);
  for (const [k, v] of Object.entries(RAMP_STATUS)) {
    if (byStatus[v]) out.push(`   ${v.replace('_', ' ')}: ${byStatus[v]}`);
  }
  out.push(`   Boost list this week: ${spotlight.length}`);
  out.push('');
  out.push(`Top losses this week:`);
  for (const a of alerts.slice(0, 5)) {
    out.push(`   @${a.creator.username} (${a.creator.manager ?? 'unassigned'}) — ${pct(a.metrics.change7.diamonds)}, ~${n(a.valueAtRisk)} at risk`);
  }
  return out.join('\n');
}

/** Machine-readable form for a webhook, Slack bot or the relay's own API. */
export function toJson({ asOf, alerts, recoveries, ramp, spotlight }) {
  return {
    asOf,
    alerts: alerts.map((a) => ({
      username: a.creator.username,
      creatorId: a.creator.creatorId,
      group: a.creator.group,
      manager: a.creator.manager,
      severity: a.severity,
      tier: a.tier,
      notify: a.notify,
      isNew: a.isNew,
      escalated: a.escalated,
      openSince: a.openSince,
      valueAtRisk: a.valueAtRisk,
      signals: a.signals.map((s) => ({ code: s.code, label: s.label, detail: s.detail })),
      action: a.action,
      week: {
        diamonds: Math.round(a.metrics.curr7.diamonds),
        diamondsChange: a.metrics.change7.diamonds,
        liveHours: Number(a.metrics.curr7.liveHours.toFixed(2)),
        liveHoursChange: a.metrics.change7.liveHours,
        liveDays: Math.round(a.metrics.curr7.validLiveDays),
        darkStreak: a.metrics.darkStreak,
      },
    })),
    recoveries: recoveries.map((r) => ({ username: r.creator.username, manager: r.creator.manager, since: r.since })),
    ramp: ramp.map((r) => ({
      username: r.creator.username,
      creatorId: r.creator.creatorId,
      team: r.creator.group,
      manager: r.creator.manager,
      joinDate: r.creator.joinDate,
      day: r.day,
      month: r.month,
      daysLeftInMonth: r.daysLeftInMonth,
      attemptsLeft: r.attemptsLeft,
      monthToDate: r.monthToDate,
      target: 200000,
      paceTarget: r.paceTarget,
      requiredPerDay: r.requiredPerDay,
      currentPerDay: r.currentPerDay,
      projected: r.projected,
      willHit: r.willHit,
      status: r.status,
      bestMonth: r.bestMonth,
      achievedIn: r.achievedIn,
      diamondsPerHour: r.diamondsPerHour,
      potential: r.potential,
      lever: r.plan.lever,
      ask: r.plan.ask,
      onBoostList: spotlight.includes(r),
    })),
  };
}
