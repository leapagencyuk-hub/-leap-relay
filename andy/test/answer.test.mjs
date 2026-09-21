import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Andy, trimHistory } from '../lib/answer.mjs';
import { Corpus } from '../lib/store.mjs';
import { KeywordIndex } from '../lib/keyword.mjs';
import { indexableText } from '../lib/sync.mjs';

// A three-passage corpus, built here rather than committed, so the tests carry
// no binary fixture and cannot drift from the format the code writes.
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-answer-'));
  const corpus = new Corpus(dataDir);
  const chunks = [
    { id: 0, docId: 'd1', title: 'Gifting Playbook.pdf', folder: 'Gifting', link: 'https://drive/d1', heading: 'Goals', page: 3,
      text: 'Set a visible goal at the top of every stream so the room has a reason to gift now.' },
    { id: 1, docId: 'd1', title: 'Gifting Playbook.pdf', folder: 'Gifting', link: 'https://drive/d1', heading: 'Expensive gifts', page: 9,
      text: 'Pink Drift is worth 3600 diamonds and comes from fan club regulars.' },
    { id: 2, docId: 'd2', title: 'Schedules.pdf', folder: 'Schedules', link: 'https://drive/d2', heading: 'Slippage', page: 1,
      text: 'Fan club members drift away when a creator misses their usual days.' },
  ];
  corpus.writeChunks(chunks);
  corpus.writeDocuments({ d1: { name: 'Gifting Playbook.pdf', chunks: 2 }, d2: { name: 'Schedules.pdf', chunks: 1 } });
  corpus.writeMeta({ updatedAt: new Date().toISOString(), chunks: 3, documents: 2, dim: 0, model: null, embedded: 0 });
  fs.writeFileSync(path.join(dataDir, 'keyword.json'), JSON.stringify(KeywordIndex.build(chunks.map(indexableText)).toJSON()));
  return dataDir;
}

const CONFIG = {
  dataDir: fixture(),
  embeddings: { provider: 'none' },
  retrieval: { candidates: 20, passages: 3, rrfK: 60 },
  answer: { model: 'test', maxToolRounds: 3, historyTurns: 4 },
  creatorHealth: {},
};

/**
 * A stand-in for the Anthropic client: replays a scripted list of responses.
 *
 * Requests are snapshotted, not stored by reference. The live `messages` array
 * keeps growing after each call — which is what we want in production, since
 * the SDK serialises at call time — but it means a test holding the reference
 * would inspect a later turn than the one it thinks it is looking at.
 */
const scripted = (responses) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(structuredClone(request));
        const next = responses.shift();
        if (!next) throw new Error('script ran out of responses');
        return next;
      },
    },
  };
};

const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const toolUse = (name, input, id = 't1') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

test('answers without tools when nothing needs looking up', async () => {
  const client = scripted([text('Straight answer.')]);
  const andy = new Andy(CONFIG, { client });
  const result = await andy.ask('hello');
  assert.equal(result.text, 'Straight answer.');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.citations, []);
});

test('sends the brief and the tools, and caches the brief', async () => {
  const client = scripted([text('ok')]);
  await new Andy(CONFIG, { client }).ask('hello');
  const request = client.calls[0];
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
  assert.deepEqual(request.tools.map((t) => t.name).sort(), ['get_creator', 'list_cases', 'search_knowledge']);
  assert.equal(request.thinking.type, 'adaptive');
});

test('runs a search and returns every tool result in one user message', async () => {
  const client = scripted([toolUse('search_knowledge', { query: 'goals' }), text('Set a goal [#0].')]);
  const andy = new Andy(CONFIG, { client });
  const result = await andy.ask('how do goals work');

  const followUp = client.calls[1].messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.equal(followUp.content.length, 1);
  assert.equal(followUp.content[0].type, 'tool_result');
  assert.match(followUp.content[0].content, /\[#0\]/);

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].id, 0);
  assert.equal(result.used[0].tool, 'search_knowledge');
});

test('drops a citation Andy was never shown, and counts it', async () => {
  const client = scripted([toolUse('search_knowledge', { query: 'goals' }), text('Real [#0] and invented [#9999].')]);
  const result = await new Andy(CONFIG, { client }).ask('goals');
  assert.equal(result.invented, 1);
  assert.ok(!result.text.includes('9999'), 'the invented id must not survive into the answer');
  assert.ok(result.text.includes('[#0]'), 'the real id must survive');
  assert.equal(result.citations.length, 1);
});

test('a failed lookup is handed back as a tool error, not thrown', async () => {
  const client = scripted([toolUse('get_creator', { username: 'nobody' }), text('Could not check their numbers.')]);
  const result = await new Andy(CONFIG, { client }).ask('how is @nobody doing');
  assert.equal(result.used[0].ok, false);
  const followUp = client.calls[1].messages.at(-1);
  assert.equal(followUp.content[0].is_error, true);
});

test('a refusal comes back cleanly instead of crashing the parse', async () => {
  const client = scripted([{ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber' } }]);
  const result = await new Andy(CONFIG, { client }).ask('something disallowed');
  assert.equal(result.refused, true);
  assert.deepEqual(result.citations, []);
});

test('stops after maxToolRounds and still produces an answer', async () => {
  const client = scripted([
    toolUse('search_knowledge', { query: 'a' }, 'a'),
    toolUse('search_knowledge', { query: 'b' }, 'b'),
    toolUse('search_knowledge', { query: 'c' }, 'c'),
    text('Here is what I found.'),
  ]);
  const result = await new Andy(CONFIG, { client }).ask('loop forever');
  assert.equal(result.exhausted, true);
  assert.equal(result.rounds, 3);
  assert.equal(result.text, 'Here is what I found.');
});

test('history never starts on an assistant turn', () => {
  const history = [
    { role: 'user', content: 'one' }, { role: 'assistant', content: '1' },
    { role: 'user', content: 'two' }, { role: 'assistant', content: '2' },
  ];
  assert.equal(trimHistory(history, 1)[0].role, 'user');
  assert.equal(trimHistory(history, 10).length, 4);
});
