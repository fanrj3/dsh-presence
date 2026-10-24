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

function isWithin(parent, child) {
  if (!parent) return false;
  const base = parent.replace(/\/+$/, '');
  return child === base || child.startsWith(`${base}/`);
}

/** Run the command in a shell where the destructive verb only reports. */
async function dryRunDestructive(connection, command, kind, cwd) {
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
 * Gate one destructive command.
 *
 * Returns null for a benign command (= run it), a report object for a destructive
 * command without confirmation (= do not run, show the report), and throws for
 * the unrecoverable cases (unset variable, workspace root/ancestor, home, `/`,
 * `.git`) regardless of confirmation.
 *
 * @param connection - live PresenceConnection.
 * @param command - the raw command line.
 * @param cwd - remote working directory, or null.
 * @param workspace - `{ path }` of the session workspace, or null.
 * @param host - alias used in messages.
 * @param confirm - the caller already saw a report and asked to proceed.
 */
export async function guardDestructive({ connection, command, cwd = null, workspace = null, host = 'remote', confirm = false }) {
  const kind = destructiveKind(command);
  if (!kind) return null;

  const dry = await dryRunDestructive(connection, command, kind, cwd);
  const resolved = await describeTargets(connection, dry.targets, cwd);
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

  const report = [
    `destructive command needs confirmation (${kind}) â€?nothing was executed yet`,
    `host: ${host}`,
    `command: ${String(command).replace(/\s+/g, ' ').slice(0, 400)}`,
    cwd ? `cwd: ${cwd}` : null,
    resolved.length > 0 ? 'resolved targets:' : 'resolved targets: (none â€?the command would touch nothing)',
    ...resolved.map((entry) => `  ${entry.type}  ${entry.path}  ${entry.entries}  ${entry.size}`),
    confirm
      ? null
      : 'Pass confirm:true to execute it. Prefer presence_trash when the files are in a workspace (recoverable).',
  ].filter(Boolean);

  return { kind, report: report.join('\n'), resolved };
}
