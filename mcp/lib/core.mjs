// Shared runtime for the Presence MCP server: settings, connection pool, host
// and path resolution, output formatting. Imports only the vendored copy of the
// plugin kernel (mcp/src/core, mcp/src/pool.js, ...); never from src/tools.js or
// index.js. `scripts/sync-kernel.mjs` keeps that copy identical to ../../src.

import { homedir } from 'node:os';
import { isAbsolute, resolve as resolveLocal } from 'node:path';
import { posix } from 'node:path';

import { PresencePool } from '../src/pool.js';
import { listHosts } from '../src/core/ssh-config.mjs';
import { parsePresenceUrl, normalizeRemotePath } from '../src/mounts.js';

// ---------------------------------------------------------------- settings
function numberFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

export const settings = {
  maxChannels: numberFromEnv('PRESENCE_MAX_CHANNELS', 8, { min: 1, max: 64 }),
  connectTimeoutMs: numberFromEnv('PRESENCE_CONNECT_TIMEOUT_MS', 25_000, { min: 1_000 }),
  idleTimeoutMs: numberFromEnv('PRESENCE_IDLE_TIMEOUT_MS', 900_000, { min: 10_000 }),
  readOnly: process.env.PRESENCE_READ_ONLY === '1',
  defaultHost: (process.env.PRESENCE_HOST || '').trim() || null,
  defaultCwd: (process.env.PRESENCE_CWD || '').trim() || null,
  // host:/abs/path — a remote project root used for relative paths.
  workspace: (() => {
    const raw = (process.env.PRESENCE_WORKSPACE || '').trim();
    if (!raw) return null;
    const match = /^([^:]+):(\/.*)$/u.exec(raw);
    if (!match) return { host: null, path: normalizeRemotePath(raw) };
    return { host: match[1], path: normalizeRemotePath(match[2]) };
  })(),
  sessionId: (process.env.PRESENCE_SESSION || `mcp-${process.pid}`).trim(),
};

// -------------------------------------------------------------------- pool
let poolInstance = null;

export function getPool() {
  if (!poolInstance) {
    poolInstance = new PresencePool({
      maxChannels: settings.maxChannels,
      connectTimeoutMs: settings.connectTimeoutMs,
      idleTimeoutMs: settings.idleTimeoutMs,
      readOnly: settings.readOnly,
    });
    const dispose = () => {
      try {
        poolInstance?.dispose();
      } catch {
        /* best effort */
      }
    };
    process.once('exit', dispose);
    process.once('SIGINT', () => {
      dispose();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      dispose();
      process.exit(143);
    });
  }
  return poolInstance;
}

// ------------------------------------------------------------------- hosts
export function knownHosts() {
  return listHosts().map((entry) => ({
    alias: entry.alias,
    hostname: entry.hostname,
    port: entry.port,
    user: entry.user ?? null,
    source: entry.source ?? 'config',
  }));
}

/** Resolve which machine a call targets, or throw a message the agent can act on. */
export function pickHost(args = {}) {
  const explicit = typeof args.host === 'string' ? args.host.trim() : '';
  if (explicit) return explicit;
  if (settings.workspace?.host) return settings.workspace.host;
  if (settings.defaultHost) return settings.defaultHost;
  const hosts = knownHosts();
  const available = hosts.map((entry) => entry.alias).join(', ') || 'none';
  throw new Error(
    `no host given: pass "host" (a name from ~/.ssh/config or the manual host list), ` +
      `or set PRESENCE_HOST / PRESENCE_WORKSPACE. Available: ${available}`,
  );
}

// ------------------------------------------------------------------- paths
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/u;

/**
 * Resolve a path the agent gave us into an absolute remote path:
 * presence://host/path, ~/x, POSIX absolute, or workspace-relative.
 */
export async function remotePath(connection, input, { base = null } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('path is required');
  const viaUrl = raw.startsWith('presence://') ? parsePresenceUrl(raw) : null;
  if (raw.startsWith('presence://')) {
    if (!viaUrl) throw new Error(`"${raw}" is not a valid presence path (unknown host or malformed URL)`);
    return normalizeRemotePath(viaUrl.path);
  }
  if (WINDOWS_PATH.test(raw) || raw.startsWith('\\\\')) {
    throw new Error(`"${raw}" looks like a local Windows path; this tool operates on the remote machine`);
  }
  if (raw === '~') return connection.homePath();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return posix.join(await connection.homePath(), raw.slice(2).replaceAll('\\', '/'));
  }
  const normalized = raw.replaceAll('\\', '/');
  if (isAbsolute(normalized)) return normalizeRemotePath(normalized);
  const root = base ?? workspaceRoot();
  if (!root) {
    throw new Error(
      `relative path "${raw}" needs a workspace root: pass an absolute path, or set ` +
        `PRESENCE_WORKSPACE=host:/abs/path (or PRESENCE_CWD=/abs/path)`,
    );
  }
  return posix.join(root, normalized);
}

export function workspaceRoot() {
  return settings.workspace?.path ?? settings.defaultCwd ?? null;
}

/** cwd for exec: explicit argument, else workspace root, else the remote home. */
export async function execCwd(connection, requested) {
  if (requested) return remotePath(connection, requested);
  return workspaceRoot();
}

// ------------------------------------------------------------------ format
export const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

export function clip(text, cap = 16 * 1024) {
  const value = String(text ?? '');
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n… [truncated ${value.length - cap} chars]`;
}

export function clipMiddle(text, cap = 16 * 1024) {
  const value = String(text ?? '');
  if (value.length <= cap) return value;
  const half = Math.floor((cap - 64) / 2);
  return `${value.slice(0, half)}\n… [${value.length - cap} chars omitted] …\n${value.slice(-half)}`;
}

export function parseMode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  const text = String(value).trim();
  const match = /^(?:0o)?0?([0-7]{3,4})$/u.exec(text);
  if (!match) throw new Error(`mode must be octal such as 755 or 0o644, got "${value}"`);
  return Number.parseInt(match[1], 8);
}

export function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value < 0) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return index === 0 ? `${size} B` : `${size.toFixed(1)} ${units[index]}`;
}

export function formatMtime(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function joinLocalPath(...parts) {
  return resolveLocal(...parts);
}

export function expandLocalHome(input) {
  const raw = String(input ?? '').trim();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolveLocal(homedir(), raw.slice(2));
  return resolveLocal(raw);
}
