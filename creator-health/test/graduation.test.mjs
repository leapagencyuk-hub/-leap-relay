import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graduationEvents, milestoneReached, graduationLadder, MILESTONES } from '../lib/graduation.mjs';
import { graduationEmbed } from '../lib/discord.mjs';
import { CaseStore } from '../lib/cases.mjs';

const config = {
  ramp: { targetDiamonds: 200000, windowDays: 90 },
  graduation: { enabled: true, finalPushDays: 5, finalPushReach: 50000, finalPushStretch: 4 },
};

/** One ramp row, with only the fields the graduation chase reads. */
const row = ({ username = 'c1', monthToDate = 0, daysLeft = 10, perDay = 5000, day = 40,
  attemptsLeft = 1, achievedIn = null, group = 'Team Alpha' } = {}) => ({
  creator: { key: username, username, group, manager: 'josh@leap', quitOn: null },
  day, month: '2026-09', daysLeftInMonth: daysLeft, monthToDate,
  currentPerDay: perDay, projected: monthToDate + perDay * daysLeft,
  attemptsLeft, achievedIn, bestMonth: { key: '2026-08', diamonds: 50000 },
  diamondsPerHour: 1500, status: 'AT_RISK',
});

const store = () => new CaseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-grad-')));
const run = (ramp, s, asOf = '2026-09-20', persist = true, cfg = config) =>
  graduationEvents({ ramp, store: s, asOf, config: cfg, persist });

test('the ladder is read in diamonds still to find', () => {
  assert.equal(milestoneReached(120000, false), null, '80,000 in is not yet a mark');
  assert.equal(milestoneReached(99000, false).key, 'M100K');
  assert.equal(milestoneReached(40000, false).key, 'M50K');
  assert.equal(milestoneReached(24000, false).key, 'M25K');
  assert.equal(milestoneReached(9000, false).key, 'M10K');
  assert.equal(milestoneReached(0, true).key, 'DONE');
});

test('each mark fires once, and a creator hovering on one does not fire again', () => {
  const s = store();
  // 55,000 short: inside 100,000, not yet inside 50,000.
  assert.equal(run([row({ monthToDate: 145000 })], s).milestones.length, 1);
  assert.equal(run([row({ monthToDate: 145000 })], s, '2026-09-21').milestones.length, 0);
  // Slips back out and comes in again — still silent.
  assert.equal(run([row({ monthToDate: 144000 })], s, '2026-09-22').milestones.length, 0);
  // Now crosses the next mark down.
  const next = run([row({ monthToDate: 160000 })], s, '2026-09-23');
  assert.equal(next.milestones[0].milestone.key, 'M50K');
  fs.rmSync(s.path, { force: true });
});

test('crossing two marks in a day reports the deeper one and names the other', () => {
  const s = store();
  const out = run([row({ monthToDate: 178000 })], s);   // 22,000 short: past 100k and 50k, inside 25k
  assert.equal(out.milestones[0].milestone.key, 'M25K');
  assert.deepEqual(out.milestones[0].alsoCrossed.map((m) => m.key), ['M100K', 'M50K']);
  const title = graduationEmbed(out.milestones[0]).embeds[0].title;
  assert.match(title, /22,000 to go/, 'the card leads with the real gap, not the mark');
});

test('a dry run does not spend the one card a mark gets', () => {
  const s = store();
  assert.equal(run([row({ monthToDate: 145000 })], s, '2026-09-20', false).milestones.length, 1);
  assert.equal(run([row({ monthToDate: 145000 })], s, '2026-09-20', true).milestones.length, 1,
    'previewing a card must not silently cost the real one');
});

test('the last days are pinged every morning, for creators genuinely in reach', () => {
  const s = store();
  // Already told about every mark it has passed, so only the push can fire.
  run([row({ monthToDate: 170000, daysLeft: 3, perDay: 9000 })], s, '2026-09-25');
  const d28 = run([row({ monthToDate: 175000, daysLeft: 3, perDay: 9000 })], s, '2026-09-28');
  const d29 = run([row({ monthToDate: 180000, daysLeft: 2, perDay: 9000 })], s, '2026-09-29');
  assert.equal(d28.finalPush.length + d28.milestones.length > 0, true);
  assert.equal(d29.finalPush.length, 1, 'the closing days repeat by design');
  // Twice in one day is still once.
  assert.equal(run([row({ monthToDate: 180000, daysLeft: 2, perDay: 9000 })], s, '2026-09-29').finalPush.length, 0);
  fs.rmSync(s.path, { force: true });
});

test('the closing ping is never a lie', () => {
  const s = store();
  // 45,000 short with 2 days left while doing 1,000 a day is 22x their rate.
  const out = run([row({ username: 'hopeless', monthToDate: 155000, daysLeft: 2, perDay: 1000 })], s, '2026-09-29');
  const pushed = out.finalPush.map((p) => p.username);
  assert.deepEqual(pushed, [], 'telling a coach to chase an impossible gap is how they stop reading');
});

test('a creator past day 90 is not in the chase, however big their month', () => {
  const s = store();
  const out = run([row({ username: 'toolate', day: 97, monthToDate: 208500, daysLeft: 0 })], s);
  assert.equal(out.rows.length, 0);
  assert.equal(out.milestones.length, 0, 'a 200k month after the window closed is not a graduation');
});

test('a creator who already graduated is not chased again', () => {
  const s = store();
  const out = run([row({ username: 'mature', monthToDate: 252527, achievedIn: '2026-08' })], s);
  assert.equal(out.rows.length, 0, 'they are a mature creator now, not a candidate');
});

test('graduating fires once and reads as done', () => {
  const s = store();
  const out = run([row({ username: 'made_it', monthToDate: 223638 })], s);
  assert.equal(out.milestones[0].milestone.key, 'DONE');
  assert.equal(out.milestones[0].done, true);
  const e = graduationEmbed(out.milestones[0]).embeds[0];
  assert.match(e.title, /Graduated/);
  assert.match(e.fields.at(-1).value, /resets on the 1st/, 'the target is monthly, and the card has to say so');
  assert.equal(run([row({ username: 'made_it', monthToDate: 240000 })], s, '2026-09-21').milestones.length, 0);
  fs.rmSync(s.path, { force: true });
});

test('the card never quotes two different rates for the same creator', () => {
  const s = store();
  const out = run([row({ monthToDate: 129958, daysLeft: 10, perDay: 5481 })], s);
  const p = out.milestones[0];
  assert.equal(p.projected, 129958 + 5481 * 10,
    'the projection has to be built from the rate the card prints as "doing"');
  const e = graduationEmbed(p).embeds[0];
  assert.equal(e.fields.find((f) => f.name === 'Finishes on').value, '184,768');
});

test('the last attempt is said out loud', () => {
  const s = store();
  const last = run([row({ username: 'lastgo', monthToDate: 145000, attemptsLeft: 0 })], s);
  assert.match(graduationEmbed(last.milestones[0]).embeds[0].fields.at(-2).value, /last month inside/);
});

test('the team ladder counts the chase and names who is close', () => {
  const s = store();
  const rows = run([
    row({ username: 'done1', monthToDate: 210000 }),
    row({ username: 'near', monthToDate: 195000 }),
    row({ username: 'mid', monthToDate: 160000 }),
    row({ username: 'far', monthToDate: 20000 }),
    row({ username: 'other', monthToDate: 195000, group: 'Team Bravo' }),
  ], s).rows;
  const l = graduationLadder(rows, 'Team Alpha');
  assert.equal(l.total, 4);
  assert.equal(l.graduated, 1);
  assert.deepEqual(l.within10k.map((r) => r.username), ['near']);
  assert.deepEqual(l.within50k.map((r) => r.username), ['mid']);
  assert.equal(l.further, 1);
  assert.deepEqual(l.closest.map((r) => r.username), ['near', 'mid'], 'closest first: that is where a day is best spent');
});

test('a whole month fires each mark exactly once', () => {
  const s = store();
  let fired = [];
  // A creator climbing steadily from zero to graduation over the month.
  for (let d = 1; d <= 30; d++) {
    const out = run([row({
      monthToDate: Math.round(210000 * (d / 30)), daysLeft: 30 - d, perDay: 7000,
    })], s, `2026-09-${String(d).padStart(2, '0')}`);
    fired.push(...out.milestones.map((m) => m.milestone.key));
  }
  assert.deepEqual(fired, ['M100K', 'M50K', 'M25K', 'M10K', 'DONE'],
    'every mark, in order, and none of them twice');
  assert.equal(new Set(fired).size, MILESTONES.length);
  fs.rmSync(s.path, { force: true });
});
