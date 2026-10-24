// Persistent record of "this session has seen this remote file at version X".
//
// The harness read-before-edit guard keeps its state in a WeakMap keyed by the
// live Session object, so a resumed/compacted agent loses it and the model is
// forced to re-read huge files. We keep an independent record on disk and, just
// before a built-in edit/write, re-publish the observation when the file is
// still at the recorded version. Safety is preserved: if the file changed since
// the read, nothing is repaired and the guard still refuses.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_SESSION = 500;

function storePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'presence', 'observed.json');
}

function emptyStore() {
  return { version: 1, sessions: {} };
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.sessions) return parsed;
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
    writeFileSync(temporary, JSON.stringify(store));
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

/** Remember that `sessionId` saw `targetKey` at `version`. */
export function recordObservation(sessionId, targetKey, version) {
  if (!sessionId || !targetKey) return;
  const store = load();
  store.sessions[sessionId] ??= {};
  store.sessions[sessionId][targetKey] = { version, at: Date.now() };
  prune(store);
  save(store);
}

/** Version this session recorded for `targetKey`, or null when unseen/stale. */
export function lookupObservation(sessionId, targetKey) {
  if (!sessionId || !targetKey) return null;
  const store = load();
  const entry = store.sessions[sessionId]?.[targetKey];
  if (!entry) return null;
  if (Date.now() - entry.at > MAX_AGE_MS) return null;
  return entry.version ?? null;
}
