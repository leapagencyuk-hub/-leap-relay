// A live check of everything Andy depends on.
//
// `status` reads the config; this actually calls each service. The difference
// matters during setup: a service account key can be present and perfectly
// well-formed while the folder has never been shared with it, and Google
// reports that as a 404 that reads like a typo.
//
// Every failure here has to answer "what do I do about it", not just "what
// went wrong".
import { Drive, readServiceAccount } from './drive.mjs';
import { Embedder } from './embed.mjs';
import { CreatorData } from './creator.mjs';
import { Discord } from './discord.mjs';

const ok = (name, detail, extra = {}) => ({ name, ok: true, detail, ...extra });
const bad = (name, detail, fix = null) => ({ name, ok: false, detail, fix });
const skip = (name, detail) => ({ name, ok: null, detail });

export async function doctor(config) {
  const checks = [];

  // --- Anthropic ------------------------------------------------------------
  if (!process.env.ANTHROPIC_API_KEY) {
    checks.push(bad('Anthropic', 'ANTHROPIC_API_KEY is not set', 'Andy cannot answer anything without it.'));
  } else {
    try {
      const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/models`, {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15000),
      });
      checks.push(res.ok
        ? ok('Anthropic', `key works · answering with ${config.answer?.model}`)
        : bad('Anthropic', `the API rejected the key (HTTP ${res.status})`, 'Check ANTHROPIC_API_KEY.'));
    } catch (err) {
      checks.push(bad('Anthropic', `could not reach the API: ${err.message}`));
    }
  }

  // --- Google Drive ---------------------------------------------------------
  const folderId = config.knowledge?.driveFolderId;
  let account = null;
  try {
    account = readServiceAccount();
  } catch (err) {
    checks.push(bad('Drive service account', `the key is set but unreadable: ${err.message}`,
      'GOOGLE_SERVICE_ACCOUNT_JSON must be the whole downloaded JSON file, raw or base64.'));
  }

  if (!account && !checks.some((c) => c.name === 'Drive service account')) {
    checks.push(bad('Drive service account', 'GOOGLE_SERVICE_ACCOUNT_JSON is not set',
      'Create a service account in Google Cloud, download its JSON key, and put the file contents in this variable.'));
  } else if (account) {
    checks.push(ok('Drive service account', account.client_email, { email: account.client_email }));

    if (!folderId) {
      checks.push(bad('Drive folder', 'no folder configured'));
    } else {
      const drive = new Drive(account);
      try {
        const result = await drive.checkFolder(folderId);
        if (!result.ok) {
          checks.push(bad('Drive folder', result.reason,
            `Open the folder in Drive, press Share, and add ${account.client_email} as a Viewer.`));
        } else {
          checks.push(ok('Drive folder', `"${result.name}" is shared with Andy`));

          // Listing is the only check that proves the whole path works, and it
          // also answers the question everyone asks next: how much is in there?
          const files = await drive.listFolder(folderId);
          const usable = files.filter((f) => Drive.isSupported(f.mimeType, f.name));
          const unusable = files.filter((f) => !Drive.isSupported(f.mimeType, f.name));
          const byKind = {};
          for (const f of usable) {
            const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'google doc').toLowerCase();
            byKind[ext] = (byKind[ext] ?? 0) + 1;
          }
          const mb = files.reduce((sum, f) => sum + (f.size ?? 0), 0) / 1048576;
          checks.push(ok('Drive contents',
            `${usable.length} readable file(s), ${mb.toFixed(0)} MB · ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')}`,
            { files: usable.length, skipped: unusable.length, megabytes: Math.round(mb), byKind }));
          const scans = config.knowledge?.readScans;
          checks.push(scans?.enabled
            ? ok('Reading scans', `on · ${scans.model} · up to ${scans.maxPages} pages a document. This is the only part of ingest that costs money per page.`)
            : skip('Reading scans', 'off — a PDF with no text layer will be reported as unreadable rather than read. Turn on knowledge.readScans if the library has scanned decks.'));
          if (unusable.length) {
            checks.push(skip('Drive — not readable',
              `${unusable.length} file(s) Andy will skip (images, video, and anything else with no text): ${unusable.slice(0, 5).map((f) => f.name).join(', ')}${unusable.length > 5 ? '…' : ''}`));
          }
        }
      } catch (err) {
        checks.push(bad('Drive folder', err.message));
      }
    }
  }

  // --- Embeddings -----------------------------------------------------------
  const embedder = new Embedder(config.embeddings);
  if (!embedder.enabled) {
    checks.push(skip('Embeddings',
      `off — retrieval is keyword-only, which misses paraphrased questions. Set ${config.embeddings?.provider === 'openai' ? 'OPENAI_API_KEY' : 'VOYAGE_API_KEY'} to turn it on.`));
  } else {
    try {
      const [vector] = await embedder.embed(['a test passage about gifting'], { kind: 'document' });
      checks.push(ok('Embeddings', `${embedder.label} · ${vector.length} dimensions`));
    } catch (err) {
      checks.push(bad('Embeddings', err.message, 'Retrieval falls back to keyword-only until this works.'));
    }
  }

  // --- creator-health -------------------------------------------------------
  const data = new CreatorData(config.creatorHealth);
  if (!data.enabled) {
    checks.push(bad('Creator data', 'CREATOR_HEALTH_URL is not set',
      'Andy can advise from the library but cannot look up a named creator\'s numbers.'));
  } else {
    try {
      const health = await data.health();
      checks.push(health?.ok
        ? ok('Creator data', `connected · ${health.snapshots} snapshot(s), latest ${health.latest ?? 'none yet'}`)
        : bad('Creator data', 'the service answered, but not with a healthy response'));
    } catch (err) {
      checks.push(bad('Creator data', err.message,
        'Check CREATOR_HEALTH_URL and that UPLOAD_TOKEN matches the one creator-health uses.'));
    }
  }

  // --- Discord --------------------------------------------------------------
  if (!config.discord?.botToken) {
    checks.push(bad('Discord', 'DISCORD_BOT_TOKEN is not set', 'Andy will not appear in Discord at all.'));
  } else {
    const discord = new Discord({ token: config.discord.botToken, applicationId: config.discord.applicationId });
    const me = await discord.me();
    checks.push(me.ok
      ? ok('Discord', `connected as ${me.body.username}`)
      : bad('Discord', `the token was rejected (${me.status ?? me.error})`, 'Reset the bot token in the Discord developer portal.'));
    checks.push(config.discord.publicKey
      ? ok('Discord interactions', 'public key set — slash commands can be verified')
      : bad('Discord interactions', 'ANDY_DISCORD_PUBLIC_KEY is not set',
        'Slash commands will fail signature verification. @mentions still work.'));
  }

  return checks;
}
