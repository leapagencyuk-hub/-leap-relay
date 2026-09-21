# Andy

The coaching brain. Staff ask a question in Discord; Andy answers from LEAP's own
document library **and** the asked-about creator's live numbers.

The second half is the point. A search box over a folder of PDFs gives generic
advice. Andy reads what the creator actually did this week — against last week,
against last month, against their own normal — works out which part of the
library applies to *that*, and answers with both.

```
Coach:  @Andy sur3shot has fallen off a cliff this week. What do I say on the call?

Andy:   Their diamonds are down 43% but that's the symptom, not the cause —
        they've lost 2 LIVE days (4 in the last 7, down from 6) and 25% of their
        hours. The room didn't leave; they stopped showing up for it.

        Fan club diamonds are down 38% while membership only fell 10%, so it's
        the same faces gifting less, not people walking. That usually follows
        the schedule rather than causing it [#214].

        Ask about Tuesday and Thursday specifically — those are the two they
        dropped. Then: is the schedule still realistic for their life right now,
        or has something changed? [#87]

        Josh already had a schedule conversation with them on 16 Sept
        (case D-260915-6627), so don't open with that one again.

        Sources
        #214  Fan Club Retention.pdf — Spending vs membership · p6
        #87   Coaching Conversations.pdf — Schedule slippage · p12
```

---

## How it fits together

```
   Google Drive folder                    creator-health service
   (staff drop files in)                  (the daily TikTok export)
           │                                        │
           ▼                                        │
   ┌───────────────┐  PDF/DOCX/Docs → text          │
   │  1  sync      │  lib/drive.mjs                 │
   │               │  lib/extract.mjs               │
   └───────────────┘                                │
           │                                        │
           ▼                                        │
   ┌───────────────┐  heading-aware, page-tracked   │
   │  2  chunk     │  lib/chunk.mjs                 │
   └───────────────┘                                │
           │                                        │
           ▼                                        │
   ┌───────────────┐  BM25 + int8 vectors           │
   │  3  index     │  lib/keyword.mjs               │
   │               │  lib/vectors.mjs               │
   └───────────────┘                                │
           │                                        │
           ▼                                        ▼
   ┌────────────────────────────────────────────────────┐
   │  4  answer — claude-opus-5 with three tools         │
   │     search_knowledge · get_creator · list_cases     │
   │     lib/answer.mjs                                  │
   └────────────────────────────────────────────────────┘
           │
           ▼
   ┌───────────────┐  @mentions over the Gateway,
   │  5  Discord   │  /andy over the interactions endpoint
   └───────────────┘  lib/gateway.mjs · lib/interactions.mjs
```

---

## Where the answers come from

### The library

Everything in one Google Drive folder, including sub-folders. Staff drop files
in; Andy syncs them nightly and on demand. No upload step, no second place to
remember.

| Format | Read as |
|---|---|
| PDF | Text layer, page by page. **A scan with no text layer cannot be read** — it needs OCR first, and Andy says so by name rather than skipping it quietly. |
| DOCX | Full text |
| Google Docs / Slides | Exported as text |
| Google Sheets / CSV / TSV | Row by row with the header on each, so a table stays searchable |
| TXT, Markdown, HTML, JSON, RTF | Directly |
| VTT / SRT | Subtitles with the timestamps stripped — this is how a recorded call or a stream becomes searchable |

Unchanged files are skipped on their Drive checksum, so a nightly sync over
hundreds of documents downloads nothing. A file deleted from Drive stops being
quoted on the next sync — a document somebody removed because it was wrong must
stop being an answer.

### The creator data

Andy calls the `leap-creator-health` service over HTTP. It reads exactly what a
coach's Discord card is built from:

- this week against last, judged against that creator's own volatility
- this month against last month, prorated to the same day
- fan club membership and spending, moving separately
- campaign history — the one cause in the whole export the data can confirm
- **the open case, its ranked causes, and what the coach has already tried**

That last line is why the example above does not say "have a schedule
conversation". It already happened.

---

## The four things that decide whether an answer is any good

**1. Chunk on structure, not on length.** A passage that says "do this for 20
minutes" with no clue what "this" is reads as authoritative and is useless. Every
chunk carries its heading trail — `Fan club growth > Early stage > Under 1,000
followers` — and its page number, so a citation is something a coach can open and
check.

**2. Keyword and vector search both run.** They fail differently. Vectors find
"the room is dead" in a document that says "low engagement"; BM25 finds the page
that says *Pink Drift* when someone asks about Pink Drift. Their ranks are fused
with reciprocal rank fusion rather than their scores added, because BM25 scores
are unbounded and cosine similarities are not — any weighted sum needs a
constant that has to be retuned every time the corpus changes.

**3. Numbers first, library second.** When a creator is named, Andy fetches their
data before it searches. Their numbers decide which part of the library is
relevant. Searching first produces advice that would fit anyone, with a name
stapled to the front.

**4. Every citation is checked.** Andy cites passages as `[#214]`, and every id
is verified against the passages actually retrieved before the answer is shown.
An id Andy never saw is stripped out and counted. A coach who clicks a source
once and finds nothing there stops clicking sources.

---

## Using it in Discord

### Just talk to it

`@Andy why has the fan club stopped spending on gh0s733?`

Andy replies in the channel, in a thread if you start one. A thread remembers its
last few turns, so *"and what about his schedule?"* works. Replying to one of
Andy's messages counts as talking to it — no mention needed.

### Slash commands

| Command | What it does |
|---|---|
| `/andy question:…` | Ask anything. Add `private:true` to keep the answer to yourself. |
| `/andy-creator username:…` | Everything Andy knows about one creator and what to do about them. |
| `/andy-status` | What Andy has read, and what it is missing. Always private. |

Answers are public by default on purpose: one coach's question usually answers a
question three other people had.

---

## Setting it up

### 1. The Drive folder

1. **Google Cloud Console → IAM & Admin → Service Accounts → Create.** No roles
   needed; this account only ever reads one folder.
2. **Keys → Add Key → JSON.** Download it.
3. Share the Drive folder with the service account's email address (it looks
   like `andy@project.iam.gserviceaccount.com`) as **Viewer**.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the file's contents — raw JSON, or
   base64 if pasting JSON into the dashboard field is awkward.
5. Set `ANDY_DRIVE_FOLDER_ID` to the id in the folder's URL:
   `drive.google.com/drive/folders/`**`1a2b3c…`**

A service account is the right shape here: nobody clicks through a consent
screen, no refresh token expires, and revoking Andy's access is removing one
member from one folder.

### 2. The Discord bot

1. **https://discord.com/developers/applications → New Application.**
2. **Bot → Reset Token** → `DISCORD_BOT_TOKEN`.
3. **Bot → Privileged Gateway Intents → Message Content Intent: ON.** Without
   this Andy connects, sees that a message happened, and reads an empty string —
   which looks like a broken bot rather than a missing setting. It is called out
   in the logs for that reason.
4. **General Information → Public Key** → `ANDY_DISCORD_PUBLIC_KEY`;
   **Application ID** → `ANDY_DISCORD_APP_ID`.
5. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   permissions *Send Messages*, *Send Messages in Threads*, *Embed Links*,
   *Read Message History*. Open the URL and add Andy to the server.
6. Deploy, then set **Interactions Endpoint URL** to
   `https://leap-andy.onrender.com/discord/interactions` (whatever host Render gives the `leap-andy` service). Discord sends a signed PING and
   will not save the URL until it verifies.
7. `node cli.mjs register <guildId>` to publish the slash commands. Guild-scoped
   appears immediately; global takes up to an hour.

`@mentions` work as soon as the bot token is set — they go over the Gateway, not
the interactions endpoint. The endpoint is only needed for slash commands.

### 3. Keys

| Variable | What breaks without it |
|---|---|
| `ANTHROPIC_API_KEY` | Everything. Andy cannot answer. |
| `VOYAGE_API_KEY` | Nothing visibly — retrieval silently falls back to keyword-only, which is worse at paraphrased questions. `/andy-status` says so. |
| `ANDY_TOKEN` | Nothing, but `/sync` and `/ask` are then open to anyone who finds the URL. |
| `CREATOR_HEALTH_URL` | Andy can advise from the library but cannot look up a creator's numbers. |
| `UPLOAD_TOKEN` | Same — creator-health rejects the lookup. Use the same value creator-health is protected with. |

### 4. First sync

Open the admin page and press **Sync from Drive**, or:

```bash
node cli.mjs sync
```

Hundreds of PDFs take a few minutes the first time and seconds after that.

---

## Running it

```bash
node cli.mjs sync              # pull the Drive folder in and reindex
node cli.mjs sync --force      # re-read everything, ignoring checksums
node cli.mjs reindex           # re-chunk and re-embed from cache, no download
node cli.mjs ask "why do fan clubs stop spending?"
node cli.mjs search "fan club"  # the raw passages, no model call — for checking retrieval
node cli.mjs status            # what Andy has read, and what it is missing
node cli.mjs doctor            # live-check every connection, with the fix for each failure
node cli.mjs docs              # every document with its chunk count and any error
node cli.mjs register <guild>  # publish the slash commands
node cli.mjs whoami            # check the bot token reaches Discord
npm test
```

`search` is the one to reach for when an answer is wrong. It shows exactly what
Andy was given, with no model in the way, which separates "the library doesn't
cover this" from "retrieval didn't find it".

### As a service

```bash
ANDY_TOKEN=... npm start        # :8901
```

| Route | Purpose |
|---|---|
| `GET /` | The admin page — corpus, readiness, sync buttons, an ask box |
| `GET /status.json` | Everything the admin page shows, machine-readable |
| `POST /sync` | Pull Drive in and reindex (`?force=1` re-reads everything) |
| `POST /reindex` | Re-chunk and re-embed from cache |
| `POST /ask` | `{ question }` → the answer and its sources |
| `POST /discord/interactions` | Discord's interactions endpoint |
| `GET /health` | Document and passage counts, Gateway state |

`/sync`, `/reindex` and `/ask` need `ANDY_TOKEN` when it is set.
`/discord/interactions` is protected by Discord's Ed25519 signature instead and
must stay open for Discord to reach it.

Andy re-reads the folder every three hours (`knowledge.syncEveryHours`, or
`null` to leave it to the button), and once on startup if the last sync is
older than that. Files go into Drive constantly, and a cycle that finds nothing
new costs a single API call — only a file whose checksum moved is downloaded or
re-embedded — so this is deliberately frequent rather than nightly.

---

## Why the index is a flat file

No database, no native module, no second service. The whole index is one binary
file scanned in full on every query.

At this corpus size that is not a compromise:

| Corpus | Index on disk | Search |
|---|---|---|
| 5,000 passages (~50 documents) | 4.9 MB | 10 ms |
| 50,000 passages (~500 documents) | 49 MB | 120 ms |

An approximate index would add a build step, a native dependency and a tuning
parameter to save time Andy does not spend — it is already answering inside
Discord's deferred-response window with two orders of magnitude to spare.

Vectors are stored as int8 rather than float32. Unit-length embeddings live in
`[-1, 1]`, so one byte per dimension holds them to about three decimal places:
measured quantisation error is under 0.001, which is nowhere near enough to
change a ranking, and the file is a quarter of the size.

---

## Known limits

- **A scanned PDF is invisible.** No text layer, nothing to read. Andy lists
  them by name on the admin page and in `/andy-status` rather than skipping them
  quietly, but running them through OCR is a manual job.
- **Andy does not know what it has not been given.** A gap in the Drive folder
  is a gap in the brain, and it will answer from the creator data and say the
  library does not cover it — which is the honest answer, but it looks like a
  limitation of the tool rather than of the folder.
- **Images and video are not read.** A deck's text is extracted; a chart in it
  is not. Neither is anything said in an `.mp4` unless a transcript is uploaded
  beside it.
- **Retrieval is per question, not per conversation.** A follow-up in a thread
  carries the previous turns but searches fresh, so a vague follow-up can
  retrieve differently to its parent question.
- **Thread memory lasts a day** and is capped. It is a coaching conversation,
  not a record of one.
- **Without an embeddings key, paraphrase suffers.** Keyword-only retrieval
  finds the exact terms and misses the rest. This is visible in `/andy-status`
  rather than silent, but it is easy to leave in that state and not notice.
- **Creator lookups are as fresh as the last export.** If nobody uploaded
  today's file to creator-health, Andy is advising on yesterday's numbers. It
  reports the reading's age when it is stale.
- **Costs scale with questions, not with the corpus.** Embedding the library is
  a one-off of a few pence. Each answer is an Opus call with the passages in
  context.

## Next, in order of value

1. **Real questions from real coaches, then read what retrieval returned.**
   `cli.mjs search` against the questions people actually ask is the fastest way
   to find out whether the chunking suits these documents.
2. **OCR the scans.** Every scanned deck is a document the network paid for and
   cannot use.
3. **Let Andy open a case.** It already reads the caseload; writing to it — "log
   this as tried" from a Discord button — closes the loop that creator-health's
   effectiveness report depends on.
4. **Feed answers back.** A thumbs-down on an answer, stored with the question
   and the passages retrieved, is the eval set. Without it, tuning retrieval is
   guesswork.
