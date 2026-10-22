// Side Quests: a personal target, set in the last week of the month.
//
// WHAT A QUEST IS. Seven days before the month ends, a small number of
// creators are given one target each — hold the tier they are in, or cross
// into the next — and seven nights to hit it. Hitting it pays the incentive
// they would have earned anyway PLUS quest coins on top PLUS a Uni Wheel
// entry. Missing it costs them nothing they had.
//
// THE TARGET IS FROZEN THE DAY IT IS SET. Everything else here recomputes
// daily, but `need` and `target` are written once into the store and never
// touched again. A target that drifted with the data would be a target nobody
// could chase: a creator who had a good night would watch the finish line move
// away from them, which is the one thing that would make the whole programme
// feel rigged.
//
// WHO GETS ONE, and the reasoning behind each gate, measured against September
// and October rather than guessed:
//
//   over a month on the roster   a creator with no previous month has no tier
//                                to hold and nothing to rank up from.
//
//   not a partner agency         Surge, Stay Social and Team Ratty recruit and
//                                coach their own people, and LEAP settles most
//                                of the revenue back to them. Paying coins to
//                                capture a fraction of the upside is a bad
//                                trade, and "speak to your coach" means
//                                nothing to a creator LEAP does not coach.
//
//   within reach                 the gap has to be closable in seven nights at
//                                1.5x the pace they are already running.
//
//   not already cracking it      a creator doing more than 1.2x the nightly
//                                rate they need does not need a quest. In the
//                                September run every creator above 2x hit
//                                their target anyway: six cards, six hits,
//                                nothing bought. Cutting at 1.2x dropped eight
//                                cards and lost none of the value at stake.
//
//   not stalled                  and the mirror of it. A creator who has not
//                                been LIVE in three days is not about to close
//                                a tier gap in seven, and a card telling them
//                                otherwise is a card that lies. This gate is
//                                the one the September simulation did not have
//                                and three October names needed.
//
//   worth having                 a floor on what the quest is worth to LEAP,
//                                so nobody spends coins chasing fifteen quid.
import { monthMtd } from './policy.mjs';
import { DEFAULT_TIERS, lastMonthDiamonds } from './tiers.mjs';
import { coachName } from './coaches.mjs';

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => { const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return iso(t); };
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const dayNumber = (asOf) => Number(asOf.slice(8, 10));
const between = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY);

/** The quest runs over the last N days of the month. */
export const QUEST_DAYS = 7;

/**
 * The day quests are set, leaving exactly QUEST_DAYS nights to chase.
 *
 * Set on the 24th of a 31-day month and the creator has the 25th through the
 * 31st: seven nights. Off by one here and every card quotes a nightly target
 * that is wrong by a seventh.
 */
export function questDayFor(month) {
  return `${month}-${String(daysInMonth(month) - QUEST_DAYS).padStart(2, '0')}`;
}

/** The last day of the month a quest is judged on. */
export function questEndFor(month) {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

/** True on the day the quests should be generated. */
export function isQuestDay(asOf) {
  return asOf === questDayFor(asOf.slice(0, 7));
}

/** True while a month's quests are live and worth reporting on. */
export function questsRunning(asOf) {
  const month = asOf.slice(0, 7);
  return asOf >= questDayFor(month) && asOf <= questEndFor(month);
}

const tiers = (config) => config?.tiers?.bands ?? DEFAULT_TIERS;
const tierAt = (diamonds, config) => {
  let found = tiers(config)[0];
  for (const t of tiers(config)) if ((diamonds ?? 0) >= t.min) found = t;
  return found;
};
const thresholdOf = (tier, config) => tiers(config).find((t) => t.tier === tier)?.min ?? 0;

/**
 * What a creator has done in the last `days` days of data we hold.
 *
 * Used for the stalled gate and for recent form, both of which ask the same
 * question — what are they doing NOW — rather than what their month average
 * says. A creator can be on a fine month-to-date pace and have stopped a week
 * ago; the month number cannot see that and this can.
 */
export function recentForm(creator, asOf, days = 3) {
  const now = monthMtd(creator, asOf);
  if (!now) return null;
  const then = monthMtd(creator, addDays(asOf, -days));
  // Both ends landing on the same reading means the data stops short of asOf,
  // not that the creator did nothing. Returning zero here would mark the whole
  // roster stalled and the run would produce no quests at all, silently. Say
  // we cannot tell instead, and let the caller refuse to generate.
  if (then && now === then) return null;
  // Early in a month there is no `days`-ago reading inside it. Month-to-date is
  // then the whole of the recent window, which is correct rather than a
  // fallback.
  const base = then ?? { diamonds: 0, liveHours: 0, validLiveDays: 0 };
  return {
    diamonds: Math.max(0, (now.diamonds ?? 0) - (base.diamonds ?? 0)),
    liveHours: Math.max(0, (now.liveHours ?? 0) - (base.liveHours ?? 0)),
    validLiveDays: Math.max(0, (now.validLiveDays ?? 0) - (base.validLiveDays ?? 0)),
    perNight: Math.max(0, ((now.diamonds ?? 0) - (base.diamonds ?? 0))) / days,
  };
}

/**
 * Pick the quests for a month. Call this once, on the quest day.
 *
 * Returns plain objects ready to be stored: everything a card needs later is
 * captured here, because the roster can change underneath us and a quest has
 * to survive its creator changing coach or group mid-chase.
 */
export function selectQuests({ creators, asOf, config = {} }) {
  const cfg = config.sideQuests ?? {};
  // Generating against stale data is the one failure that looks like success:
  // every creator reads as stalled, the list comes back empty, and nobody can
  // tell that from "nobody qualified". Refuse loudly instead.
  const freshest = creators.reduce((best, c) => {
    const last = c.obs?.length ? c.obs[c.obs.length - 1].date : null;
    return last && (!best || last > best) ? last : best;
  }, null);
  const stalledDaysCfg = cfg.stalledAfterDays ?? 3;
  if (freshest && between(freshest, asOf) > stalledDaysCfg) {
    const err = new Error(`data stops at ${freshest} but quests are being set for ${asOf} — upload the latest export first`);
    err.code = 'STALE_DATA';
    err.lastAsOf = freshest;
    throw err;
  }
  const month = asOf.slice(0, 7);
  const end = questEndFor(month);
  const nights = between(asOf, end);
  const skipGroups = new Set((cfg.excludeGroups ?? []).map((g) => String(g).toLowerCase()));
  const minWorth = cfg.minWorthGbp ?? 25;
  const formCap = cfg.formCap ?? 1.2;
  const stalledDays = cfg.stalledAfterDays ?? 3;
  const reach = cfg.reachMultiple ?? 1.5;
  const fx = config.revenue?.usdToGbp ?? 0.754074;
  const incr = config.revenue?.incremental?.actualRate?.[month]
    ?? config.revenue?.incremental?.boardRate ?? 0.05;
  const elapsed = dayNumber(asOf);

  const out = [];
  for (const c of creators) {
    if (c.quitOn) continue;
    if (skipGroups.has(String(c.group ?? '').toLowerCase())) continue;
    // Over a month on the roster, so there is a previous month to hold.
    if (!c.joinDate || between(c.joinDate, asOf) < 30) continue;
    const mtd = monthMtd(c, asOf);
    if (!mtd) continue;
    const base = lastMonthDiamonds(c, month);
    if (base == null) continue;
    const dia = Math.round(mtd.diamonds ?? 0);
    const perDay = dia / elapsed;
    if (perDay <= 0) continue;
    const form = recentForm(c, asOf, stalledDays);
    // Stalled: nothing at all in the last three days of data.
    if (!form || (form.liveHours <= 0 && form.diamonds <= 0)) continue;

    const from = tierAt(base, config);
    const consider = [];
    // HOLD — they are in a tier and have not yet re-earned it this month.
    if (from.tier > 1 && dia < thresholdOf(from.tier, config)) {
      const target = thresholdOf(from.tier, config);
      consider.push({ kind: 'HOLD', tier: from.tier, target,
        usd: target * 0.01 * 0.04 + (target - dia) * 0.01 * incr });
    }
    // CROSS — the next tier up from where last month left them.
    const next = tiers(config).find((t) => t.min > base);
    if (next && dia < next.min) {
      consider.push({ kind: 'CROSS', tier: next.tier, target: next.min,
        usd: next.min * 0.01 * (from.advanced ?? from.base ?? 0.075) + (next.min - dia) * 0.01 * incr });
    }
    for (const q of consider) {
      const need = q.target - dia;
      if (need <= 0) continue;
      if (need > perDay * nights * reach) continue;            // out of reach
      const needPerNight = need / nights;
      if (form.perNight >= needPerNight * formCap) continue;    // already cracking it
      const gbp = q.usd * fx;
      if (gbp < minWorth) continue;                             // not worth coins
      out.push({
        creatorKey: c.key, username: c.username, group: c.group ?? null,
        coach: c.manager ?? null, kind: q.kind, tier: q.tier,
        month, setOn: asOf, endsOn: end,
        startedAt: dia, target: q.target, need: Math.round(need),
        perNight: Math.ceil(needPerNight / 100) * 100,
        formAtSet: Math.round(form.perNight),
        worthGbp: Math.round(gbp * 100) / 100,
        questCoins: Math.max(500, Math.round(gbp * 0.10 / 0.01 / 100) * 100),
        incentiveCoins: q.kind === 'HOLD' ? (MAINTAIN[q.tier] ?? 0) : (RANKUP[q.tier] ?? 0),
      });
    }
  }
  // One quest per creator: the bigger prize wins.
  const best = new Map();
  for (const q of out) {
    const prev = best.get(q.username);
    if (!prev || q.worthGbp > prev.worthGbp) best.set(q.username, q);
  }
  return [...best.values()].sort((a, b) => b.worthGbp - a.worthGbp);
}

/** The coin values LEAP already pays for the incentive itself. */
const MAINTAIN = { 3: 1000, 4: 1500, 5: 2500, 6: 3500, 7: 5000, 8: 8000, 9: 12500 };
const RANKUP = { 2: 1000, 3: 2000, 4: 3000, 5: 5000, 6: 7000, 7: 10000, 8: 16000, 9: 25000 };

/** Where a quest stands today, measured against the frozen target. */
export function questProgress(quest, creator, asOf) {
  const mtd = creator ? monthMtd(creator, asOf) : null;
  const now = Math.round(mtd?.diamonds ?? quest.startedAt);
  const gained = Math.max(0, now - quest.startedAt);
  const left = Math.max(0, quest.target - now);
  const nightsLeft = Math.max(0, between(asOf, quest.endsOn));
  const elapsed = Math.max(1, between(quest.setOn, asOf));
  const done = now >= quest.target;
  // Nights actually elapsed since the quest was set. On the day it is set this
  // is zero, and judging anybody on zero nights would paint the whole board
  // red before a single creator had the chance to do anything about it.
  const nightsRun = between(quest.setOn, asOf);
  const fresh = nightsRun < 1;
  // With no nights run, the fairest read of whether they are on course is the
  // rate they were already doing when the quest was handed to them.
  const rate = fresh ? (quest.formAtSet ?? 0) : gained / elapsed;
  return {
    now, gained, left, nightsLeft, done, fresh, nightsRun,
    pct: quest.need > 0 ? Math.min(1, gained / quest.need) : 1,
    perNightNeeded: nightsLeft > 0 ? Math.ceil(left / nightsLeft / 100) * 100 : left,
    perNightDoing: Math.round(rate),
    onCourse: done || (nightsLeft > 0 && rate * nightsLeft >= left),
  };
}

/**
 * The message a coach sends the creator.
 *
 * Written to be copied straight out of the card and pasted into a DM, so it
 * carries no Discord markup a creator would see as literal asterisks and no
 * figure that is not about them.
 */
export function creatorMessage(quest, progress) {
  const n = (x) => Math.round(x).toLocaleString('en-GB');
  const head = quest.kind === 'HOLD'
    ? `SIDE QUEST — hold Tier ${quest.tier}`
    : `SIDE QUEST — reach Tier ${quest.tier}`;
  if (progress.done) {
    return [`${head}`, '', `You did it. ${n(progress.now)} diamonds — that's the target cleared.`,
      '', `Your ${quest.kind === 'HOLD' ? 'Maintain' : 'Rank Up'} Incentive pays as normal, plus ${n(quest.questCoins)} Side Quest coins on top, plus your Uni Wheel entry.`,
      '', 'Proper effort. Enjoy it.'].join('\n');
  }
  const urgency = progress.nightsLeft <= 1 ? 'Last night to do it.'
    : progress.nightsLeft <= 3 ? `${progress.nightsLeft} nights left.`
      : `${progress.nightsLeft} nights to go.`;
  return [
    head, '',
    `You're on ${n(progress.now)} diamonds. Target is ${n(quest.target)}.`,
    `${n(progress.left)} to go — about ${n(progress.perNightNeeded)} a night. ${urgency}`,
    '',
    progress.onCourse
      ? `You're on pace. Hold it and it's yours.`
      : `You need to lift it from here, but it's on.`,
    '',
    `Hit it and you get your ${quest.kind === 'HOLD' ? 'Maintain' : 'Rank Up'} Incentive as normal, PLUS ${n(quest.questCoins)} Side Quest coins on top, PLUS 1 entry to this month's Uni Wheel.`,
    '',
    'Tell your room what you\'re chasing — it works.',
  ].join('\n');
}

/**
 * The three moments a coach gets pushed, and nothing in between.
 *
 * A card every morning in a team room is a card nobody reads by Wednesday. So
 * the team channels get three, spaced where they change what a coach does:
 *
 *   launch    the day quests are set. Here are yours, here is the message.
 *   midpoint  halfway. Who has moved and who has not touched it.
 *   final     one night left. The last chance to get anyone over the line.
 *
 * The Side Quest channels still carry the daily picture — this is the push
 * into the rooms where coaches actually talk, and it only fires three times.
 */
export function questPhase(asOf, { setOn, endsOn }, config = {}) {
  if (!setOn || !endsOn) return null;
  if (asOf === setOn) return 'launch';
  const total = between(setOn, endsOn);
  const run = between(setOn, asOf);
  if (run < 0 || run > total) return null;
  const left = total - run;
  // Counted in nights REMAINING rather than nights elapsed, because that is
  // what decides whether a coach can still do anything about it. Asked for as
  // "day 5" and "two days before the end", which on a seven-night quest are
  // the same evening — so they are spread, and both are configurable.
  const cfg = config.sideQuests?.teamCards ?? {};
  if (left === (cfg.finalNightsLeft ?? 1)) return 'final';
  if (left === (cfg.midpointNightsLeft ?? 4)) return 'midpoint';
  return null;
}

/**
 * The same board, split by coach, for the cards that go to team rooms.
 *
 * A coach should never open their own room and read about somebody else's
 * creator, so this groups rather than filters a shared list.
 */
export function questsByCoach(board) {
  const out = new Map();
  for (const row of board.quests) {
    const key = row.quest.coach ?? 'unassigned';
    if (!out.has(key)) out.set(key, { coach: key, label: row.coachLabel, group: row.quest.group, rows: [] });
    out.get(key).rows.push(row);
  }
  for (const entry of out.values()) {
    entry.rows.sort((a, b) => b.quest.worthGbp - a.quest.worthGbp);
    entry.done = entry.rows.filter((r) => r.progress.done).length;
    entry.behind = entry.rows.filter((r) => !r.progress.done && !r.progress.fresh && !r.progress.onCourse).length;
    entry.worthGbp = Math.round(entry.rows.reduce((a, r) => a + r.quest.worthGbp, 0));
    entry.wonGbp = Math.round(entry.rows.filter((r) => r.progress.done).reduce((a, r) => a + r.quest.worthGbp, 0));
    entry.coinsWon = entry.rows.filter((r) => r.progress.done)
      .reduce((a, r) => a + r.quest.questCoins + r.quest.incentiveCoins, 0);
  }
  return [...out.values()].sort((a, b) => b.worthGbp - a.worthGbp);
}

/** Read and write the month's quests. The store is the record, not the roster. */
export function readQuests(store, month) {
  return store?.data?.sideQuests?.[month] ?? null;
}

export function saveQuests(store, month, quests) {
  store.data.sideQuests = store.data.sideQuests ?? {};
  store.data.sideQuests[month] = { setOn: quests[0]?.setOn ?? null, quests };
  return store.data.sideQuests[month];
}

/**
 * Everything the two channels need: each quest with today's progress, plus the
 * totals the terminal card reports.
 */
export function questBoard({ creators, asOf, store, config = {} }) {
  const month = asOf.slice(0, 7);
  const saved = readQuests(store, month);
  if (!saved?.quests?.length) return { month, asOf, quests: [], summary: null };
  const byKey = new Map(creators.map((c) => [c.key, c]));
  const byName = new Map(creators.map((c) => [c.username, c]));
  const rows = saved.quests.map((q) => {
    const creator = byKey.get(q.creatorKey) ?? byName.get(q.username) ?? null;
    const progress = questProgress(q, creator, asOf);
    return { quest: q, progress, coachLabel: q.coach ? coachName(q.coach, config) : null };
  });
  const done = rows.filter((r) => r.progress.done);
  // A quest set today has had no nights to run, so it is neither on course nor
  // behind. Counting it as behind would open the board on a wall of red.
  const fresh = rows.filter((r) => !r.progress.done && r.progress.fresh);
  const onCourse = rows.filter((r) => !r.progress.done && !r.progress.fresh && r.progress.onCourse);
  const behind = rows.filter((r) => !r.progress.done && !r.progress.fresh && !r.progress.onCourse);
  return {
    month, asOf,
    quests: rows.sort((a, b) => b.quest.worthGbp - a.quest.worthGbp),
    summary: {
      total: rows.length, done: done.length, fresh: fresh.length,
      onCourse: onCourse.length, behind: behind.length,
      nightsLeft: rows[0] ? rows[0].progress.nightsLeft : 0,
      worthGbp: Math.round(rows.reduce((a, r) => a + r.quest.worthGbp, 0)),
      wonGbp: Math.round(done.reduce((a, r) => a + r.quest.worthGbp, 0)),
      coinsIfAllHit: rows.reduce((a, r) => a + r.quest.questCoins + r.quest.incentiveCoins, 0),
      coinsOwed: done.reduce((a, r) => a + r.quest.questCoins + r.quest.incentiveCoins, 0),
      diamondsGained: rows.reduce((a, r) => a + r.progress.gained, 0),
    },
  };
}
