import test from 'node:test';
import assert from 'node:assert/strict';
import {
  creatorWeekBoard, creatorWeekDue, weekStartOf, isWeekEnd, rankPoints, PILLARS,
} from '../lib/creatorweek.mjs';
import { creatorWeekEmbed } from '../lib/discord.mjs';

const config = {
  creatorWeek: { show: 10 },
  monitoring: { ignoreGroups: ['Surge Agency'] },
  coaches: { names: { 'josh@leap': 'Sur3shot' } },
};
// 2026-09-14 is a Monday, 2026-09-20 the Sunday that closes that week.
const MON = '2026-09-14';
const SUN = '2026-09-20';

/**
 * One creator with a reading on each named day.
 *
 * `days` maps a date to what they gained THAT DAY, which is what the series
 * stores: month-to-date arrives in the export and is converted to deltas on
 * ingest, so a board test works in the same units the board reads.
 */
const who = (username, days, { group = 'Team Alpha', quitOn = null } = {}) => ({
  key: username, username, quitOn, group, manager: 'josh@leap', joinDate: '2026-01-01',
  obs: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([date, g]) => ({
    date, periodStart: `${date.slice(0, 7)}-01`, span: 1, partial: false,
    delta: {
      diamonds: g.diamonds ?? 0, liveHours: g.hours ?? 0,
      newFollowers: g.followers ?? 0, newFans: g.fans ?? 0,
      validLiveDays: 0, liveStreams: 0, fanClubDiamonds: 0,
      matches: 0, diamondsFromMatches: 0, diamondsFromMultiGuest: 0,
    },
    mtd: {},
  })),
});

/** The same gains every day of a stretch, which is all most cases need. */
const every = (from, to, g) => {
  const out = {};
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out[d.toISOString().slice(0, 10)] = g;
  }
  return out;
};

test('weeks run Monday to Sunday, and Sunday is the day it is decided', () => {
  assert.equal(weekStartOf('2026-09-14'), '2026-09-14', 'Monday is its own week start');
  assert.equal(weekStartOf('2026-09-17'), '2026-09-14', 'Thursday looks back to Monday');
  assert.equal(weekStartOf('2026-09-20'), '2026-09-14', 'Sunday belongs to the week it ends');
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21', 'and Monday starts the next one');
  assert.equal(isWeekEnd('2026-09-20'), true);
  for (const d of ['2026-09-14', '2026-09-18', '2026-09-19', '2026-09-21']) {
    assert.equal(isWeekEnd(d), false, d);
  }
});

test('a week that straddles a month is still one week', () => {
  // The export resets on the 1st, so this is the case most likely to be wrong.
  // 2026-09-28 is a Monday; that week ends on 4 October.
  const b = creatorWeekBoard({
    creators: [who('crosser', { ...every('2026-09-28', '2026-10-04', { diamonds: 100, hours: 2, followers: 5, fans: 1 }) })],
    asOf: '2026-10-04', config,
  });
  assert.equal(b.weekStart, '2026-09-28');
  assert.equal(b.weekEnd, '2026-10-04');
  assert.equal(b.days, 7);
  assert.equal(b.finished, true, '4 October 2026 is a Sunday');
  // Seven days counted, not the four that October alone would give.
  assert.equal(Math.round(b.rows[0].now.diamonds), 700);
  assert.equal(Math.round(b.rows[0].now.liveHours), 14);
});

test('position, not size, decides each pillar', () => {
  // Best in the network scores 1 and worst scores 0, however far apart the
  // numbers are. This is what stops one enormous diamond week deciding a board
  // that is supposed to be about four things.
  assert.deepEqual(rankPoints([5, 3, 1]), [1, 0.5, 0]);
  assert.deepEqual(rankPoints([1000000, 3, 1]), [1, 0.5, 0], 'the outlier gets no more than first place');
  // Everybody on the same number shares the places they jointly occupy, so the
  // hundreds of creators on nought fan club members are not secretly ordered.
  // (Rounded: 1 - 2/3 and 1/3 are not the same float, and that is not a bug.)
  const r6 = (xs) => xs.map((x) => Math.round(x * 1e6) / 1e6);
  assert.deepEqual(r6(rankPoints([5, 0, 0, 0])), [1, 0.333333, 0.333333, 0.333333]);
  assert.deepEqual(rankPoints([7]), [1]);
  assert.deepEqual(rankPoints([]), []);
});

test('the all-rounder beats the creator who is only huge on one thing', () => {
  const week = (g) => every(MON, SUN, g);
  const b = creatorWeekBoard({
    creators: [
      who('allrounder', week({ diamonds: 1000, hours: 6, followers: 200, fans: 10 })),
      who('diamonds_only', week({ diamonds: 900000, hours: 1, followers: 1, fans: 0 })),
      who('quiet', week({ diamonds: 10, hours: 1, followers: 2, fans: 0 })),
    ],
    asOf: SUN, config,
  });
  assert.equal(b.rows[0].username, 'allrounder');
  assert.ok(b.rows[0].score > b.rows[1].score);
  // And the enormous one is still second, not buried: it did grow.
  assert.equal(b.rows[1].username, 'diamonds_only');
});

test('you cannot win it without going LIVE', () => {
  const b = creatorWeekBoard({
    creators: [
      who('streamer', every(MON, SUN, { diamonds: 100, hours: 3, followers: 10, fans: 1 })),
      // Big follower week, never went LIVE. Not a creator of the week here.
      who('never_live', every(MON, SUN, { diamonds: 0, hours: 0, followers: 5000, fans: 90 })),
    ],
    asOf: SUN, config,
  });
  assert.deepEqual(b.rows.map((r) => r.username), ['streamer']);
});

test('creators who left and partner agencies are not in the competition', () => {
  const g = { diamonds: 5000, hours: 20, followers: 500, fans: 30 };
  const b = creatorWeekBoard({
    creators: [
      who('ours', every(MON, SUN, g)),
      who('gone', every(MON, SUN, g), { quitOn: '2026-09-16' }),
      who('partner', every(MON, SUN, g), { group: 'Surge Agency' }),
    ],
    asOf: SUN, config,
  });
  assert.deepEqual(b.rows.map((r) => r.username), ['ours']);
});

test('beating your own last week is what makes it winnable', () => {
  // Two creators, identical this week. One doubled on last week, the other
  // halved. The fifth pillar is the only thing between them, and it decides it.
  const thisWeek = { diamonds: 5000, hours: 20, followers: 300, fans: 10 };
  const b = creatorWeekBoard({
    creators: [
      who('climbing', {
        ...every('2026-09-07', '2026-09-13', { diamonds: 1000, hours: 5, followers: 50, fans: 2 }),
        ...every(MON, SUN, thisWeek),
      }),
      who('sliding', {
        ...every('2026-09-07', '2026-09-13', { diamonds: 20000, hours: 40, followers: 900, fans: 40 }),
        ...every(MON, SUN, thisWeek),
      }),
    ],
    asOf: SUN, config,
  });
  assert.equal(b.rows[0].username, 'climbing');
  assert.ok(b.rows[0].climb > 0, 'their position improved on last week');
  assert.ok(b.rows[1].climb < 0, 'and the other one slipped');
  // Turn the fifth pillar off and the two are level, which proves it was the
  // only thing separating them.
  const flat = creatorWeekBoard({
    creators: [
      who('climbing', { ...every('2026-09-07', '2026-09-13', { diamonds: 1000, hours: 5, followers: 50, fans: 2 }), ...every(MON, SUN, thisWeek) }),
      who('sliding', { ...every('2026-09-07', '2026-09-13', { diamonds: 20000, hours: 40, followers: 900, fans: 40 }), ...every(MON, SUN, thisWeek) }),
    ],
    asOf: SUN, config: { ...config, creatorWeek: { ...config.creatorWeek, momentumWeight: 0 } },
  });
  assert.equal(flat.rows[0].score, flat.rows[1].score);
});

test('mid-week compares the same days of last week, not a whole one', () => {
  // On a Wednesday a creator is three days in. Comparing that with seven days
  // of last week would mark down every creator in the network every Tuesday.
  const WED = '2026-09-16';
  const b = creatorWeekBoard({
    creators: [
      who('steady', {
        ...every('2026-09-07', '2026-09-13', { diamonds: 100, hours: 2, followers: 10, fans: 1 }),
        ...every(MON, WED, { diamonds: 100, hours: 2, followers: 10, fans: 1 }),
      }),
    ],
    asOf: WED, config,
  });
  assert.equal(b.days, 3);
  assert.equal(b.daysLeft, 4);
  const r = b.rows[0];
  assert.equal(Math.round(r.now.diamonds), 300, 'three days this week');
  assert.equal(Math.round(r.before.diamonds), 300, 'against three days of last week, not seven');
  assert.equal(r.climb, 0, 'doing exactly the same is neither up nor down');
});

test('the weights are LEAP\'s to change', () => {
  const week = (g) => every(MON, SUN, g);
  const creators = [
    who('grinder', week({ diamonds: 100, hours: 40, followers: 10, fans: 0 })),
    who('earner', week({ diamonds: 500000, hours: 2, followers: 10, fans: 0 })),
  ];
  const hours = creatorWeekBoard({
    creators, asOf: SUN,
    config: { ...config, creatorWeek: { weights: { liveHours: 10 }, momentumWeight: 0 } },
  });
  assert.equal(hours.rows[0].username, 'grinder');
  const money = creatorWeekBoard({
    creators, asOf: SUN,
    config: { ...config, creatorWeek: { weights: { diamonds: 10 }, momentumWeight: 0 } },
  });
  assert.equal(money.rows[0].username, 'earner');
});

test('the card shows what each creator grew, and says how it is judged', () => {
  const b = creatorWeekBoard({
    creators: [
      who('topdog', every(MON, SUN, { diamonds: 1000, hours: 6, followers: 300, fans: 12 })),
      who('secondplace', every(MON, SUN, { diamonds: 500, hours: 4, followers: 100, fans: 4 })),
    ],
    asOf: '2026-09-17', config,
  });
  const e = creatorWeekEmbed(b, { config }).embeds[0];

  assert.equal(e.title, '🌟 LEAP\'s Creator of the Week – 14–20 September');
  assert.match(e.description, /^Welcome to Creator of the Week!/);
  // A board that will not show its reasoning is a board creators argue with.
  assert.match(e.description, /diamonds, LIVE hours, new followers and new fan club members/);
  assert.match(e.description, /beat your own last week/);
  assert.match(e.description, /\*\*updated every day\*\*/);
  assert.match(e.description, /crowned on Sunday/);

  assert.equal(e.fields[0].name, 'This week so far');
  assert.equal(e.fields[0].value.split('\n')[0],
    '1. topdog — 4,000 💎 · 24.0 hrs · 1,200 followers · 48 fan club');
  assert.match(e.footer.text, /^Updated daily · 3 days left this week/);
});

test('the card tells a creator nothing about anyone\'s coach, team or pay', () => {
  const b = creatorWeekBoard({
    creators: [who('someone', every(MON, SUN, { diamonds: 812345, hours: 30, followers: 400, fans: 20 }))],
    asOf: '2026-09-17', config,
  });
  const whole = JSON.stringify(creatorWeekEmbed(b, { config }).embeds[0]);
  assert.doesNotMatch(whole, /Sur3shot|josh@leap|coach/i);
  assert.doesNotMatch(whole, /Team Alpha/);
  assert.doesNotMatch(whole, /£|\$/);
});

test('on Sunday the card crowns the winner and points at Monday', () => {
  const b = creatorWeekBoard({
    creators: [
      who('topdog', every(MON, SUN, { diamonds: 1000, hours: 6, followers: 300, fans: 12 })),
      who('secondplace', every(MON, SUN, { diamonds: 500, hours: 4, followers: 100, fans: 4 })),
      who('thirdplace', every(MON, SUN, { diamonds: 100, hours: 2, followers: 10, fans: 1 })),
    ],
    asOf: SUN, config,
  });
  assert.equal(b.finished, true);
  assert.equal(b.daysLeft, 0);

  const e = creatorWeekEmbed(b, { config }).embeds[0];
  assert.match(e.title, /^👑 LEAP's Creator of the Week – 14–20 September$/);
  assert.match(e.description, /the creator who grew the most is \*\*topdog\*\*/);
  assert.match(e.description, /\*\*7,000\*\* diamonds · \*\*42\.0\*\* LIVE hours/);
  assert.match(e.description, /secondplace and thirdplace right behind them/);
  assert.equal(e.fields[0].name, 'Final standings, 14–20 September');
  assert.match(e.footer.text, /A new week starts on Monday/);
  // And it stops telling people there is time to climb, because there is not.
  assert.doesNotMatch(e.description, /still time to climb/);
});

test('a week spanning two months is named across both', () => {
  const b = creatorWeekBoard({
    creators: [who('x', every('2026-09-28', '2026-10-04', { diamonds: 10, hours: 1, followers: 1, fans: 0 }))],
    asOf: '2026-10-04', config,
  });
  assert.match(creatorWeekEmbed(b, { config }).embeds[0].title, /28 September – 4 October$/);
});

test('Monday morning, before anyone has streamed, says so', () => {
  const b = creatorWeekBoard({
    creators: [who('nobody', { '2026-09-21': { diamonds: 0, hours: 0, followers: 0, fans: 0 } })],
    asOf: '2026-09-21', config,
  });
  assert.equal(b.entered, 0);
  assert.equal(b.days, 1);
  assert.match(creatorWeekEmbed(b, { config }).embeds[0].fields[0].value, /First one on the board/);
});

test('the card stays inside Discord\'s limits with a long board', () => {
  const creators = Array.from({ length: 200 }, (_, i) =>
    who(`a_creator_with_quite_a_long_name_${String(i).padStart(3, '0')}`,
      every(MON, SUN, { diamonds: 1000 + i * 37, hours: 3 + i / 50, followers: 20 + i, fans: i % 17 })));
  const cfg = { ...config, creatorWeek: { show: 25 } };
  const b = creatorWeekBoard({ creators, asOf: SUN, config: cfg });
  assert.equal(b.entered, 200);
  const e = creatorWeekEmbed(b, { config: cfg }).embeds[0];
  assert.ok(e.fields[0].value.length <= 1024, `field is ${e.fields[0].value.length}`);
  for (const l of e.fields[0].value.split('\n')) {
    assert.match(l, /^\d+\. \S+ — [\d,]+ 💎 · [\d.]+ hrs · [\d,]+ followers · [\d,]+ fan club$/);
  }
});

test('every pillar the award claims to measure is actually measured', () => {
  // The card promises four things. If one were quietly dropped from the score
  // the board would still look fine, so each is moved on its own here.
  const base = { diamonds: 100, hours: 5, followers: 20, fans: 2 };
  for (const p of PILLARS) {
    const bump = { ...base };
    bump[{ diamonds: 'diamonds', liveHours: 'hours', newFollowers: 'followers', newFans: 'fans' }[p.key]] *= 50;
    const b = creatorWeekBoard({
      creators: [who('mover', every(MON, SUN, bump)), who('flat', every(MON, SUN, base))],
      asOf: SUN, config: { ...config, creatorWeek: { momentumWeight: 0 } },
    });
    assert.equal(b.rows[0].username, 'mover', `${p.label} moves the ranking`);
  }
});

test('the board is posted once a day, and again when asked', () => {
  const store = { data: { lastCreatorWeekOn: null } };
  assert.equal(creatorWeekDue(config, store, SUN), true);
  store.data.lastCreatorWeekOn = SUN;
  assert.equal(creatorWeekDue(config, store, SUN), false);
  assert.equal(creatorWeekDue(config, store, '2026-09-21'), true);
  assert.equal(creatorWeekDue({ creatorWeek: { enabled: false } }, { data: {} }, SUN), false);
});
