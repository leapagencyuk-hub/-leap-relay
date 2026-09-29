import test from 'node:test';
import assert from 'node:assert/strict';
import { leagueOf, leagueMoveFor, leagueBoard, DEFAULT_LEAGUES } from '../lib/leagues.mjs';
import { rankUpLeagueEmbed, deRankLeagueEmbed } from '../lib/discord.mjs';

const config = {
  leagues: { tiers: DEFAULT_LEAGUES },
  coaches: { names: { 'josh@leap': 'Sur3shot' } },
  monitoring: { ignoreGroups: [] },
};
const ASOF = '2026-09-20';   // day 20 of 30, so 10 days left

const who = (username, { diamonds = 0, lastMonth = 0, coach = 'josh@leap',
  group = 'Team Alpha', quitOn = null, date = ASOF } = {}) => ({
  key: username, username, quitOn, group, manager: coach, joinDate: '2026-01-01',
  obs: [{ date, mtd: { diamonds }, lastMonthDiamonds: lastMonth }],
});

test('the four leagues are LEAP\'s own thresholds', () => {
  const cases = [
    [0, 'Aspire'], [49999, 'Aspire'],
    [50000, 'Rising'], [199999, 'Rising'],
    [200000, 'Elite'], [499999, 'Elite'],
    [500000, 'Pro'], [5000000, 'Pro'],
  ];
  for (const [d, name] of cases) assert.equal(leagueOf(d, config).name, name, `${d} diamonds`);
  // Nothing sensible to read is the bottom league, where a new creator belongs.
  for (const v of [null, undefined, NaN]) assert.equal(leagueOf(v, config).name, 'Aspire');
});

test('a rank-up is final the moment it happens', () => {
  // Month to date only goes up, so crossing on the 20th cannot be undone by
  // the 30th. The card says so, and it is why this list needs no hedging.
  const r = leagueMoveFor(who('climber', { diamonds: 223638, lastMonth: 198822 }), ASOF, config);
  assert.equal(r.from, 'Rising');
  assert.equal(r.to, 'Elite');
  assert.equal(r.rankedUp, true);
  assert.equal(r.deRanked, false);
  assert.equal(r.jumped, 1);
  assert.equal(r.nextLeague, 'Pro');
  assert.equal(r.toNext, 500000 - 223638);
});

test('a two-league jump is counted and said', () => {
  const r = leagueMoveFor(who('rocket', { diamonds: 531799, lastMonth: 152681 }), ASOF, config);
  assert.equal(r.from, 'Rising');
  assert.equal(r.to, 'Pro');
  assert.equal(r.jumped, 2);
  assert.equal(r.toNext, null, 'nothing above Pro to chase');
});

test('below your league early in the month is not a de-rank', () => {
  // This is the whole point of the card. On day 20 a Pro creator on 280,000 is
  // behind, but 14,000 a day for ten more days gets them to 420,000 — short of
  // Pro, so out of road. One doing 40,000 a day is not.
  const stuck = leagueMoveFor(who('cannot', { diamonds: 280194, lastMonth: 657252 }), ASOF, config);
  assert.equal(stuck.deRanked, true);
  assert.equal(stuck.slipping, false);
  assert.equal(stuck.shortBy, 500000 - 280194);

  const winnable = leagueMoveFor(who('can', { diamonds: 414527, lastMonth: 597613 }), ASOF, config);
  assert.equal(winnable.deRanked, false);
  assert.equal(winnable.slipping, true, 'still has the pace to get back');
  assert.ok(winnable.couldRecover);
});

test('on the last day of the month there is no road left for anybody behind', () => {
  const r = leagueMoveFor(
    who('nearly', { diamonds: 199999, lastMonth: 250000, date: '2026-09-30' }), '2026-09-30', config);
  assert.equal(r.daysLeft, 0);
  assert.equal(r.deRanked, true, '1 diamond short with no days left is still short');
  assert.equal(r.slipping, false);
});

test('holding your league is neither, and is counted', () => {
  const board = leagueBoard({
    creators: [
      who('held', { diamonds: 260000, lastMonth: 240000 }),
      who('up', { diamonds: 520000, lastMonth: 240000 }),
    ],
    asOf: ASOF, config,
  });
  assert.equal(board.held, 1);
  assert.deepEqual(board.rankedUp.map((r) => r.username), ['up']);
  assert.deepEqual(board.deRanked, []);
});

test('the board ignores partner agencies and creators who left', () => {
  const board = leagueBoard({
    creators: [
      who('ours', { diamonds: 220000, lastMonth: 10000 }),
      who('partner', { diamonds: 900000, lastMonth: 0, group: 'Surge Agency' }),
      who('gone', { diamonds: 900000, lastMonth: 0, quitOn: '2026-09-04' }),
    ],
    asOf: ASOF,
    config: { ...config, monitoring: { ignoreGroups: ['Surge Agency'] } },
  });
  assert.deepEqual(board.rankedUp.map((r) => r.username), ['ours']);
});

test('the rank-up card celebrates, names the coach, and points at the next one', () => {
  const board = leagueBoard({
    creators: [who('climber', { diamonds: 223638, lastMonth: 198822 })], asOf: ASOF, config,
  });
  const [page] = rankUpLeagueEmbed(board, { config });
  const e = page.embeds[0];
  assert.match(e.title, /^Ranked up — September$/, 'one page needs no part number');
  assert.match(e.description, /locked in for the month/);
  const body = e.fields.map((f) => `${f.name}\n${f.value}`).join('\n');
  assert.match(body, /@climber\*\* Rising to \*\*Elite\*\* · 223,638 · 276,362 more for Pro · Sur3shot/);
  assert.match(body, /\*\*Aspire\*\* — under 50,000/);
});

test('every name is shown, however many there are', () => {
  // Staff make a poster for each one, so a card that ends "and 18 more" is
  // useless. Discord caps a field at 1024 characters and an embed at 6000, so
  // a long month is split across fields and messages rather than trimmed.
  const creators = Array.from({ length: 120 }, (_, i) =>
    who(`a_creator_with_a_long_name_${String(i).padStart(3, '0')}`, { diamonds: 220000 + i, lastMonth: 10000 }));
  const board = leagueBoard({ creators, asOf: ASOF, config });
  assert.equal(board.rankedUp.length, 120);

  const pages = rankUpLeagueEmbed(board, { config });
  assert.ok(pages.length > 1, 'it took more than one message');

  const all = pages.flatMap((p) => p.embeds[0].fields).map((f) => f.value).join('\n');
  for (const c of creators) {
    assert.ok(all.includes(`@${c.username}**`), `${c.username} is on the card`);
  }
  assert.doesNotMatch(all, /and \d+ more/, 'and nothing was trimmed');

  // Every page stays inside Discord's limits.
  for (const p of pages) {
    const e = p.embeds[0];
    assert.ok(e.fields.length <= 25, 'at most 25 fields');
    for (const f of e.fields) assert.ok(f.value.length <= 1024, `field is ${f.value.length}`);
    const total = e.title.length + (e.description?.length ?? 0) + e.footer.text.length
      + e.fields.reduce((n2, f) => n2 + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `embed is ${total}`);
  }
  // Each page is titled distinctly, so the duplicate sweep cannot eat page 1
  // when page 2 goes up.
  const titles = pages.map((p) => p.embeds[0].title);
  assert.equal(new Set(titles).size, titles.length);
  assert.match(titles[0], /\(1 of \d+\)$/);
});

test('the de-rank card puts the winnable ones first, and shows them all', () => {
  const board = leagueBoard({
    creators: [
      who('cannot', { diamonds: 280194, lastMonth: 657252 }),
      who('can', { diamonds: 414527, lastMonth: 597613 }),
    ],
    asOf: ASOF, config,
  });
  const pages = deRankLeagueEmbed(board, { config });
  const first = pages[0].embeds[0];
  assert.match(first.description, /\*\*1\*\* cannot get back.*\*\*1\*\* still can/s);
  assert.match(first.fields[0].name, /Can still make it back — 1/);
  assert.match(first.fields[0].value, /@can\*\* Pro to Elite · 85,473 short · 8,548\/day/);

  const body = pages.flatMap((p) => p.embeds[0].fields).map((f) => `${f.name}\n${f.value}`).join('\n');
  assert.match(body, /Out of road — 1/);
  assert.match(body, /@cannot\*\* Pro to \*\*Elite\*\* · 280,194 against 657,252 last month/);
});

test('empty cards say so rather than showing a bare heading', () => {
  const board = leagueBoard({ creators: [who('flat', { diamonds: 60000, lastMonth: 55000 })], asOf: ASOF, config });
  assert.match(rankUpLeagueEmbed(board, { config })[0].embeds[0].description, /Nobody has climbed/);
  assert.match(deRankLeagueEmbed(board, { config })[0].embeds[0].description, /Nobody is below/);
});

test('a creator with no reading this month is not guessed at', () => {
  assert.equal(leagueMoveFor({ username: 'ghost', obs: [] }, ASOF, config), null);
  assert.equal(leagueMoveFor({ username: 'ghost' }, ASOF, config), null);
});
