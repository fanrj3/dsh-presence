// Keep the built-in grep/glob honest inside a remote workspace.
//
// Those tools always spawn the host's ripgrep against the host disk, so in a
// remote workspace `grep` errors (the mount path does not exist locally) and
// `glob` silently returns nothing. The `tools/execute` waterfall lets us answer
// the call ourselves with the tool's own canonical value shape, so the built-in
// renderer and search card keep working.

import { parseMountPath, parsePresenceUrl, resolveRemoteInput } from './mounts.js';
import { remoteGlobDetailed, remoteGrep, splitGlobPattern } from './remote-search.js';
import { canonicalObservation, lookupObservation, recordObservation } from './observed-store.js';

const LIMIT = 200;

/**
 * A `presence:`-shaped string that does not name a known host is a hard error.
 * Without this, `presence://srv/workspace/x` is read as a relative path and the
 * built-in tool searches a literal `presence:` directory instead.
 */
function invalidPresencePath(value, pool) {
  let aliases = [];
  try {
    aliases = pool.hosts().map((entry) => entry.alias);
  } catch {
    aliases = [];
  }
  return new Error(
    `"${value}" is not a valid presence path (expected presence://<host>/<absolute path>; ` +
      `known hosts: ${aliases.length > 0 ? aliases.join(', ') : 'none'})`,
  );
}

/**
 * Backslashes separate segments in a relative remote spelling; they are never
 * part of a segment name. POSIX absolute paths may legally contain one, and a
 * Windows drive/UNC path is local and must be left for the local tool.
 */
function normalizeRelativeInput(value) {
  const textValue = String(value ?? '');
  if (!textValue) return textValue;
  if (textValue.startsWith('/') || /^[A-Za-z]:[\\/]/.test(textValue) || textValue.startsWith('\\\\')) return textValue;
  return textValue.replace(/\\/g, '/');
}

/**
 * Install the interceptor. Inactive for every non-remote session.
 * @param ctx - plugin context (event owner).
 * @param options.pool - the connection pool.
 * @param options.cwdOf - async (exec) => session cwd or null.
 */
export function installToolInterceptor(ctx, { pool, cwdOf }) {
  const resolveInput = (cwd, value) => {
    const raw = String(value ?? '');
    if (/^presence:/i.test(raw)) {
      // parsePresenceUrl is the authority here: resolveRemoteInput would treat
      // an unparsable `presence:` string as a relative path.
      const viaUrl = parsePresenceUrl(raw.replace(/^presence:/i, 'presence:'));
      if (!viaUrl) throw invalidPresencePath(raw, pool);
      return viaUrl;
    }
    return resolveRemoteInput(cwd, normalizeRelativeInput(raw));
  };
  const errorResult = (message) => ({
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  });

  ctx.on('tools/execute', async (exec, next) => {
    const name = exec?.name;
    if (name !== 'grep' && name !== 'glob') return next();

    let cwd = null;
    try {
      cwd = await cwdOf(exec);
    } catch {
      cwd = null;
    }
    const mounted = cwd ? parseMountPath(cwd) : null;
    if (!mounted) return next();

    const args = exec.arguments ?? {};
    const rawPattern = String(args.pattern ?? '');
    // An absolute glob (`/srv/app/*.py`) carries its own root, so it works even
    // when the caller passed no `path`. The regex of `grep` is never split: a
    // leading `/` there is part of the pattern.
    const absoluteGlob = name === 'glob' ? splitGlobPattern(rawPattern) : null;
    const requested = args.path ?? args.directory ?? args.cwd;
    let scope;
    try {
      scope = absoluteGlob
        ? resolveInput(cwd, absoluteGlob.root)
        : requested
          ? resolveInput(cwd, requested)
          : { host: mounted.host, path: mounted.path };
    } catch (error) {
      return errorResult(error?.message ?? String(error));
    }
    if (!scope) return next();

    try {
      const connection = await pool.connection(scope.host);
      const info = await connection.stat(scope.path);
      if (!info.exists) {
        const message = `${scope.path} does not exist on ${scope.host}`;
        return errorResult(message);
      }

      if (name === 'glob') {
        const pattern = absoluteGlob ? absoluteGlob.pattern : rawPattern || '*';
        // `truncated` cannot travel in the fixed `{root, paths}` schema; the
        // built-in renderer still shows the capped list, and presence_glob
        // reports the true totals.
        const detailed = await remoteGlobDetailed(connection, { root: scope.path, pattern, limit: LIMIT });
        const prefix = scope.path.replace(/\/+$/, '');
        return { value: { root: scope.path, paths: detailed.files.map((file) => `${prefix}/${file}`) } };
      }

      // Ask for one extra match so the cap is known to us; the canonical
      // `{matches}` schema has no truncation field, so exactly LIMIT is exposed.
      const { matches } = await remoteGrep(connection, {
        root: scope.path,
        pattern: rawPattern,
        include: args.include,
        limit: LIMIT + 1,
        // Same semantics as presence_search: smart case everywhere.
        smartCase: true,
      });
      return { value: { matches: matches.slice(0, LIMIT) } };
    } catch (error) {
      return errorResult(error?.message ?? String(error));
    }
  });
}

/**
 * Bridge between the Presence file tools and the harness read-before-edit
 * policy (plugin `fs-observation-policy`).
 *
 * The policy records an authoritative observation only when a tool emits
 * `fs/observed` with a resolved target and the returned version. Its state is a
 * WeakMap keyed by the live Session object inside that plugin — it is not a
 * service, so it cannot be read or written directly from here. What IS possible
 * (and what this bridge does) is to publish the same event the built-in tools
 * publish:
 *  - after `presence_read`/`presence_write`/`presence_edit` succeed (through the
 *    `observe` callback the tools call), so a later built-in `edit` on the same
 *    remote file passes;
 *  - after a built-in `read`/`read_image`, so the persisted record survives
 *    compaction (the guard's own WeakMap does not);
 *  - just before a built-in `edit`/`write`, re-publishing the recorded version
 *    when the file is still at exactly that version. A changed file is never
 *    auto-approved.
 *
 * `exec cat` (or any command that happens to read a file) is deliberately NOT
 * turned into an observation: a shell command carries neither a target identity
 * nor a version, and fabricating one would defeat the guard.
 *
 * @param ctx - plugin context (event owner).
 * @param options.cwdOf - async (exec) => session cwd or null.
 * @param options.late - late-bound services (`fs`).
 * @returns `{ observe, resolveObservation }`; `observe` is the callback
 *   `definePresenceTools` expects, `resolveObservation` is useful for probes.
 */
export function installObservationBridge(ctx, { cwdOf, late }) {
  const sessionIdOf = (exec) => exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? null;

  const explicitHostOf = (exec) => {
    const host = exec?.arguments?.host;
    return typeof host === 'string' && host.trim() ? host.trim() : null;
  };

  /**
   * Resolve a tool path spelling to `{ target, canonical }`. A remote spelling
   * becomes the canonical `presence://host/path` target directly (so a local
   * session that passed `host` explicitly still records the right identity);
   * a genuinely local path falls back to the provider's own target, keeping the
   * pre-0.20 local repair behavior.
   */
  const resolveObservation = async (exec, path) => {
    if (typeof path !== 'string' || path === '') return null;
    let cwd = null;
    try {
      cwd = (await cwdOf(exec)) ?? null;
    } catch {
      cwd = null;
    }
    const explicitHost = explicitHostOf(exec);
    const canonical = canonicalObservation(path, { cwd, host: explicitHost });
    if (canonical) {
      // The presence provider's identity IS the presence URL; the policy only
      // reads `targetKey`, and every other `fs/observed` listener can stat this
      // target through the same provider.
      return { target: { targetKey: canonical.key, displayPath: canonical.key }, canonical };
    }
    // A relative spelling cannot be mapped when the call named a different host
    // than the mounted workspace: resolving it through the provider would record
    // the mounted machine's file, which is NOT the file the tool touched. Never
    // fabricate a target that belongs to another machine.
    if (explicitHost && cwd && parseMountPath(cwd)) return null;
    const fs = late?.fs;
    if (!fs || typeof fs.resolve !== 'function') return null;
    try {
      const target = await fs.resolve(path, cwd ? { cwd } : undefined);
      if (!target) return null;
      return { target, canonical: canonicalObservation(target, { cwd }) };
    } catch {
      return null;
    }
  };

  /** Record that this session saw the file at its current version. */
  const observe = async (exec, path, options = {}) => {
    try {
      const resolved = await resolveObservation(exec, path);
      if (!resolved) return;
      const fs = late?.fs;
      const stat = fs && typeof fs.stat === 'function' ? await fs.stat(resolved.target) : null;
      const observation = stat ? { kind: 'present', version: stat.version } : { kind: 'absent' };
      // The built-in read/write tools already publish their own event; a second
      // one would only churn `changes` listeners. Presence tools have no other
      // publisher, so they always publish here.
      if (options.publish !== false) ctx.emit('fs/observed', resolved.target, observation, { agent: exec?.agent });
      if (stat && options.remember !== false) {
        recordObservation(
          sessionIdOf(exec),
          resolved.canonical ?? String(resolved.target.targetKey ?? ''),
          stat.version,
          { cwd: null },
        );
      }
    } catch {
      /* the observation is an optimization, never a failure */
    }
  };

  /** Re-publish a recorded observation if the file is still at that version. */
  const repair = async (exec, path) => {
    const sessionId = sessionIdOf(exec);
    if (!sessionId) return null;
    const resolved = await resolveObservation(exec, path);
    if (!resolved) return null;
    const targetKey = resolved.canonical?.key ?? String(resolved.target.targetKey ?? '');
    const recorded = lookupObservation(sessionId, resolved.canonical ?? targetKey);
    if (!recorded) return null;
    const fs = late?.fs;
    const stat = fs && typeof fs.stat === 'function' ? await fs.stat(resolved.target) : null;
    if (!stat || stat.version !== recorded) return null;
    ctx.emit('fs/observed', resolved.target, { kind: 'present', version: stat.version }, { agent: exec.agent });
    return stat.version;
  };

  // Built-in read/read_image: remember what the session has seen, so the record
  // survives compaction even though the guard's WeakMap does not.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (!result?.isError && (exec?.name === 'read' || exec?.name === 'read_image')) {
        await observe(exec, exec.arguments?.file_path, { publish: false });
      }
    } catch {
      /* best effort */
    }
    return next();
  });

  // Built-in edit/write on a remote target: if this session read the file at
  // the same version we recorded, re-publish the observation so the guard
  // passes. A changed file is left alone: the guard's refusal is the point.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec?.name === 'edit' || exec?.name === 'write') {
        const path = exec.arguments?.file_path;
        if (typeof path === 'string' && path !== '') await repair(exec, path);
      }
    } catch {
      /* best effort: a failed repair leaves the original guard behavior */
    }
    return next();
  });

  return { observe, resolveObservation };
}

