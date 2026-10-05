import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerRevenue, partnerRevenues, partnerTierOf, partnerDue, PARTNER_TIERS } from '../lib/partner.mjs';
import { partnerEarningsEmbed } from '../lib/discord.mjs';

const config = {
  partners: {
    enabled: true,
    tiers: PARTNER_TIERS,
    agencies: [{ name: 'Stay Social', group: 'Stay Social', tier: 'Growth' }],
  },
  revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05 } },
  rankUp: { advanced: true },
};
const ASOF = '2026-10-10';
const partner = { name: 'Stay Social', group: 'Stay Social', tier: 'Growth' };

/**
 * A creator with a month-to-date reading per day, so the single-day deltas the
 * card's "today" line needs are real rather than spread.
 */
const who = (username, { days = [], group = 'Stay Social', quitOn = null,
  lastMonth = 0, manager = 'staysocial@leap', septTotal = null, month = '2026-10' } = {}) => {
  const obs = [];
  if (septTotal != null) {
    obs.push({ date: '2026-09-30', span: 1, partial: false, mtd: { diamonds: septTotal, liveHours: 10, validLiveDays: 5 }, delta: { diamonds: septTotal } });
  }
  let run = 0;
  days.forEach((d, i) => {
    run += d;
    obs.push({
      date: `${month}-${String(i + 1).padStart(2, '0')}`,
      span: 1, partial: false,
      delta: { diamonds: d, liveHours: 2, validLiveDays: d > 0 ? 1 : 0 },
      mtd: { diamonds: run, liveHours: 2 * (i + 1), validLiveDays: days.slice(0, i + 1).filter((x) => x > 0).length },
      lastMonthDiamonds: lastMonth,
    });
  });
  return { key: username, username, group, manager, quitOn, joinDate: '2026-01-01', obs };
};

// --- the contract ----------------------------------------------------------

test("the share ladder is the Agreement's, clause 5", () => {
  assert.deepEqual(PARTNER_TIERS.map((t) => [t.name, t.share]),
    [['Seedling', 0.80], ['Growth', 0.85], ['Performance', 0.90], ['Elite', 0.95]]);
});

test('the tier is read from config, because it is a judgement and not a calculation', () => {
  // Clause 5 reviews it monthly on growth, compliance, retention and
  // contribution. None of that is in the export.
  const t = partnerTierOf({ tier: 'Growth' }, config);
  assert.equal(t.current.share, 0.85);
  assert.equal(t.next.name, 'Performance');
  assert.equal(partnerTierOf({ tier: 'Elite' }, config).next, null);
});

test('an unknown tier falls back to the bottom rung rather than paying out at the top', () => {
  const t = partnerTierOf({ tier: 'nonsense' }, config);
  assert.equal(t.current.name, 'Seedling');
});

// --- the money -------------------------------------------------------------

test('agency revenue is the incremental share plus rank-up bonuses', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [100000], lastMonth: 0 })],
    asOf: '2026-10-01', config, partner,
  });
  // 100,000 diamonds. Incremental: 100,000 x $0.01 x 5% = $50.
  // Ranked up tier 1 -> 2, so the rank-up bonus pays on the whole month at the
  // tier-1 advanced ratio: 100,000 x $0.01 x 7.5% = $75.
  assert.equal(r.incrementalUsd, 50);
  assert.equal(r.rankUpUsd, 75);
  assert.equal(r.agencyUsd, 125);
  assert.equal(r.rankedUp.length, 1);
});

test('the partner gets their tier share of it, and nothing is net of tax', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [100000], lastMonth: 0 })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.settlement.usd, 106.25, '85% of $125');
  assert.equal(r.beforeTax, true);
});

test('a rank-up pays on the whole month, not on the diamonds above the line', () => {
  // The creator crossed 100,000 and finished on 180,000. The bonus is on all
  // 180,000. Verified against the WAGES CALCUATOR tab — see lib/tiers.mjs.
  const r = partnerRevenue({
    creators: [who('a', { days: [180000], lastMonth: 50000 })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.rankUpUsd, 180000 * 0.01 * 0.075);
});

test('no rank-up means no bonus, however many diamonds', () => {
  // Last month 500,000 puts them in tier 5; 400,000 this month is tier 4, so
  // they went down. TikTok pays the rank-up incentive on rank-ups only.
  const r = partnerRevenue({
    creators: [who('a', { days: [400000], lastMonth: 500000 })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.rankUpUsd, 0);
  assert.equal(r.incrementalUsd, 200);
});

test('the breakdown column adds up to the total printed under it', () => {
  // Rounding each part independently and the total separately left
  // "incremental 33.04 + rank-up 0.00 = 33.03" on the card, which reads as a
  // mistake because it is one.
  const r = partnerRevenue({
    creators: [who('a', { days: [87612], lastMonth: 71173 })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(Math.round((r.incrementalGbp + r.rankUpGbp) * 100) / 100, r.agencyGbp);
});

// --- who counts ------------------------------------------------------------

test('a creator who left mid-month still counts, because the money was earned', () => {
  // The opposite of the coaching cards, which forget a departed creator at
  // once. One is about who to chase today; this is about money already earned.
  const r = partnerRevenue({
    creators: [who('gone', { days: [5000, 5000], quitOn: '2026-10-02' })],
    asOf: '2026-10-02', config, partner,
  });
  assert.equal(r.diamonds, 10000);
  assert.equal(r.creators, 1);
  assert.equal(r.live, 0);
  assert.equal(r.rows[0].left, true);
});

test('only this partner\'s group is counted', () => {
  const r = partnerRevenue({
    creators: [
      who('ours', { days: [10000] }),
      who('theirs', { days: [999999], group: 'Team Alpha' }),
    ],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.diamonds, 10000);
});

test('the group name is matched loosely, because the export is inconsistent about case and spaces', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [10000], group: ' stay social ' })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.diamonds, 10000);
});

// --- the daily line --------------------------------------------------------

test('"today" is a real single day, not the month average', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [16047, 56030, 8161, 7374] })],
    asOf: '2026-10-04', config, partner,
  });
  assert.equal(r.today.diamonds, 7374);
  assert.equal(r.today.previousDiamonds, 8161);
  assert.equal(r.perDayDiamonds, Math.round(87612 / 4));
});

test('a multi-day reading is not counted as a day', () => {
  // A span of several days spreads its delta, and counting that as "today"
  // would be an average dressed up as a day.
  const c = who('a', { days: [1000] });
  c.obs.push({ date: '2026-10-05', span: 3, partial: false, delta: { diamonds: 9000 }, mtd: { diamonds: 10000 }, lastMonthDiamonds: 0 });
  const r = partnerRevenue({ creators: [c], asOf: '2026-10-05', config, partner });
  assert.equal(r.today.diamonds, 0, 'the spread day contributes nothing to a single-day figure');
  assert.equal(r.diamonds, 10000, 'but it still counts toward the month');
});

// --- the projection --------------------------------------------------------

test('the projection runs off the median day, so one big night cannot carry it', () => {
  // Stay Social's October opened 16k, 56k, 8k, 7k. The mean projected 679,000
  // against 134,000 last month — a 407% rise off a single evening.
  const r = partnerRevenue({
    creators: [who('a', { days: [16047, 56030, 8161, 7374] })],
    asOf: '2026-10-04', config, partner,
  });
  assert.equal(r.projected.from, 'median day');
  const mean = Math.round((87612 / 4) * 31);
  assert.ok(r.projected.diamonds < mean * 0.6, `median projection ${r.projected.diamonds} should be well under the mean's ${mean}`);
});

test('last month only shapes the projection when last month is comparable', () => {
  // Most of this roster joined partway through September, so the same point
  // last month holds almost nothing and the ratio came out at forty times.
  const r = partnerRevenue({
    creators: [who('a', { days: [10000, 10000, 10000, 10000], septTotal: 500000 })],
    asOf: '2026-10-04', config, partner,
  });
  assert.equal(r.projected.from, 'median day',
    'a September that had barely started by the 4th must not scale October');
});

test('the projection says when the month is too young to trust it', () => {
  const young = partnerRevenue({ creators: [who('a', { days: [1000, 1000] })], asOf: '2026-10-02', config, partner });
  assert.equal(young.projected.young, true);
  const grown = partnerRevenue({
    creators: [who('a', { days: Array(20).fill(1000) })], asOf: '2026-10-20', config, partner,
  });
  assert.equal(grown.projected.young, false);
});

test('no rank-up is ever projected, because a threshold either falls or it does not', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [50000, 10000] })], asOf: '2026-10-02', config, partner,
  });
  assert.equal(r.projected.rankUpsProjected, false);
  assert.equal(r.rankUpUsd, 0);
  // The projection is the incremental half on projected diamonds, plus only the
  // rank-up money already real.
  assert.equal(r.projected.usd, Math.round(r.projected.diamonds * 0.01 * 0.05 * 0.85 * 100) / 100);
});

// --- where they earn more --------------------------------------------------

test('the rank-up list is only creators who can actually get there', () => {
  // A creator on 573 diamonds needing 99,427 is not a lever, and listing them
  // beside somebody 41,622 away makes the real one look like noise.
  const r = partnerRevenue({
    creators: [
      who('close', { days: [40000, 18378] }),
      who('miles_off', { days: [300, 273] }),
    ],
    asOf: '2026-10-02', config, partner,
  });
  assert.deepEqual(r.nearestRankUp.map((x) => x.username), ['close']);
  assert.equal(r.outOfReach, 1);
});

test('a rank-up is worth the whole threshold, which is why it is the biggest lever', () => {
  const r = partnerRevenue({
    creators: [who('close', { days: [58378] })], asOf: '2026-10-01', config, partner,
  });
  const x = r.nearestRankUp[0];
  assert.equal(x.gap, 100000 - 58378);
  // 100,000 x $0.01 x 7.5% x 85% x FX
  assert.equal(x.ifRankedUpGbp, Math.round(100000 * 0.01 * 0.075 * 0.754074 * 0.85 * 100) / 100);
  assert.ok(x.ifRankedUpGbp > r.settlement.gbp, 'and it beats the whole month so far');
});

test('creators earning nothing are listed, and departed ones are not on that list', () => {
  const r = partnerRevenue({
    creators: [
      who('dormant', { days: [0, 0] }),
      who('gone', { days: [0, 0], quitOn: '2026-10-02' }),
      who('earning', { days: [100, 100] }),
    ],
    asOf: '2026-10-02', config, partner,
  });
  assert.deepEqual(r.dormant.map((x) => x.username), ['dormant']);
});

test('every rung of the ladder is priced on this month, so moving up has a number', () => {
  const r = partnerRevenue({
    creators: [who('a', { days: [1000000] })], asOf: '2026-10-01', config, partner,
  });
  assert.deepEqual(r.atEachTier.map((t) => t.name), ['Seedling', 'Growth', 'Performance', 'Elite']);
  assert.equal(r.atEachTier.find((t) => t.current).name, 'Growth');
  assert.ok(r.nextTierGain > 0);
  // Five points of share on the same agency revenue.
  assert.equal(r.nextTierGain, Math.round(r.agencyUsd * 0.05 * 0.754074 * 100) / 100);
});

// --- the card --------------------------------------------------------------

const sample = () => partnerRevenue({
  creators: [
    who('victoria.willis8', { days: [16047, 40000, 2161, 170], lastMonth: 71173 }),
    who('frisk7046', { days: [0, 16030, 6000, 7204] }),
    who('anf_203', { days: [0, 0, 0, 0] }),
    who('jeddyslays_20', { days: [0, 0, 38, 38], quitOn: '2026-10-04' }),
  ],
  asOf: '2026-10-04', config, partner,
});

test('the card carries the warning verbatim', () => {
  const e = partnerEarningsEmbed(sample(), { config }).embeds[0];
  const text = JSON.stringify(e);
  assert.ok(text.includes('THIS IS FOR VISUAL PURPOSES AND A ROUGH ESTIMATE OF YOUR INCOME, NOT EXACT. '
    + 'FOR EXACT FIGURES TALK TO THE DIRECTORS'), 'the mandatory earnings warning is missing or altered');
});

test('BEFORE TAX is on the title, the warning and the settlement line', () => {
  // Clause 6 puts Corporation Tax, VAT and statutory deductions ahead of
  // settlement. A partner reading one line in isolation must not be able to
  // mistake any of these for what lands in their bank.
  const e = partnerEarningsEmbed(sample(), { config }).embeds[0];
  assert.match(e.title, /BEFORE TAX/);
  assert.match(e.description, /BEFORE TAX/);
  assert.match(e.footer.text, /before tax/i);
  const tagged = e.fields.filter((f) => /BEFORE TAX/.test(f.name)).length;
  assert.ok(tagged >= 3, `only ${tagged} field headings say BEFORE TAX`);
});

test('the card is financial, so it carries no emoji', () => {
  const text = JSON.stringify(partnerEarningsEmbed(sample(), { config }));
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), 'found an emoji on a revenue card');
});

test('the card stays inside Discord limits', () => {
  const e = partnerEarningsEmbed(sample(), { config }).embeds[0];
  assert.ok(JSON.stringify(e).length < 6000);
  assert.ok(e.fields.length <= 25);
  for (const f of e.fields) assert.ok(f.value.length <= 1024, `field "${f.name}" over 1024`);
});

test('a big roster does not blow the per-creator field', () => {
  const many = Array.from({ length: 60 }, (_, i) => who(`creator_number_${i}_longish`, { days: [1000 + i] }));
  const r = partnerRevenue({ creators: many, asOf: '2026-10-01', config, partner });
  const e = partnerEarningsEmbed(r, { config }).embeds[0];
  for (const f of e.fields) assert.ok(f.value.length <= 1024, `field "${f.name}" over 1024`);
  assert.ok(JSON.stringify(e).length < 6000);
});

// --- when it posts ---------------------------------------------------------

test('it posts once a day, and only once', () => {
  const store = { data: {} };
  assert.equal(partnerDue(config, store, ASOF), true);
  store.data.lastPartnerOn = ASOF;
  assert.equal(partnerDue(config, store, ASOF), false);
  assert.equal(partnerDue(config, store, '2026-10-11'), true);
});

test('with no partners configured it does not post at all', () => {
  assert.equal(partnerDue({ partners: { enabled: true, agencies: [] } }, { data: {} }, ASOF), false);
  assert.equal(partnerDue({ partners: { enabled: false, agencies: [partner] } }, { data: {} }, ASOF), false);
});

test('a disabled partner is skipped', () => {
  const two = {
    ...config,
    partners: {
      ...config.partners,
      agencies: [{ ...partner }, { name: 'Other', group: 'Other', tier: 'Seedling', enabled: false }],
    },
  };
  const rs = partnerRevenues({ creators: [who('a', { days: [1000] })], asOf: '2026-10-01', config: two });
  assert.deepEqual(rs.map((r) => r.partner), ['Stay Social']);
});

// --- the activeness incentive ----------------------------------------------
//
// TikTok pays the agency three ways, not two. This system knew about two of
// them until Backstage's September page was read: rank-up $11.20K, activeness
// $8.04K, incremental $23.21K.

const withLevels = (levels) => ({
  ...config,
  partners: {
    ...config.partners,
    agencies: [{ ...config.partners.agencies[0], levels }],
  },
});

test('activeness is diamonds x $0.01 x the level ratio', () => {
  const cfg = withLevels({ '2026-10': { a: 3 } });
  const r = partnerRevenue({
    creators: [who('a', { days: [71173] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  // Level 3 is 2%. This is victoria.willis8's September row, which Backstage
  // priced at $14.23.
  assert.equal(r.activenessUsd, 14.23);
});

test('every one of September\'s seven creators reproduces Backstage to the cent', () => {
  // The reconciliation this whole model rests on. Backstage's per-creator
  // activeness view for StaySocial, September 2026.
  const rows = [
    ['victoria.willis8', 71173, 3, 14.23],
    ['scottie2k26', 7625, 4, 1.90],
    ['jeddyslays_20', 17573, 2, 1.75],
    ['i_am_shoooook', 2762, 3, 0.55],
    ['sbird198', 1714, 3, 0.34],
    ['therealmelty', 30174, 0, 0.00],
    ['anf_203', 1733, 0, 0.00],
  ];
  const cfg = withLevels({ '2026-10': Object.fromEntries(rows.map(([u, , l]) => [u, l])) });
  for (const [username, diamonds, , expected] of rows) {
    const r = partnerRevenue({
      creators: [who(username, { days: [diamonds] })],
      asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
    });
    // Within a penny of Backstage's own figure. Backstage TRUNCATES where this
    // rounds — it shows $1.90 for scottie2k26's $1.90625 and $1.75 for
    // jeddyslays_20's $1.7573 — so an exact match on every row is not
    // available, and a card that claimed one would be overstating its own
    // precision on a figure it already calls a rough estimate.
    assert.ok(Math.abs(r.activenessUsd - expected) < 0.011,
      `${username}: got $${r.activenessUsd}, Backstage shows $${expected}`);
  }
});

test('the whole September month reconciles to Backstage\'s $124.99', () => {
  // activeness $18.79 + incremental at 8% on 132,754 diamonds ($106.20) +
  // nothing from rank-ups, because nobody ranked up.
  const rows = [
    ['victoria.willis8', 71173, 3], ['scottie2k26', 7625, 4], ['jeddyslays_20', 17573, 2],
    ['i_am_shoooook', 2762, 3], ['sbird198', 1714, 3], ['therealmelty', 30174, 0], ['anf_203', 1733, 0],
  ];
  const cfg = {
    ...withLevels({ '2026-09': Object.fromEntries(rows.map(([u, , l]) => [u, l])) }),
    revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05, actualRate: { '2026-09': 0.08 } } },
  };
  const r = partnerRevenue({
    creators: rows.map(([u, d]) => who(u, { days: [d], month: '2026-09' })),
    asOf: '2026-09-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.diamonds, 132754);
  assert.equal(r.rate, 0.08);
  assert.equal(r.rateIsActual, true);
  assert.equal(r.incrementalUsd, 106.2);
  assert.equal(r.activenessUsd, 18.79);
  assert.equal(r.rankUpUsd, 0);
  // Backstage shows $124.99; it truncates where this rounds.
  assert.ok(Math.abs(r.agencyUsd - 124.99) < 0.02, `got $${r.agencyUsd}`);
});

test('a creator on no level earns nothing from activeness however many diamonds', () => {
  const cfg = withLevels({ '2026-10': { big: 0 } });
  const r = partnerRevenue({
    creators: [who('big', { days: [500000] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.activenessUsd, 0);
  assert.deepEqual(r.noLevel.map((x) => x.username), ['big']);
  // But the incremental share still pays on them.
  assert.ok(r.incrementalUsd > 0);
});

test('a creator we hold no level for contributes nothing rather than a guess', () => {
  // The level comes from valid LIVE days AND duration, and fitting a ladder to
  // seven known rows got four of seven right. Seven rows is not enough to fit
  // two variables, so this does not pretend to.
  const r = partnerRevenue({
    creators: [who('unknown', { days: [50000] })],
    asOf: '2026-10-01', config, partner,
  });
  assert.equal(r.activenessUsd, 0);
  assert.equal(r.levelsKnown, 0);
  assert.deepEqual(r.levelsUnknown.map((x) => x.username), ['unknown']);
});

test('last month\'s levels are carried forward, and the result says so', () => {
  const cfg = withLevels({ '2026-09': { a: 3 } });
  const r = partnerRevenue({
    creators: [who('a', { days: [10000] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.rows[0].level, 3);
  assert.equal(r.rows[0].levelFrom, 'carried forward');
  assert.equal(r.levelsCarried, 1);
});

test('this month\'s level wins over last month\'s', () => {
  const cfg = withLevels({ '2026-09': { a: 2 }, '2026-10': { a: 4 } });
  const r = partnerRevenue({
    creators: [who('a', { days: [10000] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.rows[0].level, 4);
  assert.equal(r.rows[0].levelFrom, 'month');
});

test('a level is matched without the @ and without case', () => {
  const cfg = withLevels({ '2026-10': { '@Victoria.Willis8': 3 } });
  const r = partnerRevenue({
    creators: [who('victoria.willis8', { days: [10000] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.rows[0].level, 3);
});

test('levels 2, 3 and 4 are confirmed and 1 and 5 are not', () => {
  // No LEAP creator has been seen on level 1 or 5, so those ratios are a
  // straight-line guess and must not be presented as fact.
  const cfg = withLevels({ '2026-10': { a: 3, b: 5 } });
  const r = partnerRevenue({
    creators: [who('a', { days: [1000] }), who('b', { days: [1000] })],
    asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(r.rows.find((x) => x.username === 'a').levelConfirmed, true);
  assert.equal(r.rows.find((x) => x.username === 'b').levelConfirmed, false);
});

// --- which incremental rate ------------------------------------------------

test('a partner is costed at the rate TikTok actually settled, not the board rate', () => {
  // The coach boards quote 5% to under-promise. A partner is settled on what
  // their creators actually generated, and quoting 5% against a real 8%
  // understates them by over a third.
  const cfg = {
    ...config,
    revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05, actualRate: { '2026-09': 0.08 } } },
  };
  const r = partnerRevenue({
    creators: [who('a', { days: [100000], month: '2026-09' })], asOf: '2026-09-01', config: cfg, partner,
  });
  assert.equal(r.rate, 0.08);
  assert.equal(r.rateIsActual, true);
  assert.equal(r.incrementalUsd, 80);
});

test('a month TikTok has not settled falls back to the board rate and says it is provisional', () => {
  const cfg = {
    ...config,
    revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05, actualRate: { '2026-09': 0.08 } } },
  };
  const r = partnerRevenue({
    creators: [who('a', { days: [100000] })], asOf: '2026-10-01', config: cfg, partner,
  });
  assert.equal(r.rate, 0.05);
  assert.equal(r.rateIsActual, false);
});

test('turning off useActualRate puts a partner back on the board rate', () => {
  const cfg = {
    ...config,
    partners: { ...config.partners, useActualRate: false },
    revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05, actualRate: { '2026-09': 0.08 } } },
  };
  const r = partnerRevenue({
    creators: [who('a', { days: [100000], month: '2026-09' })], asOf: '2026-09-01', config: cfg, partner,
  });
  assert.equal(r.rate, 0.05);
});

test('last month is costed at last month\'s rate, not this month\'s', () => {
  // Restating a settled month at today's rate would quietly disagree with what
  // the partner was actually paid.
  const cfg = {
    ...withLevels({ '2026-09': { a: 3 } }),
    revenue: { usdToGbp: 0.754074, incremental: { boardRate: 0.05, actualRate: { '2026-09': 0.08 } } },
  };
  const c = who('a', { days: [1000], septTotal: 100000 });
  const r = partnerRevenue({ creators: [c], asOf: '2026-10-01', config: cfg, partner: cfg.partners.agencies[0] });
  assert.equal(r.lastMonth.diamonds, 100000);
  // 100,000 x $0.01 x 8% = $80 incremental, plus level 3 activeness at 2% = $20.
  assert.equal(r.lastMonth.usd, Math.round(100 * 0.85 * 100) / 100);
});

// --- the card --------------------------------------------------------------

test('the breakdown names all three incentives and still adds up', () => {
  const cfg = withLevels({ '2026-10': { 'victoria.willis8': 3, frisk7046: 2 } });
  const r = partnerRevenue({
    creators: [
      who('victoria.willis8', { days: [16047, 40000, 2161, 170] }),
      who('frisk7046', { days: [0, 16030, 6000, 7204] }),
    ],
    asOf: '2026-10-04', config: cfg, partner: cfg.partners.agencies[0],
  });
  assert.equal(Math.round((r.incrementalGbp + r.activenessGbp + r.rankUpGbp) * 100) / 100, r.agencyGbp);
  const e = partnerEarningsEmbed(r, { config: cfg }).embeds[0];
  const breakdown = e.fields.find((f) => /breakdown/.test(f.name)).value;
  assert.match(breakdown, /Incremental share/);
  assert.match(breakdown, /Activeness/);
  assert.match(breakdown, /Rank-up bonuses/);
});

test('the card says when the incremental rate is provisional', () => {
  const e = partnerEarningsEmbed(sample(), { config }).embeds[0];
  assert.match(e.fields.find((f) => /breakdown/.test(f.name)).value,
    /provisional, because TikTok has not settled this month yet/);
});
