// The wait registry: what `presence_jobs {action:'wait'}` and `presence_wait`
// are currently waiting for, plus a short history of finished waits.
//
// The client renders this as a floating dock (`GET /presence/api/waits`), so the
// entries are plain JSON: a tool call is the only writer, the Web UI is the only
// reader, and a wait that timed out is as interesting as one that met.
//
// Lifecycle: `begin` when the wait starts, `update` on every poll (progress +
// last log line), `end` when it stops. Finished entries linger for
// `keepFinishedMs` so the dock can show "done/timeout" briefly; a hard
// `maxEntries` cap keeps a long-lived app bounded even if nothing prunes.
//
// Nothing in here may throw into a tool call: an unknown id is a no-op and an
// unrepresentable patch is ignored, because losing a progress sample is always
// better than failing the wait.

/** How far apart two progress samples must be (the dock's ETA needs a few). */
const SAMPLE_MIN_GAP_MS = 500;
/** Samples retained per entry; with 500 ms spacing this is ~2 minutes of ETA data. */
const MAX_SAMPLES = 240;
const MAX_LABEL = 120;
const MAX_LAST_LINE = 300;
const MAX_META_VALUE = 500;
const MAX_ERROR = 500;
const MAX_UNIT = 40;
const MAX_KIND = 24;
const MAX_HOST = 128;

const STATES = new Set(['running', 'done', 'timeout', 'error']);
const META_KEYS = ['jobId', 'condition', 'logPath', 'command'];

function clipText(value, cap) {
  const text = String(value ?? '');
  return text.length > cap ? text.slice(0, cap) : text;
}

/** A finite number, or null. Strings are accepted because tool args are loose. */
function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeState(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STATES.has(text) ? text : null;
}

/** Keep the API/UI payload small: known keys only, values stringified. */
function sanitizeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const key of META_KEYS) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    let text;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    if (typeof text !== 'string') continue;
    out[key] = clipText(text, MAX_META_VALUE);
  }
  return out;
}

function normalizeProgressPatch(current, patch) {
  const next = {
    done: current.done,
    total: current.total,
    unit: current.unit,
    note: current.note,
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'done')) next.done = finiteNumber(patch.done);
  if (Object.prototype.hasOwnProperty.call(patch, 'total')) next.total = finiteNumber(patch.total);
  if (Object.prototype.hasOwnProperty.call(patch, 'unit')) {
    next.unit = typeof patch.unit === 'string' && patch.unit !== '' ? clipText(patch.unit, MAX_UNIT) : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
    next.note = typeof patch.note === 'string' && patch.note !== '' ? clipText(patch.note, MAX_LAST_LINE) : null;
  }
  return next;
}

/** A serializable copy, so callers can never mutate the registry's state. */
function cloneEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    host: entry.host,
    label: entry.label,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    timeoutMs: entry.timeoutMs,
    state: entry.state,
    meta: { ...entry.meta },
    progress: { ...entry.progress },
    lastLine: entry.lastLine,
    exitCode: entry.exitCode,
    error: entry.error,
    samples: entry.samples.map((sample) => ({ at: sample.at, done: sample.done, total: sample.total })),
  };
}

/**
 * Create the in-memory wait registry.
 *
 * @param options.keepFinishedMs - how long a finished entry stays visible (default 10 min).
 * @param options.maxEntries - hard cap on retained entries (default 50).
 * @returns `{ begin, update, end, list, get, clear, dispose }`; every method is
 *   safe to call with bad input and never throws.
 */
export function createWaitRegistry({ keepFinishedMs = 10 * 60_000, maxEntries = 50 } = {}) {
  const keepMs =
    Number.isFinite(Number(keepFinishedMs)) && Number(keepFinishedMs) >= 0 ? Number(keepFinishedMs) : 10 * 60_000;
  const cap = Number.isSafeInteger(Number(maxEntries)) && Number(maxEntries) > 0 ? Number(maxEntries) : 50;

  const entries = new Map();
  /** id -> time the entry was ended; presence means "frozen, no more updates". */
  const finishedAt = new Map();
  /** id -> last progress sample time, for the >=500 ms spacing rule. */
  const lastSampleAt = new Map();
  let counter = 0;
  let disposed = false;

  /** Sequence suffix of `w-<n>`, so ties on startedAt keep creation order. */
  const sequenceOf = (id) => {
    const match = /^w-(\d+)$/.exec(String(id));
    return match ? Number(match[1]) : 0;
  };

  const forget = (id) => {
    entries.delete(id);
    finishedAt.delete(id);
    lastSampleAt.delete(id);
  };

  /**
   * Drop expired finished entries, then enforce the hard cap (oldest finished
   * first, then oldest overall if a flood of still-running waits exceeds it).
   */
  const prune = () => {
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (entry.state === 'running') continue;
      const since = finishedAt.get(id) ?? entry.updatedAt;
      if (now - since > keepMs) forget(id);
    }
    if (entries.size <= cap) return;
    const oldestFirst = [...entries.values()].sort(
      (left, right) => left.startedAt - right.startedAt || sequenceOf(left.id) - sequenceOf(right.id),
    );
    for (const entry of oldestFirst) {
      if (entries.size <= cap) break;
      if (entry.state !== 'running') forget(entry.id);
    }
    for (const entry of oldestFirst) {
      if (entries.size <= cap) break;
      forget(entry.id);
    }
  };

  /** Apply a patch to a live entry; the caller has already resolved the entry. */
  const applyPatch = (entry, patch, at) => {
    if (!patch || typeof patch !== 'object') {
      entry.updatedAt = at;
      return;
    }
    if (patch.state !== undefined) {
      const state = normalizeState(patch.state);
      if (state !== null) entry.state = state;
    }
    if (patch.progress !== undefined && patch.progress && typeof patch.progress === 'object') {
      entry.progress = normalizeProgressPatch(entry.progress, patch.progress);
      const done = entry.progress.done;
      const total = entry.progress.total;
      const last = lastSampleAt.get(entry.id);
      if (
        (Number.isFinite(done) || Number.isFinite(total)) &&
        (last === undefined || at - last >= SAMPLE_MIN_GAP_MS)
      ) {
        entry.samples.push({
          at,
          done: Number.isFinite(done) ? done : null,
          total: Number.isFinite(total) ? total : null,
        });
        lastSampleAt.set(entry.id, at);
        if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
      }
    }
    if (patch.lastLine !== undefined) {
      entry.lastLine = patch.lastLine === null ? null : clipText(String(patch.lastLine), MAX_LAST_LINE) || null;
    }
    if (patch.exitCode !== undefined) {
      const exitCode = finiteNumber(patch.exitCode);
      if (exitCode !== null) entry.exitCode = Math.trunc(exitCode);
      else if (patch.exitCode === null) entry.exitCode = null;
    }
    if (patch.error !== undefined) {
      entry.error = patch.error === null ? null : clipText(String(patch.error), MAX_ERROR) || null;
    }
    entry.updatedAt = at;
  };

  const get = (id) => {
    try {
      if (disposed || id === undefined || id === null) return null;
      prune();
      const entry = entries.get(String(id));
      return entry ? cloneEntry(entry) : null;
    } catch {
      return null;
    }
  };

  const begin = (input = {}) => {
    if (disposed) return null;
    try {
      prune();
      const at = Date.now();
      counter += 1;
      const kind = typeof input.kind === 'string' && input.kind.trim() ? clipText(input.kind.trim(), MAX_KIND) : 'wait';
      const host =
        typeof input.host === 'string' && input.host.trim() ? clipText(input.host.trim(), MAX_HOST) : null;
      const label = clipText(
        typeof input.label === 'string' && input.label.trim() ? input.label.trim() : kind,
        MAX_LABEL,
      );
      const timeoutMs = finiteNumber(input.timeoutMs);
      const entry = {
        id: `w-${counter}`,
        kind,
        host,
        label,
        startedAt: at,
        updatedAt: at,
        timeoutMs: timeoutMs === null ? null : Math.max(0, Math.trunc(timeoutMs)),
        state: 'running',
        meta: sanitizeMeta(input.meta),
        progress: { done: null, total: null, unit: null, note: null },
        lastLine: null,
        exitCode: null,
        error: null,
        samples: [],
      };
      entries.set(entry.id, entry);
      // A flood of running waits is still bounded: the cap evicts the oldest.
      if (entries.size > cap) prune();
      return cloneEntry(entry);
    } catch {
      return null;
    }
  };

  const update = (id, patch = {}) => {
    try {
      if (disposed || id === undefined || id === null) return null;
      prune();
      const key = String(id);
      const entry = entries.get(key);
      if (!entry) return null;
      if (finishedAt.has(key)) return cloneEntry(entry);
      applyPatch(entry, patch, Date.now());
      return cloneEntry(entry);
    } catch {
      return null;
    }
  };

  const end = (id, patch = {}) => {
    try {
      if (disposed || id === undefined || id === null) return null;
      prune();
      const key = String(id);
      const entry = entries.get(key);
      if (!entry) return null;
      if (finishedAt.has(key)) return cloneEntry(entry);
      const at = Date.now();
      applyPatch(entry, patch, at);
      if (entry.state === 'running') entry.state = 'done';
      entry.updatedAt = at;
      finishedAt.set(key, at);
      lastSampleAt.delete(key);
      return cloneEntry(entry);
    } catch {
      return null;
    }
  };

  const list = ({ activeOnly = false } = {}) => {
    try {
      if (disposed) return [];
      prune();
      let rows = [...entries.values()];
      if (activeOnly) rows = rows.filter((entry) => entry.state === 'running');
      rows.sort((left, right) => left.startedAt - right.startedAt || sequenceOf(left.id) - sequenceOf(right.id));
      return rows.map(cloneEntry);
    } catch {
      return [];
    }
  };

  const clear = () => {
    try {
      entries.clear();
      finishedAt.clear();
      lastSampleAt.clear();
    } catch {
      /* clearing is best effort */
    }
  };

  const dispose = () => {
    try {
      disposed = true;
      clear();
    } catch {
      /* disposing is best effort */
    }
  };

  return { begin, update, end, list, get, clear, dispose };
}
