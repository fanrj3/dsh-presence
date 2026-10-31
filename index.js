// Presence: give a coding agent a stable, local-feeling presence on every
// machine listed in ~/.ssh/config. Nothing is installed on the far side.

import z from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { PresencePool } from './src/pool.js';
import { JobStore } from './src/job-store.js';
import { definePresenceTools } from './src/tools.js';
import { presenceRoutes } from './src/api.js';
import { shared } from './src/shared.js';
import { mountsRoot, parseMountPath } from './src/mounts.js';
import { installObservationBridge, installToolInterceptor } from './src/intercept.js';
import { TunnelStore } from './src/tunnel-store.js';
import { PortDiscovery } from './src/port-discovery.js';
import { installJobNotifier } from './src/job-notifier.js';
import { installRemoteFileReferences } from './src/file-references.js';
import { createWaitRegistry } from './src/waits.js';

/** Bundle version, shown in the runtime context so agents notice capability changes. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

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
  notifyCommand: z
    .string()
    .default('')
    .description('Optional local command run when a background job finishes. PRESENCE_JOB_ID/HOST/LABEL/EXIT are in its environment.'),
  portDiscovery: z
    .boolean()
    .default(true)
    .description('Scan connected machines for listening ports so the Ports panel can offer one-click forwards.'),
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
    notifyCommand: '',
    portDiscovery: true,
    ...config,
  };

  // The job registry outlives the process: detached jobs are still on the
  // machine after a restart, and the store is what makes them visible again
  // (as `unknown` until a pid probe proves otherwise).
  const jobStore = new JobStore();
  const pool = new PresencePool(settings, { jobStore });
  shared.pool = pool;
  shared.mountsRoot = mountsRoot();
  // D1/D2: saved forwards and the listening-port scanner share one lifecycle
  // with the pool; both are handed to the Web API through `late`.
  const tunnelStore = new TunnelStore();
  const portDiscovery = new PortDiscovery(pool, { enabled: settings.portDiscovery !== false });
  // 0.21 wait dock: in-memory registry shared by the wait tools (writers) and
  // `GET /presence/api/waits` (reader). It is not persisted: a wait cannot
  // survive the process that is blocking on it.
  const waits = createWaitRegistry();
  ctx.effect(() => () => {
    portDiscovery.clear();
    waits.dispose();
    pool.dispose();
    shared.pool = null;
  });

  // Late-bound services. Each is captured by its own inject, so callers never
  // depend on activation order and a one-shot `ctx.get` can't miss them.
  const late = {
    credentials: undefined,
    registry: undefined,
    workingDirectory: undefined,
    fs: undefined,
    agents: undefined,
    // D1/D2 owners, constructed above with the pool.
    tunnelStore,
    portDiscovery,
    jobStore,
    // 0.21 wait dock registry, read by GET /presence/api/waits.
    waits,
  };
  ctx.inject(['agents'], (scope) => {
    late.agents = scope.agents;
    scope.effect(() => () => {
      late.agents = undefined;
    });
  });
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
  // otherwise an agent that read a file with presence_read still hits "file has
  // not been read" when it tries the built-in edit.
  //
  // The bridge (src/intercept.js) canonicalizes every path spelling to
  // `presence://host/path`, persists (session, canonical target) -> version and,
  // just before a built-in edit/write, re-publishes the observation when the
  // file is still at that exact version. That repairs the guard after
  // compaction, when its own WeakMap is gone; a changed file is never
  // auto-approved.
  ctx.inject(['fs'], (scope) => {
    late.fs = scope.fs;
    scope.effect(() => () => {
      late.fs = undefined;
    });
  });
  const { observe } = installObservationBridge(ctx, { cwdOf, late });

  for (const definition of definePresenceTools(pool, settings, { cwdOf, observe, waits })) {
    ctx.tools.register(definition);
  }

  // In a remote workspace the built-in grep/glob would scan the host disk:
  // answer those calls against the remote machine instead.
  installToolInterceptor(ctx, { pool, cwdOf });

  // D1: bring saved auto-restore forwards back when a machine reconnects. The
  // hook is fire-and-forget and dedupes against the live tunnel list, so a
  // preset restored by hand (or opened moments earlier) is not opened twice.
  const restoring = new Set();
  const restorePresets = async (host) => {
    if (restoring.has(host)) return;
    restoring.add(host);
    try {
      const presets = tunnelStore.list().filter((preset) => preset.autoRestore && preset.host === host);
      if (presets.length === 0) return;
      const open = new Set(
        pool
          .listTunnels()
          .filter((tunnel) => tunnel.host === host)
          .map((tunnel) => `${tunnel.remoteHost}:${tunnel.remotePort}`),
      );
      for (const preset of presets) {
        const target = `${preset.remoteHost}:${preset.remotePort}`;
        if (open.has(target)) continue;
        open.add(target);
        try {
          const tunnel = await pool.openForward(host, {
            localPort: preset.localPort ?? undefined,
            remoteHost: preset.remoteHost,
            remotePort: preset.remotePort,
          });
          portDiscovery.rememberForwarded(host, tunnel);
        } catch (error) {
          console.error(
            `presence: could not restore the port forward ${target} on ${host}: ${error?.message ?? String(error)}`,
          );
        }
      }
    } catch (error) {
      console.error(`presence: could not restore port forwards on ${host}: ${error?.message ?? String(error)}`);
    } finally {
      restoring.delete(host);
    }
  };
  const disposeConnectionHook = pool.onConnectionEstablished((host) => {
    restorePresets(host).catch(() => {});
  });
  ctx.effect(() => () => disposeConnectionHook());

  // C2: tell clients about finished background jobs; optionally run a local
  // notification command. The interval is disposed with the plugin scope.
  installJobNotifier(ctx, pool, { notifyCommand: settings.notifyCommand });

  // B1: answer remote `@` completion from the machine, not the empty mount dir.
  installRemoteFileReferences(ctx, { pool, mountsRoot: shared.mountsRoot, late });

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

  // ---------------------------------------------------------------- prompts
  //
  // The static context is deployment-wide and token-cheap. 0.20 makes the
  // session-scope sentence explicit: a LOCAL session and a session inside a
  // remote workspace need opposite rules, and the 0.19 wording ("if your
  // working directory is under the mounts root...") let a local session assume
  // it was remote.
  const STATIC_GUIDANCE =
    '- Which tool: inside the workspace mount use the built-in read/write/edit/grep/glob (grep/glob are routed to the remote machine); absolute paths outside it (/data, GPFS, /scratch) need presence_read/write/edit/stat/search/glob, and listing or running commands there needs presence_exec (e.g. presence_exec {command:"ls -la /data"}); present and Office only see local files, so presence_export first.\n' +
    '- Long jobs: presence_exec {background:true} then presence_jobs {action:"status"|"wait"}, with presence_tail to follow the log. Interactive shells: presence_terminal (tmux sessions survive reconnects). Do not start nohup/tmux new-session/& inside a foreground presence_exec for long work — a login-node session can be cleaned up; background:true already detaches with setsid, and on scheduler-managed clusters use the cluster launcher (rlaunch -d, salloc/sbatch).\n' +
    '- Output: \\r progress bars are normalized by default (progress:"all"/"strip" available); output over the cap is spilled to a remote file whose path is returned — presence_tail it.\n' +
    '- Destructive commands: dry-run first; confirm:true runs the whole command, confirm:"partial" runs only the safe segments; prefer presence_trash.\n' +
    '- Hosts: transient failures are retried, then a host may show degraded with the last error; presence_hosts marks the current workspace machine.';

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
            `Presence ${VERSION ?? ''}${VERSION ? ':' : ''} ${hosts.length} remote machines from ~/.ssh/config (${live}). ` +
            'Session scope — decide this first; the two cases need opposite behaviour. ' +
            '(a) If your working directory is under the presence mounts root (`~/.dsh/presence/mounts/<host>/<path>`), ' +
            'this session RUNS IN that remote workspace: built-in read/write/edit, the file tree, and grep/glob all reach it ' +
            '(grep/glob are routed to the remote machine automatically). ' +
            '(b) If your working directory is NOT under that root, this session is LOCAL: built-in tools touch only local files, ' +
            'so every presence_* call must pass `host` explicitly (or have PRESENCE_HOST configured once), and remote output is ' +
            'never your workspace. ' +
            'TO CHANGE A REMOTE FILE use the built-in `edit`/`write` tools or presence_edit/presence_write — never `sed -i`, ' +
            '`perl -pi`, or shell redirects, which bypass the atomic write, the ambiguity check and the version guard. ' +
            'DESTRUCTIVE shell commands (rm -r/-f, git clean -fdx, find -delete, shred, dd of=) are dry-run first and need confirm:true; ' +
            'prefer presence_trash {action:"trash"} for a recoverable delete inside a workspace. ' +
            'Prefer presence_search (countOnly/truncation aware) and presence_glob (with size/mtime) for structured searches, ' +
            'presence_exec for commands, and presence_forward to reach a remote port. ' +
            'To get a LOCAL file (screenshot, attachment under ~/.dsh/attachments, build artifact) onto the remote machine, use presence_import — it is the local→remote direction, binary-safe, and returns the sha256; presence_export is the reverse. ' +
            'read_image works directly on remote images (mount path or presence:// URL) as long as the model accepts image input. ' +
            'Built-in read/write/edit and presence_read/write/edit both reach the remote workspace and share the read-before-edit guard; ' +
            'that guard is repaired automatically after compaction, so a file you already read stays editable. Prefer the built-in tools inside the workspace and presence_* outside it. ' +
            'For long work start it with presence_exec {background:true}, then use presence_jobs {action:"wait"} or presence_wait instead of sleep+poll, ' +
            'and presence_jobs {action:"list"|"stop"} to manage this session\'s jobs. ' +
            'The mount path is virtual: Explorer, Office, Python and native open cannot see remote files — call presence_export first, then present the returned local path. ' +
            'Paths may be given relative to the workspace root, as a presence:// URL, or as the local mount path.' +
            `\n\nGuidance:\n${STATIC_GUIDANCE}` +
            '\n\nSession scope rules:\n' +
            '- Local session: the globally last-opened remote workspace is not bound to this session; pass host explicitly on every presence_* call, and treat presence_exec output as remote data — not as files in your working directory.\n' +
            '- Remote-workspace session: prefer the built-in read/write/edit/grep/glob inside the mounted workspace; use presence_read/write/edit/stat/search/glob for absolute paths elsewhere (presence_exec for listing/commands), and pass host explicitly for any machine other than the mount host.\n' +
            '- presence_hosts marks the machine this session is mounted on (if any) and the explicit default host; check it before assuming a machine.'
          );
        },
      }),
    );
  });

  // Per-agent session scope. No static text can know where *this* agent runs, so
  // resolve the agent's working directory once when it is created and register a
  // scoped system-prompt section (the pattern `dsh-file-reference-local` uses:
  // `agent.ctx.inject([...])` + `scope.systemPrompt.section(...)`), disposed with
  // the agent. The section text is a function so a `cd` into/out of a mounted
  // workspace updates it; the resolved cwd is only the fallback.
  const sessionScopeFibers = new Map();
  const sessionScopeText = (cwd) => {
    if (!cwd) return '';
    const mounted = parseMountPath(cwd);
    if (mounted) {
      return (
        `This session runs in the remote workspace ${mounted.host}:${mounted.path}; ` +
        'built-in read/write/edit, the file tree and grep/glob reach it. ' +
        `presence_* calls may omit host for ${mounted.host} only — pass host explicitly for any other machine — ` +
        'and remote output is not your local workspace.'
      );
    }
    return (
      `This session is LOCAL (cwd=${JSON.stringify(cwd)}). Presence tools are optional: ` +
      'pass host explicitly on every presence_* call (or configure PRESENCE_HOST once), and never treat remote output ' +
      'as the workspace or as a local path.'
    );
  };
  const installSessionScope = (agent) => {
    if (!agent?.ctx || sessionScopeFibers.has(agent)) return sessionScopeFibers.get(agent) ?? null;
    let fiber = null;
    try {
      fiber = agent.ctx.inject(['systemPrompt', 'workingDirectory'], async (scope) => {
        let cwd = null;
        try {
          cwd = (await scope.workingDirectory.ensure(agent)) ?? null;
        } catch {
          cwd = null;
        }
        scope.systemPrompt.section({
          name: 'presence:session-scope',
          order: 450,
          text: () => {
            let current = cwd;
            try {
              current = scope.workingDirectory?.get?.(agent.session) ?? cwd;
            } catch {
              current = cwd;
            }
            return sessionScopeText(current);
          },
        });
      });
      sessionScopeFibers.set(agent, fiber);
    } catch (error) {
      console.error(`presence: could not install the per-agent session scope: ${error?.message ?? String(error)}`);
      return null;
    }
    return fiber;
  };
  const disposeSessionScope = (agent) => {
    const fiber = sessionScopeFibers.get(agent);
    if (!fiber) return;
    sessionScopeFibers.delete(agent);
    try {
      Promise.resolve(fiber.dispose()).catch(() => {});
    } catch {
      /* already gone */
    }
  };
  ctx.on('agent/created', (payload) => {
    installSessionScope(payload?.agent ?? payload);
  });
  ctx.on('agent/disposed', (payload) => {
    disposeSessionScope(payload?.agent ?? payload);
  });
  // Agents that already exist when Presence activates need the section too; a
  // missing `agents` service just means there is nothing to install yet.
  ctx.inject(['agents'], (scope) => {
    try {
      for (const agent of scope.agents.list()) installSessionScope(agent);
    } catch {
      /* best effort: the static context still covers the session scope */
    }
  });
  ctx.effect(() => () => {
    const disposals = [];
    for (const [agent, fiber] of [...sessionScopeFibers]) {
      sessionScopeFibers.delete(agent);
      try {
        disposals.push(Promise.resolve(fiber.dispose()));
      } catch {
        /* already gone */
      }
    }
    return Promise.allSettled(disposals).then(() => {});
  });
}
