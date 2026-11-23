# LEAP incentive banking and claiming
## Build spec for the LEAP Discord bot

Prepared for Java. November 2026.

---

## 1. WHAT THIS IS

Creators earn incentives through the month: campaign placings, milestones,
in-house promos. Today those land in a Google Sheet and get paid by hand, and
nobody except the person holding the sheet knows what they are owed.

This system turns that sheet into a bank. Every incentive a creator earns is
**banked** against their name. They can see their balance at any time. When they
want paying they run **`/claim`**, a member of staff approves it, and the agency
pays.

The Google Sheet stays the single source of truth. The bot never holds a balance
of its own. If the bot and the sheet ever disagree, the sheet wins, because the
sheet is what Perry and the directors actually look at.

---

## 2. TWO DECISIONS TO MAKE BEFORE ANY CODE IS WRITTEN

These two came out of the original brief and both change what gets built.

### 2.1 State lives in a column, not in a cell colour

The brief described claims turning a row **yellow**, and approvals turning it
**green**. That visual is right and the spec keeps it. What it must not do is
store the state *in* the colour.

Cell background is not data. It survives nothing. One sort, one copy-paste, one
person tidying the formatting, and the system silently forgets who is owed what.
There is no timestamp, no record of who approved, and no way to answer "when did
this get paid" three months later.

**Instead:** a `Status` column holds a word. **Conditional formatting paints the
row from that column.** The row still goes yellow on claim and green on
approval, exactly as described, but the colour is now a *display* of the truth
rather than the truth itself. It can never drift.

This is a small change to build and the difference between a system that works
in month six and one that does not.

### 2.2 This is a bot, not an AI

The brief refers throughout to "the AI". Nothing here needs a language model.
Every step is deterministic: read rows, filter by Discord ID, sum a column,
write a status, send a message.

Putting a model between a creator and their money introduces a failure mode that
cannot be tested away, which is that it confidently states a wrong balance.
Build it as plain code with rules. It will be cheaper, faster, and it will be
right every time.

---

## 3. THE SHEET

Two new tabs on the existing TRACKING workbook.

### 3.1 Tab: `Incentives Ledger`

One row per incentive awarded. **Rows are never deleted and never reordered.**
This tab is the ledger and the audit trail.

| Col | Field | Written by | Notes |
|---|---|---|---|
| A | `Entry ID` | Bot | `INC-2026-11-0001`. Unique, never reused. |
| B | `Month Earned` | Staff | `2026-11` |
| C | `Creator Name` | Staff | |
| D | `TikTok Handle` | Staff | |
| E | `Discord ID` | Bot | Resolved from the directory on first read |
| F | `Incentive` | Staff | e.g. `Rising Legends 2nd` |
| G | `Amount (GBP)` | Staff | Number, not text. No currency symbol. |
| H | `Status` | Bot / approver | See the state machine below |
| I | `Claimed At` | Bot | ISO timestamp, UTC |
| J | `Decided By` | Bot | Discord username of the approver |
| K | `Decided At` | Bot | ISO timestamp, UTC |
| L | `Paid At` | Bot | ISO timestamp, UTC |
| M | `Receipt Link` | Staff | Matches the existing in-app gifting tab |
| N | `Notes` | Anyone | Free text. Rejection reason goes here. |

**Conditional formatting on column H**, applied across the row:

| Status | Row colour |
|---|---|
| `BANKED` | no fill |
| `CLAIMED` | yellow |
| `APPROVED` | green |
| `PAID` | grey |
| `REJECTED` | red |

### 3.2 Tab: `Creator Directory`

The mapping between a Discord account and a creator. **This is the single most
likely thing to break the system**, because a creator who is not in here cannot
claim and will open a ticket about it.

| Col | Field | Notes |
|---|---|---|
| A | `Creator Name` | Must match column C of the ledger exactly |
| B | `TikTok Handle` | |
| C | `Discord ID` | The numeric snowflake, not the username |
| D | `Active` | `TRUE` / `FALSE` |

Store the numeric Discord ID, not the display name. Display names change.

---

## 4. THE STATE MACHINE

```
                 staff adds row
                       |
                       v
                   [ BANKED ] <--------------+
                       |                     |
                 creator /claim              | rejected, returned to pot
                       |                     |
                       v                     |
                   [ CLAIMED ]  (yellow) ----+
                       |
                 staff approves
                       |
                       v
                  [ APPROVED ]  (green)
                       |
                  finance pays
                       |
                       v
                    [ PAID ]   (grey)
```

A rejection either returns the row to `BANKED` with a note, or terminates at
`REJECTED` (red) if the award was made in error. The approver chooses which.

**Only these transitions are legal.** Any attempt to move a row another way is
rejected by the bot and logged. In particular a row at `PAID` is terminal and
cannot be reopened; a correction is a new row with a negative amount.

---

## 5. COMMANDS

### 5.1 `/incentives` — check balance

Visible to the creator only (ephemeral reply). Never posts publicly.

```
Your incentive pot

BANKED and ready to claim
  Rising Legends 2nd        Nov 2026     £29.10
  Milly Club                Oct 2026     £288.00
  ---------------------------------------------
  Total available                        £317.10

AWAITING APPROVAL
  Community Showdown 3rd    Oct 2026     £7.13

Use /claim to claim your £317.10.
```

### 5.2 `/claim` — claim the pot

1. Resolve the caller's Discord ID against `Creator Directory`.
   Not found, or `Active = FALSE` → reply telling them to open a ticket in
   `#support`. Do not guess at a name match.
2. Read all ledger rows for that Discord ID with `Status = BANKED`.
3. Nothing banked → reply saying so, with their pending total if any.
4. Otherwise show a confirmation with the itemised list and a
   **Confirm / Cancel** button pair. A claim is not a thing to fire off by
   accident.
5. On confirm, write every one of those rows to `CLAIMED` with `Claimed At`,
   in **one batch update**.
6. Post an approval card to `#incentive-approvals`.
7. Reply to the creator confirming what is now awaiting approval.

### 5.3 The approval card

Posted by the bot in a staff-only channel. One card per claim, not per row.

```
CLAIM — Elmo  (@Elmo)
Discord: @elmo_tt

  Rising Legends 2nd     Nov 2026    £9.70
  Aspire Legends 3rd     Nov 2026    £29.10
  ----------------------------------------
  Total                              £38.80

Entries: INC-2026-11-0014, INC-2026-11-0015
Claimed: 2026-11-24 19:42 UTC

[ Approve ]  [ Reject ]
```

Buttons rather than commands. An approver should not have to copy an entry ID.

**Approve** → rows go `APPROVED`, `Decided By` and `Decided At` written, creator
gets a DM.

**Reject** → a modal asks for a reason, then a choice of *return to pot* or
*remove*. Reason is written to `Notes`. Creator gets a DM with the reason.

### 5.4 `/paid <entry-id...>` — mark as paid

Restricted to the finance role. Moves `APPROVED` rows to `PAID`, writes
`Paid At`, and prompts for the receipt link. Creator gets a DM confirming
payment has gone out.

---

## 6. THE MONTHLY ANNOUNCEMENT

A scheduled job. **Default: the 10th of each month, 10:00 UTC.** The date must
be configurable without a redeploy.

For every creator with at least one row where `Month Earned` is last month and
`Status = BANKED`, send a DM:

```
Well done. Here is what you earned in October.

  Milly Club              £288.00
  Community Showdown 3rd    £7.13
  --------------------------------
  Added to your pot        £295.13

Your total pot is now £612.23.

Use /claim whenever you want it paid out. There is no deadline
and it does not expire.
```

Rules for the job:

- **Idempotent.** It must be safe to run twice. Keep a record of
  `(creator, month)` pairs already announced and skip them. A second run after a
  crash must not send a second DM.
- **Rate limited.** At 500 plus creators this cannot fire in a burst. Queue it,
  roughly one DM per second, and respect any 429 with its retry header.
- **Handle closed DMs.** A `403` means the creator does not accept DMs from the
  server. Log it, carry on, and post a single summary list at the end to
  `#incentive-approvals` so somebody can chase them in a ticket.
- **Report.** When finished, post a summary: sent, skipped, failed.

---

## 7. INTEGRATION NOTES

### 7.1 Google Sheets access

- Google Cloud service account, JSON key supplied **as an environment variable**,
  never committed. This matches how `routes.json` is already handled: the real
  credentials are gitignored and only a reference is in the repo.
- Share the TRACKING workbook with the service account email as **Editor**.
- Scope: `https://www.googleapis.com/auth/spreadsheets`.
- Quotas are 300 read requests per minute per project and 60 per minute per
  user. Cache `Creator Directory` in memory with a 5 minute TTL. Never read the
  whole ledger to answer `/incentives`; read once, cache, invalidate on write.
- Use `batchUpdate` for every write. One claim covering six rows is one API
  call, not six.

### 7.2 Concurrency

- Take a per-creator lock around the read-then-write in `/claim`. Two taps on
  Confirm must not produce two claims.
- The sheet write is the commit point. If it fails, nothing happened: tell the
  creator it failed and ask them to try again. Never reply with success before
  the write returns.
- If a human edits a row between the read and the write, the write will still
  land on the row the bot read. Match on `Entry ID`, never on row number.
  **Row numbers move. Entry IDs do not.**

### 7.3 Permissions

- `/incentives` and `/claim`: any creator with the verified role.
- Approve and Reject: an `Incentives Approver` role.
- `/paid`: a `Finance` role.
- A creator can only ever read or claim rows carrying their own Discord ID.
  There is no command that shows one creator another's balance.

---

## 8. WHAT GOOD LOOKS LIKE

The build is finished when all of these are true.

1. Staff add a row to `Incentives Ledger` and the creator can see it in
   `/incentives` within five minutes.
2. `/claim` turns the rows yellow in the sheet and posts one approval card.
3. Approving turns them green, records who approved and when, and DMs the
   creator.
4. `/paid` turns them grey and records the timestamp.
5. The monthly job runs twice in a row and the second run sends zero DMs.
6. Two rapid `/claim` calls produce exactly one claim.
7. A creator missing from `Creator Directory` gets a clear message pointing at
   `#support`, not an error.
8. Sorting or recolouring the sheet by hand changes nothing about what the bot
   believes.

---

## 9. OPEN QUESTIONS FOR PERRY

These are not blockers for starting, but they need answers before launch.

1. **Partial claims.** This spec claims the whole banked pot at once. Should a
   creator be able to claim one item and leave the rest banked?
2. **Minimum claim.** Is there a floor, for example no claims under £10, to keep
   payment admin sane? The sheet shows awards as small as £7.13.
3. **Expiry.** The announcement copy says the pot never expires. Confirm that is
   the policy. If incentives do expire, say after twelve months, that changes
   both the copy and the job.
4. **Who approves?** Named roles, and whether one approver is enough or two are
   needed above a certain amount.
5. **Currency.** The existing sheet carries both coin values and pounds. This
   spec assumes the ledger is pounds only. Confirm.
6. **The Stay Social system.** The brief says "very similar to Stay Social". If
   Java can be shown that bot, differences should be caught now rather than
   after build.
7. **Backfill.** Does the ledger start empty from launch month, or does the
   existing history on the tracking tabs get imported as `PAID` rows so
   creators can see their record?
