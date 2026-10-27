// Remote `@` file-reference completion (B1).
//
// The harness's local file-reference service walks the host filesystem and
// indexes the workspace it is given. In a remote workspace that workspace is a
// presence mount: an empty local stand-in directory, so `@` completion shows
// nothing. This module wraps `ctx.fileReferences.list(agent, query, signal)`:
// when the agent's working directory is under the mounts root, the answer comes
// from the remote machine instead (one `rg --files` scan per workspace, cached,
// with `find` as the fallback); every other session keeps the original service.
//
// The candidate shape and the query grammar are copied from DSH's
// @deepseek-ai/dsh-file-reference-local implementation, because the host RPC
// adapter (`sessionFileReferences`) forwards this list verbatim to the editor:
//   [{ path: string, kind: 'file' | 'directory' }]
//
// Frozen contract: .scratch/feat-0.18/CONTRACTS.md section 7.

import { parseMountPath } from './mounts.js';

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_ENTRIES = 50_000;
const INDEX_TTL_MS = 10_000;
const DIRECTORY_TTL_MS = 2_000;
const INDEX_TIMEOUT_MS = 30_000;
const MAX_INDEX_CACHE = 16;
const MAX_DIRECTORY_CACHE = 128;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;

// Same default set as DSH's local service: version-control and dependency
// stores plus build output. `lib` stays: many packages keep sources there.
export const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('file reference search aborted');
}

/** POSIX single-quote for the remote shell. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The editor grammar normalizes Windows separators; match the local service. */
export function normalizeQuery(rawQuery) {
  return String(rawQuery ?? '').replaceAll('\\', '/');
}

/** A global (bare) query hides dot-paths unless the user typed a dot. */
export function visibleForGlobalQuery(path, query) {
  if (query.startsWith('.') || query.includes('/.')) return true;
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

/** Match score: exact name, prefix, substring, path substring, then subsequence. */
export function scoreCandidate(candidate, query) {
  if (query === '') return 0;
  const path = candidate.path.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const needle = query.toLowerCase();
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0;
  if (name === needle) return 1000 + directoryBonus;
  if (name.startsWith(needle)) return 900 + directoryBonus;
  if (name.includes(needle)) return 700 + directoryBonus;
  if (path.includes(needle)) return 500 + directoryBonus;
  const subsequence = subsequenceScore(path, needle);
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus;
}

function subsequenceScore(target, query) {
  let targetIndex = 0;
  let gap = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found < 0) return undefined;
    gap += found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(0, 100 - gap);
}

function kindRank(kind) {
  return kind === 'directory' ? 0 : 1;
}

/** Deterministic ranked slice, identical ordering to the local service. */
export function rankCandidates(candidates, query, limit) {
  const ranked = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score !== undefined) ranked.push({ candidate, score });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
      (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length) ||
      compareText(left.candidate.path, right.candidate.path),
  );
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

/** One directory-listing line, minus the `./` prefix `find` prints. */
function splitListingLine(line) {
  const text = line.replace(/^\uFEFF/u, '').replace(/^\.\//u, '').replace(/\r$/u, '');
  return text === '.' || text === '' ? null : text;
}

function parseListing(text) {
  const paths = [];
  for (const line of String(text ?? '').split('\n')) {
    const path = splitListingLine(line);
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Build the bounded index from a flat file listing. Directories are derived
 * from the file paths (the remote scan lists files only), which is exactly what
 * a user typing `@src` needs and costs no extra round trip.
 */
export function buildIndex(paths, { maxEntries = DEFAULT_MAX_ENTRIES, excludedDirectories = DEFAULT_EXCLUDED_DIRECTORIES } = {}) {
  const excluded = new Set(excludedDirectories);
  const unique = [...new Set((Array.isArray(paths) ? paths : []).map((path) => String(path ?? '').replace(/^\.\//u, '')).filter((path) => path !== '' && path !== '.'))];
  unique.sort(compareText);
  const directories = new Set();
  const files = [];
  for (const path of unique) {
    if (files.length >= maxEntries) break;
    const segments = path.split('/');
    if (segments.some((segment) => excluded.has(segment))) continue;
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
    files.push(path);
  }
  const entries = [];
  for (const directory of [...directories].sort(compareText)) {
    if (entries.length >= maxEntries) return entries;
    entries.push({ path: directory, kind: 'directory' });
  }
  for (const file of files) {
    if (entries.length >= maxEntries) break;
    entries.push({ path: file, kind: 'file' });
  }
  return entries;
}

/** Resolve a display-relative directory under the workspace root, or null. */
function resolveRemoteDirectory(root, displayDirectory) {
  const base = String(root ?? '').split('/').filter(Boolean);
  for (const segment of String(displayDirectory ?? '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return `/${base.join('/')}`;
}

/** One `rg --files` (or `find`) listing of a remote workspace. */
function indexCommand(root, excludedDirectories) {
  const rootArg = shellQuote(root);
  const excludes = excludedDirectories.map((name) => `-g ${shellQuote(`!**/${name}/**`)}`).join(' ');
  const prune = excludedDirectories.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  const find = `find . \\( ${prune} \\) -prune -o -type f -print | sed 's|^\\./||'`;
  return `cd ${rootArg} 2>/dev/null && if command -v rg >/dev/null 2>&1; then rg --files --hidden --no-ignore ${excludes}; else ${find}; fi`;
}

/**
 * The remote listing cache + query logic. One instance per plugin scope; keyed
 * by (host, remote workspace root) so two sessions in one workspace share it.
 */
class RemoteFileLister {
  #pool;
  #maxResults;
  #maxEntries;
  #excludedDirectories;
  #indexes = new Map();
  #directories = new Map();
  #lastErrorLog = new Map();

  constructor(pool, config = {}) {
    this.#pool = pool;
    this.#maxResults = Number.isSafeInteger(Number(config.maxResults)) && Number(config.maxResults) > 0
      ? Number(config.maxResults)
      : DEFAULT_MAX_RESULTS;
    this.#maxEntries = Number.isSafeInteger(Number(config.maxEntries)) && Number(config.maxEntries) > 0
      ? Number(config.maxEntries)
      : DEFAULT_MAX_ENTRIES;
    this.#excludedDirectories = Array.isArray(config.excludedDirectories) && config.excludedDirectories.length > 0
      ? config.excludedDirectories.filter((name) => typeof name === 'string' && name.length > 0)
      : [...DEFAULT_EXCLUDED_DIRECTORIES];
  }

  #logError(host, error) {
    const last = this.#lastErrorLog.get(host) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.#lastErrorLog.set(host, Date.now());
    try {
      console.error(`presence file references: could not list ${host}: ${error?.message ?? String(error)}`);
    } catch {
      /* logging is best effort */
    }
  }

  /** Full listing text, following the spill file when the exec cap truncated it. */
  async #listingText(connection, result) {
    let text = typeof result?.stdout === 'string' ? result.stdout : '';
    if (result?.stdoutTruncated && typeof result.stdoutFile === 'string' && result.stdoutFile !== '') {
      try {
        const full = await connection.readText(result.stdoutFile, { length: MAX_LISTING_BYTES });
        if (typeof full?.content === 'string' && full.content.length > text.length) text = full.content;
      } catch {
        /* the partial stdout still yields candidates */
      }
    }
    return text;
  }

  async #ensureIndex(host, root, signal) {
    const key = `${host}\0${root}`;
    const cached = this.#indexes.get(key);
    const now = Date.now();
    if (cached?.entries && now - cached.at < INDEX_TTL_MS) return cached.entries;
    if (cached?.promise) return cached.promise;
    const promise = (async () => {
      const connection = await this.#pool.connection(host);
      const command = indexCommand(root, this.#excludedDirectories);
      const result = await connection.exec(command, {
        timeoutMs: INDEX_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
        signal,
      });
      throwIfAborted(signal);
      const text = await this.#listingText(connection, result);
      throwIfAborted(signal);
      return buildIndex(parseListing(text), { maxEntries: this.#maxEntries, excludedDirectories: this.#excludedDirectories });
    })();
    this.#indexes.delete(key);
    this.#indexes.set(key, { at: now, entries: null, promise });
    if (this.#indexes.size > MAX_INDEX_CACHE) {
      const oldest = this.#indexes.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.#indexes.delete(oldest);
    }
    try {
      const entries = await promise;
      this.#indexes.set(key, { at: Date.now(), entries, promise: null });
      return entries;
    } catch (error) {
      this.#indexes.delete(key);
      throw error;
    }
  }

  /** Live directory listing for the "typed a slash" part of the grammar. */
  async #listRemoteDirectory(host, directory, signal) {
    const key = `${host}\0${directory}`;
    const cached = this.#directories.get(key);
    if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.entries;
    const connection = await this.#pool.connection(host);
    throwIfAborted(signal);
    const entries = await connection.list(directory);
    throwIfAborted(signal);
    this.#directories.set(key, { at: Date.now(), entries });
    if (this.#directories.size > MAX_DIRECTORY_CACHE) {
      const oldest = this.#directories.keys().next().value;
      if (oldest !== undefined) this.#directories.delete(oldest);
    }
    return entries;
  }

  async #candidatesForDirectory(host, root, displayDirectory, fragment, signal) {
    if (String(displayDirectory).startsWith('/')) return [];
    if (displayDirectory.split('/').some((segment) => this.#excludedDirectories.includes(segment))) return [];
    const directory = resolveRemoteDirectory(root, displayDirectory);
    if (directory === null) return [];
    let entries;
    try {
      entries = await this.#listRemoteDirectory(host, directory, signal);
    } catch (error) {
      throwIfAborted(signal);
      this.#logError(host, error);
      return [];
    }
    const candidates = [];
    for (const entry of entries) {
      const name = String(entry?.name ?? '');
      if (name === '') continue;
      if (name.startsWith('.') && !fragment.startsWith('.')) continue;
      if (entry.kind === 'dir') {
        if (this.#excludedDirectories.includes(name)) continue;
        candidates.push({ path: `${displayDirectory}${name}`, kind: 'directory' });
      } else if (entry.kind === 'file') {
        candidates.push({ path: `${displayDirectory}${name}`, kind: 'file' });
      }
    }
    return rankCandidates(candidates, fragment, this.#maxResults);
  }

  /**
   * Answer one list() call for a remote workspace. `list` never throws on a
   * remote hiccup: the completion menu just stays empty until the next query.
   */
  async list(host, root, rawQuery, signal) {
    const query = normalizeQuery(rawQuery);
    try {
      throwIfAborted(signal);
      const slash = query.lastIndexOf('/');
      if (query === '' || slash >= 0) {
        const displayDirectory = slash < 0 ? '' : query.slice(0, slash + 1);
        const fragment = slash < 0 ? '' : query.slice(slash + 1);
        return await this.#candidatesForDirectory(host, root, displayDirectory, fragment, signal);
      }
      const entries = await this.#ensureIndex(host, root, signal);
      const visible = entries.filter((candidate) => visibleForGlobalQuery(candidate.path, query));
      return rankCandidates(visible, query, this.#maxResults);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#logError(host, error);
      return [];
    }
  }

  /** Drop cached listings (plugin reload, or a workspace that changed heavily). */
  clear() {
    this.#indexes.clear();
    this.#directories.clear();
  }
}

/** The cwd service returns a string path; tolerate a `{path}` wrapper too. */
function workingDirectoryValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.path === 'string') return value.path;
  return null;
}

/**
 * Install the wrapper. Must be called from the plugin's apply(); the wrapper
 * waits for the file-reference service through `ctx.inject`, so activation
 * order does not matter.
 *
 * @param ctx - plugin context.
 * @param options.pool - connection pool.
 * @param options.mountsRoot - the Presence mounts root (informational; the
 *   authoritative parser is `parseMountPath`).
 * @param options.late - late-bound service holder from index.js (kept for
 *   symmetry with the other installers; unused today).
 * @param options.log - error sink (the plugin passes console.error; probes
 *   pass a no-op so an expected failure does not look like a crash).
 * @returns a status object: `{ ok, error, installed, restore() }`. When the
 *   service instance refuses the patch, `error` carries the exact reason.
 */
export function installRemoteFileReferences(ctx, { pool, mountsRoot, late, log } = {}) {
  void mountsRoot;
  void late;
  const logError = typeof log === 'function' ? log : (message) => console.error(message);
  const status = {
    ok: false,
    error: null,
    get installed() {
      return Boolean(patched);
    },
    restore() {
      try {
        patched?.restore();
      } catch {
        /* restoration is best effort */
      }
      patched = null;
    },
  };
  let patched = null;
  if (!ctx || typeof ctx.inject !== 'function') {
    status.error = 'installRemoteFileReferences: ctx.inject is not available';
    return status;
  }
  if (!pool || typeof pool.connection !== 'function') {
    status.error = 'installRemoteFileReferences: the connection pool is not available';
    return status;
  }

  const register = (scope) => {
    try {
      const service = scope?.fileReferences;
      const workingDirectory = scope?.workingDirectory;
      if (!service || typeof service.list !== 'function') {
        throw new Error('the fileReferences service is not available (no list() method)');
      }
      if (!workingDirectory || typeof workingDirectory.ensure !== 'function') {
        throw new Error('the workingDirectory service is not available');
      }
      const hadOwnList = Object.prototype.hasOwnProperty.call(service, 'list');
      const previousOwnList = hadOwnList ? Object.getOwnPropertyDescriptor(service, 'list') : null;
      const original = service.list.bind(service);
      const lister = new RemoteFileLister(pool, service.config ?? {});

      const wrapped = async function list(agent, query, signal) {
        let cwd = null;
        try {
          cwd = workingDirectoryValue(await workingDirectory.ensure(agent, signal));
        } catch (error) {
          if (signal?.aborted) throw error;
          cwd = null;
        }
        const mounted = cwd ? parseMountPath(cwd) : null;
        if (!mounted) return original(agent, query, signal);
        const root = mounted.path.replace(/\/+$/u, '') || '/';
        // A workspace mounted at the remote filesystem root would make the
        // index walk the whole machine; leave that (absurd) case to the
        // original service instead of scanning everything.
        if (root === '/') return original(agent, query, signal);
        return lister.list(mounted.host, root, query, signal);
      };

      try {
        Object.defineProperty(service, 'list', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: wrapped,
        });
      } catch (error) {
        throw new Error(`could not wrap fileReferences.list: ${error?.message ?? String(error)}`);
      }

      patched = {
        lister,
        restore() {
          try {
            if (hadOwnList && previousOwnList) Object.defineProperty(service, 'list', previousOwnList);
            else delete service.list;
          } catch {
            /* the service is going away anyway */
          }
        },
      };
      status.ok = true;
      status.error = null;
      try {
        if (typeof scope.effect === 'function') {
          scope.effect(() => () => {
            status.restore();
            lister.clear();
          });
        }
      } catch {
        /* disposal is also covered by the plugin scope going away */
      }
    } catch (error) {
      status.ok = false;
      status.error = error?.message ?? String(error);
      try {
        logError(`presence file references: ${status.error}`);
      } catch {
        /* logging is best effort */
      }
    }
  };

  try {
    ctx.inject(['fileReferences', 'workingDirectory'], register);
  } catch (error) {
    status.ok = false;
    status.error = error?.message ?? String(error);
  }
  return status;
}
