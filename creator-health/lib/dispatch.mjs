// Decides who hears about what, and posts it.
//
// The rule throughout: a coach hears about their own creators, and the managers'
// channel hears only about what the coaches have not dealt with. Anything else
// trains people to ignore the channel.
import { Discord, declineEmbed, opportunityEmbed, followUpEmbed, escalationEmbed, summaryEmbed } from './discord.mjs';
import { STATUS } from './cases.mjs';

/** Where one coach's cards go, in order of preference. */
function routeFor(coach, discordConfig) {
  const entry = discordConfig.coaches?.[coach] ?? null;
  return {
    webhook: entry?.webhook ?? discordConfig.defaultWebhook ?? null,
    channelId: entry?.channelId ?? discordConfig.defaultChannelId ?? null,
    userId: entry?.userId ?? null,
    mention: entry?.mention ?? null,
    found: Boolean(entry),
  };
}

async function deliver(client, route, payload) {
  // Webhooks first: they need no bot token, so a network can start on them.
  if (route.webhook) return client.postToWebhook(route.webhook, payload);
  if (route.channelId) return client.postToChannel(route.channelId, payload);
  if (route.userId) return client.postToUser(route.userId, payload);
  return { ok: false, error: 'no Discord destination configured for this coach' };
}

export function caseStats(store, asOf) {
  const all = store.all();
  const count = (p) => all.filter(p).length;
  return {
    open: count((c) => c.status === STATUS.OPEN),
    acknowledged: count((c) => c.status === STATUS.ACKNOWLEDGED),
    actioned: count((c) => c.status === STATUS.ACTIONED),
    snoozed: count((c) => c.status === STATUS.SNOOZED),
    openedToday: count((c) => c.openedOn === asOf),
    resolvedToday: count((c) => c.outcome?.on === asOf && c.status === STATUS.RESOLVED),
    unacknowledged: count((c) => c.status === STATUS.OPEN && c.openedOn < asOf),
  };
}

/**
 * Post everything the day produced.
 *
 * `dryRun` renders every payload without sending, which is what the CLI uses to
 * let someone read exactly what their coaches would have received.
 */
/**
 * Refuse to start rather than fail one message at a time.
 *
 * Without this, a half-configured Discord block (mode `bot`, no token) means
 * every card is attempted, times out, and retries — a daily run that should
 * take seconds instead hangs for minutes and still delivers nothing.
 */
export function preflight(discordConfig) {
  if (!discordConfig?.enabled) return { ok: false, reason: 'Discord is disabled in routes.json' };
  const hasWebhook = Boolean(discordConfig.defaultWebhook)
    || Object.values(discordConfig.coaches ?? {}).some((c) => c.webhook);
  if (discordConfig.mode === 'bot' && !discordConfig.botToken) {
    return hasWebhook
      ? { ok: true, warning: 'no bot token — only coaches with a webhook will be messaged' }
      : { ok: false, reason: 'mode is "bot" but DISCORD_BOT_TOKEN is not set' };
  }
  const hasDestination = hasWebhook || discordConfig.defaultChannelId
    || Object.values(discordConfig.coaches ?? {}).some((c) => c.channelId || c.userId);
  if (!hasDestination) return { ok: false, reason: 'no channel, user or webhook configured for anyone' };
  return { ok: true };
}

export async function dispatch({
  asOf, changes, alerts, spotlight, ramp, stats, store, discordConfig, dryRun = false,
}) {
  const check = preflight(discordConfig);
  if (!dryRun && !check.ok) return { sent: [], previews: [], skipped: check.reason };
  const client = new Discord({ token: discordConfig.botToken });
  const alertByKey = new Map(alerts.map((a) => [a.creator.key, a]));
  const spotlightByKey = new Map(spotlight.map((r) => [r.creator.key, r]));
  const sent = [];
  const previews = [];

  const send = async (label, coach, route, payload, caseRecord = null) => {
    if (dryRun) {
      previews.push({ label, coach, payload });
      sent.push({ label, coach, ok: true, dryRun: true });
      return;
    }
    const res = await deliver(client, route, payload);
    if (res.ok && caseRecord && res.body?.id) {
      caseRecord.discord = { channelId: res.body.channel_id ?? route.channelId, messageId: res.body.id };
    }
    sent.push({ label, coach, ok: res.ok, error: res.error, caseId: caseRecord?.id });
  };

  // --- newly opened cases ---------------------------------------------------
  for (const c of changes.opened) {
    const route = routeFor(c.coach, discordConfig);
    if (c.kind === 'decline') {
      const alert = alertByKey.get(c.creatorKey);
      if (!alert) continue;
      await send('case-opened', c.coach, route, declineEmbed(c, alert, { mention: route.mention }), c);
    } else {
      const row = spotlightByKey.get(c.creatorKey);
      if (!row) continue;
      await send('opportunity-opened', c.coach, route, opportunityEmbed(c, row, { mention: route.mention }), c);
    }
  }

  // --- cases that got worse while already open ------------------------------
  // Only urgent deterioration is re-posted. Everything else is visible on the
  // existing card and in the caseload, and re-posting it is how a channel
  // becomes noise.
  for (const c of changes.worsened) {
    if (c.severity !== 'urgent') continue;
    const alert = alertByKey.get(c.creatorKey);
    if (!alert) continue;
    const route = routeFor(c.coach, discordConfig);
    const payload = declineEmbed(c, alert, { mention: route.mention });
    payload.embeds[0].title = `⏫ ${payload.embeds[0].title} — getting worse`;
    await send('case-worsened', c.coach, route, payload, c);
  }

  // --- follow-ups that came due --------------------------------------------
  for (const c of changes.dueFollowUps) {
    const route = routeFor(c.coach, discordConfig);
    await send('follow-up', c.coach, route, followUpEmbed(c, { mention: route.mention }), c);
  }

  // --- nobody picked these up ----------------------------------------------
  if (changes.escalated.length && discordConfig.escalationChannelId) {
    await send('escalation', '(managers)', { channelId: discordConfig.escalationChannelId },
      escalationEmbed(changes.escalated, asOf));
  }

  // --- daily roll-up --------------------------------------------------------
  if (discordConfig.summaryChannelId) {
    await send('summary', '(summary)', { channelId: discordConfig.summaryChannelId },
      summaryEmbed({ asOf, stats, caseStats: caseStats(store, asOf), alerts, ramp, spotlight }));
  }

  if (!dryRun) store.save();
  return { sent, previews, warning: check.warning };
}
