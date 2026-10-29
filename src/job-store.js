// Persistent registry of background jobs.
//
// A detached job outlives the tool call that started it and the Harness
// process that started it. The live pool keeps jobs in memory for its lifetime;
// this JSON store is what makes them visible again after a restart. It lives
// under ~/.dsh/presence next to the other Presence stores, is written atomically
// (temp file + rename, 0600) and is bounded in size, so it cannot grow forever.
//
// Shapes (frozen by .scratch/feat-0.20/CONTRACTS-0.20.md):
//   { id, host, label, command, sessionId, pid, pgid, logPath, commandLogPath,
//     startedAt, exitedAt, exitCode, exitSignal, state }
//
// `state` is one of running | exited | unknown. A record read back from disk is
// never trusted as `running`: the pool demotes non-exited records to `unknown`
// until a pid liveness probe actually finds the process group.
//
// Deliberate additions for restart trust (both optional, documented in the
// 0.20 report): `statusPath` (the wrapper's exit-status file, without which a
// job that ended while the app was down could never report its exit code) and
// `cwd` (kept for the process listing/seed path).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Hard bound on the store, whatever the caller's prune settings say. */
export const MAX_JOB_RECORDS = 500;
/** Retention for finished jobs: a month is long enough to come back to a run. */
export const MAX_JOB_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SIZE = 100;
const MAX_COMMAND = 8 * 1024;
const MAX_PATH = 4 * 1024;
const MAX_LABEL = 160;
const MAX_SESSION = 200;

export const JOB_STATES = new Set(['running', 'exited', 'unknown']);

function storeDirectory() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'presence');
}

/** Absolute path of the job registry. `PRESENCE_JOBS_FILE` overrides it (probes). */
export function jobsFile() {
  return process.env.PRESENCE_JOBS_FILE || join(storeDirectory(), 'jobs.json');
}

function text(value, limit) {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > limit ? value.slice(0, limit) : value;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateOf(value) {
  const state = String(value ?? '').toLowerCase();
  if (state === 'stopped' || state === 'killed') return 'exited';
  return JOB_STATES.has(state) ? state : 'unknown';
}

/** Tolerant reading of one stored record; a bad row is dropped instead of thrown. */
function recordFromStored(item) {
  try {
    if (!item || typeof item !== 'object') return null;
    const id = text(item.id, MAX_SIZE);
    const host = text(item.host, MAX_SIZE);
    if (!id || !host) return null;
    const pid = numberOrNull(item.pid);
    const startedAt = numberOrNull(item.startedAt);
    const exitedAt = numberOrNull(item.exitedAt);
    return {
      id,
      host,
      label: text(item.label, MAX_LABEL),
      command: text(item.command, MAX_COMMAND),
      sessionId: text(item.sessionId, MAX_SESSION),
      pid: pid === null ? null : Math.trunc(pid),
      pgid: numberOrNull(item.pgid) === null ? (pid === null ? null : Math.trunc(pid)) : Math.trunc(numberOrNull(item.pgid)),
      logPath: text(item.logPath, MAX_PATH),
      commandLogPath: text(item.commandLogPath, MAX_PATH),
      statusPath: text(item.statusPath, MAX_PATH),
      cwd: text(item.cwd, MAX_PATH),
      startedAt: startedAt === null ? null : Math.trunc(startedAt),
      exitedAt: exitedAt === null ? null : Math.trunc(exitedAt),
      exitCode: numberOrNull(item.exitCode) === null ? null : Math.trunc(numberOrNull(item.exitCode)),
      exitSignal: numberOrNull(item.exitSignal) === null ? null : Math.trunc(numberOrNull(item.exitSignal)),
      state: stateOf(item.state),
    };
  } catch {
    return null;
  }
}

/** Count back from the newest record so a store stays useful after truncation. */
function sortNewestFirst(left, right) {
  const finished = (record) => record.exitedAt ?? record.startedAt ?? 0;
  return finished(right) - finished(left);
}

/** Bound one record before it is written: long commands must not bloat the file. */
function normalizeRecord(input) {
  return recordFromStored(input);
}

function emptyStore() {
  return { version: 1, jobs: [] };
}

/**
 * Move a corrupt store out of the way instead of losing the user's job history
 * to the next write, then start from scratch. Never throws: a failed rename (a
 * read-only home, say) leaves the next load to fail the same harmless way.
 */
function quarantineCorruptStore(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    renameSync(file, `${file}.corrupt-${stamp}`);
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* the next successful save replaces it */
    }
  }
}

/** Read every record; a missing, unreadable or corrupt file yields `[]`. */
export function loadJobRecords() {
  const file = jobsFile();
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantineCorruptStore(file);
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  const byId = new Map();
  for (const item of items) {
    const record = recordFromStored(item);
    if (!record) continue;
    byId.set(record.id, record);
  }
  return [...byId.values()].slice(0, MAX_JOB_RECORDS);
}

/** Atomically replace the store (temp file + rename, 0600 like the other stores). */
export function saveJobRecords(records) {
  const normalized = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(records) ? records : [])].sort(sortNewestFirst)) {
    const record = normalizeRecord(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    normalized.push(record);
  }
  const bounded = normalized.slice(0, MAX_JOB_RECORDS);
  const file = jobsFile();
  mkdirSync(storeDirectory(), { recursive: true });
  const payload = `${JSON.stringify({ version: 1, jobs: bounded }, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    // Windows can refuse renaming over a file another process holds open. Fall
    // back to a direct write so the save still lands, then drop the temp file.
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 });
  }
  return bounded;
}

/** Create or replace one record (identity is `id`). */
export function upsertJobRecord(record) {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error('a job record needs at least id and host');
  const records = loadJobRecords();
  const index = records.findIndex((entry) => entry.id === normalized.id);
  if (index >= 0) records[index] = normalized;
  else records.unshift(normalized);
  saveJobRecords(records);
  return normalized;
}

/** Every stored record, optionally narrowed to one session. Newest first. */
export function listJobRecords({ sessionId = undefined } = {}) {
  return loadJobRecords()
    .filter((record) => sessionId === undefined || record.sessionId === sessionId)
    .sort(sortNewestFirst);
}

/** Forget one record. Returns whether it existed. */
export function removeJobRecord(id) {
  const records = loadJobRecords();
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) return false;
  saveJobRecords(next);
  return true;
}

/**
 * Bound the store: drop finished jobs older than `maxAgeMs` first, then the
 * oldest finished jobs beyond `maxEntries`. Running records are the only truth
 * about a live process and are kept; if they alone exceed the hard bound, the
 * oldest are dropped last so the file still cannot grow without limit.
 *
 * Returns the removed ids (deterministic order).
 */
export function pruneJobRecords({ maxAgeMs = MAX_JOB_AGE_MS, maxEntries = MAX_JOB_RECORDS } = {}) {
  const records = loadJobRecords();
  const age = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : MAX_JOB_AGE_MS;
  const limit = Number.isFinite(Number(maxEntries))
    ? Math.max(0, Math.min(MAX_JOB_RECORDS, Math.floor(Number(maxEntries))))
    : MAX_JOB_RECORDS;
  const now = Date.now();
  const finished = (record) => record.exitedAt ?? record.startedAt ?? 0;
  const dropped = new Set();
  for (const record of records) {
    if (record.state === 'exited' && now - finished(record) >= age) dropped.add(record.id);
  }
  let kept = records.filter((record) => !dropped.has(record.id));
  const newest = [...kept].sort(sortNewestFirst);
  for (const record of newest.slice(limit)) {
    if (record.state === 'exited') dropped.add(record.id);
  }
  kept = records.filter((record) => !dropped.has(record.id));
  if (kept.length > MAX_JOB_RECORDS) {
    const oldestFirst = [...kept].sort((left, right) => finished(left) - finished(right));
    for (const state of ['exited', 'unknown', 'running']) {
      for (const record of oldestFirst) {
        if (kept.length <= MAX_JOB_RECORDS) break;
        if (dropped.has(record.id) || record.state !== state) continue;
        dropped.add(record.id);
        kept = kept.filter((entry) => entry.id !== record.id);
      }
      if (kept.length <= MAX_JOB_RECORDS) break;
    }
  }
  if (dropped.size > 0) saveJobRecords(kept);
  return { removed: dropped.size, ids: [...dropped] };
}

/**
 * File-backed owner of the job registry. All state lives in the JSON file, so a
 * second instance (or a probe) sees exactly what the plugin sees.
 */
export class JobStore {
  /** Absolute store path, exposed for diagnostics and probes. */
  get file() {
    return jobsFile();
  }

  load() {
    return loadJobRecords();
  }

  list(query = {}) {
    return listJobRecords(query);
  }

  save(records) {
    return saveJobRecords(records);
  }

  upsert(record) {
    return upsertJobRecord(record);
  }

  remove(id) {
    return removeJobRecord(id);
  }

  prune(options = {}) {
    return pruneJobRecords(options);
  }
}
