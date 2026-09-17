# Creator health monitoring

Daily pipeline over the TikTok **Creator data** export. Two jobs:

1. **Catch a creator sliding while it is still fixable** — diamonds, LIVE hours,
   fan club — and message their coach with what changed and what to do.
2. **Run the first-90-days push to 200,000 diamonds** — who is on pace, who is
   behind, who has the raw ability to get there, and which lever closes the gap.

---

## The thing that changes everything

The export is **month-to-date cumulative**, not daily. The `Data period` column
reads `2026-09-01 ~ 2026-09-15`, and every counter in the row — Diamonds, LIVE
duration, Valid go LIVE days, New followers, Fan Club diamonds — is the total
**since the 1st of the month**.

Consequences, all of which the pipeline handles:

| What happens | What it looks like if you ignore it | What we do |
|---|---|---|
| Counters reset on the 1st | Every creator appears to lose ~100% overnight | The period start is parsed; a new month means the delta *is* the new total |
| Numbers only ever go up within a month | "Growth" every single day, for everyone | Yesterday's file is subtracted from today's to get the real day |
| A missed upload | A day silently vanishes | The gap is detected and the delta is spread over the days it covers |
| The same file uploaded twice | Everything double counts | Keyed by the period end date — a repeat upload is a no-op |
| A restated total | A negative day | Clamped to zero and flagged `restated` |

**There is no column for "diamonds since joining."** That number — the one the
200k target is measured against — does not exist in the export. It has to be
accrued by this tool, one daily file at a time. This is the single strongest
reason to start uploading daily *now*: every day skipped is a permanent hole.

Two smaller traps also handled:

- Creators who leave have their **Creator ID replaced with the literal text
  "The creator has quit the network"** and their join time blanked. In the
  sample files that is 96 rows sharing one "ID". Keying on Creator ID alone
  collapses them into a single ghost creator. They are matched back by username.
- `Fan contribution %` arrives as `0.94618`, not `94.618%`. Both forms are
  accepted.

---

## Pipeline

```
   daily .xlsx
        │
        ▼
 ┌──────────────┐   parse the zip + sheet XML directly, no dependencies
 │ 1  read      │   lib/xlsx.mjs
 └──────────────┘
        │
        ▼
 ┌──────────────┐   map columns, parse "126h 27m 31s", resolve identity,
 │ 2  normalise │   separate quit rows          lib/normalize.mjs
 └──────────────┘
        │
        ▼
 ┌──────────────┐   store the snapshot immutably, convert month-to-date
 │ 3  accrue    │   totals into per-day deltas  lib/store.mjs
 └──────────────┘
        │
        ▼
 ┌──────────────┐   7/14/28-day windows, each creator's own baseline and
 │ 4  measure   │   volatility                  lib/metrics.mjs
 └──────────────┘
        │
        ├─────────────────────────────┐
        ▼                             ▼
 ┌──────────────┐            ┌──────────────┐
 │ 5a decline   │            │ 5b 200k ramp │
 │ lib/rules.mjs│            │ lib/ramp.mjs │
 └──────────────┘            └──────────────┘
        │                             │
        └─────────────┬───────────────┘
                      ▼
            ┌──────────────────┐   group by Creator Network manager,
            │ 6  message coach │   render, send  lib/digest.mjs + notify.mjs
            └──────────────────┘
```

Snapshots are the source of truth and are never rewritten. Everything else is
derived, so `rebuild` re-runs the whole history after any rule change — which
means thresholds can be re-tuned and back-tested against data already collected.

---

## Catching a decline early

### Why "watch the diamonds" is too late

Diamonds are the **last** thing to move. When a creator starts to go, the
metrics fall in this order:

| When | What moves | In the export |
|---|---|---|
| Day 0 | They skip a scheduled LIVE | `Valid go LIVE days` |
| Day 0–3 | Sessions get shorter | `LIVE duration` |
| Day 3–7 | Regulars drift, fan club thins | `Active fans from Fan Club`, `New fans` |
| Day 7–14 | **Diamonds fall** | `Diamonds` |

By the time the diamond number looks bad, the cause is two weeks old and the
habit has set. So the pipeline scores attendance and session length in their own
right, and treats a diamond drop as **confirmation**, not discovery.

### The signals

| Signal | Fires when | Type |
|---|---|---|
| `DARK` | No LIVE for longer than twice their normal gap between streams | leading |
| `LIVE_DAYS_DOWN` | Lost LIVE days this week vs last, beyond their own variance | leading |
| `HOURS_DOWN` | LIVE hours down week on week | leading |
| `SUSTAINED_HOURS_DOWN` | Hours below their weeks 3–8 normal | leading |
| `FANCLUB_FANS_DOWN` | Active fan-club members shrinking | leading |
| `CONCENTRATION_RISK` | >85% of income from the fan club **and** it is shrinking | context |
| `EFFICIENCY_DOWN` | Same hours, fewer diamonds per hour | confirming |
| `FANCLUB_DIAMONDS_DOWN` | Fan club spending less | confirming |
| `DIAMONDS_DOWN` | Diamonds down week on week | confirming |
| `SUSTAINED_DIAMONDS_DOWN` | Diamonds below their weeks 3–8 normal | confirming |

### Three design decisions that make it usable

**1. Every threshold is relative to that creator.** A `-35%` week is routine for
someone whose income swings with whichever gifter turns up, and alarming for
someone who bills like clockwork. Each creator's own week-to-week volatility is
measured over 8 weeks, and the threshold is raised to clear their personal noise
floor. Same for attendance: two days off air is an emergency for someone live
six days a week and completely normal for someone live once a week.

**2. Both "it just changed" and "it changed and stayed changed."** Week-on-week
catches the moment something breaks. But once a creator settles at a lower
level, this week looks identical to last week and the whole slide goes silent —
so everything is *also* compared against their **weeks 3–8 baseline**, which
deliberately skips the two most recent weeks because a slide in progress has
already dragged those down. Adding this lifted detection of injected declines
from 58% to 79%.

**3. One signal is a nudge; two that agree is a phone call.** A single metric
moving is noise more often than it is a problem. The output is graded:

- 🔴 **urgent** — a leading *and* a confirming signal agree, or one severe signal
- 🟠 **warn** — two signals agree
- 🟡 **early** — one signal only; a one-line mention, not an interruption

### Ranking

Coaches get a sorted list, not an alphabetical one. Rank is severity first, then
**diamonds at risk** = what the next 28 days lose if this week's rate holds. The
biggest losses come first.

### Not everyone is eligible

In the sample file, **242 of 806 active creators earned zero diamonds all
month** and 548 of 798 earned nothing on the day measured. Alerting on them
would bury the real signal. A creator must have an established rhythm — at
least 4 valid LIVE days in the trailing 28 — before "deviation" means anything.
Everyone else belongs on an **activation** list, which is a recruitment problem,
not a decline problem.

### Not the same alert every morning

Alert state persists. A coach is messaged when something is **new** or has
**worsened**, then not again for 5 days unless it deteriorates further.
Recoveries are reported once. Measured over a simulated week of daily runs:

| Day | Open | Messaged | Call-worthy | New | Worsened | Recovered |
|---|---|---|---|---|---|---|
| 1 (cold start) | 129 | 129 | 68 | 129 | 0 | 0 |
| 2 | 135 | 36 | 16 | 27 | 9 | 20 |
| 3 | 130 | 30 | 19 | 16 | 14 | 19 |
| 4 | 145 | 57 | 32 | 32 | 25 | 17 |
| 5 | 143 | 40 | 23 | 23 | 17 | 21 |

Day one flags everything at once; after that it settles to **30–57 messages a
day across 16 coaches — roughly 2–3 each.**

### What a coach receives

```
LEAP creator check — 2026-09-15
Coach: joshbates93@hotmail.com

DECLINING — 16 creators, ~569,737 diamonds at risk

🔴 @sur3shot — Team Alpha, day 503
   This week: 15,384 diamonds (-43%) · 8.0h LIVE (-25%) · 4 LIVE days
   • 2 fewer LIVE days this week — 4 valid LIVE days in the last 7, down from 6.
   • Fan Club diamonds -38% — Fan club gave 14,819 this week vs 24,084 last week.
   • Diamonds -43% — 15,384 this week vs 26,965 last week — 11,581 fewer.
   • Diamonds -44% below their normal — 15,384 this week against a 27,389 weekly
     average before this started — this has been running for weeks, not days.
   At risk: ~31,655 diamonds over the next 28 days if this holds
   👉 They have dropped 2 LIVE days a week. Getting those back is worth about
      8,875 diamonds a week. Ask what is blocking those days before talking
      about content.

EARLY SIGNS — one signal only, worth a message not a call (13)
   🟡 @hex_rated — Fan Club diamonds -33%
   🟡 @georgia.senpai — Fan Club diamonds -35%
   🟡 @fort26857 — Fan Club diamonds -50%
```

(That is a cold start on simulated data — the first run flags everything at
once. See the volume table below for the steady state.)

Every alert ends with a concrete ask derived from which lever actually moved —
attendance, session length, or conversion — with the diamonds attached so the
coach can lead with the number.

---

## The first 90 days: 200,000 diamonds

### Tracking

`Days since joining` is in the export, so the cohort is exact. Cumulative
diamonds since joining is not, so it is accrued daily from the deltas.

For creators who joined **before** this tool started, the pipeline reports
`blindDays` and marks the figure `exact: false` rather than quietly guessing.
One month of otherwise-lost history is recovered from the `Diamonds last month`
column on a creator's first snapshot. From a clean start every figure is exact.

### The pacing curve

Straight-line pacing (2,222/day from day one) is wrong — new creators ramp, and
it would flag every promising creator as failing in week one. The default curve:

| Milestone | Target | Share |
|---|---|---|
| Day 30 | 30,000 | 15% |
| Day 60 | 90,000 | 45% |
| Day 90 | 200,000 | 100% |

Interpolated between milestones and fully configurable. Status is `ON_TRACK` /
`AT_RISK` / `OFF_TRACK` / `ACHIEVED` / `MISSED` against that curve, shown
alongside the projection from the current run rate — because "ahead of pace but
the current rate finishes 93,000 short" is a real and important state.

### Who has the potential

This is the part that answers "how do we boost them." Two creators both on
30,000 at day 40 are not the same creator:

- 4,800 diamonds/hour, streaming 1.2h a day → **massive headroom**
- 180 diamonds/hour, streaming 7h a day → already maxed out

So potential is scored as **conversion rate × unused sustainable hours × days
remaining** — not on current output. Then the gap is closed with the cheapest
lever first:

1. **days** — add LIVE days at their existing session length (cheapest, biggest early win)
2. **hours** — lengthen sessions, capped at what is sustainable
3. **rate** — improve diamonds per hour; slowest to move, needs real coaching

Each produces a specific ask:

```
🔴 @ohburnzyy — day 42 of 90 (48 left) — OFF TRACK
   32,013 / 200,000 (16%) · pace target by now 54,000
   Doing 1,317/day, needs 3,500/day · at 1,171 diamonds per LIVE hour
   On this week's rate they finish day 90 on 95,250 — 104,750 short
   👉 Needs about 3.0h LIVE a day (currently 0.7h) at their 1,171 diamonds/hour.
      Build to 6 days a week first, then lengthen sessions.
```

The **boost list** is the short version: behind on the curve, but with the
conversion rate and unused hours to actually get there. In the sample data only
~20 of 336 creators inside 90 days are worth a coach's week — the rest are
either already on track or need activation before they need a target.

Sober note: median month-to-date diamonds for a creator inside 90 days is **47**.
200k in 90 days is a genuine stretch for all but a handful. The tool's job is to
find that handful early and put the coaching hours there.

---

## Running it

```bash
cd creator-health

node cli.mjs ingest ~/Downloads/Creator_data_2026_09_16_08_37_UTC0.xlsx
node cli.mjs report                      # network summary + every coach's message
node cli.mjs coach josh@example.com      # one coach
node cli.mjs creator unc.inc0            # one creator's full history
node cli.mjs status                      # what is stored, and any missing days
node cli.mjs rebuild                     # re-derive after a rule change
npm test
```

### As a service

```bash
UPLOAD_TOKEN=... npm start        # :8900
```

| Route | Purpose |
|---|---|
| `POST /upload` | The day's `.xlsx` — raw body or a multipart form field |
| `POST /notify` | Run today's analysis and push digests to webhooks (`?dry=1` to preview) |
| `GET /report.json` | Everything, machine-readable |
| `GET /coach/:email` | One coach's message |
| `GET /creator/:name` | One creator's numbers and recent history |
| `GET /health` | Snapshot count and latest date |

```bash
curl -X POST "https://.../upload" -H "Authorization: Bearer $UPLOAD_TOKEN" \
     -F "file=@Creator_data_2026_09_16_08_37_UTC0.xlsx"
curl -X POST "https://.../notify" -H "Authorization: Bearer $UPLOAD_TOKEN"
```

Uploading the same day twice is safe. Copy `routes.example.json` to
`routes.json` to route each coach to their own Slack/Discord/Telegram webhook;
URLs written as `env:VAR_NAME` are read from the environment so no secret is
committed.

### Deploying alongside the relay

It is deliberately dependency-free — the xlsx reader parses the zip and sheet
XML directly — so it deploys as a second Render service with `npm install` doing
nothing, or runs in the same container on its own port. Storage is gzipped JSON
snapshots on disk: ~900 rows a day is trivial, and moving to Postgres later
means reimplementing `lib/store.mjs` only.

**Render needs a persistent disk** mounted at `creator-health/data`, or the
accrued history — the part that cannot be rebuilt from anywhere else — is lost
on every deploy.

### Trying it before real history exists

Two days of files cannot show a 7-day trend. The simulator seeds from a real
export, gives every creator a plausible daily rhythm, and pushes ~10% of them
into decline:

```bash
node tools/simulate.mjs <real-export.xlsx> --days 60 --out ./data-sim
sed 's|"./data"|"./data-sim"|' config.json > config.sim.json
node cli.mjs rebuild --config ./config.sim.json
node cli.mjs report  --config ./config.sim.json
```

It writes `truth.json` listing which creators were pushed and when, so detection
can be scored. Current tuning catches **12 of the 13 injected declines worth
chasing** (creators earning ≥2,000 diamonds per LIVE day); the one miss had been
running two days. Smaller creators are deliberately not alerted on — an alert
about someone losing 400 diamonds a week costs more attention than it saves.

---

## Tuning

Everything lives in `config.json` — no code changes needed.

| Setting | Meaning |
|---|---|
| `tiers` | 28-day diamond bands (core / growing / emerging / dormant) |
| `decline.byTier` | Per-tier drop percentages, absolute floors, dark-day limits |
| `decline.volatilityMultiple` | How far past a creator's own noise a drop must go (1.4 ≈ 1.4σ) |
| `decline.eligibility` | Minimum activity before a creator is eligible to be alerted on |
| `decline.cooldownDays` | Days before repeating an unchanged alert |
| `ramp.curve` | The pacing milestones |
| `ramp.sustainableHoursPerDay` | What counts as a reasonable ask |
| `ramp.spotlightCount` | How many creators on the weekly boost list |

**Tune against real data.** The thresholds here are derived from the two sample
files plus a simulation. After a month of real uploads, re-run `rebuild` and
back-test: if coaches are ignoring alerts, raise `volatilityMultiple`; if real
declines are being missed, lower the tier drop percentages.

---

## Known limits

- **Pre-tracking history is a hole.** Creators who joined before day one of the
  tool carry `blindDays` and `exact: false` on the 200k figure. Only time fixes
  this.
- **Deltas are daily, not hourly.** Nothing here can see *within* a day. Fine
  for coaching; not a real-time alerting system.
- **A missed upload blurs, it does not break.** The days in a gap share their
  totals evenly, which keeps 7- and 28-day windows correct but makes those
  individual days approximate. `cli.mjs status` lists every gap.
- **A username change is only safe while the ID is present.** Quit rows have
  their ID masked, so a creator who renames *and* quits in the same window would
  not be reconnected to their history.
- **Thresholds are calibrated on simulated declines**, because two real files
  cannot contain a trend. They will need one real month to settle.

## Next, in order of value

1. **A month of real uploads, then re-tune.** Nothing else matters as much.
2. **Log what coaches do with each alert** — acted / ignored / not a problem.
   That turns alert quality from a guess into a measurement, and is the training
   data for ranking alerts by what actually gets fixed.
3. **A dashboard.** `GET /report.json` already carries everything; the relay
   service can serve a page from it.
4. **Track intervention outcomes** — did the creator recover after the coach
   called? That is the number that proves the tool is worth running.
