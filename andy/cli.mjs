#!/usr/bin/env node
// Andy from the terminal.
//
//   node cli.mjs ingest <folder>    read a folder on this machine — no Google account needed
//   node cli.mjs sync [--force]     pull the Drive folder in and reindex
//   node cli.mjs reindex            re-chunk and re-embed what is already downloaded
//   node cli.mjs ask "question"     ask Andy, print the answer and its sources
//   node cli.mjs search "query"     just the passages, no model call — for checking retrieval
//   node cli.mjs status             what Andy has read, and what it is missing
//   node cli.mjs doctor             live-check every connection and say how to fix each one
//   node cli.mjs docs               every document, with its chunk count and any error
//   node cli.mjs register [guildId] publish the slash commands
//   node cli.mjs whoami             check the bot token reaches Discord
import { loadConfig, readiness } from './lib/config.mjs';
import { Knowledge } from './lib/retrieve.mjs';
import { Andy } from './lib/answer.mjs';
import { sync, reindex } from './lib/sync.mjs';
import { Discord } from './lib/discord.mjs';
import { COMMANDS } from './lib/interactions.mjs';
import { doctor } from './lib/doctor.mjs';

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const config = loadConfig();

const n = (x) => Number(x ?? 0).toLocaleString('en-GB');

const progress = ({ phase, message, done, total }) => {
  const suffix = total ? ` (${done}/${total})` : '';
  process.stderr.write(`\r\u001b[K${phase}: ${message}${suffix}`);
};

async function main() {
  switch (command) {
    case 'ingest':
    case 'sync':
    case 'reindex': {
      if (command === 'ingest' && !args[0]) {
        return fail('usage: cli.mjs ingest "/path/to/Andy\'s Brain"');
      }
      const report = command === 'reindex'
        ? await reindex(config, { onProgress: progress })
        : await sync(config, {
          folder: command === 'ingest' ? args[0] : null,
          force: flags.has('--force'),
          onProgress: progress,
        });
      process.stderr.write('\r\u001b[K');
      console.log(JSON.stringify(report, null, 2));
      if (report.skipped) {
        console.log(`\n${report.skipped} file(s) skipped — Andy has no way to read them (images, video, and anything else with no text).`);
      }
      if (report.failed?.length) {
        console.log(`\n${report.failed.length} file(s) could not be read:`);
        for (const f of report.failed) console.log(`  ${f.name} — ${f.error}`);
      }
      return;
    }

    case 'ask': {
      const question = args.join(' ');
      if (!question) return fail('usage: cli.mjs ask "your question"');
      const result = await new Andy(config, {}).ask(question);
      console.log(`\n${result.text}\n`);
      if (result.citations.length) {
        console.log('Sources');
        for (const c of result.citations) {
          console.log(`  [#${c.id}] ${c.title}${c.heading ? ` · ${c.heading}` : ''}${c.page > 1 ? ` · p${c.page}` : ''}`);
        }
      }
      console.log(`\n${result.rounds} round(s), ${result.considered ?? 0} passage(s) considered${result.invented ? `, ${result.invented} invented citation(s) dropped` : ''}`);
      return;
    }

    case 'search': {
      const query = args.join(' ');
      if (!query) return fail('usage: cli.mjs search "your query"');
      const results = await new Knowledge(config).search(query);
      if (!results.length) return console.log('Nothing matched.');
      for (const { chunk, score, from } of results) {
        console.log(`\n[#${chunk.id}] ${chunk.title}${chunk.heading ? ` · ${chunk.heading}` : ''}${chunk.page > 1 ? ` · p${chunk.page}` : ''}  (${from.join('+')}, ${score.toFixed(4)})`);
        console.log(`   ${chunk.text.slice(0, 220).replace(/\n/g, ' ')}…`);
      }
      return;
    }

    case 'status': {
      const status = new Knowledge(config).status();
      console.log(`Documents     ${n(status.documents)}`);
      console.log(`Passages      ${n(status.chunks)}`);
      console.log(`Retrieval     ${status.retrieval}`);
      console.log(`Embeddings    ${status.embeddings}${status.embedded ? ` · ${n(status.embedded)} vectors, ${status.dim}d` : ''}`);
      console.log(`Last sync     ${status.lastSync ?? 'never'}`);
      if (status.vectorsMatchChunks === false) {
        console.log('\nWARNING: the vector index does not match the passages — run `sync` before trusting an answer.');
      }
      console.log('\nReadiness');
      for (const check of readiness(config)) console.log(`  ${check.ok ? 'ok  ' : 'MISS'} ${check.name} — ${check.detail}`);
      if (status.failed?.length) {
        console.log(`\n${status.failed.length} file(s) Andy could not read:`);
        for (const f of status.failed) console.log(`  ${f.name} — ${f.error}`);
      }
      return;
    }

    case 'docs': {
      const documents = Object.values(new Knowledge(config).corpus.readDocuments());
      documents.sort((a, b) => (b.chunks ?? 0) - (a.chunks ?? 0));
      console.log('chunks  kind        folder / name');
      for (const d of documents) {
        const where = [d.folder, d.name].filter(Boolean).join(' / ');
        console.log(`${String(d.chunks ?? 0).padStart(6)}  ${String(d.kind ?? '').padEnd(10)}  ${where}${d.error ? `   ✗ ${d.error}` : ''}`);
      }
      console.log(`\n${documents.length} document(s), ${n(documents.reduce((s, d) => s + (d.chunks ?? 0), 0))} passages`);
      return;
    }

    case 'doctor': {
      console.log('Checking everything Andy depends on…\n');
      const checks = await doctor(config);
      for (const check of checks) {
        const mark = check.ok === true ? ' ok ' : check.ok === false ? 'FAIL' : ' -- ';
        console.log(`${mark}  ${check.name.padEnd(22)} ${check.detail}`);
        if (check.fix) console.log(`        ${' '.repeat(22)} → ${check.fix}`);
      }
      const failed = checks.filter((c) => c.ok === false);
      console.log(failed.length
        ? `\n${failed.length} thing(s) need fixing before Andy works properly.`
        : '\nEverything Andy needs is connected.');
      if (failed.length) process.exitCode = 1;
      return;
    }

    case 'register': {
      const discord = new Discord({ token: config.discord?.botToken, applicationId: config.discord?.applicationId });
      if (!discord.token || !discord.applicationId) return fail('DISCORD_BOT_TOKEN and ANDY_DISCORD_APP_ID must both be set');
      // A guild-scoped registration appears immediately; global takes up to an
      // hour, which is a long time to wonder whether it worked.
      const guildId = args[0] ?? null;
      const result = await discord.registerCommands(guildId, COMMANDS);
      if (!result.ok) return fail(`registration failed: ${result.error ?? result.status}`);
      console.log(`Registered ${result.body.length} command(s)${guildId ? ` in guild ${guildId} — live now` : ' globally — allow up to an hour to appear'}:`);
      for (const c of result.body) console.log(`  /${c.name} — ${c.description}`);
      return;
    }

    case 'whoami': {
      const discord = new Discord({ token: config.discord?.botToken, applicationId: config.discord?.applicationId });
      if (!discord.token) return fail('DISCORD_BOT_TOKEN is not set');
      const result = await discord.me();
      if (!result.ok) return fail(`Discord rejected the token: ${result.error ?? result.status}`);
      console.log(`Connected as ${result.body.username} (${result.body.id})`);
      return;
    }

    default:
      console.log(`Andy — the LEAP coaching brain.

  ingest <folder>     read a folder on this machine — no Google account needed
  sync [--force]      pull the Drive folder in and reindex
  reindex             re-chunk and re-embed what is already downloaded
  ask "question"      ask Andy, with sources
  search "query"      just the passages, no model call
  status              what Andy has read, and what it is missing
  doctor              live-check every connection: Drive, Anthropic, Discord, creator data
  docs                every document, with its chunk count
  register [guildId]  publish the slash commands
  whoami              check the bot token reaches Discord`);
  }
}

function fail(message) { console.error(message); process.exitCode = 1; }

main().catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; });
