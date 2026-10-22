import test from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, readToken, portalSecret, allLinks, ROLE } from '../lib/portaltoken.mjs';
import { buildPortal, diagnose, creatorMessage, rankMessage, slippingLabel, leverFromSignals, STATE } from '../lib/portal.mjs';
import { coachPage, directorPage, esc, EARNINGS_DISCLAIMER } from '../lib/portalhtml.mjs';

const SECRET = 'a-test-secret-of-sufficient-length';

// --- the link is the credential -----------------------------------------------

test('a token round-trips, and nothing else does', () => {
  const t = mintToken('josh@leap.com', ROLE.COACH, SECRET);
  assert.deepEqual(readToken(t, SECRET), { role: ROLE.COACH, subject: 'josh@leap.com' });

  assert.equal(readToken(t, 'a-different-secret-entirely!!'), null, 'another secret cannot read it');
  assert.equal(readToken(`${t}x`, SECRET), null, 'a lengthened signature is rejected');
  assert.equal(readToken(t.slice(0, -1), SECRET), null, 'a shortened signature is rejected');
  assert.equal(readToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), SECRET), null,
    'a flipped character is rejected');
  assert.equal(readToken('garbage', SECRET), null);
  assert.equal(readToken('', SECRET), null);
  assert.equal(readToken(null, SECRET), null);
});

test('a coach cannot promote their own link to a director one', () => {
  const coach = mintToken('josh@leap.com', ROLE.COACH, SECRET);
  const [payload] = coach.split('.');
  const swapped = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8').replace(/^c\|/, 'd|');
  const forged = `${Buffer.from(swapped).toString('base64url')}.${coach.split('.')[1]}`;
  assert.equal(readToken(forged, SECRET), null, 'the role is inside the signature');
});

test('an unknown role is refused even with a good signature', () => {
  // Mint with a role the reader does not accept: the signature is valid, the
  // claim is not. Belt and braces, because roles are how the director view is
  // gated and a typo there would open every roster.
  const bad = mintToken('josh@leap.com', 'x', SECRET);
  assert.equal(readToken(bad, SECRET), null);
});

test('no secret means no portal at all', () => {
  assert.equal(portalSecret({}), null);
  assert.equal(portalSecret({ PORTAL_SECRET: 'tooshort' }), null, 'a weak secret is no secret');
  assert.equal(portalSecret({ PORTAL_SECRET: SECRET }), SECRET);
  assert.equal(mintToken('josh@leap.com', ROLE.COACH, null), null);
  assert.equal(readToken('anything.atall', null), null);
  assert.equal(allLinks([], 'https://x', null), null);
});

// --- the view model ------------------------------------------------------------

const creator = (username, over = {}) => ({
  key: `id:${username}`, username, manager: 'josh@leap.com', group: 'Team Alpha',
  joinDate: '2026-01-01', quitOn: null, obs: [], levels: {}, ...over,
});

const metrics = (over = {}) => ({
  endDate: '2026-10-19',
  curr7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000, newFollowers: 100, matches: 0 },
  prev7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000, newFollowers: 100 },
  curr28: { diamonds: 28000, liveHours: 80, matches: 0 },
  change7: { diamonds: 0, liveHours: 0, newFollowers: 0 },
  profile: { diamonds: {}, liveHours: {}, validLiveDays: {} },
  fanClub: { activeFans: 30, diamondsChange7: 0, activeFansChange14: 0 },
  monthToDate: { diamonds: 50000, liveHours: 90, validLiveDays: 18, newFollowers: 400 },
  monthOnMonth: { diamonds: { monthToDate: 50000, change: 0 } },
  diamondsPerHour28: 350, diamondsPerHour7: 350,
  dailyDiamonds7: 1000, activeDays28: 18, darkStreak: 0, daysSinceJoining: 300,
  ...over,
});

function portalOf(rows, config = {}) {
  const creators = rows.map((r) => r.creator);
  const metricsByKey = new Map(rows.map((r) => [r.creator.key, r.metrics]));
  return buildPortal({
    result: { creators, metricsByKey, alerts: rows.filter((r) => r.alert).map((r) => r.alert),
      ramp: rows.filter((r) => r.ramp).map((r) => r.ramp), activation: [], asOf: '2026-10-19' },
    rankUp: { rows: rows.filter((r) => r.rank).map((r) => r.rank) },
    config: { ramp: { targetDiamonds: 200000 }, ...config },
  });
}

test('a coach view holds that coach and nobody else', () => {
  const mine = { creator: creator('mine'), metrics: metrics() };
  const theirs = { creator: creator('theirs', { manager: 'kelly@leap.com', group: 'Team Bravo' }), metrics: metrics() };
  const portal = portalOf([mine, theirs]);

  const josh = portal.byCoach.get('josh@leap.com');
  assert.deepEqual(josh.rows.map((r) => r.username), ['mine']);
  assert.deepEqual(josh.teams, ['Team Alpha']);

  const kelly = portal.byCoach.get('kelly@leap.com');
  assert.deepEqual(kelly.rows.map((r) => r.username), ['theirs']);

  // And the rendered page carries no trace of the other roster. This is the
  // guarantee the whole portal rests on, so it is asserted on the HTML rather
  // than on the model: a leak would show up in what is served, not in a map.
  const page = coachPage(josh, { config: {} });
  assert.ok(page.includes('@mine'));
  assert.ok(!page.includes('theirs'), 'no other coach\'s creator appears');
  assert.ok(!page.includes('Team Bravo'));
});

test('quiet creators do not all read as emergencies', () => {
  // The first run flagged 663 creators network-wide as needing action, because
  // any dark streak counted. A page where two thirds of the roster is red is a
  // page nobody opens twice.
  const dormant = {
    creator: creator('dormant'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 24 }, monthOnMonth: { diamonds: null } }),
  };
  const earner = {
    creator: creator('earner'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  };
  const portal = portalOf([dormant, earner]);
  const view = portal.byCoach.get('josh@leap.com');
  assert.equal(view.counts.act, 1, 'only the one who was actually earning');
  assert.equal(view.attention[0].username, 'earner');
});

test('the attention list is capped, and says what it held back', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    creator: creator(`c${i}`),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 - i * 100 } }),
  }));
  const view = portalOf(rows, { portal: { attentionCount: 4 } }).byCoach.get('josh@leap.com');
  assert.equal(view.attention.length, 4);
  assert.equal(view.attentionMore, 10);
  assert.ok(coachPage(view, { config: {} }).includes('10 more are flagged'));
});

// --- Carla's if-this-then-that -------------------------------------------------

test('hours down with conversion holding is an hours problem', () => {
  const d = diagnose(metrics({
    curr7: { diamonds: 3500, liveHours: 10, validLiveDays: 5, fanClubDiamonds: 2500 },
    prev7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000 },
    change7: { diamonds: -0.5, liveHours: -0.5 },
    diamondsPerHour7: 350,
  }));
  assert.equal(d.lever, 'hours');
  assert.match(d.detail, /hours are the whole gap/);
});

test('hours down with conversion down too is not', () => {
  const d = diagnose(metrics({
    curr7: { diamonds: 1000, liveHours: 10, validLiveDays: 5, fanClubDiamonds: 800 },
    prev7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000 },
    change7: { diamonds: -0.86, liveHours: -0.5 },
    diamondsPerHour7: 100,
  }));
  assert.equal(d.lever, 'conversion');
  assert.match(d.detail, /More time alone will not fix this/);
});

test('a record month with nothing wrong says so instead of inventing a cause', () => {
  const d = diagnose(metrics({ monthOnMonth: { diamonds: { monthToDate: 500000, change: 4.2 } } }));
  assert.equal(d.lever, 'anomaly');
  assert.match(d.detail, /Nothing here explains it/);
});

test('gifting sliding is reported in our own numbers, never as a gift rate', () => {
  // Coaches cannot see the Creator Insights sheet, so nothing may point them
  // at it. And TikTok's gift rate is gifters over viewers — the export carries
  // neither, so a card claiming one would be inventing it.
  const d = diagnose(metrics({
    fanClub: {
      activeFans: 30, diamondsChange7: -0.6, activeFansChange14: 0,
      spendPerFan: 420, spendPerFanBefore: 1100,
    },
  }));
  assert.equal(d.lever, 'gifting');
  assert.match(d.detail, /engagement and gifter management/);
  // Our own measure, from numbers TikTok gave us, named as ours.
  assert.match(d.detail, /Each active fan club member is worth 420 diamonds/);
  assert.match(d.detail, /against 1,100 before/);
  assert.equal(/gift rate/i.test(d.detail), false, 'never calls it a gift rate');
  assert.equal(/Insights/i.test(JSON.stringify(d)), false, 'and never sends them to the sheet');

  assert.ok(d.actions.some((a) => /welcoming and thanking/.test(a)));
  assert.ok(d.actions.some((a) => /campaign/i.test(a)), 'campaigns move engagement most');
});

test('nothing anywhere on a coach page mentions the Insights sheet', () => {
  const view = portalOf([{
    creator: creator('a'),
    metrics: metrics({ fanClub: { activeFans: 30, diamondsChange7: -0.6, activeFansChange14: 0 } }),
  }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.equal(/Insights/i.test(page), false);
  assert.equal(/gift rate/i.test(page.replace(/not TikTok's gift rate[^<]*/i, '')), false,
    'the only mention is the footnote saying we do not have it');
});

test('dark beats every other reading', () => {
  const d = diagnose(metrics({ darkStreak: 6, change7: { liveHours: -0.9 } }));
  assert.equal(d.lever, 'dark');
});

// --- what gets served ----------------------------------------------------------

test('a username cannot smuggle markup onto the page', () => {
  const nasty = { creator: creator('<img src=x onerror=alert(1)>'), metrics: metrics() };
  const view = portalOf([nasty]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.ok(!page.includes('<img src=x'), 'the tag is escaped');
  assert.ok(page.includes('&lt;img src=x'));
  assert.equal(esc('<&">\''), '&lt;&amp;&quot;&gt;&#39;');
});

test('any page that shows money carries the disclaimer', () => {
  // The real invariant, which is stronger than "the coach page has the line":
  // wherever a pound sign reaches a coach, so does the sentence. A page with no
  // earnings on it needs no disclaimer about earnings.
  const rows = [{ creator: creator('a'), metrics: metrics() }];
  const portal = portalOf(rows);
  for (const [label, page] of [
    ['coach', coachPage(portal.byCoach.get('josh@leap.com'), { config: {} })],
    ['director', directorPage(portal, [], {})],
    ['team', coachPage(portal.byTeam.get('Team Alpha'), { config: {} })],
  ]) {
    if (page.includes('£')) {
      assert.ok(page.includes(EARNINGS_DISCLAIMER), `${label} page shows money without the line`);
    }
  }
  // And the director page always shows money, so it always carries it.
  assert.ok(directorPage(portal, [], {}).includes('£'));
  assert.ok(directorPage(portal, [], {}).includes(EARNINGS_DISCLAIMER));
});

test('a creator card links out to their TikTok', () => {
  const view = portalOf([{ creator: creator('bangeduptoes'), metrics: metrics() }])
    .byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.ok(page.includes('https://www.tiktok.com/@bangeduptoes'));
  assert.ok(page.includes('rel="noopener noreferrer"'), 'and does not hand over the opener');
});

test('the page is built around the three questions, in order', () => {
  const sliding = creator('sliding');
  const chasing = creator('chasing');
  const climbing = creator('climbing');
  const view = portalOf([
    { creator: sliding, metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }) },
    {
      creator: chasing,
      metrics: metrics({ monthToDate: { diamonds: 150000 } }),
      ramp: { creator: chasing, monthToDate: 150000, requiredPerDay: 1500 },
    },
    {
      creator: climbing,
      metrics: metrics(),
      rank: {
        creator: climbing, rankedUp: false, maintained: false, reachable: true,
        fromTier: 2, toTier: 2, gap: 20000, needPerDay: 2000, worthIfCrossed: 15.08, worth: 0,
      },
    },
  ]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  const at = (s) => page.indexOf(s);
  assert.ok(at('Urgent') > 0 && at('200k graduation') > 0 && at('Rank up') > 0,
    'all three sections render');
  assert.ok(at('Urgent') < at('200k graduation'), 'urgent first');
  assert.ok(at('200k graduation') < at('Rank up'), 'then the 200k chase, then rank ups');
});

test('a creator in the 200k chase is told what closing the gap pays the coach', () => {
  const c = creator('a');
  const portal = portalOf([{
    creator: c,
    metrics: metrics({ monthToDate: { diamonds: 150000 } }),
    // Doing 1,000 a day; needs 1,500. Inside the stretch, so a real chase.
    ramp: { creator: c, monthToDate: 150000, requiredPerDay: 1500 },
  }]);
  const view = portal.byCoach.get('josh@leap.com');
  assert.equal(view.chase.length, 1);
  assert.equal(view.chase[0].graduation.remaining, 50000);
  // 50,000 diamonds at the coach's own share rate, not the network average.
  assert.ok(view.chase[0].worthIfGraduates > 0);
  assert.equal(Math.round(view.chase[0].worthIfGraduates * 10000) / 10000,
    Math.round(50000 * view.perDiamond * 10000) / 10000);
});

test('coach-facing pages stay free of emoji, like the coach cards', () => {
  const view = portalOf([{ creator: creator('a'), metrics: metrics() }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.equal(/\p{Extended_Pictographic}/u.test(page), false);
});

test('the director page links to each coach and never shows a bare roster', () => {
  const portal = portalOf([
    { creator: creator('a'), metrics: metrics() },
    { creator: creator('b', { manager: 'kelly@leap.com' }), metrics: metrics() },
  ]);
  const links = [{ coach: 'josh@leap.com', name: 'Josh', url: 'https://x/portal/tok1' }];
  const page = directorPage(portal, links, {});
  assert.ok(page.includes('https://x/portal/tok1'));
  assert.ok(!page.includes('@a'), 'the director page is coaches, not creators');
});

// --- the team link, which is the one that goes in a channel --------------------

test('a team view carries the roster and none of the money', () => {
  const portal = portalOf([
    { creator: creator('a'), metrics: metrics() },
    { creator: creator('b', { manager: 'kelly@leap.com' }), metrics: metrics() },
  ]);
  const team = portal.byTeam.get('Team Alpha');
  // Both coaches' creators, because anybody in that room expects the whole team.
  assert.deepEqual(team.rows.map((r) => r.username).sort(), ['a', 'b']);
  assert.equal(team.earnings, null, 'no earnings object at all');
  assert.equal(team.earningsHidden, true);

  const page = coachPage(team, { config: {} });
  assert.ok(!page.includes('Your month'), 'no wage block on a page that lands in a channel');
  assert.ok(!page.includes('Fixed '), 'no pay breakdown either');
  assert.ok(page.includes('@a') && page.includes('@b'));
});

test('a team token and a coach token are not interchangeable', () => {
  const team = mintToken('Team Alpha', ROLE.TEAM, SECRET);
  assert.deepEqual(readToken(team, SECRET), { role: ROLE.TEAM, subject: 'team alpha' });
  assert.notEqual(readToken(team, SECRET).role, ROLE.COACH);

  // The subject is lower-cased on the way in and team names are not, so the
  // server has to fold when it looks one up. Matching exactly 404s every team
  // link ever sent, which is how this was found.
  const portal = portalOf([{ creator: creator('a'), metrics: metrics() }]);
  const keys = [...portal.byTeam.keys()];
  assert.deepEqual(keys, ['Team Alpha']);
  assert.equal(portal.byTeam.get(readToken(team, SECRET).subject), undefined,
    'an exact lookup misses, which is what the server compensates for');
  assert.ok(keys.find((t) => t.toLowerCase() === readToken(team, SECRET).subject));
});

// --- signing in with Discord ---------------------------------------------------

import {
  mintSession, readSession, mintState, readState, resolveAccess,
  cookieValue, sessionCookie, discordApp, redirectUri,
} from '../lib/portalauth.mjs';

test('a session cookie survives a round trip and nothing else does', () => {
  const c = mintSession('123456789012345678', SECRET);
  assert.equal(readSession(c, SECRET), '123456789012345678');
  assert.equal(readSession(c, 'another-secret-entirely-here'), null);
  assert.equal(readSession(`${c}x`, SECRET), null);
  assert.equal(readSession('nonsense', SECRET), null);
});

test('a session expires rather than lasting forever', () => {
  const c = mintSession('123456789012345678', SECRET, { days: 1, now: 0 });
  assert.equal(readSession(c, SECRET, 0), '123456789012345678');
  assert.equal(readSession(c, SECRET, 86400000 + 1), null, 'a day later it is dead');
});

test('the OAuth state is signed, expiring, and cannot carry an open redirect', () => {
  assert.equal(readState(mintState('/portal', SECRET), SECRET).returnTo, '/portal');
  assert.equal(readState(mintState('/portal', SECRET, 0), SECRET, 11 * 60 * 1000), null, 'ten minutes');
  assert.equal(readState(mintState('/portal', SECRET), 'other-secret-entirely-xx'), null);
  // The one that matters: a state cannot bounce a signed-in coach off-site.
  assert.equal(readState(mintState('https://evil.example', SECRET), SECRET).returnTo, '/portal');
  assert.equal(readState(mintState('//evil.example', SECRET), SECRET).returnTo, '/portal');
});

test('a Discord id resolves to exactly the person it belongs to', () => {
  const discordConfig = {
    coaches: {
      'josh@leap.com': { mention: '<@111111111111111111>' },
      'kelly@leap.com': { mention: '<@222222222222222222>', userId: null },
    },
  };
  const config = {
    portal: {
      directors: ['<@999999999999999999>'],
      discordIds: { '333333333333333333': 'Cover@Leap.com' },
    },
  };
  assert.deepEqual(resolveAccess('111111111111111111', { config, discordConfig }),
    { role: 'coach', subject: 'josh@leap.com' });
  assert.deepEqual(resolveAccess('999999999999999999', { config, discordConfig }),
    { role: 'director', subject: '*' }, 'a director id wins over everything');
  assert.deepEqual(resolveAccess('333333333333333333', { config, discordConfig }),
    { role: 'coach', subject: 'cover@leap.com' }, 'the explicit map is folded to lower case');

  // The whole point of the module: an account nobody listed gets nothing.
  assert.equal(resolveAccess('444444444444444444', { config, discordConfig }), null);
  assert.equal(resolveAccess('', { config, discordConfig }), null);
  assert.equal(resolveAccess('not-an-id', { config, discordConfig }), null);
  assert.equal(resolveAccess('12', { config, discordConfig }), null, 'a short number is not a snowflake');
  assert.equal(resolveAccess(null, {}), null, 'and no config at all is not a way in');
});

test('an unresolved mention placeholder does not hand out a roster', () => {
  // routes.deploy.json ships with PASTE_DISCORD_USER_MENTION in every slot. If
  // that ever read as an id, the first person to sign in would get a roster.
  const discordConfig = { coaches: { 'josh@leap.com': { mention: 'PASTE_DISCORD_USER_MENTION' } } };
  assert.equal(resolveAccess('111111111111111111', { config: {}, discordConfig }), null);
});

test('the session cookie is locked down', () => {
  const c = sessionCookie('abc');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Path=\/portal/);
  assert.match(sessionCookie(null), /Max-Age=0/, 'signing out clears it');
  assert.equal(cookieValue('a=1; leap_portal=xyz; b=2', 'leap_portal'), 'xyz');
  assert.equal(cookieValue('', 'leap_portal'), null);
});

test('with no Discord app configured there is no login', () => {
  assert.equal(discordApp({}), null);
  assert.equal(discordApp({ DISCORD_CLIENT_ID: 'x' }), null, 'both halves or nothing');
  assert.deepEqual(discordApp({ DISCORD_CLIENT_ID: 'x', DISCORD_CLIENT_SECRET: 'y' }),
    { clientId: 'x', clientSecret: 'y' });
  assert.equal(redirectUri({ portal: { baseUrl: 'https://leap.example/' } }, {}),
    'https://leap.example/portal/callback');
});

test('a big month slipping is not reported as a collapse', () => {
  // @itsmalkin read "+126% this month" beside "hours and conversion both down",
  // which looks like the page arguing with itself. Both facts are true: the
  // month is huge and the week is falling. The card has to say so.
  const d = diagnose(metrics({
    curr7: { diamonds: 1000, liveHours: 10, validLiveDays: 5, fanClubDiamonds: 800 },
    prev7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000 },
    change7: { diamonds: -0.86, liveHours: -0.5 },
    diamondsPerHour7: 100,
    monthOnMonth: { diamonds: { monthToDate: 574323, change: 1.26 } },
  }));
  assert.equal(d.lever, 'conversion', 'still flagged, because the week is real');
  assert.equal(d.headline, 'Coming off a peak');
  assert.match(d.detail, /126% up on the same point last month/);
  assert.match(d.detail, /big month easing off rather than a bad one/);
  // And it no longer tells somebody on a record month to get back to basics in
  // the same sentence as "this is not an alarm".
  assert.equal(/Back to basics/.test(d.detail), false);
});

test('the 200k chase only names creators who can still get there', () => {
  // Without the reach test this section listed ten creators and put the LARGEST
  // payout against the one furthest away, because closing a gap pays per
  // diamond. A creator needing 15,877 a day was top of a list meant to be a
  // morning's work.
  const near = creator('near');
  const far = creator('far');
  const view = portalOf([
    {
      creator: near, metrics: metrics({ monthToDate: { diamonds: 150000 } }),
      ramp: { creator: near, monthToDate: 150000, requiredPerDay: 1500 },
    },
    {
      creator: far, metrics: metrics({ monthToDate: { diamonds: 10000 } }),
      ramp: { creator: far, monthToDate: 10000, requiredPerDay: 15877 },
    },
  ]).byCoach.get('josh@leap.com');

  assert.deepEqual(view.chase.map((r) => r.username), ['near']);
  assert.equal(view.chaseOutOfReach, 1, 'and the rest are counted, not hidden');
  assert.ok(coachPage(view, { config: {} }).includes('1 more are inside their 90 days'));
});

test('a creator who is urgent is not also listed under the other two sections', () => {
  const c = creator('both');
  const view = portalOf([{
    creator: c,
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 150000 } }),
    ramp: { creator: c, monthToDate: 150000, requiredPerDay: 1500 },
    rank: {
      creator: c, rankedUp: false, maintained: false, reachable: true,
      fromTier: 2, toTier: 2, gap: 20000, needPerDay: 2000, worthIfCrossed: 15.08, worth: 0,
    },
  }]).byCoach.get('josh@leap.com');

  assert.equal(view.attention.length, 1, 'urgent wins');
  assert.equal(view.chase.length, 0);
  assert.equal(view.upside.length, 0);
  // One call to make, not three.
  const page = coachPage(view, { config: {} });
  assert.equal(page.split('@both').length - 1 > 0, true);
});

// --- what a coach actually sends -----------------------------------------------

test('every diagnosis comes with a message a coach can paste', () => {
  const view = portalOf([{
    creator: creator('a'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]).byCoach.get('josh@leap.com');
  const d = view.attention[0].diagnosis;
  assert.ok(d.message && d.message.length > 40);
  assert.match(d.message, /@a/);
});

const LEVERS = ['dark', 'hours', 'conversion', 'days', 'gifting', 'rate', 'protect', 'anomaly', 'hold'];

test('every message reads like a person wrote it, not a bot', () => {
  const facts = {
    perHour: 3586, perHourNormal: 6157, hoursNow: 39.9, hoursBefore: 62.5,
    daysNow: 4, daysBefore: 7, monthNow: 574323, monthThen: 253653,
    perFan: 420, perFanBefore: 1100, darkDays: 6,
  };
  for (const lever of LEVERS) {
    const msg = creatorMessage(lever, 'someone', facts);
    assert.ok(msg.length > 40, `${lever} has a real message`);
    assert.equal(/\p{Extended_Pictographic}/u.test(msg), false, `${lever} has an emoji`);
    assert.equal(msg.includes('**'), false, `${lever} has markdown`);
    // Never anybody else's business: what the agency earns, what a coach is
    // paid, or another creator's numbers.
    assert.equal(/[£$€]/.test(msg), false, `${lever} mentions money`);
    assert.equal(/\bcoach\b|commission|agency/i.test(msg), false, `${lever} mentions the agency`);
  }
});

test('a message carries the creator\'s own numbers, and drops the line when it has none', () => {
  // Facts and data, in their own terms. A creator sees these in their own LIVE
  // Backstage anyway; what they cannot see is anybody else's.
  const withFacts = creatorMessage('hours', 'someone', { perHour: 3586, hoursNow: 39.9, hoursBefore: 62.5 });
  assert.match(withFacts, /3,586 diamonds an hour/);
  assert.match(withFacts, /39\.9 hours last week against 62\.5/);

  // And with nothing to quote, the sentence goes rather than printing a hole.
  const bare = creatorMessage('hours', 'someone');
  assert.equal(/undefined|null|NaN/.test(bare), false);
  assert.equal(bare.includes('diamonds an hour'), false);
  assert.match(bare, /your hours have come down on last week/i);
});

test('money below a pound is left off a card rather than dressed as an incentive', () => {
  const c = creator('tiny');
  const view = portalOf([{
    creator: c,
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 }, dailyDiamonds7: 1 }),
  }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.equal(/£0\.\d\d\/wk/.test(page), false, 'no nine-pence urgency');
});

// --- creator faces --------------------------------------------------------------

import { parseAvatar, avatarRoute, avatarKey } from '../lib/avatars.mjs';

test('the smallest avatar TikTok offers is the one taken', () => {
  // The portal draws these at 54px. avatarLarger is 1080x1080 and about 170KB,
  // so a page with twenty creators pulled three and a half megabytes of faces
  // onto a phone to render thumbnails. avatarThumb is 100x100 and about 5KB.
  const page = JSON.stringify({
    avatarLarger: 'https://cdn/x~tplv-tiktokx-cropcenter:1080:1080.jpeg?sig=a',
    avatarMedium: 'https://cdn/x~tplv-tiktokx-cropcenter:720:720.jpeg?sig=b',
    avatarThumb: 'https://cdn/x~tplv-tiktokx-cropcenter:100:100.jpeg?sig=c',
  });
  assert.match(parseAvatar(page), /cropcenter:100:100/);

  // And it must be TikTok's own signed URL for that size, never a rewrite of a
  // bigger one: the path is covered by the signature, so asking for :200:200
  // on a URL signed for :1080:1080 is refused. Fifty of fifty failed that way.
  assert.match(parseAvatar(page), /sig=c/);
});

test('an avatar falls back through the sizes and gives up cleanly', () => {
  assert.match(parseAvatar(JSON.stringify({ avatarLarger: 'https://cdn/big.jpeg' })), /big\.jpeg/);
  assert.equal(parseAvatar('<html>nothing here</html>'), null);
  assert.equal(parseAvatar(null), null);
  // Escaped slashes are how the embedded JSON writes them.
  assert.equal(parseAvatar('"avatarThumb":"https:\\u002F\\u002Fcdn\\u002Fa.jpeg"'),
    'https://cdn/a.jpeg');
});

test('a handle cannot be walked out of the avatar directory', () => {
  // Stripping slashes is what stops a traversal; collapsing dots is so the
  // filename is something a person can still reason about.
  assert.equal(avatarKey('../../etc/passwd'), 'etcpasswd');
  assert.equal(avatarKey('Bang/Ed..Toes'), 'banged.toes');
  assert.equal(avatarKey('..'), '');
  assert.equal(avatarKey('./.hidden'), 'hidden');
  assert.equal(avatarKey('%2e%2e%2f'), '2e2e2f');
  assert.equal(avatarKey('a'.repeat(300)).length, 64, 'and cannot be arbitrarily long');
  for (const nasty of ['../../etc/passwd', '..', './.hidden', 'a/../../b']) {
    assert.equal(/[/\\]/.test(avatarKey(nasty)), false, `${nasty} keeps a separator`);
  }
  assert.equal(avatarRoute('bangeduptoes'), '/portal/avatar/bangeduptoes');
});

// --- the real logins -------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realConfig = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));

test('every Discord id in the config resolves to exactly one person', () => {
  const { directors = [], discordIds = {} } = realConfig.portal ?? {};
  const names = realConfig.coaches?.names ?? {};

  for (const id of directors) {
    assert.match(id, /^\d{17,20}$/, `${id} is not a Discord snowflake`);
    assert.deepEqual(resolveAccess(id, { config: realConfig }), { role: 'director', subject: '*' });
  }
  for (const [id, email] of Object.entries(discordIds)) {
    assert.match(id, /^\d{17,20}$/, `${id} is not a Discord snowflake`);
    assert.ok(names[email], `${email} has no coach name in config`);
    const got = resolveAccess(id, { config: realConfig });
    // An id that is both an owner and a coach gets the director view. That is
    // Sur3shot and Slow, and it is deliberate: they reach their own team from
    // the network page like any other.
    const expected = directors.includes(id)
      ? { role: 'director', subject: '*' }
      : { role: 'coach', subject: email.toLowerCase() };
    assert.deepEqual(got, expected, `${email} resolved wrong`);
  }

  // No id does double duty as two different coaches.
  const emails = Object.values(discordIds).filter((e) => !directors.includes(
    Object.entries(discordIds).find(([, v]) => v === e)[0]));
  assert.equal(new Set(emails).size, emails.length, 'two ids share one coach');
});

test('an account nobody listed still gets nothing, with the real config', () => {
  assert.equal(resolveAccess('111111111111111111', { config: realConfig }), null);
});

test('Cam sees his stats and never a figure of money', () => {
  // Asked for explicitly: Cam is not on a financial arrangement yet, so the
  // portal shows him his roster and no earnings anywhere on it.
  const cam = 'bigbamc.tt@gmail.com';
  assert.ok((realConfig.revenue?.hideEarningsFor ?? []).includes(cam),
    'Cam must be on the earnings-hidden list');

  const c = creator('a', { manager: cam });
  const portal = buildPortal({
    result: {
      creators: [c], metricsByKey: new Map([[c.key, metrics({ darkStreak: 9 })]]),
      alerts: [], ramp: [], activation: [], asOf: '2026-10-19',
    },
    revenue: { byCoach: new Map([[cam, { total: 500, diamonds: 1000, base: 100, unlock: 0.2,
      recruitBonus: 0, rankUpBonus: 0, incrementalShare: 0, leapedCount: 0, rankUps: 0,
      totalWithGoals: 500, goals: null }]]) },
    config: { ...realConfig, ramp: { targetDiamonds: 200000 } },
  });
  const view = portal.byCoach.get(cam);
  assert.equal(view.earningsHidden, true);

  const page = coachPage(view, { config: realConfig });
  assert.equal(page.includes('£'), false, 'no pound sign anywhere on Cam\'s page');
  assert.equal(page.includes('Your month'), false, 'and no wage block');
  assert.equal(page.includes('at risk'), false, 'and no value-at-risk line');
  assert.ok(page.includes('@a'), 'but he still sees his roster');
});

// --- Discord points at the portal, and lands where it says ----------------------

import { dailyOverviewEmbed, teamPortalEmbed, declineBriefEmbed } from '../lib/discord.mjs';

test('a creator card is anchored so a ping can link straight to it', () => {
  const view = portalOf([{
    creator: creator('BangedUpToes'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]).byCoach.get('josh@leap.com');
  assert.ok(coachPage(view, { config: {} }).includes('id="c-bangeduptoes"'));
});

test('the monitoring ping links to that creator, not to the top of the page', () => {
  const c = { id: 'x', username: 'BangedUpToes', creatorKey: 'id:1', coach: 'josh@leap.com',
    group: 'Team Alpha', severity: 'urgent', kind: 'decline', openedOn: '2026-10-19',
    firstSeenOn: '2026-10-19', playbookId: 'DIAMONDS_DOWN' };
  const alert = { creator: { username: 'BangedUpToes' }, metrics: metrics({ darkStreak: 4 }) };
  const out = declineBriefEmbed(c, alert, {
    buttons: false, config: {}, portalUrl: 'https://x/portal',
    diagnosis: { headline: 'Gone dark', detail: 'Find out why.' },
  });
  const body = JSON.stringify(out);
  assert.ok(body.includes('https://x/portal#c-bangeduptoes'));
  assert.ok(body.includes('Gone dark'), 'and carries the same reading the portal shows');
});

test('with no portal the monitoring card keeps the full evidence', () => {
  // Cutting the detail with nowhere to point is just losing the detail.
  const c = { id: 'x', username: 'a', creatorKey: 'id:1', coach: 'josh@leap.com', group: 'T',
    severity: 'urgent', kind: 'decline', openedOn: '2026-10-19', firstSeenOn: '2026-10-19',
    playbookId: 'DIAMONDS_DOWN', weekly: false, baseline: {} };
  const alert = { creator: { username: 'a' }, metrics: metrics(), signals: [], causes: [] };
  const brief = declineBriefEmbed(c, alert, { buttons: false, config: {}, portalUrl: null });
  assert.ok(JSON.stringify(brief).length > 200, 'falls back to the long card');
});

test('the owners card is six things and a door', () => {
  const portal = portalOf([{
    creator: creator('a'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]);
  const out = dailyOverviewEmbed({ portal, asOf: '2026-10-19', config: {}, portalUrl: 'https://x/portal' });
  assert.equal(out.embeds[0].fields.length, 6, 'six, because that is what fits on a phone');
  assert.match(out.embeds[0].fields[0].name, /^1\. /);
  assert.equal(out.components[0].components[0].url, 'https://x/portal');
  // Counts are never bare: every line that has somebody on it names somebody.
  assert.match(out.embeds[0].fields[0].value, /@a/);
});

test('a team card in a shared channel still shows no money', () => {
  const portal = portalOf([{
    creator: creator('a'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]);
  const out = teamPortalEmbed({
    view: portal.byTeam.get('Team Alpha'), team: 'Team Alpha', asOf: '2026-10-19',
    config: {}, portalUrl: 'https://x/portal',
  });
  assert.equal(JSON.stringify(out).includes('£'), false);
  assert.equal(out.components[0].components[0].url, 'https://x/portal');
});

test('a percentage on a card always shows the figure it is measured against', () => {
  const c = creator('a');
  const m = metrics({
    monthToDate: { diamonds: 527439, liveHours: 62, validLiveDays: 18 },
    monthOnMonth: {
      diamonds: { monthToDate: 527439, change: -0.41, lastMonthToSamePoint: 894000 },
      liveHours: { change: -0.05, lastMonthToSamePoint: 65.3 },
      validLiveDays: { change: 0.17, lastMonthToSamePoint: 15.4 },
    },
    fanClub: { activeFans: 305, activeFansChange14: 0.4, activeFans14: 218 },
  });
  const view = portalOf([{ creator: c, metrics: m, alert: { creator: c, metrics: m, severity: 'urgent', signals: [] } }])
    .byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });

  assert.ok(page.includes('from 894,000'), 'diamonds show last month to the same point');
  assert.ok(page.includes('from 65.3h'), 'hours too');
  assert.ok(page.includes('from 15 by this point last month'), 'and LIVE days');
  // The month figures compare to the SAME POINT last month, never to the whole
  // of it: on the 19th a part month against a whole one reads as a collapse
  // for somebody doing exactly what they always do.
  assert.ok(page.includes('by this point last month'));
  // Fan club is a 14-day window, the only one we hold, and says so.
  assert.ok(page.includes('from 218 two weeks ago'));
});

test('banked rank ups render as cards, not a heading with nothing under it', () => {
  // Sur3shot's page showed "RANK UP & MAINTAIN (69)" and then empty space:
  // all 69 were banked, and banked was hidden behind a fold.
  const rows = Array.from({ length: 5 }, (_, i) => {
    const c = creator(`banked${i}`);
    return {
      creator: c,
      metrics: metrics(),
      rank: {
        creator: c, rankedUp: i === 0, maintained: i !== 0, reachable: true,
        fromTier: 2, toTier: i === 0 ? 3 : 2, gap: 0, needPerDay: null,
        worthIfCrossed: 0, worth: 10,
      },
    };
  });
  const view = portalOf(rows).byCoach.get('josh@leap.com');
  assert.equal(view.upside.length, 0, 'nothing in reach');
  assert.equal(view.banked.length, 5);

  const page = coachPage(view, { config: {} });
  assert.ok(page.includes('Rank up &amp; maintain'));
  // Every banked creator is named on the page, not folded away.
  for (let i = 0; i < 5; i++) assert.ok(page.includes(`@banked${i}`), `banked${i} is missing`);
  assert.ok(page.includes('1 ranked up, 4 holding their tier'));
  assert.equal(page.includes('<details class="fold"><summary>Banked'), false, 'not behind a fold');
});

test('a creator closing on the next tier is marked out from the rest', () => {
  // Amber is "worth a message today" rather than "worth a message on the
  // 30th": most of the way to the next tier, with the month still to run.
  const far = creator('far');
  const close = creator('close');
  const rank = (c, diamonds, target) => ({
    creator: c, rankedUp: false, maintained: true, reachable: true,
    fromTier: 1, toTier: 1, gap: target - diamonds, needPerDay: 500,
    worthIfCrossed: 7.54, worth: 0, diamonds, target, daysLeft: 10,
  });
  const view = portalOf([
    { creator: far, metrics: metrics(), rank: rank(far, 10000, 100000) },
    { creator: close, metrics: metrics(), rank: rank(close, 86678, 100000) },
  ]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });

  assert.ok(/class="rk near"[\s\S]{0,500}@close/.test(page), '87% of the way there is amber');
  assert.equal(/class="rk near"[\s\S]{0,500}@far/.test(page), false, '10% of the way is not');
  // And the bar is drawn against the real target, not a guess.
  assert.ok(page.includes('86,678</b> / 100,000') || page.includes('86,678</b>'));
  assert.ok(page.includes('13,322</b> to go'));
});

test('a rank-up message tells the creator their number, unlike a decline note', () => {
  // The deliberate exception, and the one place a figure reaches a creator.
  // Carla's rule from the 22 October call: "tell them the number — a creator
  // who does not know the target cannot chase it." It is also not a
  // disclosure: a creator sees their own diamond count in their own Backstage.
  const msg = rankMessage('syn1880', { gap: 13322, perDay: 1110, tier: 2, daysLeft: 12 });
  assert.match(msg, /13,322/, 'the gap is the point of the message');
  assert.match(msg, /Tier 2/);
  // What still never goes in: money, or anybody else's numbers.
  assert.equal(/[£$€]/.test(msg), false, 'no money');
  assert.equal(/coach|commission|paid/i.test(msg), false, 'nothing about what we earn');

  // And somebody already there is told to hold, not handed a number.
  const held = rankMessage('kirstx3', { gap: 0, perDay: null, tier: 8, daysLeft: 12 });
  assert.equal(/\d{3,}/.test(held), false);
  assert.match(held, /holding your tier/);
  assert.equal(/\p{Extended_Pictographic}/u.test(msg), false, 'and no emoji');
});

test('creator lists tile on a desktop instead of running down the middle', () => {
  const view = portalOf([{
    creator: creator('a'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.ok(page.includes('<div class="cards">'), 'cards sit in a grid');
  assert.ok(page.includes('max-width:1400px'), 'and the page uses the screen');
});

test('no message carries markdown or an emoji, wherever it is pasted', () => {
  // A coach pastes these wherever they talk to the creator. Discord renders
  // **bold**; a TikTok DM prints the asterisks.
  const all = [
    rankMessage('a', { gap: 7337, perDay: 611, tier: 5, daysLeft: 10 }),
    rankMessage('a', { gap: 0, perDay: null, tier: 5, daysLeft: 10 }),
    shortFormMessage('a', { verdict: 'cold', daysSince: 9, last7: 0 }),
    shortFormMessage('a', { verdict: 'good', last7: 5 }),
    ...LEVERS.map((l) => creatorMessage(l, 'a')),
  ];
  for (const m of all) {
    assert.equal(m.includes('**'), false, `markdown in: ${m.slice(0, 60)}`);
    assert.equal(/\[.+\]\(.+\)/.test(m), false, 'and no markdown links');
    assert.equal(/\p{Extended_Pictographic}/u.test(m), false, `emoji in: ${m.slice(0, 60)}`);
  }
});

// --- a big month easing off is not an emergency ---------------------------------

test('a creator having a record month is not filed under urgent', () => {
  // @itsmalkin was listed as "Slipping now, worth the call" on a month running
  // 127% ahead of the same point last month. The week is worth a word; it is
  // not the same word.
  const c = creator('bigmonth');
  const m = metrics({
    curr7: { diamonds: 65587, liveHours: 39.9, validLiveDays: 6, fanClubDiamonds: 50000 },
    prev7: { diamonds: 384978, liveHours: 62.5, validLiveDays: 7, fanClubDiamonds: 300000 },
    change7: { diamonds: -0.83, liveHours: -0.36 },
    diamondsPerHour7: 1645, diamondsPerHour28: 3586,
    monthToDate: { diamonds: 574323 },
    monthOnMonth: { diamonds: { monthToDate: 574323, change: 1.26, lastMonthToSamePoint: 253653 } },
  });
  const view = portalOf([{ creator: c, metrics: m, alert: { creator: c, metrics: m, severity: 'warn', signals: [] } }])
    .byCoach.get('josh@leap.com');

  assert.equal(view.counts.act, 0, 'not urgent');
  assert.equal(view.protect.length, 1, 'but still surfaced');
  const page = coachPage(view, { config: {} });
  assert.ok(page.includes('Protect the month'));
  assert.ok(page.includes('not to warn'));
});

test('a week is measured against their own normal when last week was a freak', () => {
  // 6,157/hour one week against a 28-day average of 3,586 is an outlier.
  // Measuring the next week off that spike produced "-45%" and called a record
  // month a collapse; against their own normal it is -54%, and the card says so.
  const d = diagnose(metrics({
    curr7: { diamonds: 65587, liveHours: 39.9, validLiveDays: 6, fanClubDiamonds: 50000 },
    prev7: { diamonds: 384978, liveHours: 62.5, validLiveDays: 7, fanClubDiamonds: 300000 },
    change7: { diamonds: -0.83, liveHours: -0.36 },
    diamondsPerHour7: 1645, diamondsPerHour28: 3586,
    monthOnMonth: { diamonds: { monthToDate: 574323, change: 1.26 } },
  }));
  assert.match(d.detail, /against their own normal/);
  assert.match(d.detail, /last week was an outlier at 6,1\d\d/);
  assert.match(d.detail, /on last week/, 'and every figure names its window');
  assert.match(d.detail, /126% up on the same point last month/);
  assert.match(d.detail, /protect it, not to sound an alarm/);
  assert.equal(/Back to basics/.test(d.detail), false);
});

test('a creator on a record month is sent encouragement, not a lecture', () => {
  const c = creator('bigmonth');
  const m = metrics({
    change7: { liveHours: -0.36 }, diamondsPerHour7: 1645, diamondsPerHour28: 3586,
    prev7: { diamonds: 384978, liveHours: 62.5, validLiveDays: 7, fanClubDiamonds: 300000 },
    curr7: { diamonds: 65587, liveHours: 39.9, validLiveDays: 6, fanClubDiamonds: 50000 },
    monthOnMonth: { diamonds: { monthToDate: 574323, change: 1.26 } },
  });
  const view = portalOf([{ creator: c, metrics: m, alert: { creator: c, metrics: m, severity: 'warn', signals: [] } }])
    .byCoach.get('josh@leap.com');
  const msg = view.protect[0].diagnosis.message;
  assert.match(msg, /brilliant month/);
  assert.equal(/slipping|problem/i.test(msg), false, 'nothing that reads as a telling-off');
  // And the advice to the coach matches.
  assert.ok(view.protect[0].diagnosis.actions.some((a) => /Lead with the month/.test(a)));
});

// --- short form -----------------------------------------------------------------

import { readPosts, shortFormAdvice, shortFormMessage, handleKey } from '../lib/shortform.mjs';

test('post dates turn into the thing a coach needs to know', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const at = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);

  const today = readPosts([at('2026-10-22'), at('2026-10-21'), at('2026-10-20')], { now });
  assert.equal(today.verdict, 'good');
  assert.equal(today.daysSince, 0);
  assert.equal(today.last7, 3);

  // Perry's threshold: past three days is too long.
  assert.equal(readPosts([at('2026-10-19')], { now }).verdict, 'slowing');
  assert.equal(readPosts([at('2026-10-18')], { now }).verdict, 'cold');
  assert.equal(readPosts([at('2026-10-13')], { now }).daysSince, 9);
  assert.equal(readPosts([], { now }).verdict, 'none');

  // Duplicates from overlapping pages of the feed must not inflate the count.
  const dupes = readPosts([at('2026-10-22'), at('2026-10-22'), at('2026-10-21')], { now });
  assert.equal(dupes.posts, 2);
});

test('the short-form advice says why it matters, not just what happened', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const at = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
  const cold = shortFormAdvice(readPosts([at('2026-10-10')], { now }));
  assert.match(cold.headline, /Last posted 12 days ago/);
  assert.match(cold.detail, /past three days is too long/);
  assert.match(shortFormAdvice(readPosts([], { now })).detail, /70%/);
  // Somebody doing it right is told so, rather than only being left alone.
  assert.match(shortFormAdvice(readPosts([at('2026-10-22')], { now })).detail, /tell them it is working/);
});

test('the short-form message carries the how, and no other creator', () => {
  const m = shortFormMessage('jedstreams', { verdict: 'cold' });
  assert.match(m, /@jedstreams/);
  assert.match(m, /15 to 30 seconds/, 'the format from the announcement');
  assert.equal(/[£$€]/.test(m), false);
  assert.match(shortFormMessage('a', { verdict: 'good' }), /keep it up/);
});

test('a handle cannot escape the short-form cache key', () => {
  assert.equal(handleKey('../../etc/passwd'), 'etcpasswd');
  assert.equal(/[/\\]/.test(handleKey('a/b\\c')), false);
});

test('the check-short-form button is on every creator card', () => {
  const view = portalOf([{
    creator: creator('jedstreams'),
    metrics: metrics({ darkStreak: 9, monthToDate: { diamonds: 90000 } }),
  }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.ok(page.includes('data-shortform="jedstreams"'));
  assert.ok(page.includes('Check short form'));
});

// --- what the card leads with ---------------------------------------------------

test('an urgent card leads with what is wrong, not what it costs', () => {
  const c = creator('slipping');
  const m = metrics({
    curr7: { diamonds: 1000, liveHours: 10, validLiveDays: 5, fanClubDiamonds: 800 },
    prev7: { diamonds: 7000, liveHours: 20, validLiveDays: 5, fanClubDiamonds: 5000 },
    change7: { diamonds: -0.86, liveHours: -0.5 },
    diamondsPerHour7: 100, diamondsPerHour28: 350,
    monthToDate: { diamonds: 90000 },
  });
  const view = portalOf([{ creator: c, metrics: m, alert: { creator: c, metrics: m, severity: 'urgent', signals: [] } }])
    .byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });

  assert.ok(page.includes('class="slip">DIAMONDS SLIPPING'), 'the red says what is happening');
  // The money is still there, just not the headline.
  assert.equal(/class="risk">[^<]*<\/span><\/div>\s*<div class="meta">/.test(page), false,
    'the money is no longer in the name row');
  assert.ok(slippingLabel('hours') === 'HOURS SLIPPING');
  assert.ok(slippingLabel('gifting') === 'ENGAGEMENT SLIPPING');
  assert.ok(slippingLabel('dark') === 'GONE DARK');
  assert.equal(slippingLabel('anomaly'), null, 'a record month is not slipping');
});

test('a creator being protected or chased keeps the money on the headline', () => {
  const c = creator('chasing');
  const view = portalOf([{
    creator: c,
    metrics: metrics({ monthToDate: { diamonds: 150000 } }),
    ramp: { creator: c, monthToDate: 150000, requiredPerDay: 1500 },
  }]).byCoach.get('josh@leap.com');
  const page = coachPage(view, { config: {} });
  assert.equal(page.includes('class="slip"'), false, 'nothing is slipping here');
});

test('the pay breakdown is a row of tiles, not a grey sentence', () => {
  const c = creator('a');
  const portal = buildPortal({
    result: { creators: [c], metricsByKey: new Map([[c.key, metrics()]]),
      alerts: [], ramp: [], activation: [], asOf: '2026-10-19' },
    revenue: { byCoach: new Map([['josh@leap.com', {
      total: 557.29, diamonds: 4171633, base: 350, recruitBonus: 50, rankUpBonus: 0,
      incrementalShare: 157.29, leapedCount: 5, rankUps: 0, unlock: 0.2,
      totalWithGoals: 714.57, goals: { diamondsToGo: 4215435, recruitsToGo: 23, diamondsHit: false, recruitsHit: false },
    }]]) },
    config: { ramp: { targetDiamonds: 200000 } },
  }).byCoach.get('josh@leap.com');
  const page = coachPage(portal, { config: {} });

  assert.ok(page.includes('What you are paid on'));
  for (const label of ['Fixed', 'Recruits', 'Rank ups', 'Diamond share']) {
    assert.ok(page.includes(`<div class="k">${label}</div>`), `${label} has its own tile`);
  }
  assert.ok(page.includes('£350.00') && page.includes('£157.29'));
  assert.ok(page.includes('5 leaped'), 'and each tile says what earned it');
});

test('an urgent creator is never told there is nothing to fix', () => {
  // 64 urgent creators were getting "Nothing to fix. Holding." The decline
  // rules fire on month-on-month and against-their-own-normal; diagnose only
  // looked week-on-week, found nothing, and contradicted the heading above it.
  const m = metrics();   // flat week on week: nothing for diagnose to find
  const alert = {
    severity: 'urgent',
    signals: [
      { label: 'Diamonds -87% on last month', detail: '60,170 so far this month against 456,053 by the same day.' },
      { label: 'Diamonds per LIVE hour -85%', detail: 'Earning 720 per hour this week against 4,676 before this started.' },
    ],
  };
  const d = diagnose(m, { alert });
  assert.notEqual(d.lever, 'hold');
  assert.equal(d.fromRules, true);
  assert.match(d.headline, /Diamonds -87% on last month/);
  assert.match(d.detail, /456,053/, 'and quotes the rule\'s own evidence');
  assert.ok(d.actions.length, 'with steps to match the lever');
  assert.ok(slippingLabel(d.lever), 'and a red label for the card');
});

test('the lever is read from what the rules actually found', () => {
  const sig = (label) => ({ signals: [{ label, detail: '' }] });
  assert.equal(leverFromSignals(sig('Active Fan Club members -23%').signals), 'gifting');
  assert.equal(leverFromSignals(sig('Diamonds per LIVE hour -74%').signals), 'conversion');
  assert.equal(leverFromSignals(sig('LIVE hours -53% on last month').signals), 'hours');
  assert.equal(leverFromSignals(sig('Valid LIVE days down').signals), 'days');
});

// --- is the tool being used -----------------------------------------------------

import { recordVisit, readActivity, activityFor, coachPerformance } from '../lib/coachactivity.mjs';
import os from 'node:os';

test('a visit is counted once a day, not once a refresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-act-'));
  recordVisit(dir, 'josh@leap.com', { today: '2026-10-20' });
  recordVisit(dir, 'josh@leap.com', { today: '2026-10-20' });
  recordVisit(dir, 'josh@leap.com', { today: '2026-10-20' });
  recordVisit(dir, 'josh@leap.com', { today: '2026-10-22' });

  const a = activityFor(readActivity(dir), 'josh@leap.com', '2026-10-22');
  // Somebody refreshing eleven times has not used it eleven times, and a
  // counter that said so would make the most anxious coach look the keenest.
  assert.equal(a.daysThisMonth, 2);
  assert.equal(a.lastSeen, '2026-10-22');
  assert.equal(a.daysSince, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a coach who has never opened it is named as never, not as zero', () => {
  const a = activityFor({}, 'nobody@leap.com', '2026-10-22');
  assert.equal(a.everOpened, false);
  assert.equal(a.lastSeen, null);
  assert.equal(a.daysSince, null, 'null, so the page can say "never" rather than "0d ago"');
});

test('the performance board shows usage and results side by side', () => {
  const c = creator('a');
  const portal = portalOf([{ creator: c, metrics: metrics({
    monthToDate: { diamonds: 50000 },
    monthOnMonth: { diamonds: { monthToDate: 50000, change: 1, lastMonthToSamePoint: 25000 } },
  }) }]);
  const perf = coachPerformance({
    portal,
    activity: { 'josh@leap.com': { days: ['2026-10-22'], lastSeen: '2026-10-22' } },
    asOf: '2026-10-22',
  });
  const row = perf.rows[0];
  assert.equal(row.daysSince, 0);
  assert.equal(row.diamonds, 50000);
  assert.equal(row.lastMonthToDate, 25000);
  assert.equal(Math.round(row.growth * 100), 100, 'team against itself at the same point');
  assert.equal(perf.neverOpened, 0);
  assert.equal(perf.usingIt, 1);

  const page = directorPage(portal, [], { performance: perf });
  assert.ok(page.includes('Coach performance'));
  assert.ok(page.includes('today'), 'last in');
  assert.ok(page.includes('+100%'), 'and whether the team is moving');
});

test('the board records that a coach came, never what they looked at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-act2-'));
  recordVisit(dir, 'josh@leap.com', { today: '2026-10-22' });
  const raw = JSON.stringify(readActivity(dir));
  // The question is "is this coach using the tool", not "watch this coach
  // work". A tool that reports the second to their boss is one they stop
  // opening honestly.
  assert.equal(/creator|username|page|viewed|opened:/i.test(raw), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)['josh@leap.com']).sort(), ['days', 'lastSeen']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a side quest reaches the coach who has to chase it', () => {
  // questBoard returns { quest, progress, coachLabel }, keyed on the quest's
  // own creatorKey. The portal keyed on q.key, which does not exist, so no
  // side quest had ever appeared on a coach's page.
  const c = creator('quester');
  const quests = {
    quests: [{
      quest: { creatorKey: c.key, username: 'quester', kind: 'CROSS', target: 100000,
        need: 20000, startedAt: 80000, worthGbp: 7.54, setOn: '2026-10-24', endsOn: '2026-10-31' },
      progress: { now: 86000, gained: 6000, left: 14000, nightsLeft: 5, done: false, pct: 0.3 },
      coachLabel: 'Josh',
    }],
  };
  const creators = [c];
  const view = buildPortal({
    result: { creators, metricsByKey: new Map([[c.key, metrics()]]),
      alerts: [], ramp: [], activation: [], asOf: '2026-10-26' },
    quests,
    config: { ramp: { targetDiamonds: 200000 } },
  }).byCoach.get('josh@leap.com');

  assert.equal(view.quests.length, 1, 'the quest found its creator');
  assert.equal(view.quests[0].username, 'quester');
  assert.ok(coachPage(view, { config: {} }).includes('Side quests'));
});
