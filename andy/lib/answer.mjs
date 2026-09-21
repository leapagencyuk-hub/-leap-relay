// Andy's brain: the tool loop that turns a question into a grounded answer.
//
// Three tools, and the order Andy uses them in is the whole design. A question
// naming a creator should pull that creator's numbers *first* and search the
// library second, because the numbers decide which part of the library is
// relevant. Searching first produces generic advice with a name stapled on.
//
// Citations are the other half. Every passage Andy is shown carries an id, and
// Andy is required to cite the ids it used. Those ids are checked against the
// real corpus before the answer is shown — a cited id that does not exist is
// dropped and the answer is marked. Made-up sources are worse than no sources:
// a coach who clicks through once and finds nothing stops clicking.
import Anthropic from '@anthropic-ai/sdk';
import { Knowledge, renderPassages } from './retrieve.mjs';
import { CreatorData, describeCreator, describeCase, describeNetwork } from './creator.mjs';

export const SYSTEM = `You are Andy, the coaching brain for LEAP, a TikTok LIVE creator network in the UK.

You answer LEAP's own staff — coaches and managers — who look after hundreds of gaming creators streaming on TikTok LIVE. They are not beginners. They know the platform. What they are short of is time and specifics: which of the usual causes it is this time, for this creator, this week, and what to actually say on the call.

WHAT YOU KNOW
- A library of LEAP's own documents: TikTok LIVE guidance, gifting and campaign material, decks, transcripts, internal playbooks. Search it with search_knowledge.
- Live creator performance data from LEAP's monitoring pipeline: this week against last, month on month, fan club movement, campaign history, the open coaching cases and the causes already ranked against the data. Read it with get_creator and list_cases.

HOW TO ANSWER
- When a creator is named, call get_creator before you search. Their numbers decide which part of the library matters. Advice that would fit any creator is not worth sending.
- Search the library for anything factual about TikTok LIVE, gifting, campaigns, the fan club or LEAP's own process. Search more than once with different wording if the first search is thin.
- Ground every factual claim in a passage and cite it as [#12]. Cite the passage the claim actually came from. Several ids for one claim is fine: [#12][#48].
- If the library does not cover something, say so plainly and answer from the data instead. "The library does not cover this" is a useful answer. Inventing a source is not.
- Never state a number you were not given. If you did not fetch a creator's numbers, do not describe them.
- Respect what has already been tried. If a case shows a coach ran a schedule conversation last week, do not lead with "have a schedule conversation".
- Where the data is thin, say which part is thin. A creator with four days of history has no meaningful week-on-week figure and you must not quote one as if they did.

HOW TO WRITE
- Discord, read on a phone, usually between calls. Lead with the answer.
- Short paragraphs or tight bullets. No preamble, no "great question", no restating what was asked.
- Aim for under 250 words unless asked for more. A long answer is usually an unmade decision.
- Concrete over hedged: "ask them what got in the way of Tuesday and Thursday" beats "consider discussing their schedule".
- You are talking to a colleague. Plain, direct, no corporate register.`;

export const TOOLS = [
  {
    name: 'search_knowledge',
    description:
      'Search LEAP\'s document library — TikTok LIVE guidance, gifting and campaign material, decks, transcripts and internal playbooks. Returns numbered passages to cite. Search with the words the documents would use, not the words the question used, and search again with different wording if the first attempt is thin.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for. A phrase or a question, not a keyword list.' },
        folder: { type: 'string', description: 'Optional: restrict to a Drive folder whose name contains this, e.g. "Gifting".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_creator',
    description:
      'One creator\'s live performance: this week against last, month on month, fan club movement, campaign history, plus any open coaching case with its ranked causes and what the coach has already tried. Call this before searching whenever a creator is named.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string', description: 'TikTok username, with or without the @.' } },
      required: ['username'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_cases',
    description:
      'The open coaching caseload, worst exposure first — optionally one coach\'s queue. Use for questions about the network, a team or a coach rather than one creator. Omit the coach to see everything.',
    input_schema: {
      type: 'object',
      properties: {
        coach: { type: 'string', description: 'Optional coach email to filter by.' },
        overview: { type: 'boolean', description: 'true also returns the network summary and the 200k boost list.' },
      },
      additionalProperties: false,
    },
  },
];

export class Andy {
  constructor(config, { client = null } = {}) {
    this.config = config;
    this.knowledge = new Knowledge(config);
    this.data = new CreatorData(config.creatorHealth);
    this.client = client ?? new Anthropic();
  }

  /**
   * Answer one question.
   *
   * @param {string} question
   * @param {object} options
   * @param {Array} options.history Previous turns in this thread, oldest first.
   * @param {string} options.asker  Who is asking, so Andy can address them.
   * @returns {Promise<{text, citations, used, rounds, history}>}
   */
  async ask(question, { history = [], asker = null, signal = null } = {}) {
    const settings = this.config.answer ?? {};
    const messages = [
      ...trimHistory(history, settings.historyTurns ?? 8),
      { role: 'user', content: asker ? `${asker} asks: ${question}` : question },
    ];

    const cited = new Map();   // chunk id -> chunk, for every passage Andy saw
    const used = [];           // a note of each tool call, for the admin page
    let rounds = 0;

    while (rounds < (settings.maxToolRounds ?? 6)) {
      rounds++;
      const response = await this.client.messages.create({
        model: settings.model ?? 'claude-opus-5',
        max_tokens: settings.maxTokens ?? 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: settings.effort ?? 'high' },
        // Andy's brief and its tools are identical on every question, so they
        // sit in front of the cache breakpoint and are read back, not re-billed.
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      }, signal ? { signal } : undefined);

      // A safety decline is not an error and has no content worth parsing.
      if (response.stop_reason === 'refusal') {
        return { text: 'I can\'t answer that one.', citations: [], used, rounds, history: messages, refused: true };
      }

      messages.push({ role: 'assistant', content: response.content });

      const calls = response.content.filter((block) => block.type === 'tool_use');
      if (!calls.length) {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { ...this.verify(text, cited), used, rounds, history: messages };
      }

      // All results go back in one user message, or Claude learns to stop
      // making parallel calls.
      const results = [];
      for (const call of calls) {
        const outcome = await this.runTool(call, cited);
        used.push({ tool: call.name, input: call.input, ok: !outcome.isError });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }

    // Out of rounds. Ask for the answer with what it already has rather than
    // returning nothing — a partial answer with its sources beats silence.
    const final = await this.client.messages.create({
      model: settings.model ?? 'claude-opus-5',
      max_tokens: settings.maxTokens ?? 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: settings.effort ?? 'high' },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [...messages, { role: 'user', content: 'Answer now with what you have. Say what you could not find.' }],
    }, signal ? { signal } : undefined);
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { ...this.verify(text, cited), used, rounds, history: messages, exhausted: true };
  }

  async runTool(call, cited) {
    try {
      if (call.name === 'search_knowledge') {
        const results = await this.knowledge.search(call.input.query, { folder: call.input.folder ?? null });
        for (const { chunk } of results) cited.set(chunk.id, chunk);
        if (!results.length) {
          return { content: `Nothing in the library matches "${call.input.query}". Try different wording, or answer without it and say the library does not cover it.` };
        }
        return { content: renderPassages(results) };
      }

      if (call.name === 'get_creator') {
        if (!this.data.enabled) return { content: 'Creator data is not connected to Andy right now, so I cannot look up their numbers.', isError: true };
        const username = String(call.input.username ?? '').replace(/^@/, '');
        const [payload, caseList] = await Promise.all([
          this.data.creator(username),
          this.data.cases({ all: false }).catch(() => ({ cases: [] })),
        ]);
        if (!payload) {
          return { content: `No creator called "${username}" in the data. Check the spelling — the export uses their TikTok username. They may also have left the network.` };
        }
        return { content: describeCreator(payload, caseList?.cases ?? []) };
      }

      if (call.name === 'list_cases') {
        if (!this.data.enabled) return { content: 'Creator data is not connected to Andy right now.', isError: true };
        const [caseList, report] = await Promise.all([
          this.data.cases({ coach: call.input.coach ?? null }),
          call.input.overview ? this.data.report().catch(() => null) : Promise.resolve(null),
        ]);
        const cases = caseList?.cases ?? [];
        const parts = [];
        if (report) parts.push(describeNetwork(report));
        parts.push(cases.length
          ? `${cases.length} open case(s)${call.input.coach ? ` for ${call.input.coach}` : ''}, worst exposure first:\n\n` +
            cases.slice(0, 25).map((c) => describeCase(c).join('\n')).join('\n\n')
          : `No open cases${call.input.coach ? ` for ${call.input.coach}` : ''}.`);
        return { content: parts.filter(Boolean).join('\n\n') };
      }

      return { content: `Unknown tool ${call.name}.`, isError: true };
    } catch (err) {
      // Handed back as a tool error rather than thrown: Andy can say the
      // lookup failed and still answer from the library.
      return { content: `That lookup failed: ${err.message}`, isError: true };
    }
  }

  /**
   * Check every [#id] in the answer against the passages actually retrieved.
   *
   * An id Andy never saw is dropped from the text and reported. In practice
   * this fires rarely, and the one time it does is the time it matters.
   */
  verify(text, cited) {
    const seen = new Map();
    let invented = 0;

    const cleaned = String(text).replace(/\[#(\d+)\]/g, (match, raw) => {
      const id = Number(raw);
      const chunk = cited.get(id);
      if (!chunk) { invented++; return ''; }
      seen.set(id, chunk);
      return match;
    }).replace(/ +([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ');

    const citations = [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, chunk]) => ({
        id,
        title: chunk.title,
        heading: chunk.heading,
        page: chunk.page,
        folder: chunk.folder,
        link: chunk.link,
      }));

    return { text: cleaned.trim(), citations, invented, considered: cited.size };
  }
}

/** Keep the last N turns, and never start the window on an assistant reply. */
export function trimHistory(history, turns) {
  const kept = history.slice(-turns * 2);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}
