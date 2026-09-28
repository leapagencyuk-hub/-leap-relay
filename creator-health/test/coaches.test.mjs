import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coachName, offTheBoards } from '../lib/coaches.mjs';
import { leaderboard } from '../lib/leaderboard.mjs';
import { growthBoard } from '../lib/growthboard.mjs';
import { leaderboardEmbed, growthBoardEmbed, declineEmbed, graduationEmbed } from '../lib/discord.mjs';

const config = {
  coaches: {
    names: { 'joshbates93@hotmail.com': 'Sur3shot', 'bigbamc.tt@gmail.com': 'Cam' },
    excludeFromBoards: ['amykinsincolour@gmail.com'],
  },
  leaderboard: { show: 10 },
  growthBoard: { priorWeight: 25, minComparable: 3, thinBelow: 10, show: 12 },
  monitoring: { ignoreGroups: [] },
};

test('a coach is called what their team calls them', () => {
  assert.equal(coachName('joshbates93@hotmail.com', config), 'Sur3shot');
  assert.equal(coachName('BigBamC.TT@Gmail.com', config), 'Cam', 'the address is not case sensitive');
});

test('a coach with no entry still reads, rather than not appearing', () => {
  assert.equal(coachName('newhire@leap.com', config), 'newhire');
  assert.equal(coachName('someone@x.com', {}), 'someone');
  assert.equal(coachName(null, config), 'unassigned');
  assert.equal(coachName('unassigned', config), 'unassigned');
});

test('being off the boards is separate from being an ignored team', () => {
  assert.equal(offTheBoards('amykinsincolour@gmail.com', config), true);
  assert.equal(offTheBoards('AMYKINSINCOLOUR@GMAIL.COM', config), true);
  assert.equal(offTheBoards('joshbates93@hotmail.com', config), false);
  assert.equal(offTheBoards('anyone@x.com', {}), false, 'no list means nobody is excluded');
});

const who = (username, coach, joinDate, { aug = null, sep = 0, liveDays = 0 } = {}) => ({
  key: username, username, joinDate, quitOn: null, group: 'Team Alpha', manager: coach,
  obs: [
    ...(aug == null ? [] : [{ date: '2026-08-31', mtd: { diamonds: aug } }]),
    { date: '2026-09-20', mtd: { diamonds: sep, validLiveDays: liveDays } },
  ],
});

test('the recruitment board uses the nicknames and leaves the excluded coach off', () => {
  const creators = [
    who('a', 'joshbates93@hotmail.com', '2026-09-02', { sep: 5000, liveDays: 3 }),
    who('b', 'amykinsincolour@gmail.com', '2026-09-03', { sep: 9000, liveDays: 4 }),
    who('c', 'bigbamc.tt@gmail.com', '2026-09-04', { sep: 1000, liveDays: 1 }),
  ];
  const b = leaderboard({ creators, asOf: '2026-09-20', config });
  assert.deepEqual(b.rows.map((r) => r.name), ['Sur3shot', 'Cam'],
    'nicknames, and no amykins');
  assert.equal(b.total, 2, 'the excluded coach\'s recruits are not counted either');
  // Their creator was the biggest earner; the standout must not credit them.
  assert.equal(b.standout.username, 'a');
  const text = JSON.stringify(leaderboardEmbed(b, { config }));
  assert.ok(!/amykins/i.test(text));
  assert.match(text, /Sur3shot/);
});

test('the growth board does the same', () => {
  const creators = [
    who('a', 'joshbates93@hotmail.com', '2026-01-01', { aug: 10000, sep: 20000 }),
    who('a2', 'joshbates93@hotmail.com', '2026-01-01', { aug: 10000, sep: 20000 }),
    who('a3', 'joshbates93@hotmail.com', '2026-01-01', { aug: 10000, sep: 20000 }),
    who('b', 'amykinsincolour@gmail.com', '2026-01-01', { aug: 1000, sep: 900000 }),
    who('b2', 'amykinsincolour@gmail.com', '2026-01-01', { aug: 1000, sep: 900000 }),
    who('b3', 'amykinsincolour@gmail.com', '2026-01-01', { aug: 1000, sep: 900000 }),
  ];
  const b = growthBoard({ creators, asOf: '2026-09-20', config });
  assert.deepEqual(b.rows.map((r) => r.name), ['Sur3shot']);
  assert.ok(!/amykins/i.test(JSON.stringify(growthBoardEmbed(b, { config }))),
    'and their enormous month does not quietly set the network prior either');
});

test('the cards a coach reads use the nickname too', () => {
  const caseRecord = {
    id: 'D-1', kind: 'decline', status: 'open', severity: 'urgent', playbookId: 'DIAMONDS_DOWN',
    creatorKey: 'k1', username: 'creator1', coach: 'joshbates93@hotmail.com', group: 'Team Alpha',
    openedOn: '2026-09-19', valueAtRisk: 1000,
    baseline: { weeklyDiamonds: 100, weeklyHours: 1, weeklyLiveDays: 1 },
  };
  const window = { diamonds: 1000, liveHours: 10, validLiveDays: 5 };
  const alert = {
    creator: { key: 'k1', username: 'creator1' }, severity: 'urgent', signals: [], causes: [],
    metrics: {
      curr7: window, prev7: window, curr28: window,
      change7: { diamonds: -0.4, liveHours: -0.3 }, monthly: {}, monthlyCoverage: {},
    },
  };
  const footer = declineEmbed(caseRecord, alert, { config }).embeds[0].footer.text;
  assert.match(footer, /Sur3shot/);
  assert.ok(!/joshbates93/.test(footer));

  const grad = graduationEmbed({
    username: 'c', group: 'Team Alpha', coach: 'bigbamc.tt@gmail.com', day: 40, month: '2026-09',
    monthToDate: 150000, target: 200000, remaining: 50000, daysLeft: 10, perDay: 6000,
    requiredPerDay: 5000, projected: 210000, attemptsLeft: 1, bestMonth: 0, done: false,
  }, { config }).embeds[0].footer.text;
  assert.match(grad, /Cam/);
});

test('the real config carries every coach on the boards', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  // A typo in an address silently falls back to the local part, so pin them.
  for (const [email, name] of Object.entries(real.coaches.names)) {
    assert.match(email, /@/, `${email} should be an address`);
    assert.ok(name && name !== email.split('@')[0], `${email} needs a real nickname`);
  }
  assert.equal(Object.keys(real.coaches.names).length, 10);
});

test('no card renders a raw email address', () => {
  // A new embed that forgets to pass `config` would silently print
  // "joshbates93" on a card his own team reads. Cheap to check, easy to miss.
  // Matches property access only: `acknowledgedBy` is a Discord username set
  // when somebody clicks a button, not an address, and is not our business.
  const src = fs.readFileSync(new URL('../lib/discord.mjs', import.meta.url), 'utf8');
  const raw = [...src.matchAll(/\$\{[^}]*\.coach\b[^}]*\}/g)]
    .map((m) => m[0])
    .filter((m) => !/coachName/.test(m));
  assert.deepEqual(raw, [],
    `these interpolate a coach without going through coachName: ${raw.join(', ')}`);
});
