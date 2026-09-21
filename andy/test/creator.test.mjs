import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorData, describeCreator, describeCase, describeNetwork } from '../lib/creator.mjs';
import { resolveEnv, loadConfig } from '../lib/config.mjs';
import { Conversations } from '../lib/conversation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The shape creator-health's GET /creator/:name actually returns. */
const payload = (overrides = {}) => ({
  creator: { username: 'sur3shot', group: 'Team Alpha', manager: 'josh@leap.uk', quitOn: null, ...overrides.creator },
  metrics: {
    endDate: '2026-09-15',
    daysSinceJoining: 503,
    curr7: { diamonds: 15384, liveHours: 8, validLiveDays: 4 },
    change7: { diamonds: -0.43, liveHours: -0.25, validLiveDays: -0.33 },
    curr28: { diamonds: 80000, liveHours: 40 },
    darkStreak: 0,
    diamondsPerHour7: 1923,
    diamondsPerHour28: 2000,
    exact: { curr7: 7, prev7: 7, curr28: 28 },
    stale: 0,
    fanClub: { activeFans: 120, activeFansChange7: -0.1, share7: 0.5, diamondsChange7: -0.38 },
    lastMatch: '2026-08-02',
    matches28: 0,
    monthOnMonth: {
      dayOfMonth: 15, previousMonth: '2026-08',
      diamonds: { monthToDate: 31000, lastMonthToSamePoint: 60000, change: -0.48, projectedMonth: 62000 },
    },
    ...overrides.metrics,
  },
});

test('a creator reads as the numbers a coach would be given', () => {
  const text = describeCreator(payload());
  assert.match(text, /@sur3shot — Team Alpha, coached by josh@leap\.uk/);
  assert.match(text, /Diamonds\s+15,384\s+\(-43%\)/);
  assert.match(text, /LIVE days\s+4 of 7/);
  assert.match(text, /31,000 so far vs 60,000 by day 15 last month \(-48%\)/);
});

test('thin coverage is flagged, so no weekly figure is quoted as if it were solid', () => {
  const text = describeCreator(payload({ metrics: { exact: { curr7: 2, prev7: 1, curr28: 3 } } }));
  assert.match(text, /CAVEAT: only 2 and 1 real daily readings/);
  assert.match(text, /lean on the monthly comparison/);
});

test('full coverage adds no caveat', () => {
  assert.ok(!describeCreator(payload()).includes('CAVEAT'));
});

test('a creator who has left is marked as not actionable', () => {
  const text = describeCreator(payload({ creator: { quitOn: '2026-09-10' } }));
  assert.match(text, /LEFT THE NETWORK on 2026-09-10/);
});

test('never having run a campaign reads as a fact, not a blank', () => {
  const text = describeCreator(payload({ metrics: { lastMatch: null, matches28: 0 } }));
  assert.match(text, /never taken part in a campaign/);
});

test('a concentration risk is named rather than left for the model to spot', () => {
  const text = describeCreator(payload({ metrics: { fanClub: { activeFans: 50, activeFansChange7: -0.3, share7: 0.92, diamondsChange7: -0.4 } } }));
  assert.match(text, /concentration risk/);
});

test('inside the first 90 days, the 200k target is called out', () => {
  const text = describeCreator(payload({ metrics: { daysSinceJoining: 25 } }));
  assert.match(text, /still inside the first 90 days/);
});

test('a case shows what the coach already tried', () => {
  const lines = describeCase({
    id: 'D-260915-6627', kind: 'decline', severity: 'urgent', openedOn: '2026-09-15', status: 'actioned',
    coach: 'josh@leap.uk', group: 'Team Alpha', valueAtRisk: 90000,
    signals: ['LIVE_DAYS_DOWN', 'DIAMONDS_DOWN'],
    causes: [{ id: 'HOURS', kind: 'cause', label: 'Less hours, schedule slipped', confidence: 'likely', evidence: ['9 days with no LIVE at all'] }],
    history: [{ event: 'actioned', at: '2026-09-16', note: 'agreed a four-day schedule on a call' }],
    followUpOn: '2026-09-23',
  }).join('\n');
  assert.match(lines, /the data points at this/);
  assert.match(lines, /already tried \(2026-09-16\): agreed a four-day schedule/);
  assert.match(lines, /follow-up due 2026-09-23/);
});

test('the network summary leads with exposure, not an alphabetical list', () => {
  const text = describeNetwork({
    asOf: '2026-09-20',
    alerts: [
      { username: 'small', group: 'Team B', manager: 'a@b.c', severity: 'warn', valueAtRisk: 1000, signals: [{ code: 'HOURS_DOWN' }] },
      { username: 'iamscone', group: 'Not in a group', manager: 'x@y.z', severity: 'urgent', valueAtRisk: 679113, signals: [{ code: 'DIAMONDS_DOWN' }] },
    ],
    ramp: [{ username: 'baron', monthToDate: 91227, daysLeftInMonth: 10, requiredPerDay: 10877, currentPerDay: 4231, lever: 'days', onBoostList: true }],
  });
  assert.ok(text.indexOf('@iamscone') < text.indexOf('@small'), 'the biggest exposure should come first');
  assert.match(text, /1 urgent/);
  assert.match(text, /@baron — 91,227\/200,000, 10 days left/);
});

test('the client is disabled rather than broken when the URL is unset', async () => {
  const data = new CreatorData({});
  assert.equal(data.enabled, false);
  await assert.rejects(() => data.creator('x'), /CREATOR_HEALTH_URL is not set/);
});

test('a leading @ is stripped before the lookup', async () => {
  const calls = [];
  const data = new CreatorData({ baseUrl: 'http://x' });
  data.get = async (p) => { calls.push(p); return null; };
  await data.creator('@sur3shot');
  assert.deepEqual(calls, ['/creator/sur3shot']);
});

// --- config ------------------------------------------------------------------

test('env: references resolve, and an unset one is null rather than the literal', () => {
  process.env.ANDY_TEST_VALUE = 'resolved';
  assert.equal(resolveEnv('env:ANDY_TEST_VALUE'), 'resolved');
  assert.equal(resolveEnv('env:ANDY_TEST_MISSING'), null);
  assert.equal(resolveEnv('literal'), 'literal');
  delete process.env.ANDY_TEST_VALUE;
});

test('an empty environment variable counts as unset, not as an empty token', () => {
  process.env.ANDY_TEST_EMPTY = '';
  assert.equal(resolveEnv('env:ANDY_TEST_EMPTY'), null);
  delete process.env.ANDY_TEST_EMPTY;
});

test('the shipped config loads and documentation keys are dropped', () => {
  const config = loadConfig();
  assert.equal(config.answer.model, 'claude-opus-5');
  assert.ok(!('_provider' in config.embeddings), 'underscore keys are documentation, not settings');
  assert.ok(Array.isArray(config.monitoring?.ignoreGroups ?? []));
});

// --- conversations -----------------------------------------------------------

test('a thread remembers its turns and forgets the oldest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-conv-'));
  const conversations = new Conversations(dir, { maxTurns: 2 });
  conversations.push('t1', 'one', 'a');
  conversations.push('t1', 'two', 'b');
  conversations.push('t1', 'three', 'c');
  const history = conversations.get('t1');
  assert.equal(history.length, 4);
  assert.equal(history[0].content, 'two', 'the oldest turn should have dropped off');
  assert.deepEqual(new Conversations(dir, { maxTurns: 2 }).get('t1'), history, 'it should survive a restart');
});

test('two threads do not share memory', () => {
  const conversations = new Conversations(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-conv-')), { maxTurns: 4 });
  conversations.push('a', 'about sur3shot', 'x');
  conversations.push('b', 'about someone else', 'y');
  assert.equal(conversations.get('a').length, 2);
  assert.ok(!JSON.stringify(conversations.get('b')).includes('sur3shot'));
});

test('a bare host:port from Render service wiring is given a scheme', async () => {
  const { normaliseBase } = await import('../lib/creator.mjs');
  assert.equal(normaliseBase('leap-creator-health:10000'), 'http://leap-creator-health:10000');
  assert.equal(normaliseBase('https://ch.example.com/'), 'https://ch.example.com');
  assert.equal(normaliseBase('http://x:1'), 'http://x:1');
  assert.equal(normaliseBase(null), '');
  assert.equal(new CreatorData({ baseUrl: 'leap-creator-health:10000' }).enabled, true);
});
