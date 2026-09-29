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
import { MILESTONES } from './graduation.mjs';
import { coachName, offTheBoards, earningsHidden } from './coaches.mjs';
import { hrs } from './hardestworker.mjs';
import { PILLARS } from './creatorweek.mjs';

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
  // The winner's card, once a month. Nothing else in the system uses it.
  gold: 0xe0a800,
};

const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));

/**
 * Break a list across as many fields and messages as it takes to show all of it.
 *
 * Discord caps a field value at 1024 characters and a whole embed at 6000, so
 * a long list has to be split rather than trimmed. Trimming is what this
 * replaces: a card that ended "and 18 more" was unusable to anyone working
 * through the names one by one.
 *
 * Continuation messages carry the part number in their title. That is not
 * decoration — the duplicate sweep matches on exact title, so parts must not
 * share one, or posting part 2 would delete part 1.
 */
function paginateList(lines, { name, title, description, color, footer, extraFields = [] }) {
  const FIELD = 1000;      // under Discord's 1024, with room for the join
  const EMBED = 5200;      // under 6000, leaving room for title and footer
  const FIELDS = 20;       // under 25

  const fields = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    fields.push({ name: fields.length === 0 ? name : `${name}, cont. ${fields.length + 1}`, value: cur.join('\n') });
    cur = []; curLen = 0;
  };
  for (const line of lines) {
    if (curLen + line.length + 1 > FIELD) flush();
    cur.push(line); curLen += line.length + 1;
  }
  flush();
  fields.push(...extraFields);

  // Now pack fields into messages that stay under the embed budget.
  const pages = [];
  let page = [];
  let pageLen = 0;
  for (const f of fields) {
    const size = f.name.length + f.value.length;
    if (page.length && (pageLen + size > EMBED || page.length >= FIELDS)) {
      pages.push(page); page = []; pageLen = 0;
    }
    page.push(f); pageLen += size;
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([]);

  return pages.map((pageFields, i) => ({
    embeds: [{
      title: pages.length > 1 ? `${title} (${i + 1} of ${pages.length})` : title,
      ...(i === 0 && description ? { description } : {}),
      color,
      fields: pageFields,
      footer: { text: footer },
      timestamp: new Date().toISOString(),
    }],
  }));
}

/** "2026-09" -> "September". */
const monthNameOf = (month) => new Date(`${month}-01T00:00:00Z`)
  .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

/** "1 card" / "2 cards". Nobody writes "card(s)" except a computer. */
const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

/**
 * Join a list to fit a Discord field, dropping whole entries rather than
 * cutting one in half, and saying honestly how many were left out.
 *
 * A plain slice is the obvious thing and it is wrong in two ways at once. It
 * lands mid-word — "@bia" where the creator is @biancasomething — and the
 * "and 48 more" it appends was counted before the slice, so the number is a
 * lie as well. Both read as a bug to anyone who looks.
 *
 * `total` is how many entries exist, when `parts` has already been capped by
 * the caller. The tail counts everything not shown, whichever cap dropped it.
 */
function fitJoin(parts, { total = parts.length, max = 1024, sep = '\n' } = {}) {
  const tailFor = (rest) => `${sep}… and ${n(rest)} more`;
  const fit = (reserve) => {
    const out = [];
    let len = 0;
    for (const part of parts) {
      const add = (out.length ? sep.length : 0) + part.length;
      if (len + add + reserve > max) break;
      out.push(part);
      len += add;
    }
    return out;
  };
  // If the whole list fits with nothing left over, it needs no room for a tail.
  const whole = fit(0);
  if (whole.length === parts.length && total === parts.length) return whole.join(sep);
  const shown = fit(tailFor(total).length);
  const rest = total - shown.length;
  return shown.join(sep) + (rest > 0 ? tailFor(rest) : '');
}
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
    // stored on the case and the card edited or removed later.
    return request('POST', `${url}${url.includes('?') ? '&' : '?'}wait=true`, { body: payload });
  }

  /**
   * Remove a message this webhook posted.
   *
   * A webhook can edit and delete its own messages with nothing but its URL, so
   * a channel that should only ever hold the current version of something does
   * not need a bot. A 404 means it is already gone, which is the outcome we
   * wanted, so it is not an error.
   */
  async deleteWebhookMessage(url, messageId) {
    const base = url.split('?')[0].replace(/\/$/, '');
    const res = await request('DELETE', `${base}/messages/${messageId}`, {});
    if (!res.ok && res.status === 404) return { ok: true, alreadyGone: true };
    return res;
  }

  /**
   * Remove a message the bot posted to a channel.
   *
   * The counterpart to deleteWebhookMessage, for routes that fall back to a
   * channel id and a bot token. A bot needs no special permission to delete
   * its OWN messages, so this works wherever it could post in the first place.
   * As above, a 404 means it is already gone, which is the outcome we wanted.
   */
  async deleteMessage(channelId, messageId) {
    const res = await request('DELETE', `/channels/${channelId}/messages/${messageId}`, { token: this.token });
    if (!res.ok && res.status === 404) return { ok: true, alreadyGone: true };
    return res;
  }

  /**
   * The most recent messages in a channel, newest first.
   *
   * Needs the bot token and Read Message History. Used to find our own older
   * copies of a card that the stored message id has lost track of.
   */
  listMessages(channelId, { limit = 100 } = {}) {
    return request('GET', `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`, { token: this.token });
  }

  /** Who this bot is, so its own posts can be told from everyone else's. */
  whoAmI() {
    return request('GET', '/users/@me', { token: this.token });
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

/**
 * The redo control for the management overview.
 *
 * Two steps on purpose. This puts about twenty cards into fourteen channels,
 * and one mis-click re-pings every coach, so the first press only opens a
 * confirmation nobody else can see.
 */
export function redoButton({ enabled = true } = {}) {
  if (!enabled) return [];
  return [{
    type: 1,
    components: [{
      type: 2, style: BUTTON.SECONDARY, label: 'Redo today',
      custom_id: customId('redo', 'today'),
    }],
  }];
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

function footerText(c, config = {}) {
  const coach = c.coach && c.coach !== 'unassigned' ? coachName(c.coach, config) : null;
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
export function declineEmbed(caseRecord, alert, { mention = null, buttons = true, avatar = null, config = {} } = {}) {
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
      footer: { text: footerText(caseRecord, config) },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** The card for a creator who can still land a 200k month. */
export function opportunityEmbed(caseRecord, row, { mention = null, buttons = true, avatar = null, config = {} } = {}) {
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
      footer: { text: footerText(caseRecord, config) },
      timestamp: new Date().toISOString(),
    }],
    components: caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** The card for a creator who has not started. */
export function activationEmbed(caseRecord, { mention = null, buttons = true, avatar = null, metrics = null, config = {} } = {}) {
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
      footer: { text: footerText(caseRecord, config) },
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
    const parts = list.slice(0, perStage).map((r) => {
      const tag = stage === 'DORMANT'
        ? (r.lastMonth > 0 ? ` (was ${n(r.lastMonth)})` : '')
        : r.day != null ? ` (d${r.day})` : '';
      return `@${r.creator.username}${tag}`;
    });
    fields.push({
      name: `${book.title ?? stage} — ${list.length}`,
      value: fitJoin(parts, { total: list.length, sep: ' · ' }),
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
 * A creator crossing a rung on the way to 200,000.
 *
 * The whole card is one question: can they still land it, and what has to
 * change today. So the numbers are the gap, the rate they are on, and the rate
 * they need — nothing that does not bear on that.
 */
export function graduationEmbed(p, { mention = null, finalPush = false, config = {} } = {}) {
  const done = p.done;
  const urgent = finalPush || (p.daysLeft <= 5 && !done);

  // Always the real gap, never the rung. A card headed "100,000 to go" on a
  // creator who is 70,042 short is a card a coach has to re-read.
  const title = done
    ? `Graduated — 200,000 banked in ${monthName(p.month)}`
    : `${n(p.remaining)} to go, ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;

  const description = done
    ? `\`${progressBar(p.monthToDate, p.target)}\`\n`
      + `**${n(p.monthToDate)}** in ${monthName(p.month)} — past the 200,000 graduation target`
      + (p.daysLeft > 0 ? ` with **${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}** of the month still to run.` : '.')
      + `\nDay ${p.day} of their 90.`
    : `\`${progressBar(p.monthToDate, p.target)}\`\n`
      + `**${n(p.monthToDate)} / ${n(p.target)}** in ${monthName(p.month)}, `
      + `**${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}** left.\n`
      + (p.requiredPerDay != null
        ? `They need **${n(p.requiredPerDay)}/day** from here. This week they are doing **${n(p.perDay)}/day**`
          + (p.stretch != null
            ? p.stretch <= 1 ? ' — **already at the rate**.'
              : ` — **${p.stretch.toFixed(1)}x** what they are doing now.`
            : '.')
        : 'No days left in the month.');

  const fields = [];
  if (!done && p.milestone) {
    fields.push({
      name: 'Why this landed now',
      value: `They just came inside **${n(p.milestone.remaining)}** of the target`
        + (p.alsoCrossed?.length ? `, passing ${p.alsoCrossed.map((m) => n(m.remaining)).join(' and ')} on the way` : '')
        + '. One card per mark, so this is the only time you will hear about this one.',
    });
  }
  if (!done) {
    fields.push(
      { name: 'Doing', value: `${n(p.perDay)}/day`, inline: true },
      { name: 'Needs', value: `${n(p.requiredPerDay)}/day`, inline: true },
      { name: 'Finishes on', value: n(p.projected), inline: true },
    );
    if (p.diamondsPerHour != null) {
      const hours = p.requiredPerDay != null && p.diamondsPerHour > 0
        ? p.requiredPerDay / p.diamondsPerHour : null;
      fields.push({
        name: 'What that is in LIVE hours',
        value: `At their ${n(p.diamondsPerHour)} per LIVE hour, ${
          hours != null ? `**${hours.toFixed(1)} hours a day** for the rest of the month` : 'unknown'}.`,
      });
    }
  }

  // What happens if this month does not land. A creator on their last attempt
  // is a different conversation from one with two more goes.
  fields.push({
    name: done ? 'What now' : 'If this month does not land',
    value: done
      ? `The counter resets on the 1st. Graduation is per month, so next month starts at zero — `
        + `the job now is holding the level, not chasing it again.`
      : p.attemptsLeft > 0
        ? `They have **${p.attemptsLeft} more month${p.attemptsLeft === 1 ? '' : 's'}** inside their 90 days to try again.`
        : '**This is their last month inside the 90-day window.** There is no next attempt.',
  });

  if (p.bestMonth > 0 && !done) {
    fields.push({ name: 'Their best month so far', value: n(p.bestMonth), inline: true });
  }

  return {
    content: mention ?? undefined,
    embeds: [{
      author: authorBlock({ username: p.username, group: p.group }, null),
      title,
      description,
      color: done ? COLOR.recovered : urgent ? COLOR.urgent : COLOR.opportunity,
      fields,
      footer: { text: `day ${p.day} of 90 · ${p.group ?? 'no team'}${p.coach ? ` · ${coachName(p.coach, config)}` : ''}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

const money = (amount, currency = 'GBP') => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 })
      .format(amount);
  } catch { return `${currency} ${amount}`; }
};

/**
 * One creator crossing the leaped line.
 *
 * A payroll event, so it says what was earned, by whom, and on what evidence.
 * Several in a day are digested into one card rather than posted separately —
 * a channel of forty is a spreadsheet, and this is meant to be read.
 */
export function leapedEmbed(rows, { threshold, currency = 'GBP', fee = 10 } = {}) {
  const one = rows.length === 1 ? rows[0] : null;
  const total = rows.reduce((n, r) => n + (r.fee ?? 0), 0);

  if (one) {
    return {
      embeds: [{
        author: authorBlock({ username: one.username, group: one.group }, null),
        title: `Leaped — ${money(one.fee, currency)}`,
        description: `**@${one.username}** has passed **${threshold.hours} LIVE hours** and `
          + `**${n(threshold.diamonds)} diamonds**.\n`
          + `They are on ${one.atHours}h and ${n(one.atDiamonds)} diamonds.`,
        color: COLOR.recovered,
        fields: [
          { name: 'Earned by', value: one.name ?? 'unassigned', inline: true },
          { name: 'Team', value: one.group ?? '—', inline: true },
          {
            name: 'Added to',
            value: `${new Date(`${one.month}-01T00:00:00Z`)
              .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} payroll`,
            inline: true,
          },
        ],
        footer: { text: `leaped ${one.on}` },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  return {
    embeds: [{
      title: `${rows.length} creators leaped — ${money(total, currency)}`,
      description: `Past **${threshold.hours} LIVE hours** and **${n(threshold.diamonds)} diamonds**.`,
      color: COLOR.recovered,
      fields: [{
        name: 'Who',
        value: fitJoin(
          rows.slice(0, 25).map((r) =>
            `**@${r.username}** — ${r.name ?? 'unassigned'} · ${r.atHours}h · ${n(r.atDiamonds)}`),
          { total: rows.length }),
      }],
      footer: { text: `leaped ${rows[0]?.on ?? ''} · ${money(fee, currency)} each` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** This month's leaped creators and what they are worth, per coach. */
export function leapedOverviewEmbed(s) {
  const monthName = new Date(`${s.month}-01T00:00:00Z`)
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const fields = [];

  if (s.coaches.length) {
    fields.push({
      name: 'Earned this month',
      value: s.coaches.map((c) =>
        `\`${money(c.owed, s.currency).padStart(6)}\`  **${c.name}** — ${c.count} leaped`)
        .join('\n').slice(0, 1024),
    });
  }

  if (s.today.length) {
    fields.push({
      name: s.fromSheet
        ? `Crossed the bar today — ${s.today.length}`
        : s.firstRun
          ? `Caught up on ${s.today.length} who leaped earlier this month`
          : `Leaped today — ${s.today.length}`,
      value: s.today.slice(0, 15).map((r) =>
        `**@${r.username}** · ${r.name} · ${r.atHours}h · ${n(r.atDiamonds)}`).join('\n').slice(0, 1024),
    });
  }

  if (s.close.length) {
    fields.push({
      name: `Closest to leaping — ${s.close.length} within ${n(1500)} diamonds`,
      value: s.close.slice(0, 10).map((r) => {
        const need = [
          r.needDiamonds > 0 ? `${n(r.needDiamonds)} diamonds` : null,
          r.needHours > 0 ? `${r.needHours}h LIVE` : null,
        ].filter(Boolean).join(' and ');
        return `**@${r.username}** needs ${need} · ${r.name}`;
      }).join('\n').slice(0, 1024),
    });
  }

  fields.push({
    name: 'How a creator leaps',
    value: `Cumulative **${s.threshold.hours} LIVE hours** and **${n(s.threshold.diamonds)} diamonds**, `
      + `at any point in their life with us — a creator who signed months ago and only clears it now `
      + `leaps now, and this month's payroll carries it. It happens once per creator, `
      + `and is worth ${money(s.fee, s.currency)}.`
      + (s.carriedOverTotal
        ? `\n\n**${s.carriedOverTotal}** creators were already past the line when this started. `
          + 'They are recorded so nobody is paid for them twice, and are not in the figures above.'
        : ''),
  });

  return {
    embeds: [{
      title: `Leaped creators — ${monthName}`,
      description: `**${s.leapedThisMonth ?? s.thisMonth.length}** leaped this month, `
        + `worth **${money(s.owed, s.currency)}**.\n`
        + `${s.totalLeaped} creators have leaped in total.`
        + (s.fromSheet
          ? `\n_This month's figures are LEAP's own, from the Recruitment sheet — `
            + `the same numbers as the wage block on your team card._`
          : ''),
      color: (s.leapedThisMonth ?? s.thisMonth.length) ? COLOR.recovered : COLOR.neutral,
      fields,
      footer: { text: `as of ${s.asOf}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Who climbed a LEAP league this month.
 *
 * Deliberately a celebration and nothing else. Biggest first, the jump stated
 * plainly, and how far the next one is — which is the only ask on the card.
 */
export function rankUpLeagueEmbed(board, { config = {} } = {}) {
  const rows = board.rankedUp;
  const leagues = {
    name: 'The leagues',
    value: board.standings.map((l) =>
      `\`${String(l.count).padStart(4)}\`  **${l.name}** — ${l.min ? `${n(l.min)}+` : 'under 50,000'}`).join('\n'),
  };

  return paginateList(
    rows.map((r) =>
      `**@${r.username}** ${r.from} to **${r.to}**${r.jumped > 1 ? ` (${r.jumped} leagues)` : ''}`
      + ` · ${n(r.diamonds)}`
      + (r.toNext != null ? ` · ${n(r.toNext)} more for ${r.nextLeague}` : '')
      + ` · ${r.name}`),
    {
      name: `Moved up — ${rows.length}`,
      title: `Ranked up — ${monthNameOf(board.month)}`,
      description: rows.length
        ? `**${rows.length}** creators have climbed a league this month.\n`
          + '_Month to date only goes up, so these are locked in for the month._'
        : 'Nobody has climbed a league yet this month.',
      color: rows.length ? COLOR.recovered : COLOR.neutral,
      footer: `${board.asOf} · ${board.daysLeft} days left in the month`,
      extraFields: [leagues],
    });
}

/**
 * Who has dropped out of the league they finished last month in.
 *
 * Two lists, and the split is the whole value of the card. A creator below
 * their league early in the month has not dropped — the month has barely
 * started. They have only dropped when the diamonds they still need are more
 * than their own rate can deliver in the days that are left.
 *
 * The ones who can still make it come first, because that is the list somebody
 * can do something about. Both are shown in full: staff work through these
 * name by name, so a trimmed list is worse than no list.
 */
export function deRankLeagueEmbed(board, { config = {} } = {}) {
  const winnable = board.slipping.map((r) =>
    `**@${r.username}** ${r.from} to ${r.to} · ${n(r.shortBy)} short`
    + ` · ${n(Math.ceil(r.shortBy / Math.max(1, r.daysLeft)))}/day · ${r.name}`);
  const gone = board.deRanked.map((r) =>
    `**@${r.username}** ${r.from} to **${r.to}** · ${n(r.diamonds)} against ${n(r.lastMonth)} last month · ${r.name}`);

  const total = winnable.length + gone.length;
  const pages = [];

  if (winnable.length) {
    pages.push(...paginateList(winnable, {
      name: `Can still make it back — ${winnable.length}`,
      title: `De-ranks — ${monthNameOf(board.month)}`,
      description: `**${gone.length}** cannot get back to last month's league. `
        + `**${winnable.length}** still can.\n`
        + '_A creator below their league early in the month has not dropped. They have dropped '
        + 'when what they still need is more than their own rate can deliver in the days left._',
      color: gone.length ? COLOR.warn : COLOR.neutral,
      footer: `${board.asOf} · ${board.daysLeft} days left in the month`,
    }));
  }

  if (gone.length) {
    pages.push(...paginateList(gone, {
      name: `Out of road — ${gone.length}`,
      title: winnable.length
        ? `De-ranked — ${monthNameOf(board.month)}`
        : `De-ranks — ${monthNameOf(board.month)}`,
      description: winnable.length ? null
        : `**${gone.length}** cannot get back to last month's league.`,
      color: COLOR.warn,
      footer: `${board.asOf} · ${board.daysLeft} days left in the month`,
    }));
  }

  if (!total) {
    pages.push(...paginateList([], {
      name: 'Nobody',
      title: `De-ranks — ${monthNameOf(board.month)}`,
      description: 'Nobody is below the league they finished last month in.',
      color: COLOR.neutral,
      footer: `${board.asOf} · ${board.daysLeft} days left in the month`,
    }));
  }

  return pages;
}

/**
 * One team's league movement, for the coach who runs it.
 *
 * The network cards go to the admin channels and cover everybody. This is the
 * same month cut down to the creators a coach can actually ring, and it goes
 * to their monitoring channel.
 *
 * Both directions on one card, in the order a coach can use: who climbed (say
 * well done), who can still get back (ring them today), who cannot (next
 * month's problem). Nothing is trimmed here either.
 */
export function teamLeagueEmbed(rows, { team, board, config = {} } = {}) {
  const up = rows.filter((r) => r.rankedUp);
  const winnable = rows.filter((r) => r.slipping);
  const gone = rows.filter((r) => r.deRanked);
  if (!up.length && !winnable.length && !gone.length) return [];

  const lines = [];
  if (up.length) {
    lines.push(`**Ranked up — ${up.length}**`);
    for (const r of up) {
      lines.push(`\`+\` **@${r.username}** ${r.from} to **${r.to}**`
        + `${r.jumped > 1 ? ` (${r.jumped} leagues)` : ''} · ${n(r.diamonds)}`
        + (r.toNext != null ? ` · ${n(r.toNext)} more for ${r.nextLeague}` : ''));
    }
  }
  if (winnable.length) {
    if (lines.length) lines.push('');
    lines.push(`**Can still get back — ${winnable.length}**`);
    for (const r of winnable) {
      lines.push(`\`>\` **@${r.username}** ${r.from} to ${r.to} · ${n(r.shortBy)} short`
        + ` · ${n(Math.ceil(r.shortBy / Math.max(1, r.daysLeft)))}/day`);
    }
  }
  if (gone.length) {
    if (lines.length) lines.push('');
    lines.push(`**Out of road — ${gone.length}**`);
    for (const r of gone) {
      lines.push(`\`-\` **@${r.username}** ${r.from} to **${r.to}** · ${n(r.diamonds)} against ${n(r.lastMonth)} last month`);
    }
  }

  return paginateList(lines, {
    name: 'This month',
    title: `${team} — league moves, ${monthNameOf(board.month)}`,
    description: `**${up.length}** up, **${winnable.length}** who can still get back, `
      + `**${gone.length}** who cannot.\n`
      + '_A rank-up is locked in for the month. A creator below their league has only dropped '
      + 'when what they still need is more than their own rate can deliver in the days left._',
    color: up.length ? COLOR.recovered : gone.length ? COLOR.warn : COLOR.neutral,
    footer: `${board.asOf} · ${board.daysLeft} days left in the month`,
  });
}

/**
 * The coach growth board.
 *
 * Deliberately sparse. A coach wants to know whether they are up, and where
 * they sit — not a spreadsheet. So it carries the rank, the movement, their own
 * real growth, and their team size, and nothing else per row.
 *
 * The order is growth weighted for how many creators it rests on, but the
 * number printed is the unweighted truth. One footnote explains why a big
 * percentage on a small team does not necessarily lead.
 */
export function growthBoardEmbed(b, { config = {} } = {}) {
  const monthName = new Date(`${b.month}-01T00:00:00Z`)
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const arrow = (r) => {
    if (r.isNew) return 'new';
    if (r.move == null || r.move === 0) return '  —';
    return r.move > 0 ? `+${r.move}` : String(r.move);
  };
  const place = (rank) => (rank <= 3 ? ['1st', '2nd', '3rd'][rank - 1] : `${rank}th`);

  const top = b.rows.slice(0, config.growthBoard?.show ?? 12);
  const board = top.map((r) =>
    `\`${place(r.rank).padStart(4)}  ${arrow(r).padStart(3)}  ${pct(r.growth).padStart(5)}\`  `
    + `**${r.name}**  ·  ${r.roster} creator${r.roster === 1 ? '' : 's'}${r.thin ? '  (small team)' : ''}`
  ).join('\n');

  const fields = [{
    name: `Against the same point in ${b.prevName}`,
    value: (board || 'Not enough history to rank anyone yet.').slice(0, 1024),
  }];

  const callouts = [];
  if (b.bestHabit?.habitRate != null) {
    callouts.push(`**${b.bestHabit.name}** has the most creators streaming regularly — `
      + `${Math.round(b.bestHabit.habitRate * 100)}% of their earners went LIVE ${b.habitTarget}+ days in 28.`);
  }
  if (b.bestConversion?.earningRate != null) {
    callouts.push(`**${b.bestConversion.name}** has the most of their roster earning — `
      + `${Math.round(b.bestConversion.earningRate * 100)}%.`);
  }
  if (callouts.length) {
    fields.push({ name: 'Not about size', value: callouts.join('\n').slice(0, 1024) });
  }

  fields.push({
    name: 'How this is ranked',
    value: 'Growth against the same point last month, on creators who were earning in both, '
      + 'weighted for how many creators it rests on. The same swing across five creators is not '
      + 'the same evidence as across a hundred, so a big percentage on a small team does not '
      + 'automatically lead. The percentage shown is the real one.',
  });

  return {
    embeds: [{
      title: `Growth leaderboard — ${monthName}`,
      description: `The network is **${pct(b.network)}** on the same point in ${b.prevName}, `
        + `with **${b.daysLeft}** day${b.daysLeft === 1 ? '' : 's'} to go.`,
      color: b.network >= 0 ? COLOR.recovered : COLOR.warn,
      fields,
      footer: { text: `${b.asOf} · ${b.rows.length} coach${b.rows.length === 1 ? '' : 'es'} ranked` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * The monthly new-creator leaderboard.
 *
 * Posted every day, so the movement has to be the news — a table of the same
 * totals as yesterday is not worth a notification. Rank change carries that,
 * and "+3 today" says who is actually working this week rather than who had a
 * good first of the month.
 */
export function leaderboardEmbed(b, { config = {} } = {}) {
  const monthName = new Date(`${b.month}-01T00:00:00Z`)
    .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

  // Movement, in the only two characters that read at a glance.
  const arrow = (r) => {
    if (r.isNew) return 'new';
    if (r.move == null || r.move === 0) return '  —';
    return r.move > 0 ? `+${r.move}` : String(r.move);
  };
  const medal = (rank) => (rank <= 3 ? ['1st', '2nd', '3rd'][rank - 1] : `${rank}th`);

  const top = b.rows.slice(0, config.leaderboard?.show ?? 10);
  const board = top.map((r) => {
    const gained = r.gained > 0 ? ` (+${r.gained} today)` : '';
    return `\`${medal(r.rank).padStart(4)}  ${arrow(r).padStart(3)}\`  **${r.name}** — `
      + `**${r.count}** signed · ${r.started} started · ${r.earning} earning${gained}`;
  }).join('\n');

  const fields = [{
    name: `Recruits this month — ${b.total} across ${b.rows.length} coach${b.rows.length === 1 ? '' : 'es'}`,
    value: (board || 'Nobody has signed anyone yet this month.').slice(0, 1024),
  }];

  if (b.standout) {
    fields.push({
      name: 'Best signing of the month so far',
      value: `**@${b.standout.username}** — ${n(b.standout.diamonds)} diamonds in ${b.standout.liveDays} LIVE days`
        + `\nSigned ${b.standout.joinDate} by **${b.standout.coachName ?? coachName(b.standout.coach, config)}**`
        + `${b.standout.group ? ` · ${b.standout.group}` : ''}`,
    });
  }

  if (b.teams.length > 1) {
    fields.push({
      name: 'By team',
      value: b.teams.slice(0, 10).map((t) =>
        `\`${String(t.count).padStart(3)}\` ${t.team} · ${t.started} started`).join('\n').slice(0, 1024),
    });
  }

  // The number that stops this becoming a race to sign anyone with a pulse.
  const rate = b.startedRate == null ? '—' : `${Math.round(b.startedRate * 100)}%`;
  fields.push({
    name: 'Signed is not started',
    value: `**${b.started} of ${b.total}** (${rate}) of this month's recruits have been LIVE at least once.`
      + (b.notStarted.length
        ? `\n**${b.notStarted.length}** have not. They are in the inactive channel, and they count against `
          + 'the graduation rate whether they start or not.'
        : '\nEvery one of them has started.'),
  });

  const pace = b.change != null
    ? `**${b.total}** signed so far, against **${n(b.lastToSamePoint)}** by day ${b.dayOfMonth} last month `
      + `(**${pct(b.change)}**).`
    : `**${b.total}** signed so far this month.`;
  const landing = b.projected == null ? '' : b.projectedFrom === 'last month'
    ? `\nLast month finished on **${n(b.lastMonthTotal)}**; on the same shape this one lands near **${n(b.projected)}**, `
      + `with **${b.daysLeft}** day${b.daysLeft === 1 ? '' : 's'} to go.`
    : `\nOn this pace the month finishes on **${n(b.projected)}**, with **${b.daysLeft}** day${b.daysLeft === 1 ? '' : 's'} to go.`;

  return {
    embeds: [{
      title: `New creator leaderboard — ${monthName}`,
      description: `${pace}${landing}`,
      color: b.change == null ? COLOR.opportunity : b.change >= 0 ? COLOR.recovered : COLOR.warn,
      fields,
      footer: { text: `${b.asOf} · resets on the 1st` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * LEAP's Hardest Worker Challenge, for the creator server.
 *
 * This is the one card in the system a creator reads, and it is deliberately
 * the plainest: a name and a number of hours, ten of them. No coach, no team,
 * no diamonds, no money — none of that is any other creator's business, and
 * none of it is what the challenge is about.
 *
 * The wording is LEAP's own, off the card they were making by hand every week,
 * with "every week" changed to what it now is. Keeping their words matters
 * more than improving them: creators have been reading this card for months
 * and it should carry on sounding like the same person wrote it.
 *
 * On the last day of the month the same card crowns the winner instead of
 * inviting people to climb, because by then nobody can.
 */
export function hardestWorkerEmbed(b, { config = {} } = {}) {
  const monthName = monthNameOf(b.month);
  const line = (r) => `${r.rank}. ${r.username} — ${hrs(r.hours)} hrs`;

  // Discord caps a field value at 1024 characters. Ten rows never comes close,
  // but `show` is configurable and a card that silently lost its last two rows
  // would be worse than one that prints fewer. Cut at a whole row.
  const rows = [];
  let len = 0;
  for (const r of b.top) {
    const t = line(r);
    if (len + t.length + 1 > 1000) break;
    rows.push(t); len += t.length + 1;
  }

  const left = b.daysLeft === 1 ? '1 day left' : `${b.daysLeft} days left`;

  if (b.finished && b.winner) {
    const behind = b.top.slice(1, 3).map((r) => r.username);
    return {
      embeds: [{
        title: `🏆 LEAP's Hardest Worker Challenge – ${monthName} winner`,
        description: `That's ${monthName} done, and the hardest worker of the month is `
          + `**${b.winner.username}** on **${hrs(b.winner.hours)} hours** streamed. 🔥\n\n`
          + `Huge congratulations${behind.length ? ` — and to ${behind.join(' and ')} right behind them` : ''}. `
          + 'Every one of you on this board put the hours in, and it shows. 💪',
        color: COLOR.gold,
        fields: [{ name: `${monthName} final leaderboard`, value: rows.join('\n') }],
        footer: { text: `Final standings for ${monthName}. The board resets on the 1st — new month, new challenge. 🚩` },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  return {
    embeds: [{
      title: `🏆 LEAP's Hardest Worker Challenge – ${monthName}`,
      description: 'Welcome to our monthly Hardest Worker Challenge! 💪\n\n'
        + 'Below is the current leaderboard showing how many hours each creator has streamed '
        + 'so far this month. The leaderboard is **updated every day**, so keep grinding and '
        + 'climb the ranks to win prizes and recognition! 🔥',
      color: COLOR.recovered,
      fields: [{
        name: `${monthName} leaderboard`,
        value: rows.join('\n') || 'Nobody has been LIVE yet this month. First one on the board takes top spot. 🔥',
      }],
      footer: { text: `Updated daily · ${left} in ${monthName} · Keep streaming to stay on top! 🚩` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Creator of the Week, for the creator server.
 *
 * Creator-facing like the Hardest Worker card, and written the same way: a name
 * and what they grew, no coach, no team, no money. The difference is that this
 * one has to say how it is judged, because "who grew the most" is a claim and
 * a board that will not show its reasoning is a board creators argue with.
 *
 * On Sunday the week is over and the same card crowns the winner.
 */
export function creatorWeekEmbed(b, { config = {} } = {}) {
  const span = weekSpan(b.weekStart, b.weekEnd);

  // What a creator earned, streamed, gained and built is their own business,
  // and the whole network reads this channel. So none of it is printed. The
  // score is built from positions rather than quantities, so it ranks people
  // without telling anybody what anybody did.
  const move = (r) => {
    if (r.isNew) return '  new';
    if (r.move == null) return '';
    if (r.move === 0) return '    ·';
    return r.move > 0 ? `  ▲${r.move}` : `  ▼${-r.move}`;
  };
  const line = (r) => `${r.rank}. ${r.username} — ${r.points} pts${move(r)}`;

  const rows = [];
  let len = 0;
  for (const r of b.top) {
    const t = line(r);
    if (len + t.length + 1 > 1000) break;
    rows.push(t); len += t.length + 1;
  }

  const judged = 'This is not a board for whoever is biggest. Your score is out of 100 and it is '
    + 'mostly about how much **you** have grown this week against your own recent weeks — fan club, '
    + 'diamonds, LIVE hours and new followers — with some credit for how you are doing across the '
    + 'network. Nobody\'s figures are shown, only the score.';

  if (b.finished && b.winner) {
    const w = b.winner;
    const behind = b.top.slice(1, 3).map((r) => r.username);
    // What they grew more than anybody, and what they were outright best at.
    // Both are worth saying out loud and neither gives away a number.
    const grewMost = PILLARS.filter((p) => w.growthScores?.[p.key] === 1).map((p) => p.label);
    const bestAt = PILLARS.filter((p) => w.scores?.[p.key] === 1).map((p) => p.label);
    return {
      embeds: [{
        title: `👑 LEAP's Creator of the Week – ${span}`,
        description: `The week is done, and the creator who grew the most is **${w.username}**, `
          + `finishing on **${w.points} points**. 🔥\n\n`
          + (grewMost.length ? `Nobody in the network grew more this week for ${listOf(grewMost)}. ` : '')
          + (bestAt.length ? `Best in the whole network this week for ${listOf(bestAt)}.` : '')
          + (grewMost.length || bestAt.length ? '\n\n' : '')
          + `Huge congratulations${behind.length ? ` — and to ${behind.join(' and ')} right behind them` : ''}. `
          + 'Every creator on this board grew this week, and that is the whole point of it. 💪',
        color: COLOR.gold,
        fields: [{ name: `Final standings, ${span}`, value: rows.join('\n') }],
        footer: { text: 'A new week starts on Monday and everyone goes back to zero. Your turn. 🚩' },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  const left = b.daysLeft === 1 ? '1 day left' : `${b.daysLeft} days left`;
  return {
    embeds: [{
      title: `🌟 LEAP's Creator of the Week – ${span}`,
      description: `Welcome to Creator of the Week! 💪\n\n${judged}\n\n`
        + 'Below is where it stands right now. The board is **updated every day** and the winner '
        + 'is crowned on Sunday, so there is still time to climb. 🔥',
      color: COLOR.opportunity,
      fields: [{
        name: 'This week so far',
        value: rows.join('\n')
          || 'Nobody has been LIVE yet this week. First one on the board takes top spot. 🔥',
      }],
      footer: { text: `Updated daily · ${left} this week · ▲ is places moved since yesterday · Go LIVE and grow. 🚩` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** "a, b and c" — for a list a person reads rather than scans. */
const listOf = (xs) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** "15–21 September", or "29 September – 5 October" when a week straddles two. */
function weekSpan(start, end) {
  const day = (d) => String(Number(d.slice(8, 10)));
  const month = (d) => monthNameOf(d.slice(0, 7));
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${day(start)}–${day(end)} ${month(end)}`
    : `${day(start)} ${month(start)} – ${day(end)} ${month(end)}`;
}

/**
 * One creator about to miss the activeness gate.
 *
 * The gate is a cliff: 15 LIVE hours across more than 7 days in the calendar
 * month, or the rank-up incentive pays nothing on them at all. So the card
 * leads with the two gaps and the days left, and says what it is worth.
 */
export function activenessPingEmbed(r, { mention = null, config = {} } = {}) {
  const gaps = [
    r.daysShort > 0 ? `**${r.daysShort} more LIVE day${r.daysShort === 1 ? '' : 's'}**` : null,
    r.hoursShort > 0 ? `**${r.hoursShort} more hour${r.hoursShort === 1 ? '' : 's'}**` : null,
  ].filter(Boolean).join(' and ');

  const urgent = r.daysLeft <= 3 || r.daysShort >= r.daysLeft;

  return {
    content: mention ?? undefined,
    embeds: [{
      author: authorBlock({ username: r.username, group: r.group }, null),
      title: `${gaps.replace(/\*\*/g, '')} to clear activeness — ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`,
      description: `They are on **${r.hours}h** across **${r.days} LIVE day${r.days === 1 ? '' : 's'}** this month.\n`
        + `The gate is **${r.needHours}h across ${r.needDays} days**`
        + (r.prorated ? ` (scaled to ${Math.round(r.scale * 100)}% — they joined mid-month)` : '')
        + `.\nThey need ${gaps} before the 1st.`,
      color: urgent ? COLOR.urgent : COLOR.warn,
      fields: [
        { name: 'Has done', value: `${r.hours}h · ${r.days} days`, inline: true },
        { name: 'Needs', value: `${r.needHours}h · ${r.needDays} days`, inline: true },
        { name: 'Days left', value: String(r.daysLeft), inline: true },
        {
          name: 'Why it matters',
          value: `Miss this and the rank-up incentive pays **nothing** on their `
            + `${n(r.diamonds)} diamonds this month — up to **${n(r.atStake)}** forgone. `
            + `It resets on the 1st, so there is no catching up next month.`,
        },
        ...(r.daysShort > 0 && r.daysShort >= r.daysLeft
          ? [{ name: 'Tight', value: `They have to go LIVE **every remaining day** to clear it.` }]
          : []),
      ],
      footer: { text: `${r.group ?? 'no team'}${r.coach ? ` · ${coachName(r.coach, config)}` : ''} · activeness gate` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** The daily network picture of the activeness gate. */
export function activenessOverviewEmbed(s, { config = {} } = {}) {
  const pctClear = s.total ? Math.round((s.cleared / s.total) * 100) : 0;
  const fields = [];

  if (s.oneDayShort.length) {
    fields.push({
      name: `One LIVE day short — ${s.oneDayShort.length}`,
      value: s.oneDayShort.slice(0, 10).map((r) =>
        `**@${r.username}** ${r.hours}h/${r.days}d · ${n(r.diamonds)} · ${r.group ?? '—'}`).join('\n').slice(0, 1024),
    });
  }
  if (s.hoursOnly.length) {
    fields.push({
      name: `Days met, hours short — ${s.hoursOnly.length}`,
      value: s.hoursOnly.slice(0, 10).map((r) =>
        `**@${r.username}** ${r.hoursShort}h to go · ${n(r.diamonds)} · ${r.group ?? '—'}`).join('\n').slice(0, 1024),
    });
  }

  const teams = s.teams.filter((t) => t.worthChasing > 0 || t.lost > 0).slice(0, 12);
  if (teams.length) {
    fields.push({
      name: `By team — worth chasing (past ${n(s.minDiamonds)} diamonds)`,
      value: teams.map((t) =>
        `\`${String(t.worthChasing).padStart(3)}\` ${t.team} · ~${n(t.atStake)} at stake`
        + (t.lost ? ` · ${t.lost} already gone` : '')).join('\n').slice(0, 1024),
    });
  }

  fields.push({
    name: 'What the gate is',
    value: '15 LIVE hours across more than 7 days in the calendar month, excluding static streams. '
      + 'Clear it and the rank-up incentive can pay on that creator; miss it and it pays nothing, '
      + 'whatever they earned. It resets on the 1st.',
  });

  return {
    embeds: [{
      title: `Activeness — ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left in the month`,
      description: `\`${progressBar(s.cleared, s.total)}\`\n`
        + `**${s.cleared} of ${s.total}** active creators have cleared the gate (${pctClear}%).\n`
        + `**${s.reachable}** can still make it — **${s.worthChasing}** of them past ${n(s.minDiamonds)} diamonds, `
        + `worth up to **${n(s.atStake)}** in rank-up bonus.`
        + (s.lost ? `\n**${s.lost}** can no longer clear it this month — ~${n(s.forfeited)} gone.` : ''),
      color: s.reachable > 0 ? COLOR.warn : COLOR.recovered,
      fields,
      footer: { text: `${s.month} · posted once a day` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Where the network itself stands, for management.
 *
 * These are the two numbers TikTok judges LEAP on. Neither is a coach's to fix
 * directly, which is why they go here and not into a team channel.
 */
export function policyEmbed(p, { asOf }) {
  const g = p.graduation;
  const m = p.mature;
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const fields = [];

  fields.push({
    name: 'New creator graduation rate',
    value: [
      `**${pct(g.rate)}** — ${g.numerator} of ${g.denominator}`,
      `Counted: joined since ${g.since}, and past ${n(g.floor)} diamonds this month.`,
      `${g.joined} joined in the window; ${g.denominator} cleared ${n(g.floor)} and so are evaluated.`,
    ].join('\n'),
  });

  if (g.closest.length) {
    fields.push({
      name: 'Closest to graduating this month',
      value: g.closest.slice(0, 6).map((r) =>
        `**@${r.username}** ${n(r.remaining)} to go · ${r.group ?? '—'}`).join('\n').slice(0, 1024),
    });
  }

  fields.push({
    name: 'Mature creator rank-up and maintenance rate',
    value: [
      `**${pct(m.rate)}** — ${m.numerator} of ${m.denominator} held or raised their tier`,
      m.clearsBonus
        ? `Clears the ${pct(m.bonusAt)} line, so the rank-up bonus carries the extra 1%.`
        : `**${m.toBonus} more** would clear the ${pct(m.bonusAt)} line and add 1% to the rank-up bonus.`,
      m.clearsInvite
        ? `Clears the ${pct(m.inviteAt)} line for the premium invitation reward.`
        : `**${m.toInvite} more** would clear the ${pct(m.inviteAt)} line for the premium invitation reward.`,
    ].join('\n'),
  });

  if (m.dropped.length) {
    fields.push({
      name: 'Dropped a tier — closest to climbing back',
      value: m.dropped.slice(0, 6).map((r) =>
        `**@${r.username}** ${n(r.now)} now, was ${n(r.was)} · ${n(r.toHold)} to get back · ${r.group ?? '—'}`)
        .join('\n').slice(0, 1024),
    });
  }

  const st = p.standing;
  fields.push({
    name: st.safe ? 'Inactive-operations rule: not at risk' : 'Inactive-operations rule',
    value: [
      `New creators in 3 months: **${n(st.newCreators)}** (breaches under ${n(st.minNew)})`,
      `Diamonds in 3 months: **${n(st.diamonds)}** (breaches under ${n(st.minDiamonds)})`,
      st.safe
        ? 'All three have to breach together for a consequence. Two are clear, so this rule cannot fire.'
        : 'Both quantity criteria are breached. A third consecutive Low month would trigger a consequence.',
    ].join('\n'),
  });

  return {
    embeds: [{
      title: 'Where the network stands',
      description: 'The two rates TikTok sets our benefits tier on. '
        + `Graduation threshold for this region is **${n(g.threshold)}**.`,
      color: g.rate != null && g.rate > 0 ? COLOR.opportunity : COLOR.neutral,
      fields,
      footer: { text: `as of ${asOf} · 2026 Creator Network Policies & Rules` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * A coach's rough earnings, for the bottom of their daily summary.
 *
 * Laid out as a block per coach so it reads like a payslip rather than a
 * paragraph, and so a team with two coaches does not double the length of the
 * card. The warning goes FIRST and in bold: this number will be wrong, and
 * somebody reading it a fortnight from now must not be able to say they thought
 * it was their pay.
 */
export function revenueFields(rev, coaches, { config = {} } = {}) {
  if (!rev || !coaches?.length) return [];
  // Somebody not on a coach's package yet sees their team's card without a
  // wage on it. The figures are still computed; only the display is withheld.
  const shown = coaches.filter((r) => !earningsHidden(r.coach, config));
  const cur = rev.currency;
  const gbp = (x) => {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(x);
    } catch { return `${cur} ${x.toFixed(2)}`; }
  };
  const fields = [];

  // With nobody left to pay, the warning has nothing to disclaim and the
  // header would sit above an empty space. The all-staff recruitment board is
  // not earnings and is the same on every card, so it still goes out below.
  if (!shown.length) return fields;

  fields.push({
    name: 'Your revenue — rough estimate only',
    value: '**THIS IS FOR VISUAL PURPOSES AND A ROUGH ESTIMATE OF YOUR INCOME, NOT EXACT. '
      + 'FOR EXACT FIGURES TALK TO THE DIRECTORS**\n'
      + '_Paid on the 15th of next month._',
  });

  for (const r of shown) {
    const line = (label, value) => `${label.padEnd(26)}${value}`;
    fields.push({
      name: r.name,
      value: '```\n'
        + [
          ...(r.base ? [line('Extra revenue (fixed)', gbp(r.base))] : []),
          line('Recruits this month', String(r.recruited)),
          line('New recruit bonus', `${r.leapedCount} x ${gbp(rev.fee)}  =  ${gbp(r.recruitBonus)}`),
          line('Incremental share', `~${gbp(r.incrementalShare)}`),
          line('Rank ups', `~${gbp(r.rankUpBonus)}`),
          line('Onboarded all time', String(r.onboardedAllTime)),
          '',
          line('ESTIMATED THIS MONTH', `~${gbp(r.total)}`),
          line('with Backstage goals', `~${gbp(r.totalWithGoals)}`),
        ].join('\n')
        + '\n```'
        + `\n${n(r.diamonds)} diamonds · ${plural(r.rankUps, 'rank-up')}`
        + (r.closeToRankUp ? ` · ${r.closeToRankUp} more in reach, ~${gbp(r.rankUpUpside)}` : ''),
    });
  }

  return fields;
}

/**
 * Who in this team is nearly leaped, and what each one still needs.
 *
 * This replaced the all-staff recruitment board on the team card. That board
 * was the same nine lines on all ten cards and named nobody a coach could do
 * anything about; this names their own creators and the exact gap, so the card
 * ends on a job rather than on a scoreboard.
 *
 * Each one is £10 to the coach and a creator properly started, so it is worth
 * saying what is missing rather than only that something is.
 */
export function closeToLeapingFields(rows, { config = {}, limit = 10 } = {}) {
  if (!rows?.length) return [];
  const bar = config.leaped ?? {};
  const need = (r) => {
    const parts = [];
    if (r.needDiamonds > 0) parts.push(`${n(r.needDiamonds)} diamonds`);
    if (r.needHours > 0) parts.push(`${r.needHours}h LIVE`);
    return parts.length ? parts.join(' and ') : 'nothing — they are over the bar';
  };
  return [{
    name: `Closest to leaping — ${rows.length} in your team`,
    value: fitJoin([
      ...rows.slice(0, limit).map((r) => `**@${r.username}** needs ${need(r)}`),
      '',
      `Each one is **${money(bar.fee ?? 10, bar.currency ?? 'GBP')}** once they pass `
        + `**${bar.hours ?? 5} LIVE hours** and **${n(bar.diamonds ?? 5000)} diamonds**, counted over their whole time with us.`,
    ], { total: rows.length + 2 }),
  }];
}

/**
 * The rank-up brackets: who is close, what crossing is worth, and by when.
 *
 * This is the one block on the card a coach can act on the same day. It is
 * deliberately shaped as a chase rather than a report — a creator sitting
 * below a tier line is worth nothing at all until they cross it, and then they
 * are worth their whole month at once. That step is the entire motivation, so
 * the money is stated against the name and not buried in a total.
 *
 * `board` is a rankUpBoard; `coaches` are the coach addresses this card is for.
 */
export function rankUpFields(board, coaches, { config = {}, limit = 6 } = {}) {
  if (!board || !coaches?.length) return [];
  const cur = config.leaped?.currency ?? 'GBP';
  const money = (x) => {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(x);
    } catch { return `${cur} ${x.toFixed(2)}`; }
  };
  const fields = [];

  for (const coach of coaches) {
    // Every line here is a pound figure, so it is withheld with the rest.
    if (earningsHidden(coach, config)) continue;
    const e = board.byCoach.get(coach);
    if (!e || (!e.ranked.length && !e.close.length)) continue;

    const lines = [];
    if (e.ranked.length) {
      lines.push(`**Banked  ${money(e.worth)}**`);
      for (const r of e.ranked.slice(0, limit)) {
        lines.push(`\`+\` **${r.username}**  T${r.fromTier}>${r.toTier}  ${n(r.diamonds)}  ${money(r.worth)}`);
      }
      if (e.ranked.length > limit) lines.push(`   +${e.ranked.length - limit} more`);
    }

    if (e.close.length) {
      if (lines.length) lines.push('');
      lines.push(`**In reach  ${money(e.upside)}**`);
      for (const r of e.close.slice(0, limit)) {
        const per = r.needPerDay == null ? null : `  ${n(Math.ceil(r.needPerDay))}/day`;
        lines.push(`\`>\` **${r.username}**  T${r.fromTier}>${r.fromTier + 1}`
          + `  ${n(r.gap)} to go  ${money(r.worthIfCrossed)}${per ?? ''}`);
      }
      if (e.close.length > limit) lines.push(`   +${e.close.length - limit} more`);
    }

    fields.push({
      name: `Rank-ups — ${e.name}  ·  ${board.daysLeft} days left`,
      value: fitJoin(lines),
    });
  }

  return fields;
}

/**
 * The daily state of one team, for the coach who runs it.
 *
 * Ordered the way a coach spends their day: what the team is worth this month,
 * who is closest to 200k, who is worth pushing while the wind is behind them,
 * then what is slipping. The habit that drives all of it goes last, because it
 * is the one thing that is true every day and does not need reading twice.
 */
export function teamSummaryEmbed(summary, { mention = null, config = {} } = {}) {
  const s = summary;
  const fields = [];
  const line = (r, tail) => `**@${r.username}** ${tail}`;

  // A list is only as trustworthy as its count. Showing five under a heading
  // that says nine reads as a bug, so say what was left out.
  const listOf = (rows, total, render) =>
    fitJoin(rows.map(render), { total: total ?? rows.length });

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

  // The 200k ladder, when this team has anyone inside their 90 days.
  const g = s.graduation;
  if (g && g.total) {
    const band = (rows, label) => rows.length
      ? `**${label}** — ${rows.map((r) => `@${r.username} (${n(r.remaining)})`).join(' · ')}`
      : null;
    const lines = [
      g.graduated ? `**${g.graduated} graduated this month.**` : null,
      band(g.within10k, 'Within 10,000'),
      band(g.within25k, 'Within 25,000'),
      band(g.within50k, 'Within 50,000'),
      band(g.within100k, 'Within 100,000'),
      g.bestPlaced.length
        ? `**Best placed of the rest** — ${g.bestPlaced.map((r) =>
          `@${r.username} (${n(r.monthToDate)}, day ${r.day})`).join(' · ')}`
        : null,
      g.further ? `${g.further} of the ${g.total} inside their 90 days are more than 100,000 off.` : null,
    ].filter(Boolean);
    if (lines.length) {
      fields.push({
        name: `200k graduation — ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left to bank it`,
        value: lines.join('\n').slice(0, 1024),
      });
    }
  }

  const f = s.frequency;
  const habit = [
    `**${f.meeting} of ${s.roster.earning}** went live ${f.target}+ days in the last 28.`
      + ` Above that line **59%** grew last month, below it **31%**.`,
  ];
  if (f.closest.length) {
    habit.push(`Closest: ${
      f.closest.map((r) => `@${r.username} (${Math.round(r.liveDays28)}d)`).join(' · ')}`);
  }
  fields.push({ name: `Live ${f.target}+ days in 28`, value: fitJoin(habit) });

  // Last, deliberately: it is the part a coach will look for, and putting it
  // first would have the card read as a payslip with some creator notes
  // attached rather than the other way round.
  fields.push(...revenueFields(s.revenue, s.revenueCoaches, { config }));
  // Straight after the money, because it is the same money: this is the part
  // of it that has not been earned yet and still can be.
  fields.push(...rankUpFields(s.rankUp, (s.revenueCoaches ?? []).map((r) => r.coach), { config }));
  // Last: the shortest job on the card, and the one that pays today.
  fields.push(...closeToLeapingFields(s.closeToLeaping, { config }));

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
      footer: { text: `as of ${s.asOf} · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left in the month` },
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
export function followUpEmbed(caseRecord, { mention = null, buttons = true, avatar = null, config = {} } = {}) {
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
      footer: { text: footerText(caseRecord, config) },
      timestamp: new Date().toISOString(),
    }],
    components: good ? [] : caseButtons(caseRecord, { enabled: buttons }),
  };
}

/** Sent to the managers' channel when nobody has picked a case up. */
export function escalationEmbed(cases, asOf, config = {}) {
  const lines = cases.slice(0, 20).map((c) =>
    `• **@${c.username}** (${coachName(c.coach, config)}) — open since ${c.openedOn}, ~${n(c.valueAtRisk)} at risk · \`${c.id}\``);
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
  health = null, openCases = [], staleness = null, activation = null, graduation = null,
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
        ? `**${plural(posted.length, 'card')}**\n${deliveryLines.slice(0, 10).join('\n') || '—'}`
          + (failed.length ? `\n${failed.length} failed to send` : '')
        : failed.length ? `nothing delivered — ${plural(failed.length, 'failure')}` : 'Nothing new today.',
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
      name: '200k graduation',
      // Scoped to creators inside their 90 days, which is the only population
      // the target applies to. `ramp` covers a wider net for the report.
      value: graduation
        ? [
          `${graduation.graduated} graduated of ${graduation.total} in window`,
          `${graduation.within25k} within 25,000 · ${graduation.within100k} within 100,000`,
          `${graduation.daysLeft} day${graduation.daysLeft === 1 ? '' : 's'} left to bank it`,
        ].join('\n')
        : [
          `${byStatus.ON_TRACK ?? 0} on track · ${(byStatus.AT_RISK ?? 0) + (byStatus.OFF_TRACK ?? 0)} behind`,
          `${byStatus.ACHIEVED ?? 0} hit the target`,
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
        health.missingDays ? `${plural(health.missingDays, 'day')} never uploaded` : 'No missing days',
        // Two detectors, and only one of them needs daily history. Saying
        // "detection: off" while the month comparison is raising urgent cases
        // reads as a contradiction.
        `Month on month: on${health.monthSource ? ` (vs ${health.monthSource})` : ''}`,
        health.declineReady
          ? 'Week on week: on'
          : `Week on week: needs ~${plural(health.uploadsNeeded, 'more daily upload', 'more daily uploads')}`,
      ].join('\n'),
      inline: false,
    });
  }

  return {
    embeds: [{
      title: `LEAP creator overview — ${asOf}`,
      description: stats.quit
        ? `${plural(stats.quit, 'creator')} ${stats.quit === 1 ? 'has' : 'have'} left the network.`
        : undefined,
      color: changes.escalated?.length ? COLOR.escalation : COLOR.neutral,
      fields,
      footer: { text: 'Posted once a day. Team cards go to each team\'s channel.' },
      timestamp: new Date().toISOString(),
    }],
  };
}
