// The model-facing surface. Every tool targets one machine by its ssh alias and
// reuses that machine's persistent connection 鈥?there is no per-call handshake
// and nothing is installed on the far side.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { activeWorkspace } from './workspaces.js';
import { parseMountPath, parsePresenceUrl } from './mounts.js';
import { remoteGlobDetailed, remoteGrep, splitGlobPattern } from './remote-search.js';
import { guardDestructive } from './destructive.js';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import { exportDirectory, join as joinPath, dirname as dirnamePath, resolve as resolvePath, sep, pruneExports } from './localpaths.js';

const OUTPUT_CAP = 32 * 1024;
const EXEC_OUTPUT_CAP = 16 * 1024;
const READ_CAP = 32 * 1024 * 1024;
const EXPORT_CAP = 64 * 1024 * 1024;
const WAIT_PORT_TIMEOUT_MS = 15_000;
const READ_MANY_MAX_FILES = 50;
const STAT_MAX_PATHS = 100;
const PROBE_MAX_PORTS = 20;
const TRASH_MAX_PATHS = 50;
const DIFF_LINE_CAP = 100;
const DIFF_BYTE_CAP = 8 * 1024;

function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function clip(text, cap = OUTPUT_CAP) {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n鈥?(${text.length - cap} more characters truncated)`;
}

/** Head + tail clipping: keeps the start (what ran) and the end (why it failed). */
function clipMiddle(text, cap = EXEC_OUTPUT_CAP) {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.4);
  const tail = cap - head;
  return (
    `${text.slice(0, head)}\n鈥?(${text.length - cap} characters truncated; full output below) 鈥n` +
    text.slice(text.length - tail)
  );
}

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|[0-?]*[ -/]*[@-~])/g;

/** Drop ANSI escapes and other control characters that corrupt model-facing text. */
function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function text(value) {
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The session a job belongs to; both the flat and header spellings are seen. */
function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? null;
}

/**
 * `set -o pipefail` is a bash feature; the remote exec shell is bash on Linux
 * but may be dash elsewhere. Probe it harmlessly so a non-bash shell keeps
 * working instead of failing the whole command.
 */
function pipefailPrelude() {
  return '(set -o pipefail) 2>/dev/null && set -o pipefail; ';
}

/** A file system sandbox message is about the LOCAL harness, not the remote. */
function isSandboxMessage(message) {
  return /sandbox|escalation available/i.test(String(message ?? ''));
}

/** "755" | "0755" | "0o755" | 0o755 鈫?octal mode number, or undefined when unset. */
function parseMode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const match = /^(?:0o)?0?([0-7]{3,4})$/.exec(String(value).trim());
  if (!match) throw new Error(`mode must be an octal string such as "755" or "0644", got ${JSON.stringify(value)}`);
  return Number.parseInt(match[1], 8);
}

/** In-place shell rewrites the agent should replace with presence_edit/edit. */
const EDIT_SHELL = /\bsed\s+(?:-[A-Za-z]*i[A-Za-z]*\b|--in-place\b)|\bperl\s+-[A-Za-z]*i\b|\bruby\s+-i\b/;

function withSandboxNote(message) {
  const base = String(message ?? '');
  if (!isSandboxMessage(base)) return base;
  return (
    `${base}\n` +
    'note: ctx.fs does not write remote /tmp, so an escalation here cannot help; ' +
    'use presence_write to create files and presence_exec to run remote commands instead.'
  );
}

/** Last lines of a remote log, for a failed background start. */
async function readRemoteTail(connection, logPath, lines = 20) {
  if (!logPath) return '';
  const count = Math.max(1, Math.min(200, Number(lines) || 20));
  try {
    const result = await connection.exec(`tail -n ${count} ${shq(logPath)} 2>/dev/null; true`, { timeoutMs: 15_000 });
    return String(result?.stdout ?? '').replace(/\n$/, '');
  } catch {
    return '';
  }
}

/** Last-resort port probe for a connection without `probePort`. */
async function probePortWithShell(connection, port) {
  try {
    const result = await connection.exec(`bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}'`, { timeoutMs: 2_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Wait until a port listens on the remote loopback.
 * Prefers the pool teammate's `connection.waitForPort`, then `probePort`, and
 * finally a 1-second shell probe loop.
 */
async function waitForRemotePort(connection, port, timeoutMs = WAIT_PORT_TIMEOUT_MS) {
  const targetPort = Number(port);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error(`waitForPort must be a TCP port number, got ${port}`);
  }
  const started = Date.now();
  const deadline = started + Math.max(0, timeoutMs);
  if (typeof connection.waitForPort === 'function') {
    try {
      const result = await connection.waitForPort({ port: targetPort, host: '127.0.0.1', timeoutMs });
      return { ready: Boolean(result?.ready), waitedMs: Number(result?.waitedMs) || Date.now() - started };
    } catch {
      /* fall through to the probe loop */
    }
  }
  for (;;) {
    let open = false;
    try {
      if (typeof connection.probePort === 'function') {
        const result = await connection.probePort('127.0.0.1', targetPort, { timeoutMs: 1_000 });
        open = result?.checked === false ? await probePortWithShell(connection, targetPort) : true;
      } else {
        open = await probePortWithShell(connection, targetPort);
      }
    } catch {
      open = false;
    }
    const waitedMs = Date.now() - started;
    if (open) return { ready: true, waitedMs };
    if (Date.now() >= deadline) return { ready: false, waitedMs };
    await sleep(Math.min(1_000, Math.max(10, deadline - Date.now())));
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMtime(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '?';
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

/** A compact octal mode such as "0644", or null when the exact mode is unknown. */
function modeLabel(mode) {
  if (!Number.isInteger(mode) || mode < 0) return null;
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

/**
 * Trash entries carry movedAt as an ISO string, but older callers may pass
 * epoch milliseconds (or a numeric string). Normalize both to milliseconds so
 * formatMtime never receives a string and renders an empty cell.
 */
function toMtimeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^-?\d+(?:\.\d+)?$/u.test(text)) {
      const numeric = Number(text);
      return Number.isFinite(numeric) ? numeric : null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toISO(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** One text block of JSON, clipped so a huge array cannot blow the output cap. */
function jsonText(value, cap = OUTPUT_CAP) {
  return clip(JSON.stringify(value, null, 2), cap);
}

/** A job's exit as one phrase; null when the job has not exited. */
function exitSummaryOf(job) {
  const exitCode = job?.exitCode ?? null;
  const exitSignal = job?.exitSignal ?? null;
  if (exitCode === null && exitSignal === null) return job?.state === 'running' ? null : 'unknown';
  if (exitCode === null) return `signal ${exitSignal}`;
  return `exit ${exitCode}${exitSignal ? ` signal ${exitSignal}` : ''}`;
}

// ------------------------------------------------------------- remote probes

/** `ss -ltnp` output -> `{ port: { pid, process } }` for the ports we asked about. */
function parseSsListeners(stdout, wanted) {
  const listeners = new Map();
  const wantedSet = new Set(wanted);
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('State') || line.startsWith('__')) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 5) continue;
    const address = columns[3];
    const port = Number.parseInt(address.slice(address.lastIndexOf(':') + 1), 10);
    if (!Number.isInteger(port) || !wantedSet.has(port)) continue;
    const pid = /pid=(\d+)/.exec(line)?.[1];
    const process = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? null;
    const previous = listeners.get(port);
    if (!previous || (previous.pid === null && pid)) {
      listeners.set(port, { pid: pid ? Number(pid) : null, process });
    }
  }
  return listeners;
}

/**
 * One remote exec answers both port questions for a whole round: which ports
 * are listening (ss -ltnp, with pid/process) and which accept a TCP connect
 * (bash /dev/tcp, python3 fallback). Ports are validated integers, so they are
 * safe to splice into the script.
 */
async function inspectRemotePorts(connection, ports, { probe = true, timeoutMs = 20_000 } = {}) {
  const wanted = [...new Set(ports.map((port) => Number(port)))].filter(
    (port) => Number.isInteger(port) && port > 0 && port <= 65535,
  );
  const listeners = new Map();
  const probes = new Map();
  if (wanted.length === 0) return { listeners, probes, ssAvailable: false };
  const list = wanted.join(' ');
  const lines = [
    'if command -v ss >/dev/null 2>&1; then echo __SS_OK__; ss -ltnp 2>/dev/null; else echo __SS_MISSING__; fi',
  ];
  if (probe) {
    lines.push(
      'if command -v bash >/dev/null 2>&1; then',
      `  for p in ${list}; do`,
      '    if command -v timeout >/dev/null 2>&1; then',
      '      timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" >/dev/null 2>&1',
      '      rc=$?',
      '    else',
      '      bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" >/dev/null 2>&1',
      '      rc=$?',
      '    fi',
      '    if [ "$rc" -eq 0 ]; then echo "PB accepted $p"; elif [ "$rc" -eq 124 ]; then echo "PB timeout $p"; else echo "PB refused $p"; fi',
      '  done',
      '  echo __PB_DONE__',
      'else echo __PB_NOBASH__; fi',
    );
  }
  const result = await connection.exec(`sh -c ${shq(lines.join('\n'))}`, {
    timeoutMs,
    maxOutputBytes: 256 * 1024,
  });
  const stdout = String(result.stdout ?? '');
  const ssAvailable = stdout.includes('__SS_OK__');
  for (const [port, state] of parseSsListeners(stdout, wanted)) listeners.set(port, state);
  const collect = (value) => {
    for (const match of String(value ?? '').matchAll(/^PB (accepted|timeout|refused) (\d+)$/gm)) {
      probes.set(Number(match[2]), match[1]);
    }
  };
  collect(stdout);
  if (probe && !stdout.includes('__PB_DONE__')) {
    // No bash, or a bash built without /dev/tcp: python3 can still answer.
    const remaining = wanted.filter((port) => !probes.has(port));
    if (remaining.length > 0) {
      const python = [
        'if command -v python3 >/dev/null 2>&1; then',
        `python3 - ${remaining.join(' ')} <<'PY'`,
        'import socket',
        'import sys',
        '',
        'for raw in sys.argv[1:]:',
        '    port = int(raw)',
        '    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
        '    sock.settimeout(1.0)',
        '    try:',
        '        sock.connect(("127.0.0.1", port))',
        '        print(f"PB accepted {port}")',
        '    except socket.timeout:',
        '        print(f"PB timeout {port}")',
        '    except OSError:',
        '        print(f"PB refused {port}")',
        '    finally:',
        '        sock.close()',
        'PY',
        'fi',
      ].join('\n');
      const fallback = await connection
        .exec(`sh -c ${shq(python)}`, { timeoutMs, maxOutputBytes: 256 * 1024 })
        .catch(() => null);
      if (fallback) collect(fallback.stdout);
    }
  }
  return { listeners, probes, ssAvailable };
}

/**
 * One report row: `listening` comes from ss (or from an accepted connect when
 * ss is unavailable), `probe` from the TCP connect, and `ok` compares that
 * state with the caller's expectation ("open" when no expect was given).
 */
function portProbeRow(port, snapshot, { expect = null, probe = true } = {}) {
  const listener = snapshot.listeners.get(port) ?? null;
  const connect = probe ? snapshot.probes.get(port) ?? 'skipped' : 'skipped';
  const listening = snapshot.ssAvailable ? listener !== null : connect === 'accepted';
  const open = listening || connect === 'accepted';
  const wantOpen = expect === null ? true : expect === 'open';
  return {
    port,
    listening,
    pid: listener?.pid ?? null,
    process: listener?.process ?? null,
    probe: connect,
    ok: open === wantOpen,
  };
}

/** Poll until a remote port stops accepting connections; true/false/null. */
async function waitRemotePortClosed(connection, port, { timeoutMs = 3_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    const snapshot = await inspectRemotePorts(connection, [port], { probe: true });
    const row = portProbeRow(port, snapshot, { probe: true });
    const open = row.listening || row.probe === 'accepted';
    const known = snapshot.ssAvailable || row.probe !== 'skipped';
    if (!open) return known ? true : null;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/** Is anything still listening on this local port? */
function probeLocalPort(port, { timeoutMs = 500 } = {}) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const socket = connectTcp({ host: '127.0.0.1', port: numeric });
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** A tunnel close can return before the listening socket is gone: probe twice. */
async function localPortReleased(port) {
  let connected = await probeLocalPort(port);
  if (connected) {
    await sleep(120);
    connected = await probeLocalPort(port);
  }
  return connected === false;
}

/**
 * Metadata for many paths in one exec. `stat -c` describes a symlink itself
 * unless followSymlinks is set; sha256sum runs only for regular files (and,
 * without followSymlinks, never through a link). Missing paths come back as
 * `exists: false` instead of failing the batch.
 */
async function statRemotePaths(connection, paths, { hash = false, followSymlinks = false } = {}) {
  const quoted = paths.map((path) => shq(path)).join(' ');
  const statFlag = followSymlinks ? '-L ' : '';
  const hashable = followSymlinks ? '[ -f "$p" ]' : '[ -f "$p" ] && [ ! -L "$p" ]';
  const script = [
    `for p in ${quoted}; do`,
    '  if [ -e "$p" ] || [ -L "$p" ]; then',
    `    stat ${statFlag}-c 'META|%F|%s|%a|%Y|%n' -- "$p" 2>/dev/null || echo "META|unknown|0||0|$p"`,
    ...(hash ? [`    if ${hashable}; then sha256sum -- "$p" 2>/dev/null; fi`] : []),
    '  else',
    '    echo "MISSING|$p"',
    '  fi',
    'done',
  ].join('\n');
  const result = await connection.exec(`sh -c ${shq(script)}`, { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 });
  const meta = new Map();
  const missing = new Set();
  const digests = new Map();
  for (const raw of String(result.stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('MISSING|')) {
      missing.add(line.slice('MISSING|'.length));
      continue;
    }
    if (line.startsWith('META|')) {
      const [type, size, mode, mtime, ...rest] = line.split('|').slice(1);
      meta.set(rest.join('|'), {
        type,
        sizeBytes: Number.parseInt(size, 10),
        mode,
        mtimeSeconds: Number.parseInt(mtime, 10),
      });
      continue;
    }
    const digest = /^\\?([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (digest) digests.set(digest[2], digest[1]);
  }
  return paths.map((path) => {
    const info = meta.get(path);
    if (missing.has(path) || !info) {
      return {
        path,
        exists: false,
        type: 'missing',
        sizeBytes: null,
        mode: null,
        mtimeISO: null,
        mtimeMs: null,
        ...(hash ? { sha256: null } : {}),
      };
    }
    const type =
      info.type === 'regular file'
        ? 'file'
        : info.type === 'directory'
          ? 'dir'
          : info.type === 'symbolic link'
            ? 'link'
            : 'other';
    const mtimeMs = Number.isFinite(info.mtimeSeconds) && info.mtimeSeconds > 0 ? info.mtimeSeconds * 1000 : null;
    return {
      path,
      exists: true,
      type,
      sizeBytes: Number.isFinite(info.sizeBytes) ? info.sizeBytes : null,
      mode: modeLabel(Number.parseInt(info.mode, 8)) ?? null,
      mtimeISO: toISO(mtimeMs),
      mtimeMs,
      ...(hash ? { sha256: digests.get(path) ?? null } : {}),
    };
  });
}

/** The current sha256 of one remote file, or null when it cannot be read. */
async function remoteFileSha256(connection, target) {
  const result = await connection.exec(`sha256sum -- ${shq(target)} 2>/dev/null`, { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  const match = /^\\?([0-9a-f]{64})\s/.exec(String(result.stdout ?? ''));
  return match ? match[1] : null;
}

// Common-prefix/common-suffix diff with +/- context lines. No LCS: this is
// meant to let an agent verify one exact replacement, not to merge files.
function diffLines(before, after, { context = 2, maxLines = DIFF_LINE_CAP, maxBytes = DIFF_BYTE_CAP } = {}) {
  if (before === after) return '(no changes)';
  const oldLines = String(before ?? '').split('\n');
  const newLines = String(after ?? '').split('\n');
  const shared = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldChangeStart = prefix;
  const newChangeStart = prefix;
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldStart = Math.max(0, oldChangeStart - context);
  const newStart = Math.max(0, newChangeStart - context);
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + context);
  const newEnd = Math.min(newLines.length, newChangeEnd + context);
  const num = (value) => String(value).padStart(5);
  const rows = [`@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`];
  for (let index = oldStart; index < oldChangeStart; index += 1) {
    rows.push(`${num(index + 1)}   ${oldLines[index]}`);
  }
  for (let index = oldChangeStart; index < oldChangeEnd; index += 1) {
    rows.push(`${num(index + 1)} - ${oldLines[index]}`);
  }
  for (let index = newChangeStart; index < newChangeEnd; index += 1) {
    rows.push(`${num(index + 1)} + ${newLines[index]}`);
  }
  for (let index = 0; index < context && oldChangeEnd + index < oldEnd; index += 1) {
    const line = oldChangeEnd + index;
    rows.push(`${num(line + 1)}   ${oldLines[line]}`);
  }
  const total = rows.length;
  const text = rows.length > maxLines
    ? `${rows.slice(0, maxLines).join('\n')}\n... diff truncated (${total - maxLines} more lines)`
    : rows.join('\n');
  return clip(text, maxBytes);
}

/**
 * One remote text file as the read tools see it: the raw window (byte-exact
 * within the window), the same window as clean display lines, and the paging
 * facts. Files past READ_CAP are windowed on the far side so the line count is
 * true instead of invented.
 */
async function readFileWindow(connection, target, { offset = 1, limit = 2000 } = {}) {
  const first = Math.max(1, Number(offset) || 1);
  const count = Math.max(1, Number(limit) || 2000);
  const info = await connection.stat(target);
  if (!info.exists) throw new Error(`${target} does not exist`);
  if (info.isDir) throw new Error(`${target} is a directory; use presence_exec with ls`);
  if (info.size > READ_CAP) {
    const windowed = await connection.readTextWindow(target, { lineOffset: first, lineLimit: count });
    const totalLines = windowed.totalLines;
    if (first > totalLines && totalLines > 0) {
      throw new Error(`offset ${first} is past the end of ${target} (${totalLines} lines)`);
    }
    const rawWindow = String(windowed.content ?? '');
    const display = rawWindow.replace(/\r/g, '');
    const lines = display === '' ? [] : display.split('\n');
    const endLine = first + lines.length - 1;
    return { info, totalLines, rawWindow, lines, offset: first, truncated: endLine < totalLines || windowed.truncated === true };
  }
  const { content } = await connection.readText(target, { length: Math.min(info.size, READ_CAP) });
  if (content.includes('\u0000')) {
    throw new Error(
      `${target} looks binary (${info.size} bytes, contains NUL). This tool reads text only. ` +
        'Use presence_exec with `head -c`, `file`, or `presence_terminal` to inspect it.',
    );
  }
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  const totalLines = lines.length;
  const rawWindow = content.split('\n').slice(first - 1, first - 1 + count).join('\n');
  const window = lines.slice(first - 1, first - 1 + count);
  return { info, totalLines, rawWindow, lines: window, offset: first, truncated: first - 1 + window.length < totalLines };
}

/** The footer presence_read appends when numbering is on. */
function readFooter({ offset, lines, totalLines }) {
  const end = offset + lines.length - 1;
  return end < totalLines
    ? `(Showing lines ${offset}-${end} of ${totalLines}. Use offset=${end + 1} to continue.)`
    : `(End of file - ${totalLines} lines)`;
}

const DEFAULT_TAIL_LINES = 40;
const MAX_TAIL_LINES = 500;
// A full-screen replay is worth recognizing as such: a tty dump of a few
// screens is large but not truncated, so `clip()` alone would not say so.
const TERMINAL_LARGE_OUTPUT_BYTES = 4 * 1024;

/** `wait.tailLines` is a display budget: whole lines, 1..500, 0/absent = 40. */
function clampTailLines(value) {
  if (value === undefined || value === null) return DEFAULT_TAIL_LINES;
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return DEFAULT_TAIL_LINES;
  return Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(number)));
}

/** The pool prefixes every job command with the pipefail probe; hide it. */
function stripPipefailPrelude(value) {
  return String(value ?? '').replace(/^(?:\(set -o pipefail\) 2>\/dev\/null && set -o pipefail; )+/, '');
}

/** A match line rendered so a line number is never fabricated. */
function formatMatchLine(match) {
  if (match.lineNumber > 0) return `${match.path ? `${match.path}:` : ''}${match.lineNumber}:${match.line}`;
  return match.path ? `${match.path}: ${match.line}` : match.line;
}

/**
 * `pool.waitJob` fallback for a pool that predates the teammate's API: poll
 * liveness and read the log tail over the same connection.
 */
async function waitForJobFallback(pool, id, { timeoutMs, tailLines }) {
  const started = Date.now();
  let job = null;
  for (;;) {
    const jobs = await pool.listJobs();
    job = jobs.find((entry) => entry.id === id);
    if (!job) throw new Error(`no background job "${id}"`);
    if (job.state !== 'running' && job.state !== 'unknown') break;
    if (Date.now() - started >= timeoutMs) break;
    await sleep(Math.min(1_000, Math.max(50, timeoutMs - (Date.now() - started))));
  }
  let logSize = null;
  let logTail = '';
  try {
    const connection = await pool.connection(job.host);
    const result = await connection.exec(
      `wc -c < ${shq(job.logPath)} 2>/dev/null; tail -n ${Math.max(1, tailLines)} ${shq(job.logPath)} 2>/dev/null`,
      { timeoutMs: 15_000 },
    );
    const stdout = String(result?.stdout ?? '');
    const newline = stdout.indexOf('\n');
    const size = Number(newline === -1 ? stdout.trim() : stdout.slice(0, newline).trim());
    if (Number.isFinite(size)) {
      logSize = size;
      logTail = stdout.slice(newline + 1).replace(/\n$/, '');
    } else {
      logTail = stdout.replace(/\n$/, '');
    }
  } catch {
    /* size/tail are a convenience; the state is still useful */
  }
  return { ...job, logTail, logSize };
}

function formatWaitReport(job, { timeoutMs, tailLines, timedOut = false }) {
  const state = job.state ?? 'unknown';
  const stillRunning = state === 'running' || state === 'unknown';
  const exit =
    job.exitCode === undefined || job.exitCode === null ? (stillRunning ? 'still running' : 'unknown') : String(job.exitCode);
  const size = job.logSize === undefined || job.logSize === null ? 'unknown' : formatBytes(job.logSize);
  const parts = [
    `job ${job.id} on ${job.host ?? '?'}: state=${state}  exit=${exit}  timedOut=${timedOut ? 'yes' : 'no'}`,
    `pid: ${job.pid ?? '?'}  log: ${job.logPath ?? '?'}  size: ${size}`,
  ];
  if (stillRunning) {
    parts.push(`(did not exit within ${timeoutMs}ms; use action:'wait' again or action:'stop')`);
  }
  parts.push(`--- last ${tailLines} line(s) ---`);
  parts.push(job.logTail ? clip(job.logTail) : '(log is empty or unreadable)');
  return parts.join('\n');
}

/** One background job in a stable, model-facing shape (also the JSON payload). */
function jobRecord(job) {
  return {
    id: job.id,
    host: job.host,
    state: job.state ?? 'unknown',
    exitCode: job.exitCode ?? null,
    exitSignal: job.exitSignal ?? null,
    pid: job.pid ?? null,
    label: job.label ? stripPipefailPrelude(job.label) : null,
    startedAt: job.startedAt ?? null,
    logPath: job.logPath ?? null,
    logSize: job.logSize ?? null,
    command: job.command ? stripPipefailPrelude(job.command) : null,
    cwd: job.cwd ?? null,
  };
}

/** Whether a pid still exists on its host; `verified` is false when the probe failed. */
async function verifyPidAlive(pool, host, pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 1) return { alive: null, verified: false };
  try {
    const connection = await pool.connection(host);
    const probe = await connection.exec(`ps -p ${value} -o pid= 2>/dev/null`, { timeoutMs: 5_000 });
    return { alive: String(probe.stdout ?? '').trim() !== '', verified: true };
  } catch {
    return { alive: null, verified: false };
  }
}

/** Optional proof that a stopped job really released the port it was serving. */
async function portReleasedAfterStop(pool, host, port, timeoutMs = 3_000) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return null;
  try {
    const connection = await pool.connection(host);
    return await waitRemotePortClosed(connection, numeric, { timeoutMs });
  } catch {
    return null;
  }
}

/** A verified stop is reported the same way for a jobId and a raw pgid. */
function stopSummary(result, check) {
  const exit = `exit=${result.exitCode ?? '-'}${result.exitSignal ? ` signal=${result.exitSignal}` : ''}`;
  const verify = `pid ${result.pid ?? '?'} alive=${check.alive === null ? 'unknown' : check.alive} verified=${check.verified}`;
  return `${verify}  ${exit}`;
}

const textOutput = (description) => ({
  schema: { type: 'string', description },
  render: (_args, value) => [{ type: 'text', text: value }],
});

/** Wrapping one tool keeps the definition list readable and the schema identical. */
function tool(definition) {
  return defineTool({
    ...definition,
    output: textOutput('Human-readable result.'),
    async execute(args, exec) {
      const value = await definition.execute(args, exec);
      return typeof value === 'string' ? value : text(JSON.stringify(value));
    },
  });
}

export function definePresenceTools(pool, settings, { cwdOf, observe } = {}) {
  const ensureWritable = () => {
    if (settings.readOnly) throw new Error('this Presence profile is read-only; ask the user to allow writes');
  };
  /** Best effort: let the harness read-before-edit policy know the file was seen. */
  const markObserved = async (exec, path) => {
    if (typeof observe !== 'function') return;
    try {
      await observe(exec, path);
    } catch {
      /* observation is an optimization, never a failure */
    }
  };

  /**
   * Where this call belongs. Inside a workspace the session's own directory
   * decides the machine 鈥?every workspace in the sidebar just works, with no
   * "make it current" step. Explicit host still wins; a session outside any
   * remote workspace falls back to the last opened one.
   */
  const pickScope = async (args, exec) => {
    let cwd = null;
    try {
      cwd = (await cwdOf?.(exec)) ?? null;
    } catch {
      cwd = null;
    }
    const mounted = cwd ? parseMountPath(cwd) : null;
    if (mounted && !args.host) return { host: mounted.host, workspace: { host: mounted.host, path: mounted.path } };

    const active = activeWorkspace();
    const host = args.host || active?.host;
    if (!host) {
      throw new Error('no host given and no remote workspace here; call presence_hosts then pass host');
    }
    const workspace = active && active.host === host ? active : null;
    return { host, workspace };
  };

  /** Every alias the ssh config knows, for the "known hosts" hint. */
  const knownHostAliases = () => {
    try {
      return pool.hosts().map((entry) => entry.alias);
    } catch {
      return [];
    }
  };

  /**
   * A `presence:`-shaped string that is not a usable presence URL must fail
   * loudly. Otherwise `presence://srv/workspace/x` looks like a relative path and
   * silently creates a literal `presence:` directory.
   */
  const invalidPresencePath = (value) => {
    const aliases = knownHostAliases();
    return new Error(
      `"${value}" is not a valid presence path (expected presence://<host>/<absolute path>; ` +
        `known hosts: ${aliases.length > 0 ? aliases.join(', ') : 'none'})`,
    );
  };

  /**
   * Resolve any spelling of a remote path to one absolute remote path:
   * `presence://host/path`, a local mount path, `~/x`, an absolute path, or a
   * workspace-relative path. One file, several names 鈥?all accepted.
   */
  const remotePath = async (connection, workspace, path) => {
    const value = String(path);
    let viaUrl = parsePresenceUrl(value);
    if (!viaUrl && /^presence:/i.test(value)) {
      // The scheme is case-insensitive; parsePresenceUrl only knows lowercase.
      viaUrl = parsePresenceUrl(value.replace(/^presence:/i, 'presence:'));
      if (!viaUrl) throw invalidPresencePath(value);
    }
    if (viaUrl) {
      if (workspace && viaUrl.host !== workspace.host) {
        throw new Error(`"${path}" belongs to ${viaUrl.host}, but this session is on ${workspace.host}`);
      }
      return viaUrl.path;
    }
    const viaMount = parseMountPath(value);
    if (viaMount) {
      if (workspace && viaMount.host !== workspace.host) {
        throw new Error(`"${path}" belongs to ${viaMount.host}, but this session is on ${workspace.host}`);
      }
      return viaMount.path;
    }
    // A drive letter or a UNC prefix is a local Windows path, never a remote
    // one; it must not be rewritten into a remote relative path below.
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
      throw new Error(`"${value}" is a local Windows path; this tool only handles paths on a remote machine`);
    }
    let resolved = value;
    // Backslashes are a Windows path separator, not part of a remote name.
    // Only relative remote spellings are rewritten: POSIX absolute paths may
    // legitimately contain a backslash, and Windows absolute paths never get here.
    if (!resolved.startsWith('/')) resolved = resolved.replace(/\\/g, '/');
    const home = await connection.homePath();
    if (resolved === '~') resolved = home;
    else if (resolved.startsWith('~/')) resolved = `${home}${resolved.slice(1)}`;
    if (resolved.startsWith('/')) return resolved;
    if (!workspace) throw new Error(`"${path}" is relative but no workspace is active; pass an absolute path`);
    return `${workspace.path.replace(/\/+$/, '')}/${resolved}`;
  };

  return [
    tool({
      name: 'presence_hosts',
      description:
        'List the machines Presence can reach, taken from the user\'s ~/.ssh/config, with whether each one is connected right now. Call this before targeting a host for the first time. The default host (the active workspace\'s machine) is marked with "*". format:\'json\' returns one object per host: {alias, address, user, hostname, port, source, state, connected, default}.',
      parameters: {
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: an array of host objects. Defaults to text.',
        },
      },
      async execute(args) {
        const hosts = pool.hosts();
        const defaultHost = settings.defaultHost ?? activeWorkspace()?.host ?? null;
        if (args.format === 'json') {
          return jsonText(
            hosts.map((host) => ({
              alias: host.alias,
              address: `${host.user ?? '?'}@${host.hostname}:${host.port}`,
              user: host.user ?? null,
              hostname: host.hostname,
              port: host.port,
              source: host.source ?? 'config',
              state: host.connected ? 'connected' : 'idle',
              connected: host.connected === true,
              default: host.alias === defaultHost,
            })),
          );
        }
        if (hosts.length === 0) return 'No hosts with an explicit HostName were found in ~/.ssh/config.';
        const lines = hosts.map((host) => {
          const state = host.connected ? `connected${host.terminals ? `, ${host.terminals} terminal(s)` : ''}` : 'not connected';
          const key = host.identityFile ? `key ${host.identityFile}` : 'default keys';
          const marker = host.alias === defaultHost ? '*' : '';
          return `${marker}${host.alias}  ${host.user ?? '?'}@${host.hostname}:${host.port}  ${state}  (${key})`;
        });
        return `${hosts.length} host(s):\n${lines.join('\n')}`;
      },
    }),

    tool({
      name: 'presence_connect',
      description:
        'Open the persistent connection to one machine and report what it is. Later calls on this host reuse it. Call this when a host reports "not connected" and you want the identity up front, or to surface an authentication problem early. format:\'json\' returns {host, user, hostname, kernel, arch, platform, connectedAtMs}.',
      parameters: {
        host: { type: 'string', required: true, description: 'Exact ssh alias, as listed by presence_hosts.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON with the parsed remote identity. Defaults to text.',
        },
      },
      async execute(args) {
        const started = Date.now();
        const connection = await pool.connection(args.host);
        const who = await connection.exec('printf "%s@%s %s" "$(id -un)" "$(hostname)" "$(uname -srm)"');
        const raw = who.stdout.trim();
        if (args.format === 'json') {
          // `user@hostname Sysname Release Machine`
          const match = /^([^@\s]+)@(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(raw);
          return jsonText(
            match
              ? {
                  host: args.host,
                  user: match[1],
                  hostname: match[2],
                  kernel: match[4],
                  arch: match[5],
                  platform: match[3],
                  connectedAtMs: connection.connectedAt ?? null,
                }
              : {
                  host: args.host,
                  user: null,
                  hostname: null,
                  kernel: null,
                  arch: null,
                  platform: null,
                  connectedAtMs: connection.connectedAt ?? null,
                  raw,
                },
          );
        }
        return `connected to ${args.host} in ${Date.now() - started}ms\nremote: ${raw}`;
      },
    }),

    tool({
      name: 'presence_exec',
      description:
        'Run a shell command on a remote machine and return its exit code, stdout and stderr. Inside a workspace the machine and working directory come from the session itself, so no host is needed. The connection persists between calls. Commands run with `set -o pipefail` by default, so `cmd | tail` reports cmd\'s real failure; pass pipefail:false to disable. For servers or long jobs use background:true instead of `&`: it returns a job id, takes an optional label, and can wait until a port is listening with waitForPort. format:\'json\' returns one text block of JSON ({cwd, command, exitCode, signal, durationMs, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated}) with stdout/stderr clipped to 16 KiB each; saveStdout writes a successful foreground command\'s stdout to a remote file.\n\nDESTRUCTIVE COMMANDS (`rm -r/-f`, `git clean -fdx`, `find -delete`, `shred`, `truncate`, `dd of=`) are dry-run first: the tool shows every resolved target and refuses workspace roots, ancestors, home, `/` and `.git` metadata. Re-run with confirm:true to execute; format:\'json\' returns that dry run as {dryRun:true, requiresConfirm:true, targets, command, report}. Prefer presence_trash for recoverable deletes. Output is ANSI-stripped and middle-truncated by default.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        command: { type: 'string', required: true, description: 'Command line, interpreted by the remote shell.' },
        cwd: { type: 'string', description: 'Directory to run in, absolute or workspace-relative. Defaults to the workspace root, else the remote login directory.' },
        timeoutMs: { type: 'number', description: 'Abort after this many milliseconds (the remote process tree is killed). Defaults to 120000. Ignored for background jobs, which are meant to outlive the call.' },
        background: { type: 'boolean', description: 'Start detached and return immediately with pid and a remote log file. Use for servers and long-running jobs.' },
        label: { type: 'string', description: 'For background: short label shown by presence_jobs. Defaults to the command.' },
        pipefail: { type: 'boolean', description: 'Set the remote shell\'s pipefail so a failing left side of a pipeline is reported. Defaults to true; pass false to disable.' },
        confirm: {
          type: 'boolean',
          description: 'Required to actually run a command classified as destructive; without it the tool returns a dry-run report of the resolved targets instead.',
        },
        maxOutput: {
          type: 'number',
          description: 'Max characters of stdout/stderr shown inline. Defaults to 16384 (up to 262144); the full output is always written to a log file whose path is reported.',
        },
        raw: { type: 'boolean', description: 'Keep ANSI escape sequences in the output. Defaults to false (stripped).' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {cwd, command, exitCode, signal, durationMs, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated}. Streams are clipped to 16 KiB each. For a destructive command without confirm:true the JSON is {dryRun:true, requiresConfirm:true, targets, command, report}. Defaults to text.',
        },
        saveStdout: {
          type: 'string',
          description: 'After a successful (exit 0) foreground command, write stdout to this remote path atomically (parent directories are created) and report path+bytes. Skipped with a note for a non-zero exit or a background job.',
        },
        waitForPort: {
          type: 'number',
          description: 'For background: TCP port to wait for on 127.0.0.1 (up to 15s) before returning, and report whether it is listening. Ignored for foreground commands.',
        },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const directory = args.cwd ? await remotePath(connection, workspace, args.cwd) : workspace?.path;
        const pipefail = args.pipefail !== false;

        // Destructive commands are dry-run first: show the resolved targets, and
        // refuse the cases where an empty variable or stray glob would delete a
        // whole tree. Nothing runs until the caller repeats the call with confirm.
        if (!args.confirm) {
          const guard = await guardDestructive({
            connection,
            command: args.command,
            cwd: directory ?? null,
            workspace,
            host,
            confirm: false,
          });
          if (guard) {
            // JSON callers get the guard report as data instead of having to
            // parse the text report; `targets` mirrors the report's target block.
            if (args.format === 'json') {
              return jsonText({
                dryRun: true,
                requiresConfirm: true,
                targets: guard.targets ?? [],
                command: args.command,
                report: guard.report,
              });
            }
            return guard.report;
          }
        } else {
          await guardDestructive({
            connection,
            command: args.command,
            cwd: directory ?? null,
            workspace,
            host,
            confirm: true,
          });
        }

        if (args.background) {
          if (args.waitForPort !== undefined && args.waitForPort !== null) {
            const port = Number(args.waitForPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              throw new Error(`waitForPort must be a TCP port number, got ${args.waitForPort}`);
            }
          }
          const body = `${pipefail ? pipefailPrelude() : ''}${args.command}`;
          let job;
          try {
            job = await pool.startJob(host, {
              command: body,
              cwd: directory ?? null,
              label: args.label,
              sessionId: sessionIdOf(exec),
            });
          } catch (error) {
            throw new Error(withSandboxNote(error?.message ?? String(error)));
          }

          if (job?.exitedEarly) {
            const recorded = typeof job.logTail === 'string' ? job.logTail : null;
            const tail = recorded !== null ? recorded : await readRemoteTail(connection, job.logPath, 20);
            const size =
              job.logSize === undefined || job.logSize === null ? null : ` (${formatBytes(job.logSize)})`;
            return [
              `background job ${job.id ?? '(unknown)'} exited immediately on ${host} (it did not stay running)`,
              `exit: ${job.exitCode ?? 'unknown'}`,
              job.logPath ? `log: ${job.logPath}${size ?? ''}` : null,
              tail ? `--- last lines ---\n${clip(tail)}` : '(the log is empty)',
            ]
              .filter(Boolean)
              .join('\n');
          }

          const parts = [
            `started in background on ${host}`,
            `job: ${job.id}`,
            `pid: ${job.pid}`,
            `log: ${job.logPath}`,
            args.label ? `label: ${args.label}` : null,
            `stop it with presence_jobs {action:'stop', jobId:'${job.id}'}; follow it with presence_jobs {action:'wait', jobId:'${job.id}'} or presence_exec: tail -n 100 ${job.logPath}`,
          ].filter(Boolean);

          if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
            parts.push(
              'note: timeoutMs does not apply to background jobs 鈥?they are meant to outlive the call; ' +
                `use presence_jobs {action:'wait', jobId:'${job.id}', timeoutMs} to wait for it`,
            );
          }

          if (args.waitForPort !== undefined && args.waitForPort !== null) {
            const outcome = await waitForRemotePort(connection, args.waitForPort, WAIT_PORT_TIMEOUT_MS);
            parts.push(
              outcome.ready
                ? `port ${args.waitForPort} is listening on ${host} (after ${outcome.waitedMs}ms)`
                : `port ${args.waitForPort} is NOT listening on ${host} after ${outcome.waitedMs}ms 鈥?check the log: tail -n 50 ${job.logPath}`,
            );
          }
          if (args.saveStdout) {
            parts.push('stdout not saved: a background job already writes its output to the log above');
          }
          return parts.join('\n');
        }

        const saveTarget = args.saveStdout ? await remotePath(connection, workspace, args.saveStdout) : null;
        let command = args.command;
        if (directory) command = `cd ${shq(directory)} && ${command}`;
        if (pipefail) command = `${pipefailPrelude()}${command}`;
        let result;
        try {
          result = await connection.exec(command, { timeoutMs: args.timeoutMs ?? 120_000 });
        } catch (error) {
          throw new Error(withSandboxNote(error?.message ?? String(error)));
        }

        let savedStdout = null;
        let saveError = null;
        if (saveTarget && result.code === 0) {
          try {
            const parent = saveTarget.includes('/') ? saveTarget.slice(0, saveTarget.lastIndexOf('/')) : '';
            if (parent) {
              const made = await connection.exec(`mkdir -p ${shq(parent)}`, { timeoutMs: 30_000 });
              if (made.code !== 0) {
                throw new Error(`cannot create ${parent}: ${made.stderr.trim() || `exit ${made.code}`}`);
              }
            }
            const written = await connection.writeText(saveTarget, result.stdout ?? '');
            savedStdout = { path: saveTarget, sizeBytes: written.bytes };
          } catch (error) {
            saveError = error?.message ?? String(error);
          }
        }

        const plain = (value) => (args.raw ? String(value ?? '') : stripAnsi(value));
        if (args.format === 'json') {
          const stdoutRaw = plain(result.stdout);
          const stderrRaw = plain(result.stderr);
          const payload = {
            cwd: directory ?? null,
            command: args.command,
            exitCode: result.code ?? null,
            signal: result.signal ?? null,
            durationMs: result.durationMs ?? null,
            timedOut: result.timedOut === true,
            stdout: clip(stdoutRaw, EXEC_OUTPUT_CAP),
            stderr: clip(stderrRaw, EXEC_OUTPUT_CAP),
            stdoutTruncated: result.stdoutTruncated === true || stdoutRaw.length > EXEC_OUTPUT_CAP,
            stderrTruncated: result.stderrTruncated === true || stderrRaw.length > EXEC_OUTPUT_CAP,
          };
          if (savedStdout) payload.savedStdout = savedStdout;
          if (saveError) payload.savedStdoutError = saveError;
          if (saveTarget && !savedStdout && !saveError) {
            payload.savedStdoutSkipped = { path: saveTarget, reason: `exit ${result.code ?? '?'} is not 0` };
          }
          return JSON.stringify(payload, null, 2);
        }

        const parts = [`exit: ${result.code}  (${result.durationMs}ms)`];
        if (result.timedOut) parts.push('timed out 鈥?the remote process tree was terminated');
        const inlineCap = Math.max(1000, Math.min(Number(args.maxOutput) || EXEC_OUTPUT_CAP, 256 * 1024));
        const note = (stream) => {
          const captured = plain(stream === 'stdout' ? result.stdout : result.stderr);
          const truncated = stream === 'stdout' ? result.stdoutTruncated : result.stderrTruncated;
          const file = stream === 'stdout' ? result.stdoutFile : result.stderrFile;
          if (!truncated && captured.length <= inlineCap) return null;
          const where = file ? `full ${stream}: ${file} on ${host}` : `no ${stream} file could be saved`;
          return `(${truncated ? `${stream} exceeded the 256 KiB capture cap; ` : ''}showing first/last ${inlineCap} characters 鈥?${where})`;
        };
        if (result.stdout) {
          parts.push(`--- stdout ---\n${clipMiddle(plain(result.stdout), inlineCap)}`);
          const hint = note('stdout');
          if (hint) parts.push(hint);
        }
        if (result.stderr) {
          parts.push(`--- stderr ---\n${clipMiddle(plain(result.stderr), inlineCap)}`);
          const hint = note('stderr');
          if (hint) parts.push(hint);
        }
        if (result.code !== 0 && isSandboxMessage(result.stderr)) {
          parts.push(
            'note: ctx.fs does not write remote /tmp, so an escalation here cannot help; ' +
              'use presence_write to create files and presence_exec to run remote commands instead.',
          );
        }
        // Nudge the model away from shell one-liners for edits: they skip the
        // atomic write, the ambiguity check and the version guard.
        if (EDIT_SHELL.test(args.command)) {
          parts.push(
            'note: prefer presence_edit (or the built-in `edit` tool) for remote file changes 鈥?' +
              '`sed -i`/`perl -pi`/`python -c` rewrites bypass the atomic write and the ambiguity check.',
          );
        }
        if (savedStdout) {
          parts.push(`stdout saved to ${savedStdout.path} (${savedStdout.sizeBytes} bytes)`);
        } else if (saveError) {
          parts.push(`stdout save to ${saveTarget} failed: ${saveError}`);
        } else if (saveTarget) {
          parts.push(`stdout not saved to ${saveTarget}: exit ${result.code ?? '?'} is not 0`);
        }
        return parts.join('\n');
      },
    }),

    tool({
      name: 'presence_read',
      description:
        'Read a text file on a remote machine. Inside a workspace, relative paths resolve against the workspace root and the machine comes from the workspace. Returns line-numbered content with a line-count footer, like reading a local file. Use offset/limit for large files. Pass `raw:true` for the exact file content with no path header, no line numbers and no footer; pass `numbered:false` for unnumbered content that keeps the path header.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to the active workspace\'s machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum lines to return. Defaults to 2000.' },
        numbered: {
          type: 'boolean',
          description: 'Prefix each line with its line number and append the line-count footer. Defaults to true; pass false for unnumbered content with no footer.',
        },
        raw: {
          type: 'boolean',
          description: 'Return exactly the file content: no path header, no line numbers and no line-count footer. Defaults to false.',
        },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const view = await readFileWindow(connection, target, { offset: args.offset, limit: args.limit });
        const raw = args.raw === true;
        const numbered = !raw && args.numbered !== false;
        const body = numbered
          ? view.lines.map((line, index) => `${view.offset + index}: ${line}`).join('\n')
          : view.rawWindow;
        await markObserved(exec, args.path);
        if (raw) return body;
        const footer = numbered ? `\n\n${readFooter(view)}` : '';
        return `<path>${target}</path>\n${body}${footer}`;
      },
    }),

    tool({
      name: 'presence_read_many',
      description:
        'Read several text files on one remote machine in a single call (1-50 paths). Each file becomes one "=== <path> ===" section: numbered lines by default, verbatim with raw:true, and only the first limit lines. An unreadable file is reported inline as "error: ..." instead of failing the whole call. The total output is clipped to 32 KiB with a truncation note.',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Remote paths (absolute, ~/..., presence://host/path, or workspace-relative). 1-50 entries.',
        },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        raw: { type: 'boolean', description: 'Return verbatim content without line numbers. Defaults to false (numbered lines).' },
        limit: { type: 'number', description: 'Maximum lines per file. Defaults to 2000.' },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const inputs = Array.isArray(args.paths) ? args.paths : [];
        if (inputs.length === 0) throw new Error('paths is required: pass 1-50 remote paths');
        if (inputs.length > READ_MANY_MAX_FILES) {
          throw new Error(`presence_read_many reads at most ${READ_MANY_MAX_FILES} files per call, got ${inputs.length}`);
        }
        const limit = Math.max(1, Number(args.limit) || 2000);
        const raw = args.raw === true;
        const sections = [];
        for (const input of inputs) {
          let target = String(input);
          try {
            target = await remotePath(connection, workspace, input);
            const view = await readFileWindow(connection, target, { offset: 1, limit });
            const body = raw
              ? view.rawWindow
              : view.lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
            const note = view.truncated
              ? `\n... [truncated: showing ${view.lines.length} of ${view.totalLines} lines]`
              : '';
            sections.push(`=== ${target} ===\n${body}${note}`);
            await markObserved(exec, input);
          } catch (error) {
            sections.push(`=== ${target} ===\nerror: ${error?.message ?? String(error)}`);
          }
        }
        return clip(sections.join('\n\n'));
      },
    }),

    tool({
      name: 'presence_write',
      description:
        'Create or fully replace a file on a remote machine. Missing parent directories are created. Inside a workspace, relative paths resolve against the workspace root. The write is atomic (temp file + rename), so a reader never sees a half-written file. An existing file keeps its mode (e.g. 0755 stays executable); pass `mode` to set one explicitly. After writing, the remote file is stat-ed and the result reports its actual size, octal mode and full sha256. Pass `ifMatchSha256` (the hash the file must currently have) to refuse the overwrite when the remote content changed since you read it.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        content: { type: 'string', required: true, description: 'Complete new file content.' },
        mode: {
          type: 'string',
          description: 'Octal file mode to set, e.g. "755" or "644". Defaults to the existing file\'s mode, or 644 for a new file.',
        },
        ifMatchSha256: {
          type: 'string',
          description: 'Optimistic lock: only write when the file currently has this sha256. A mismatch (or a missing/unreadable file) is an error that reports both hashes, and nothing is written.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {path, sizeBytes, mode, sha256}. `mode` is the actual octal string such as "0644". Defaults to text.',
        },
      },
      async execute(args, exec) {
        ensureWritable();
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const expected = typeof args.ifMatchSha256 === 'string' ? args.ifMatchSha256.trim().toLowerCase() : '';
        if (expected) {
          const current = await remoteFileSha256(connection, target);
          if (!current) {
            throw new Error(
              `ifMatchSha256: could not read the current sha256 of ${target} on ${host} ` +
                '(the file is missing, or the host has no sha256sum); nothing was written',
            );
          }
          if (current !== expected) {
            throw new Error(
              `ifMatchSha256 mismatch for ${target} on ${host}: expected ${expected}, current ${current}; ` +
                'nothing was written (read the file again and retry with its current hash)',
            );
          }
        }
        const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
        if (parent) {
          const made = await connection.exec(`mkdir -p ${shq(parent)}`, { timeoutMs: 30_000 });
          if (made.code !== 0) throw new Error(`cannot create parent directory ${parent}: ${made.stderr.trim()}`);
        }
        const payload = Buffer.from(args.content ?? '', 'utf8');
        const digest = createHash('sha256').update(payload).digest('hex');
        const result = await connection.writeText(target, payload, { mode: parseMode(args.mode) });
        const info = await connection.stat(target);
        const sizeBytes = info.exists ? info.size : result.bytes;
        const mode = info.exists ? info.mode : result.mode;
        const octal = modeLabel(mode);
        await markObserved(exec, args.path);
        if (args.format === 'json') {
          return jsonText({ path: target, sizeBytes, mode: octal, sha256: digest });
        }
        return `wrote ${sizeBytes} bytes to ${target} on ${host} mode ${octal ?? 'unknown'} sha256 ${digest}`;
      },
    }),

    tool({
      name: 'presence_export',
      description:
        'Copy a remote file to a real local file so desktop tools can open it. The workspace path is a virtual mount: Explorer, Office, Python and the `present` tool cannot see remote files directly. Export first, then present or open the returned local path. Files are written to the local export folder (content-addressed, deduplicated); `to` may only point inside that folder or the local workspace. Limit: 64 MiB.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', required: true, description: 'Remote file: absolute, workspace-relative, presence URL, or mount path.' },
        to: { type: 'string', description: 'Optional local destination inside the export folder (defaults to a content-addressed name).' },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`${target} does not exist on ${host}`);
        if (info.isDir) throw new Error(`${target} is a directory; export files one by one, or use presence_exec with tar/scp`);
        if (info.size > EXPORT_CAP) {
          throw new Error(`${target} is ${info.size} bytes; export is capped at ${EXPORT_CAP} bytes 鈥?use presence_exec with scp/rsync for larger files`);
        }
        const { buffer } = await connection.readBytes(target, { offset: 0, length: info.size });
        const name = target.split('/').filter(Boolean).pop() ?? 'export.bin';
        const folder = exportDirectory();
        mkdirSync(folder, { recursive: true });
        const checksum = createHash('sha256').update(buffer).digest('hex');
        const destination = args.to ?? joinPath(folder, `${checksum.slice(0, 12)}-${name}`);
        const absolute = resolvePath(destination);

        // Writes are confined to the export folder (or the local workspace, for
        // local sessions): an agent must not be able to drop files anywhere.
        const allowedRoots = [resolvePath(folder)];
        if (workspace && !parseMountPath(workspace.path)) allowedRoots.push(resolvePath(workspace.path));
        const contained = allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`));
        if (!contained) {
          throw new Error(`refusing to write "${destination}": export targets are limited to ${folder}`);
        }

        mkdirSync(dirnamePath(absolute), { recursive: true });
        writeFileSync(absolute, buffer);
        pruneExports(folder);
        const digest = createHash('sha256').update(buffer).digest('hex');
        return (
          `exported ${info.size} bytes from ${target} on ${host}\n` +
          `sha256: ${digest}\n` +
          `local file: ${absolute}\n\n` +
          'That path is a real local file: present it, open it in Explorer, or read it with local tools.'
        );
      },
    }),

    tool({
      name: 'presence_import',
      description:
        'Upload a LOCAL file to the remote machine 鈥?the missing local鈫抮emote direction of presence_export, and the only way to create binary files remotely (images, PDFs, build artifacts, attachments under ~/.dsh/attachments). Writes atomically, creates parent directories, can set a mode, and returns the sha256 so both sides can be checked. format:\'json\' returns {remotePath, localPath, sizeBytes, sha256, mode} with the full digest. Limit: 64 MiB; for larger files use presence_exec with scp/rsync.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          description: 'Absolute local path (Windows drive paths welcome), e.g. C:\\Users\\...\\attachments\\v1\\objects\\ab\\ab12....png',
        },
        to: {
          type: 'string',
          required: true,
          description: 'Remote destination: absolute, workspace-relative, presence URL, or local mount path.',
        },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        mode: { type: 'string', description: 'Octal mode for the destination, e.g. "755". Defaults to 644 for a new file, or the existing file\'s mode.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing remote file. Defaults to true; pass false to fail instead.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {remotePath, localPath, sizeBytes, sha256, mode}. The digest is complete, not abbreviated. Defaults to text.',
        },
      },
      async execute(args, exec) {
        ensureWritable();
        const rawSource = String(args.source ?? '').trim();
        if (!rawSource) throw new Error('source is required');
        const localSource = resolvePath(rawSource.startsWith('~') ? joinPath(homedir(), rawSource.slice(1)) : rawSource);
        let localStat;
        try {
          localStat = statSync(localSource);
        } catch {
          throw new Error(`local file not found: ${localSource}`);
        }
        if (!localStat.isFile()) throw new Error(`${localSource} is not a regular file`);
        if (localStat.size > EXPORT_CAP) {
          throw new Error(`${localSource} is ${localStat.size} bytes; import is capped at ${EXPORT_CAP} bytes 鈥?use presence_exec with scp/rsync for larger files`);
        }

        const buffer = readFileSync(localSource);
        const digest = createHash('sha256').update(buffer).digest('hex');

        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.to);
        const existing = await connection.stat(target);
        if (existing.exists && existing.isDir) throw new Error(`${target} is a directory on ${host}`);
        if (existing.exists && args.overwrite === false) {
          throw new Error(`${target} already exists on ${host}; pass overwrite:true to replace it`);
        }
        const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
        if (parent) {
          const made = await connection.exec(`mkdir -p ${shq(parent)}`, { timeoutMs: 30_000 });
          if (made.code !== 0) throw new Error(`cannot create parent directory ${parent}: ${made.stderr.trim()}`);
        }
        const mode = parseMode(args.mode) ?? (existing.exists ? undefined : 0o644);
        const result = await connection.writeText(target, buffer, { mode });
        const after = await connection.stat(target);
        const modeText = modeLabel(after.exists ? after.mode : result.mode);
        if (args.format === 'json') {
          return jsonText({
            remotePath: target,
            localPath: localSource,
            sizeBytes: result.bytes ?? buffer.length,
            sha256: digest,
            mode: modeText,
          });
        }
        return (
          `imported ${buffer.length} bytes to ${target} on ${host}${modeText ? ` mode ${modeText}` : ''}\n` +
          `sha256: ${digest}\n` +
          `local source: ${localSource}`
        );
      },
    }),

    tool({
      name: 'presence_trash',
      description:
        'Delete a remote path RECOVERABLY: it is moved into `~/.dsh/presence-trash/<timestamp>/` on the same machine (no install, no extra service) and the restore path is returned. Prefer this over `rm -rf` for anything inside a workspace. Actions: trash (one path, or up to 50 paths in one call), list (recent trash containers, newest first; a single movedAtISO per entry), restore (move one back).',
      parameters: {
        action: { type: 'string', required: true, enum: ['trash', 'list', 'restore'], description: 'What to do.' },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', description: 'For trash: the remote path to move into the trash. For list: substring filter on trashPath/name.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'For trash: several remote paths in one call (1-50, mutually exclusive with path). Each item is reported on its own, so one failure does not hide the others.',
        },
        trashPath: { type: 'string', description: 'For restore: the path returned by trash (the container), not the original location.' },
        to: { type: 'string', description: 'For restore: where to put it back, e.g. the original path.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description:
            'Return one text block containing JSON. trash => {trashPath, sizeBytes, sourceRemoved, strategy, restoreHint} for one path, or {results:[{path, trashPath, sizeBytes, sourceRemoved, strategy, restoreHint} | {path, error}], trashed, failed} for paths; list => array of {trashPath, name, movedAtISO}; restore => {restored, from, to}. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        if (args.action === 'trash') {
          if (args.path !== undefined && args.paths !== undefined) {
            throw new Error('pass either path or paths, not both');
          }
          const inputs = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : args.path ? [args.path] : [];
          if (inputs.length === 0) throw new Error('trash requires a path (or paths)');
          if (inputs.length > TRASH_MAX_PATHS) {
            throw new Error(`trash moves at most ${TRASH_MAX_PATHS} paths per call, got ${inputs.length}`);
          }
          if (typeof connection.trash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
          const results = [];
          for (const input of inputs) {
            let target = String(input);
            try {
              target = await remotePath(connection, workspace, input);
              const result = await connection.trash(target);
              const after = await connection.stat(target).catch(() => null);
              results.push({
                path: target,
                trashPath: result.trashPath,
                sizeBytes: result.size ?? null,
                entries: result.entries ?? null,
                sourceRemoved: after ? after.exists !== true : false,
                strategy: result.strategy,
                restoreHint: `presence_trash {action:'restore', trashPath:${JSON.stringify(result.trashPath)}, to:${JSON.stringify(target)}}`,
              });
            } catch (error) {
              results.push({ path: target, error: error?.message ?? String(error) });
            }
          }
          // A single `path` keeps the shape callers already parse.
          if (args.paths === undefined) {
            const single = results[0];
            if (single.error) throw new Error(single.error);
            if (args.format === 'json') {
              return jsonText({
                trashPath: single.trashPath,
                sizeBytes: single.sizeBytes,
                sourceRemoved: single.sourceRemoved,
                strategy: single.strategy,
                restoreHint: single.restoreHint,
              });
            }
            return (
              `moved to trash on ${host}\n` +
              `original: ${single.path}\n` +
              `trash: ${single.trashPath}\n` +
              `${single.entries ?? '?'} files, ${single.sizeBytes === null ? 'size unknown' : formatBytes(single.sizeBytes)}\n` +
              `source removed: ${single.sourceRemoved ? 'yes' : 'no'}\n` +
              `restore with ${single.restoreHint}`
            );
          }
          const failed = results.filter((row) => row.error).length;
          if (args.format === 'json') {
            return jsonText({
              results: results.map((row) =>
                row.error
                  ? { path: row.path, error: row.error }
                  : {
                      path: row.path,
                      trashPath: row.trashPath,
                      sizeBytes: row.sizeBytes,
                      sourceRemoved: row.sourceRemoved,
                      strategy: row.strategy,
                      restoreHint: row.restoreHint,
                    },
              ),
              trashed: results.length - failed,
              failed,
            });
          }
          const lines = results.map((row) =>
            row.error
              ? `${row.path}  error: ${row.error}`
              : `${row.path} -> ${row.trashPath} (${row.sizeBytes === null ? 'size unknown' : formatBytes(row.sizeBytes)}, source removed: ${row.sourceRemoved ? 'yes' : 'no'})`,
          );
          return clip([`moved ${results.length - failed}/${results.length} path(s) to trash on ${host}`, ...lines].join('\n'));
        }
        if (args.action === 'list') {
          if (typeof connection.listTrash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
          const needle = args.path === undefined || args.path === null ? '' : String(args.path).trim();
          // A filter should search more than the newest page, then sort/trim.
          const entries = await connection.listTrash({ limit: needle ? 1000 : 20 });
          const rows = entries
            .filter((entry) => !needle || entry.trashPath.includes(needle) || String(entry.name ?? '').includes(needle))
            .map((entry) => {
              const movedAtMs = toMtimeMs(entry.movedAt);
              return { trashPath: entry.trashPath, name: entry.name, movedAtMs };
            })
            .sort((a, b) => (b.movedAtMs ?? 0) - (a.movedAtMs ?? 0));
          if (args.format === 'json') {
            // One time field only: the container's own mtime is the move time.
            return jsonText(
              rows.map((row) => ({ trashPath: row.trashPath, name: row.name, movedAtISO: toISO(row.movedAtMs) })),
            );
          }
          if (rows.length === 0) return `trash is empty on ${host}${needle ? ` for "${needle}"` : ''}`;
          return clip(rows.map((row) => `${formatMtime(row.movedAtMs ?? Number.NaN)}  ${row.trashPath}`).join('\n'));
        }
        if (!args.trashPath) throw new Error('restore requires trashPath');
        if (!args.to) throw new Error('restore requires to (the original location; the container does not record it)');
        if (typeof connection.restoreTrash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
        const restored = await connection.restoreTrash(args.trashPath, { to: args.to });
        if (args.format === 'json') {
          return JSON.stringify({ restored: true, from: args.trashPath, to: restored.to ?? args.to }, null, 2);
        }
        return `restored ${args.trashPath} to ${restored.to ?? args.to} on ${host}`;
      },
    }),

    tool({
      name: 'presence_edit',
      description:
        'Replace exact text inside a file on a remote machine. Use this 鈥?or the built-in `edit` tool, which also reaches the remote workspace 鈥?instead of `sed -i`, `perl -pi`, or `python -c` for remote edits: it is atomic, refuses an anchor that occurs more than once unless replaceAll is set, and reports how many occurrences changed. Returns a compact diff of the changed lines (context +/-2, max 100 lines/8 KiB); dryRun:true validates the anchor and computes the same diff without writing. The file keeps its mode (an executable stays executable). Inside a workspace, relative paths resolve against the workspace root.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        old: { type: 'string', description: 'Exact text to replace, including indentation.' },
        oldString: { type: 'string', description: 'Alias for `old` (same spelling as the built-in edit tool).' },
        new: { type: 'string', description: 'Replacement text.' },
        newString: { type: 'string', description: 'Alias for `new` (same spelling as the built-in edit tool).' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
        replace_all: { type: 'boolean', description: 'Alias for replaceAll (same spelling as the built-in edit tool).' },
        dryRun: {
          type: 'boolean',
          description: 'Validate the anchor and show the compact diff without writing the file. Defaults to false.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {path, replaced, dryRun, bytesBefore, bytesAfter, sizeBytes, actualSizeBytes, projectedSizeBytes, diff}. `sizeBytes` is the size the file really has (on-disk for a dry run, written size otherwise). Defaults to text.',
        },
      },
      async execute(args, exec) {
        const oldText = args.old ?? args.oldString;
        const newText = args.new ?? args.newString;
        if (typeof oldText !== 'string' || oldText === '') throw new Error('old (or oldString) is required');
        if (typeof newText !== 'string') throw new Error('new (or newString) is required');
        const dryRun = args.dryRun === true;
        if (!dryRun) ensureWritable();
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`${target} does not exist on ${host} 鈥?nothing to edit (use presence_write to create it)`);
        if (info.isDir) throw new Error(`${target} is a directory on ${host}`);
        const replaceAll = Boolean(args.replaceAll ?? args.replace_all);
        const before = (await connection.readText(target, { length: Number.MAX_SAFE_INTEGER })).content;
        const occurrences = before.split(oldText).length - 1;
        if (occurrences === 0) throw new Error('text to replace was not found');
        if (occurrences > 1 && !replaceAll) {
          throw new Error(`text occurs ${occurrences} times; pass replaceAll or a longer anchor`);
        }
        let replaced = replaceAll ? occurrences : 1;
        let after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
        const bytesBefore = Buffer.byteLength(before, 'utf8');
        // The size the edited content would produce, computed before any write.
        const projectedSizeBytes = Buffer.byteLength(after, 'utf8');
        let bytesAfter = projectedSizeBytes;
        let actualSizeBytes = bytesBefore;
        if (!dryRun) {
          const result = await connection.editText(target, oldText, newText, { replaceAll });
          replaced = result.replaced;
          after = (await connection.readText(target, { length: Number.MAX_SAFE_INTEGER })).content;
          bytesAfter = result.bytes;
          actualSizeBytes = result.bytes;
        }
        const diff = diffLines(before, after);
        await markObserved(exec, args.path);
        if (args.format === 'json') {
          return jsonText({
            path: target,
            replaced,
            dryRun,
            bytesBefore,
            bytesAfter,
            // sizeBytes is what the file really has: the on-disk size for a dry
            // run, the written size otherwise. `projectedSizeBytes` is the edit.
            sizeBytes: actualSizeBytes,
            actualSizeBytes,
            projectedSizeBytes,
            diff,
          });
        }
        const verb = dryRun ? 'would edit' : 'edited';
        const note = dryRun ? ` (dry run: ${bytesBefore} B → ${projectedSizeBytes} B projected; nothing written)` : '';
        return `${verb} ${target} on ${host}: ${replaced} occurrence(s), ${bytesBefore} -> ${bytesAfter} bytes${note}\n${diff}`;
      },
    }),

    tool({
      name: 'presence_search',
      description:
        'Search file contents on a remote machine with the tools that machine already has (ripgrep, falling back to grep). Smart-case: lowercase patterns match case-insensitively, any uppercase letter makes them exact 鈥?the same as the built-in grep. Inside a workspace the search root defaults to the workspace. `path` may be a single file or a directory; every match is reported as path:line:text. `include` accepts one glob (*.ts), a brace list (*.{js,jsx}) or a comma-separated list (*.txt,*.dat); spaces are trimmed. The result states the limit and whether it truncated; countOnly returns the exact number of matching lines instead. A bad regex or an unreadable/oversized tree is an error, never a silent empty result.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to the active workspace\'s machine.' },
        pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
        path: { type: 'string', description: 'File or directory to search, absolute or workspace-relative. Defaults to the workspace root, else the remote home directory.' },
        include: { type: 'string', description: 'Only files matching this glob. Accepts *.ts, *.{js,jsx}, or a comma-separated list such as *.txt,*.dat (spaces are trimmed).' },
        limit: { type: 'number', description: 'Maximum matches to return. Defaults to 200.' },
        countOnly: { type: 'boolean', description: 'Return only the exact count of matching lines, not the matches themselves. Defaults to false.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {pattern, root, countOnly, matchCount, truncated, matches:[{file, line, column?, text}]}. countOnly keeps matches empty. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = args.path ? await remotePath(connection, workspace, args.path) : workspace?.path ?? (await connection.homePath());

        // Fail loudly instead of pretending "no matches": a missing path or a
        // bad regex must not look like an empty result.
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`${target} does not exist on ${host}`);
        if (!info.isDir && !info.isFile) throw new Error(`${target} on ${host} is not a regular file or directory`);

        const limit = Math.max(1, args.limit ?? 200);
        const { matches, truncated, total, warning } = await remoteGrep(connection, {
          root: target,
          pattern: args.pattern,
          include: args.include,
          limit,
          smartCase: true,
          countOnly: Boolean(args.countOnly),
        });
        const warn = warning ? `\n(warning: some paths were not searchable 鈥?${warning.slice(0, 300)})` : '';

        if (args.format === 'json') {
          const matchCount = total ?? matches.length;
          return jsonText({
            pattern: args.pattern,
            root: target,
            countOnly: Boolean(args.countOnly),
            matchCount,
            truncated: truncated === true,
            matches: args.countOnly
              ? []
              : matches.map((match) => ({
                  file: match.path,
                  line: match.lineNumber,
                  ...(match.column === undefined ? {} : { column: match.column }),
                  text: match.line,
                })),
          });
        }
        if (args.countOnly) {
          return `${total} matching line(s) for ${args.pattern} under ${target} on ${host}${warn}`;
        }
        if (matches.length === 0) {
          return `no matches for ${args.pattern} under ${target} on ${host} (limit ${limit}, not truncated)${warn}`;
        }
        const lines = matches.map(formatMatchLine);
        const header = truncated
          ? total === null
            ? `showing ${matches.length} of more than ${limit} matches (truncated; limit ${limit}) on ${host}:`
            : `showing ${matches.length} of ${total} matches (truncated; limit ${limit}) on ${host}:`
          : `${total ?? matches.length} match(es) on ${host} (not truncated; limit ${limit}):`;
        const footer = truncated
          ? '\n(more matches exist 鈥?use countOnly for an exact total, narrow path/include, or raise limit)'
          : '';
        return `${header}\n${clip(lines.join('\n'))}${footer}${warn}`;
      },
    }),

    tool({
      name: 'presence_glob',
      description:
        'Find files on the remote machine by glob pattern. Use this instead of `glob`, which only scans the local disk and silently returns an empty result for a remote workspace. An absolute pattern such as /srv/app/*.py carries its own root and needs no path. All matches are sorted newest-first before `limit` is applied, and the result reports the total number of matches. Returns absolute paths with size and mtime when the host\'s find supports -printf; otherwise names only, and says so.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Glob relative to the search root, e.g. "src/**/*.ts", or absolute, e.g. "/srv/app/*.py".' },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', description: 'Directory to search from. Ignored by an absolute pattern; defaults to the workspace root.' },
        limit: { type: 'number', description: 'Maximum files to return, applied after the newest-first sort. Defaults to 200.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: an array of {path, sizeBytes, mtimeISO, mtimeMs}, newest first. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const limit = Math.max(1, args.limit ?? 200);
        const rawPattern = String(args.pattern);
        const absolute = splitGlobPattern(rawPattern);
        const pattern = absolute ? absolute.pattern : rawPattern;
        const base = absolute
          ? absolute.root
          : args.path
            ? await remotePath(connection, workspace, args.path)
            : workspace?.path ?? (await connection.homePath());
        const info = await connection.stat(base);
        if (!info.exists) throw new Error(`${base} does not exist on ${host}`);
        if (!info.isDir) throw new Error(`${base} on ${host} is not a directory`);

        const detailed = await remoteGlobDetailed(connection, { root: base, pattern, limit, stats: true });
        const prefix = base.replace(/\/+$/, '');
        if (args.format === 'json') {
          return jsonText(
            detailed.entries.map((entry) => ({
              path: `${prefix}/${entry.path}`,
              sizeBytes: entry.size ?? null,
              mtimeISO: toISO(entry.mtime),
              mtimeMs: entry.mtime ?? null,
            })),
          );
        }
        if (detailed.files.length === 0) {
          return `no files match ${rawPattern} under ${base} on ${host} (limit ${limit}, not truncated)`;
        }
        const lines = detailed.entries.map((entry) => {
          const path = `${prefix}/${entry.path}`;
          if (!detailed.stats || entry.mtime === null) return path;
          return `${formatMtime(entry.mtime)}  ${formatBytes(entry.size).padStart(9)}  ${path}`;
        });
        const totalLabel =
          detailed.total === null
            ? detailed.scanCapped
              ? `${detailed.scanned}+`
              : `more than ${limit}`
            : String(detailed.total);
        const newest = detailed.stats ? ', newest first' : '';
        const header = detailed.truncated
          ? `showing ${detailed.entries.length} of ${totalLabel} files on ${host} under ${base} (truncated; limit ${limit}${newest}):`
          : `${totalLabel} file(s) on ${host} under ${base} (not truncated; limit ${limit}${newest}):`;
        const footer = [];
        if (detailed.truncated) {
          footer.push(`(more files match 鈥?raise limit or narrow the pattern)`);
        }
        if (detailed.scanCapped) {
          footer.push('(the host-side scan stopped at its file cap, so the total is a lower bound)');
        }
        if (!detailed.stats) {
          footer.push('(sizes and mtimes unavailable: this host\'s find does not support -printf; listing names only)');
        }
        return `${header}\n${clip(lines.join('\n'))}${footer.length ? `\n${footer.join('\n')}` : ''}`;
      },
    }),

    tool({
      name: 'presence_stat',
      description:
        'Report metadata for 1-100 remote paths in one call: type, size, octal mode, mtime and optionally sha256. Missing paths come back with exists:false instead of failing the whole call, so it doubles as an existence check. A symlink is described as a link and never followed unless followSymlinks is set; sha256 is computed only for regular files. format:\'json\' returns [{path, exists, type, sizeBytes, mode, mtimeISO, mtimeMs, sha256?}].',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Remote paths (absolute, ~/..., presence://host/path, or workspace-relative). 1-100 entries.',
        },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        hash: {
          type: 'boolean',
          description: 'Also compute sha256 for existing regular files. Defaults to false.',
        },
        followSymlinks: {
          type: 'boolean',
          description: 'Stat and hash through symlinks instead of describing the link itself. Defaults to false.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: one object per path. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const inputs = Array.isArray(args.paths) ? args.paths : [];
        if (inputs.length === 0) throw new Error('paths is required: pass 1-100 remote paths');
        if (inputs.length > STAT_MAX_PATHS) {
          throw new Error(`presence_stat reports at most ${STAT_MAX_PATHS} paths per call, got ${inputs.length}`);
        }
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const targets = [];
        for (const input of inputs) targets.push(await remotePath(connection, workspace, input));
        const rows = await statRemotePaths(connection, targets, {
          hash: args.hash === true,
          followSymlinks: args.followSymlinks === true,
        });
        if (args.format === 'json') return jsonText(rows);
        const header = ['path', 'type', 'size', 'mode', 'mtime', ...(args.hash === true ? ['sha256'] : [])].join('\t');
        const lines = rows.map((row) => {
          const size = row.type === 'dir' || row.sizeBytes === null ? '-' : formatBytes(row.sizeBytes);
          const cells = [row.path, row.type, size, row.mode ?? '-', row.mtimeISO ?? '-'];
          if (args.hash === true) cells.push(row.sha256 ?? '-');
          return cells.join('\t');
        });
        const found = rows.filter((row) => row.exists).length;
        const hashed = rows.filter((row) => row.sha256).length;
        const summary =
          `${rows.length} path(s): ${found} found, ${rows.length - found} missing` +
          (args.hash === true ? `, ${hashed} hashed` : '');
        return clip([header, ...lines, '', summary].join('\n'));
      },
    }),

    tool({
      name: 'presence_jobs',
      description:
        'List, inspect, wait for, or stop background commands started with presence_exec {background:true}. Jobs are detached process groups on the remote machine, so they survive the SSH connection. list is scoped to this session by default (all:true shows every session); status shows one job\'s state, exit code, pid, label, start time and log; wait follows a job until it exits or the timeout, returning its state, exit code, log size and log tail; stop takes a jobId, or a raw pgid + host when the job id was lost, then verifies whether the pid is still alive and reports the exit summary. format:\'json\' returns structured data for list/status/stop.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'wait', 'status', 'stop'],
          description: 'What to do: list jobs, show one job\'s status, wait for one to exit, or stop one.',
        },
        jobId: { type: 'string', description: 'For wait/status/stop: the job id returned when it started.' },
        timeoutMs: { type: 'number', description: 'For wait: how long to wait for the job to exit. Defaults to 120000.' },
        tailLines: { type: 'number', description: 'For wait: how many log lines to return, clamped to 1-500 (0 or omitted = 40). Defaults to 40.' },
        all: { type: 'boolean', description: 'For list: include jobs from every session, not just this one. Defaults to false.' },
        pgid: { type: 'number', description: 'For stop: a process group id to signal directly, as an alternative to jobId. Requires host.' },
        host: { type: 'string', description: 'For stop with pgid: the ssh alias of the machine that owns the process group.' },
        port: {
          type: 'number',
          description: 'For stop: after stopping, wait up to 3s for this remote TCP port to be released and report `portReleased` (true/false/null). Use it to prove a stopped server really freed its port.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'For list/status/wait/stop: return one text block containing JSON instead of human-readable text. wait adds `timedOut`; a running job\'s `exitSummary` is null; stop adds `port`/`portReleased` when a port is given. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const action = args.action;
        if (action === 'list') {
          const sessionId = sessionIdOf(exec);
          let jobs = args.all || !sessionId ? await pool.listJobs() : await pool.listJobs({ sessionId });
          if (!Array.isArray(jobs)) jobs = [];
          const scoped = jobs.some((job) => Object.prototype.hasOwnProperty.call(job, 'sessionId'));
          let visible = jobs;
          if (!args.all && scoped && sessionId) {
            // null/undefined sessionId means "started outside a session"; it
            // cannot belong to a different session, so keep it visible.
            visible = jobs.filter(
              (job) => job.sessionId === sessionId || job.sessionId === null || job.sessionId === undefined,
            );
          }
          if (visible.length === 0) {
            if (args.format === 'json') return '[]';
            return args.all
              ? 'no background jobs'
              : 'no background jobs for this session (use all:true to list every session)';
          }
          if (args.format === 'json') return JSON.stringify(visible.map((job) => jobRecord(job)), null, 2);
          const lines = visible.map((job) => {
            // The stored command carries the pool's pipefail probe; the list
            // should show what the caller actually asked to run.
            const label = stripPipefailPrelude(job.label ?? job.command ?? '(no label)') || '(no label)';
            const age = job.startedAt ? `${Math.round((Date.now() - job.startedAt) / 1000)}s` : '?';
            const exit =
              job.exitCode === undefined || job.exitCode === null ? (job.state === 'running' ? '-' : '?') : job.exitCode;
            return (
              `${job.id}  ${label}\n` +
              `  state=${job.state ?? 'unknown'}  exit=${exit}  pid=${job.pid ?? '?'}  host=${job.host}  age=${age}  log=${job.logPath ?? '?'}`
            );
          });
          return `${visible.length} job(s):\n${lines.join('\n')}`;
        }

        if (action === 'status') {
          if (!args.jobId) throw new Error('status requires a jobId');
          let jobs = await pool.listJobs();
          if (!Array.isArray(jobs)) jobs = [];
          const job = jobs.find((entry) => entry.id === args.jobId);
          if (!job) throw new Error(`no background job "${args.jobId}"`);
          const body = jobRecord(job);
          // A running job has no exit yet: null says exactly that, where
          // "unknown" reads like a failed probe.
          const exitSummary = body.state === 'running' ? null : exitSummaryOf(body);
          if (args.format === 'json') return jsonText({ ...body, exitSummary });
          const lines = [
            `job ${body.id} on ${body.host}: ${body.state}`,
            `pid: ${body.pid ?? '-'}  started: ${body.startedAt ? formatMtime(body.startedAt) : '-'}`,
            `exit=${body.exitCode ?? '-'}${body.exitSignal ? ` signal=${body.exitSignal}` : ''}`,
          ];
          if (body.label) lines.push(`label: ${body.label}`);
          if (body.command) lines.push(`command: ${body.command}`);
          if (body.cwd) lines.push(`cwd: ${body.cwd}`);
          if (body.logPath) {
            lines.push(`log: ${body.logPath}${body.logSize !== null ? ` (${formatBytes(body.logSize)})` : ''}`);
          }
          return clip(lines.join('\n'));
        }

        if (action === 'wait') {
          if (!args.jobId) throw new Error('wait requires a jobId');
          const timeoutMs = Math.max(0, Number(args.timeoutMs ?? 120_000) || 0);
          const tailLines = clampTailLines(args.tailLines);
          const job =
            typeof pool.waitJob === 'function'
              ? await pool.waitJob(args.jobId, { timeoutMs, tailLines })
              : await waitForJobFallback(pool, args.jobId, { timeoutMs, tailLines });
          // waitJob returns when the deadline passes; `running`/`unknown` is
          // the only state that means "the wait ended before the job did".
          const state = job.state ?? 'unknown';
          const timedOut = state === 'running' || state === 'unknown';
          if (args.format === 'json') {
            return jsonText({
              id: job.id,
              host: job.host ?? null,
              state,
              timedOut,
              exitCode: job.exitCode ?? null,
              exitSignal: job.exitSignal ?? null,
              exitSummary: timedOut ? null : exitSummaryOf(job),
              logSize: job.logSize ?? null,
              logTail: job.logTail ?? null,
            });
          }
          return formatWaitReport(job, { timeoutMs, tailLines, timedOut });
        }

        if (action === 'stop') {
          if (args.jobId) {
            const result = await pool.stopJob(args.jobId);
            const check = await verifyPidAlive(pool, result.host, result.pid);
            const portReleased = await portReleasedAfterStop(pool, result.host, args.port);
            if (args.format === 'json') {
              return jsonText({
                id: result.id,
                host: result.host,
                pid: result.pid,
                stopped: result.stopped,
                wasAlive: result.wasAlive ?? null,
                reason: result.reason ?? null,
                survivors: result.survivors ?? null,
                exitCode: result.exitCode ?? null,
                exitSignal: result.exitSignal ?? null,
                exitSummary: exitSummaryOf({ ...result, state: 'exited' }),
                verified: check.verified,
                alive: check.alive,
                port: args.port ?? null,
                portReleased,
              });
            }
            const portLine =
              args.port === undefined || args.port === null
                ? null
                : `port ${args.port} released: ${portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no'}`;
            if (result.stopped) {
              const lines = [`stopped ${result.id} (pid ${result.pid}) on ${result.host}`, stopSummary(result, check)];
              if (portLine) lines.push(portLine);
              return lines.join('\n');
            }
            const reason = result.reason ?? `survivors ${(result.survivors ?? []).join(', ') || 'unknown'}`;
            const lines = [`nothing to stop for ${result.id}: ${reason}`, stopSummary(result, check)];
            if (portLine) lines.push(portLine);
            return lines.join('\n');
          }
          if (args.pgid === undefined || args.pgid === null) {
            throw new Error('stop requires a jobId, or pgid plus host');
          }
          const pgid = Number(args.pgid);
          if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${args.pgid}`);
          if (!args.host) throw new Error('stop with pgid requires host');
          let result;
          if (typeof pool.stopProcessGroup === 'function') {
            result = await pool.stopProcessGroup(args.host, pgid);
          } else {
            const connection = await pool.connection(args.host);
            if (typeof connection.stopBackground !== 'function') {
              throw new Error(`stopping a bare process group is not supported on ${args.host}`);
            }
            result = await connection.stopBackground(pgid);
          }
          const survivors = Array.isArray(result?.survivors) ? result.survivors : [];
          const stopped = result?.stopped !== false && survivors.length === 0;
          const check = await verifyPidAlive(pool, args.host, pgid);
          const portReleased = await portReleasedAfterStop(pool, args.host, args.port);
          if (args.format === 'json') {
            return jsonText({
              id: result?.id ?? null,
              host: args.host,
              pid: pgid,
              stopped,
              wasAlive: result?.wasAlive ?? null,
              reason: result?.reason ?? null,
              survivors,
              exitCode: result?.exitCode ?? null,
              exitSignal: result?.exitSignal ?? null,
              exitSummary: exitSummaryOf({ ...result, state: 'exited' }),
              verified: check.verified,
              alive: check.alive,
              port: args.port ?? null,
              portReleased,
            });
          }
          const portLine =
            args.port === undefined || args.port === null
              ? ''
              : `\nport ${args.port} released: ${portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no'}`;
          return stopped
            ? `stopped process group ${pgid} on ${args.host}\n${stopSummary({ ...result, pid: pgid }, check)}${portLine}`
            : `could not stop process group ${pgid} on ${args.host}: survivors ${survivors.join(', ') || 'unknown'}\n${stopSummary({ ...result, pid: pgid }, check)}${portLine}`;
        }

        throw new Error(`unknown action ${action}`);
      },
    }),

    tool({
      name: 'presence_forward',
      description:
        'Forward a local TCP port to a port on the remote machine, so a service it runs (dev server, Jupyter, TensorBoard) is reachable at http://127.0.0.1:<localPort> on this machine. Every forward opened here shows up automatically in the right-sidebar 「端口转发」 panel (and 设置 → Presence), where the user can open it in a browser or stop it. Actions: open (needs remotePort), list, close (needs forwardId). Prefer this over guessing `ssh -L` in a shell.',
      parameters: {
        action: { type: 'string', required: true, enum: ['open', 'close', 'list'], description: 'What to do with the forward.' },
        remotePort: { type: 'number', description: 'For open: the port the remote service listens on.' },
        localPort: { type: 'number', description: 'For open: local port to bind. Defaults to an OS-assigned free port.' },
        remoteHost: { type: 'string', description: 'For open: remote bind host. Defaults to 127.0.0.1.' },
        forwardId: { type: 'string', description: 'For close: the id returned by open.' },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: open => {id, localHost, localPort, remoteHost, remotePort, url, requestedLocalPort, localPortFallback, state}; list => array; close => {id, closed}. Defaults to text.',
        },
      },
      async execute(args, exec) {
        if (args.action === 'list') {
          const tunnels = pool.listTunnels();
          const rows = tunnels.map((tunnel) => ({
            id: tunnel.id,
            host: tunnel.host,
            localHost: '127.0.0.1',
            localPort: tunnel.localPort,
            remoteHost: tunnel.remoteHost,
            remotePort: tunnel.remotePort,
            url: tunnel.url,
            state: 'open',
          }));
          if (args.format === 'json') return JSON.stringify(rows, null, 2);
          if (tunnels.length === 0) return 'no active forwards';
          return [
            `${tunnels.length} active forward(s) — the right-sidebar 端口转发 panel shows these too:`,
            ...tunnels.map((tunnel) =>
              `${tunnel.id}  ${tunnel.url}  ->  ${tunnel.host}:${tunnel.remoteHost}:${tunnel.remotePort}`),
          ].join('\n');
        }
        if (args.action === 'close') {
          if (!args.forwardId) throw new Error('close requires a forwardId');
          const closed = await pool.closeTunnel(args.forwardId);
          if (args.format === 'json') return JSON.stringify({ id: args.forwardId, closed }, null, 2);
          return closed ? `closed forward ${args.forwardId} (the Ports panel updated too)` : `no forward ${args.forwardId}`;
        }
        if (!args.remotePort) throw new Error('open requires remotePort');
        const { host } = await pickScope(args, exec);
        const tunnel = await pool.openForward(host, {
          localPort: args.localPort ?? undefined,
          remoteHost: args.remoteHost ?? '127.0.0.1',
          remotePort: args.remotePort,
        });
        const url = `http://127.0.0.1:${tunnel.localPort}`;
        if (args.format === 'json') {
          return JSON.stringify(
            {
              id: tunnel.id,
              localHost: '127.0.0.1',
              localPort: tunnel.localPort,
              remoteHost: tunnel.remoteHost,
              remotePort: tunnel.remotePort,
              url,
              requestedLocalPort: tunnel.requestedLocalPort,
              localPortFallback: tunnel.localPortFallback === true,
              state: 'open',
            },
            null,
            2,
          );
        }
        return [
          `opened forward ${tunnel.id}`,
          `local:  ${url}`,
          `remote: ${host}:${tunnel.remoteHost}:${tunnel.remotePort}`,
          tunnel.localPortFallback
            ? `note: local port ${tunnel.requestedLocalPort} was busy, so an OS-assigned port was used; pass localPort to pick another.`
            : 'note: the local port mirrors the remote port; pass localPort to override.',
          'The right-sidebar 端口转发 panel lists it automatically — open the local URL in a browser to check the service.',
          `Stop it with presence_forward { "action": "close", "forwardId": "${tunnel.id}" }.`,
        ].join('\n');
      },
    }),

    tool({
      name: 'presence_port_probe',
      description:
        'Check 1-20 TCP ports on one remote machine in a single call: whether anything listens (ss -ltnp, with pid/process) and whether a TCP connect is accepted (bash /dev/tcp, python3 fallback). expect:\'open\' or \'closed\' makes ok report whether the actual state matches; waitMs polls every 250 ms until every port matches (or, without expect, until every port is open), then reports the last state. Use it to prove a server started, or that a stopped job or closed forward really released its port. format:\'json\' returns [{port, listening, pid, process, probe, ok}].',
      parameters: {
        ports: {
          type: 'array',
          items: { type: 'number' },
          required: true,
          description: 'TCP ports to check (1-20 entries).',
        },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        expect: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Expected state; `ok` compares the actual state with it. Without it, `ok` means "open".',
        },
        waitMs: {
          type: 'number',
          description: 'Poll every 250 ms until the expectation holds, up to this many milliseconds. Defaults to 0 (one shot).',
        },
        probe: {
          type: 'boolean',
          description: 'Also do a TCP connect check (bash /dev/tcp, python3 fallback). Defaults to true; false only reads the ss table.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: one object per port. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const inputs = Array.isArray(args.ports) ? args.ports : [];
        if (inputs.length === 0) throw new Error('ports is required: pass 1-20 TCP ports');
        if (inputs.length > PROBE_MAX_PORTS) {
          throw new Error(`presence_port_probe checks at most ${PROBE_MAX_PORTS} ports per call, got ${inputs.length}`);
        }
        const ports = [...new Set(inputs.map((value) => Number(value)))];
        for (const port of ports) {
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid TCP port ${port}`);
        }
        const { host } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const probe = args.probe !== false;
        const expect = args.expect === 'open' || args.expect === 'closed' ? args.expect : null;
        const waitMs = Math.max(0, Math.min(120_000, Number(args.waitMs) || 0));
        const deadline = Date.now() + waitMs;
        let snapshot;
        let rows;
        for (;;) {
          snapshot = await inspectRemotePorts(connection, ports, { probe });
          rows = ports.map((port) => portProbeRow(port, snapshot, { expect, probe }));
          const satisfied =
            expect === null ? rows.every((row) => row.listening || row.probe === 'accepted') : rows.every((row) => row.ok);
          if (satisfied || waitMs <= 0 || Date.now() >= deadline) break;
          await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
        }
        if (args.format === 'json') return jsonText(rows);
        const header = 'port\tlistening\tpid\tprocess\tprobe\tok';
        const lines = rows.map(
          (row) =>
            `${row.port}\t${row.listening ? 'yes' : 'no'}\t${row.pid ?? '-'}\t${row.process ?? '-'}\t${row.probe}\t${row.ok ? 'yes' : 'no'}`,
        );
        const openCount = rows.filter((row) => row.listening || row.probe === 'accepted').length;
        const footer = [
          `${rows.length} port(s): ${openCount} open`,
          expect === null ? null : `expect: ${expect} · pass: ${rows.every((row) => row.ok) ? 'yes' : 'no'}`,
          snapshot.ssAvailable ? null : 'ss is unavailable: listening falls back to the TCP connect probe',
          probe && rows.some((row) => row.probe === 'skipped')
            ? 'TCP connect probe unavailable (no bash with /dev/tcp and no python3)'
            : null,
        ].filter(Boolean);
        return clip([header, ...lines, '', ...footer].join('\n'));
      },
    }),

    tool({
      name: 'presence_http_probe',
      description:
        'Probe a remote HTTP service through a temporary tunnel: wait for the remote port (by default), forward it to this machine, GET one or more paths, assert status codes and body substrings, then ALWAYS close the tunnel in a finally block and verify the local port was released. paths defaults to ["/"], expectStatus to [200]; expectBody is a list of substrings that must all appear somewhere in the concatenated bodies. pass is true when every status is expected and every substring was found. format:\'json\' returns {forwardId, localPort, remotePort, results, pass, portReleased}. This replaces the exec + forward + fetch + forward close + port check chain with one call.',
      parameters: {
        remotePort: { type: 'number', required: true, description: 'Remote TCP port serving HTTP.' },
        localPort: { type: 'number', description: 'Local port for the tunnel. Defaults to the remote port, falling back to an OS-assigned one.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Request paths, 1-20. A path without a leading "/" gets one. Defaults to ["/"].',
        },
        expectStatus: {
          type: 'array',
          items: { type: 'number' },
          description: 'Accepted HTTP status codes. Defaults to [200].',
        },
        expectBody: {
          type: 'array',
          items: { type: 'string' },
          description: 'Substrings that must all appear somewhere in the concatenated response bodies.',
        },
        timeoutMs: { type: 'number', description: 'Per-request timeout. Defaults to 15000.' },
        waitForPort: {
          type: 'boolean',
          description: 'Wait up to timeoutMs for the remote port to accept TCP before forwarding. Defaults to true.',
        },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return one text block containing JSON: {forwardId, localPort, remotePort, results, pass, portReleased}. Defaults to text.',
        },
      },
      async execute(args, exec) {
        const remotePort = Number(args.remotePort);
        if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          throw new Error(`remotePort must be a TCP port number, got ${args.remotePort}`);
        }
        const timeoutMs = Math.max(100, Math.min(120_000, Number(args.timeoutMs) || 15_000));
        const paths = (Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : ['/']).map((value) => {
          const path = String(value);
          return path.startsWith('/') ? path : `/${path}`;
        });
        const expectStatus = (Array.isArray(args.expectStatus) && args.expectStatus.length > 0
          ? args.expectStatus
          : [200]
        ).map((value) => Number(value));
        const expectBody = (Array.isArray(args.expectBody) ? args.expectBody : []).map(String);
        const { host } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        if (args.waitForPort !== false) {
          const waited = await waitForRemotePort(connection, remotePort, timeoutMs);
          if (!waited.ready) {
            throw new Error(
              `nothing is listening on 127.0.0.1:${remotePort} on ${host} after ${waited.waitedMs}ms`,
            );
          }
        }
        const tunnel = await pool.openForward(host, {
          localPort: args.localPort,
          remoteHost: '127.0.0.1',
          remotePort,
        });
        const base = `http://127.0.0.1:${tunnel.localPort}`;
        const results = [];
        const bodies = [];
        let portReleased = null;
        try {
          for (const path of paths) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const response = await fetch(base + path, { signal: controller.signal });
              const body = await response.text();
              bodies.push(body);
              results.push({
                path,
                status: response.status,
                bytes: Buffer.byteLength(body, 'utf8'),
                contentType: response.headers.get('content-type') ?? null,
                body,
              });
            } catch (error) {
              results.push({
                path,
                status: null,
                bytes: 0,
                contentType: null,
                body: '',
                error: String(error?.message ?? error),
              });
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          // Never leave a tunnel behind, whatever the probes did.
          await pool.closeTunnel(tunnel.id).catch(() => {});
          portReleased = await localPortReleased(tunnel.localPort);
        }
        const missingBody = expectBody.filter((needle) => !bodies.join('\n').includes(needle));
        const rows = results.map((row) => ({
          path: row.path,
          status: row.status,
          bytes: row.bytes,
          contentType: row.contentType,
          bodyMatched: expectBody.length === 0 ? null : expectBody.every((needle) => row.body.includes(needle)),
          ...(row.error ? { error: row.error } : {}),
        }));
        const pass =
          results.every((row) => row.status !== null && expectStatus.includes(row.status)) && missingBody.length === 0;
        if (args.format === 'json') {
          return jsonText({
            forwardId: tunnel.id,
            localPort: tunnel.localPort,
            remotePort: tunnel.remotePort,
            results: rows,
            pass,
            portReleased,
          });
        }
        const table = results.map(
          (row) =>
            `${row.path}\t${row.status ?? 'ERR'}\t${row.bytes}\t${row.contentType ?? '-'}\t` +
            `${expectBody.length === 0 ? '-' : expectBody.every((needle) => row.body.includes(needle)) ? 'yes' : 'no'}` +
            `${row.error ? `\t${row.error}` : ''}`,
        );
        const notes = [
          `forward ${tunnel.id}: ${base} -> ${host}:127.0.0.1:${tunnel.remotePort} (closed after the probe)`,
          `expect: status ${expectStatus.join('/')}${
            expectBody.length ? ` · body ${expectBody.map((needle) => JSON.stringify(needle)).join(', ')}` : ''
          }`,
          missingBody.length ? `missing body: ${missingBody.map((needle) => JSON.stringify(needle)).join(', ')}` : null,
          `pass: ${pass ? 'yes' : 'no'} · local port ${tunnel.localPort} released: ` +
            `${portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no'}`,
        ].filter(Boolean);
        return clip(['path\tstatus\tbytes\tcontent-type\tbody', ...table, '', ...notes].join('\n'));
      },
    }),

    tool({
      name: 'presence_terminal',
      description:
        'Drive a persistent interactive terminal on a remote machine. open starts a shell that survives between tool calls; pass `session` to run it inside a named tmux session on the target, so it also survives an SSH drop or an app restart 鈥?reopen with the same name to reattach. write sends keystrokes, read returns new output since the last read, close ends it. Use this for REPLs, ssh sessions, long-running interactive programs and pagers 鈥?not for one-shot commands, which presence_exec handles.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['open', 'write', 'read', 'close', 'list'],
          description: 'What to do with the terminal.',
        },
        host: { type: 'string', description: 'For open: ssh alias. Defaults to the active workspace\'s machine.' },
        session: {
          type: 'string',
          description:
            'For open: name of a tmux session to create or reattach. Use it whenever the terminal must outlive the connection; reuse the same name to come back to the same shell.',
        },
        terminalId: { type: 'string', description: 'The id returned by open; required for write, read and close.' },
        data: { type: 'string', description: 'For write: the exact characters to send, including newlines.' },
        cwd: {
          type: 'string',
          description: 'For open: directory the shell starts in, absolute or workspace-relative. Defaults to the workspace root when there is one.',
        },
        command: { type: 'string', description: 'For open: program the shell runs, default "bash".' },
        ackOnly: {
          type: 'boolean',
          description: 'For write: return only an ack and leave the output for the next read, instead of waiting for and returning it. Defaults to false.',
        },
        waitMs: { type: 'number', description: 'For read: wait up to this long for new output. Defaults to 0.' },
        cols: { type: 'number', description: 'For open: terminal width. Defaults to 120.' },
        rows: { type: 'number', description: 'For open: terminal height. Defaults to 32.' },
        killSession: {
          type: 'boolean',
          description: 'For close: also kill the named tmux session instead of leaving it running. Defaults to false.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description:
            'Return one text block containing JSON. open => {terminalId, host, cwd, shell}; write => {terminalId, writtenBytes, output} (output is null with ackOnly); read => {terminalId, output, closed}; list => array of {terminalId, host, session, closed, pending}; close => {terminalId, closed, session, killedSession, host}. Defaults to text.',
        },
      },
      async execute(args, exec) {
        if (args.action === 'open') {
          const { host, workspace } = await pickScope(args, exec);
          const connection = await pool.connection(host);
          const cwd = args.cwd ? await remotePath(connection, workspace, args.cwd) : workspace?.path ?? null;
          const shell = String(args.command ?? 'bash').trim() || 'bash';
          const { id, host: opened, session } = await pool.openTerminal(host, {
            cols: args.cols ?? 120,
            rows: args.rows ?? 32,
            session: args.session,
          });
          if (!session || args.cwd !== undefined || args.command !== undefined) {
            // A plain terminal always gets a deterministic shell and directory;
            // an attached tmux session is only steered when asked explicitly.
            const startup = `${cwd ? `cd ${shq(cwd)} && ` : ''}exec ${shell}`;
            pool.writeTerminal(id, `${startup}\n`);
            await sleep(200);
            // Drop the startup echo/prompt so the caller's first read is theirs.
            await pool.readTerminal(id, { waitMs: 400 }).catch(() => {});
          }
          if (args.format === 'json') {
            return jsonText({ terminalId: id, host: opened, cwd, shell });
          }
          const first = await pool.readTerminal(id, { waitMs: 600 });
          const where = session ? `${opened} (tmux session "${session}")` : opened;
          return `terminal ${id} opened on ${where}${first.data ? `\n${clip(first.data)}` : ''}`;
        }
        if (args.action === 'list') {
          const terminals = pool.listTerminals();
          if (args.format === 'json') {
            return jsonText(
              terminals.map((terminal) => ({
                terminalId: terminal.id,
                host: terminal.host,
                session: terminal.session ?? null,
                closed: terminal.closed === true,
                pending: terminal.pending,
              })),
            );
          }
          if (terminals.length === 0) return 'no open terminals';
          return terminals
            .map((terminal) => `${terminal.id}  ${terminal.host}  ${terminal.closed ? 'closed' : 'open'}  ${terminal.pending} byte(s) unread`)
            .join('\n');
        }
        if (!args.terminalId) throw new Error(`${args.action} requires a terminalId`);
        if (args.action === 'write') {
          const data = args.data ?? '';
          const writtenBytes = Buffer.byteLength(data, 'utf8');
          pool.writeTerminal(args.terminalId, data);
          if (args.ackOnly) {
            if (args.format === 'json') {
              return jsonText({ terminalId: args.terminalId, writtenBytes, output: null });
            }
            return `sent ${writtenBytes} bytes to ${args.terminalId}; read the output with presence_terminal {action:'read'}`;
          }
          await sleep(150);
          const read = await pool.readTerminal(args.terminalId, { waitMs: 400 });
          const output = read.data ?? '';
          if (args.format === 'json') {
            return jsonText({ terminalId: args.terminalId, writtenBytes, output });
          }
          return clip(output || '(no output yet)');
        }
        if (args.action === 'read') {
          const result = await pool.readTerminal(args.terminalId, { waitMs: args.waitMs ?? 0 });
          const data = result.data ?? '';
          if (args.format === 'json') {
            return jsonText({ terminalId: args.terminalId, output: data, closed: result.closed === true });
          }
          const body = data || '(no new output)';
          const bytes = Buffer.byteLength(data, 'utf8');
          // A full-screen replay is recognizable by its size; clip() only
          // mentions the cap, not the byte count of a large-but-intact buffer.
          const sizeNote = bytes >= TERMINAL_LARGE_OUTPUT_BYTES ? `\n(${bytes} bytes)` : '';
          return `${clip(body)}${sizeNote}${result.closed ? '\n(terminal is closed)' : ''}`;
        }
        if (args.action === 'close') {
          let session = null;
          let host = null;
          try {
            const terminal = pool.terminal(args.terminalId);
            session = terminal.session ?? null;
            host = terminal.host ?? null;
          } catch {
            /* already gone */
          }
          const killedSession = Boolean(args.killSession && session && host);
          if (killedSession) {
            const connection = await pool.connection(host);
            await connection.exec(`tmux kill-session -t ${shq(session)}`).catch(() => {});
          }
          pool.closeTerminal(args.terminalId);
          if (args.format === 'json') {
            return jsonText({ terminalId: args.terminalId, closed: true, session, killedSession, host });
          }
          if (killedSession) return `closed ${args.terminalId} and killed tmux session "${session}"`;
          if (session) return `closed ${args.terminalId}; tmux session "${session}" keeps running 鈥?reopen with session:"${session}" to reattach`;
          return `closed ${args.terminalId}`;
        }
        throw new Error(`unknown action ${args.action}`);
      },
    }),
  ];
}
