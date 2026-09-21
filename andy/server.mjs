#!/usr/bin/env node
// Andy, as a service.
//
//   GET  /                        the admin page — what Andy has read, and an ask box
//   GET  /status.json             corpus, retrieval mode, readiness, what failed to read
//   POST /upload                  files dragged onto the admin page, then ingest them
//   POST /sync                    pull the library in and reindex (?force=1 re-reads everything)
//   POST /reindex                 re-chunk and re-embed what is already downloaded
//   POST /ask                     { question } -> the answer and its sources
//   POST /discord/interactions    Discord's interactions endpoint (slash commands)
//   GET  /health
//
// Everything that changes state needs ANDY_TOKEN when it is set. The Discord
// endpoint is protected by Discord's own signature instead and has to stay open
// for Discord to reach it at all.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readiness } from './lib/config.mjs';
import { Knowledge } from './lib/retrieve.mjs';
import { Andy } from './lib/answer.mjs';
import { sync, reindex } from './lib/sync.mjs';
import { Conversations } from './lib/conversation.mjs';
import { Gateway } from './lib/gateway.mjs';
import { createMentionHandler } from './lib/mentions.mjs';
import { verifySignature } from './lib/discord.mjs';
import { parseMultipart, storeUploads, uploadStats } from './lib/upload.mjs';
import { acknowledge, fulfil, INTERACTION } from './lib/interactions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const PORT = Number(process.env.ANDY_PORT || process.env.PORT || 8901);
const TOKEN = process.env.ANDY_TOKEN || null;

const knowledge = new Knowledge(config);
const andy = new Andy(config, {});
const conversations = new Conversations(config.dataDir, { maxTurns: config.answer?.historyTurns ?? 8 });

const log = (line) => console.log(`[andy] ${line}`);
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); };

const authorised = (req, url) =>
  !TOKEN || req.headers.authorization === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;

// Generous, because this takes a whole folder of PDFs in one go. The browser
// sends them in batches, so this is a per-batch ceiling rather than a limit on
// how big the library can be.
const MAX_UPLOAD = 200 * 1024 * 1024;

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// One sync at a time. Two overlapping runs would fight over the index files and
// the loser would leave a corpus that half matches its vectors.
let syncing = null;
function runSync(options) {
  if (syncing) return syncing;
  syncing = (options.reindexOnly ? reindex(config, {}) : sync(config, options))
    .then((report) => { knowledge.load({ force: true }); log(`sync: ${JSON.stringify(report)}`); return report; })
    .finally(() => { syncing = null; });
  return syncing;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (route === '/health') {
      const status = knowledge.status();
      return json(res, 200, { ok: true, documents: status.documents, chunks: status.chunks, gateway: gateway?.ready ?? false });
    }

    if (route === '/status.json') {
      return json(res, 200, {
        ...knowledge.status(),
        readiness: readiness(config),
        creatorData: andy.data.enabled ? config.creatorHealth.baseUrl : null,
        gateway: gateway ? { enabled: true, ready: gateway.ready } : { enabled: false },
        uploads: uploadStats(config.uploadDir),
        syncing: Boolean(syncing),
        protected: Boolean(TOKEN),
      });
    }

    if (route === '/' || route === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'public', 'admin.html')));
    }

    if (req.method === 'POST' && route === '/upload') {
      if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
      const raw = await readBody(req, MAX_UPLOAD);
      const parts = parseMultipart(raw, req.headers['content-type']);
      if (!parts.length) return json(res, 400, { error: 'no files in the request' });

      const { written, rejected } = storeUploads(config.uploadDir, parts, {
        replaceAll: url.searchParams.get('replace') === '1',
      });
      log(`upload: ${written.length} file(s) stored${rejected.length ? `, ${rejected.length} rejected` : ''}`);

      // Ingesting on the same request is deliberate. A separate "now index it"
      // step is a step somebody forgets, and then Andy answers from a library
      // that does not contain the file they just watched upload.
      const report = url.searchParams.get('ingest') === '0' ? null : await runSync({});
      return json(res, 200, { stored: written.length, rejected, ...(report ?? {}) });
    }

    if (req.method === 'POST' && (route === '/sync' || route === '/reindex')) {
      if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
      const already = Boolean(syncing);
      const report = await runSync({ force: url.searchParams.get('force') === '1', reindexOnly: route === '/reindex' });
      return json(res, 200, { ...report, joinedRunningSync: already });
    }

    if (req.method === 'POST' && route === '/ask') {
      if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.question) return json(res, 400, { error: 'no question' });
      const result = await andy.ask(String(body.question), { asker: body.asker ?? null });
      return json(res, 200, {
        text: result.text,
        citations: result.citations,
        used: result.used,
        rounds: result.rounds,
        invented: result.invented ?? 0,
      });
    }

    if (req.method === 'POST' && route === '/discord/interactions') {
      const raw = await readBody(req);
      const ok = verifySignature(
        config.discord?.publicKey,
        req.headers['x-signature-ed25519'],
        req.headers['x-signature-timestamp'],
        raw,
      );
      // A bare 401 is what Discord requires before it will accept the endpoint.
      if (!ok) { res.writeHead(401); return res.end('invalid request signature'); }

      const interaction = JSON.parse(raw.toString('utf8'));
      const reply = acknowledge(interaction);
      json(res, 200, reply);

      // The work happens after the acknowledgement. Nothing here can reach the
      // client any more, so a failure has to be logged rather than thrown.
      if (interaction.type === INTERACTION.COMMAND) {
        fulfil(interaction, { andy, config, knowledge })
          .then((outcome) => log(`/${interaction.data?.name}: ${outcome.ok ? 'answered' : `failed — ${outcome.error}`}`))
          .catch((err) => log(`/${interaction.data?.name} crashed: ${err.message}`));
      }
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: err.message });
    log(`request failed after responding: ${err.message}`);
  }
});

// --- Discord Gateway ---------------------------------------------------------

let gateway = null;
if (config.discord?.gateway && config.discord?.botToken) {
  gateway = new Gateway({
    token: config.discord.botToken,
    allowedChannels: config.discord.allowedChannels ?? [],
    log,
    onMention: createMentionHandler({ andy, config, conversations, log }),
  }).start();
} else {
  log(config.discord?.botToken
    ? 'gateway disabled in config — slash commands only, no @mentions'
    : 'no DISCORD_BOT_TOKEN — Andy will not connect to Discord');
}

// --- keeping up with the folder ----------------------------------------------
//
// Files go into Drive constantly and nobody wants to remember a button
// afterwards, so Andy re-reads the folder on a short cycle. That is cheap on
// purpose: listing is one API call per thousand files, and only a file whose
// checksum moved is downloaded or re-embedded. A cycle that finds nothing new
// costs a single request.
//
// Driven off the last sync's timestamp rather than a wall-clock slot, because
// this service restarts on every deploy and a fixed slot would be skipped by
// any restart that happened to straddle it.
const syncEveryHours = config.knowledge?.syncEveryHours;
if (syncEveryHours != null) {
  const intervalMs = syncEveryHours * 3600 * 1000;
  const dueSince = () => {
    const last = knowledge.status().lastSync;
    return last ? Date.now() - Date.parse(last) : Infinity;
  };
  const maybeSync = (reason) => {
    const elapsed = dueSince();
    if (elapsed < intervalMs) return;
    log(`${reason} sync starting (last was ${elapsed === Infinity ? 'never' : `${Math.round(elapsed / 3600000)}h ago`})`);
    runSync({}).catch((err) => log(`${reason} sync failed: ${err.message}`));
  };

  // On boot too: a deploy should not leave the brain a cycle behind. The
  // elapsed-time check means a burst of redeploys does not re-sync each time.
  setTimeout(() => maybeSync('startup'), 10000).unref?.();
  const timer = setInterval(() => maybeSync('scheduled'), 10 * 60 * 1000);
  timer.unref?.();
  log(`watching the Drive folder every ${syncEveryHours}h`);
}

for (const check of readiness(config)) {
  if (!check.ok) log(`not ready: ${check.name} — ${check.detail}`);
}

server.listen(PORT, '0.0.0.0', () => {
  const status = knowledge.status();
  log(`listening on :${PORT} — ${status.documents} documents, ${status.chunks} passages, retrieval ${status.retrieval}`);
});

const shutdown = () => { gateway?.stop(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
