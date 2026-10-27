// Read the tail of a remote file, optionally following it for a bounded time.
// Everything goes through the host connection's own stat/readBytes calls, so
// nothing is installed on the remote machine and the file is never pulled
// whole: only the byte window that holds the requested lines is read.
//
// `truncated` means content before the returned window was dropped: the file
// has more bytes or lines than the returned text. `bytes` is the UTF-8 size of
// the returned text. `followedMs` is how long follow mode actually observed.

const DEFAULT_LINES = 200;
const MAX_LINES = 5000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 60_000;
const POLL_MS = 500;
const MIN_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
// Hard ceiling for the accumulated follow text; reaching it trims to the
// requested lines so one noisy log cannot grow without bound.
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function clampLines(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LINES;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LINES;
  return Math.max(1, Math.min(MAX_LINES, Math.floor(number)));
}

function clampTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(number));
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Drop a trailing CR per line, matching how the read tools display text. */
function cleanText(text) {
  const raw = String(text ?? '');
  if (raw === '') return '';
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].endsWith('\r')) lines[index] = lines[index].slice(0, -1);
  }
  return lines.join('\n');
}

/** Keep at most `count` trailing lines; keeps a final newline when there was one. */
function trimToLines(text, count) {
  const raw = String(text ?? '');
  if (raw === '') return { text: '', dropped: false };
  const parts = raw.split('\n');
  const trailing = parts.length > 0 && parts[parts.length - 1] === '';
  if (trailing) parts.pop();
  if (parts.length <= count) return { text: raw, dropped: false };
  const kept = parts.slice(parts.length - count);
  return { text: `${kept.join('\n')}${trailing ? '\n' : ''}`, dropped: true };
}

/** Resolve after `ms`, or immediately when the signal aborts. */
function waitFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/**
 * Read the last `lines` lines of one remote text file.
 *
 * With `follow:true` keep polling for new bytes until `timeoutMs` elapses or
 * `signal` aborts; the returned text includes everything appended meanwhile.
 * A file that shrinks while following is treated as rotated: observation
 * restarts from the beginning of the new file.
 *
 * @param {object} connection live PresenceConnection
 * @param {string} path absolute remote path
 * @param {{lines?: number, follow?: boolean, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{text: string, lines: number, bytes: number, truncated: boolean, followedMs: number}>}
 */
export async function tailRemote(connection, path, { lines = DEFAULT_LINES, follow = false, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const target = String(path ?? '');
  if (!target) throw new Error('tail requires a remote file path');
  if (!target.startsWith('/')) throw new Error(`tail requires an absolute remote path, got ${JSON.stringify(target)}`);
  const requested = clampLines(lines);
  const budgetMs = follow ? clampTimeout(timeoutMs) : 0;

  const info = await connection.stat(target);
  if (!info.exists) throw new Error(`${target} does not exist`);
  if (info.isDir) throw new Error(`${target} is a directory; tail reads files`);

  const size = Number(info.size) || 0;
  let windowStart = 0;
  let text = '';
  let partial = '';
  if (size > 0) {
    let window = Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, requested * 512));
    for (;;) {
      const start = Math.max(0, size - window);
      const { buffer } = await connection.readBytes(target, { offset: start, length: size - start });
      const decoded = buffer.toString('utf8');
      windowStart = start;
      if (start > 0) {
        // The window opens mid-line: that first, partial line is not ours.
        const newline = decoded.indexOf('\n');
        partial = decoded;
        text = cleanText(newline === -1 ? '' : decoded.slice(newline + 1));
      } else {
        partial = '';
        text = cleanText(decoded);
      }
      if (splitLines(text).length >= requested || start === 0 || window >= MAX_WINDOW_BYTES) break;
      window = Math.min(MAX_WINDOW_BYTES, window * 4);
    }
  }
  // A file with no newline (one huge line) has no whole trailing line to show;
  // report the readable tail of that line instead of nothing.
  if (text === '' && size > 0 && partial !== '') {
    text = cleanText(partial);
    windowStart = Math.max(windowStart, 1);
  }

  let dropped = windowStart > 0;
  const initialTrim = trimToLines(text, requested);
  if (initialTrim.dropped) dropped = true;
  text = initialTrim.text;

  let offset = size;
  let followedMs = 0;
  if (follow && budgetMs > 0) {
    const followStarted = Date.now();
    const deadline = followStarted + budgetMs;
    while (!signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await waitFor(Math.min(POLL_MS, remaining), signal);
      if (signal?.aborted) break;
      const poll = await connection.stat(target);
      if (!poll.exists) break;
      const pollSize = Number(poll.size) || 0;
      if (pollSize < offset) {
        // Truncated or rotated: start over from the new file's beginning.
        offset = 0;
        text = '';
      }
      if (pollSize > offset) {
        const { buffer } = await connection.readBytes(target, { offset, length: pollSize - offset });
        if (buffer.length > 0) {
          text += buffer.toString('utf8');
          offset += buffer.length;
        }
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        const guard = trimToLines(text, requested);
        text = guard.text;
        dropped = true;
      }
    }
    followedMs = Date.now() - followStarted;
  }

  const finalTrim = trimToLines(text, requested);
  if (finalTrim.dropped) dropped = true;
  text = finalTrim.text;
  return {
    text,
    lines: splitLines(text).length,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: dropped,
    followedMs,
  };
}
