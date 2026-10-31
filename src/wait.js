// Poll one remote condition until it is true or the deadline passes.
//
// `presence_wait` has to answer "has the training run written its checkpoint?"
// without the model writing a sleep/tail loop. Every condition is a small,
// bounded probe of the machine that is already connected (one stat, one grep,
// one ps, one TCP probe per poll); nothing is installed on the far side and
// no polling framework is involved.
//
// A timeout is a normal answer, not an error: `met: false, timedOut: true`.
// Only an unusable condition (unknown kind, missing required field) throws.

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_MS = 1_000;
const MIN_POLL_MS = 10;
const MAX_POLL_MS = 60_000;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (!(ms > 0)) return resolve();
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** POSIX single-quote escaping for remote shell commands. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return number;
}

/**
 * `mtimeAfter` accepts the spellings a caller can actually produce: the epoch
 * milliseconds from `presence_stat`, epoch seconds from `date +%s`, an ISO
 * timestamp or a Date. Returns epoch milliseconds, or null when absent.
 */
function normalizeTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const at = value.getTime();
    if (!Number.isFinite(at)) throw new Error(`${label} is not a valid date`);
    return at;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite timestamp`);
    // Epoch seconds are ~1.7e9; anything smaller than 1e11 is seconds.
    return value < 1e11 ? Math.floor(value * 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  const numeric = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (Number.isFinite(numeric)) return numeric < 1e11 ? Math.floor(numeric * 1000) : Math.floor(numeric);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp: ${JSON.stringify(value)}`);
  return parsed;
}

function requiredString(value, label) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (text === '') throw new Error(`${label} is required`);
  return text;
}

/**
 * Validate and normalize the model-facing condition into the shape the probes
 * below execute. Throws on a condition that can never become true, so a typo is
 * reported at once instead of after a two-minute timeout.
 */
export function normalizeWaitCondition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('a condition object is required (kind: file|grep|process|port|job)');
  }
  const kind = String(input.kind ?? input.type ?? '').trim().toLowerCase();
  switch (kind) {
    case 'file': {
      const path = requiredString(input.path, 'condition.path');
      const exists = input.exists === undefined ? true : input.exists === true;
      let minBytes = null;
      if (input.minBytes !== undefined && input.minBytes !== null && input.minBytes !== '') {
        minBytes = Number(input.minBytes);
        if (!Number.isFinite(minBytes) || minBytes < 0) {
          throw new Error(`condition.minBytes must be a non-negative number, got ${JSON.stringify(input.minBytes)}`);
        }
        minBytes = Math.floor(minBytes);
      }
      const mtimeAfterMs = normalizeTimestamp(input.mtimeAfter, 'condition.mtimeAfter');
      return { kind, path, exists, minBytes, mtimeAfterMs };
    }
    case 'grep': {
      const path = requiredString(input.path, 'condition.path');
      const pattern = requiredString(input.pattern, 'condition.pattern');
      const count = positiveInteger(input.count, 1);
      return { kind, path, pattern, count };
    }
    case 'process': {
      const hasPid = input.pid !== undefined && input.pid !== null && input.pid !== '';
      const hasPattern = input.pattern !== undefined && input.pattern !== null && input.pattern !== '';
      if (hasPid === hasPattern) {
        throw new Error('condition needs exactly one of pid or pattern');
      }
      const alive = input.alive === undefined ? true : input.alive === true;
      if (hasPid) {
        const pid = Number(input.pid);
        if (!Number.isSafeInteger(pid) || pid < 1) {
          throw new Error(`condition.pid must be a positive integer, got ${JSON.stringify(input.pid)}`);
        }
        return { kind, pid, pattern: null, alive };
      }
      return { kind, pid: null, pattern: requiredString(input.pattern, 'condition.pattern'), alive };
    }
    case 'port': {
      const port = Number(input.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`condition.port must be 1-65535, got ${JSON.stringify(input.port)}`);
      }
      const state = String(input.state ?? 'open').toLowerCase();
      if (state !== 'open' && state !== 'closed') {
        throw new Error(`condition.state must be "open" or "closed", got ${JSON.stringify(input.state)}`);
      }
      const host = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : '127.0.0.1';
      return { kind, port, state, host };
    }
    case 'job': {
      const jobId = requiredString(input.jobId ?? input.id, 'condition.jobId');
      return { kind, jobId };
    }
    default:
      throw new Error(
        `unknown condition kind ${JSON.stringify(kind)} (expected file, grep, process, port or job)`,
      );
  }
}

/** One probe of a file condition. */
async function probeFile(connection, condition) {
  const info = await connection.stat(condition.path);
  const exists = Boolean(info?.exists);
  const observed = {
    path: condition.path,
    exists,
    size: exists ? info.size ?? null : null,
    mtime: exists ? info.mtime ?? null : null,
    isDir: exists ? info.isDir ?? null : null,
  };
  if (!condition.exists) return { met: !exists, observed };
  if (!exists) return { met: false, observed };
  let met = true;
  if (condition.minBytes !== null) met = Number(info.size ?? 0) >= condition.minBytes;
  if (met && condition.mtimeAfterMs !== null) met = Number(info.mtime ?? 0) > condition.mtimeAfterMs;
  return { met, observed };
}

/** One `grep -c` of a grep condition; a missing file counts as zero matches. */
async function probeGrep(connection, condition) {
  const result = await connection.exec(
    `grep -c -E -- ${shellQuote(condition.pattern)} ${shellQuote(condition.path)} 2>/dev/null`,
    { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 },
  );
  const text = String(result?.stdout ?? '').trim();
  const matches = /^\d+$/.test(text) ? Number(text) : 0;
  const observed = { path: condition.path, pattern: condition.pattern, matches };
  // grep exits 2 on an unusable file or an invalid regexp; keep the reason in
  // the snapshot so a timeout report explains itself instead of showing 0.
  if (result?.code !== undefined && result.code >= 2) {
    const error = String(result.stderr ?? '').trim().split('\n').filter(Boolean).pop();
    if (error) observed.error = error.slice(0, 300);
  }
  return { met: matches >= condition.count, observed };
}

/**
 * POSIX shell text that evaluates to `value` without ever containing it as a
 * contiguous string. `pgrep -f` matches full command lines, and the probe's own
 * wrapper shell carries the command text in *its* command line, so a plain
 * `pgrep -f -- 'PATTERN'` would match itself and report every pattern as alive.
 * Splitting the value into concatenated quoted chunks keeps the literal out of
 * the command line while the shell variable holds the exact text.
 */
function hiddenShellValue(value) {
  const text = String(value);
  if (text === '') return "''";
  const size = text.length <= 4 ? 1 : text.length <= 16 ? 4 : 8;
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.map((chunk) => shellQuote(chunk)).join('');
}

/** One `kill -0` / `pgrep -f` of a process condition. */
async function probeProcess(connection, condition) {
  if (condition.pid !== null) {
    const result = await connection.exec(`kill -0 ${condition.pid} 2>/dev/null`, {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    const alive = result?.code === 0;
    return { met: alive === condition.alive, observed: { pid: condition.pid, alive } };
  }
  // The pattern reaches pgrep through a shell variable whose literal is split
  // across quoted chunks in the command line (see hiddenShellValue): without
  // that, pgrep -f matches the probe's own wrapper shell and `alive:false`
  // could never be met.
  const patternVar = `P=${hiddenShellValue(condition.pattern)}`;
  const result = await connection.exec(
    `${patternVar}; pgrep -f -- "$P" 2>/dev/null | wc -l`,
    { timeoutMs: 10_000, maxOutputBytes: 1024 },
  );
  const text = String(result?.stdout ?? '').trim();
  const matches = /^\d+$/.test(text) ? Number(text) : 0;
  const alive = matches > 0;
  return { met: alive === condition.alive, observed: { pattern: condition.pattern, matches, alive } };
}

/** One TCP probe of a port condition (the connection's own bash /dev/tcp probe). */
async function probePort(connection, condition) {
  let ready;
  if (typeof connection.waitForPort === 'function') {
    const result = await connection.waitForPort({ port: condition.port, host: condition.host, timeoutMs: 0 });
    ready = Boolean(result?.ready);
  } else if (typeof connection.probePort === 'function') {
    // Older transports have only the throwing probe; one attempt is the poll.
    try {
      const result = await connection.probePort(condition.host, condition.port, { timeoutMs: 2_000 });
      ready = result?.checked !== false;
    } catch {
      ready = false;
    }
  } else {
    throw new Error('this connection cannot probe remote ports');
  }
  const observed = { port: condition.port, host: condition.host, ready };
  return { met: condition.state === 'open' ? ready : !ready, observed };
}

/** The job registry row for `jobId`, from the live pool or a fake in a probe. */
async function jobRow(pool, jobId) {
  if (!pool) throw new Error('a job condition needs the background-job registry');
  if (typeof pool.getJob === 'function') {
    const row = await pool.getJob(jobId);
    if (row) return row;
  }
  try {
    const jobs = pool.jobs;
    if (jobs instanceof Map) {
      const row = jobs.get(jobId);
      if (row) return row;
    } else if (Array.isArray(jobs)) {
      const row = jobs.find((entry) => entry?.id === jobId);
      if (row) return row;
    }
  } catch {
    /* a pool that exposes no synchronous map falls through to listJobs */
  }
  if (typeof pool.listJobs === 'function') {
    const rows = await pool.listJobs();
    const row = (Array.isArray(rows) ? rows : []).find((entry) => entry?.id === jobId);
    if (row) return row;
  }
  return null;
}

/** One registry probe of a job condition; unknown/missing keeps polling. */
async function probeJob(pool, condition) {
  const row = await jobRow(pool, condition.jobId);
  if (!row) return { met: false, observed: { jobId: condition.jobId, state: 'missing' } };
  const observed = {
    jobId: condition.jobId,
    state: row.state ?? 'unknown',
    exitCode: row.exitCode ?? null,
    exitSignal: row.exitSignal ?? null,
    host: row.host ?? null,
    pid: row.pid ?? null,
  };
  return { met: observed.state === 'exited', observed };
}

/**
 * Poll one condition until it is true, the deadline passes, or the caller
 * aborts. Exactly one remote (or registry) probe runs per poll.
 *
 * @param options.pool - the background-job registry, for `job` conditions.
 * @param options.connection - the host connection, for every other condition.
 * @param options.condition - model-facing condition (`kind` plus its fields).
 * @param options.timeoutMs - deadline, default 120000, capped at one hour.
 * @param options.pollMs - gap between probes, default 1000.
 * @param options.signal - caller cancellation; an abort returns `met: false`.
 * @param options.onPoll - optional progress callback, invoked after every
 *   non-final poll (before sleeping) with `{ observed, polls, elapsedMs, met:false }`.
 *   A throwing callback is ignored: progress is a nicety, not part of the wait.
 * @returns `{ met, timedOut, elapsedMs, observed, polls, condition }`; never
 *   rejects because of a timeout or an unreachable host.
 */
export async function waitUntil({
  pool = null,
  connection = null,
  condition,
  timeoutMs,
  pollMs,
  signal,
  onPoll = null,
} = {}) {
  const normalized = normalizeWaitCondition(condition);
  const budgetRaw = Number(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const budget = Number.isFinite(budgetRaw) ? Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.floor(budgetRaw))) : DEFAULT_TIMEOUT_MS;
  const gapRaw = Number(pollMs ?? DEFAULT_POLL_MS);
  const gap = Number.isFinite(gapRaw) ? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(gapRaw))) : DEFAULT_POLL_MS;

  let conn = connection;
  if (normalized.kind !== 'job' && !conn) {
    throw new Error(`a connection to the host is required for a ${normalized.kind} condition`);
  }

  const started = Date.now();
  const deadline = started + budget;
  let polls = 0;
  let observed = null;

  for (;;) {
    if (signal?.aborted) {
      return { met: false, timedOut: false, aborted: true, elapsedMs: Date.now() - started, observed, polls, condition: normalized };
    }
    polls += 1;
    try {
      const result =
        normalized.kind === 'file'
          ? await probeFile(conn, normalized)
          : normalized.kind === 'grep'
            ? await probeGrep(conn, normalized)
            : normalized.kind === 'process'
              ? await probeProcess(conn, normalized)
              : normalized.kind === 'port'
                ? await probePort(conn, normalized)
                : await probeJob(pool, normalized);
      observed = result.observed;
      if (result.met) {
        return { met: true, timedOut: false, elapsedMs: Date.now() - started, observed, polls, condition: normalized };
      }
    } catch (error) {
      // An unreachable host (or a transport hiccup) is not a failed condition:
      // keep the last snapshot, note why this poll failed, and retry.
      observed = { ...(observed ?? {}), error: String(error?.message ?? error).slice(0, 500) };
    }
    // Report the poll that is about to sleep, so a UI can show progress while
    // the wait is still running. The condition did not become true, hence
    // `met: false`; the final, met poll returns above without calling this.
    if (typeof onPoll === 'function') {
      try {
        const pending = onPoll({ observed, polls, elapsedMs: Date.now() - started, met: false });
        if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
      } catch {
        /* a progress callback must never break the wait */
      }
    }
    if (Date.now() >= deadline) {
      return { met: false, timedOut: true, elapsedMs: Date.now() - started, observed, polls, condition: normalized };
    }
    await sleep(Math.min(gap, Math.max(0, deadline - Date.now())), signal);
  }
}
