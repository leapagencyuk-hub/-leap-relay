// Thread memory.
//
// "What about his fan club?" is only answerable if Andy remembers who "he" is.
// So each Discord thread (or channel, for a loose exchange) keeps its last few
// turns, and a follow-up carries them.
//
// Kept small on purpose. This is a coaching conversation that lasts minutes,
// not a transcript worth archiving: old threads expire, the file is capped, and
// nothing here is the system of record for anything.
import fs from 'node:fs';
import path from 'node:path';

const MAX_THREADS = 400;
const EXPIRE_MS = 24 * 3600 * 1000;

export class Conversations {
  constructor(dataDir, { maxTurns = 8 } = {}) {
    this.file = path.join(dataDir, 'conversations.json');
    this.maxTurns = maxTurns;
    this.threads = this.read();
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  get(key) {
    const thread = this.threads[key];
    if (!thread) return [];
    if (Date.now() - thread.at > EXPIRE_MS) { delete this.threads[key]; return []; }
    return thread.messages;
  }

  /**
   * Record a turn.
   *
   * Only the question and the final text are kept — not the tool calls. Replaying
   * a previous turn's search results would drag stale passages into a new
   * question and quietly bias the answer toward whatever was asked before.
   */
  push(key, question, answer) {
    const messages = [
      ...this.get(key),
      { role: 'user', content: question },
      { role: 'assistant', content: answer || '(no answer)' },
    ].slice(-this.maxTurns * 2);
    this.threads[key] = { at: Date.now(), messages };
    this.prune();
    this.write();
  }

  prune() {
    const now = Date.now();
    for (const [key, thread] of Object.entries(this.threads)) {
      if (now - thread.at > EXPIRE_MS) delete this.threads[key];
    }
    const keys = Object.keys(this.threads);
    if (keys.length > MAX_THREADS) {
      keys.sort((a, b) => this.threads[a].at - this.threads[b].at)
        .slice(0, keys.length - MAX_THREADS)
        .forEach((key) => delete this.threads[key]);
    }
  }

  write() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.threads));
      fs.renameSync(tmp, this.file);
    } catch {
      // Losing thread memory degrades a follow-up; it must never fail an answer
      // that has already been produced.
    }
  }
}
