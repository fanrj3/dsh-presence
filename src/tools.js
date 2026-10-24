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
import { exportDirectory, join as joinPath, dirname as dirnamePath, resolve as resolvePath, sep, pruneExports } from './localpaths.js';

const OUTPUT_CAP = 32 * 1024;
const EXEC_OUTPUT_CAP = 16 * 1024;
const READ_CAP = 32 * 1024 * 1024;
const EXPORT_CAP = 64 * 1024 * 1024;
const WAIT_PORT_TIMEOUT_MS = 15_000;

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

function formatWaitReport(job, { timeoutMs, tailLines }) {
  const state = job.state ?? 'unknown';
  const stillRunning = state === 'running' || state === 'unknown';
  const exit =
    job.exitCode === undefined || job.exitCode === null ? (stillRunning ? 'still running' : 'unknown') : String(job.exitCode);
  const size = job.logSize === undefined || job.logSize === null ? 'unknown' : formatBytes(job.logSize);
  const parts = [
    `job ${job.id} on ${job.host ?? '?'}: state=${state}  exit=${exit}`,
    `pid: ${job.pid ?? '?'}  log: ${job.logPath ?? '?'}  size: ${size}`,
  ];
  if (stillRunning) {
    parts.push(`(did not exit within ${timeoutMs}ms; use action:'wait' again or action:'stop')`);
  }
  parts.push(`--- last ${tailLines} line(s) ---`);
  parts.push(job.logTail ? clip(job.logTail) : '(log is empty or unreadable)');
  return parts.join('\n');
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
        'List the machines Presence can reach, taken from the user\'s ~/.ssh/config, with whether each one is connected right now. Call this before targeting a host for the first time.',
      parameters: {},
      async execute() {
        const hosts = pool.hosts();
        if (hosts.length === 0) return 'No hosts with an explicit HostName were found in ~/.ssh/config.';
        const lines = hosts.map((host) => {
          const state = host.connected ? `connected${host.terminals ? `, ${host.terminals} terminal(s)` : ''}` : 'not connected';
          const key = host.identityFile ? `key ${host.identityFile}` : 'default keys';
          return `${host.alias}  ${host.user ?? '?'}@${host.hostname}:${host.port}  ${state}  (${key})`;
        });
        return `${hosts.length} host(s):\n${lines.join('\n')}`;
      },
    }),

    tool({
      name: 'presence_connect',
      description:
        'Open the persistent connection to one machine and report what it is. Later calls on this host reuse it. Call this when a host reports "not connected" and you want the identity up front, or to surface an authentication problem early.',
      parameters: {
        host: { type: 'string', required: true, description: 'Exact ssh alias, as listed by presence_hosts.' },
      },
      async execute(args, exec) {
        const started = Date.now();
        const connection = await pool.connection(args.host);
        const who = await connection.exec('printf "%s@%s %s" "$(id -un)" "$(hostname)" "$(uname -srm)"');
        return `connected to ${args.host} in ${Date.now() - started}ms\nremote: ${who.stdout.trim()}`;
      },
    }),

    tool({
      name: 'presence_exec',
      description:
        'Run a shell command on a remote machine and return its exit code, stdout and stderr. Inside a workspace the machine and working directory come from the session itself, so no host is needed. The connection persists between calls. Commands run with `set -o pipefail` by default, so `cmd | tail` reports cmd\'s real failure; pass pipefail:false to disable. For servers or long jobs use background:true instead of `&`: it returns a job id, takes an optional label, and can wait until a port is listening with waitForPort.\n\nDESTRUCTIVE COMMANDS (`rm -r/-f`, `git clean -fdx`, `find -delete`, `shred`, `truncate`, `dd of=`) are dry-run first: the tool shows every resolved target and refuses workspace roots, ancestors, home, `/` and `.git` metadata. Re-run with confirm:true to execute; prefer presence_trash for recoverable deletes. Output is ANSI-stripped and middle-truncated by default.',
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
          if (guard) return guard.report;
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
          return parts.join('\n');
        }

        let command = args.command;
        if (directory) command = `cd ${shq(directory)} && ${command}`;
        if (pipefail) command = `${pipefailPrelude()}${command}`;
        let result;
        try {
          result = await connection.exec(command, { timeoutMs: args.timeoutMs ?? 120_000 });
        } catch (error) {
          throw new Error(withSandboxNote(error?.message ?? String(error)));
        }
        const parts = [`exit: ${result.code}  (${result.durationMs}ms)`];
        if (result.timedOut) parts.push('timed out 鈥?the remote process tree was terminated');
        const inlineCap = Math.max(1000, Math.min(Number(args.maxOutput) || EXEC_OUTPUT_CAP, 256 * 1024));
        const plain = (value) => (args.raw ? String(value ?? '') : stripAnsi(value));
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
        return parts.join('\n');
      },
    }),

    tool({
      name: 'presence_read',
      description:
        'Read a text file on a remote machine. Inside a workspace, relative paths resolve against the workspace root and the machine comes from the workspace. Returns line-numbered content, like reading a local file. Use offset/limit for large files.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to the active workspace\'s machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum lines to return. Defaults to 2000.' },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`${target} does not exist on ${host}`);
        if (info.isDir) throw new Error(`${target} is a directory; use presence_exec with ls`);

        const offset = Math.max(1, args.offset ?? 1);
        const limit = Math.max(1, args.limit ?? 2000);

        // Large files: read the requested window on the remote side and ask the
        // remote for the true line count, instead of truncating the content and
        // then reporting a made-up total.
        if (info.size > READ_CAP) {
          const windowed = await connection.readTextWindow(target, { lineOffset: offset, lineLimit: limit });
          const totalLines = windowed.totalLines;
          if (offset > totalLines && totalLines > 0) {
            throw new Error(`offset ${offset} is past the end of ${target} (${totalLines} lines)`);
          }
          const body = String(windowed.content ?? '').replace(/\r/g, '').replace(/\n$/, '');
          const window = body === '' ? [] : body.split('\n');
          const numbered = window.map((line, index) => `${offset + index}: ${line}`).join('\n');
          const endLine = offset + window.length - 1;
          const footer =
            endLine < totalLines
              ? `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
              : `(End of file - ${totalLines} lines)`;
          await markObserved(exec, args.path);
          return `<path>${target}</path>\n${numbered}\n\n${footer}`;
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
        const window = lines.slice(offset - 1, offset - 1 + limit);
        const end = Math.min(lines.length, offset - 1 + window.length);
        const numbered = window.map((line, index) => `${offset + index}: ${line}`).join('\n');
        const footer =
          end < lines.length
            ? `(Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.)`
            : `(End of file - ${lines.length} lines)`;
        await markObserved(exec, args.path);
        return `<path>${target}</path>\n${numbered}\n\n${footer}`;
      },
    }),

    tool({
      name: 'presence_write',
      description:
        'Create or fully replace a file on a remote machine. Missing parent directories are created. Inside a workspace, relative paths resolve against the workspace root. The write is atomic (temp file + rename), so a reader never sees a half-written file. An existing file keeps its mode (e.g. 0755 stays executable); pass `mode` to set one explicitly.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        content: { type: 'string', required: true, description: 'Complete new file content.' },
        mode: {
          type: 'string',
          description: 'Octal file mode to set, e.g. "755" or "644". Defaults to the existing file\'s mode, or 644 for a new file.',
        },
      },
      async execute(args, exec) {
        ensureWritable();
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
        if (parent) {
          const made = await connection.exec(`mkdir -p ${shq(parent)}`, { timeoutMs: 30_000 });
          if (made.code !== 0) throw new Error(`cannot create parent directory ${parent}: ${made.stderr.trim()}`);
        }
        const result = await connection.writeText(target, args.content, { mode: parseMode(args.mode) });
        await markObserved(exec, args.path);
        const modeText = typeof result.mode === 'number' ? ` mode ${result.mode.toString(8).padStart(3, '0')}` : '';
        return `wrote ${result.bytes} bytes to ${target} on ${host}${modeText}`;
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
        'Upload a LOCAL file to the remote machine 鈥?the missing local鈫抮emote direction of presence_export, and the only way to create binary files remotely (images, PDFs, build artifacts, attachments under ~/.dsh/attachments). Writes atomically, creates parent directories, can set a mode, and returns the sha256 so both sides can be checked. Limit: 64 MiB; for larger files use presence_exec with scp/rsync.',
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
        const modeText = typeof result.mode === 'number' ? ` mode ${result.mode.toString(8).padStart(3, '0')}` : '';
        return (
          `imported ${buffer.length} bytes to ${target} on ${host}${modeText}\n` +
          `sha256: ${digest}\n` +
          `local source: ${localSource}`
        );
      },
    }),

    tool({
      name: 'presence_trash',
      description:
        'Delete a remote path RECOVERABLY: it is moved into `~/.dsh/presence-trash/<timestamp>/` on the same machine (no install, no extra service) and the restore path is returned. Prefer this over `rm -rf` for anything inside a workspace. Actions: trash (move a path), list (recent trash containers), restore (move one back).',
      parameters: {
        action: { type: 'string', required: true, enum: ['trash', 'list', 'restore'], description: 'What to do.' },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', description: 'For trash: the remote path to move into the trash.' },
        trashPath: { type: 'string', description: 'For restore: the path returned by trash (the container), not the original location.' },
        to: { type: 'string', description: 'For restore: where to put it back, e.g. the original path.' },
      },
      async execute(args, exec) {
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        if (args.action === 'trash') {
          if (!args.path) throw new Error('trash requires a path');
          if (typeof connection.trash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
          const target = await remotePath(connection, workspace, args.path);
          const result = await connection.trash(target);
          return (
            `moved to trash on ${host}\n` +
            `original: ${target}\n` +
            `trash: ${result.trashPath}\n` +
            `${result.entries ?? '?'} files, ${result.size ?? '?'}\n` +
            `restore with presence_trash {action:'restore', trashPath:'${result.trashPath}', to:'${target}'}`
          );
        }
        if (args.action === 'list') {
          if (typeof connection.listTrash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
          const entries = await connection.listTrash({ limit: 20 });
          if (entries.length === 0) return `trash is empty on ${host}`;
          return entries.map((entry) => `${entry.movedAt ?? '?'}  ${entry.trashPath}`).join('\n');
        }
        if (!args.trashPath) throw new Error('restore requires trashPath');
        if (typeof connection.restoreTrash !== 'function') throw new Error('this Presence build has no trash support; update the plugin');
        const restored = await connection.restoreTrash(args.trashPath, { to: args.to });
        return `restored ${args.trashPath} to ${restored.to ?? args.to} on ${host}`;
      },
    }),

    tool({
      name: 'presence_edit',
      description:
        'Replace exact text inside a file on a remote machine. Use this 鈥?or the built-in `edit` tool, which also reaches the remote workspace 鈥?instead of `sed -i`, `perl -pi`, or `python -c` for remote edits: it is atomic, refuses an anchor that occurs more than once unless replaceAll is set, and reports how many occurrences changed. The file keeps its mode (an executable stays executable). Inside a workspace, relative paths resolve against the workspace root.',
      parameters: {
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
        path: { type: 'string', required: true, description: 'Absolute path, ~/relative, or workspace-relative.' },
        old: { type: 'string', description: 'Exact text to replace, including indentation.' },
        oldString: { type: 'string', description: 'Alias for `old` (same spelling as the built-in edit tool).' },
        new: { type: 'string', description: 'Replacement text.' },
        newString: { type: 'string', description: 'Alias for `new` (same spelling as the built-in edit tool).' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
        replace_all: { type: 'boolean', description: 'Alias for replaceAll (same spelling as the built-in edit tool).' },
      },
      async execute(args, exec) {
        ensureWritable();
        const oldText = args.old ?? args.oldString;
        const newText = args.new ?? args.newString;
        if (typeof oldText !== 'string' || oldText === '') throw new Error('old (or oldString) is required');
        if (typeof newText !== 'string') throw new Error('new (or newString) is required');
        const { host, workspace } = await pickScope(args, exec);
        const connection = await pool.connection(host);
        const target = await remotePath(connection, workspace, args.path);
        const info = await connection.stat(target);
        if (!info.exists) throw new Error(`${target} does not exist on ${host} 鈥?nothing to edit (use presence_write to create it)`);
        if (info.isDir) throw new Error(`${target} is a directory on ${host}`);
        const replaceAll = Boolean(args.replaceAll ?? args.replace_all);
        const result = await connection.editText(target, oldText, newText, { replaceAll });
        await markObserved(exec, args.path);
        return `replaced ${result.replaced} occurrence(s) in ${target} on ${host} (${result.bytes} bytes now)`;
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
        if (detailed.files.length === 0) {
          return `no files match ${rawPattern} under ${base} on ${host} (limit ${limit}, not truncated)`;
        }
        const prefix = base.replace(/\/+$/, '');
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
      name: 'presence_jobs',
      description:
        'List, wait for, or stop background commands started with presence_exec {background:true}. Jobs are detached process groups on the remote machine, so they survive the SSH connection. list is scoped to this session by default (all:true shows every session); wait follows a job until it exits or the timeout, returning its state, exit code, log size and log tail; stop takes a jobId, or a raw pgid + host when the job id was lost.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'wait', 'stop'],
          description: 'What to do: list jobs, wait for one to exit, or stop one.',
        },
        jobId: { type: 'string', description: 'For wait/stop: the job id returned when it started.' },
        timeoutMs: { type: 'number', description: 'For wait: how long to wait for the job to exit. Defaults to 120000.' },
        tailLines: { type: 'number', description: 'For wait: how many log lines to return, clamped to 1-500 (0 or omitted = 40). Defaults to 40.' },
        all: { type: 'boolean', description: 'For list: include jobs from every session, not just this one. Defaults to false.' },
        pgid: { type: 'number', description: 'For stop: a process group id to signal directly, as an alternative to jobId. Requires host.' },
        host: { type: 'string', description: 'For stop with pgid: the ssh alias of the machine that owns the process group.' },
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
            return args.all
              ? 'no background jobs'
              : 'no background jobs for this session (use all:true to list every session)';
          }
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

        if (action === 'wait') {
          if (!args.jobId) throw new Error('wait requires a jobId');
          const timeoutMs = Math.max(0, Number(args.timeoutMs ?? 120_000) || 0);
          const tailLines = clampTailLines(args.tailLines);
          const job =
            typeof pool.waitJob === 'function'
              ? await pool.waitJob(args.jobId, { timeoutMs, tailLines })
              : await waitForJobFallback(pool, args.jobId, { timeoutMs, tailLines });
          return formatWaitReport(job, { timeoutMs, tailLines });
        }

        if (action === 'stop') {
          if (args.jobId) {
            const result = await pool.stopJob(args.jobId);
            if (result.stopped) return `stopped ${result.id} (pid ${result.pid}) on ${result.host}`;
            const reason = result.reason ?? `survivors ${(result.survivors ?? []).join(', ') || 'unknown'}`;
            const code = result.exitCode !== undefined && result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
            return `nothing to stop for ${result.id}: ${reason}${code}`;
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
          return result?.stopped === false || survivors.length > 0
            ? `could not stop process group ${pgid} on ${args.host}: survivors ${survivors.join(', ') || 'unknown'}`
            : `stopped process group ${pgid} on ${args.host}`;
        }

        throw new Error(`unknown action ${action}`);
      },
    }),

    tool({
      name: 'presence_forward',
      description:
        'Forward a local TCP port to a port on the remote machine, so a service it runs (dev server, Jupyter, TensorBoard) is reachable at http://127.0.0.1:<localPort> on this machine. Prefer this over guessing `ssh -L` in a shell.',
      parameters: {
        action: { type: 'string', required: true, enum: ['open', 'close', 'list'], description: 'What to do with the forward.' },
        remotePort: { type: 'number', description: 'For open: the port the remote service listens on.' },
        localPort: { type: 'number', description: 'For open: local port to bind. Defaults to an OS-assigned free port.' },
        remoteHost: { type: 'string', description: 'For open: remote bind host. Defaults to 127.0.0.1.' },
        forwardId: { type: 'string', description: 'For close: the id returned by open.' },
        host: { type: 'string', description: 'ssh alias. Defaults to this session\'s workspace machine.' },
      },
      async execute(args, exec) {
        if (args.action === 'list') {
          const tunnels = pool.listTunnels();
          if (tunnels.length === 0) return 'no active forwards';
          return tunnels.map((tunnel) => `${tunnel.id}  http://127.0.0.1:${tunnel.localPort} -> ${tunnel.host}:${tunnel.remoteHost}:${tunnel.remotePort}`).join('\n');
        }
        if (args.action === 'close') {
          if (!args.forwardId) throw new Error('close requires a forwardId');
          const closed = await pool.closeTunnel(args.forwardId);
          return closed ? `closed ${args.forwardId}` : `no forward ${args.forwardId}`;
        }
        if (!args.remotePort) throw new Error('open requires remotePort');
        const { host } = await pickScope(args, exec);
        const tunnel = await pool.openTunnel(host, {
          localPort: args.localPort ?? 0,
          remoteHost: args.remoteHost ?? '127.0.0.1',
          remotePort: args.remotePort,
        });
        return `forward ${tunnel.id}: http://127.0.0.1:${tunnel.localPort} -> ${host}:${tunnel.remoteHost}:${tunnel.remotePort}`;
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
        waitMs: { type: 'number', description: 'For read: wait up to this long for new output. Defaults to 0.' },
        cols: { type: 'number', description: 'For open: terminal width. Defaults to 120.' },
        rows: { type: 'number', description: 'For open: terminal height. Defaults to 32.' },
        killSession: {
          type: 'boolean',
          description: 'For close: also kill the named tmux session instead of leaving it running. Defaults to false.',
        },
      },
      async execute(args, exec) {
        if (args.action === 'open') {
          const { host } = await pickScope(args, exec);
          const { id, host: opened, session } = await pool.openTerminal(host, {
            cols: args.cols ?? 120,
            rows: args.rows ?? 32,
            session: args.session,
          });
          const first = await pool.readTerminal(id, { waitMs: 600 });
          const where = session ? `${opened} (tmux session "${session}")` : opened;
          return `terminal ${id} opened on ${where}${first.data ? `\n${clip(first.data)}` : ''}`;
        }
        if (args.action === 'list') {
          const terminals = pool.listTerminals();
          if (terminals.length === 0) return 'no open terminals';
          return terminals
            .map((terminal) => `${terminal.id}  ${terminal.host}  ${terminal.closed ? 'closed' : 'open'}  ${terminal.pending} byte(s) unread`)
            .join('\n');
        }
        if (!args.terminalId) throw new Error(`${args.action} requires a terminalId`);
        if (args.action === 'write') {
          pool.writeTerminal(args.terminalId, args.data ?? '');
          return `sent ${(args.data ?? '').length} characters to ${args.terminalId}`;
        }
        if (args.action === 'read') {
          const result = await pool.readTerminal(args.terminalId, { waitMs: args.waitMs ?? 0 });
          const data = result.data ?? '';
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
          if (args.killSession && session && host) {
            const connection = await pool.connection(host);
            await connection.exec(`tmux kill-session -t ${shq(session)}`).catch(() => {});
          }
          pool.closeTerminal(args.terminalId);
          if (args.killSession && session) return `closed ${args.terminalId} and killed tmux session "${session}"`;
          if (session) return `closed ${args.terminalId}; tmux session "${session}" keeps running 鈥?reopen with session:"${session}" to reattach`;
          return `closed ${args.terminalId}`;
        }
        throw new Error(`unknown action ${args.action}`);
      },
    }),
  ];
}
