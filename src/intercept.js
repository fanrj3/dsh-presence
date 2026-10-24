// Keep the built-in grep/glob honest inside a remote workspace.
//
// Those tools always spawn the host's ripgrep against the host disk, so in a
// remote workspace `grep` errors (the mount path does not exist locally) and
// `glob` silently returns nothing. The `tools/execute` waterfall lets us answer
// the call ourselves with the tool's own canonical value shape, so the built-in
// renderer and search card keep working.

import { parseMountPath, parsePresenceUrl, resolveRemoteInput } from './mounts.js';
import { remoteGlobDetailed, remoteGrep, splitGlobPattern } from './remote-search.js';

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
