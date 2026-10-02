# LEAP creator-health — everything the system knows

A single reference to what this pipeline does, every rule and formula in it,
how each one was verified, and what is still open. Written to be read whole:
by a person, or by another tool that needs LEAP's domain knowledge without
reading 36 source files.

No secrets here. Webhook URLs and tokens live in `routes.json` (gitignored)
and in the host's environment variables.

---

## 1. What it is

A daily pipeline over TikTok's **Creator data** .xlsx export. A file goes in,
Discord cards come out. It runs as a web service; `server.mjs` takes uploads,
`cli.mjs` does the same work from a terminal.

- **Live service:** `leap-creator-health.onrender.com`
- **Repo path:** `creator-health/`
- **Runtime:** Node, zero dependencies. The .xlsx reader is hand-written
  (`lib/xlsx.mjs`): zip central directory + `zlib.inflateRawSync` + XML regex.
- **Tests:** 328, run with `npm test`.

---

## 2. The data model — the thing that changes everything

**The export is month-to-date cumulative, not daily.** Every counter —
diamonds, LIVE duration, valid LIVE days, new followers, fan club — is the
total since the 1st. They all reset to zero on the 1st.

So a day's figure is `today's MTD − yesterday's MTD`, and within a month MTD
can only ever go up. `lib/store.mjs` folds this out on ingest and stores
per-observation **deltas**; everything downstream reads deltas, not raw MTD.

**The export runs a day behind.** A file pulled on 30 September covers
1–29 September. To close a month you pull on the 1st of the next one — that
export covers the full previous month. Verified: snapshots exist for
`2026-07-31` and `2026-08-31`, both complete months.

**Missing days are spread, not lost.** `allocateDaily` in `lib/metrics.mjs`
splits a multi-day observation evenly across the days it covers. Totals stay
right; individual days become estimates. `observed` marks the days that came
from a true single-day upload.

### Columns that matter

| Export column | Our name | Note |
|---|---|---|
| Diamonds | `mtd.diamonds` | |
| LIVE duration | `mtd.liveHours` | `"126h 27m 31s"` → 126.4586 |
| Valid go LIVE days | `mtd.validLiveDays` | |
| New followers | `mtd.newFollowers` | |
| New fans | `mtd.newFans` | Fan club members gained |
| Fan Club total Diamonds | `mtd.fanClubDiamonds` | **See the warning below** |
| Diamonds last month | `lastMonthDiamonds` | Sets the TikTok tier |
| Tier status | `tierStatus` | TikTok's own "Ranked up"/"Maintained"/"Not maintained" |
| Graduation status | `graduationStatus` | |

**Warning on "Fan Club total Diamonds".** Despite the name it is **not** the
paid Fan Club subscription — it is diamonds from **followers**, which TikTok's
companion column calls "Fan contribution %". Our figure matches that column
for 650 of 650 creators. It runs at ~93% of all diamonds network-wide, and a
paid tier that is 9.8% of followers cannot produce 93% of the gifting.

---

## 3. The money — every formula, and how it was proved

### 3.1 Rank ups (the TikTok rank-up task)

```
TikTok pays LEAP:  diamonds × $0.01 × the creator's tier ratio
LEAP pays a coach: diamonds × $0.01 × 1%      (a flat 1%, NOT a share of the ratio)
```

Paid **only** on creators TikTok marks `Ranked up` — not "maintained", not a
diamond floor. Paid on the creator's **whole month**, not the threshold crossed.

- **Verified against Backstage, to the cent.** Its per-creator rank-up page on
  30 September: `coregaming2811` 458,691 → $344.01, `sur3shot` 314,254 →
  $235.69, `samboogames` 214,578 → $160.93, `.yas_xoxoo` 172,494 → $129.37.
  Every one is `diamonds × $0.01 × 0.075`.
- **The ratio is Advanced (7.5%), not Base (6.5%).** None of those four lands
  at 6.5%.
- **The coach's 1% reproduces the WAGES CALCUATOR exactly** across 174 rows,
  February to July.
- **"Ranked up only" was tested against nine other populations** (including
  "ranked up or maintained") by backing August out of Backstage's own
  "vs last month" percentages. It won by a distance.

**Rank-ups land late in the month.** Network creators marked Ranked up in
September: 6 by the 14th, 8 by the 15th, 17 by the 20th, **33 by the 30th**.
About half arrive after the 20th. A mid-month figure is not a forecast.

Code: `lib/tiers.mjs` (tier table, `rankUpFor`), `lib/revenue.mjs`.

#### The tier table

Tier is set by **last month's** diamonds and cannot move during the month.

| Tier | From | Base | Advanced |
|---|---|---|---|
| 1–5 | 0 / 100k / 200k / 300k / 500k | 6.5% | 7.5% |
| 6 | 700,000 | 5.5% | 6.5% |
| 7 | 1,000,000 | 4.5% | 5.5% |
| 8 | 1,600,000 | 3.5% | 4.5% |
| 9 | 2,500,000 | 3.0% | 4.0% |
| 10 | 5,000,000 | — | — |

Validated against the export's own `Tier last month` column: 804 of 808 agree.

### 3.2 Incremental share (the sheet's MANAGER DIAMOND %)

```
roster diamonds × $0.01 × TikTok's incremental rate × the coach's unlock × FX
```

- Paid across the coach's **whole roster**, not just those who ranked up.
- **TikTok's rate moves with network volume:** 8% in September on 29.0m
  diamonds, ~4% in August on 25.3m. The next band at 30.34m was worth +$4.09K.
- **The coach's unlock is 10%, 15% or 20%.** Everyone starts at 10%; hitting
  the group's monthly **diamond goal** adds 5%, hitting the **recruiter goal**
  adds another 5%. Goals come off Backstage's Group goals page on the 1st.
- **FX:** `usdToGbp` = 0.754074.

**Verified against LEAP's finance sheet, to the penny, for all ten coaches in
September** — every one implies a rate of exactly 8.00%. The whole
INCREMENTAL DIAMOND % total reconciles at £2,630.99 once Mr Kins (£19.80),
Jed (£378.31) and Surge (£291.53) are added to the ten coaches' £1,941.35.

**The cards always quote 5%, never the live rate.** LEAP's instruction: a card
must not promise in a good month what a quiet one cannot pay. The real figure
lives in `revenue.incremental.actualRate` for reconciliation and no card reads
it. A test pins that.

Code: `lib/revenue.mjs`. Config: `revenue.incremental`, `revenue.goals`.

### 3.3 Leaps (new recruit bonus)

£10 once per creator, the first time their **cumulative lifetime** totals pass
**5 LIVE hours and 5,000 diamonds**. Frozen on first sight — a re-run or a
config change can never move anybody's pay.

September is a hardcoded override (`leaped.monthOverride`, £390 total) because
the system started watching on 31 August and could not tell who crossed that
month from who had crossed long before. It credited 73 where the sheet says 40.
**From October it computes itself.**

Code: `lib/leaped.mjs`, `lib/leapedimport.mjs`.

### 3.4 Fixed pay

`revenue.baseWageByCoach`. Sur3shot 350, Colesy 250, CamB 100, rest 150.

### 3.5 September 2026 actuals, for reference

| Coach | Fixed | Leaps | Rank-ups | Share | Total |
|---|---|---|---|---|---|
| Sur3shot | £350 | £110 | £87.47 | £259.73 | £807.21 |
| Unc | £150 | £40 | £258.27 | £149.86 | £598.14 |
| Cam | £100 | £150 | £97.90 | £75.80 | £423.70 |
| Muju | £150 | £10 | £81.60 | £124.16 | £365.76 |
| Colesy | £250 | £0 | £44.68 | £67.55 | £362.23 |
| Bean | £150 | £30 | £37.74 | £76.64 | £294.38 |
| Reefman | £150 | £30 | £46.33 | £44.54 | £270.87 |
| Slow | £0 | £0 | £137.21 | £118.24 | £255.45 |
| Malkin | £150 | £20 | £21.64 | £28.75 | £220.39 |
| Chavy | £150 | £0 | £0 | £28.18 | £178.18 |
| **Total** | **£1,600** | **£390** | **£908.90** | **£1,023.74** | **£3,922.64** |

TikTok's September incremental pot was **$23,210 (£17,502)**. Total paid out
£2,630.99 — **the business kept 85%**.

Mandatory on every earnings card, verbatim, pinned by a test:
> **THIS IS FOR VISUAL PURPOSES AND A ROUGH ESTIMATE OF YOUR INCOME, NOT
> EXACT. FOR EXACT FIGURES TALK TO THE DIRECTORS**

---

## 4. LEAP's leagues (competitions, not pay)

Four leagues, by a month's diamonds. **Separate from TikTok's ten tiers and
they touch nobody's pay.**

| League | Diamonds |
|---|---|
| Aspire | 0 – 49,999 |
| Rising | 50,000 – 199,999 |
| Elite | 200,000 – 499,999 |
| Pro | 500,000+ |

**You are placed by LAST month's diamonds and ranked within that league by
THIS month's.** Reverse-engineered from LEAP's own published winners post:
9 of 9 matched July (the month before the competition), not August.

A **rank-up is final** the moment it happens — MTD only goes up. A **drop is
provisional**: a creator below their league is only de-ranked when
`perDay × daysLeft < shortBy`; otherwise they are *slipping* and can still
get back.

Code: `lib/leagues.mjs`, `lib/rankings.mjs`. Pulled on a button, not daily.

---

## 5. The boards and cards

### Coach-facing (team channels)

| Card | Cadence | Code |
|---|---|---|
| Per-creator decline / opportunity / activation cases | On change | `lib/cases.mjs`, `lib/rules.mjs` |
| Team daily summary (incl. earnings + goal progress) | Daily | `lib/teamsummary.mjs` |
| 200k graduation milestones | On crossing a rung | `lib/graduation.mjs` |
| 200k final push | Last 5 days of month | `lib/graduation.mjs` |
| Activeness gate pings | Closing days | `lib/activeness.mjs` |
| Recruitment leaderboard | Daily | `lib/leaderboard.mjs` |
| Coach growth board | Daily | `lib/growthboard.mjs` |
| League up / down / per-team | Button | `lib/rankings.mjs` |
| Leaped events + payroll overview | Daily | `lib/leaped.mjs` |

### Creator-facing (separate Discord server)

| Card | Cadence | Code |
|---|---|---|
| **Hardest Worker Challenge** | Daily; winner on the last day; resets on the 1st | `lib/hardestworker.mjs` |
| **Creator of the Week** | Daily; winner Sunday; resets Monday | `lib/creatorweek.mjs` |

Both publish **no figures** — a score and a position only. Creator earnings are
nobody else's business and the whole network reads those channels.

#### Hardest Worker
Ranked on month-to-date **LIVE hours**. Top 10. Quits and partner agencies out.
Zero-hour creators are not listed. Wording is LEAP's own, off the card they
made by hand.

#### Creator of the Week — the scoring
Weeks run **Monday to Sunday**. Not a board for whoever is biggest:

- **Four pillars**, scored by **position** in the network, not size:
  fan club (weight 4), diamonds (3), LIVE hours (3), followers (1).
- **Growth against the creator's own baseline** — the *same days* of each of
  the previous 3 weeks. Damped by the network's median baseline, so two
  diamonds becoming twenty is not read as a tenfold week, and 0 → something is
  finite rather than infinite.
- **Score = growth × 3 + standing × 1.** "Are they growing, and doing well."
- **Only the top 25% of the week's field by performance can win.** Taken as a
  share of the field, not a score to beat — a fixed threshold collapses when a
  pillar is a near-universal tie and hands the award to the creator it was
  written to stop. No bar below 20 entrants.
- **You cannot win without going LIVE.**

---

## 6. What predicts a creator doing well

Measured, not assumed: 99 creators who joined in **August**, scored on what
they went on to do in **September**. Spearman correlation of each first-month
signal with next-month diamonds:

| First-month signal | Correlation |
|---|---|
| **Fan club members per day** | **0.647** |
| Diamonds per day | 0.635 |
| Diamonds per hour | 0.588 |
| LIVE-day rate (how often they turn up) | 0.571 |
| Hours per day | 0.550 |
| Followers per day | 0.529 |
| Fan-club share of gifts | 0.150 |
| Which day of the month they joined | −0.011 |

**Fan club growth is the single best predictor of future earnings — better
than diamonds.** Blending the top five gives **0.667**, beating every
individual signal.

What it is worth: on the August cohort, the **top quarter** of the blend had a
median September of **16,714 diamonds**; the **bottom quarter, zero**.

**Turning up beats having a big night.** A creator on 58,188 diamonds who
streamed 2 days of 11 scores below one on 7,926 who streamed 10 of 11.

Needs **at least 7 days** of history — a per-day rate off one session is noise.

---

## 7. Mechanics worth knowing

- **Replace, don't stack.** Recurring cards post the new one, then delete the
  old (`replaceLast` in `lib/dispatch.mjs`). Post-then-delete, so a failure
  leaves a stale card rather than an empty channel.
- **`supersedes(previous, period, newId)`** — a card with a period only
  replaces within that period, so a month's closing board survives. The two
  creator-facing boards pass **no** period, so they clear on the 1st / Monday.
- **Duplicate sweep** (`lib/sweep.mjs`) removes our own older copies matching
  the *exact* title just posted. Paginated cards must have distinct titles
  (`"(1 of 3)"`) or page 2 would delete page 1.
- **Show every name.** `paginateList` splits long lists across fields and
  messages rather than trimming — staff make a poster for each one.
- **Discord limits:** field value 1024, embed total 6000, 25 fields.
- **`new Response('', {status: 204})` throws in undici.** Must be `null`.
- **Floating point:** `0.10 + 0.05 = 0.15000000000000002`. Rates and unlocks
  are rounded with `toPrecision(6)`.

---

## 8. Files

```
creator-health/
  server.mjs              web service: /upload /run /redo /rankings /hardest
                          /creator-week /export /selftest /status.json /health
  cli.mjs                 same work from a terminal
  config.json             every rule, rate, weight and goal
  routes.deploy.json      Discord routes, env: references only (committed)
  routes.json             real webhooks (GITIGNORED)
  public/upload.html      upload page and the action buttons
  lib/
    xlsx.mjs              the .xlsx reader
    normalize.mjs         export row -> our shape
    store.mjs             snapshots, series, MTD -> deltas
    metrics.mjs           allocateDaily, windowSum, rolling windows
    policy.mjs            monthMtd and the policy standing
    rules.mjs causes.mjs cases.mjs playbook.mjs      the alerting engine
    tiers.mjs             TikTok tiers and rank-ups
    leagues.mjs           LEAP's four leagues
    revenue.mjs           all coach pay
    leaped.mjs leapedimport.mjs                      the £10 leap bonus
    graduation.mjs ramp.mjs                          the 200k chase
    activeness.mjs activation.mjs                    gates and non-starters
    leaderboard.mjs growthboard.mjs                  coach boards
    hardestworker.mjs creatorweek.mjs                creator-facing boards
    challenge.mjs         the on-demand refresh for both creator boards
    rankings.mjs          the league button
    teamsummary.mjs digest.mjs discord.mjs dispatch.mjs notify.mjs sweep.mjs
    redo.mjs              repost today, fresh
  test/                   22 files, 328 tests
```

---

## 9. Open questions and next steps

**Security — do this first.**
`UPLOAD_TOKEN` is **not set** on the host. `server.mjs` has
`if (!TOKEN) return true`, so every endpoint is public: the full creator
database and payroll records are downloadable by anyone with the URL, and
`/upload`, `/redo` and both creator boards can be triggered by anyone.
Set it in the host's environment and paste the same string into the upload
page's token box.

**Known gaps**
- **6–19 September has no uploads.** 15 days spread from one reading. Totals
  are right, daily movement is estimated. Creator of the Week baselines are
  fully clean from the week of 12 October.
- **A fourth Backstage goal column** (`0/23` on Colesy's row) is unexplained.
  We use the middle two: diamonds and recruits.
- **`leapagencyuk` has no October goals** — sits on the 10% base.
- **Cam's goals were removed** at LEAP's request. His card was already hidden;
  the side effect is his internal figure now computes at 10%, not the 20% his
  September row was paid at.
- **The recruiter goal is read as "creators who joined this month"**, credited
  to their manager. Unconfirmed against Backstage's own definition.
- **$612.88 gap** between Backstage's manager leaderboard ($1,482.88 for
  joshbates93) and its own per-creator page ($870.00, which we reproduce
  exactly). Likely other bonus tasks in the manager figure. Unresolved.
- **A failed daily run tells nobody** — it is caught and written to
  `console.error`. The service stays up and the channels go quiet.
- **Creator of the Week has never completed a live week.** The Sunday winner
  and Monday reset were proved against a local stand-in, not in production.

**Suggested next**
1. Set `UPLOAD_TOKEN`.
2. Make a failed daily run post to the overview channel.
3. Dry-run the October leap transition before it lands in a wage card.
4. Decide whether the 200k chase should cover the whole network, not only
   creators inside their 90-day window (242 of 915).
5. Monthly on the 1st: read Backstage's Group goals into `revenue.goals`, and
   record the month's real rate in `revenue.incremental.actualRate`.
