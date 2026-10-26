// Tool-level probe for the 0.17.5 tool-UX round: presence_stat,
// presence_port_probe, presence_http_probe and the JSON return shapes of the
// older tools. Plain Node against a real host.
//
//   node scripts/tool-probe.mjs [alias]
//
// src/tools.js imports @deepseek-ai/dsh-tools, which only exists inside the
// Harness runtime. A tiny loader hook maps that specifier to an identity
// `defineTool`, so the real tool implementations (and their arguments, text and
// JSON shapes) run here unchanged.
//
// Everything it creates lives in /tmp on the remote machine and is removed at
// the end; the local temp file is removed too.

import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePool } from '../src/pool.js';

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
// The hook runs in its own thread; a data: URL keeps this file self-contained.
register(`data:text/javascript,${encodeURIComponent(hookSource)}`);

const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
const pool = new PresencePool(settings);
const { definePresenceTools } = await import('../src/tools.js');
const tools = new Map(
  definePresenceTools(pool, settings, { cwdOf: async () => null }).map((tool) => [tool.name, tool]),
);
const exec = {};
const call = (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool.execute({ host: alias, ...args }, exec);
};
const asJson = (value) => JSON.parse(value);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Read terminal output until `marker` shows up (the shell may still be starting). */
async function readTerminalUntil(terminalId, marker, { attempts = 15, waitMs = 400 } = {}) {
  let output = '';
  for (let index = 0; index < attempts && !output.includes(marker); index += 1) {
    const chunk = asJson(
      await call('presence_terminal', { action: 'read', terminalId, waitMs, format: 'json' }),
    ).output ?? '';
    output += chunk;
  }
  return output;
}

const stamp = Date.now();
const dir = `/tmp/presence-toolprobe-${stamp}`;
// A high port range keeps this probe clear of the other probes' fixed ports.
const serverPort = 20000 + ((stamp + process.pid) % 20000);
const localFixture = mkdtempSync(join(tmpdir(), 'presence-toolprobe-'));
let serverJob = null;
let sleepJob = null;
let terminalId = null;

try {
  // ---------------------------------------------------------------- fixtures
  await call('presence_exec', {
    command:
      `mkdir -p ${dir}/sub && ` +
      `printf 'first needle line\\nsecond needle line\\n' > ${dir}/single.txt && ` +
      `printf 'tool-probe-ok\\n' > ${dir}/index.html && ` +
      `printf 'sub-body\\n' > ${dir}/sub/a.txt && ` +
      `printf 'doomed\\n' > ${dir}/doomed.txt && ln -s ${dir}/single.txt ${dir}/link.txt`,
  });

  // -------------------------------------------------------------- stat/json
  const statArgs = {
    paths: [dir, `${dir}/single.txt`, `${dir}/missing.txt`, `${dir}/link.txt`],
    hash: true,
    format: 'json',
  };
  const statJson = asJson(await call('presence_stat', statArgs));
  const [dirRow, fileRow, missingRow, linkRow] = statJson;
  const localDigest = createHash('sha256').update('first needle line\nsecond needle line\n').digest('hex');
  check(
    'stat json: dir/file/missing/link rows',
    statJson.length === 4 &&
      dirRow.type === 'dir' &&
      fileRow.type === 'file' &&
      missingRow.exists === false &&
      missingRow.type === 'missing' &&
      linkRow.type === 'link',
    `types=${statJson.map((row) => row.type).join(',')}`,
  );
  check(
    'stat json: size, mode and sha256 match the file',
    fileRow.sizeBytes === 37 &&
      /^0[0-7]{3}$/.test(String(fileRow.mode)) &&
      fileRow.sha256 === localDigest &&
      Number.isFinite(fileRow.mtimeMs) &&
      typeof fileRow.mtimeISO === 'string',
    `size=${fileRow.sizeBytes} mode=${fileRow.mode} sha=${String(fileRow.sha256).slice(0, 12)}…`,
  );
  check(
    'stat json: a symlink is described, not hashed or followed',
    linkRow.exists === true && linkRow.sha256 === null,
    `sha256=${linkRow.sha256}`,
  );
  const statText = await call('presence_stat', { paths: [dir, `${dir}/missing.txt`], host: alias });
  check(
    'stat text: table plus found/missing summary',
    statText.includes('path\ttype\tsize\tmode\tmtime') && statText.includes('1 found, 1 missing'),
    statText.split('\n').at(-1),
  );

  // -------------------------------------------------------------- port probe
  const closedJson = asJson(await call('presence_port_probe', { ports: [1], expect: 'closed', format: 'json' }));
  check(
    'port_probe json: closed port matches expect=closed',
    closedJson.length === 1 && closedJson[0].listening === false && closedJson[0].ok === true,
    JSON.stringify(closedJson[0]),
  );

  const serverText = await call('presence_exec', {
    command: `python3 -m http.server ${serverPort} --bind 127.0.0.1`,
    cwd: dir,
    background: true,
    label: 'tool-probe-http',
  });
  serverJob = /job: (\S+)/.exec(serverText)?.[1] ?? null;
  check('port_probe setup: http server job started', Boolean(serverJob), serverJob ?? serverText);

  const openJson = asJson(
    await call('presence_port_probe', { ports: [serverPort], expect: 'open', waitMs: 8000, format: 'json' }),
  );
  const openRow = openJson[0];
  check(
    'port_probe json: waits for the server and reports pid/process',
    openRow.ok === true &&
      openRow.listening === true &&
      openRow.probe === 'accepted' &&
      Number.isInteger(openRow.pid) &&
      String(openRow.process ?? '').includes('python'),
    `listening=${openRow.listening} pid=${openRow.pid} process=${openRow.process} probe=${openRow.probe}`,
  );

  // -------------------------------------------------------------- http probe
  const httpJson = asJson(
    await call('presence_http_probe', {
      remotePort: serverPort,
      paths: ['/', '/sub/a.txt'],
      expectStatus: [200],
      expectBody: ['tool-probe-ok', 'sub-body'],
      format: 'json',
    }),
  );
  check(
    'http_probe json: pass, body match, tunnel closed and port released',
    httpJson.pass === true &&
      httpJson.results.length === 2 &&
      httpJson.results.every((row) => row.status === 200) &&
      httpJson.portReleased === true,
    `pass=${httpJson.pass} released=${httpJson.portReleased} forward=${httpJson.forwardId}`,
  );
  const forwardList = asJson(await call('presence_forward', { action: 'list', format: 'json' }));
  check(
    'http_probe: the temporary forward is gone from the forward list',
    Array.isArray(forwardList) && !forwardList.some((tunnel) => tunnel.localPort === httpJson.localPort),
    `forwards=${forwardList.length}`,
  );

  const failingJson = asJson(
    await call('presence_http_probe', {
      remotePort: serverPort,
      paths: ['/'],
      expectStatus: [404],
      format: 'json',
    }),
  );
  check(
    'http_probe json: a wrong expectation yields pass=false but still cleans up',
    failingJson.pass === false && failingJson.portReleased === true,
    `pass=${failingJson.pass} released=${failingJson.portReleased}`,
  );

  // ------------------------------------------------------------ jobs format
  const runningStatus = asJson(await call('presence_jobs', { action: 'status', jobId: serverJob, format: 'json' }));
  check(
    'jobs status json: running job has exitSummary=null',
    runningStatus.state === 'running' && runningStatus.exitSummary === null,
    `state=${runningStatus.state} exitSummary=${runningStatus.exitSummary}`,
  );

  const stopped = asJson(
    await call('presence_jobs', { action: 'stop', jobId: serverJob, port: serverPort, format: 'json' }),
  );
  check(
    'jobs stop json: stop plus portReleased',
    stopped.stopped === true && stopped.portReleased === true,
    `stopped=${stopped.stopped} portReleased=${stopped.portReleased}`,
  );
  const releasedJson = asJson(
    await call('presence_port_probe', { ports: [serverPort], expect: 'closed', waitMs: 5000, format: 'json' }),
  );
  check(
    'port_probe json: the stopped server really released its port',
    releasedJson[0].ok === true && releasedJson[0].listening === false,
    `probe=${releasedJson[0].probe} listening=${releasedJson[0].listening}`,
  );

  sleepJob = /job: (\S+)/.exec(
    await call('presence_exec', { command: 'sleep 30', cwd: dir, background: true, label: 'tool-probe-sleep' }),
  )?.[1];
  const waitJson = asJson(
    await call('presence_jobs', { action: 'wait', jobId: sleepJob, timeoutMs: 500, format: 'json' }),
  );
  check(
    'jobs wait json: timedOut=true and no exit yet',
    waitJson.timedOut === true && waitJson.exitSummary === null && waitJson.state !== 'exited',
    `state=${waitJson.state} timedOut=${waitJson.timedOut}`,
  );

  // ------------------------------------------------------- older JSON shapes
  const hostsJson = asJson(await call('presence_hosts', { format: 'json' }));
  const hostRow = hostsJson.find((row) => row.alias === alias);
  check(
    'list_hosts json: alias/address/source/state/default',
    Boolean(hostRow) &&
      hostRow.address.endsWith(`${hostRow.hostname}:${hostRow.port}`) &&
      hostRow.state === 'connected' &&
      hostRow.connected === true &&
      typeof hostRow.default === 'boolean',
    `state=${hostRow?.state} default=${hostRow?.default}`,
  );

  const connectJson = asJson(await call('presence_connect', { format: 'json' }));
  check(
    'connect json: parsed identity + connectedAtMs',
    connectJson.host === alias &&
      typeof connectJson.user === 'string' &&
      connectJson.platform === 'Linux' &&
      Number.isFinite(connectJson.connectedAtMs),
    `${connectJson.user}@${connectJson.hostname} ${connectJson.platform} ${connectJson.kernel} ${connectJson.arch}`,
  );

  const searchJson = asJson(
    await call('presence_search', { pattern: 'needle', path: dir, format: 'json' }),
  );
  check(
    'search json: pattern/root/matchCount/matches',
    searchJson.pattern === 'needle' &&
      searchJson.root === dir &&
      searchJson.matchCount === 2 &&
      searchJson.matches.length === 2 &&
      searchJson.matches[0].file.endsWith('/single.txt') &&
      searchJson.matches[0].line === 1 &&
      searchJson.matches[0].text.includes('needle'),
    `matchCount=${searchJson.matchCount}`,
  );

  const globJson = asJson(await call('presence_glob', { pattern: '*.txt', path: dir, format: 'json' }));
  const globRow = globJson.find((row) => row.path.endsWith('/single.txt'));
  check(
    'glob json: absolute paths with size/mtime',
    Boolean(globRow) &&
      globRow.path === `${dir}/single.txt` &&
      globRow.sizeBytes === 37 &&
      Number.isFinite(globRow.mtimeMs) &&
      typeof globRow.mtimeISO === 'string',
    `files=${globJson.length}`,
  );

  // ------------------------------------------------------------- write/edit
  const written = asJson(
    await call('presence_write', { path: `${dir}/lock.txt`, content: 'version one\n', format: 'json' }),
  );
  const writtenDigest = createHash('sha256').update('version one\n').digest('hex');
  check(
    'write json: full sha256 + mode',
    written.sha256 === writtenDigest && written.mode === '0644' && written.sizeBytes === 12,
    `sha=${written.sha256.slice(0, 12)}… mode=${written.mode}`,
  );
  let lockError = null;
  try {
    await call('presence_write', {
      path: `${dir}/lock.txt`,
      content: 'stale overwrite\n',
      ifMatchSha256: 'f'.repeat(64),
    });
  } catch (error) {
    lockError = error.message;
  }
  const lockAfter = asJson(await call('presence_stat', { paths: [`${dir}/lock.txt`], hash: true, format: 'json' }));
  check(
    'write ifMatchSha256: mismatch reports both hashes and writes nothing',
    lockError?.includes('f'.repeat(64)) && lockError.includes(writtenDigest) && lockAfter[0].sha256 === writtenDigest,
    (lockError ?? 'no error').slice(0, 80),
  );
  const matched = asJson(
    await call('presence_write', {
      path: `${dir}/lock.txt`,
      content: 'version two\n',
      ifMatchSha256: writtenDigest,
      format: 'json',
    }),
  );
  check('write ifMatchSha256: matching hash writes', matched.sizeBytes === 12, `size=${matched.sizeBytes}`);

  const editDry = asJson(
    await call('presence_edit', {
      path: `${dir}/lock.txt`,
      old: 'version two',
      new: 'version two expanded',
      dryRun: true,
      format: 'json',
    }),
  );
  check(
    'edit dryRun json: actual vs projected size',
    editDry.dryRun === true &&
      editDry.actualSizeBytes === 12 &&
      editDry.projectedSizeBytes === 21 &&
      editDry.sizeBytes === 12,
    `actual=${editDry.actualSizeBytes} projected=${editDry.projectedSizeBytes} size=${editDry.sizeBytes}`,
  );
  const editDryText = await call('presence_edit', {
    path: `${dir}/lock.txt`,
    old: 'version two',
    new: 'version two expanded',
    dryRun: true,
  });
  check(
    'edit dryRun text: "dry run: X B → Y B projected"',
    editDryText.includes('dry run: 12 B → 21 B projected'),
    editDryText.split('\n')[0],
  );
  const editReal = asJson(
    await call('presence_edit', {
      path: `${dir}/lock.txt`,
      old: 'version two',
      new: 'version two expanded',
      format: 'json',
    }),
  );
  check('edit json: sizeBytes is the written size', editReal.sizeBytes === 21, `size=${editReal.sizeBytes}`);

  // ---------------------------------------------------------- exec dry run
  const dryRun = asJson(await call('presence_exec', { command: `rm -rf ${dir}/doomed.txt`, format: 'json' }));
  const doomed = asJson(await call('presence_stat', { paths: [`${dir}/doomed.txt`], format: 'json' }));
  check(
    'exec destructive json: dryRun/requiresConfirm/targets/report, nothing deleted',
    dryRun.dryRun === true &&
      dryRun.requiresConfirm === true &&
      dryRun.targets.some((target) => target.path === `${dir}/doomed.txt`) &&
      dryRun.report.includes('nothing was executed yet') &&
      !dryRun.report.includes('\uFFFD') &&
      doomed[0].exists === true,
    `targets=${dryRun.targets.length} report=${JSON.stringify(dryRun.report.split('\n')[0])}`,
  );

  // ---------------------------------------------------------------- trash
  const trashBase = `toolprobe-${stamp}`;
  await call('presence_exec', {
    command: `printf 'a\\n' > ${dir}/${trashBase}-t1.txt; printf 'b\\n' > ${dir}/${trashBase}-t2.txt`,
  });
  const batch = asJson(
    await call('presence_trash', {
      action: 'trash',
      paths: [`${dir}/${trashBase}-t1.txt`, `${dir}/${trashBase}-t2.txt`],
      format: 'json',
    }),
  );
  check(
    'trash json: paths[] batch reports each result',
    batch.results.length === 2 && batch.trashed === 2 && batch.failed === 0,
    `trashed=${batch.trashed} failed=${batch.failed}`,
  );
  const trashedList = asJson(
    await call('presence_trash', { action: 'list', path: trashBase, format: 'json' }),
  );
  check(
    'trash list json: one time field (movedAtISO)',
    trashedList.length === 2 &&
      trashedList.every(
        (row) =>
          Object.keys(row).sort().join(',') === 'movedAtISO,name,trashPath' && typeof row.movedAtISO === 'string',
      ),
    trashedList.map((row) => Object.keys(row).join('+')).join(' | '),
  );
  for (const row of trashedList) {
    await call('presence_trash', { action: 'restore', trashPath: row.trashPath, to: `${dir}/${row.name}` });
  }

  // -------------------------------------------------------------- terminal
  const opened = asJson(
    await call('presence_terminal', {
      action: 'open',
      cwd: dir,
      command: 'bash',
      format: 'json',
    }),
  );
  terminalId = opened.terminalId;
  check(
    'terminal open json: terminalId/host/cwd/shell',
    Boolean(opened.terminalId) && opened.host === alias && opened.cwd === dir && opened.shell === 'bash',
    `${opened.terminalId} cwd=${opened.cwd}`,
  );
  const wrote = asJson(
    await call('presence_terminal', {
      action: 'write',
      terminalId,
      data: 'echo TPROBE-$((6*7))\n',
      format: 'json',
    }),
  );
  // The echoed command contains "TPROBE-$((6*7))", never "TPROBE-42": finding the
  // evaluated marker proves the shell actually ran and its output came back.
  let readBack = wrote.output ?? '';
  if (!String(readBack).includes('TPROBE-42')) {
    readBack += await readTerminalUntil(terminalId, 'TPROBE-42');
  }
  check(
    'terminal write/read json: command output is returned, not swallowed',
    wrote.writtenBytes > 0 && String(readBack).includes('TPROBE-42'),
    JSON.stringify(String(readBack).slice(-80)),
  );
  const ackOnly = asJson(
    await call('presence_terminal', {
      action: 'write',
      terminalId,
      data: 'echo ACK-ONLY\n',
      ackOnly: true,
      format: 'json',
    }),
  );
  check(
    'terminal write ackOnly json: output stays for read',
    ackOnly.output === null && Boolean(ackOnly.terminalId),
    JSON.stringify(ackOnly),
  );
  const closed = asJson(await call('presence_terminal', { action: 'close', terminalId, format: 'json' }));
  terminalId = null;
  check('terminal close json: closed=true', closed.closed === true, JSON.stringify(closed));

  // ----------------------------------------------------------------- import
  const localFile = join(localFixture, 'upload.txt');
  writeFileSync(localFile, 'imported payload\n', 'utf8');
  const imported = asJson(
    await call('presence_import', { source: localFile, to: `${dir}/upload.txt`, format: 'json' }),
  );
  check(
    'import json: full sha256 + mode + paths',
    imported.sha256 === createHash('sha256').update('imported payload\n').digest('hex') &&
      imported.remotePath === `${dir}/upload.txt` &&
      imported.localPath === localFile &&
      imported.sizeBytes === 17 &&
      imported.mode === '0644',
    `sha=${String(imported.sha256).slice(0, 12)}… mode=${imported.mode}`,
  );
} finally {
  if (terminalId) {
    await call('presence_terminal', { action: 'close', terminalId }).catch(() => {});
  }
  for (const job of [serverJob, sleepJob]) {
    if (job) await call('presence_jobs', { action: 'stop', jobId: job }).catch(() => {});
  }
  await call('presence_exec', { command: `rm -rf ${dir}`, confirm: true }).catch(() => {});
  pool.dispose();
  rmSync(localFixture, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
