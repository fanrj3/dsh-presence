// Background-job completion notifications.
//
// The pool already knows when a detached job finishes (it polls the status file
// when asked). This module asks every couple of seconds, remembers the state it
// last reported, and on a running -> exited transition publishes a host event
// (`presence/job-exited`) so clients can toast it, plus optionally runs a local
// command (a desktop notification shim) with the job's details in the
// environment. Nothing here may ever throw into the plugin: a notification is a
// convenience, not a reason to break the app.

import { spawn as spawnChild } from 'node:child_process';

const DEFAULT_INTERVAL_MS = 2_000;
// Finished jobs are pruned by the pool eventually; keep the local transition map
// bounded even if the pool is configured to remember thousands.
const MAX_TRACKED = 1_000;

/**
 * The event payload: the pool's job row, trimmed to what a notification renders.
 * Kept in one place so the host event and `/presence/api/state` agree.
 */
export function jobSummary(job) {
  return {
    id: job?.id ?? null,
    host: job?.host ?? null,
    pid: job?.pid ?? null,
    state: typeof job?.state === 'string' ? job.state : 'unknown',
    exitCode: job?.exitCode ?? null,
    signal: job?.exitSignal ?? null,
    label: job?.label ?? null,
    sessionId: job?.sessionId ?? null,
    startedAt: job?.startedAt ?? null,
    logPath: job?.logPath ?? null,
    logSize: job?.logSize ?? null,
    command: job?.command ?? null,
  };
}

/**
 * A command that finished on its own (or was stopped) starts a notification,
 * and so does one that was `unknown` on the previous poll: after a reconnect a
 * finished job must still be reported exactly once.
 */
function isExitTransition(previous, next) {
  return next === 'exited' && previous !== undefined && previous !== 'exited';
}

/**
 * Poll `pool.listJobs()` and publish one event per finished job.
 *
 * @param ctx - plugin context; `ctx.emit` publishes the event and `ctx.effect`
 *   owns the interval so plugin unload stops it.
 * @param pool - the connection pool.
 * @param options.notifyCommand - optional local command run through the shell.
 * @param options.intervalMs - poll interval (tests use a short one).
 * @param options.spawn - injectable spawn (tests); defaults to node:child_process.
 * @param options.onError - log sink for a failed notification step.
 * @returns `{ tick, stats, dispose }`; `tick` forces one poll (used by probes).
 */
export function installJobNotifier(ctx, pool, options = {}) {
  const notifyCommand = typeof options.notifyCommand === 'string' ? options.notifyCommand.trim() : '';
  const requestedInterval = Number(options.intervalMs);
  const intervalMs = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? Math.max(10, requestedInterval)
    : DEFAULT_INTERVAL_MS;
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnChild;
  const onError = typeof options.onError === 'function'
    ? options.onError
    : (message) => {
        try {
          console.error(`presence job notifier: ${message}`);
        } catch {
          /* a broken console must not break the poll */
        }
      };

  /** job id -> last reported state; undefined means "not seen yet, seed it". */
  const states = new Map();
  const stats = { ticks: 0, events: 0, spawns: 0, errors: 0 };
  let disposed = false;
  let inFlight = false;
  let timer = null;

  const report = (message, error) => {
    stats.errors += 1;
    onError(error ? `${message}: ${error?.message ?? String(error)}` : message);
  };

  const publish = (job) => {
    try {
      if (typeof ctx?.emit === 'function') {
        ctx.emit('presence/job-exited', job);
        stats.events += 1;
      }
    } catch (error) {
      report('could not emit presence/job-exited', error);
    }
    if (!notifyCommand) return;
    try {
      const exit = job.exitCode === null || job.exitCode === undefined ? '' : String(job.exitCode);
      const signal = job.exitSignal === null || job.exitSignal === undefined ? '' : String(job.exitSignal);
      const child = spawn(notifyCommand, {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PRESENCE_JOB_ID: String(job.id ?? ''),
          PRESENCE_JOB_HOST: String(job.host ?? ''),
          PRESENCE_JOB_LABEL: String(job.label ?? ''),
          PRESENCE_JOB_EXIT: exit,
          PRESENCE_JOB_SIGNAL: signal,
          PRESENCE_JOB_STATE: String(job.state ?? 'exited'),
        },
      });
      stats.spawns += 1;
      child.on?.('error', (error) => report('notification command failed', error));
      child.unref?.();
    } catch (error) {
      report('could not start the notification command', error);
    }
  };

  /** One poll. Never rejects; a failed listing is simply retried next tick. */
  const tick = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    let jobs;
    try {
      jobs = await pool.listJobs({ sessionId: undefined });
    } catch (error) {
      report('could not list background jobs', error);
      return;
    } finally {
      inFlight = false;
    }
    if (disposed || !Array.isArray(jobs)) return;
    stats.ticks += 1;
    for (const job of jobs) {
      if (!job || typeof job.id !== 'string' || job.id === '') continue;
      const state = typeof job.state === 'string' ? job.state : 'unknown';
      const previous = states.get(job.id);
      states.set(job.id, state);
      // The first sighting only seeds the map: a job that finished while the
      // plugin was loading must not pop a notification for old work.
      if (isExitTransition(previous, state)) publish(jobSummary(job));
    }
    if (states.size > MAX_TRACKED) {
      const ids = [...states.keys()];
      for (const id of ids.slice(0, ids.length - MAX_TRACKED)) states.delete(id);
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = () => {
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    timer.unref?.();
  };

  // Cordis owns the lifecycle: the interval dies with the plugin scope.
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => {
        start();
        return dispose;
      });
    } catch (error) {
      report('could not register the notification interval', error);
      start();
    }
  } else {
    start();
  }

  return {
    tick,
    stats,
    dispose,
    get running() {
      return !disposed;
    },
  };
}
