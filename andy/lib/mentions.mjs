// Answering a mention in a channel.
//
// Typing indicators matter more than they sound. Andy takes ten to thirty
// seconds on a real question, and without a visible "Andy is typing…" that
// silence reads as the bot being down — so people ask again, or give up. The
// indicator lasts ten seconds per call, so it is refreshed until the answer is
// ready.
import { Discord, answerMessages, errorMessage } from './discord.mjs';

const TYPING_REFRESH_MS = 8000;

export function createMentionHandler({ andy, config, conversations, log = () => {} }) {
  const discord = new Discord({ token: config.discord?.botToken, applicationId: config.discord?.applicationId });

  return async function handleMention(message) {
    const channelId = message.channel_id;
    // A Discord thread has its own channel id, so keying on it gives each
    // thread its own memory for free — two threads in the same channel are two
    // separate conversations, which is what someone starting a thread expects.
    const key = `discord:${channelId}`;
    const typing = keepTyping(discord, channelId);

    try {
      const result = await andy.ask(message.question, {
        history: conversations.get(key),
        asker: message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? null,
      });

      const parts = answerMessages(result);
      for (const [i, part] of parts.entries()) {
        await discord.postToChannel(channelId, {
          ...part,
          // Only the first part replies to the question; the rest follow it, or
          // Discord renders three separate reply headers for one answer.
          ...(i === 0 ? { message_reference: { message_id: message.id, fail_if_not_exists: false } } : {}),
        });
      }

      conversations.push(key, message.question, result.text);
      log(`answered in ${channelId}: ${result.citations.length} source(s), ${result.rounds} round(s)${result.invented ? `, ${result.invented} invented citation(s) dropped` : ''}`);
      return result;
    } catch (err) {
      log(`mention failed in ${channelId}: ${err.message}`);
      await discord.postToChannel(channelId, {
        ...errorMessage(`I couldn't answer that: ${err.message}`),
        message_reference: { message_id: message.id, fail_if_not_exists: false },
      }).catch(() => {});
      return null;
    } finally {
      typing.stop();
    }
  };
}

function keepTyping(discord, channelId) {
  // Typing is its own endpoint rather than a message post, so it does not go
  // through the message helper.
  const send = () => fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
    method: 'POST',
    headers: { authorization: `Bot ${discord.token}` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
  send();
  const timer = setInterval(send, TYPING_REFRESH_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
