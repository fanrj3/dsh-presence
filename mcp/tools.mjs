// The MCP tools. Each handler wraps the vendored Presence kernel
// (src/pool.js, src/core/connection.mjs, src/remote-search.js, ... — a verbatim
// copy of the plugin kernel, kept in sync by scripts/sync-kernel.mjs).
// stdout is the JSON-RPC channel: log with console.error only.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { connect as connectLocal } from 'node:net';
import { promisify } from 'node:util';
import { z } from 'zod';

const MCP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

import { remoteGrep, remoteGlobDetailed, splitGlobPattern } from './src/remote-search.js';
import { guardDestructive, destructiveKind, shq } from './src/destructive.js';
import { exportDirectory, pruneExports } from './src/localpaths.js';

import {
  settings,
  getPool,
  pickHost,
  knownHosts,
  remotePath,
  workspaceRoot,
  execCwd,
  clip,
  clipMiddle,
  stripAnsi,
  parseMode,
  formatBytes,
  formatMtime,
  expandLocalHome,
} from './lib/core.mjs';

const MAX_TRANSFER = 64 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const OUTPUT_CAP = 32 * 1024;
const JSON_STREAM_CAP = 16 * 1024;
const READ_MANY_MAX_FILES = 50;
const READ_MANY_DEFAULT_BYTES_PER_FILE = 16 * 1024;
const READ_MANY_DEFAULT_BYTES_TOTAL = 256 * 1024;
const LS_RECURSIVE_MAX_DEPTH = 6;
const LS_RECURSIVE_MAX_ENTRIES = 2000;
const DIFF_LINE_CAP = 100;
const DIFF_BYTE_CAP = 8 * 1024;

// presence_jobs purge is an MCP-level view filter: the kernel keeps every job
// it started, so this Set only hides the ids from listings in this process.
const PURGED_JOB_IDS = new Set();

// The kernel tunnel object carries no timestamp, so presence_forward records
// when this process opened each tunnel (epoch ms; rendered as ISO on output).
const FORWARD_CREATED_MS = new Map();

function forwardCreatedAt(id) {
  const ms = FORWARD_CREATED_MS.get(id);
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

// Signal exit codes (128 + signal) as reported by the remote shell wrapper.
const SIGNAL_NAMES = {
  129: 'SIGHUP',
  130: 'SIGINT',
  131: 'SIGQUIT',
  132: 'SIGILL',
  133: 'SIGTRAP',
  134: 'SIGABRT',
  135: 'SIGBUS',
  136: 'SIGFPE',
  137: 'SIGKILL',
  138: 'SIGUSR1',
  139: 'SIGSEGV',
  140: 'SIGUSR2',
  141: 'SIGPIPE',
  142: 'SIGALRM',
  143: 'SIGTERM',
  144: 'SIGSTKFLT',
  145: 'SIGCHLD',
  146: 'SIGCONT',
  147: 'SIGSTOP',
  148: 'SIGTSTP',
  149: 'SIGTTIN',
  150: 'SIGTTOU',
  151: 'SIGURG',
  152: 'SIGXCPU',
  153: 'SIGXFSZ',
  154: 'SIGVTALRM',
  155: 'SIGPROF',
  156: 'SIGWINCH',
  157: 'SIGIO',
  158: 'SIGPWR',
};

// `signal 143 (SIGTERM)` / `code 0` / `unknown` — one comparable field for the
// two exit shapes the kernel reports.
function exitSummary({ exitCode = null, exitSignal = null } = {}) {
  if (exitSignal !== null && exitSignal !== undefined) {
    const raw = Number(exitSignal);
    if (Number.isFinite(raw)) {
      const name = SIGNAL_NAMES[raw] ?? SIGNAL_NAMES[raw + 128] ?? null;
      return name ? `signal ${raw} (${name})` : `signal ${raw}`;
    }
    return `signal ${exitSignal}`;
  }
  if (exitCode !== null && exitCode !== undefined) return `code ${exitCode}`;
  return 'unknown';
}


function ok(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function errorHint(message) {
  if (/authentication failed|no usable key|permission denied \(publickey\)|keyboard-interactive/iu.test(message)) {
    return 'the host needs key/agent auth or a password; export PRESENCE_PASSWORD_<ALIAS> for this process';
  }
  if (/nothing is listening on/iu.test(message)) {
    return 'start the remote service first, or verify the port with presence_exec { command: "ss -ltn" }';
  }
  if (/timed out|timeout/iu.test(message)) {
    return 'raise timeoutMs, or use background=true + presence_jobs for long commands';
  }
  if (/no host "/u.test(message)) return 'call presence_list_hosts to see the available aliases';
  if (/no such file/iu.test(message)) return 'list the parent directory with presence_glob, then read the exact file';
  if (/read-only/iu.test(message)) return 'this server runs with PRESENCE_READ_ONLY=1; writes are disabled by the operator';
  if (/is a directory/iu.test(message)) return 'use presence_glob to list it, or pass a file path to presence_read';
  return '';
}

function fail(error) {
  const message = error && typeof error === 'object' ? error.message ?? String(error) : String(error);
  const hint = errorHint(message);
  return {
    content: [{ type: 'text', text: `error: ${message}${hint ? `\nhint: ${hint}` : ''}` }],
    isError: true,
  };
}

function describeExec(result) {
  const parts = [];
  const stdout = stripAnsi(result.stdout ?? '');
  const stderr = stripAnsi(result.stderr ?? '');
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  const meta = [`exit=${result.code ?? '?'}`];
  if (result.signal) meta.push(`signal=${result.signal}`);
  if (result.durationMs !== undefined) meta.push(`${result.durationMs} ms`);
  if (result.timedOut) meta.push('timed out');
  parts.push(`(${meta.join(' · ')})`);
  return clip(parts.join('\n\n'), 32 * 1024);
}

function connectionFor(host) {
  return getPool().connection(host);
}

async function resolveHostAndConnection(args) {
  const host = pickHost(args);
  const connection = await connectionFor(host);
  return { host, connection };
}

function modeOrUndefined(value) {
  return value === undefined || value === '' ? undefined : parseMode(value);
}

function isReadOnly() {
  return settings.readOnly;
}

function ensureWritable() {
  if (isReadOnly()) throw new Error('this MCP server is running read-only (PRESENCE_READ_ONLY=1)');
}

// ---------------------------------------------------------------- helpers
// A compact octal mode such as "0644", or null when the exact mode is unknown.
function modeLabel(mode) {
  if (!Number.isInteger(mode) || mode < 0) return null;
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

// Trash entries carry movedAt as an ISO string, but older callers may pass
// epoch milliseconds (or a numeric string). Normalize both to milliseconds so
// formatMtime never receives a string and renders an empty cell.
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

function toISO(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Compact JSON for an array, shrunk from the tail until it fits the text cap
// (clipping serialized JSON would make it unparseable).
function jsonArrayText(items, cap = OUTPUT_CAP) {
  let shown = Array.isArray(items) ? items : [];
  let text = JSON.stringify(shown);
  while (text.length > cap && shown.length > 1) {
    shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.8)));
    text = JSON.stringify(shown);
  }
  if (text.length > cap && shown.length === 1 && shown[0] && typeof shown[0] === 'object') {
    // A single oversized object: shrink its string fields, but keep the array
    // wrapper so JSON.parse still sees the documented shape.
    text = `[${jsonObjectText(shown[0], cap - 2)}]`;
  }
  return text.length > cap ? clip(text, cap) : text;
}

// Compact JSON for a shallow object: shrink its longest string fields until it
// fits, so the emitted text stays valid JSON.
function jsonObjectText(value, cap = OUTPUT_CAP) {
  let text = JSON.stringify(value);
  let guard = 0;
  while (text.length > cap && guard < 40) {
    let key = null;
    for (const [name, field] of Object.entries(value)) {
      if (typeof field !== 'string' || field.length === 0) continue;
      if (!key || field.length > value[key].length) key = name;
    }
    if (!key) break;
    value[key] = `${value[key].slice(0, Math.floor(value[key].length / 2))}…`;
    text = JSON.stringify(value);
    guard += 1;
  }
  return text.length > cap ? clip(text, cap) : text;
}

// Common-prefix/common-suffix diff with ±context lines. No LCS: this is meant
// to let an agent verify one exact replacement, not to merge arbitrary files.
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
  let text = rows.length > maxLines
    ? `${rows.slice(0, maxLines).join('\n')}\n… diff truncated (${total - maxLines} more lines)`
    : rows.join('\n');
  return clip(text, maxBytes);
}

// Fit the structured exec result under the text cap while keeping it valid
// JSON: halve the streams first (marking them truncated), then the command/cwd.
function execJsonText(payload, cap = OUTPUT_CAP) {
  let text = JSON.stringify(payload);
  let guard = 0;
  while (text.length > cap && guard < 24) {
    const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
    const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
    const key = stdout.length >= stderr.length ? 'stdout' : 'stderr';
    if (!payload[key]) break;
    payload[key] = payload[key].slice(0, Math.floor(payload[key].length / 2));
    payload[`${key}Truncated`] = true;
    text = JSON.stringify(payload);
    guard += 1;
  }
  for (const key of ['command', 'cwd']) {
    while (text.length > cap && typeof payload[key] === 'string' && payload[key].length > 0) {
      payload[key] = payload[key].slice(0, Math.floor(payload[key].length / 2));
      text = JSON.stringify(payload);
    }
  }
  return text.length > cap ? clip(text, cap) : text;
}

// Back a UTF-8 byte slice up to the last complete character, so a capped read
// never ends in U+FFFD replacement noise.
function safeUtf8End(buffer) {
  const length = buffer.length;
  for (let back = 1; back <= Math.min(4, length); back += 1) {
    const byte = buffer[length - back];
    if ((byte & 0x80) === 0) return length;
    if ((byte & 0xc0) === 0x80) continue;
    let need = 0;
    if ((byte & 0xe0) === 0xc0) need = 2;
    else if ((byte & 0xf0) === 0xe0) need = 3;
    else if ((byte & 0xf8) === 0xf0) need = 4;
    else return length;
    return need <= back ? length : length - back;
  }
  return length;
}

function clipTextToBytes(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), bytes: buffer.length };
  const cut = buffer.subarray(0, Math.max(0, Math.floor(maxBytes)));
  const safe = cut.subarray(0, safeUtf8End(cut));
  return { text: safe.toString('utf8'), bytes: safe.length };
}

async function remoteLineCount(connection, target) {
  try {
    const result = await connection.exec(`wc -l < ${shq(target)}`, { timeoutMs: 30_000 });
    const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

// One file window for read_many: the presence_read line-limit semantics plus a
// hard per-file byte cap; whichever stops first wins.
async function readFileWindow(connection, target, { lineLimit, maxBytes }) {
  const info = await connection.stat(target);
  if (!info.exists) throw new Error(`no such file: ${target}`);
  if (info.isDir) throw new Error(`${target} is a directory`);
  let content;
  let totalLines;
  let truncated;
  if (info.size <= maxBytes) {
    const read = await connection.readText(target, { length: info.size });
    const lines = read.content.split('\n');
    totalLines = lines.length;
    if (lines.length > lineLimit) {
      content = lines.slice(0, lineLimit).join('\n');
      truncated = true;
    } else {
      content = read.content;
      truncated = false;
    }
  } else {
    const { buffer } = await connection.readBytes(target, { offset: 0, length: maxBytes });
    const cut = buffer.subarray(0, safeUtf8End(buffer));
    content = cut.toString('utf8');
    const lines = content.split('\n');
    if (lines.length > lineLimit) content = lines.slice(0, lineLimit).join('\n');
    totalLines = await remoteLineCount(connection, target);
    truncated = true;
  }
  return {
    content,
    sizeBytes: info.size,
    readBytes: Buffer.byteLength(content, 'utf8'),
    totalLines,
    truncated,
    truncatedByTotal: false,
  };
}

// Spend maxBytesTotal front to back: earlier files keep their content and only
// the tail is trimmed, so one large file cannot swallow the whole budget.
function trimToTotalBudget(items, maxBytesTotal) {
  let remaining = Math.max(0, Math.floor(Number(maxBytesTotal) || 0));
  let trimmed = 0;
  for (const item of items) {
    if (item.error) continue;
    const bytes = Number.isFinite(Number(item.readBytes)) ? Number(item.readBytes) : 0;
    if (bytes <= remaining) {
      remaining -= bytes;
      continue;
    }
    const clipped = clipTextToBytes(item.content, remaining);
    item.content = clipped.text;
    item.readBytes = clipped.bytes;
    item.truncated = true;
    item.truncatedByTotal = true;
    remaining = 0;
    trimmed += 1;
  }
  return trimmed;
}

// presence_exec: pick the script interpreter once per host (bash preferred).
const SCRIPT_SHELLS = new Map();

async function scriptShell(connection, host) {
  const cached = SCRIPT_SHELLS.get(host);
  if (cached) return cached;
  let shell = '/bin/sh';
  try {
    const probe = await connection.exec(
      'command -v bash >/dev/null 2>&1 && printf bash || printf sh',
      { timeoutMs: 10_000 },
    );
    shell = String(probe.stdout ?? '').trim() === 'bash' ? 'bash' : '/bin/sh';
  } catch {
    shell = '/bin/sh';
  }
  SCRIPT_SHELLS.set(host, shell);
  return shell;
}

function safeExportName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const segments = raw.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  let name = segments.at(-1) ?? '';
  name = name.replaceAll('\0', '').replaceAll('..', '_');
  if (!name || name === '.' || name === '..') return null;
  return name.slice(0, 200);
}

// Is anything listening on a local TCP port? Used to prove a closed forward
// released its port instead of leaving a socket behind.
function probeLocalPort(port, { timeoutMs = 500 } = {}) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const socket = connectLocal({ host: '127.0.0.1', port: numeric });
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

// ------------------------------------------------------ remote port probes
// `ss -ltnp` line -> { port: { pid, process } } for the requested ports. The
// local address is the fourth column; the process column only carries a pid
// when the socket belongs to a process this user can see.
function parseSsListeners(stdout, wanted) {
  const listeners = new Map();
  const wantedSet = new Set(wanted);
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('State') || line.startsWith('__')) continue;
    const columns = line.split(/\s+/u);
    if (columns.length < 5) continue;
    const address = columns[3];
    const port = Number.parseInt(address.slice(address.lastIndexOf(':') + 1), 10);
    if (!Number.isInteger(port) || !wantedSet.has(port)) continue;
    const pid = /pid=(\d+)/u.exec(line)?.[1];
    const process = /users:\(\("([^"]+)"/u.exec(line)?.[1] ?? null;
    const previous = listeners.get(port);
    if (!previous || (previous.pid === null && pid)) {
      listeners.set(port, { pid: pid ? Number(pid) : null, process });
    }
  }
  return listeners;
}

// One exec answers both questions for a whole round: which ports listen (ss)
// and which accept a TCP connect (bash /dev/tcp, python3 fallback). Passed
// ports are validated integers, so they are safe to splice into the script.
async function inspectRemotePorts(connection, ports, { probe = true, timeoutMs = 20_000 } = {}) {
  const wanted = [...new Set(ports.map((port) => Number(port)))]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
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
  const collect = (text) => {
    for (const match of String(text ?? '').matchAll(/^PB (accepted|timeout|refused) (\d+)$/gmu)) {
      probes.set(Number(match[2]), match[1]);
    }
  };
  collect(stdout);
  if (probe && !stdout.includes('__PB_DONE__')) {
    // No bash, or bash built without /dev/tcp: python3 can still answer.
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

// One report row: `listening` comes from ss (or from an accepted connect when
// ss is unavailable), `probe` from the TCP connect, and `ok` compares that
// state with the caller's expectation ("open" when no expect was given).
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

// Poll until the port stops accepting connections. true = released, false =
// still open after the deadline, null = neither ss nor the probe could answer.
async function waitRemotePortClosed(connection, port, { timeoutMs = 3_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    const snapshot = await inspectRemotePorts(connection, [port], { probe: true });
    const row = portProbeRow(port, snapshot, { probe: true });
    const open = row.listening || row.probe === 'accepted';
    const known = snapshot.ssAvailable || row.probe !== 'skipped';
    if (!open) return known ? true : null;
    if (Date.now() >= deadline) return false;
    await promisify(setTimeout)(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

// A tunnel close can return before the listening socket is gone; probe, retry
// once, and report whether the local port is really released.
async function localPortReleased(port) {
  let connected = await probeLocalPort(port);
  if (connected) {
    await promisify(setTimeout)(120);
    connected = await probeLocalPort(port);
  }
  return connected === false;
}

// presence_stat: batch metadata in one exec. `stat -c` never follows symlinks
// unless followSymlinks is set; sha256sum runs only for regular files (and,
// without followSymlinks, never through a link).
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
    const line = raw.replace(/\r$/u, '');
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
    const digest = /^\\?([0-9a-f]{64})\s+\*?(.+)$/u.exec(line);
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
    const type = info.type === 'regular file'
      ? 'file'
      : info.type === 'directory'
        ? 'dir'
        : info.type === 'symbolic link' ? 'link' : 'other';
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

// Current sha256 of one remote file; null when it cannot be read or the host
// has no sha256sum (callers report that instead of pretending a mismatch).
async function remoteFileSha256(connection, target) {
  const result = await connection.exec(`sha256sum -- ${shq(target)}`, { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  return /^\\?([0-9a-f]{64})\s/mu.exec(String(result.stdout ?? ''))?.[1] ?? null;
}

// Depth-first directory walk for presence_ls recursive: bounded by depth and
// entry count, and it never follows symlinks (so it cannot loop forever).
async function collectRemoteTree(connection, root, { maxEntries, maxDepth }) {
  const rows = [];
  let truncated = false;
  const rootPrefix = root.replace(/\/+$/u, '');
  const walk = async (dir, depth) => {
    let children;
    try {
      children = await connection.list(dir);
    } catch {
      return { bytes: 0, files: 0 };
    }
    const aggregate = { bytes: 0, files: 0 };
    for (const child of children) {
      if (rows.length >= maxEntries) {
        truncated = true;
        break;
      }
      const relPath = child.path.startsWith(`${rootPrefix}/`)
        ? child.path.slice(rootPrefix.length + 1)
        : child.name;
      const row = { entry: child, depth, relPath, recursiveBytes: null };
      rows.push(row);
      if (child.kind === 'dir') {
        if (depth < maxDepth) {
          const sub = await walk(child.path, depth + 1);
          row.recursiveBytes = sub.bytes;
          aggregate.bytes += sub.bytes;
          aggregate.files += sub.files;
        }
      } else if (child.kind === 'file') {
        aggregate.bytes += child.size;
        aggregate.files += 1;
      }
    }
    return aggregate;
  };
  const totals = await walk(root, 1);
  return { rows, truncated, totals };
}



// ------------------------------------------------------------------ tools
export function registerTools(server) {
  // ---------------------------------------------------------------- hosts
  server.registerTool(
    'presence_list_hosts',
    {
      title: 'List Presence hosts',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'List the machines Presence can reach: every Host in ~/.ssh/config plus manual hosts stored by Presence. Returns alias, hostname, port, user and whether a connection is currently open; the default host (PRESENCE_WORKSPACE / PRESENCE_HOST) is marked with "*" in text mode. format="json" returns one object per host with address, state and default flags.',
      inputSchema: {
        format: z.enum(['text', 'json']).optional().describe('"json" returns an array of structured host objects'),
      },
    },
    async (args) => {
      try {
        const hosts = getPool().hosts();
        const defaultHost = settings.workspace?.host ?? settings.defaultHost ?? null;
        if (hosts.length === 0) return ok('no hosts: add machines to ~/.ssh/config or use Presence manual hosts');
        if (args.format === 'json') {
          const rows = hosts.map((entry) => ({
            alias: entry.alias,
            address: `${entry.user ?? '?'}@${entry.hostname}:${entry.port}`,
            user: entry.user ?? null,
            hostname: entry.hostname,
            port: entry.port,
            source: entry.source,
            state: entry.connected ? 'connected' : 'idle',
            connected: entry.connected === true,
            default: entry.alias === defaultHost,
          }));
          return ok(jsonArrayText(rows));
        }
        const lines = hosts.map((entry) => {
          const state = entry.connected ? 'connected' : 'idle';
          const marker = entry.alias === defaultHost ? '*' : '';
          return `${marker}${entry.alias}\t${entry.user ?? '?'}@${entry.hostname}:${entry.port}\t${entry.source}\t${state}` +
            (entry.terminals ? `\tterminals=${entry.terminals}` : '');
        });
        return ok(['alias\taddress\tsource\tstate', ...lines].join('\n'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_connect',
    {
      title: 'Connect to a remote machine',
      description:
        'Open (or reuse) the persistent SSH connection to one machine and report who you are on the far side. Subsequent tools reuse this connection, so this is cheap after the first call. format="json" returns {host, user, hostname, kernel, arch, platform, connectedAtMs}.',
      inputSchema: {
        host: z.string().describe('ssh alias from ~/.ssh/config or a manual Presence host'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns the parsed identity as an object'),
      },
    },
    async (args) => {
      try {
        const { host, connection } = await resolveHostAndConnection(args);
        const who = await connection.exec('printf "%s@%s %s" "$(id -un)" "$(hostname)" "$(uname -srm)"');
        const raw = who.stdout.trim();
        if (args.format === 'json') {
          // `user@hostname Sysname Release Machine`
          const match = /^([^@\s]+)@(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/u.exec(raw);
          return ok(jsonObjectText(match
            ? {
              host,
              user: match[1],
              hostname: match[2],
              platform: match[3],
              kernel: match[4],
              arch: match[5],
              connectedAtMs: connection.connectedAt ?? null,
            }
            : {
              host,
              user: null,
              hostname: null,
              platform: null,
              kernel: null,
              arch: null,
              connectedAtMs: connection.connectedAt ?? null,
              raw,
            }));
        }
        return ok(`${host}: ${raw}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_ls',
    {
      title: 'List a remote directory',
      description:
        'List one remote directory (name, kind, size, mtime). Add recursive=true to walk subdirectories (depth 6, up to 2000 entries) and totalBytes=true to sum file sizes (directories excluded; JSON directories gain recursiveBytes). This is the fastest way to see what a path contains; use presence_glob for pattern search and presence_read for file contents.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        path: z.string().optional().describe('Remote directory (defaults to the workspace root or remote home)'),
        host: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum entries, default 200 (2000 with recursive)'),
        recursive: z.boolean().optional().describe('Walk subdirectories, depth limit 6, at most 2000 entries'),
        totalBytes: z.boolean().optional().describe('Sum file sizes (directories excluded); with recursive, per-directory recursiveBytes'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured entries (sizeBytes, isDir, mtimeISO, mtimeMs)'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const target = args.path
          ? await remotePath(connection, args.path)
          : workspaceRoot() ?? (await connection.homePath());
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`no such directory: ${target}`);
        if (!info.isDir) throw new Error(`${target} is a file; use presence_read`);
        const recursive = args.recursive === true;
        const limit = args.limit ?? (recursive ? LS_RECURSIVE_MAX_ENTRIES : 200);
        const maxEntries = recursive ? Math.min(limit, LS_RECURSIVE_MAX_ENTRIES) : limit;
        let rows;
        let truncated;
        let totals = null;
        let listed = 0;
        if (recursive) {
          const tree = await collectRemoteTree(connection, target, {
            maxEntries,
            maxDepth: LS_RECURSIVE_MAX_DEPTH,
          });
          rows = tree.rows;
          truncated = tree.truncated;
          listed = rows.length;
          if (args.totalBytes === true) totals = tree.totals;
        } else {
          const entries = await connection.list(target);
          const shown = entries.slice(0, maxEntries);
          rows = shown.map((entry) => ({ entry, depth: 0, relPath: entry.name, recursiveBytes: null }));
          truncated = entries.length > shown.length;
          listed = entries.length;
          if (args.totalBytes === true) {
            const files = shown.filter((entry) => entry.kind === 'file');
            totals = { files: files.length, bytes: files.reduce((sum, entry) => sum + entry.size, 0) };
          }
        }
        if (args.format === 'json') {
          const jsonRows = rows.map(({ entry, depth, relPath, recursiveBytes }) => {
            const row = {
              name: entry.name,
              path: entry.path,
              kind: entry.kind,
              sizeBytes: entry.size,
              isDir: entry.kind === 'dir',
              mtimeISO: toISO(entry.mtime),
              mtimeMs: entry.mtime,
            };
            if (recursive) row.depth = depth;
            if (recursive) row.relPath = relPath;
            if (entry.kind === 'dir' && args.totalBytes === true) row.recursiveBytes = recursiveBytes;
            return row;
          });
          return ok(jsonArrayText(jsonRows));
        }
        if (rows.length === 0) {
          return ok(args.totalBytes === true ? `${target} is empty\ntotal: 0 files, 0 bytes` : `${target} is empty`);
        }
        const lines = rows.map(({ entry, relPath }) => {
          const kind = entry.kind === 'dir' ? 'dir ' : entry.kind === 'link' ? 'link' : 'file';
          const size = entry.kind === 'dir' ? '-' : formatBytes(entry.size);
          return `${kind}\t${size}\t${formatMtime(entry.mtime)}\t${recursive ? relPath : entry.name}`;
        });
        const notes = [];
        if (truncated) {
          notes.push(
            recursive
              ? `… truncated at ${maxEntries} entries (totals cover the listed entries only)`
              : `… truncated (showing ${rows.length} of ${listed})`,
          );
        }
        if (args.totalBytes === true && totals) notes.push(`total: ${totals.files} files, ${totals.bytes} bytes`);
        const footer = notes.length ? `\n${notes.join('\n')}` : '';
        const body = clip(`${target}\n${lines.join('\n')}`, Math.max(1024, OUTPUT_CAP - footer.length));
        return ok(`${body}${footer}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----------------------------------------------------------------- exec
  server.registerTool(
    'presence_exec',
    {
      title: 'Run a shell command on a remote machine',
      annotations: { destructiveHint: true, openWorldHint: true },
      description:
        'Run one command on the remote machine over the existing SSH connection. Defaults to the workspace directory (PRESENCE_WORKSPACE or PRESENCE_CWD) when cwd is omitted. Pass script (a script body) instead of command to avoid multi-level shell quoting: it is written to a remote temp file (mode 0700), run with bash (or /bin/sh) and removed afterwards. Destructive commands (rm -r, git clean, find -delete, truncate...) are dry-run until confirm=true. Use background=true for long-running servers and poll them with presence_jobs; waitForPort waits for the started service to accept connections. format="json" returns structured data (exitCode/stdout/stderr for the foreground; jobId/pid/cwd/command/logPath for the background), and saveStdout writes a successful command\'s stdout to a remote file.',
      inputSchema: {
        command: z.string().optional().describe('Shell command to run (mutually exclusive with script)'),
        script: z.string().optional().describe('Script body: written to a remote temp file, run with bash or /bin/sh, then deleted (mutually exclusive with command)'),
        host: z.string().optional().describe('Machine alias; defaults to PRESENCE_WORKSPACE host or PRESENCE_HOST'),
        cwd: z.string().optional().describe('Directory to run in (absolute remote path or workspace-relative)'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Per-command timeout, default 120000'),
        background: z.boolean().optional().describe('Start detached and return a job id instead of waiting'),
        label: z.string().optional().describe('Label for a background job'),
        confirm: z.boolean().optional().describe('Set true to actually run a destructive command or script'),
        maxOutput: z.number().int().min(1000).max(200000).optional().describe('Output characters to return, default 16384'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns one structured JSON object (streams clipped to 16 KiB)'),
        saveStdout: z.string().optional().describe('Write stdout to this remote path after a successful (exit 0) foreground command'),
        waitForPort: z.number().int().min(1).max(65535).optional().describe('With background=true: wait up to 15 s until this port accepts TCP on the remote 127.0.0.1'),
      },
    },
    async (args, extra) => {
      try {
        const host = pickHost(args);
        const connection = await connectionFor(host);
        const cwd = await execCwd(connection, args.cwd);
        if (extra?.signal?.aborted) {
          return { content: [{ type: 'text', text: 'cancelled' }], isError: true };
        }
        const command = String(args.command ?? '');
        const script = typeof args.script === 'string' ? args.script : '';
        const hasScript = script.trim() !== '';
        if (hasScript && command.trim() !== '') {
          throw new Error('pass either command or script, not both');
        }
        if (!hasScript && command.trim() === '') {
          throw new Error('command or script is required');
        }

        // A script is materialized next to the command; the outer finally always
        // removes it, including when the command fails or is refused.
        let scriptPath = null;
        let displayCommand = command;
        try {
          if (hasScript) {
            const kind = destructiveKind(script);
            if (kind && args.confirm !== true) {
              const report = [
                'dry run only — the script looks destructive and was NOT executed.',
                `detected: ${kind}`,
                'Script mode cannot resolve individual targets; re-run with confirm=true to execute it.',
              ].join('\n');
              if (args.format === 'json') {
                return ok(jsonObjectText({
                  dryRun: true,
                  requiresConfirm: true,
                  targets: [],
                  command: null,
                  script: true,
                  detected: kind,
                  report,
                }));
              }
              return ok(report);
            }
            scriptPath = `/tmp/presence-exec-${randomBytes(6).toString('hex')}.sh`;
            await connection.writeText(scriptPath, script, { mode: 0o700 });
            const shell = await scriptShell(connection, host);
            displayCommand = `${shell} ${shq(scriptPath)}`;
          } else {
            const guard = await guardDestructive({
              connection,
              command,
              cwd: cwd ?? null,
              workspace: workspaceRoot(),
              host,
              confirm: args.confirm === true,
            }).catch((error) => {
              throw error; // guard refusals (root/home/workspace) are hard errors
            });
            if (guard && !args.confirm) {
              // JSON callers get the guard report as data: no need to parse text.
              if (args.format === 'json') {
                return ok(jsonObjectText({
                  dryRun: true,
                  requiresConfirm: true,
                  targets: guard.targets ?? [],
                  command,
                  cwd: cwd ?? null,
                  detected: guard.kind ?? null,
                  resolved: guard.resolved ?? [],
                  report: guard.report,
                }));
              }
              const text = [
                'dry run only — the command looks destructive and was NOT executed.',
                guard.report,
                '',
                'Re-run with confirm=true to execute it.',
              ].join('\n');
              return ok(text);
            }
          }

          if (args.background) {
            if (args.saveStdout) {
              throw new Error('saveStdout needs a foreground command; a background job already writes its output to logPath');
            }
            const job = await getPool().startJob(host, {
              command: displayCommand,
              cwd: cwd ?? null,
              label: args.label ?? null,
              sessionId: settings.sessionId,
            });
            let portCheck = null;
            if (args.waitForPort !== undefined && args.waitForPort !== null) {
              if (job.exitedEarly) {
                portCheck = { ready: false, checked: false, waitedMs: 0, reason: 'the job exited immediately' };
              } else {
                const waited = await connection.waitForPort({
                  port: Number(args.waitForPort),
                  host: '127.0.0.1',
                  timeoutMs: 15_000,
                });
                portCheck = { ...waited, checked: true };
              }
            }
            if (args.format === 'json') {
              const body = {
                jobId: job.id,
                pid: job.pid,
                cwd: job.cwd ?? cwd ?? (await connection.homePath()),
                command: displayCommand,
                logPath: job.logPath ?? null,
                label: args.label ?? null,
              };
              if (hasScript) body.script = true;
              if (portCheck?.checked) {
                body.ready = portCheck.ready === true;
                body.waitedMs = portCheck.waitedMs ?? null;
              }
              if (job.exitedEarly) {
                body.state = 'exited';
                body.exitCode = job.exitCode ?? null;
              }
              return ok(execJsonText(body));
            }
            const lines = [`started job ${job.id} (pid ${job.pid}) on ${host}`];
            if (job.cwd) lines.push(`cwd: ${job.cwd}`);
            if (job.logPath) lines.push(`log: ${job.logPath}`);
            if (job.exitedEarly) {
              lines.push(`the process exited immediately (code=${job.exitCode ?? '?'})`);
              if (job.logTail) lines.push(`--- log tail ---\n${job.logTail}`);
            } else {
              lines.push(`poll with presence_jobs { "action": "wait", "jobId": "${job.id}" }`);
            }
            if (portCheck) {
              if (!portCheck.checked) {
                lines.push(`port ${args.waitForPort} not checked: ${portCheck.reason}`);
              } else if (portCheck.ready) {
                lines.push(
                  `port ${args.waitForPort} accepts TCP on 127.0.0.1 after ${portCheck.waitedMs} ms` +
                    ` (pid ${job.pid} is the job's process-group leader; the listening process may be a child)`,
                );
              } else {
                lines.push(
                  `port ${args.waitForPort} is NOT listening after ${portCheck.waitedMs} ms` +
                    `${job.logPath ? ` — check the log: tail -n 50 ${job.logPath}` : ''}`,
                );
              }
            }
            return ok(clip(lines.join('\n'), OUTPUT_CAP));
          }

          const saveTarget = args.saveStdout ? await remotePath(connection, args.saveStdout) : null;
          const effective = cwd ? `cd ${shq(cwd)} && ${displayCommand}` : displayCommand;
          let result;
          try {
            result = await connection.exec(effective, { timeoutMs: args.timeoutMs ?? 120_000, signal: extra?.signal });
          } catch (error) {
            const message = String(error?.message ?? error);
            if (/timed out/u.test(message)) {
              if (args.format === 'json') {
                return {
                  content: [{
                    type: 'text',
                    text: execJsonText({
                      cwd: cwd ?? (await connection.homePath()),
                      command: displayCommand,
                      ...(hasScript ? { script: true } : {}),
                      exitCode: null,
                      signal: null,
                      durationMs: null,
                      timedOut: true,
                      stdout: '',
                      stderr: '',
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    }),
                  }],
                  isError: true,
                };
              }
              return { content: [{ type: 'text', text: `command timed out: ${message}` }], isError: true };
            }
            throw error;
          }

          let savedStdout = null;
          let saveError = null;
          if (saveTarget) {
            if (result.code === 0) {
              try {
                await connection.exec(`mkdir -p ${shq(dirname(saveTarget))}`, { timeoutMs: 30_000 });
                const written = await connection.writeText(saveTarget, result.stdout ?? '');
                savedStdout = { path: saveTarget, sizeBytes: written.bytes };
              } catch (error) {
                saveError = String(error?.message ?? error);
              }
            }
          }

          if (args.format === 'json') {
            const stdoutRaw = stripAnsi(result.stdout ?? '');
            const stderrRaw = stripAnsi(result.stderr ?? '');
            const stdout = clip(stdoutRaw, JSON_STREAM_CAP);
            const stderr = clip(stderrRaw, JSON_STREAM_CAP);
            const payload = {
              cwd: cwd ?? (await connection.homePath()),
              command: displayCommand,
              ...(hasScript ? { script: true } : {}),
              exitCode: result.code ?? null,
              signal: result.signal ?? null,
              durationMs: result.durationMs ?? null,
              timedOut: result.timedOut === true,
              stdout,
              stderr,
              stdoutTruncated: stdoutRaw.length > JSON_STREAM_CAP,
              stderrTruncated: stderrRaw.length > JSON_STREAM_CAP,
            };
            if (savedStdout) payload.savedStdout = savedStdout;
            if (saveError) payload.savedStdoutError = saveError;
            if (saveTarget && !savedStdout && !saveError) {
              payload.savedStdoutSkipped = { path: saveTarget, reason: `exit ${result.code ?? '?'} is not 0` };
            }
            return ok(execJsonText(payload));
          }

          const text = describeExec(result);
          const clipped = args.maxOutput && text.length > args.maxOutput ? clipMiddle(text, args.maxOutput) : text;
          const notes = [];
          if (savedStdout) {
            notes.push(`stdout saved to ${savedStdout.path} (${savedStdout.sizeBytes} bytes)`);
          } else if (saveError) {
            notes.push(`stdout save to ${saveTarget} failed: ${saveError}`);
          } else if (saveTarget) {
            notes.push(`stdout not saved to ${saveTarget}: exit ${result.code ?? '?'} is not 0`);
          }
          return ok(clip(`$ ${displayCommand}${cwd ? `   (cwd: ${cwd})` : ''}\n${clipped}${notes.length ? `\n${notes.join('\n')}` : ''}`, OUTPUT_CAP));
        } finally {
          if (scriptPath) {
            await connection.exec(`rm -f ${shq(scriptPath)}`, { timeoutMs: 15_000 }).catch(() => {});
          }
        }
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----------------------------------------------------------------- files
  server.registerTool(
    'presence_read',
    {
      title: 'Read a remote file',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Read a remote text file with line numbers. Use offset/limit for big files; files larger than 32 MiB are read as a line window. Pass raw=true (or numbered=false) for verbatim content with no line numbers and no line-count trailer.',
      inputSchema: {
        path: z.string().describe('Remote path (absolute, ~/..., presence://host/path, or workspace-relative)'),
        host: z.string().optional(),
        offset: z.number().int().min(1).optional().describe('First line to read, 1-based, default 1'),
        limit: z.number().int().min(1).max(20000).optional().describe('Lines to read, default 2000'),
        numbered: z.boolean().optional().describe('Prefix each line with a line number (default true); false returns content without numbering or trailer'),
        raw: z.boolean().optional().describe('Return exactly the file content: no line numbers and no (N lines total) trailer'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const target = await remotePath(connection, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`no such file: ${target}`);
        if (info.isDir) throw new Error(`${target} is a directory (use presence_glob to list it)`);
        const offset = args.offset ?? 1;
        const limit = args.limit ?? 2000;
        const raw = args.raw === true;
        const numbered = !raw && args.numbered !== false;
        let content;
        let footer = '';
        if (info.size > MAX_READ_BYTES) {
          const windowed = await connection.readTextWindow(target, { lineOffset: offset, lineLimit: limit });
          content = windowed.content;
          if (numbered) footer = `\n(${windowed.totalLines ?? '?'} lines total${windowed.truncated ? ', windowed' : ''})`;
        } else {
          const read = await connection.readText(target, { length: Math.min(info.size, MAX_READ_BYTES) });
          content = read.content;
          const lines = content.split('\n');
          content = lines.slice(offset - 1, offset - 1 + limit).join('\n');
          if (numbered) footer = `\n(${lines.length} lines total)`;
        }
        const body = numbered
          ? content
            .split('\n')
            .map((line, index) => `${String(offset + index).padStart(6)}  ${line}`)
            .join('\n')
          : content;
        return ok(clip(`${body}${footer}`, OUTPUT_CAP));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_read_many',
    {
      title: 'Read several remote files in one call',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Read up to 50 remote text files in one call. Each file is read up to maxBytesPerFile (default 16 KiB) and reported separately, so one large file no longer consumes the whole budget; maxBytesTotal (default 256 KiB) only trims the tail when the sum of all files exceeds it. Text output is one "=== path ===" section per file, line-numbered like presence_read; pass raw=true for verbatim content. format="json" returns [{path, content, sizeBytes, readBytes, totalLines, truncated, truncatedByTotal, error?}] with verbatim content; limit caps lines per file, whichever (line limit or byte cap) comes first. hash=true adds the sha256 of each file whose returned content is complete (null when truncated); it is computed locally from the returned content, so no extra remote read is needed.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(READ_MANY_MAX_FILES).describe('Remote paths (absolute, ~/..., presence://host/path, or workspace-relative)'),
        host: z.string().optional(),
        raw: z.boolean().optional().describe('Text mode: return verbatim content without line numbers'),
        limit: z.number().int().min(1).max(20000).optional().describe('Lines per file, default 2000 (applied before the byte cap)'),
        maxBytesPerFile: z.number().int().min(16).max(16 * 1024 * 1024).optional()
          .describe(`Per-file byte cap, default ${READ_MANY_DEFAULT_BYTES_PER_FILE}`),
        maxBytesTotal: z.number().int().min(16).max(64 * 1024 * 1024).optional()
          .describe(`Total byte budget; only the tail is trimmed past it, default ${READ_MANY_DEFAULT_BYTES_TOTAL}`),
        hash: z.boolean().optional().describe('Include the sha256 of each complete file (null when the content is truncated)'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns a machine-readable array'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const limit = args.limit ?? 2000;
        const raw = args.raw === true;
        const maxBytesPerFile = args.maxBytesPerFile ?? READ_MANY_DEFAULT_BYTES_PER_FILE;
        const maxBytesTotal = args.maxBytesTotal ?? READ_MANY_DEFAULT_BYTES_TOTAL;
        const items = [];
        for (const input of args.paths.slice(0, READ_MANY_MAX_FILES)) {
          const target = await remotePath(connection, input);
          try {
            const window = await readFileWindow(connection, target, { lineLimit: limit, maxBytes: maxBytesPerFile });
            items.push({ path: target, ...window });
          } catch (error) {
            items.push({
              path: target,
              error: String(error?.message ?? error),
              content: '',
              sizeBytes: null,
              readBytes: 0,
              totalLines: null,
              truncated: false,
              truncatedByTotal: false,
            });
          }
        }
        const trimmed = trimToTotalBudget(items, maxBytesTotal);
        if (args.hash === true) {
          // Only complete content is hashed: a truncated slice is not the file.
          for (const item of items) {
            item.sha256 = !item.error && item.truncated !== true && typeof item.content === 'string'
              ? createHash('sha256').update(item.content, 'utf8').digest('hex')
              : null;
          }
        }
        if (args.format === 'json') return ok(JSON.stringify(items));
        const sections = [];
        let totalBytes = 0;
        for (const item of items) {
          totalBytes += Number(item.readBytes) || 0;
          sections.push(`=== ${item.path} ===`);
          if (item.error) {
            sections.push(`error: ${item.error}`);
          } else {
            const body = raw
              ? item.content
              : item.content
                .split('\n')
                .map((line, index) => `${String(index + 1).padStart(6)}  ${line}`)
                .join('\n');
            sections.push(body);
            if (item.truncated) {
              sections.push(`… [truncated: showing ${item.readBytes} of ${item.sizeBytes} bytes]`);
            }
          }
          if (args.hash === true) sections.push(`sha256: ${item.sha256 ?? 'null'}`);
        }
        const totalNote = `total: ${items.length} files, ${totalBytes} bytes` +
          (trimmed > 0 ? ` (maxBytesTotal ${maxBytesTotal}; ${trimmed} file(s) trimmed)` : '');
        return ok(`${sections.join('\n\n')}\n\n${totalNote}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_write',
    {
      title: 'Write a remote file',
      annotations: { destructiveHint: true, openWorldHint: false },
      description:
        'Write (create or replace) a UTF-8 text file on the remote machine. Creates parent directories, preserves an existing file mode, defaults to 0644 for new files, and writes atomically. Pass ifMatchSha256 (the sha256 the file must currently have) to refuse the overwrite when the remote content changed since you read it. The result reports the actual mode and size from the remote file, plus its sha256.',
      inputSchema: {
        path: z.string().describe('Remote path (absolute or workspace-relative)'),
        content: z.string().describe('Full file content'),
        host: z.string().optional(),
        mode: z.union([z.string(), z.number()]).optional().describe('Octal mode such as "755"; existing mode is preserved when omitted'),
        ifMatchSha256: z.string().optional().describe('Only write when the file currently has this sha256 (optimistic lock); the write fails with both hashes otherwise'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns {path, sizeBytes, mode, modeNumeric, sha256}'),
      },
    },
    async (args) => {
      try {
        ensureWritable();
        const payload = Buffer.from(args.content ?? '', 'utf8');
        if (payload.length > 8 * 1024 * 1024) {
          throw new Error(`content is too large for one write (${formatBytes(payload.length)} > 8 MiB); use presence_import for big files`);
        }
        const digest = createHash('sha256').update(payload).digest('hex');
        const { connection } = await resolveHostAndConnection(args);
        const target = await remotePath(connection, args.path);
        const expected = typeof args.ifMatchSha256 === 'string' ? args.ifMatchSha256.trim().toLowerCase() : '';
        if (expected) {
          const current = await remoteFileSha256(connection, target);
          if (!current) {
            throw new Error(
              `ifMatchSha256: could not read the current sha256 of ${target} (the file is missing, or the remote has no sha256sum); nothing was written`,
            );
          }
          if (current !== expected) {
            throw new Error(
              `ifMatchSha256 mismatch for ${target}: expected ${expected}, current ${current}; nothing was written`,
            );
          }
        }
        await connection.exec(`mkdir -p ${shq(dirname(target))}`, { timeoutMs: 30_000 });
        const result = await connection.writeText(target, payload, { mode: modeOrUndefined(args.mode) });
        const info = await connection.stat(target);
        const sizeBytes = info.exists ? info.size : result.bytes;
        const mode = info.exists ? info.mode : result.mode;
        const octal = modeLabel(mode);
        if (args.format === 'json') {
          return ok(jsonObjectText({
            path: target,
            sizeBytes,
            mode: octal,
            modeNumeric: Number.isInteger(mode) ? mode : null,
            sha256: digest,
          }));
        }
        return ok(`wrote ${target} (${sizeBytes} bytes, mode ${octal ?? 'unknown'}, sha256 ${digest})`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_edit',
    {
      title: 'Edit a remote file by exact replacement or line range',
      annotations: { destructiveHint: true, openWorldHint: false },
      description:
        'Edit a remote text file two ways: an exact oldText replacement (refused when the anchor is ambiguous; replaceAll=true replaces every occurrence), or a 1-based inclusive line range with startLine/endLine + newText (splice those lines, empty newText deletes them). Both return a compact diff of the changed lines; dryRun=true computes the same diff and validates the edit without writing. The two modes cannot be combined.',
      inputSchema: {
        path: z.string(),
        oldText: z.string().optional().describe('Exact text to replace (mutually exclusive with startLine/endLine)'),
        newText: z.string().optional().describe('Replacement text; with startLine/endLine it replaces the whole range ("" deletes the lines)'),
        host: z.string().optional(),
        startLine: z.number().int().min(1).optional().describe('First line of the range to replace, 1-based inclusive'),
        endLine: z.number().int().min(1).optional().describe('Last line of the range to replace, 1-based inclusive'),
        replaceAll: z.boolean().optional().describe('Exact mode: replace every occurrence instead of requiring a unique match'),
        dryRun: z.boolean().optional().describe('Validate and show the diff without writing the file'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns {path, replaced, mode, dryRun, sizeBytes, diff}'),
      },
    },
    async (args) => {
      try {
        if (!args.dryRun) ensureWritable();
        const { connection } = await resolveHostAndConnection(args);
        const target = await remotePath(connection, args.path);
        const newText = String(args.newText ?? '');
        const lineMode = args.startLine !== undefined || args.endLine !== undefined;
        if (lineMode && args.oldText !== undefined) {
          throw new Error('pass either oldText or startLine/endLine, not both');
        }
        if (!lineMode && !String(args.oldText ?? '')) {
          throw new Error('provide oldText (exact replacement) or startLine and endLine (line range)');
        }
        const before = (await connection.readText(target, { length: Number.MAX_SAFE_INTEGER })).content;
        let replaced;
        let simulated;
        let mode;
        let range = null;
        if (lineMode) {
          const { startLine, endLine } = args;
          if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
            throw new Error('startLine and endLine are both required (1-based, inclusive)');
          }
          if (endLine < startLine) throw new Error(`endLine ${endLine} is before startLine ${startLine}`);
          const lines = before.split('\n');
          if (startLine > lines.length) {
            throw new Error(`startLine ${startLine} is beyond the end of the file (${lines.length} lines)`);
          }
          if (endLine > lines.length) {
            throw new Error(`endLine ${endLine} is beyond the end of the file (${lines.length} lines)`);
          }
          replaced = endLine - startLine + 1;
          // An empty newText deletes the range outright (a literal "" would
          // otherwise splice in one empty line instead of removing lines).
          const replacement = newText === '' ? [] : newText.split('\n');
          simulated = [
            ...lines.slice(0, startLine - 1),
            ...replacement,
            ...lines.slice(endLine),
          ].join('\n');
          mode = 'lines';
          range = { startLine, endLine };
        } else {
          const oldText = String(args.oldText);
          const occurrences = before.split(oldText).length - 1;
          if (occurrences === 0) throw new Error('text to replace was not found');
          if (occurrences > 1 && args.replaceAll !== true) {
            throw new Error(`text occurs ${occurrences} times; pass replaceAll or a longer anchor`);
          }
          replaced = args.replaceAll === true ? occurrences : 1;
          simulated = args.replaceAll === true
            ? before.split(oldText).join(newText)
            : before.replace(oldText, newText);
          mode = 'exact';
        }
        let afterContent = simulated;
        const bytesBefore = Buffer.byteLength(before, 'utf8');
        const projectedSizeBytes = Buffer.byteLength(simulated, 'utf8');
        // dryRun reports the size the file still has on disk; a real write
        // reports the size it now has. projectedSizeBytes is always the size
        // the edited content would produce.
        let sizeBytes = args.dryRun === true ? bytesBefore : projectedSizeBytes;
        if (!args.dryRun) {
          const result = await connection.writeText(target, simulated);
          afterContent = (await connection.readText(target, { length: Number.MAX_SAFE_INTEGER })).content;
          sizeBytes = result.bytes;
        }
        const actualSizeBytes = args.dryRun === true ? bytesBefore : sizeBytes;
        const diff = diffLines(before, afterContent);
        if (args.format === 'json') {
          return ok(jsonObjectText({
            path: target,
            replaced,
            mode,
            dryRun: args.dryRun === true,
            actualSizeBytes,
            projectedSizeBytes,
            bytesBefore,
            bytesAfter: projectedSizeBytes,
            sizeBytes,
            diff,
            ...(range ?? {}),
          }));
        }
        const verb = args.dryRun === true ? 'would edit' : 'edited';
        const amount = mode === 'lines' ? `${replaced} line(s) replaced` : `${replaced} replacement(s)`;
        const sizeNote = args.dryRun === true
          ? `dry run: ${actualSizeBytes} B → ${projectedSizeBytes} B projected`
          : `${bytesBefore} → ${sizeBytes} B`;
        return ok(clip(
          `${verb} ${target} (${amount}, ${sizeNote})\n${diff}`,
          OUTPUT_CAP,
        ));
      } catch (error) {
        const message = String(error?.message ?? error);
        if (/ambig|more than once/iu.test(message)) {
          return fail(new Error(`${message}\npass replaceAll=true to replace every occurrence`));
        }
        return fail(error);
      }
    },
  );

  // ---------------------------------------------------------------- search
  server.registerTool(
    'presence_search',
    {
      title: 'Search remote files',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Regex search inside a remote directory using the target machine\'s own ripgrep (falls back to grep). Use include for a glob such as "*.ts"; countOnly returns just the match count. format="json" returns {pattern, root, countOnly, matchCount, matches:[{file, line, text}]} (countOnly keeps matches empty).',
      inputSchema: {
        pattern: z.string().describe('Regex to search for'),
        host: z.string().optional(),
        path: z.string().optional().describe('Directory to search (defaults to the workspace root or remote home)'),
        include: z.string().optional().describe('Glob filter such as "*.ts" or "src/**"'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum matches, default 200'),
        countOnly: z.boolean().optional(),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured match objects'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const root = args.path
          ? await remotePath(connection, args.path)
          : workspaceRoot() ?? (await connection.homePath());
        const result = await remoteGrep(connection, {
          root,
          pattern: args.pattern,
          include: args.include,
          limit: args.limit ?? 200,
          smartCase: true,
          countOnly: args.countOnly === true,
        });
        if (args.format === 'json') {
          const matchCount = result.total ?? result.matches.length;
          const matches = args.countOnly === true
            ? []
            : result.matches.map((match) => ({
              file: match.path,
              line: match.lineNumber,
              text: match.line,
            }));
          return ok(jsonObjectText({
            pattern: args.pattern,
            root,
            countOnly: args.countOnly === true,
            matchCount,
            truncated: result.truncated === true,
            matches,
          }));
        }
        if (args.countOnly) return ok(`${result.total ?? result.matches.length} matches in ${root}`);
        if (result.matches.length === 0) return ok(`no matches in ${root}`);
        const lines = result.matches.map((match) =>
          match.lineNumber === 0 ? match.line : `${match.path}:${match.lineNumber}: ${match.line}`);
        const footer = result.truncated ? `\n… truncated (${result.total ?? '?'} total)` : '';
        return ok(clip(`${lines.join('\n')}${footer}`, 32 * 1024));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_glob',
    {
      title: 'Find remote files by glob',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'List remote files matching a glob such as "**/*.ts". Absolute patterns carry their own root; relative patterns resolve against the workspace. Returns newest-first with sizes and mtimes. format="json" returns [{path, sizeBytes, mtimeISO, mtimeMs}].',
      inputSchema: {
        pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "/srv/app/**/*.py"'),
        host: z.string().optional(),
        path: z.string().optional().describe('Root directory for relative patterns'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum entries, default 200'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured file entries'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const absolute = args.pattern.trim().startsWith('/');
        let root = args.path
          ? await remotePath(connection, args.path)
          : workspaceRoot() ?? (await connection.homePath());
        let pattern = args.pattern;
        if (absolute) {
          const split = splitGlobPattern(args.pattern);
          if (split) {
            root = split.root;
            pattern = split.pattern;
          }
        }
        const result = await remoteGlobDetailed(connection, {
          root,
          pattern,
          limit: args.limit ?? 200,
          stats: true,
        });
        const sorted = [...(result.entries ?? [])].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
        if (args.format === 'json') {
          const rows = sorted.map((entry) => ({
            path: entry.path,
            sizeBytes: entry.size ?? null,
            mtimeISO: toISO(entry.mtime),
            mtimeMs: entry.mtime ?? null,
          }));
          return ok(jsonArrayText(rows));
        }
        if (sorted.length === 0) return ok(`no files in ${root} matching ${pattern}`);
        const lines = sorted.map((entry) =>
          `${entry.path}\t${formatBytes(entry.size)}${entry.mtime ? `\t${formatMtime(entry.mtime)}` : ''}`);
        const footer = result.truncated ? `\n… truncated (${result.total ?? '?'} files)` : '';
        return ok(clip(`${lines.join('\n')}${footer}`, 32 * 1024));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ------------------------------------------------------------ stat / probe
  server.registerTool(
    'presence_stat',
    {
      title: 'Stat remote paths',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Report metadata for 1-100 remote paths in one call: type, size, mode, mtime, and optionally sha256 (regular files only). Missing paths come back with exists:false instead of failing the whole call, so it doubles as an existence check. symlinks are not followed unless followSymlinks=true. format="json" returns [{path, exists, type, sizeBytes, mode, mtimeISO, mtimeMs, sha256?}].',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(100).describe('Remote paths (absolute, ~/..., presence://host/path, or workspace-relative)'),
        host: z.string().optional(),
        hash: z.boolean().optional().describe('Also compute sha256 for existing regular files (default false)'),
        followSymlinks: z.boolean().optional().describe('Stat and hash through symlinks instead of describing the link itself'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns one object per path'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const targets = [];
        for (const input of args.paths.slice(0, 100)) {
          targets.push(await remotePath(connection, input));
        }
        const rows = await statRemotePaths(connection, targets, {
          hash: args.hash === true,
          followSymlinks: args.followSymlinks === true,
        });
        if (args.format === 'json') return ok(jsonArrayText(rows));
        const header = ['path\ttype\tsize\tmode\tmtime', ...(args.hash === true ? ['sha256'] : [])].join('\t');
        const lines = rows.map((row) => {
          const size = row.type === 'dir' || row.sizeBytes === null ? '-' : formatBytes(row.sizeBytes);
          const cells = [row.path, row.type, size, row.mode ?? '-', row.mtimeISO ?? '-'];
          if (args.hash === true) cells.push(row.sha256 ?? '-');
          return cells.join('\t');
        });
        const found = rows.filter((row) => row.exists).length;
        const hashed = rows.filter((row) => row.sha256).length;
        const summary = `${rows.length} path(s): ${found} found, ${rows.length - found} missing` +
          (args.hash === true ? `, ${hashed} hashed` : '');
        return ok(clip([header, ...lines, '', summary].join('\n'), 32 * 1024));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // -------------------------------------------------------------- transfer
  server.registerTool(
    'presence_import',
    {
      title: 'Upload a local file to the remote machine',
      description:
        'Copy a file from this machine to the remote machine (binary-safe, sha256 verified, up to 64 MiB). Use it for attachments, screenshots and build artifacts. format="json" returns {remotePath, localPath, sizeBytes, sha256, mode} with the full digest.',
      inputSchema: {
        source: z.string().describe('Local file path (absolute or ~/...)'),
        to: z.string().describe('Remote destination path (absolute or workspace-relative)'),
        host: z.string().optional(),
        mode: z.union([z.string(), z.number()]).optional(),
        overwrite: z.boolean().optional().describe('Refuse to replace an existing file when false'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns the full remote path, size, sha256 and mode'),
      },
    },
    async (args) => {
      try {
        ensureWritable();
        const { connection } = await resolveHostAndConnection(args);
        const source = expandLocalHome(args.source);
        const info = statSync(source);
        if (!info.isFile()) throw new Error(`${source} is not a file`);
        if (info.size > MAX_TRANSFER) throw new Error(`file is too large (${formatBytes(info.size)} > 64 MiB)`);
        const target = await remotePath(connection, args.to);
        const existing = await connection.stat(target);
        if (existing.exists && existing.isDir) throw new Error(`${target} is a directory`);
        if (existing.exists && args.overwrite === false) throw new Error(`${target} already exists (overwrite=false)`);
        const buffer = readFileSync(source);
        const digest = createHash('sha256').update(buffer).digest('hex');
        await connection.exec(`mkdir -p ${shq(dirname(target))}`, { timeoutMs: 30_000 });
        const result = await connection.writeText(target, buffer, {
          mode: modeOrUndefined(args.mode) ?? (existing.exists ? undefined : 0o644),
        });
        if (args.format === 'json') {
          const after = await connection.stat(target);
          return ok(jsonObjectText({
            remotePath: target,
            localPath: source,
            sizeBytes: result.bytes,
            sha256: digest,
            mode: modeLabel(after.exists ? after.mode : result.mode) ?? null,
          }));
        }
        return ok(`uploaded ${basename(source)} → ${target} (${formatBytes(result.bytes)}, sha256 ${digest.slice(0, 16)}…)`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'presence_export',
    {
      title: 'Download a remote file to this machine',
      description:
        'Copy a file from the remote machine into the local export folder (binary-safe, sha256, up to 64 MiB). Returns the local path you can open with desktop tools. format="json" returns {remotePath, localPath, sizeBytes, sha256}; name overrides the local file name (sanitized, still confined to the export folder) so screenshots no longer need the hash prefix.',
      inputSchema: {
        path: z.string().describe('Remote file path'),
        host: z.string().optional(),
        to: z.string().optional().describe('Local destination directory (defaults to the Presence export folder)'),
        name: z.string().optional().describe('Local file name to use instead of the hash-prefixed remote name (path separators and ".." are stripped)'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns {remotePath, localPath, sizeBytes, sha256}'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const target = await remotePath(connection, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`no such file: ${target}`);
        if (info.isDir) throw new Error(`${target} is a directory; only single files can be exported`);
        if (info.size > MAX_TRANSFER) throw new Error(`file is too large (${formatBytes(info.size)} > 64 MiB)`);
        const { buffer } = await connection.readBytes(target, { offset: 0, length: info.size });
        const digest = createHash('sha256').update(buffer).digest('hex');
        const folder = args.to ? expandLocalHome(args.to) : exportDirectory();
        mkdirSync(folder, { recursive: true });
        let name = `${digest.slice(0, 12)}-${basename(target)}`;
        if (args.name !== undefined && String(args.name).trim() !== '') {
          const requested = safeExportName(args.name);
          if (!requested) throw new Error(`name "${args.name}" is not a usable file name`);
          name = requested;
        }
        const destination = join(folder, name);
        const inside = relative(resolve(folder), resolve(destination));
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('refusing to write outside the export folder');
        writeFileSync(destination, buffer);
        if (!args.to) pruneExports(folder);
        if (args.format === 'json') {
          return ok(jsonObjectText({
            remotePath: target,
            localPath: destination,
            sizeBytes: buffer.length,
            sha256: digest,
          }));
        }
        return ok(`downloaded ${target} → ${destination} (${formatBytes(buffer.length)}, sha256 ${digest.slice(0, 16)}…)`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ------------------------------------------------------------------ jobs
  server.registerTool(
    'presence_jobs',
    {
      title: 'Manage background jobs on a remote machine',
      description:
        'Start a detached remote command, list jobs, show one job\'s status, wait for one to finish (returns exit code + log tail, timedOut=true when the deadline hits first) or stop one. list hides exited jobs by default; pass all=true to include history and purge to hide ids from further listings (the process namespace on the remote side is unchanged: purge only filters this MCP server\'s view). Detached jobs survive this MCP server; stop them explicitly. format="json" returns structured jobs; stop reports exitSummary and verifies the pid afterwards unless verify=false, and with port=N it also proves the remote port was released.',
      inputSchema: {
        action: z.enum(['start', 'list', 'wait', 'status', 'stop', 'purge']),
        command: z.string().optional().describe('For start: the command to run'),
        host: z.string().optional().describe('For start: machine alias'),
        cwd: z.string().optional().describe('For start: working directory'),
        label: z.string().optional(),
        jobId: z.string().optional().describe('For wait/status/stop, or purge one id'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('For wait, default 120000'),
        tailLines: z.number().int().min(1).max(500).optional().describe('For wait, default 40'),
        verify: z.boolean().optional().describe('For stop: after stopping, check whether the pid is still alive (default true)'),
        port: z.number().int().min(1).max(65535).optional().describe('For stop: after stopping, wait until this remote TCP port is released and report portReleased'),
        all: z.boolean().optional().describe('For list: include exited jobs; for purge: purge every known job id'),
        format: z.enum(['text', 'json']).optional().describe('For start/list/wait/status/stop/purge: return structured JSON'),
      },
    },
    async (args) => {
      try {
        const pool = getPool();
        if (args.action === 'start') {
          if (!args.command?.trim()) throw new Error('start requires command');
          const host = pickHost(args);
          const connection = await connectionFor(host);
          const cwd = await execCwd(connection, args.cwd);
          const job = await pool.startJob(host, {
            command: args.command,
            cwd: cwd ?? null,
            label: args.label ?? null,
            sessionId: settings.sessionId,
          });
          if (args.format === 'json') {
            return ok(jsonObjectText({
              id: job.id,
              host,
              pid: job.pid ?? null,
              cwd: cwd ?? null,
              command: args.command,
              logPath: job.logPath ?? null,
              label: job.label ?? null,
              state: job.exitedEarly ? 'exited' : 'running',
              exitCode: job.exitCode ?? null,
              exitSignal: job.exitSignal ?? null,
              logTail: job.logTail ?? null,
            }));
          }
          return ok(`started job ${job.id} (pid ${job.pid}) on ${host}${job.logPath ? `\nlog: ${job.logPath}` : ''}`);
        }
        if (args.action === 'purge') {
          const known = (await pool.listJobs({ sessionId: undefined })).map((job) => job.id);
          const targets = new Set();
          if (args.jobId) targets.add(args.jobId);
          if (args.all === true) for (const id of known) targets.add(id);
          if (targets.size === 0) throw new Error('purge requires jobId or all:true');
          const purged = [...targets];
          for (const id of purged) PURGED_JOB_IDS.add(id);
          if (args.format === 'json') return ok(jsonObjectText({ purged }));
          return ok(
            `purged ${purged.length} job(s) from this listing: ${purged.join(', ')}\n` +
            '(the jobs stay in the remote process namespace; only presence_jobs output is filtered)',
          );
        }
        if (args.action === 'list') {
          const jobs = (await pool.listJobs({ sessionId: undefined }))
            .filter((job) => !PURGED_JOB_IDS.has(job.id));
          const visible = args.all === true ? jobs : jobs.filter((job) => job.state !== 'exited');
          const hidden = jobs.length - visible.length;
          if (args.format === 'json') return ok(jsonArrayText(visible));
          if (visible.length === 0) {
            return ok(hidden > 0
              ? `no visible jobs (${hidden} exited job(s) hidden; pass all:true to include history)`
              : 'no jobs');
          }
          const lines = visible.map((job) =>
            `${job.id}\t${job.host}\t${job.state}\t${job.exitCode ?? '-'}\t${exitSummary(job)}\t${job.label ?? job.command ?? ''}`);
          if (hidden > 0) lines.push(`… ${hidden} exited job(s) hidden; pass all:true to include history`);
          return ok(lines.join('\n'));
        }
        if (args.action === 'status') {
          if (!args.jobId) throw new Error('status requires jobId');
          const jobs = await pool.listJobs({ sessionId: undefined });
          const job = jobs.find((entry) => entry.id === args.jobId);
          if (!job) throw new Error(`no background job "${args.jobId}"`);
          const body = {
            id: job.id,
            host: job.host,
            state: job.state,
            exitCode: job.exitCode ?? null,
            exitSignal: job.exitSignal ?? null,
            // A running job has no exit yet: null says exactly that, where
            // "unknown" reads like a failed probe.
            exitSummary: job.state === 'running' ? null : exitSummary(job),
            pid: job.pid,
            label: job.label ?? null,
            startedAt: job.startedAt ?? null,
            logPath: job.logPath ?? null,
            logSize: job.logSize ?? null,
            command: job.command ?? null,
            cwd: job.cwd ?? null,
            purged: PURGED_JOB_IDS.has(job.id),
          };
          if (args.format === 'json') return ok(jsonObjectText(body));
          const lines = [
            `job ${body.id} on ${body.host}: ${body.state}`,
            `pid: ${body.pid ?? '-'}`,
            `started: ${body.startedAt ? formatMtime(body.startedAt) : '-'}`,
            body.exitSummary === null
              ? 'exit: still running (no exit yet)'
              : `exit: ${body.exitSummary} (exitCode=${body.exitCode ?? '-'}${body.exitSignal ? ` signal=${body.exitSignal}` : ''})`,
          ];
          if (body.label) lines.push(`label: ${body.label}`);
          if (body.command) lines.push(`command: ${body.command}`);
          if (body.cwd) lines.push(`cwd: ${body.cwd}`);
          if (body.logPath) lines.push(`log: ${body.logPath}${body.logSize !== null ? ` (${formatBytes(body.logSize)})` : ''}`);
          if (body.purged) lines.push('note: hidden from list by purge (still reachable by jobId)');
          return ok(clip(lines.join('\n'), OUTPUT_CAP));
        }
        if (!args.jobId) throw new Error('wait/stop requires jobId');
        if (args.action === 'wait') {
          const job = await pool.waitJob(args.jobId, {
            timeoutMs: args.timeoutMs ?? 120_000,
            tailLines: args.tailLines ?? 40,
          });
          // waitJob returns as soon as the deadline passes; `running` is the
          // only state that means "the wait ended before the job did".
          const timedOut = job.state === 'running';
          if (args.format === 'json') {
            return ok(jsonObjectText({
              id: job.id,
              host: job.host,
              state: job.state,
              timedOut,
              exitCode: job.exitCode ?? null,
              exitSignal: job.exitSignal ?? null,
              exitSummary: timedOut ? null : exitSummary(job),
              logSize: job.logSize ?? null,
              logTail: job.logTail ?? null,
            }));
          }
          const lines = [
            `job ${job.id} on ${job.host}: ${job.state}${timedOut ? ' (wait timed out)' : ''}`,
            timedOut
              ? 'exit: still running (no exit yet)'
              : `exit: ${exitSummary(job)} (exitCode=${job.exitCode ?? '-'}${job.exitSignal ? ` signal=${job.exitSignal}` : ''})`,
          ];
          if (job.logTail) lines.push(`--- log tail ---\n${job.logTail}`);
          return ok(clip(lines.join('\n'), OUTPUT_CAP));
        }
        const result = await pool.stopJob(args.jobId);
        let alive = null;
        let verifyError = null;
        if (args.verify !== false) {
          const pid = Number(result.pid);
          if (Number.isInteger(pid) && pid > 1) {
            try {
              const connection = await connectionFor(result.host);
              const probe = await connection.exec(`ps -p ${pid} -o pid= 2>/dev/null`, { timeoutMs: 5_000 });
              alive = String(probe.stdout ?? '').trim() !== '';
            } catch (error) {
              verifyError = String(error?.message ?? error);
            }
          }
        }
        // Optional second proof: the port the job served is really gone.
        let portReleased = null;
        if (Number.isInteger(args.port) && args.port > 0) {
          try {
            const connection = await connectionFor(result.host);
            portReleased = await waitRemotePortClosed(connection, args.port, { timeoutMs: 3_000, intervalMs: 250 });
          } catch {
            portReleased = null;
          }
        }
        const summary = exitSummary({ exitCode: result.exitCode, exitSignal: result.exitSignal });
        if (args.format === 'json') {
          const body = {
            id: result.id,
            host: result.host,
            pid: result.pid,
            stopped: result.stopped,
            wasAlive: result.wasAlive,
            reason: result.reason ?? null,
            survivors: result.survivors ?? null,
            exitCode: result.exitCode ?? null,
            exitSignal: result.exitSignal ?? null,
            exitSummary: summary,
            verified: args.verify !== false,
            alive,
            port: args.port ?? null,
            portReleased,
          };
          if (verifyError) body.verifyError = verifyError;
          return ok(jsonObjectText(body));
        }
        const lines = [`stop ${result.id} on ${result.host}: stopped=${result.stopped} reason=${result.reason ?? '-'}`];
        if (args.verify !== false) {
          lines.push(`pid ${result.pid} alive=${alive === null ? 'unknown' : alive} exit: ${summary}`);
          if (verifyError) lines.push(`alive check failed: ${verifyError}`);
        } else {
          lines.push(`exit: ${summary} (alive check skipped)`);
        }
        if (Number.isInteger(args.port) && args.port > 0) {
          lines.push(`port ${args.port} released: ${portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no'}`);
        }
        return ok(clip(lines.join('\n'), OUTPUT_CAP));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --------------------------------------------------------------- forward
  server.registerTool(
    'presence_forward',
    {
      title: 'Forward a remote port to this machine',
      annotations: { destructiveHint: false, openWorldHint: true },
      description:
        'Expose a remote service (dev server, Jupyter, TensorBoard) at http://127.0.0.1:<localPort>. The local port defaults to the remote port and falls back to a free port when busy. Actions: open, list, close. close returns state="closed", the localPort and portReleased (a real TCP probe of 127.0.0.1 after the tunnel closes). format="json" returns structured tunnel objects, including state and createdAt (ISO-8601 UTC with milliseconds) for open and list.',
      inputSchema: {
        action: z.enum(['open', 'list', 'close']),
        host: z.string().optional(),
        remotePort: z.number().int().min(1).max(65535).optional().describe('For open'),
        localPort: z.number().int().min(1).max(65535).optional().describe('For open; defaults to remotePort'),
        remoteHost: z.string().optional().describe('For open; default 127.0.0.1'),
        forwardId: z.string().optional().describe('For close'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured tunnel data'),
      },
    },
    async (args) => {
      try {
        const pool = getPool();
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
            createdAt: forwardCreatedAt(tunnel.id),
          }));
          if (args.format === 'json') return ok(jsonArrayText(rows));
          if (tunnels.length === 0) return ok('no active forwards');
          return ok(tunnels.map((tunnel) =>
            `${tunnel.id}\t${tunnel.url}\t→\t${tunnel.host}:${tunnel.remoteHost}:${tunnel.remotePort}`).join('\n'));
        }
        if (args.action === 'close') {
          if (!args.forwardId) throw new Error('close requires forwardId');
          const known = pool.listTunnels().find((tunnel) => tunnel.id === args.forwardId) ?? null;
          const closed = await pool.closeTunnel(args.forwardId);
          FORWARD_CREATED_MS.delete(args.forwardId);
          let portReleased = null;
          if (known) {
            // The listener may take a few milliseconds to go away; one retry
            // separates "still bound" from a race with close().
            portReleased = await localPortReleased(known.localPort);
          }
          if (args.format === 'json') {
            return ok(jsonObjectText({
              id: args.forwardId,
              closed,
              state: 'closed',
              localPort: known?.localPort ?? null,
              portReleased,
            }));
          }
          if (!closed) return ok(`no forward ${args.forwardId}`);
          const release = portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no';
          return ok(`closed forward ${args.forwardId} (local port ${known?.localPort ?? '?'} released: ${release})`);
        }
        if (!args.remotePort) throw new Error('open requires remotePort');
        const host = pickHost(args);
        const tunnel = await pool.openForward(host, {
          localPort: args.localPort,
          remoteHost: args.remoteHost ?? '127.0.0.1',
          remotePort: args.remotePort,
        });
        FORWARD_CREATED_MS.set(tunnel.id, Date.now());
        const url = `http://127.0.0.1:${tunnel.localPort}`;
        if (args.format === 'json') {
          return ok(jsonObjectText({
            id: tunnel.id,
            host,
            localHost: '127.0.0.1',
            localPort: tunnel.localPort,
            remoteHost: tunnel.remoteHost,
            remotePort: tunnel.remotePort,
            url,
            requestedLocalPort: tunnel.requestedLocalPort,
            localPortFallback: tunnel.localPortFallback === true,
            state: 'open',
            createdAt: forwardCreatedAt(tunnel.id),
          }));
        }
        return ok([
          `opened forward ${tunnel.id}`,
          `local:  ${url}`,
          `remote: ${host}:${tunnel.remoteHost}:${tunnel.remotePort}`,
          tunnel.localPortFallback
            ? `local port ${tunnel.requestedLocalPort} was busy, using ${tunnel.localPort} instead`
            : 'local port mirrors the remote port',
        ].join('\n'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ------------------------------------------------------------- port probe
  server.registerTool(
    'presence_port_probe',
    {
      title: 'Probe listening ports on a remote machine',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Check 1-20 TCP ports on the remote machine in one call: whether anything listens (ss -ltnp, with pid/process) and whether a TCP connect is accepted (bash /dev/tcp, python3 fallback). expect="open"/"closed" makes ok report whether the actual state matches; waitMs polls every 250 ms until every port matches (or, without expect, until every port is open), then reports the last state. Use it to prove a server started, or that a stopped job or closed forward really released its port.',
      inputSchema: {
        ports: z.array(z.number().int().min(1).max(65535)).min(1).max(20).describe('TCP ports to check'),
        host: z.string().optional(),
        expect: z.enum(['open', 'closed']).optional().describe('Expected state; ok compares the actual state with it'),
        waitMs: z.number().int().min(0).max(120000).optional().describe('Poll every 250 ms until the expectation holds, default 0'),
        probe: z.boolean().optional().describe('TCP connect check (default true); false only reads the ss table'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns one object per port'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        const ports = [...new Set(args.ports.map((port) => Number(port)))];
        const probe = args.probe !== false;
        const expect = args.expect ?? null;
        const waitMs = args.waitMs ?? 0;
        const deadline = Date.now() + waitMs;
        let snapshot;
        let rows;
        for (;;) {
          snapshot = await inspectRemotePorts(connection, ports, { probe });
          rows = ports.map((port) => portProbeRow(port, snapshot, { expect, probe }));
          const satisfied = expect === null
            ? rows.every((row) => row.listening || row.probe === 'accepted')
            : rows.every((row) => row.ok);
          if (satisfied || waitMs <= 0 || Date.now() >= deadline) break;
          await promisify(setTimeout)(Math.min(250, Math.max(0, deadline - Date.now())));
        }
        if (args.format === 'json') return ok(jsonArrayText(rows));
        const header = 'port\tlistening\tpid\tprocess\tprobe\tok';
        const lines = rows.map((row) =>
          `${row.port}\t${row.listening ? 'yes' : 'no'}\t${row.pid ?? '-'}\t${row.process ?? '-'}\t${row.probe}\t${row.ok ? 'yes' : 'no'}`);
        const openCount = rows.filter((row) => row.listening || row.probe === 'accepted').length;
        const footer = [
          `${rows.length} port(s): ${openCount} open`,
          expect === null ? null : `expect: ${expect} · pass: ${rows.every((row) => row.ok) ? 'yes' : 'no'}`,
          snapshot.ssAvailable ? null : 'ss is unavailable: listening falls back to the TCP connect probe',
          probe && rows.some((row) => row.probe === 'skipped')
            ? 'TCP connect probe unavailable (no bash with /dev/tcp and no python3)'
            : null,
        ].filter(Boolean).join('\n');
        return ok(clip([header, ...lines, '', footer].join('\n'), 32 * 1024));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ------------------------------------------------------------- http probe
  server.registerTool(
    'presence_http_probe',
    {
      title: 'Probe a remote HTTP service through a temporary tunnel',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Forward a remote HTTP port to this machine, GET one or more paths, assert status and body, then always close the tunnel and verify the local port was released. paths defaults to ["/"], expectStatus to [200], expectBody is a list of substrings that must all appear somewhere in the concatenated bodies. pass is true when every status is expected and every substring was found. This replaces the exec + forward + fetch + forward close + port check chain with one call.',
      inputSchema: {
        host: z.string().optional(),
        remotePort: z.number().int().min(1).max(65535).describe('Remote TCP port serving HTTP'),
        localPort: z.number().int().min(1).max(65535).optional().describe('Local port for the tunnel, default remotePort'),
        paths: z.array(z.string()).min(1).max(20).optional().describe('Request paths, default ["/"]'),
        expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(10).optional().describe('Accepted HTTP statuses, default [200]'),
        expectBody: z.array(z.string()).max(20).optional().describe('Substrings that must all appear somewhere in the concatenated bodies'),
        timeoutMs: z.number().int().min(100).max(120000).optional().describe('Per-request timeout, default 15000'),
        waitForPort: z.boolean().optional().describe('Wait up to timeoutMs for the remote port to accept TCP first (default true)'),
        format: z.enum(['text', 'json']).optional().describe('"json" returns {forwardId, localPort, remotePort, results, pass, portReleased}'),
      },
    },
    async (args) => {
      try {
        const pool = getPool();
        const host = pickHost(args);
        const connection = await connectionFor(host);
        const timeoutMs = args.timeoutMs ?? 15_000;
        if (args.waitForPort !== false) {
          const waited = await connection.waitForPort({ port: args.remotePort, timeoutMs });
          if (!waited.ready) {
            throw new Error(
              `nothing is listening on 127.0.0.1:${args.remotePort} on ${host} after ${waited.waitedMs} ms`,
            );
          }
        }
        const tunnel = await pool.openForward(host, {
          localPort: args.localPort,
          remoteHost: '127.0.0.1',
          remotePort: args.remotePort,
        });
        const base = `http://127.0.0.1:${tunnel.localPort}`;
        const paths = (args.paths?.length ? args.paths : ['/'])
          .map((path) => (String(path).startsWith('/') ? String(path) : `/${path}`));
        const expectStatus = args.expectStatus?.length ? args.expectStatus : [200];
        const expectBody = (args.expectBody ?? []).map(String);
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
        for (const row of results) {
          row.bodyMatched = expectBody.length === 0 ? null : expectBody.every((needle) => row.body.includes(needle));
          delete row.body;
        }
        const pass = results.every((row) => row.status !== null && expectStatus.includes(row.status)) &&
          missingBody.length === 0;
        if (args.format === 'json') {
          return ok(jsonObjectText({
            forwardId: tunnel.id,
            host,
            localPort: tunnel.localPort,
            remotePort: tunnel.remotePort,
            url: base,
            expectStatus,
            expectBody,
            missingBody,
            results: results.map((row) => ({
              path: row.path,
              status: row.status,
              bytes: row.bytes,
              contentType: row.contentType,
              bodyMatched: row.bodyMatched,
              ...(row.error ? { error: row.error } : {}),
            })),
            pass,
            portReleased,
          }));
        }
        const table = results.map((row) =>
          `${row.path}\t${row.status ?? 'ERR'}\t${row.bytes}\t${row.contentType ?? '-'}\t` +
          `${row.bodyMatched === null ? '-' : row.bodyMatched ? 'yes' : 'no'}${row.error ? `\t${row.error}` : ''}`);
        const notes = [
          `forward ${tunnel.id}: ${base} → ${host}:127.0.0.1:${tunnel.remotePort}`,
          `expect: status ${expectStatus.join('/')}${expectBody.length ? ` · body ${expectBody.map((needle) => JSON.stringify(needle)).join(', ')}` : ''}`,
          missingBody.length ? `missing body: ${missingBody.map((needle) => JSON.stringify(needle)).join(', ')}` : null,
          `pass: ${pass ? 'yes' : 'no'} · local port ${tunnel.localPort} released: ` +
            `${portReleased === null ? 'unknown' : portReleased ? 'yes' : 'no'}`,
        ].filter(Boolean);
        return ok(clip(['path\tstatus\tbytes\tcontent-type\tbody', ...table, '', ...notes].join('\n'), 32 * 1024));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // -------------------------------------------------------------- terminal
  server.registerTool(
    'presence_terminal',
    {
      title: 'Drive a persistent remote terminal',
      annotations: { destructiveHint: false, openWorldHint: true },
      description:
        'Open an interactive shell on the remote machine (optionally inside a named tmux session that survives reconnects), write keystrokes, read output deltas, list and close terminals. open takes cwd (defaults to the workspace root) and command (default "bash") and reports {terminalId, host, cwd, shell, reused}; opening again with the same live tmux session reuses that terminal. write returns the immediate output by default, or with ackOnly=true only {terminalId, writtenBytes, output:null} and leaves the output for read. Reads are incremental since the previous read. format="json" returns structured data for open/write/read/close/list.',
      inputSchema: {
        action: z.enum(['open', 'write', 'read', 'close', 'list']),
        host: z.string().optional().describe('For open'),
        session: z.string().optional().describe('For open: tmux session name to create or reattach'),
        terminalId: z.string().optional().describe('For write/read/close'),
        data: z.string().optional().describe('For write: keystrokes (include "\\n" to submit)'),
        cwd: z.string().optional().describe('For open: start directory (defaults to the workspace root)'),
        command: z.string().optional().describe('For open: program to run in the shell, default "bash"'),
        ackOnly: z.boolean().optional().describe('For write: return only an ack and leave the output for read'),
        waitMs: z.number().int().min(0).max(30000).optional().describe('For read: wait for new output, ms'),
        cols: z.number().int().min(20).max(400).optional(),
        rows: z.number().int().min(5).max(200).optional(),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured data for open/write/read/close/list'),
      },
    },
    async (args) => {
      try {
        const pool = getPool();
        if (args.action === 'list') {
          const terminals = pool.listTerminals();
          if (args.format === 'json') {
            return ok(jsonArrayText(terminals.map((terminal) => ({
              terminalId: terminal.id,
              host: terminal.host,
              session: terminal.session ?? null,
              closed: terminal.closed === true,
              pending: terminal.pending,
            }))));
          }
          if (terminals.length === 0) return ok('no terminals');
          return ok(terminals.map((terminal) =>
            `${terminal.id}\t${terminal.host}\t${terminal.closed ? 'closed' : 'open'}${terminal.session ? `\ttmux=${terminal.session}` : ''}`).join('\n'));
        }
        if (args.action === 'open') {
          const host = pickHost(args);
          const connection = await connectionFor(host);
          const cwd = await execCwd(connection, args.cwd);
          const shell = String(args.command ?? 'bash').trim() || 'bash';
          // pool.openTerminal sanitizes the tmux name the same way.
          const sessionName = args.session
            ? (String(args.session).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 40) || 'presence')
            : null;
          const existing = sessionName
            ? pool.listTerminals().find((terminal) =>
              terminal.host === host && terminal.session === sessionName && !terminal.closed)
            : null;
          let terminalId;
          let reused = false;
          if (existing) {
            terminalId = existing.id;
            reused = true;
          } else {
            const terminal = await pool.openTerminal(host, {
              cols: args.cols ?? 120,
              rows: args.rows ?? 32,
              session: args.session,
            });
            terminalId = terminal.id;
          }
          if (!reused && (args.cwd !== undefined || args.command !== undefined || !sessionName)) {
            // A plain terminal always gets a deterministic shell and directory;
            // an attached tmux session is only steered when asked explicitly.
            const startup = `${cwd ? `cd ${shq(cwd)} && ` : ''}exec ${shell}`;
            pool.writeTerminal(terminalId, `${startup}\n`);
            await promisify(setTimeout)(200);
            // Drop the startup echo/prompt so the caller's first read is theirs.
            await pool.readTerminal(terminalId, { waitMs: 400 }).catch(() => {});
          }
          if (args.format === 'json') {
            return ok(jsonObjectText({ terminalId, host, cwd, shell, reused }));
          }
          const first = await pool.readTerminal(terminalId, { waitMs: 400 });
          return ok(`terminal ${terminalId} on ${host}${args.session ? ` (tmux: ${args.session})` : ''}\n${clip(stripAnsi(first.data), 8192)}`);
        }
        if (!args.terminalId) throw new Error(`${args.action} requires terminalId`);
        if (args.action === 'write') {
          if (typeof args.data !== 'string') throw new Error('write requires data');
          const writtenBytes = Buffer.byteLength(args.data, 'utf8');
          pool.writeTerminal(args.terminalId, args.data);
          if (args.ackOnly === true) {
            if (args.format === 'json') {
              return ok(jsonObjectText({ terminalId: args.terminalId, writtenBytes, output: null }));
            }
            return ok(`wrote ${writtenBytes} bytes to terminal ${args.terminalId}; read the output with presence_terminal { "action": "read" }`);
          }
          await promisify(setTimeout)(150);
          const read = await pool.readTerminal(args.terminalId, { waitMs: 400 });
          if (args.format === 'json') {
            return ok(jsonObjectText({ terminalId: args.terminalId, writtenBytes, output: stripAnsi(read.data) }));
          }
          return ok(clip(stripAnsi(read.data) || '(no output yet)', 16384));
        }
        if (args.action === 'read') {
          const read = await pool.readTerminal(args.terminalId, { waitMs: args.waitMs ?? 0 });
          const output = stripAnsi(read.data);
          if (args.format === 'json') {
            return ok(jsonObjectText({ terminalId: args.terminalId, output, closed: read.closed === true }));
          }
          return ok(clip(output || (read.closed ? '(terminal closed)' : '(no new output)'), 16384));
        }
        const terminal = pool.terminal(args.terminalId);
        if (terminal?.session) {
          const connection = await connectionFor(terminal.host);
          await connection.exec(`tmux kill-session -t ${shq(terminal.session)}`).catch(() => {});
        }
        pool.closeTerminal(args.terminalId);
        if (args.format === 'json') {
          return ok(jsonObjectText({ terminalId: args.terminalId, closed: true }));
        }
        return ok(`closed terminal ${args.terminalId}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----------------------------------------------------------------- trash
  server.registerTool(
    'presence_trash',
    {
      title: 'Move remote files to the trash',
      annotations: { destructiveHint: true, openWorldHint: false },
      description:
        'Move remote files or folders into the remote trash (~/.dsh/presence-trash), list recently trashed items (newest first, optional path filter), or restore one. Prefer this over rm -rf. trash accepts one path or up to 50 paths (paths), reports each result and verifies the source is gone; list reports a single movedAtISO (no duplicate time fields). format="json" returns structured entries.',
      inputSchema: {
        action: z.enum(['trash', 'list', 'restore']),
        host: z.string().optional(),
        path: z.string().optional().describe('For trash: one remote path; for list: substring filter on trashPath/name'),
        paths: z.array(z.string()).min(1).max(50).optional().describe('For trash: several remote paths in one call (mutually exclusive with path)'),
        trashPath: z.string().optional().describe('For restore: the trash path returned by trash/list'),
        to: z.string().optional().describe('For restore: destination path'),
        limit: z.number().int().min(1).max(200).optional(),
        format: z.enum(['text', 'json']).optional().describe('"json" returns structured data'),
      },
    },
    async (args) => {
      try {
        const { connection } = await resolveHostAndConnection(args);
        if (args.action === 'list') {
          const needle = args.path?.trim();
          const limit = args.limit ?? 20;
          // A filter should search more than the newest page, then trim.
          const fetchLimit = needle ? Math.min(1000, Math.max(limit * 10, 200)) : limit;
          let entries = await connection.listTrash({ limit: fetchLimit });
          if (needle) {
            entries = entries.filter((entry) => entry.trashPath.includes(needle) || entry.name.includes(needle));
          }
          let rows = entries
            .map((entry) => {
              const movedAtMs = toMtimeMs(entry.movedAt);
              return {
                trashPath: entry.trashPath,
                name: entry.name,
                movedAtISO: toISO(movedAtMs),
                movedAtMs,
              };
            })
            .sort((a, b) => (b.movedAtMs ?? 0) - (a.movedAtMs ?? 0));
          if (needle) rows = rows.slice(0, limit);
          if (args.format === 'json') {
            // One time field only: movedAtISO (movedAtMs is internal, for sorting).
            return ok(jsonArrayText(rows.map(({ trashPath, name, movedAtISO }) => ({ trashPath, name, movedAtISO }))));
          }
          if (rows.length === 0) {
            return ok(`trash is empty${needle ? ` for "${needle}"` : ''}`);
          }
          return ok(rows.map((row) =>
            `${row.trashPath}\t${formatMtime(row.movedAtMs ?? Number.NaN)}\t${row.name}`).join('\n'));
        }
        if (args.action === 'restore') {
          ensureWritable();
          if (!args.trashPath || !args.to) throw new Error('restore requires trashPath and to');
          const restored = await connection.restoreTrash(args.trashPath, { to: args.to });
          if (args.format === 'json') {
            return ok(jsonObjectText({ restored: true, from: args.trashPath, to: restored.to }));
          }
          return ok(`restored ${args.trashPath} → ${restored.to}`);
        }
        ensureWritable();
        if (args.path !== undefined && args.paths !== undefined) {
          throw new Error('pass either path or paths, not both');
        }
        const inputs = args.paths?.length ? args.paths : args.path !== undefined ? [args.path] : [];
        if (inputs.length === 0) throw new Error('trash requires path or paths');
        const results = [];
        for (const input of inputs.slice(0, 50)) {
          let target = null;
          try {
            target = await remotePath(connection, input);
            const result = await connection.trash(target);
            const after = await connection.stat(target).catch(() => null);
            const sourceRemoved = after ? after.exists !== true : false;
            const restoreHint = `presence_trash { "action": "restore", "trashPath": ${JSON.stringify(result.trashPath)}, "to": ${JSON.stringify(target)} }`;
            results.push({
              path: target,
              trashPath: result.trashPath,
              sizeBytes: result.size ?? null,
              sourceRemoved,
              strategy: result.strategy,
              restoreHint,
            });
          } catch (error) {
            results.push({ path: target ?? String(input), error: String(error?.message ?? error) });
          }
        }
        if (args.path !== undefined && args.paths === undefined) {
          // Single-path shape, kept for callers that already parse it.
          const single = results[0];
          if (single.error) throw new Error(single.error);
          if (args.format === 'json') {
            return ok(jsonObjectText({
              trashPath: single.trashPath,
              sizeBytes: single.sizeBytes,
              sourceRemoved: single.sourceRemoved,
              strategy: single.strategy,
              restoreHint: single.restoreHint,
            }));
          }
          return ok(`trashed ${single.path} → ${single.trashPath} (${formatBytes(single.sizeBytes)}, ${single.strategy}; source removed: ${single.sourceRemoved ? 'yes' : 'no'})`);
        }
        const failed = results.filter((row) => row.error).length;
        if (args.format === 'json') {
          return ok(jsonObjectText({
            results: results.map((row) => (row.error
              ? { path: row.path, error: row.error }
              : {
                path: row.path,
                trashPath: row.trashPath,
                sizeBytes: row.sizeBytes,
                sourceRemoved: row.sourceRemoved,
                strategy: row.strategy,
                restoreHint: row.restoreHint,
              })),
            trashed: results.length - failed,
            failed,
          }));
        }
        const lines = results.map((row) => (row.error
          ? `${row.path}\terror: ${row.error}`
          : `${row.path} → ${row.trashPath} (${formatBytes(row.sizeBytes)}, ${row.strategy}; source removed: ${row.sourceRemoved ? 'yes' : 'no'})`));
        return ok(clip([
          `trashed ${results.length - failed}/${results.length} path(s)`,
          ...lines,
        ].join('\n'), OUTPUT_CAP));
      } catch (error) {
        return fail(error);
      }
    },
  );
  // ---------------------------------------------------------------- status
  server.registerTool(
    'presence_status',
    {
      title: 'Presence runtime status',
      description:
        'Show the effective MCP configuration (default host, workspace root, read-only mode), known hosts and live resources (connections, jobs, forwards, terminals). Call this once at the start when something is unclear.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      try {
        const pool = getPool();
        const hosts = knownHosts();
        const connected = pool.hosts().filter((entry) => entry.connected).map((entry) => entry.alias);
        const body = {
          server: 'presence-mcp',
          version: MCP_VERSION,
          node: process.version,
          uptimeMs: Math.round(process.uptime() * 1000),
          tools: TOOL_NAMES.length,
          workspace: settings.workspace ?? null,
          defaultHost: settings.defaultHost ?? settings.workspace?.host ?? null,
          defaultCwd: settings.defaultCwd,
          effective: {
            host: settings.workspace?.host ?? settings.defaultHost ?? null,
            cwd: workspaceRoot(),
            note: 'presence_exec without cwd runs here, and relative paths resolve against it (workspace root, else PRESENCE_CWD)',
          },
          readOnly: settings.readOnly,
          sessionId: settings.sessionId,
          pool: {
            hosts: hosts.length,
            connected,
            jobs: (await pool.listJobs({ sessionId: undefined })).filter((job) => !PURGED_JOB_IDS.has(job.id)).length,
            purgedJobs: [...PURGED_JOB_IDS],
            forwards: pool.listTunnels().length,
            terminals: pool.listTerminals().length,
          },
          hosts: hosts.map((entry) => entry.alias),
        };
        return ok(JSON.stringify(body, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

export const TOOL_NAMES = [
  'presence_list_hosts',
  'presence_connect',
  'presence_ls',
  'presence_exec',
  'presence_read',
  'presence_read_many',
  'presence_write',
  'presence_edit',
  'presence_search',
  'presence_glob',
  'presence_stat',
  'presence_import',
  'presence_export',
  'presence_jobs',
  'presence_forward',
  'presence_port_probe',
  'presence_http_probe',
  'presence_terminal',
  'presence_trash',
  'presence_status',
];
