import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, splitForDiscord, answerMessages, MESSAGE_LIMIT } from '../lib/discord.mjs';
import { acknowledge, INTERACTION, RESPONSE, COMMANDS } from '../lib/interactions.mjs';

/** A Discord-shaped Ed25519 keypair: the portal shows the raw 32-byte key as hex. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicHex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'),
    sign: (timestamp, body) =>
      crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex'),
  };
}

test('accepts a correctly signed request', () => {
  const { publicHex, sign } = keypair();
  const body = JSON.stringify({ type: 1 });
  const ts = '1750000000';
  assert.equal(verifySignature(publicHex, sign(ts, body), ts, Buffer.from(body)), true);
});

test('rejects a tampered body under a valid signature', () => {
  const { publicHex, sign } = keypair();
  const ts = '1750000000';
  const signature = sign(ts, JSON.stringify({ type: 1 }));
  const tampered = Buffer.from(JSON.stringify({ type: 2, data: { name: 'andy' } }));
  assert.equal(verifySignature(publicHex, signature, ts, tampered), false);
});

test('rejects a replayed signature under a different timestamp', () => {
  const { publicHex, sign } = keypair();
  const body = JSON.stringify({ type: 1 });
  assert.equal(verifySignature(publicHex, sign('1750000000', body), '1750000001', Buffer.from(body)), false);
});

test('rejects missing or malformed input instead of throwing', () => {
  const { publicHex } = keypair();
  assert.equal(verifySignature(publicHex, undefined, '1', 'x'), false);
  assert.equal(verifySignature(publicHex, 'not-hex', '1', 'x'), false);
  assert.equal(verifySignature('not-a-key', 'aa', '1', 'x'), false);
});

test('a PING is answered with a PONG', () => {
  assert.deepEqual(acknowledge({ type: INTERACTION.PING }), { type: RESPONSE.PONG });
});

test('a command defers, so Andy is not held to the three-second deadline', () => {
  const reply = acknowledge({ type: INTERACTION.COMMAND, data: { name: 'andy', options: [{ name: 'question', value: 'hi' }] } });
  assert.equal(reply.type, RESPONSE.DEFERRED_MESSAGE);
  assert.deepEqual(reply.data, {}, 'a public question should not be flagged ephemeral');
});

test('the private option makes the deferred answer ephemeral', () => {
  const reply = acknowledge({
    type: INTERACTION.COMMAND,
    data: { name: 'andy', options: [{ name: 'question', value: 'hi' }, { name: 'private', value: true }] },
  });
  assert.equal(reply.data.flags, 64);
});

test('every registered command fits what Discord accepts', () => {
  for (const command of COMMANDS) {
    assert.match(command.name, /^[a-z][a-z0-9-]{0,31}$/, `${command.name} is not a valid command name`);
    assert.ok(command.description.length <= 100, `${command.name} description is too long`);
    for (const option of command.options ?? []) {
      assert.ok(option.description.length <= 100, `${command.name}.${option.name} description is too long`);
    }
    // Discord rejects a command whose optional arguments precede required ones.
    const required = (command.options ?? []).map((o) => Boolean(o.required));
    assert.deepEqual(required, [...required].sort((a, b) => Number(b) - Number(a)),
      `${command.name} lists an optional argument before a required one`);
  }
});

test('a long answer splits on paragraphs, loses nothing, and fits the limit', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(30)}`.trim());
  const parts = splitForDiscord(paragraphs.join('\n\n'));
  assert.ok(parts.length > 1, 'this should have needed splitting');
  for (const part of parts) assert.ok(part.length <= MESSAGE_LIMIT, `a part is ${part.length} characters`);
  for (let i = 0; i < 40; i++) {
    assert.ok(parts.some((p) => p.includes(`Paragraph ${i}.`)), `paragraph ${i} was dropped`);
  }
});

test('a single paragraph longer than a whole message is still delivered whole', () => {
  const parts = splitForDiscord('x'.repeat(MESSAGE_LIMIT * 2 + 17));
  assert.equal(parts.join('').length, MESSAGE_LIMIT * 2 + 17);
  for (const part of parts) assert.ok(part.length <= MESSAGE_LIMIT);
});

test('sources ride on the last message, so they land under the whole answer', () => {
  const result = {
    text: `A. ${'word '.repeat(600)}\n\nB.`,
    citations: [{ id: 3, title: 'Gifting.pdf', heading: 'Goals', page: 4, link: 'https://drive/x' }],
    used: [{ tool: 'search_knowledge' }],
  };
  const messages = answerMessages(result);
  assert.ok(messages.length > 1);
  assert.equal(messages[0].embeds, undefined);
  assert.match(messages.at(-1).embeds[0].title, /Sources \(1\)/);
  assert.match(messages.at(-1).embeds[0].description, /Gifting\.pdf/);
});

test('a search that found nothing says so rather than showing an empty source list', () => {
  const messages = answerMessages({ text: 'No idea.', citations: [], used: [{ tool: 'search_knowledge' }] });
  assert.match(messages.at(-1).embeds[0].description, /library/i);
});

test('answers never ping anyone', () => {
  const messages = answerMessages({ text: 'Ask @everyone about <@1234>', citations: [], used: [] });
  assert.deepEqual(messages[0].allowed_mentions, { parse: [] });
});
