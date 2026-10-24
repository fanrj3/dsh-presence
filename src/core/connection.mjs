// One SSH connection per machine, held open by the plugin.
//
// Nothing is installed on the far side: files travel over the server's own SFTP
// subsystem, commands over exec channels, terminals over shell channels. The
// handshake is paid once, then every operation is a round trip on the existing
// connection instead of a new `ssh` process.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { Client } from 'ssh2';
import { defaultKeys } from './ssh-config.mjs';

const KEEPALIVE_MS = 15_000;
const READY_MS = 25_000;
// Callers clip what they display; this is what the connection will hold. Past
// it the head stays in memory and the untouched stream goes to the remote disk.
const OUTPUT_CAP_BYTES = 256 * 1024;
// A spilled stream is written to /tmp, which is not a dump: bound each file and
// rotate the old ones before writing a new one.
const SPILL_MAX_BYTES = 32 * 1024 * 1024;
const SPILL_KEEP_FILES = 20;
const SPILL_MAX_AGE_MINUTES = 24 * 60;
const SPILL_PRUNE_TIMEOUT_MS = 15_000;
const SPILL_PRUNE_OUTPUT_BYTES = 64 * 1024;
const READ_WINDOW_BYTES = 4 * 1024 * 1024;
// SFTP writeFile asks for 0666 and lets the session umask decide, so a host
// with umask 0002 (Debian's USERGROUPS_ENAB turns 022 into 002) publishes 0664
// for a brand-new file. Ask for 0644 instead: the umask still applies, so the
// result is the documented 0644 here and never wider than 0644 anywhere.
const DEFAULT_FILE_MODE = 0o644;
// `timeout --kill-after=5s` plus scheduling slack: after this a local wait is
// pointless, and only then do we stop listening.
const REMOTE_KILL_GRACE_MS = 8_000;
const TIMEOUT_PROBE_MS = 10_000;
// A background job must report its own session leader pid, and the launcher has
// to wait for that one line before it can exit; failures are bounded, not hung.
const BACKGROUND_LAUNCH_MS = 20_000;
const BACKGROUND_PID_POLLS = 200; // x 10ms
const BACKGROUND_STOP_MS = 20_000;
const BACKGROUND_STOP_POLLS = 30; // x 50ms
// One `ps` table for every registered job; a busy machine can be large.
const BACKGROUND_LIST_BYTES = 2 * 1024 * 1024;
// Background logs and status files live in /tmp as well; keep that set bounded
// the same way as the spill files.
const BACKGROUND_KEEP_FILES = 50;
const BACKGROUND_MAX_AGE_MINUTES = 24 * 60;
const BACKGROUND_PRUNE_TIMEOUT_MS = 15_000;
const BACKGROUND_PRUNE_OUTPUT_BYTES = 16 * 1024;
// A killed job cannot report its own exit code. The shell convention for
// "terminated by signal N" is 128 + N, so SIGTERM is 143 and SIGKILL 137.
const SIGNAL_NUMBERS = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  STKFLT: 16,
  CHLD: 17,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
  TTIN: 21,
  TTOU: 22,
  URG: 23,
  XCPU: 24,
  XFSZ: 25,
  VTALRM: 26,
  PROF: 27,
  WINCH: 28,
  IO: 29,
  PWR: 30,
  SYS: 31,
};
// The trash is a directory tree on the machine itself, so recovery needs no
// service and nothing installed. `~` is expanded on the far side, never with
// the local home directory. One container per trashed entry keeps the original
// name, mode and ownership intact for a same-filesystem rename.
const TRASH_DEFAULT_ROOT = '~/.dsh/presence-trash';
// A large tree can take minutes to move or copy; a stalled one must not pin a
// channel forever. The listing itself is small, so it gets a shorter budget.
const TRASH_TIMEOUT_MS = 300_000;
const TRASH_LIST_TIMEOUT_MS = 30_000;
const TRASH_LIST_BYTES = 2 * 1024 * 1024;
// A broader listing than this is noise for a "recent trash" view; callers may
// ask for less, not for an unbounded dump.
const TRASH_LIST_LIMIT = 1000;

/**
 * POSIX-sh fragment shared by the trash scripts: expand a leading `~` for the
 * trash root remotely, from the login shell's HOME, falling back to the home
 * directory this connection already resolved. Nothing here uses the local home.
 */
const TRASH_ROOT_EXPAND = [
  'case $root in',
  "  '~') root=${HOME:-$home} ;;",
  "  '~/'*) root=${HOME:-$home}/${root#'~/'} ;;",
  "  '~'*) echo 'presence: the trash root may only use ~ or ~/..., not another user home' >&2; exit 3 ;;",
  'esac',
].join('\n');

/** POSIX single-quoting, so the remote shell sees exactly these bytes. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Lines of a text blob, without inventing a line for the final newline. */
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function randomToken() {
  return randomBytes(6).toString('hex');
}

/** Seconds as GNU `timeout` reads them; sub-second deadlines stay sub-second. */
function timeoutSeconds(timeoutMs) {
  return String(Number((timeoutMs / 1000).toFixed(3)));
}

/** 128 + the signal number, the exit code a shell reports for a killed job. */
function signalExitCode(name) {
  const number = SIGNAL_NUMBERS[name];
  return Number.isInteger(number) ? 128 + number : null;
}

/**
 * An octal file mode for SFTP, or `null` when the caller did not ask for one.
 * Rejecting a bad value here is better than letting NaN reach setstat, where a
 * mistyped mode would silently leave the file at the server default. A string
 * is read as octal digits, so a tool argument "755" means 0o755 rather than the
 * decimal 755. Setuid/setgid/sticky bits are allowed; the file type bits are not.
 */
function octalMode(value) {
  if (value === undefined || value === null) return null;
  let mode;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[0-7]{1,4}$/.test(text)) {
      throw new Error(`mode must be an octal number such as 0o755, got "${value}"`);
    }
    mode = Number.parseInt(text, 8);
  } else {
    mode = Number(value);
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new Error(`mode must be an octal number such as 0o755, got ${String(value)}`);
  }
  return mode;
}

function attemptList(entry, password) {
  const attempts = [];
  const keys = [...(entry.identityFile ?? [])];
  for (const key of defaultKeys()) if (!keys.includes(key)) keys.push(key);
  if (process.env.SSH_AUTH_SOCK) attempts.push({ method: 'agent', agent: process.env.SSH_AUTH_SOCK });
  if (entry.forwardAgent && process.env.SSH_AUTH_SOCK) attempts.push({ method: 'agent', agent: process.env.SSH_AUTH_SOCK });
  for (const path of keys) attempts.push({ method: 'publickey', path });
  if (password) {
    attempts.push({ method: 'password' });
    attempts.push({ method: 'keyboard-interactive' });
  }
  return attempts;
}

function buildAuthHandler(entry, password, onNeedPassword) {
  const attempts = attemptList(entry, password);
  let index = 0;

  // ssh2's modern authHandler contract takes an object, not (method, params):
  // returning a bare string would make ssh2 fall back to `config.privateKey`.
  return (methodsLeft, partialSuccess, callback) => {
    while (index < attempts.length) {
      const attempt = attempts[index];
      const allowed = !methodsLeft || methodsLeft.includes(attempt.method);
      if (!allowed) {
        index += 1;
        continue;
      }
      if (attempt.method === 'agent') {
        index += 1;
        return callback('agent');
      }
      if (attempt.method === 'keyboard-interactive') {
        index += 1;
        return callback('keyboard-interactive');
      }
      if (attempt.method === 'password') {
        index += 1;
        return callback({ type: 'password', username: entry.user, password });
      }
      index += 1;
      let key;
      try {
        key = readFileSync(attempt.path);
      } catch {
        continue;
      }
      return callback({ type: 'publickey', username: entry.user, key });
    }
    onNeedPassword?.();
    return callback(false);
  };
}

export function describeSshError(error) {
  const message = error?.message ?? String(error);
  if (/authentication methods failed|All configured authentication methods failed/i.test(message)) {
    return new Error('authentication failed: no usable key, and no password was supplied');
  }
  if (/Encrypted private key detected/i.test(message)) {
    return new Error('the private key is passphrase-protected; supply the passphrase');
  }
  if (/ECONNREFUSED/.test(message)) return new Error('connection refused: nothing is listening on that port');
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return new Error('hostname could not be resolved');
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(message)) {
    return new Error('timed out during the SSH handshake');
  }
  return error instanceof Error ? error : new Error(message);
}

export class PresenceConnection {
  #client;
  #sftpPromise;
  #closed = false;
  #home;
  #caps;
  #stdbuf;
  #background = new Map();
  #limit;
  #active = 0;
  #waiters = [];

  constructor(client, entry, banner) {
    this.#client = client;
    this.entry = entry;
    this.target = entry.alias;
    this.banner = banner;
    this.connectedAt = Date.now();
    // sshd allows 10 sessions per connection by default; leave headroom for sftp.
    this.#limit = Number(entry.maxChannels ?? 8);
    client.on('close', () => {
      this.#closed = true;
    });
  }

  /** One shared slot pool for every channel we open on this connection. */
  async #acquire() {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release() {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#active -= 1;
  }

  static connect(entry, { password, passphrase, timeoutMs = READY_MS, onNeedPassword } = {}) {
    const client = new Client();
    const options = {
      host: entry.hostname,
      port: entry.port ?? 22,
      username: entry.user,
      readyTimeout: timeoutMs,
      keepaliveInterval: KEEPALIVE_MS,
      keepaliveCountMax: 3,
      // ssh2's built-in stream compression: a large win for big files read
      // over exec/SFTP (CSV, logs) and negotiated only when the server offers
      // it. It does not affect auth.
      compress: true,
      tryKeyboard: Boolean(password),
      authHandler: buildAuthHandler(entry, password, onNeedPassword),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          try {
            client.end();
          } catch {
            /* already gone */
          }
          reject(describeSshError(error));
        }
      };

      client.on('banner', (banner) => {
        client.bannerText = banner;
      });
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        settle(new Error('password requested by the server but no password is available'));
        finish([]);
      });
      client.on('ready', () => {
        if (settled) return;
        settled = true;
        // Nagle + delayed ACK costs a full 40ms on request/response traffic.
        try {
          client.setNoDelay(true);
        } catch {
          /* older builds */
        }
        resolve(new PresenceConnection(client, entry, client.bannerText ?? ''));
      });
      client.on('error', (error) => settle(error));
      client.once('close', () => {
        const error = new Error('connection closed before the handshake finished');
        if (!settled) settle(error);
      });

      try {
        client.connect(options);
      } catch (error) {
        settle(error);
      }
    });
  }

  get closed() {
    return this.#closed;
  }

  get sftp() {
    if (!this.#sftpPromise) {
      this.#sftpPromise = new Promise((resolve, reject) => {
        this.#client.sftp((error, sftp) => (error ? reject(describeSshError(error)) : resolve(sftp)));
      });
    }
    return this.#sftpPromise;
  }

  /** Detach from the server without waiting. */
  end() {
    this.#closed = true;
    try {
      this.#client.end();
    } catch {
      /* already gone */
    }
  }

  // ------------------------------------------------------------------ exec

  /**
   * A local channel close drops the pipe but leaves the remote process alive,
   * so the deadline is handed to `timeout` on the far side when it exists.
   * Probed once per connection: one cheap channel, cached answer.
   */
  #remoteTimeoutAvailable() {
    if (!this.#caps) {
      this.#caps = (async () => {
        try {
          // Deliberately outside the slot pool: one short-lived channel, and
          // taking a slot here could deadlock a caller waiting for the last one.
          const probe = await this.#execChannel('command -v timeout >/dev/null 2>&1 && uname -s', {
            timeoutMs: TIMEOUT_PROBE_MS,
          });
          return probe.code === 0 && probe.stdout.trim() === 'Linux';
        } catch {
          return false;
        }
      })();
    }
    return this.#caps;
  }

  /** Run one command over a fresh channel; the connection stays up. */
  async exec(command, { timeoutMs = 120_000, env = null, signal, maxOutputBytes = OUTPUT_CAP_BYTES } = {}) {
    if (this.#closed) throw new Error('connection is closed');
    if (signal?.aborted) throw new Error('command aborted');

    // Normalise once: callers may pass a numeric string, and the backstop below
    // adds milliseconds to it.
    const budgetMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 0;

    // Exports and command are composed before any wrapping, so the far side
    // gets one shell string: `bash -c 'export K=V; command'` still applies the
    // environment, and the deadline covers both.
    const composed = env
      ? `export ${Object.entries(env)
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(' ')}; ${command}`
      : command;

    const remoteDeadline = budgetMs > 0 && (await this.#remoteTimeoutAvailable());
    const wrapped = remoteDeadline
      ? `timeout --signal=TERM --kill-after=5s ${timeoutSeconds(budgetMs)} bash -c ${shellQuote(composed)}`
      : composed;

    await this.#acquire();
    try {
      return await this.#execChannel(wrapped, { timeoutMs: budgetMs, signal, maxOutputBytes, remoteDeadline });
    } finally {
      this.#release();
    }
  }

  #execChannel(command, { timeoutMs = 0, signal = null, maxOutputBytes = OUTPUT_CAP_BYTES, remoteDeadline = false } = {}) {
    const cap = Number(maxOutputBytes) > 0 ? Math.floor(Number(maxOutputBytes)) : Infinity;

    return new Promise((resolve, reject) => {
      let settled = false;
      let stream = null;
      let timer = null;
      let started = 0;
      const stdoutChunks = [];
      const stderrChunks = [];

      const stopClock = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
      };

      /** Head of the stream for the caller, the rest onto the remote disk. */
      const keepHead = async (chunks, kind) => {
        const all = Buffer.concat(chunks);
        if (all.length <= cap) return { text: all.toString('utf8'), truncated: false, file: null, bytes: 0 };
        const text = all.subarray(0, cap).toString('utf8');
        // One file per truncated stream, so a caller can follow the rest even
        // after the tool output was clipped. It holds at most SPILL_MAX_BYTES:
        // a command that prints gigabytes must not fill /tmp.
        const file = `/tmp/presence-exec-${randomToken()}${kind === 'stdout' ? '' : `-${kind}`}.log`;
        // Best effort, and deliberately outside the slot pool: the caller still
        // owns a slot while this result is being built.
        await this.#pruneSpillLogs();
        const data = all.subarray(0, SPILL_MAX_BYTES);
        try {
          const written = await this.writeText(file, data);
          return { text, truncated: true, file, bytes: written.bytes };
        } catch {
          // A read-only /tmp must not turn a finished command into a failure.
          return { text, truncated: true, file: null, bytes: 0 };
        }
      };

      const buildResult = async (code, signalName, { timedOut, durationMs }) => {
        const stdout = await keepHead(stdoutChunks, 'stdout');
        const stderr = await keepHead(stderrChunks, 'stderr');
        const value = {
          code,
          signal: signalName,
          stdout: stdout.text,
          stderr: stderr.text,
          durationMs,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
        };
        if (stdout.truncated) {
          value.stdoutFile = stdout.file;
          value.stdoutFileBytes = stdout.bytes;
        }
        if (stderr.truncated) {
          value.stderrFile = stderr.file;
          value.stderrFileBytes = stderr.bytes;
        }
        return value;
      };

      const settle = (error, value) => {
        if (settled) return false;
        settled = true;
        stopClock();
        if (error) {
          try {
            stream?.close();
          } catch {
            /* channel already gone */
          }
          reject(error);
          return false;
        }
        resolve(value);
        return true;
      };

      function onAbort() {
        settle(new Error('command aborted'));
      }

      function onDeadline() {
        if (settled) return;
        settled = true;
        stopClock();
        try {
          stream?.close();
        } catch {
          /* channel already gone */
        }
        if (!remoteDeadline) {
          // Nothing on the far side enforces the deadline, so do not pretend
          // the process tree is gone; closing the channel is all we have.
          reject(new Error(`command timed out after ${timeoutMs}ms (the remote process may still be running)`));
          return;
        }
        // The remote `timeout` should have returned by now; report the deadline
        // as hit instead of hanging the caller on a channel that never closes.
        buildResult(124, null, { timedOut: true, durationMs: started ? Date.now() - started : 0 }).then(resolve, reject);
      }

      if (signal?.aborted) {
        settle(new Error('command aborted'));
        return;
      }
      // Without remote enforcement the timer is the only timeout there is; with
      // it, this is just a backstop behind `--kill-after`.
      const deadline = remoteDeadline ? timeoutMs + REMOTE_KILL_GRACE_MS : timeoutMs;
      if (deadline > 0) timer = setTimeout(onDeadline, deadline);
      signal?.addEventListener('abort', onAbort, { once: true });

      const onChannel = (error, channel) => {
        stream = channel;
        if (error) {
          settle(describeSshError(error));
          return;
        }
        if (settled) {
          // Aborted or timed out while the channel was still being opened.
          try {
            channel.close();
          } catch {
            /* already gone */
          }
          return;
        }
        started = Date.now();
        // No setEncoding: byte counts must match the cap, and the spill file has
        // to hold the exact bytes the remote process wrote.
        channel.on('data', (chunk) => {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        channel.stderr?.on('data', (chunk) => {
          stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        channel.on('error', (streamError) => settle(streamError));
        channel.on('close', (code, signalName) => {
          if (settled) return;
          settled = true;
          stopClock();
          const durationMs = Date.now() - started;
          // `timeout` reports 124 when it had to end the command itself.
          buildResult(code, signalName, { timedOut: remoteDeadline && code === 124, durationMs }).then(resolve, reject);
        });
      };

      try {
        this.#client.exec(command, onChannel);
      } catch (execError) {
        // ssh2 throws synchronously when the connection is already gone; without
        // this the armed timer would outlive the rejected promise.
        settle(describeSshError(execError));
      }
    });
  }

  /**
   * Best effort: drop spill files older than a day and all but the newest
   * nineteen, so writing the next one leaves at most twenty. Never throws — a
   * cleanup failure must not turn a finished command into an error. Runs
   * outside the slot pool because its caller already holds a slot.
   */
  async #pruneSpillLogs() {
    if (this.#closed) return;
    const script = [
      `find /tmp -maxdepth 1 -type f -name 'presence-exec-*.log' -mmin +${SPILL_MAX_AGE_MINUTES} -exec rm -f -- {} + 2>/dev/null`,
      `ls -1t /tmp/presence-exec-*.log 2>/dev/null | tail -n +${SPILL_KEEP_FILES} | while IFS= read -r file; do rm -f -- "$file"; done`,
      `true`,
    ].join('\n');
    try {
      await this.#execChannel(`bash -c ${shellQuote(script)}`, {
        timeoutMs: SPILL_PRUNE_TIMEOUT_MS,
        maxOutputBytes: SPILL_PRUNE_OUTPUT_BYTES,
      });
    } catch {
      // A host without bash, a read-only /tmp, a closed connection: nothing to do.
    }
  }

  /** Open an interactive terminal channel (PTY allocated server-side). */
  async shell({ cols = 120, rows = 32, term = 'xterm-256color' } = {}) {
    if (this.#closed) throw new Error('connection is closed');
    await this.#acquire();
    return new Promise((resolve, reject) => {
      this.#client.shell({ term, cols, rows }, (error, stream) => {
        if (error) {
          this.#release();
          reject(describeSshError(error));
          return;
        }
        stream.setEncoding('utf8');
        stream.once('close', () => this.#release());
        resolve(stream);
      });
    });
  }

  // -------------------------------------------------------- background jobs

  /** Whether `stdbuf` exists and works here; probed once, cached like `#caps`. */
  #stdbufAvailable() {
    if (!this.#stdbuf) {
      this.#stdbuf = (async () => {
        try {
          // Outside the slot pool for the same reason as the timeout probe: one
          // short channel, so a caller holding the last slot cannot deadlock.
          const probe = await this.#execChannel(
            'command -v stdbuf >/dev/null 2>&1 && stdbuf -oL -eL true >/dev/null 2>&1 && echo yes',
            { timeoutMs: TIMEOUT_PROBE_MS },
          );
          return probe.stdout.trim() === 'yes';
        } catch {
          return false;
        }
      })();
    }
    return this.#stdbuf;
  }

  /**
   * Best effort: keep /tmp/presence-bg-* from growing without bound before a
   * new job writes there. Files older than a day go first, then every file
   * except the newest `keepLog`/`keepStatus` of each kind. Never throws: a
   * cleanup failure must not stop the job from starting. Returns how many
   * files were removed.
   */
  async #pruneBackgroundFiles({ keepLog = BACKGROUND_KEEP_FILES, keepStatus = BACKGROUND_KEEP_FILES } = {}) {
    if (this.#closed) return 0;
    const keep = (value) => Math.max(0, Math.floor(Number(value) || 0));
    const script = [
      `removed=0`,
      `prune_kind() {`,
      `  kind=$1`,
      `  keep=$2`,
      `  old=$(find /tmp -maxdepth 1 -type f -name "presence-bg-*.$kind" -mmin +${BACKGROUND_MAX_AGE_MINUTES} -print 2>/dev/null | wc -l)`,
      `  removed=$((removed + old))`,
      `  find /tmp -maxdepth 1 -type f -name "presence-bg-*.$kind" -mmin +${BACKGROUND_MAX_AGE_MINUTES} -exec rm -f -- {} + 2>/dev/null`,
      `  extra=$(ls -1t /tmp/presence-bg-*.$kind 2>/dev/null | tail -n +$((keep + 1)) | wc -l)`,
      `  removed=$((removed + extra))`,
      `  ls -1t /tmp/presence-bg-*.$kind 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r file; do rm -f -- "$file"; done`,
      `}`,
      `prune_kind log ${keep(keepLog)}`,
      `prune_kind status ${keep(keepStatus)}`,
      `echo "__PRESENCE_PRUNED__ $removed"`,
    ].join('\n');
    try {
      const result = await this.exec(`sh -c ${shellQuote(script)}`, {
        timeoutMs: BACKGROUND_PRUNE_TIMEOUT_MS,
        maxOutputBytes: BACKGROUND_PRUNE_OUTPUT_BYTES,
      });
      const match = /__PRESENCE_PRUNED__ (\d+)/.exec(result.stdout);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Start `command` in a new session, detached from this channel, appending its
   * output to `logPath`. Returns the session leader pid, which is also the
   * process group id, so `stopBackground` can signal the whole tree, and the
   * path the session writes its exit code to when the command finishes.
   *
   * The pid cannot be the launcher's `$!`: that is a wrapper shell which exits
   * at once and leaves the real job unstoppable (and setsid forks when it is
   * already a group leader). The new session therefore prints its own `$$`
   * into a file, and the launcher waits for that one line before it returns.
   *
   * That session is a supervising shell rather than the workload itself: it
   * waits for the command so it can record `$?` into `statusPath` even when the
   * command fails. It stays the group leader, so stopping by pid still reaches
   * the whole tree.
   */
  async startBackground(command, { cwd = null, env = null, logPath, statusPath, login = false } = {}) {
    if (this.#closed) throw new Error('connection is closed');
    const body = String(command ?? '');
    if (body.trim() === '') throw new Error('command is required');
    if (env) {
      for (const key of Object.keys(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name: ${key}`);
      }
    }

    const log = logPath ? String(logPath) : `/tmp/presence-bg-${Date.now()}-${randomToken()}.log`;
    const status = statusPath ? String(statusPath) : `/tmp/presence-bg-${Date.now()}-${randomToken()}.status`;
    // Bound the per-job files in /tmp before this job adds two more. With the
    // default paths the job itself is about to add one file of each kind, so
    // leave that slot free: the directory then stays at fifty, not fifty-one.
    // Best effort: the count is informational and never blocks a start.
    const pruned = await this.#pruneBackgroundFiles({
      keepLog: BACKGROUND_KEEP_FILES - (/^\/tmp\/presence-bg-[^/]*\.log$/.test(log) ? 1 : 0),
      keepStatus: BACKGROUND_KEEP_FILES - (/^\/tmp\/presence-bg-[^/]*\.status$/.test(status) ? 1 : 0),
    });
    const statusTemp = `${status}.tmp`;
    const pidFile = `${log}.pid-${randomToken()}`;
    // Line-buffered logs: a C program behind stdbuf flushes per line instead of
    // sitting on an empty file until exit. Optional, so a host without stdbuf
    // just gets the plain command.
    const stdbuf = (await this.#stdbufAvailable()) ? 'stdbuf -oL -eL ' : '';
    const environment =
      env && Object.keys(env).length > 0
        ? `export ${Object.entries(env)
            .map(([key, value]) => `${key}=${shellQuote(value)}`)
            .join(' ')}; `
        : '';
    const directory = cwd ? `cd -- ${shellQuote(String(cwd))} || exit 1; ` : '';
    // stdout/stderr are attached to the log before the pid is printed: when the
    // log cannot be opened the job never starts, instead of dying after a "pid".
    // The status is staged and renamed, so a reader never sees it half-written.
    const inner = [
      `exec </dev/null >>${shellQuote(log)} 2>&1`,
      `printf '%s\\n' "$$" > ${shellQuote(pidFile)}`,
      `${stdbuf}bash ${login ? '-lc' : '-c'} ${shellQuote(body)}`,
      `rc=$?`,
      `printf '%s' "$rc" > ${shellQuote(statusTemp)}`,
      `mv -f ${shellQuote(statusTemp)} ${shellQuote(status)}`,
    ].join('\n');
    const launcher = [
      `${environment}${directory}: > ${shellQuote(log)} || exit 1`,
      `rm -f -- ${shellQuote(status)} ${shellQuote(statusTemp)} ${shellQuote(pidFile)}`,
      `setsid bash -c ${shellQuote(inner)} </dev/null >/dev/null &`,
      `n=0`,
      `while [ ! -s ${shellQuote(pidFile)} ] && [ "$n" -lt ${BACKGROUND_PID_POLLS} ]; do n=$((n+1)); sleep 0.01; done`,
      `if [ -s ${shellQuote(pidFile)} ]; then pid=$(cat ${shellQuote(pidFile)}); rm -f ${shellQuote(pidFile)}; printf '%s\\n' "$pid"; else echo 'presence: the remote shell did not report a pid' >&2; exit 1; fi`,
    ].join('\n');

    let started;
    try {
      started = await this.exec(launcher, { timeoutMs: BACKGROUND_LAUNCH_MS });
    } catch (error) {
      throw new Error(`could not start background job on ${this.target}: ${error?.message ?? error}`);
    }
    const lastLine = started.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    const match = /^(\d+)$/.exec(lastLine);
    if (!match) {
      const detail = started.stderr.trim().split('\n').slice(-5).join(' ').trim();
      const why = detail || (started.timedOut ? 'timed out' : `exit ${started.code}`);
      throw new Error(`could not start background job on ${this.target}: ${why}`);
    }
    const pid = Number(match[1]);
    this.#background.set(pid, {
      pid,
      command: body,
      cwd: cwd ? String(cwd) : null,
      logPath: log,
      statusPath: status,
      startedAt: Date.now(),
    });
    return { pid, logPath: log, statusPath: status, pruned };
  }

  /**
   * Remember a job that outlived an earlier connection to the same machine, so
   * `listBackground`/`stopBackground` still cover it after a reconnect. A pgid
   * belongs to the machine, not to the SSH session that started it. The status
   * path is optional, but without it a stop cannot report the job's exit code.
   */
  trackBackground({ pid, command = null, cwd = null, logPath = null, statusPath = null, startedAt = Date.now() } = {}) {
    const numeric = Number(pid);
    if (!Number.isSafeInteger(numeric) || numeric <= 1) return false;
    if (!this.#background.has(numeric)) {
      this.#background.set(numeric, { pid: numeric, command, cwd, logPath, statusPath, startedAt });
    }
    return true;
  }

  /**
   * Whether anything is left in `pgid`'s process group. `ps -g` matches the
   * session id too, and setsid makes both equal to the leader pid, so one
   * query covers the tree even when the leader is gone. `null` means the
   * machine could not be asked; that must never read as "nothing is there".
   */
  async #groupAlive(pgid) {
    try {
      const result = await this.exec(`ps -o pid= -g ${Number(pgid)} 2>/dev/null`, {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
      // procps exits 1 when no process matches; anything else is "unknown".
      if (result.code !== 0 && result.code !== 1) return null;
      return result.stdout.trim() !== '';
    } catch {
      return null;
    }
  }

  /**
   * Stop a job started by `startBackground`. The signal goes to the process
   * group, not the single pid: the leader may already be gone while its
   * children still run. Whatever survives the grace period is killed hard.
   *
   * A group that is already gone is reported as such — `stopped: false`,
   * `reason: 'no such process group'` — instead of pretending the signal did
   * something. After a real kill the status file decides the exit code; when
   * the wrapper was killed before writing one, `exitSignal` carries the shell
   * convention (143 for SIGTERM, 137 for SIGKILL) and `exitCode` stays null.
   */
  async stopBackground(pid, { signal = 'TERM', statusPath = null } = {}) {
    const pgid = Number(pid);
    // `kill -- -1` would signal every process this user owns, so refuse it.
    if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pid}`);
    const name = String(signal ?? 'TERM')
      .toUpperCase()
      .replace(/^SIG/, '');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(name)) throw new Error(`unsupported signal: ${signal}`);
    const tracked = this.#background.get(pgid);
    const statusFile = statusPath ? String(statusPath) : (tracked?.statusPath ?? null);

    const alive = await this.#groupAlive(pgid);
    if (alive === null) {
      throw new Error(`could not inspect process group ${pgid} on ${this.target}`);
    }
    if (!alive) {
      // A repeated stop, or a job that finished on its own: never claim success.
      const status = statusFile ? await this.backgroundStatus(statusFile) : null;
      this.#background.delete(pgid);
      return {
        stopped: false,
        wasAlive: false,
        reason: 'no such process group',
        survivors: [],
        exitCode: status?.found ? status.exitCode : null,
        exitSignal: null,
      };
    }

    const script = [
      `pgid=${pgid}`,
      // `-s NAME -- -pgid`: the long form is what dash/sh accept, and the group
      // is addressed as a negative pid.
      `if kill -s ${name} -- -"$pgid" 2>/dev/null; then`,
      `  n=0`,
      `  while kill -s 0 -- -"$pgid" 2>/dev/null && [ "$n" -lt ${BACKGROUND_STOP_POLLS} ]; do n=$((n+1)); sleep 0.05; done`,
      `  if kill -s 0 -- -"$pgid" 2>/dev/null; then`,
      `    echo __PRESENCE_HARD_KILL__`,
      `    kill -s KILL -- -"$pgid" 2>/dev/null`,
      `    sleep 0.1`,
      `  fi`,
      `else`,
      `  echo __PRESENCE_NO_KILL__`,
      `fi`,
      `if kill -s 0 -- -"$pgid" 2>/dev/null; then echo __PRESENCE_STILL_RUNNING__; fi`,
      `ps -o pid=,args= -g "$pgid" 2>/dev/null`,
      // Read after the kill, so a wrapper that just managed to finish still wins.
      statusFile
        ? `if [ -f ${shellQuote(statusFile)} ]; then printf '__PRESENCE_STATUS__ '; cat -- ${shellQuote(statusFile)} 2>/dev/null; printf '\\n'; fi`
        : null,
      `true`,
    ]
      .filter((line) => line !== null)
      .join('\n');
    const result = await this.exec(script, { timeoutMs: BACKGROUND_STOP_MS });
    if (result.code !== 0) {
      // Never claim a job was stopped when the stop script itself never ran.
      throw new Error(`could not stop process group ${pgid} on ${this.target}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const hardKilled = lines.includes('__PRESENCE_HARD_KILL__');
    const killRejected = lines.includes('__PRESENCE_NO_KILL__');
    const stillRunning = lines.includes('__PRESENCE_STILL_RUNNING__');
    const statusLine = lines.find((line) => line.startsWith('__PRESENCE_STATUS__'));
    const statusText = statusLine === undefined ? null : statusLine.slice('__PRESENCE_STATUS__'.length).trim();
    const survivors = lines.filter(
      (line) =>
        line !== '__PRESENCE_HARD_KILL__' &&
        line !== '__PRESENCE_NO_KILL__' &&
        line !== '__PRESENCE_STILL_RUNNING__' &&
        !line.startsWith('__PRESENCE_STATUS__'),
    );
    const stopped = !stillRunning && survivors.length === 0;
    // Forget a job only once its group is really gone; survivors stay tracked.
    if (stopped) this.#background.delete(pgid);
    const statusFound = statusText !== null;
    return {
      stopped,
      wasAlive: true,
      survivors,
      exitCode: statusFound && /^\d{1,3}$/.test(statusText) ? Number(statusText) : null,
      // A status file means the wrapper finished; otherwise the signal we had
      // to use is the only exit information there is.
      exitSignal: stopped && !statusFound && !killRejected ? signalExitCode(hardKilled ? 'KILL' : name) : null,
      ...(stopped ? {} : { reason: 'process group survived' }),
    };
  }

  /**
   * Registered jobs that still have a process in their group, from one `ps`.
   * Matching on pgid catches the case where the leader exited but children
   * remained: the group keeps the leader's pid as its id.
   */
  async listBackground() {
    const jobs = [...this.#background.values()];
    if (jobs.length === 0) return [];
    const result = await this.exec('ps -eo pid=,ppid=,pgid=,args=', {
      timeoutMs: 15_000,
      maxOutputBytes: BACKGROUND_LIST_BYTES,
    });
    if (result.code !== 0) {
      throw new Error(`could not list processes on ${this.target}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    if (result.stdoutTruncated) {
      throw new Error(`could not list processes on ${this.target}: the process table is too large to read`);
    }
    const members = new Map();
    for (const line of result.stdout.split('\n')) {
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!row) continue;
      const pgid = Number(row[3]);
      if (!this.#background.has(pgid)) continue;
      members.set(pgid, (members.get(pgid) ?? 0) + 1);
    }
    return jobs
      .filter((job) => members.has(job.pid))
      .map((job) => ({ ...job, alive: true, processes: members.get(job.pid) }));
  }

  /**
   * Exit status of several background jobs in one round trip. The result is an
   * array parallel to `statusPaths`: `{ found: false }` means that job is still
   * running, `{ found: true, exitCode }` means its wrapper finished (a null exit
   * code means the file held no number). Throws only when the machine cannot be
   * asked at all.
   */
  async backgroundStatuses(statusPaths = []) {
    const paths = statusPaths.map((path) => String(path));
    if (paths.length === 0) return [];
    const script = [
      `count=$#`,
      `i=0`,
      `while [ "$i" -lt "$count" ]; do`,
      `  path=$1`,
      `  shift`,
      `  if [ -f "$path" ]; then`,
      `    printf '%s ' "$i"`,
      `    cat -- "$path" 2>/dev/null`,
      `    printf '\\n'`,
      `  fi`,
      `  i=$((i+1))`,
      `done`,
      `true`,
    ].join('\n');
    const result = await this.exec(`bash -c ${shellQuote(script)} presence-statuses ${paths.map(shellQuote).join(' ')}`, {
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    const statuses = paths.map(() => ({ found: false, exitCode: null }));
    for (const line of result.stdout.split('\n')) {
      const row = /^(\d+) (.*)$/.exec(line);
      if (!row) continue;
      const index = Number(row[1]);
      if (!Number.isInteger(index) || index < 0 || index >= statuses.length) continue;
      const text = row[2].trim();
      statuses[index] = { found: true, exitCode: /^\d{1,3}$/.test(text) ? Number(text) : null };
    }
    return statuses;
  }

  /**
   * Read the exit code a background wrapper left at `statusPath`. `null` means
   * the machine could not be asked, which is not the same as "exited".
   */
  async backgroundStatus(statusPath) {
    try {
      const [status] = await this.backgroundStatuses([statusPath]);
      return status ?? null;
    } catch {
      return null;
    }
  }

  /** Last `lines` lines of a remote file; empty when it cannot be read. */
  async readTail(path, { lines = 40, timeoutMs = 15_000, maxBytes = OUTPUT_CAP_BYTES } = {}) {
    const count = Math.max(0, Math.floor(Number(lines) || 0));
    if (count === 0) return '';
    try {
      const result = await this.exec(`tail -n ${count} -- ${shellQuote(String(path))} 2>/dev/null`, {
        timeoutMs,
        maxOutputBytes: maxBytes,
      });
      return result.stdout;
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ sftp

  async #call(method, ...args) {
    const sftp = await this.sftp;
    return new Promise((resolve, reject) => {
      sftp[method](...args, (error, ...results) => {
        if (error) reject(error);
        else resolve(results.length > 1 ? results : results[0]);
      });
    });
  }

  async realpath(path = '.') {
    const resolved = await this.#call('realpath', path);
    return resolved;
  }

  /**
   * Ask the remote side whether anything accepts TCP on `remoteHost:remotePort`.
   * One exec, no extra tooling: /dev/tcp is a bash builtin. Throws when the port
   * is closed — the failure a forward would otherwise only show on its first
   * connection, where it reads as a local problem.
   *
   * @returns {Promise<{ checked: boolean, target: string }>} `checked: false`
   *   when the remote cannot run the probe (no bash, no /dev/tcp); the caller
   *   should then keep its previous behaviour instead of refusing the forward.
   */
  async probePort(remoteHost = '127.0.0.1', remotePort, { timeoutMs = 2_000 } = {}) {
    const host = String(remoteHost ?? '');
    if (!/^[A-Za-z0-9_.:%[\]-]+$/.test(host)) throw new Error(`remoteHost is not a host name or address: ${remoteHost}`);
    const port = Number(remotePort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`remotePort must be a TCP port number, got ${remotePort}`);
    }
    const target = `${host}:${port}`;
    // Host and port travel as argv, so no value is spliced into the script text.
    const script = 'exec 3<>/dev/tcp/"$1"/"$2"';
    let probe;
    try {
      probe = await this.exec(`bash -c ${shellQuote(script)} presence-probe ${shellQuote(host)} ${port}`, { timeoutMs });
    } catch (error) {
      if (!/timed out/i.test(error?.message ?? '')) {
        throw new Error(`could not probe ${target} on ${this.target}: ${error?.message ?? error}`);
      }
      throw new Error(`nothing is listening on ${target} on ${this.target}`);
    }
    // No bash, or built without net redirections: the question is unanswerable,
    // which is not the same as a closed port.
    if (probe.code === 127 || /\/dev\/tcp.*No such file/i.test(probe.stderr)) return { checked: false, target };
    if (probe.timedOut || probe.code !== 0) throw new Error(`nothing is listening on ${target} on ${this.target}`);
    return { checked: true, target };
  }

  /**
   * Wait until something accepts TCP on `host:port` on the remote machine.
   * One exec per attempt, using bash's /dev/tcp builtin, so no tool is needed
   * on the far side. Unlike `probePort` this does not throw when the port is
   * closed: it keeps asking until the deadline, then reports `ready: false`.
   *
   * @returns {Promise<{ ready: boolean, waitedMs: number }>}
   */
  async waitForPort({ port, host = '127.0.0.1', timeoutMs = 10_000, intervalMs = 250 } = {}) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error(`port must be a TCP port number, got ${port}`);
    }
    const targetHost = String(host ?? '127.0.0.1');
    if (!/^[A-Za-z0-9_.:%[\]-]+$/.test(targetHost)) throw new Error(`host is not a host name or address: ${host}`);
    const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 10_000;
    const gap = Number.isFinite(Number(intervalMs)) ? Math.max(0, Number(intervalMs)) : 250;
    const started = Date.now();
    const deadline = started + budget;
    // Host and port travel as argv, so no value is spliced into the script text.
    const script = 'exec 3<>/dev/tcp/"$1"/"$2"';
    for (;;) {
      let ready = false;
      try {
        const remaining = Math.max(0, deadline - Date.now());
        const probe = await this.exec(
          `bash -c ${shellQuote(script)} presence-port ${shellQuote(targetHost)} ${portNumber}`,
          { timeoutMs: Math.max(250, Math.min(2_000, remaining)), maxOutputBytes: 8 * 1024 },
        );
        ready = probe.code === 0;
      } catch {
        // A host without bash, a dropped channel, a refused connect: not ready.
        ready = false;
      }
      if (ready) return { ready: true, waitedMs: Date.now() - started };
      if (Date.now() >= deadline) return { ready: false, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, Math.min(gap, Math.max(0, deadline - Date.now()))));
    }
  }

  /**
   * Forward a local TCP port to a port on the remote machine over this
   * connection, so a service started there is reachable at 127.0.0.1 here.
   */
  async tunnel({ localPort = 0, remoteHost = '127.0.0.1', remotePort } = {}) {
    if (!remotePort) throw new Error('remotePort is required');
    const { createServer } = await import('node:net');
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      this.#client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, stream) => {
        if (error) {
          socket.destroy();
          return;
        }
        stream.on('error', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    return {
      host: this.target,
      localPort: port,
      remoteHost,
      remotePort,
      close: () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  }

  async stat(path) {
    try {
      const info = await this.#call('stat', path);
      return {
        path,
        exists: true,
        size: info.size,
        mode: info.mode & 0o7777,
        mtime: info.mtime * 1000,
        isDir: info.isDirectory(),
        isLink: info.isSymbolicLink(),
        isFile: info.isFile(),
      };
    } catch (error) {
      if (error?.code === 2 || /No such file/i.test(error?.message ?? '')) return { path, exists: false };
      throw error;
    }
  }

  async list(path) {
    const entries = await this.#call('readdir', path);
    return entries
      .map((item) => ({
        name: item.filename,
        path: `${path.replace(/\/$/, '')}/${item.filename}`,
        size: item.attrs.size,
        mtime: item.attrs.mtime * 1000,
        kind: item.attrs.isDirectory() ? 'dir' : item.attrs.isSymbolicLink() ? 'link' : 'file',
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  /** The login directory, resolved once per connection. */
  async homePath() {
    if (this.#home === undefined) {
      this.#home = (await this.realpath('.')).replace(/\/+$/, '') || '/';
    }
    return this.#home;
  }

  /** Read a byte range; fixed-size requests keep the round trip predictable. */
  async readBytes(path, { offset = 0, length = 256 * 1024 } = {}) {
    const info = await this.stat(path);
    if (!info.exists) {
      const error = new Error(`no such file: ${path}`);
      error.code = 'not_found';
      throw error;
    }
    const size = Math.min(length, Math.max(0, info.size - offset));
    const buffer = Buffer.alloc(size);
    if (size === 0) return { buffer, info };
    const handle = await this.#call('open', path, 'r');
    try {
      let read = 0;
      while (read < size) {
        const chunk = await new Promise((resolve, reject) => {
          this.#call('read', handle, buffer, read, size - read, offset + read).then(([, chunk]) => resolve(chunk), reject);
        });
        if (!chunk || chunk.length === 0) break;
        read += chunk.length;
      }
      return { buffer: buffer.subarray(0, read), info };
    } finally {
      await this.#call('close', handle).catch(() => {});
    }
  }

  async readText(path, { offset = 0, length = 1024 * 1024 } = {}) {
    const { buffer, info } = await this.readBytes(path, { offset, length });
    return { path, content: buffer.toString('utf8'), size: info.size, mtime: info.mtime };
  }

  /**
   * Windowed read for files too big to pull whole: the line window is selected
   * on the far side, so only those lines cross the wire, and the total line
   * count is fetched separately so callers page with real numbers.
   * `lineOffset`/`lineLimit` win when given; otherwise `offsetBytes`/`maxBytes`
   * describe a byte window. `truncated` means the content stops before EOF.
   */
  async readTextWindow(path, { offsetBytes = 0, maxBytes = READ_WINDOW_BYTES, lineOffset, lineLimit } = {}) {
    const info = await this.stat(path);
    if (!info.exists) {
      const error = new Error(`no such file: ${path}`);
      error.code = 'not_found';
      throw error;
    }
    const budget = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : READ_WINDOW_BYTES;
    const offset = Math.max(0, Math.floor(Number(offsetBytes) || 0));
    const wantsLines = lineOffset !== undefined || lineLimit !== undefined;
    const first = Math.max(1, Math.floor(Number(lineOffset ?? 1)) || 1);
    const limit = lineLimit === undefined ? null : Math.max(0, Math.floor(Number(lineLimit) || 0));

    // Small enough to move in one piece: count and slice locally, so the count
    // stays exact even when the last line has no trailing newline.
    if (info.size <= budget) {
      const { buffer } = await this.readBytes(path, { offset: 0, length: budget });
      const text = buffer.toString('utf8');
      const lines = splitLines(text);
      if (!wantsLines) {
        return {
          content: (offset > 0 ? buffer.subarray(offset) : buffer).toString('utf8'),
          totalLines: lines.length,
          truncated: offset + buffer.length < info.size,
        };
      }
      const window = limit === null ? lines.slice(first - 1) : lines.slice(first - 1, first - 1 + limit);
      return { content: window.join('\n'), totalLines: lines.length, truncated: first - 1 + window.length < lines.length };
    }

    // Past the byte budget: never pull the whole file, only the window.
    const totalLines = await this.#lineCount(path);
    if (!wantsLines) {
      const { buffer } = await this.readBytes(path, { offset, length: budget });
      return { content: buffer.toString('utf8'), totalLines, truncated: offset + buffer.length < info.size };
    }
    const end = limit === null ? totalLines : Math.min(totalLines, first + limit - 1);
    if (limit === 0 || end < first) return { content: '', totalLines, truncated: totalLines > 0 };
    const read = await this.exec(`sed -n ${shellQuote(`${first},${end}p`)} ${shellQuote(path)}`, {
      timeoutMs: 60_000,
      maxOutputBytes: budget,
    });
    if (read.code !== 0 && read.stdout === '') {
      throw new Error(`could not read ${path}: ${read.stderr.trim() || `sed exited ${read.code}`}`);
    }
    // sed terminates every printed line; the caller gets lines, not a trailing
    // newline, matching the local branch above.
    const content = read.stdout.endsWith('\n') ? read.stdout.slice(0, -1) : read.stdout;
    return { content, totalLines, truncated: end < totalLines || Boolean(read.stdoutTruncated) };
  }

  /** True total line count, for paging arithmetic on files read in windows. */
  async #lineCount(path) {
    const { code, stdout } = await this.exec(`wc -l < ${shellQuote(path)}`, { timeoutMs: 60_000 });
    const count = Number.parseInt(String(stdout).trim(), 10);
    if (code !== 0 || !Number.isFinite(count)) throw new Error(`could not count lines in ${path}`);
    return count;
  }

  /**
   * Write via a temporary file + rename so readers never see half a file.
   *
   * `content` is a UTF-8 string or a Buffer. `options.mode` (an octal number
   * such as 0o755) sets the resulting mode; without it a target that is already
   * a regular file keeps the mode it had, so rewriting an executable script
   * stops silently turning it into 0644. A new file is created 0644 (subject to
   * the server's umask). The mode is applied to the staged temporary, before
   * the rename, so the target never appears between two writes with the wrong
   * mode.
   *
   * @returns {Promise<{ path: string, bytes: number, mode: number|null }>} the
   *   caller's `path`, the bytes written, and the mode forced onto the file —
   *   `null` when the server default stands and the value is not known here.
   */
  async writeText(path, content, options = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    // Explicit mode wins. A null here means "preserve or default", decided only
    // once the target is resolved below.
    let mode = octalMode(options?.mode);
    // A rename onto a symlink would replace the link itself and leave the real
    // file with its old content, so stage beside the resolved target instead.
    let link = null;
    try {
      // lstat, not stat: only the literal path matters here, and it is the only
      // way to tell a dangling link from a missing file.
      link = await this.#call('lstat', path);
    } catch (error) {
      // Missing path: the create case, which writes at the caller's path.
      if (!(error?.code === 2 || /No such file/i.test(error?.message ?? ''))) throw error;
    }
    let target = path;
    const dangling = () => {
      const error = new Error(`refusing to write "${path}": it is a symlink whose target does not exist`);
      error.code = 'dangling_symlink';
      return error;
    };
    if (link?.isSymbolicLink?.() === true) {
      // stat() follows the link, so a dead target shows up as ENOENT here. The
      // server's realpath() cannot be trusted for this: OpenSSH resolves a
      // dangling link lexically and reports its missing target as success.
      const followed = await this.stat(path);
      if (!followed.exists) throw dangling();
      // The mode to keep is the target's, not the link's: that stat already
      // followed the link, so this costs no extra round trip.
      if (mode === null && followed.isFile) mode = followed.mode;
      // Stage beside the resolved target, never at the link path: a rename onto
      // the link would replace the link itself and leave the target untouched.
      try {
        target = await this.realpath(path);
      } catch {
        // Resolution failed after all. Refuse rather than write at the link.
        throw dangling();
      }
    } else if (link) {
      // An existing non-link: resolve as before, so a relative path lands on the
      // same canonical file it always did.
      target = await this.realpath(path).catch(() => path);
      // For a non-link lstat and stat describe the same inode, so this is the
      // resolved target's mode without a second round trip.
      if (mode === null && link.isFile()) mode = link.mode & 0o7777;
    }
    const temporary = `${target}.presence-${process.pid}-${Date.now()}-${randomToken()}`;
    // Open with the mode this write is heading for rather than writeFile's 0666
    // default: a preserved or explicit mode is then never briefly wider on the
    // staged file, and a create publishes 0644 instead of umask's 0664. The
    // chmod below still fixes an explicit/preserved mode exactly, because the
    // open request is itself subject to the umask.
    await this.#call('writeFile', temporary, data, { mode: mode ?? DEFAULT_FILE_MODE });
    try {
      // chmod the temporary, never the target: the rename publishes content and
      // mode together, so nothing reads the new bytes at the old mode (or the
      // old bytes at the new one). A failed chmod must not leave the staged
      // file behind — the catch below unlinks it and rethrows.
      if (mode !== null) await this.#call('chmod', temporary, mode);
      // SFTP v3 rename refuses to replace an existing target; the OpenSSH
      // posix-rename extension is the atomic overwrite, and every real
      // OpenSSH server has it.
      try {
        await this.#call('ext_openssh_rename', temporary, target);
      } catch {
        await this.#call('unlink', target).catch(() => {});
        await this.#call('rename', temporary, target);
      }
    } catch (error) {
      await this.#call('unlink', temporary).catch(() => {});
      throw error;
    }
    // The caller asked about `path`; the link (if any) is still a link. `mode`
    // is reported only when we forced it: guessing the server default would
    // hide a umask surprise from the caller.
    return { path, bytes: data.length, mode };
  }

  /**
   * Binary upload: exactly `writeText`'s staging, rename and mode policy, but
   * it insists on a Buffer. Bytes cross untouched — no UTF-8 decode, no NUL
   * truncation — so PNG/PDF/archive content round-trips byte for byte. Used by
   * the `presence_import` tool; callers holding a string want `writeText`.
   */
  async writeBytes(path, buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) {
      const kind = buffer === null ? 'null' : Array.isArray(buffer) ? 'array' : typeof buffer;
      throw new Error(`writeBytes requires a Buffer, got ${kind}; use writeText for a string`);
    }
    return this.writeText(path, buffer, options);
  }

  /** Change a remote file's mode; `mode` is an octal number such as 0o640. */
  async chmod(path, mode) {
    const value = octalMode(mode);
    if (value === null) throw new Error('chmod requires a mode, for example 0o640');
    await this.#call('chmod', path, value);
    return { path, mode: value };
  }

  async unlink(path) {
    await this.#call('unlink', path);
  }

  async mkdir(path) {
    await this.#call('mkdir', path);
  }

  // ----------------------------------------------------------------- trash

  /**
   * Move a remote path into a trash container instead of deleting it. Nothing
   * is installed on the far side: one `sh` script performs the checks, the
   * metadata scan and the move in a single round trip.
   *
   * The default root is `~/.dsh/presence-trash`, expanded on the remote machine
   * (`$HOME`, with the login directory as fallback) and never locally. Each
   * call creates `<root>/<UTC timestamp>-<random>/` and moves the entry there
   * as `<container>/<basename>`.
   *
   * Symlinks: only the parent directory is resolved (`realpath -m`); the
   * literal basename is appended afterwards and that path is moved. `mv` acts
   * on the directory entry itself, so trashing a symlink moves the LINK and
   * leaves its target untouched — resolving the whole path would move the
   * target instead.
   *
   * Refused (throws, nothing moves): `/`, the remote home, an ancestor of the
   * remote home, a path that does not exist, and a path that still names `.`
   * or `..` after resolution. A symlink whose target is missing still exists
   * as a directory entry and can be trashed.
   *
   * `size` (`du -sb`) and `entries` (`find -type f | wc -l`) are best effort
   * and `null` when the host cannot produce them. `strategy` is `'rename'` for
   * a plain same-filesystem `mv`; `'copy'` when the entry crossed filesystems,
   * either because `mv` reported a cross-device link and `cp -a` + `rm -rf`
   * took over, or because the parent and the trash root are on different
   * devices (`mv` then copies internally, which is not atomic).
   *
   * @returns {Promise<{ path: string, trashed: true, trashPath: string,
   *   size: number|null, entries: number|null, strategy: 'rename'|'copy' }>}
   */
  async trash(path, { root = null } = {}) {
    const literal = String(path ?? '');
    if (literal === '') throw new Error('trash requires a path');
    const home = await this.homePath();
    const rawRoot = root === null || root === undefined ? TRASH_DEFAULT_ROOT : String(root);
    const token = randomToken();
    const script = [
      'set -u',
      'LC_ALL=C',
      'export LC_ALL',
      'literal=$1',
      'home=$2',
      'root=$3',
      'token=$4',
      'fail() {',
      "  printf 'presence: refusing to trash %s: %s\\n' \"$literal\" \"$1\" >&2",
      '  exit 3',
      '}',
      'if [ -z "$literal" ]; then fail "the path is empty"; fi',
      'if [ "$literal" = / ]; then fail "it is the filesystem root"; fi',
      'if [ ! -e "$literal" ] && [ ! -L "$literal" ]; then fail "no such file or directory"; fi',
      'dir=$(dirname -- "$literal") || fail "could not parse the path"',
      'base=$(basename -- "$literal") || fail "could not parse the path"',
      'case $base in',
      "  ''|.|..|/|*/*) fail \"it does not name a single directory entry\" ;;",
      'esac',
      'parent=$(realpath -m -- "$dir") || fail "could not resolve its parent directory"',
      'case $parent in',
      '  /*) ;;',
      '  *) fail "its parent directory did not resolve to an absolute path" ;;',
      'esac',
      'if [ "$parent" = / ]; then resolved=/$base; else resolved=$parent/$base; fi',
      'case $resolved in',
      '  */../*|*/..|*/./*|*/.|*/) fail "it still contains . or .. after resolution" ;;',
      'esac',
      'case $home in',
      '  */) home=${home%/} ;;',
      'esac',
      'if [ "$resolved" = "$home" ]; then fail "it is the remote home directory"; fi',
      'case $home in',
      '  "$resolved"/*) fail "it is an ancestor of the remote home directory" ;;',
      'esac',
      ...TRASH_ROOT_EXPAND.split('\n'),
      'rootdir=$(realpath -m -- "$root") || { echo "presence: could not resolve the trash root $root" >&2; exit 4; }',
      'case $rootdir in',
      '  /*) ;;',
      '  *) echo "presence: the trash root did not resolve to an absolute path" >&2; exit 4 ;;',
      'esac',
      'if [ "$rootdir" = / ]; then echo "presence: refusing to use / as the trash root" >&2; exit 4; fi',
      'case $rootdir in',
      '  "$resolved"|"$resolved"/*) fail "the trash root is inside it" ;;',
      'esac',
      'if ! mkdir -p -- "$rootdir" 2>/dev/null; then',
      '  echo "presence: could not create the trash root $rootdir" >&2',
      '  exit 4',
      'fi',
      'stamp=$(date -u "+%Y%m%dT%H%M%SZ") || { echo "presence: could not read the remote clock" >&2; exit 4; }',
      'container=$rootdir/$stamp-$token',
      'if ! mkdir -- "$container" 2>/dev/null; then',
      '  echo "presence: could not create the trash container $container" >&2',
      '  exit 4',
      'fi',
      'bounded() {',
      '  if command -v timeout >/dev/null 2>&1; then timeout 30s "$@"; else "$@"; fi',
      '}',
      'size=$(bounded du -sb -- "$resolved" 2>/dev/null | cut -f1)',
      'case $size in',
      '  ""|*[!0-9]*) size= ;;',
      'esac',
      'entries=$(bounded find "$resolved" -type f 2>/dev/null | wc -l)',
      'entries=$(printf "%s" "$entries" | tr -cd "0-9")',
      'srcdev=$(stat -c %d -- "$parent" 2>/dev/null)',
      'rootdev=$(stat -c %d -- "$rootdir" 2>/dev/null)',
      'dest=$container/$base',
      'strategy=rename',
      'if mv_error=$(LC_ALL=C mv -- "$resolved" "$dest" 2>&1); then',
      '  if [ -n "$srcdev" ] && [ -n "$rootdev" ] && [ "$srcdev" != "$rootdev" ]; then strategy=copy; fi',
      'else',
      '  case $mv_error in',
      '    *"cross-device link"*)',
      '      strategy=copy',
      '      if ! cp_error=$(LC_ALL=C cp -a -- "$resolved" "$dest" 2>&1); then',
      '        rm -rf -- "$container" 2>/dev/null',
      '        printf "presence: could not copy %s into the trash: %s\\n" "$resolved" "$cp_error" >&2',
      '        exit 5',
      '      fi',
      '      if ! rm_error=$(LC_ALL=C rm -rf -- "$resolved" 2>&1); then',
      '        printf "presence: %s is copied into the trash but the original could not be removed: %s\\n" "$resolved" "$rm_error" >&2',
      '        exit 5',
      '      fi',
      '      ;;',
      '    *)',
      '      rmdir -- "$container" 2>/dev/null',
      '      printf "presence: could not move %s into the trash: %s\\n" "$resolved" "$mv_error" >&2',
      '      exit 5',
      '      ;;',
      '  esac',
      'fi',
      'encoded=$(printf "%s" "$dest" | base64 | tr -d "\\n")',
      'printf "__PRESENCE_TRASH__ %s %s %s %s\\n" "$strategy" "${size:--}" "${entries:--}" "$encoded"',
    ].join('\n');
    const result = await this.exec(
      `sh -c ${shellQuote(script)} presence-trash ${shellQuote(literal)} ${shellQuote(home)} ${shellQuote(rawRoot)} ${shellQuote(token)}`,
      { timeoutMs: TRASH_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
    );
    const match = /^__PRESENCE_TRASH__ (rename|copy) (\d+|-) (\d+|-) ([A-Za-z0-9+/=]+)$/m.exec(result.stdout);
    if (!match) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      const error = new Error(`could not trash ${literal} on ${this.target}: ${detail}`);
      error.code = result.code === 3 ? 'refused' : 'trash_failed';
      throw error;
    }
    return {
      path: literal,
      trashed: true,
      trashPath: Buffer.from(match[4], 'base64').toString('utf8'),
      size: match[2] === '-' ? null : Number(match[2]),
      entries: match[3] === '-' ? null : Number(match[3]),
      strategy: match[1],
    };
  }

  /**
   * Recent trash entries, newest container first. Each entry is
   * `{ trashPath, movedAt, name }`: the complete path of the trashed item, the
   * container's UTC timestamp as an ISO 8601 string, and the item's own name.
   * Only containers created by `trash` (`<timestamp>-<random>`) are listed;
   * empty containers and foreign directories under the root are skipped.
   * `limit` is clamped to 1..1000, and `root` follows `trash`'s remote `~`
   * expansion.
   *
   * @returns {Promise<Array<{ trashPath: string, movedAt: string|null, name: string }>>}
   */
  async listTrash({ root = null, limit = 20 } = {}) {
    const requested = limit === null || limit === undefined ? 20 : Number(limit);
    const wanted = Number.isFinite(requested) ? Math.floor(requested) : 20;
    if (wanted <= 0) return [];
    const capped = Math.min(wanted, TRASH_LIST_LIMIT);
    const home = await this.homePath();
    const rawRoot = root === null || root === undefined ? TRASH_DEFAULT_ROOT : String(root);
    const script = [
      'set -u',
      'LC_ALL=C',
      'export LC_ALL',
      'home=$1',
      'root=$2',
      'limit=$3',
      ...TRASH_ROOT_EXPAND.split('\n'),
      'rootdir=$(realpath -m -- "$root") || { echo "presence: could not resolve the trash root $root" >&2; exit 3; }',
      'if [ -e "$rootdir" ] && [ ! -d "$rootdir" ]; then',
      '  echo "presence: the trash root is not a directory: $rootdir" >&2',
      '  exit 3',
      'fi',
      '[ -d "$rootdir" ] || exit 0',
      // Sort by the container's mtime, not by its name: two entries trashed in
      // the same second would otherwise be ordered by their random suffix.
      'find "$rootdir" -mindepth 1 -maxdepth 1 -type d -name "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*" -printf "%T@ %f\\n" 2>/dev/null | sort -rn | head -n "$limit" | while IFS= read -r row; do',
      '  name=${row#* }',
      "  find \"$rootdir/$name\" -mindepth 1 -maxdepth 1 -exec sh -c 'for p do printf \"%s\\000\" \"$p\"; done' sh {} + 2>/dev/null",
      'done',
    ].join('\n');
    const result = await this.exec(
      `sh -c ${shellQuote(script)} presence-list-trash ${shellQuote(home)} ${shellQuote(rawRoot)} ${capped}`,
      { timeoutMs: TRASH_LIST_TIMEOUT_MS, maxOutputBytes: TRASH_LIST_BYTES },
    );
    if (result.code !== 0) {
      throw new Error(`could not list the trash on ${this.target}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    if (result.stdoutTruncated) {
      throw new Error(`the trash listing on ${this.target} is too large; lower the limit`);
    }
    return result.stdout
      .split('\u0000')
      .filter((entry) => entry !== '')
      .slice(0, capped)
      .map((trashPath) => {
        const slash = trashPath.lastIndexOf('/');
        const name = slash === -1 ? trashPath : trashPath.slice(slash + 1);
        const container = slash === -1 ? '' : trashPath.slice(0, slash);
        const containerName = container.slice(container.lastIndexOf('/') + 1);
        const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(containerName);
        return {
          trashPath,
          movedAt: stamp
            ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`
            : null,
          name,
        };
      });
  }

  /**
   * Move a previously trashed path back. `to` is required: a container records
   * when an entry was trashed, not where it came from, so guessing the original
   * location from the leaf name would be unreliable. The destination's parent
   * directory is created when missing; the destination itself must not exist
   * (no silent overwrite). Like `trash`, only the parents are resolved with
   * `realpath -m`, so a trashed symlink comes back as a link.
   *
   * @returns {Promise<{ restored: true, to: string }>} the resolved absolute
   *   destination, which is where the entry actually landed.
   */
  async restoreTrash(trashPath, { to = null } = {}) {
    const literal = String(trashPath ?? '');
    if (literal === '') throw new Error('restoreTrash requires a trashPath');
    if (to === null || to === undefined || String(to).trim() === '') {
      throw new Error(
        'restoreTrash requires the original location: pass { to: "<path>" }; the trash container does not record where the entry came from',
      );
    }
    const wanted = String(to);
    const home = await this.homePath();
    const script = [
      'set -u',
      'LC_ALL=C',
      'export LC_ALL',
      'literal=$1',
      'to=$2',
      'home=$3',
      'fail() {',
      "  printf 'presence: refusing to restore %s: %s\\n' \"$literal\" \"$1\" >&2",
      '  exit 3',
      '}',
      'if [ -z "$literal" ]; then fail "the trash path is empty"; fi',
      'if [ "$literal" = / ]; then fail "it is the filesystem root"; fi',
      'if [ ! -e "$literal" ] && [ ! -L "$literal" ]; then fail "no such file or directory in the trash"; fi',
      'dir=$(dirname -- "$literal") || fail "could not parse the trash path"',
      'base=$(basename -- "$literal") || fail "could not parse the trash path"',
      'case $base in',
      "  ''|.|..|/|*/*) fail \"it does not name a single directory entry\" ;;",
      'esac',
      'parent=$(realpath -m -- "$dir") || fail "could not resolve its parent directory"',
      'case $parent in',
      '  /*) ;;',
      '  *) fail "its parent directory did not resolve to an absolute path" ;;',
      'esac',
      'if [ "$parent" = / ]; then resolved=/$base; else resolved=$parent/$base; fi',
      'case $resolved in',
      '  */../*|*/..|*/./*|*/.|*/) fail "it still contains . or .. after resolution" ;;',
      'esac',
      'case $home in',
      '  */) home=${home%/} ;;',
      'esac',
      'if [ "$resolved" = "$home" ]; then fail "it is the remote home directory"; fi',
      'case $home in',
      '  "$resolved"/*) fail "it is an ancestor of the remote home directory" ;;',
      'esac',
      'if [ -z "$to" ]; then fail "no destination was given"; fi',
      'todir=$(dirname -- "$to") || fail "could not parse the destination"',
      'tobase=$(basename -- "$to") || fail "could not parse the destination"',
      'case $tobase in',
      "  ''|.|..|/|*/*) fail \"the destination does not name a single directory entry\" ;;",
      'esac',
      'toparent=$(realpath -m -- "$todir") || fail "could not resolve the destination parent directory"',
      'case $toparent in',
      '  /*) ;;',
      '  *) fail "the destination parent did not resolve to an absolute path" ;;',
      'esac',
      'if [ "$toparent" = / ]; then dest=/$tobase; else dest=$toparent/$tobase; fi',
      'case $dest in',
      '  */../*|*/..|*/./*|*/.|*/) fail "the destination still contains . or .. after resolution" ;;',
      'esac',
      'if [ "$dest" = / ]; then fail "the destination is the filesystem root"; fi',
      'if [ "$dest" = "$home" ]; then fail "the destination is the remote home directory"; fi',
      'case $home in',
      '  "$dest"/*) fail "the destination is an ancestor of the remote home directory" ;;',
      'esac',
      'if [ -e "$dest" ] || [ -L "$dest" ]; then fail "the destination already exists"; fi',
      'if ! mkdir -p -- "$toparent" 2>/dev/null; then',
      '  echo "presence: could not create the destination directory $toparent" >&2',
      '  exit 4',
      'fi',
      'if ! mv_error=$(LC_ALL=C mv -- "$resolved" "$dest" 2>&1); then',
      '  case $mv_error in',
      '    *"cross-device link"*)',
      '      if ! cp_error=$(LC_ALL=C cp -a -- "$resolved" "$dest" 2>&1); then',
      '        rm -rf -- "$dest" 2>/dev/null',
      '        printf "presence: could not copy %s to %s: %s\\n" "$resolved" "$dest" "$cp_error" >&2',
      '        exit 5',
      '      fi',
      '      if ! rm_error=$(LC_ALL=C rm -rf -- "$resolved" 2>&1); then',
      '        printf "presence: %s is copied to %s but the trashed copy could not be removed: %s\\n" "$resolved" "$dest" "$rm_error" >&2',
      '        exit 5',
      '      fi',
      '      ;;',
      '    *)',
      '      printf "presence: could not move %s to %s: %s\\n" "$resolved" "$dest" "$mv_error" >&2',
      '      exit 5',
      '      ;;',
      '  esac',
      'fi',
      'container=$(dirname -- "$resolved")',
      'case $(basename -- "$container") in',
      '  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*) rmdir -- "$container" 2>/dev/null ;;',
      'esac',
      'encoded=$(printf "%s" "$dest" | base64 | tr -d "\\n")',
      'printf "__PRESENCE_RESTORED__ %s\\n" "$encoded"',
    ].join('\n');
    const result = await this.exec(
      `sh -c ${shellQuote(script)} presence-restore ${shellQuote(literal)} ${shellQuote(wanted)} ${shellQuote(home)}`,
      { timeoutMs: TRASH_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
    );
    const match = /^__PRESENCE_RESTORED__ ([A-Za-z0-9+/=]+)$/m.exec(result.stdout);
    if (!match) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      const error = new Error(`could not restore ${literal} on ${this.target}: ${detail}`);
      error.code = result.code === 3 ? 'refused' : 'restore_failed';
      throw error;
    }
    return { restored: true, to: Buffer.from(match[1], 'base64').toString('utf8') };
  }

  /** Literal replacement; refuses to guess when the anchor is ambiguous. */
  async editText(path, oldText, newText, { replaceAll = false } = {}) {
    if (!oldText) throw new Error('oldText must not be empty');
    const { content } = await this.readText(path, { length: Number.MAX_SAFE_INTEGER });
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      const error = new Error('text to replace was not found');
      error.code = 'not_found';
      throw error;
    }
    if (occurrences > 1 && !replaceAll) {
      const error = new Error(`text occurs ${occurrences} times; pass replaceAll or a longer anchor`);
      error.code = 'ambiguous';
      throw error;
    }
    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    // readText follows the link and writeText writes through it, so editing a
    // symlinked file leaves the link in place.
    const result = await this.writeText(path, updated);
    return { ...result, replaced: replaceAll ? occurrences : 1 };
  }
}

/** Kept for callers that need a raw TCP socket through the connection. */
export function forwardOut(client, source, destination) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, destination.host, destination.port, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

export { Client };
