# Carla call — 22 October 2026

Working notes from the TikTok LIVE UK+ Agency Team call with Carla (Perry, Andy,
Kelly). Everything below is what was said on the call, organised so it can
actually be built against. Where a rule maps onto code that already exists, the
file is named.

---

## 1. Coach earnings: the 5% incremental display

LEAP shows coaches their incremental share at a **flat 5% for the whole month**
so they can see what they are earning from day one. Real incremental is
impossible to fix in advance, so the figure is a motivator, not a promise.

- The exposure: if the agency's actual incremental lands **below** 5% in a given
  month, the coaches have been shown a number LEAP has to honour. Perry has
  flagged this himself. October is forecast at 8%, last month was 10–11%, so
  there is headroom — but it is not guaranteed headroom.
- Carla's view: correct call. "People need to know what their effort is worth,
  either I have a base, or I know if I put in X amount of work I can achieve Y."

The coach card (Malkin's, shown on the call) already carries: fixed wage,
recruits done, which recruits hit the leap bonus (5 LIVE hours + 5,000
diamonds), the incremental share from their creators, and a "what if" block —
*"£58 if you get commit king to this, £8 if you get this person to this."*

## 2. Carla's ask: rank-up and maintain cards

The highest-value single thing a coach can work on is a **rank-up or a
maintain**. Carla wants a card that says:

> If you got these four rank-ups you'd make £100 more — and here is what each of
> them needs.

Two halves, and the second half is the one LEAP does not have yet: **what does
this specific creator need**. Most of the time it is LIVE hours, but the data
can say more than that.

---

## 3. The diagnosis method — "if this, then that"

This is the core of the call. Source is **Carla's Creator Insights sheet**, not
the Creator data export:

- Lives in Lark. **Download it rather than scan it.**
- Carla refreshes it **every Thursday morning**. Data is **one day delayed**.
- Confirmed on the call: LEAP may download it and put it anywhere, including
  through AI.
- It carries month-on-month percentages, which the daily Creator data export
  does not.
- Lifestyle creators get their own pull — send Carla handles as they come. The
  tiers sheet becomes useful as the lifestyle section grows.

### The rules, as given

**Always: ignore PKs / battles for any non-lifestyle creator.** They are noise
for a gaming roster.

| What the data shows | What it means | What the coach does |
| --- | --- | --- |
| Record month, nothing else off | Anomaly — the stats have no answer | Content review + gifter management |
| Go-live rate fine, nothing else off | Nothing wrong | Keep an eye, keep them excited for the rest of the month |
| More LIVE days, shorter sessions, **HDR unchanged** | Purely an hours problem | Add hours — the money follows directly |
| More LIVE days, shorter sessions, **HDR also down** | Not just hours | Treat as a conversion problem, below |
| **Gift rate down month-on-month** | Engagement and gifter management | See the gift-rate list below |
| **Watch duration down** | One of exactly two things | Going live less (can't watch more), or going live and people aren't staying → content review |
| Stream length **in red** | Streaming too long | Shorten, or change the game |
| Incremental down overall | Comes back to HDR | As above |
| Very high gift rate, low volume | Nothing wrong with the content | They are not going live enough |

**Gift rate, what drives it.** Base layer: welcoming and thanking. Then the
things that actually move it — viewer wishes, gift gathering and gift goals,
campaigns, fan club campaigns, interactive gaming, revenue boosting. You cannot
ask for gifts; you can engage with *how* people can support.

- **Campaigns spike gift rate.** A creator who is always in campaigns reads
  visibly higher. Carla identified Jed from gift rate alone without looking at
  the name. This is also how you can see from the data that someone is *not*
  engaging with a campaign.
- **The bigger the creator, the lower the gift rate** — expected, not a fault.
  Still worth pushing, because gift rate is how you protect revenue and
  maintenance.

**Watch duration, the two readings.** People watching less is either "I went
live less so you could not watch more" or "I went live and you did not stay."
Only the second is a content problem. When it is content, it is very often a
return to basics rather than anything exotic — welcoming, introducing yourself,
revenue boosting, running a gift goal. Perry's own example on the call: bad
LIVE, reset the next morning, welcomed and thanked everyone and revenue-boosted
the gift goal, great LIVE. You know it for two years and you still forget it,
because once you stop focusing on it you assume you are still doing it.

### Against what is already built

`lib/causes.mjs` already detects FEWER_HOURS, STOPPED_CAMPAIGNS,
NEVER_CAMPAIGNS, LOST_GIFTERS, GIFTERS_TAPPED_OUT, NO_GOALS, NO_SHORT_FORM,
ALGORITHM_GAP, HOLIDAY, DRAMA. Carla's rules add or sharpen:

- **HDR month-on-month as the splitter.** We hold `diamondsPerHour28` and
  `diamondsPerHour7` in `lib/metrics.mjs`; what is missing is the explicit
  "hours down, HDR flat → it is only hours" versus "both down → conversion"
  fork, stated in those words on the card.
- **Gift rate as a named metric.** We have `fanClub.share7` and
  `fanClub.diamondsChange7`; Carla's "gift rate" is the headline number and
  deserves to be quoted as one.
- **Watch duration.** Not in the Creator data export. It is in the Creator
  Insights sheet. Would need that sheet ingested.
- **Ignore PKs for non-lifestyle creators.** Needs a lifestyle flag on the
  roster; everything else defaults to ignoring battles.
- **The anomaly fallback.** When nothing in the stats explains a record month,
  say so and fall through to content review + gifter management, rather than
  inventing a cause.

---

## 4. Side quests

- Go to **mature creators and above**, not everyone.
- Saturday's run: if everyone hits, LEAP makes about **£2,300** extra against a
  cost of about **£500**.
- Carla will **sanity-check the money differential**. Perry sends the PDF on
  Saturday; she checks it, then checks it again for the next two months, and
  then the system is proven.
- Prizes do not have to be coins — a wristband, a Stanley, a chance to wear
  something. The reaction so far has been strong.
- Carla's dashboard answers the question side quests actually turn on: **is this
  quest worth the diamonds?** For Mimi, a 15,000-diamond quest was not worth it;
  but if she finished 11,000 short of a rank-up, gifting her the 11,000 to take
  the 15,000 would be.

## 5. Carla's dashboards — and what LEAP should copy

LEAP does not have access; Carla does, and will screen-share them weekly.

**Dashboard 1 — rank-up / maintain, in diamonds.** Shows potential payout and
what each creator needs to get over the edge. Also exists for **activeness**.

Carla's direct advice on format, asked by Perry:

- The format is good. **Remove anyone who cannot do anything.** The list should
  be: who is ranking up, who is maintaining, who is close to a rank-up and worth
  chasing. Nobody else.
- **Do not share this version with staff** — it is a director's tool for side
  quest and gifting decisions. For the coach version, **rename the column to
  "rank up needed"** and do the payout math yourself.
- **Colour it.** A coach should be able to see at a glance that someone is red,
  then ask why.

**Dashboard 2 — forecast.** Projects incremental %, rank-up bonus and so on from
last month's execution plus current tracking. LEAP: ~10–11% incremental last
month, 8% forecast now (Cursed was not there last month). Rank-up bonus is
running well above September — which says keep pushing rank-ups and maintains.

## 6. The coach portal

Perry's problem: the data is good but pushing it as messages reads as spam.
Proposed a portal — coaches open it, see their creators, see what to do, press a
button that tells them what to send.

Carla: **do both.**

- A portal for the coach who is in it to win it and will check daily.
- A **weekly nudge** for the average coach — "reminder to poke Andrew."
- Ask the coaches after a month whether it is too many messages.
- Keep it simple. Colour-coded. Do not overcomplicate it.

This is the shape it wants: the goals LEAP already sets for coaches, combined
with every creator they need to engage with, each row carrying the diagnosis
from §3 and a button that produces the message.

---

## 7. Star creators and verticals

- P Star / LA Star creators are **becoming more important**, and there may be a
  **special bonus on them next month**.
- The logic: TikTok has got quantity, and got revenue out of that quantity. Now
  it wants **quality**. Star creators and verticals are what quality means.
- Better content also means getting blocked less, which means earning more.
- No dashboard for it yet. Carla will put it in the sheet as soon as there is
  one. Visible on Starlight currently.

## 8. Campaign calendar

The problem: LEAP builds its campaign calendar a month ahead, TikTok's lands
late, and the two collide — which has cost money these last months.

Carla's answer:

- TikTok's general calendar is being pushed to land in the **first week** of the
  month. Partner campaigns cannot be announced until the partner aligns, so they
  will always be late.
- **Put TikTok campaigns on LEAP's calendar as unnamed placeholders.** "There is
  a TikTok campaign here." There is a TikTok campaign essentially **every
  week**, so the placeholder is safe even when the specific one moves.
- **Gaming Arena and Live Fest will never be cancelled** — only shifted by a day
  or two. Plan around those tentpoles.
- Product can still move things for reasons LEAP cannot predict — e.g. not
  running over a weekend because of weekend experience problems.
- **Plan campaigns around a wider goal.** Always have a **Road to 200k** of some
  form. Side quests sit under it, getting millionaires over the edge. Flash
  campaigns and LEAP's own tentpoles (Community Cup, Road to HQ) go around that.
- **Spend the campaign budget on the small creators.** The big ones will compete
  and win without it.
- There are general TikTok campaigns LEAP's creators could join and are not
  attuned to — that is revenue left on the table.

**November from TikTok:** another gaming-agency Crew Showdown, a gaming side
campaign during Power League, and a flash campaign on GTA launch day. Dalia's
calendar is strong; it will be shared once confirmed.

## 9. Creator Network Tournament — Talent League points

Found out the morning of the call, not yet 100% confirmed.

How Creator Network points work:
- **Sign-ups**: sign up + the creator goes LIVE = X points.
- **Regionals / Power League**: 1 diamond = 1 point.
- **Milestones**: e.g. hit 10m diamonds, get 50,000 points.
- **New — Talent League**: incremental points on top. Roughly, make 1m diamonds
  and get ~15% of that again as Talent League points.

Why this matters for LEAP specifically: every agency earns the regular points.
**The other agencies are not earning Talent League points.** LEAP is positioned
to. Carla: "this could really be our year" — the last year before competing
against Hey Honey and Fast Track.

**Action: get people signed up.**

## 10. Special bonuses

- Starlight on track for ~£4.5k; recruitment bonus another £500–1,000. ~£5.5k
  total, possibly more. Recruitment target was 144.
- **The battle bonus is not worth chasing.** It is the minimum target, ~$500,
  and LEAP's top three would need 300k in battles, which has never happened.
- Carla will send a **special bonus recap**: which bonuses LEAP is in, where it
  currently stands, and what is actually worth pushing.

## 11. Kicking inactives

- LEAP's average go-live rate has dipped because nobody was kicked this month —
  Starlight points.
- **Do not kick before Live Fest either**: there are points for sign-ups.
- **No other agency kicks after two months. That is only LEAP.** Hey Honey and
  the other big agencies keep inactive creators for months in case they come
  back. A battler can be dormant four months and then kill it; less likely for
  gaming, but the point stands.
- The cost of not kicking is a trend-score ding, which is small.

## 12. The gaming thesis — and the battle target correction

Carla had LEAP's battle target changed. The team had pulled targets from pre-top
and top revenue for the past three months with the battle share underneath, but
**never percentaged it**. LEAP was the only agency whose AM noticed, because:

- LEAP's battle revenue is **under 10%** of that pre-top/top revenue.
- Most other agencies are at **90–97% PK at pre-top**.

Her argument, and it is the strategic one worth keeping:

> A battler cannot sustain 97% PK for three years — people get bored, gifters
> leave. A gamer can. 80% gaming revenue and 20% battles is why your agency will
> be so strong.

Evidence on the board: two gaming agencies in the UK top 10. The top three in
LEAP's Starlight league are all gaming agencies, sitting level with huge
Italian and Spanish battle agencies. Battle agencies spike and fall; LEAP just
keeps moving up.

## 13. Where October stands

- Tracking at **−3% month-on-month**, with Unkink down ~60% (3m → 1.8m) and this
  supposedly being the quiet week.
- Fewer campaigns run, ~£1,000 saved, and still a strong month.
- **Cursed is an anomaly** — ~2m, and "literally everything we tell you not to
  be": static images, no face cam, no revenue boosting, no campaigns.
- The anomaly worry is next month's comparison. Impact has the same problem with
  Grits (10m in a week). Carla: *"if you're going to have an anomaly month,
  having one just before Live Fest is okay."*
- No quit requests, good recruits, creators returning, healthy atmosphere.

## 14. KA announcements — standing request

**Perry's request, agreed by Carla: do not announce when LEAP hits KA.** Say
"record goals" or "hit goals", or say nothing.

Reason: LEAP's positioning is the underdog that then surprises everyone. Carla
announces because some agencies love it and TikTok wants to show it celebrates
internally — she will use "record goals" for LEAP instead.

## 15. Live Fest

- **The angle is "it's not a campaign, it's an event."** Keep pushing that
  wording for as long as possible.
- Six or seven good creators coming to London next week. That plants the seed
  with all of them.
- Carla asked LEAP to go LIVE on the leap account to talk about Live Fest.
  **Perry will do it with a base deck, not off the cuff** — a TikTok deck, LEAP
  and TikTok logos behind him, ring light. That is the brand standard: it should
  look like the HQ article. Carla is getting a base deck and will check whether
  a push notification can go out ("leap is going live now to talk about Live
  Fest").
- Carla will boost it and share it in the G4 / G3 community WhatsApps.
- Explicitly optional — "not one of those ones where I'm like, do not say no."
- Future iterations (House Cup, Community First) may get a proper spotlight like
  Call of Duty had.
- **Promo plan sequence agreed**: TikTok meeting tomorrow → the event next week →
  LEAP builds its Live Fest promo plan the week after → one Thursday spent
  walking Carla through it so she can flag anything missing. That lands just as
  warm-up starts.

## 16. The 29th

- Event runs **2pm till 9pm**. Drinks before at the **Queen's Head pub**. Andy
  leaving at 5. Dress code to confirm, assume smart casual.
- A possible second event the same evening, ~7pm, run by **Red Bull**. Dalia and
  Carla have applied for one or two LEAP creators plus Kelly as a creator.
  Ticket count unknown, approval not guaranteed.
- Carla will send the confirmed attendee list; LEAP sends invites to its own
  creators.
- **Open action for LEAP**: from the list Carla shared, name anyone LEAP wishes
  had replied. She will check if they are attending and make a point of
  introducing them.

## 17. Content and brand

- The **TikTok HQ video** is LEAP's best. The format works because nobody wants
  to watch a founder talk about why they made HQ — first 5–10 seconds is the
  hook ("we're at London with TikTok, let's jump in"), then straight to the
  montage. Photos, atmosphere, 20 seconds, done.
- Same format for Live Fest: hook is Perry and the creators outside the venue or
  by the Live Fest logo — "we've brought our creators to London for the Live
  Fest launch, let's go" — then the montage.
- Carla and Dalia are using LEAP's **Summer Nights video in a pitch deck for Red
  Bull.**

## 18. Dubai / MENA

- The model: find a third person to run it — "an Archie". They take the same
  split Perry and Andy take; Perry and Andy halve their half. **LEAP keeps 50%.**
- Carla sees a real gap for a **gaming agency in MENA**, and a gap for getting
  MENA gifters into the UK. UK vs MENA interactive campaigns.
- Waiting on Ashley / Persh.
- **Contact route: Anton**, who is Ahmed's boss. Carla will get his email.
  When Perry messages him, **do not throw Ahmed under the bus** — "sorry it took
  me so long, I only got your email now, I lost it."
- Carla's only condition: LEAP stays the focus. "If it becomes a liability I'm
  just going to stop answering your calls."

## 19. Off-platform rules — the Luky flag

Luky cannot be safe-listed because he is pushing **X/Twitter and Discord**, and
crucially **not in a visual space** — his bio tree is already gone and he is
still being flagged, so it is something **written**: super fan welcome message,
viewer wishes, or LIVE room titles. Carla is getting the exact location from
TNS; Luky probably knows if asked directly.

The rule and the reasoning:

- **Anything encouraging people to leave the app.** TikTok's system reads
  written text; a human reviewer might not spot it, the system does.
- Why: (1) TikTok does not control the other platform, so if someone gets
  scammed there it becomes TikTok's problem; (2) a gifter sitting in your LIVE
  who leaves for Discord does not come back and does not gift there.
- On-screen handles that are subtle (the "machine gun Lucci Luky" twitch/kick
  bar) are fine. It is the written push that gets you.
- **Short form is exempt.** A short-form video saying "join my Discord" does not
  affect your LIVE.
- **The line to give creators: use short form to build your other platforms,
  keep LIVE TikTok-focused.** That is where you get nailed for driving to third
  parties.

LEAP's angle with Luky is working — a creator who was never going to touch a
campaign again has agreed to do gaming LIVE next month, by feeding him the point
that the reason he is on Kick at all is TikTok.

## 20. Tax / HMRC

Perry is exploring LEAP helping creators with tax, and asked whether Carla has
seen HMRC come after TikTok LIVE creators.

- **South Africa**: people were hit with tax bills, from short form.
- **UK**: she has heard **directly-managed creators mention tax issues**.
- The underlying problem: people treat it as funny money, not real income. They
  undersave because they want all of it now, and it is very hard to claw back.

She agreed it is a real issue and worth researching further.

## 21. Trophies — open complaint

LEAP asked for months where TikTok sources its Gaming Arena trophies and plaques
and was told they could not have them and no link could be given. **Illuminate
has since turned up with the exact same trophies.**

Carla's response: she would not share a supplier with one agency and not
another; she has always said they come from Fluid or a Chinese supplier, and she
does not believe the Gaming Arena trophy is Fluid. It may be a dupe. **She will
ask Illuminate** — and if they found them cheaper or faster, TikTok might change
supplier anyway.

## 22. Process notes

- **Carla records these calls** and will share the recording.
- Andy does month-end — data, wages, books — overnight on the 31st into the 1st.
  Not because it has to be done then, but because it is the quietest part of the
  day and it means LEAP can forward-plan immediately instead of waiting a week.
- **LEAP has predicted its revenue accurately three months running.** Everyone
  says you cannot predict TikTok revenue. That capability matters most when the
  fee policy changes, because it lets LEAP make educated guesses about what the
  new shape looks like.
- Carla's standing offer: **trainings for LEAP staff, and one-to-one support
  with LEAP's bigger creators.**

---

## Open actions

**LEAP**
- Send Carla the side quest PDF on Saturday for the money-differential check.
- Name anyone from Carla's list LEAP wishes had replied, so she can arrange an
  introduction on the 29th.
- Build the Live Fest promo plan the week after the event; book a Thursday to
  walk Carla through it.
- Push Creator Network sign-ups — the Talent League points are the opportunity.
- Message Anton once Carla supplies the email. Do not throw Ahmed under the bus.
- Ask Luky directly where his Twitter/Discord push is written.
- Send Carla lifestyle creator handles as they come.
- Research HMRC exposure for UK LIVE creators.

**Carla**
- Special bonus recap: standings and what is worth pushing.
- Live Fest base deck, and check on a push notification for the LEAP LIVE.
- Confirmed attendee list for the 29th.
- Exact location of Luky's flag from TNS.
- Ask Illuminate about the trophy supplier.
- Star creator / vertical data into the sheet once a dashboard exists.
- Sanity-check side quest payout math, Saturday and for two months after.

**Build**
- Rank-up / maintain coach card with the per-creator "what they need" diagnosis.
- Ingest Carla's Creator Insights sheet (Thursdays, one day delayed) for
  month-on-month HDR, gift rate and watch duration.
- The if-this-then-that rules from §3 into `lib/causes.mjs`.
- Ignore PKs for non-lifestyle creators — needs a lifestyle flag on the roster.
- Coach portal: one row per creator needing attention, colour-coded, a button
  that writes the message, plus a weekly nudge for coaches who will not open it.
- Rename the director rank-up column to "rank up needed" for the coach-facing
  version, and strip anyone who cannot be acted on.
