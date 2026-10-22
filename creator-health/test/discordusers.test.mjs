import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHandle, resolveDiscordId, mentionFor, guildOfChannel } from '../lib/discordusers.mjs';

const member = (username, { nick = null, global_name = null, id = '111' } = {}) =>
  ({ user: { id, username, global_name }, nick });
const reply = (members) => async () => ({ ok: true, status: 200, json: async () => members });

test('handles match through the decoration people add', () => {
  const same = ['ybwils', '@ybwils', 'YbWiLs', 'yb_wils', 'yb.wils', 'ᴛᴛᴠ ybwils'];
  for (const v of same) assert.equal(normaliseHandle(v), 'ybwils', v);
  assert.notEqual(normaliseHandle('ybwils'), normaliseHandle('ybwils2'));
});

test('an exact match on any of the three Discord names resolves', async () => {
  for (const m of [
    member('ybwils'),
    member('someoneelse', { global_name: 'YbWiLs' }),
    member('someoneelse', { nick: 'yb_wils' }),
  ]) {
    const out = await resolveDiscordId('ybwils', { guildId: 'g', token: 't', fetchImpl: reply([m]), cache: {} });
    assert.equal(out.id, '111', out.reason);
  }
});

test('a near miss is not a match', async () => {
  const out = await resolveDiscordId('ybwils', {
    guildId: 'g', token: 't', cache: {}, fetchImpl: reply([member('ybwilson'), member('ybwils_tv')]),
  });
  assert.equal(out.id, null);
  assert.match(out.reason, /no exact match/);
});

test('two people with the same name resolve to nobody', async () => {
  const out = await resolveDiscordId('ybwils', {
    guildId: 'g', token: 't', cache: {},
    fetchImpl: reply([member('ybwils', { id: '1' }), member('YbWils', { id: '2' })]),
  });
  assert.equal(out.id, null, 'pinging the wrong person is worse than pinging nobody');
  assert.match(out.reason, /2 members match/);
});

test('hits and misses are both cached, so a daily run is not a daily search', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, status: 200, json: async () => [] }; };
  const cache = {};
  await resolveDiscordId('ghost', { guildId: 'g', token: 't', cache, fetchImpl: counting });
  const second = await resolveDiscordId('ghost', { guildId: 'g', token: 't', cache, fetchImpl: counting });
  assert.equal(calls, 1, 'a miss should not be looked up twice');
  assert.ok(second.cached);
});

test('a network failure is not cached as a miss', async () => {
  const cache = {};
  const dead = async () => { throw new Error('ECONNRESET'); };
  const out = await resolveDiscordId('ybwils', { guildId: 'g', token: 't', cache, fetchImpl: dead });
  assert.equal(out.id, null);
  assert.match(out.reason, /network/);
  assert.deepEqual(cache, {}, 'the wifi dropping must not blacklist a creator forever');
});

test('no token means no ping, not a wrong ping', async () => {
  const out = await resolveDiscordId('ybwils', { cache: {} });
  assert.equal(out.id, null);
  assert.match(out.reason, /no bot token/);
});

test('the mention is a real ping when known and plain text when not', () => {
  assert.equal(mentionFor('ybwils', '123'), '<@123>');
  assert.equal(mentionFor('ybwils', null), '@ybwils');
  assert.equal(mentionFor('@ybwils', null), '@ybwils', 'no double @');
});

test('the guild id can be read off the channel', async () => {
  const out = await guildOfChannel('849787198420549642', {
    token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ guild_id: 'G9' }) }),
  });
  assert.equal(out, 'G9');
  assert.equal(await guildOfChannel('x', { token: null }), null);
});
