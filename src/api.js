// The host half of the Presence panel: a tiny JSON API the Web UI calls.
// Loopback only 閳?a server picker that can hand out an SSH password must never
// be reachable from another machine.

import { activateWorkspace, activeWorkspace, listWorkspaces, removeWorkspace, upsertWorkspace } from './workspaces.js';
import { ensureMountDir, mountPathFor, normalizeRemotePath } from './mounts.js';

const MAX_BODY = 64 * 1024;

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
