// Destructive-command guard for remote shell execution.
//
// A real incident motivated this: `presence_exec` ran `rm -rf .tmesh/$J` with an
// empty `$J`, which removed the whole `.tmesh` tree with no dry-run, no backup
// and no warning. The guard:
//   1. classifies the command,
//   2. re-runs it in a reporting shell (`rm` shadowed, `find -delete` -> `-print`,
//      `git clean` -> dry run) so nothing is removed,
//   3. refuses unset variables, workspace roots/ancestors, home, `/` and `.git`,
//   4. otherwise returns a report of the resolved targets and requires confirm.
//
// 0.19.0 adds two things the P0 feedback asked for:
//   5. a top-level split of the command line (`;`, `&&`, `||`, newlines outside
//      quotes), so a rejected mixed command can list the segments that are safe
//      to run on their own (`confirm:"partial"`), and
//   6. a single-file exemption: exactly `rm -f <literal path>` for a path that
//      resolves inside the session workspace runs directly — it cannot remove a
//      tree, which is what the guard exists to stop.

import { posix } from 'node:path';

export function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const DESTRUCTIVE_KINDS = [
  {
    kind: 'rm',
    test: (command) => /\brm\s+/i.test(command) && /\brm\s+[^;&|]*-[A-Za-z]*[rRf]/i.test(command),
  },
  { kind: 'git-clean', test: (command) => /\bgit\s+clean\b[^;&|]*-[A-Za-z]*[fdx]/i.test(command) },
  { kind: 'find-delete', test: (command) => /\bfind\b[^;&|]*-delete\b/.test(command) },
  {
    kind: 'truncate',
    test: (command) =>
      /\b(truncate\s+-s\s*0|:>\s*\S|shred\b|mkfs(\.\w+)?\b|dd\b[^;&|]*\bof=\/dev\/)/i.test(command),
  },
];

/** Classify a shell command that can destroy data, or null when it looks benign. */
export function destructiveKind(command) {
  const text = String(command ?? '');
  for (const entry of DESTRUCTIVE_KINDS) {
    if (entry.test(text)) return entry.kind;
  }
  return null;
}

/** Minimal shell word splitter that honours single/double quotes. */
export function shellWords(text) {
  const words = [];
  let current = null;
  let quote = null;
  for (const character of String(text)) {
    if (current === null) {
      if (/\s/.test(character)) continue;
      current = '';
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      words.push(current);
      current = null;
      continue;
    }
    current += character;
  }
  if (current !== null) words.push(current);
  return words;
}

/**
 * Split one command line on top-level `;`, `&&`, `||` and newlines.
 *
 * Quotes (`'`, `"`, backtick), backslash escapes and `(...)` / `$(...)` nesting
 * are honoured, so `echo "a; b"` and `echo "$(a; b)"` stay one segment. A lone
 * `&` or `|` is a background/pipeline operator rather than a sequence boundary,
 * so it stays inside its segment; that keeps the unit conservative (the whole
 * pipeline is one destructive or one safe segment).
 *
 * @returns {string[]} trimmed, non-empty segments in command order.
 */
export function splitShellSegments(command) {
  const text = String(command ?? '');
  const segments = [];
  let current = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      current += character;
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"' || quote === '`') {
      current += character;
      if (character === '\\' && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      // An escaped operator is a literal character, not a boundary.
      current += character + text[index + 1];
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ')') {
      if (depth > 0) depth -= 1;
      current += character;
      continue;
    }
    if (depth === 0) {
      if (character === ';' || character === '\n' || character === '\r') {
        flush();
        continue;
      }
      if (character === '&' && text[index + 1] === '&') {
        flush();
        index += 1;
        continue;
      }
      if (character === '|' && text[index + 1] === '|') {
        flush();
        index += 1;
        continue;
      }
    }
    current += character;
  }
  flush();
  return segments;
}

/** Characters that make a path non-literal (glob, expansion, redirect, chaining). */
const NOT_LITERAL_PATH = /[*?[\]$;&|<>`(){}\\~\n\r]/;

/**
 * The path of an exact `rm -f <one literal path>` command, or null.
 *
 * The exemption is intentionally narrow: a different verb/mount, `-r`, an
 * extra operand, a glob, a variable, a redirect, a pipeline or a second
 * command all keep the normal guard path.
 */
export function singleRmTarget(command) {
  const text = String(command ?? '');
  if (NOT_LITERAL_PATH.test(text)) return null;
  const words = shellWords(text);
  if (words.length !== 3) return null;
  if (words[0] !== 'rm' || words[1] !== '-f') return null;
  const target = words[2];
  if (!target || target.startsWith('-')) return null;
  return target;
}

function withoutTrailingSlashes(value) {
  const text = String(value);
  if (text === '/') return '/';
  return text.replace(/\/+$/, '');
}

/** Absolute, lexically normalised form of `target` relative to `cwd`. */
function absoluteRemotePath(cwd, target) {
  if (!cwd || !target) return null;
  try {
    return posix.normalize(posix.join(String(cwd), String(target)));
  } catch {
    return null;
  }
}

/**
 * True when `target` is deletable under the exemption: inside the workspace,
 * but neither the workspace root itself nor an ancestor of it.
 */
export function isDeletableWorkspaceFile(target, workspaceRoot) {
  const path = withoutTrailingSlashes(target);
  const base = withoutTrailingSlashes(workspaceRoot);
  if (!path.startsWith('/') || !base.startsWith('/')) return false;
  if (path === base) return false;
  // `path` is an ancestor of the workspace root (e.g. `/tmp` for `/tmp/ws`).
  if (base.startsWith(`${path}/`)) return false;
  return path.startsWith(`${base}/`);
}

/** Resolve a remote path through symlinks; falls back to the parent directory. */
async function resolveRemotePath(connection, target, cwd) {
  const script =
    `cd ${shq(cwd)} || exit 0; p=${shq(target)}; ` +
    `r=$(realpath -m -- "$p" 2>/dev/null || readlink -f -- "$p" 2>/dev/null); ` +
    `[ -n "$r" ] || r=$(cd "$(dirname -- "$p")" 2>/dev/null && printf '%s/%s' "$PWD" "$(basename -- "$p")"); ` +
    `printf '%s\\n' "$r"`;
  try {
    const result = await connection.exec(`bash -c ${shq(script)}`, { timeoutMs: 15_000 });
    const line = String(result.stdout ?? '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)[0];
    return line ?? null;
  } catch {
    return null;
  }
}

/**
 * The 0.19.0 single-file exemption: `rm -f <one literal path>` for a path that
 * resolves inside the workspace, is not the workspace root and cannot be an
 * ancestor of it. Symlinks are resolved first, so a link inside the workspace
 * that points outside is not exempt.
 */
async function exemptSingleFileRm({ connection, command, cwd, workspace }) {
  const workspaceRoot = workspace?.path ?? null;
  if (!cwd || !workspaceRoot) return false;
  const target = singleRmTarget(command);
  if (!target) return false;
  const lexical = absoluteRemotePath(cwd, target);
  if (!lexical) return false;
  const resolved = await resolveRemotePath(connection, target, cwd);
  const candidate = resolved && resolved.startsWith('/') ? posix.normalize(resolved) : lexical;
  return isDeletableWorkspaceFile(candidate, workspaceRoot);
}

function isWithin(parent, child) {
  if (!parent) return false;
  const base = parent.replace(/\/+$/, '');
  return child === base || child.startsWith(`${base}/`);
}

/** Run the command in a shell where the destructive verb only reports. */
async function dryRunDestructive(connection, command, kind, cwd) {
  if (kind === 'truncate') {
    // There is no safe replay for these verbs: `shred`/`truncate`/`mkfs`/`dd of=`
    // write for real and a `:>` redirect cannot be shadowed. Never execute them
    // in the dry run; report that targets cannot be resolved instead of doing
    // the damage while claiming "nothing was executed".
    return { targets: [], stderr: '', code: 0, skipped: true };
  }
  let probe;
  if (kind === 'rm') {
    probe =
      'rm() { for a in "$@"; do case "$a" in -*) ;; *) printf \'%s\\n\' "$a" ;; esac; done; }; ' +
      String(command);
  } else if (kind === 'git-clean') {
    // Keep every flag and add the dry-run flag: `git clean -fdx` -> `git clean -n -fdx`.
    probe = String(command).replace(/\bgit\s+clean\b/, 'git clean -n');
  } else if (kind === 'find-delete') {
    probe = String(command).replace(/-delete\b/g, '-print');
  } else {
    probe = String(command);
  }
  const wrapped = cwd
    ? `cd ${shq(cwd)} && bash -c ${shq(`set -u; ${probe}`)}`
    : `bash -c ${shq(`set -u; ${probe}`)}`;
  const result = await connection.exec(wrapped, { timeoutMs: 30_000 });
  const stderr = String(result.stderr ?? '').trim();
  if (/unbound variable/i.test(stderr)) {
    const error = new Error(
      'refusing a destructive command that references an unset shell variable: ' +
        `${stderr.split('\n')[0] || stderr}\n` +
        'Fix the variable (or give it a default: ${VAR:-}) and retry. Nothing was executed.',
    );
    error.code = 'destructive_unset_variable';
    throw error;
  }
  const targets = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^would remove /i, ''));
  return { targets, stderr, code: result.code };
}

/** Resolve every target and describe it (type, file count, size). */
async function describeTargets(connection, targets, cwd) {
  if (targets.length === 0) return [];
  const script = targets
    .map((target) => {
      const quoted = shq(target);
      return (
        `p=${quoted}; if [ -e "$p" ] || [ -L "$p" ]; then ` +
        `r=$(realpath -m -- "$p" 2>/dev/null || printf '%s' "$p"); ` +
        `if [ -d "$r" ]; then n=$(find "$r" -xdev -type f 2>/dev/null | wc -l); ` +
        `s=$(du -sh -- "$r" 2>/dev/null | cut -f1); printf 'dir\\t%s\\t%s files\\t%s\\n' "$r" "$n" "$s"; ` +
        `else s=$(du -sh -- "$r" 2>/dev/null | cut -f1); printf 'file\\t%s\\t-\\t%s\\n' "$r" "$s"; fi; ` +
        `else printf 'missing\\t%s\\t-\\t-\\n' "$p"; fi`
      );
    })
    .join('\n');
  const body = cwd ? `cd ${shq(cwd)} && ${script}` : script;
  const result = await connection.exec(`bash -c ${shq(body)}`, { timeoutMs: 60_000 });
  return String(result.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [type, path, entries, size] = line.split('\t');
      return { type, path, entries, size };
    });
}

/**
 * Classify every top-level segment so a rejected command can say which parts
 * were safe. `targets` is best effort: a segment that depends on an earlier
 * assignment (`J=""; rm -rf $J`) cannot be dry-run on its own, so it stays empty
 * instead of guessing.
 */
async function describeSplit({ connection, command, cwd, kind, resolved }) {
  const safeSegments = [];
  const destructiveSegments = [];
  for (const segment of splitShellSegments(command)) {
    const segmentKind = destructiveKind(segment);
    if (segmentKind) destructiveSegments.push({ segment, kind: segmentKind, targets: [] });
    else safeSegments.push(segment);
  }
  if (destructiveSegments.length === 0) {
    // The classifier matched across a line break the splitter treats as a
    // boundary; keep the whole command as the single destructive unit.
    destructiveSegments.push({ segment: String(command).trim(), kind, targets: [] });
  }
  if (destructiveSegments.length === 1 && safeSegments.length === 0) {
    // The whole command is the destructive segment: reuse the targets the
    // guard already resolved instead of dry-running it a second time.
    destructiveSegments[0].targets = resolved;
    return { safeSegments, destructiveSegments };
  }
  for (const entry of destructiveSegments) {
    try {
      const segmentDry = await dryRunDestructive(connection, entry.segment, entry.kind, cwd);
      entry.targets = await describeTargets(connection, segmentDry.targets, cwd);
    } catch {
      entry.targets = [];
    }
  }
  return { safeSegments, destructiveSegments };
}

/**
 * Gate one destructive command.
 *
 * Returns null for a benign command (= run it) or for the single-file `rm -f`
 * exemption, a report object for a destructive command without confirmation
 * (= do not run, show the report), and throws for the unrecoverable cases
 * (unset variable, workspace root/ancestor, home, `/`, `.git`) regardless of
 * confirmation.
 *
 * @param connection - live PresenceConnection.
 * @param command - the raw command line.
 * @param cwd - remote working directory, or null.
 * @param workspace - `{ path }` of the session workspace, or null.
 * @param host - alias used in messages.
 * @param confirm - the caller already saw a report and asked to proceed
 *   (`true` = whole command, `'partial'` = the caller runs split.safeSegments).
 */
export async function guardDestructive({ connection, command, cwd = null, workspace = null, host = 'remote', confirm = false }) {
  const kind = destructiveKind(command);
  if (!kind) return null;

  // 0.19.0: removing one generated file with `rm -f` is the everyday case; the
  // guard exists to stop tree deletions. Everything that is not exactly
  // `rm -f <literal path>` inside the workspace keeps the full guard below.
  if (await exemptSingleFileRm({ connection, command, cwd, workspace })) return null;

  const dry = await dryRunDestructive(connection, command, kind, cwd);
  const resolved = await describeTargets(connection, dry.targets, cwd);
  const split = await describeSplit({ connection, command, cwd, kind, resolved });
  const home = await connection.homePath().catch(() => null);
  const workspaceRoot = workspace?.path ?? null;

  const forbidden = [];
  for (const entry of resolved) {
    if (entry.path === '/' || entry.path === home) forbidden.push(`${entry.path} (root or home directory)`);
    else if (workspaceRoot && entry.path === workspaceRoot) forbidden.push(`${entry.path} (this session's workspace root)`);
    else if (workspaceRoot && isWithin(entry.path, workspaceRoot)) forbidden.push(`${entry.path} (an ancestor of the workspace root)`);
    else if (/(^|\/)\.git(\/|$)/.test(entry.path)) forbidden.push(`${entry.path} (git repository metadata)`);
  }
  if (forbidden.length > 0) {
    throw new Error(
      `refusing the destructive command on ${host}: it targets ${forbidden.join('; ')}. ` +
        'Nothing was executed. Narrow the path, or delete recoverably with presence_trash.',
    );
  }

  const targetsLine =
    resolved.length > 0
      ? 'resolved targets:'
      : dry.skipped
        ? `resolved targets: (not resolvable without doing it - ${kind} commands are never replayed)`
        : 'resolved targets: (none - the command would touch nothing)';
  const safeLines = split.safeSegments.length > 0 ? split.safeSegments.map((segment) => `  ${segment}`) : ['  (none)'];
  const confirmHint =
    split.safeSegments.length > 0
      ? 'Pass confirm:true to run the whole command, confirm:"partial" to run only the safe segments, ' +
        'or use presence_trash for a recoverable delete.'
      : 'Pass confirm:true to run the whole command, or use presence_trash for a recoverable delete.';

  const lines = [
    'Nothing was executed — the whole command was skipped, including non-destructive parts.',
    `destructive command needs confirmation (${kind}): nothing was executed yet`,
    `host: ${host}`,
    `command: ${String(command).replace(/\s+/g, ' ').slice(0, 400)}`,
    cwd ? `cwd: ${cwd}` : null,
    targetsLine,
    ...resolved.map((entry) => `  ${entry.type}  ${entry.path}  ${entry.entries}  ${entry.size}`),
    '',
    'Safe segments you can run separately:',
    ...safeLines,
  ];
  if (!confirm) lines.push('', confirmHint);

  // `targets` is the machine-readable twin of the report's target block:
  // callers that answer in JSON (presence_exec format:'json') do not need to
  // parse the text, and existing callers keep reading `report`/`resolved`.
  // `split` lets the caller run only the safe segments (confirm:"partial").
  return {
    kind,
    report: lines.filter((line) => line !== null && line !== undefined).join('\n'),
    resolved,
    targets: resolved,
    split,
  };
}
