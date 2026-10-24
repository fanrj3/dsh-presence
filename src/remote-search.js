// Remote search primitives shared by the presence_* tools and by the
// grep/glob interceptor that keeps the built-in tools honest on a remote
// workspace. Everything runs on the target machine with its own rg/grep.

const MATCH_LIMIT = 200;
const SEARCH_TIMEOUT_MS = 60_000;
const STATS_TIMEOUT_MS = 30_000;
// Newest-first sorting needs the whole match set, not just the first page. The
// scan is bounded so an enormous tree cannot stall a glob; a capped result
// reports the count it could establish instead of inventing one.
const GLOB_SCAN_CAP = 5_000;
const GLOB_STAT_BATCH = 200;

/** Marker the remote shell writes when rg/grep exits with a real error while
 * its output is being piped through `head` (the pipeline status would be
 * head's otherwise). */
const FAILURE_MARKER = '__PRESENCE_SEARCH_FAILED__';

function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The alias to name in an error, even when a caller only has a connection. */
function connectionLabel(connection) {
  return connection?.target ?? connection?.entry?.alias ?? 'remote host';
}

/** Pick an actionable hint from the remote failure text. */
function recoveryHint(detail) {
  if (/no such file|os error 2|not exist/i.test(detail)) {
    return 'the path does not exist — check it with presence_exec (ls) or presence_glob';
  }
  if (/timed out|timeout/i.test(detail)) {
    return 'the search timed out — narrow path/include, or use presence_exec with a targeted command';
  }
  if (/permission denied/i.test(detail)) {
    return 'permission denied on the remote machine — check the path owner with presence_exec';
  }
  return 'narrow path/include, or use presence_exec with a targeted command';
}

function searchFailure(connection, detail) {
  return new Error(`search failed on ${connectionLabel(connection)}: ${detail}; ${recoveryHint(detail)}`);
}

function globFailure(connection, detail) {
  return new Error(`glob failed on ${connectionLabel(connection)}: ${detail}; ${recoveryHint(detail)}`);
}

/**
 * Split an absolute glob such as `/srv/workspace/scripts/*.py` into the search
 * root (`/srv/workspace/scripts`) and the pattern relative to it (`*.py`).
 *
 * The cut is made at the first path segment containing a wildcard, so
 * `/srv/app/**\/*.ts` searches `/srv/app` instead of a literal `**` directory.
 * Returns `null` for a relative pattern.
 *
 * @returns `{ root: string, pattern: string } | null`
 */
export function splitGlobPattern(pattern) {
  const value = String(pattern ?? '');
  if (!value.startsWith('/')) return null;
  const segments = value.split('/');
  let cut = -1;
  for (let index = 1; index < segments.length; index += 1) {
    if (/[*?[\]{}]/.test(segments[index])) {
      cut = index;
      break;
    }
  }
  // No wildcard at all: the last segment is a file name.
  if (cut === -1) cut = Math.max(1, segments.length - 1);
  const root = `/${segments.slice(1, cut).join('/')}`;
  const rest = segments.slice(cut).join('/');
  return { root: root === '/' ? '/' : root.replace(/\/+$/, ''), pattern: rest || '*' };
}

/** Resolve the (root, pattern) pair a caller handed us, absolute patterns win. */
function resolveGlobTarget(root, pattern) {
  const absolute = splitGlobPattern(pattern);
  if (absolute) return absolute;
  const base = root === undefined || root === null || root === '' ? '.' : String(root);
  return { root: base, pattern: String(pattern ?? '*') };
}

/** `rg --files` (or find) names relative to the root, limit + 1 to detect more.
 * A non-finite `limit` lists everything (bounded by the caller). */
async function listGlobPaths(connection, root, pattern, limit) {
  const basename = String(pattern).split('/').filter(Boolean).pop() ?? '*';
  const head = Number.isFinite(limit) ? ` | head -n ${Math.max(1, Math.floor(limit))}` : '';
  const command =
    `cd ${shq(root)} && { { if command -v rg >/dev/null 2>&1; then ` +
    `rg --files -g ${shq(pattern)}; ` +
    `else find . -type f -name ${shq(basename)}; fi; }; ` +
    `code=$?; if [ "$code" -gt 1 ] && [ "$code" -ne 141 ]; then printf '\\n${FAILURE_MARKER} %s\\n' "$code" >&2; fi; }` +
    head;
  let result;
  try {
    result = await connection.exec(command, { timeoutMs: SEARCH_TIMEOUT_MS });
  } catch (error) {
    throw globFailure(connection, error?.message ?? String(error));
  }
  if (result.timedOut) throw globFailure(connection, `timed out after ${SEARCH_TIMEOUT_MS}ms`);
  const stderr = String(result.stderr ?? '');
  const marker = new RegExp(`${FAILURE_MARKER}\\s+(\\d+)`).exec(stderr);
  if (marker) {
    const detail = stderr.replace(new RegExp(`^.*${FAILURE_MARKER}\\s+\\d+.*$`, 'gm'), '').trim();
    throw globFailure(connection, detail || `exit ${marker[1]}`);
  }
  if (result.code > 1) throw globFailure(connection, stderr.trim() || `exit ${result.code}`);
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\.\//, ''));
}

/**
 * One remote `find` for a batch: GNU find prints size, mtime and path in a
 * single call. Returns null when this host's find has no `-printf`, so the
 * caller can fall back to names only instead of failing the glob.
 */
async function statGlobBatch(connection, root, files) {
  const quoted = files.map((file) => shq(`./${file}`)).join(' ');
  // Paths must precede find's expressions; xargs appends them, so hand the
  // whole batch to one `sh` and one `find` as positional parameters.
  const script = `find "$@" -maxdepth 0 -printf '%s\\t%T@\\t%p\\n' 2>/dev/null`;
  const command = `cd ${shq(root)} && printf '%s\\0' ${quoted} | xargs -0 -r sh -c ${shq(script)} sh`;
  let result;
  try {
    result = await connection.exec(command, { timeoutMs: STATS_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const entries = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    if (!line) continue;
    const first = line.indexOf('\t');
    const second = first === -1 ? -1 : line.indexOf('\t', first + 1);
    if (first === -1 || second === -1) continue;
    const size = Number(line.slice(0, first));
    const mtime = Number(line.slice(first + 1, second));
    entries.push({
      path: line.slice(second + 1).replace(/^\.\//, ''),
      size: Number.isFinite(size) ? size : null,
      mtime: Number.isFinite(mtime) ? Math.round(mtime * 1000) : null,
    });
  }
  return entries.length > 0 ? entries : null;
}

/** Stat every listed file, in batches that stay well under the command limit. */
async function statGlobFiles(connection, root, files) {
  if (files.length === 0) return null;
  const batches = [];
  for (let start = 0; start < files.length; start += GLOB_STAT_BATCH) {
    batches.push(files.slice(start, start + GLOB_STAT_BATCH));
  }
  const measured = await Promise.all(batches.map((batch) => statGlobBatch(connection, root, batch)));
  if (measured.some((entries) => entries === null)) return null;
  return measured.flat();
}

/**
 * Glob files under a remote root, with optional size/mtime metadata.
 *
 * An absolute pattern (`/srv/workspace/scripts/*.py`) names its own root; the
 * caller may omit `root` entirely.
 *
 * `stats` also switches on the full scan: newest-first order and an exact total
 * are only meaningful over every match, not over an already-truncated page.
 * The scan is bounded by `GLOB_SCAN_CAP`; a capped result reports `total: null`
 * and `scanCapped: true` rather than pretending the cap is the total.
 *
 * @returns `{ root, pattern, files: string[], entries: {path,size,mtime}[],
 *   truncated: boolean, total: number|null, scanCapped: boolean,
 *   scanned: number, stats: boolean }`; paths stay relative to the root.
 */
export async function remoteGlobDetailed(
  connection,
  { root, pattern, limit = MATCH_LIMIT, stats = false, scanAll = Boolean(stats) } = {},
) {
  const target = resolveGlobTarget(root, pattern);
  const wanted = Math.max(1, Number(limit) || MATCH_LIMIT);
  const scanLimit = scanAll ? GLOB_SCAN_CAP + 1 : wanted + 1;
  const found = await listGlobPaths(connection, target.root, target.pattern, scanLimit);
  const scanCapped = scanAll && found.length > GLOB_SCAN_CAP;
  const candidates = scanCapped ? found.slice(0, GLOB_SCAN_CAP) : found;
  const total = scanAll ? (scanCapped ? null : candidates.length) : found.length > wanted ? null : found.length;
  let entries = candidates.map((path) => ({ path, size: null, mtime: null }));
  let statsAvailable = false;
  if (stats && candidates.length > 0) {
    const measured = await statGlobFiles(connection, target.root, candidates);
    if (measured) {
      statsAvailable = true;
      const byPath = new Map(measured.map((entry) => [entry.path, entry]));
      entries = candidates.map((path) => byPath.get(path) ?? { path, size: null, mtime: null });
      // The report asks for newest first; find returns directory order.
      entries.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));
    }
  }
  const shown = entries.slice(0, wanted);
  return {
    root: target.root,
    pattern: target.pattern,
    files: shown.map((entry) => entry.path),
    entries: shown,
    truncated: total === null ? true : total > wanted,
    total,
    scanCapped,
    scanned: candidates.length,
    stats: statsAvailable,
  };
}

/**
 * Glob files under a remote root.
 *
 * Backwards compatible array result: `truncated` is a non-enumerable property
 * on the array, so `files.map(...)` / `files.join(...)` keep working while
 * new callers can read `files.truncated`.
 *
 * @returns `string[]` with paths relative to the root, canonical '/'.
 */
export async function remoteGlob(connection, options = {}) {
  const detailed = await remoteGlobDetailed(connection, options);
  const files = detailed.files;
  Object.defineProperty(files, 'truncated', {
    value: detailed.truncated,
    enumerable: false,
    configurable: true,
  });
  return files;
}

/** Per-connection cache: does this rg accept `--binary-files=without-match`? */
const BINARY_FLAG_MODE = new WeakMap();

/**
 * One `include` argument may name several globs. Accept the three spellings a
 * caller naturally reaches for: a single glob (`*.ts`), a brace list
 * (`*.{js,jsx}`) or a comma-separated list (`*.txt,*.dat`, spaces allowed).
 * Commas inside braces belong to the brace group, not to the list.
 */
function splitIncludePatterns(include) {
  const value = String(include ?? '').trim();
  if (!value) return [];
  const patterns = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      const piece = value.slice(start, index).trim();
      if (piece) patterns.push(piece);
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) patterns.push(last);
  return patterns.length > 0 ? patterns : [value];
}

/** GNU grep's `--include` has no brace expansion: `{a,b}` becomes two flags. */
function grepIncludeFlags(patterns) {
  const expanded = [];
  for (const pattern of patterns) {
    const brace = /^\{([^{}]*)\}$/.exec(pattern);
    if (!brace) {
      expanded.push(pattern);
      continue;
    }
    for (const alternative of brace[1].split(',')) {
      const trimmed = alternative.trim();
      if (trimmed) expanded.push(trimmed);
    }
  }
  return expanded.map((pattern) => `--include=${shq(pattern)}`).join(' ');
}

/**
 * Build the rg/grep invocations for one search.
 *
 * `--with-filename` / `-H` are always on: rg omits the filename when given one
 * explicit file, which used to make a single-file search parse to nothing.
 */
function searchCommands(pattern, include, smartCase, binaryFlag = true) {
  const includePatterns = splitIncludePatterns(include);
  const caseFlag = smartCase ? '-S ' : '';
  const binary = binaryFlag ? '--binary-files=without-match ' : '';
  const globFlags = includePatterns.map((item) => `-g ${shq(item)}`).join(' ');
  const grepInclude = grepIncludeFlags(includePatterns);
  // GNU grep has no smart case: emulate it from the pattern.
  const insensitive = smartCase && !/[A-Z]/.test(pattern) ? '-i ' : '';
  return {
    rg: `rg -n --no-heading --with-filename --color never ${caseFlag}${binary}-e ${shq(pattern)}${globFlags ? ` ${globFlags}` : ''} --`,
    grep: `grep -rnH --color=never ${insensitive}-I${grepInclude ? ` ${grepInclude}` : ''} -e ${shq(pattern)} --`,
  };
}

/**
 * rg 11 (still common on Ubuntu 20.04) rejects `--binary-files`; newer rg
 * accepts it. When the flag is unsupported, filter the old "Binary file
 * matches" notice out of stdout instead.
 */
function binaryFlagUnsupported(result) {
  if (!result) return false;
  // The pipeline status is head's, so the option-parser complaint is the only
  // reliable signal that this rg build is too old.
  return /--binary-files/.test(result.stderr) && /(wasn't expected|isn't valid|unrecognized|unknown option|invalid option|invalid value)/i.test(result.stderr);
}

function buildSearchCommand({ commands, root, countOnly, wanted, filterBinary }) {
  const host = shq(root);
  const failureCheck =
    `{ if command -v rg >/dev/null 2>&1; then ${commands.rg} ${host}; ` +
    `else ${commands.grep} ${host}; fi; code=$?; ` +
    // 141 = SIGPIPE from `head` closing early: truncation, not an error.
    `if [ "$code" -gt 1 ] && [ "$code" -ne 141 ]; then printf '\\n${FAILURE_MARKER} %s\\n' "$code" >&2; fi; }`;
  const filtered = filterBinary ? `${failureCheck} | grep -v '^Binary file matches'` : failureCheck;
  return countOnly ? `${filtered} | wc -l` : `${filtered} | head -n ${wanted + 1}`;
}

/**
 * One `path:line:text` output line → `{ path, lineNumber, line }`.
 *
 * Splitting at the first two colons is right for the canonical shape, but the
 * parser must never drop a line or invent a line number: when the middle field
 * is not numeric (rg/grep printed no filename, or the line is a notice), the
 * whole line becomes the text with lineNumber 0, which callers render verbatim
 * instead of as an empty "Line 0".
 */
function parseMatchLine(line) {
  const first = line.indexOf(':');
  const second = first === -1 ? -1 : line.indexOf(':', first + 1);
  if (first === -1 || second === -1) return { path: '', lineNumber: 0, line };
  const numberText = line.slice(first + 1, second);
  if (!/^\d+$/.test(numberText)) return { path: '', lineNumber: 0, line };
  return { path: line.slice(0, first), lineNumber: Number(numberText), line: line.slice(second + 1) };
}

/**
 * Ripgrep matches under a remote root.
 *
 * Truncation is detected by asking for `limit + 1` matches. A real failure
 * (bad regex, unreadable path, timeout) is thrown instead of being reported as
 * an empty result.
 *
 * @returns `{ matches: {path,lineNumber,line}[], truncated: boolean,
 *   total: number|null }` — `total` is exact only for `countOnly` or when the
 *   result was not truncated.
 */
export async function remoteGrep(
  connection,
  { root, pattern, include, limit = MATCH_LIMIT, smartCase = true, countOnly = false } = {},
) {
  if (!root) throw searchFailure(connection, 'no search root was given');
  const text = String(pattern ?? '');
  const wanted = Math.max(1, Number(limit) || MATCH_LIMIT);
  const smart = smartCase !== false;

  // Start with the explicit binary flag; retry once without it on rg builds
  // that predate the option. The answer is cached per connection.
  let withBinaryFlag = BINARY_FLAG_MODE.get(connection) !== false;
  let filterBinary = BINARY_FLAG_MODE.get(connection) === false;
  let result;
  for (;;) {
    const command = buildSearchCommand({
      commands: searchCommands(text, include, smart, withBinaryFlag),
      root,
      countOnly,
      wanted,
      filterBinary,
    });
    try {
      result = await connection.exec(command, { timeoutMs: SEARCH_TIMEOUT_MS });
    } catch (error) {
      throw searchFailure(connection, error?.message ?? String(error));
    }
    if (withBinaryFlag && binaryFlagUnsupported(result)) {
      BINARY_FLAG_MODE.set(connection, false);
      withBinaryFlag = false;
      filterBinary = true;
      continue;
    }
    BINARY_FLAG_MODE.set(connection, withBinaryFlag);
    break;
  }
  if (result.timedOut) throw searchFailure(connection, `timed out after ${SEARCH_TIMEOUT_MS}ms`);

  const stderr = String(result.stderr ?? '');
  const stdout = String(result.stdout ?? '');
  const lines = stdout.split('\n').filter(Boolean);
  const marker = new RegExp(`${FAILURE_MARKER}\\s+(\\d+)`).exec(stderr);
  // A permission error inside ONE subdirectory (or any rg exit >= 2) must not
  // discard the matches it did produce: keep them and report a warning.
  let warning = null;
  if (marker) {
    const detail = stderr.replace(new RegExp(`^.*${FAILURE_MARKER}\\s+\\d+.*$`, 'gm'), '').trim();
    if (lines.length === 0 && !countOnly) throw searchFailure(connection, detail || `exit ${marker[1]}`);
    warning = detail || `exit ${marker[1]}`;
  } else if (result.code > 1) {
    // rg: 0 matches, 1 no matches, >=2 real error (bad regex, unreadable path…).
    if (lines.length === 0 && !countOnly) throw searchFailure(connection, stderr.trim() || `exit ${result.code}`);
    warning = stderr.trim() || `exit ${result.code}`;
  }

  if (countOnly) {
    const total = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(total)) {
      throw searchFailure(connection, `could not read the match count (${stdout.trim() || 'no output'})`);
    }
    return { matches: [], truncated: false, total, warning };
  }

  const matches = [];
  for (const line of lines) {
    matches.push(parseMatchLine(line));
    if (matches.length >= wanted) break;
  }
  const truncated = lines.length > wanted;
  return { matches, truncated, total: truncated ? null : matches.length, warning };
}
