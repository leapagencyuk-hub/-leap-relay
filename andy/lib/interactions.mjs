// Slash commands.
//
// Discord gives an interaction three seconds to be acknowledged, and Andy takes
// longer than that on purpose — it searches, it reads a creator's numbers, it
// thinks. So every command defers immediately and the real answer arrives as a
// follow-up. The deferred token is good for fifteen minutes, which is far more
// headroom than any question needs.
import { Discord, answerMessages, errorMessage } from './discord.mjs';

export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
export const RESPONSE = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, MODAL: 9 };
const EPHEMERAL = 64;

export const COMMANDS = [
  {
    name: 'andy',
    description: 'Ask Andy anything about coaching a TikTok LIVE creator',
    options: [
      { name: 'question', description: 'What do you want to know?', type: 3, required: true },
      { name: 'private', description: 'Answer only to you (default: everyone in the channel can see it)', type: 5, required: false },
    ],
  },
  {
    name: 'andy-creator',
    description: 'Ask Andy what to do about one creator, using their live numbers',
    options: [
      { name: 'username', description: 'TikTok username, with or without the @', type: 3, required: true },
      { name: 'question', description: 'Optional: something specific you want to know about them', type: 3, required: false },
      { name: 'private', description: 'Answer only to you', type: 5, required: false },
    ],
  },
  {
    name: 'andy-status',
    description: 'What Andy has read, and what it is missing',
    options: [],
  },
];

const option = (interaction, name) =>
  interaction.data?.options?.find((o) => o.name === name)?.value;

const asker = (interaction) =>
  interaction.member?.nick
  ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username
  ?? interaction.user?.global_name ?? interaction.user?.username
  ?? 'A coach';

/**
 * Decide the immediate reply. Runs inside the three-second window, so it does
 * no work beyond reading the payload.
 */
export function acknowledge(interaction) {
  if (interaction.type === INTERACTION.PING) return { type: RESPONSE.PONG };
  if (interaction.type !== INTERACTION.COMMAND) return { type: RESPONSE.MESSAGE, data: { content: 'I don\'t know what that was.', flags: EPHEMERAL } };

  const name = interaction.data?.name;
  if (name === 'andy-status') return { type: RESPONSE.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };

  const priv = option(interaction, 'private') === true;
  return { type: RESPONSE.DEFERRED_MESSAGE, data: priv ? { flags: EPHEMERAL } : {} };
}

/**
 * Do the work and deliver it, after the acknowledgement has already gone back.
 *
 * Never throws: an interaction that fails silently leaves the coach staring at
 * "Andy is thinking…" forever, which is worse than an error they can read.
 */
export async function fulfil(interaction, { andy, config, knowledge = null }) {
  const discord = new Discord({ token: config.discord?.botToken, applicationId: config.discord?.applicationId });
  const priv = option(interaction, 'private') === true;
  const flags = priv || interaction.data?.name === 'andy-status' ? EPHEMERAL : 0;

  try {
    if (interaction.data?.name === 'andy-status') {
      return await discord.editOriginal(interaction.token, statusMessage(knowledge ?? andy.knowledge, andy, config));
    }

    const question = buildQuestion(interaction);
    if (!question) {
      return await discord.editOriginal(interaction.token, errorMessage('I need a question.'));
    }

    const result = await andy.ask(question, { asker: asker(interaction) });
    const messages = answerMessages(result);

    // The first part edits the placeholder; any overflow follows it, so a long
    // answer reads as one reply rather than arriving out of order.
    await discord.editOriginal(interaction.token, { ...messages[0], flags: flags || undefined });
    for (const extra of messages.slice(1)) {
      await discord.followUp(interaction.token, { ...extra, flags: flags || undefined });
    }
    return { ok: true, result };
  } catch (err) {
    await discord.editOriginal(interaction.token, errorMessage(`Something went wrong: ${err.message}`)).catch(() => {});
    return { ok: false, error: err.message };
  }
}

function buildQuestion(interaction) {
  if (interaction.data?.name === 'andy') return String(option(interaction, 'question') ?? '').trim();
  if (interaction.data?.name === 'andy-creator') {
    const username = String(option(interaction, 'username') ?? '').replace(/^@/, '').trim();
    if (!username) return null;
    const extra = String(option(interaction, 'question') ?? '').trim();
    return extra
      ? `About the creator @${username}: ${extra}`
      : `@${username} — how are they doing, what is going wrong, and what should their coach do about it?`;
  }
  return null;
}

export function statusMessage(knowledge, andy, config) {
  const status = knowledge.status();
  const lines = [
    `**${status.documents.toLocaleString('en-GB')}** documents · **${status.chunks.toLocaleString('en-GB')}** passages`,
    `Retrieval: ${status.retrieval} · embeddings ${status.embeddings}`,
    `Creator data: ${andy.data.enabled ? `connected (${config.creatorHealth.baseUrl})` : '**not connected** — I cannot look up a creator\'s numbers'}`,
    `Last sync: ${status.lastSync ? status.lastSync.slice(0, 16).replace('T', ' ') + ' UTC' : '**never**'}`,
  ];
  if (status.vectorsMatchChunks === false) {
    lines.push('⚠️ The vector index does not match the passages — run a sync, or I am searching yesterday\'s corpus.');
  }
  if (status.failed?.length) {
    lines.push('', `**${status.failed.length} file(s) I could not read:**`);
    for (const f of status.failed.slice(0, 8)) lines.push(`• ${f.name} — ${f.error}`);
    if (status.failed.length > 8) lines.push(`…and ${status.failed.length - 8} more`);
  }
  return { content: lines.join('\n').slice(0, 2000), flags: EPHEMERAL };
}
