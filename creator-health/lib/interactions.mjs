// Inbound Discord interactions: button clicks, modal submissions and slash
// commands.
//
// Discord signs every request with Ed25519 and requires a reply within three
// seconds. Both are handled here without a library — Node's crypto can verify
// the signature from the raw 32-byte public key Discord shows in the developer
// portal, and every handler below is local file IO, so the deadline is never
// close.
import crypto from 'node:crypto';
import { parseCustomId } from './discord.mjs';
import { CaseStore, acknowledge, recordAction, snooze, resolve, STATUS } from './cases.mjs';
import { PLAYBOOK } from './playbook.mjs';
import { Store } from './store.mjs';
import { computeMetrics } from './metrics.mjs';

// Discord's SPKI prefix for an Ed25519 key; prepending it turns the portal's
// raw hex into something crypto.createPublicKey accepts.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
export const RESPONSE = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
};
const EPHEMERAL = 64;

/**
 * Verify the Ed25519 signature on an interaction request.
 *
 * This must run against the raw request body, not a re-serialised copy: JSON
 * round-tripping reorders keys and the signature stops matching.
 */
export function verifySignature(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]),
      key,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

const who = (interaction) =>
  interaction.member?.user?.username ?? interaction.user?.username ?? 'someone';

const ephemeral = (content) => ({
  type: RESPONSE.MESSAGE,
  data: { content, flags: EPHEMERAL },
});

/** Rewrite the card's footer in place so its state is always visible. */
function updatedCard(interaction, caseRecord, { keepButtons = true } = {}) {
  const message = interaction.message ?? {};
  const embeds = (message.embeds ?? []).map((e, i) =>
    i === 0 ? { ...e, footer: { text: footerFor(caseRecord) } } : e);
  return {
    type: RESPONSE.UPDATE_MESSAGE,
    data: {
      embeds,
      components: keepButtons ? message.components ?? [] : [],
    },
  };
}

function footerFor(c) {
  const state = {
    [STATUS.OPEN]: '⏳ waiting to be picked up',
    [STATUS.ACKNOWLEDGED]: `🙋 picked up by ${c.acknowledgedBy}`,
    [STATUS.ACTIONED]: `✅ actioned — checking back ${c.followUpOn}`,
    [STATUS.SNOOZED]: `😴 snoozed until ${c.snoozedUntil}`,
    [STATUS.RESOLVED]: '🎉 resolved',
    [STATUS.LOST]: '⚪ creator left',
  }[c.status] ?? c.status;
  return `${c.id} · ${c.group ?? 'no group'} · ${state}`;
}

function actionModal(caseRecord) {
  const book = PLAYBOOK[caseRecord.playbookId] ?? PLAYBOOK.DIAMONDS_DOWN;
  return {
    type: RESPONSE.MODAL,
    data: {
      custom_id: `ch:actmodal:${caseRecord.id}`,
      title: `What did you do? — @${caseRecord.username}`.slice(0, 45),
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: 'note',
          label: 'What you did',
          style: 2,
          required: true,
          max_length: 500,
          placeholder: book.ask.slice(0, 100),
        }],
      }],
    },
  };
}

function snoozeModal(caseRecord) {
  return {
    type: RESPONSE.MODAL,
    data: {
      custom_id: `ch:snoozemodal:${caseRecord.id}`,
      title: `Known reason — @${caseRecord.username}`.slice(0, 45),
      components: [
        {
          type: 1,
          components: [{
            type: 4, custom_id: 'reason', label: 'Why this is expected', style: 2,
            required: true, max_length: 300,
            placeholder: 'On holiday / ill / exams / agreed break',
          }],
        },
        {
          type: 1,
          components: [{
            type: 4, custom_id: 'days', label: 'Quiet for how many days?', style: 1,
            required: false, max_length: 3, placeholder: '14',
          }],
        },
      ],
    },
  };
}

const fieldValue = (interaction, id) => {
  for (const row of interaction.data?.components ?? []) {
    for (const comp of row.components ?? []) if (comp.custom_id === id) return comp.value;
  }
  return null;
};

/**
 * Handle one verified interaction.
 *
 * `context` supplies the config and the current as-of date so handlers stay
 * pure of module-level state and can be driven directly from tests.
 */
export async function handleInteraction(interaction, context) {
  const { config } = context;

  if (interaction.type === INTERACTION.PING) return { type: RESPONSE.PONG };

  const store = new CaseStore(config.dataDir);
  const asOf = context.asOf ?? new Date().toISOString().slice(0, 10);
  const actor = who(interaction);

  if (interaction.type === INTERACTION.COMPONENT) {
    const parsed = parseCustomId(interaction.data?.custom_id);
    if (!parsed) return ephemeral('That button is from an older version of the bot.');
    const c = store.get(parsed.caseId);
    if (!c) return ephemeral(`Case \`${parsed.caseId}\` no longer exists.`);

    switch (parsed.action) {
      case 'ack': {
        if (c.status === STATUS.ACKNOWLEDGED || c.status === STATUS.ACTIONED) {
          return ephemeral(`Already picked up by ${c.acknowledgedBy}.`);
        }
        acknowledge(store, c.id, actor);
        return updatedCard(interaction, store.get(c.id));
      }
      case 'act':
        return actionModal(c);
      case 'snooze':
        return snoozeModal(c);
      case 'done': {
        resolve(store, c.id, actor, 'closed from Discord');
        return updatedCard(interaction, store.get(c.id), { keepButtons: false });
      }
      default:
        return ephemeral('Unknown action.');
    }
  }

  if (interaction.type === INTERACTION.MODAL_SUBMIT) {
    const [, kind, caseId] = String(interaction.data?.custom_id ?? '').split(':');
    const c = store.get(caseId);
    if (!c) return ephemeral(`Case \`${caseId}\` no longer exists.`);

    if (kind === 'actmodal') {
      const note = fieldValue(interaction, 'note') ?? '';
      const res = recordAction(store, caseId, actor, note, asOf);
      return {
        type: RESPONSE.UPDATE_MESSAGE,
        data: {
          embeds: (interaction.message?.embeds ?? []).map((e, i) =>
            i === 0
              ? {
                ...e,
                footer: { text: footerFor(store.get(caseId)) },
                fields: [...(e.fields ?? []), {
                  name: `📝 ${actor} logged`,
                  value: `${note}\n_Checking back on ${res.followUpOn}._`.slice(0, 1000),
                }],
              }
              : e),
          components: [],
        },
      };
    }

    if (kind === 'snoozemodal') {
      const reason = fieldValue(interaction, 'reason') ?? '';
      const days = Math.min(90, Math.max(1, Number(fieldValue(interaction, 'days')) || 14));
      snooze(store, caseId, actor, days, reason, asOf);
      return updatedCard(interaction, store.get(caseId), { keepButtons: false });
    }
    return ephemeral('Unknown form.');
  }

  if (interaction.type === INTERACTION.COMMAND) {
    return handleCommand(interaction, { ...context, store, asOf, actor });
  }

  return ephemeral('Unsupported interaction.');
}

// --- slash commands ----------------------------------------------------------

const optionValue = (interaction, name) =>
  (interaction.data?.options ?? []).find((o) => o.name === name)?.value ?? null;

async function handleCommand(interaction, context) {
  const { config, store, actor } = context;
  const name = interaction.data?.name;

  if (name === 'cases') {
    const mine = optionValue(interaction, 'coach') ?? null;
    const open = store.all()
      .filter((c) => [STATUS.OPEN, STATUS.ACKNOWLEDGED, STATUS.ACTIONED].includes(c.status))
      .filter((c) => !mine || c.coach === mine)
      .sort((a, b) => b.valueAtRisk - a.valueAtRisk)
      .slice(0, 15);
    if (!open.length) return ephemeral(mine ? `No open cases for ${mine}.` : 'No open cases. 🎉');
    const lines = open.map((c) => {
      const state = c.status === STATUS.OPEN ? '⏳' : c.status === STATUS.ACKNOWLEDGED ? '🙋' : '✅';
      return `${state} **@${c.username}** — ${PLAYBOOK[c.playbookId]?.title ?? c.playbookId}`
        + ` · since ${c.openedOn} · \`${c.id}\``;
    });
    return ephemeral(`**${open.length} open case${open.length === 1 ? '' : 's'}**\n${lines.join('\n')}`.slice(0, 1900));
  }

  if (name === 'creator') {
    const username = String(optionValue(interaction, 'username') ?? '').replace(/^@/, '').toLowerCase();
    const series = new Store(config.dataDir).readSeries();
    const creator = Object.values(series.creators).find((c) => c.username.toLowerCase() === username);
    if (!creator) return ephemeral(`No creator called \`${username}\` in the data.`);
    const m = computeMetrics(creator, series.lastAsOf);
    const open = store.all().filter((c) => c.creatorKey === creator.key
      && [STATUS.OPEN, STATUS.ACKNOWLEDGED, STATUS.ACTIONED].includes(c.status));
    const fmt = (x, d = 0) => (x == null ? '—' : Number(x.toFixed(d)).toLocaleString('en-GB'));
    return {
      type: RESPONSE.MESSAGE,
      data: {
        flags: EPHEMERAL,
        embeds: [{
          title: `@${creator.username}`,
          description: `${creator.group ?? 'no group'} · coach ${creator.coach ?? creator.manager ?? '—'}`
            + `${creator.quitOn ? `\n⚪ **Left the network on ${creator.quitOn}**` : ''}`,
          color: open.length ? 0xf76b15 : 0x30a46c,
          fields: [
            { name: 'Last 7 days', value: `${fmt(m.curr7.diamonds)} diamonds\n${fmt(m.curr7.liveHours, 1)}h LIVE\n${fmt(m.curr7.validLiveDays)} LIVE days`, inline: true },
            { name: 'Week before', value: `${fmt(m.prev7.diamonds)} diamonds\n${fmt(m.prev7.liveHours, 1)}h LIVE\n${fmt(m.prev7.validLiveDays)} LIVE days`, inline: true },
            { name: 'Rate', value: `${fmt(m.diamondsPerHour28)}/hour\n${m.darkStreak} days dark\n${fmt(m.fanClub.activeFans)} fan club`, inline: true },
            {
              name: open.length ? `Open cases (${open.length})` : 'Open cases',
              value: open.length
                ? open.map((c) => `\`${c.id}\` ${PLAYBOOK[c.playbookId]?.title} — ${c.status}`).join('\n')
                : 'None.',
            },
          ],
          footer: { text: `as of ${series.lastAsOf} · asked by ${actor}` },
        }],
      },
    };
  }

  return ephemeral('Unknown command.');
}

/** Definitions to register with Discord; see `cli.mjs discord-register`. */
export const COMMANDS = [
  {
    name: 'cases',
    description: 'Show the open creator cases',
    options: [{ name: 'coach', description: 'Filter to one coach (their manager email)', type: 3, required: false }],
  },
  {
    name: 'creator',
    description: 'Look up one creator\'s current numbers',
    options: [{ name: 'username', description: 'TikTok username, with or without the @', type: 3, required: true }],
  },
];
