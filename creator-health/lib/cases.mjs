// Case management: the difference between a monitoring tool and a support system.
//
// An alert is an event — it fires and it is gone. A case is a thing someone owns
// until it is closed. Cases give three things a raw alert cannot:
//
//   1. A coach can be chased. "Open, unacknowledged, 3 days" is actionable in a
//      way that "we sent a message on Tuesday" is not.
//   2. Repeat alerts collapse into the case that is already open, so a creator
//      who has been struggling for a fortnight generates one thread, not fourteen.
//   3. Every intervention gets a verdict, measured from the data on a schedule.
//      After a few months that answers the question the whole tool exists for:
//      which kinds of help actually work, and for whom.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { captureBaseline, playbookFor, PLAYBOOK } from './playbook.mjs';
import { rankCauses } from './causes.mjs';
import { groupKey } from './notify.mjs';

export const STATUS = {
  OPEN: 'open',                 // raised, nobody has picked it up
  ACKNOWLEDGED: 'acknowledged', // a coach has taken it on
  ACTIONED: 'actioned',         // the coach has done something; the clock is running
  RESOLVED: 'resolved',         // recovered, or closed by hand
  SNOOZED: 'snoozed',           // known reason, suppressed for a while
  LOST: 'lost',                 // creator left the network
};

const OPEN_STATES = new Set([STATUS.OPEN, STATUS.ACKNOWLEDGED, STATUS.ACTIONED]);
export const isOpen = (c) => OPEN_STATES.has(c.status);

const addDays = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Short, unambiguous, and quotable out loud on a call. */
function newCaseId(kind, asOf) {
  const prefix = kind === 'opportunity' ? 'O' : 'D';
  return `${prefix}-${asOf.replace(/-/g, '').slice(2)}-${crypto.randomBytes(2).toString('hex')}`;
}

export class CaseStore {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'cases.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = fs.existsSync(this.path)
      ? JSON.parse(fs.readFileSync(this.path, 'utf8'))
      : { cases: {}, updatedAt: null };
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.path);
  }

  all() { return Object.values(this.data.cases); }
  get(id) { return this.data.cases[id] ?? null; }
  openFor(creatorKey, kind) {
    return this.all().find((c) => c.creatorKey === creatorKey && c.kind === kind && isOpen(c)) ?? null;
  }
  /**
   * A creator we have deliberately stopped raising, for now.
   *
   * Two ways that happens: somebody snoozed them, or a case was closed for
   * going stale and is on a cooling-off period. Without the second, a stale
   * close would reopen the same case the very next morning.
   */
  suppressedFor(creatorKey, kind, asOf) {
    return this.all().find((c) => c.creatorKey === creatorKey && c.kind === kind
      && ((c.status === STATUS.SNOOZED && c.snoozedUntil > asOf)
        || (c.reopenAfter && c.reopenAfter > asOf))) ?? null;
  }

  log(c, event, { by = 'system', note = null, at = null } = {}) {
    c.history.push({ at: at ?? new Date().toISOString(), by, event, note });
  }
}

/**
 * Reconcile today's findings with the open caseload.
 *
 * Returns what changed rather than what exists, because that is what gets
 * posted to Discord: newly opened cases, cases that got worse, cases whose
 * follow-up is due, cases nobody has picked up, and cases that resolved
 * themselves.
 */
export function reconcile({ asOf, alerts, spotlight, metricsByKey, creators, store, config }) {
  const cfg = config.cases;
  const opened = [];
  const escalated = [];
  const dueFollowUps = [];
  const autoResolved = [];
  const worsened = [];

  const byKey = new Map(creators.map((c) => [c.key, c]));
  const alertByKey = new Map(alerts.map((a) => [a.creator.key, a]));
  const deferred = [];

  // Teams nobody is coaching. Their data keeps accruing — ignoring a team is a
  // decision that can be reversed, and the history has to be there when it is —
  // but no case is opened and nothing is posted about them.
  const ignored = new Set((config.monitoring?.ignoreGroups ?? []).map(groupKey));
  const isIgnored = (creator) => ignored.has(groupKey(creator?.group));

  // Lift expired snoozes first. If this ran after the opening pass, a creator
  // whose snooze ended today would get a second case opened alongside the one
  // being woken up.
  for (const c of store.all()) {
    if (c.status === STATUS.SNOOZED && c.snoozedUntil && c.snoozedUntil <= asOf) {
      c.status = STATUS.OPEN;
      store.log(c, 'unsnoozed');
    }
  }

  // How many cases each coach is already carrying. A queue longer than a coach
  // can work is not a queue, it is a way of looking busy: past the limit the
  // extra cards get ignored and the important ones get ignored with them. So
  // the caseload is capped, the highest-value creators get the slots, and the
  // rest wait for one to close.
  const openPerCoach = new Map();
  for (const c of store.all()) {
    if (!isOpen(c)) continue;
    const bucket = openPerCoach.get(c.coach) ?? { decline: 0, opportunity: 0 };
    bucket[c.kind]++;
    openPerCoach.set(c.coach, bucket);
  }
  const headroom = (coach, kind) => {
    const limit = kind === 'decline' ? cfg.maxOpenPerCoach : cfg.maxOpenOpportunitiesPerCoach;
    const used = (openPerCoach.get(coach) ?? { decline: 0, opportunity: 0 })[kind];
    return limit - used;
  };
  const take = (coach, kind) => {
    const bucket = openPerCoach.get(coach) ?? { decline: 0, opportunity: 0 };
    bucket[kind]++;
    openPerCoach.set(coach, bucket);
  };

  // --- open or update decline cases -----------------------------------------
  // Worst first, so that when a coach is at their limit the slots hold the
  // creators with the most to lose.
  const declineCandidates = [...alerts].sort((a, b) => b.valueAtRisk - a.valueAtRisk);

  for (const alert of declineCandidates) {
    if (alert.severity === 'watch' && !cfg.openCasesForEarlySigns) continue;
    if (isIgnored(alert.creator)) continue;
    const key = alert.creator.key;
    if (store.suppressedFor(key, 'decline', asOf)) continue;

    const existing = store.openFor(key, 'decline');
    const codes = alert.signals.map((s) => s.code);

    if (!existing) {
      const coach = alert.creator.manager ?? 'unassigned';
      if (headroom(coach, 'decline') <= 0) {
        deferred.push({ username: alert.creator.username, coach, valueAtRisk: alert.valueAtRisk });
        continue;
      }
      const book = playbookFor(codes);
      const c = {
        id: newCaseId('decline', asOf),
        kind: 'decline',
        creatorKey: key,
        username: alert.creator.username,
        creatorId: alert.creator.creatorId,
        group: alert.creator.group,
        coach: alert.creator.manager ?? 'unassigned',
        openedOn: asOf,
        severity: alert.severity,
        signals: codes,
        playbookId: book.id,
        baseline: captureBaseline(alert.metrics),
        // Which evidence this case was raised on, so the card and the
        // follow-up are judged the same way it was opened.
        weekly: alert.weekly !== false,
        // Ranked at the moment the case opens, against the data as it looked
        // then. Re-ranking later would quietly rewrite the coach's starting
        // point after they had already acted on it.
        causes: rankCauses(alert.metrics, { weekly: alert.weekly !== false }),
        valueAtRisk: alert.valueAtRisk,
        status: STATUS.OPEN,
        followUpOn: null,
        snoozedUntil: null,
        escalatedOn: null,
        outcome: null,
        discord: null,
        history: [],
      };
      store.log(c, 'opened', { note: `${alert.severity}: ${codes.join(', ')}` });
      store.data.cases[c.id] = c;
      take(coach, 'decline');
      opened.push(c);
      continue;
    }

    // Already open. Record deterioration, but do not re-notify for noise.
    const grew = SEVERITY_RANK[alert.severity] > SEVERITY_RANK[existing.severity];
    const newCodes = codes.filter((x) => !existing.signals.includes(x));
    if (grew || newCodes.length) {
      existing.severity = grew ? alert.severity : existing.severity;
      existing.signals = [...new Set([...existing.signals, ...codes])];
      existing.valueAtRisk = alert.valueAtRisk;
      // A case that gets worse often gets worse for a new reason, so the
      // ranking is refreshed here even though the opening one is preserved
      // in the history.
      existing.causes = rankCauses(alert.metrics, { weekly: alert.weekly !== false });
      store.log(existing, 'worsened', {
        note: grew ? `escalated to ${alert.severity}` : `new signals: ${newCodes.join(', ')}`,
      });
      worsened.push(existing);
    }
  }

  // --- open opportunity cases for the boost list ----------------------------
  if (cfg.openOpportunityCases) {
    for (const row of spotlight) {
      const key = row.creator.key;
      if (isIgnored(row.creator)) continue;
      if (store.openFor(key, 'opportunity') || store.suppressedFor(key, 'opportunity', asOf)) continue;
      const coach = row.creator.manager ?? 'unassigned';
      if (headroom(coach, 'opportunity') <= 0) {
        deferred.push({ username: row.creator.username, coach, valueAtRisk: 0, kind: 'opportunity' });
        continue;
      }
      const m = metricsByKey.get(key);
      const c = {
        id: newCaseId('opportunity', asOf),
        kind: 'opportunity',
        creatorKey: key,
        username: row.creator.username,
        creatorId: row.creator.creatorId,
        group: row.creator.group,
        coach: row.creator.manager ?? 'unassigned',
        openedOn: asOf,
        severity: 'opportunity',
        signals: ['OPPORTUNITY'],
        playbookId: 'OPPORTUNITY',
        baseline: captureBaseline(m),
        causes: rankCauses(m),
        context: {
          day: row.day, daysLeft: row.daysLeft, earned: row.earned,
          requiredPerDay: row.requiredPerDay, currentPerDayAtOpen: row.currentPerDay,
          lever: row.plan.lever, ask: row.plan.ask, diamondsPerHour: row.diamondsPerHour,
        },
        valueAtRisk: 0,
        status: STATUS.OPEN,
        followUpOn: null, snoozedUntil: null, escalatedOn: null,
        outcome: null, discord: null, history: [],
      };
      store.log(c, 'opened', { note: `day ${row.day}, needs ${row.requiredPerDay}/day` });
      store.data.cases[c.id] = c;
      take(coach, 'opportunity');
      opened.push(c);
    }
  }

  // --- walk the open caseload ----------------------------------------------
  for (const c of store.all()) {
    if (!isOpen(c)) continue;

    const creator = byKey.get(c.creatorKey);

    // A team added to the ignore list after the fact still has open cases.
    // Close them rather than leaving a coach with cards for creators the
    // network has decided not to monitor.
    if (isIgnored(creator) || isIgnored(c)) {
      c.status = STATUS.RESOLVED;
      c.outcome = { on: asOf, verdict: 'no_change', ignored: true };
      store.log(c, 'closed', { note: `${c.group ?? 'their team'} is no longer monitored` });
      continue;
    }

    if (creator?.quitOn) {
      c.status = STATUS.LOST;
      c.outcome = { on: asOf, verdict: 'quit' };
      store.log(c, 'lost', { note: `creator quit on ${creator.quitOn}` });
      continue;
    }

    // A decline case closes itself when the creator stops tripping any rule and
    // has been back at their normal level for a few days.
    if (c.kind === 'decline' && !alertByKey.has(c.creatorKey)) {
      c.clearDays = (c.clearDays ?? 0) + 1;
      if (c.clearDays >= cfg.autoResolveClearDays) {
        // No longer tripping any rule is not the same as being better. A
        // creator can stop alerting simply because their lower output has
        // become their new normal, and recording that as a recovery would
        // make every intervention look like it worked.
        const m = metricsByKey.get(c.creatorKey);
        const book = PLAYBOOK[c.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
        const verdict = m ? book.test(m, c) : 'no_change';
        c.status = STATUS.RESOLVED;
        c.outcome = { on: asOf, verdict, auto: true, unmeasured: !m };
        store.log(c, 'auto-resolved', { note: `${c.clearDays} clear days — ${verdict}` });
        autoResolved.push(c);
        continue;
      }
    } else {
      c.clearDays = 0;
    }

    const age = daysBetween(c.openedOn, asOf);
    const stillDeclining = alertByKey.has(c.creatorKey);

    // Escalation.
    //
    // With buttons, "nobody has picked this up" is the signal. Without them
    // every case looks unacknowledged forever, so escalating on that would
    // send the entire caseload to the managers' channel every few days. In
    // non-interactive mode the data has to say it instead: still open, still
    // declining, after long enough that something should have changed.
    if (!c.escalatedOn) {
      const limit = c.severity === 'urgent' ? cfg.escalateUrgentAfterDays : cfg.escalateAfterDays;
      const unacknowledged = c.status === STATUS.OPEN;
      const shouldEscalate = cfg.interactive
        ? unacknowledged && age >= limit
        : stillDeclining && age >= (cfg.escalateNoChangeAfterDays ?? limit * 2);
      if (shouldEscalate) {
        c.escalatedOn = asOf;
        store.log(c, 'escalated', {
          note: cfg.interactive ? `${age} days unacknowledged` : `${age} days open and still declining`,
        });
        escalated.push(c);
      }
    }

    // Closing a case that has gone stale.
    //
    // Nothing closes a case in non-interactive mode except recovery, so
    // without this the per-coach limit fills with cases nobody can clear and
    // new findings stop coming through entirely. Closing frees the slot; the
    // cooling-off period stops it reopening the next morning.
    if (cfg.maxOpenDays && age >= cfg.maxOpenDays && c.status !== STATUS.ACTIONED) {
      const metrics = metricsByKey.get(c.creatorKey);
      const book = PLAYBOOK[c.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
      const verdict = metrics ? book.test(metrics, c) : 'no_change';
      c.status = STATUS.RESOLVED;
      c.outcome = { on: asOf, verdict, stale: true, unmeasured: !metrics };
      c.reopenAfter = addDays(asOf, cfg.reopenCooldownDays ?? 7);
      store.log(c, 'closed-stale', { note: `${age} days open — ${verdict}` });
      autoResolved.push(c);
      continue;
    }

    // The coach acted and the follow-up window has elapsed: grade it.
    if (c.status === STATUS.ACTIONED && c.followUpOn && c.followUpOn <= asOf && !c.outcome) {
      const m = metricsByKey.get(c.creatorKey);
      if (m) {
        const book = PLAYBOOK[c.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
        const verdict = book.test(m, c);
        c.outcome = {
          on: asOf,
          verdict,
          measured: {
            weeklyDiamonds: Math.round(m.curr7.diamonds),
            weeklyHours: Number(m.curr7.liveHours.toFixed(1)),
            weeklyLiveDays: Number(m.curr7.validLiveDays.toFixed(1)),
            activeFanClubFans: m.fanClub.activeFans,
          },
        };
        store.log(c, 'followed-up', { note: verdict });
        if (verdict === 'recovered') {
          c.status = STATUS.RESOLVED;
        } else {
          // Not fixed. Hand it back with the clock reset rather than closing it.
          c.status = STATUS.OPEN;
          c.followUpOn = null;
          c.attempts = (c.attempts ?? 1) + 1;
        }
        dueFollowUps.push(c);
      }
    }
  }

  // Escalate the worst few, not everything overdue. A managers' channel that
  // gets fifty names in one post is a channel nobody reads.
  escalated.sort((a, b) => b.valueAtRisk - a.valueAtRisk);
  const escalatedNow = escalated.slice(0, cfg.escalateMaxPerRun);
  for (const c of escalated.slice(cfg.escalateMaxPerRun)) {
    // Un-mark the ones we held back so they are escalated on a later day.
    c.escalatedOn = null;
    c.history = c.history.filter((h) => h.event !== 'escalated' || h.at.slice(0, 10) !== asOf);
  }

  store.save();
  const ignoredCreators = creators.filter((c) => !c.quitOn && isIgnored(c)).length;
  return {
    opened, worsened, escalated: escalatedNow, dueFollowUps, autoResolved, deferred,
    ignoredCreators, ignoredGroups: [...ignored],
  };
}

const SEVERITY_RANK = { opportunity: 0, watch: 1, warn: 2, urgent: 3 };

// --- transitions driven by a coach ------------------------------------------

export function acknowledge(store, caseId, who) {
  const c = store.get(caseId);
  if (!c) return { ok: false, error: 'case not found' };
  if (!isOpen(c)) return { ok: false, error: `case is ${c.status}` };
  c.status = STATUS.ACKNOWLEDGED;
  c.acknowledgedBy = who;
  store.log(c, 'acknowledged', { by: who });
  store.save();
  return { ok: true, case: c };
}

export function recordAction(store, caseId, who, note, asOf) {
  const c = store.get(caseId);
  if (!c) return { ok: false, error: 'case not found' };
  const book = PLAYBOOK[c.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
  c.status = STATUS.ACTIONED;
  c.acknowledgedBy = c.acknowledgedBy ?? who;
  c.followUpOn = addDays(asOf, book.followUpDays);
  c.outcome = null;
  store.log(c, 'actioned', { by: who, note });
  store.save();
  return { ok: true, case: c, followUpOn: c.followUpOn };
}

export function snooze(store, caseId, who, days, note, asOf) {
  const c = store.get(caseId);
  if (!c) return { ok: false, error: 'case not found' };
  c.status = STATUS.SNOOZED;
  c.snoozedUntil = addDays(asOf, days);
  store.log(c, 'snoozed', { by: who, note: note ? `${days}d: ${note}` : `${days}d` });
  store.save();
  return { ok: true, case: c };
}

export function resolve(store, caseId, who, note) {
  const c = store.get(caseId);
  if (!c) return { ok: false, error: 'case not found' };
  c.status = STATUS.RESOLVED;
  c.outcome = c.outcome ?? { on: new Date().toISOString().slice(0, 10), verdict: 'no_change', manual: true };
  store.log(c, 'resolved', { by: who, note });
  store.save();
  return { ok: true, case: c };
}

/**
 * Which interventions actually work.
 *
 * This is the report that justifies the whole system: graded outcomes per
 * playbook entry, plus how long coaches take to pick a case up. It needs a few
 * months of cases before it means anything, which is the point of recording
 * from day one.
 */
/**
 * How each team's caseload actually resolves.
 *
 * This is the answer to "can we tell if a coach is doing nothing?" without
 * anyone clicking anything. A team whose flagged creators recover is working;
 * a team whose cases all run to the stale limit still declining is not. It
 * cannot see *what* a coach did — only whether the creators got better, which
 * is the thing that matters.
 */
export function teamOutcomes(store, { now = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = {};
  for (const c of store.all()) {
    if (c.kind !== 'decline') continue;
    const key = c.group ?? '(no team)';
    const r = (rows[key] ??= {
      team: key, coaches: new Set(), opened: 0, recovered: 0, improved: 0,
      wentStale: 0, lost: 0, open: 0, daysToRecover: [], oldestOpenDays: 0,
    });
    if (c.coach) r.coaches.add(c.coach);
    r.opened++;

    if (isOpen(c)) {
      r.open++;
      r.oldestOpenDays = Math.max(r.oldestOpenDays, daysBetween(c.openedOn, now));
      continue;
    }
    if (c.status === STATUS.LOST) { r.lost++; continue; }
    if (c.outcome?.verdict === 'recovered') {
      r.recovered++;
      if (c.outcome.on) r.daysToRecover.push(daysBetween(c.openedOn, c.outcome.on));
    } else if (c.outcome?.verdict === 'improved') {
      r.improved++;
    }
    // A case that ran to the limit without getting better is the signal that
    // nothing was done, or that what was done did not work.
    if (c.outcome?.stale && !['recovered', 'improved'].includes(c.outcome.verdict)) r.wentStale++;
  }

  return Object.values(rows).map((r) => {
    const closed = r.opened - r.open;
    const sorted = r.daysToRecover.slice().sort((a, b) => a - b);
    return {
      ...r,
      coaches: [...r.coaches],
      closed,
      recoveryRate: closed ? Number((r.recovered / closed).toFixed(2)) : null,
      staleRate: closed ? Number((r.wentStale / closed).toFixed(2)) : null,
      medianDaysToRecover: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      daysToRecover: undefined,
    };
  }).sort((a, b) => b.opened - a.opened);
}

export function effectiveness(store) {
  const byPlaybook = {};
  const byCoach = {};
  const bucket = () => ({ total: 0, recovered: 0, improved: 0, no_change: 0, worse: 0, quit: 0 });

  for (const c of store.all()) {
    if (!c.outcome) continue;
    // Plenty of flagged creators come back on their own. Counting those as
    // coaching wins would make every intervention look perfect and tell us
    // nothing. Split them out: cases a coach acted on measure the
    // intervention, cases nobody touched measure what happens anyway.
    const acted = c.history.some((h) => h.event === 'actioned');
    const p = (byPlaybook[c.playbookId] ??= { acted: bucket(), untouched: bucket() });
    const side = acted ? p.acted : p.untouched;
    side.total++;
    side[c.outcome.verdict] = (side[c.outcome.verdict] ?? 0) + 1;

    const ack = c.history.find((h) => h.event === 'acknowledged');
    const b = (byCoach[c.coach] ??= {
      cases: 0, acknowledged: 0, actioned: 0, recoveredAfterAction: 0, pickupDays: [],
    });
    b.cases++;
    if (ack) {
      b.acknowledged++;
      b.pickupDays.push(daysBetween(c.openedOn, ack.at.slice(0, 10)));
    }
    if (acted) {
      b.actioned++;
      if (c.outcome.verdict === 'recovered') b.recoveredAfterAction++;
    }
  }

  for (const b of Object.values(byCoach)) {
    const sorted = b.pickupDays.slice().sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    b.medianPickupDays = sorted.length
      ? Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
      : null;
    delete b.pickupDays;
  }

  for (const p of Object.values(byPlaybook)) {
    const rate = (s) => (s.total ? s.recovered / s.total : null);
    p.successRate = rate(p.acted) == null ? null : Number(rate(p.acted).toFixed(2));
    p.baselineRate = rate(p.untouched) == null ? null : Number(rate(p.untouched).toFixed(2));
    // The number that answers "is this intervention worth the coach's hour?"
    p.lift = p.successRate != null && p.baselineRate != null
      ? Number((p.successRate - p.baselineRate).toFixed(2))
      : null;
  }
  return { byPlaybook, byCoach };
}
