# LEAP Requirements — Discord rollout

## The thing to understand first

A pinned post will not reach the people who fail. Of the 58 creators who
would have been removed in September, **39 did literally nothing** — never
streamed, never earned a diamond, almost certainly never opened the server.
Nine had already quit before anyone asked them to.

So the public post is doing two jobs, and neither is persuasion:

1. **Defensibility.** When somebody is removed, the standard was published,
   dated and acknowledged. No argument.
2. **The borderline cases.** Roughly one creator in five sits near the line.
   They are the ones a post can move.

What actually changes behaviour is a **timed, personal nudge** before each
deadline. That is the part worth building.

---

## 1. Where it lives

### Creator-facing server

```
#start-here          locked, read-only
                     └── PINNED: the requirements post (below)
                     └── Membership Screening gate: must accept to see the server

#your-progress       locked, read-only, bot posts only
                     └── checkpoint cards for creators approaching a deadline
```

### Roles — make the clock visible without anyone mentioning it

```
🌱 NEW CREATOR     on joining. Carries the 90-day clock.
✅ CREATOR         granted at day 90 once all three are cleared.
```

The role change at day 90 is the reward, and it costs nothing. A creator who
can see `🌱 NEW CREATOR` on their own name knows they are on a clock without
being told twice. It also makes removal a role change rather than a mystery.

### Onboarding gate

Discord's **Membership Screening** (Server Settings → Membership Screening)
makes a new member tick the rules before they can post anywhere. Put the three
requirements in as the rules. That is the acknowledgement, timestamped by
Discord, with no extra tooling.

---

## 2. The pinned post

> ## LEAP REQUIREMENTS
>
> Three things in your first 90 days. That's all we ask.
>
> **1 — Go LIVE within 7 days of joining**
> **2 — Go LIVE on 10 days in your first 30**
> **3 — Earn 10,000 diamonds in your first 90**
>
> Miss one and you come off the roster.
>
> **Why these three.** They are the lowest bar that tells us you actually want
> to grow — and we checked them against our own numbers before setting them.
>
> Creators who go LIVE on 10 days in their first month are **four times more
> likely** to still be streaming two months later, and more than **ten times**
> as likely to be earning properly. The ones who don't clear it mostly stop
> altogether within a few weeks.
>
> **None of this is hard if you want it.** 10 days in 30 is one night in three.
> 10,000 diamonds across three months is about 110 a day. If that feels like a
> lot, this is the wrong agency for you, and that's a fine thing to find out in
> week one rather than month six.
>
> **Come off the roster and you can come back.** Your clock just restarts at
> day one. No hard feelings either way — we would rather you returned when
> you're ready than stayed on a list doing nothing.
>
> Stuck, ill, away, or something's happened? **Tell your coach before the
> deadline, not after.** We can work with almost anything we know about.
>
> Questions → your coach.

---

## 3. The checkpoint nudges

This is the part that works. Four messages, each sent before a deadline, never
after.

**Day 1 — welcome**

> Welcome to LEAP. Your 90 days start today.
> First one: get LIVE before <DATE>. Doesn't need to be long or polished —
> an hour counts. Just get the first one out of the way.
> Your coach is <COACH>.

**Day 5 — only if they haven't been LIVE**

> You've got 2 days to get your first stream in.
> An hour is enough. Tonight would do it.
> Need a hand setting up? Message <COACH> now, not tomorrow.

**Day 25 — only if under 10 LIVE days**

> You're on <N> of 10 LIVE days with 5 days to go.
> You need <10-N> more nights. An hour each counts.
> If that's not happening, tell <COACH> today and we'll sort something.

**Day 80 — only if under 10,000 diamonds**

> You're on <N> of 10,000 diamonds with 10 days left.
> That's <X> a night. Closer than it sounds.
> <COACH> can help you plan the last stretch — ask.

**Removal**

> Your 90 days are up and the <RULE> wasn't met, so you're coming off the
> roster today.
> This isn't personal and it isn't permanent. If you want to come back, message
> <COACH> any time and we'll restart you from day one.
> Genuinely — good luck with it.

---

## 4. What the system can and can't do

**Webhooks cannot send DMs.** The service posts to channels. So:

| | how |
|---|---|
| Pinned post | manual, once |
| Role changes | manual, or a Discord bot |
| Checkpoint list for coaches | **the service can do this today** — a daily card naming who hits a deadline this week and what they still need |
| DM to the creator | needs either the coach to send it, or a bot token |

**Recommended first step:** the coach-facing checkpoint card. It needs no new
Discord permissions, reuses the existing webhook routing, and puts the right
five names in front of each coach every morning. Coaches send the DMs.

If that proves out, a bot token turns the same list into automatic DMs.

---

## 5. Order to roll it out

1. Post the requirements, pin them, turn on Membership Screening. Today.
2. Give everyone who joins from that date `🌱 NEW CREATOR`.
3. Build the coach-facing checkpoint card. Coaches send the nudges by hand.
4. Run one full month. Count how many got nudged and then cleared the bar —
   that is the number that says whether the nudges work.
5. Only then decide on a bot.

**Do not apply the rules retrospectively on day one.** 122 creators on the
current roster have already missed one of these deadlines. Removing them in
the same week you announce the standard will read as a cull rather than a
policy. Announce it, apply it to everyone joining from that date, and give the
existing roster their own 30-day window to get to 10 LIVE days before the rules
bite on them.
