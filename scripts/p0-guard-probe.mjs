// P0 guard probe: destructive-command split, single-`rm -f` exemption and the
// rejected-command report wording.
//
//   node scripts/p0-guard-probe.mjs
//
// No SSH host is needed: the guard is driven through a fake PresenceConnection
// that records every remote command and answers the dry-run/target probes. The
// fake also lets the probe assert that no command was actually executed.

import {
  destructiveKind,
  guardDestructive,
  isDeletableWorkspaceFile,
  singleRmTarget,
  splitShellSegments,
} from '../src/destructive.js';

let checks = 0;
let failures = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const WORKSPACE = '/tmp/p0-guard/ws';
const FROZEN_REPORT_LINE =
  'Nothing was executed — the whole command was skipped, including non-destructive parts.';

/** A fake connection: `handler(command)` returns a fake exec result or null. */
function fakeConnection({ home = '/home/probe', handler = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async homePath() {
      return home;
    },
    async exec(command, options) {
      calls.push({ command, options });
      return handler(command) ?? { code: 0, stdout: '', stderr: '', durationMs: 1 };
    },
  };
}

const ok = (stdout, stderr = '') => ({ code: stderr ? 1 : 0, stdout, stderr, durationMs: 1 });

/** Fake used by the mixed-command proof: answers the rm shim and the stat probe. */
function mixedHandler(command) {
  if (command.includes('rm() {')) {
    return ok(command.includes('echo hi') ? 'build\nhi\n' : 'build\n');
  }
  if (command.includes('if [ -e "$p" ]')) {
    if (command.includes("p='hi'")) {
      return ok(
        `dir\t${WORKSPACE}/build\t3 files\t12K\nmissing\t${WORKSPACE}/hi\t-\t-\n`,
      );
    }
    return ok(`dir\t${WORKSPACE}/build\t3 files\t12K\n`);
  }
  return null;
}

// ------------------------------------------------------------------ splitter
const splitCases = [
  ['rm -f a; echo hi', ['rm -f a', 'echo hi']],
  ['cd x && rm -rf y', ['cd x', 'rm -rf y']],
  ['a || b; c\n d', ['a', 'b', 'c', 'd']],
  ['echo "a; b" && rm -rf y', ['echo "a; b"', 'rm -rf y']],
  ["printf 'a && b'", ["printf 'a && b'"]],
  ['echo "$(a; b)"', ['echo "$(a; b)"']],
  ['rm -rf x | tee log', ['rm -rf x | tee log']],
  ['rm -rf a & echo b', ['rm -rf a & echo b']],
  ['echo one\nrm -rf a', ['echo one', 'rm -rf a']],
  ['  rm -rf a ;;  ', ['rm -rf a']],
];
for (const [command, expected] of splitCases) {
  const actual = splitShellSegments(command);
  check(
    `split: ${JSON.stringify(command)}`,
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );
}

// -------------------------------------------------------------- classification
function classify(command) {
  const safe = [];
  const destructive = [];
  for (const segment of splitShellSegments(command)) {
    const kind = destructiveKind(segment);
    if (kind) destructive.push({ segment, kind });
    else safe.push(segment);
  }
  return { safe, destructive };
}
const classCases = [
  ['rm -f a; echo hi', ['rm -f a'], ['echo hi']],
  ['cd x && rm -rf y', ['rm -rf y'], ['cd x']],
  ['echo "a; b" && rm -rf y', ['rm -rf y'], ['echo "a; b"']],
  ["printf 'x && y'", [], ["printf 'x && y'"]],
  ['git clean -fdx || true', ['git clean -fdx'], ['true']],
  ['find . -name "*.log" -delete', ['find . -name "*.log" -delete'], []],
  ['ls -la && echo ok', [], ['ls -la', 'echo ok']],
  ['rm -rf a; rm -rf b', ['rm -rf a', 'rm -rf b'], []],
];
for (const [command, destructive, safe] of classCases) {
  const result = classify(command);
  check(
    `classify: ${JSON.stringify(command)}`,
    JSON.stringify(result.destructive.map((entry) => entry.segment)) === JSON.stringify(destructive) &&
      JSON.stringify(result.safe) === JSON.stringify(safe),
    `safe=${JSON.stringify(result.safe)} destructive=${JSON.stringify(result.destructive.map((entry) => entry.segment))}`,
  );
}

// ------------------------------------------------------- single-rm exemption
const rmCases = [
  ['rm -f a', 'a'],
  ['rm -f ./build/out.o', './build/out.o'],
  ["rm -f 'a b'", 'a b'],
  ['rm -rf a', null],
  ['rm -fr a', null],
  ['rm -frm a', null],
  ['rm -f a b', null],
  ['rm -f $X', null],
  ['rm -f a/*.log', null],
  ['rm -f a?', null],
  ['rm -f a; echo hi', null],
  ['rm -f a | cat', null],
  ['rm -f a && echo hi', null],
  ['rm -f a 2>/dev/null', null],
  ['sudo rm -f a', null],
  ['rm -f -r a', null],
];
for (const [command, expected] of rmCases) {
  const actual = singleRmTarget(command);
  check(`single rm: ${JSON.stringify(command)}`, actual === expected, `-> ${JSON.stringify(actual)}`);
}

const insideCases = [
  [`${WORKSPACE}/a`, true],
  [`${WORKSPACE}/nested/a`, true],
  [WORKSPACE, false],
  ['/tmp', false],
  ['/data/big.bin', false],
  ['/', false],
];
for (const [target, expected] of insideCases) {
  check(`inside workspace: ${target}`, isDeletableWorkspaceFile(target, WORKSPACE) === expected);
}
check(
  'trailing slash in the workspace root is normalised',
  isDeletableWorkspaceFile(`${WORKSPACE}/a`, `${WORKSPACE}/`) === true,
);

// Exemption: a single literal rm -f inside the workspace returns null (run it)
// after one remote symlink-resolution probe.
{
  const connection = fakeConnection({
    handler: (command) => (command.includes('|| exit 0') ? ok(`${WORKSPACE}/out.txt\n`) : null),
  });
  const result = await guardDestructive({
    connection,
    command: 'rm -f out.txt',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('single rm -f inside the workspace is exempt (null)', result === null);
  check(
    'exemption runs only the remote symlink resolution',
    connection.calls.length === 1 && connection.calls[0].command.includes('|| exit 0'),
    `${connection.calls.length} call(s)`,
  );
}

// A single rm -f whose target resolves outside the workspace is guarded again.
{
  const connection = fakeConnection({
    handler: (command) => {
      if (command.includes('|| exit 0')) return ok('/data/big.bin\n');
      if (command.includes('rm() {')) return ok('/data/big.bin\n');
      if (command.includes('if [ -e "$p" ]')) return ok('file\t/data/big.bin\t-\t2G\n');
      return null;
    },
  });
  const result = await guardDestructive({
    connection,
    command: 'rm -f /data/big.bin',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('single rm -f outside the workspace is still guarded', Boolean(result?.kind === 'rm'), `kind=${result?.kind ?? null}`);
  check(
    'outside rm -f reports the resolved target',
    Boolean(result?.report.includes('/data/big.bin')) && result?.resolved.length === 1,
    `resolved=${result?.resolved.length}`,
  );
}

// A symlink inside the workspace that resolves outside is not exempt.
{
  const connection = fakeConnection({
    handler: (command) => (command.includes('|| exit 0') ? ok('/data/secret\n') : null),
  });
  const result = await guardDestructive({
    connection,
    command: 'rm -f link',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('symlink escaping the workspace is not exempt', result !== null, `kind=${result?.kind ?? null}`);
}

// ------------------------------------------------- mixed command: split + report
{
  const connection = fakeConnection({ handler: mixedHandler });
  const result = await guardDestructive({
    connection,
    command: 'rm -rf build; echo hi',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('mixed command is guarded, not run', Boolean(result?.kind === 'rm'), `kind=${result?.kind ?? null}`);
  const split = result?.split;
  check(
    'split.safeSegments lists the non-destructive part',
    Array.isArray(split?.safeSegments) && JSON.stringify(split.safeSegments) === JSON.stringify(['echo hi']),
    JSON.stringify(split?.safeSegments),
  );
  check(
    'split.destructiveSegments carries segment/kind/targets',
    Array.isArray(split?.destructiveSegments) &&
      split.destructiveSegments.length === 1 &&
      split.destructiveSegments[0].segment === 'rm -rf build' &&
      split.destructiveSegments[0].kind === 'rm' &&
      Array.isArray(split.destructiveSegments[0].targets) &&
      split.destructiveSegments[0].targets.some((entry) => entry.path === `${WORKSPACE}/build`),
    JSON.stringify(split?.destructiveSegments?.map((entry) => entry.segment)),
  );
  check('report starts with the frozen sentence', result?.report.split('\n')[0] === FROZEN_REPORT_LINE);
  check(
    'report keeps the existing target block with the resolved build directory',
    result.report.includes('resolved targets:') && result.report.includes(`${WORKSPACE}/build`),
  );
  check(
    'report has the safe-segments block with the safe command',
    result.report.includes('Safe segments you can run separately:') &&
      result.report.includes('  echo hi'),
  );
  check(
    'report suggests confirm:true and confirm:"partial"',
    result.report.includes('confirm:true') && result.report.includes('confirm:"partial"'),
  );
  check(
    'guard executed only reporting probes (no real rm)',
    connection.calls.every(
      (call) => call.command.includes('rm() {') || call.command.includes('if [ -e "$p" ]'),
    ),
    connection.calls.map((call) => call.command.slice(0, 40)).join(' | '),
  );
}

// ------------------------------------------- pure destructive: (none) + wording
{
  const connection = fakeConnection({
    handler: (command) => {
      if (command.includes('rm() {')) return ok('build\n');
      if (command.includes('if [ -e "$p" ]')) return ok(`dir\t${WORKSPACE}/build\t3 files\t12K\n`);
      return null;
    },
  });
  const result = await guardDestructive({
    connection,
    command: 'rm -rf build',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('pure destructive command has no safe segments', result?.split.safeSegments.length === 0);
  check('pure destructive split reuses the resolved targets', result?.split.destructiveSegments[0].targets.length === 1);
  check('pure destructive report shows (none) for safe segments', result?.report.includes('  (none)'));
  check(
    'pure destructive report does not offer confirm:"partial"',
    !result?.report.includes('confirm:"partial"') && result.report.includes('confirm:true'),
  );
}

// ------------------------------------------------------ confirm:"partial" shape
{
  const connection = fakeConnection({ handler: mixedHandler });
  const result = await guardDestructive({
    connection,
    command: 'rm -rf build; echo hi',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: 'partial',
  });
  check(
    'confirm:"partial" still returns split (the caller executes safe segments)',
    JSON.stringify(result?.split.safeSegments) === JSON.stringify(['echo hi']),
  );
  check(
    'confirm:"partial" only runs reporting probes, not the safe segment',
    connection.calls.every(
      (call) => call.command.includes('rm() {') || call.command.includes('if [ -e "$p" ]'),
    ),
    connection.calls.map((call) => call.command.slice(0, 40)).join(' | '),
  );
  check('no report or split value contains replacement characters', !JSON.stringify(result).includes('\uFFFD'));
}

// ------------------------------------------------------- protection still throws
{
  const connection = fakeConnection({
    handler: (command) => {
      if (command.includes('rm() {')) return ok(`${WORKSPACE}\n`);
      if (command.includes('if [ -e "$p" ]')) return ok(`dir\t${WORKSPACE}\t5 files\t1.2M\n`);
      return null;
    },
  });
  let refusal = null;
  try {
    await guardDestructive({
      connection,
      command: `rm -rf ${WORKSPACE}`,
      cwd: WORKSPACE,
      workspace: { path: WORKSPACE },
      host: 'fake',
      confirm: true,
    });
  } catch (error) {
    refusal = error;
  }
  check('workspace root is refused', /workspace root/i.test(refusal?.message ?? ''), refusal?.message?.split('\n')[0] ?? 'no error');
}

{
  const connection = fakeConnection({
    handler: (command) =>
      command.includes('rm() {') ? ok('', 'bash: line 1: P0_UNSET: unbound variable\n') : null,
  });
  let refusal = null;
  try {
    await guardDestructive({
      connection,
      command: 'rm -rf $P0_UNSET/x',
      cwd: WORKSPACE,
      workspace: { path: WORKSPACE },
      host: 'fake',
      confirm: false,
    });
  } catch (error) {
    refusal = error;
  }
  check(
    'unset variable is refused',
    refusal?.code === 'destructive_unset_variable',
    refusal?.message?.split('\n')[0] ?? 'no error',
  );
}

// -------------------------------------------------- truncate kinds: never replay
{
  const connection = fakeConnection();
  const result = await guardDestructive({
    connection,
    command: 'shred -u /tmp/p0-guard/ws/secret.bin',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
    confirm: false,
  });
  check('truncate-kind command is guarded', Boolean(result?.kind === 'truncate'), `kind=${result?.kind ?? null}`);
  check(
    'truncate-kind dry run never executes the command',
    connection.calls.length === 0,
    `${connection.calls.length} remote call(s)`,
  );
  check(
    'truncate-kind report says targets are not resolvable without doing it',
    result?.report.includes('never replayed'),
  );
}

// ---------------------------------------------------------------- benign + exit
{
  const connection = fakeConnection();
  const result = await guardDestructive({
    connection,
    command: 'ls -la && echo ok',
    cwd: WORKSPACE,
    workspace: { path: WORKSPACE },
    host: 'fake',
  });
  check('benign command returns null', result === null);
  check('benign command runs nothing in the guard', connection.calls.length === 0);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
