// End-to-end probe for the file-transfer API in src/api.js.
//
//   node scripts/api-probe.mjs [host]
//
// No DSH and no HTTP server: the exported route handlers are called directly
// with a fake request/response pair, over one real PresencePool connection.
// Everything the probe creates lives under /tmp/presence-api-probe-* and is
// removed again; the trash round-trip restores what it trashed.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { PresencePool } from '../src/pool.js';
import { presenceRoutes } from '../src/api.js';
import { mountPathFor } from '../src/mounts.js';

const HOST = process.env.PRESENCE_PROBE_HOST || process.argv[2] || 'server';
const API = '/presence/api';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// ------------------------------------------------------------------ doubles

/** Enough of a request for `guarded` + the streaming/upload readers. */
class ProbeRequest extends PassThrough {
  constructor({ method = 'GET', url, headers = {}, remoteAddress = '127.0.0.1' }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3846', ...headers };
    this.socket = { remoteAddress };
  }
}

/** Minimal ServerResponse: statusCode, headers, and the written bytes. */
class ProbeResponse extends Writable {
  #chunks = [];

  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.headersSent = false;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers ?? {};
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.#chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.#chunks);
  }

  json() {
    return JSON.parse(this.body().toString('utf8'));
  }

  /** Resolves when `send()`/`end()` flushed, or when the response was destroyed. */
  finished(timeoutMs = 15_000) {
    if (this.writableFinished) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('response never finished')), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('finish', done);
      this.once('close', done);
    });
  }
}

// -------------------------------------------------------------------- utils

let checks = 0;
let failures = 0;

async function check(label, run) {
  checks += 1;
  try {
    const detail = await run();
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${String(error?.message ?? error).replaceAll('\n', '\n      ')}`);
    return false;
  }
}

function routesFor(pool, late) {
  const table = new Map();
  for (const route of presenceRoutes(pool, late)) table.set(route.path, route.handler);
  return table;
}

/** Call one handler exactly as the Web server would, and collect the response. */
async function call(table, method, path, { body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const request = new ProbeRequest({ method, url: path, headers, remoteAddress });
  if (body !== undefined && request.headers['content-length'] === undefined) {
    request.headers['content-length'] = String(body.length);
  }
  const response = new ProbeResponse();
  const handler = table.get(path.split('?')[0]);
  assert.equal(typeof handler, 'function', `no route for ${path.split('?')[0]}`);
  const pending = handler(request, response);
  request.end(body ?? undefined);
  await pending;
  await response.finished();
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body(),
    json: () => response.json(),
  };
}

const q = (params) => new URLSearchParams(params).toString();
const url = (name, params) => `${API}/${name}?${q(params)}`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function containerOf(trashPath) {
  return String(trashPath).slice(0, String(trashPath).lastIndexOf('/'));
}

// --------------------------------------------------------------------- main

async function main() {
  const pool = new PresencePool({ maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000 });
  const started = Date.now();

  const mountedCwd = mountPathFor(HOST, '/tmp/mounted-dir');
  const sessions = new Map([
    ['probe-local-session', '/home/someone/project'],
    ['probe-mounted-session', mountedCwd],
  ]);
  const late = {
    agents: { get: (sessionId) => (sessions.has(sessionId) ? { session: { id: sessionId } } : undefined) },
    workingDirectory: { get: (session) => sessions.get(session?.id) },
  };
  const routes = routesFor(pool, late);
  const bareRoutes = routesFor(pool, {});

  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const fixtureDir = `/tmp/presence-api-probe-${stamp}`;
  const looseFile = `/tmp/presence-api-probe-${stamp}.tmp`;
  const uploadName = 'pr\u00f6be data.bin';
  const uploadedPath = `${fixtureDir}/${uploadName}`;
  const doomedDir = `${fixtureDir}/doomed`;
  const payload = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]),
    randomBytes(2048),
    Buffer.from('presence\u0000tail', 'utf8'),
  ]);
  const payloadSha = sha256(payload);
  const emptySha = sha256(Buffer.alloc(0));

  let connection;
  let trashContainer = null;
  let restored = false;

  const cleanup = async () => {
    if (!connection) return;
    const steps = [];
    if (fixtureDir.startsWith('/tmp/presence-api-probe-')) {
      steps.push(() => connection.exec(`rm -rf -- ${shellQuote(fixtureDir)}`));
    }
    if (looseFile.startsWith('/tmp/presence-api-probe-')) {
      steps.push(() => connection.exec(`rm -f -- ${shellQuote(looseFile)}`));
    }
    if (trashContainer && /\/presence-trash\/\d{8}T\d{6}Z-[0-9a-f]+$/.test(trashContainer)) {
      // Empty after a successful restore; only this probe's container matches.
      steps.push(() => connection.exec(`rm -rf -- ${shellQuote(trashContainer)}`));
    }
    for (const step of steps) await step().catch(() => {});
  };

  try {
    console.log(`\n=== Presence file API probe -> ${HOST} ===\n`);
    connection = await pool.connection(HOST);
    const who = await connection.exec('printf "%s@%s" "$(id -un)" "$(hostname)"');
    console.log(`connected to ${who.stdout.trim()} in ${Date.now() - started}ms\n`);

    // ------------------------------------------------- routes and the fence

    await check('all six endpoints are registered under both prefixes', () => {
      const paths = presenceRoutes(pool, late).map((route) => route.path);
      for (const name of ['entries', 'raw', 'upload', 'mkdir', 'remove', 'context']) {
        assert.ok(paths.includes(`/presence/api/${name}`), `missing /presence/api/${name}`);
        assert.ok(paths.includes(`/api/presence/${name}`), `missing /api/presence/${name}`);
      }
      return `${paths.length} route registrations`;
    });

    await check('the /api/presence spelling is handled by the same route', async () => {
      const response = await call(routes, 'GET', `/api/presence/entries?${q({ host: HOST, path: '/tmp' })}`);
      assert.equal(response.status, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().path, '/tmp');
    });

    await check('a non-loopback request is refused with 403', async () => {
      const response = await call(routes, 'GET', url('entries', { host: HOST, path: '/tmp' }), { remoteAddress: '10.1.2.3' });
      assert.equal(response.status, 403);
      assert.equal(response.json().ok, false);
    });

    await check('a cross-site request is refused with 403', async () => {
      const response = await call(routes, 'GET', url('entries', { host: HOST, path: '/tmp' }), {
        headers: { origin: 'http://evil.example' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json().ok, false);
    });

    // --------------------------------------------------------- /entries errors

    await check('/entries rejects a blank host with 400', async () => {
      const response = await call(routes, 'GET', url('entries', { path: '/tmp' }));
      assert.equal(response.status, 400);
      assert.equal(response.json().ok, false);
    });

    await check('/entries answers 404 for an unknown path', async () => {
      const response = await call(routes, 'GET', url('entries', { host: HOST, path: `${fixtureDir}-missing` }));
      assert.equal(response.status, 404);
      assert.equal(response.json().ok, false);
      assert.match(response.json().error, /does not exist/);
    });

    // ------------------------------------------------------------- /mkdir

    await check('/mkdir creates a nested path (parents allowed)', async () => {
      const target = `${fixtureDir}/nested`;
      const response = await call(routes, 'POST', url('mkdir', { host: HOST, path: target }), {
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
      });
      assert.equal(response.status, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().path, target);
      assert.equal((await connection.stat(target)).isDir, true);
      return target;
    });

    // ------------------------------------------------------------- /upload

    await check('/upload writes binary bytes, sha256 and mode 644', async () => {
      const response = await call(routes, 'POST', url('upload', { host: HOST, dir: fixtureDir, name: uploadName, mode: '644' }), {
        headers: { 'content-type': 'application/octet-stream' },
        body: payload,
      });
      const data = response.json();
      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.path, uploadedPath);
      assert.equal(data.bytes, payload.length);
      assert.equal(data.sha256, payloadSha);
      const read = await connection.readBytes(uploadedPath, { length: payload.length });
      assert.deepEqual(read.buffer, payload);
      const info = await connection.stat(uploadedPath);
      assert.equal(info.size, payload.length);
      assert.equal(info.mode & 0o777, 0o644);
      return `${payload.length} bytes, mode 644, sha256 ${payloadSha.slice(0, 12)}...`;
    });

    await check('/upload accepts a 0-byte file', async () => {
      const response = await call(routes, 'POST', url('upload', { host: HOST, dir: fixtureDir, name: 'empty.dat' }), {
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(0),
      });
      const data = response.json();
      assert.equal(response.status, 200);
      assert.equal(data.bytes, 0);
      assert.equal(data.sha256, emptySha);
      assert.equal((await connection.stat(`${fixtureDir}/empty.dat`)).size, 0);
    });

    await check('/upload keeps a dotfile, flagged hidden by /entries', async () => {
      const response = await call(routes, 'POST', url('upload', { host: HOST, dir: fixtureDir, name: '.hidden-marker' }), {
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      });
      assert.equal(response.status, 200);
    });

    await check('/upload rejects a path-traversal name with 400', async () => {
      for (const name of ['../escape.bin', 'a/b.bin', 'a\\b.bin', '..', '']) {
        const response = await call(routes, 'POST', url('upload', { host: HOST, dir: fixtureDir, name }), {
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from('x'),
        });
        assert.equal(response.status, 400, `name ${JSON.stringify(name)} was accepted`);
        assert.equal(response.json().ok, false);
      }
    });

    await check('/upload rejects a declared body above the 64 MiB cap with 413', async () => {
      const response = await call(routes, 'POST', url('upload', { host: HOST, dir: fixtureDir, name: 'toobig.bin' }), {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(64 * 1024 * 1024 + 1) },
        body: Buffer.alloc(0),
      });
      assert.equal(response.status, 413);
      assert.equal(response.json().ok, false);
    });

    await check('/upload only answers POST', async () => {
      const response = await call(routes, 'GET', url('upload', { host: HOST, dir: fixtureDir, name: 'x.bin' }));
      assert.equal(response.status, 405);
    });

    // ---------------------------------------------------------------- /raw

    await check('/raw returns the same bytes with a sensible content type', async () => {
      const response = await call(routes, 'GET', url('raw', { host: HOST, path: uploadedPath, download: '1' }));
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'application/octet-stream');
      assert.equal(Number(response.headers['content-length']), payload.length);
      assert.deepEqual(response.body, payload);
      const disposition = String(response.headers['content-disposition']);
      assert.match(disposition, /^attachment; filename\*=UTF-8''/);
      assert.ok(disposition.includes(encodeURIComponent(uploadName)), disposition);
      return disposition;
    });

    await check('/raw defaults to inline without download=1', async () => {
      const response = await call(routes, 'GET', url('raw', { host: HOST, path: uploadedPath }));
      assert.equal(response.status, 200);
      assert.match(String(response.headers['content-disposition']), /^inline; /);
      assert.deepEqual(response.body, payload);
    });

    await check('/raw honours a byte range', async () => {
      const response = await call(routes, 'GET', url('raw', { host: HOST, path: uploadedPath }), {
        headers: { range: 'bytes=2-9' },
      });
      assert.equal(response.status, 206);
      assert.deepEqual(response.body, payload.subarray(2, 10));
      assert.equal(response.headers['content-range'], `bytes 2-9/${payload.length}`);
      assert.equal(Number(response.headers['content-length']), 8);
    });

    await check('/raw answers 404 for a missing file', async () => {
      const response = await call(routes, 'GET', url('raw', { host: HOST, path: `${fixtureDir}/nope.bin` }));
      assert.equal(response.status, 404);
      assert.equal(response.json().ok, false);
    });

    // ------------------------------------------------------------ /entries

    await check('/entries lists a folder: dirs first, hidden flagged, numeric mtime', async () => {
      const response = await call(routes, 'GET', url('entries', { host: HOST, path: fixtureDir }));
      const data = response.json();
      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.host, HOST);
      assert.equal(data.path, fixtureDir);
      assert.equal(data.crumbs[0].path, '/');
      assert.equal(data.crumbs.at(-1).path, fixtureDir);
      assert.equal(data.crumbs.at(-1).name, fixtureDir.split('/').at(-1));

      const names = data.entries.map((entry) => entry.name);
      for (const expected of ['nested', uploadName, '.hidden-marker', 'empty.dat']) {
        assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`);
      }
      const nested = data.entries.find((entry) => entry.name === 'nested');
      const file = data.entries.find((entry) => entry.name === uploadName);
      const hidden = data.entries.find((entry) => entry.name === '.hidden-marker');
      assert.equal(nested.kind, 'dir');
      assert.equal(file.kind, 'file');
      assert.equal(file.size, payload.length);
      assert.equal(typeof file.mtime, 'number');
      assert.ok(file.mtime > 0);
      assert.ok('mode' in file, 'entry has no mode field');
      assert.ok(file.mode === null || Number.isInteger(file.mode), `unexpected mode ${file.mode}`);
      assert.equal(file.hidden, false);
      assert.equal(hidden.hidden, true);
      assert.equal(typeof hidden.mtime, 'number');

      // Directories first, then case-insensitive name within each kind.
      const firstFile = data.entries.findIndex((entry) => entry.kind !== 'dir');
      assert.ok(firstFile > 0);
      assert.ok(data.entries.slice(firstFile).every((entry) => entry.kind !== 'dir'));
      const dirs = data.entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.name.toLowerCase());
      const files = data.entries.filter((entry) => entry.kind !== 'dir').map((entry) => entry.name.toLowerCase());
      assert.deepEqual([...dirs].sort(), dirs);
      assert.deepEqual([...files].sort(), files);
      return `${data.entries.length} entries, ${firstFile} dirs`;
    });

    // --------------------------------------------------- /tmp + loose fixture

    await check('/entries of /tmp has a dir and a file with numeric mtimes', async () => {
      const looseName = looseFile.slice('/tmp/'.length);
      const loosePayload = Buffer.from('presence probe fixture\n');
      const upload = await call(routes, 'POST', url('upload', { host: HOST, dir: '/tmp', name: looseName }), {
        headers: { 'content-type': 'application/octet-stream' },
        body: loosePayload,
      });
      assert.equal(upload.status, 200);

      const response = await call(routes, 'GET', url('entries', { host: HOST, path: '/tmp' }));
      const data = response.json();
      assert.equal(response.status, 200);
      assert.equal(data.path, '/tmp');
      assert.ok(data.entries.some((entry) => entry.kind === 'dir'), 'no directory in /tmp');
      assert.ok(data.entries.some((entry) => entry.kind === 'file'), 'no file in /tmp');
      assert.ok(data.entries.every((entry) => typeof entry.mtime === 'number'));
      assert.ok(data.entries.every((entry) => typeof entry.hidden === 'boolean'));
      const ours = data.entries.find((entry) => entry.name === looseName);
      assert.equal(ours.kind, 'file');
      assert.equal(ours.size, loosePayload.length);
      return `${data.entries.length} entries in /tmp`;
    });

    // ----------------------------------------------------- /remove (trash)

    await check('/remove refuses the filesystem root with 400 and the remote message', async () => {
      const response = await call(routes, 'POST', url('remove', { host: HOST, path: '/' }));
      assert.equal(response.status, 400);
      assert.equal(response.json().ok, false);
      assert.match(response.json().error, /root/);
    });

    await check('/mkdir + /remove + restoreTrash round-trip', async () => {
      const made = await call(routes, 'POST', url('mkdir', { host: HOST, path: doomedDir }));
      assert.equal(made.status, 200);
      assert.equal((await connection.stat(doomedDir)).isDir, true);

      const removed = await call(routes, 'POST', url('remove', { host: HOST, path: doomedDir }));
      const data = removed.json();
      assert.equal(removed.status, 200);
      assert.equal(data.ok, true);
      assert.ok(data.trashPath, 'no trashPath returned');
      trashContainer = containerOf(data.trashPath);
      assert.ok(trashContainer.includes('/presence-trash/'), trashContainer);
      assert.equal((await connection.stat(doomedDir)).exists, false);
      assert.ok((await connection.listTrash()).some((entry) => entry.trashPath === data.trashPath));

      const back = await connection.restoreTrash(data.trashPath, { to: doomedDir });
      restored = true;
      assert.equal(back.restored, true);
      assert.ok(String(back.to).endsWith('/doomed'), back.to);
      assert.equal((await connection.stat(doomedDir)).isDir, true);
      return data.trashPath;
    });

    // ------------------------------------------------------------ /context

    await check('/context answers 404 for an unknown session', async () => {
      const response = await call(routes, 'GET', url('context', { sessionId: 'probe-made-up-session' }));
      assert.equal(response.status, 404);
      assert.equal(response.json().ok, false);
    });

    await check('/context reports workspace null when the cwd is not a mount', async () => {
      const response = await call(routes, 'GET', url('context', { sessionId: 'probe-local-session' }));
      assert.equal(response.status, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().workspace, null);
    });

    await check('/context resolves a mounted cwd to { host, path, title }', async () => {
      const response = await call(routes, 'GET', url('context', { sessionId: 'probe-mounted-session' }));
      const data = response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(data.workspace, { host: HOST, path: '/tmp/mounted-dir', title: 'mounted-dir' });
    });

    await check('/context answers 400 without a sessionId', async () => {
      const response = await call(routes, 'GET', url('context', {}));
      assert.equal(response.status, 400);
    });

    await check('/context answers 503 when the session services are absent', async () => {
      const response = await call(bareRoutes, 'GET', url('context', { sessionId: 'anything' }));
      assert.equal(response.status, 503);
      assert.equal(response.json().ok, false);
    });
  } finally {
    await cleanup();
    await check('remote fixtures were removed', async () => {
      if (!connection) return 'no connection; nothing created';
      assert.equal((await connection.stat(fixtureDir)).exists, false, `${fixtureDir} still exists`);
      assert.equal((await connection.stat(looseFile)).exists, false, `${looseFile} still exists`);
      return `${fixtureDir} gone${restored ? ', trash restored' : ''}`;
    });
    pool.dispose();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${checks - failures}/${checks} checks passed in ${seconds}s${failures ? `, ${failures} FAILED` : ''}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main().catch((error) => {
  console.error(`\nprobe aborted: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
