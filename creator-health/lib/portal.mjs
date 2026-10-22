// The coach portal's view model.
//
// Everything here is assembly. The analysis already exists — decline rules,
// causes, the rank-up board, the 200k chase, side quests, coach earnings — and
// has been feeding Discord cards for months. What it has never had is one place
// a coach can open and see their own roster whole.
//
// Three rules shape it, all of them Carla's, from the call of 22 October:
//
//   1. Only name people a coach can do something about. A list of 130 creators
//      "more than 100,000 off" is a number nobody can act on. Strip the rest.
//   2. Colour it, so a coach sees that somebody is red before they read why.
//   3. Say what the creator needs, not just that they are down. "Down 40%" is
//      a fact; "going live more but shorter, and converting the same, so this
//      is hours" is a phone call.
//
// A coach sees only their own creators. That is enforced at the token, not
// here — see lib/portaltoken.mjs — but this module never assembles a coach view
// containing somebody else's roster either, so a bug in one is not a leak.
import { groupKey } from './notify.mjs';
import { monthMtd } from './policy.mjs';
import { coachName, earningsHidden } from './coaches.mjs';
import { rankCauses, KIND } from './causes.mjs';
import { graduationLadder } from './graduation.mjs';
import { planFor } from './ramp.mjs';
import { isOpen } from './cases.mjs';
import { avatarRoute } from './avatars.mjs';

const num = (x) => (Number.isFinite(x) ? x : 0);
const n0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '—');
const pct = (x) => (Number.isFinite(x) ? x : null);

/** Red, amber, green, grey. The one thing a coach reads before any words. */
export const STATE = { ACT: 'act', PROTECT: 'protect', WATCH: 'watch', GOOD: 'good', IDLE: 'idle' };

/**
 * What is wrong, in two words, for the top of an urgent card.
 *
 * The card used to lead with "£6.19/wk at risk" in red. Money is the reason a
 * coach acts, but it is not what is happening — so the red says what is
 * happening and the money moves below it.
 */
export const SLIPPING = {
  dark: 'GONE DARK',
  days: 'LIVE DAYS SLIPPING',
  hours: 'HOURS SLIPPING',
  conversion: 'DIAMONDS SLIPPING',
  gifting: 'ENGAGEMENT SLIPPING',
  rate: 'ENGAGEMENT SLIPPING',
};
export const slippingLabel = (lever) => SLIPPING[lever] ?? null;

/** The steps, per lever. One home, so every route to a lever gives the same ones. */
export const ACTIONS = {
  dark: [
    'Call them. Not a message — a call.',
    'Find out whether it is life, burnout, or they have gone somewhere else.',
    'Agree one date they will go back on, and put it in writing.',
  ],
  hours: [
    'Add LIVE days before you add session length. Frequency is cheaper for them and it is what the algorithm reads.',
    'Agree a schedule they will actually keep, not the one they wish they kept.',
    'Nothing about content needs changing. Say that — it is the reassuring half of this call.',
  ],
  days: [
    'Find out what changed. A dropped night is usually a life reason, not a TikTok one.',
    'Get one night back first. One is a habit; four is a negotiation.',
    'Check their LIVE duration too — fewer, longer sessions is a different problem from fewer, shorter ones.',
  ],
  conversion: [
    'Watch one of their LIVEs before the call. You cannot coach conversion off a spreadsheet.',
    'Back to basics: are they welcoming, thanking, introducing themselves?',
    'Is there a gift goal running, and are they revenue boosting it?',
    'If the room is flat, the game may be the problem. Ask what else they could play.',
  ],
  gifting: [
    'Check the real gift rate on the Creator Insights sheet before you call. This is our nearest reading, not the number itself.',
    'The base layer first: welcoming and thanking. People forget they stopped.',
    'Then the drivers: viewer wishes, gift goals, fan club campaigns, interactive gaming.',
    'Are they in a campaign? Campaigns spike gift rate more than anything else on this list.',
    'We cannot ask for gifts. We can make it obvious how someone supports them.',
  ],
  protect: [
    'Lead with the month, not the week. They are having a big one and they should hear that first.',
    'Find out what made the big week work. That is the repeatable part, and nobody writes it down.',
    'Only then, gently: the last few nights converted below their own normal. Ask what changed.',
    'Do not send a "you are slipping" message to somebody having a record month.',
  ],
  anomaly: [
    'Find out what changed. A record month always has a reason, and the reason is repeatable.',
    'Content review: watch a LIVE and write down what they are doing differently.',
    'Gifter management — who is carrying this month, and what happens when they stop?',
    'Do not change anything mid-run. Protect it, then build on it next month.',
  ],
  hold: ['Nothing needed. Keep them excited and leave them alone.'],
};

/**
 * Which lever an alert's own signals point at.
 *
 * The decline rules fire on things this module does not check for itself —
 * month-on-month, against their own normal, fan-club erosion — so without this
 * 64 urgent creators got a card headed URGENT and a reading of "Nothing to fix.
 * Holding." The rules already worked out what was wrong; this reads their
 * answer rather than inventing a second one.
 */
export function leverFromSignals(signals = []) {
  const text = signals.map((x) => `${x?.label ?? ''} ${x?.detail ?? ''}`).join(' ').toLowerCase();
  if (/fan club/.test(text)) return 'gifting';
  if (/per live hour|per hour/.test(text)) return 'conversion';
  if (/live hours/.test(text)) return 'hours';
  if (/live days/.test(text)) return 'days';
  return 'conversion';
}

/**
 * What this creator needs, in a coach's words.
 *
 * Carla's if-this-then-that, as far as our own export can carry it. The three
 * columns her method really turns on — ACU, gift rate and watch duration — are
 * on her Creator Insights sheet and are not derivable from the Creator data
 * export, so where one of them would change the answer this says so rather than
 * guessing. An honest "check the Insights sheet" beats a confident wrong lever.
 */
export function diagnose(m, { rank = null, config = {}, alert = null } = {}) {
  if (!m) return null;
  const hoursChange = pct(m.change7?.liveHours);
  const daysNow = num(m.curr7?.validLiveDays);
  const daysBefore = num(m.prev7?.validLiveDays);
  const hdrNow = m.diamondsPerHour7;
  const hdrBefore = m.prev7?.liveHours > 0.5 ? m.prev7.diamonds / m.prev7.liveHours : null;
  const hdrNormal = m.diamondsPerHour28;

  // Compare against their own normal, not against last week, when last week was
  // itself a freak. @itsmalkin did 6,157 an hour one week against a 28-day
  // average of 3,586; measuring the next week off that spike produced "-45%"
  // and called a record month a collapse. The honest figure is the one against
  // their own baseline, and the card says which it used.
  const spikeMultiple = config.portal?.spikeMultiple ?? 1.4;
  const lastWeekWasASpike = hdrBefore != null && hdrNormal
    && hdrBefore > hdrNormal * spikeMultiple;
  const hdrBase = lastWeekWasASpike ? hdrNormal : hdrBefore;
  const hdrChange = hdrNow != null && hdrBase ? (hdrNow - hdrBase) / hdrBase : null;
  const hdrAgainst = lastWeekWasASpike ? 'their own normal' : 'last week';
  const fanSpend = pct(m.fanClub?.diamondsChange7);
  const monthChange = pct(m.monthOnMonth?.diamonds?.change);

  // Dark is dark. Nothing else is worth saying until they are back on.
  if ((m.darkStreak ?? 0) >= (config.portal?.darkDays ?? 4)) {
    return {
      lever: 'dark',
      headline: `No LIVE for ${m.darkStreak} days`,
      detail: 'Nothing else in the data means anything until they are back on. Find out why.',
      actions: [
        'Call them. Not a message — a call.',
        'Find out whether it is life, burnout, or they have gone somewhere else.',
        'Agree one date they will go back on, and put it in writing.',
      ],
    };
  }

  // A creator whose month is far ahead but whose week is falling is coming off
  // a peak, not collapsing. The card said "+126% this month" and "both down" in
  // the same breath and read like a contradiction, so the sentence that
  // reconciles them has to be on the card: they are still having a big month,
  // and this is the week it starts slipping. That is the week to make the call,
  // which is the whole reason it is flagged.
  const offAPeak = monthChange != null && monthChange >= (config.portal?.recordMonth ?? 0.5);
  const peakNote = offAPeak
    ? ` Their month is ${Math.round(monthChange * 100)}% up on the same point last month, so this is a big month easing off rather than a bad one. The job is to protect it, not to sound an alarm.`
    : '';

  // Hours down with conversion holding is the cleanest call there is: the room
  // still pays the same per hour, so the hours ARE the money.
  const hoursDown = hoursChange != null && hoursChange <= -(config.portal?.hoursDrop ?? 0.15);
  if (hoursDown && hdrChange != null && hdrChange > -(config.portal?.hdrDrop ?? 0.15)) {
    return {
      lever: 'hours',
      headline: offAPeak ? 'Hours slipping off a peak' : 'Hours, not the room',
      detail: `LIVE hours ${Math.round(hoursChange * 100)}% on last week, with diamonds per hour holding against ${hdrAgainst}. The room converts the same, so the hours are the whole gap. Get the time back.${peakNote}`,
      actions: [
        'Add LIVE days before you add session length. Frequency is cheaper for them and it is what the algorithm reads.',
        'Agree a schedule they will actually keep, not the one they wish they kept.',
        'Nothing about content needs changing. Say that — it is the reassuring half of this call.',
      ],
    };
  }

  // Both down is a conversion problem wearing an hours problem's clothes.
  if (hoursDown && hdrChange != null && hdrChange <= -(config.portal?.hdrDrop ?? 0.15)) {
    return {
      lever: 'conversion',
      headline: offAPeak ? 'Coming off a peak' : 'Hours and conversion both down',
      // Two different sentences for two different situations. Telling somebody
      // on a 126% month to get "back to basics" in the same breath as "this is
      // a big month easing off" is the page arguing with itself again.
      detail: offAPeak
        ? `Hours ${Math.round(hoursChange * 100)}% on last week, and diamonds per hour ${Math.round(hdrChange * 100)}% against ${hdrAgainst}${
          lastWeekWasASpike ? ` (${n0(hdrNormal)}/hour over 28 days — last week was an outlier at ${n0(hdrBefore)})` : ''}.${peakNote}`
        : `Hours ${Math.round(hoursChange * 100)}% on last week, and diamonds per hour ${Math.round(hdrChange * 100)}% against ${hdrAgainst}${
          lastWeekWasASpike ? ` (${n0(hdrNormal)}/hour over 28 days — last week was an outlier at ${n0(hdrBefore)})` : ''}. More time alone will not fix this. Back to basics on the stream: welcoming, thanking, a gift goal, revenue boost.`,
      actions: offAPeak ? [
        'Lead with the month, not the week. They are having a big one and they should hear that first.',
        'Find out what made the big week work. That is the repeatable part, and nobody writes it down.',
        'Only then, gently: the last few nights converted below their own normal. Ask what changed.',
        'Do not send a "you are slipping" message to somebody having a record month.',
      ] : [
        'Watch one of their LIVEs before the call. You cannot coach conversion off a spreadsheet.',
        'Back to basics: are they welcoming, thanking, introducing themselves?',
        'Is there a gift goal running, and are they revenue boosting it?',
        'If the room is flat, the game may be the problem. Ask what else they could play.',
      ],
    };
  }

  // Fewer nights on is its own thing, and the commonest one.
  if (daysBefore - daysNow >= (config.portal?.daysDrop ?? 2)) {
    return {
      lever: 'days',
      headline: 'Going live less',
      detail: `${daysNow} LIVE days last week against ${daysBefore} the week before. Frequency first — it is cheaper than longer sessions and it is what the algorithm reads.`,
      actions: [
        'Find out what changed. A dropped night is usually a life reason, not a TikTok one.',
        'Get one night back first. One is a habit; four is a negotiation.',
        'Check their LIVE duration too — fewer, longer sessions is a different problem from fewer, shorter ones.',
      ],
    };
  }

  // Our nearest reading of gift rate. The real one is on the Insights sheet;
  // fan club spend is the part of it we hold, and it moves with it.
  if (fanSpend != null && fanSpend <= -(config.portal?.giftDrop ?? 0.25)) {
    return {
      lever: 'gifting',
      headline: 'Gifting is sliding',
      detail: `Fan club spend ${Math.round(fanSpend * 100)}% on last week, with the hours holding up. This is engagement and gifter management, not an hours problem.`,
      needsInsights: true,
      actions: [
        'Check the real gift rate on the Creator Insights sheet before you call. This is our nearest reading, not the number itself.',
        'The base layer first: welcoming and thanking. People forget they stopped.',
        'Then the drivers: viewer wishes, gift goals, fan club campaigns, interactive gaming.',
        'Are they in a campaign? Campaigns spike gift rate more than anything else on this list.',
        'We cannot ask for gifts. We can make it obvious how someone supports them.',
      ],
    };
  }

  // A record month with nothing wrong in the data. Carla's rule: say so, and
  // fall through to the two things the data cannot see.
  if (monthChange != null && monthChange >= (config.portal?.recordMonth ?? 0.5)) {
    return {
      lever: 'anomaly',
      headline: 'Record month, nothing off in the data',
      detail: 'Nothing here explains it and nothing needs fixing. The job is to protect it and to learn from it.',
      actions: [
        'Find out what changed. A record month always has a reason, and the reason is repeatable.',
        'Content review: watch a LIVE and write down what they are doing differently.',
        'Gifter management — who is carrying this month, and what happens when they stop?',
        'Do not change anything mid-run. Protect it, then build on it next month.',
      ],
    };
  }

  // An alert fired and none of the week-on-week checks above explain it. The
  // rules look at things this function does not — month-on-month, against
  // their own normal, fan-club erosion — so take their reading rather than
  // telling a coach that an urgent creator has nothing wrong with them.
  if (alert?.signals?.length) {
    const lever = leverFromSignals(alert.signals);
    const top = alert.signals.slice(0, 2);
    return {
      lever,
      headline: top[0]?.label ?? 'Declining',
      detail: top.map((x) => [x.label, x.detail].filter(Boolean).join('. ')).join(' ')
        || 'The decline rules flagged this creator.',
      actions: ACTIONS[lever] ?? ACTIONS.conversion,
      fromRules: true,
    };
  }

  // Still short of a target with nothing broken: it is a plan, not a problem.
  if (rank?.needPerDay != null && rank.needPerDay > 0) {
    const plan = planFor(m, rank.needPerDay, config.ramp ?? {});
    return {
      lever: plan.lever,
      headline: 'On the chase',
      detail: plan.ask,
      actions: [
        'Tell them the number. A creator who does not know the target cannot chase it.',
        'Agree the nights this week, not the month. The month is the goal; the week is the plan.',
      ],
    };
  }
  return {
    lever: 'hold',
    headline: 'Nothing to fix',
    detail: 'Holding. Keep them excited for the rest of the month.',
    actions: ['Nothing needed. Keep them excited and leave them alone.'],
  };
}

/**
 * Something the coach can actually send.
 *
 * The gap this closes: a card tells a coach what is wrong and they still have
 * to work out how to say it to a 19-year-old at 11pm. These are written to be
 * pasted as they are.
 *
 * Creator-facing, so the same rules the creator cards follow apply here and
 * are not negotiable: NO FIGURES. No diamonds, no hours, no LIVE days, no fan
 * club numbers, no team names, no coach names, no money. A creator who gets
 * sent their own diamond count has been shown the agency's books. Warmth and
 * emojis are fine — these are not coach cards.
 */
export function creatorMessage(lever, username) {
  const at = `@${String(username ?? '').replace(/^@/, '')}`;
  const MESSAGES = {
    dark: `Hey ${at} 👀 not seen you go live in a bit and just wanted to check in — all good your end?\n\nNo pressure at all, just here if something's up. And if you're ready to get back on, tell me which night and I'll make sure we're behind you for it 💙`,
    hours: `${at} 🔥 your room is converting brilliantly right now — the people who turn up are properly backing you.\n\nThe only thing holding you back is how often we're seeing you. Nothing about the content needs changing, we just need you on more. What nights can you lock in this week? 💙`,
    conversion: `Hey ${at} 💙 want to help you get the room buzzing again.\n\nQuick reset — welcome people in by name, thank every single gift out loud, and keep a goal running so the room knows what they're building towards. It sounds basic and it's the thing that moves it most.\n\nI'll jump in your next live and we'll go from there 🙌`,
    days: `${at} 👋 noticed we've not had as many nights from you lately.\n\nGetting live more often is the single biggest thing for you right now — the algorithm rewards showing up more than it rewards long sessions. Can we pick some nights and stick to them this week? I'll back you the whole way 💙`,
    gifting: `Hey ${at} 💙 your hours are great — let's get the room giving back properly.\n\nThree things: welcome people in by name, thank every gift out loud, and keep a goal running so there's something to chase together. Getting you into the next campaign too, they make a massive difference.\n\nWhat do you fancy going for? 🔥`,
    rate: `${at} 🔥 you're putting the hours in and I want them to pay off properly.\n\nMore time on its own won't do it — let's work on the room instead. Fan club, goals and getting you matched up with other creators so new people find you. Free for a quick chat this week? 💙`,
    protect: `${at} 🚀 just wanted to say — you are having a brilliant month, and that big week was something else.\n\nNo pressure at all, I just don't want us to lose the rhythm you found. Whatever you were doing on those nights, let's get back to it this week.\n\nProperly proud of you 💙`,
    anomaly: `${at} 🚀 you are having an absolutely unreal month and I'm not letting it go unnoticed.\n\nWhatever you've changed, keep doing it. Don't switch anything up right now — just keep showing up the way you are. Properly proud of you 💙`,
    hold: `${at} 💙 just a quick one — you're doing everything right at the minute. Keep going, keep showing up, and shout if you need anything 🙌`,
  };
  return MESSAGES[lever] ?? MESSAGES.hold;
}

/**
 * The nudge a coach sends about a target.
 *
 * This one DOES carry a figure, and the distinction is deliberate.
 *
 * The decline messages above carry none, because "your gifting is down 80%"
 * tells a creator how we grade them and lands as a complaint. A target is the
 * opposite: Carla's own rule from the 22 October call is "tell them the number
 * — a creator who does not know the target cannot chase it." And it is not a
 * disclosure, because a creator can already see their own diamond count in
 * their own LIVE Backstage. What they cannot see, and what never goes in here,
 * is anybody else's numbers, what the agency earns, or what their coach is paid.
 */
export function rankMessage(username, { gap, perDay, tier, daysLeft }) {
  const at = `@${String(username ?? '').replace(/^@/, '')}`;
  const nf = (x) => Math.round(x).toLocaleString('en-GB');
  if (!gap || gap <= 0) {
    return `${at} 🔥 you've already done it this month — you're holding your tier and that is money in your pocket.\n\nDon't ease off now. Keep the nights you've been doing and let's finish strong 💙`;
  }
  const days = daysLeft > 0 ? daysLeft : 1;
  // Plain text, no markdown. A coach might paste this into Discord, where
  // **bold** renders, or into a TikTok DM, where it shows as asterisks.
  return `${at} 👀 you are closer than you think.\n\n${nf(gap)} diamonds off Tier ${tier} — that's about ${nf(perDay ?? gap / days)} a day for the rest of the month. Completely doable if we lock the nights in.\n\nTell your community what you're going for, they'll get behind it. Let's go 🔥💙`;
}

/** One roster line. Everything a coach sorts on, and the colour. */
function rosterRow({ creator, metrics, rank, alert, quest, grad, config, hasAvatar = null }) {
  const m = metrics;
  const mtd = num(m?.monthToDate?.diamonds);
  const change = pct(m?.monthOnMonth?.diamonds?.change);
  let state = STATE.IDLE;
  // Carla's first rule, and the one that decides whether this page is usable:
  // only name people a coach can do something about. Without the floor every
  // dormant creator on the roster reads red — 663 of them across the network on
  // the first run — and a page where two thirds of the roster is an emergency
  // is a page nobody opens twice.
  //
  // A creator who has gone dark on real output is a coaching job. A creator who
  // has never started is an activation job, and lives in its own list.
  const actFloor = config.portal?.actFloorDiamonds ?? 5000;
  const darkDays = config.portal?.darkDays ?? 4;

  // A creator having a huge month whose week has eased off is not an emergency,
  // and calling it one is how a coach stops trusting the page. @itsmalkin was
  // filed under "Slipping now, worth the call" on a month running 127% ahead of
  // the same point last month. The week is still worth a word — it just is not
  // the same word.
  const monthUp = pct(m?.monthOnMonth?.diamonds?.change);
  const havingABigMonth = monthUp != null && monthUp >= (config.portal?.bigMonth ?? 0.5);

  if (alert && havingABigMonth) state = STATE.PROTECT;
  else if (alert) state = STATE.ACT;
  else if ((m?.darkStreak ?? 0) >= darkDays && mtd >= actFloor) state = STATE.ACT;
  else if (rank?.rankedUp || (grad?.done)) state = STATE.GOOD;
  else if (rank?.reachable && rank.gap > 0) state = STATE.WATCH;
  else if (quest && !quest.done) state = STATE.WATCH;
  else if (mtd > 0) state = STATE.GOOD;
  return {
    key: creator.key,
    username: creator.username,
    // Straight to their profile. Half of Carla's method is things the export
    // cannot see — are they posting short form, what does the room look like —
    // and a coach should not have to retype a handle to go and look.
    tiktok: creator.username ? `https://www.tiktok.com/@${encodeURIComponent(creator.username)}` : null,
    // Served by us, not by TikTok: their avatar URLs are signed and expire
    // within the day, so a page that linked them straight would show a wall of
    // broken squares by tomorrow morning.
    avatar: creator.username && hasAvatar?.(creator.username) ? avatarRoute(creator.username) : null,
    group: creator.group ?? null,
    joinDate: creator.joinDate ?? null,
    state,
    diamonds: Math.round(mtd),
    change,
    // Rounded: the 7-day window allocates multi-day spans fractionally, so the
    // raw number is things like 0.14285714285714285, which is not a number to
    // print beside somebody's name.
    liveDays7: Math.round(num(m?.curr7?.validLiveDays) * 10) / 10,
    liveDays28: num(m?.activeDays28),
    hours7: num(m?.curr7?.liveHours),
    perHour: m?.diamondsPerHour28 ?? null,
    // The four numbers Perry asked for, each against the same point last
    // month. `monthOnMonth` carries the comparison and is null for anyone with
    // no previous month, so the value falls back to this month's own total and
    // the change reads as unavailable rather than as zero.
    // Each one carries the figure its percentage is measured against, because a
    // percentage with nothing behind it is half a fact. For the month stats
    // that figure is LAST MONTH TO THE SAME POINT, not last month's total: on
    // the 19th, comparing a part month against a whole one would read as a
    // collapse for somebody doing exactly what they always do.
    //
    // Fan club is the odd one out and is labelled as such — it is a 14-day
    // change, the only window we hold for it.
    month: {
      diamonds: {
        now: Math.round(num(m?.monthToDate?.diamonds)),
        change: pct(m?.monthOnMonth?.diamonds?.change),
        then: m?.monthOnMonth?.diamonds?.lastMonthToSamePoint ?? null,
        thenNote: 'by this point last month',
      },
      hours: {
        now: num(m?.monthToDate?.liveHours),
        change: pct(m?.monthOnMonth?.liveHours?.change),
        then: m?.monthOnMonth?.liveHours?.lastMonthToSamePoint ?? null,
        thenNote: 'by this point last month',
      },
      liveDays: {
        now: Math.round(num(m?.monthToDate?.validLiveDays)),
        change: pct(m?.monthOnMonth?.validLiveDays?.change),
        then: m?.monthOnMonth?.validLiveDays?.lastMonthToSamePoint ?? null,
        thenNote: 'by this point last month',
      },
      fanClub: {
        now: m?.fanClub?.activeFans ?? null,
        change: pct(m?.fanClub?.activeFansChange14),
        then: m?.fanClub?.activeFans14 ?? null,
        thenNote: 'two weeks ago',
      },
    },
    perDay7: Math.round(num(m?.dailyDiamonds7)),
    darkStreak: m?.darkStreak ?? 0,
    fanClub: m?.fanClub?.activeFans ?? null,
    rank: rank ? {
      rankedUp: rank.rankedUp, maintained: rank.maintained,
      fromTier: rank.fromTier, toTier: rank.toTier,
      gap: rank.gap, needPerDay: rank.needPerDay == null ? null : Math.round(rank.needPerDay),
      reachable: rank.reachable, worth: rank.worth, worthIfCrossed: rank.worthIfCrossed,
      // What the bar is drawn against: the next tier's floor, and how far along
      // the creator is toward it. Backstage shows the same two numbers, and a
      // bar reads in a glance where "tier 1 to 1, maintaining" reads as nothing.
      diamonds: Math.round(rank.diamonds ?? 0),
      target: rank.target,
      progress: rank.target ? Math.min(1, (rank.diamonds ?? 0) / rank.target) : 1,
      daysLeft: rank.daysLeft ?? 0,
    } : null,
    quest: quest ?? null,
    graduation: grad ? { remaining: grad.remaining, done: grad.done, requiredPerDay: grad.requiredPerDay } : null,
    alert: alert ? { severity: alert.severity, signals: alert.signals.map((s) => s.label ?? s.id) } : null,
    rankMessage: rank ? rankMessage(creator.username, {
      gap: rank.gap, perDay: rank.needPerDay, tier: (rank.toTier ?? 0) + 1, daysLeft: rank.daysLeft,
    }) : null,
    diagnosis: (() => {
      const d = diagnose(m, { rank, config, alert });
      if (!d) return d;
      // A creator having a big month gets the protective note, whatever lever
      // the data tripped. Sending somebody on a record month a back-to-basics
      // lecture is how a coach loses them.
      const key = state === STATE.PROTECT ? 'protect' : d.lever;
      return { ...d, message: creatorMessage(key, creator.username) };
    })(),
  };
}

/**
 * The whole portal, assembled once per run and sliced per viewer.
 *
 * Built in one pass because the expensive parts — metrics, causes, the rank-up
 * board — are shared, and because the director view is the coach views summed.
 * Slicing afterwards is what guarantees the two can never disagree.
 */
export function buildPortal({
  result, config, revenue = null, rankUp = null, quests = null, caseStore = null,
  hasAvatar = null,
}) {
  const { creators, metricsByKey, alerts = [], ramp = [], activation = [], asOf } = result;
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const month = asOf.slice(0, 7);

  const alertByKey = new Map(alerts.map((a) => [a.creator.key, a]));
  const rankByKey = new Map((rankUp?.rows ?? []).map((r) => [r.creator.key, r]));
  const gradByKey = new Map(ramp.map((r) => [r.creator.key, r]));
  const questByKey = new Map((quests?.quests ?? []).map((q) => [q.key, q]));
  const openCases = (caseStore?.all?.() ?? []).filter(isOpen);
  const caseByKey = new Map(openCases.map((c) => [c.creatorKey, c]));
  const activationByKey = new Map(activation.map((a) => [a.creator.key, a]));

  // Graduation rows carry the group, so the ladder is built per team once.
  const gradRows = ramp.map((r) => ({
    group: r.creator.group ?? null, done: r.monthToDate >= (config.ramp?.targetDiamonds ?? 200000),
    remaining: Math.max(0, (config.ramp?.targetDiamonds ?? 200000) - r.monthToDate),
    monthToDate: r.monthToDate, username: r.creator.username, creator: r.creator,
    requiredPerDay: r.requiredPerDay,
  }));

  const byCoach = new Map();
  for (const c of creators) {
    if (c.quitOn) continue;
    if (ignored.has(groupKey(c.group))) continue;
    const coach = c.manager ?? 'unassigned';
    const bucket = byCoach.get(coach) ?? { coach, name: coachName(coach, config), rows: [], teams: new Set() };
    const m = metricsByKey.get(c.key);
    const g = gradByKey.get(c.key);
    bucket.rows.push(rosterRow({
      creator: c, metrics: m,
      rank: rankByKey.get(c.key) ?? null,
      alert: alertByKey.get(c.key) ?? null,
      quest: questByKey.get(c.key) ?? null,
      hasAvatar,
      grad: g ? { remaining: Math.max(0, (config.ramp?.targetDiamonds ?? 200000) - g.monthToDate), done: g.monthToDate >= (config.ramp?.targetDiamonds ?? 200000), requiredPerDay: g.requiredPerDay } : null,
      config,
    }));
    if (c.group) bucket.teams.add(c.group);
    byCoach.set(coach, bucket);
  }

  const views = new Map();
  for (const [coach, bucket] of byCoach) {
    const rows = bucket.rows.sort((a, b) => b.diamonds - a.diamonds);
    const rev = revenue?.byCoach?.get(coach) ?? null;

    // What one diamond is worth to THIS coach, at their current unlock. The
    // whole point of putting money on a creator card is that it is their money:
    // a coach on both goals earns twice what a coach on neither does for the
    // same creator, and quoting the network average would be a lie to both.
    const incCfg = config.revenue?.incremental ?? {};
    const unlock = rev?.unlock ?? (incCfg.baseUnlock ?? 0.10);
    const perDiamond = 0.01 * (incCfg.boardRate ?? 0.05) * unlock
      * (config.revenue?.usdToGbp ?? 0.754073884);

    for (const r of rows) {
      // Closing a 200k gap pays the coach their diamond share on every diamond
      // of it. Landing a rank up pays the rank-up rate on the whole month.
      r.worthIfGraduates = r.graduation && !r.graduation.done
        ? r.graduation.remaining * perDiamond : 0;
      r.worthIfRanksUp = r.rank && !r.rank.rankedUp ? (r.rank.worthIfCrossed ?? 0) : 0;
      // What walking away costs. A creator sliding takes their diamonds with
      // them, and for an urgent card that is the number that moves somebody.
      r.atRisk = r.state === STATE.ACT ? Math.max(0, r.perDay7 * 7) * perDiamond : 0;
    }

    // Carla's three questions, in the order a coach should answer them, and
    // each list filtered to people the coach can still change the outcome for.
    //
    // The 200k list needs the reach test more than any of them. Without it the
    // section listed ten creators and quoted the LARGEST payout against the
    // one furthest away — because closing a gap pays per diamond, so a creator
    // 190,000 short "is worth" more than one 50,000 short. That is exactly
    // backwards as an incentive, and it put 15,877-a-day creators at the top
    // of a list meant to be a morning's work.
    const chaseStretch = config.portal?.chaseStretch ?? 2;
    // Named somewhere above already — urgent or protect — so not named again.
    const urgentKeys = new Set(rows
      .filter((r) => r.state === STATE.ACT || r.state === STATE.PROTECT).map((r) => r.key));
    const inReach = (r) => {
      const need = r.graduation?.requiredPerDay;
      if (need == null) return false;
      if (need <= 0) return true;
      const doing = r.perDay7;
      return doing > 0 && need <= doing * chaseStretch;
    };
    const chase = rows
      .filter((r) => r.graduation && !r.graduation.done && r.diamonds > 0 && inReach(r))
      // A creator already named under Urgent is not named again here. The coach
      // has one call to make, not two, and the urgent card is the one that says
      // what is wrong.
      .filter((r) => !urgentKeys.has(r.key))
      .sort((a, b) => a.graduation.remaining - b.graduation.remaining)
      .slice(0, config.portal?.chaseCount ?? 6);
    const chaseOutOfReach = rows
      .filter((r) => r.graduation && !r.graduation.done && r.diamonds > 0 && !inReach(r)).length;
    const graduated = rows.filter((r) => r.graduation?.done);

    // Carla's first rule, applied: the upside list names only creators a coach
    // can still change the outcome for, ordered by what it is worth to them.
    const upside = rows
      .filter((r) => r.rank && !r.rank.rankedUp && r.rank.reachable && r.rank.gap > 0)
      .filter((r) => !urgentKeys.has(r.key))
      .sort((a, b) => b.rank.worthIfCrossed - a.rank.worthIfCrossed)
      .slice(0, config.portal?.upsideCount ?? 8);
    const upsideTotal = upside.reduce((n, r) => n + r.rank.worthIfCrossed, 0);

    // Already banked, and therefore defendable: a maintain lost in the last
    // week of the month costs the same as a rank-up never made.
    const banked = rows.filter((r) => r.rank?.rankedUp || r.rank?.maintained);

    // Ordered by what is at stake, and capped. A coach has a morning, not a
    // day: the top of this list is where it should go, and the rest are still
    // on the roster table below with their colour on them.
    const protect = rows
      .filter((r) => r.state === STATE.PROTECT)
      .sort((a, b) => b.diamonds - a.diamonds);
    const acting = rows
      .filter((r) => r.state === STATE.ACT)
      .sort((a, b) => (b.alert ? 1 : 0) - (a.alert ? 1 : 0) || b.diamonds - a.diamonds);
    const attentionCap = config.portal?.attentionCount ?? 10;
    const attention = acting.slice(0, attentionCap);
    const attentionMore = Math.max(0, acting.length - attention.length);

    views.set(coach, {
      coach, name: bucket.name, asOf, month,
      teams: [...bucket.teams].sort(),
      earningsHidden: earningsHidden(coach, config),
      earnings: rev,
      counts: {
        roster: rows.length,
        act: rows.filter((r) => r.state === STATE.ACT).length,
        protect: protect.length,
        watch: rows.filter((r) => r.state === STATE.WATCH).length,
        good: rows.filter((r) => r.state === STATE.GOOD).length,
        idle: rows.filter((r) => r.state === STATE.IDLE).length,
      },
      diamonds: rows.reduce((n, r) => n + r.diamonds, 0),
      upside, upsideTotal, banked, attention, attentionMore, protect,
      perDiamond, chase, graduated, chaseOutOfReach,
      chaseTotal: chase.reduce((n, r) => n + r.worthIfGraduates, 0),
      atRiskTotal: rows.reduce((n, r) => n + (r.atRisk ?? 0), 0),
      quests: rows.filter((r) => r.quest),
      activation: rows.filter((r) => activationByKey.has(r.key)),
      cases: rows.filter((r) => caseByKey.has(r.key))
        .map((r) => ({ ...r, caseId: caseByKey.get(r.key).id, caseKind: caseByKey.get(r.key).kind })),
      graduation: [...bucket.teams].map((t) => ({ team: t, ladder: graduationLadder(gradRows, t) })),
      rows,
    });
  }

  const coaches = [...views.values()].sort((a, b) => b.diamonds - a.diamonds);

  // The same roster sliced by team instead of by coach, with every earnings
  // line removed. This is what a card in a shared team channel is allowed to
  // link to: a coach's own view carries their wage, and a team room is not a
  // private place. Teams with two coaches get both coaches' creators, which is
  // what anybody in that room would expect to see.
  const teamViews = new Map();
  for (const view of views.values()) {
    for (const team of view.teams) {
      const rows = view.rows.filter((r) => r.group === team);
      const prior = teamViews.get(team);
      const merged = prior ? [...prior.rows, ...rows] : rows;
      merged.sort((a, b) => b.diamonds - a.diamonds);
      const acting = merged.filter((r) => r.state === STATE.ACT);
      const cap = config.portal?.attentionCount ?? 10;
      const upside = merged
        .filter((r) => r.rank && !r.rank.rankedUp && r.rank.reachable && r.rank.gap > 0)
        .sort((a, b) => b.rank.worthIfCrossed - a.rank.worthIfCrossed)
        .slice(0, config.portal?.upsideCount ?? 8);
      teamViews.set(team, {
        coach: team, name: team, asOf, month, teams: [team],
        // Not a preference. A team link is handed around a channel.
        earningsHidden: true, earnings: null,
        counts: {
          roster: merged.length,
          act: acting.length,
          watch: merged.filter((r) => r.state === STATE.WATCH).length,
          good: merged.filter((r) => r.state === STATE.GOOD).length,
          idle: merged.filter((r) => r.state === STATE.IDLE).length,
        },
        diamonds: merged.reduce((n, r) => n + r.diamonds, 0),
        upside,
        upsideTotal: upside.reduce((n, r) => n + r.rank.worthIfCrossed, 0),
        banked: merged.filter((r) => r.rank?.rankedUp || r.rank?.maintained),
        attention: acting.slice(0, cap),
        attentionMore: Math.max(0, acting.length - cap),
        protect: merged.filter((r) => r.state === STATE.PROTECT),
        perDiamond: 0,
        chase: merged.filter((r) => r.graduation && !r.graduation.done && r.diamonds > 0
          && r.graduation.requiredPerDay != null && r.perDay7 > 0
          && r.graduation.requiredPerDay <= r.perDay7 * (config.portal?.chaseStretch ?? 2))
          .sort((a, b) => a.graduation.remaining - b.graduation.remaining)
          .slice(0, config.portal?.chaseCount ?? 6),
        chaseOutOfReach: 0,
        graduated: merged.filter((r) => r.graduation?.done),
        chaseTotal: 0,
        atRiskTotal: 0,
        quests: merged.filter((r) => r.quest),
        activation: merged.filter((r) => activationByKey.has(r.key)),
        cases: [],
        graduation: [{ team, ladder: graduationLadder(gradRows, team) }],
        rows: merged,
      });
    }
  }
  return {
    asOf, month,
    stale: result.stale ?? null,
    coaches,
    byCoach: views,
    byTeam: teamViews,
    network: {
      roster: coaches.reduce((n, c) => n + c.counts.roster, 0),
      diamonds: coaches.reduce((n, c) => n + c.diamonds, 0),
      act: coaches.reduce((n, c) => n + c.counts.act, 0),
      upsideTotal: coaches.reduce((n, c) => n + c.upsideTotal, 0),
      payroll: revenue?.networkTotal ?? null,
      rankUps: coaches.reduce((n, c) => n + c.banked.filter((r) => r.rank.rankedUp).length, 0),
      maintains: coaches.reduce((n, c) => n + c.banked.filter((r) => r.rank.maintained).length, 0),
    },
  };
}
