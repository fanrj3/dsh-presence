// Pure helpers for the Presence 0.21 client wait dock (no DOM, no React, no
// fetch) so the tricky parts can be checked by scripts/wait-ui-probe.mjs:
//
//   - `/presence/api/waits` payload tolerance (new SHAPE, old host garbage);
//   - finished-entry retention (finished rows stay 10 s client-side);
//   - collapsed / expanded / hidden presentation thresholds;
//   - progress formatting and ETA maths from the last <= 60 s of samples.
//
// app.js renders everything and owns polling; it imports these helpers.

export const WAIT_STATES = ['running', 'done', 'timeout', 'error'];
export const FINISHED_HOLD_MS = 10_000;
export const POLL_EXPANDED_MS = 1_500;
export const POLL_COLLAPSED_MS = 5_000;
export const ETA_WINDOW_MS = 60_000;
export const SAMPLE_CAP = 240;
export const MAX_LAST_LINE = 400;

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const finiteOrNull = finiteNumber;
const stringOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Coerce a timestamp; invalid values fall back to `fallback`. */
export function normalizeTimestamp(value, fallback = 0) {
  const number = finiteNumber(value);
  return number === null ? fallback : number;
}

/** "03:07" (mm:ss, total minutes so a 1 h wait is "60:00"), never negative. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((finiteNumber(ms) ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Compact duration for ETA/timeout chips: "42s", "3m", "2h 5m", "0s". */
export function formatDurationShort(ms) {
  const totalMs = Math.max(0, finiteNumber(ms) ?? 0);
  const seconds = Math.round(totalMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Local wall clock "14:05:09"; empty string for an invalid timestamp. */
export function formatClock(at) {
  const value = finiteNumber(at);
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One progress object from the API, tolerant of missing/garbage fields. */
export function normalizeProgress(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const done = finiteNumber(source.done);
  const total = finiteNumber(source.total);
  return {
    done: done !== null && done >= 0 ? done : null,
    total: total !== null && total >= 0 ? total : null,
    unit: stringOrNull(source.unit),
    note: stringOrNull(source.note),
  };
}

/** Samples from the API: numeric at/done/total only, sorted, capped, deduped. */
export function normalizeSamples(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const at = finiteNumber(item.at);
    if (at === null) continue;
    const done = finiteNumber(item.done);
    const total = finiteNumber(item.total);
    if (done === null && total === null) continue;
    if (at === lastAt) {
      // Keep the newest reading for a duplicated timestamp.
      rows[rows.length - 1] = { at, done: done ?? null, total: total ?? null };
      continue;
    }
    if (at < lastAt) {
      // Out-of-order single sample: ignore rather than re-sorting every poll
      // (the host emits ascending timestamps; a glitch is not worth trusting).
      continue;
    }
    rows.push({ at, done: done ?? null, total: total ?? null });
    lastAt = at;
  }
  return rows.slice(-SAMPLE_CAP);
}

/**
 * Normalise one wait entry. `fallbackNow` is used when startedAt/updatedAt are
 * missing. Returns null for entries without a usable id.
 */
export function normalizeWait(raw, fallbackNow = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = stringOrNull(raw.id);
  if (!id) return null;
  const startedAt = normalizeTimestamp(raw.startedAt, fallbackNow);
  const updatedAt = normalizeTimestamp(raw.updatedAt, startedAt);
  const metaSource = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {};
  const meta = {};
  for (const key of ['jobId', 'condition', 'logPath', 'command']) {
    const value = stringOrNull(metaSource[key]);
    if (value !== null) meta[key] = value;
  }
  const state = WAIT_STATES.includes(raw.state) ? raw.state : 'running';
  const lastLine = typeof raw.lastLine === 'string' && raw.lastLine.trim() !== ''
    ? raw.lastLine.slice(0, MAX_LAST_LINE)
    : null;
  return {
    id,
    kind: raw.kind === 'wait' ? 'wait' : 'job',
    host: stringOrNull(raw.host),
    label: stringOrNull(raw.label) ?? id,
    startedAt,
    updatedAt,
    timeoutMs: finiteOrNull(raw.timeoutMs),
    state,
    meta,
    progress: normalizeProgress(raw.progress),
    lastLine,
    exitCode: finiteOrNull(raw.exitCode),
    error: stringOrNull(raw.error),
    samples: normalizeSamples(raw.samples),
  };
}

/**
 * Parse GET /waits: `{ ok, now, waits:[...] }`. A missing/invalid list, an old
 * host error payload or junk entries never throw — they collapse to empty rows.
 */
export function normalizeWaitsPayload(payload, fallbackNow = Date.now()) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const now = normalizeTimestamp(source.now, fallbackNow);
  const rows = Array.isArray(source.waits) ? source.waits : [];
  const waits = [];
  for (const row of rows) {
    const wait = normalizeWait(row, now);
    if (wait) waits.push(wait);
  }
  return { now, waits };
}

export function waitIsFinished(wait) {
  return Boolean(wait) && wait.state !== 'running';
}

/**
 * Running entries are always visible. Finished ones stay for `holdMs` after
 * their frozen updatedAt (10 s by default) and then disappear client-side.
 * A missing timestamp on a finished row is hidden instead of sticking forever.
 */
export function waitVisible(wait, now = Date.now(), holdMs = FINISHED_HOLD_MS) {
  if (!wait) return false;
  if (!waitIsFinished(wait)) return true;
  const finishedAt = finiteNumber(wait.updatedAt);
  if (finishedAt === null) return false;
  const age = now - finishedAt;
  // Negative age means the host clock is ahead: treat it as just finished.
  return age < holdMs;
}

export function filterVisibleWaits(waits, now = Date.now(), holdMs = FINISHED_HOLD_MS) {
  return (Array.isArray(waits) ? waits : []).filter((wait) => waitVisible(wait, now, holdMs));
}

/**
 * Decide what the dock shows: hidden, collapsed pill or expanded card, plus the
 * counts and the polling interval that goes with it.
 */
export function dockPresentation({ expanded = false, waits = [], now = Date.now(), holdMs = FINISHED_HOLD_MS } = {}) {
  const visible = filterVisibleWaits(waits, now, holdMs);
  const running = visible.filter((wait) => wait.state === 'running').length;
  const finished = visible.length - running;
  return {
    mode: visible.length === 0 ? 'hidden' : expanded ? 'expanded' : 'collapsed',
    visible,
    running,
    finished,
    showSpinner: running > 0,
    pollMs: expanded ? POLL_EXPANDED_MS : POLL_COLLAPSED_MS,
  };
}

/** Progress as a 0..1 ratio clamped to [0,1], or null without a usable total. */
export function progressRatio(progress) {
  const done = finiteNumber(progress?.done);
  const total = finiteNumber(progress?.total);
  if (done === null || total === null || total <= 0) return null;
  return clamp(done / total, 0, 1);
}

/** "12/100 steps", "12 steps", "80 bytes" or the free-form note; null if empty. */
export function formatProgress(progress) {
  const done = finiteNumber(progress?.done);
  const total = finiteNumber(progress?.total);
  const unit = stringOrNull(progress?.unit);
  const note = stringOrNull(progress?.note);
  if (done !== null && total !== null) return `${done}/${total}${unit ? ` ${unit}` : ''}`;
  if (done !== null) return `${done}${unit ? ` ${unit}` : ''}`;
  if (note !== null) return note;
  return null;
}

/**
 * ETA from the last <= `windowMs` of samples (default 60 s):
 *   rate = (last.done - first.done) / seconds between them
 *   eta  = (total - done) / rate
 *
 * Returns `{ etaMs, ratePerSecond, used, firstAt, lastAt, spanMs, remaining,
 * reason }`. `reason` is null when computed, else one of
 * 'non-numeric' | 'insufficient' | 'stalled' | 'complete'. A zero or negative
 * rate is 'stalled' (never Infinity); fewer than two usable samples is
 * 'insufficient'.
 */
export function computeEta(samples, options = {}) {
  const now = normalizeTimestamp(options.now, Date.now());
  const windowMs = Math.max(0, finiteNumber(options.windowMs) ?? ETA_WINDOW_MS);
  const done = finiteNumber(options.done ?? null);
  const total = finiteNumber(options.total ?? null);
  const empty = {
    etaMs: null,
    ratePerSecond: null,
    used: 0,
    firstAt: null,
    lastAt: null,
    spanMs: 0,
    remaining: null,
    reason: 'non-numeric',
  };
  if (done === null || total === null) return empty;
  const remaining = total - done;
  if (remaining <= 0) {
    return { ...empty, remaining: 0, etaMs: 0, reason: 'complete' };
  }

  const usable = normalizeSamples(samples)
    .filter((sample) => sample.done !== null && sample.at >= now - windowMs && sample.at <= now + 1_000);
  if (usable.length < 2) return { ...empty, remaining, used: usable.length, reason: 'insufficient' };

  const first = usable[0];
  const last = usable[usable.length - 1];
  const spanMs = last.at - first.at;
  if (!(spanMs > 0)) return { ...empty, remaining, used: usable.length, reason: 'insufficient' };
  const delta = last.done - first.done;
  const ratePerSecond = delta / (spanMs / 1000);
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    return {
      ...empty,
      ratePerSecond: Number.isFinite(ratePerSecond) ? ratePerSecond : null,
      used: usable.length,
      firstAt: first.at,
      lastAt: last.at,
      spanMs,
      remaining,
      reason: 'stalled',
    };
  }
  const etaMs = (remaining / ratePerSecond) * 1000;
  return {
    etaMs: Number.isFinite(etaMs) ? Math.max(0, etaMs) : null,
    ratePerSecond,
    used: usable.length,
    firstAt: first.at,
    lastAt: last.at,
    spanMs,
    remaining,
    reason: Number.isFinite(etaMs) ? null : 'insufficient',
  };
}

/**
 * Downsample samples for detail/sparkline display: optional time window, at
 * most `maxPoints` newest rows, still ascending. Never throws on junk input.
 */
export function reduceSamples(samples, { windowMs = null, maxPoints = 24, now = Date.now() } = {}) {
  const cap = Math.max(1, Math.floor(finiteNumber(maxPoints) ?? 24));
  const window = finiteNumber(windowMs);
  const rows = normalizeSamples(samples).filter((sample) => (
    window === null || sample.at >= now - Math.max(0, window)
  ));
  if (rows.length <= cap) return rows;
  // Keep both ends so the sparkline does not lose the current reading.
  const stride = (rows.length - 1) / (cap - 1);
  const picked = [];
  for (let index = 0; index < cap; index += 1) {
    picked.push(rows[Math.round(index * stride)]);
  }
  return picked;
}

/** Elapsed since startedAt, floored at 0 (never negative on clock skew). */
export function elapsedMs(wait, now = Date.now()) {
  if (!wait) return 0;
  const startedAt = finiteNumber(wait.startedAt);
  if (startedAt === null) return 0;
  return Math.max(0, (finiteNumber(now) ?? Date.now()) - startedAt);
}

/**
 * One-line label for the collapsed pill: "3 个等待 · build the kernel", using
 * the first running wait (or the first finished one when only those remain).
 */
export function pillLabelText(visible, maxLabel = 42) {
  const list = Array.isArray(visible) ? visible : [];
  if (list.length === 0) return null;
  const first = list.find((wait) => wait.state === 'running') ?? list[0];
  const label = String(first.label ?? '').trim();
  if (!label) return null;
  const clipped = label.length > maxLabel ? `${label.slice(0, maxLabel - 1)}…` : label;
  return { count: list.length, label: clipped };
}
