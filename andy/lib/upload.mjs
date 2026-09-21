// Files dragged onto the admin page.
//
// This is the path that needs no Google Cloud project: drop the folder on the
// page and Andy reads it. The browser sends each file's path relative to the
// folder root as its filename, so `Andy's Brain/Gifting/Playbook.pdf` arrives
// intact — which matters, because those sub-folder names become the topic
// labels on every chunk exactly as they do from Drive.
//
// The multipart parser is written by hand, as in creator-health: the parts are
// sliced out of the raw buffer rather than decoded as text, because a PDF must
// survive byte for byte.
import fs from 'node:fs';
import path from 'node:path';

/** Every file part in a multipart/form-data body, with its declared path. */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundaryMatch) return [];
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);

  const files = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const headerStart = start + boundary.length;
    const headerEnd = buffer.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;
    const headers = buffer.toString('utf8', headerStart, headerEnd);
    const next = buffer.indexOf(boundary, headerEnd);

    const filename = /filename\*?=(?:"([^"]*)"|([^;\r\n]+))/i.exec(headers);
    if (filename) {
      const name = (filename[1] ?? filename[2] ?? '').trim();
      if (name) {
        const end = next === -1 ? buffer.length : next - 2;   // trim the trailing CRLF
        files.push({ name, data: buffer.subarray(headerEnd + 4, end) });
      }
    }
    if (next === -1) break;
    start = next;
  }
  return files;
}

/**
 * Turn an uploaded path into a safe path under the uploads directory.
 *
 * A filename arriving over the wire is attacker-controlled by definition, so
 * `..`, absolute paths and anything else that escapes the directory are
 * stripped rather than sanitised — there is no legitimate upload that needs
 * to write outside the folder it is being uploaded into.
 */
export function safeRelativePath(name) {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[\0<>:"|?*]/g, '_').slice(0, 120));
  if (!parts.length) return null;
  return path.join(...parts);
}

/**
 * Write uploaded files into the uploads directory, keeping their folder tree.
 *
 * Replaces what is there for the paths it receives and leaves the rest alone,
 * so uploading one corrected file does not require re-uploading the folder.
 */
export function storeUploads(uploadDir, files, { replaceAll = false } = {}) {
  if (replaceAll) fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const written = [];
  const rejected = [];
  for (const file of files) {
    const relative = safeRelativePath(file.name);
    if (!relative) { rejected.push({ name: file.name, reason: 'unusable filename' }); continue; }
    const target = path.join(uploadDir, relative);
    // Belt and braces: even after stripping, confirm the resolved path is
    // still inside the directory before anything is written.
    if (!path.resolve(target).startsWith(path.resolve(uploadDir) + path.sep)) {
      rejected.push({ name: file.name, reason: 'path escapes the uploads folder' });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
    written.push({ name: relative, bytes: file.data.length });
  }
  return { written, rejected };
}

export function uploadStats(uploadDir) {
  if (!fs.existsSync(uploadDir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { files++; bytes += fs.statSync(full).size; }
    }
  };
  walk(uploadDir);
  return { files, bytes };
}
