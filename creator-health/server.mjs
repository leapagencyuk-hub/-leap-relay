#!/usr/bin/env node
// The daily upload surface. Zero dependencies, so it runs anywhere Node runs —
// beside relay.mjs on the same Render service, or on its own.
//
//   GET  /                  the upload page — drop the day's export here
//   POST /upload            the day's .xlsx; ingests and runs in one go
//   GET  /report.json       full machine-readable result
//   GET  /report            the network summary as text
//   GET  /coach/:email      one coach's message
//   GET  /creator/:name     one creator's numbers
//   POST /notify            run today's analysis and push digests to webhooks
//   POST /run               the daily run: reconcile cases and post to Discord
//                           ?force=leaderboard,growth,overview,policy,activeness,summaries
//                           (or ?force=all) reposts today's once-a-day cards
//   POST /discord/interactions  Discord's interactions endpoint (button clicks)
//   GET  /cases             the open caseload
//   GET  /effectiveness     which interventions are working
//   GET  /selftest           what this service can reach
//                            ?post=1 sends a test line, ?sample=1 sends real cards
//   GET  /health
//
// Uploads and /notify require UPLOAD_TOKEN if it is set: send it as
// `Authorization: Bearer <token>` or `?token=`.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, ingestFile, analyse, buildDigests, renderNetworkSummary, toJson,
  runDaily, CaseStore, effectiveness, dataHealth,
} from './lib/pipeline.mjs';
import { loadRoutes, sendDigests } from './lib/notify.mjs';
import { Store } from './lib/store.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { isOpen } from './lib/cases.mjs';
import { verifySignature, handleInteraction } from './lib/interactions.mjs';
import { preflight } from './lib/dispatch.mjs';
import { redoToday, redoSummary } from './lib/redo.mjs';
import { isManageExport, readManualLeaps, importManualLeaps, importSummary } from './lib/leapedimport.mjs';
import { Discord, declineEmbed, activationEmbed } from './lib/discord.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CH_CONFIG || path.join(here, 'config.json');
const config = loadConfig(configPath);
// Render (and most hosts) assign the port and expect the service to bind to it.
const PORT = Number(process.env.CH_PORT || process.env.PORT || 8900);
const TOKEN = process.env.UPLOAD_TOKEN || null;
const MAX_UPLOAD = 25 * 1024 * 1024;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};
const text = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
};

function authorised(req, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Pull the file out of a multipart/form-data body.
 *
 * Written by hand rather than pulled in as a dependency: the payload here is
 * always a single file part, and the xlsx must survive byte for byte, so the
 * part is sliced out of the raw buffer rather than decoded as text.
 */
function extractMultipart(buf, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) return buf;
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const headerStart = start + boundary.length;
    const headerEnd = buf.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;
    const headers = buf.toString('utf8', headerStart, headerEnd);
    const next = buf.indexOf(boundary, headerEnd);
    if (/filename=/i.test(headers)) {
      const end = next === -1 ? buf.length : next - 2; // trim the trailing CRLF
      return buf.subarray(headerEnd + 4, end);
    }
    start = next;
  }
  return buf;
}

async function handleUpload(req, res, url) {
  if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 413, { error: err.message });
  }
  const contentType = req.headers['content-type'] ?? '';
  const fileBuf = contentType.includes('multipart/form-data') ? extractMultipart(body, contentType) : body;
  if (fileBuf.length < 4 || fileBuf[0] !== 0x50 || fileBuf[1] !== 0x4b) {
    return json(res, 400, { error: 'body is not an .xlsx file' });
  }

  const tmp = path.join(os.tmpdir(), `creator-upload-${Date.now()}.xlsx`);
  fs.writeFileSync(tmp, fileBuf);
  try {
    // Two different exports come off Backstage and they are easy to confuse.
    // Rather than make somebody pick the right button, work out which one this
    // is and do the right thing with it.
    if (isManageExport(tmp)) {
      const { exportedAt, marks, scanned } = readManualLeaps(tmp);
      const series = new Store(config.dataDir).readSeries();
      const store = new CaseStore(config.dataDir);
      const out = importManualLeaps({
        marks, creators: Object.values(series.creators), store, exportedAt,
      });
      store.save();
      return json(res, 200, {
        kind: 'manage',
        applied: true,
        exportedAt,
        scanned,
        marked: marks.length,
        added: out.added.length,
        corrected: out.corrected.length,
        correctedValue: out.corrected.reduce((n, r) => n + (r.wasCredited?.fee ?? 0), 0),
        kept: out.kept.length,
        firstImport: out.firstImport,
        already: out.already.length,
        unmatched: out.unmatched,
        message: importSummary(out),
      });
    }

    const result = ingestFile(tmp, config, { force: url.searchParams.get('force') === '1' });
    if (!result.applied) {
      return json(res, 200, { applied: false, asOf: result.asOf, reason: result.reason });
    }

    const payload = {
      applied: true,
      asOf: result.asOf,
      periodStart: result.snapshot.periodStart,
      activeCreators: result.snapshot.active.length,
      quitCreators: result.snapshot.quit.length,
    };

    // Upload is the whole job. Leaving the run as a second step means someone
    // has to remember it every day, and the day they forget is the day a
    // creator's slide goes unnoticed.
    if (url.searchParams.get('run') !== '0') {
      try {
        const run = await runDaily(config, configPath, { dryRun: url.searchParams.get('dry') === '1' });
        payload.run = {
          asOf: run.result.asOf,
          opened: run.changes.opened.length,
          followUps: run.changes.dueFollowUps.length,
          escalated: run.changes.escalated.length,
          closed: run.changes.autoResolved.length,
          cases: run.cases,
          delivered: run.delivery.sent.filter((x) => x.ok && !x.skipped).length,
          skipped: run.delivery.sent.filter((x) => x.ok && x.skipped).length,
          failures: run.delivery.sent.filter((x) => !x.ok).map((f) => `${f.label}: ${f.error}`),
          discordSkipped: run.delivery.skipped ?? null,
        };
      } catch (err) {
        // The file is safely stored either way; say which half failed.
        payload.run = { error: err.message };
      }
    }
    return json(res, 200, payload);
  } catch (err) {
    return json(res, 400, { error: err.message });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function handleNotify(req, res, url) {
  if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
  const dryRun = url.searchParams.get('dry') === '1';
  const result = analyse(config, { asOf: url.searchParams.get('as-of'), persist: !dryRun });
  const digests = buildDigests(result, config);
  const routes = loadRoutes(path.dirname(configPath));
  const sent = await sendDigests(digests, routes, {
    dryRun,
    summary: renderNetworkSummary({ ...result, config }),
  });
  return json(res, 200, { asOf: result.asOf, digests: digests.length, sent });
}

/**
 * Discord's interactions endpoint.
 *
 * Discord verifies the URL by sending a signed PING before it will save it, and
 * rejects the endpoint outright if an unsigned request is ever answered with
 * anything but 401 — so the signature check happens before the body is even
 * parsed, against the exact bytes received.
 */
async function handleDiscordInteractions(req, res) {
  const discord = loadRoutes(path.dirname(configPath)).discord;
  if (!discord.publicKey) return json(res, 503, { error: 'DISCORD_PUBLIC_KEY is not configured' });

  let raw;
  try {
    raw = await readBody(req, 1024 * 1024);
  } catch (err) {
    return json(res, 413, { error: err.message });
  }

  const ok = verifySignature(
    discord.publicKey,
    req.headers['x-signature-ed25519'],
    req.headers['x-signature-timestamp'],
    raw,
  );
  if (!ok) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('invalid request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'malformed interaction payload' });
  }

  try {
    // `followUp` edits the deferred reply once slow work finishes. Discord
    // wants an answer within three seconds and a redo takes longer, so the
    // handler defers and the result arrives here.
    const followUp = async (content) => {
      const app = interaction.application_id;
      const tok = interaction.token;
      if (!app || !tok) return;
      await fetch(`https://discord.com/api/v10/webhooks/${app}/${tok}/messages/@original`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, components: [] }),
      }).catch(() => {});
    };
    const reply = await handleInteraction(interaction, { config, configPath, followUp });
    return json(res, 200, reply);
  } catch (err) {
    // Never leave Discord waiting: an error here still gets a valid response,
    // or the coach sees "this interaction failed" with no explanation.
    return json(res, 200, {
      type: 4,
      data: { content: `Something went wrong handling that: ${err.message}`, flags: 64 },
    });
  }
}

/**
 * Say exactly what this running service can and cannot reach.
 *
 * When nothing arrives in Discord the question is always the same: is it the
 * config, the network, or did the pipeline simply have nothing to send? Reading
 * that off a deploy log is guesswork, so this answers it directly — and with
 * `?post=1` proves the last hop by actually sending a line.
 *
 * Webhook URLs are never echoed: a URL is a credential, and this endpoint
 * exists to be pasted into a chat when something is wrong.
 */
async function handleSelfTest(req, res, url) {
  if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
  const { discord } = loadRoutes(path.dirname(configPath));
  const check = preflight(discord);
  const store = new Store(config.dataDir);
  const series = store.readSeries();

  const teams = Object.values(discord.groups ?? {}).map((g) => ({
    team: g.label,
    destination: g.webhook ? 'webhook' : g.channelId ? 'channel' : 'NONE',
  }));

  const result = {
    config: {
      source: fs.existsSync(path.join(path.dirname(configPath), 'routes.json'))
        ? 'routes.json' : 'routes.deploy.json',
      enabled: discord.enabled,
      mode: discord.mode,
      routeBy: discord.routeBy,
      overview: discord.summaryWebhook ? 'set' : 'MISSING',
      escalation: discord.escalationWebhook || discord.escalationChannelId ? 'set' : 'not configured',
      inactive: discord.inactiveWebhook ? 'set' : 'not configured — activation cards go to the team channels',
      teamSummaries: Object.values(discord.teamSummaries ?? {}).filter((g) => g.webhook || g.channelId).length,
      activenessOverview: discord.activenessOverviewWebhook ? 'set' : 'MISSING',
      activenessPings: discord.activenessPingWebhook ? 'set' : 'MISSING',
      leaderboard: discord.leaderboardWebhook ? 'set' : 'MISSING',
      growthBoard: discord.growthBoardWebhook ? 'set' : 'MISSING',
      leaped: discord.leapedWebhook ? 'set' : 'MISSING',
      leapedOverview: discord.leapedOverviewWebhook ? 'set' : 'MISSING',
      teamsResolved: teams.filter((t) => t.destination !== 'NONE').length,
      teamsMissing: teams.filter((t) => t.destination === 'NONE').map((t) => t.team),
    },
    preflight: check,
    data: {
      snapshots: store.listSnapshotDates().length,
      lastAsOf: series.lastAsOf,
      openCases: new CaseStore(config.dataDir).all().filter(isOpen).length,
      lastOverviewOn: new CaseStore(config.dataDir).data.lastOverviewOn ?? null,
    },
  };

  // A real card, posted to the overview channel rather than to a coach.
  //
  // The point is to see exactly what a coach will get — layout, links, and
  // whether the avatar lookup actually works, which cannot be checked any other
  // way without posting into a team channel people are watching.
  if (url.searchParams.get('sample') === '1') {
    try {
      const analysis = analyse(config, { persist: false });
      const store2 = new CaseStore(config.dataDir);
      const open = store2.all().filter(isOpen)
        .sort((a, b) => (b.valueAtRisk ?? 0) - (a.valueAtRisk ?? 0));
      const decline = open.find((c) => c.kind === 'decline');
      const activation = open.find((c) => c.kind === 'activation');
      const client = new Discord({ token: discord.botToken });
      const route = discord.summaryWebhook
        ? { webhook: discord.summaryWebhook }
        : { channelId: discord.summaryChannelId };

      const posts = [];
      if (decline) {
        const alert = analysis.alerts.find((a) => a.creator.key === decline.creatorKey);
        if (alert) {
          posts.push(['decline', declineEmbed(decline, alert, {
            avatar: config.avatars,
            buttons: discord.mode === 'bot' && discord.interactionsReady !== false,
          })]);
        }
      }
      if (activation) {
        posts.push(['activation', activationEmbed(activation, {
          avatar: config.avatars,
          metrics: analysis.metricsByKey.get(activation.creatorKey),
          buttons: discord.mode === 'bot' && discord.interactionsReady !== false,
        })]);
      }

      result.sample = { posted: [], skipped: posts.length ? null : 'no open cases to render' };
      for (const [kind, payload] of posts) {
        payload.content = `**Sample ${kind} card** — this is what the team channel receives.`;
        const sent = route.webhook
          ? await client.postToWebhook(route.webhook, payload)
          : await client.postToChannel(route.channelId, payload);
        result.sample.posted.push({
          kind,
          creator: kind === 'decline' ? decline.username : activation.username,
          ok: sent.ok,
          // Discord resolves the avatar when it renders, so all we can report
          // is whether we asked for one.
          avatar: Boolean(payload.embeds[0].author?.icon_url),
          error: sent.error ?? null,
        });
      }
    } catch (err) {
      result.sample = { error: err.message };
    }
  }

  if (url.searchParams.get('post') === '1') {
    if (!discord.summaryWebhook) {
      result.testPost = { ok: false, error: 'no overview webhook configured' };
    } else {
      const client = new Discord({ token: discord.botToken });
      const sent = await client.postToWebhook(discord.summaryWebhook, {
        content: `Self-test from the monitoring service at ${new Date().toISOString()}. `
          + `${result.data.snapshots} export(s) held, ${result.data.openCases} open case(s).`,
      });
      result.testPost = { ok: sent.ok, status: sent.status ?? null, error: sent.error ?? null };
    }
  }
  return json(res, 200, result);
}

/**
 * Repost today, fresh.
 *
 * POST only, deliberately: this puts about twenty cards into fourteen channels
 * and a GET would let a link preview or a browser prefetch fire it.
 */
async function handleRedo(req, res, url) {
  if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
  const summary = await redoToday(config, configPath, { asOf: url.searchParams.get('as-of') });
  return json(res, 200, { ...summary, message: redoSummary(summary) });
}

async function handleRun(req, res, url) {
  if (!authorised(req, url)) return json(res, 401, { error: 'unauthorised' });
  const dryRun = url.searchParams.get('dry') === '1';
  const { result, changes, delivery, cases } = await runDaily(config, configPath, {
    asOf: url.searchParams.get('as-of'),
    dryRun,
    // The once-a-day guard is right for automatic runs and wrong when someone
    // has deliberately asked for a post again.
    forceSummary: url.searchParams.get('force-overview') === '1',
    // ?force=leaderboard,growth or ?force=all — reposts today's once-a-day
    // cards without waiting for tomorrow.
    force: (url.searchParams.get('force') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  });
  return json(res, 200, {
    asOf: result.asOf,
    dryRun,
    opened: changes.opened.length,
    worsened: changes.worsened.length,
    followUps: changes.dueFollowUps.length,
    escalated: changes.escalated.length,
    autoResolved: changes.autoResolved.length,
    cases,
    delivered: delivery.sent.length,
    failures: delivery.sent.filter((x) => !x.ok),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'POST' && route === '/upload') return await handleUpload(req, res, url);
    if (req.method === 'POST' && route === '/notify') return await handleNotify(req, res, url);
    if (req.method === 'POST' && route === '/run') return await handleRun(req, res, url);
    if (req.method === 'POST' && route === '/redo') return await handleRedo(req, res, url);
    if (route === '/selftest') return await handleSelfTest(req, res, url);  // GET or POST
    if (req.method === 'POST' && route === '/discord/interactions') {
      return await handleDiscordInteractions(req, res);
    }
    if (route === '/cases') {
      const store = new CaseStore(config.dataDir);
      const coach = url.searchParams.get('coach');
      const all = url.searchParams.get('all') === '1';
      return json(res, 200, {
        cases: store.all()
          .filter((c) => (all ? true : isOpen(c)))
          .filter((c) => !coach || c.coach === coach.toLowerCase())
          .sort((a, b) => b.valueAtRisk - a.valueAtRisk),
      });
    }
    if (route === '/effectiveness') {
      return json(res, 200, effectiveness(new CaseStore(config.dataDir)));
    }
    if (route === '/' || route === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'public', 'upload.html')));
    }
    if (route === '/status.json') {
      const health = dataHealth(config, new Store(config.dataDir).readSeries().lastAsOf);
      const store = new CaseStore(config.dataDir);
      return json(res, 200, {
        ...health,
        openCases: store.all().filter(isOpen).length,
        protected: Boolean(TOKEN),
      });
    }
    if (route === '/health') {
      // Liveness only, and deliberately nothing else. The host restarts a
      // service whose health check fails, so anything this depends on becomes
      // something that can get the service killed and keep it killed. Reading
      // the data directory made the check depend on a network disk that is
      // still mounting at the moment the first check arrives.
      //
      // How much data there is belongs on /status.json, which nobody restarts
      // anything over.
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }
    if (route === '/report.json') {
      const result = analyse(config, { asOf: url.searchParams.get('as-of'), persist: false });
      return json(res, 200, { ...toJson(result), digests: buildDigests(result, config) });
    }
    if (route === '/report') {
      const result = analyse(config, { asOf: url.searchParams.get('as-of'), persist: false });
      return text(res, 200, renderNetworkSummary({ ...result, config }));
    }
    if (route.startsWith('/coach/')) {
      const coach = decodeURIComponent(route.slice('/coach/'.length)).toLowerCase();
      const result = analyse(config, { asOf: url.searchParams.get('as-of'), persist: false });
      const d = buildDigests(result, config).find((x) => x.coach === coach);
      return text(res, 200, d ? d.text : `Nothing to send ${coach} today.`);
    }
    if (route.startsWith('/creator/')) {
      const name = decodeURIComponent(route.slice('/creator/'.length)).toLowerCase();
      const store = new Store(config.dataDir);
      const series = store.readSeries();
      const c = Object.values(series.creators).find(
        (x) => x.username.toLowerCase() === name || x.creatorId === name);
      if (!c) return json(res, 404, { error: 'creator not found' });
      const asOf = url.searchParams.get('as-of') ?? series.lastAsOf;
      return json(res, 200, { creator: { ...c, obs: c.obs.slice(-30) }, metrics: computeMetrics(c, asOf) });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

/**
 * A daily safety net.
 *
 * Uploading runs the pipeline, which covers the normal day. But follow-up
 * verdicts and escalations are keyed on dates, so a day with no upload would
 * leave them waiting - and the overview would go quiet without saying why.
 * This runs once a day regardless, and the once-a-day guard means an upload
 * later the same day does not post a second overview.
 */
function startDailySchedule() {
  const hour = Number(process.env.CH_DAILY_HOUR ?? 9);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  let lastRunOn = null;

  const tick = async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (lastRunOn === today || now.getUTCHours() < hour) return;
    lastRunOn = today;
    try {
      const run = await runDaily(config, configPath, {});
      const sent = run.delivery.sent.filter((x) => x.ok && !x.skipped).length;
      console.log(`[daily ${today}] opened ${run.changes.opened.length}, follow-ups ${run.changes.dueFollowUps.length}, sent ${sent}`);
    } catch (err) {
      // Never take the service down over a scheduled run. A fresh install with
      // nothing uploaded yet is expected, not an error.
      const expected = /no snapshots ingested/.test(err.message);
      console[expected ? 'log' : 'error'](`[daily ${today}] ${expected ? 'nothing to do yet' : `failed: ${err.message}`}`);
    }
  };

  // Not immediately. Scoring 820 creators blocks the event loop for over a
  // second, and the rest of the run then posts twenty cards and reads as many
  // channels. Doing that in the same breath as binding the port means the
  // host's first health check lands on a busy process, and a host that decides
  // a service is unhealthy restarts it — which starts the whole thing again.
  // Nothing here is urgent to the second: the schedule is a safety net for a
  // day nobody uploaded.
  const settle = Number(process.env.CH_BOOT_DELAY_MS ?? 30000);
  setTimeout(() => { tick().catch((err) => console.error(`[daily] ${err.message}`)); }, settle).unref?.();
  return setInterval(() => {
    tick().catch((err) => console.error(`[daily] ${err.message}`));
  }, 10 * 60 * 1000).unref?.() ?? null;
}

// A long-running service must not die of something it could have logged. Node
// treats an unhandled rejection as fatal, so one stray promise anywhere - a
// Discord call, a webhook, a background write - would take the whole thing down
// and leave a bad gateway with no explanation. Log it and keep serving; a
// broken card is better than a dead service, and the log says which.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err?.stack ?? err);
});

/**
 * Say enough at boot that a log answers "why is it down" without a second
 * deploy. Every line is wrapped: a diagnostic that throws is worse than no
 * diagnostic, because it takes the service with it.
 */
function bootReport() {
  const line = (label, get) => {
    let value;
    try { value = get(); } catch (err) { value = `unavailable (${err.code ?? err.message})`; }
    console.log(`  ${label.padEnd(14)} ${value}`);
  };
  console.log('boot:');
  line('node', () => process.version);
  line('data dir', () => config.dataDir);
  line('writable', () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, '.writetest');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return 'yes';
  });
  line('snapshots', () => new Store(config.dataDir).listSnapshotDates().length);
  line('discord', () => {
    const d = loadRoutes(path.dirname(configPath)).discord;
    const check = preflight(d);
    return `${check.ok ? 'routed' : `NOT ROUTED — ${check.reason}`}${d.botToken ? ', bot token set' : ', no bot token'}`;
  });
  line('token', () => (TOKEN ? 'set' : 'NOT SET — /upload and /redo are open'));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`creator-health listening on :${PORT}  (data: ${config.dataDir})`);
  bootReport();
  startDailySchedule();
  console.log(`daily safety-net run at ${process.env.CH_DAILY_HOUR ?? 9}:00 UTC`
    + ` (first check ${Math.round(Number(process.env.CH_BOOT_DELAY_MS ?? 30000) / 1000)}s after boot)`);
});
