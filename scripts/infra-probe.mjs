// Standalone probe for Presence 0.18.0 infrastructure features.
//
//   node scripts/infra-probe.mjs [alias]
//
// Runs under plain Node — no DSH imports, no web server — and covers:
//   1. tunnel-store round-trip, atomic file, corrupt-store recovery;
//   2. the `ss` parser + PortDiscovery cache/error/forwarded logic (fake pool);
//   3. a real `ss` scan against a host from ~/.ssh/config (via src/pool.js);
//   4. job-notifier running -> exited transitions, event dedupe and the
//      optional notifyCommand spawn/environment;
//   5. remote file-reference filtering with a fake pool + fake workingDirectory,
//      including the exact item shape, caching, delegation and restore.
//
// It creates its own scratch home/mount tree and removes it afterwards.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PresencePool } from '../src/pool.js';
import { readSshConfig } from '../src/core/ssh-config.mjs';
import { shared } from '../src/shared.js';
import { TunnelStore, loadPresets, removePreset, tunnelsFile, upsertPreset } from '../src/tunnel-store.js';
import { PortDiscovery, parseSsOutput } from '../src/port-discovery.js';
import { installJobNotifier } from '../src/job-notifier.js';
import { buildIndex, installRemoteFileReferences } from '../src/file-references.js';

const host = process.argv[2] ?? 'lthpc-v6';
const sandbox = mkdtempSync(join(tmpdir(), 'presence-infra-probe-'));
// Every store in Presence reads DSH_HOME lazily, so pointing it at the sandbox
// keeps the probe away from the real ~/.dsh/presence files.
process.env.DSH_HOME = join(sandbox, 'dsh-home');
const previousMountsRoot = shared.mountsRoot;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --------------------------------------------------------------- tunnel store
function probeTunnelStore() {
  console.log('\n=== tunnel store ===');
  const store = new TunnelStore();
  check('starts empty', store.list().length === 0, store.file);

  const first = store.upsert({ host, remotePort: 18081, label: 'web', autoRestore: true });
  check(
    'preset gets id/createdAt and is persisted',
    /^p-/.test(first.id) && Boolean(first.createdAt) && JSON.parse(readFileSync(tunnelsFile(), 'utf8')).presets.length === 1,
    JSON.stringify(first),
  );

  const updated = store.upsert({ host, remotePort: 18081, label: 'web 2', localPort: 9001 });
  check(
    'same host/remote target updates in place (keeps id and autoRestore)',
    updated.id === first.id && updated.label === 'web 2' && updated.localPort === 9001 && updated.autoRestore === true && store.list().length === 1,
    JSON.stringify(updated),
  );

  const second = store.upsert({ host, remotePort: 18082, remoteHost: '127.0.0.1', label: 'api', localPort: null });
  check('a second target appends', store.list().length === 2 && second.id !== first.id);
  check('exported loadPresets agrees with the class', loadPresets().length === 2 && loadPresets()[0].id === first.id);
  check('remove by id', store.remove({ id: second.id }) === true && store.list().length === 1);
  check('remove of a missing preset reports false', store.remove({ id: 'p-does-not-exist' }) === false);

  let badInput = null;
  try {
    upsertPreset({ remotePort: 1234 });
  } catch (error) {
    badInput = error;
  }
  check('invalid preset input is refused', Boolean(badInput) && /host is required/.test(badInput.message), badInput?.message);
  removePreset({ host, remotePort: 18081 });
  check('removePreset by target works', loadPresets().length === 0);

  // A corrupt file must reset to an empty store and leave the broken bytes as a
  // backup, never throw or silently delete evidence.
  writeFileSync(tunnelsFile(), '{ this is not json');
  const recovered = loadPresets();
  const storeDir = join(process.env.DSH_HOME, 'presence');
  const backups = readdirSync(storeDir).filter((name) => name.startsWith('tunnels.json.corrupt-'));
  check(
    'corrupt store resets without throwing and keeps a backup',
    recovered.length === 0 && backups.length === 1 && readFileSync(join(storeDir, backups[0]), 'utf8').includes('not json'),
    backups.join(', '),
  );
  check('store is usable after recovery', new TunnelStore().list().length === 0 && upsertPreset({ host, remotePort: 18083 }).remotePort === 18083);
}

// ------------------------------------------------------------ port discovery
function probeSsParser() {
  console.log('\n=== ss parser ===');
  const withProcess = [
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      4096         0.0.0.0:111        0.0.0.0:*',
    'LISTEN 0      128             [::]:22            [::]:* users:(("sshd",pid=812,fd=3))',
    'LISTEN 0      128      127.0.0.1:631        0.0.0.0:* users:(("cupsd",pid=901,fd=13))',
    'LISTEN 0      128                *:8000             *:* users:(("node",pid=4242,fd=21))',
    'LISTEN 0      4096            [::]:22            [::]:* users:(("sshd",pid=812,fd=4))',
  ].join('\n');
  const parsed = parseSsOutput(withProcess);
  check('parses ports with process info', parsed.ports.length === 4 && parsed.hasProcessInfo, JSON.stringify(parsed.ports));
  check(
    'port rows have the frozen shape',
    parsed.ports.every(
      (entry) =>
        Number.isInteger(entry.port) &&
        entry.port >= 1 &&
        entry.port <= 65535 &&
        typeof entry.address === 'string' &&
        (entry.pid === null || Number.isInteger(entry.pid)) &&
        (entry.process === null || typeof entry.process === 'string'),
    ),
  );
  const sshd = parsed.ports.find((entry) => entry.port === 22);
  check('extracts process name/pid', sshd?.process === 'sshd' && sshd?.pid === 812 && sshd?.address === '::', JSON.stringify(sshd));
  check('ports are sorted and deduplicated', parsed.ports.map((entry) => entry.port).join(',') === '22,111,631,8000');

  const plain = parseSsOutput('State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:443 0.0.0.0:*');
  check('works without -p', plain.ports.length === 1 && plain.ports[0].pid === null && plain.hasProcessInfo === false);
  check('ignores non-listening rows and garbage', parseSsOutput('ESTAB 0 0 1.2.3.4:22 5.6.7.8:22\nnot a row\n').ports.length === 0);
  check('ignores a bare header', parseSsOutput('State Recv-Q Send-Q Local Address:Port Peer Address:Port').ports.length === 0);

  check(
    'netstat-style listing parses too',
    parseSsOutput('tcp 0 0 0.0.0.0:6379 0.0.0.0:* LISTEN').ports[0]?.port === 6379,
  );
}

async function probePortDiscovery() {
  console.log('\n=== port discovery (fake pool) ===');
  const ssOutput = [
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=812,fd=3))',
    'LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:(("node",pid=4242,fd=21))',
    'LISTEN 0 128 127.0.0.1:631 0.0.0.0:*',
  ].join('\n');

  let connectionCalls = 0;
  let execCalls = 0;
  const tunnel = { id: 'f1', host, localPort: 9000, remoteHost: '127.0.0.1', remotePort: 8000 };
  let tunnels = [tunnel];
  const makePool = ({ fail = null, output = ssOutput } = {}) => ({
    connectionCalls: () => connectionCalls,
    execCalls: () => execCalls,
    pool: {
      async connection() {
        connectionCalls += 1;
        if (fail) throw fail;
        return {
          async exec() {
            execCalls += 1;
            return { code: 0, stdout: output, stderr: '', stdoutTruncated: false };
          },
        };
      },
      listTunnels() {
        return tunnels;
      },
    },
  });

  const fake = makePool();
  const discovery = new PortDiscovery(fake.pool);
  const first = await discovery.scan(host, { force: true });
  check(
    'first scan returns decorated ports',
    first.ports.length === 3 &&
      first.new.length === 3 &&
      first.ports.every((entry) => Number.isInteger(entry.firstSeen) && typeof entry.forwarded === 'boolean'),
    JSON.stringify(first.ports),
  );
  check('live tunnel marks its port forwarded', first.ports.find((entry) => entry.port === 8000)?.forwarded === true);
  const second = await discovery.scan(host, { force: true });
  check('only the first scan reports ports as new', second.new.length === 0 && second.ports.length === 3);
  const beforeCache = execCalls;
  const cached = await discovery.scan(host);
  check('a repeat scan within 5s is answered from cache', execCalls === beforeCache && cached.ports.length === 3);

  discovery.rememberForwarded(host, { remotePort: 631 });
  const remembered = await discovery.scan(host);
  check('rememberForwarded updates the cached decoration', remembered.ports.find((entry) => entry.port === 631)?.forwarded === true);

  tunnels = [];
  const unforwarded = await discovery.scan(host, { force: true });
  check('closing the tunnel clears forwarded on the next scan', unforwarded.ports.every((entry) => entry.forwarded === false));

  const failing = makePool({ fail: new Error('connection refused') });
  const failingDiscovery = new PortDiscovery(failing.pool);
  const callsBeforeFailure = failing.connectionCalls();
  let firstError = null;
  let secondError = null;
  try {
    await failingDiscovery.scan(host);
  } catch (error) {
    firstError = error;
  }
  try {
    await failingDiscovery.scan(host);
  } catch (error) {
    secondError = error;
  }
  check(
    'scan failures are quarantined instead of hammering the host',
    firstError?.message === 'connection refused' &&
      secondError?.message === 'connection refused' &&
      failing.connectionCalls() - callsBeforeFailure === 1,
    `connection calls: ${failing.connectionCalls() - callsBeforeFailure}`,
  );

  const disabled = new PortDiscovery(fake.pool, { enabled: false });
  const off = await disabled.scan(host);
  check('disabled discovery answers empty without touching the host', off.disabled === true && off.ports.length === 0);

  const noHost = new PortDiscovery(fake.pool);
  let hostError = null;
  try {
    await noHost.scan('');
  } catch (error) {
    hostError = error;
  }
  check('scan without a host is a clear error', /host is required/.test(hostError?.message ?? ''));
}

// --------------------------------------------------------------- real remote
async function probeRealScan(pool) {
  console.log(`\n=== real scan (${host}) ===`);
  const hooked = [];
  const disposeHook = pool.onConnectionEstablished((alias, connection) => {
    hooked.push({ alias, closed: Boolean(connection?.closed) });
  });
  try {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const discovery = new PortDiscovery(pool);
        const result = await discovery.scan(host, { force: true });
        const ports = result.ports ?? [];
        const detail = ports
          .slice(0, 8)
          .map((entry) => `${entry.port}/${entry.address}${entry.process ? `[${entry.process}]` : ''}`)
          .join(', ');
        check(
          `real ss scan returns listening ports (attempt ${attempt})`,
          ports.length > 0 &&
            ports.every((entry) => Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535 && typeof entry.address === 'string'),
          `${ports.length} ports: ${detail}`,
        );
        check(
          'real scan reports forwarded as a boolean and firstSeen as a timestamp',
          ports.every((entry) => typeof entry.forwarded === 'boolean' && Number.isFinite(entry.firstSeen)),
        );
        check(
          'the connection-established hook fired with the live connection',
          hooked.length === 1 && hooked[0].alias === host && hooked[0].closed === false,
          JSON.stringify(hooked),
        );
        // A reconnect is a new connection; a disposed hook must not fire again.
        disposeHook();
        await pool.disconnect(host);
        await pool.connection(host);
        check('a disposed connection hook no longer fires', hooked.length === 1, `${hooked.length} firings`);
        return;
      } catch (error) {
        lastError = error;
        console.log(`      attempt ${attempt} failed: ${error?.message ?? String(error)}`);
      }
    }
    check(`real ss scan returns listening ports on ${host}`, false, lastError?.message ?? String(lastError));
  } finally {
    disposeHook();
  }
}

// --------------------------------------------------------------- job notifier
async function probeJobNotifier() {
  console.log('\n=== job notifier (fake pool) ===');
  const events = [];
  const disposers = [];
  const ctx = {
    emit(name, job) {
      events.push({ name, job });
    },
    effect(fn) {
      disposers.push(fn());
    },
  };
  const running = {
    id: 'j1',
    host,
    pid: 1234,
    state: 'running',
    exitCode: null,
    exitSignal: null,
    label: 'build',
    startedAt: Date.now(),
    logPath: '/tmp/presence-probe.log',
    logSize: 12,
    command: 'make',
  };
  let jobs = [{ ...running }];
  const fakePool = {
    async listJobs() {
      return jobs;
    },
  };
  const notifier = installJobNotifier(ctx, fakePool, { intervalMs: 10_000 });
  await notifier.tick();
  check('the first poll only seeds the state map', events.length === 0 && notifier.stats.ticks === 1);

  jobs = [{ ...running, state: 'exited', exitCode: 0, exitSignal: null }];
  await notifier.tick();
  const exitEvent = events[0];
  check(
    'running -> exited emits presence/job-exited with the job detail',
    events.length === 1 &&
      exitEvent?.name === 'presence/job-exited' &&
      exitEvent?.job.id === 'j1' &&
      exitEvent?.job.state === 'exited' &&
      exitEvent?.job.exitCode === 0 &&
      exitEvent?.job.host === host,
    JSON.stringify(exitEvent?.job),
  );
  check('no notifyCommand configured means no local spawn', notifier.stats.spawns === 0);
  await notifier.tick();
  check('a job is reported exactly once', events.length === 1);

  // unknown -> exited also matters: a reconnect can reveal a finished job.
  const ghost = { ...running, id: 'j2', state: 'unknown' };
  jobs = [ghost];
  await notifier.tick();
  jobs = [{ ...ghost, state: 'exited', exitCode: null, exitSignal: 143 }];
  await notifier.tick();
  check(
    'unknown -> exited notifies once with the signal',
    events.length === 2 && events[1].job.id === 'j2' && events[1].job.signal === 143,
    JSON.stringify(events[1]?.job),
  );

  notifier.dispose();
  for (const dispose of disposers) if (typeof dispose === 'function') dispose();
  check('dispose stops the poller', notifier.running === false);

  // notifyCommand: the spawned command must carry the PRESENCE_JOB_* contract.
  const spawned = [];
  const spawnCtx = { emit() {}, effect(fn) { this.disposers = [fn()]; } };
  let spawnJobs = [{ ...running }];
  const spawnPool = { async listJobs() { return spawnJobs; } };
  const spawnNotifier = installJobNotifier(spawnCtx, spawnPool, {
    intervalMs: 10_000,
    notifyCommand: 'presence-notify --from-probe',
    spawn(command, options) {
      spawned.push({ command, options });
      return { on() {}, unref() {} };
    },
  });
  await spawnNotifier.tick();
  spawnJobs = [{ ...running, state: 'exited', exitCode: 2 }];
  await spawnNotifier.tick();
  const spawn = spawned[0];
  check(
    'notifyCommand spawns through the shell with PRESENCE_JOB_* env',
    spawned.length === 1 &&
      spawn.command === 'presence-notify --from-probe' &&
      spawn.options.shell === true &&
      spawn.options.env.PRESENCE_JOB_ID === 'j1' &&
      spawn.options.env.PRESENCE_JOB_HOST === host &&
      spawn.options.env.PRESENCE_JOB_LABEL === 'build' &&
      spawn.options.env.PRESENCE_JOB_EXIT === '2',
    JSON.stringify({ command: spawn?.command, env: spawn?.options?.env }),
  );
  spawnNotifier.dispose();
  for (const dispose of spawnCtx.disposers ?? []) if (typeof dispose === 'function') dispose();
}

// ----------------------------------------------------------- file references
async function probeFileReferences() {
  console.log('\n=== file references (B1, fake pool) ===');
  const config = readSshConfig();
  const mountHost = config.has(host) ? host : [...config.keys()][0];
  if (!mountHost) {
    check('a configured ssh host is available for the mount path', false, 'no host in ~/.ssh/config');
    return;
  }
  const mounts = join(sandbox, 'mounts');
  shared.mountsRoot = mounts;
  const remoteRoot = '/proj';
  const cwd = join(mounts, mountHost, 'proj');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(sandbox, 'local-project'), { recursive: true });

  const remoteFiles = [
    'README.md',
    'docs/guide.md',
    'src/app.js',
    'src/index.js',
    'src/lib/util.js',
    'src/lib/deep/file.js',
    'node_modules/pkg/index.js',
    '.git/config',
    '.hidden/secret.txt',
    'other/src/index.js',
  ];
  const listings = new Map([
    [remoteRoot, [
      { name: 'README.md', path: `${remoteRoot}/README.md`, kind: 'file' },
      { name: 'src', path: `${remoteRoot}/src`, kind: 'dir' },
      { name: 'node_modules', path: `${remoteRoot}/node_modules`, kind: 'dir' },
      { name: '.hidden', path: `${remoteRoot}/.hidden`, kind: 'dir' },
    ]],
    [`${remoteRoot}/src`, [
      { name: 'app.js', path: `${remoteRoot}/src/app.js`, kind: 'file' },
      { name: 'index.js', path: `${remoteRoot}/src/index.js`, kind: 'file' },
      { name: 'lib', path: `${remoteRoot}/src/lib`, kind: 'dir' },
      { name: 'node_modules', path: `${remoteRoot}/src/node_modules`, kind: 'dir' },
      { name: '.env', path: `${remoteRoot}/src/.env`, kind: 'file' },
      { name: 'link.js', path: `${remoteRoot}/src/link.js`, kind: 'link' },
    ]],
  ]);
  let indexExecCalls = 0;
  const listCalls = [];
  const connection = {
    async exec(command) {
      indexExecCalls += 1;
      if (!command.includes('rg --files')) throw new Error(`unexpected remote command: ${command}`);
      return { code: 0, stdout: remoteFiles.join('\n'), stderr: '', stdoutTruncated: false };
    },
    async list(path) {
      listCalls.push(path);
      return listings.get(path) ?? [];
    },
  };
  const fakePool = { async connection() { return connection; } };
  const originalItems = [{ path: 'local-only.txt', kind: 'file' }];
  let originalCalls = 0;
  const service = {
    async list(_agent, _query, _signal) {
      originalCalls += 1;
      return originalItems.map((item) => ({ ...item }));
    },
    config: { maxResults: 20 },
  };
  let cwdValue = cwd;
  const workingDirectory = { async ensure() { return cwdValue; } };
  const disposers = [];
  const scope = {
    fileReferences: service,
    workingDirectory,
    effect(fn) {
      disposers.push(fn());
    },
  };
  const ctx = {
    inject(services, callback) {
      check('B1: install injects fileReferences + workingDirectory', services.join(',') === 'fileReferences,workingDirectory', services.join(','));
      callback(scope);
    },
  };
  const status = installRemoteFileReferences(ctx, { pool: fakePool, mountsRoot: mounts, late: {} });
  check('B1: fileReferences.list was wrapped', status.ok === true && status.installed === true, status.error ?? '');

  const signal = new AbortController().signal;
  const resultsGlobal = await service.list({ id: 'a' }, 'ind', signal);
  check(
    'B1: global query returns remote candidates',
    resultsGlobal.length > 0 && resultsGlobal.some((item) => item.path === 'src/index.js'),
    JSON.stringify(resultsGlobal.slice(0, 6)),
  );
  check(
    'B1: item shape matches LocalFileReferenceService.list',
    resultsGlobal.every(
      (item) =>
        Object.keys(item).sort().join(',') === 'kind,path' && (item.kind === 'file' || item.kind === 'directory'),
    ),
  );
  check(
    'B1: excluded directories and hidden paths are filtered',
    !resultsGlobal.some((item) => /(^|\/)(node_modules|\.git|\.hidden)(\/|$)/.test(item.path)),
  );
  check('B1: the remote index is scanned once and cached', indexExecCalls === 1, `exec calls: ${indexExecCalls}`);

  const dirResults = await service.list({ id: 'a' }, 'src/', signal);
  check(
    'B1: a directory query lists the live remote directory',
    listCalls[0] === `${remoteRoot}/src` &&
      dirResults.some((item) => item.path === 'src/lib' && item.kind === 'directory') &&
      dirResults.some((item) => item.path === 'src/app.js' && item.kind === 'file'),
    JSON.stringify(dirResults),
  );
  check(
    'B1: directory listing hides dotfiles, symlinks and excluded dirs',
    !dirResults.some((item) => item.path === 'src/.env' || item.path === 'src/link.js' || item.path === 'src/node_modules'),
  );
  const rootResults = await service.list({ id: 'a' }, '', signal);
  check(
    'B1: the empty query lists the root and hides dotdirs',
    listCalls[1] === remoteRoot &&
      rootResults.some((item) => item.path === 'README.md') &&
      rootResults.some((item) => item.path === 'src' && item.kind === 'directory') &&
      !rootResults.some((item) => item.path === '.hidden' || item.path === 'node_modules'),
    JSON.stringify(rootResults),
  );

  cwdValue = join(sandbox, 'local-project');
  const delegated = await service.list({ id: 'b' }, 'anything', signal);
  check(
    'B1: a non-remote cwd still uses the original service',
    originalCalls === 1 && delegated.length === 1 && delegated[0].path === 'local-only.txt',
  );
  cwdValue = cwd;

  for (const dispose of disposers) if (typeof dispose === 'function') dispose();
  const afterRestore = await service.list({ id: 'a' }, 'ind', signal);
  check(
    'B1: disposal restores the original service',
    originalCalls === 2 && afterRestore[0]?.path === 'local-only.txt',
  );

  const index = buildIndex(['src/a.js', 'src/lib/b.js', 'node_modules/x.js', '.git/config']);
  check(
    'B1: index derives directory candidates and drops excluded dirs',
    index.some((entry) => entry.path === 'src' && entry.kind === 'directory') &&
      index.some((entry) => entry.path === 'src/lib' && entry.kind === 'directory') &&
      !index.some((entry) => entry.path.startsWith('node_modules')),
    JSON.stringify(index),
  );

  const frozenService = Object.freeze({ async list() { return []; }, config: { maxResults: 20 } });
  const frozenCtx = {
    inject(_services, callback) {
      callback({ fileReferences: frozenService, workingDirectory, effect() {} });
    },
  };
  const frozen = installRemoteFileReferences(frozenCtx, { pool: fakePool, mountsRoot: mounts, late: {}, log: () => {} });
  check(
    'B1: a frozen service instance is reported instead of ignored',
    frozen.ok === false && typeof frozen.error === 'string' && /frozen|could not wrap/.test(frozen.error),
    frozen.error,
  );

  // Cordis hands plugins a traceable Proxy around the service instance. The
  // wrapper must still install and restore through that proxy.
  const proxyTarget = {
    async list() {
      return [{ path: 'proxy-original.txt', kind: 'file' }];
    },
    config: { maxResults: 20 },
  };
  const proxied = new Proxy(proxyTarget, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
  const proxyDisposers = [];
  const proxyCtx = {
    inject(_services, callback) {
      callback({
        fileReferences: proxied,
        workingDirectory,
        effect(fn) {
          proxyDisposers.push(fn());
        },
      });
    },
  };
  const proxiedStatus = installRemoteFileReferences(proxyCtx, { pool: fakePool, mountsRoot: mounts, late: {} });
  const proxiedResults = await proxied.list({ id: 'a' }, 'ind', signal);
  check(
    'B1: wrapping works through the Cordis traceable service proxy',
    proxiedStatus.ok === true && proxiedResults.some((item) => item.path === 'src/index.js'),
    proxiedStatus.error ?? '',
  );
  for (const dispose of proxyDisposers) if (typeof dispose === 'function') dispose();
  const proxiedRestored = await proxied.list({ id: 'a' }, 'ind', signal);
  check(
    'B1: restoring through the proxy brings the original method back',
    proxiedRestored.length === 1 && proxiedRestored[0].path === 'proxy-original.txt',
    JSON.stringify(proxiedRestored),
  );
}

// --------------------------------------------------------------------- driver
let pool = null;
try {
  probeTunnelStore();
  probeSsParser();
  await probePortDiscovery();

  const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
  pool = new PresencePool(settings);
  await probeRealScan(pool);

  await probeJobNotifier();
  await probeFileReferences();
} catch (error) {
  console.error(`\nprobe crashed: ${error?.stack ?? String(error)}`);
  results.push({ name: 'probe completed', ok: false });
} finally {
  try {
    pool?.dispose();
  } catch {
    /* pool cleanup is best effort */
  }
  shared.mountsRoot = previousMountsRoot;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows can hold a file open briefly; the path is under %TEMP% */
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const entry of failed) console.log(`  FAILED: ${entry.name}`);
process.exit(failed.length === 0 ? 0 : 1);
