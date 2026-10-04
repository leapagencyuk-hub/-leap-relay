import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  starlightRow, starlightRows, starlightTeam, starlightTeams, starlightSummary,
  starlightDue, steadyHistory, bandOf, chaseOrder, MISSIONS, STAR_DAYS,
  interactionRead, conversionOdds, capableOdds, messageWorth, dailyChase, chaseReason,
  CAPABLE_BY_HITS, CAPABLE_ONE_MONTH, CAPABLE_UNKNOWN,
} from '../lib/starlight.mjs';
import { starlightEmbed, starlightOverviewEmbed } from '../lib/discord.mjs';
import {
  readRosterFile, saveRosterFile, readRoster, overlaps, rosterHealth,
  describeFile, isActivityHostRank, handle,
} from '../lib/starlightroster.mjs';

const config = {
  starlight: { enabled: true, from: '2026-10-01', to: '2026-11-02', starDays: 10, target: 70 },
  monitoring: { ignoreGroups: ['TEAM TRUCKERS'] },
  coaches: { names: { 'josh@leap': 'Sur3shot', 'bean@leap': 'Bean' }, excludeFromBoards: ['kins@leap'] },
};
const ASOF = '2026-10-10';

/**
 * A creator with one month-to-date reading per month.
 *
 * `months` is keyed by the last day of each month, which is what monthMtd reads
 * when it is asked for a whole month's total.
 */
const who = (username, { days = 0, hours = null, group = 'Team Alpha',
  manager = 'josh@leap', quitOn = null, months = {}, asOf = ASOF, diamonds = 0 } = {}) => {
  const obs = Object.entries(months).map(([date, d]) => ({
    date,
    mtd: { validLiveDays: d, liveHours: d * 3, diamonds: 0 },
  }));
  obs.push({ date: asOf, mtd: { validLiveDays: days, liveHours: hours ?? days * 3, diamonds } });
  obs.sort((a, b) => a.date.localeCompare(b.date));
  return { key: username, username, quitOn, group, manager, joinDate: '2026-01-01', obs };
};

const SEPT = '2026-09-30';
const AUG = '2026-08-31';
const JULY = '2026-07-31';

// --- steady presence is one number ------------------------------------------

test('a Star Creator is 10 valid LIVE days — the hour per day is already in the count', () => {
  // The whole module rests on this: TikTok's "Valid go LIVE days" already means
  // a day with an hour on it, verified across 9,828 stored readings, so the
  // "1+ hour per day" half of the criterion needs no second test.
  const r = starlightRow(who('a', { days: 10, hours: 10 }), ASOF, config);
  assert.equal(r.star, true);
  assert.equal(r.mission, 1);
  assert.equal(r.tickets, 1);
});

test('nine days is not a Star Creator however many hours are on them', () => {
  const r = starlightRow(who('a', { days: 9, hours: 90 }), ASOF, config);
  assert.equal(r.star, false);
  assert.equal(r.daysShort, 1);
});

test('the ladder climbs on days and the gap is to the next rung, not the last', () => {
  const r = starlightRow(who('a', { days: 16, hours: 48 }), ASOF, config);
  assert.equal(r.mission, 2);
  assert.equal(r.tickets, 2);
  assert.equal(r.next.n, 3);
  assert.equal(r.daysShort, 4);
});

test('all three missions done leaves no next rung and no gap', () => {
  const r = starlightRow(who('a', { days: 22, hours: 66 }), ASOF, config);
  assert.equal(r.mission, 3);
  assert.equal(r.tickets, 3);
  assert.equal(r.next, null);
  assert.equal(r.daysShort, 0);
  assert.equal(r.band, 'DONE');
});

test('a rung needs its hours as well as its days, even though in practice days bind', () => {
  // Mission 3 is the only rung where hours can bite: 20 days buys at least 20
  // hours, and the rung wants 25. No creator in three months of stored data has
  // ever been caught by it, but the mission values are config and Backstage may
  // hold different ones, so both halves are checked.
  const r = starlightRow(who('a', { days: 20, hours: 21 }), ASOF, config);
  assert.equal(r.mission, 2);
  assert.equal(r.hoursShort, 4);
});

// --- the days-left arithmetic -----------------------------------------------

test('days left counts from the day after the reading, because the export runs a day behind', () => {
  const r = starlightRow(who('a', { days: 2, asOf: '2026-10-02' }), '2026-10-02', config);
  assert.equal(r.daysLeft, 29);
  assert.equal(r.monthLength, 31);
});

test('needing more days than are left is out of reach and says so', () => {
  const r = starlightRow(who('a', { days: 1, asOf: '2026-10-28' }), '2026-10-28', config);
  assert.equal(r.daysShort, 9);
  assert.equal(r.daysLeft, 3);
  assert.equal(r.reachable, false);
  assert.equal(r.band, 'GONE');
});

test('the required rate is the share of remaining days they have to be LIVE on', () => {
  const r = starlightRow(who('a', { days: 5, asOf: '2026-10-21' }), '2026-10-21', config);
  assert.equal(r.daysShort, 5);
  assert.equal(r.daysLeft, 10);
  assert.equal(r.needRate, 0.5);
  assert.equal(r.band, 'TIGHT');
});

test('bands are ordered by what the coach does, not by how well the creator is doing', () => {
  assert.equal(bandOf({ next: null, reachable: true, needRate: 0, days: 30 }), 'DONE');
  assert.equal(bandOf({ next: { n: 1 }, reachable: false, needRate: 2, days: 3 }), 'GONE');
  assert.equal(bandOf({ next: { n: 1 }, reachable: true, needRate: 0.3, days: 0 }), 'NOT_STARTED');
  assert.equal(bandOf({ next: { n: 1 }, reachable: true, needRate: 0.3, days: 4 }), 'ON_TRACK');
  assert.equal(bandOf({ next: { n: 1 }, reachable: true, needRate: 0.6, days: 4 }), 'TIGHT');
  assert.equal(bandOf({ next: { n: 1 }, reachable: true, needRate: 0.9, days: 4 }), 'URGENT');
});

// --- history: "ones who went LIVE before, or have shown it" ------------------

test('history reads the three months before this one, not this one', () => {
  const h = steadyHistory(who('a', { days: 0, months: { [SEPT]: 18, [AUG]: 12, [JULY]: 3 } }), ASOF);
  assert.deepEqual(h.months.map((m) => [m.month, m.days, m.hit]),
    [['2026-09', 18, true], ['2026-08', 12, true], ['2026-07', 3, false]]);
  assert.equal(h.hits, 2);
  assert.equal(h.known, 3);
  assert.equal(h.steady, false);
  assert.equal(h.lastMonth.days, 18);
});

test('three for three is TikTok own steady-presence flag', () => {
  const h = steadyHistory(who('a', { months: { [SEPT]: 18, [AUG]: 12, [JULY]: 11 } }), ASOF);
  assert.equal(h.steady, true);
});

test('fewer than three months on file reads as unknown, not as a failure', () => {
  // A creator who joined in September is not a creator who failed July, and a
  // card that said otherwise would have a coach apologising for the calendar.
  const h = steadyHistory(who('a', { months: { [SEPT]: 18 } }), ASOF);
  assert.equal(h.known, 1);
  assert.equal(h.steady, null);
  assert.equal(h.hits, 1);
});

test('the push list is whoever has cleared the bar in any month we hold', () => {
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('proven', { days: 2, months: { [SEPT]: 18 } }), ASOF, config),
      starlightRow(who('onlyjuly', { days: 0, months: { [SEPT]: 2, [AUG]: 1, [JULY]: 14 } }), ASOF, config),
      starlightRow(who('never', { days: 3, months: { [SEPT]: 4 } }), ASOF, config),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(t.push.map((r) => r.username), ['proven', 'onlyjuly']);
  assert.deepEqual(t.trying.map((r) => r.username), ['never']);
});

test('nobody is in two piles: trying and not-started exclude the proven', () => {
  const rows = [
    starlightRow(who('proven_zero', { days: 0, months: { [SEPT]: 18 } }), ASOF, config),
    starlightRow(who('new_zero', { days: 0 }), ASOF, config),
  ];
  const t = starlightTeam({ team: 'Team Alpha', rows, asOf: ASOF, config });
  assert.deepEqual(t.push.map((r) => r.username), ['proven_zero']);
  assert.deepEqual(t.cold.map((r) => r.username), ['new_zero']);
  assert.deepEqual(t.trying, []);
});

// --- the chase order --------------------------------------------------------

test('the chase order buckets the gap, so one day in four weeks does not outrank a record', () => {
  // On the 2nd, 9 days out of 29 and 10 out of 29 are the same ask. Sorting on
  // the raw gap put a creator who managed 7 days last month above one who
  // managed 18, on a difference of one day in four weeks.
  const strong = starlightRow(who('strong', { days: 0, asOf: '2026-10-02', months: { [SEPT]: 18, [AUG]: 16, [JULY]: 15 } }), '2026-10-02', config);
  const weak = starlightRow(who('weak', { days: 1, asOf: '2026-10-02', months: { [SEPT]: 7, [AUG]: 2, [JULY]: 10 } }), '2026-10-02', config);
  assert.deepEqual([strong, weak].sort(chaseOrder).map((r) => r.username), ['strong', 'weak']);
});

test('a smaller gap still wins when it is a genuinely easier ask', () => {
  const close = starlightRow(who('close', { days: 9, asOf: '2026-10-25', months: { [SEPT]: 4 } }), '2026-10-25', config);
  const far = starlightRow(who('far', { days: 2, asOf: '2026-10-25', months: { [SEPT]: 20, [AUG]: 20, [JULY]: 20 } }), '2026-10-25', config);
  assert.deepEqual([far, close].sort(chaseOrder).map((r) => r.username), ['close', 'far']);
});

// --- the roster gate --------------------------------------------------------

const roster = {
  campaigns: {
    A: { campaign: 'A', asOf: '2026-10-04', count: 1, members: ['ina'] },
    B: { campaign: 'B', asOf: '2026-10-04', count: 2, members: ['inb', 'alsob'] },
  },
  creators: {
    ina: { username: 'ina', campaign: 'A', interactionDays: null, stage: 0, asOf: '2026-10-04' },
    inb: { username: 'inb', campaign: 'B', interactionDays: 0, stage: 0, asOf: '2026-10-04' },
    alsob: { username: 'alsob', campaign: 'B', interactionDays: 12, stage: 0, asOf: '2026-10-04' },
  },
};

test('with a roster loaded, only campaign creators are on the card', () => {
  const { rows, gated } = starlightRows({
    creators: [who('ina'), who('inb'), who('nobody')], asOf: ASOF, config, roster,
  });
  assert.equal(gated, true);
  assert.deepEqual(rows.map((r) => r.username).sort(), ['ina', 'inb']);
});

test('with no roster loaded it falls back to the whole monitored roster and says so', () => {
  const { rows, gated } = starlightRows({ creators: [who('a'), who('b')], asOf: ASOF, config });
  assert.equal(gated, false);
  assert.equal(rows.length, 2);
});

test('campaign creators with no export row are reported, not silently dropped', () => {
  const { missing } = starlightRows({ creators: [who('ina')], asOf: ASOF, config, roster });
  assert.deepEqual(missing.map((m) => m.username).sort(), ['alsob', 'inb']);
});

test('the board filters do not apply, because an ignored team still scores for LEAP', () => {
  // TikTok put them in LEAP campaign, so their LIVE days count toward LEAP
  // share of the prize whoever manages them. Dropping them would quietly cost
  // the agency points, so they are carried and labelled instead.
  const bigRoster = {
    campaigns: { A: { campaign: 'A', asOf: '2026-10-04', count: 2, members: ['truck', 'kinsy'] } },
    creators: {
      truck: { username: 'truck', campaign: 'A', interactionDays: null, asOf: '2026-10-04' },
      kinsy: { username: 'kinsy', campaign: 'A', interactionDays: null, asOf: '2026-10-04' },
    },
  };
  const { rows } = starlightRows({
    creators: [
      who('truck', { group: 'TEAM TRUCKERS', manager: 'senninha@leap' }),
      who('kinsy', { manager: 'kins@leap' }),
    ],
    asOf: ASOF, config, roster: bigRoster,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.username, r.outsideBoards, r.outsideReason]), [
    ['truck', true, 'team is not monitored'],
    ['kinsy', true, 'manager is off the boards'],
  ]);
});

test('a creator who has left the network is off the card whatever the roster says', () => {
  const { rows } = starlightRows({
    creators: [who('ina', { quitOn: '2026-10-03' })], asOf: ASOF, config, roster,
  });
  assert.deepEqual(rows, []);
});

// --- interaction days -------------------------------------------------------

test('campaign B rungs want interaction days and campaign A rungs do not', () => {
  const a = starlightRow(who('ina', { days: 12 }), ASOF, config, roster.creators.ina);
  const b = starlightRow(who('inb', { days: 12 }), ASOF, config, roster.creators.inb);
  assert.equal(a.mission, 1, 'campaign A clears on days alone');
  assert.equal(b.mission, 0, 'campaign B has not scored its 10 interaction days');
  assert.equal(b.interactionShort, 10);
});

test('an unknown interaction count never reads as a failure', () => {
  // Null is not zero. A creator we hold no reading for must not be shown as
  // short of a rung we cannot measure.
  const entry = { username: 'x', campaign: 'B', interactionDays: null, asOf: '2026-10-04' };
  const r = starlightRow(who('x', { days: 12 }), ASOF, config, entry);
  assert.equal(r.mission, 1);
  assert.equal(r.interactionUnknown, true);
  assert.equal(r.interactionShort, null);
});

test('hours going in with zero interaction days is its own list', () => {
  const rows = [
    starlightRow(who('inb', { days: 4 }), ASOF, config, roster.creators.inb),
    starlightRow(who('alsob', { days: 4 }), ASOF, config, roster.creators.alsob),
  ];
  const t = starlightTeam({ team: 'Team Alpha', rows, asOf: ASOF, config });
  assert.deepEqual(t.talk.map((r) => r.username), ['inb']);
});

test('zero days and zero interaction is not the talk-to-chat list', () => {
  // That creator has not gone LIVE at all, so "talk to your chat more" is not
  // the conversation — going LIVE is.
  const r = starlightRow(who('inb', { days: 0 }), ASOF, config, roster.creators.inb);
  assert.equal(r.interactionBlocked, false);
});

// --- the team card ----------------------------------------------------------

test('the card is headed by the coach who holds most of the team', () => {
  // The campaign lists cut across LEAP's teams, so taking rows[0] would have
  // put the wrong name on the card whenever the sort landed on the odd one out.
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('odd', { manager: 'bean@leap' }), ASOF, config),
      starlightRow(who('one', { manager: 'josh@leap' }), ASOF, config),
      starlightRow(who('two', { manager: 'josh@leap' }), ASOF, config),
    ],
    asOf: ASOF, config,
  });
  assert.equal(t.coachName, 'Sur3shot');
  assert.equal(t.others, 1);
});

test('Star Creator days are the tournament currency, so the team total counts every day past the bar', () => {
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('a', { days: 18 }), ASOF, config),
      starlightRow(who('b', { days: 11 }), ASOF, config),
      starlightRow(who('c', { days: 9 }), ASOF, config),
    ],
    asOf: ASOF, config,
  });
  assert.equal(t.stars, 2);
  assert.equal(t.starDays, 29, 'both Star Creators whole day counts, not the excess over 10');
});

test('teams come out biggest first, each with its own creators', () => {
  const { teams } = starlightTeams({
    creators: [
      who('a1', { group: 'Team Alpha' }), who('a2', { group: 'Team Alpha' }),
      who('b1', { group: 'Team Bravo' }),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(teams.map((t) => [t.team, t.total]), [['Team Alpha', 2], ['Team Bravo', 1]]);
});

// --- the card itself --------------------------------------------------------

const bigTeam = () => starlightTeam({
  team: 'Team Alpha',
  rows: Array.from({ length: 60 }, (_, i) => starlightRow(
    who(`creator_with_a_fairly_long_handle_${i}`, { days: i % 4, months: { [SEPT]: 12 + (i % 9) } }),
    ASOF, config,
  )),
  asOf: ASOF, config: { ...config, starlight: { ...config.starlight, perBand: 100 } },
});

test('the card explains the campaign and the creators prize', () => {
  const [page] = starlightEmbed(bigTeam(), { config });
  const d = page.embeds[0].description;
  assert.match(d, /Star Light Agency Tournament/);
  assert.match(d, /Diamond Track/);
  assert.match(d, /10 days in the month/);
  assert.match(d, /Uni Wheel/);
  assert.match(d, /TikTok Universe/);
  // The ladder has to be on the FIRST page: a long push list pages, and a
  // ladder in a field would land on the page a coach reads last.
  assert.match(d, /Mission 1 — LIVE on 10 days, 10 hours total — 1 ticket/);
  assert.match(d, /Mission 3 — LIVE on 20 days, 25 hours total — 3 tickets/);
});

test('the card is coach-facing, so it carries no emoji', () => {
  // The same rule as every other card a coach gets. The creator-facing boards
  // are the exception, and this is not one of them: it names teams, coaches and
  // who is behind.
  const pages = starlightEmbed(bigTeam(), { config });
  const text = JSON.stringify(pages);
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), 'found an emoji on a coach card');
});

test('a long work-through list pages rather than ending in "and 40 more"', () => {
  const t = bigTeam();
  const shown = starlightEmbed(t, { config }).flatMap((p) => p.embeds[0].fields)
    .filter((f) => /THE REST TO WORK THROUGH/.test(f.name))
    .flatMap((f) => f.value.split('\n'));
  assert.ok(!shown.some((l) => /and \d+ more/.test(l)), 'the list was trimmed instead of paged');
  assert.equal(shown.filter((l) => l.startsWith('@')).length, t.rest.length);
  assert.ok(t.rest.length > 20, 'and there were enough rows for this to mean something');
});

test("today's names are not repeated in the list underneath", () => {
  // "The rest" has to mean the rest. Listing the same six again below their own
  // reasons made the card read as though they had to be worked twice.
  const t = bigTeam();
  const picked = new Set(t.today.pick.map((c) => c.row.username));
  assert.ok(picked.size > 0);
  assert.equal(t.rest.filter((r) => picked.has(r.username)).length, 0);
});

test('every page stays inside Discord limits', () => {
  for (const page of starlightEmbed(bigTeam(), { config })) {
    const e = page.embeds[0];
    assert.ok(JSON.stringify(e).length < 6000, 'embed over 6000 characters');
    assert.ok(e.fields.length <= 25, 'more than 25 fields');
    for (const f of e.fields) assert.ok(f.value.length <= 1024, `field "${f.name}" over 1024`);
  }
});

test('pages have distinct titles, or the duplicate sweep would eat page one', () => {
  const titles = starlightEmbed(bigTeam(), { config }).map((p) => p.embeds[0].title);
  assert.equal(new Set(titles).size, titles.length);
});

test('a team with creators in both campaigns gets both ladders', () => {
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('ina', { days: 3 }), ASOF, config, roster.creators.ina),
      starlightRow(who('inb', { days: 3 }), ASOF, config, roster.creators.inb),
    ],
    asOf: ASOF, config,
  });
  const d = starlightEmbed(t, { config })[0].embeds[0].description;
  assert.match(d, /Campaign A/);
  assert.match(d, /Campaign B/);
  assert.match(d, /10 interaction days/);
});

test('a push line names the month that earned the creator their place', () => {
  // A row reading "needs 10 more days (2 last month)" under a heading that says
  // "have done 10 days before" looks like a bug until the month is named.
  // Enough other rows that `rusty` is not one of the day's six and so lands in
  // the work-through list, which is the line this is about.
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('rusty', { days: 0, months: { [SEPT]: 2, [AUG]: 16 } }), ASOF, config),
      ...Array.from({ length: 8 }, (_, i) => starlightRow(
        who(`stronger_${i}`, { days: 0, months: { [SEPT]: 20, [AUG]: 20, [JULY]: 20 } }), ASOF, config,
      )),
    ],
    asOf: ASOF, config,
  });
  const value = starlightEmbed(t, { config })[0].embeds[0].fields
    .find((f) => /THE REST TO WORK THROUGH/.test(f.name)).value;
  assert.match(value, /@rusty — on 0, needs 10 more days \(2 last month, 16 in August\)/);
});

test('a creator somebody else manages is named as theirs on the card', () => {
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('mine', { days: 1, months: { [SEPT]: 12 } }), ASOF, config),
      starlightRow(who('theirs', { days: 1, manager: 'bean@leap', months: { [SEPT]: 12 } }), ASOF, config),
      starlightRow(who('also_mine', { days: 1, months: { [SEPT]: 12 } }), ASOF, config),
    ],
    asOf: ASOF, config,
  });
  const value = starlightEmbed(t, { config })[0].embeds[0].fields[0].value;
  assert.match(value, /@theirs \[Bean\]/);
  assert.ok(!/@mine \[/.test(value), 'the card coach own creators are not labelled');
});

test('the scoreboard separates creators we cannot track from creators nobody coaches', () => {
  const s = starlightSummary({
    creators: [
      who('truck', { group: 'TEAM TRUCKERS', manager: 'senninha@leap' }),
      who('ina', { days: 11 }),
    ],
    asOf: ASOF,
    config,
    roster: {
      campaigns: { A: { campaign: 'A', asOf: '2026-10-04', count: 3, members: ['truck', 'ina', 'ghost'] } },
      creators: {
        truck: { username: 'truck', campaign: 'A', interactionDays: null, asOf: '2026-10-04' },
        ina: { username: 'ina', campaign: 'A', interactionDays: null, asOf: '2026-10-04' },
        ghost: { username: 'ghost', campaign: 'A', interactionDays: null, asOf: '2026-10-04' },
      },
    },
  });
  assert.deepEqual(s.missing.map((m) => m.username), ['ghost']);
  assert.deepEqual(s.outside.map((r) => r.username), ['truck']);
  const card = starlightOverviewEmbed(s, { config });
  const names = card.embeds[0].fields.map((f) => f.name).join(' | ');
  assert.match(names, /Scoring for LEAP, no LEAP coach/);
  assert.match(names, /In the campaign, not in our data/);
});

test('the scoreboard shows the target and the projection', () => {
  const s = starlightSummary({ creators: [who('a', { days: 11 }), who('b', { days: 2 })], asOf: ASOF, config });
  const card = starlightOverviewEmbed(s, { config });
  assert.match(card.embeds[0].fields[0].value, /of a 70 target/);
});

// --- when it posts ----------------------------------------------------------

test('the card posts once a day, and not twice', () => {
  const store = { data: {} };
  assert.equal(starlightDue(config, store, '2026-10-10'), true);
  store.data.lastStarlightOn = '2026-10-10';
  assert.equal(starlightDue(config, store, '2026-10-10'), false);
  assert.equal(starlightDue(config, store, '2026-10-11'), true);
});

test('it does not post outside the campaign window', () => {
  // A card about a finished tournament is noise in a coach channel, and one
  // before it starts is a card about nothing.
  const store = { data: {} };
  assert.equal(starlightDue(config, store, '2026-09-30'), false);
  assert.equal(starlightDue(config, store, '2026-11-03'), false);
  assert.equal(starlightDue(config, store, '2026-10-01'), true);
});

test('disabling it in config stops it', () => {
  const off = { ...config, starlight: { ...config.starlight, enabled: false } };
  assert.equal(starlightDue(off, { data: {} }, '2026-10-10'), false);
});

// --- reading the Backstage campaign sheets ----------------------------------

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starlight-'));

test('the campaign and the sheet date come out of the filename', () => {
  assert.deepEqual(
    describeFile('Activity_Host_Rank_-_7690978446935097352_2026_10_04_20_41_UTC0.xlsx'),
    { id: '7690978446935097352', asOf: '2026-10-04' },
  );
  assert.deepEqual(describeFile('renamed.xlsx'), { id: null, asOf: null });
});

test('a sheet is recognised by the column only it has', () => {
  assert.equal(isActivityHostRank(['UserName', 'Go-LIVE days during Event']), true);
  assert.equal(isActivityHostRank(["Creator's username", 'Diamonds']), false);
});

test('handles are compared without the @ and without case', () => {
  assert.equal(handle('@Sezzy.Plays'), 'sezzy.plays');
  assert.equal(handle(' KC.Is.Live '), 'kc.is.live');
});

test('the campaign is told by the columns, because the sheets carry no campaign name', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'Activity_Host_Rank_-_111_2026_10_04_09_00_UTC0.xlsx');
  const b = path.join(dir, 'Activity_Host_Rank_-_222_2026_10_04_09_00_UTC0.xlsx');
  writeSheet(a, ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event'],
    [['alpha', '0', '3h14min', '1']]);
  writeSheet(b, ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event', 'Active interaction days'],
    [['beta', '0', '15h21min', '3', '4']]);
  assert.equal(readRosterFile(a).campaign, 'A');
  assert.equal(readRosterFile(b).campaign, 'B');
  assert.equal(readRosterFile(a).creators[0].interactionDays, null, 'A does not score interaction, so it is unknown not zero');
  assert.equal(readRosterFile(b).creators[0].interactionDays, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('re-uploading a campaign replaces it, so a dropped creator stops being chased', () => {
  const dir = tmpdir();
  const one = path.join(dir, 'Activity_Host_Rank_-_111_2026_10_04_09_00_UTC0.xlsx');
  const two = path.join(dir, 'Activity_Host_Rank_-_111_2026_10_11_09_00_UTC0.xlsx');
  const head = ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event'];
  writeSheet(one, head, [['stays', '0', '1h0min', '1'], ['dropped', '0', '0', '0']]);
  writeSheet(two, head, [['stays', '1', '12h0min', '11']]);
  saveRosterFile(dir, one);
  assert.equal(Object.keys(readRoster(dir).creators).length, 2);
  const out = saveRosterFile(dir, two);
  assert.deepEqual(Object.keys(readRoster(dir).creators), ['stays']);
  assert.equal(out.asOf, '2026-10-11');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a creator in two campaigns is reported, because they can only take tickets from one', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'Activity_Host_Rank_-_111_2026_10_04_09_00_UTC0.xlsx');
  const b = path.join(dir, 'Activity_Host_Rank_-_222_2026_10_04_09_00_UTC0.xlsx');
  writeSheet(a, ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event'],
    [['gina', '0', '2h4min', '1'], ['onlya', '0', '0', '0']]);
  writeSheet(b, ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event', 'Active interaction days'],
    [['gina', '0', '2h4min', '1', '4']]);
  saveRosterFile(dir, a);
  const out = saveRosterFile(dir, b);
  assert.deepEqual(out.inBoth, [{ username: 'gina', campaigns: ['A', 'B'] }]);
  assert.deepEqual(out.movedCampaign, [{ username: 'gina', from: 'A', to: 'B' }]);
  assert.deepEqual(overlaps(readRoster(dir)), [{ username: 'gina', campaigns: ['A', 'B'] }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('roster health says how stale the hand-uploaded sheet has gone', () => {
  const h = rosterHealth({
    campaigns: { A: { campaign: 'A', asOf: '2026-10-04', count: 64 } },
    creators: { x: {} },
  }, '2026-10-11');
  assert.equal(h.loaded, true);
  assert.equal(h.staleDays, 7);
  assert.equal(rosterHealth({}, '2026-10-11').loaded, false);
});

test('a file that is not an Activity Host Rank sheet is refused by name', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Activity_Host_Rank_-_111_2026_10_04_09_00_UTC0.xlsx');
  writeSheet(f, ["Creator's username", 'Diamonds'], [['someone', '100']]);
  assert.throws(() => readRosterFile(f), /Go-LIVE days during Event/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the default mission ladders are the ones in the brief', () => {
  assert.deepEqual(MISSIONS.A.map((m) => [m.days, m.hours, m.tickets]),
    [[10, 10, 1], [15, 15, 2], [20, 25, 3]]);
  assert.deepEqual(MISSIONS.B.map((m) => m.interactionDays), [10, 15, 20]);
  assert.equal(STAR_DAYS, 10, 'mission 1 is TikTok own Star Creator minimum, which is the point of it');
});

/** A minimal .xlsx, so the sheet reader is exercised rather than mocked. */
function writeSheet(file, headers, rows) {
  const cell = (v) => `<c t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
  const row = (cells, i) => `<row r="${i + 1}">${cells.map(cell).join('')}</row>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + [headers, ...rows].map(row).join('') + `</sheetData></worksheet>`;
  const parts = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  fs.writeFileSync(file, zip(parts));
}

/** A stored (uncompressed) zip, which is all the sheet reader needs. */
function zip(parts) {
  const crcTable = (() => {
    const t = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('a sheet whose filename carries no date says it assumed the upload date', () => {
  // The card prints this date as the age of its interaction numbers, so a
  // fallback that looked like a real reading would have the card claim a
  // week-old sheet was current.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starlight-'));
  // A real campaign id, because the reader wants six digits or more: four
  // would match the year in the date that follows it.
  const named = path.join(dir, 'Activity_Host_Rank_-_7690978446935097352_2026_10_04_09_00_UTC0.xlsx');
  const bare = path.join(dir, 'renamed.xlsx');
  const head = ['UserName', 'Completed stage', 'LIVE duration', 'Go-LIVE days during Event'];
  writeSheet(named, head, [['a', '0', '1h0min', '1']]);
  writeSheet(bare, head, [['a', '0', '1h0min', '1']]);

  const fromName = saveRosterFile(dir, named);
  assert.equal(fromName.asOf, '2026-10-04');
  assert.equal(fromName.asOfFrom, 'filename');
  assert.equal(fromName.campaignId, '7690978446935097352');

  const fallback = saveRosterFile(dir, bare);
  assert.equal(fallback.asOfFrom, 'upload date');
  assert.equal(fallback.asOf, new Date().toISOString().slice(0, 10));
  assert.equal(fallback.campaignId, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the campaign id reader does not mistake the date for an id', () => {
  // "Rank_-_7690978446935097352_2026_10_04" — a looser pattern would have
  // taken 2026 as the campaign, which would then differ between two uploads
  // of the same campaign in different months.
  assert.equal(describeFile('Activity_Host_Rank_-_2026_10_04_09_00_UTC0.xlsx').id, null);
  assert.equal(describeFile('Activity_Host_Rank_-_7690978446935097352_2026_10_04_09_00_UTC0.xlsx').id,
    '7690978446935097352');
});

// --- the interaction read ---------------------------------------------------

test('gifts read as interaction and hours do not', () => {
  // The two cases that made the point, from the labelled Campaign B sheet.
  // mackopete streamed 19.2 hours over 3 days for 52 diamonds and TikTok
  // scored him zero; the_cleaner87 streamed 3.1 hours on one day for 2,609
  // diamonds and scored the full four. Any read built on time would have had
  // these the wrong way round.
  const grind = starlightRow(who('mackopete', { days: 3, hours: 19.2, diamonds: 52 }), ASOF, config);
  const gifted = starlightRow(who('the_cleaner87', { days: 1, hours: 3.1, diamonds: 2609 }), ASOF, config);
  assert.equal(interactionRead(grind, config).band, 'THIN');
  assert.equal(interactionRead(gifted, config).band, 'GOOD');
});

test('the cut is 20 diamonds per LIVE hour, measured', () => {
  const at = (dia, hours) => interactionRead(
    starlightRow(who('x', { days: 3, hours, diamonds: dia }), ASOF, config), config,
  );
  assert.equal(at(60, 3).band, 'GOOD', '20/hr exactly is in');
  assert.equal(at(57, 3).band, 'THIN', 'just under is out');
  assert.equal(at(60, 3).perHour, 20);
});

test('a creator who has not been LIVE reads UNKNOWN, never bad', () => {
  // Their problem is going LIVE, which every other list on the card is about.
  // Putting them on a "talk to your chat" list would be advice about a stream
  // they have not done.
  const r = interactionRead(starlightRow(who('x', { days: 0, hours: 0 }), ASOF, config), config);
  assert.equal(r.band, 'UNKNOWN');
  assert.equal(r.perHour, null);
});

test("Backstage's own reading beats the proxy where we hold one", () => {
  const entry = { username: 'inb', campaign: 'B', interactionDays: 9, asOf: '2026-10-04' };
  const r = interactionRead(starlightRow(who('inb', { days: 3, hours: 9, diamonds: 0 }), ASOF, config, entry), config);
  assert.equal(r.source, 'Backstage');
  assert.equal(r.days, 9);
  assert.equal(r.perHour, null, 'the proxy is not reported beside a real measurement');
});

test('Backstage interaction days are judged on pace, not against the month-end target', () => {
  // Four interaction days on the 4th against a target of ten is somebody doing
  // it every single day. Reading that as "six short" put creators who had
  // scored on every day of the campaign onto the list to chase about it.
  const entry = { username: 'inb', campaign: 'B', interactionDays: 4, asOf: '2026-10-04' };
  const early = starlightRow(who('inb', { days: 4, hours: 12, diamonds: 100, asOf: '2026-10-04' }), '2026-10-04', config, entry);
  assert.equal(interactionRead(early, config).band, 'GOOD');

  // The same four days with three days left is genuinely behind.
  const late = starlightRow(who('inb', { days: 4, hours: 12, diamonds: 100, asOf: '2026-10-28' }), '2026-10-28', config, entry);
  assert.equal(interactionRead(late, config).band, 'THIN');
});

test('the talk-to-chat list is only creators who have been LIVE', () => {
  const entry = (d) => ({ username: 'x', campaign: 'B', interactionDays: d, asOf: '2026-10-04' });
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('grinding', { days: 3, hours: 19, diamonds: 50 }), ASOF, config, entry(0)),
      starlightRow(who('absent', { days: 0, hours: 0 }), ASOF, config, entry(1)),
    ],
    asOf: ASOF, config,
  });
  assert.deepEqual(t.talk.map((r) => r.username), ['grinding']);
});

// --- the conversion model ---------------------------------------------------

test('the conversion table is read off the required rate', () => {
  // Measured over 8,337 September creator-days. The cliff is between a third
  // and a half of the remaining days.
  const at = (days, asOf) => conversionOdds(starlightRow(who('x', { days, asOf, months: { [SEPT]: 20, [AUG]: 20 } }), asOf, config));
  assert.ok(at(8, '2026-10-20') > 0.8, 'needing 2 of 11 is comfortable');
  assert.ok(at(4, '2026-10-20') < 0.5, 'needing 6 of 11 is not');
  assert.equal(at(0, '2026-10-29'), 0, 'needing 10 of 2 is arithmetically impossible');
});

test('an already-qualified creator is certain and worth no message', () => {
  const r = starlightRow(who('x', { days: 12, months: { [SEPT]: 20 } }), ASOF, config);
  assert.equal(conversionOdds(r), 1);
  assert.equal(messageWorth(r), 0);
});

test('capability comes from the record and never from where they are now', () => {
  const both = starlightRow(who('x', { days: 0, months: { [SEPT]: 20, [AUG]: 20, [JULY]: 1 } }), ASOF, config);
  const one = starlightRow(who('x', { days: 0, months: { [SEPT]: 20, [AUG]: 1, [JULY]: 1 } }), ASOF, config);
  const none = starlightRow(who('x', { days: 0, months: { [SEPT]: 1, [AUG]: 1, [JULY]: 1 } }), ASOF, config);
  assert.equal(capableOdds(both), CAPABLE_BY_HITS[2]);
  assert.equal(capableOdds(one), CAPABLE_BY_HITS[1]);
  assert.equal(capableOdds(none), CAPABLE_BY_HITS[0]);
});

test('a creator with no history on file is not treated as a strong prospect', () => {
  // The first version of this guessed 0.82 for the no-history case — the
  // conversion rate of people facing an EASY remaining ask, which is not a
  // capability at all — and it ranked creators nobody has ever seen go LIVE
  // above creators with a twenty-day month behind them.
  const unknown = starlightRow(who('new', { days: 0, months: {} }), ASOF, config);
  const proven = starlightRow(who('proven', { days: 0, months: { [SEPT]: 20, [AUG]: 20, [JULY]: 20 } }), ASOF, config);
  assert.equal(capableOdds(unknown), CAPABLE_UNKNOWN);
  assert.ok(messageWorth(unknown) < messageWorth(proven),
    'a creator with no record must not outrank a proven one');
});

test('one month on file is read less confidently than two', () => {
  const hit = starlightRow(who('x', { days: 0, months: { [SEPT]: 20 } }), ASOF, config);
  const miss = starlightRow(who('x', { days: 0, months: { [SEPT]: 2 } }), ASOF, config);
  assert.equal(capableOdds(hit), CAPABLE_ONE_MONTH.hit);
  assert.equal(capableOdds(miss), CAPABLE_ONE_MONTH.miss);
  assert.ok(CAPABLE_ONE_MONTH.hit < CAPABLE_BY_HITS[2]);
});

test('a message is worth most to the stalled-but-proven, and nothing to the on-course', () => {
  // The whole point of the ranking. Both of these are real shapes off the
  // October roster.
  const stalled = starlightRow(who('nugs988', { days: 0, asOf: '2026-10-03', months: { [SEPT]: 18, [AUG]: 16, [JULY]: 15 } }), '2026-10-03', config);
  const flying = starlightRow(who('leachiii', { days: 3, asOf: '2026-10-03', months: { [SEPT]: 10, [AUG]: 12, [JULY]: 14 } }), '2026-10-03', config);
  const hopeless = starlightRow(who('never', { days: 0, asOf: '2026-10-03', months: { [SEPT]: 1, [AUG]: 0, [JULY]: 2 } }), '2026-10-03', config);
  assert.ok(messageWorth(stalled) > 0.3, `stalled-but-proven should be top, got ${messageWorth(stalled)}`);
  assert.ok(messageWorth(flying) < 0.05, 'somebody on course needs no message');
  assert.ok(messageWorth(hopeless) < 0.1, 'chasing will not fix what has never been done');
  assert.ok(messageWorth(stalled) > messageWorth(hopeless));
});

test('on-course creators are named so a coach does not spend a message there', () => {
  const t = starlightTeam({
    team: 'Team Alpha',
    rows: [
      starlightRow(who('flying', { days: 3, asOf: '2026-10-03', months: { [SEPT]: 12, [AUG]: 12, [JULY]: 12 } }), '2026-10-03', config),
      starlightRow(who('stalled', { days: 0, asOf: '2026-10-03', months: { [SEPT]: 18, [AUG]: 16, [JULY]: 15 } }), '2026-10-03', config),
    ],
    asOf: '2026-10-03', config,
  });
  assert.deepEqual(t.onCourse.map((r) => r.username), ['flying']);
  assert.deepEqual(t.today.pick.map((c) => c.row.username), ['stalled'],
    'and they are kept off the day list entirely');
});

// --- the daily rotation -----------------------------------------------------

const rotationRows = (asOf = '2026-10-03') => Array.from({ length: 20 }, (_, i) => starlightRow(
  who(`c${i}`, { days: 0, asOf, months: { [SEPT]: 18, [AUG]: 16, [JULY]: 15 } }), asOf, config,
));

test('the list is capped, so a coach gets a handful rather than the roster', () => {
  const out = dailyChase({ rows: rotationRows(), store: { data: {} }, asOf: '2026-10-03', config });
  assert.equal(out.pick.length, 6);
  assert.equal(out.queued, 14);
});

test('the same names do not come back the next day', () => {
  const store = { data: {} };
  const first = dailyChase({ rows: rotationRows('2026-10-03'), store, asOf: '2026-10-03', config });
  const second = dailyChase({ rows: rotationRows('2026-10-04'), store, asOf: '2026-10-04', config });
  const a = new Set(first.pick.map((c) => c.row.username));
  const b = second.pick.map((c) => c.row.username);
  assert.equal(b.filter((u) => a.has(u)).length, 0, 'day two repeated day one');
  // Twelve, not six: `covered` counts today's list as reached, which is what
  // the card is reporting once it has posted.
  assert.equal(second.covered, 12, 'and it counts everyone surfaced so far, today included');
  assert.equal(first.covered, 6);
});

test('after the cooldown they can come back round', () => {
  const store = { data: {} };
  dailyChase({ rows: rotationRows('2026-10-03'), store, asOf: '2026-10-03', config });
  // Four days later, with everyone else also spent, the first six are eligible
  // again rather than the list running dry.
  for (const d of ['2026-10-04', '2026-10-05', '2026-10-06']) {
    dailyChase({ rows: rotationRows(d), store, asOf: d, config });
  }
  const back = dailyChase({ rows: rotationRows('2026-10-07'), store, asOf: '2026-10-07', config });
  assert.ok(back.pick.length > 0, 'the rotation came back round');
});

test('a last chance overrides the cooldown', () => {
  // Tomorrow there is no list to be on, so the cooldown cannot hold them.
  const store = { data: { starlightSurfaced: { '2026-10': { urgent: '2026-10-27' } } } };
  const rows = [starlightRow(who('urgent', { days: 2, asOf: '2026-10-23', months: { [SEPT]: 20, [AUG]: 20 } }), '2026-10-23', config)];
  const out = dailyChase({ rows, store, asOf: '2026-10-28', config, persist: false });
  assert.deepEqual(out.pick.map((c) => c.row.username), ['urgent']);
  assert.equal(out.pick[0].lastChance, true);
});

test('a dry run reports the same coverage as the real run', () => {
  // Reading the surfacing record through a live reference made this number
  // depend on whether persist had run, so the preview and the post disagreed.
  const dry = dailyChase({ rows: rotationRows(), store: { data: {} }, asOf: '2026-10-03', config, persist: false });
  const wet = dailyChase({ rows: rotationRows(), store: { data: {} }, asOf: '2026-10-03', config, persist: true });
  assert.equal(dry.covered, wet.covered);
});

test('a dry run does not spend the rotation', () => {
  // Previewing the card would otherwise put six creators on cooldown, and the
  // real run would then hand the coach a different six.
  const store = { data: {} };
  dailyChase({ rows: rotationRows(), store, asOf: '2026-10-03', config, persist: false });
  assert.deepEqual(store.data.starlightSurfaced, undefined);
  const real = dailyChase({ rows: rotationRows(), store, asOf: '2026-10-03', config });
  assert.equal(real.pick.length, 6);
  assert.equal(Object.keys(store.data.starlightSurfaced['2026-10']).length, 6);
});

test('creators already past the bar, or out of days, are never on the list', () => {
  const rows = [
    starlightRow(who('done', { days: 14, months: { [SEPT]: 20 } }), ASOF, config),
    starlightRow(who('gone', { days: 0, asOf: '2026-10-29', months: { [SEPT]: 20, [AUG]: 20 } }), '2026-10-29', config),
  ];
  const out = dailyChase({ rows, store: { data: {} }, asOf: '2026-10-29', config, persist: false });
  assert.deepEqual(out.pick, []);
});

test('the reason on each line is a sentence, not the model', () => {
  const out = dailyChase({ rows: rotationRows(), store: { data: {} }, asOf: '2026-10-03', config, persist: false });
  const reason = chaseReason(out.pick[0]);
  assert.match(reason, /did 18 days last month, nothing yet this month/);
  assert.ok(!/0\.\d|odds|%/.test(reason), 'a coach does not need the conversion odds');
});

test('the card leads with the day list and says the names rotate', () => {
  const t = starlightTeam({ team: 'Team Alpha', rows: rotationRows(), asOf: '2026-10-03', config, store: { data: {} }, persist: true });
  const first = starlightEmbed(t, { config })[0].embeds[0].fields[0];
  assert.match(first.name, /MESSAGE THESE TODAY/);
  assert.match(first.value, /Different names tomorrow/);
  assert.match(first.value, /14 more in the queue/);
  assert.match(first.value, /of 20 reached this month/);
});

test('the prize fund is nowhere on any card', () => {
  // Directors' knowledge. The channel this posts to is read by coaches.
  const t = starlightTeam({ team: 'Team Alpha', rows: rotationRows(), asOf: '2026-10-03', config, store: { data: {} } });
  const s = starlightSummary({ creators: [who('a', { days: 3 })], asOf: '2026-10-03', config });
  const text = JSON.stringify([...starlightEmbed(t, { config }), starlightOverviewEmbed(s, { config })]);
  assert.ok(!/26[,.]?500/.test(text), 'the prize fund appeared on a card');
  assert.ok(!/\$/.test(text), 'a cash figure appeared on a card');
});
