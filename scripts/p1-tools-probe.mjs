// P1 tools probe for Presence 0.20.0 (contract: .scratch/feat-0.20/CONTRACTS-0.20.md).
//
//   node scripts/p1-tools-probe.mjs [alias]
//
// Covers the tools workstream against a real host:
//   - HOTFIX: a genuinely local session (cwd outside the mounts root) must throw
//     for a tool without an explicit host, even when workspaces.json has a
//     globally active remote workspace; settings.defaultHost is the opt-in;
//     a session whose cwd is a mount path uses the mounted host;
//   - presence_hosts: default is session-scoped (session workspace host, else
//     PRESENCE_HOST), never the global active workspace; workspace:true only for
//     the session's mounted host;
//   - presence_exec text header 'host: X  remote cwd: Y' (foreground and
//     background), existing argument aliases still work;
//   - presence_wait: file (waits for a file that appears later), grep, process,
//     port open/closed, job exit, timeout returns met:false (never throws),
//     condition validation;
//   - batch presence_export (paths[] + glob, basename default, sha8 collision)
//     and batch presence_import (paths[] + glob, per-file results, cwd-relative);
//   - presence_write mode:"append" (bytesAppended/total/sha256, creates a
//     missing file, keeps the mode, refuses ifMatchSha256), overwrite unchanged;
//   - tool count is 25 and every host parameter describes the session scope.
//
// src/tools.js imports @deepseek-ai/dsh-tools, which only exists inside the
// Harness runtime. A loader hook maps that specifier to an identity defineTool
// so the real implementations run here unchanged. Remote fixtures live in /tmp
// and are removed at the end; local fixtures and exports are removed too.

import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePool } from '../src/pool.js';
import { mountPathFor } from '../src/mounts.js';

const alias = process.argv[2] ?? 'server';
const stamp = Date.now();
const remoteDir = `/tmp/presence-p1tools-${stamp}`;

// ---------------------------------------------------------------- isolation
// The regression this hotfix fixes is exactly "a local session silently used the
// globally last-activated remote workspace". Point DSH_HOME at a throwaway
// directory that *does* contain such an active workspace, so the negative case
// is real rather than vacuous.
const fakeHome = mkdtempSync(join(tmpdir(), 'presence-p1tools-home-'));
process.env.DSH_HOME = fakeHome;
mkdirSync(join(fakeHome, 'presence'), { recursive: true });
writeFileSync(
  join(fakeHome, 'presence', 'workspaces.json'),
  `${JSON.stringify(
    {
      active: 'w-p1-global-active',
      items: [
        {
          id: 'w-p1-global-active',
          host: alias,
          path: '/tmp/presence-p1-global-active',
          title: 'global active',
          createdAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

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

const settings = {
  maxChannels: 8,
  connectTimeoutMs: 25_000,
  idleTimeoutMs: 900_000,
  readOnly: false,
  defaultHost: null,
};
const pool = new PresencePool(settings);
const { definePresenceTools } = await import('../src/tools.js');
const execCtx = { agent: null, signal: undefined };

const localCwd = 'D:\\tmp\\presence-p1-local-session';
const toolsOf = (definitions) => new Map(definitions.map((tool) => [tool.name, tool]));
// A genuinely local session: its cwd is not under the mounts root.
const localTools = toolsOf(definePresenceTools(pool, settings, { cwdOf: async () => localCwd }));
// The documented opt-in for local sessions.
const configuredTools = toolsOf(
  definePresenceTools(pool, { ...settings, defaultHost: alias }, { cwdOf: async () => localCwd }),
);
// A remote-workspace session: its cwd is the mount path for `alias`.
const mountCwd = mountPathFor(alias, remoteDir);
const mountedTools = toolsOf(definePresenceTools(pool, settings, { cwdOf: async () => mountCwd }));
// Plain probe tools: everything funnels through an explicit host.
const baseTools = toolsOf(definePresenceTools(pool, settings, { cwdOf: async () => null }));

const call = async (tools, name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool.execute({ host: alias, ...args }, execCtx);
};
/** No implicit host, for the local-session and mounted-session cases. */
const callRaw = async (tools, name, args = {}) => {
  const tool = tools.get(name);
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
const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const jobIds = new Set();
const exportedLocalFiles = [];
const localFixture = mkdtempSync(join(tmpdir(), 'presence-p1tools-local-'));
const startJob = async (command, label) => {
  const text = await call(baseTools, 'presence_exec', { command, cwd: remoteDir, background: true, label });
  const id = /job: (\S+)/.exec(text)?.[1] ?? null;
  if (id) jobIds.add(id);
  return { id, text };
};
const stopJob = async (id) => {
  if (!id) return;
  await call(baseTools, 'presence_jobs', { action: 'stop', jobId: id }).catch(() => {});
  jobIds.delete(id);
};

try {
  // ------------------------------------------------------------- fixtures
  const fixture = await call(baseTools, 'presence_exec', {
    command:
      `mkdir -p ${remoteDir}/exp/one ${remoteDir}/exp/two ${remoteDir}/exp/three && ` +
      `printf 'alpha\\n' > ${remoteDir}/alpha.txt && ` +
      `printf 'beta\\n' > ${remoteDir}/exp/one/beta.txt && ` +
      `printf 'gamma\\n' > ${remoteDir}/exp/two/gamma.txt && ` +
      `printf 'delta\\n' > ${remoteDir}/exp/two/delta.txt && ` +
      `printf 'dup-one\\n' > ${remoteDir}/exp/one/dup.txt && ` +
      `printf 'dup-two\\n' > ${remoteDir}/exp/three/dup.txt && ` +
      `printf 'ready one\\nready two\\n' > ${remoteDir}/ready.log`,
  });
  check('fixtures created', fixture.includes('exit: 0'), fixture.split('\n')[0]);

  // ------------------------------------------------------------- HOTFIX 1
  // A local session without a host must fail loudly instead of borrowing the
  // globally active workspace (which workspaces.json above deliberately has).
  const localExecError = await expectError(() => callRaw(localTools, 'presence_exec', { command: 'pwd' }));
  check(
    'hotfix: local session without host throws the explicit message',
    localExecError?.includes(`this session is local (cwd=${localCwd})`) &&
      localExecError.includes('pass an explicit host') &&
      localExecError.includes('Remote workspaces are not bound to this session; call presence_hosts first'),
    localExecError ?? 'no error',
  );
  const localReadError = await expectError(() => callRaw(localTools, 'presence_read', { path: '/tmp/x.txt' }));
  check(
    'hotfix: every scoped tool uses the same local-session error (presence_read)',
    localReadError?.includes('this session is local') && localReadError.includes('call presence_hosts first'),
    localReadError ?? 'no error',
  );

  // ------------------------------------------------------------- HOTFIX 2
  // settings.defaultHost is the documented opt-in for a local session.
  const configuredText = await callRaw(configuredTools, 'presence_exec', { command: 'printf "configured-ok"' });
  check(
    'hotfix: settings.defaultHost makes a local session work',
    configuredText.startsWith(`host: ${alias}  remote cwd: `) && configuredText.includes('configured-ok'),
    configuredText.split('\n')[0],
  );
  const configuredHosts = asJson(await callRaw(configuredTools, 'presence_hosts', { format: 'json' }));
  const configuredDefault = configuredHosts.filter((row) => row.default).map((row) => row.alias);
  check(
    'hotfix: hosts marks the configured host as default, not as a workspace',
    configuredDefault.length === 1 &&
      configuredDefault[0] === alias &&
      configuredHosts.find((row) => row.alias === alias)?.workspace === false,
    `defaults=${configuredDefault.join(',')}`,
  );
  const configuredHostsText = await callRaw(configuredTools, 'presence_hosts', {});
  check(
    'hotfix: hosts text prints the usable default with its origin',
    configuredHostsText.includes(`default: ${alias} (PRESENCE_HOST default)`),
    configuredHostsText.split('\n').at(-1),
  );

  // ------------------------------------------------------------- HOTFIX 3
  // The global active workspace must not leak into a session without one.
  const noScopeHosts = asJson(await callRaw(localTools, 'presence_hosts', { format: 'json' }));
  const noScopeHostsText = await callRaw(localTools, 'presence_hosts', {});
  check(
    'hotfix: hosts never defaults to the global active workspace',
    noScopeHosts.every((row) => row.default === false) &&
      noScopeHosts.every((row) => row.workspace === false) &&
      !/^default: /m.test(noScopeHostsText),
    `defaults=${noScopeHosts.filter((row) => row.default).length} workspaces=${noScopeHosts.filter((row) => row.workspace).length}`,
  );

  // ------------------------------------------------------------- HOTFIX 4
  // A session whose cwd is a mount path uses the mounted host and workspace.
  const mountedText = await callRaw(mountedTools, 'presence_exec', { command: 'pwd' });
  check(
    'hotfix: mounted session uses the mounted host and remote cwd',
    mountedText.split('\n')[0] === `host: ${alias}  remote cwd: ${remoteDir}` && mountedText.includes(remoteDir),
    mountedText.split('\n')[0],
  );
  const mountedHosts = asJson(await callRaw(mountedTools, 'presence_hosts', { format: 'json' }));
  const mountedRow = mountedHosts.find((row) => row.alias === alias);
  check(
    'hotfix: hosts marks the mounted host as default and workspace',
    mountedRow?.default === true && mountedRow?.workspace === true,
    `default=${mountedRow?.default} workspace=${mountedRow?.workspace}`,
  );
  const mountedHostsText = await callRaw(mountedTools, 'presence_hosts', {});
  check(
    'hotfix: hosts text names the session workspace machine',
    mountedHostsText.includes(`default: ${alias} (session workspace machine)`),
    mountedHostsText.split('\n').at(-1),
  );

  // ------------------------------------------------------------- exec header
  const execText = await call(baseTools, 'presence_exec', { command: 'echo p1-ok', cwd: remoteDir });
  check(
    'exec: text header is "host: <alias>  remote cwd: <abs>"',
    execText.split('\n')[0] === `host: ${alias}  remote cwd: ${remoteDir}` && execText.includes('p1-ok'),
    execText.split('\n')[0],
  );
  const execBackground = await call(baseTools, 'presence_exec', {
    command: 'sleep 30',
    cwd: remoteDir,
    background: true,
    label: 'p1-tools-header-job',
  });
  const backgroundJobId = /job: (\S+)/.exec(execBackground)?.[1] ?? null;
  if (backgroundJobId) jobIds.add(backgroundJobId);
  check(
    'exec: background text header is the same host/remote-cwd line',
    execBackground.split('\n')[0] === `host: ${alias}  remote cwd: ${remoteDir}`,
    execBackground.split('\n')[0],
  );
  const earlyExit = await call(baseTools, 'presence_exec', {
    command: 'exit 3',
    cwd: remoteDir,
    background: true,
    label: 'p1-tools-early-exit',
  });
  const earlyJobId = /job: (\S+)/.exec(earlyExit)?.[1] ?? null;
  if (earlyJobId) jobIds.add(earlyJobId);
  check(
    'exec: early-exit background report keeps the header line',
    earlyExit.split('\n')[0] === `host: ${alias}  remote cwd: ${remoteDir}`,
    earlyExit.split('\n')[0],
  );

  // ------------------------------------------------------------- aliases
  const readAlias = await call(baseTools, 'presence_read', { file_path: `${remoteDir}/alpha.txt` });
  check('aliases: presence_read still accepts file_path', readAlias.includes('alpha'), readAlias.split('\n')[0]);
  const execAlias = await call(baseTools, 'presence_exec', { command: 'pwd', workdir: remoteDir });
  check(
    'aliases: presence_exec still accepts workdir',
    execAlias.split('\n')[0] === `host: ${alias}  remote cwd: ${remoteDir}` && execAlias.includes(remoteDir),
    execAlias.split('\n')[1] ?? '',
  );
  const editAlias = asJson(
    await call(baseTools, 'presence_edit', {
      file_path: `${remoteDir}/alpha.txt`,
      oldString: 'alpha',
      newString: 'ALPHA',
      format: 'json',
    }),
  );
  check('aliases: presence_edit still accepts oldString/newString', editAlias.replaced === 1, `replaced=${editAlias.replaced}`);

  // ------------------------------------------------------------- presence_wait
  // file: a background command writes the file a few seconds later; the wait
  // must observe it appear rather than just seeing an existing file.
  const delayed = await startJob(`sleep 3; printf 'made\\n' > ${remoteDir}/appeared.txt`, 'p1-tools-delayed-file');
  check('wait: delayed-file job started', Boolean(delayed.id), delayed.id ?? delayed.text.split('\n')[0]);
  const waitFile = asJson(
    await call(baseTools, 'presence_wait', {
      file: { path: `${remoteDir}/appeared.txt`, minBytes: 1 },
      timeoutMs: 20_000,
      pollMs: 200,
      format: 'json',
    }),
  );
  check(
    'wait: file condition polls until the file appears',
    waitFile.met === true &&
      waitFile.timedOut === false &&
      waitFile.observed?.exists === true &&
      waitFile.elapsedMs >= 300 &&
      waitFile.polls >= 2 &&
      waitFile.condition?.kind === 'file',
    `met=${waitFile.met} elapsed=${waitFile.elapsedMs} probes=${waitFile.polls}`,
  );
  if (delayed.id) await stopJob(delayed.id);

  const waitFileText = await call(baseTools, 'presence_wait', {
    file: { path: `${remoteDir}/appeared.txt` },
    timeoutMs: 10_000,
  });
  check(
    'wait: text report is compact and names condition/observed',
    waitFileText.startsWith('wait: met after ') &&
      waitFileText.includes('condition: {"kind":"file"') &&
      waitFileText.includes('observed: '),
    waitFileText.split('\n')[0],
  );

  // grep: wait until at least N lines match.
  const waitGrep = asJson(
    await call(baseTools, 'presence_wait', {
      grep: { path: `${remoteDir}/ready.log`, pattern: '^ready', count: 2 },
      timeoutMs: 10_000,
      pollMs: 200,
      format: 'json',
    }),
  );
  check(
    'wait: grep condition matches the requested line count',
    waitGrep.met === true && waitGrep.observed?.matches >= 2,
    `met=${waitGrep.met} matches=${waitGrep.observed?.matches}`,
  );

  // process: a running job pid, and a pattern that is definitely absent.
  const sleeper = await startJob('sleep 30', 'p1-tools-sleeper');
  const sleeperStatus = asJson(await call(baseTools, 'presence_jobs', { action: 'status', jobId: sleeper.id, format: 'json' }));
  const waitProcess = asJson(
    await call(baseTools, 'presence_wait', {
      process: { pid: sleeperStatus.pid, alive: true },
      timeoutMs: 10_000,
      pollMs: 250,
      format: 'json',
    }),
  );
  check(
    'wait: process condition sees a live pid',
    waitProcess.met === true && waitProcess.observed?.alive === true,
    `met=${waitProcess.met} pid=${waitProcess.observed?.pid}`,
  );
  const waitAbsent = asJson(
    await call(baseTools, 'presence_wait', {
      process: { pid: 999_999_999, alive: false },
      timeoutMs: 10_000,
      pollMs: 250,
      format: 'json',
    }),
  );
  check(
    'wait: process condition met when the pid is gone',
    waitAbsent.met === true && waitAbsent.observed?.alive === false,
    `met=${waitAbsent.met} pid=${waitAbsent.observed?.pid} alive=${waitAbsent.observed?.alive}`,
  );
  // A pattern that no process carries: waiting for its absence must terminate.
  // (The probe itself runs the pattern through wait.js, so a self-matching
  // pgrep would hang here — this is the regression guard for that.)
  const waitPatternAbsent = asJson(
    await call(baseTools, 'presence_wait', {
      process: { pattern: `presence-p1-no-such-process-${stamp}`, alive: false },
      timeoutMs: 10_000,
      pollMs: 250,
      format: 'json',
    }),
  );
  check(
    'wait: process condition met when the pattern is absent',
    waitPatternAbsent.met === true &&
      waitPatternAbsent.observed?.alive === false &&
      waitPatternAbsent.observed?.matches === 0,
    `met=${waitPatternAbsent.met} matches=${waitPatternAbsent.observed?.matches}`,
  );

  // port: open while the server runs, closed after stopping it.
  const port = 41_000 + ((stamp + process.pid) % 15_000);
  const server = await startJob(`python3 -m http.server ${port} --bind 127.0.0.1`, 'p1-tools-http');
  const waitPort = asJson(
    await call(baseTools, 'presence_wait', {
      port: { port, state: 'open' },
      timeoutMs: 20_000,
      pollMs: 300,
      format: 'json',
    }),
  );
  check(
    'wait: port condition waits for a listening port',
    waitPort.met === true && waitPort.observed?.ready === true,
    `met=${waitPort.met} ready=${waitPort.observed?.ready}`,
  );
  await stopJob(server.id);
  const waitPortClosed = asJson(
    await call(baseTools, 'presence_wait', {
      port: { port, state: 'closed' },
      timeoutMs: 15_000,
      pollMs: 300,
      format: 'json',
    }),
  );
  check(
    'wait: port condition waits for the port to close',
    waitPortClosed.met === true && waitPortClosed.observed?.ready === false,
    `met=${waitPortClosed.met} ready=${waitPortClosed.observed?.ready}`,
  );

  // job: a short job must be observed as exited.
  const shortJob = await startJob('sleep 2', 'p1-tools-short-job');
  const waitJob = asJson(
    await call(baseTools, 'presence_wait', {
      job: { jobId: shortJob.id },
      timeoutMs: 20_000,
      pollMs: 250,
      format: 'json',
    }),
  );
  check(
    'wait: job condition met when the job exits',
    waitJob.met === true && waitJob.observed?.state === 'exited',
    `met=${waitJob.met} state=${waitJob.observed?.state}`,
  );
  await stopJob(shortJob.id);

  // timeout: met:false is data, never an error.
  let timeoutThrew = null;
  let waitTimeout = null;
  try {
    waitTimeout = asJson(
      await call(baseTools, 'presence_wait', {
        file: { path: `${remoteDir}/never-appears.txt` },
        timeoutMs: 700,
        pollMs: 100,
        format: 'json',
      }),
    );
  } catch (error) {
    timeoutThrew = String(error?.message ?? error);
  }
  check(
    'wait: timeout returns met:false (no throw)',
    timeoutThrew === null &&
      waitTimeout?.met === false &&
      waitTimeout.timedOut === true &&
      waitTimeout.elapsedMs >= 600 &&
      waitTimeout.observed !== null,
    timeoutThrew ?? `met=${waitTimeout?.met} timedOut=${waitTimeout?.timedOut} elapsed=${waitTimeout?.elapsedMs}`,
  );

  // condition validation: exactly one condition, and useful field errors.
  const twoConditions = await expectError(() =>
    call(baseTools, 'presence_wait', {
      file: { path: `${remoteDir}/alpha.txt` },
      port: { port: 1, state: 'closed' },
      timeoutMs: 500,
    }),
  );
  const noCondition = await expectError(() => call(baseTools, 'presence_wait', { timeoutMs: 500 }));
  const badProcess = await expectError(() =>
    call(baseTools, 'presence_wait', { process: { pid: 1, pattern: 'sh' }, timeoutMs: 500 }),
  );
  check(
    'wait: validates exactly-one-condition and field errors',
    twoConditions?.includes('exactly one condition, got file, port') &&
      noCondition?.includes('needs exactly one condition') &&
      badProcess?.includes('exactly one of pid or pattern'),
    [twoConditions, noCondition, badProcess].map((value) => (value ?? 'no error').slice(0, 40)).join(' | '),
  );

  // ------------------------------------------------------------- batch export
  const exportJson = asJson(
    await call(baseTools, 'presence_export', {
      paths: [`${remoteDir}/exp/one/beta.txt`, `${remoteDir}/exp/two/gamma.txt`],
      glob: `${remoteDir}/exp/two/*.txt`,
      format: 'json',
    }),
  );
  exportedLocalFiles.push(...exportJson.files.map((row) => row.localPath));
  const exportNames = exportJson.files.map((row) => row.localPath.split(/[\\/]/).pop()).sort();
  const exportedByName = new Map(
    exportJson.files.map((row) => [row.localPath.split(/[\\/]/).pop(), row]),
  );
  const expectedExports = {
    'beta.txt': 'beta\n',
    'delta.txt': 'delta\n',
    'gamma.txt': 'gamma\n',
  };
  check(
    'export batch: paths[] + glob exported every file into the export folder',
    exportJson.exported === 3 &&
      exportJson.failed === 0 &&
      exportJson.files.length === 3 &&
      exportNames.join(',') === 'beta.txt,delta.txt,gamma.txt' &&
      Object.entries(expectedExports).every(([name, content]) => {
        const row = exportedByName.get(name);
        if (!content) return true;
        return row && row.bytes === Buffer.byteLength(content) && row.sha256 === sha256(content);
      }),
    `exported=${exportJson.exported} names=${exportNames.join(',')}`,
  );
  const betaRow = exportedByName.get('beta.txt');
  check(
    'export batch: local file has the remote bytes and sha256',
    readFileSync(betaRow.localPath, 'utf8') === 'beta\n' && betaRow.sha256 === sha256('beta\n'),
    betaRow.localPath,
  );
  const singleExportText = await call(baseTools, 'presence_export', { path: `${remoteDir}/alpha.txt` });
  const singleExportPath = /local file: (.+)$/m.exec(singleExportText)?.[1] ?? '';
  if (singleExportPath) exportedLocalFiles.push(singleExportPath.trim());
  check(
    'export single: keeps the text report and the basename default',
    singleExportText.includes(`exported 6 bytes from ${remoteDir}/alpha.txt on ${alias}`) &&
      singleExportPath.trim().endsWith('alpha.txt') &&
      readFileSync(singleExportPath.trim(), 'utf8') === 'ALPHA\n',
    singleExportPath.trim(),
  );
  // The first alpha.txt is already in the export folder, so this one gets -<sha8>.
  const collidedText = await call(baseTools, 'presence_export', { path: `${remoteDir}/alpha.txt` });
  const collidedPath = /local file: (.+)$/m.exec(collidedText)?.[1] ?? '';
  if (collidedPath) exportedLocalFiles.push(collidedPath.trim());
  check(
    'export single: an occupied basename gets the -<sha8> suffix',
    /alpha-[0-9a-f]{8}\.txt$/.test(collidedPath.trim()) && readFileSync(collidedPath.trim(), 'utf8') === 'ALPHA\n',
    collidedPath.trim(),
  );
  // Two different remote files with the same basename in one batch must not
  // overwrite each other locally.
  const dupJson = asJson(
    await call(baseTools, 'presence_export', {
      paths: [`${remoteDir}/exp/one/dup.txt`, `${remoteDir}/exp/three/dup.txt`],
      format: 'json',
    }),
  );
  exportedLocalFiles.push(...dupJson.files.map((row) => row.localPath));
  const dupNames = dupJson.files.map((row) => row.localPath.split(/[\\/]/).pop());
  check(
    'export batch: same-basename files are disambiguated',
    dupJson.files.length === 2 &&
      dupNames[0] === 'dup.txt' &&
      /^dup-[0-9a-f]{8}\.txt$/.test(dupNames[1]) &&
      readFileSync(dupJson.files[0].localPath, 'utf8') !== readFileSync(dupJson.files[1].localPath, 'utf8'),
    dupNames.join(','),
  );
  const exportAlias = await call(baseTools, 'presence_export', { file_path: `${remoteDir}/ready.log` });
  const exportAliasPath = /local file: (.+)$/m.exec(exportAlias)?.[1] ?? '';
  if (exportAliasPath) exportedLocalFiles.push(exportAliasPath.trim());
  check(
    'export: file_path alias still works',
    exportAlias.includes('exported 20 bytes from') && exportAliasPath.trim().endsWith('ready.log'),
    exportAliasPath.trim(),
  );

  // ------------------------------------------------------------- batch import
  mkdirSync(join(localFixture, 'nested'), { recursive: true });
  writeFileSync(join(localFixture, 'one.txt'), 'first local\n', 'utf8');
  writeFileSync(join(localFixture, 'two.txt'), 'second local\n', 'utf8');
  writeFileSync(join(localFixture, 'nested', 'three.txt'), 'third local\n', 'utf8');
  const originalCwd = process.cwd();
  process.chdir(localFixture);
  let importJson;
  try {
    importJson = asJson(
      await call(baseTools, 'presence_import', {
        paths: ['one.txt', 'two.txt'],
        glob: 'nested/*.txt',
        to: `${remoteDir}/imported`,
        format: 'json',
      }),
    );
  } finally {
    process.chdir(originalCwd);
  }
  const importedNames = importJson.files.map((row) => row.remotePath.split('/').pop()).sort();
  const importedStat = asJson(
    await call(baseTools, 'presence_stat', {
      paths: importJson.files.map((row) => row.remotePath),
      hash: true,
      format: 'json',
    }),
  );
  const importStatByPath = new Map(importedStat.map((row) => [row.path, row]));
  check(
    'import batch: cwd-relative paths[] + glob upload every file',
    importJson.imported === 3 &&
      importJson.failed === 0 &&
      importedNames.join(',') === 'one.txt,three.txt,two.txt' &&
      importJson.files.every((row) => row.remotePath.startsWith(`${remoteDir}/imported/`)),
    `imported=${importJson.imported} names=${importedNames.join(',')}`,
  );
  check(
    'import batch: remote bytes and sha256 match the local files',
    importJson.files.every((row) => {
      const stat = importStatByPath.get(row.remotePath);
      const localBytes = readFileSync(row.localPath);
      return (
        stat?.exists === true &&
        stat.sha256 === sha256(localBytes) &&
        stat.sizeBytes === localBytes.length &&
        row.sizeBytes === localBytes.length
      );
    }),
    importedStat.map((row) => `${row.path.split('/').pop()}:${row.sizeBytes}`).join(','),
  );
  const twoRead = await call(baseTools, 'presence_read', { path: `${remoteDir}/imported/two.txt`, raw: true });
  check(
    'import batch: the uploaded content is intact',
    twoRead === 'second local\n',
    JSON.stringify(twoRead),
  );
  // A batch name collision inside one call also gets -<sha8>.
  mkdirSync(join(localFixture, 'dup-a'), { recursive: true });
  mkdirSync(join(localFixture, 'dup-b'), { recursive: true });
  writeFileSync(join(localFixture, 'dup-a', 'same.txt'), 'same-a\n', 'utf8');
  writeFileSync(join(localFixture, 'dup-b', 'same.txt'), 'same-b\n', 'utf8');
  const dupImport = asJson(
    await call(baseTools, 'presence_import', {
      paths: [join(localFixture, 'dup-a', 'same.txt'), join(localFixture, 'dup-b', 'same.txt')],
      to: `${remoteDir}/imported-dup`,
      format: 'json',
    }),
  );
  const dupImportNames = dupImport.files.map((row) => row.remotePath.split('/').pop());
  check(
    'import batch: same-basename local files are disambiguated remotely',
    dupImport.files.length === 2 &&
      dupImportNames[0] === 'same.txt' &&
      /^same-[0-9a-f]{8}\.txt$/.test(dupImportNames[1]),
    dupImportNames.join(','),
  );
  // Single-file behavior is unchanged (same JSON shape as 0.19.0).
  writeFileSync(join(localFixture, 'single.txt'), 'single payload\n', 'utf8');
  const singleImport = asJson(
    await call(baseTools, 'presence_import', {
      source: join(localFixture, 'single.txt'),
      to: `${remoteDir}/single/single.txt`,
      format: 'json',
    }),
  );
  check(
    'import single: keeps the 0.19.0 JSON shape',
    singleImport.remotePath === `${remoteDir}/single/single.txt` &&
      singleImport.localPath === join(localFixture, 'single.txt') &&
      singleImport.sizeBytes === 15 &&
      singleImport.sha256 === sha256('single payload\n') &&
      singleImport.mode === '0644' &&
      singleImport.files === undefined,
    `size=${singleImport.sizeBytes} mode=${singleImport.mode}`,
  );
  const filePathImport = asJson(
    await call(baseTools, 'presence_import', {
      source: join(localFixture, 'single.txt'),
      to_path: `${remoteDir}/single/to-path.txt`,
      format: 'json',
    }),
  );
  check(
    'import: to_path alias still works',
    filePathImport.remotePath === `${remoteDir}/single/to-path.txt`,
    filePathImport.remotePath,
  );

  // ------------------------------------------------------------- append mode
  await call(baseTools, 'presence_write', { path: `${remoteDir}/append.txt`, content: 'one\n' });
  const appended = asJson(
    await call(baseTools, 'presence_write', {
      path: `${remoteDir}/append.txt`,
      content: 'two\n',
      mode: 'append',
      format: 'json',
    }),
  );
  const appendedText = await call(baseTools, 'presence_read', { path: `${remoteDir}/append.txt`, raw: true });
  check(
    'write append: bytesAppended, total size and resulting sha256',
    appended.writeMode === 'append' &&
      appended.bytesAppended === 4 &&
      appended.sizeBytes === 8 &&
      appended.sha256 === sha256('one\ntwo\n') &&
      appendedText === 'one\ntwo\n',
    `appended=${appended.bytesAppended} total=${appended.sizeBytes} file=${JSON.stringify(appendedText)}`,
  );
  const appendCreated = asJson(
    await call(baseTools, 'presence_write', {
      path: `${remoteDir}/append-new.txt`,
      content: 'created by append\n',
      mode: 'append',
      format: 'json',
    }),
  );
  check(
    'write append: creates a missing file',
    appendCreated.sizeBytes === 18 && appendCreated.sha256 === sha256('created by append\n'),
    `size=${appendCreated.sizeBytes}`,
  );
  await call(baseTools, 'presence_write', {
    path: `${remoteDir}/append-sh.sh`,
    content: '#!/bin/sh\n',
    mode: '755',
  });
  const appendMode = asJson(
    await call(baseTools, 'presence_write', {
      path: `${remoteDir}/append-sh.sh`,
      content: 'echo hi\n',
      mode: 'append',
      format: 'json',
    }),
  );
  const appendModeStat = asJson(
    await call(baseTools, 'presence_stat', { paths: [`${remoteDir}/append-sh.sh`], format: 'json' }),
  );
  check(
    'write append: keeps the existing mode (executable stays executable)',
    appendMode.mode === '0755' && appendModeStat[0].mode === '0755',
    `json=${appendMode.mode} stat=${appendModeStat[0].mode}`,
  );
  const appendLock = await expectError(() =>
    call(baseTools, 'presence_write', {
      path: `${remoteDir}/append.txt`,
      content: 'x',
      mode: 'append',
      ifMatchSha256: sha256('one\ntwo\n'),
    }),
  );
  check(
    'write append: ifMatchSha256 is refused (overwrite-only)',
    appendLock?.includes('only valid for an overwrite'),
    appendLock ?? 'no error',
  );
  const overwriteOctal = asJson(
    await call(baseTools, 'presence_write', {
      path: `${remoteDir}/append.txt`,
      content: 'reset\n',
      mode: '644',
      format: 'json',
    }),
  );
  check(
    'write overwrite: an octal mode string still sets the mode',
    overwriteOctal.mode === '0644' && overwriteOctal.sizeBytes === 6 && overwriteOctal.sha256 === sha256('reset\n'),
    `mode=${overwriteOctal.mode} size=${overwriteOctal.sizeBytes}`,
  );
  const stagingLeft = await call(baseTools, 'presence_exec', {
    command: `find ${remoteDir} -maxdepth 1 -name '.presence-append-*' | wc -l`,
    cwd: remoteDir,
  });
  check(
    'write append: staging file is removed',
    /(?:^|\n)0(?:\n|$)/.test(stagingLeft),
    stagingLeft.split('\n').find((line) => line.trim() !== '') ?? '',
  );

  // ------------------------------------------------------------- jobs fields
  const jobsJson = asJson(await call(baseTools, 'presence_jobs', { action: 'list', format: 'json' }));
  const jobRow = jobsJson.find((row) => row.id === sleeper.id) ?? jobsJson[0] ?? null;
  check(
    'jobs: JSON rows carry pgid/commandLogPath/persisted (defensive)',
    Boolean(jobRow) &&
      Object.prototype.hasOwnProperty.call(jobRow, 'pgid') &&
      Object.prototype.hasOwnProperty.call(jobRow, 'commandLogPath') &&
      typeof jobRow.persisted === 'boolean' &&
      Object.prototype.hasOwnProperty.call(jobRow, 'pid'),
    Object.keys(jobRow ?? {}).join(','),
  );
  await stopJob(sleeper.id);
  if (backgroundJobId) await stopJob(backgroundJobId);
  if (earlyJobId) await stopJob(earlyJobId);

  // ------------------------------------------------------------- tool surface
  check(
    'tools: exactly 25 tools are defined',
    baseTools.size === 25 && localTools.size === 25,
    `count=${baseTools.size}`,
  );
  const toolNames = [...baseTools.keys()];
  check(
    'tools: presence_wait is present and names are unique',
    toolNames.includes('presence_wait') && new Set(toolNames).size === toolNames.length,
    `${toolNames.length} names`,
  );
  // presence_connect needs an explicit alias and presence_jobs{host} targets a
  // raw process group, so neither is a pickScope host default.
  const hostParams = [...baseTools.values()].filter(
    (tool) => tool.parameters?.host && !['presence_connect', 'presence_jobs'].includes(tool.name),
  );
  const scopedHostParams = hostParams.filter((tool) =>
    String(tool.parameters.host.description ?? '').includes('local session must pass host'),
  );
  check(
    'tools: every host parameter describes the session scope',
    hostParams.length > 0 &&
      scopedHostParams.length === hostParams.length &&
      [...baseTools.values()].every((tool) =>
        [tool.description ?? '', JSON.stringify(tool.parameters ?? {})].every(
          (value) => !value.includes("active workspace's machine"),
        ),
      ),
    `${scopedHostParams.length}/${hostParams.length} host params`,
  );
} finally {
  for (const id of [...jobIds]) await stopJob(id);
  await call(baseTools, 'presence_exec', { command: `rm -rf ${remoteDir}`, confirm: true }).catch(() => {});
  for (const path of exportedLocalFiles) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
  rmSync(localFixture, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  pool.dispose();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
