// Why a creator is down, ranked.
//
// The coaches already know how to fix these things. What costs them time is
// working out *which* of the usual suspects it is this time, across hundreds of
// creators. So this does not prescribe a fix — it reads the data for the
// signatures of the nine things that actually go wrong at LEAP, ranks them, and
// hands over the questions that separate one from another.
//
// Confidence is stated honestly, because a coach who is told "lost gifters"
// and finds a creator on holiday stops trusting the tool:
//
//   likely   - the data shows this pattern directly
//   possible - the data is consistent with it but does not single it out
//   ask      - the data cannot see this at all; it is on the list because it is
//              common and worth ruling out in conversation
//
// Nothing here is ever the last word. The creator is.

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));
const RANK = { likely: 3, possible: 2, ask: 1 };

/** Roughly unchanged, for "X moved but Y did not" tests. */
const flat = (change, tolerance = 0.15) => change != null && Math.abs(change) <= tolerance;
const down = (change, threshold) => change != null && change <= -threshold;

/**
 * Two different things a coach needs, kept apart on purpose.
 *
 *   cause - something that changed, and explains the drop
 *   lever - something they have never done, which is an opportunity rather
 *           than an explanation
 *
 * Mixing them is what makes this kind of tool useless. Four creators in five
 * have never done a campaign, so "not taking part in campaigns" as a *cause*
 * is just the base rate wearing a diagnosis hat. As a *lever* on a creator who
 * is already struggling, it is a genuinely useful thing to raise.
 */
export const KIND = { CAUSE: 'cause', LEVER: 'lever' };

/**
 * Each cause knows how to recognise itself. `detect` returns null when the
 * pattern is absent, or a confidence plus the evidence that earned it.
 */
export const CAUSES = [
  {
    id: 'FEWER_HOURS',
    kind: KIND.CAUSE,
    label: 'Less hours — schedule has slipped',
    detect: (m) => {
      const ev = [];
      if (m.darkStreak >= 3) ev.push(`${m.darkStreak} days with no LIVE at all`);
      if (down(m.change7.liveHours, 0.2)) {
        ev.push(`LIVE hours ${pct(m.change7.liveHours)} — ${m.curr7.liveHours.toFixed(1)}h this week vs ${m.prev7.liveHours.toFixed(1)}h last`);
      }
      if (m.prev7.validLiveDays - m.curr7.validLiveDays >= 1.5) {
        ev.push(`${Math.round(m.curr7.validLiveDays)} LIVE days this week, down from ${Math.round(m.prev7.validLiveDays)}`);
      }
      if (!ev.length) return null;
      return { confidence: 'likely', evidence: ev };
    },
    ask: [
      'Do they actually have a written schedule, or is it whenever they feel like it?',
      'If they have one — what got in the way this week?',
      'Is the schedule still realistic for their life right now, or has something changed?',
    ],
    check: ['Their last agreed schedule, and whether this is the first week they have missed it'],
  },
  {
    id: 'STOPPED_CAMPAIGNS',
    kind: KIND.CAUSE,
    label: 'Stopped doing campaigns and matches',
    detect: (m) => {
      // Only a *cause* if they used to and stopped. Someone who has never
      // matched has not changed anything, so it cannot explain a drop.
      if (!m.lastMatch) return null;
      if (m.matchShare28 != null && m.matchShare28 > 0.1 && m.matches7 === 0) {
        return {
          confidence: 'likely',
          evidence: [`Matches are normally ${pct(m.matchShare28)} of their diamonds, and they have done none this week`],
        };
      }
      if (m.lastMatch.days >= 21) {
        return {
          confidence: 'likely',
          evidence: [`They used to match, and the last one was at least ${m.lastMatch.days} days ago${m.lastMatch.exact ? '' : ' (possibly longer)'}`],
        };
      }
      return null;
    },
    ask: [
      'Did they enter the last campaign? If not — did they even know it was on?',
      'When did they last do a match? Who with?',
      'Is anything stopping them: nerves, timing, no one to match with?',
    ],
    check: ['The campaign sign-up list — were they on it?'],
  },
  {
    id: 'NEVER_CAMPAIGNS',
    kind: KIND.LEVER,
    label: 'Has never done a campaign or match',
    detect: (m) => {
      if (m.lastMatch || m.matches28 > 0) return null;
      // Only worth raising on someone with a room to bring to it.
      if (m.curr28.liveHours < 8 || m.curr28.diamonds < 5000) return null;
      return {
        confidence: 'possible',
        evidence: [
          'No matches on record at all',
          `They are streaming ${m.curr28.liveHours.toFixed(0)}h a month — there is a room here that has never been put in front of anyone else`,
        ],
      };
    },
    ask: [
      'Have they ever done a match? What put them off?',
      'Would they try one with someone from their own team first?',
      'Do they know campaigns exist and how to enter?',
    ],
    check: ['Whether anyone has ever actually invited them to one'],
  },
  {
    id: 'LOST_GIFTERS',
    kind: KIND.CAUSE,
    label: 'Lost gifters — the people have gone',
    detect: (m) => {
      const fansDown = m.fanClub.activeFansChange14 ?? m.fanClub.activeFansChange7;
      if (!down(fansDown, 0.2) || (m.fanClub.activeFans ?? 0) < 3) return null;
      const ev = [`Active fan club members ${pct(fansDown)} — down to ${n(m.fanClub.activeFans)}`];
      if ((m.fanClub.contribution ?? 0) > 0.8) {
        ev.push(`${pct(m.fanClub.contribution)} of their income comes from that group`);
      }
      return { confidence: 'likely', evidence: ev };
    },
    ask: [
      'Has one of the big supporters gone quiet, or left altogether?',
      'Did anything happen in the fan club — a fallout, a mod problem?',
      'Are they still talking to their regulars off-stream?',
    ],
    check: ['Their fan club list — which names have stopped appearing'],
  },
  {
    id: 'GIFTERS_TAPPED_OUT',
    kind: KIND.CAUSE,
    label: 'Gifters ran out of money — same people, smaller gifts',
    detect: (m) => {
      // The distinction the data can make and a coach cannot eyeball: the same
      // faces spending less looks nothing like losing the faces, and the two
      // need completely different conversations.
      const fansChange = m.fanClub.activeFansChange14 ?? m.fanClub.activeFansChange7;
      const spendDown = down(m.fanClub.diamondsChange7, 0.25);
      if (!spendDown || !flat(fansChange, 0.1)) return null;
      return {
        confidence: 'likely',
        evidence: [
          `Fan club spending ${pct(m.fanClub.diamondsChange7)} but membership is unchanged at ${n(m.fanClub.activeFans)}`,
          'The same people are still turning up — they are just spending less',
        ],
      };
    },
    ask: [
      'Same faces in the room, smaller gifts? That is usually wallets, not interest.',
      'Where are their regulars in the month — is this the week before payday?',
      'Is there a cheaper way for them to support: lower tier, more people, rather than more from the same few?',
    ],
    check: ['Whether this happens at the same point every month'],
  },
  {
    id: 'NO_GOALS',
    kind: KIND.CAUSE,
    label: 'No goals or revenue boosting in the room',
    detect: (m) => {
      const baseRate = m.profile.liveHours?.baseline > 0.5
        ? (m.profile.diamonds?.baseline ?? 0) / m.profile.liveHours.baseline
        : m.diamondsPerHour28;
      if (!baseRate || !m.diamondsPerHour7) return null;
      const change = (m.diamondsPerHour7 - baseRate) / baseRate;
      // Hours held up and the money did not: the room is running, but nothing
      // in it is asking for anything.
      if (!down(change, 0.25) || !flat(m.change7.liveHours, 0.2)) return null;
      return {
        confidence: 'likely',
        evidence: [
          `${n(m.diamondsPerHour7)} diamonds per LIVE hour this week against ${n(baseRate)} normally (${pct(change)})`,
          `Hours are holding at ${m.curr7.liveHours.toFixed(1)}h — the time is there, the asks are not`,
        ],
      };
    },
    ask: [
      'Are they running gift goals on screen, or just chatting and hoping?',
      'When did they last do a goal night, a battle, or a target they announced?',
      'Do they thank gifters by name? Rooms notice.',
    ],
    check: ['Watch ten minutes of a recent LIVE — is there a goal visible at all?'],
  },
  {
    id: 'NO_SHORT_FORM',
    kind: KIND.LEVER,
    label: 'No short form content bringing new traffic in',
    detect: (m) => {
      const followersDown = down(m.change7.newFollowers, 0.3);
      const stillLive = m.curr7.liveHours >= 2 && !down(m.change7.liveHours, 0.25);
      if (!followersDown || !stillLive) return null;
      return {
        confidence: 'possible',
        evidence: [
          `New followers ${pct(m.change7.newFollowers)} — ${n(m.curr7.newFollowers)} this week vs ${n(m.prev7.newFollowers)} last`,
          'They are still going live, so the room is not being refilled from outside',
        ],
      };
    },
    ask: [
      'When did they last post short form? How many a week?',
      'Are they clipping their own LIVEs, or is it all live and nothing else?',
      'Do they post before going live to pull people in?',
    ],
    check: ['Their profile — date and frequency of the last few posts'],
  },
  {
    id: 'ALGORITHM_GAP',
    kind: KIND.LEVER,
    label: 'May not understand how coins drive reach',
    detect: (m) => {
      // A hypothesis about a newer creator with a quiet room, never a finding.
      if ((m.daysSinceJoining ?? 999) > 150) return null;
      if (!m.diamondsPerHour28 || m.diamondsPerHour28 > 800) return null;
      if (m.curr28.liveHours < 8) return null;
      return {
        confidence: 'possible',
        evidence: [
          `Putting the hours in (${m.curr28.liveHours.toFixed(0)}h in 28 days) at only ${n(m.diamondsPerHour28)} diamonds an hour`,
          `Day ${m.daysSinceJoining} — early enough that nobody may have explained the mechanics yet`,
        ],
      };
    },
    ask: [
      'Do they understand that gifting drives their ranking, and ranking drives reach?',
      'Have they had the coins-to-growth conversation, or did they just get handed a schedule?',
      'Do they know which of their streams did best, and why?',
    ],
    check: ['Whether anyone has actually walked them through the mechanics since they joined'],
  },
  {
    id: 'HOLIDAY',
    kind: KIND.CAUSE,
    label: 'Away — holiday or a planned break',
    detect: (m) => {
      // A clean stop after a reliable run looks nothing like a drift downwards.
      if (m.darkStreak < 3) return null;
      const wasReliable = (m.profile.validLiveDays?.baseline ?? 0) >= 3;
      if (!wasReliable) return null;
      return {
        confidence: 'possible',
        evidence: [
          `Stopped completely ${m.darkStreak} days ago after a steady ${(m.profile.validLiveDays.baseline).toFixed(1)} days a week`,
          'A clean stop after a reliable run is more often a break than a decline',
        ],
      };
    },
    ask: [
      'Are they away? Did they tell anyone they were going?',
      'When are they back — and do they have a plan for restarting rather than drifting?',
    ],
    check: ['Any message they sent before they stopped'],
    resolution: 'If they are away, snooze the case until they are back rather than closing it.',
  },
  {
    id: 'DRAMA',
    kind: KIND.CAUSE,
    label: 'Drama or fallout',
    detect: (m) => {
      // Mostly invisible in this export. It earns its place by being common,
      // not by being detectable, and saying so is the honest thing to do.
      const fansFalling = (m.fanClub.totalFansChange14 ?? 0) < 0;
      // Everything collapsing *while they keep streaming the same hours* is the
      // signature worth asking about. If the hours went too, the hours are the
      // story and drama is just a guess on top of a guess.
      const sharpAndBroad = down(m.change7.diamonds, 0.4)
        && down(m.change7.newFollowers, 0.3)
        && flat(m.change7.liveHours, 0.2)
        && m.curr7.liveHours >= 2;
      if (fansFalling) {
        return {
          confidence: 'possible',
          evidence: ['Total fans is actually falling, not just growing more slowly — people are leaving'],
        };
      }
      if (sharpAndBroad) {
        return {
          confidence: 'ask',
          evidence: ['Everything dropped at once, which is more often something that happened than something that drifted'],
        };
      }
      return null;
    },
    ask: [
      'Has anything happened in their community this week?',
      'Any fallout with another creator, a mod, or someone in the fan club?',
      'Are they alright? Sometimes the numbers are the last thing to show it.',
    ],
    check: ['Anything in the group chat around the day it turned'],
  },
];

/**
 * Rank the causes for one creator.
 *
 * Always returns something. When the data shows nothing specific, the fallback
 * is the set of questions worth asking anyway — which is still more use to a
 * coach than a number that went down.
 */
export function rankCauses(metrics, { limit = 3, leverLimit = 2 } = {}) {
  const found = [];
  for (const cause of CAUSES) {
    let hit = null;
    try {
      hit = cause.detect(metrics);
    } catch {
      hit = null; // a missing field must never take the whole digest down
    }
    if (!hit) continue;
    found.push({
      id: cause.id,
      kind: cause.kind,
      label: cause.label,
      confidence: hit.confidence,
      evidence: hit.evidence,
      ask: cause.ask,
      check: cause.check,
      resolution: cause.resolution ?? null,
    });
  }

  found.sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  const causes = found.filter((f) => f.kind === KIND.CAUSE).slice(0, limit);
  const levers = found.filter((f) => f.kind === KIND.LEVER).slice(0, leverLimit);
  if (causes.length || levers.length) return [...causes, ...levers];

  return [{
    id: 'UNKNOWN',
    kind: KIND.CAUSE,
    label: 'Nothing obvious in the numbers',
    confidence: 'ask',
    evidence: ['The usual signatures are not there, so this one needs a conversation'],
    ask: [
      'What has changed for them in the last couple of weeks?',
      'Are they still enjoying it? Burnout shows up here before it shows up anywhere else.',
      'Is anything else competing for their time — work, family, another platform?',
    ],
    check: ['Their last three streams, and when you last spoke'],
    resolution: null,
  }];
}

export const CONFIDENCE_LABEL = {
  likely: 'the data points at this',
  possible: 'consistent with the data',
  ask: 'worth ruling out',
};
