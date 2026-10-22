import test from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, readToken, portalSecret, allLinks, ROLE } from '../lib/portaltoken.mjs';
import { buildPortal, diagnose, STATE } from '../lib/portal.mjs';
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

test('gifting sliding sends them to the Insights sheet rather than guessing', () => {
  const d = diagnose(metrics({ fanClub: { activeFans: 30, diamondsChange7: -0.6, activeFansChange14: 0 } }));
  assert.equal(d.lever, 'gifting');
  assert.equal(d.needsInsights, true);
  assert.match(d.detail, /engagement and gifter management/);
  // The steps are the point: a coach told "gifting is down" and nothing else
  // has been given a fact, not a call to make.
  assert.ok(d.actions.some((a) => /Creator Insights sheet/.test(a)));
  assert.ok(d.actions.some((a) => /welcoming and thanking/.test(a)));
  assert.ok(d.actions.some((a) => /campaign/i.test(a)), 'campaigns spike gift rate');
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
  assert.match(d.detail, /still 126% up/);
  assert.match(d.detail, /big month starting to slip rather than a bad one/);
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
