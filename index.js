// Presence: give a coding agent a stable, local-feeling presence on every
// machine listed in ~/.ssh/config. Nothing is installed on the far side.

import z from '@deepseek-ai/schemastery';
import { PresencePool } from './src/pool.js';
import { definePresenceTools } from './src/tools.js';
import { presenceRoutes } from './src/api.js';
import { activeWorkspace } from './src/workspaces.js';
import { shared } from './src/shared.js';
import { mountsRoot, parseMountPath } from './src/mounts.js';
import { installToolInterceptor } from './src/intercept.js';

/** Cordis plugin name. */
export const name = 'presence';

/** The tools registry and nothing else is required; the panel attaches when a Web host exists. */
export const inject = ['tools'];

/** Configurable from cordis.patch.yml; the user's patch layer survives upgrades. */
export const Config = z.object({
  maxChannels: z
    .natural()
    .default(8)
    .description('Concurrent channels per connection. sshd allows 10 sessions by default; keep headroom for SFTP.'),
  connectTimeoutMs: z.natural().default(25_000).description('How long a connection attempt may take.'),
  idleTimeoutMs: z
    .natural()
    .default(900_000)
    .description('Close an idle connection after this long, unless it still owns a terminal.'),
  readOnly: z.boolean().default(false).description('Refuse writes and edits; reading, searching and exec stay available.'),
});

/**
 * Register the Presence tool surface and, when this profile serves a Web UI,
 * the panel's JSON API.
 * @param ctx - context providing the tool registry and optional web server.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config = {}) {
  const settings = {
    maxChannels: 8,
    connectTimeoutMs: 25_000,
    idleTimeoutMs: 900_000,
    readOnly: false,
    ...config,
  };

  const pool = new PresencePool(settings);
  shared.pool = pool;
  shared.mountsRoot = mountsRoot();
  ctx.effect(() => () => {
    pool.dispose();
    shared.pool = null;
  });

  // Late-bound services. Each is captured by its own inject, so callers never
  // depend on activation order and a one-shot `ctx.get` can't miss them.
  const late = { credentials: undefined, registry: undefined, workingDirectory: undefined, fs: undefined };
  ctx.inject(['workingDirectory'], (scope) => {
    late.workingDirectory = scope.workingDirectory;
    scope.effect(() => () => {
      late.workingDirectory = undefined;
    });
  });

  /** Resolve the session's cwd (the mount path inside a remote workspace). */
  const cwdOf = async (exec) => {
    try {
      if (!exec?.agent || !late.workingDirectory) return null;
      return await late.workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      return null;
    }
  };

  // The harness read-before-edit policy is event-driven: it records a target as
  // "seen" only when a tool dispatches `fs/observed`. presence_read/write/edit
  // are not the built-in fs tools, so they publish the observation themselves —
  // otherwise an agent that read a file with presence_read still hits
  // "file has not been read" when it tries the built-in edit.
  const observe = async (exec, path) => {
    try {
      const fs = late.fs;
      if (!fs || !exec?.agent || typeof path !== 'string' || path === '') return;
      const cwd = await cwdOf(exec);
      const target = await fs.resolve(path, cwd ? { cwd } : undefined);
      const stat = await fs.stat(target);
      const observation = stat ? { kind: 'present', version: stat.version } : { kind: 'absent' };
      ctx.emit('fs/observed', target, observation, { agent: exec.agent });
    } catch {
      /* the observation is an optimization, never a failure */
    }
  };

  ctx.inject(['fs'], (scope) => {
    late.fs = scope.fs;
    scope.effect(() => () => {
      late.fs = undefined;
    });
  });

  for (const definition of definePresenceTools(pool, settings, { cwdOf, observe })) {
    ctx.tools.register(definition);
  }

  // In a remote workspace the built-in grep/glob would scan the host disk:
  // answer those calls against the remote machine instead.
  installToolInterceptor(ctx, { pool, cwdOf });

  ctx.inject(['credentials'], (scope) => {
    late.credentials = scope.credentials;
    scope.effect(() => () => {
      late.credentials = undefined;
    });
  });
  ctx.inject(['workspaceRegistry'], (scope) => {
    late.registry = scope.workspaceRegistry;
    scope.effect(() => () => {
      late.registry = undefined;
    });
  });

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = presenceRoutes(pool, late).map((route) => scope.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  });

  // Tell the model what is reachable without spending tokens on every alias.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() =>
      scope.systemPrompt.context({
        name: 'presence:remote-machines',
        order: 500,
        text: () => {
          const hosts = pool.hosts();
          if (hosts.length === 0) return '';
          const connected = hosts.filter((host) => host.connected).map((host) => host.alias);
          const live = connected.length > 0 ? `connected now: ${connected.join(', ')}` : 'none connected yet';
          return (
            `Presence: ${hosts.length} remote machines from ~/.ssh/config (${live}). ` +
            'If your working directory is under the presence mounts root, this session runs against that remote machine: ' +
            'read/write/edit, the file tree, and grep/glob all reach it (grep/glob are routed to the remote machine automatically). ' +
            'TO CHANGE A REMOTE FILE use the built-in `edit`/`write` tools or presence_edit/presence_write — never `sed -i`, ' +
            '`perl -pi`, or shell redirects, which bypass the atomic write, the ambiguity check and the version guard. ' +
            'Prefer presence_search (countOnly/truncation aware) and presence_glob (with size/mtime) for structured searches, ' +
            'presence_exec for commands, and presence_forward to reach a remote port. ' +
            'To get a LOCAL file (screenshot, attachment under ~/.dsh/attachments, build artifact) onto the remote machine, use presence_import — it is the local→remote direction, binary-safe, and returns the sha256; presence_export is the reverse. ' +
            'read_image works directly on remote images (mount path or presence:// URL) as long as the model accepts image input. ' +
            'Built-in read/write/edit and presence_read/write/edit both reach the remote workspace and share the read-before-edit guard; prefer the built-in tools inside the workspace and presence_* outside it. ' +
            'For long work start it with presence_exec {background:true}, then use presence_jobs {action:"wait"} instead of sleep+poll, ' +
            'and presence_jobs {action:"list"|"stop"} to manage this session\'s jobs. ' +
            'The mount path is virtual: Explorer, Office, Python and native open cannot see remote files — call presence_export first, then present the returned local path. ' +
            'Paths may be given relative to the workspace root, as a presence:// URL, or as the local mount path.'
          );
        },
      }),
    );
  });
}
