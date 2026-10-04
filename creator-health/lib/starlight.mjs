// The Star Light campaign chase: who is on for Star Creator status, and who a
// coach has to ring today.
//
// WHAT THE CAMPAIGN IS
//
//   TikTok's Star Light Agency Tournament, 1-31 October 2026. LEAP is in the
//   Diamond Track. The agency scores on the number of STAR CREATORS and the
//   number of STAR CREATOR DAYS across the month, so there is no ceiling:
//   every extra qualifying day is more points.
//
//   The cash the tournament pays is deliberately not recorded here or anywhere
//   this code can print. It is directors' knowledge, and this module's output
//   goes to a channel coaches read.
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

// --- the interaction read -----------------------------------------------------
//
// TikTok scores "active interaction" and the creator export has no column for
// it. Backstage's campaign sheet does, but only for Campaign B and only as of
// whenever it was last pulled by hand, so most of the roster most of the time
// has no reading at all.
//
// WHAT WORKS, MEASURED AGAINST TIKTOK'S OWN SCORE
//
//   The Campaign B sheet is a labelled set: 129 creators with TikTok's real
//   interaction-day count beside them. Joined to our export, 34 of them had
//   been LIVE, 12 of those were scored as interacting. Candidate signals, by
//   area under the ROC curve on that population:
//
//     diamonds                    0.848      <- and diamonds per LIVE day
//     diamonds per LIVE hour      0.841
//     own-audience gift share     0.676
//     fan club joins per hour     0.674
//     new fan club members        0.659
//     new followers               0.581
//     valid LIVE days             0.532      <- no better than a coin toss
//     LIVE hours                  0.511
//     LIVE streams                0.426
//
//   So GIFTS are the signal and TIME IS NOT. Going LIVE longer does not make
//   TikTok score you as interacting; being gifted does. The two cases that
//   make the point: mackopete streamed 19.2 hours over 3 days for 52 diamonds
//   and scored zero, while the_cleaner87 streamed 3.1 hours on one day for
//   2,609 diamonds and scored the full four.
//
//   Fan club joins do NOT hold up on their own, which is worth saying plainly
//   because it is the intuitive half: as a rule "gained a fan club member" is
//   62% accurate, against 82% for the gift rate, and ORing the two together
//   makes it worse (65%) rather than better. The fan club is a fine thing to
//   coach and it is not the thing TikTok is counting here.
//
// THE RATE, NOT THE TOTAL
//
//   Diamonds and diamonds-per-hour tie on separation, and the rate is used
//   because the total is unfair to a creator who streams less: among creators
//   who went LIVE, hours do not predict the score at all, so a per-hour rate
//   loses nothing and stops a long streamer outranking a well-gifted short one.
//
//   Measured bands, same population:
//
//     under 5 diamonds per LIVE hour     13% were scored as interacting
//     5 to 20                             0%
//     20 and over                         71%
//
//   Hence the cut at 20. It catches 10 of the 12 who were scored, and flags 4
//   of the 22 who were not — 82% of the population called right.
//
// WHAT THIS IS NOT
//
//   It is a proxy, fitted on 34 creators four days into one campaign, and it
//   is reported as a proxy: the card says "gifts per hour", never "interaction
//   days", and where a real Backstage reading exists that is shown instead.
//
//   It also cannot explain six creators who were scored as interacting with no
//   LIVE time at all, in our data or Backstage's — kbx5463, shiey0_6,
//   gamergirlamy94, beamedbyiiiiiiii, lifewithjoanneee and onlychriszo, four of
//   them on the full four days. Whatever that counter is picking up there, it
//   is not gifts on a LIVE stream, so this proxy does not pretend to cover it
//   and reads UNKNOWN for anybody who has not been LIVE.

/** The measured cut, in diamonds per valid LIVE hour. */
export const GIFT_RATE_BANDS = { good: 20, thin: 0 };

/**
 * How a creator is likely scoring on interaction, from gifts per LIVE hour.
 *
 * `GOOD` is above the measured cut. `THIN` is LIVE but under it — the list a
 * coach can do something about, because the fix is a conversation about chat
 * rather than a conversation about going LIVE. `UNKNOWN` has not been LIVE
 * enough to read, and is deliberately not called bad.
 */
export function interactionRead(row, config = {}) {
  const cfg = config.starlight?.interaction ?? {};
  const good = cfg.goodPerHour ?? GIFT_RATE_BANDS.good;
  const minHours = cfg.minHours ?? 1;

  // Nothing to read on somebody who has not been LIVE. Deliberately not called
  // bad: their problem is going LIVE, which every other list on the card is
  // about, and putting them on a "talk to your chat more" list would be advice
  // about a stream they have not done.
  if (!(row.hours >= minHours)) {
    return { band: 'UNKNOWN', source: 'too little LIVE to read', days: null, perHour: null, onPace: null };
  }

  // Backstage's own number wins wherever we hold one: a measurement beats a
  // proxy fitted to predict that measurement.
  //
  // Judged on PACE, not against the month-end target, for the same reason the
  // LIVE days are: four interaction days on the 4th against a target of ten is
  // somebody doing it every day, not somebody six short. Reading it as a
  // shortfall put creators who had scored on every single day of the campaign
  // on the list of creators to chase about interaction.
  if (row.interactionDays != null && row.next?.interactionDays != null) {
    const short = Math.max(0, row.next.interactionDays - row.interactionDays);
    const rate = short === 0 ? 0 : row.daysLeft > 0 ? short / row.daysLeft : Infinity;
    const onPace = rate <= (cfg.onPaceRate ?? 0.35);
    return {
      band: onPace ? 'GOOD' : row.interactionDays > 0 ? 'THIN' : 'NONE',
      source: 'Backstage',
      days: row.interactionDays,
      perHour: null,
      onPace,
    };
  }

  const perHour = row.diamonds / row.hours;
  return {
    band: perHour >= good ? 'GOOD' : 'THIN',
    source: 'gifts per LIVE hour',
    days: null,
    perHour: Math.round(perHour * 10) / 10,
    onPace: perHour >= good,
  };
}

// --- who is actually worth a message today ------------------------------------
//
// A coach has sixty-odd creators and time for a handful of messages. Sorting by
// who is furthest behind sends them at the people least likely to move, and
// sorting by who is closest sends them at people who were going to make it
// anyway. Neither is the right list.
//
// WHAT CONVERTS, FROM LEAP'S OWN SEPTEMBER
//
//   September is the one month we hold mid-month readings for, and its 3rd is
//   exactly where October is now. Of 859 creators with a day-3 reading, the
//   share who finished the month with 10+ valid LIVE days:
//
//     days by the 3rd    never cleared 10    cleared 1 of 2    cleared both
//            0                  4%                14%              48%
//            1                 19%                29%              62%
//            2                 23%                82%              83%
//            3                 43%               100%              96%
//
//   Two things fall straight out of that table.
//
//   First, A CREATOR ON THREE DAYS BY THE 3rd NEEDS NO MESSAGE. They land it
//   96% of the time on their own. Messaging them is the most comfortable thing
//   a coach can do and it is worth almost nothing.
//
//   Second, THE MONEY IS IN THE STALLED-BUT-PROVEN. Nought days by the 3rd and
//   a record of clearing it in both prior months converts 48% of the time — so
//   roughly half of that group is still winnable, and the other half is what a
//   message is for. Nought days with no record converts 4%, and no amount of
//   chasing changes what somebody has never done.
//
// AND LATER IN THE MONTH
//
//   Pooling every day-reading we hold for September — 8,337 creator-days not
//   yet at ten — against the ask they faced, measured as days still needed over
//   days still left:
//
//     needs this share of the days left     finished with 10+
//       up to 0.15                                77%
//       0.15 to 0.25                              82%
//       0.25 to 0.35                              60%
//       0.35 to 0.5                               12%
//       0.5 to 0.7                                21%
//       0.7 to 1.0                                 1%
//       over 1.0 (arithmetically impossible)       0%
//
//   The cliff is between a third and a half of the remaining days. Below it
//   most people get there; above it almost nobody does, whatever their record.
//
// THE RANKING
//
//   What a message is worth is not the chance they succeed, it is the chance
//   they succeed BECAUSE of it. So each creator carries two numbers:
//
//     odds       their measured chance from where they are now, read off the
//                table above and narrowed by their own record
//     capable    their measured chance from their record alone, unconditional
//                on this month: 8% having never cleared 10, 37% having cleared
//                it once in the last two months, 77% having cleared it twice
//
//   and the list is ordered by `capable - odds`: how much of what this creator
//   has already proved they can do is being lost to where they currently are.
//
//   It puts the right people at the top and, as importantly, keeps the wrong
//   ones off it. On October's roster:
//
//     0 days, cleared both prior months   0.77 - 0.41 = 0.36   top of the list
//     0 days, cleared one                 0.37 - 0.14 = 0.23
//     2 days, cleared both                0.77 - 0.73 = 0.04   on track, leave them
//     3 days, cleared both                0.77 - 0.87 = 0      needs no message
//     0 days, never cleared 10            0.08 - 0.07 = 0.01   chasing will not fix this

/** P(finishes the month at the bar), measured, by how hard the ask is. */
export const CONVERSION = [
  // `upTo` is the share of the remaining days they still have to be LIVE on.
  { upTo: 0.15, all: 0.77, byHits: [0.64, 0.97, 0.69] },
  { upTo: 0.25, all: 0.82, byHits: [0.58, 0.91, 0.87] },
  { upTo: 0.35, all: 0.60, byHits: [0.27, 0.62, 0.73] },
  { upTo: 0.50, all: 0.12, byHits: [0.07, 0.14, 0.41] },
  { upTo: 0.70, all: 0.21, byHits: [0.26, 0.17, 0.19] },
  { upTo: 1.00, all: 0.01, byHits: [0.01, 0.00, 0.04] },
  { upTo: Infinity, all: 0, byHits: [0, 0, 0] },
];

/**
 * What their record alone says they convert at, unconditional on this month.
 *
 * Measured over the same 859 September creators. Used as the ceiling a message
 * is working towards, which is why it must NOT be conditioned on where they
 * are now.
 *
 *   cleared 10 in neither of the two prior months     8%   (n=261)
 *   cleared 10 in one of two                         37%   (n=134)
 *   cleared 10 in both                               77%   (n=225)
 *   only one month on file, and they cleared it      55%   (n= 29)
 *   only one month on file, and they did not         22%   (n= 74)
 *   no prior month on file at all                    18%   (n=136)
 *   everybody, for reference                         35%   (n=859)
 *
 * Every one of those is measured. The first version of this guessed at the
 * no-history case and guessed 0.82 — the conversion rate of people facing an
 * EASY remaining ask, which is not a capability at all — and it put creators
 * nobody has ever seen go LIVE at the top of the list, ahead of creators with
 * a twenty-day month behind them.
 */
export const CAPABLE_BY_HITS = [0.08, 0.37, 0.77];
export const CAPABLE_ONE_MONTH = { hit: 0.55, miss: 0.22 };
export const CAPABLE_UNKNOWN = 0.18;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Their measured chance of getting to the bar from where they are. */
export function conversionOdds(row) {
  if (row.star) return 1;
  if (!row.reachable) return 0;
  const band = CONVERSION.find((b) => row.needRate <= b.upTo) ?? CONVERSION.at(-1);
  const hits = row.history?.known >= 2 ? Math.min(2, row.history.hits) : null;
  // With fewer than two months on file there is no record to narrow it by, so
  // the pooled rate is the honest answer rather than the bottom of the table —
  // a creator who joined last month has not failed anything.
  return hits == null ? band.all : band.byHits[hits];
}

/** What their record says they are capable of, whatever this month looks like. */
export function capableOdds(row) {
  const h = row.history;
  if (!h || h.known === 0) return CAPABLE_UNKNOWN;
  if (h.known === 1) return h.hits > 0 ? CAPABLE_ONE_MONTH.hit : CAPABLE_ONE_MONTH.miss;
  return CAPABLE_BY_HITS[Math.min(2, h.hits)];
}

/**
 * What a message to this creator is worth today.
 *
 * The gap between what they have proved they can do and what they are on
 * course for. Zero means either that they are already on course — so the
 * message buys nothing — or that there is nothing in their record to work
 * with.
 */
export function messageWorth(row) {
  if (row.star) return 0;
  return clamp01(capableOdds(row) - conversionOdds(row));
}

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
 *   LEAP's share of the tournament whoever manages them. Filtering them out would
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
export function starlightTeam({ team, rows, asOf, config = {}, store = null, persist = false }) {
  const cfg = config.starlight ?? {};
  const bands = {};
  for (const r of rows) (bands[r.band] ??= []).push(r);
  for (const list of Object.values(bands)) list.sort(chaseOrder);

  // "Ones who went live before, or have shown it": cleared the bar in any month
  // we hold. Proven beats recent — somebody who did it in July and not since is
  // still somebody who has done it.
  const proven = (r) => (r.history?.hits ?? 0) > 0;
  const stars = rows.filter((r) => r.star).sort((a, b) => b.days - a.days);
  // Already on course on the measured table, so a message buys nothing. Named
  // rather than hidden, because these are exactly the creators a coach reaches
  // for first — they are the comfortable call — and every message spent here
  // is a message not spent on somebody who needed it.
  const onCourse = rows.filter((r) => !r.star && conversionOdds(r) >= (cfg.onCourseOdds ?? 0.7))
    .sort((a, b) => b.days - a.days);
  const settled = new Set(onCourse.map((r) => r.username));
  const push = rows.filter((r) => !r.star && r.reachable && proven(r) && !settled.has(r.username))
    .sort(chaseOrder);
  const today = dailyChase({ rows, store, asOf, config, persist, team });
  // "The rest" has to mean the rest. Today's six are listed above with their
  // reasons, and repeating them underneath made the card read as though the
  // same names had to be worked twice.
  const picked = new Set(today.pick.map((c) => c.row.username));
  const rest = push.filter((r) => !picked.has(r.username));
  const trying = rows.filter((r) => !r.star && r.days > 0 && !proven(r) && !settled.has(r.username))
    .sort((a, b) => b.days - a.days);
  const cold = rows.filter((r) => !r.star && r.days === 0 && !proven(r))
    .sort((a, b) => a.username.localeCompare(b.username));
  // Interaction, from Backstage where we hold a reading and from gifts per
  // LIVE hour where we do not. THIN is the coachable one: LIVE hours going in
  // and the gifts not following, which going LIVE more does not fix.
  for (const r of rows) r.interaction = interactionRead(r, config);
  const talk = rows.filter((r) => !r.star && r.days > 0
    && (r.interaction.band === 'THIN' || r.interaction.band === 'NONE')).sort(chaseOrder);
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
    push, rest, trying, cold, talk, starRows: stars, onCourse, lost: lost.length,
    // The short list the card leads with: different names each day, ordered by
    // what a message is actually worth. See dailyChase.
    today,
    oneDayOut: rows.filter((r) => r.next && r.daysShort === 1 && r.reachable).sort(chaseOrder),
    perBand: cfg.perBand ?? 25,
    campaigns: [...new Set(rows.map((r) => r.campaign).filter(Boolean))].sort(),
    outside: rows.filter((r) => r.outsideBoards),
    rosterAsOf: rows.map((r) => r.rosterAsOf).filter(Boolean).sort()[0] ?? null,
    rows,
  };
}

/** Grouped the way the routes are: one card per team, biggest team first. */
export function starlightTeams({ creators, asOf, config = {}, roster = null, store = null, persist = false }) {
  const { rows, missing, gated } = starlightRows({ creators, asOf, config, roster });
  const byTeam = new Map();
  for (const r of rows) {
    const key = r.group ?? 'no team';
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(r);
  }
  const teams = [...byTeam.entries()]
    .map(([team, list]) => starlightTeam({ team, rows: list, asOf, config, store, persist }))
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
    interaction: rows.reduce((m, r) => {
      const b = interactionRead(r, config).band;
      m[b] = (m[b] ?? 0) + 1;
      return m;
    }, {}),
    // What the whole roster is on course for, from the measured conversion
    // table rather than a straight line.
    expectedStars: Math.round(rows.reduce((t, r) => t + conversionOdds(r), 0)),
    worthMessaging: rows.filter((r) => messageWorth(r) >= (config.starlight?.minWorth ?? 0.03)).length,
    outside: rows.filter((r) => r.outsideBoards)
      .map((r) => ({ username: r.username, outsideReason: r.outsideReason, days: r.days })),
    byCampaign: rows.reduce((m, r) => { const k = r.campaign ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
    gated,
    missing,
    rows,
  };
}

// --- the daily list ----------------------------------------------------------
//
// A coach with sixty creators and a card listing all sixty messages nobody. So
// the card leads with a short named list, and the job of this function is to
// make sure that list is DIFFERENT PEOPLE every day without ever losing
// somebody who matters.
//
// Four rules, in this order:
//
//   1. NOW OR NEVER FIRST. A creator one day away from the arithmetic going
//      against them jumps everything, cooldown included. Tomorrow there is no
//      list to be on.
//
//   2. COOLDOWN. Somebody surfaced in the last few days is held back, so a
//      coach is not handed the same four names every morning. This is what
//      makes it a rotation rather than a leaderboard.
//
//   3. WORTH. Ordered by what a message is worth — see messageWorth — so the
//      people whose record says they can and whose position says they will not
//      come first, and the people who are already on course do not appear at
//      all.
//
//   4. NEVER CONTACTED BEATS CONTACTED. Among creators worth the same, the one
//      nobody has spoken to yet goes first. Over a month that gets the whole
//      list covered instead of a favourite dozen rung repeatedly.
//
// Nothing here tracks whether the coach actually sent the message. It tracks
// what was PUT IN FRONT OF THEM, which is the only thing this system can
// honestly claim to know, and the state is named `surfaced` rather than
// `contacted` so nobody reads it as more than that.

/**
 * Today's list for one team.
 *
 * `store` is the case store, which is where the per-month surfacing record
 * lives. With `persist` false nothing is written, so a dry run or a second look
 * at the same day gives the same answer and costs nothing.
 */
export function dailyChase({ rows, store, asOf, config = {}, persist = true, team = null }) {
  const cfg = config.starlight ?? {};
  const cap = cfg.messagesPerDay ?? 6;
  const cooldown = cfg.cooldownDays ?? 4;
  const month = asOf.slice(0, 7);
  const minWorth = cfg.minWorth ?? 0.03;

  // Copied, not referenced. `covered` below is counted after the picks are
  // written, and reading through a live reference made the number depend on
  // whether persist had run — the same call answering differently in a dry run.
  const seen = { ...(store?.data?.starlightSurfaced?.[month] ?? {}) };
  const daysSince = (key) => {
    const last = seen[key];
    if (!last) return null;
    return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000);
  };

  const candidates = rows
    .filter((r) => !r.star && r.reachable && r.next)
    .map((r) => {
      const worth = messageWorth(r);
      const since = daysSince(r.creator?.key ?? r.username);
      return {
        row: r,
        worth,
        odds: conversionOdds(r),
        capable: capableOdds(r),
        since,
        // One more day of not going LIVE and the arithmetic stops working. This
        // is the only thing that overrides the cooldown.
        lastChance: r.daysShort > 0 && r.daysShort >= r.daysLeft,
        // Doing the hours, gifts thin: a different message, and one worth
        // sending to somebody who is otherwise on course.
        interaction: interactionRead(r, config),
      };
    });

  const fresh = candidates.filter((c) => c.since == null || c.since >= cooldown);
  const held = candidates.filter((c) => c.since != null && c.since < cooldown);

  const order = (a, b) => {
    if (a.lastChance !== b.lastChance) return a.lastChance ? -1 : 1;
    if (Math.abs(b.worth - a.worth) > 0.005) return b.worth - a.worth;
    // Never surfaced goes first, so a month covers the list rather than a
    // favourite few.
    const an = a.since == null ? 1 : 0;
    const bn = b.since == null ? 1 : 0;
    if (an !== bn) return bn - an;
    if (a.since !== b.since) return (b.since ?? 0) - (a.since ?? 0);
    return b.row.diamonds - a.row.diamonds;
  };

  // Last chances are never held back by the cooldown.
  const forced = held.filter((c) => c.lastChance);
  const pool = [...fresh, ...forced].filter((c) => c.lastChance || c.worth >= minWorth);
  pool.sort(order);
  const pick = pool.slice(0, cap);

  if (persist && store && pick.length) {
    store.data.starlightSurfaced ??= {};
    const book = (store.data.starlightSurfaced[month] ??= {});
    for (const c of pick) book[c.row.creator?.key ?? c.row.username] = asOf;
    // Last month's book is no use and grows forever otherwise.
    delete store.data.starlightSurfaced[previousMonth(previousMonth(month))];
  }

  return {
    team,
    asOf,
    month,
    pick,
    // Everyone worth a message who did not fit today, so the card can say the
    // queue exists rather than implying the list is the whole job.
    queued: pool.length - pick.length,
    // How much of the team has been put in front of the coach this month,
    // today's list included. The honest measure of whether the rotation is
    // working its way through the roster rather than circling a favourite few.
    covered: rows.filter((r) => {
      const key = r.creator?.key ?? r.username;
      return seen[key] || pick.some((c) => (c.row.creator?.key ?? c.row.username) === key);
    }).length,
    coverable: rows.filter((r) => !r.star && r.reachable).length,
    cooldown,
    cap,
  };
}

/**
 * Why this creator, in one line a coach can read and act on.
 *
 * Never the model's numbers. A coach does not need to be told the conversion
 * odds; they need the sentence that opens the conversation.
 */
export function chaseReason(c) {
  const r = c.row;
  const last = r.history?.lastMonth;
  const best = (r.history?.months ?? []).filter((m) => m.hit).sort((a, b) => b.days - a.days)[0];
  if (c.lastChance) {
    return r.daysLeft === r.daysShort
      ? 'last chance — needs every remaining day'
      : 'running out of month';
  }
  if (r.days === 0 && last?.hit) return `did ${last.days} days last month, nothing yet this month`;
  if (r.days === 0 && best) return `did ${best.days} days in ${monthLabel(best.month)}, nothing yet this month`;
  if (r.days === 0) return 'has not been LIVE yet this month';
  if (c.interaction.band === 'THIN') return `${r.days} days in, but gifts are thin — chat needs work`;
  if (last?.hit) return `${r.days} days in, did ${last.days} last month`;
  return `${r.days} days in, needs ${r.daysShort} more`;
}

const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`)
  .toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

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
