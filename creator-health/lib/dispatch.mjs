// Decides who hears about what, and posts it.
//
// The rule throughout: a coach hears about their own creators, and the managers'
// channel hears only about what the coaches have not dealt with. Anything else
// trains people to ignore the channel.
import {
  Discord, declineEmbed, opportunityEmbed, activationEmbed, followUpEmbed,
  escalationEmbed, overviewEmbed, programmesEmbed,
} from './discord.mjs';
import { campaignGap, concentrationRisk, programmesDue, uploadStaleness } from './programmes.mjs';
import { Avatars } from './profile.mjs';
import { STATUS, teamOutcomes, isOpen } from './cases.mjs';
import { groupKey, isChannelId, isWebhookUrl } from './notify.mjs';

/**
 * Where one creator's card goes.
 *
 * The channel comes from the team, because that is how the server is arranged,
 * but the @mention comes from the creator's own coach. A team channel with two
 * coaches in it would otherwise ping the wrong person for six of the creators
 * in Team Alpha.
 */
export function routeFor({ coach, group }, discordConfig) {
  const byCoach = discordConfig.coaches?.[String(coach ?? '').toLowerCase()] ?? null;
  const byGroup = discordConfig.groups?.[groupKey(group)] ?? null;
  const preferGroup = discordConfig.routeBy !== 'coach';
  const primary = preferGroup ? (byGroup ?? byCoach) : (byCoach ?? byGroup);
  const secondary = preferGroup ? byCoach : byGroup;

  return {
    webhook: primary?.webhook ?? secondary?.webhook ?? discordConfig.defaultWebhook ?? null,
    channelId: primary?.channelId ?? secondary?.channelId ?? discordConfig.defaultChannelId ?? null,
    userId: byCoach?.userId ?? null,
    // Always the individual coach where we know them, whichever channel it lands in.
    mention: byCoach?.mention ?? primary?.mention ?? null,
    matchedGroup: Boolean(byGroup),
    matchedCoach: Boolean(byCoach),
    viaDefault: !primary && !secondary,
  };
}

/**
 * Which teams and coaches have nowhere to post.
 *
 * Without this, a team with no channel silently falls through to the default
 * channel or nowhere at all, and nobody notices that a whole group of creators
 * stopped being monitored.
 */
export function coverage(creators, discordConfig) {
  const groups = new Map();
  for (const c of creators) {
    if (c.quitOn) continue;
    const key = groupKey(c.group);
    const entry = groups.get(key) ?? {
      label: c.group ?? '(no group)', creators: 0, coaches: new Set(),
      routed: isChannelId(discordConfig.groups?.[key]?.channelId)
        || isWebhookUrl(discordConfig.groups?.[key]?.webhook),
    };
    entry.creators++;
    if (c.manager) entry.coaches.add(c.manager);
    groups.set(key, entry);
  }
  const rows = [...groups.values()]
    .map((g) => ({ ...g, coaches: [...g.coaches] }))
    .sort((a, b) => b.creators - a.creators);
  return {
    groups: rows,
    unrouted: rows.filter((g) => !g.routed),
    unroutedCreators: rows.filter((g) => !g.routed).reduce((n, g) => n + g.creators, 0),
  };
}

async function deliver(client, route, payload, label = '') {
  // Webhooks first: they need no bot token, so a network can start on them.
  if (route.webhook) return client.postToWebhook(route.webhook, payload);
  if (route.channelId) return client.postToChannel(route.channelId, payload);
  if (route.userId) return client.postToUser(route.userId, payload);
  return {
    ok: false,
    error: `no Discord channel for ${label || 'this creator'} — add its team to routes.json (see: cli.mjs discord-check)`,
  };
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
    || Object.values(discordConfig.coaches ?? {}).some((c) => c.webhook)
    || Object.values(discordConfig.groups ?? {}).some((g) => g.webhook);
  if (discordConfig.mode === 'webhook' && !hasWebhook) {
    return { ok: false, reason: 'mode is "webhook" but no webhook URLs are set' };
  }
  if (discordConfig.mode === 'bot' && !discordConfig.botToken) {
    return hasWebhook
      ? { ok: true, warning: 'no bot token — only coaches with a webhook will be messaged' }
      : { ok: false, reason: 'mode is "bot" but DISCORD_BOT_TOKEN is not set' };
  }
  const hasDestination = hasWebhook || discordConfig.defaultChannelId
    || Object.values(discordConfig.coaches ?? {}).some((c) => c.channelId || c.userId)
    || Object.values(discordConfig.groups ?? {}).some((g) => g.channelId || g.webhook);
  if (!hasDestination) return { ok: false, reason: 'no channel, user or webhook configured for any team or coach' };
  return { ok: true };
}

export async function dispatch({
  asOf, changes, alerts, spotlight, ramp, stats, store, discordConfig,
  dryRun = false, forceSummary = false, health = null,
  creators = [], metricsByKey = new Map(), activation = [], config = {},
}) {
  const activationSummary = activation.length ? {
    total: activation.length,
    newNotStarted: activation.filter((r) => r.stage === 'NO_START').length,
    stalled: activation.filter((r) => r.stage === 'STALLED').length,
    decide: activation.filter((r) => r.stage === 'DECIDE').length,
    dormant: activation.filter((r) => r.stage === 'DORMANT').length,
    open: store.all().filter((c) => c.kind === 'activation' && isOpen(c)).length,
  } : null;
  const check = preflight(discordConfig);
  if (!dryRun && !check.ok) return { sent: [], previews: [], skipped: check.reason };
  const client = new Discord({ token: discordConfig.botToken });

  // Look up pictures for the creators about to be posted about, before any
  // card is built. Capped and cached, and a miss simply means no picture.
  const avatars = new Avatars(config.dataDir ?? '.', config.avatars);
  if (!dryRun) {
    await avatars.warm([
      ...changes.opened.map((c) => c.username),
      ...changes.dueFollowUps.map((c) => c.username),
    ]);
  }
  // Webhooks cannot carry working buttons at all, and a bot cannot until its
  // interactions endpoint is reachable.
  const buttons = discordConfig.mode === 'bot' && discordConfig.interactionsReady !== false;
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
    const res = await deliver(client, route, payload, caseRecord?.group ?? coach);
    if (res.ok && caseRecord && res.body?.id) {
      caseRecord.discord = { channelId: res.body.channel_id ?? route.channelId, messageId: res.body.id };
    }
    sent.push({ label, coach, ok: res.ok, error: res.error, caseId: caseRecord?.id });
  };

  // --- newly opened cases ---------------------------------------------------
  for (const c of changes.opened) {
    const route = routeFor(c, discordConfig);
    if (c.kind === 'decline') {
      const alert = alertByKey.get(c.creatorKey);
      if (!alert) continue;
      await send('case-opened', c.coach, route, declineEmbed(c, alert, { mention: route.mention, buttons, avatar: avatars.get(c.username) }), c);
    } else if (c.kind === 'activation') {
      await send('activation-opened', c.coach, route, activationEmbed(c, { mention: route.mention, buttons, avatar: avatars.get(c.username), metrics: metricsByKey.get(c.creatorKey) }), c);
    } else {
      const row = spotlightByKey.get(c.creatorKey);
      if (!row) continue;
      await send('opportunity-opened', c.coach, route, opportunityEmbed(c, row, { mention: route.mention, buttons, avatar: avatars.get(c.username) }), c);
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
    const route = routeFor(c, discordConfig);
    const payload = declineEmbed(c, alert, { mention: route.mention, buttons, avatar: avatars.get(c.username) });
    payload.embeds[0].title = `${payload.embeds[0].title} (getting worse)`;
    await send('case-worsened', c.coach, route, payload, c);
  }

  // --- follow-ups that came due --------------------------------------------
  for (const c of changes.dueFollowUps) {
    const route = routeFor(c, discordConfig);
    await send('follow-up', c.coach, route, followUpEmbed(c, { mention: route.mention, buttons, avatar: avatars.get(c.username) }), c);
  }

  // --- nobody picked these up ----------------------------------------------
  const escalationRoute = discordConfig.escalationWebhook
    ? { webhook: discordConfig.escalationWebhook }
    : discordConfig.escalationChannelId ? { channelId: discordConfig.escalationChannelId } : null;
  if (changes.escalated.length && escalationRoute) {
    await send('escalation', '(managers)', escalationRoute, escalationEmbed(changes.escalated, asOf));
  }

  // --- daily roll-up --------------------------------------------------------
  // The overview is a once-a-day post, not a per-run one. `run` may be invoked
  // more than once in a day — a retried upload, a manual re-run — and posting
  // the same summary each time is how a channel stops being read.
  const summaryRoute = discordConfig.summaryWebhook
    ? { webhook: discordConfig.summaryWebhook }
    : discordConfig.summaryChannelId ? { channelId: discordConfig.summaryChannelId } : null;

  // --- the weekly network post ---------------------------------------------
  if (summaryRoute && programmesDue(config, store, asOf)) {
    const campaign = campaignGap(creators, metricsByKey, config);
    const concentration = concentrationRisk(creators, metricsByKey, config);
    if (campaign.length || concentration.length) {
      await send('programmes', '(overview)', summaryRoute, programmesEmbed({
        asOf, campaign, concentration, config,
        totals: { earning: creators.filter((c) => !c.quitOn
          && (metricsByKey.get(c.key)?.curr28.diamonds ?? 0) > 0).length },
      }));
      if (!dryRun) store.data.lastProgrammesOn = asOf;
    }
  }

  const alreadyPosted = store.data.lastOverviewOn === asOf;
  if (summaryRoute && (!alreadyPosted || forceSummary)) {
    await send('overview', '(overview)', summaryRoute, overviewEmbed({
      asOf, stats, caseStats: caseStats(store, asOf), alerts, ramp, spotlight,
      changes, sent, teams: teamOutcomes(store, { now: asOf }), health,
      openCases: store.all().filter(isOpen),
      staleness: uploadStaleness(asOf, config),
      activation: activationSummary,
    }));
    if (!dryRun) store.data.lastOverviewOn = asOf;
  } else if (summaryRoute && alreadyPosted) {
    sent.push({ label: 'overview', coach: '(overview)', ok: true, skipped: 'already posted today' });
  }

  if (!dryRun) store.save();
  return { sent, previews, warning: check.warning };
}
