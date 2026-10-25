// The host half of the Presence panel: a tiny JSON API the Web UI calls.
// Loopback only 闁?a server picker that can hand out an SSH password must never
// be reachable from another machine.

import { createHash } from 'node:crypto';
import { activateWorkspace, activeWorkspace, listWorkspaces, removeWorkspace, upsertWorkspace } from './workspaces.js';
import { ensureMountDir, mountPathFor, normalizeRemotePath, parseMountPath } from './mounts.js';

const MAX_BODY = 64 * 1024;
// One file per request, in memory only for the upload (the body must be hashed
// before it is written), streamed for the download.
const MAX_TRANSFER = 64 * 1024 * 1024;
const RAW_CHUNK = 1024 * 1024;

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/**
 * Reject another site's page driving this API. Loopback alone is not enough:
 * any page open in this browser also talks to 127.0.0.1.
 */
function isSameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === new URL(`http://${request.headers.host ?? ''}`).host;
  } catch {
    return false;
  }
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

/** Extension to content type for `/raw`; everything else is opaque bytes. */
const CONTENT_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain; charset=utf-8'],
  ['md', 'text/markdown; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['csv', 'text/csv; charset=utf-8'],
  ['zip', 'application/zip'],
  ['bin', 'application/octet-stream'],
]);

function contentTypeFor(path) {
  const value = String(path);
  const dot = value.lastIndexOf('.');
  if (dot <= value.lastIndexOf('/')) return 'application/octet-stream';
  return CONTENT_TYPES.get(value.slice(dot + 1).toLowerCase()) ?? 'application/octet-stream';
}

/** Last segment of a POSIX remote path. */
function baseName(path) {
  const value = String(path).replace(/\/+$/, '');
  const slash = value.lastIndexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

/** RFC 5987 `filename*` payload: percent-encode, and escape what encodeURIComponent keeps. */
function dispositionFilename(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** "755" | "0755" | "0o755" | 0o755 -> octal mode number, or undefined when unset. */
function parseMode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const match = /^(?:0o)?0?([0-7]{3,4})$/.exec(String(value).trim());
  if (!match) throw new Error(`mode must be an octal string such as "755" or "0644", got ${JSON.stringify(value)}`);
  return Number.parseInt(match[1], 8);
}

/**
 * Collect a raw request body (an upload), or throw with `status: 413` once it
 * is past the cap. The data listener keeps running after the rejection so the
 * rest of the body is drained and the 413 can still reach the client.
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let stopped = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        stopped = true;
        chunks.length = 0;
        const error = new Error(`request body is larger than ${limit} bytes`);
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (stopped) return;
      stopped = true;
      reject(error);
    });
  });
}

/**
 * Discard a body nobody reads. The panel posts an empty JSON object to
 * `/mkdir` and `/remove`, whose parameters live in the query string.
 */
function drain(request) {
  if (request.readableEnded || request.destroyed) return;
  request.resume();
}

/** POSIX single-quoting, so the remote shell sees exactly these bytes. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * A single `Range: bytes=start-end` (also `start-` and `-suffix`). Anything
 * else is ignored and the whole file is served, so a Range-unaware client
 * still gets its bytes.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

/** Prefix of the credential reference that may hold a remembered password. */
export function credentialRef(host) {
  return `PRESENCE_SSH_${host.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

async function rememberedPassword(credentials, host) {
  if (!credentials) return undefined;
  try {
    const resolved = await credentials.resolve(credentialRef(host));
    return resolved?.value;
  } catch {
    return undefined;
  }
}

/**
 * Build the routes the panel uses.
 * @param pool - the connection pool.
 * @param late - mutable holder filled by the plugin's inject callbacks:
 *   `late.credentials` and `late.registry`, read per request.
 * @returns WebRoute registrations.
 */
export function presenceRoutes(pool, late = {}) {
  const getCredentials = () => late.credentials;
  const getRegistry = () => late.registry;
  const guarded = (handler) => async (request, response) => {
    if (!isLoopback(request) || !isSameOrigin(request)) {
      send(response, 403, { ok: false, error: 'Presence is reachable from this machine only' });
      return;
    }
    try {
      await handler(request, response);
    } catch (error) {
      // A streamed download writes its head before the first chunk; once that
      // happened no JSON error can be sent, so fail the connection instead of
      // throwing a second, uncaught error from this catch block.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(response, 200, { ok: false, error: error?.message ?? String(error) });
    }
  };

  const routes = [
    {
      kind: 'exact',
      path: '/presence/api/state',
      handler: guarded(async (_request, response) => {
        const hosts = pool.hosts();
        for (const host of hosts) {
          host.remembered = Boolean(await rememberedPassword(getCredentials(), host.alias));
          host.passwordHint = host.remembered ? 'remembered' : pool.hasSecret(host.alias) ? 'session' : 'none';
        }
        send(response, 200, { ok: true, hosts, terminals: pool.listTerminals() });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/connect',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        const body = await readJson(request);
        const host = String(body.host ?? '');
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        const password = typeof body.password === 'string' && body.password !== '' ? body.password : await rememberedPassword(getCredentials(), host);
        const started = Date.now();
        const connection = await pool.connection(host, {
          password,
          passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
        });
        if (body.remember === true && password) {
          const credentials = getCredentials();
          if (!credentials) {
            send(response, 200, {
              ok: true,
              connected: host,
              ms: Date.now() - started,
              warning: 'this profile has no credential store, so the password stays in memory only',
            });
            return;
          }
          await credentials.set(credentialRef(host), password);
        }
        const who = await connection.exec('printf "%s@%s" "$(id -un)" "$(hostname)"');
        send(response, 200, {
          ok: true,
          connected: host,
          identity: who.stdout.trim(),
          ms: Date.now() - started,
        });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/disconnect',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        const body = await readJson(request);
        const host = String(body.host ?? '');
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        await pool.disconnect(host);
        send(response, 200, { ok: true });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/forget',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        const body = await readJson(request);
        const host = String(body.host ?? '');
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        pool.forgetSecret(host);
        const credentials = getCredentials();
        if (credentials) await credentials.unset(credentialRef(host)).catch(() => {});
        send(response, 200, { ok: true });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/browse',
      handler: guarded(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '');
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        const requested = url.searchParams.get('path') || '.';
        const connection = await pool.connection(host);
        const home = await connection.realpath('.').catch(() => '~');
        let path;
        try {
          path = await connection.realpath(requested);
        } catch {
          path = requested.startsWith('/') ? requested : home;
        }
        const entries = await connection.list(path);
        const crumbs = [{ name: '/', path: '/' }];
        let walk = '';
        for (const part of path.split('/').filter(Boolean)) {
          walk += `/${part}`;
          crumbs.push({ name: part, path: walk });
        }
        send(response, 200, {
          ok: true,
          host,
          path,
          home,
          crumbs,
          entries: entries.map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind, size: entry.size })),
        });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/file',
      handler: guarded(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '');
        const path = String(url.searchParams.get('path') ?? '');
        if (!host || !path) {
          send(response, 400, { ok: false, error: 'host and path are required' });
          return;
        }
        const connection = await pool.connection(host);
        const info = await connection.stat(path);
        if (!info.exists) {
          send(response, 404, { ok: false, error: 'not found' });
          return;
        }
        if (info.isDir) {
          send(response, 400, { ok: false, error: 'is a directory' });
          return;
        }
        const cap = 256 * 1024;
        const { content } = await connection.readText(path, { length: Math.min(info.size, cap) });
        send(response, 200, {
          ok: true,
          path,
          size: info.size,
          truncated: info.size > cap,
          content,
        });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/entries',
      handler: guarded(async (request, response) => {
        if (request.method !== 'GET') {
          send(response, 405, { ok: false, error: 'use GET' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '').trim();
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        const connection = await pool.connection(host);
        let path = String(url.searchParams.get('path') ?? '').trim();
        if (!path) path = await connection.homePath();
        if (!path.startsWith('/')) path = normalizeRemotePath(`${await connection.homePath()}/${path}`);
        path = path.replace(/\/+$/, '') || '/';
        const info = await connection.stat(path);
        if (!info.exists) {
          send(response, 404, { ok: false, error: `${path} does not exist on ${host}` });
          return;
        }
        if (!info.isDir) {
          send(response, 400, { ok: false, error: `${path} is not a directory on ${host}` });
          return;
        }
        const listed = await connection.list(path);
        const entries = listed
          .map((entry) => {
            const name = entry.name;
            return {
              name,
              path: entry.path,
              kind: entry.kind === 'dir' ? 'dir' : entry.kind === 'link' ? 'link' : 'file',
              size: Number.isFinite(entry.size) ? entry.size : null,
              mtime: Number.isFinite(entry.mtime) ? entry.mtime : null,
              // `list` carries no per-entry mode today: one stat per name would
              // cost a round trip per file in the folder. A connection that
              // starts reporting one is picked up here with no extra request.
              mode: Number.isInteger(entry.mode) ? entry.mode & 0o7777 : null,
              // Dotfiles stay visible; the panel decides whether to dim them.
              hidden: name.startsWith('.'),
            };
          })
          .sort((a, b) => {
            if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
            const left = a.name.toLowerCase();
            const right = b.name.toLowerCase();
            if (left === right) return a.name.localeCompare(b.name);
            return left < right ? -1 : 1;
          });
        const crumbs = [{ name: '/', path: '/' }];
        let walk = '';
        for (const part of path.split('/').filter(Boolean)) {
          walk += `/${part}`;
          crumbs.push({ name: part, path: walk });
        }
        send(response, 200, { ok: true, host, path, crumbs, entries });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/raw',
      handler: guarded(async (request, response) => {
        if (request.method !== 'GET') {
          send(response, 405, { ok: false, error: 'use GET' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '').trim();
        const path = String(url.searchParams.get('path') ?? '').trim();
        if (!host || !path) {
          send(response, 400, { ok: false, error: 'host and path are required' });
          return;
        }
        const connection = await pool.connection(host);
        const info = await connection.stat(path);
        if (!info.exists) {
          send(response, 404, { ok: false, error: `${path} does not exist on ${host}` });
          return;
        }
        if (info.isDir) {
          send(response, 400, { ok: false, error: `${path} is a directory on ${host}` });
          return;
        }
        let start = 0;
        let end = Math.max(0, info.size - 1);
        const range = parseRange(request.headers.range, info.size);
        if (range) {
          start = range.start;
          end = range.end;
        }
        const span = info.size === 0 ? 0 : end - start + 1;
        if (span > MAX_TRANSFER) {
          send(response, 400, {
            ok: false,
            error: `${path} is ${info.size} bytes; raw transfer is capped at ${MAX_TRANSFER} bytes`,
          });
          return;
        }
        const type = contentTypeFor(path);
        const download = url.searchParams.get('download') === '1';
        const disposition = `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${dispositionFilename(baseName(path))}`;
        const headers = {
          'content-type': type,
          'content-length': span,
          'content-disposition': disposition,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff',
        };
        // A remote SVG is a document when opened directly (and then runs its
        // script in this origin): sandbox it. Images embedded via <img> are
        // unaffected by the policy of the image response itself.
        if (type === 'image/svg+xml') headers['content-security-policy'] = "sandbox; default-src 'none'";
        if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
        response.writeHead(range ? 206 : 200, headers);
        if (span === 0) {
          response.end();
          return;
        }
        // Stream in fixed windows instead of buffering the file: a 60 MiB image
        // must not become a 60 MiB Buffer in this process.
        const stop = end + 1;
        try {
          let offset = start;
          while (offset < stop) {
            const { buffer } = await connection.readBytes(path, { offset, length: Math.min(RAW_CHUNK, stop - offset) });
            if (!buffer || buffer.length === 0) break;
            offset += buffer.length;
            if (!response.write(buffer)) {
              // Wait for the socket, or for the client to go away.
              await new Promise((resolve) => {
                const wake = () => {
                  response.off('drain', wake);
                  response.off('close', wake);
                  resolve();
                };
                response.once('drain', wake);
                response.once('close', wake);
              });
            }
            if (response.destroyed) break;
          }
          response.end();
        } catch {
          // The head is already out; breaking the connection is the only
          // signal left, and it stops the read loop from pulling more bytes.
          response.destroy();
        }
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/upload',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '').trim();
        const dir = String(url.searchParams.get('dir') ?? '').trim();
        const name = String(url.searchParams.get('name') ?? '');
        if (!host) {
          send(response, 400, { ok: false, error: 'host is required' });
          return;
        }
        if (!dir) {
          send(response, 400, { ok: false, error: 'dir is required' });
          return;
        }
        if (
          name === '' ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\\') ||
          name.includes('\0') ||
          name.includes('..')
        ) {
          send(response, 400, { ok: false, error: 'name must be one plain file name: no "/", no "\\", no ".."' });
          return;
        }
        let mode;
        try {
          mode = parseMode(url.searchParams.get('mode')) ?? 0o644;
        } catch (error) {
          send(response, 400, { ok: false, error: error.message });
          return;
        }
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_TRANSFER) {
          send(response, 413, { ok: false, error: `upload is capped at ${MAX_TRANSFER} bytes` });
          drain(request);
          return;
        }
        let buffer;
        try {
          buffer = await readBody(request, MAX_TRANSFER);
        } catch (error) {
          if (error.status === 413) {
            send(response, 413, { ok: false, error: `${error.message}; the upload cap is ${MAX_TRANSFER} bytes` });
            return;
          }
          throw error;
        }
        const connection = await pool.connection(host);
        const base = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
        const target = base === '/' ? `/${name}` : `${base}/${name}`;
        // The panel uploads into the folder it is showing; creating it is a
        // convenience, and a failure here surfaces from the write instead.
        await connection.exec(`mkdir -p ${shellQuote(base)}`, { timeoutMs: 20_000 }).catch(() => {});
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const written = await connection.writeText(target, buffer, { mode });
        send(response, 200, {
          ok: true,
          path: target,
          bytes: buffer.length,
          sha256,
          mode: written.mode ?? mode,
        });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/mkdir',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        drain(request);
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '').trim();
        const path = String(url.searchParams.get('path') ?? '').trim();
        if (!host || !path) {
          send(response, 400, { ok: false, error: 'host and path are required' });
          return;
        }
        const connection = await pool.connection(host);
        // `-p` matches the panel, which creates a folder under the open one and
        // may also be asked to create a whole path.
        const result = await connection.exec(`mkdir -p ${shellQuote(path)}`, { timeoutMs: 30_000 });
        if (result.code !== 0) {
          send(response, 400, {
            ok: false,
            error: `could not create ${path} on ${host}: ${result.stderr.trim() || `exit ${result.code}`}`,
          });
          return;
        }
        send(response, 200, { ok: true, path });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/remove',
      handler: guarded(async (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use POST' });
          return;
        }
        drain(request);
        const url = new URL(request.url ?? '/', 'http://localhost');
        const host = String(url.searchParams.get('host') ?? '').trim();
        const path = String(url.searchParams.get('path') ?? '').trim();
        if (!host || !path) {
          send(response, 400, { ok: false, error: 'host and path are required' });
          return;
        }
        const connection = await pool.connection(host);
        let result;
        try {
          result = await connection.trash(path);
        } catch (error) {
          // `trash` refuses roots and the remote home with code 'refused'; the
          // rest are real failures. Both answer 4xx with the remote message.
          const status = error?.code === 'refused' ? 400 : 409;
          send(response, status, { ok: false, error: error?.message ?? String(error) });
          return;
        }
        send(response, 200, { ok: true, trashPath: result.trashPath, strategy: result.strategy });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/context',
      handler: guarded(async (request, response) => {
        if (request.method !== 'GET') {
          send(response, 405, { ok: false, error: 'use GET' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const sessionId = String(url.searchParams.get('sessionId') ?? '').trim();
        if (!sessionId) {
          send(response, 400, { ok: false, error: 'sessionId is required' });
          return;
        }
        // Both services are injected late, so they can be absent in a stripped
        // profile; read them here rather than freezing the reference at setup.
        const agents = late.agents;
        const workingDirectory = late.workingDirectory;
        if (!agents || typeof agents.get !== 'function' || !workingDirectory || typeof workingDirectory.get !== 'function') {
          send(response, 503, { ok: false, error: 'session context is not available in this profile' });
          return;
        }
        const agent = await agents.get(sessionId);
        if (!agent) {
          send(response, 404, { ok: false, error: `no session ${sessionId}` });
          return;
        }
        let cwd = null;
        try {
          cwd = agent.session ? await workingDirectory.get(agent.session) : null;
        } catch {
          cwd = null;
        }
        if (cwd && typeof cwd === 'object') cwd = cwd.path ?? null;
        const mounted = typeof cwd === 'string' ? parseMountPath(cwd) : null;
        if (!mounted) {
          send(response, 200, { ok: true, workspace: null });
          return;
        }
        const title = mounted.path.split('/').filter(Boolean).at(-1) ?? mounted.host;
        send(response, 200, { ok: true, workspace: { host: mounted.host, path: mounted.path, title } });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/workspaces',
      handler: guarded(async (request, response) => {
        if (request.method === 'GET') {
          const workspaces = listWorkspaces();
          const registry = getRegistry();
          let synced = 0;
          // Heal workspaces created before the registry was reachable: creating
          // an already-registered canonical path returns the existing entity.
          if (registry) {
            for (const entry of workspaces) {
              try {
                await registry.create(ensureMountDir(entry.host, entry.path), entry.title);
                synced += 1;
              } catch {
                /* the filesystem provider may not be mounted in this profile */
              }
            }
          }
          send(response, 200, { ok: true, workspaces, active: activeWorkspace()?.id ?? null, synced });
          return;
        }
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'use GET or POST' });
          return;
        }
        const body = await readJson(request);
        if (body.activate !== undefined) {
          const active = activateWorkspace(String(body.activate));
          send(response, 200, { ok: true, active: active?.id ?? null, workspace: active, workspaces: listWorkspaces() });
          return;
        }
        if (body.remove) {
          const id = String(body.remove);
          const target = listWorkspaces().find((entry) => entry.id === id);
          const removed = removeWorkspace(id);
          const registry = getRegistry();
          if (removed && target && registry) {
            try {
              const existing = await registry.resolveByPath(ensureMountDir(target.host, target.path));
              if (existing) await registry.delete(existing.id);
            } catch {
              /* the DSH workspace may already be gone */
            }
          }
          send(response, 200, { ok: true, removed, workspaces: listWorkspaces() });
          return;
        }
        const host = String(body.host ?? '');
        const path = String(body.path ?? '');
        if (!host || !path) {
          send(response, 400, { ok: false, error: 'host and path are required' });
          return;
        }
        const connection = await pool.connection(host);
        const info = await connection.stat(path);
        if (!info.exists) {
          send(response, 400, { ok: false, error: `${path} does not exist on ${host}` });
          return;
        }
        if (!info.isDir) {
          send(response, 400, { ok: false, error: `${path} is not a directory on ${host}` });
          return;
        }
        const workspace = upsertWorkspace({ host, path, title: typeof body.title === 'string' ? body.title : undefined });

        // When the filesystem provider is mounted, the remote folder becomes a
        // real DSH workspace too: it lands in the sidebar, gets sessions whose
        // cwd is the remote path, and the file tree reads it through ctx.fs.
        const registry = getRegistry();
        let dshWorkspace = null;
        let warning = null;
        if (registry) {
          const url = `presence://${host}${normalizeRemotePath(path)}`;
          try {
            const created = await registry.create(mount, workspace.title);
            dshWorkspace = { id: created.id, path: created.path, title: created.title };
          } catch (error) {
            warning = `saved here, but the DSH workspace could not be created: ${error?.message ?? String(error)}`;
          }
        } else {
          warning = 'this profile has no workspace registry; the workspace exists only inside Presence';
        }

        send(response, 200, { ok: true, workspace, workspaces: listWorkspaces(), dshWorkspace, warning });
      }),
    },
    {
      kind: 'exact',
      path: '/presence/api/diag',
      handler: guarded(async (_request, response) => {
        const registry = getRegistry();
        const entries = listWorkspaces();
        let created = null;
        let createError = null;
        if (registry && entries[0]) {
          try {
            const workspace = await registry.create(ensureMountDir(entries[0].host, entries[0].path), entries[0].title);
            created = { id: workspace.id, path: workspace.path, title: workspace.title };
          } catch (error) {
            createError = `${error?.constructor?.name}: ${error?.message ?? String(error)}`;
          }
        }
        send(response, 200, {
          ok: true,
          hasRegistry: Boolean(registry),
          registryType: registry?.constructor?.name ?? null,
          hasCredentials: Boolean(getCredentials()),
          workspaces: entries.length,
          created,
          createError,
        });
      }),
    },
  ];

  // The desktop shell carries `/api/*` over its IPC bridge but does not forward
  // arbitrary plugin paths. Register every route under both spellings so the
  // panel works in the browser AND in the packaged app.
  return routes.flatMap((route) => [
    route,
    { ...route, path: route.path.replace(/^\/presence\/api\//, '/api/presence/') },
  ]);
}
