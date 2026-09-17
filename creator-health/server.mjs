#!/usr/bin/env node
// The daily upload surface. Zero dependencies, so it runs anywhere Node runs —
// beside relay.mjs on the same Render service, or on its own.
//
//   POST /upload            the day's .xlsx (raw body, or a multipart form field)
//   GET  /report.json       full machine-readable result
//   GET  /report            the network summary as text
//   GET  /coach/:email      one coach's message
//   GET  /creator/:name     one creator's numbers
//   POST /notify            run today's analysis and push digests to webhooks
//   GET  /health
//
// Uploads and /notify require UPLOAD_TOKEN if it is set: send it as
// `Authorization: Bearer <token>` or `?token=`.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ingestFile, analyse, buildDigests, renderNetworkSummary, toJson } from './lib/pipeline.mjs';
import { loadRoutes, sendDigests } from './lib/notify.mjs';
import { Store } from './lib/store.mjs';
import { computeMetrics } from './lib/metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CH_CONFIG || path.join(here, 'config.json');
const config = loadConfig(configPath);
const PORT = Number(process.env.CH_PORT || 8900);
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
    const result = ingestFile(tmp, config, { force: url.searchParams.get('force') === '1' });
    if (!result.applied) return json(res, 200, { applied: false, asOf: result.asOf, reason: result.reason });
    return json(res, 200, {
      applied: true,
      asOf: result.asOf,
      periodStart: result.snapshot.periodStart,
      activeCreators: result.snapshot.active.length,
      quitCreators: result.snapshot.quit.length,
    });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'POST' && route === '/upload') return await handleUpload(req, res, url);
    if (req.method === 'POST' && route === '/notify') return await handleNotify(req, res, url);
    if (route === '/health') {
      const store = new Store(config.dataDir);
      const dates = store.listSnapshotDates();
      return json(res, 200, { ok: true, snapshots: dates.length, latest: dates.at(-1) ?? null });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`creator-health listening on :${PORT}  (data: ${config.dataDir})`);
  if (!TOKEN) console.log('warning: UPLOAD_TOKEN is not set — /upload and /notify are open');
});
