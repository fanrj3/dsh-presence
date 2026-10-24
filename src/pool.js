// The pool the plugin owns: one live connection per machine, plus the
// terminals that belong to it.

import { listHosts, readSshConfig } from './core/ssh-config.mjs';
import { PresenceConnection } from './core/connection.mjs';

const MAX_TERMINAL_BUFFER = 256 * 1024;
// A job that dies at once (a port already in use) must not be reported as
// started: give the wrapper a moment, then check the process group.
const JOB_EARLY_CHECK_MS = 800;
const JOB_EARLY_TAIL_LINES = 20;
// Finished jobs pile up in the local registry for the life of the app. Prune
// them at most once a minute from `listJobs`, keeping the newest entries and
// anything that finished in the last six hours.
const JOB_PRUNE_INTERVAL_MS = 60_000;
const JOB_PRUNE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const JOB_PRUNE_MAX_ENTRIES = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PresencePool {
  #settings;
  #connections = new Map();
  #connecting = new Map();
  #terminals = new Map();
  #tunnels = new Map();
  #jobs = new Map();
  #lastUsed = new Map();
  #lastPruneAt = 0;
  #secrets = new Map();
  #hostsCache;
  #reaper;
  #counter = 0;

  constructor(settings) {
    this.#settings = settings;
    this.#reaper = setInterval(() => this.#reapIdle(), 60_000);
    this.#reaper.unref?.();
  }

  get settings() {
    return this.#settings;
  }

  /** Machines from ~/.ssh/config, with live state. The file itself is re-read at most every 10s. */
  hosts() {
    const now = Date.now();
    if (!this.#hostsCache || now - this.#hostsCache.at > 10_000) {
      this.#hostsCache = { at: now, list: listHosts() };
    }
    return this.#hostsCache.list.map((entry) => {
      const connection = this.#connections.get(entry.alias);
      return {
        alias: entry.alias,
        hostname: entry.hostname,
        port: entry.port,
        user: entry.user,
        connected: Boolean(connection && !connection.closed),
        identityFile: entry.identityFile?.[0],
        terminals: [...this.#terminals.values()].filter((terminal) => terminal.host === entry.alias).length,
      };
    });
  }

  /** Resolve a live connection, opening one if needed. */
  async connection(host, { password, passphrase } = {}) {
    const existing = this.#connections.get(host);
    if (existing && !existing.closed) {
      this.#lastUsed.set(host, Date.now());
      return existing;
    }
    if (this.#connecting.has(host)) return this.#connecting.get(host);

    const entry = readSshConfig().get(host);
    if (!entry) {
      const known = listHosts()
        .map((item) => item.alias)
        .join(', ');
      throw new Error(`no host "${host}" in ~/.ssh/config${known ? `; available: ${known}` : ''}`);
    }

    // Secrets live in this process only, never in the session log. A value
    // supplied once is reused for reconnects until the plugin unloads. Until
    // the panel ships, a password can come from the environment of the process
    // that launched the Harness: PRESENCE_PASSWORD_<ALIAS>.
    const envPassword = process.env[`PRESENCE_PASSWORD_${host.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`];
    if (password || passphrase) this.#secrets.set(host, { password, passphrase });
    const secret = this.#secrets.get(host) ?? (envPassword ? { password: envPassword } : {});

    const pending = PresenceConnection.connect(
      { ...entry, maxChannels: this.#settings.maxChannels },
      { password: secret.password, passphrase: secret.passphrase, timeoutMs: this.#settings.connectTimeoutMs },
    )
      .then((connection) => {
        this.#connections.set(host, connection);
        this.#lastUsed.set(host, Date.now());
        return connection;
      })
      .finally(() => this.#connecting.delete(host));

    this.#connecting.set(host, pending);
    return pending;
  }

  async disconnect(host) {
    const connection = this.#connections.get(host);
    this.#connections.delete(host);
    this.#lastUsed.delete(host);
    for (const terminal of [...this.#terminals.values()]) {
      if (terminal.host === host) this.#closeTerminal(terminal.id);
    }
    connection?.end();
  }

  /** Whether a password for this host is held in this process right now. */
  hasSecret(host) {
    return this.#secrets.has(host);
  }

  forgetSecret(host) {
    this.#secrets.delete(host);
  }

  // ------------------------------------------------------------- terminals

  // --------------------------------------------------------------- tunnels

  /** Forward a local port to the remote machine so its services are reachable. */
  async openTunnel(host, { localPort = 0, remoteHost = '127.0.0.1', remotePort } = {}) {
    if (!remotePort) throw new Error('remotePort is required');
    const connection = await this.connection(host);
    // Probe before the forward exists: otherwise a closed remote port only
    // surfaces on the first connection through the tunnel, where it looks like
    // a local failure. One cheap exec; hosts without bash skip the check.
    await connection.probePort(remoteHost, remotePort);
    const tunnel = await connection.tunnel({ localPort, remoteHost, remotePort });
    const id = `f${(this.#counter += 1)}`;
    this.#tunnels.set(id, tunnel);
    return { id, host: tunnel.host, localPort: tunnel.localPort, remoteHost: tunnel.remoteHost, remotePort: tunnel.remotePort };
  }

  async closeTunnel(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return false;
    this.#tunnels.delete(id);
    await tunnel.close();
    return true;
  }

  listTunnels() {
    return [...this.#tunnels.entries()].map(([id, tunnel]) => ({
      id,
      host: tunnel.host,
      localPort: tunnel.localPort,
      remoteHost: tunnel.remoteHost,
      remotePort: tunnel.remotePort,
      url: `http://127.0.0.1:${tunnel.localPort}`,
    }));
  }

  // -------------------------------------------------------- background jobs

  /**
   * Start a detached job on one machine and remember it. `pid` is the job's
   * session leader, i.e. its process group, so either one can later be stopped
   * as a unit. The log and the exit-status file are on the remote machine;
   * `logPath` and `statusPath` say where.
   *
   * A command that dies at once (a port already in use, a missing binary) used
   * to look like a successful start. The launcher returns as soon as the leader
   * prints its pid, so wait briefly and report the death with its exit code and
   * the end of the log instead.
   */
  async startJob(host, { command, cwd = null, logPath = null, label = null, sessionId = null } = {}) {
    if (!command) throw new Error('command is required');
    const connection = await this.connection(host);
    const started = await connection.startBackground(command, { cwd, logPath });
    const id = `j${(this.#counter += 1)}`;
    const job = {
      id,
      host,
      pid: started.pid,
      logPath: started.logPath,
      statusPath: started.statusPath,
      command,
      cwd,
      label: label ?? null,
      sessionId: sessionId ?? null,
      startedAt: Date.now(),
      state: 'running',
      exitCode: null,
      exitSignal: null,
      exitedAt: null,
      logSize: null,
      logTail: '',
      stopped: false,
    };
    this.#jobs.set(id, job);

    await sleep(JOB_EARLY_CHECK_MS);
    const alive = await this.#groupAlive(connection, job.pid);
    if (alive !== false) {
      return { id, host, pid: job.pid, logPath: job.logPath, statusPath: job.statusPath, label: job.label, sessionId: job.sessionId };
    }
    const status = await connection.backgroundStatus(job.statusPath);
    const output = await this.#readOutput(connection, job, JOB_EARLY_TAIL_LINES);
    job.state = 'exited';
    job.exitCode = status?.found ? status.exitCode : null;
    job.exitedAt = Date.now();
    job.logSize = output.logSize;
    job.logTail = output.logTail;
    return {
      id,
      host,
      pid: job.pid,
      logPath: job.logPath,
      statusPath: job.statusPath,
      label: job.label,
      sessionId: job.sessionId,
      exitedEarly: true,
      exitCode: job.exitCode,
      exitSignal: job.exitSignal ?? null,
      logTail: job.logTail,
      logSize: job.logSize,
    };
  }

  /**
   * Wait for a job to finish, or for the deadline. Checks the status file
   * first: the wrapper writes it even when the command fails, so the caller
   * gets a real exit code instead of polling `ps`. Falls back to process-group
   * liveness for a job that was killed before it could write one.
   *
   * Throws only when the id is not in the registry. An unreachable host yields
   * `state: 'unknown'` (the detached job may well still be running), never a
   * claim that it exited.
   */
  async waitJob(id, { timeoutMs = 120_000, tailLines = 40, pollMs = 500 } = {}) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`no background job "${id}"`);
    const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 120_000;
    const gap = Number.isFinite(Number(pollMs)) ? Math.max(10, Number(pollMs)) : 500;
    const lines = Number.isFinite(Number(tailLines)) ? Math.max(0, Math.floor(Number(tailLines))) : 40;
    const deadline = Date.now() + budget;

    let connection;
    try {
      connection = await this.connection(job.host);
    } catch {
      return this.#unreachableResult(job);
    }

    for (;;) {
      const status = await connection.backgroundStatus(job.statusPath);
      if (status === null) return this.#unreachableResult(job);
      if (status.found) {
        const output = await this.#readOutput(connection, job, lines);
        job.state = 'exited';
        job.exitCode = status.exitCode;
        job.exitedAt ??= Date.now();
        job.logSize = output.logSize ?? job.logSize;
        job.logTail = output.logTail;
        return this.#jobResult(job, {
          state: 'exited',
          exitCode: status.exitCode,
          exitSignal: job.exitSignal ?? null,
          exitedAt: job.exitedAt,
          ...output,
        });
      }

      const alive = await this.#groupAlive(connection, job.pid);
      if (alive === null) return this.#unreachableResult(job);
      if (!alive) {
        // No wrapper left to write a status: it was killed, or the host died.
        // A stop we performed ourselves recorded which signal did it.
        const output = await this.#readOutput(connection, job, lines);
        job.state = 'exited';
        job.exitCode = null;
        job.exitedAt ??= Date.now();
        job.logSize = output.logSize ?? job.logSize;
        job.logTail = output.logTail;
        return this.#jobResult(job, {
          state: 'exited',
          exitCode: null,
          exitSignal: job.exitSignal ?? null,
          exitedAt: job.exitedAt,
          ...output,
        });
      }

      if (Date.now() >= deadline) {
        const output = await this.#readOutput(connection, job, lines);
        job.state = 'running';
        job.logSize = output.logSize ?? job.logSize;
        job.logTail = output.logTail;
        return this.#jobResult(job, { state: 'running', ...output });
      }
      await sleep(Math.min(gap, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * Stop one job: TERM to its whole process group, then KILL whatever is left.
   * Throws for an id this pool does not know. A raw group from an earlier run
   * can be passed instead — `stopJob({ pgid, host })` — because a pgid belongs
   * to the machine, not to this process.
   */
  async stopJob(id, { pgid = null, host = null } = {}) {
    if (id && typeof id === 'object') {
      ({ pgid = null, host = null } = id);
      id = id.id ?? id.jobId ?? null;
    }
    if (pgid !== null && pgid !== undefined) {
      const numeric = Number(pgid);
      if (!Number.isSafeInteger(numeric) || numeric <= 1) throw new Error(`refusing to signal process group ${pgid}`);
      const target = host ?? this.#jobs.get(id)?.host ?? [...this.#jobs.values()].find((job) => job.pid === numeric)?.host ?? null;
      if (!target) throw new Error(`no host for process group ${numeric}; pass { pgid, host }`);
      const job = [...this.#jobs.values()].find((entry) => entry.host === target && entry.pid === numeric) ?? null;
      const result = await this.stopProcessGroup(target, numeric);
      return {
        id: job?.id ?? null,
        host: target,
        pid: numeric,
        logPath: job?.logPath ?? null,
        stopped: result.stopped,
        wasAlive: result.wasAlive,
        reason: result.reason ?? null,
        survivors: result.survivors,
        exitCode: result.exitCode ?? job?.exitCode ?? null,
        exitSignal: result.exitSignal ?? null,
      };
    }
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`no background job "${id}"`);
    const result = await this.stopProcessGroup(job.host, job.pid);
    return {
      id,
      host: job.host,
      pid: job.pid,
      logPath: job.logPath,
      stopped: result.stopped,
      wasAlive: result.wasAlive,
      reason: result.reason ?? null,
      survivors: result.survivors,
      exitCode: result.exitCode ?? job.exitCode ?? null,
      exitSignal: result.exitSignal ?? null,
    };
  }

  /**
   * Stop a raw process group on a machine; no registry entry is required.
   *
   * Reports what actually happened: a group that is already gone answers
   * `stopped: false` with `reason: 'no such process group'` instead of
   * claiming a kill, and a group killed before it could write its status
   * carries `exitSignal` (143 for SIGTERM, 137 for SIGKILL) with
   * `exitCode: null`.
   */
  async stopProcessGroup(host, pgid) {
    const numeric = Number(pgid);
    if (!Number.isSafeInteger(numeric) || numeric <= 1) throw new Error(`refusing to signal process group ${pgid}`);
    const connection = await this.connection(host);
    const job = [...this.#jobs.values()].find((entry) => entry.host === host && entry.pid === numeric) ?? null;
    const result = await connection.stopBackground(numeric, { statusPath: job?.statusPath ?? null });
    if (job) {
      job.wasAlive = result.wasAlive;
      job.survivors = result.survivors;
      // A repeated stop observes no signal, but must not erase the one that
      // actually ended the job.
      job.exitSignal = result.exitSignal ?? job.exitSignal ?? null;
      if (result.stopped) {
        job.stopped = true;
        job.state = 'exited';
        job.exitedAt ??= Date.now();
        job.exitCode = result.exitCode ?? null;
      } else if (!result.wasAlive) {
        // Already gone: its status file, when there is one, is the real code.
        job.state = 'exited';
        job.exitedAt ??= Date.now();
        job.exitCode = result.exitCode ?? job.exitCode ?? null;
      }
    }
    return {
      host,
      pgid: numeric,
      pid: numeric,
      stopped: result.stopped,
      wasAlive: result.wasAlive,
      reason: result.reason ?? null,
      survivors: result.survivors,
      exitCode: result.exitCode ?? job?.exitCode ?? null,
      exitSignal: result.exitSignal ?? null,
    };
  }

  /**
   * Drop local bookkeeping for jobs that are finished and past their welcome:
   * older than `maxAgeMs`, or beyond the newest `maxEntries`. Only EXITED jobs
   * are dropped — a running (or still unknown) job keeps its slot no matter
   * how old it is, and the detached process on the machine is never touched.
   * Returns the ids that were forgotten.
   */
  async pruneJobs({ maxAgeMs = JOB_PRUNE_MAX_AGE_MS, maxEntries = JOB_PRUNE_MAX_ENTRIES } = {}) {
    const now = Date.now();
    const age = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : JOB_PRUNE_MAX_AGE_MS;
    const limit = Number.isFinite(Number(maxEntries)) ? Math.max(0, Math.floor(Number(maxEntries))) : JOB_PRUNE_MAX_ENTRIES;
    const finishedAt = (job) => job.exitedAt ?? job.startedAt ?? 0;
    const dropped = new Set();
    for (const job of this.#jobs.values()) {
      if (job.state !== 'exited') continue;
      if (now - finishedAt(job) >= age) dropped.add(job.id);
    }
    // Keep the newest `limit` entries overall; running jobs inside the tail are
    // never dropped, only the finished ones behind them.
    const newestFirst = [...this.#jobs.values()].sort((a, b) => finishedAt(b) - finishedAt(a));
    for (const job of newestFirst.slice(limit)) {
      if (job.state === 'exited') dropped.add(job.id);
    }
    for (const id of dropped) this.#jobs.delete(id);
    this.#lastPruneAt = now;
    return { removed: dropped.size, ids: [...dropped] };
  }

  /**
   * Jobs this pool started, optionally narrowed to one session, with liveness
   * read from the machines connected right now. `state` is 'unknown' when the
   * host cannot be asked: a detached job outlives its SSH connection, so no
   * answer is not the same as a dead job.
   */
  async listJobs({ sessionId = undefined } = {}) {
    // Local bookkeeping only, so no round trip; at most once a minute so a
    // listing loop does not sort the registry on every call.
    if (Date.now() - this.#lastPruneAt >= JOB_PRUNE_INTERVAL_MS) {
      await this.pruneJobs().catch(() => {});
    }
    const jobs = [...this.#jobs.values()].filter((job) => sessionId === undefined || job.sessionId === sessionId);
    if (jobs.length === 0) return [];

    const byHost = new Map();
    for (const job of jobs) {
      if (!byHost.has(job.host)) byHost.set(job.host, []);
      byHost.get(job.host).push(job);
    }

    await Promise.all(
      [...byHost.entries()].map(async ([host, hostJobs]) => {
        const connection = this.#connections.get(host);
        if (!connection || connection.closed) {
          for (const job of hostJobs) if (job.state !== 'exited') job.state = 'unknown';
          return;
        }
        // A job started before a reconnect is not in this connection's registry;
        // its process group still exists on the machine, so seed it back in.
        for (const job of hostJobs) {
          if (job.stopped || job.state === 'exited') continue;
          connection.trackBackground({
            pid: job.pid,
            command: job.command,
            cwd: job.cwd,
            logPath: job.logPath,
            statusPath: job.statusPath,
            startedAt: job.startedAt,
          });
        }
        let running;
        try {
          running = new Set((await connection.listBackground()).map((entry) => entry.pid));
        } catch {
          // Liveness is a convenience; a failed `ps` must not hide the job list.
          running = null;
        }
        if (!running) {
          for (const job of hostJobs) if (job.state !== 'exited') job.state = 'unknown';
          return;
        }
        // One round trip for every status file on this host: the command may
        // have finished while a child it spawned kept the group alive.
        let statuses = null;
        try {
          statuses = await connection.backgroundStatuses(hostJobs.map((job) => job.statusPath));
        } catch {
          // Liveness from `ps` is still worth reporting.
        }
        await Promise.all(
          hostJobs.map(async (job, index) => {
            const status = statuses?.[index] ?? null;
            if (job.stopped) {
              job.state = 'exited';
              job.exitedAt ??= Date.now();
            } else if (status?.found) {
              job.state = 'exited';
              job.exitCode = status.exitCode;
              job.exitedAt ??= Date.now();
            } else if (job.state === 'exited') {
              // Already reported finished; a recycled pgid must not resurrect it.
              job.exitedAt ??= Date.now();
            } else if (running.has(job.pid)) {
              job.state = 'running';
            } else {
              // No wrapper left to write a status: it was killed.
              job.state = 'exited';
              job.exitCode = null;
              job.exitedAt ??= Date.now();
            }
            const info = await connection.stat(job.logPath).catch(() => null);
            if (info?.exists) job.logSize = info.size;
          }),
        );
      }),
    );

    return jobs.map((job) => ({
      id: job.id,
      host: job.host,
      pid: job.pid,
      state: job.state ?? 'unknown',
      exitCode: job.exitCode ?? null,
      exitSignal: job.exitSignal ?? null,
      label: job.label ?? null,
      sessionId: job.sessionId ?? null,
      startedAt: job.startedAt,
      logPath: job.logPath,
      logSize: job.logSize ?? null,
      // Kept for the existing jobs view, which still prints the command line.
      command: job.command,
      cwd: job.cwd,
    }));
  }

  /**
   * Whether anything is left in `pid`'s process group. The session leader is
   * also the pgid (setsid), so `ps -g` covers the tree even if the leader is
   * gone. `null` means the machine could not be asked.
   */
  async #groupAlive(connection, pid) {
    try {
      const result = await connection.exec(`ps -o pid= -g ${Number(pid)} 2>/dev/null`, { timeoutMs: 5_000 });
      // procps exits 1 when no process matches; any other failure is "unknown".
      if (result.code !== 0 && result.code !== 1) return null;
      return result.stdout.trim() !== '';
    } catch {
      return null;
    }
  }

  /** End of the job log and its current size, for a job that has stopped. */
  async #readOutput(connection, job, tailLines) {
    const [logTail, info] = await Promise.all([
      connection.readTail(job.logPath, { lines: tailLines }),
      connection.stat(job.logPath).catch(() => null),
    ]);
    return { logTail, logSize: info?.exists ? info.size : null };
  }

  #jobResult(job, { state, exitCode = null, exitSignal = null, exitedAt = null, logTail = '', logSize = null }) {
    return {
      id: job.id,
      host: job.host,
      pid: job.pid,
      logPath: job.logPath,
      statusPath: job.statusPath,
      state,
      exitCode,
      exitSignal,
      exitedAt,
      logTail,
      logSize,
    };
  }

  #unreachableResult(job) {
    const exited = job.state === 'exited' || job.stopped;
    return this.#jobResult(job, {
      state: exited ? 'exited' : 'unknown',
      exitCode: exited ? (job.exitCode ?? null) : null,
      exitSignal: exited ? (job.exitSignal ?? null) : null,
      exitedAt: exited ? (job.exitedAt ?? null) : null,
      logTail: job.logTail ?? '',
      logSize: job.logSize ?? null,
    });
  }

  async openTerminal(host, { cols = 120, rows = 32, session } = {}) {
    const connection = await this.connection(host);
    const stream = await connection.shell({ cols, rows });
    const id = `t${(this.#counter += 1)}`;
    const terminal = {
      id,
      host,
      stream,
      session: undefined,
      buffer: '',
      cursor: 0,
      cols,
      rows,
      closed: false,
      waiters: new Set(),
    };

    // A named session runs the shell inside tmux on the target machine, which
    // already ships it: the terminal then survives an SSH drop or an app
    // restart, and reopening with the same name reattaches to the live one.
    if (session) {
      const safe = String(session).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'presence';
      terminal.session = safe;
      stream.write('export TERM=xterm-256color\n');
      stream.write(`tmux new-session -A -s ${safe}\n`);
    }
    stream.on('data', (chunk) => {
      terminal.buffer += chunk;
      if (terminal.buffer.length > MAX_TERMINAL_BUFFER) {
        const drop = terminal.buffer.length - MAX_TERMINAL_BUFFER;
        terminal.buffer = terminal.buffer.slice(drop);
        terminal.cursor = Math.max(0, terminal.cursor - drop);
      }
      for (const wake of terminal.waiters) wake();
      terminal.waiters.clear();
    });
    stream.on('close', () => {
      terminal.closed = true;
      for (const wake of terminal.waiters) wake();
      terminal.waiters.clear();
    });
    this.#terminals.set(id, terminal);
    // A tmux reattach paints the whole screen, then repaints it once more when
    // the client size settles, so the caller's first read would replay the
    // screen twice. Let that initial burst land, discard it, and hand back a
    // terminal whose buffer starts after it. Plain shells keep the old
    // behaviour: their prompt is the first thing the caller wants to see.
    if (terminal.session) {
      await sleep(250);
      await this.readTerminal(id).catch(() => {});
    }
    return { id, host };
  }

  terminal(id) {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw new Error(`no terminal "${id}"; open one with action=open`);
    return terminal;
  }

  writeTerminal(id, data) {
    const terminal = this.terminal(id);
    if (terminal.closed) throw new Error(`terminal "${id}" is closed`);
    terminal.stream.write(data);
    return { ok: true };
  }

  resizeTerminal(id, cols, rows) {
    const terminal = this.terminal(id);
    terminal.cols = cols;
    terminal.rows = rows;
    try {
      terminal.stream.setWindow(rows, cols, 0, 0);
    } catch {
      /* channel closed */
    }
    return { ok: true };
  }

  /** Return output produced since the previous read, optionally waiting for some. */
  async readTerminal(id, { waitMs = 0 } = {}) {
    let terminal = this.terminal(id);
    let text = terminal.buffer.slice(terminal.cursor);
    if (!text && !terminal.closed && waitMs > 0) {
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          terminal.waiters.delete(wake);
          resolve();
        }, waitMs);
        terminal.waiters.add(wake);
      });
      terminal = this.terminal(id);
      text = terminal.buffer.slice(terminal.cursor);
    }
    terminal.cursor = terminal.buffer.length;
    return { data: text, closed: terminal.closed };
  }

  closeTerminal(id) {
    this.#closeTerminal(id);
  }

  #closeTerminal(id) {
    const terminal = this.#terminals.get(id);
    if (!terminal) return;
    this.#terminals.delete(id);
    try {
      terminal.stream.close();
    } catch {
      /* already gone */
    }
  }

  listTerminals() {
    return [...this.#terminals.values()].map((terminal) => ({
      id: terminal.id,
      host: terminal.host,
      session: terminal.session,
      closed: terminal.closed,
      pending: terminal.buffer.length - terminal.cursor,
    }));
  }

  // ---------------------------------------------------------------- housekeeping

  #reapIdle() {
    const now = Date.now();
    for (const [host, connection] of this.#connections) {
      const used = this.#lastUsed.get(host) ?? 0;
      if (connection.closed) {
        this.#connections.delete(host);
        this.#lastUsed.delete(host);
        continue;
      }
      if (now - used < this.#settings.idleTimeoutMs) continue;
      if (this.listTerminals().some((terminal) => terminal.host === host)) continue;
      this.disconnect(host);
    }
  }

  dispose() {
    clearInterval(this.#reaper);
    for (const terminal of [...this.#terminals.values()]) this.#closeTerminal(terminal.id);
    for (const tunnel of this.#tunnels.values()) tunnel.close().catch(() => {});
    this.#tunnels.clear();
    // Detached jobs are meant to outlive tool calls and this app: they keep
    // running, only the local bookkeeping goes away. Nothing here may throw.
    this.#jobs.clear();
    for (const connection of this.#connections.values()) connection.end();
    this.#connections.clear();
  }
}
