// Renders the evaluated results into the message a coach actually receives.
import { RAMP_STATUS } from './ramp.mjs';

const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const SEVERITY_ICON = { urgent: '🔴', warn: '🟠', watch: '🟡' };
const RAMP_ICON = {
  [RAMP_STATUS.ACHIEVED]: '✅', [RAMP_STATUS.ON_TRACK]: '🟢',
  [RAMP_STATUS.AT_RISK]: '🟠', [RAMP_STATUS.OFF_TRACK]: '🔴',
  [RAMP_STATUS.MISSED]: '⚪',
};

function alertBlock(a) {
  const c = a.creator;
  const m = a.metrics;
  const lines = [];
  const age = m.daysSinceJoining != null ? `, day ${m.daysSinceJoining}` : '';
  lines.push(`${SEVERITY_ICON[a.severity]} @${c.username} — ${c.group ?? 'no group'}${age}`);
  lines.push(`   This week: ${n(m.curr7.diamonds)} diamonds (${pct(m.change7.diamonds)}) · ${m.curr7.liveHours.toFixed(1)}h LIVE (${pct(m.change7.liveHours)}) · ${Math.round(m.curr7.validLiveDays)} LIVE days`);
  for (const s of a.signals) lines.push(`   • ${s.label} — ${s.detail}`);
  if (a.valueAtRisk > 0) lines.push(`   At risk: ~${n(a.valueAtRisk)} diamonds over the next 28 days if this holds`);
  if (a.escalated) lines.push(`   ⚠️ Worsened since first flagged on ${a.openSince}`);
  lines.push(`   👉 ${a.action}`);
  return lines.join('\n');
}

function rampBlock(r) {
  const c = r.creator;
  const pctDone = Math.round(r.pctOfTarget * 100);
  const lines = [];
  lines.push(`${RAMP_ICON[r.status] ?? '•'} @${c.username} — day ${r.day} of 90 (${r.daysLeft} left) — ${r.status.replace('_', ' ')}`);
  lines.push(`   ${n(r.earned)} / 200,000 (${pctDone}%)${r.exact ? '' : ` · ${r.blindDays}d before tracking not counted`} · pace target by now ${n(r.curveTarget)}`);
  lines.push(`   Doing ${n(r.currentPerDay)}/day, needs ${n(r.requiredPerDay)}/day · at ${n(r.diamondsPerHour)} diamonds per LIVE hour`);
  lines.push(`   On this week's rate they finish day 90 on ${n(r.projected)} — ${r.willHit ? 'clears the target' : `${n(200000 - r.projected)} short`}`);
  lines.push(`   👉 ${r.plan.ask}`);
  return lines.join('\n');
}

/** One coach's daily message. Returns null when there is nothing worth sending. */
export function renderCoachDigest({ coach, asOf, alerts, recoveries, ramp, spotlight, config }) {
  const notify = alerts.filter((a) => a.notify);
  const maxA = config.digest.maxAlertsPerCoach;
  const maxR = config.digest.maxRampRowsPerCoach;
  const rampUrgent = ramp.filter((r) => [RAMP_STATUS.AT_RISK, RAMP_STATUS.OFF_TRACK].includes(r.status) && r.daysLeft > 0);
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
      out.push(`   🟡 @${a.creator.username} — ${a.signals.map((s) => s.label).join('; ')}`);
    }
    out.push('');
  }

  if (spotlight.length) {
    out.push(`BOOST LIST — behind on the 200k target but reachable`);
    out.push('');
    for (const r of spotlight.slice(0, maxR)) { out.push(rampBlock(r)); out.push(''); }
  }

  const remaining = rampUrgent.filter((r) => !spotlight.includes(r));
  if (remaining.length) {
    out.push(`FIRST 90 DAYS — also behind (${remaining.length})`);
    for (const r of remaining.slice(0, maxR)) {
      out.push(`   ${RAMP_ICON[r.status]} @${r.creator.username} — day ${r.day}, ${n(r.earned)}/200,000, needs ${n(r.requiredPerDay)}/day`);
    }
    out.push('');
  }

  if (wins.length) {
    out.push(`🎉 HIT 200K: ${wins.map((r) => `@${r.creator.username} (day ${r.day})`).join(', ')}`);
    out.push('');
  }

  if (config.digest.includeRecoveries && recoveries.length) {
    out.push(`↩️ RECOVERED: ${recoveries.map((r) => `@${r.creator.username}`).join(', ')}`);
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
  out.push(`First-90 cohort (${ramp.length} creators against the 200k target):`);
  for (const [k, v] of Object.entries(RAMP_STATUS)) {
    if (byStatus[v]) out.push(`   ${RAMP_ICON[v] ?? '•'} ${v.replace('_', ' ')}: ${byStatus[v]}`);
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
      manager: r.creator.manager,
      joinDate: r.creator.joinDate,
      day: r.day,
      daysLeft: r.daysLeft,
      earned: r.earned,
      exact: r.exact,
      blindDays: r.blindDays,
      target: 200000,
      curveTarget: r.curveTarget,
      requiredPerDay: r.requiredPerDay,
      currentPerDay: r.currentPerDay,
      projected: r.projected,
      willHit: r.willHit,
      status: r.status,
      diamondsPerHour: r.diamondsPerHour,
      potential: r.potential,
      lever: r.plan.lever,
      ask: r.plan.ask,
      onBoostList: spotlight.includes(r),
    })),
  };
}
