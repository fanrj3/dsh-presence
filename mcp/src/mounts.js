// Local mount markers.
//
// The workspace registry canonicalizes paths with node's `realpath`, so a
// workspace path must be a real local directory. A remote folder therefore gets
// a local stand-in directory:
//
//   <DSH_HOME>/presence/mounts/<host>/<absolute remote path>
//
// The directory is empty on disk; the fs provider maps everything under it back
// to `<host>:<remote path>`, so the file tree and the built-in tools read and
// write the remote machine while the registry sees an ordinary local folder.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shared } from './shared.js';
import { listHosts } from './core/ssh-config.mjs';

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function mountsRoot() {
  return shared.mountsRoot ?? join(dshHome(), 'presence', 'mounts');
}

/** Lexical POSIX normalization for a remote folder path. */
export function normalizeRemotePath(path) {
  const parts = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The local stand-in directory for one (host, remote folder) pair. */
export function mountPathFor(host, remotePath) {
  const segments = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  return join(mountsRoot(), host, ...segments);
}

let hostCache = null;
let hostCacheAt = 0;

/**
 * Whether a mount's first segment is a real ssh alias. Without this, an upward
 * directory walk that joins a marker direct under the mounts root (e.g.
 * `<mounts>/.git`) would be read as "host .git".
 */
function isKnownHost(host) {
  if (!hostCache || Date.now() - hostCacheAt > 10_000) {
    let aliases = new Set();
    try {
      aliases = new Set(listHosts().map((entry) => entry.alias));
    } catch {
      /* keep empty */
    }
    hostCache = aliases;
    hostCacheAt = Date.now();
  }
  return hostCache.has(host);
}

/** Read a local path back as (host, remote path), or null when it is not mounted. */
export function parseMountPath(path) {
  const root = mountsRoot().replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = String(path).replace(/\\/g, '/');
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  const rest = normalized.slice(root.length + 1);
  const [host, ...segments] = rest.split('/');
  if (!host || !isKnownHost(host)) return null;
  return { host, path: `/${segments.filter(Boolean).join('/')}` };
}

/** Create the stand-in directory (idempotent) and return its absolute path. */
export function ensureMountDir(host, remotePath) {
  const dir = mountPathFor(host, remotePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read `presence://<host>/<path>` back as (host, path), or null. */
export function parsePresenceUrl(value) {
  const match = /^presence:\/\/([^/]+)(\/.*)?$/.exec(String(value));
  if (!match) return null;
  const host = match[1];
  if (!isKnownHost(host)) return null;
  return { host, path: normalizeRemotePath(match[2] ?? '/') };
}

/**
 * Resolve any spelling of a remote path to `{ host, path }`, or null when the
 * input is not remote at all (a plain local path in a local session).
 *
 * Accepted, in order:
 *  - `presence://host/abs/path`
 *  - a local mount path `<mountsRoot>/host/abs/path`
 *  - a POSIX absolute path `/abs/path` while the session is on a remote host
 *  - a relative path while the session is on a remote host (joined to its root)
 *
 * @param cwd - the session working directory (may be a mount path).
 * @param input - the caller's path spelling.
 */
export function resolveRemoteInput(cwd, input) {
  const value = String(input ?? '');
  const viaUrl = parsePresenceUrl(value);
  if (viaUrl) return viaUrl;

  const viaMount = parseMountPath(value);
  if (viaMount) return viaMount;

  const mounted = cwd ? parseMountPath(cwd) : null;
  if (!mounted) return null;

  // A Windows drive path or a UNC path is always local, even when the session
  // runs in a remote workspace: only POSIX absolute spellings mean "remote".
  // Without this, presenting/reading a real local file (e.g. an export under
  // %TEMP%) would be rewritten into a nonexistent remote path.
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return null;

  if (value.startsWith('/')) return { host: mounted.host, path: normalizeRemotePath(value) };
  if (value === '' || value === '.') return { host: mounted.host, path: mounted.path };
  return { host: mounted.host, path: normalizeRemotePath(`${mounted.path}/${value}`) };
}


