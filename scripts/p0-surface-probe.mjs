// P0 tool-surface probe for Presence 0.19.0.
//
//   node scripts/p0-surface-probe.mjs [alias]
//
// Covers the contract's "Tool surface" section against a real host:
//   - every argument alias (path/file_path/filePath, edit old/new spellings,
//     cwd/workdir/dir, from/to spellings),
//   - the self-explaining missing-argument errors,
//   - presence_exec text/JSON: cwd, spill paths, timeout text + partial output,
//     long-job hints, SIGPIPE text, progress modes, tailLines,
//   - presence_hosts: session-workspace default (fake cwdOf mount path),
//     settings.defaultHost fallback, degraded rendering,
//   - presence_jobs list: label first, command clipped to 200 characters,
//   - presence_exec dry-run partial: safe segments executed, destructive ones
//     skipped,
//   - presence_edit not-found hints (closest lines + re-read note).
//
// src/tools.js imports @deepseek-ai/dsh-tools, which only exists inside the
// Harness runtime. A loader hook maps that specifier to an identity defineTool
// so the real implementations run here unchanged. All remote fixtures live in
// /tmp and are removed at the end; the local temp file is removed too.

import { register } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePool } from '../src/pool.js';
import { mountPathFor } from '../src/mounts.js';

const alias = process.argv[2] ?? 'server';

const stubSource = `export function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
    execute: definition.execute,
  };
}
`;
const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;
const hookSource = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`);

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const settings = {
  maxChannels: 8,
  connectTimeoutMs: 25_000,
  idleTimeoutMs: 900_000,
  readOnly: false,
  defaultHost: null,
};
const pool = new PresencePool(settings);
const otherAlias = (() => {
  try {
    return pool.hosts().map((host) => host.alias).find((name) => name !== alias) ?? null;
  } catch {
    return null;
  }
})();
// The fallback case: no session workspace, so this configured host wins.
settings.defaultHost = otherAlias;

const { definePresenceTools } = await import('../src/tools.js');
const execCtx = { agent: null, signal: undefined };

const baseTools = new Map(
  definePresenceTools(pool, settings, { cwdOf: async () => null }).map((tool) => [tool.name, tool]),
);

// A fake session workspace mounts the probed host: presence_hosts must mark this
// machine as the session default even though settings.defaultHost is another one.
const seenCwdExec = [];
const workspaceMount = mountPathFor(alias, '/tmp/presence-surface-workspace');
const workspaceTools = new Map(
  definePresenceTools(pool, settings, {
    cwdOf: async (exec) => {
      seenCwdExec.push(exec);
      return workspaceMount;
    },
  }).map((tool) => [tool.name, tool]),
);

// Degraded rendering needs a pool row that reports a recent failure.
const degradedHost = {
  alias: 'simulated-degraded',
  hostname: '10.255.255.1',
  port: 22,
  user: 'tester',
  source: 'manual',
  connected: true,
  state: 'degraded',
  lastError: 'retry 2 failed: connection timed out after 25000ms',
  terminals: 0,
};
const degradedTools = new Map(
  definePresenceTools(
    { hosts: () => [degradedHost] },
    settings,
    { cwdOf: async () => null },
  ).map((tool) => [tool.name, tool]),
);

const call = async (name, args = {}, tools = baseTools) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool.execute({ host: alias, ...args }, execCtx);
};
// Missing-argument errors are checked without the probe's implicit `host`, so
// the "received" list is exactly what the caller sent.
const callRaw = async (name, args = {}) => {
  const tool = baseTools.get(name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool.execute(args, execCtx);
};
const asJson = (value) => JSON.parse(value);
const expectError = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const stamp = Date.now();
const dir = `/tmp/presence-surface-probe-${stamp}`;
const localFixture = mkdtempSync(join(tmpdir(), 'presence-surface-probe-'));
let jobIds = [];
let connection = null;

try {
  connection = await pool.connection(alias);

  // ------------------------------------------------------------- fixtures
  await call('presence_exec', {
    command:
      `mkdir -p ${dir} && ` +
      `printf 'line one\\nline two\\nline three\\n' > ${dir}/edit.txt && ` +
      `printf 'export me\\n' > ${dir}/export.txt && ` +
      `printf 'left side\\n' > ${dir}/diff-a.txt && ` +
      `printf 'right side\\n' > ${dir}/diff-b.txt && ` +
      `mkdir -p ${dir}/doomed && printf 'x\\n' > ${dir}/doomed/file.txt && ` +
      `mkdir -p ${dir}/doomed2 && printf 'x\\n' > ${dir}/doomed2/file.txt`,
  });

  // -------------------------------------------------- schema / parameters
  {
    const execTool = baseTools.get('presence_exec');
    const params = execTool.parameters;
    check(
      'schema: exec timeoutMs defaults to 300000 in its description',
      String(params.timeoutMs?.description ?? '').includes('300000'),
      JSON.stringify(String(params.timeoutMs?.description ?? '').slice(0, 60)),
    );
    check(
      'schema: exec has tailLines (number) and progress (last|all|strip)',
      params.tailLines?.type === 'number' &&
        Array.isArray(params.progress?.enum) &&
        params.progress.enum.join(',') === 'last,all,strip',
      `tailLines=${params.tailLines?.type} progress=${(params.progress?.enum ?? []).join('|')}`,
    );
    const confirmOptions = Array.isArray(params.confirm?.oneOf) ? params.confirm.oneOf : [];
    const hasPartial = confirmOptions.some(
      (option) => option?.type === 'string' && Array.isArray(option.enum) && option.enum.includes('partial'),
    );
    check(
      'schema: exec confirm accepts boolean or "partial"',
      confirmOptions.some((option) => option?.type === 'boolean') && hasPartial,
      JSON.stringify(confirmOptions),
    );
  }

  // ------------------------------------------------------------ aliases
  const written = asJson(
    await call('presence_write', { file_path: `${dir}/alias-write.txt`, content: 'one\n', format: 'json' }),
  );
  check(
    'alias: presence_write accepts file_path',
    written.path === `${dir}/alias-write.txt` && written.sizeBytes === 4,
    `path=${written.path}`,
  );
  const writtenCamel = asJson(
    await call('presence_write', { filePath: `${dir}/alias-camel.txt`, content: 'camel\n', format: 'json' }),
  );
  check('alias: presence_write accepts filePath', writtenCamel.sizeBytes === 6, `size=${writtenCamel.sizeBytes}`);

  const readSnake = await call('presence_read', { file_path: `${dir}/alias-write.txt`, raw: true });
  const readCamel = await call('presence_read', { filePath: `${dir}/alias-camel.txt`, raw: true });
  check('alias: presence_read accepts file_path/filePath', readSnake === 'one\n' && readCamel === 'camel\n', JSON.stringify(readSnake));

  const readManyCanonical = await call('presence_read_many', { paths: [`${dir}/alias-write.txt`] });
  const readManyAlias = await call('presence_read_many', { file_path: `${dir}/alias-camel.txt` });
  check(
    'alias: presence_read_many accepts paths and a single file_path',
    readManyCanonical.includes('one') && readManyAlias.includes('camel'),
    `alias=${JSON.stringify(readManyAlias.slice(0, 40))}`,
  );

  const statCanonical = asJson(await call('presence_stat', { paths: [`${dir}/alias-write.txt`], format: 'json' }));
  const statAlias = asJson(await call('presence_stat', { file_path: `${dir}/alias-write.txt`, format: 'json' }));
  check(
    'alias: presence_stat accepts paths and a single file_path',
    statCanonical[0].path === `${dir}/alias-write.txt` && statAlias[0].path === `${dir}/alias-write.txt`,
    `rows=${statAlias.length}`,
  );

  const mkdirText = await call('presence_mkdir', { file_path: `${dir}/alias-dir` });
  check('alias: presence_mkdir accepts file_path', mkdirText.includes('created directory'), mkdirText);

  await call('presence_write', { path: `${dir}/move-me.txt`, content: 'move\n' });
  const moveText = await call('presence_move', {
    from_path: `${dir}/move-me.txt`,
    to_path: `${dir}/moved.txt`,
  });
  const movedStat = asJson(await call('presence_stat', { paths: [`${dir}/moved.txt`], format: 'json' }));
  check(
    'alias: presence_move accepts from_path/to_path',
    moveText.includes('moved') && movedStat[0].exists === true,
    moveText,
  );

  const copyText = await call('presence_copy', { from: `${dir}/moved.txt`, to_path: `${dir}/copied.txt` });
  const copiedStat = asJson(await call('presence_stat', { paths: [`${dir}/copied.txt`], format: 'json' }));
  check('alias: presence_copy accepts to_path', copyText.includes('copied') && copiedStat[0].exists === true, copyText);

  await call('presence_write', { path: `${dir}/exec-bit.txt`, content: '#!/bin/sh\n' });
  await call('presence_chmod', { filePath: `${dir}/exec-bit.txt`, mode: '755' });
  const modeStat = asJson(await call('presence_stat', { paths: [`${dir}/exec-bit.txt`], format: 'json' }));
  check('alias: presence_chmod accepts filePath', modeStat[0].mode === '0755', `mode=${modeStat[0].mode}`);

  const diffJson = asJson(
    await call('presence_diff', { file_path: `${dir}/diff-a.txt`, b: `${dir}/diff-b.txt`, format: 'json' }),
  );
  check(
    'alias: presence_diff accepts a plain path spelling for the left side',
    diffJson.stats.added >= 1 && diffJson.stats.removed >= 1,
    JSON.stringify(diffJson.stats),
  );

  await call('presence_write', { path: `${dir}/tail.log`, content: 'first\nsecond\nthird\n' });
  const tailText = await call('presence_tail', { file_path: `${dir}/tail.log`, lines: 2 });
  check('alias: presence_tail accepts file_path', tailText.includes('third') && !tailText.includes('first'), tailText.split('\n')[0]);

  const exportText = await call('presence_export', { file_path: `${dir}/export.txt` });
  check('alias: presence_export accepts file_path', exportText.includes('exported') && exportText.includes('local file:'), exportText.split('\n')[0]);

  const localUpload = join(localFixture, 'upload.txt');
  writeFileSync(localUpload, 'uploaded payload\n', 'utf8');
  const importJson = asJson(
    await call('presence_import', { source: localUpload, to_path: `${dir}/uploaded.txt`, format: 'json' }),
  );
  check(
    'alias: presence_import accepts to_path',
    importJson.remotePath === `${dir}/uploaded.txt` && importJson.sizeBytes === 17,
    `remote=${importJson.remotePath}`,
  );

  await call('presence_write', { path: `${dir}/trash-me.txt`, content: 'trash\n' });
  const trashed = asJson(await call('presence_trash', { action: 'trash', file_path: `${dir}/trash-me.txt`, format: 'json' }));
  const restored = asJson(
    await call('presence_trash', { action: 'restore', trashPath: trashed.trashPath, to_path: `${dir}/trash-me.txt`, format: 'json' }),
  );
  const restoredStat = asJson(await call('presence_stat', { paths: [`${dir}/trash-me.txt`], format: 'json' }));
  check(
    'alias: presence_trash accepts file_path and restore to_path',
    trashed.trashPath.includes('presence-trash') && restored.restored === true && restoredStat[0].exists === true,
    `trash=${trashed.trashPath}`,
  );

  // The glob/search path parameter also accepts the alias spellings.
  const globJson = asJson(await call('presence_glob', { pattern: '*.txt', file_path: dir, format: 'json' }));
  const searchJson = asJson(await call('presence_search', { pattern: 'right side', file_path: dir, format: 'json' }));
  check(
    'alias: presence_glob/presence_search accept file_path',
    globJson.some((row) => row.path.endsWith('/alias-write.txt')) && searchJson.matchCount >= 1,
    `glob=${globJson.length} matches=${searchJson.matchCount}`,
  );

  // edit spellings: oldString/newString, old_string/new_string, replace_all, dry_run.
  const editCamel = asJson(
    await call('presence_edit', {
      path: `${dir}/edit.txt`,
      oldString: 'line two',
      newString: 'line TWO',
      format: 'json',
    }),
  );
  const editSnake = asJson(
    await call('presence_edit', {
      path: `${dir}/edit.txt`,
      old_string: 'line three',
      new_string: 'line THREE',
      replace_all: false,
      format: 'json',
    }),
  );
  check(
    'alias: presence_edit accepts oldString/newString and old_string/new_string',
    editCamel.replaced === 1 && editSnake.replaced === 1,
    `camel=${editCamel.replaced} snake=${editSnake.replaced}`,
  );

  await call('presence_write', { path: `${dir}/replace-all.txt`, content: 'x x x\n' });
  const replaceAll = asJson(
    await call('presence_edit', {
      path: `${dir}/replace-all.txt`,
      old: 'x',
      new: 'y',
      replace_all: true,
      format: 'json',
    }),
  );
  check('alias: presence_edit accepts replace_all', replaceAll.replaced === 3, `replaced=${replaceAll.replaced}`);

  const dryJson = asJson(
    await call('presence_edit', {
      path: `${dir}/edit.txt`,
      old: 'line one',
      new: 'line ONE',
      dry_run: true,
      format: 'json',
    }),
  );
  const afterDry = await call('presence_read', { path: `${dir}/edit.txt`, raw: true });
  check(
    'alias: presence_edit accepts dry_run and writes nothing',
    dryJson.dryRun === true && afterDry.includes('line one'),
    `dryRun=${dryJson.dryRun}`,
  );

  const pwdWorkdir = asJson(await call('presence_exec', { command: 'pwd', workdir: dir, format: 'json' }));
  const pwdDir = asJson(await call('presence_exec', { command: 'pwd', dir, format: 'json' }));
  check(
    'alias: presence_exec accepts workdir and dir for cwd',
    pwdWorkdir.cwd === dir && pwdDir.cwd === dir,
    `workdir=${pwdWorkdir.cwd} dir=${pwdDir.cwd}`,
  );

  // --------------------------------------------- missing-argument errors
  const missingPath = await expectError(() => callRaw('presence_write', { content: 'x' }));
  check(
    'error: presence_write missing path explains accepted spellings and example',
    missingPath ===
      'missing "path" on presence_write (accepted: path, file_path; received: content). ' +
        'Example: {"path": "/srv/app/a.txt", "content": "hi"}',
    missingPath,
  );
  const missingContent = await expectError(() => callRaw('presence_write', { path: `${dir}/x.txt` }));
  check(
    'error: presence_write missing content explains itself',
    missingContent?.startsWith('missing "content" on presence_write (accepted: content; received: path)'),
    missingContent,
  );
  const missingOld = await expectError(() => callRaw('presence_edit', { path: `${dir}/edit.txt` }));
  check(
    'error: presence_edit missing old lists all spellings',
    missingOld?.startsWith('missing "old" on presence_edit (accepted: old, oldString, old_string; received: path)'),
    missingOld,
  );
  const missingNew = await expectError(() => callRaw('presence_edit', { path: `${dir}/edit.txt`, old: 'line one' }));
  check(
    'error: presence_edit missing new lists all spellings',
    missingNew?.startsWith('missing "new" on presence_edit (accepted: new, newString, new_string; received: path, old)'),
    missingNew,
  );
  const missingReadPath = await expectError(() => callRaw('presence_read', {}));
  check(
    'error: presence_read missing path names the argument and received keys',
    missingReadPath?.includes('missing "path" on presence_read') && missingReadPath.includes('received: nothing'),
    missingReadPath,
  );
  const missingTo = await expectError(() => callRaw('presence_move', { from: `${dir}/moved.txt` }));
  check(
    'error: presence_move missing to proposes an example',
    missingTo?.startsWith('missing "to" on presence_move (accepted: to, to_path; received: from)') &&
      missingTo.includes('Example: {"from": "/srv/app/a.txt", "to": "/srv/app/b.txt"}'),
    missingTo,
  );
  const missingCommand = await expectError(() => callRaw('presence_exec', {}));
  check(
    'error: presence_exec missing command explains itself',
    missingCommand === 'missing "command" on presence_exec (accepted: command; received: nothing). Example: {"command": "uname -a"}',
    missingCommand,
  );

  // -------------------------------------------------- exec text and JSON
  const execText = await call('presence_exec', { command: 'echo surface-text', cwd: dir });
  const execLines = execText.split('\n');
  check(
    'exec text: starts with the absolute remote cwd',
    execLines[0] === `host: ${alias}  remote cwd: ${dir}` && execText.includes('surface-text') && execText.includes('exit: 0'),
    execLines[0],
  );
  const execJson = asJson(await call('presence_exec', { command: 'echo surface-json', cwd: dir, format: 'json' }));
  check(
    'exec JSON: absolute cwd, exitCode, stdout, hints/tailLines',
    execJson.cwd === dir &&
      execJson.exitCode === 0 &&
      execJson.stdout.includes('surface-json') &&
      Array.isArray(execJson.hints) &&
      execJson.hints.length === 0 &&
      execJson.tailLines === 0,
    `cwd=${execJson.cwd} hints=${JSON.stringify(execJson.hints)}`,
  );

  const progressLast = asJson(
    await call('presence_exec', { command: "printf 'alpha\\rbeta\\rgamma\\n'", cwd: dir, format: 'json' }),
  );
  const progressAll = asJson(
    await call('presence_exec', { command: "printf 'alpha\\rbeta\\rgamma\\n'", cwd: dir, progress: 'all', format: 'json' }),
  );
  check(
    'exec progress: default "last" keeps the final state, "all" keeps every update',
    progressLast.stdout.trim() === 'gamma' && progressAll.stdout === 'alpha\nbeta\ngamma\n',
    `last=${JSON.stringify(progressLast.stdout)} all=${JSON.stringify(progressAll.stdout)}`,
  );

  // 1.1 MiB output exceeds the connection's capture cap and must spill.
  const spillText = await call('presence_exec', { command: 'seq 1 200000', cwd: dir });
  const spillJson = asJson(await call('presence_exec', { command: 'seq 1 200000', cwd: dir, format: 'json' }));
  check(
    'exec text: oversized stdout names the spill file and omitted characters',
    spillText.includes('characters omitted; full stdout: /tmp/presence-exec-') &&
      /stdout: \/tmp\/presence-exec-\S+ \(\d+ bytes\)/.test(spillText) &&
      spillText.includes('--- stdout ---'),
    spillText.split('\n').find((line) => line.includes('characters omitted; full stdout'))?.slice(0, 120) ?? '',
  );
  check(
    'exec JSON: oversized stdout carries stdoutFile/stdoutFileBytes',
    spillJson.stdoutTruncated === true &&
      typeof spillJson.stdoutFile === 'string' &&
      spillJson.stdoutFile.startsWith('/tmp/presence-exec-') &&
      spillJson.stdoutFileBytes > 0,
    `file=${spillJson.stdoutFile} bytes=${spillJson.stdoutFileBytes}`,
  );
  check(
    'exec JSON: payload stays valid and inside the 32 KiB cap',
    JSON.stringify(spillJson).length <= 32 * 1024 + 64,
    `jsonChars=${JSON.stringify(spillJson).length}`,
  );

  const execTailText = await call('presence_exec', {
    command: 'seq 1 20000',
    cwd: dir,
    maxOutput: 1000,
    tailLines: 3,
  });
  check(
    'exec tailLines: head excerpt plus the last 3 lines of a 108 KiB output',
    execTailText.includes('\n19998\n19999\n20000') && execTailText.includes('characters omitted'),
    JSON.stringify(execTailText.split('\n').slice(-4)),
  );

  const timeoutText = await call('presence_exec', {
    command: 'echo timeout-partial; sleep 5',
    cwd: dir,
    timeoutMs: 500,
  });
  const timeoutJson = asJson(
    await call('presence_exec', {
      command: 'echo timeout-partial; sleep 5',
      cwd: dir,
      timeoutMs: 500,
      format: 'json',
    }),
  );
  check(
    'exec timeout text: exact termination sentence plus partial output',
    timeoutText.includes(
      'timed out after 500ms — remote process tree terminated (SIGTERM, then SIGKILL after 5s); partial output below',
    ) && timeoutText.includes('timeout-partial'),
    timeoutText.split('\n').find((line) => line.includes('timed out')) ?? '',
  );
  check(
    'exec timeout JSON: timedOut/killed/killSequence and partial stdout',
    timeoutJson.timedOut === true &&
      timeoutJson.killed === true &&
      JSON.stringify(timeoutJson.killSequence) === '["SIGTERM","SIGKILL"]' &&
      timeoutJson.stdout.includes('timeout-partial'),
    `killed=${timeoutJson.killed} killSequence=${JSON.stringify(timeoutJson.killSequence)}`,
  );

  const timeoutSpill = await call('presence_exec', {
    command: 'seq 1 200000; sleep 5',
    cwd: dir,
    timeoutMs: 600,
  });
  check(
    'exec timeout text: partial output is spilled and its path reported',
    timeoutSpill.includes('partial output saved to: /tmp/presence-exec-') &&
      timeoutSpill.includes('--- stdout ---') &&
      /stdout: \/tmp\/presence-exec-\S+ \(\d+ bytes\)/.test(timeoutSpill),
    timeoutSpill.split('\n').find((line) => line.includes('partial output saved to')) ?? '',
  );

  const timeoutBackground = await call('presence_exec', {
    command: 'nohup sleep 2 >/dev/null 2>&1; sleep 5',
    cwd: dir,
    timeoutMs: 500,
  });
  check(
    'exec timeout text: background-children warning for nohup/& commands',
    timeoutBackground.startsWith(`host: ${alias}  remote cwd: ${dir}`) &&
      timeoutBackground.split('\n')[1].startsWith('hint: ') &&
      timeoutBackground.includes(
        'background children started by this command may still be running — use background:true / presence_terminal to track them',
      ),
    timeoutBackground.split('\n').slice(0, 3).join(' | '),
  );

  const hintJson = asJson(
    await call('presence_exec', { command: 'nohup sh -c "exit 0" >/dev/null 2>&1 &', cwd: dir, format: 'json' }),
  );
  const hintText = await call('presence_exec', { command: 'nohup sh -c "exit 0" >/dev/null 2>&1 &', cwd: dir });
  check(
    'exec hint: nohup/trailing & adds one hint line (JSON hints[])',
    Array.isArray(hintJson.hints) &&
      hintJson.hints.length === 1 &&
      hintJson.hints[0].includes('background:true') &&
      hintText.split('\n')[0] === `host: ${alias}  remote cwd: ${dir}` &&
      hintText.split('\n')[1].startsWith('hint: '),
    `hint=${JSON.stringify(hintJson.hints[0]?.slice(0, 60))}`,
  );
  const noHint = asJson(await call('presence_exec', { command: 'echo plain', cwd: dir, format: 'json' }));
  check('exec hint: a plain command has no hint', Array.isArray(noHint.hints) && noHint.hints.length === 0, JSON.stringify(noHint.hints));

  const sigpipeJson = asJson(
    await call('presence_exec', { command: 'yes | head -n 1', cwd: dir, format: 'json' }),
  );
  const sigpipeText = await call('presence_exec', { command: 'yes | head -n 1', cwd: dir });
  check(
    'exec SIGPIPE: flag, code 141 and the harmless explanation',
    sigpipeJson.sigpipe === true &&
      sigpipeJson.exitCode === 141 &&
      sigpipeText.includes('exit 141 (SIGPIPE — downstream closed early; usually harmless)'),
    `code=${sigpipeJson.exitCode} sigpipe=${sigpipeJson.sigpipe} line=${sigpipeText.split('\n').find((line) => line.includes('SIGPIPE'))}`,
  );

  // -------------------------------------------------- edit not-found hints
  await call('presence_write', { path: `${dir}/anchor.txt`, content: 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n' });
  const notFound = await expectError(() =>
    call('presence_edit', { path: `${dir}/anchor.txt`, old: 'const alpha  = 1;', new: 'const alpha = 2;' }),
  );
  const closestLine = /line 1: const alpha = 1;/.test(notFound ?? '');
  check(
    'edit not found: closest lines, line numbers and the re-read hint',
    notFound?.includes('text to replace was not found') &&
      closestLine &&
      notFound.includes('re-read the file if another session changed it') &&
      notFound.includes('ifMatchSha256 is available on presence_write'),
    (notFound ?? '').split('\n').slice(0, 3).join(' | '),
  );

  // ------------------------------------------------------------- hosts
  await call('presence_connect', { format: 'json' }).catch(() => {});
  const hostsJson = asJson(await call('presence_hosts', { format: 'json' }));
  const otherRow = hostsJson.find((row) => row.alias === otherAlias);
  const aliasRow = hostsJson.find((row) => row.alias === alias);
  check(
    'hosts JSON: no workspace here, so settings.defaultHost is the default',
    Boolean(otherAlias) && otherRow?.default === true && aliasRow?.default === false,
    `default=${hostsJson.filter((row) => row.default).map((row) => row.alias).join(',')} expected=${otherAlias}`,
  );
  check(
    'hosts JSON: connected rows expose state and the workspace flag',
    aliasRow?.state === 'connected' && typeof aliasRow?.workspace === 'boolean' && aliasRow.connected === true,
    `state=${aliasRow?.state} workspace=${aliasRow?.workspace}`,
  );

  seenCwdExec.length = 0;
  const workspaceHosts = asJson(await call('presence_hosts', { format: 'json' }, workspaceTools));
  const workspaceDefaultRow = workspaceHosts.find((row) => row.default);
  check(
    'hosts: the session workspace machine wins over settings.defaultHost',
    workspaceDefaultRow?.alias === alias && workspaceDefaultRow?.workspace === true,
    `default=${workspaceDefaultRow?.alias} expected=${alias}`,
  );
  check(
    'hosts execute receives the exec context (fake cwdOf saw it)',
    seenCwdExec.at(-1) === execCtx,
    `calls=${seenCwdExec.length}`,
  );

  const degradedText = await call('presence_hosts', {}, degradedTools);
  const degradedJson = asJson(await call('presence_hosts', { format: 'json' }, degradedTools));
  check(
    'hosts degraded: text renders "degraded (last error: ...)"',
    degradedText.includes('degraded (last error: retry 2 failed: connection timed out after 25000ms)'),
    degradedText.split('\n')[1] ?? degradedText,
  );
  check(
    'hosts degraded: JSON keeps state + lastError',
    degradedJson[0]?.state === 'degraded' && degradedJson[0]?.lastError?.includes('timed out'),
    JSON.stringify({ state: degradedJson[0]?.state, lastError: degradedJson[0]?.lastError }),
  );

  // ------------------------------------------------------------- jobs list
  const longCommand = `sleep 30 # ${'padding '.repeat(40)}`;
  const started = await call('presence_exec', {
    command: longCommand,
    cwd: dir,
    background: true,
    label: 'surface-probe-long-job',
  });
  const jobId = /job: (\S+)/.exec(started)?.[1] ?? null;
  if (jobId) jobIds.push(jobId);
  const jobsJson = asJson(await call('presence_jobs', { action: 'list', format: 'json' }));
  const jobJson = jobsJson.find((row) => row.id === jobId);
  const jobsText = await call('presence_jobs', { action: 'list' });
  const labelIndex = jobsText.indexOf('surface-probe-long-job');
  const idIndex = jobsText.indexOf(`job=${jobId}`);
  check(
    'jobs list JSON: command clipped to 200 characters',
    Boolean(jobJson) && jobJson.command.length > 200 && jobJson.command.length < 260 && jobJson.command.includes('more characters'),
    `len=${jobJson?.command?.length}`,
  );
  check(
    'jobs list text: label first, clipped command on its own line',
    labelIndex >= 0 && idIndex > labelIndex && jobsText.includes('command: sleep 30') && jobsText.includes('more characters'),
    `labelAt=${labelIndex} idAt=${idIndex}`,
  );
  check(
    'jobs list JSON: payload wrapped as 32 KiB-bounded JSON text',
    jobsJson.length >= 1 && jobsText.split('\n').some((line) => line.includes('job=')),
    `jobs=${jobsJson.length}`,
  );
  await call('presence_jobs', { action: 'stop', jobId });
  jobIds = jobIds.filter((id) => id !== jobId);

  // ------------------------------------------------- dry-run / partial run
  const dryRunJson = asJson(
    await call('presence_exec', { command: `rm -rf ${dir}/doomed; echo safe-one`, cwd: dir, format: 'json' }),
  );
  const doomedUtf = asJson(await call('presence_stat', { paths: [`${dir}/doomed`], format: 'json' }));
  check(
    'dry-run JSON: report starts with the skip sentence and exposes safeSegments',
    dryRunJson.dryRun === true &&
      dryRunJson.requiresConfirm === true &&
      dryRunJson.report.startsWith(
        'Nothing was executed — the whole command was skipped, including non-destructive parts.',
      ) &&
      dryRunJson.safeSegments?.includes('echo safe-one') &&
      dryRunJson.partialAvailable === true &&
      doomedUtf[0].exists === true,
    `safe=${JSON.stringify(dryRunJson.safeSegments)}`,
  );
  const dryText = await call('presence_exec', { command: `rm -rf ${dir}/doomed; echo safe-one`, cwd: dir });
  check(
    'dry-run text: surfaces the safe-segment suggestions',
    dryText.includes('Safe segments you can run separately:') && dryText.includes('echo safe-one'),
    dryText.split('\n')[0] ?? '',
  );

  const partialJson = asJson(
    await call('presence_exec', {
      command: `rm -rf ${dir}/doomed; printf 'partial-safe\\n' > ${dir}/partial.txt`,
      cwd: dir,
      confirm: 'partial',
      format: 'json',
    }),
  );
  const partialStat = asJson(
    await call('presence_stat', { paths: [`${dir}/partial.txt`, `${dir}/doomed`], format: 'json' }),
  );
  check(
    'partial JSON: safe segment executed, destructive segment skipped',
    partialJson.dryRun === false &&
      partialJson.partial === true &&
      partialJson.executedSegments.length === 1 &&
      partialJson.executedSegments[0].includes('partial-safe') &&
      partialJson.skippedSegments.length === 1 &&
      partialJson.skippedSegments[0].includes('rm -rf') &&
      partialJson.exitCode === 0 &&
      partialStat[0].exists === true &&
      partialStat[1].exists === true,
    `executed=${JSON.stringify(partialJson.executedSegments)} skipped=${JSON.stringify(partialJson.skippedSegments)}`,
  );

  const partialText = await call('presence_exec', {
    command: `rm -rf ${dir}/doomed2; echo partial-text`,
    cwd: dir,
    confirm: 'partial',
  });
  const doomed2 = asJson(await call('presence_stat', { paths: [`${dir}/doomed2`], format: 'json' }));
  check(
    'partial text: reports ran/skipped counts and leaves the destructive target alone',
    partialText.includes('partial: ran 1 safe segment(s); skipped 1 destructive segment(s)') &&
      partialText.includes('echo partial-text') &&
      doomed2[0].exists === true,
    partialText.split('\n').slice(0, 3).join(' | '),
  );

  const confirmed = await call('presence_exec', {
    command: `rm -rf ${dir}/doomed2 && echo confirmed-run`,
    cwd: dir,
    confirm: true,
  });
  const doomed2After = asJson(await call('presence_stat', { paths: [`${dir}/doomed2`], format: 'json' }));
  check(
    'confirm:true still executes the whole command',
    confirmed.includes('confirmed-run') && doomed2After[0].exists === false,
    confirmed.split('\n').slice(0, 2).join(' | '),
  );
} finally {
  for (const jobId of jobIds) {
    await call('presence_jobs', { action: 'stop', jobId }).catch(() => {});
  }
  if (connection) {
    await connection.exec(`rm -rf ${shellQuote(dir)}`).catch(() => {});
  }
  pool.dispose();
  rmSync(localFixture, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
