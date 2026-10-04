// The Star Light campaign chase: who is on for Star Creator status, and who a
// coach has to ring today.
//
// WHAT THE CAMPAIGN IS
//
//   TikTok's Star Light Agency Tournament, 1-31 October 2026. LEAP is in the
//   Diamond Track, playing for up to $26,500 USD. The agency scores on the
//   number of STAR CREATORS and the number of STAR CREATOR DAYS across the
//   month, so there is no ceiling: every extra qualifying day is more points.
//
//   TikTok's own Star Creator test has four parts. Only one of them is in the
//   creator export, and it happens to be the one almost everybody fails:
//
//     Steady presence     10+ days a month, 1+ hour per day      <- this module
//     Active interaction  engages the audience, valid LIVE rate >50%
//     Refined visuals     background, lighting, tidy setup
//     Content safety      follows platform policy
//
//   On TikTok's eligible list of 278 LEAP creators, scored over three months:
//   217 were missing steady presence and 198 were missing active interaction,
//   while only 13 were missing visuals and none were missing safety. So the
//   campaign is won on consistency first, and consistency is the half we can
//   measure exactly, every day, from the file we already pull.
//
// STEADY PRESENCE IS ONE NUMBER, AND WE HAVE IT
//
//   "10+ days a month, 1+ hour per day" reads like two conditions. It is one:
//   TikTok's "Valid go LIVE days" column already means a day with at least an
//   hour of LIVE on it.
//
//   Checked, not assumed. Across every month-to-date row we hold with at least
//   one valid day — 9,828 of them — LIVE hours is NEVER below valid days. Not
//   once. The tightest row in the whole history is lyndz_lou_91 on 5 September:
//   one valid day, 1.0014 hours. One hour and five seconds.
//
//   So steady presence is `validLiveDays >= 10`, exactly, with no proxy and no
//   second test. That is the number this module is built on.
//
// THE MISSION LADDER IS ALSO JUST DAYS
//
//   Backstage's ticket ladder sets a minutes target and a days target on each
//   rung — 600 mins/10 days, 900/15, 1500/20. The minutes never bind. Across
//   July, August and September, of the 390 creator-months that reached 20 valid
//   days, every single one was already past 25 hours — 390 of 390, at all three
//   rungs. The reason is in the distribution: the median creator does 3.01
//   hours per valid day (p10 2.03, p90 5.18), so twenty days buys sixty hours
//   against a target of twenty-five.
//
//   Both halves are still enforced here, because the mission values are
//   config and Backstage may be holding different ones. But the card leads
//   with days, because days is what a coach can do something about.
//
// WHAT IS NOT IN HERE, AND WHY
//
//   Active interaction. The export has no interaction-days column, and the
//   obvious proxy does not survive contact: valid days over LIVE streams puts
//   59.6% of September's streamers above 50%, where TikTok's own flag passes
//   only 29% of the eligible list. Those are not the same measurement, so this
//   module does not pretend one is the other. Campaign B's ladder has an
//   interaction-days rung we cannot verify; `interactionUnknown` marks it so
//   the card can say so rather than imply a creator is further along than we
//   know.
//
//   The 278-creator eligible list, and the A/B campaign split. Those live in
//   Backstage and in Leap_Starlight_Hit_List.xlsx, which is not loaded here.
//   Until it is, `campaign` and `eligible` come from config overrides if set
//   and are otherwise null, and the card covers the whole monitored roster.
//   That is deliberately the wider net: a creator TikTok has since made
//   eligible is better chased than missed.
import { monthMtd, previousMonth } from './policy.mjs';
import { groupKey } from './notify.mjs';
import { coachName, offTheBoards } from './coaches.mjs';

const daysInMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/**
 * The ticket ladder, per campaign.
 *
 * Campaign A scores minutes and days. Campaign B scores interaction days as
 * well, which is the whole reason the two campaigns exist. Both are checked on
 * every rung; in practice `days` is the one that bites, and for B interaction
 * is the one that trips people who are doing the hours.
 *
 * 600/900/1500 minutes is 10/15/25 hours. Marked UNCONFIRMED in the brief
 * against what was actually entered in Backstage, which is why these are
 * config rather than constants.
 */
export const MISSIONS = {
  A: [
    { n: 1, days: 10, hours: 10, tickets: 1 },
    { n: 2, days: 15, hours: 15, tickets: 2 },
    { n: 3, days: 20, hours: 25, tickets: 3 },
  ],
  B: [
    { n: 1, days: 10, hours: 10, interactionDays: 10, tickets: 1 },
    { n: 2, days: 15, hours: 15, interactionDays: 15, tickets: 2 },
    { n: 3, days: 20, hours: 25, interactionDays: 20, tickets: 3 },
  ],
};

/** Mission 1 is also TikTok's Star Creator minimum, which is not a coincidence:
 * the ladder was set to start there so every creator pushed to rung one also
 * scores tournament points for LEAP. */
export const STAR_DAYS = 10;

/**
 * The ladder for one campaign.
 *
 * A creator we hold no campaign for falls back to A's ladder, which is the
 * subset both campaigns share: it will never claim a ticket B has not given,
 * because every rung of B is A's rung plus a condition.
 */
function missionsOf(config, campaign = null) {
  const set = config.starlight?.missions ?? MISSIONS;
  if (Array.isArray(set)) return set;
  return set[campaign] ?? set.A ?? MISSIONS.A;
}

/**
 * How far up the ladder they are, and what the next rung costs.
 *
 * `interactionDays` is null for a creator whose campaign does not score it, and
 * for anyone we hold no roster line for. Null is not zero: a rung that needs
 * interaction days is treated as met on that condition when we have no reading,
 * so an unknown never reads as a failure. The card says which rows are unknown
 * rather than this quietly deciding for them.
 */
function ladder({ days, hours, interactionDays }, missions) {
  const meets = (m) => days >= m.days
    && hours >= m.hours
    && (m.interactionDays == null || interactionDays == null || interactionDays >= m.interactionDays);
  let reached = null;
  for (const m of missions) if (meets(m)) reached = m;
  const next = missions.find((m) => !reached || m.n > reached.n) ?? null;
  const want = next?.interactionDays ?? null;
  return {
    mission: reached?.n ?? 0,
    tickets: reached?.tickets ?? 0,
    next,
    daysShort: next ? Math.max(0, next.days - days) : 0,
    hoursShort: next ? Math.max(0, Math.round((next.hours - hours) * 10) / 10) : 0,
    interactionShort: want != null && interactionDays != null ? Math.max(0, want - interactionDays) : null,
    // The rung wants interaction days and we have no reading for them.
    interactionUnknown: want != null && interactionDays == null,
  };
}

/**
 * The same day of the month, a month earlier.
 *
 * Used to shape the projection on the creator's own curve. Clamped to the end
 * of the shorter month, so the 31st reads against the 30th rather than falling
 * off and silently projecting on a straight line.
 */
function sameDayLastMonth(asOf) {
  const prev = previousMonth(asOf.slice(0, 7));
  const day = Math.min(Number(asOf.slice(8, 10)), daysInMonth(prev));
  return `${prev}-${String(day).padStart(2, '0')}`;
}

/** Final valid-day count for a month, or null if we hold nothing for it. */
function daysInMonthFor(creator, month) {
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const mtd = monthMtd(creator, last);
  return mtd ? Math.round(mtd.validLiveDays ?? 0) : null;
}

/**
 * Whether this creator has a habit of going LIVE enough, over the months before
 * this one.
 *
 * This is our reconstruction of TikTok's own steady-presence flag, which scores
 * the last three months rather than the current one. It matters to a coach for
 * a reason the current month cannot show: a creator who cleared 10 days in all
 * three of the last months and is behind today will almost certainly get there,
 * and a creator who has never cleared it is a different conversation.
 */
export function steadyHistory(creator, asOf, { months = 3, need = STAR_DAYS } = {}) {
  const out = [];
  let month = previousMonth(asOf.slice(0, 7));
  for (let i = 0; i < months; i++) {
    const days = daysInMonthFor(creator, month);
    out.push({ month, days, hit: days != null && days >= need });
    month = previousMonth(month);
  }
  const known = out.filter((m) => m.days != null);
  return {
    months: out,
    known: known.length,
    hits: known.filter((m) => m.hit).length,
    // TikTok's flag needs all three. With fewer than three months on file we
    // cannot say, so this is null rather than false — a creator who joined in
    // September is not a creator who failed July.
    steady: known.length >= months ? known.every((m) => m.hit) : null,
    // Did they do it last month? The single most useful thing on the card.
    lastMonth: out[0] ?? null,
  };
}

/**
 * One creator's standing in the campaign.
 *
 * Built around the two numbers a coach can act on: how many more days the next
 * rung needs, and how many days are left to find them in. Everything else on
 * the row exists to sort or to explain those two.
 */
export function starlightRow(creator, asOf, config = {}, entry = null) {
  if (!creator?.obs?.length) return null;
  const cfg = config.starlight ?? {};
  const campaign = entry?.campaign ?? null;
  const missions = missionsOf(config, campaign);
  const month = asOf.slice(0, 7);
  const monthLength = daysInMonth(month);
  const dayOfMonth = Number(asOf.slice(8, 10));
  // The export runs a day behind, so "days left" counts from the day after the
  // reading. On the 2nd with data to the 2nd there are 29 days still to play.
  const daysLeft = Math.max(0, monthLength - dayOfMonth);

  const mtd = monthMtd(creator, asOf);
  if (!mtd) return null;

  // Days and hours come from the daily creator export, never from the campaign
  // sheet: the sheet is uploaded by hand and goes stale, and its "Go-LIVE days
  // during Event" is the same counter as "Valid go LIVE days" anyway (see
  // starlightroster.mjs for the proof). Interaction days are the other way
  // round — only the sheet has them — so they carry the sheet's own date.
  const days = Math.round(mtd.validLiveDays ?? 0);
  const hours = Math.round((mtd.liveHours ?? 0) * 10) / 10;
  const interactionDays = entry?.interactionDays ?? null;
  const l = ladder({ days, hours, interactionDays }, missions);
  const star = days >= (cfg.starDays ?? STAR_DAYS);
  // Days past the bar are the tournament's actual currency, so they are on the
  // row even though no rung rewards them.
  const starDays = Math.max(0, days - (cfg.starDays ?? STAR_DAYS) + (star ? 1 : 0));

  // Can they still reach the next rung? Days are the hard wall — one day is one
  // day and no amount of streaming makes two. Hours have to fit in the days
  // left at a session length people actually do.
  const perDay = cfg.plausibleHoursPerDay ?? 3;
  const reachable = l.next == null
    || (l.daysShort <= daysLeft && l.hoursShort <= daysLeft * perDay);

  // The one number that says how hard the ask is: go LIVE on this share of
  // every day left. 1.0 means every single remaining day.
  const needRate = l.next == null ? 0
    : daysLeft > 0 ? l.daysShort / daysLeft : (l.daysShort > 0 ? Infinity : 0);

  const history = steadyHistory(creator, asOf, { months: cfg.historyMonths ?? 3, need: cfg.starDays ?? STAR_DAYS });

  return {
    creator,
    username: creator.username,
    group: creator.group ?? null,
    coach: creator.manager ?? null,
    month, asOf, dayOfMonth, monthLength, daysLeft,
    days, hours,
    mission: l.mission, tickets: l.tickets,
    next: l.next, daysShort: l.daysShort, hoursShort: l.hoursShort,
    star, starDays,
    reachable, needRate,
    band: bandOf({ next: l.next, reachable, needRate, days }, cfg),
    history,
    interactionDays,
    interactionShort: l.interactionShort,
    interactionUnknown: l.interactionUnknown,
    // Doing the hours and scoring nothing on interaction. A specific, fixable
    // conversation, and the only thing on this card the creator cannot fix by
    // simply going LIVE more.
    interactionBlocked: interactionDays === 0 && days > 0,
    campaign,
    // Backstage's own ticket count, beside ours rather than instead of it.
    backstageStage: entry?.stage ?? null,
    rosterAsOf: entry?.asOf ?? null,
    projected: project(creator, days, asOf, dayOfMonth, monthLength),
    diamonds: Math.round(mtd.diamonds ?? 0),
  };
}

/**
 * Where their valid days land by the 31st.
 *
 * A straight line from day 2 says a creator who streamed once is on for 15
 * days, which is nonsense a coach would rightly ignore. Where we hold the same
 * point last month for this same creator, scale by their own curve instead:
 * somebody who streams weekends is lumpy, and last month's lumps are the best
 * guide we have to this month's.
 */
function project(creator, days, asOf, dayOfMonth, monthLength) {
  const prevMonth = previousMonth(asOf.slice(0, 7));
  const atSamePoint = monthMtd(creator, sameDayLastMonth(asOf));
  const prevTotal = daysInMonthFor(creator, prevMonth);
  const soFarThen = atSamePoint ? Math.round(atSamePoint.validLiveDays ?? 0) : null;
  if (soFarThen != null && soFarThen > 0 && prevTotal != null && prevTotal > 0) {
    return { days: Math.round(days * (prevTotal / soFarThen)), from: 'last month' };
  }
  return {
    days: dayOfMonth > 0 ? Math.round((days / dayOfMonth) * monthLength) : null,
    from: 'pace',
  };
}

/**
 * Which pile a creator goes in.
 *
 * Ordered by what the coach does about it, not by how well they are doing. The
 * two that matter most are CLOSE — one or two streams from a rung, so the
 * cheapest points on the board — and COLD, which is a creator who has cleared
 * this bar before and is not clearing it now. Those are the winnable ones.
 */
export function bandOf({ next, reachable, needRate, days }, cfg = {}) {
  if (next == null) return 'DONE';
  if (!reachable) return 'GONE';
  if (days === 0) return 'NOT_STARTED';
  if (needRate <= (cfg.comfortable ?? 0.4)) return 'ON_TRACK';
  if (needRate <= (cfg.tight ?? 0.7)) return 'TIGHT';
  return 'URGENT';
}

export const BAND_LABEL = {
  DONE: 'All three missions done',
  ON_TRACK: 'On track',
  TIGHT: 'Tight',
  URGENT: 'Urgent',
  GONE: 'Out of days',
  NOT_STARTED: 'Not been LIVE yet',
};

/**
 * Every campaign creator's standing.
 *
 * The roster is the gate. A creator Backstage has not put in a campaign earns
 * the tournament nothing however many days they do, so chasing them under a
 * Star Light card would be a lie about what their effort buys. With no roster
 * loaded this falls back to the whole monitored roster, which is the wider net
 * and the right default while the sheets are still being exported — the card
 * says which of the two it is doing.
 *
 * THE BOARD FILTERS DO NOT APPLY HERE, and that is deliberate.
 *
 *   Everywhere else, `monitoring.ignoreGroups` and `coaches.excludeFromBoards`
 *   drop creators nobody at LEAP coaches and coaches who are not in the
 *   internal competition. Right for a coaching card. Wrong for this one: TikTok
 *   has put those creators in LEAP's campaigns, so their LIVE days score toward
 *   LEAP's share of the $26,500 whoever manages them. Filtering them out would
 *   quietly cost the agency points.
 *
 *   On the October roster that is three creators — sezzy.plays, whose manager
 *   is excluded from the boards, and b41lzstreams and kc.is.live, both on
 *   TEAM TRUCKERS, which is an ignored group. They are carried with
 *   `outsideBoards` set and a reason, so a card can say plainly that no LEAP
 *   coach owns them rather than implying somebody dropped them.
 *
 * `missing` is the other half of the answer: campaign creators we hold no
 * export row for at all. Those are invisible unless something names them.
 */
export function starlightRows({ creators, asOf, config = {}, roster = null }) {
  const cfg = config.starlight ?? {};
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const include = cfg.includeOutsideBoards !== false;
  const entries = roster?.creators ?? null;
  const gated = Boolean(entries && Object.keys(entries).length > 0);
  const rows = [];
  const seen = new Set();
  for (const c of creators) {
    if (c.quitOn) continue;
    const name = String(c.username ?? '').trim().replace(/^@/, '').toLowerCase();
    const entry = gated ? entries[name] : null;
    if (gated && !entry) continue;

    const ignoredTeam = ignored.has(groupKey(c.group));
    const excludedCoach = offTheBoards(c.manager, config);
    if ((ignoredTeam || excludedCoach) && !include) continue;

    const r = starlightRow(c, asOf, config, entry);
    if (!r) continue;
    r.outsideBoards = ignoredTeam || excludedCoach;
    r.outsideReason = ignoredTeam ? 'team is not monitored'
      : excludedCoach ? 'manager is off the boards' : null;
    seen.add(name);
    rows.push(r);
  }
  const missing = gated
    ? Object.values(entries).filter((e) => !seen.has(e.username))
      .map((e) => ({ username: e.username, campaign: e.campaign }))
    : [];
  return { rows, missing, gated };
}

/**
 * How to order a coach's chase list.
 *
 * Not by gap alone, which is the obvious thing and it is wrong early in the
 * month. On the 2nd, needing 9 days out of 29 and needing 10 out of 29 are the
 * same ask — about a day and a half a week either way — so sorting on the raw
 * gap put a creator who managed 7 days last month above one who managed 18 on a
 * difference of one day in four weeks.
 *
 * So the gap is bucketed into what it actually costs the creator: days needed
 * per remaining week, rounded up. Inside a bucket, the one with the strongest
 * record goes first, because that is who is most likely to convert the call.
 */
export function chaseOrder(a, b) {
  const bucket = (r) => (r.daysShort <= 0 ? 0 : Math.ceil((r.needRate ?? 0) * 7) || 1);
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  const hits = (r) => r.history?.hits ?? 0;
  if (hits(a) !== hits(b)) return hits(b) - hits(a);
  const last = (r) => r.history?.lastMonth?.days ?? 0;
  if (last(a) !== last(b)) return last(b) - last(a);
  if (a.days !== b.days) return b.days - a.days;
  return b.diamonds - a.diamonds;
}

/**
 * Whose card this is.
 *
 * A team is usually one coach's, but not always — TikTok's campaign lists cut
 * across LEAP's, and Team Alpha's October roster includes one creator managed
 * by somebody else. So the card is headed by the coach who holds most of the
 * team, and any row that belongs to a different coach is named on its own line.
 * Taking `rows[0]` would have put the wrong name on the card whenever the
 * sorting happened to land on the odd one out.
 */
function modalCoach(rows, config) {
  const counts = new Map();
  for (const r of rows) counts.set(r.coach ?? null, (counts.get(r.coach ?? null) ?? 0) + 1);
  const coach = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    coach,
    coachName: coachName(coach, config),
    // Rows this coach does not own, so the card can say so beside the name.
    others: rows.filter((r) => (r.coach ?? null) !== coach).length,
  };
}

/**
 * The per-team card's contents.
 *
 * One team, because that is how a coach reads and how the channels are routed.
 *
 * The piles are the card, and they are ordered by who is worth a message today
 * rather than by who is doing best:
 *
 *   PUSH     Creators who have cleared 10 LIVE days in a month before and have
 *            not yet this month. These are the cheapest points on the board —
 *            they have proved they can do it, so the call is a reminder, not a
 *            negotiation. Cheapest gap first.
 *   TRYING   Been LIVE at least once this month but no history of clearing the
 *            bar. Shown with their day count and nothing else: they are
 *            already moving and a coach does not need a paragraph each.
 *   COLD     Zero days so far. Named, because a creator nobody mentions is a
 *            creator nobody rings.
 *   TALK     Campaign B only: putting the hours in and scoring zero interaction
 *            days. The one problem on this card that going LIVE more does not
 *            fix.
 *   IN       Already past 10 days, so already scoring the tournament. Still
 *            listed with their count, because Star Creator DAYS are the
 *            currency and there is no ceiling on them.
 */
export function starlightTeam({ team, rows, asOf, config = {} }) {
  const cfg = config.starlight ?? {};
  const bands = {};
  for (const r of rows) (bands[r.band] ??= []).push(r);
  for (const list of Object.values(bands)) list.sort(chaseOrder);

  // "Ones who went live before, or have shown it": cleared the bar in any month
  // we hold. Proven beats recent — somebody who did it in July and not since is
  // still somebody who has done it.
  const proven = (r) => (r.history?.hits ?? 0) > 0;
  const stars = rows.filter((r) => r.star).sort((a, b) => b.days - a.days);
  const push = rows.filter((r) => !r.star && r.reachable && proven(r)).sort(chaseOrder);
  const trying = rows.filter((r) => !r.star && r.days > 0 && !proven(r)).sort((a, b) => b.days - a.days);
  const cold = rows.filter((r) => !r.star && r.days === 0 && !proven(r))
    .sort((a, b) => a.username.localeCompare(b.username));
  const talk = rows.filter((r) => r.interactionBlocked && !r.star).sort(chaseOrder);
  // Proven, zero days, and now out of month. Nothing a coach can do about the
  // tickets, so they are counted rather than listed as a chase.
  const lost = rows.filter((r) => !r.star && !r.reachable);

  return {
    team,
    asOf,
    month: rows[0]?.month ?? asOf.slice(0, 7),
    dayOfMonth: rows[0]?.dayOfMonth ?? Number(asOf.slice(8, 10)),
    monthLength: rows[0]?.monthLength ?? daysInMonth(asOf.slice(0, 7)),
    daysLeft: rows[0]?.daysLeft ?? 0,
    ...modalCoach(rows, config),
    total: rows.length,
    stars: stars.length,
    // Star Creator days are what the tournament actually scores, so the team's
    // running total is the one number that says how much this team has banked.
    starDays: stars.reduce((t, r) => t + r.days, 0),
    tickets: rows.reduce((t, r) => t + r.tickets, 0),
    maxTickets: rows.reduce((t, r) => t + (missionsOf(config, r.campaign).at(-1)?.tickets ?? 3), 0),
    bands,
    push, trying, cold, talk, starRows: stars, lost: lost.length,
    oneDayOut: rows.filter((r) => r.next && r.daysShort === 1 && r.reachable).sort(chaseOrder),
    perBand: cfg.perBand ?? 25,
    campaigns: [...new Set(rows.map((r) => r.campaign).filter(Boolean))].sort(),
    outside: rows.filter((r) => r.outsideBoards),
    rosterAsOf: rows.map((r) => r.rosterAsOf).filter(Boolean).sort()[0] ?? null,
    rows,
  };
}

/** Grouped the way the routes are: one card per team, biggest team first. */
export function starlightTeams({ creators, asOf, config = {}, roster = null }) {
  const { rows, missing, gated } = starlightRows({ creators, asOf, config, roster });
  const byTeam = new Map();
  for (const r of rows) {
    const key = r.group ?? 'no team';
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(r);
  }
  const teams = [...byTeam.entries()]
    .map(([team, list]) => starlightTeam({ team, rows: list, asOf, config }))
    .sort((a, b) => b.total - a.total);
  return { teams, missing, gated };
}

/** The network's own standing, for the overview. */
export function starlightSummary({ creators, asOf, config = {}, roster = null }) {
  const { rows, missing, gated } = starlightRows({ creators, asOf, config, roster });
  const stars = rows.filter((r) => r.star);
  const counts = {};
  for (const r of rows) counts[r.band] = (counts[r.band] ?? 0) + 1;
  const target = config.starlight?.target ?? null;
  return {
    asOf,
    month: asOf.slice(0, 7),
    dayOfMonth: Number(asOf.slice(8, 10)),
    monthLength: daysInMonth(asOf.slice(0, 7)),
    daysLeft: rows[0]?.daysLeft ?? 0,
    tracked: rows.length,
    stars: stars.length,
    starDays: stars.reduce((t, r) => t + r.days, 0),
    tickets: rows.reduce((t, r) => t + r.tickets, 0),
    counts,
    // On their own projections, where the month lands.
    projectedStars: rows.filter((r) => (r.projected?.days ?? 0) >= (config.starlight?.starDays ?? STAR_DAYS)).length,
    target,
    oneDayOut: rows.filter((r) => r.next && r.daysShort === 1 && r.reachable).length,
    cold: rows.filter((r) => r.history?.lastMonth?.hit && !r.star && r.reachable).length,
    interactionBlocked: rows.filter((r) => r.interactionBlocked).length,
    outside: rows.filter((r) => r.outsideBoards)
      .map((r) => ({ username: r.username, outsideReason: r.outsideReason, days: r.days })),
    byCampaign: rows.reduce((m, r) => { const k = r.campaign ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
    gated,
    missing,
    rows,
  };
}

/** Posted once a day, and only once — like every other board. */
export function starlightDue(config, store, asOf) {
  const cfg = config.starlight ?? {};
  if (cfg.enabled === false) return false;
  // The campaign is one month long. Outside it there is nothing to chase, and a
  // card about a finished tournament is noise in a coach's channel.
  if (cfg.from && asOf < cfg.from) return false;
  if (cfg.to && asOf > cfg.to) return false;
  return store.data.lastStarlightOn !== asOf;
}
