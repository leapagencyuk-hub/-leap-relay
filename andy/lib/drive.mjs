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

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** Google Docs/Sheets/Slides have no bytes to download — they are exported. */
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const FOLDER = 'application/vnd.google-apps.folder';

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
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${await this.token()}` },
          signal: AbortSignal.timeout(raw ? 120000 : 30000),
        });
        // Drive rate-limits with 403 as well as 429, so back off on both.
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          lastError = `HTTP ${res.status}`;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15000)));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      } catch (err) {
        lastError = err.message;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw new Error(`Drive request failed: ${lastError}`);
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

  /** Native Google formats report no size until exported; everything else does. */
  static isSupported(mimeType, name = '') {
    if (GOOGLE_EXPORT[mimeType]) return true;
    if (mimeType === 'application/vnd.google-apps.form' || mimeType?.startsWith('application/vnd.google-apps')) return false;
    return SUPPORTED.test(name) || SUPPORTED_MIME.has(mimeType);
  }
}

const SUPPORTED = /\.(pdf|docx|txt|md|markdown|csv|tsv|html?|json|rtf|vtt|srt)$/i;
const SUPPORTED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'text/html', 'application/json', 'application/rtf', 'text/vtt',
]);

export { GOOGLE_EXPORT, FOLDER };
