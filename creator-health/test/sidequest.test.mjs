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
