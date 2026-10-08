# LEAP new-creator requirements
## Build spec for the LEAP bot

---

## 1. WHAT THIS IS

Every creator who joins LEAP is on a 90-day clock with three bars to clear. The
bot owns the clock: it assigns roles, sends six messages, and removes anyone who
misses a deadline. There is no manual review and no override.

The monitoring service already tracks every creator's LIVE days and diamonds
daily. It publishes a feed; the bot reads the feed and acts. The bot never
computes eligibility itself — if it did, two systems would disagree within a
month.

---

## 2. DEFINITIONS — READ THESE BEFORE WRITING ANY LOGIC

**Day 0** is `joinDate` from the TikTok export. Day N is `joinDate + N` days.

**A valid LIVE day** is TikTok's own `validLiveDays` counter, not something to
derive. It already means a day with at least one LIVE hour — verified across
9,828 month-to-date rows, the tightest case being 1.0014 hours. Do not
re-implement it from `liveHours`.

**Diamonds** are `mtd.diamonds`, TikTok's month-to-date figure.

**The counters reset on the 1st.** `mtd` is month-to-date, not lifetime. Any
window spanning a month boundary is the **sum of per-month figures**, never a
subtraction. A creator who joins on 20 August and is judged at day 30 needs
`August.validLiveDays + September.validLiveDays`.

**The export runs a day behind.** `series.lastAsOf` is the newest data held,
and it is yesterday. A deadline falling today is evaluated against data that
does not include today. Always read `lastAsOf` rather than assuming.

**Timezone is UTC** (`config.timezone`). Deadlines are date comparisons, not
timestamps.

---

## 3. THE THREE RULES

Expressed as the service evaluates them. `D(a,b)` = diamonds summed over the
months spanning day *a* to day *b*; `L(a,b)` = valid LIVE days, same.

| rule | evaluated on | passes if | fails if |
|---|---|---|---|
| **1** | day 7 | `L(0,7) >= 1` | no LIVE activity at all |
| **2** | day 30 | `L(0,30) >= 10` **OR** `D(0,30) >= 10000` | neither |
| **3** | day 90 | `D(0,90) >= 10000` | under 10,000 |

**Rule 2 has the shortcut built in.** A creator past 10,000 diamonds at their
30-day gate passes regardless of how few nights they streamed. This is not a
discretionary exception — it is part of the rule and the bot applies it
automatically.

**A creator removed at one gate never reaches the next.** Evaluate in order and
stop at the first failure. Do not evaluate rule 3 for somebody rule 2 already
removed.

---

## 4. ROLE STATE MACHINE

```
                    joins, verified by Ops
                              |
                              v
                     +-----------------+
                     |  NEW CREATOR    |   clock running, day 0
                     +-----------------+
                              |
         +--------------------+--------------------+
         |                    |                    |
   passes 10,000        reaches day 90       misses a gate
     diamonds            having cleared       (day 7/30/90)
     (any day)            all three                |
         |                    |                    |
         v                    v                    v
    +---------+          +---------+         +-----------+
    | CREATOR |          | CREATOR |         |  REMOVED  |
    +---------+          +---------+         +-----------+
                                                   |
                                            rejoins on request
                                                   |
                                                   v
                                            back to NEW CREATOR,
                                            clock restarts at day 0
```

**The 10,000 check runs daily, not only at gates.** A creator who crosses the
bar on day 12 becomes a CREATOR on day 12 and stops receiving clock messages
immediately.

**Re-entry is a fresh start.** New `joinDate`, new clock, all three rules apply
again. Keep the previous run in history; do not merge it.

---

## 5. MESSAGE TRIGGERS

| # | fires on | only if | variables |
|---|---|---|---|
| 1 | day 1 | always | `COACH` |
| 2 | day 5 | no LIVE activity yet | — |
| 3 | day 20 | under 5 valid LIVE days | `N`, `10-N`, `COACH` |
| 4 | any day | diamonds cross 10,000 | — |
| 5 | day 80 | under 10,000 diamonds | `N`, `X` = nightly rate needed |
| 6 | removal day | a gate failed | `RULE` |

**Message 3 has two versions.** At day 20 only 10 days remain, so a creator on
0 days needs all 10. Version A for 2–4 days, Version B for 0–1. Version B does
not claim it is easy. A message that tells somebody an impossible thing is
achievable is remembered when the removal lands.

**`X` on message 5** = `(10000 - N) / 10`, rounded up to something readable.

**Send each message once.** Key on `(creatorId, messageType, clockRunId)` so a
re-entry gets a fresh set and a retry does not double-send.

**Never send a message after its deadline.** If the job is late, skip rather
than send — a day-5 nudge arriving on day 8 is worse than silence.

---

## 6. THE MESSAGES

### 1 — Day 1, on verification

> Welcome to LEAP Creator Network. Ops have approved your verification.
>
> First thing: head to **#induction** and hit **Start my onboarding**.
>
> Your 90 days with us start today. Every new creator clears three requirements
> in that time and they're all written up in **#requirements** — worth two
> minutes now rather than finding out about them later. They're not hard, but
> they do matter.
>
> Your coach is **<COACH>**.
>
> Anything at all, open a ticket in **#support**. Someone's always about.

### 2 — Day 5, if not LIVE yet

> Day 5 with us and you haven't been LIVE yet.
>
> You've got **2 days** left to get your first stream in. It doesn't need to be
> long or polished — an hour counts, and that's requirement one done.
>
> If something's in the way, setup or nerves or just not knowing where to
> start, open a ticket in **#support**. That's genuinely what it's for. We'd
> much rather sort it tonight than lose you on day 7.

### 3A — Day 20, on 2 to 4 LIVE days

> You're on **<N> of 10** LIVE days with **10 days** left in your first 30.
>
> That's **<10-N> more nights**. An hour each counts as a day, so it's doable —
> but it means going LIVE most nights from here.
>
> If that's not going to happen, tell us now. Open a ticket in **#support** and
> talk to **<COACH>**. There's usually something we can do, but only before the
> deadline. After it we can't.

### 3B — Day 20, on 0 or 1 LIVE day

> You're on **<N> of 10** LIVE days and there are **10 days** left in your
> first 30.
>
> Straight with you: that means going LIVE nearly every night between now and
> then. It's a big ask and we're not going to pretend otherwise.
>
> It's still on if you want it. Open a ticket in **#support** and talk to
> **<COACH>** today — if there's a reason you've not been able to get going,
> now is the moment to say so, not after the deadline.

### 4 — On passing 10,000 diamonds

> **That's 10,000 diamonds.** You're done — requirements cleared, and you're a
> full **CREATOR** now.
>
> No more clock, no more counting days. You got there faster than most people
> do.
>
> Go and tell your room. They're the ones who got you there.
>
> Anything you need from here, **#support** as always.

### 5 — Day 80, if under 10,000

> You're on **<N> of 10,000** diamonds with **10 days** to go. That works out
> at about **<X> a night**.
>
> Closer than it sounds. Two things move it more than anything else: going LIVE
> when your people are actually awake, and giving them a reason to stay past
> the first minute. TikTok pushes LIVEs that hold an audience, so a shorter
> stream where nobody leaves beats a long one where they drift.
>
> Open a ticket in **#support** and ask for a stream review. **<COACH>** will
> watch your last few back and tell you what's costing you — it's usually
> something small and fixable.

### 6 — Removal

> You haven't met the LEAP requirements, so you're coming off the creator
> network today.
>
> The one you missed: **<RULE>**.
>
> We don't set these to catch anyone out. They're roughly what TikTok itself
> expects from somebody trying to make LIVE a career, and below that line
> there's not a lot we can do for you.
>
> If you're serious about this and you want another go, open a ticket in
> **#support** and ask. We restart people all the time — you'd come back in on
> day one with a clean slate and the same support as everyone else.
>
> Good luck either way.

---

## 7. THE FEED

The service publishes once a morning, after the daily TikTok export lands. The
bot polls it and acts. Proposed shape:

```json
{
  "asOf": "2026-10-07",
  "generatedAt": "2026-10-08T09:00:00Z",
  "rows": [
    {
      "creatorId": "7595706166663970817",
      "username": "jedstreams",
      "coach": "Sur3shot",
      "joinDate": "2026-09-08",
      "dayNumber": 30,
      "verdict": "remove",
      "rule": 2,
      "ruleText": "under 10 LIVE days in the first 30",
      "liveDays": 4,
      "diamonds": 1620,
      "needDays": 6,
      "needDiamonds": 8380
    }
  ]
}
```

**`verdict` is one of `nudge`, `pass`, `remove`.** No `review` state — there is
no discretionary band.

**The service decides, the bot delivers.** If the bot ever needs to compute a
verdict itself, that is a bug in the feed, not a feature of the bot.

**Authenticate it.** `/export` already carries every field this needs and sits
behind `UPLOAD_TOKEN`. **That token is currently unset in production, which
makes every endpoint public, payroll records included.** Set it before any new
endpoint ships.

---

## 8. EDGE CASES — THESE WILL ALL HAPPEN IN MONTH ONE

**Joining in the last week of a month.** A creator joining on 28 September has
a 7-day window ending 5 October. Checking only their joining month marks them
failed for having no September activity when their window was mostly in
October. **Any window must span months whenever fewer than N days remain in the
joining month.** This bug was live in our own analysis and wrongly flagged two
creators who went on to 14 and 16 valid LIVE days.

**Mid-month joiners generally.** First 30 days nearly always spans two months.
Sum, never subtract.

**The export is a day behind.** A day-7 deadline on the 8th is evaluated
against data to the 7th. Build the deadline check off `asOf`, not `now()`.

**Paused clocks.** Illness, exams, bereavement, a broken setup. Needs a
`pausedUntil` on the creator and every day number computed as
`elapsed - pausedDays`. Pauses are set by a human before a deadline, never
after — an expired deadline cannot be un-expired once the message has gone and
the role has moved.

**A creator who quits before a deadline.** `quitOn` is set in the export. Skip
them; do not send a removal message to somebody who already left.

**Partner-agency creators.** `Surge Agency`, `Stay Social` and `Team Ratty` are
partner agencies in `monitoring.ignoreGroups`. Nobody at LEAP coaches them and
LEAP settles most of their revenue back. **Confirm whether the rules apply to
them at all before shipping.**

**Rejoining.** Fresh `joinDate`, fresh clock, fresh message keys. Keep history.

**Backfill on first run.** 122 creators on the current roster have already
missed a deadline. Do not remove them on day one — see the rollout: new joiners
from 1 Nov, existing roster from 1 Dec.

---

## 9. WHAT GOOD LOOKS LIKE

- Every message sent exactly once per creator per clock run
- No message sent after its own deadline
- No creator removed twice
- Verdicts come only from the feed
- A removal writes a record: creator, date, rule, the figures at that moment

That last one matters more than it looks. Month one will raise the question of
whether the rules caught the right people, and the only way to answer it is a
record of who went, why, and where they stood when they did.

---

## 10. STILL TO DECIDE

- **Who removes the creator from the agency in Backstage.** The bot owns
  Discord; dropping them from the TikTok roster is a separate action and no
  owner has been named.
- **Whether partner-agency creators are in scope.**
- **Whether the day-80 algorithm claim stays.** It is ordinary coaching advice
  rather than anything LEAP's data proves. Cutting the middle paragraph leaves
  the stream review offer intact.
