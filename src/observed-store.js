// Persistent record of "this session has seen this remote file at version X".
//
// The harness read-before-edit guard keeps its state in a per-plugin WeakMap
// keyed by the live Session object, so a resumed/compacted agent loses it and
// the model is forced to re-read huge files. We keep an independent record on
// disk and, just before a built-in edit/write, re-publish the observation when
// the file is still at the recorded version. Safety is preserved: if the file
// changed since the read, nothing is repaired and the guard still refuses.
//
// 0.20: keys are canonical. One remote file has many spellings — a
// `presence://host/path` URL, a local mount path, a relative path inside the
// workspace, or a remote absolute path — and the guard only matches when every
// spelling becomes the same `{ host, remotePath }` identity. The canonical key
// is exactly the `presence://` target key the fs provider hands the policy, so
// an observation recorded through presence_read repairs a built-in edit of the
// same file. Local (non-remote) observations keep their provider target key.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeRemotePath, parseMountPath, parsePresenceUrl } from './mounts.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_SESSION = 500;
const STORE_VERSION = 2;

function storePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'presence', 'observed.json');
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: {} };
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && (parsed.version === 1 || parsed.version === STORE_VERSION)) {
      return parsed;
    }
  } catch {
    /* missing or corrupt: start clean */
  }
  return emptyStore();
}

function save(store) {
  try {
    const target = storePath();
    mkdirSync(join(target, '..'), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ ...store, version: STORE_VERSION }));
    renameSync(temporary, target);
  } catch {
    /* the record is an optimization; never fail a tool because of it */
  }
}

function prune(store) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [sessionId, entries] of Object.entries(store.sessions)) {
    const kept = Object.entries(entries)
      .filter(([, value]) => value && value.at > cutoff)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES_PER_SESSION);
    if (kept.length === 0) delete store.sessions[sessionId];
    else store.sessions[sessionId] = Object.fromEntries(kept);
  }
}

/** Canonical `presence://host/absolute-path` key for one remote identity. */
function makeCanonical(host, remotePath) {
  const alias = String(host ?? '').trim();
  if (!alias) return null;
  const path = normalizeRemotePath(remotePath);
  return { host: alias, remotePath: path, key: `presence://${alias}${path}` };
}

/**
 * Resolve any spelling of a remote path to its canonical `{ host, remotePath,
 * key }`, or null when the input is not a remote path.
 *
 * Accepted:
 *  - `presence://host/abs/path` (scheme is case-insensitive)
 *  - a local mount path `<mountsRoot>/host/abs/path`
 *  - an absolute POSIX path when `host` is known (explicit host / mounted cwd)
 *  - a relative path joined to the mounted cwd's remote folder
 *  - an object with `targetKey`, or with `host` plus `path`/`remotePath`
 *
 * Local Windows paths and anything that cannot name a remote file stay null.
 */
export function canonicalObservation(input, { cwd = null, host = null } = {}) {
  const explicitHost = typeof host === 'string' && host.trim() ? host.trim() : null;
  if (input && typeof input === 'object') {
    const targetKey = typeof input.targetKey === 'string' ? input.targetKey : null;
    const directHost = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null;
    const directPath =
      typeof input.remotePath === 'string' ? input.remotePath : typeof input.path === 'string' ? input.path : null;
    if (targetKey) {
      const viaTarget = canonicalObservation(targetKey, { cwd, host: directHost ?? explicitHost });
      if (viaTarget) return viaTarget;
    }
    if (directHost && directPath) return makeCanonical(directHost, directPath);
    return null;
  }

  const value = String(input ?? '').trim();
  if (!value) return null;

  // One spelling of `presence://` may have a different scheme case.
  let viaUrl = parsePresenceUrl(value);
  if (!viaUrl && /^presence:/i.test(value)) viaUrl = parsePresenceUrl(value.replace(/^presence:/i, 'presence:'));
  if (viaUrl) return makeCanonical(viaUrl.host, viaUrl.path);

  const viaMount = parseMountPath(value);
  if (viaMount) return makeCanonical(viaMount.host, viaMount.path);

  // A Windows drive/UNC path is local even when a session is remote.
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return null;

  const mounted = cwd ? parseMountPath(cwd) : null;
  if (value.startsWith('/')) {
    const targetHost = explicitHost ?? mounted?.host ?? null;
    if (!targetHost) return null;
    return makeCanonical(targetHost, value);
  }
  if (mounted && (!explicitHost || explicitHost === mounted.host)) {
    if (value === '.' || value === './') return makeCanonical(mounted.host, mounted.path);
    return makeCanonical(mounted.host, `${mounted.path}/${value.replace(/\\/gu, '/')}`);
  }
  return null;
}

/** The canonical string key for one remote identity, or null. */
export function canonicalObservationKey(input, options = {}) {
  return canonicalObservation(input, options)?.key ?? null;
}

/** The stored entry for `target` in this session, or null when unseen/stale. */
function lookupEntry(sessionId, target, options = {}) {
  if (!sessionId || !target) return null;
  const store = load();
  const entries = store.sessions[sessionId];
  if (!entries) return null;
  const keys = [];
  const canonical = canonicalObservation(target, options);
  if (canonical) keys.push(canonical.key);
  // Keep the legacy spelling working: 0.19 wrote the raw provider target key.
  if (typeof target === 'string') keys.push(target);
  else if (target && typeof target.targetKey === 'string') keys.push(target.targetKey);
  for (const key of keys) {
    const entry = entries[key];
    if (!entry) continue;
    if (Date.now() - entry.at > MAX_AGE_MS) return null;
    return entry;
  }
  return null;
}

/**
 * Remember that `sessionId` saw `target` at `version`. `target` accepts every
 * spelling canonicalObservation does; `options.cwd`/`options.host` supply the
 * session context when the spelling is relative or bare-absolute.
 */
export function recordObservation(sessionId, target, version, options = {}) {
  if (!sessionId || !target) return;
  const canonical = canonicalObservation(target, options);
  const fallback = typeof target === 'string' ? target : typeof target?.targetKey === 'string' ? target.targetKey : null;
  const key = canonical?.key ?? fallback;
  if (!key) return;
  const store = load();
  store.sessions[sessionId] ??= {};
  store.sessions[sessionId][key] = {
    version,
    at: Date.now(),
    ...(canonical ? { host: canonical.host, remotePath: canonical.remotePath } : {}),
  };
  prune(store);
  save(store);
}

/** Version this session recorded for `target`, or null when unseen/stale. */
export function lookupObservation(sessionId, target, options = {}) {
  const entry = lookupEntry(sessionId, target, options);
  if (!entry) return null;
  return entry.version ?? null;
}

/** Host/path of a stored observation (diagnostics and probes), or null. */
export function describeObservation(sessionId, target, options = {}) {
  const entry = lookupEntry(sessionId, target, options);
  if (!entry) return null;
  return { version: entry.version ?? null, host: entry.host ?? null, remotePath: entry.remotePath ?? null, at: entry.at ?? null };
}
