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
import { ACTIVATION_PLAYBOOK } from './activation.mjs';
import { profileUrl, avatarUrl } from './profile.mjs';
import { sparkline, progressBar, monthlyTrend } from './spark.mjs';

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

/**
 * The header every card shares: who, which team, and a click straight through
 * to their profile — which is where a coach goes to see the thing the export
 * cannot show them, namely what the creator has actually been posting.
 */
function authorBlock(caseRecord, avatarConfig) {
  const icon = avatarUrl(caseRecord.username, avatarConfig ?? {});
  return {
    name: `@${caseRecord.username}${caseRecord.group ? `  ·  ${caseRecord.group}` : ''}`,
    url: profileUrl(caseRecord.username),
    ...(icon ? { icon_url: icon } : {}),
  };
}

/**
 * Follower movement, offered as what it is.
 *
 * The export contains nothing about short form — no posts, no views, no videos.
 * New followers while they are still streaming is the closest observable
 * signal, because that is the traffic short form would bring. Labelled as a
 * proxy rather than dressed up as a post count.
 */
function trafficField(m) {
  const now = Math.round(m.curr7?.newFollowers ?? 0);
  const before = Math.round(m.prev7?.newFollowers ?? 0);
  // "1 this week, 1 last week" is a field taking up space to say nothing. Only
  // show this when there is enough movement for it to carry information.
  if (Math.max(now, before) < 20) return null;
  const change = before >= 10 ? (now - before) / before : null;
  // "+0%" is a field announcing that nothing happened.
  const trend = change != null && Math.abs(change) >= 0.1 ? ` (${pct(change)})` : '';
  return {
    name: 'New followers',
    value: `**${n(now)}**${trend}\nthis week · proxy for short form`,
    inline: true,
  };
}

/**
 * The footer names the coach.
 *
 * Team Alpha has two coaches across its 233 creators, so a card landing in the
 * team channel does not say whose creator it is unless the mention is
 * configured — and mentions are optional. The name always is.
 */
/**
 * "229 held" on its own reads as a system quietly losing things. It is not:
 * the breakdown shows what kind, and how much is actually at stake in them.
 */
function heldLine(deferred) {
  const byKind = {};
  let risk = 0;
  for (const d of deferred) {
    const k = d.kind ?? 'decline';
    byKind[k] = (byKind[k] ?? 0) + 1;
    risk += d.valueAtRisk ?? 0;
  }
  const parts = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`);
  return `${deferred.length} queued (${parts.join(', ')})${risk > 0 ? ` · ~${n(risk)} at risk` : ''}`;
}

function footerText(c) {
  const coach = c.coach && c.coach !== 'unassigned' ? c.coach.split('@')[0] : null;
  return [c.id, coach, statusLine(c)].filter(Boolean).join(' · ');
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
export function declineEmbed(caseRecord, alert, { mention = null, buttons = true, avatar = null } = {}) {
  const m = alert.metrics;
  const book = PLAYBOOK[caseRecord.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;

  return {
    content: mention ?? undefined,
    embeds: [{
      author: authorBlock(caseRecord, avatar),
      title: `${SEVERITY_LABEL[caseRecord.severity] ?? 'Notice'} — ${book.title}`,
      description: (() => {
        const trend = monthlyTrend(m, 6);
        // Labels only. The detail behind each one is repeated almost word for
        // word under "Most likely why", and saying it twice makes the card
        // twice as long without telling a coach anything new.
        const signals = alert.signals.map((s) => `**${s.label}**`).join('  ·  ');
        return `${trend ? `\`${trend.spark}\`  ${trend.label}\n` : ''}${signals}`.slice(0, 3800);
      })(),
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
        trafficField(m),
        { name: `Check back in ${book.followUpDays} days`, value: book.success.slice(0, 1000) },
      ].filter(Boolean),
      footer: { text: footerText(caseRecord) },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** The card for a creator who can still land a 200k month. */
export function opportunityEmbed(caseRecord, row, { mention = null, buttons = true, avatar = null } = {}) {
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
      author: authorBlock(caseRecord, avatar),
      title: `Can still hit 200k in ${monthName}`,
      description: `\`${progressBar(row.monthToDate, 200000)}\`\n`
        + `**${n(row.monthToDate)} / 200,000** this month, with `
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
      footer: { text: footerText(caseRecord) },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** The card for a creator who has not started. */
export function activationEmbed(caseRecord, { mention = null, buttons = true, avatar = null, metrics = null } = {}) {
  const book = ACTIVATION_PLAYBOOK[caseRecord.stage] ?? {};
  const ctx = caseRecord.context ?? {};

  const trend = metrics ? monthlyTrend(metrics, 6) : null;
  const headline = [
    ctx.day != null ? `**Day ${ctx.day}** of their first 90` : null,
    ctx.everLive ? 'has gone live' : '**never gone live**',
    ctx.bestMonth > 0 ? `best month ${n(ctx.bestMonth)}` : 'nothing earned yet',
  ].filter(Boolean).join('  ·  ');

  return {
    content: mention ?? undefined,
    embeds: [{
      author: authorBlock(caseRecord, avatar),
      title: book.title ?? caseRecord.stage,
      description: `${book.concern ?? ''}\n${headline}`
        + (trend ? `\n\n\`${trend.spark}\`  ${trend.label}` : ''),
      color: caseRecord.stage === 'DECIDE' ? COLOR.warn : COLOR.watch,
      fields: [
        { name: 'Start here', value: book.first ?? book.concern ?? '' },
        { name: 'Then ask', value: (book.ask ?? []).map((a) => `• ${a}`).join('\n').slice(0, 1024) },
        ...(metrics ? [trafficField(metrics)].filter(Boolean) : []),
        ...(book.check ? [{ name: 'Worth knowing', value: String(book.check).slice(0, 1024), inline: true }] : []),
        { name: 'Done when', value: book.success ?? 'Any activity.', inline: true },
      ].filter(Boolean),
      footer: { text: footerText(caseRecord) },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/**
 * The full activation list for one team, posted weekly.
 *
 * Individual cards go out for the few most winnable creators, because a coach
 * cannot work sixty at once. But the rest should not be invisible: this is the
 * whole list in one compact message, so a coach can see everyone who is not
 * earning without sixty cards arriving to say it.
 */
export function activationRosterEmbed({ team, rows, asOf, config }) {
  const byStage = {};
  for (const r of rows) (byStage[r.stage] ??= []).push(r);

  const order = ['NO_START', 'STALLED', 'DECIDE', 'DORMANT'];
  const perStage = config.activation?.rosterPerStage ?? 30;
  const fields = [];
  for (const stage of order) {
    const list = byStage[stage];
    if (!list?.length) continue;
    const book = ACTIVATION_PLAYBOOK[stage] ?? {};
    const shown = list.slice(0, perStage);
    const line = shown.map((r) => {
      const tag = stage === 'DORMANT'
        ? (r.lastMonth > 0 ? ` (was ${n(r.lastMonth)})` : '')
        : r.day != null ? ` (d${r.day})` : '';
      return `@${r.creator.username}${tag}`;
    }).join(' · ');
    fields.push({
      name: `${book.title ?? stage} — ${list.length}`,
      value: `${line}${list.length > shown.length ? ` … +${list.length - shown.length} more` : ''}`.slice(0, 1024),
    });
  }

  return {
    embeds: [{
      title: `Activation list — ${team}`,
      description: `**${rows.length}** creator${rows.length === 1 ? '' : 's'} on this team earning nothing this month. `
        + 'Cards go out for the most winnable few; this is everyone, so nobody is invisible.',
      color: COLOR.watch,
      fields,
      footer: { text: `as of ${asOf} · posted weekly` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * The daily state of one team, for the coach who runs it.
 *
 * Ordered the way a coach spends their day: what the team is worth this month,
 * who is closest to 200k, who is worth pushing while the wind is behind them,
 * then what is slipping. The habit that drives all of it goes last, because it
 * is the one thing that is true every day and does not need reading twice.
 */
export function teamSummaryEmbed(summary, { mention = null } = {}) {
  const s = summary;
  const fields = [];
  const line = (r, tail) => `**@${r.username}** ${tail}`;

  // A list is only as trustworthy as its count. Showing five under a heading
  // that says nine reads as a bug, so say what was left out.
  const listOf = (rows, total, render) => {
    const shown = rows.map(render).join('\n');
    const rest = (total ?? rows.length) - rows.length;
    return `${shown}${rest > 0 ? `\n… and ${rest} more` : ''}`.slice(0, 1024);
  };

  // Movement, quoted on a base that can carry it. Off 40 diamonds a percentage
  // is noise, so those are said in diamonds instead.
  const move = (r) => {
    if (r.change == null) return '';
    if (r.quotable) return Math.abs(r.change) >= 0.10 ? `  (${pct(r.change)})` : '';
    return `  (was ${n(r.lastMonthToSamePoint)})`;
  };

  if (s.top.length) {
    fields.push({
      name: `Biggest this month — ${s.roster.earning} earning of ${s.roster.total}`,
      value: listOf(s.top, s.top.length, (r) => line(r, `${n(r.monthToDate)}${move(r)}`)),
    });
  }

  const { chase } = s;
  if (chase.already.length) {
    fields.push({
      name: `Already past 200k — ${chase.already.length}`,
      value: listOf(chase.already.slice(0, 5), chase.already.length, (r) => line(r, n(r.monthToDate))),
    });
  }
  if (chase.clearing.length) {
    fields.push({
      name: `On for 200k — ${chase.clearing.length}`,
      value: listOf(chase.clearing.slice(0, 5), chase.clearing.length, (r) => line(r,
        `${n(r.monthToDate)} · finishes on ${n(r.projected)} at this week's rate`)),
    });
  }
  if (chase.short.length) {
    fields.push({
      name: `Short of 200k, still reachable — ${chase.short.length}`,
      value: listOf(chase.short.slice(0, 5), chase.short.length, (r) => line(r,
        `${n(r.monthToDate)} · needs ${n(r.requiredPerDay)}/day, doing ${n(r.perDay7)}`)),
    });
  }

  if (s.readyToPush.length) {
    fields.push({
      name: 'Push these now — fan club growing, money has not followed yet',
      value: listOf(s.readyToPush, s.readyToPush.length, (r) => line(r,
        `${n(r.monthToDate)} this month · fan club ${pct(r.fanClubChange)} in 14 days`)),
    });
  }
  if (s.rising.length) {
    fields.push({
      name: 'Working — protect whatever changed',
      value: listOf(s.rising, s.rising.length, (r) => line(r,
        `${n(r.monthToDate)}${move(r)} · fan club ${pct(r.fanClubChange)}`)),
    });
  }
  if (s.slipping.length) {
    fields.push({
      name: `Slipping — ${s.slippingTotal} open`,
      value: listOf(s.slipping, s.slippingTotal, (r) => line(r,
        `${n(r.monthToDate)}${move(r)} · \`${r.caseId}\``)),
    });
  }

  const f = s.frequency;
  const habit = [
    `**${f.meeting} of ${s.roster.earning}** earning creators went live ${f.target}+ days in the last 28.`,
    'Across the network, creators above that line grew 59% of the time last month. Below it, 31%.',
    'It is how often they go live, not how long — session length barely differs between the two.',
  ];
  if (f.closest.length) {
    habit.push(`\nClosest to the line, biggest first: ${
      f.closest.map((r) => `@${r.username} (${Math.round(r.liveDays28)}d)`).join(' · ')}`);
  }
  fields.push({ name: `The habit that decides the rest`, value: habit.join('\n').slice(0, 1024) });

  const m = s.month;
  // Both halves of the comparison are the same creators, and the sentence says
  // so, because a team's total against a subset's last month is not a trend.
  const headline = m.change != null
    ? `**${n(m.toDate)}** this month.\n${m.comparable} of these creators were here in ${monthName(m.previousMonth)} too: they are on **${n(m.comparableToDate)}**, against **${n(m.lastToSamePoint)}** by this point then — **${pct(m.change)}**.`
    : `**${n(m.toDate)}** this month so far.`;

  return {
    content: mention ?? undefined,
    embeds: [{
      title: `${s.team} — daily summary`,
      description: headline,
      color: m.change == null ? COLOR.neutral : m.change >= 0 ? COLOR.recovered : COLOR.warn,
      fields,
      footer: { text: `as of ${s.asOf} · ${chase.daysLeft} day${chase.daysLeft === 1 ? '' : 's'} left in the month` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function monthName(key) {
  if (!key) return 'last month';
  return new Date(`${key}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

/**
 * The weekly network post: findings that are a programme decision rather than a
 * conversation with one creator.
 */
export function programmesEmbed({ asOf, campaign, concentration, config, totals }) {
  const size = config.programmes.listSize;
  const fields = [];

  if (campaign.length) {
    const upside = campaign.reduce((t, r) => t + r.upside, 0);
    fields.push({
      name: `Never done a campaign or match (${campaign.length} of ${totals.earning} earning creators)`,
      value: `These already have a room. It has just never been put in front of anyone else's.\n\n`
        + campaign.slice(0, size)
          .map((r) => `**@${r.creator.creatorId ? r.creator.username : r.creator.username}** · ${r.creator.group ?? '—'} · ${n(r.diamonds28)} in 28d at ${n(r.perHour)}/hour`)
          .join('\n').slice(0, 900),
    });
    fields.push({
      name: 'Why it matters',
      value: `${Math.round((campaign.length / Math.max(1, totals.earning)) * 100)}% of earning creators have never matched. `
        + `Between them they are already producing ~${n(upside)} diamonds a month without ever reaching a new room.`,
    });
  }

  if (concentration.length) {
    fields.push({
      name: `Income resting on a handful of people (${concentration.length})`,
      value: `90%+ of their diamonds come from their fan club. One member leaving is a visible drop.\n\n`
        + concentration.slice(0, size)
          .map((r) => `**@${r.creator.username}** · ${r.creator.group ?? '—'} · ${Math.round(r.share * 100)}% from ${n(r.members)} members${r.perMember ? ` (~${n(r.perMember)} each)` : ''}`)
          .join('\n').slice(0, 900),
    });
    fields.push({
      name: 'Why it matters',
      value: 'This is not urgent this week and it is how a top creator collapses in a month. '
        + 'The fix is reach, not retention: short form, matches, a lower entry gift tier.',
    });
  }

  return {
    embeds: [{
      title: `LEAP network programmes — week of ${asOf}`,
      description: 'Findings that are a decision about how the network runs, rather than '
        + 'something to raise with one creator at a time.',
      color: COLOR.opportunity,
      fields,
      footer: { text: 'Posted weekly.' },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** Posted when a follow-up window closes, so the coach learns what their call did. */
export function followUpEmbed(caseRecord, { mention = null, buttons = true, avatar = null } = {}) {
  const o = caseRecord.outcome;
  const book = PLAYBOOK[caseRecord.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
  const good = o.verdict === 'recovered';
  return {
    content: mention ?? undefined,
    embeds: [{
      author: authorBlock(caseRecord, avatar),
      title: VERDICT_LABEL[o.verdict] ?? o.verdict,
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
      footer: { text: footerText(caseRecord) },
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
  health = null, openCases = [], staleness = null, activation = null,
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

  const fields = [];

  // Stale data first: every other number below it is only as good as this.
  if (staleness && staleness.level !== 'ok' && staleness.level !== 'none') {
    fields.push({
      name: staleness.level === 'urgent' ? 'UPLOAD OVERDUE' : 'Upload overdue',
      value: staleness.message,
    });
  }

  fields.push(
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
        changes.deferred?.length ? heldLine(changes.deferred) : null,
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
  );

  // The creators the decline rules cannot see, because they never started.
  if (activation?.total) {
    fields.push({
      name: 'Never started',
      value: [
        `**${activation.total}** earning nothing this month`,
        `${activation.newNotStarted} never gone live · ${activation.stalled} live but earning nothing`,
        `${activation.decide} need a decision · ${activation.dormant} established and stopped`,
        `${activation.open} on the activation list now`,
      ].join('\n'),
      inline: false,
    });
  }

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
