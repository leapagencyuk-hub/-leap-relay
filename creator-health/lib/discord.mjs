// Discord delivery. No library: the REST calls we need are four endpoints, and
// `fetch` has been built into Node since 18.
//
// Two modes, because they have very different setup costs:
//   webhook - paste a URL per channel, working in two minutes, no buttons
//   bot     - a bot token and a public interactions URL, but coaches can then
//             action a case with one click instead of typing anything
//
// Everything below produces the same embeds either way, so a network can start
// on webhooks and move to a bot without the messages changing.
import { PLAYBOOK, VERDICT_LABEL } from './playbook.mjs';
import { CONFIDENCE_LABEL, KIND } from './causes.mjs';

const API = 'https://discord.com/api/v10';

export const SEVERITY_LABEL = { urgent: 'Urgent', warn: 'Warning', watch: 'Early sign' };

export const COLOR = {
  urgent: 0xe5484d,
  warn: 0xf76b15,
  watch: 0xffc53d,
  opportunity: 0x3e63dd,
  recovered: 0x30a46c,
  escalation: 0xab4aba,
  neutral: 0x8b8d98,
};

const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);

/**
 * One Discord request, with the rate limiter respected.
 *
 * Discord answers 429 with the exact wait in `retry_after`; honouring it is the
 * difference between a digest that delivers and a bot that gets temporarily
 * banned for hammering. A network of 16 coaches posts well inside the limits,
 * but a cold start posting 100+ cases at once will hit them.
 */
async function request(method, route, { token, body = null, retries = 3 } = {}) {
  let lastError = null;
  let networkFailures = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(route.startsWith('http') ? route : `${API}${route}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bot ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });

      if (res.status === 429) {
        const info = await res.json().catch(() => ({}));
        const wait = Math.min((info.retry_after ?? 1) * 1000 + 250, 30000);
        await new Promise((r) => setTimeout(r, wait));
        lastError = 'rate limited';
        continue;
      }
      if (res.status === 204) return { ok: true, body: null };
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (res.ok) return { ok: true, body: parsed };
      // 4xx other than rate limiting will not fix itself.
      if (res.status < 500) return { ok: false, status: res.status, error: text.slice(0, 300) };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      // A timeout or refused connection will not fix itself twice in a row;
      // retrying it for every message turns one outage into a stalled run.
      lastError = err.message;
      if (++networkFailures >= 2) return { ok: false, error: `network: ${lastError}` };
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return { ok: false, error: lastError };
}

export class Discord {
  constructor({ token = null } = {}) { this.token = token; }

  postToChannel(channelId, payload) {
    return request('POST', `/channels/${channelId}/messages`, { token: this.token, body: payload });
  }

  editMessage(channelId, messageId, payload) {
    return request('PATCH', `/channels/${channelId}/messages/${messageId}`, { token: this.token, body: payload });
  }

  postToWebhook(url, payload) {
    // `?wait=true` makes Discord return the created message, so the id can be
    // stored on the case and the card edited later.
    return request('POST', `${url}${url.includes('?') ? '&' : '?'}wait=true`, { body: payload });
  }

  /** DM a coach. Discord requires opening the channel before posting to it. */
  async postToUser(userId, payload) {
    const dm = await request('POST', '/users/@me/channels', {
      token: this.token, body: { recipient_id: userId },
    });
    if (!dm.ok) return dm;
    return this.postToChannel(dm.body.id, payload);
  }
}

// --- components --------------------------------------------------------------

const BUTTON = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

/** custom_id carries the action and the case: `ch:<action>:<caseId>`. */
export const customId = (action, caseId) => `ch:${action}:${caseId}`;
export function parseCustomId(raw) {
  const [ns, action, caseId] = String(raw ?? '').split(':');
  return ns === 'ch' && action && caseId ? { action, caseId } : null;
}

export function caseButtons(caseRecord, { enabled = true } = {}) {
  // Until the interactions endpoint is live, Discord answers every click with
  // "This interaction failed" — which reads as a broken tool. So buttons are
  // only attached when something is actually listening for them.
  if (!enabled) return [];
  const id = caseRecord.id;
  const row = [
    { type: 2, style: BUTTON.PRIMARY, label: 'On it', custom_id: customId('ack', id) },
    { type: 2, style: BUTTON.SUCCESS, label: 'Log what I did', custom_id: customId('act', id) },
    { type: 2, style: BUTTON.SECONDARY, label: 'Known reason', custom_id: customId('snooze', id) },
  ];
  if (caseRecord.kind === 'decline') {
    row.push({ type: 2, style: BUTTON.SECONDARY, label: 'Close', custom_id: customId('done', id) });
  }
  return [{ type: 1, components: row }];
}

// --- embeds ------------------------------------------------------------------

/** The three-column month view, for a case raised on monthly evidence. */
function monthOnlyFields(m, caseRecord) {
  const mom = m.monthOnMonth ?? {};
  const d = mom.diamonds ?? {};
  const h = mom.liveHours ?? {};
  const prev = mom.previousMonth ?? 'last month';
  return [
    {
      name: `This month (to day ${mom.dayOfMonth ?? '—'})`,
      value: [
        `${n(d.monthToDate)} diamonds`,
        `${h.monthToDate != null ? `${h.monthToDate.toFixed(1)}h LIVE` : '—'}`,
        `on track for ${n(d.projectedMonth)}`,
      ].join('\n'),
      inline: true,
    },
    {
      name: `Same point in ${prev}`,
      value: [
        `${n(d.lastMonthToSamePoint)} diamonds`,
        `${h.lastMonthToSamePoint != null ? `${h.lastMonthToSamePoint.toFixed(1)}h LIVE` : '—'}`,
        `full month: ${n(d.lastMonthTotal)}`,
      ].join('\n'),
      inline: true,
    },
    {
      name: 'Behind by',
      value: `${n(Math.max(0, (d.lastMonthToSamePoint ?? 0) - (d.monthToDate ?? 0)))} diamonds\n**${pct(d.change)}**`,
      inline: true,
    },
  ];
}

/** Month on month, prorated to the same point — or diamonds at risk if we cannot. */
function monthField(m, caseRecord) {
  const mom = m.monthOnMonth?.diamonds;
  if (!mom || mom.change == null) {
    return { name: 'At risk', value: `~${n(caseRecord.valueAtRisk)} diamonds over 28 days`, inline: true };
  }
  return {
    name: `vs ${m.monthOnMonth.previousMonth}`,
    value: [
      `${n(mom.monthToDate)} so far`,
      `${n(mom.lastMonthToSamePoint)} by day ${m.monthOnMonth.dayOfMonth} last month`,
      `**${pct(mom.change)}**`,
    ].join('\n'),
    inline: true,
  };
}

/**
 * Why, then what to ask. The coaches know how to help — this exists to point
 * them at the right conversation, not to script it.
 */
function causeFields(caseRecord) {
  const ranked = caseRecord.causes ?? [];
  if (!ranked.length) return [];
  const causes = ranked.filter((c) => c.kind !== KIND.LEVER);
  const levers = ranked.filter((c) => c.kind === KIND.LEVER);
  const out = [];

  if (causes.length) {
    out.push({
      name: 'Most likely why',
      value: causes.map((c) =>
        `**${c.label}** _(${CONFIDENCE_LABEL[c.confidence]})_\n${c.evidence.map((e) => `• ${e}`).join('\n')}`,
      ).join('\n\n').slice(0, 1024),
    });
    const top = causes[0];
    out.push({
      name: 'Ask them',
      value: top.ask.map((a) => `• ${a}`).join('\n').slice(0, 1024),
    });
    if (top.check?.length) {
      out.push({
        name: 'Before you call',
        value: `${top.check.join('; ')}${top.resolution ? `\n_${top.resolution}_` : ''}`.slice(0, 1024),
      });
    }
  }

  if (levers.length) {
    out.push({
      name: 'Also worth pushing',
      value: levers.map((l) => `**${l.label}** — ${l.evidence[0]}`).join('\n').slice(0, 1024),
    });
  }
  return out;
}

function statusLine(c) {
  if (c.status === 'acknowledged') return `Picked up by ${c.acknowledgedBy ?? 'a coach'}`;
  if (c.status === 'actioned') return `Actioned, checking back on ${c.followUpOn}`;
  if (c.status === 'snoozed') return `Snoozed until ${c.snoozedUntil}`;
  if (c.status === 'resolved') return 'Resolved';
  if (c.status === 'lost') return 'Creator left the network';
  return 'Open';
}

/** The card a coach sees when a creator starts slipping. */
export function declineEmbed(caseRecord, alert, { mention = null, buttons = true } = {}) {
  const m = alert.metrics;
  const book = PLAYBOOK[caseRecord.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;

  return {
    content: mention ?? undefined,
    embeds: [{
      title: `${SEVERITY_LABEL[caseRecord.severity] ?? 'Notice'} — @${caseRecord.username}: ${book.title}`,
      description: alert.signals.map((s) => `• **${s.label}** — ${s.detail}`).join('\n').slice(0, 3800),
      color: COLOR[caseRecord.severity] ?? COLOR.neutral,
      fields: [
        // A case raised on monthly evidence shows monthly figures. Showing a
        // week built from spread-out snapshots beside it would invite the coach
        // to read numbers the alert never trusted.
        ...(caseRecord.weekly === false
          ? monthOnlyFields(m, caseRecord)
          : [
            {
              name: 'This week',
              value: [
                `${n(m.curr7.diamonds)} diamonds (${pct(m.change7.diamonds)})`,
                `${m.curr7.liveHours.toFixed(1)}h LIVE (${pct(m.change7.liveHours)})`,
                `${Math.round(m.curr7.validLiveDays)} LIVE days`,
              ].join('\n'),
              inline: true,
            },
            {
              name: 'Their normal',
              value: [
                `${n(caseRecord.baseline.weeklyDiamonds)} diamonds`,
                `${caseRecord.baseline.weeklyHours.toFixed(1)}h LIVE`,
                `${caseRecord.baseline.weeklyLiveDays.toFixed(1)} LIVE days`,
              ].join('\n'),
              inline: true,
            },
            monthField(m, caseRecord),
          ]),
        ...causeFields(caseRecord),
        { name: `Check back in ${book.followUpDays} days`, value: book.success.slice(0, 1000) },
      ].filter(Boolean),
      footer: { text: `${caseRecord.id} · ${caseRecord.group ?? 'no group'} · ${statusLine(caseRecord)}` },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** The card for a creator who can still land a 200k month. */
export function opportunityEmbed(caseRecord, row, { mention = null, buttons = true } = {}) {
  const short = Math.max(0, 200000 - row.projected);
  const monthName = new Date(`${row.month}-01T00:00:00Z`)
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

  // Earlier attempts matter: the target resets on the 1st, so a creator who did
  // 180k last month is a different conversation from one who has never cleared 20k.
  const history = (row.pastAttempts ?? []).filter((a) => a.observed);
  const historyLine = history.length
    ? history.map((a) => `${a.key}: ${n(a.diamonds)}`).join(' · ')
    : 'No earlier month on record.';

  return {
    content: mention ?? undefined,
    embeds: [{
      title: `@${caseRecord.username} can still hit 200k in ${monthName}`,
      description: `**${n(row.monthToDate)} / 200,000** this month, with `
        + `**${row.daysLeftInMonth} day${row.daysLeftInMonth === 1 ? '' : 's'}** left.\n`
        + `At this week's rate they finish on ${n(row.projected)}`
        + (short > 0 ? ` — **${n(short)} short**.` : ' — **clears it**.')
        + (row.attemptsLeft > 0
          ? `\nDay ${row.day} of 90: ${row.attemptsLeft} further month${row.attemptsLeft === 1 ? '' : 's'} to try after this one.`
          : `\nDay ${row.day} of 90: this is their last month to do it.`),
      color: COLOR.opportunity,
      fields: [
        { name: 'Doing', value: `${n(row.currentPerDay)}/day`, inline: true },
        { name: 'Needs', value: `${n(row.requiredPerDay)}/day`, inline: true },
        { name: 'Converts at', value: `${n(row.diamondsPerHour)}/LIVE hour`, inline: true },
        { name: `The lever: ${row.plan.lever}`, value: row.plan.ask.slice(0, 1000) },
        { name: 'Earlier months', value: historyLine.slice(0, 1024) },
        ...causeFields(caseRecord),
        { name: 'Check back in 14 days', value: PLAYBOOK.OPPORTUNITY.success },
      ].filter(Boolean),
      footer: { text: `${caseRecord.id} · ${caseRecord.group ?? 'no group'} · ${statusLine(caseRecord)}` },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** Posted when a follow-up window closes, so the coach learns what their call did. */
export function followUpEmbed(caseRecord, { mention = null, buttons = true } = {}) {
  const o = caseRecord.outcome;
  const book = PLAYBOOK[caseRecord.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
  const good = o.verdict === 'recovered';
  return {
    content: mention ?? undefined,
    embeds: [{
      title: `@${caseRecord.username} — ${VERDICT_LABEL[o.verdict] ?? o.verdict}`,
      description: good
        ? `That worked. ${book.title} case opened ${caseRecord.openedOn} is now closed.`
        : `Followed up on the ${book.title.toLowerCase()} case from ${caseRecord.openedOn}. `
          + `Back to you — this is attempt ${caseRecord.attempts ?? 1}.`,
      color: good ? COLOR.recovered : COLOR.warn,
      fields: [
        {
          name: 'Now',
          value: `${n(o.measured?.weeklyDiamonds)} diamonds\n${o.measured?.weeklyHours ?? '—'}h LIVE\n${o.measured?.weeklyLiveDays ?? '—'} LIVE days`,
          inline: true,
        },
        {
          name: 'When we flagged it',
          value: `${n(caseRecord.baseline.atOpen.weeklyDiamonds)} diamonds\n${caseRecord.baseline.atOpen.weeklyHours}h LIVE\n${caseRecord.baseline.atOpen.weeklyLiveDays} LIVE days`,
          inline: true,
        },
        {
          name: 'Their normal',
          value: `${n(caseRecord.baseline.weeklyDiamonds)} diamonds\n${caseRecord.baseline.weeklyHours}h LIVE\n${caseRecord.baseline.weeklyLiveDays} LIVE days`,
          inline: true,
        },
      ],
      footer: { text: `${caseRecord.id} · ${statusLine(caseRecord)}` },
      timestamp: new Date().toISOString(),
    }],
    components: good ? [] : caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** Sent to the managers' channel when nobody has picked a case up. */
export function escalationEmbed(cases, asOf) {
  const lines = cases.slice(0, 20).map((c) =>
    `• **@${c.username}** (${c.coach}) — open since ${c.openedOn}, ~${n(c.valueAtRisk)} at risk · \`${c.id}\``);
  return {
    embeds: [{
      title: `${cases.length} case${cases.length === 1 ? '' : 's'} nobody has picked up`,
      description: lines.join('\n').slice(0, 3800),
      color: COLOR.escalation,
      footer: { text: `as of ${asOf}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * The once-a-day overview.
 *
 * Deliberately dense, because it is the only post in this channel and it has
 * to answer four questions without anyone opening a terminal: what went out
 * today, what is the caseload doing, which teams are not moving their
 * creators, and is the data itself healthy.
 */
export function overviewEmbed({
  asOf, stats, caseStats, alerts, ramp, spotlight, changes = {}, sent = [], teams = [],
  health = null, openCases = [],
}) {
  const risk = alerts.reduce((s, a) => s + a.valueAtRisk, 0);
  const byStatus = {};
  for (const r of ramp) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  // What actually went out, per team, so the channel is a record of delivery.
  const posted = sent.filter((x) => x.ok && !x.skipped && x.label !== 'overview');
  const failed = sent.filter((x) => !x.ok);
  const byTeam = {};
  for (const c of [...(changes.opened ?? []), ...(changes.dueFollowUps ?? [])]) {
    byTeam[c.group ?? 'no team'] = (byTeam[c.group ?? 'no team'] ?? 0) + 1;
  }
  const deliveryLines = Object.entries(byTeam).sort((a, b) => b[1] - a[1])
    .map(([team, count]) => `${team} — ${count}`);

  // Teams whose flagged creators mostly never recover: the visible difference
  // between a team that acts on these cards and one that does not.
  const notMoving = teams
    .filter((t) => t.closed >= 3 && (t.staleRate ?? 0) > 0.5)
    .sort((a, b) => b.wentStale - a.wentStale)
    .slice(0, 5);

  const fields = [
    {
      name: 'Sent today',
      value: posted.length
        ? `**${posted.length}** card(s)\n${deliveryLines.slice(0, 10).join('\n') || '—'}`
          + (failed.length ? `\n${failed.length} failed to send` : '')
        : failed.length ? `nothing delivered — ${failed.length} failure(s)` : 'Nothing new today.',
      inline: true,
    },
    {
      name: 'Caseload',
      value: [
        `${caseStats.open + caseStats.acknowledged + caseStats.actioned} open`,
        `${changes.opened?.length ?? 0} new · ${(changes.autoResolved?.length ?? 0)} closed`,
        `${caseStats.snoozed} snoozed`,
        changes.deferred?.length ? `⏸ ${changes.deferred.length} held — coaches at their limit` : null,
      ].filter(Boolean).join('\n'),
      inline: true,
    },
    {
      name: 'At risk',
      value: `~${n(risk)} diamonds\nover the next 28 days\n${stats.tracked} creators tracked`,
      inline: true,
    },
    {
      name: '200k monthly target',
      value: [
        `${byStatus.ON_TRACK ?? 0} on track · ${(byStatus.AT_RISK ?? 0) + (byStatus.OFF_TRACK ?? 0)} behind`,
        `${byStatus.ACHIEVED ?? 0} hit the target`,
        `${spotlight.length} on the boost list`,
      ].join('\n'),
      inline: true,
    },
  ];

  // Who needs a call today. Management's first question is never "how many
  // cases" — it is "which creators, and whose".
  const urgent = (changes.opened ?? [])
    .filter((c) => c.severity === 'urgent')
    .sort((a, b) => b.valueAtRisk - a.valueAtRisk);
  if (urgent.length) {
    fields.push({
      name: `Urgent — needs a call today (${urgent.length})`,
      value: urgent.slice(0, 10)
        .map((c) => `**@${c.username}** · ${c.group ?? 'no team'} · ~${n(c.valueAtRisk)} at risk`)
        .join('\n').slice(0, 1024),
    });
  }

  // The caseload broken down by team, which is the view that says where the
  // problem is concentrated rather than how big it is overall.
  const byTeamLoad = {};
  for (const c of openCases ?? []) {
    const key = c.group ?? 'no team';
    const t = (byTeamLoad[key] ??= { open: 0, urgent: 0, risk: 0, coaches: new Set() });
    t.open++;
    if (c.severity === 'urgent') t.urgent++;
    t.risk += c.valueAtRisk ?? 0;
    if (c.coach) t.coaches.add(c.coach);
  }
  const teamRows = Object.entries(byTeamLoad)
    .sort((a, b) => b[1].risk - a[1].risk)
    .slice(0, 12)
    .map(([team, t]) => `**${team}** — ${t.open} open${t.urgent ? `, ${t.urgent} urgent` : ''} · ~${n(t.risk)} at risk`);
  if (teamRows.length) {
    fields.push({ name: 'Where the caseload sits', value: teamRows.join('\n').slice(0, 1024) });
  }

  if (changes.escalated?.length) {
    fields.push({
      name: `Open and still declining (${changes.escalated.length})`,
      value: changes.escalated.slice(0, 8)
        .map((c) => `**@${c.username}** (${c.group ?? '—'}) — since ${c.openedOn}, ~${n(c.valueAtRisk)} at risk`)
        .join('\n').slice(0, 1024),
    });
  }

  if (notMoving.length) {
    fields.push({
      name: 'Teams whose flagged creators are not recovering',
      value: notMoving
        .map((t) => `**${t.team}** — ${t.wentStale}/${t.closed} ran out still down (${Math.round((t.recoveryRate ?? 0) * 100)}% fixed)`)
        .join('\n').slice(0, 1024),
    });
  }

  if (alerts.length) {
    fields.push({
      name: 'Biggest losses',
      // Each line is quoted on the basis its own alert was raised on. Showing a
      // weekly percentage for a month-raised case produced numbers like "+326%"
      // beside "urgent", which reads as the tool being broken.
      value: alerts.slice(0, 5).map((a) => {
        const monthly = a.weekly === false;
        const change = monthly ? a.metrics.monthOnMonth?.diamonds?.change : a.metrics.change7.diamonds;
        const basis = monthly ? 'on last month' : 'this week';
        return `**@${a.creator.username}** (${a.creator.group ?? '—'}) — ${pct(change)} ${basis}, ~${n(a.valueAtRisk)} at risk`;
      }).join('\n').slice(0, 1024),
    });
  }

  if (health) {
    fields.push({
      name: 'Data',
      value: [
        `Last export: ${health.lastAsOf ?? '—'} (${health.snapshots} held)`,
        health.missingDays ? `${health.missingDays} day(s) never uploaded` : 'No missing days',
        // Two detectors, and only one of them needs daily history. Saying
        // "detection: off" while the month comparison is raising urgent cases
        // reads as a contradiction.
        `Month on month: on${health.monthSource ? ` (vs ${health.monthSource})` : ''}`,
        health.declineReady
          ? 'Week on week: on'
          : `Week on week: needs ~${health.uploadsNeeded} more daily upload(s)`,
      ].join('\n'),
      inline: false,
    });
  }

  return {
    embeds: [{
      title: `LEAP creator overview — ${asOf}`,
      description: stats.quit ? `${stats.quit} creator(s) have left the network.` : undefined,
      color: changes.escalated?.length ? COLOR.escalation : COLOR.neutral,
      fields,
      footer: { text: 'Posted once a day. Team cards go to each team\'s channel.' },
      timestamp: new Date().toISOString(),
    }],
  };
}
