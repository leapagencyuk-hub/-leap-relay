import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CaseStore, reconcile, acknowledge, recordAction, snooze, effectiveness, STATUS, isOpen } from '../lib/cases.mjs';
import { verifySignature, handleInteraction, INTERACTION, RESPONSE } from '../lib/interactions.mjs';
import { parseCustomId, customId, declineEmbed } from '../lib/discord.mjs';
import { playbookFor, PLAYBOOK, captureBaseline } from '../lib/playbook.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cases-'));

const baseConfig = (dataDir) => ({
  dataDir,
  cases: {
    openCasesForEarlySigns: false,
    openOpportunityCases: true,
    autoResolveClearDays: 3,
    escalateAfterDays: 3,
    escalateUrgentAfterDays: 1,
    maxOpenPerCoach: 2,
    maxOpenOpportunitiesPerCoach: 1,
    escalateMaxPerRun: 5,
  },
});

// A metrics object with just the fields the case layer reads.
function fakeMetrics({ diamonds = 5000, hours = 10, liveDays = 5, baseline = 20000 } = {}) {
  return {
    curr7: { diamonds, liveHours: hours, validLiveDays: liveDays, fanClubDiamonds: diamonds * 0.9 },
    prev7: { diamonds: baseline, liveHours: 20, validLiveDays: 6, fanClubDiamonds: baseline * 0.9 },
    change7: { diamonds: -0.5, liveHours: -0.5 },
    profile: {
      diamonds: { baseline, cv: 0.2, sd: 1000, mean: baseline },
      liveHours: { baseline: 20, cv: 0.2, sd: 2, mean: 20 },
      validLiveDays: { baseline: 6, cv: 0.1, sd: 0.5, mean: 6 },
    },
    diamondsPerHour28: 2000,
    diamondsPerHour7: diamonds / Math.max(hours, 0.5),
    dailyDiamonds7: diamonds / 7,
    darkStreak: 0,
    fanClub: { activeFans: 40 },
  };
}

function fakeAlert(username, coach, { severity = 'warn', codes = ['DIAMONDS_DOWN'], valueAtRisk = 10000, metrics, group = 'Team Test' } = {}) {
  const m = metrics ?? fakeMetrics();
  return {
    creator: { key: `id:${username}`, username, creatorId: username, group, manager: coach },
    metrics: m,
    severity,
    valueAtRisk,
    signals: codes.map((c) => ({ code: c, label: `${c} label`, detail: `${c} detail` })),
  };
}

const runReconcile = (store, config, { asOf, alerts = [], spotlight = [], creators = null }) => {
  const list = creators ?? alerts.map((a) => ({ ...a.creator, quitOn: null }));
  return reconcile({
    asOf, alerts, spotlight, store, config,
    creators: list,
    metricsByKey: new Map(alerts.map((a) => [a.creator.key, a.metrics])),
  });
};

test('an alert becomes a case with an intervention attached', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DARK', 'DIAMONDS_DOWN'] });
  const changes = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] });

  assert.equal(changes.opened.length, 1);
  const c = changes.opened[0];
  assert.equal(c.status, STATUS.OPEN);
  assert.equal(c.coach, 'coach@leap');
  // DARK outranks DIAMONDS_DOWN, so the phone-call playbook wins.
  assert.equal(c.playbookId, 'DARK');
  assert.ok(c.baseline.weeklyDiamonds > 0, 'pre-slide baseline is captured at open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second day does not open a second case for the same creator', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] });
  const day2 = runReconcile(store, config, { asOf: '2026-09-11', alerts: [alert] });
  assert.equal(day2.opened.length, 0);
  assert.equal(store.all().filter(isOpen).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a coach is never given more cases than they can work', () => {
  const dir = tmpDir();
  const config = baseConfig(dir); // maxOpenPerCoach: 2
  const store = new CaseStore(dir);
  const alerts = [
    fakeAlert('small', 'coach@leap', { valueAtRisk: 1000 }),
    fakeAlert('huge', 'coach@leap', { valueAtRisk: 90000 }),
    fakeAlert('medium', 'coach@leap', { valueAtRisk: 50000 }),
  ];
  const changes = runReconcile(store, config, { asOf: '2026-09-10', alerts });
  assert.equal(changes.opened.length, 2);
  assert.equal(changes.deferred.length, 1);
  // The slots go to the creators with the most to lose, not to whoever is first.
  assert.deepEqual(changes.opened.map((c) => c.username).sort(), ['huge', 'medium']);
  assert.equal(changes.deferred[0].username, 'small');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a case nobody picks up is escalated, and only once', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] });
  assert.equal(runReconcile(store, config, { asOf: '2026-09-12', alerts: [alert] }).escalated.length, 0);
  assert.equal(runReconcile(store, config, { asOf: '2026-09-13', alerts: [alert] }).escalated.length, 1);
  assert.equal(runReconcile(store, config, { asOf: '2026-09-14', alerts: [alert] }).escalated.length, 0,
    'escalation does not repeat every day');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a case closes itself once the creator has been clear for long enough', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  const creators = [{ ...alert.creator, quitOn: null }];

  for (const d of ['2026-09-11', '2026-09-12']) {
    runReconcile(store, config, { asOf: d, alerts: [], creators });
    assert.equal(store.get(c.id).status, STATUS.OPEN, `still open on ${d}`);
  }
  const final = runReconcile(store, config, { asOf: '2026-09-13', alerts: [], creators });
  assert.equal(final.autoResolved.length, 1);
  assert.equal(store.get(c.id).status, STATUS.RESOLVED);
  // Closed because it stopped alerting, but with no metrics to prove recovery
  // the verdict stays honest rather than claiming a win.
  assert.equal(store.get(c.id).outcome.unmeasured, true);
  assert.notEqual(store.get(c.id).outcome.verdict, 'recovered');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a creator who stops alerting without recovering is not counted as a win', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DIAMONDS_DOWN'] });
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  const creators = [{ ...alert.creator, quitOn: null }];
  // Quiet, but still running at a quarter of their old normal.
  const stillLow = new Map([[alert.creator.key, fakeMetrics({ diamonds: 5000, baseline: 20000 })]]);
  for (const d of ['2026-09-11', '2026-09-12', '2026-09-13']) {
    reconcile({ asOf: d, alerts: [], spotlight: [], store, config, creators, metricsByKey: stillLow });
  }
  const after = store.get(c.id);
  assert.equal(after.status, STATUS.RESOLVED, 'closed, because nothing is alerting');
  assert.notEqual(after.outcome.verdict, 'recovered', 'but not recorded as a recovery');
  const { byPlaybook } = effectiveness(store);
  assert.equal(byPlaybook.DIAMONDS_DOWN.untouched.recovered, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a snoozed creator does not generate a new case until it expires', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  snooze(store, c.id, 'josh', 14, 'on holiday', '2026-09-10');

  assert.equal(runReconcile(store, config, { asOf: '2026-09-15', alerts: [alert] }).opened.length, 0,
    'still snoozed');
  const after = runReconcile(store, config, { asOf: '2026-09-25', alerts: [alert] });
  assert.equal(store.get(c.id).status, STATUS.OPEN, 'the original case comes back');
  assert.equal(after.opened.length, 0, 'reopened rather than duplicated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acting on a case sets a follow-up, and the follow-up is graded from the data', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DIAMONDS_DOWN'] });
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;

  acknowledge(store, c.id, 'josh');
  const acted = recordAction(store, c.id, 'josh', 'Called, agreed 4 nights a week', '2026-09-10');
  assert.equal(store.get(c.id).status, STATUS.ACTIONED);
  // DIAMONDS_DOWN follows up after 10 days.
  assert.equal(acted.followUpOn, '2026-09-20');

  // Recovered to their pre-slide normal by the follow-up date.
  const recovered = fakeAlert('alpha', 'coach@leap', { metrics: fakeMetrics({ diamonds: 19000 }) });
  const changes = runReconcile(store, config, {
    asOf: '2026-09-20', alerts: [], creators: [{ ...recovered.creator, quitOn: null }],
  });
  // The creator no longer alerts, so supply metrics for grading directly.
  const graded = reconcile({
    asOf: '2026-09-20', alerts: [], spotlight: [], store, config,
    creators: [{ ...recovered.creator, quitOn: null }],
    metricsByKey: new Map([[recovered.creator.key, recovered.metrics]]),
  });
  const after = store.get(c.id);
  assert.ok(after.outcome, 'a verdict was recorded');
  assert.equal(after.outcome.verdict, 'recovered');
  assert.equal(after.status, STATUS.RESOLVED);
  assert.ok(changes || graded);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a follow-up that did not work hands the case back rather than closing it', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DIAMONDS_DOWN'] });
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  recordAction(store, c.id, 'josh', 'Sent a message', '2026-09-10');

  const stillDown = fakeAlert('alpha', 'coach@leap', { metrics: fakeMetrics({ diamonds: 4000 }) });
  reconcile({
    asOf: '2026-09-20', alerts: [stillDown], spotlight: [], store, config,
    creators: [{ ...stillDown.creator, quitOn: null }],
    metricsByKey: new Map([[stillDown.creator.key, stillDown.metrics]]),
  });
  const after = store.get(c.id);
  assert.notEqual(after.outcome.verdict, 'recovered');
  assert.equal(after.status, STATUS.OPEN, 'back in the queue');
  assert.equal(after.attempts, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a creator who leaves closes their cases as lost, not as a failure to fix', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  reconcile({
    asOf: '2026-09-11', alerts: [], spotlight: [], store, config,
    creators: [{ ...alert.creator, quitOn: '2026-09-11' }],
    metricsByKey: new Map(),
  });
  assert.equal(store.get(c.id).status, STATUS.LOST);
  assert.equal(store.get(c.id).outcome.verdict, 'quit');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Discord ----------------------------------------------------------------

test('a correctly signed interaction verifies and a tampered one does not', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 1 });
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex');

  assert.equal(verifySignature(raw, sig, timestamp, Buffer.from(body)), true);
  assert.equal(verifySignature(raw, sig, timestamp, Buffer.from('{"type":2}')), false, 'body tampered');
  assert.equal(verifySignature(raw, sig, '0', Buffer.from(body)), false, 'timestamp replayed');
  assert.equal(verifySignature(raw, 'ff'.repeat(64), timestamp, Buffer.from(body)), false, 'bad signature');
  assert.equal(verifySignature(raw, 'not-hex', timestamp, Buffer.from(body)), false, 'malformed input is rejected, not thrown');
});

test('Discord answers a PING with a PONG', async () => {
  const dir = tmpDir();
  const reply = await handleInteraction({ type: INTERACTION.PING }, { config: baseConfig(dir) });
  assert.equal(reply.type, RESPONSE.PONG);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('custom ids round-trip and junk is rejected', () => {
  assert.deepEqual(parseCustomId(customId('ack', 'D-260910-ab12')), { action: 'ack', caseId: 'D-260910-ab12' });
  assert.equal(parseCustomId('something-else'), null);
  assert.equal(parseCustomId(undefined), null);
});

test('clicking "On it" claims the case, and a second click says who has it', async () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap');
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;

  const click = {
    type: INTERACTION.COMPONENT,
    data: { custom_id: customId('ack', c.id) },
    member: { user: { username: 'josh' } },
    message: { embeds: [{ title: 'x', footer: { text: 'old' } }], components: [] },
  };
  const first = await handleInteraction(click, { config, asOf: '2026-09-10' });
  assert.equal(first.type, RESPONSE.UPDATE_MESSAGE);
  assert.match(first.data.embeds[0].footer.text, /picked up by josh/);
  assert.equal(new CaseStore(dir).get(c.id).status, STATUS.ACKNOWLEDGED);

  const second = await handleInteraction(
    { ...click, member: { user: { username: 'alex' } } }, { config, asOf: '2026-09-10' });
  assert.equal(second.type, RESPONSE.MESSAGE);
  assert.match(second.data.content, /Already picked up by josh/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('"Log what I did" opens a form, and submitting it starts the follow-up clock', async () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DARK'] });
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;

  const modal = await handleInteraction({
    type: INTERACTION.COMPONENT,
    data: { custom_id: customId('act', c.id) },
    member: { user: { username: 'josh' } },
  }, { config, asOf: '2026-09-10' });
  assert.equal(modal.type, RESPONSE.MODAL);
  assert.equal(modal.data.custom_id, `ch:actmodal:${c.id}`);

  const submitted = await handleInteraction({
    type: INTERACTION.MODAL_SUBMIT,
    data: {
      custom_id: `ch:actmodal:${c.id}`,
      components: [{ type: 1, components: [{ custom_id: 'note', value: 'Called, family emergency, back Monday' }] }],
    },
    member: { user: { username: 'josh' } },
    message: { embeds: [{ title: 'x', fields: [] }] },
  }, { config, asOf: '2026-09-10' });

  const after = new CaseStore(dir).get(c.id);
  assert.equal(after.status, STATUS.ACTIONED);
  assert.equal(after.followUpOn, '2026-09-17', 'DARK follows up after 7 days');
  assert.match(submitted.data.embeds[0].fields.at(-1).value, /family emergency/);
  assert.ok(after.history.some((h) => h.event === 'actioned' && h.note.includes('family emergency')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a button for a case that no longer exists fails politely', async () => {
  const dir = tmpDir();
  const reply = await handleInteraction({
    type: INTERACTION.COMPONENT,
    data: { custom_id: customId('ack', 'D-999999-dead') },
    member: { user: { username: 'josh' } },
  }, { config: baseConfig(dir), asOf: '2026-09-10' });
  assert.equal(reply.type, RESPONSE.MESSAGE);
  assert.match(reply.data.content, /no longer exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the card Discord receives is within its size limits', () => {
  const dir = tmpDir();
  const config = baseConfig(dir);
  const store = new CaseStore(dir);
  const alert = fakeAlert('alpha', 'coach@leap', { codes: ['DARK', 'HOURS_DOWN', 'DIAMONDS_DOWN'] });
  const [c] = runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened;
  const payload = declineEmbed(c, alert, { mention: '<@123>' });
  const embed = payload.embeds[0];

  assert.ok(embed.title.length <= 256, 'title within Discord limit');
  assert.ok(embed.description.length <= 4096, 'description within Discord limit');
  assert.ok(embed.fields.length <= 25, 'field count within Discord limit');
  for (const f of embed.fields) {
    assert.ok(f.name.length <= 256 && f.value.length <= 1024, `field "${f.name}" within limits`);
  }
  assert.equal(payload.components[0].components.length, 4);
  assert.ok(payload.components[0].components.every((b) => b.custom_id.length <= 100));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the effectiveness report counts outcomes per intervention', () => {
  const dir = tmpDir();
  const store = new CaseStore(dir);
  store.data.cases = {
    a: { id: 'a', coach: 'josh@leap', playbookId: 'DARK', openedOn: '2026-09-01', status: 'resolved',
      outcome: { verdict: 'recovered' }, history: [{ at: '2026-09-02T09:00:00Z', event: 'acknowledged' }, { at: '2026-09-02T10:00:00Z', event: 'actioned' }] },
    b: { id: 'b', coach: 'josh@leap', playbookId: 'DARK', openedOn: '2026-09-01', status: 'open',
      outcome: { verdict: 'no_change' }, history: [{ at: '2026-09-04T09:00:00Z', event: 'acknowledged' }] },
    c: { id: 'c', coach: 'alex@leap', playbookId: 'EFFICIENCY_DOWN', openedOn: '2026-09-01', status: 'open',
      outcome: { verdict: 'improved' }, history: [] },
    d: { id: 'd', coach: 'alex@leap', playbookId: 'DARK', openedOn: '2026-09-01', status: 'open',
      outcome: null, history: [] },
  };
  const { byPlaybook, byCoach } = effectiveness(store);
  // Case 'a' was actioned; 'b' was only acknowledged; 'd' has no verdict yet.
  assert.equal(byPlaybook.DARK.acted.total, 1);
  assert.equal(byPlaybook.DARK.untouched.total, 1, 'the ungraded case is not counted');
  assert.equal(byPlaybook.DARK.successRate, 1, 'the one coached case recovered');
  assert.equal(byPlaybook.DARK.baselineRate, 0, 'the untouched one did not');
  assert.equal(byPlaybook.DARK.lift, 1);
  assert.equal(byCoach['josh@leap'].acknowledged, 2);
  assert.equal(byCoach['josh@leap'].actioned, 1);
  assert.equal(byCoach['josh@leap'].medianPickupDays, 2, 'median of a 1-day and a 3-day pickup');
  assert.equal(byCoach['alex@leap'].acknowledged, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creators in an unmonitored team never become cases', () => {
  const dir = tmpDir();
  const config = { ...baseConfig(dir), monitoring: { ignoreGroups: ['Stay Social', 'TEAM TRUCKERS'] } };
  const store = new CaseStore(dir);
  const watched = fakeAlert('watched', 'coach@leap');
  const ignored = { ...fakeAlert('ignored', 'sol@leap'), creator: { ...fakeAlert('ignored', 'sol@leap').creator, group: 'Stay Social' } };

  const changes = runReconcile(store, config, { asOf: '2026-09-10', alerts: [watched, ignored] });
  assert.equal(changes.opened.length, 1);
  assert.equal(changes.opened[0].username, 'watched');
  assert.equal(changes.ignoredCreators, 1, 'and it is counted, not silently dropped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the team name is matched however the export spells it', () => {
  const dir = tmpDir();
  // config says "TEAM TRUCKERS"; the creator record says "Team Truckers ".
  const config = { ...baseConfig(dir), monitoring: { ignoreGroups: ['TEAM TRUCKERS'] } };
  const store = new CaseStore(dir);
  const base = fakeAlert('trucker', 'sen@leap');
  const alert = { ...base, creator: { ...base.creator, group: 'Team Truckers ' } };
  assert.equal(runReconcile(store, config, { asOf: '2026-09-10', alerts: [alert] }).opened.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ignoring a team closes the cases it already had', () => {
  const dir = tmpDir();
  const store = new CaseStore(dir);
  const base = fakeAlert('ratty', 'row@leap');
  const alert = { ...base, creator: { ...base.creator, group: 'Team Ratty' } };

  // Opened while the team was still monitored.
  const [c] = runReconcile(store, baseConfig(dir), { asOf: '2026-09-10', alerts: [alert] }).opened;
  assert.equal(c.status, STATUS.OPEN);

  // The team is then taken off the list.
  const now = { ...baseConfig(dir), monitoring: { ignoreGroups: ['Team Ratty'] } };
  runReconcile(store, now, { asOf: '2026-09-11', alerts: [alert] });
  const after = store.get(c.id);
  assert.equal(after.status, STATUS.RESOLVED, 'no stale cards for creators nobody is coaching');
  assert.ok(after.outcome.ignored);
  assert.ok(after.history.some((h) => h.note?.includes('no longer monitored')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the playbook picks the most urgent signal present', () => {
  assert.equal(playbookFor(['DIAMONDS_DOWN', 'DARK']).id, 'DARK');
  assert.equal(playbookFor(['FANCLUB_FANS_DOWN', 'EFFICIENCY_DOWN']).id, 'EFFICIENCY_DOWN');
  assert.equal(playbookFor(['NOT_A_REAL_SIGNAL']).id, 'DIAMONDS_DOWN', 'falls back rather than crashing');
  for (const [id, entry] of Object.entries(PLAYBOOK)) {
    assert.equal(entry.id, id, `${id} is keyed by its own id`);
    assert.ok(entry.followUpDays > 0 && typeof entry.test === 'function', `${id} is measurable`);
    assert.ok(entry.concern && entry.success, `${id} names the concern and what success is`);
  }
});
