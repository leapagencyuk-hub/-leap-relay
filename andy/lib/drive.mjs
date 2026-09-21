// Google Drive, over the REST API with a service account.
//
// A service account is the right shape for this: staff keep dropping files into
// a shared folder and nobody has to click through an OAuth consent screen, ever.
// The account is just another member of the folder — share it as Viewer and it
// sees what the folder sees.
//
// No googleapis dependency. The whole exchange is a self-signed JWT for an
// access token, then two GET endpoints, and node:crypto signs RS256 natively.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { GOOGLE_EXPORT, FOLDER_MIME as FOLDER, isSupported } from './formats.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';


const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function readServiceAccount(env = process.env) {
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const file = env.GOOGLE_SERVICE_ACCOUNT_FILE;
  let raw = null;
  if (inline) {
    // Pasting JSON into a dashboard field is awkward, so base64 is accepted too.
    raw = inline.trim().startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8');
  } else if (file) {
    raw = fs.readFileSync(file, 'utf8');
  }
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('service account JSON has no client_email/private_key');
  }
  return parsed;
}

/** Sign a JWT and trade it for an access token. Tokens last an hour; we cache. */
export async function getAccessToken(account, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const claim = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claim));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), account.private_key);
  const assertion = `${head}.${body}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Drive auth failed (${res.status}): ${json.error_description ?? json.error ?? 'unknown'}`);
  }
  return { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
}

export class Drive {
  constructor(account) {
    this.account = account;
    this._token = null;
  }

  static fromEnv(env = process.env) {
    const account = readServiceAccount(env);
    return account ? new Drive(account) : null;
  }

  async token() {
    // Refresh a minute early; a token that expires mid-walk fails a long sync.
    if (this._token && this._token.expiresAt > Date.now() + 60000) return this._token.token;
    this._token = await getAccessToken(this.account);
    return this._token.token;
  }

  async request(url, { raw = false, retries = 3 } = {}) {
    let lastError = null;
    let lastStatus = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${await this.token()}` },
          signal: AbortSignal.timeout(raw ? 120000 : 30000),
        });
        // Drive rate-limits with 403 as well as 429, so back off on both.
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          lastError = `HTTP ${res.status}`;
          lastStatus = res.status;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15000)));
          continue;
        }
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          error.status = res.status;
          throw error;
        }
        return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      } catch (err) {
        // A 4xx will not fix itself, and retrying it four times turns a
        // misconfiguration into a slow one.
        if (err.status && err.status < 500 && err.status !== 429) throw err;
        lastError = err.message;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    const failure = new Error(`Drive request failed: ${lastError}`);
    failure.status = lastStatus;
    throw failure;
  }

  /**
   * Check that the folder is reachable, and say precisely what is wrong if not.
   *
   * Google reports a folder that exists but has not been shared with this
   * service account as a plain 404 — indistinguishable from a typo in the id.
   * That single ambiguity is the most common way this setup fails, so it is
   * named here rather than left for somebody to guess at.
   */
  async checkFolder(folderId) {
    try {
      const params = new URLSearchParams({ fields: 'id, name, mimeType', supportsAllDrives: 'true' });
      const folder = await this.request(`${API}/files/${folderId}?${params}`);
      if (folder.mimeType !== FOLDER) {
        return { ok: false, reason: `that id is a ${folder.mimeType}, not a folder` };
      }
      return { ok: true, name: folder.name, account: this.account.client_email };
    } catch (err) {
      if (err.status === 404) {
        return {
          ok: false,
          reason: `Drive says that folder does not exist — which is also what it says when the folder has not been shared with ${this.account.client_email}. Share it with that address as Viewer, or check the id.`,
        };
      }
      if (err.status === 403) {
        return {
          ok: false,
          reason: 'Drive refused the request. Usually the Drive API is not enabled on the service account\'s Google Cloud project — enable it under APIs & Services → Library → Google Drive API.',
        };
      }
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Every file under a folder, following sub-folders.
   *
   * Staff organise by topic — "Gifting", "Schedules", "Campaign decks" — and
   * those folder names are the best topic labels in the whole corpus, so the
   * path down to each file is kept and travels with every chunk.
   */
  async listFolder(folderId, { prefix = [], seen = new Set() } = {}) {
    if (seen.has(folderId)) return [];   // shortcuts can make the tree a cycle
    seen.add(folderId);

    const out = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink, shortcutDetails)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request(`${API}/files?${params}`);

      for (const file of page.files ?? []) {
        const target = file.shortcutDetails
          ? { ...file, id: file.shortcutDetails.targetId, mimeType: file.shortcutDetails.targetMimeType }
          : file;
        if (target.mimeType === FOLDER) {
          out.push(...await this.listFolder(target.id, { prefix: [...prefix, file.name], seen }));
        } else {
          out.push({
            id: target.id,
            name: file.name,
            mimeType: target.mimeType,
            modifiedTime: file.modifiedTime,
            size: Number(file.size ?? 0),
            md5: file.md5Checksum ?? null,
            link: file.webViewLink ?? `https://drive.google.com/file/d/${target.id}/view`,
            folder: prefix.join(' / ') || null,
          });
        }
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);

    return out;
  }

  /** The file's bytes, or its exported text when Drive owns the format. */
  async download(file) {
    const exportAs = GOOGLE_EXPORT[file.mimeType];
    if (exportAs) {
      const params = new URLSearchParams({ mimeType: exportAs, supportsAllDrives: 'true' });
      return { buffer: await this.request(`${API}/files/${file.id}/export?${params}`, { raw: true }), mimeType: exportAs };
    }
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    return { buffer: await this.request(`${API}/files/${file.id}?${params}`, { raw: true }), mimeType: file.mimeType };
  }

  static isSupported(mimeType, name = '') { return isSupported(mimeType, name); }
}

/**
 * A Drive folder, as the source `sync` consumes.
 *
 * Wrapping it this way is what lets a local folder and an upload be ingested by
 * exactly the same pipeline — the difference between where files come from
 * stops here, and nothing downstream knows about Google at all.
 */
export function driveSource(drive, folderId) {
  return {
    label: `Google Drive folder ${folderId}`,
    kind: 'drive',
    check: () => drive.checkFolder(folderId),
    list: () => drive.listFolder(folderId),
    download: (file) => drive.download(file),
  };
}


export { GOOGLE_EXPORT, FOLDER };
