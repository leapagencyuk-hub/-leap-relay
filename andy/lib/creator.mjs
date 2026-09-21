// The link to the creator data.
//
// This is what makes Andy more than a search box over a folder of PDFs. Asked
// "what do we do about @sur3shot", Andy reads the same numbers the coach's card
// was raised on — this week against last, the ranked causes, the open case and
// what has already been tried — and then goes looking in the library for the
// part that applies to *that*. Advice about creators in general is worth very
// little; advice about this creator, this week, is the whole point.
//
// It talks to creator-health over HTTP rather than reading its data directory,
// because the two are separate Render services with separate disks. That also
// means Andy never has to know how a snapshot is stored, only what it means.

const CONFIDENCE_LABEL = {
  likely: 'the data points at this',
  possible: 'consistent with the data',
  ask: 'worth ruling out',
};

export class CreatorData {
  constructor(settings = {}) {
    this.baseUrl = normaliseBase(settings.baseUrl);
    this.token = settings.token ?? null;
    this.timeoutMs = settings.timeoutMs ?? 12000;
  }

  get enabled() { return Boolean(this.baseUrl); }

  async get(path) {
    if (!this.enabled) throw new Error('CREATOR_HEALTH_URL is not set');
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`creator-health ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  creator(username) {
    return this.get(`/creator/${encodeURIComponent(String(username).replace(/^@/, ''))}`);
  }

  cases({ coach = null, all = false } = {}) {
    const params = new URLSearchParams();
    if (coach) params.set('coach', coach);
    if (all) params.set('all', '1');
    return this.get(`/cases${params.toString() ? `?${params}` : ''}`);
  }

  report() { return this.get('/report.json'); }

  health() { return this.get('/health'); }
}

/**
 * Accept a bare host:port as well as a full URL.
 *
 * Render's `fromService` wiring supplies `leap-creator-health:10000` with no
 * scheme, which is exactly the value this is most likely to be given in
 * production — and `fetch` rejects it. Internal traffic between two Render
 * services is plain HTTP, so that is what a scheme-less value means.
 */
export function normaliseBase(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-GB'));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const h = (x) => (x == null ? '—' : `${x.toFixed(1)}h`);

/**
 * One creator, written for the model to reason over.
 *
 * Deliberately prose-with-numbers rather than raw JSON. The metrics object is
 * large and mostly irrelevant to a coaching question, and handing the model all
 * of it invites it to quote a field nobody asked about. This is the same set of
 * facts a coach's Discord card is built from, in the same framing.
 */
export function describeCreator(payload, openCases = []) {
  if (!payload) return null;
  const { creator, metrics } = payload;
  const lines = [];

  lines.push(`@${creator.username}${creator.group ? ` — ${creator.group}` : ''}${creator.manager ? `, coached by ${creator.manager}` : ''}`);
  if (creator.quitOn) lines.push(`LEFT THE NETWORK on ${creator.quitOn}. Nothing below is actionable.`);
  if (metrics.daysSinceJoining != null) {
    lines.push(`Day ${metrics.daysSinceJoining} since joining${metrics.daysSinceJoining <= 90 ? ' — still inside the first 90 days, so the 200k target applies' : ''}.`);
  }
  lines.push(`Data as of ${metrics.endDate}.`);

  lines.push('', 'This week (last 7 days), against the week before:');
  lines.push(`  Diamonds      ${n(metrics.curr7.diamonds)}  (${pct(metrics.change7.diamonds)})`);
  lines.push(`  LIVE hours    ${h(metrics.curr7.liveHours)}  (${pct(metrics.change7.liveHours)})`);
  lines.push(`  LIVE days     ${n(metrics.curr7.validLiveDays)} of 7  (${pct(metrics.change7.validLiveDays)})`);
  if (metrics.darkStreak) lines.push(`  Days dark     ${metrics.darkStreak} in a row with no LIVE at all`);
  if (metrics.diamondsPerHour7 != null) {
    lines.push(`  Per LIVE hour ${n(metrics.diamondsPerHour7)} this week vs ${n(metrics.diamondsPerHour28)} over 28 days`);
  }

  if (metrics.monthOnMonth?.diamonds) {
    const m = metrics.monthOnMonth;
    lines.push('', `This month against ${m.previousMonth}, compared at the same point in the month:`);
    lines.push(`  ${n(m.diamonds.monthToDate)} so far vs ${n(m.diamonds.lastMonthToSamePoint)} by day ${m.dayOfMonth} last month (${pct(m.diamonds.change)})`);
    if (m.diamonds.projectedMonth != null) lines.push(`  On this rate the month finishes on ${n(m.diamonds.projectedMonth)}.`);
  }

  if (metrics.fanClub?.activeFans != null) {
    lines.push('', 'Fan club:');
    lines.push(`  ${n(metrics.fanClub.activeFans)} active members (${pct(metrics.fanClub.activeFansChange7)} this week)`);
    if (metrics.fanClub.share7 != null) {
      lines.push(`  ${Math.round(metrics.fanClub.share7 * 100)}% of this week's diamonds came from the fan club${metrics.fanClub.share7 > 0.85 ? ' — that is a concentration risk' : ''}`);
    }
    lines.push(`  Fan club diamonds ${pct(metrics.fanClub.diamondsChange7)} week on week`);
  }

  lines.push('', 'Campaigns:');
  lines.push(metrics.lastMatch
    ? `  ${metrics.matches28} match(es) in the last 28 days; last one ${metrics.lastMatch}.`
    : '  No match on record at all — they have never taken part in a campaign.');

  // Coverage is a caveat the model has to see. A creator with four days of
  // history has no meaningful week-on-week figure, and an answer that quotes
  // one anyway is exactly how a tool loses a coach's trust.
  if (metrics.exact?.curr7 < 5 || metrics.exact?.prev7 < 5) {
    lines.push('', `CAVEAT: only ${metrics.exact?.curr7 ?? 0} and ${metrics.exact?.prev7 ?? 0} real daily readings in the two weeks compared. Week-on-week changes here are approximate — lean on the monthly comparison instead.`);
  }
  if (metrics.stale > 2) lines.push(`CAVEAT: their last reading is ${metrics.stale} days old.`);

  const mine = openCases.filter((c) => c.username?.toLowerCase() === creator.username.toLowerCase());
  if (mine.length) {
    lines.push('', 'Open case(s) a coach already owns:');
    for (const c of mine) lines.push(...describeCase(c).map((l) => `  ${l}`));
  }

  return lines.join('\n');
}

/** One case: what was found, what it was blamed on, and what has been tried. */
export function describeCase(c) {
  const lines = [
    `${c.id} · ${c.kind} · ${c.severity ?? 'n/a'} · opened ${c.openedOn} · status ${c.status}`,
    `  coach ${c.coach}${c.group ? ` · ${c.group}` : ''} · ~${n(c.valueAtRisk)} diamonds at risk over 28 days`,
    `  signals: ${(c.signals ?? []).join(', ') || 'none'}`,
  ];
  for (const cause of c.causes ?? []) {
    lines.push(`  ${cause.kind === 'lever' ? 'lever' : 'cause'}: ${cause.label} (${CONFIDENCE_LABEL[cause.confidence] ?? cause.confidence})`);
    for (const evidence of cause.evidence ?? []) lines.push(`      ${evidence}`);
  }
  // What the coach has already done matters more than anything else here: the
  // one thing Andy must not do is suggest the thing that was tried last week.
  const actions = (c.history ?? []).filter((e) => e.event === 'actioned' || e.event === 'resolved');
  for (const action of actions) lines.push(`  already tried (${action.at ?? '?'}): ${action.note ?? 'logged, no note'}`);
  if (c.followUpOn) lines.push(`  follow-up due ${c.followUpOn}`);
  return lines;
}

/** The network at a glance, for questions that are not about one creator. */
export function describeNetwork(report) {
  if (!report) return null;
  const alerts = report.alerts ?? [];
  const ramp = report.ramp ?? [];
  const bySeverity = alerts.reduce((acc, a) => { acc[a.severity] = (acc[a.severity] ?? 0) + 1; return acc; }, {});
  const atRisk = alerts.reduce((sum, a) => sum + (a.valueAtRisk ?? 0), 0);

  const lines = [
    `Network as of ${report.asOf}.`,
    `${alerts.length} creators flagged — ${bySeverity.urgent ?? 0} urgent, ${bySeverity.warn ?? 0} warning, ${bySeverity.watch ?? 0} early sign.`,
    `~${n(atRisk)} diamonds at risk across them over the next 28 days.`,
  ];

  const worst = [...alerts].sort((a, b) => (b.valueAtRisk ?? 0) - (a.valueAtRisk ?? 0)).slice(0, 8);
  if (worst.length) {
    lines.push('', 'Biggest exposure:');
    for (const a of worst) {
      lines.push(`  @${a.username} (${a.group ?? 'no team'}, ${a.manager ?? 'unassigned'}) — ${a.severity}, ~${n(a.valueAtRisk)} at risk, ${a.signals.map((s) => s.code).join('/')}`);
    }
  }

  const boost = ramp.filter((r) => r.onBoostList);
  if (boost.length) {
    lines.push('', `On the 200k boost list (${boost.length}) — behind pace but still able to land it this month:`);
    for (const r of boost.slice(0, 8)) {
      lines.push(`  @${r.username} — ${n(r.monthToDate)}/200,000, ${r.daysLeftInMonth} days left, needs ${n(r.requiredPerDay)}/day vs ${n(r.currentPerDay)} now. Cheapest lever: ${r.lever}.`);
    }
  }
  return lines.join('\n');
}
