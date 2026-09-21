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

🔴 @sur3shot — Team Alpha, day 503
   This week: 15,384 diamonds (-43%) · 8.0h LIVE (-25%) · 4 LIVE days
   • 2 fewer LIVE days this week — 4 valid LIVE days in the last 7, down from 6.
   • Fan Club diamonds -38% — Fan club gave 14,819 this week vs 24,084 last week.
   • Diamonds -43% — 15,384 this week vs 26,965 last week — 11,581 fewer.

EARLY SIGNS — one signal only, worth a message not a call (13)
   🟡 @hex_rated — Fan Club diamonds -33%
   🟡 @georgia.senpai — Fan Club diamonds -35%
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
🔍 Most likely why
   Less hours — schedule has slipped (the data points at this)
   • 9 days with no LIVE at all
   • LIVE hours -100% — 0.0h this week vs 16.1h last

💬 Ask them
   • Do they actually have a written schedule, or is it whenever they feel like it?
   • If they have one — what got in the way this week?
   • Is the schedule still realistic for their life right now, or has something changed?

📎 Before you call
   Their last agreed schedule, and whether this is the first week they have missed it

🚀 Also worth pushing
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
  Not in a group             48  ⚠️  NOWHERE
  Surge Agency               23  ⚠️  NOWHERE

⚠️  5 team(s) with no channel, covering 84 creators
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
node cli.mjs effectiveness               # which interventions work
node cli.mjs creator unc.inc0            # one creator's numbers
node cli.mjs report                      # the older plain-text digest
node cli.mjs status                      # what is stored, and any missing days
node cli.mjs rebuild                     # re-derive after a rule change
node cli.mjs discord-scaffold --write     # build routes.json from the live teams
node cli.mjs discord-check                # confirm every team has a channel
node cli.mjs discord-register             # publish the slash commands
npm test
```

### As a service

```bash
UPLOAD_TOKEN=... npm start        # :8900
```

| Route | Purpose |
|---|---|
| `POST /upload` | The day's `.xlsx` — raw body or a multipart form field |
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
| `cases.maxOpenPerCoach` | The work-in-progress limit — the most important number here |
| `cases.maxOpenOpportunitiesPerCoach` | Boost-list cases per coach |
| `cases.escalateAfterDays` | Days unacknowledged before the managers' channel hears |
| `cases.escalateUrgentAfterDays` | The same for urgent cases |
| `cases.escalateMaxPerRun` | Cap on names in one escalation post |
| `cases.autoResolveClearDays` | Clear days before a case closes itself |
| `cases.openCasesForEarlySigns` | Whether single-signal warnings become cases (off by default) |
| `monitoring.ignoreGroups` | Teams to skip entirely — no cases, no cards, data still accrues |
| `decline.eligibility.minExactDaysPerWindow` | Real daily readings needed in each week before week-on-week fires |

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
