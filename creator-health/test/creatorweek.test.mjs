import test from 'node:test';
import assert from 'node:assert/strict';
import {
  creatorWeekBoard, creatorWeekDue, weekStartOf, isWeekEnd, rankPoints, PILLARS,
} from '../lib/creatorweek.mjs';
import { creatorWeekEmbed } from '../lib/discord.mjs';
import { recordWeekBoard } from '../lib/creatorweek.mjs';

const require_cw = () => ({ recordWeekBoard });

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

test('growing on your own numbers beats being big and standing still', () => {
  // The whole reason this board exists. The giant did more of everything this
  // week than the climber did, and still loses, because the giant did what the
  // giant always does and the climber had the better week.
  const normal = (g) => every('2026-08-24', '2026-09-13', g);   // three weeks of their own
  const b = creatorWeekBoard({
    creators: [
      who('giant', {
        ...normal({ diamonds: 200000, hours: 8, followers: 900, fans: 40 }),
        ...every(MON, SUN, { diamonds: 200000, hours: 8, followers: 900, fans: 40 }),
      }),
      who('climber', {
        ...normal({ diamonds: 1000, hours: 2, followers: 30, fans: 1 }),
        ...every(MON, SUN, { diamonds: 20000, hours: 7, followers: 400, fans: 18 }),
      }),
    ],
    asOf: SUN, config,
  });
  assert.equal(b.rows[0].username, 'climber');
  assert.ok(b.rows[0].growth > b.rows[1].growth, 'the climber grew and the giant did not');
  assert.ok(b.rows[1].standing > b.rows[0].standing, 'while the giant is still the bigger creator');
});

test('a creator standing exactly still is not growing, however large they are', () => {
  const same = { diamonds: 500000, hours: 30, followers: 2000, fans: 90 };
  const b = creatorWeekBoard({
    creators: [
      who('flat', { ...every('2026-08-24', '2026-09-13', same), ...every(MON, SUN, same) }),
      who('up_a_bit', {
        ...every('2026-08-24', '2026-09-13', { diamonds: 100, hours: 2, followers: 10, fans: 1 }),
        ...every(MON, SUN, { diamonds: 400, hours: 4, followers: 40, fans: 4 }),
      }),
    ],
    asOf: SUN, config,
  });
  const flat = b.rows.find((r) => r.username === 'flat');
  for (const p of PILLARS) {
    assert.ok(flat.ratio[p.key] <= 1.0001, `${p.label}: level is level, not growth`);
  }
  assert.equal(b.rows[0].username, 'up_a_bit');
});

test('small numbers cannot fake a tenfold week', () => {
  // Two diamonds becoming twenty is not a tenfold week, it is noise. The ratio
  // is damped by the network's own typical baseline, so it barely moves; a
  // creator doing the same multiple on real numbers is not damped at all.
  const b = creatorWeekBoard({
    creators: [
      who('noise', {
        ...every('2026-08-24', '2026-09-13', { diamonds: 2, hours: 2, followers: 1, fans: 0 }),
        ...every(MON, SUN, { diamonds: 20, hours: 2, followers: 10, fans: 0 }),
      }),
      who('real', {
        ...every('2026-08-24', '2026-09-13', { diamonds: 2000, hours: 4, followers: 100, fans: 5 }),
        ...every(MON, SUN, { diamonds: 20000, hours: 8, followers: 1000, fans: 50 }),
      }),
      who('middle', {
        ...every('2026-08-24', '2026-09-13', { diamonds: 900, hours: 3, followers: 50, fans: 2 }),
        ...every(MON, SUN, { diamonds: 900, hours: 3, followers: 50, fans: 2 }),
      }),
    ],
    asOf: SUN, config,
  });
  const by = Object.fromEntries(b.rows.map((r) => [r.username, r]));
  // Both multiplied their diamonds by ten. Only one of them actually grew.
  assert.equal(Math.round(by.noise.now.diamonds / by.noise.base.diamonds), 10);
  assert.equal(Math.round(by.real.now.diamonds / by.real.base.diamonds), 10);
  assert.ok(by.real.ratio.diamonds > by.noise.ratio.diamonds * 2,
    `damped: real ${by.real.ratio.diamonds.toFixed(2)} vs noise ${by.noise.ratio.diamonds.toFixed(2)}`);
  assert.equal(b.rows[0].username, 'real');
});

test('starting from nothing is a big week, not an infinite one', () => {
  const b = creatorWeekBoard({
    creators: [
      who('from_zero', every(MON, SUN, { diamonds: 5000, hours: 10, followers: 200, fans: 8 })),
      who('steady', {
        ...every('2026-08-24', '2026-09-13', { diamonds: 100000, hours: 20, followers: 800, fans: 40 }),
        ...every(MON, SUN, { diamonds: 300000, hours: 40, followers: 2400, fans: 120 }),
      }),
    ],
    asOf: SUN, config,
  });
  const zero = b.rows.find((r) => r.username === 'from_zero');
  for (const p of PILLARS) {
    assert.ok(Number.isFinite(zero.ratio[p.key]), `${p.label} ratio is a number`);
    assert.equal(zero.base[p.key], 0, 'and it really was from nothing');
  }
  // Tripling on real numbers beats appearing from nowhere on small ones.
  assert.equal(b.rows[0].username, 'steady');
});

test('mid-week compares the same days of their own weeks, not a whole one', () => {
  // On a Wednesday a creator is three days in. Measuring that against seven
  // days of their normal would mark down every creator in the network on a
  // Tuesday and hand the award to whoever uploaded latest.
  const WED = '2026-09-16';
  const g = { diamonds: 100, hours: 2, followers: 10, fans: 1 };
  const b = creatorWeekBoard({
    creators: [who('steady', { ...every('2026-08-24', '2026-09-13', g), ...every(MON, WED, g) })],
    asOf: WED, config,
  });
  assert.equal(b.days, 3);
  assert.equal(b.daysLeft, 4);
  const r = b.rows[0];
  assert.equal(Math.round(r.now.diamonds), 300, 'three days this week');
  assert.equal(Math.round(r.base.diamonds), 300, 'against three days of a normal week, not seven');
  assert.equal(r.ratio.diamonds, 1, 'doing exactly the usual is neither up nor down');
});

test('their normal is however many of their own weeks LEAP asks for', () => {
  const creators = [who('x', {
    // A quiet fortnight, then a strong week, then this week.
    ...every('2026-08-24', '2026-09-06', { diamonds: 100, hours: 2, followers: 10, fans: 1 }),
    ...every('2026-09-07', '2026-09-13', { diamonds: 700, hours: 14, followers: 70, fans: 7 }),
    ...every(MON, SUN, { diamonds: 700, hours: 14, followers: 70, fans: 7 }),
  })];
  const one = creatorWeekBoard({ creators, asOf: SUN, config: { ...config, creatorWeek: { baselineWeeks: 1 } } });
  const three = creatorWeekBoard({ creators, asOf: SUN, config: { ...config, creatorWeek: { baselineWeeks: 3 } } });
  assert.equal(Math.round(one.rows[0].base.diamonds), 4900, 'last week only');
  assert.equal(Math.round(three.rows[0].base.diamonds), 2100,
    'averaged over three: two quiet weeks at 700 and one strong at 4,900');
  assert.ok(three.rows[0].ratio.diamonds > one.rows[0].ratio.diamonds,
    'a longer memory makes the same week look like more of a step up');
});

test('growth and standing are mixed in the proportion LEAP sets', () => {
  const creators = [
    who('giant', {
      ...every('2026-08-24', '2026-09-13', { diamonds: 200000, hours: 8, followers: 900, fans: 40 }),
      ...every(MON, SUN, { diamonds: 200000, hours: 8, followers: 900, fans: 40 }),
    }),
    who('climber', {
      ...every('2026-08-24', '2026-09-13', { diamonds: 1000, hours: 2, followers: 30, fans: 1 }),
      ...every(MON, SUN, { diamonds: 20000, hours: 7, followers: 400, fans: 18 }),
    }),
  ];
  const growthOnly = creatorWeekBoard({
    creators, asOf: SUN, config: { ...config, creatorWeek: { growthWeight: 1, standingWeight: 0 } },
  });
  assert.equal(growthOnly.rows[0].username, 'climber');
  const sizeOnly = creatorWeekBoard({
    creators, asOf: SUN, config: { ...config, creatorWeek: { growthWeight: 0, standingWeight: 1 } },
  });
  assert.equal(sizeOnly.rows[0].username, 'giant', 'turn growth off and it is a size board again');
});

test('the weights are LEAP\'s to change', () => {
  // Same growth on every pillar for both, so only the weighting separates them.
  const creators = [
    who('grinder', {
      ...every('2026-08-24', '2026-09-13', { diamonds: 100, hours: 4, followers: 10, fans: 1 }),
      ...every(MON, SUN, { diamonds: 100, hours: 40, followers: 10, fans: 1 }),
    }),
    who('earner', {
      ...every('2026-08-24', '2026-09-13', { diamonds: 5000, hours: 4, followers: 10, fans: 1 }),
      ...every(MON, SUN, { diamonds: 500000, hours: 4, followers: 10, fans: 1 }),
    }),
  ];
  const hours = creatorWeekBoard({
    creators, asOf: SUN,
    config: { ...config, creatorWeek: { weights: { liveHours: 10, diamonds: 0, newFollowers: 0, newFans: 0 } } },
  });
  assert.equal(hours.rows[0].username, 'grinder');
  const money = creatorWeekBoard({
    creators, asOf: SUN,
    config: { ...config, creatorWeek: { weights: { diamonds: 10, liveHours: 0, newFollowers: 0, newFans: 0 } } },
  });
  assert.equal(money.rows[0].username, 'earner');
});

test('the card publishes a score and a place, and none of the numbers', () => {
  const b = creatorWeekBoard({
    creators: [
      who('topdog', every(MON, SUN, { diamonds: 812345, hours: 6, followers: 300, fans: 12 })),
      who('secondplace', every(MON, SUN, { diamonds: 500, hours: 4, followers: 100, fans: 4 })),
    ],
    asOf: '2026-09-17', config,
  });
  const e = creatorWeekEmbed(b, { config }).embeds[0];

  assert.equal(e.title, '🌟 LEAP\'s Creator of the Week – 14–20 September');
  assert.match(e.description, /^Welcome to Creator of the Week!/);
  // A board that will not show its reasoning is a board creators argue with,
  // so how it is judged is named — just never anybody's figures.
  assert.match(e.description, /not a board for whoever is biggest/);
  assert.match(e.description, /fan club, diamonds, LIVE hours and new followers/);
  assert.match(e.description, /grown this week against your own recent weeks/);
  assert.match(e.description, /Nobody's figures are shown, only the score/);

  assert.equal(e.fields[0].name, 'This week so far');
  assert.match(e.fields[0].value.split('\n')[0], /^1\. \S+ — \d{1,3} pts$/);
  assert.match(e.footer.text, /^Updated daily · 3 days left this week/);
});

test('a creator\'s diamonds, followers and fan club never reach the channel', () => {
  // The whole network reads this channel. One published diamond total tells
  // 800 people what somebody earns, and the award becomes a leak.
  const b = creatorWeekBoard({
    creators: [
      who('earner', every(MON, SUN, { diamonds: 812345, hours: 33, followers: 4321, fans: 77 })),
      who('other', every(MON, SUN, { diamonds: 900, hours: 4, followers: 90, fans: 3 })),
    ],
    asOf: '2026-09-17', config,
  });
  const whole = JSON.stringify(creatorWeekEmbed(b, { config }).embeds[0]);
  // Every figure the board holds for the leader, in every shape it might be
  // written: raw, rounded and grouped.
  const r = b.rows.find((x) => x.username === 'earner');
  for (const v of [r.now.diamonds, r.now.liveHours, r.now.newFollowers, r.now.newFans]) {
    for (const written of [String(Math.round(v)), Math.round(v).toLocaleString('en-GB'), v.toFixed(1)]) {
      // A short number can appear inside the score or the week's dates by
      // coincidence; only guard the ones long enough to be the figure itself.
      if (written.replace(/\D/g, '').length < 3) continue;
      assert.ok(!whole.includes(written), `${written} must not be on the card`);
    }
  }
  assert.doesNotMatch(whole, /diamonds?\s*[:·—-]\s*\d/i);
  assert.doesNotMatch(whole, /💎/, 'not even as a symbol beside a number');
});

test('movement is shown against the last board from a different day', () => {
  const { recordWeekBoard } = require_cw();
  const store = { data: {} };
  // One creator ahead after two days; the other overtakes them on Wednesday.
  const steady = { diamonds: 1000, hours: 5, followers: 100, fans: 10 };
  const creators = [
    who('fast_starter', {
      '2026-09-14': steady, '2026-09-15': steady,
      '2026-09-16': { diamonds: 1, hours: 0.1, followers: 0, fans: 0 },
    }),
    who('late_surge', {
      '2026-09-14': { diamonds: 10, hours: 1, followers: 1, fans: 0 },
      '2026-09-15': { diamonds: 10, hours: 1, followers: 1, fans: 0 },
      '2026-09-16': { diamonds: 100000, hours: 20, followers: 5000, fans: 90 },
    }),
  ];

  // Tuesday's board: nothing to compare with, so nobody has moved.
  const tue = creatorWeekBoard({ creators, asOf: '2026-09-15', store, config });
  assert.deepEqual(tue.rows.map((r) => r.username), ['fast_starter', 'late_surge']);
  assert.deepEqual(tue.rows.map((r) => r.move), [null, null]);
  recordWeekBoard(store, tue);

  // Pressing the button again the same day must not destroy the comparison.
  recordWeekBoard(store, tue);
  assert.equal(store.data.creatorWeek.prevRanks, null, 'the same day is not a new board');
  assert.equal(store.data.creatorWeek.ranks.fast_starter, 1);

  // Wednesday: the surge takes the lead, and both arrows say so.
  const wed = creatorWeekBoard({ creators, asOf: '2026-09-16', store, config });
  assert.deepEqual(wed.rows.map((r) => r.username), ['late_surge', 'fast_starter']);
  assert.equal(wed.rows[0].move, 1, 'up one place');
  assert.equal(wed.rows[1].move, -1, 'and down one');

  const value = creatorWeekEmbed(wed, { config }).embeds[0].fields[0].value;
  assert.match(value, /^1\. late_surge — \d{1,3} pts {2}▲1$/m);
  assert.match(value, /^2\. fast_starter — \d{1,3} pts {2}▼1$/m);

  // Now the day's board is recorded, as the daily run does. Pressing the button
  // afterwards must still show movement against TUESDAY — comparing Wednesday
  // with Wednesday would quietly flatten every arrow on the card.
  recordWeekBoard(store, wed);
  const pressedAgain = creatorWeekBoard({ creators, asOf: '2026-09-16', store, config });
  assert.deepEqual(pressedAgain.rows.map((r) => r.move), wed.rows.map((r) => r.move),
    'the arrows do not change because somebody pressed the button');
  assert.equal(pressedAgain.rows[0].move, 1);

  // And a creator who was not on the last board at all is marked new, not moved.
  const withNewcomer = creatorWeekBoard({
    creators: [...creators, who('arrived_today', { '2026-09-16': { diamonds: 50, hours: 2, followers: 5, fans: 1 } })],
    asOf: '2026-09-16', store, config,
  });
  const fresh = withNewcomer.rows.find((r) => r.username === 'arrived_today');
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.move, null);
  assert.match(creatorWeekEmbed(withNewcomer, { config }).embeds[0].fields[0].value, /arrived_today — \d+ pts {2}new/);
});

test('a new week starts everybody level, with no arrows at all', () => {
  const { recordWeekBoard } = require_cw();
  const store = { data: {} };
  const creators = [who('someone', every(MON, '2026-09-27', { diamonds: 100, hours: 3, followers: 10, fans: 1 }))];
  recordWeekBoard(store, creatorWeekBoard({ creators, asOf: SUN, store, config }));
  // 2026-09-21 is the Monday after.
  const next = creatorWeekBoard({ creators, asOf: '2026-09-21', store, config });
  assert.equal(next.weekStart, '2026-09-21');
  assert.deepEqual(next.rows.map((r) => r.move), [null]);
  assert.doesNotMatch(creatorWeekEmbed(next, { config }).embeds[0].fields[0].value, /[▲▼]/);
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
  assert.match(e.description, /the creator who grew the most is \*\*topdog\*\*, finishing on \*\*\d{1,3} points\*\*/);
  // What they were best at is worth saying and gives away no numbers.
  assert.match(e.description,
    /Nobody in the network grew more this week for .+?\. Best in the whole network this week for .+?\./);
  assert.match(e.description, /secondplace and thirdplace right behind them/);
  assert.equal(e.fields[0].name, 'Final standings, 14–20 September');
  assert.match(e.footer.text, /A new week starts on Monday/);
  // And it stops telling people there is time to climb, because there is not.
  assert.doesNotMatch(e.description, /still time to climb/);
  // Still no figures, even in celebration.
  assert.doesNotMatch(JSON.stringify(e), /1,000|💎/);
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
    assert.match(l, /^\d+\. \S+ — \d{1,3} pts(  (new|▲\d+|▼\d+)|    ·)?$/);
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
