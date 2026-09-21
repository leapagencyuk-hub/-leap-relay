// Configuration, with secrets kept out of the file.
//
// Same convention as creator-health: any string written `env:VAR_NAME` is read
// from the environment at load time. That means config.json is safe to commit
// and a rotated key is a dashboard change rather than a deploy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/** `env:FOO` -> process.env.FOO (null when unset). Anything else passes through. */
export function resolveEnv(value) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('env:')) return value;
  const name = value.slice(4).trim();
  const found = process.env[name];
  return found === undefined || found === '' ? null : found;
}

/** Walk a config tree resolving `env:` references and dropping `_comment` keys. */
function resolveTree(node) {
  if (Array.isArray(node)) return node.map(resolveTree);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('_')) continue;   // documentation, not configuration
      out[key] = resolveTree(value);
    }
    return out;
  }
  return resolveEnv(node);
}

export function loadConfig(configPath = process.env.ANDY_CONFIG || path.join(ROOT, 'config.json')) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = resolveTree(raw);
  config.configPath = configPath;
  config.dataDir = path.resolve(path.dirname(configPath), config.dataDir ?? './data');
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config;
}

/**
 * What Andy can and cannot do right now, in the order the answer depends on it.
 *
 * Surfaced on the admin page and by `cli.mjs status`, because every one of these
 * fails silently otherwise: no Anthropic key means no answers, no Drive folder
 * means an empty brain, and no embeddings key quietly degrades retrieval to
 * keyword-only without anything looking broken.
 */
export function readiness(config) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('Anthropic API key', Boolean(process.env.ANTHROPIC_API_KEY),
    process.env.ANTHROPIC_API_KEY ? 'set' : 'ANTHROPIC_API_KEY is not set — Andy cannot answer anything');

  const provider = config.embeddings?.provider ?? 'none';
  if (provider === 'none') {
    add('Embeddings', true, 'off — retrieval is keyword-only, which misses paraphrased questions');
  } else {
    add('Embeddings', Boolean(config.embeddings?.apiKey),
      config.embeddings?.apiKey
        ? `${provider} · ${config.embeddings.model}`
        : `${provider} selected but its key is not set — retrieval falls back to keyword-only`);
  }

  add('Google Drive folder', Boolean(config.knowledge?.driveFolderId),
    config.knowledge?.driveFolderId ? 'set' : 'ANDY_DRIVE_FOLDER_ID is not set — nothing to sync');

  add('Drive service account', Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE),
    'share the Drive folder with the service account email, as Viewer');

  add('Discord bot token', Boolean(config.discord?.botToken),
    config.discord?.botToken ? 'set' : 'DISCORD_BOT_TOKEN is not set — Andy cannot post or answer in Discord');

  add('Discord interactions', Boolean(config.discord?.publicKey),
    config.discord?.publicKey ? 'set' : 'ANDY_DISCORD_PUBLIC_KEY is not set — slash commands will fail verification');

  add('Creator data', Boolean(config.creatorHealth?.baseUrl),
    config.creatorHealth?.baseUrl
      ? config.creatorHealth.baseUrl
      : 'CREATOR_HEALTH_URL is not set — Andy can advise from the library but not about a named creator');

  return checks;
}
