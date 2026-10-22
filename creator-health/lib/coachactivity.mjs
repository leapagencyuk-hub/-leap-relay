// Who actually opens the portal.
//
// A tool nobody opens is a tool that does not exist, and until now there was no
// way to tell the difference. This records one line per coach per day — the
// days they came, and the last time — so a director can see whether the thing
// is being used before concluding it is not working.
//
// What it deliberately does NOT record: what they looked at, how long they
// stayed, which creators they opened. The question is "is this coach using the
// tool", not "watch this coach work", and a tool that reports the second to
// their boss is one they will stop opening honestly.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'coach-activity.json';

const monthOf = (iso) => String(iso).slice(0, 7);

function filePath(dataDir) { return path.join(dataDir, FILE); }

export function readActivity(dataDir) {
  try {
    const p = filePath(dataDir);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

/**
 * Note that this coach opened the portal today.
 *
 * Days, not visits: somebody refreshing a page eleven times has not used it
 * eleven times, and a counter that says they did would make the most anxious
 * coach look like the most engaged one.
 */
export function recordVisit(dataDir, coach, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!coach || coach === '*') return null;
  const key = String(coach).toLowerCase();
  const all = readActivity(dataDir);
  const mine = all[key] ?? { days: [], lastSeen: null };
  if (!mine.days.includes(today)) mine.days.push(today);
  // Two months is all a monthly board can use, and it keeps the file small.
  const cutoff = monthOf(today);
  mine.days = mine.days.filter((d) => d >= `${cutoff.slice(0, 4)}-01-01`).slice(-80);
  mine.lastSeen = today;
  all[key] = mine;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${filePath(dataDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, filePath(dataDir));
  } catch { /* a lost visit is not worth failing a page render over */ }
  return mine;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** What one coach's usage looks like, as of a given day. */
export function activityFor(all, coach, asOf) {
  const mine = all[String(coach ?? '').toLowerCase()];
  const month = monthOf(asOf);
  const days = (mine?.days ?? []).filter((d) => monthOf(d) === month);
  const lastSeen = mine?.lastSeen ?? null;
  return {
    lastSeen,
    daysSince: lastSeen ? Math.max(0, daysBetween(lastSeen, asOf)) : null,
    daysThisMonth: days.length,
    everOpened: Boolean(lastSeen),
  };
}

/**
 * The directors' board: is each coach using the tool, and is their team moving.
 *
 * Engagement and results side by side on purpose. Either one alone is
 * misleading — a coach who opens it daily and whose team is falling is a
 * different conversation from one who never opens it and whose team is flying,
 * and a board showing only one of the two columns invites the wrong one.
 */
export function coachPerformance({ portal, activity, asOf, config = {} }) {
  const rows = portal.coaches.map((c) => {
    const use = activityFor(activity, c.coach, asOf);
    const rev = c.earnings;
    const change = c.rows.length
      ? c.rows.reduce((n, r) => n + (r.month?.diamonds?.then ?? 0), 0)
      : 0;
    const now = c.rows.reduce((n, r) => n + (r.month?.diamonds?.now ?? 0), 0);
    return {
      coach: c.coach,
      name: c.name,
      roster: c.counts.roster,
      diamonds: now,
      lastMonthToDate: Math.round(change),
      // Team against itself at the same point last month, which is the only
      // comparison that is fair to a coach who took the team on recently.
      growth: change > 0 ? (now - change) / change : null,
      recruited: rev?.recruited ?? 0,
      leaped: rev?.leapedCount ?? 0,
      rankUps: c.banked.filter((r) => r.rank?.rankedUp).length,
      maintains: c.banked.filter((r) => r.rank?.maintained).length,
      urgent: c.counts.act,
      // The open caseload, which is the part a coach is meant to work down.
      openCases: c.cases?.length ?? 0,
      ...use,
      earningsHidden: c.earningsHidden,
      pay: c.earnings?.total ?? null,
    };
  });
  const seenCutoff = config.portal?.staleCoachDays ?? 7;
  return {
    asOf,
    rows: rows.sort((a, b) => b.diamonds - a.diamonds),
    usingIt: rows.filter((r) => r.daysSince != null && r.daysSince <= seenCutoff).length,
    neverOpened: rows.filter((r) => !r.everOpened).length,
    seenCutoff,
  };
}
