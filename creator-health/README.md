# Creator health monitoring

Daily pipeline over the TikTok **Creator data** export. Three jobs:

1. **Catch a creator sliding while it is still fixable** — diamonds, LIVE hours,
   fan club — and message their coach in Discord with what changed and what to do.
2. **Run the first-90-days push to 200,000 diamonds** — who is on pace, who is
   behind, who has the raw ability to get there, and which lever closes the gap.
3. **Track whether the help actually worked.** Every alert becomes a case a coach
   owns, with a named intervention, a follow-up date, and a verdict measured from
   the data. Over time that answers the only question that matters: which kinds
   of support move the numbers, and for whom.

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
            ┌──────────────────┐   open / update / close cases against the
            │ 6  reconcile     │   open caseload      lib/cases.mjs
            └──────────────────┘
                      │
                      ▼
            ┌──────────────────┐   per-coach Discord cards with buttons,
            │ 7  deliver       │   escalations, summary
            └──────────────────┘   lib/discord.mjs + dispatch.mjs
                      │
                      ▼
            ┌──────────────────┐   coach clicks → case state → follow-up →
            │ 8  close the loop│   verdict            lib/interactions.mjs
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

- **urgent** — a leading *and* a confirming signal agree, or one severe signal
- **warn** — two signals agree
- **early** — one signal only; a one-line mention, not an interruption

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
Recoveries are reported once, and a coach is only messaged when something is
**new** or has **worsened** — then not again for 5 days unless it deteriorates
further. Volume numbers are in [what a coach receives](#what-a-coach-receives).

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

In Discord, one card per creator — the numbers, then why, then what to ask.
See [the playbook](#the-playbook-find-it-dont-prescribe-it) for a full card.
The plain-text digest (`cli.mjs report`) remains for anyone not on Discord:

```
LEAP creator check — 2026-09-15
Coach: joshbates93@hotmail.com

DECLINING — 16 creators, ~569,737 diamonds at risk

@sur3shot — Team Alpha, day 503
   This week: 15,384 diamonds (-43%) · 8.0h LIVE (-25%) · 4 LIVE days
   • 2 fewer LIVE days this week — 4 valid LIVE days in the last 7, down from 6.
   • Fan Club diamonds -38% — Fan club gave 14,819 this week vs 24,084 last week.
   • Diamonds -43% — 15,384 this week vs 26,965 last week — 11,581 fewer.

EARLY SIGNS — one signal only, worth a message not a call (13)
   @hex_rated — Fan Club diamonds -33%
   @georgia.senpai — Fan Club diamonds -35%
```

Volume, measured over a simulated week of daily runs:

| Day | Open | Messaged | Call-worthy | New | Worsened | Recovered |
|---|---|---|---|---|---|---|
| 1 (cold start) | 129 | 129 | 68 | 129 | 0 | 0 |
| 2 | 135 | 36 | 16 | 27 | 9 | 20 |
| 3 | 130 | 30 | 19 | 16 | 14 | 19 |
| 4 | 145 | 57 | 32 | 32 | 25 | 17 |
| 5 | 143 | 40 | 23 | 23 | 17 | 21 |

Day one flags everything at once; after that it settles to **30-57 messages a
day across 16 coaches — roughly 2-3 each**, before the work-in-progress limit
trims it further.

---

## The 200k target

**200,000 diamonds inside a single calendar month.** Not a running total over
90 days — a creator has to land it in one month, and their first 90 days give
them roughly three attempts.

That reset matters. A creator who manages 26,000 in August starts September on
zero, not 174,000 behind. Each month is a fresh attempt, and the coaching
conversation is about *this* month, which is the only one they can still change.

It also makes the tracking far more reliable than a cumulative target would be.
Every attempt is measured inside one calendar month, which is exactly the
window the export reports, so nothing has to be accrued across a period the
tool never watched. No blind days, no estimates.

### What is tracked

| | |
|---|---|
| Attempt months | Every calendar month their first 90 days touch |
| Viable | At least 20 days available — joining on the 28th is not an attempt |
| This month | Month-to-date against a prorated pace target |
| Projection | Month-to-date scaled to the full month at this week's rate |
| Earlier months | What they actually did, so a near miss reads differently to a flat month |
| Attempts left | Whole months still ahead inside the window |

Status is `ACHIEVED` (any month cleared 200k) / `ON_TRACK` (this month projects
over) / `AT_RISK` / `OFF_TRACK` / `MISSED` (window closed, never landed one).

A month we barely watched is **not** recorded as a failed attempt — coverage
below 80% of its days is marked unobserved rather than counted as a miss.

### Who has the potential

Two creators both on 30,000 at day 40 are not the same creator:

- 4,800 diamonds/hour, streaming 1.2h a day — **massive headroom**
- 180 diamonds/hour, streaming 7h a day — already maxed out

So potential is scored as **conversion rate × unused sustainable hours × days
left in the month**, not on current output. Then the gap is closed with the
cheapest lever first: **days** (add LIVE days at their existing session length),
**hours** (lengthen sessions, capped at sustainable), **rate** (improve
diamonds per hour — slowest, needs real coaching).

```
@baron_after_dark can still hit 200k in September

  91,227 / 200,000 this month, with 10 days left.
  At this week's rate they finish on 136,841 — 63,159 short.
  Day 25 of 90: 2 further months to try after this one.

  Doing          4,231/day
  Needs          10,877/day
  Converts at    7,310/LIVE hour

  The lever: days
    Add 4 LIVE days a week at their usual 2.1h. That alone covers the gap.

  Earlier months
    2026-08: 26,656
```

The **boost list** is the short version: behind this month's pace, enough days
left in the month to act, and the rate and unused hours to actually land it.
A creator with three days left in the month is not on it — there is nothing a
coach can do by then that the numbers would show.

## Creators who never started

The decline rules ignore these by design: a creator with no pattern cannot
deviate from one, so alerting on them would bury the real signal. The side
effect is that a third of the network is invisible.

On LEAP's own data that is **280 of 783 monitored creators earning nothing this
month, 176 of them signed within the last 90 days**. That is not a coaching
problem and it is not a decline. It is onboarding — and it is probably worth
more than the decline caseload, because a saved creator returns to their old
level while an activated one is income that did not exist.

Four stages, each with its own questions:

| Stage | Who | What it is |
|---|---|---|
| Settling | First week | Left alone — chasing on day three is noise |
| Never gone live | Past day 7, no stream at all | Usually practical or nerves, and nobody has asked |
| Streaming, earning nothing | Live but no money | The point most people quit |
| Needs a decision | Past day 30 | Either something changes now or the slot is better used |
| Gone quiet | Established, earning nothing | A full stop, not a slide — different conversation |

Activation has its **own per-coach budget**, separate from declines, because
chasing a first stream and saving a slipping creator are different work and
should not crowd each other out. Newest first, since they are the most likely
to convert. A case closes the moment the creator earns anything.

## Network programmes

Some numbers only mean something in aggregate. Posted weekly to the management
channel, not daily to team channels:

**Never campaigned.** 215 of 729 earning creators have never done a match.
As a per-creator nudge that is 215 conversations nobody will have; as a network
figure it is one decision about how campaigns are run. The list is ranked by
what they already produce — the top entry does 1.36M diamonds in 28 days at
10,359 an hour and has never been put in front of another room.

**Income resting on a handful of people.** 125 creators earn 90%+ of their
diamonds from their fan club, several from fewer than 100 members. One member
leaving is a visible drop. The fix is reach rather than retention.

## When uploads stop

The whole system rests on somebody uploading a file each morning, and nothing
else in it notices when that stops — a quiet week degrades every comparison
without producing a single error.

The overview now leads with it: a warning at two days, and at four days an
explicit note that week-on-week is degrading and the 200k month is being
tracked blind. One day behind is normal, because the export always covers the
day before it is produced.

## What the cards show, and what they cannot

Every card carries an author line: the creator's handle, their team, and a
**link straight to their TikTok profile**. That link matters more than it
looks — it is where a coach goes to see the one thing the export cannot show
them, namely what the creator has actually been posting.

Avatars are resolved by Discord, not by us. The first attempt fetched TikTok's
oEmbed endpoint from our side, cached the result, and produced no picture at
all in production. Handing Discord a URL that resolves the handle on request
takes our network out of the path entirely: no lookup, no cache, no rate limit,
and a failure is a card without a picture rather than a stalled run.

It uses a third-party resolver (`unavatar.io` by default). Point
`avatars.urlTemplate` elsewhere, set `avatars.enabled` to false to drop pictures
entirely, or add `avatars.manual` entries which win over the resolver.

### Reading a card at a glance

Where there is enough history, cards carry a sparkline of **complete** calendar
months — `▆█▇▃` — and opportunity cards carry a progress bar towards the
month's 200k.

The running month is deliberately excluded from the trend. A month-to-date bar
drawn beside finished months makes every creator look like they are collapsing
on the 20th: the bar is short because the month is short. Trends need three
complete months before they appear at all, because two bars is a comparison the
card already makes in words.

### There is no short-form data in the export

All 41 columns are LIVE, fans or diamonds. No posts, no views, no videos.
Counting how much short form a creator published is **not possible from this
file**, and any number claiming to would be invented.

The closest honest signal is **new followers while they are still streaming** —
that is the traffic short form would have brought. It appears on the cards
labelled as a proxy, never as a post count. Percentages are suppressed below a
base of 10, because "+700%" from one follower to eight is noise dressed as
insight.

If short-form tracking matters, it needs a second data source — TikTok's
Creator Centre export or the API — and the pipeline can take it as another
upload.

## The support system

An alert is an event: it fires, it is gone, and a week later nobody remembers
whether anyone did anything. A **case** is a thing somebody owns until it is
closed. Everything the pipeline finds becomes one.

```
   rule fires
       │
       ▼
   ┌────────┐  posted to the coach's Discord channel with buttons
   │  OPEN  │
   └────────┘
       │  coach clicks "On it"                    ⟍ nobody clicks anything
       ▼                                            ⟍ for 3 days (1 if urgent)
  ┌──────────────┐                                    ▼
  │ ACKNOWLEDGED │                            ┌────────────────┐
  └──────────────┘                            │ → managers'    │
       │  coach clicks "Log what I did"       │   channel      │
       ▼  and types what they did             └────────────────┘
  ┌──────────┐
  │ ACTIONED │  follow-up date set from the playbook (7-21 days)
  └──────────┘
       │
       ▼  on that date the success test runs against the data
  ┌─────────────────────────────────────────┐
  │  recovered → RESOLVED, coach told       │
  │  anything else → back to OPEN, attempt 2│
  └─────────────────────────────────────────┘
```

Two side doors: **"Known reason"** snoozes a creator who is ill, on holiday or
on an agreed break, and **quitting the network** closes their cases as `lost`
rather than as a coaching failure.

### Why cases and not just alerts

- **The same creator does not generate fourteen notifications in a fortnight.**
  A creator who keeps sliding has one thread that gets updated. Only an escalation
  to *urgent* re-posts.
- **A coach can be chased.** "Open, unacknowledged, 3 days, 90,000 at risk" is
  actionable in a way that "we sent a message on Tuesday" is not.
- **Every intervention gets a verdict**, so the question of what actually helps
  stops being an opinion.

### The work-in-progress limit

This is the part that keeps the system honest. A coach can hold maybe half a
dozen open cases; beyond that the extra cards get ignored, and the important
ones get ignored with them.

So the caseload is **capped per coach** (`maxOpenPerCoach`, default 8, plus 3
opportunity cases). When a coach is at their limit, new findings are **deferred**
rather than posted, and the open slots go to the creators with the most diamonds
at risk. As cases close, the next ones come through.

Without the cap, the simulated network reached **152 open cases in five days and
kept climbing**. With it, the caseload settles at **~90 across 16 coaches** and
holds there.

### The playbook: find it, don't prescribe it

The coaches already know how to fix these things. What costs them time is
working out *which* creator needs attention today, and which of the usual
causes it is this time, across hundreds of creators. So the tool names the area
of concern, ranks the likely causes against the data, and hands over the
questions that tell them apart. It does not write the intervention.

Each concern sets a follow-up window and a definition of better. The windows
differ on purpose: attendance can recover inside a week because it is a
scheduling decision, conversion cannot because it needs content changes.

| Area of concern | Check back | Better looks like |
|---|---|---|
| Off air | 7d | Back live on half their usual days |
| Dropping LIVE days | 7d | LIVE days within one of normal |
| Shorter sessions | 10d | Hours back to 85% |
| Short for weeks | 10d | Hours back to 85% |
| Room not converting | 14d | Diamonds/hour back to 85% |
| Fan club thinning | 14d | Membership back to flagged level |
| Fan club spending less | 14d | Fan club diamonds back to 85% |
| Income too concentrated | 21d | Fan club share falling, total holding |
| Earnings down | 10d | Diamonds back to 85% |
| Down for weeks | 14d | Diamonds back to 85% |
| Inside 90 days, reachable | 14d | Run rate at or above target |

### Why: the nine things that actually go wrong

`lib/causes.mjs` reads the data for the signature of each of the causes LEAP
sees in practice, and ranks them. Confidence is stated honestly, because a coach
told "lost gifters" who finds a creator on holiday stops trusting the tool:

- **the data points at this** — the pattern is there directly
- **consistent with the data** — possible, but not singled out
- **worth ruling out** — the data cannot see this at all; it is on the list
  because it is common

| Cause | How the data shows it |
|---|---|
| Less hours, schedule slipped | Hours or LIVE days down; days dark |
| Lost gifters | Fan club membership down — the people left |
| Gifters ran out of money | Spending down while membership holds — same faces, smaller gifts |
| No goals or revenue boosting | Diamonds per hour down while hours hold |
| Stopped campaigns | They used to match, and have not for 21+ days |
| No short form bringing traffic | New followers down while still streaming |
| Holidays | A clean stop after a reliable run |
| Drama | Everything down at once *while hours hold*, or total fans actually falling |
| Doesn't get coins → growth | Newer creator, hours in, very low conversion |

**Causes and levers are kept apart, and that distinction matters.** Four
creators in five have never done a campaign, so "not taking part in campaigns"
as a *cause* is just the base rate wearing a diagnosis hat — it would fire on
80% of the network and mean nothing. As a *lever* on a creator who is already
struggling, it is genuinely useful. A cause has to be something that **changed**.

The card leads with **why**, then **what to ask**, then **what to check before
you call**:

```
Most likely why
   Less hours — schedule has slipped (the data points at this)
   • 9 days with no LIVE at all
   • LIVE hours -100% — 0.0h this week vs 16.1h last

Ask them
   • Do they actually have a written schedule, or is it whenever they feel like it?
   • If they have one — what got in the way this week?
   • Is the schedule still realistic for their life right now, or has something changed?

Before you call
   Their last agreed schedule, and whether this is the first week they have missed it

Also worth pushing
   Has never done a campaign or match — no matches on record at all
```

When nothing matches, the fallback is still questions — "what changed for them
in the last couple of weeks?", "are they still enjoying it?" — because that is
more use to a coach than a number that went down.

---

### Measuring whether it works

`cli.mjs effectiveness` splits outcomes two ways:

```
  intervention                  coached  rate  left alone  rate   lift
  Dropping LIVE days                  1 100%           5 100%     0%
  Earnings down for weeks             0    —           2  50%      —
```

**"Left alone" is the control group.** Plenty of flagged creators come back on
their own, and counting those as coaching wins would make every intervention look
perfect. The gap between the two columns is what the coaching is actually worth.

Two rules keep this honest:

- A case that closes because the creator **stopped tripping thresholds** is not
  recorded as recovered unless the playbook's success test agrees. A creator
  whose lower output has simply become their new normal is a settled decline,
  not a win.
- Only cases where a coach **logged an action** count toward an intervention's
  success rate.

Nothing here means much until a few months of cases have accumulated. That is
precisely why it records from day one.

---

## Week on week, month on month

### Month on month works from day one

This is what makes the tool useful immediately rather than in a fortnight.

Week-on-week needs real daily readings in both weeks, so it stays quiet until
roughly ten daily uploads have accumulated. **Month-on-month needs none of
that**: it compares two complete months, prorated to the same day, which is
exactly what the export reports natively. Ingest one month-end export and the
comparison is live.

On LEAP's first real data — one August month-end export plus four September
days — that meant **56 decline cases** the tool could raise honestly on day
one, against zero from week-on-week. The worst was 434,000 diamonds behind
August's pace.

A month-raised case stays month-framed throughout: the card shows this month
against the same point last month, the causes are read from monthly movement,
and the follow-up is graded on the month rather than the week. Judging a
creator on data the alert never looked at is how a tool loses a coach's trust.


Both, from the same daily uploads.

**Week on week** is the 7 days to date against the 7 before, judged against each
creator's own volatility, plus a weeks 3-8 baseline so slides that have already
settled stay visible.

**Month on month is prorated.** Comparing month-to-date on the 8th against a
full previous month would read as a 70% collapse for a creator doing exactly
what they always do, so the previous month is scaled to the same point before
comparing:

```
vs 2026-08
  531,799 so far
  98,504 by day 20 last month
  +440%
```

It prefers the previous month **accrued from our own snapshots** — exact, and
works between any two months once the history exists. Before that it falls back
to the export's own "last month" columns, so it works from day one. Ingesting a
month-end export (like the August file) gives a real closed month immediately.

### When decline detection switches on

This is worth understanding, because it looks like the tool is doing nothing at
first, and it isn't.

A back-fill snapshot covering 14 days gets spread evenly across them. That
totals correctly, but it flattens every day to the same value — so comparing a
week of *that* against a week of real daily readings produces a swing that says
nothing about the creator. Early testing produced exactly this: a creator
flagged at **-73%** whose week was entirely an artifact of even spreading.

So week-on-week rules refuse to fire until **both** comparison windows contain
at least 5 days we actually observed. `cli.mjs status` says where you are:

```
decline detection  NOT YET — needs 5 real daily readings in each of two
                   consecutive weeks. 1 exact day(s) so far;
                   about 9 more daily upload(s) to go.
                   The 200k tracker and month-on-month work already.
```

The 200k tracker, month-on-month and the campaign signals do not depend on
day-level comparisons, so they work from the first upload.

## Discord

### Two modes

| | Webhook | Bot |
|---|---|---|
| Setup | Paste a URL per channel | Bot token + a public HTTPS endpoint |
| Time to working | ~2 minutes | ~20 minutes |
| Rich cards | Yes | Yes |
| Buttons, forms, `/commands` | No | Yes |
| Coach records what they did | By hand, elsewhere | One click, captured |

Start on webhooks to prove the alerts are useful. Move to a bot when you want
the feedback loop — the cards are identical either way, so nothing is wasted.

### The overview channel

One channel gets a single post a day: what went out, the caseload, which teams
are not moving their creators, and whether the data itself is healthy.

```
LEAP creator overview — 2026-09-20

  Sent today        59 cards · Team Alpha 10 · Team Bravo 8 · Team Delta 8 ...
  Caseload          59 open · 59 new · 18 held (coaches at their limit)
  At risk           ~6,620,769 diamonds over 28 days · 819 creators tracked

  Urgent — needs a call today (43)
    @iamscone   · Not in a group · ~679,113 at risk
    @gh0s733    · Team Bravo     · ~375,961 at risk
    @justmelau  · Team Alpha     · ~302,133 at risk

  Where the caseload sits
    Not in a group — 5 open, 2 urgent  · ~1,139,058 at risk
    Team Bravo     — 8 open, 7 urgent  ·   ~919,834 at risk
    Team Alpha     — 10 open, 5 urgent ·   ~829,347 at risk

  Biggest losses
    @iamscone (Not in a group) — -78% on last month, ~679,113 at risk

  Data
    Last export 2026-09-20 · 17 days never uploaded
    Month on month: on (vs 2026-08)
    Week on week: needs ~9 more daily uploads
```

Every figure is quoted on the basis its own alert was raised on. A month-raised
case shows its month change, not a weekly one — an earlier version printed
"+326%" beside "urgent" because it reached for weekly data the alert had
deliberately ignored, which reads as the tool being broken.

The two detectors are reported separately for the same reason: "decline
detection: off" above 43 urgent cases is a contradiction, not a status.

**Once a day is enforced**, not assumed: `run` may fire more than once (a
retried upload, a manual re-run) and reposting the same overview is how a
channel stops being read. The guard is by as-of date; `--force-overview`
overrides it.

With no separate managers' channel, escalations ride in the overview rather
than being dropped.

### Deploying: routes.json holds secrets

A webhook URL is a credential — anyone holding one can post to that channel —
so `routes.json` is gitignored. Which also means it is not in the repo and
never reaches a deploy.

```bash
node cli.mjs discord-env --write
```

That prints the environment variables to set on the host, and writes
`routes.deploy.json` containing `env:VAR_NAME` references and no secrets, safe
to commit. Rotating a webhook is then a dashboard change, not a code change.

`loadRoutes` reads `routes.json` when it exists and falls back to
`routes.deploy.json`, so the same code runs locally off real URLs and on the
host off environment variables. Re-run `discord-env --write` after adding a
team, or its cards will have nowhere to go once deployed.

### Webhook setup

1. In Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook**, copy the URL.
2. Copy `routes.example.json` to `routes.json`.
3. Set `discord.mode` to `"webhook"` and give each coach `{"webhook": "env:WEBHOOK_JOSH"}`.
4. Put the URLs in the environment. Done.

### Routing to a server with one channel per team

LEAP's server has a category per team, each with a `creator-monitoring`
channel, so routing is **by team** by default (`routeBy: "group"`). The
channel comes from the creator's team; the **@mention comes from their own
coach**, which matters because Team Alpha has two coaches and pinging the
wrong one for six creators is worse than not pinging at all.

Don't transcribe it by hand — build it from the data:

```bash
node cli.mjs discord-scaffold --write   # every team that exists, with creator counts
# paste the channel IDs and coach mentions into routes.json
node cli.mjs discord-check              # confirms nothing is left with nowhere to go
```

The scaffold uses the team names **exactly as the export spells them** (the
export really does contain `TEAM GOLF` and `Team Indigo ` with a trailing
space), and keeps any IDs already filled in when re-run. Lookups are
case- and whitespace-insensitive, so the channel named "Team Golf" in Discord
matches "TEAM GOLF" in the data.

`discord-check` is the one to run after any change. A `PASTE_CHANNEL_ID`
placeholder is **not** treated as a destination, so a half-filled file reports
honestly:

```
  team                 creators  destination
  Team Alpha                233  channel 111111111111110000
                                 ↳ 2 coaches share this channel: josh@…, amy@…
  Team Charlie              127  channel 111111111111110002
  Not in a group             48   NOWHERE
  Surge Agency               23   NOWHERE

 5 team(s) with no channel, covering 84 creators
```

Routing falls back team → coach → default channel, so a team with no channel
of its own still lands somewhere if a default is set. With no default, the run
reports the failure by team name rather than dropping it.

Creators with no team of their own come through the export as the literal
group **"Not in a group"** — 48 of them. They are routed like any other team;
at LEAP that channel is Team Slow.

### Teams nobody is coaching

Some groups on the export are not LEAP's to coach. List them in
`config.json` under `monitoring.ignoreGroups` and no case is opened and
nothing is posted for them:

```json
"monitoring": {
  "ignoreGroups": ["Surge Agency", "TEAM TRUCKERS", "Stay Social", "Team Ratty"]
}
```

Their **data still accrues**, because ignoring a team is a decision that can be
reversed and the history has to be there when it is. Removing a name from the
list switches it back on with its full history intact. Adding one closes any
cases that team already had, rather than leaving a coach with cards for
creators nobody is working.

`discord-check` shows them as `— not monitored` rather than as missing
channels, and `discord-scaffold` leaves them out of the file entirely, so an
unfilled placeholder always means real unfinished work.

Set `routeBy: "coach"` instead if you ever move to one channel per coach.

### Running without buttons

Webhook mode has no buttons, and three parts of the case machinery assume
clicks. Left alone they degrade within a fortnight, so `cases.interactive:
false` changes them:

| | With buttons | Without |
|---|---|---|
| Escalation | Nobody clicked "On it" in 3 days | Still open **and still declining** after 7 |
| Closing a case | Coach clicks, or the creator recovers | Recovery, or the case hits `maxOpenDays` |
| Snoozing a holiday | "Known reason" button | `cli.mjs snooze <id> <days> <reason>` |

Both matter. Escalating on "unacknowledged" would send the **entire caseload**
to the managers' channel every few days, since nothing can ever acknowledge.
And with nothing able to close a case, the per-coach limit jams and new
findings stop coming through at all — a month of simulated runs with nobody
clicking anything holds steady at ~70 open cases instead of climbing, because
stale cases close and free their slots.

A case closed for age is graded honestly: it is only recorded as recovered if
the success test agrees. It then has a cooling-off period so it does not
reopen the next morning, and comes back afterwards if the creator is still
down.

### What you lose, and what replaces it

The honest cost: **there is no control group.** The effectiveness report splits
outcomes by whether a coach logged an action, and without clicks every case is
"left alone" — so nothing separates coaching from natural recovery. The report
says so rather than showing a lift column that would be a lie.

What still works is the thing that matters: **did the creator get better?**

```
node cli.mjs teams

  team               opened  open  fixed  stale  left   fixed%  median days
  Team Alpha             23     9     12      2     0     86%           12
  TEAM GOLF               8     2      4      1     0     67%           20

  fixed  = the creator came back to their normal
  stale  = the case ran to the limit still down — nothing worked, or nothing was tried
```

A team whose flagged creators recover is working. A team whose cases all run to
the stale limit is not. It cannot see *what* a coach did, only whether it
worked — which is the part worth measuring anyway.

### Which to choose

**Bot.** Webhooks are marginally quicker to set up and throw away the entire
feedback loop: no buttons means no "On it", no logged actions, and therefore no
effectiveness measurement — the part that tells you which coaching works.

The real cost of the bot is a public HTTPS endpoint for button clicks. On
Render that is a second service alongside the relay, already defined in
`render.yaml`.

You do not have to wait for it. **Posting needs only the bot token** — the
interactions endpoint is for receiving clicks, not sending cards. So:

1. Create the bot, set `DISCORD_BOT_TOKEN`, and start posting today with
   `interactionsReady: false` in `routes.json`. Cards arrive complete, just
   without buttons.
2. Deploy the service, set the Interactions Endpoint URL, flip the flag to
   `true`. Buttons appear on every card from then on.

That ordering matters: a bot token with no endpoint makes Discord answer every
click with *"This interaction failed"*, which reads as a broken tool. The flag
exists so that never happens.

### Deploying alongside the relay on Render

`render.yaml` defines `leap-creator-health` as a second web service. The
**disk is not optional** — "diamonds since joining" and every day-on-day delta
are accrued from the daily uploads and exist nowhere else, so without it a
deploy wipes history that cannot be rebuilt from any export.

Set `UPLOAD_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` and
`DISCORD_APP_ID` in the Render dashboard (they are marked `sync: false`, so
they are never committed). The service must stay on an always-on plan: a
sleeping service fails Discord's endpoint verification.

### Bot setup

1. **https://discord.com/developers/applications → New Application.**
2. **Bot → Add Bot → Reset Token**, copy it into `DISCORD_BOT_TOKEN`.
3. **General Information → Public Key** → `DISCORD_PUBLIC_KEY`; the **Application ID** → `DISCORD_APP_ID`.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`, permissions
   *Send Messages* and *Embed Links*. Open the generated URL and add the bot to your server.
5. Deploy this service somewhere with HTTPS, then set
   **Interactions Endpoint URL** to `https://your-host/discord/interactions`.
   Discord sends a signed PING to verify it and will not save the URL until it passes.
6. Turn on **Developer Mode** in Discord (User Settings → Advanced), right-click each
   coach's channel → **Copy Channel ID**, and fill in `routes.json`.
7. `node cli.mjs discord-register` to publish `/cases` and `/creator`.

Secrets are never committed: any value in `routes.json` written as `env:VAR_NAME`
is read from the environment.

### What gets posted where

| Message | Goes to | When |
|---|---|---|
| Decline card | The creator's team channel | A case opens |
| Opportunity card | The creator's team channel | A boost-list case opens |
| "Getting worse" | The creator's team channel | An open case escalates to urgent |
| Follow-up verdict | The creator's team channel | The follow-up window closes |
| Unacknowledged cases | `escalationChannelId` | Top 5 per run, unclaimed past the limit |
| Daily roll-up | `summaryChannelId` | Every run |

The managers' channel only ever hears about what the coaches have **not** dealt
with. Anything else trains people to ignore it.

### Slash commands

- `/creator username:unc.inc0` — current numbers and any open cases, private to whoever asked
- `/cases` — the open caseload, optionally filtered by coach

### Signature verification

Discord signs every interaction with Ed25519. `lib/interactions.mjs` verifies it
against the **raw request bytes** before parsing — a re-serialised body reorders
keys and the signature stops matching. An unsigned or tampered request gets a
bare 401, which is what Discord requires before it will accept the endpoint.

---

## The daily habit

One action a day: **open the page, drop the file.** That is the whole
operation — no terminal, no second step to remember.

```
┌──────────────────────────────────────────────┐
│  LEAP creator monitoring                     │
│                                              │
│      Drop the .xlsx here                     │
│      or click to choose · one file a day     │
│                                              │
│  Current state                               │
│    Last export          2026-09-20           │
│    Missing uploads      none                 │
│    Open cases           8                    │
│    Decline detection    off · ~9 more uploads│
└──────────────────────────────────────────────┘
```

Uploading ingests the file, scores every creator, opens and closes cases, and
posts to the team channels in one go. The page then shows exactly what
happened: creators read, cases opened, messages sent, anything that failed.

Deliberately not two steps. A separate "now run it" button means somebody has
to remember it every morning, and the day they forget is the day a creator's
slide goes unnoticed.

Four buttons sit under the drop zone, so none of this needs a terminal:

- **Run now** — scores the stored data and posts, without needing a new file.
  The one to use when an export was already stored and so never triggered a run.
- **Send sample cards** — posts one real decline card and one activation card
  to the **overview** channel, so you can see exactly what a coach receives
  without posting into a team channel people are watching. It also reports
  whether the avatar lookup worked, which cannot be checked any other way.
- **Test Discord** — reports what the running service resolved (config file,
  teams with a destination, whether it is ready to send) and posts one line to
  the overview channel to prove the connection. Webhook URLs are never shown,
  so the output is safe to paste to someone.

Safe to get wrong:

- **Uploading the same file twice** does nothing — snapshots are keyed by the
  data period, so nothing double counts.
- **Uploading several days at once** works; each is processed in date order.
- **Missing a day** leaves a gap the tool reports rather than hides. The next
  upload spreads the missed days and says so.
- **A failed Discord post** does not lose the file. The data is stored first;
  re-running posts what is outstanding.

### Where it runs

The page is served by the same service that does the work, so anywhere it is
deployed, that URL is the upload point. On Render it is the
`leap-creator-health` service defined in `render.yaml`.

Set `UPLOAD_TOKEN` and the page asks for it once, then remembers it on that
device. Without the token set, the upload endpoint is open to anyone who finds
the URL.

A **daily safety net** runs at 09:00 UTC (`CH_DAILY_HOUR` to change it) whether
or not anything was uploaded, so follow-up verdicts and escalations keep moving
on a day somebody forgets. The once-a-day guard means an upload later that day
does not post a second overview.

## Running it

The daily habit is two commands:

```bash
node cli.mjs ingest ~/Downloads/Creator_data_2026_09_16_08_37_UTC0.xlsx
node cli.mjs run                         # reconcile cases, post to Discord
```

`run --dry` does everything except send or save, so you can read exactly what
your coaches would have received before anyone receives it. Add `--preview` to
print the Discord payloads themselves.

```bash
node cli.mjs cases                       # the open caseload
node cli.mjs cases --coach josh@x.com    # one coach's queue
node cli.mjs case D-260915-6627          # one case and its full history
node cli.mjs teams                       # how each team's flagged creators turned out
node cli.mjs effectiveness               # which interventions work (needs logged actions)
node cli.mjs snooze D-260915-6627 14 "on holiday"
node cli.mjs close D-260915-6627 "sorted on a call"
node cli.mjs creator unc.inc0            # one creator's numbers
node cli.mjs report                      # the older plain-text digest
node cli.mjs status                      # what is stored, and any missing days
node cli.mjs rebuild                     # re-derive after a rule change
node cli.mjs discord-scaffold --write     # build routes.json from the live teams
node cli.mjs discord-check                # confirm every team has a channel
node cli.mjs discord-env --write          # env-var form for deploying
node cli.mjs discord-register             # publish the slash commands
npm test
```

### As a service

```bash
UPLOAD_TOKEN=... npm start        # :8900
```

| Route | Purpose |
|---|---|
| `GET /` | The upload page — this is where the daily file goes |
| `POST /upload` | The day's `.xlsx`; ingests **and runs** (`?run=0` to only store) |
| `GET /status.json` | Last export, missing days, open cases, readiness |
| `POST /run` | The daily run: reconcile cases and post to Discord (`?dry=1` to preview) |
| `POST /discord/interactions` | Discord's interactions endpoint — button clicks and slash commands |
| `GET /cases` | The open caseload (`?coach=`, `?all=1`) |
| `GET /effectiveness` | Which interventions are working |
| `GET /report.json` | Everything, machine-readable |
| `GET /coach/:email` | One coach's plain-text message |
| `GET /creator/:name` | One creator's numbers and recent history |
| `POST /notify` | The older plain-text webhook digest |
| `GET /health` | Snapshot count and latest date |

`/upload` and `/run` require `UPLOAD_TOKEN` when it is set (as a Bearer header
or `?token=`). `/discord/interactions` is protected by Discord's own signature
instead, and must stay open for Discord to reach it.

```bash
curl -X POST "https://.../upload" -H "Authorization: Bearer $UPLOAD_TOKEN" \
     -F "file=@Creator_data_2026_09_16_08_37_UTC0.xlsx"
curl -X POST "https://.../run" -H "Authorization: Bearer $UPLOAD_TOKEN"
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
| `ramp.minRecentLiveDays` | LIVE days in the last week before a creator can be "boosted" |
| `ramp.minDaysLeftToPush` | Days left in the month before a push is still worth making |
| `ramp.reachableRatio` | How close to 200k the month must be able to get to qualify |
| `cases.maxOpenPerCoach` | The work-in-progress limit — the most important number here |
| `cases.maxOpenOpportunitiesPerCoach` | Boost-list cases per coach |
| `cases.escalateAfterDays` | Days unacknowledged before the managers' channel hears |
| `cases.escalateUrgentAfterDays` | The same for urgent cases |
| `cases.escalateMaxPerRun` | Cap on names in one escalation post |
| `cases.autoResolveClearDays` | Clear days before a case closes itself |
| `cases.openCasesForEarlySigns` | Whether single-signal warnings become cases (off by default) |
| `monitoring.ignoreGroups` | Teams to skip entirely — no cases, no cards, data still accrues |
| `activation.stages` | Days at which "never started" and "needs a decision" begin |
| `activation.maxOpenPerCoach` | Activation budget, separate from the decline caseload |
| `activation.dormantWasEarning` | What an established creator must have earned to count as gone quiet |
| `programmes.weekday` | Day of the week the network post goes out (1 = Monday) |
| `programmes.campaign` | Minimum size before a creator belongs on the campaign list |
| `programmes.concentration` | Fan-club share and earnings that count as exposure |
| `uploads.warnAfterDays` | Days without an export before the overview says so |
| `avatars.enabled` | Whether to attempt profile-picture lookups at all |
| `avatars.maxLookupsPerRun` | Cap on lookups, so a rate limit never stalls a run |
| `avatars.manual` | Hand-set avatar URLs, which win over the lookup |
| `discord.interactionsReady` | `false` posts cards without buttons, until the endpoint is live |
| `cases.interactive` | `false` when nobody can click: changes escalation and closing |
| `cases.escalateNoChangeAfterDays` | Days open and still declining before the managers hear |
| `cases.maxOpenDays` | When a case is closed for going stale, freeing the coach's slot |
| `cases.reopenCooldownDays` | Quiet period after a stale close, before it can reopen |
| `decline.eligibility.minExactDaysPerWindow` | Real daily readings needed in each week before week-on-week fires |
| `decline.month.diamondsDrop` | Month-on-month fall that opens a case |
| `decline.month.urgentDrop` | Fall that makes it urgent |
| `decline.month.minDaysSinceJoining` | Must have been around for the whole of last month |
| `decline.month.minDayOfMonth` | How far into the month before the comparison is fair |

**Tune against real data.** The thresholds here are derived from the two sample
files plus a simulation. After a month of real uploads, re-run `rebuild` and
back-test: if coaches are ignoring alerts, raise `volatilityMultiple`; if real
declines are being missed, lower the tier drop percentages.

---

## Known limits

- **Months before tracking started are unknown.** An earlier attempt we did not
  watch is marked unobserved rather than counted as a miss, so a creator may
  have landed a 200k month we cannot see. Only time fixes this, and the current
  month is always exact.
- **Deltas are daily, not hourly.** Nothing here can see *within* a day. Fine
  for coaching; not a real-time alerting system.
- **Drama and holidays are barely visible in this export.** Both are on the
  cause list because they are common, not because the data detects them. They
  are raised as questions, and the confidence label says so.
- **Adding a column means re-ingesting.** Snapshots store the normalised rows,
  so a new field (campaigns, multi-guest) only appears in exports ingested
  after the change. Re-run `ingest --force` over the original files if you
  still have them.
- **A missed upload blurs, it does not break.** The days in a gap share their
  totals evenly, which keeps 7- and 28-day windows correct but makes those
  individual days approximate. `cli.mjs status` lists every gap.
- **A username change is only safe while the ID is present.** Quit rows have
  their ID masked, so a creator who renames *and* quits in the same window would
  not be reconnected to their history.
- **Thresholds are calibrated on simulated declines**, because two real files
  cannot contain a trend. They will need one real month to settle.
- **Effectiveness numbers need volume.** With a handful of cases the "left alone"
  control group is too small to read. Give it a few months before drawing
  conclusions from the lift column.
- **Discord message ids are stored but cards are not retro-edited.** If a case
  changes state from the CLI rather than from a button, the Discord card keeps
  the footer it was posted with until the next post about that case.
- **The bot mode needs a public HTTPS endpoint.** On the free Render tier the
  service sleeps, and Discord will mark the interactions endpoint as failing.
  The paid always-on tier avoids this.

## Next, in order of value

1. **A month of real uploads, then re-tune.** Nothing else matters as much.
2. **Get coaches using the buttons.** The effectiveness report is only as good as
   the action log behind it, and a case nobody clicks is a case nobody measured.
   Worth watching the `actioned` column per coach for the first few weeks.
3. **A dashboard.** `GET /report.json` and `GET /cases` already carry everything;
   the relay service can serve a page from them.
4. **Re-tune the work-in-progress limit from real behaviour.** If coaches clear
   their queue every day, raise it. If cases sit unacknowledged, the limit is not
   the problem — the alerts are not earning attention, and the thresholds should
   rise instead.
5. **Rank by expected value, not just diamonds at risk.** Once the effectiveness
   table has volume, "at risk × how often this intervention works" is a better
   sort order than raw exposure.
