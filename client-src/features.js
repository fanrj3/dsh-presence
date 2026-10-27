// Pure helpers for the Presence 0.18.0 client features (file context menu,
// diff viewer, log tail, port discovery/ presets, job notifications).
//
// These deliberately contain no DOM, React or fetch access so the tricky parts
// (remote POSIX path handling, octal modes, unified-diff colouring and the
// running -> exited job transition rule) can be read and checked on their own.
// app.js imports them and owns all the rendering.

/** Join a remote POSIX directory and a child name without doubling slashes. */
export function joinRemotePath(dir, name) {
  const left = String(dir ?? '').replace(/\/+$/u, '');
  const right = String(name ?? '').replace(/^\/+/u, '');
  if (!left) return `/${right}`;
  return right ? `${left}/${right}` : left || '/';
}

/** Parent directory of a remote POSIX path ("/" for top-level entries). */
export function parentRemotePath(path) {
  const text = String(path ?? '').replace(/\/+$/u, '');
  const index = text.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return text.slice(0, index);
}

/** Last path segment of a remote POSIX path. */
export function remoteBaseName(path) {
  const text = String(path ?? '').replace(/\/+$/u, '');
  const index = text.lastIndexOf('/');
  return index < 0 ? text : text.slice(index + 1);
}

/**
 * Normalise an octal permission string the way a user types it at a prompt:
 * "755", "0755" and 493 all become "755"; anything else becomes null so the
 * caller can keep the dialog open instead of sending a bad mode.
 */
export function normalizeOctalMode(value) {
  const text = String(value ?? '').trim();
  const match = /^0?([0-7]{3,4})$/u.exec(text);
  // "755" / "0755" are octal text. A raw number (493) is octal as well.
  if (match) return match[1];
  if (typeof value === 'number') {
    const numeric = value;
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0o7777) {
      return numeric.toString(8).padStart(3, '0');
    }
  }
  return null;
}

/**
 * Classify one line of a unified diff: 'meta' (file headers), 'hunk' (@@),
 * 'add' (+), 'del' (-) or 'context'. The viewer colours by this.
 */
export function classifyDiffLine(line) {
  const text = String(line ?? '');
  if (
    text.startsWith('+++') ||
    text.startsWith('---') ||
    text.startsWith('diff --git') ||
    text.startsWith('index ') ||
    text.startsWith('new file') ||
    text.startsWith('deleted file') ||
    text.startsWith('old mode') ||
    text.startsWith('new mode') ||
    text.startsWith('similarity index') ||
    text.startsWith('rename ')
  ) {
    return 'meta';
  }
  if (text.startsWith('@@')) return 'hunk';
  if (text.startsWith('+')) return 'add';
  if (text.startsWith('-')) return 'del';
  return 'context';
}

/** Split diff text into classified lines (trailing newline does not add a row). */
export function splitDiffLines(diff) {
  const text = String(diff ?? '');
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => ({ kind: classifyDiffLine(line), text: line }));
}

/** Shorthand for the stat chips: "+12 −3". */
export function diffStatLabel(stats) {
  const added = Number(stats?.added);
  const removed = Number(stats?.removed);
  return `+${Number.isFinite(added) ? added : 0} −${Number.isFinite(removed) ? removed : 0}`;
}

/**
 * Running -> exited job detection. `previous` is the map returned by the last
 * call (null on the very first poll, which seeds the map without notifying, so
 * pre-existing finished jobs never pop a toast on page load).
 *
 * Returns { exits, next }: `exits` are the jobs that just finished, `next` is
 * the state map to keep in a ref for the next poll.
 */
export function detectJobExits(previous, jobs) {
  const previousMap = previous instanceof Map ? previous : null;
  const next = new Map();
  const exits = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.id !== 'string' || !job.id) continue;
    const state = typeof job.state === 'string' ? job.state : 'unknown';
    next.set(job.id, state);
    if (previousMap && previousMap.get(job.id) === 'running' && state === 'exited') exits.push(job);
  }
  return { exits, next };
}

/** Did a request fail because the (older) host does not have that route? */
export function isMissingEndpointError(value) {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return /HTTP 404|HTTP 405|cannot (?:GET|POST|PUT|DELETE)|unknown route|not implemented|unsupported/iu.test(text);
}

/** Does this job exit count as success? (no exit code but a signal = killed) */
export function isSuccessfulExit(job) {
  const code = job?.exitCode;
  if (typeof code === 'number') return code === 0;
  if (code === null || code === undefined) return false;
  return Number(code) === 0;
}
