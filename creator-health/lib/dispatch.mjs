// Decides who hears about what, and posts it.
//
// The rule throughout: a coach hears about their own creators, and the managers'
// channel hears only about what the coaches have not dealt with. Anything else
// trains people to ignore the channel.
import {
  Discord, declineEmbed, opportunityEmbed, activationEmbed, followUpEmbed,
  escalationEmbed, overviewEmbed, programmesEmbed, activationRosterEmbed,
  teamSummaryEmbed, graduationEmbed,
  activenessPingEmbed, activenessOverviewEmbed, policyEmbed, leaderboardEmbed, growthBoardEmbed,
  hardestWorkerEmbed, creatorWeekEmbed,
  leapedEmbed, leapedOverviewEmbed,
  redoButton,
} from './discord.mjs';
import { campaignGap, concentrationRisk, programmesDue, rosterDue, uploadStaleness } from './programmes.mjs';
import { teamSummaries, teamSummaryDue } from './teamsummary.mjs';
import { graduationEvents } from './graduation.mjs';
import { activenessRows, activenessPings, recordPings, activenessSummary, activenessDue } from './activeness.mjs';
import { policyStanding } from './policy.mjs';
import { leaderboard, recordBoard, leaderboardDue } from './leaderboard.mjs';
import { hardestWorkerBoard, hardestWorkerDue } from './hardestworker.mjs';
import { creatorWeekBoard, creatorWeekDue } from './creatorweek.mjs';
import { growthBoard, recordGrowthBoard, growthBoardDue } from './growthboard.mjs';
import { leapedState, leapedDue } from './leaped.mjs';
import { coachRevenue } from './revenue.mjs';
import { rankUpBoard } from './tiers.mjs';
import { sweeper, sweepDuplicates, titleOf } from './sweep.mjs';
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

/**
 * Whether the message we posted last replaces the one still in the channel.
 *
 * Only within the same period. A monthly board's last post is the final
 * standings, and deleting it on the 1st to make room for a board showing nobody
 * having signed anybody yet throws the result away. So the channel ends up
 * holding one live board plus one closing board per month, which is what a
 * competition wants to keep.
 */
export function supersedes(previous, period, newId) {
  if (!previous?.id || !newId) return false;
  if (previous.id === newId) return false;
  // A null period means there is no edition worth keeping — yesterday's daily
  // summary is simply out of date. The boards pass their month, so the closing
  // board of each month survives into the next.
  if (period == null) return true;
  return previous.period === period;
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
  // Every webhook destination, not just the team ones. A server configured
  // only for the boards, or only for the overview, is a valid setup and used to
  // be refused here as "no webhook URLs are set".
  const singles = [
    'defaultWebhook', 'summaryWebhook', 'escalationWebhook', 'inactiveWebhook',
    'activenessOverviewWebhook', 'activenessPingWebhook',
    'leaderboardWebhook', 'growthBoardWebhook', 'hardestWorkerWebhook', 'creatorWeekWebhook',
  ];
  const hasWebhook = singles.some((k) => Boolean(discordConfig[k]))
    || Object.values(discordConfig.coaches ?? {}).some((c) => c.webhook)
    || Object.values(discordConfig.groups ?? {}).some((g) => g.webhook)
    || Object.values(discordConfig.teamSummaries ?? {}).some((g) => g.webhook);
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
    || Object.values(discordConfig.groups ?? {}).some((g) => g.channelId || g.webhook)
    || Object.values(discordConfig.teamSummaries ?? {}).some((g) => g.channelId);
  if (!hasDestination) return { ok: false, reason: 'no channel, user or webhook configured for any team or coach' };
  return { ok: true };
}

export async function dispatch({
  asOf, changes, alerts, spotlight, ramp, stats, store, discordConfig,
  dryRun = false, forceSummary = false, force = null, health = null,
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
  // Once-a-day posts that somebody has deliberately asked for again — after a
  // fix, or because a channel was misconfigured when the day's run went out.
  // The guard is right for automatic runs and wrong here.
  const forced = new Set(Array.isArray(force) ? force : force ? [...force] : []);
  const again = (what) => forced.has(what) || forced.has('all');

  const check = preflight(discordConfig);
  if (!dryRun && !check.ok) return { sent: [], previews: [], replaced: [], swept: [], skipped: check.reason };
  const client = new Discord({ token: discordConfig.botToken });

  // Discord resolves avatar URLs itself, so there is nothing to fetch here.
  const avatarConfig = config.avatars ?? {};
  // Webhooks cannot carry working buttons at all, and a bot cannot until its
  // interactions endpoint is reachable.
  const buttons = discordConfig.mode === 'bot' && discordConfig.interactionsReady !== false;
  // Creators who are earning nothing are their own kind of work: a long list a
  // coach triages in one sitting, not a daily interruption about someone who was
  // fine yesterday. They go to one shared channel so the team channels stay
  // about creators who are actually live and slipping.
  // The channel id is only usable with a bot token. Without one, an unset
  // DISCORD_WEBHOOK_INACTIVE would send every activation card at a channel we
  // cannot post to — so fall back to the team channels instead of losing them.
  const inactiveRoute = discordConfig.inactiveWebhook
    ? { webhook: discordConfig.inactiveWebhook, channelId: discordConfig.inactiveChannelId ?? null }
    : (discordConfig.inactiveChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.inactiveChannelId } : null;
  // The coach is still named and still pinged — only the channel changes.
  const activationRoute = (c) => {
    const team = routeFor(c, discordConfig);
    return inactiveRoute ? { ...inactiveRoute, mention: team.mention } : team;
  };

  const alertByKey = new Map(alerts.map((a) => [a.creator.key, a]));
  const spotlightByKey = new Map(spotlight.map((r) => [r.creator.key, r]));
  const sent = [];
  const previews = [];
  // Recurring cards whose previous copy was removed as this one went up. The
  // redo button reports this back, so somebody pressing it can see the old
  // cards actually went rather than hoping they did.
  const replaced = [];
  // Older copies of a card found in the channel itself rather than in our own
  // notes. Anything posted while the cleanup was broken is orphaned, because
  // the store only ever held the newest id.
  const swept = [];
  // Worked out once: reading a channel needs the bot token, and telling our
  // posts from another bot's needs the bot's own id.
  const sweep = dryRun ? null : await sweeper(discordConfig);

  const send = async (label, coach, route, payload, caseRecord = null) => {
    if (dryRun) {
      previews.push({ label, coach, payload, to: route.webhook ?? route.channelId ?? null });
      sent.push({ label, coach, ok: true, dryRun: true });
      return null;
    }
    const res = await deliver(client, route, payload, caseRecord?.group ?? coach);
    if (res.ok && caseRecord && res.body?.id) {
      caseRecord.discord = { channelId: res.body.channel_id ?? route.channelId, messageId: res.body.id };
    }
    sent.push({ label, coach, ok: res.ok, error: res.error, caseId: caseRecord?.id });
    return res;
  };

  /**
   * Post the new one, then remove the old one.
   *
   * For a board, a channel of thirty daily posts is thirty stale leaderboards
   * and one current one. This keeps exactly one, and it is a fresh message
   * rather than an edit so the channel still bumps and people still see that it
   * moved — an edited message notifies nobody.
   *
   * The order matters: post first, delete second. If the post fails there is
   * still yesterday's board in the channel, which is wrong but readable. Delete
   * first and a failed post leaves the channel empty.
   */
  // Which recurring posts keep only their current version. A per-creator card
  // is a work item and is never replaced; a summary that is re-posted every day
  // is the same message with new numbers, and thirty of them is thirty stale
  // copies and one useful one.
  const replaces = (kind) => config.posts?.replacePrevious?.[kind] !== false;

  // `who` is kept because the delivery record is read per team: a roster that
  // reports itself as "(activation-roster)" tells nobody which team it was for.
  const replaceLast = async (label, who, route, payload, slot, period = null) => {
    const res = await send(label, who, route, payload);
    if (dryRun || !res?.ok) return res;
    const prev = store.data.lastMessage?.[slot] ?? null;
    if (res.body?.id) {
      store.data.lastMessage ??= {};
      store.data.lastMessage[slot] = { id: res.body.id, period };
    }
    if (supersedes(prev, period, res.body?.id)) {
      // Whichever way this slot posts. A webhook deletes its own messages with
      // nothing but its URL; a bot deletes its own with its token. Before both
      // were handled, a route that fell back from a missing webhook env var to
      // a channel id posted fine and silently never cleaned up, so the channel
      // grew a copy a day while the code reported success.
      const gone = route.webhook
        ? await client.deleteWebhookMessage(route.webhook, prev.id)
        : route.channelId
          ? await client.deleteMessage(route.channelId, prev.id)
          : { ok: false, error: 'no webhook or channel to delete through' };
      if (gone.ok) replaced.push({ label, coach: who, slot, id: prev.id });
      else sent.push({ label: `${label}-cleanup`, coach: who, ok: false, error: gone.error });
    }

    // And then look at the channel, for the copies our notes never knew about.
    // Narrow on purpose: our own posts, the exact title of the card just sent,
    // and never the one just sent.
    const channelId = route.channelId ?? null;
    if (sweep && channelId && res.body?.id) {
      const out = await sweepDuplicates(sweep.client, {
        channelId, title: titleOf(payload), keepId: res.body.id, botUserId: sweep.botUserId,
      });
      if (out.ok && out.removed.length) swept.push({ label, coach: who, slot, removed: out.removed.length });
      else if (!out.ok) sent.push({ label: `${label}-sweep`, coach: who, ok: false, error: out.reason });
    }
    return res;
  };

  // --- newly opened cases ---------------------------------------------------
  for (const c of changes.opened) {
    const route = routeFor(c, discordConfig);
    if (c.kind === 'decline') {
      const alert = alertByKey.get(c.creatorKey);
      if (!alert) continue;
      await send('case-opened', c.coach, route, declineEmbed(c, alert, { mention: route.mention, buttons, avatar: avatarConfig, config }), c);
    } else if (c.kind === 'activation') {
      const r = activationRoute(c);
      await send('activation-opened', c.coach, r, activationEmbed(c, { mention: r.mention, buttons, avatar: avatarConfig, metrics: metricsByKey.get(c.creatorKey), config }), c);
    } else {
      const row = spotlightByKey.get(c.creatorKey);
      if (!row) continue;
      await send('opportunity-opened', c.coach, route, opportunityEmbed(c, row, { mention: route.mention, buttons, avatar: avatarConfig, config }), c);
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
    const payload = declineEmbed(c, alert, { mention: route.mention, buttons, avatar: avatarConfig, config });
    payload.embeds[0].title = `${payload.embeds[0].title} (getting worse)`;
    await send('case-worsened', c.coach, route, payload, c);
  }

  // --- follow-ups that came due --------------------------------------------
  for (const c of changes.dueFollowUps) {
    const route = c.kind === 'activation' ? activationRoute(c) : routeFor(c, discordConfig);
    await send('follow-up', c.coach, route, followUpEmbed(c, { mention: route.mention, buttons, avatar: avatarConfig, config }), c);
  }

  // --- the weekly activation roster, per team -------------------------------
  // Everyone who is not earning, in one message, so the creators who did not
  // get a card this week are still visible to their coach.
  if (rosterDue(config, store, asOf) && activation.length) {
    // Teams nobody is coaching never had a channel, so the roster for them used
    // to fall away on its own. One shared channel would now catch them, so the
    // same rule cases use has to be applied here too.
    const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
    const byTeam = new Map();
    for (const row of activation) {
      if (ignored.has(groupKey(row.creator.group))) continue;
      const key = row.creator.group ?? 'no team';
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(row);
    }
    for (const [team, rows] of byTeam) {
      const sample = rows[0].creator;
      const route = activationRoute({ coach: sample.manager, group: team });
      if (!route.webhook && !route.channelId) continue;
      const roster = activationRosterEmbed({ team, rows, asOf, config });
      await (replaces('activationRoster')
        ? replaceLast('activation-roster', team, route, roster, `roster:${groupKey(team)}`)
        : send('activation-roster', team, route, roster));
    }
    if (!dryRun) store.data.lastRosterOn = asOf;
  }

  // --- the 200k graduation chase --------------------------------------------
  // Ahead of the daily summary, because a creator 8,000 short with two days
  // left is the most time-critical thing a coach will read all day. These go to
  // the team's own channel, beside the declines: it is one creator, one action.
  //
  // A dry run must not spend a milestone. Each rung fires once per creator per
  // month, so previewing it would silently cost the real card.
  const grad = graduationEvents({ ramp, store, asOf, config, persist: !dryRun });
  const ignoredTeams = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  for (const p of [...grad.milestones, ...grad.finalPush]) {
    // Teams nobody coaches are out, explicitly rather than by happening to have
    // no channel: a default webhook added later would otherwise start posting
    // about creators the network decided not to monitor.
    if (ignoredTeams.has(groupKey(p.group))) continue;
    const isPush = !p.milestone;
    const route = routeFor({ coach: p.coach, group: p.group }, discordConfig);
    if (!route.webhook && !route.channelId) continue;
    await send(isPush ? 'graduation-push' : 'graduation-milestone', p.coach, route,
      graduationEmbed(p, { mention: route.mention, finalPush: isPush, config }));
  }

  // --- the activeness gate ---------------------------------------------------
  // A cliff, not a slope: miss 15 LIVE hours across more than 7 days in the
  // month and the rank-up incentive pays nothing on that creator at all. Pings
  // go to their own channel because they are a different job from a decline —
  // the fix is "go LIVE tonight", not a conversation about why revenue slipped.
  const actRoute = (kind) => {
    const hook = discordConfig[`activeness${kind}Webhook`];
    const chan = discordConfig[`activeness${kind}ChannelId`];
    if (hook) return { webhook: hook };
    // A channel id is only usable with a bot token to post with.
    return chan && discordConfig.botToken ? { channelId: chan } : null;
  };
  const pingRoute = actRoute('Ping');
  const activenessRoute = actRoute('Overview');
  let activeness = null;
  if (config.activeness?.enabled !== false && creators.length) {
    const rows = activenessRows({ creators, asOf, config, groupKey });
    activeness = activenessSummary(rows, config);

    if (pingRoute) {
      const due = activenessPings({ rows, store, asOf, config });
      for (const r of due) {
        const coachRoute = routeFor({ coach: r.coach, group: r.group }, discordConfig);
        await send('activeness-ping', r.coach, { ...pingRoute, mention: coachRoute.mention },
          activenessPingEmbed(r, { mention: coachRoute.mention, config }));
      }
      if (!dryRun && due.length) recordPings(store, asOf, due);
    }

    if (activenessRoute && rows.length && (again('activeness') || activenessDue(config, store, asOf))) {
      const card = activenessOverviewEmbed(activeness, { config });
      await (replaces('activenessOverview')
        ? replaceLast('activeness-overview', '(activeness)', activenessRoute, card, 'activenessOverview')
        : send('activeness-overview', '(activeness)', activenessRoute, card));
      if (!dryRun) store.data.lastActivenessOn = asOf;
    }
  }

  // --- leaped creators, worked out early -------------------------------------
  // The payroll records are needed twice: by the revenue block at the bottom of
  // each team's summary, and by the leaped channels further down. Computed once
  // here so both read the same records rather than each working it out.
  const leapedForRevenue = (config.leaped?.enabled !== false && creators.length)
    ? leapedState({ creators, asOf, store, config, persist: !dryRun })
    : null;
  const revenue = (config.revenue?.enabled !== false && creators.length)
    ? coachRevenue({ creators, asOf, config, leaped: leapedForRevenue })
    : null;
  // The rank-up brackets share the summary card with the pay block, so they
  // are worked out here alongside it rather than inside the renderer.
  const rankUp = (config.rankUp?.enabled !== false && creators.length)
    ? rankUpBoard({ creators, asOf, config })
    : null;

  // --- the daily picture of each team ---------------------------------------
  // Posted before the escalation and the overview, so a coach opening Discord
  // in the morning reads where their team stands before they read what is
  // wrong with it.
  if (Object.keys(discordConfig.teamSummaries ?? {}).length
    && (again('summaries') || teamSummaryDue(config, store, asOf))) {
    const summaries = teamSummaries({ creators, metricsByKey, store, asOf, config, graduation: grad.rows, revenue, rankUp, leaped: leapedForRevenue });
    for (const [team, summary] of summaries) {
      const entry = discordConfig.teamSummaries[groupKey(team)];
      // The channel id is only usable with a bot token. The ids are committed
      // but the webhooks come from the environment, so an unset variable would
      // otherwise mean ten failed posts a day at a channel we cannot reach.
      const usable = entry?.webhook || (entry?.channelId && discordConfig.botToken);
      if (!usable) continue;
      // A team with nobody earning has nothing to summarise; the activation
      // roster already covers it, and an empty card every morning is how a
      // channel stops being read.
      if (!summary.roster.earning) continue;
      const route = { webhook: entry.webhook, channelId: entry.channelId };
      const card = teamSummaryEmbed(summary, { config });
      await (replaces('teamSummary')
        ? replaceLast('team-summary', team, route, card, `summary:${groupKey(team)}`)
        : send('team-summary', team, route, card));
    }
    if (!dryRun) store.data.lastTeamSummaryOn = asOf;
  }

  // --- nobody picked these up ----------------------------------------------
  const escalationRoute = discordConfig.escalationWebhook
    ? { webhook: discordConfig.escalationWebhook }
    : discordConfig.escalationChannelId ? { channelId: discordConfig.escalationChannelId } : null;
  if (changes.escalated.length && escalationRoute) {
    await send('escalation', '(managers)', escalationRoute, escalationEmbed(changes.escalated, asOf, config));
  }

  // --- daily roll-up --------------------------------------------------------
  // The overview is a once-a-day post, not a per-run one. `run` may be invoked
  // more than once in a day — a retried upload, a manual re-run — and posting
  // the same summary each time is how a channel stops being read.
  const summaryRoute = discordConfig.summaryWebhook
    ? { webhook: discordConfig.summaryWebhook, channelId: discordConfig.summaryChannelId ?? null }
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

  // --- the monthly recruitment board ----------------------------------------
  // Daily, because the movement is the point: a board that only changes when
  // somebody remembers to look is not a competition.
  const boardRoute = discordConfig.leaderboardWebhook
    ? { webhook: discordConfig.leaderboardWebhook, channelId: discordConfig.leaderboardChannelId ?? null }
    : (discordConfig.leaderboardChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.leaderboardChannelId } : null;
  if (boardRoute && creators.length && (again('leaderboard') || leaderboardDue(config, store, asOf))) {
    const board = leaderboard({ creators, asOf, store, config });
    if (board.total || board.lastMonthTotal) {
      const card = leaderboardEmbed(board, { config });
      await (replaces('leaderboard')
        ? replaceLast('leaderboard', '(leaderboard)', boardRoute, card, 'leaderboard', board.month)
        : send('leaderboard', '(leaderboard)', boardRoute, card));
      // Recorded after rendering, so today's card shows movement against
      // yesterday rather than against itself.
      if (!dryRun) { recordBoard(store, board); store.data.lastLeaderboardOn = asOf; }
    }
  }

  // --- the coach growth board ------------------------------------------------
  const growthRoute = discordConfig.growthBoardWebhook
    ? { webhook: discordConfig.growthBoardWebhook, channelId: discordConfig.growthBoardChannelId ?? null }
    : (discordConfig.growthBoardChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.growthBoardChannelId } : null;
  if (growthRoute && creators.length && (again('growth') || growthBoardDue(config, store, asOf))) {
    const gb = growthBoard({ creators, metricsByKey, asOf, store, config });
    // Nothing to rank in a network's first month; the card would be a heading.
    if (gb.rows.length) {
      const card = growthBoardEmbed(gb, { config });
      await (replaces('growthBoard')
        ? replaceLast('growth-board', '(growth)', growthRoute, card, 'growthBoard', gb.month)
        : send('growth-board', '(growth)', growthRoute, card));
      if (!dryRun) { recordGrowthBoard(store, gb); store.data.lastGrowthBoardOn = asOf; }
    }
  }

  // --- the creator-facing Hardest Worker Challenge ---------------------------
  // A different server to every other card here: this one is read by creators,
  // not coaches. Daily, and it takes yesterday's copy down with it.
  //
  // No period is passed, unlike the two coach boards above. Theirs keeps the
  // closing edition of each month; this one is asked to clear on the 1st, so
  // the new month's board deletes the old month's winner and starts from zero.
  const hardestRoute = discordConfig.hardestWorkerWebhook
    ? { webhook: discordConfig.hardestWorkerWebhook, channelId: discordConfig.hardestWorkerChannelId ?? null }
    : (discordConfig.hardestWorkerChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.hardestWorkerChannelId } : null;
  if (hardestRoute && creators.length && (again('hardestWorker') || hardestWorkerDue(config, store, asOf))) {
    const hw = hardestWorkerBoard({ creators, asOf, config });
    // A month nobody has streamed in yet is the 1st, and an empty board posted
    // to a creator channel is worse than none.
    if (hw.entered) {
      const card = hardestWorkerEmbed(hw, { config });
      await (replaces('hardestWorker')
        ? replaceLast('hardest-worker', '(hardest worker)', hardestRoute, card, 'hardestWorker')
        : send('hardest-worker', '(hardest worker)', hardestRoute, card));
      if (!dryRun) store.data.lastHardestWorkerOn = asOf;
    }
  }

  // --- Creator of the Week ---------------------------------------------------
  // The second creator-facing board, in the same server. Weekly rather than
  // monthly, and for the same reason as the Hardest Worker one it passes no
  // period: Monday's board removes Sunday's winner and the week starts again.
  const weekRoute = discordConfig.creatorWeekWebhook
    ? { webhook: discordConfig.creatorWeekWebhook, channelId: discordConfig.creatorWeekChannelId ?? null }
    : (discordConfig.creatorWeekChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.creatorWeekChannelId } : null;
  if (weekRoute && creators.length && (again('creatorWeek') || creatorWeekDue(config, store, asOf))) {
    const cw = creatorWeekBoard({ creators, asOf, config });
    // Nobody LIVE yet this week is Monday morning, and an empty board in a
    // creator channel is worse than none.
    if (cw.entered) {
      const card = creatorWeekEmbed(cw, { config });
      await (replaces('creatorWeek')
        ? replaceLast('creator-week', '(creator of the week)', weekRoute, card, 'creatorWeek')
        : send('creator-week', '(creator of the week)', weekRoute, card));
      if (!dryRun) store.data.lastCreatorWeekOn = asOf;
    }
  }

  // --- leaped creators, and the wage bill ------------------------------------
  // Payroll, so the state is worked out whether or not either channel is
  // configured: a leap must be recorded the day it happens, not the day
  // somebody remembers to set a webhook.
  const leapedRoute = discordConfig.leapedWebhook
    ? { webhook: discordConfig.leapedWebhook, channelId: discordConfig.leapedChannelId ?? null }
    : (discordConfig.leapedChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.leapedChannelId } : null;
  const leapedOverviewRoute = discordConfig.leapedOverviewWebhook
    ? { webhook: discordConfig.leapedOverviewWebhook, channelId: discordConfig.leapedOverviewChannelId ?? null }
    : (discordConfig.leapedOverviewChannelId && discordConfig.botToken)
      ? { channelId: discordConfig.leapedOverviewChannelId } : null;

  if (config.leaped?.enabled !== false && creators.length) {
    const leaped = leapedForRevenue;
    leaped.carriedOverTotal = Object.values(store.data.leaped ?? {}).filter((r) => r.carriedOver).length;

    if (leapedRoute && leaped.today.length) {
      const max = config.leaped?.maxCardsPerRun ?? 1;
      const opts = { threshold: leaped.threshold, currency: leaped.currency, fee: leaped.fee };
      if (leaped.today.length <= max) {
        for (const r of leaped.today) {
          await send('leaped', r.name, leapedRoute, leapedEmbed([r], opts));
        }
      } else {
        await send('leaped', '(leaped)', leapedRoute, leapedEmbed(leaped.today, opts));
      }
    }

    if (leapedOverviewRoute && (again('leapedOverview') || leapedDue(config, store, asOf))) {
      const card = leapedOverviewEmbed(leaped);
      await (replaces('leapedOverview')
        ? replaceLast('leaped-overview', '(leaped)', leapedOverviewRoute, card, 'leapedOverview')
        : send('leaped-overview', '(leaped)', leapedOverviewRoute, card));
      if (!dryRun) store.data.lastLeapedOn = asOf;
    }
  }

  // --- where the network itself stands --------------------------------------
  // The two rates TikTok sets our benefits tier on. Management's channel, once
  // a day, beside the overview: no coach can move these directly.
  if (summaryRoute && creators.length && (again('policy') || store.data.lastPolicyOn !== asOf)) {
    const card = policyEmbed(policyStanding({ creators, asOf, config }), { asOf });
    await (replaces('policy')
      ? replaceLast('policy', '(overview)', summaryRoute, card, 'policy')
      : send('policy', '(overview)', summaryRoute, card));
    if (!dryRun) store.data.lastPolicyOn = asOf;
  }

  const alreadyPosted = store.data.lastOverviewOn === asOf;
  if (summaryRoute && (!alreadyPosted || forceSummary || again('overview'))) {
    const card = overviewEmbed({
      asOf, stats, caseStats: caseStats(store, asOf), alerts, ramp, spotlight,
      changes, sent, teams: teamOutcomes(store, { now: asOf }), health,
      openCases: store.all().filter(isOpen),
      staleness: uploadStaleness(asOf, config),
      activation: activationSummary,
      graduation: grad.rows.length ? {
        total: grad.rows.length,
        graduated: grad.rows.filter((r) => r.done).length,
        within25k: grad.rows.filter((r) => !r.done && r.remaining <= 25000).length,
        within100k: grad.rows.filter((r) => !r.done && r.remaining <= 100000).length,
        daysLeft: grad.rows[0]?.daysLeft ?? 0,
      } : null,
    });
    // The redo control rides the management overview, where the directors are,
    // and only when the interactions endpoint is actually listening — an
    // unanswered button reads as a broken tool.
    if (buttons) card.components = redoButton({ enabled: true });
    await (replaces('overview')
      ? replaceLast('overview', '(overview)', summaryRoute, card, 'overview')
      : send('overview', '(overview)', summaryRoute, card));
    if (!dryRun) store.data.lastOverviewOn = asOf;
  } else if (summaryRoute && alreadyPosted) {
    sent.push({ label: 'overview', coach: '(overview)', ok: true, skipped: 'already posted today' });
  }

  if (!dryRun) store.save();
  return { sent, previews, replaced, swept, warning: check.warning };
}
