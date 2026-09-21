// A folder on disk as a source, exactly like the Drive folder.
//
// This is the path that needs no Google Cloud project at all: point Andy at a
// directory — a synced Drive folder, a Dropbox folder, or the files dragged
// onto the admin page — and it reads the same formats, keeps the same
// sub-folder names as topic labels, and skips unchanged files the same way.
//
// A Drive file's identity is its file id and its checksum. Here there is
// neither, so the path is the identity and size+mtime is the change signal.
// That is weaker — touching a file re-reads it — but re-reading a file that
// did not change is only wasted work, never a wrong answer.
import fs from 'node:fs';
import path from 'node:path';
import { isSupported, mimeFromName } from './formats.mjs';

export class LocalSource {
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) throw new Error(`no such folder: ${this.root}`);
    if (!fs.statSync(this.root).isDirectory()) throw new Error(`not a folder: ${this.root}`);
  }

  get label() { return this.root; }

  /** Everything under the folder, sub-folders included, oldest path first. */
  async list() {
    const out = [];
    const walk = (dir, trail) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // An unreadable sub-folder should cost that sub-folder, not the sync.
        return;
      }
      for (const entry of entries) {
        // Dotfiles here are editor state, OS metadata and sync conflict
        // markers, never documents.
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, [...trail, entry.name]); continue; }
        if (!entry.isFile()) continue;   // symlinks out of the tree, sockets, devices

        const stat = fs.statSync(full);
        out.push({
          id: path.relative(this.root, full),
          name: entry.name,
          mimeType: mimeFromName(entry.name),
          modifiedTime: stat.mtime.toISOString(),
          size: stat.size,
          // No checksum on disk, so size and mtime stand in for one. Cheaper
          // than hashing every file on every sync, and wrong only in the
          // harmless direction.
          md5: `${stat.size}:${Math.round(stat.mtimeMs)}`,
          link: `file://${full}`,
          folder: trail.join(' / ') || null,
          path: full,
        });
      }
    };
    walk(this.root, []);
    return out;
  }

  async download(file) {
    return { buffer: fs.readFileSync(file.path), mimeType: file.mimeType };
  }

  static isSupported(mimeType, name) { return isSupported(mimeType, name); }
}
