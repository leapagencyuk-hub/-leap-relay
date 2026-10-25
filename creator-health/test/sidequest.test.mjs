import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  QUEST_DAYS, questDayFor, questEndFor, isQuestDay, questsRunning,
  selectQuests, questProgress, questBoard, saveQuests, readQuests,
  creatorMessage, recentForm,
} from '../lib/sidequest.mjs';
import { sideQuestTerminalEmbed, sideQuestCardEmbed } from '../lib/discord.mjs';

const day = (d) => `2026-10-${String(d).padStart(2, '0')}`;
// A creator with a reading on every day asked for.
const creator = (username, { from = 1, to = 24, perDay = 5000, hoursPerDay = 2, start = 0,
  join = '2026-01-01', lastMonth = 250000, group = 'Team Alpha', coach = 'a@b.com' } = {}) => ({
  key: `id:${username}`, username, group, manager: coach, joinDate: join, quitOn: null,
  obs: Array.from({ length: to - from + 1 }, (_, i) => ({
    date: day(from + i), periodStart: '2026-10-01', lastMonthDiamonds: lastMonth,
    mtd: { diamonds: start + perDay * (from + i), liveHours: hoursPerDay * (from + i), validLiveDays: from + i },
  })),
});
const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('quest day leaves exactly seven nights', () => {
  for (const m of ['2026-09', '2026-10', '2026-11', '2026-02', '2024-02']) {
    const set = questDayFor(m), end = questEndFor(m);
    const nights = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${set}T00:00:00Z`)) / 86400000);
    assert.equal(nights, QUEST_DAYS, `${m} gives ${nights} nights`);
  }
});

test('September sets on the 23rd, the day the run was validated against', () => {
  assert.equal(questDayFor('2026-09'), '2026-09-23');
  assert.ok(isQuestDay('2026-09-23'));
  assert.ok(!isQuestDay('2026-09-24'));
});

test('quests run from the day they are set to month end, and not before', () => {
  assert.ok(!questsRunning('2026-10-23'));
  assert.ok(questsRunning('2026-10-24'));
  assert.ok(questsRunning('2026-10-31'));
  assert.ok(!questsRunning('2026-11-01'));
});

test('a target in reach is offered', () => {
  // 250k last month puts them in tier 3, so the bar to hold is 200k. At 6,250
  // a night they reach 150k by the 24th: 50k short, needing 7,143 a night,
  // which is a real stretch on their current pace rather than a formality.
  const c = creator('inreach');
  c.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: 6250 * (i + 1), liveHours: 2 * (i + 1), validLiveDays: i + 1 },
  }));
  const out = selectQuests({ creators: [c], asOf: '2026-10-24', config });
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'inreach');
  assert.equal(out[0].kind, 'HOLD', 'tier 4 at 300k is out of reach; holding tier 3 is not');
  assert.equal(out[0].target, 200000);
  assert.equal(out[0].need, 50000);
  assert.equal(out[0].endsOn, '2026-10-31');
  assert.ok(out[0].worthGbp >= 25, 'above the value floor');
});

test('a creator already smashing the rate is skipped', () => {
  // Needs very little and is doing enormous nights: no quest to buy.
  const c = creator('cracking');
  c.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: i < 20 ? 150000 : 150000 + 60000 * (i - 19), liveHours: 2 * (i + 1), validLiveDays: i + 1 },
  }));
  const out = selectQuests({ creators: [c], asOf: '2026-10-24', config });
  assert.equal(out.filter((q) => q.username === 'cracking').length, 0);
});

test('a stalled creator gets no quest, however good their month looks', () => {
  // Strong month-to-date, then nothing at all for the last four days.
  const c = creator('stalled');
  c.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: i < 20 ? 9000 * (i + 1) : 9000 * 20, liveHours: i < 20 ? 2 * (i + 1) : 40, validLiveDays: Math.min(i + 1, 20) },
  }));
  const out = selectQuests({ creators: [c], asOf: '2026-10-24', config });
  assert.equal(out.length, 0, 'a creator who stopped four days ago cannot close a tier gap in seven');
});

test('partner agencies are left out', () => {
  const c = creator('partner', { group: 'Surge Agency' });
  c.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: 8000 * (i + 1), liveHours: 2 * (i + 1), validLiveDays: i + 1 },
  }));
  assert.equal(selectQuests({ creators: [c], asOf: '2026-10-24', config }).length, 0);
});

test('a creator under a month on the roster is left out', () => {
  const c = creator('newbie', { join: '2026-10-10' });
  c.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: 8000 * (i + 1), liveHours: 2 * (i + 1), validLiveDays: i + 1 },
  }));
  assert.equal(selectQuests({ creators: [c], asOf: '2026-10-24', config }).length, 0);
});

test('generating against stale data refuses rather than returning nothing', () => {
  const c = creator('anyone', { to: 14 });
  assert.throws(() => selectQuests({ creators: [c], asOf: '2026-10-24', config }),
    (err) => err.code === 'STALE_DATA' && /2026-10-14/.test(err.message));
});

test('the target is frozen: progress is measured against the stored number', () => {
  const quest = { setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000,
    target: 200000, need: 10000, formAtSet: 2000 };
  const c = creator('frozen');
  c.obs = [{ date: '2026-10-28', periodStart: '2026-10-01', mtd: { diamonds: 196000 } }];
  const p = questProgress(quest, c, '2026-10-28');
  assert.equal(p.now, 196000);
  assert.equal(p.gained, 6000);
  assert.equal(p.left, 4000);
  assert.equal(p.nightsLeft, 3);
  assert.ok(!p.done);
  assert.ok(p.onCourse, '6,000 in four nights clears 4,000 in three');
});

test('a quest set today is "just set", not behind', () => {
  const quest = { setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 100000,
    target: 200000, need: 100000, formAtSet: 100 };
  const c = creator('today');
  c.obs = [{ date: '2026-10-24', periodStart: '2026-10-01', mtd: { diamonds: 100000 } }];
  const p = questProgress(quest, c, '2026-10-24');
  assert.ok(p.fresh, 'no nights have run yet');
  assert.equal(p.gained, 0);
});

test('hitting the target reads as done and stays done', () => {
  const quest = { setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000,
    target: 200000, need: 10000, formAtSet: 3000 };
  const c = creator('winner');
  c.obs = [{ date: '2026-10-29', periodStart: '2026-10-01', mtd: { diamonds: 240000 } }];
  const p = questProgress(quest, c, '2026-10-29');
  assert.ok(p.done);
  assert.ok(p.onCourse);
  assert.equal(p.pct, 1);
});

test('the board totals what is won separately from what is at stake', () => {
  const store = { data: {} };
  const quests = [
    { creatorKey: 'id:a', username: 'a', coach: 'a@b.com', kind: 'HOLD', tier: 3, month: '2026-10',
      setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000, target: 200000, need: 10000,
      perNight: 1500, formAtSet: 2000, worthGbp: 80, questCoins: 800, incentiveCoins: 1000 },
    { creatorKey: 'id:b', username: 'b', coach: 'a@b.com', kind: 'CROSS', tier: 4, month: '2026-10',
      setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 250000, target: 300000, need: 50000,
      perNight: 7200, formAtSet: 1000, worthGbp: 200, questCoins: 2000, incentiveCoins: 3000 },
  ];
  saveQuests(store, '2026-10', quests);
  assert.equal(readQuests(store, '2026-10').quests.length, 2);
  const creators = [
    { key: 'id:a', username: 'a', obs: [{ date: '2026-10-29', periodStart: '2026-10-01', mtd: { diamonds: 205000 } }] },
    { key: 'id:b', username: 'b', obs: [{ date: '2026-10-29', periodStart: '2026-10-01', mtd: { diamonds: 255000 } }] },
  ];
  const board = questBoard({ creators, asOf: '2026-10-29', store, config });
  assert.equal(board.summary.total, 2);
  assert.equal(board.summary.done, 1);
  assert.equal(board.summary.worthGbp, 280);
  assert.equal(board.summary.wonGbp, 80, 'only the hit one is banked');
  assert.equal(board.summary.coinsOwed, 1800, 'coins owed follow the hit, not the hope');
  assert.equal(board.summary.diamondsGained, 20000);
});

test('the creator message carries no Discord markup and names the reward', () => {
  const quest = { kind: 'HOLD', tier: 5, target: 500000, questCoins: 2000,
    setOn: '2026-10-24', endsOn: '2026-10-31' };
  const msg = creatorMessage(quest, { now: 440000, left: 60000, perNightNeeded: 8600,
    nightsLeft: 7, onCourse: false, done: false });
  assert.ok(!msg.includes('**'), 'a creator would see literal asterisks');
  assert.ok(msg.includes('2,000 Side Quest coins'));
  assert.ok(msg.includes('Uni Wheel'));
  assert.ok(!/£|GBP/.test(msg), 'creators are never shown what it is worth to LEAP');
});

test('the won message reads as a win', () => {
  const quest = { kind: 'CROSS', tier: 4, target: 300000, questCoins: 2000, setOn: '2026-10-24', endsOn: '2026-10-31' };
  const msg = creatorMessage(quest, { now: 305000, left: 0, perNightNeeded: 0, nightsLeft: 2, onCourse: true, done: true });
  assert.ok(/did it/i.test(msg));
  assert.ok(!/to go/i.test(msg));
});

test('both cards stay inside Discord limits and the card carries the coach tag', () => {
  const store = { data: {} };
  const quests = Array.from({ length: 24 }, (_, i) => ({
    creatorKey: `id:c${i}`, username: `creator_number_${i}`, coach: 'a@b.com', group: 'Team Alpha',
    kind: i % 2 ? 'HOLD' : 'CROSS', tier: 5, month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31',
    startedAt: 400000, target: 500000, need: 100000, perNight: 14300, formAtSet: 9000,
    worthGbp: 120, questCoins: 1200, incentiveCoins: 2500,
  }));
  saveQuests(store, '2026-10', quests);
  const creators = quests.map((q) => ({ key: q.creatorKey, username: q.username,
    obs: [{ date: '2026-10-28', periodStart: '2026-10-01', mtd: { diamonds: 450000 } }] }));
  const board = questBoard({ creators, asOf: '2026-10-28', store, config });
  const pages = sideQuestTerminalEmbed(board, { config });
  for (const p of (Array.isArray(pages) ? pages : [pages])) {
    const e = (p.embeds ?? [p])[0];
    assert.ok(JSON.stringify(e).length < 6000, 'embed within the 6000 limit');
    assert.ok((e.fields ?? []).length <= 25);
    for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024, `field ${f.name} over 1024`);
  }
  const card = sideQuestCardEmbed(board.quests[0], { config, mention: '<@999>' });
  assert.equal(card.content, '<@999>', 'the coach is tagged above the card');
  const e = card.embeds[0];
  assert.ok(JSON.stringify(e).length < 6000);
  for (const f of e.fields) assert.ok(f.value.length <= 1024, `field ${f.name} over 1024`);
  const send = e.fields.find((f) => f.name === 'Send them this');
  assert.ok(send && send.value.includes('```'), 'the message is in a copyable block');
});

test('recent form cannot be read when the data stops short', () => {
  const c = creator('short', { to: 14 });
  assert.equal(recentForm(c, '2026-10-24', 3), null);
  assert.ok(recentForm(c, '2026-10-14', 3));
});

// --- the three pushes into coaches' own rooms --------------------------------

import { questPhase, questsByCoach } from '../lib/sidequest.mjs';
import { sideQuestCoachEmbed } from '../lib/discord.mjs';

const span = { setOn: '2026-10-24', endsOn: '2026-10-31' };

test('a coach is pushed three times, not seven', () => {
  const fired = [];
  for (let d = 24; d <= 31; d++) {
    const asOf = `2026-10-${d}`;
    const p = questPhase(asOf, span, config);
    if (p) fired.push([asOf, p]);
  }
  assert.equal(fired.length, 3, `fired on ${fired.map((f) => f.join(':')).join(', ')}`);
  assert.deepEqual(fired.map((f) => f[1]), ['launch', 'midpoint', 'final']);
  assert.equal(fired[0][0], '2026-10-24', 'launch is the day they are set');
  assert.equal(fired[2][0], '2026-10-30', 'final leaves one night to act');
});

test('the schedule is configurable', () => {
  const tight = { sideQuests: { teamCards: { midpointNightsLeft: 2, finalNightsLeft: 1 } } };
  assert.equal(questPhase('2026-10-29', span, tight), 'midpoint');
  assert.equal(questPhase('2026-10-27', span, tight), null);
});

test('nothing fires outside the quest window', () => {
  assert.equal(questPhase('2026-10-23', span, config), null);
  assert.equal(questPhase('2026-11-01', span, config), null);
});

test('each coach only ever sees their own creators', () => {
  const store = { data: {} };
  saveQuests(store, '2026-10', [
    { creatorKey: 'id:a', username: 'mine', coach: 'coach1@x.com', group: 'Team Alpha', kind: 'HOLD', tier: 3,
      month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000, target: 200000,
      need: 10000, perNight: 1500, formAtSet: 2000, worthGbp: 80, questCoins: 800, incentiveCoins: 1000 },
    { creatorKey: 'id:b', username: 'theirs', coach: 'coach2@x.com', group: 'Team Bravo', kind: 'HOLD', tier: 3,
      month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000, target: 200000,
      need: 10000, perNight: 1500, formAtSet: 2000, worthGbp: 90, questCoins: 900, incentiveCoins: 1000 },
  ]);
  const creators = [
    { key: 'id:a', username: 'mine', obs: [{ date: '2026-10-27', periodStart: '2026-10-01', mtd: { diamonds: 195000 } }] },
    { key: 'id:b', username: 'theirs', obs: [{ date: '2026-10-27', periodStart: '2026-10-01', mtd: { diamonds: 195000 } }] },
  ];
  const groups = questsByCoach(questBoard({ creators, asOf: '2026-10-27', store, config }));
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.equal(g.rows.length, 1);
    const card = sideQuestCoachEmbed(g, 'midpoint', { config, mention: '<@1>', nightsLeft: 4 });
    const text = JSON.stringify(card);
    const mine = g.rows[0].quest.username;
    const other = mine === 'mine' ? 'theirs' : 'mine';
    assert.ok(text.includes(mine));
    assert.ok(!text.includes(other), `${g.coach} can see ${other}`);
  }
});

test('the launch card carries the message, the later ones carry the scoreboard', () => {
  const store = { data: {} };
  saveQuests(store, '2026-10', [
    { creatorKey: 'id:a', username: 'a', coach: 'c@x.com', group: 'Team Alpha', kind: 'CROSS', tier: 4,
      month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 250000, target: 300000,
      need: 50000, perNight: 7200, formAtSet: 4000, worthGbp: 200, questCoins: 2000, incentiveCoins: 3000 },
  ]);
  const at = (d, dia) => questsByCoach(questBoard({
    creators: [{ key: 'id:a', username: 'a', obs: [{ date: d, periodStart: '2026-10-01', mtd: { diamonds: dia } }] }],
    asOf: d, store, config,
  }))[0];
  const launch = sideQuestCoachEmbed(at('2026-10-24', 250000), 'launch', { config, nightsLeft: 7 });
  assert.ok(JSON.stringify(launch).includes('SIDE QUEST'), 'launch hands the coach the words');
  assert.ok(launch.embeds[0].fields.some((f) => f.value.includes('```')));
  const final = sideQuestCoachEmbed(at('2026-10-30', 262000), 'final', { config, nightsLeft: 1 });
  assert.ok(!JSON.stringify(final).includes('SIDE QUEST —'), 'the last push is a scoreboard, not a re-brief');
  assert.ok(final.embeds[0].fields.some((f) => f.name === 'Need you tonight'));
});

test('a creator who has done nothing is called out by name', () => {
  const store = { data: {} };
  saveQuests(store, '2026-10', [
    { creatorKey: 'id:z', username: 'ghost', coach: 'c@x.com', group: 'Team Alpha', kind: 'HOLD', tier: 3,
      month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000, target: 200000,
      need: 10000, perNight: 1500, formAtSet: 900, worthGbp: 80, questCoins: 800, incentiveCoins: 1000 },
    { creatorKey: 'id:y', username: 'mover', coach: 'c@x.com', group: 'Team Alpha', kind: 'HOLD', tier: 3,
      month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 190000, target: 200000,
      need: 10000, perNight: 1500, formAtSet: 900, worthGbp: 80, questCoins: 800, incentiveCoins: 1000 },
  ]);
  const entry = questsByCoach(questBoard({
    creators: [
      { key: 'id:z', username: 'ghost', obs: [{ date: '2026-10-27', periodStart: '2026-10-01', mtd: { diamonds: 190000 } }] },
      { key: 'id:y', username: 'mover', obs: [{ date: '2026-10-27', periodStart: '2026-10-01', mtd: { diamonds: 197000 } }] },
    ], asOf: '2026-10-27', store, config,
  }))[0];
  const card = sideQuestCoachEmbed(entry, 'midpoint', { config, nightsLeft: 4 });
  const untouched = card.embeds[0].fields.find((f) => f.name === 'Not been near it');
  assert.ok(untouched, 'the one who has not started gets their own block');
  assert.ok(untouched.value.includes('ghost'));
  assert.ok(!untouched.value.includes('mover'), 'somebody who moved is not shamed with them');
});

test('coach cards stay inside Discord limits with a full roster', () => {
  const store = { data: {} };
  saveQuests(store, '2026-10', Array.from({ length: 10 }, (_, i) => ({
    creatorKey: `id:${i}`, username: `a_long_creator_name_${i}`, coach: 'c@x.com', group: 'Team Alpha',
    kind: 'CROSS', tier: 6, month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31',
    startedAt: 500000, target: 700000, need: 200000, perNight: 28600, formAtSet: 12000,
    worthGbp: 400, questCoins: 4000, incentiveCoins: 7000,
  })));
  const creators = Array.from({ length: 10 }, (_, i) => ({ key: `id:${i}`, username: `a_long_creator_name_${i}`,
    obs: [{ date: '2026-10-27', periodStart: '2026-10-01', mtd: { diamonds: 540000 } }] }));
  const entry = questsByCoach(questBoard({ creators, asOf: '2026-10-27', store, config }))[0];
  for (const phase of ['launch', 'midpoint', 'final']) {
    const e = sideQuestCoachEmbed(entry, phase, { config, nightsLeft: 4 }).embeds[0];
    assert.ok(JSON.stringify(e).length < 6000, `${phase} embed too big`);
    assert.ok(e.fields.length <= 25, `${phase} too many fields`);
    for (const f of e.fields) assert.ok(f.value.length <= 1024, `${phase}: field ${f.name} over 1024`);
  }
});

test('the audit accounts for every creator and every target, and only when asked', () => {
  // One who qualifies, one in a partner agency, one too new to have a tier.
  const good = creator('inreach');
  good.obs = Array.from({ length: 24 }, (_, i) => ({
    date: day(i + 1), periodStart: '2026-10-01', lastMonthDiamonds: 250000,
    mtd: { diamonds: 6250 * (i + 1), liveHours: 2 * (i + 1), validLiveDays: i + 1 },
  }));
  const partner = creator('partnered', { group: 'Surge Agency' });
  const fresh = creator('justjoined', { join: '2026-10-20' });
  const creators = [good, partner, fresh];

  const audit = {};
  const out = selectQuests({ creators, asOf: '2026-10-24', config, audit });

  assert.equal(audit.roster, 3);
  assert.equal(audit.chosen, out.length);
  assert.equal(audit.creators['partner agency'], 1);
  assert.equal(audit.creators['under a month on the roster'], 1);

  // Each bucket reconciles against its OWN total. Pooling them would be wrong:
  // a creator weighed for both a hold and a cross is one person, two targets.
  const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  assert.equal(sum(audit.creators) + audit.creatorsConsidered, audit.roster);
  assert.equal(sum(audit.quests) + audit.chosen, audit.candidates);

  // Nobody who survived the creator gates is missing from the target count.
  assert.ok(audit.candidates >= audit.creatorsConsidered - (audit.creators['nothing left to hold or cross'] ?? 0));

  // And without an audit object nothing is tallied and the result is identical.
  assert.deepEqual(selectQuests({ creators, asOf: '2026-10-24', config }), out);
});

test('nothing a coach or creator can see says what the quest is worth to LEAP', () => {
  // The margin is a directors' number. It reached a coach's Discord card as
  // "Worth to LEAP £75" and had to be pulled. The coins are what a creator
  // chases and what a coach is allowed to quote, so they take its place.
  const store = { data: {} };
  saveQuests(store, '2026-10', [
    { creatorKey: 'id:a', username: 'a', coach: 'a@b.com', group: 'Team Alpha', kind: 'HOLD',
      tier: 5, month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 250000,
      target: 300000, need: 50000, perNight: 7200, formAtSet: 4000,
      worthGbp: 75, questCoins: 2000, incentiveCoins: 3000 },
    { creatorKey: 'id:b', username: 'b', coach: 'a@b.com', group: 'Team Alpha', kind: 'CROSS',
      tier: 6, month: '2026-10', setOn: '2026-10-24', endsOn: '2026-10-31', startedAt: 400000,
      target: 500000, need: 100000, perNight: 14300, formAtSet: 12000,
      worthGbp: 210, questCoins: 1600, incentiveCoins: 7000 },
  ]);
  const creators = [
    { key: 'id:a', username: 'a', obs: [{ date: '2026-10-28', periodStart: '2026-10-01', mtd: { diamonds: 305000 } }] },
    { key: 'id:b', username: 'b', obs: [{ date: '2026-10-28', periodStart: '2026-10-01', mtd: { diamonds: 420000 } }] },
  ];
  const board = questBoard({ creators, asOf: '2026-10-28', store, config });

  const surfaces = [
    ['terminal', sideQuestTerminalEmbed(board, { config })],
    ['creator card', sideQuestCardEmbed(board.quests[0], { config, mention: '<@1>' })],
    ['coach room card', sideQuestCoachEmbed(questsByCoach(board)[0], 'midpoint', { config, nightsLeft: 3 })],
  ];
  for (const [what, payload] of surfaces) {
    const json = JSON.stringify(payload);
    assert.equal(json.includes('£'), false, `${what} shows a pound sign`);
    assert.equal(/Worth to LEAP/.test(json), false, `${what} names LEAP's margin`);
    // And not smuggled in without the symbol either.
    assert.equal(json.includes('"75"') || json.includes(' 75 '), false, `${what} leaks the figure itself`);
  }

  // The coins did survive the cut — stripping the money must not leave a coach
  // with no reason for the creator to bother.
  const coach = JSON.stringify(sideQuestCoachEmbed(questsByCoach(board)[0], 'midpoint', { config, nightsLeft: 3 }));
  assert.ok(coach.includes('13,600'), 'coins at stake across both quests');
  assert.ok(JSON.stringify(sideQuestCardEmbed(board.quests[0], { config })).includes('coins'));
});
