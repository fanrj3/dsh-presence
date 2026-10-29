// P1 backend probe (0.20.0): job registry persistence, wait conditions,
// canonical read-observation keys and the per-agent prompt plumbing that does
// not need a running Harness.
//
//   node scripts/p1-backend-probe.mjs [ssh-alias]
//
// Everything the probe creates is removed at the end: a temporary DSH_HOME
// (the job/observed stores are redirected into it), a remote fixture directory
// under /tmp, and every background job it starts.
//
// The probe deliberately avoids importing the Harness runtime: the job store,
// the wait primitive and the observation bridge are plain modules, and the
// Cordis context is faked where an event shape must be asserted.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

const alias = process.argv[2] ?? 'server';

// Isolate every store BEFORE a module reads the environment.
const home = mkdtempSync(join(tmpdir(), 'presence-p1-backend-'));
process.env.DSH_HOME = home;
process.env.PRESENCE_JOBS_FILE = join(home, 'jobs.json');

const { readSshConfig } = await import('../src/core/ssh-config.mjs');
const { PresencePool } = await import('../src/pool.js');
const {
  JobStore,
  jobsFile,
  loadJobRecords,
  saveJobRecords,
  pruneJobRecords,
  upsertJobRecord,
  MAX_JOB_RECORDS,
} = await import('../src/job-store.js');
const { waitUntil, normalizeWaitCondition } = await import('../src/wait.js');
const {
  canonicalObservation,
  canonicalObservationKey,
  recordObservation,
  lookupObservation,
  describeObservation,
} = await import('../src/observed-store.js');
const { installObservationBridge } = await import('../src/intercept.js');
const { presenceRoutes } = await import('../src/api.js');
const { shared } = await import('../src/shared.js');
const { mountPathFor, mountsRoot } = await import('../src/mounts.js');

if (!readSshConfig().get(alias)) {
  console.error(`no host "${alias}" in ~/.ssh/config`);
  process.exit(1);
}
shared.mountsRoot = join(home, 'presence', 'mounts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
const stamp = Date.now();
const remoteDir = `/tmp/presence-p1-backend-${stamp}`;

const pools = [];
const newPool = () => {
  const store = new JobStore();
  const pool = new PresencePool(settings, { jobStore: store });
  pools.push(pool);
  return { pool, store };
};

// ------------------------------------------------ API doubles (api-probe style)
//
// The Web server exposes the `/presence/api/state` route handler; the probe
// calls it directly with a request/response pair, so the jobs payload the
// client reads is asserted without starting an HTTP server.

class ProbeRequest extends PassThrough {
  constructor({ method = 'GET', url, headers = {}, remoteAddress = '127.0.0.1' }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3846', ...headers };
    this.socket = { remoteAddress };
  }
}

class ProbeResponse extends Writable {
  #chunks = [];

  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.headersSent = false;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers ?? {};
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.#chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.#chunks);
  }

  json() {
    return JSON.parse(this.body().toString('utf8'));
  }

  finished(timeoutMs = 15_000) {
    if (this.writableFinished) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('response never finished')), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('finish', done);
      this.once('close', done);
    });
  }
}

/** Call one exported route handler exactly as the Web server would. */
async function callStateRoute(pool) {
  const route = presenceRoutes(pool, {}).find((entry) => entry.path === '/presence/api/state');
  if (!route) throw new Error('the /presence/api/state route is not registered');
  const request = new ProbeRequest({ method: 'GET', url: '/presence/api/state' });
  const response = new ProbeResponse();
  const pending = route.handler(request, response);
  request.end();
  await pending;
  await response.finished();
  return { status: response.statusCode, json: response.json() };
}


let connection = null;
const jobIds = [];

try {
  // ---------------------------------------------------------------- job store
  {
    const store = new JobStore();
    const record = {
      id: 'j1-test',
      host: alias,
      label: 'probe',
      command: 'sleep 60',
      sessionId: 'sess-1',
      pid: 4242,
      pgid: 4242,
      logPath: '/tmp/a.log',
      commandLogPath: '/tmp/a.out',
      statusPath: '/tmp/a.status',
      cwd: '/tmp',
      startedAt: Date.now() - 1000,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      state: 'running',
    };
    store.upsert(record);
    check('store: jobs file honours PRESENCE_JOBS_FILE', jobsFile() === process.env.PRESENCE_JOBS_FILE, jobsFile());
    const reloaded = new JobStore().list();
    const row = reloaded.find((entry) => entry.id === record.id);
    check(
      'store: round-trip keeps every persisted field',
      Boolean(row) &&
        row.pid === 4242 &&
        row.pgid === 4242 &&
        row.commandLogPath === '/tmp/a.out' &&
        row.statusPath === '/tmp/a.status' &&
        row.cwd === '/tmp' &&
        row.state === 'running' &&
        row.sessionId === 'sess-1',
      JSON.stringify(row),
    );
    check('store: JSON on disk is valid and atomic (no temp files)', (() => {
      try {
        const parsed = JSON.parse(readFileSync(jobsFile(), 'utf8'));
        const leftovers = readdirSync(home).filter((name) => name.includes('.tmp'));
        return parsed.version === 1 && Array.isArray(parsed.jobs) && leftovers.length === 0;
      } catch {
        return false;
      }
    })());

    store.upsert({ ...record, state: 'exited', exitCode: 0, exitedAt: Date.now() });
    const replaced = new JobStore().list().filter((entry) => entry.id === record.id);
    check('store: upsert by id replaces, not duplicates', replaced.length === 1 && replaced[0].state === 'exited' && replaced[0].exitCode === 0);

    check('store: remove forgets one record', store.remove(record.id) === true && new JobStore().list().length === 0);

    // Corrupt file: quarantined and reset instead of crashing.
    writeFileSync(jobsFile(), '{ this is not json', 'utf8');
    const recovered = loadJobRecords();
    const backups = readdirSync(home).filter((name) => /\.corrupt-/.test(name));
    check(
      'store: corrupt file is backed up and reset to empty',
      Array.isArray(recovered) && recovered.length === 0 && backups.length === 1,
      `backups=${backups.join(',') || 'none'}`,
    );
  }

  // --------------------------------------------------------------- store bounds
  {
    const now = Date.now();
    const seeded = [];
    for (let index = 0; index < MAX_JOB_RECORDS + 15; index += 1) {
      seeded.push({
        id: `j-seed-${index}`,
        host: alias,
        command: `sleep ${index}`,
        pid: 5000 + index,
        pgid: 5000 + index,
        logPath: `/tmp/seed-${index}.log`,
        startedAt: now - 40 * 24 * 60 * 60 * 1000,
        exitedAt: now - 40 * 24 * 60 * 60 * 1000,
        state: 'exited',
      });
    }
    saveJobRecords(seeded);
    const written = loadJobRecords().length;
    check('store: save is bounded to MAX_JOB_RECORDS', written <= MAX_JOB_RECORDS, `${written}/${MAX_JOB_RECORDS}`);

    // A small, deterministic prune fixture: old exited records go, a running one
    // (however old) is kept.
    const aged = Array.from({ length: 10 }, (_, index) => ({
      id: `j-old-${index}`,
      host: alias,
      command: 'sleep 1',
      pid: 6000 + index,
      pgid: 6000 + index,
      logPath: `/tmp/old-${index}.log`,
      startedAt: now - 40 * 24 * 60 * 60 * 1000,
      exitedAt: now - 40 * 24 * 60 * 60 * 1000,
      state: 'exited',
    }));
    saveJobRecords([
      ...aged,
      {
        id: 'j-keep-running',
        host: alias,
        command: 'sleep 999',
        pid: 9999,
        pgid: 9999,
        logPath: '/tmp/keep.log',
        startedAt: now - 40 * 24 * 60 * 60 * 1000,
        state: 'running',
      },
      {
        id: 'j-fresh-exit',
        host: alias,
        command: 'true',
        pid: 9998,
        pgid: 9998,
        logPath: '/tmp/fresh.log',
        startedAt: now,
        exitedAt: now,
        state: 'exited',
      },
    ]);
    const pruned = pruneJobRecords({ maxAgeMs: 24 * 60 * 60 * 1000, maxEntries: 20 });
    const remaining = loadJobRecords();
    check(
      'store: prune drops old exited records and keeps a running one',
      pruned.removed === 10 &&
        remaining.length === 2 &&
        remaining.some((entry) => entry.id === 'j-keep-running') &&
        remaining.some((entry) => entry.id === 'j-fresh-exit'),
      `removed=${pruned.removed} left=${remaining.map((entry) => entry.id).join(',')}`,
    );
    check('store: prune is idempotent (a second pass removes nothing new)', pruneJobRecords({ maxAgeMs: 24 * 60 * 60 * 1000, maxEntries: 20 }).removed === 0);
    saveJobRecords([]);
  }

  // --------------------------------------------------------- pool persistence
  connection = await new PresencePool(settings).connection(alias);
  await connection.exec(`mkdir -p ${remoteDir}`);

  const pool1 = newPool();
  await pool1.pool.connection(alias);
  const longJob = await pool1.pool.startJob(alias, {
    command: 'for i in $(seq 1 120); do echo tick $i; sleep 1; done',
    cwd: remoteDir,
    label: 'p1-backend-long',
    sessionId: 'probe-session',
  });
  jobIds.push(longJob.id);
  check(
    'pool: startJob returns id/pid/pgid/logPath and a non-null commandLogPath',
    Boolean(longJob.id) &&
      Boolean(longJob.pid) &&
      Boolean(longJob.pgid) &&
      typeof longJob.commandLogPath === 'string' &&
      longJob.commandLogPath === longJob.logPath,
    JSON.stringify(longJob),
  );
  const storedAfterStart = new JobStore().list().find((entry) => entry.id === longJob.id);
  check(
    'pool: a started job is persisted immediately as running',
    Boolean(storedAfterStart) && storedAfterStart.state === 'running' && storedAfterStart.pid === longJob.pid && storedAfterStart.pgid === longJob.pgid,
    JSON.stringify(storedAfterStart),
  );

  // /state jobs payload: the client and docs read these fields defensively.
  {
    const state = await callStateRoute(pool1.pool);
    const row = state.json.jobs?.find((entry) => entry.id === longJob.id);
    check(
      'api: /state jobs payload carries pid, pgid, commandLogPath and persisted',
      state.status === 200 &&
        state.json.ok === true &&
        Boolean(row) &&
        row.pid === longJob.pid &&
        row.pgid === longJob.pgid &&
        row.commandLogPath === longJob.logPath &&
        row.persisted === false &&
        row.state === 'running',
      JSON.stringify(row),
    );
    const brokenPool = {
      hosts: () => [],
      listTerminals: () => [],
      hasSecret: () => false,
      listJobs: async () => {
        throw new Error('registry down');
      },
    };
    const broken = await callStateRoute(brokenPool);
    check(
      'api: /state stays resilient (jobs: []) when listJobs throws',
      broken.status === 200 && broken.json.ok === true && Array.isArray(broken.json.jobs) && broken.json.jobs.length === 0,
      JSON.stringify(broken.json),
    );
  }

  // setsid detach: the job's pid is its process-group id and session id, and it
  // is not the foreground SSH shell's group.
  const psJob = await connection.exec(`ps -o pid=,ppid=,pgid=,sid= -p ${longJob.pid}`);
  const [pid, ppid, pgid, sid] = psJob.stdout.trim().split(/\s+/).map(Number);
  const psShell = await connection.exec('ps -o pid=,pgid= -p $$');
  const [shellPid, shellPgid] = psShell.stdout.trim().split(/\s+/).map(Number);
  check(
    'pool: background job is detached by setsid (pid == pgid == sid)',
    pid === longJob.pid && pgid === pid && sid === pid,
    `pid=${pid} ppid=${ppid} pgid=${pgid} sid=${sid}`,
  );
  check(
    'pool: job process group differs from the shell that launched it',
    Number.isFinite(shellPid) && Number.isFinite(shellPgid) && pid !== shellPid && pgid !== shellPgid,
    `job=${pid}/${pgid} shell=${shellPid}/${shellPgid}`,
  );

  // Second pool instance: records are visible but never trusted as running.
  const pool2 = newPool();
  const beforeConnect = await pool2.pool.listJobs();
  const inherited = beforeConnect.find((entry) => entry.id === longJob.id);
  check(
    'pool: a second instance loads the record as unknown, not running',
    Boolean(inherited) && inherited.state === 'unknown' && inherited.persisted === true,
    JSON.stringify(inherited),
  );
  check(
    'pool: listJobs rows expose pid, pgid, commandLogPath and persisted',
    Boolean(inherited) &&
      Object.hasOwn(inherited, 'pid') &&
      Object.hasOwn(inherited, 'pgid') &&
      Object.hasOwn(inherited, 'commandLogPath') &&
      typeof inherited.persisted === 'boolean',
    Object.keys(inherited ?? {}).join(','),
  );

  await pool2.pool.connection(alias);
  let liveRow = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const rows = await pool2.pool.listJobs();
    liveRow = rows.find((entry) => entry.id === longJob.id) ?? null;
    if (liveRow?.state === 'running') break;
    await sleep(200);
  }
  check(
    'pool: a pid liveness probe promotes the loaded record to running',
    liveRow?.state === 'running' && liveRow.persisted === true,
    `state=${liveRow?.state}`,
  );

  const stopped = await pool2.pool.stopJob(longJob.id);
  const survivors = await connection.exec(`ps -o pid= -g ${longJob.pgid} 2>/dev/null | wc -l`);
  const storedAfterStop = new JobStore().list().find((entry) => entry.id === longJob.id);
  check(
    'pool: stopJob stops the group and updates the persisted record',
    stopped.stopped === true && Number(survivors.stdout.trim()) === 0 && Boolean(storedAfterStop) && storedAfterStop.state === 'exited',
    `stopped=${stopped.stopped} survivors=${survivors.stdout.trim()} store=${storedAfterStop?.state}`,
  );
  const listedAfterStop = (await pool2.pool.listJobs()).find((entry) => entry.id === longJob.id);
  check('pool: the stopped job reads exited on the next listing', listedAfterStop?.state === 'exited', listedAfterStop?.state);

  // A command that dies at once must be persisted with its real exit code.
  const early = await pool1.pool.startJob(alias, { command: 'exit 7', cwd: remoteDir, label: 'p1-backend-early' });
  jobIds.push(early.id);
  const storedEarly = new JobStore().list().find((entry) => entry.id === early.id);
  check(
    'pool: an instantly failing job is persisted with its exit code',
    early.exitedEarly === true && early.exitCode === 7 && storedEarly?.state === 'exited' && storedEarly?.exitCode === 7,
    `early=${early.exitedEarly} code=${early.exitCode} store=${storedEarly?.state}/${storedEarly?.exitCode}`,
  );

  // waitJob still reports and persists a clean exit.
  const quick = await pool1.pool.startJob(alias, { command: 'echo done', cwd: remoteDir });
  jobIds.push(quick.id);
  const waited = await pool1.pool.waitJob(quick.id, { timeoutMs: 15_000, pollMs: 100 });
  const storedQuick = new JobStore().list().find((entry) => entry.id === quick.id);
  check(
    'pool: waitJob reports the exit code and persists the final state',
    waited.state === 'exited' && waited.exitCode === 0 && storedQuick?.state === 'exited' && storedQuick?.exitCode === 0,
    `state=${waited.state} code=${waited.exitCode} store=${storedQuick?.state}/${storedQuick?.exitCode}`,
  );

  const pruned = await pool1.pool.pruneJobs({ maxAgeMs: 0, maxEntries: 0 });
  const storedAfterPrune = new JobStore().list().map((entry) => entry.id);
  check(
    'pool: pruneJobs also bounds the persisted store',
    pruned.removed >= 2 && !storedAfterPrune.includes(quick.id) && !storedAfterPrune.includes(early.id),
    `removed=${pruned.removed} left=${storedAfterPrune.length}`,
  );

  // ------------------------------------------------------- wait: real host
  const filePath = `${remoteDir}/wait.txt`;
  await connection.writeText(filePath, 'line one\nREADY\n');
  {
    const start = Date.now();
    const result = await waitUntil({ connection, condition: { kind: 'file', path: filePath }, timeoutMs: 5_000 });
    check(
      'wait(file): an existing file is met on the first poll',
      result.met === true && result.polls === 1 && result.observed.exists === true && result.elapsedMs >= 0,
      `polls=${result.polls} elapsed=${Date.now() - start}`,
    );
    check(
      'wait(file): observed snapshot carries size and mtime',
      Number.isFinite(result.observed.size) && Number.isFinite(result.observed.mtime),
      JSON.stringify(result.observed),
    );
  }
  {
    const result = await waitUntil({
      connection,
      condition: { kind: 'file', path: filePath, minBytes: 10_000_000 },
      timeoutMs: 400,
      pollMs: 50,
    });
    check('wait(file): an unmet minBytes times out with met:false (no throw)', result.met === false && result.timedOut === true, `polls=${result.polls}`);
  }
  {
    const info = await connection.stat(filePath);
    const same = await waitUntil({
      connection,
      condition: { kind: 'file', path: filePath, mtimeAfter: info.mtime },
      timeoutMs: 350,
      pollMs: 50,
    });
    const older = await waitUntil({
      connection,
      condition: { kind: 'file', path: filePath, mtimeAfter: info.mtime - 60_000 },
      timeoutMs: 2_000,
      pollMs: 50,
    });
    check(
      'wait(file): mtimeAfter compares (equal mtime is not "after"; an older basis is met)',
      same.met === false && same.timedOut === true && older.met === true,
      `same=${same.met} older=${older.met}`,
    );
  }
  {
    const missing = await waitUntil({
      connection,
      condition: { kind: 'file', path: `${remoteDir}/nope.txt`, exists: false },
      timeoutMs: 2_000,
    });
    check('wait(file): exists:false is met for a missing file', missing.met === true && missing.observed.exists === false);
  }
  {
    const one = await waitUntil({
      connection,
      condition: { kind: 'grep', path: filePath, pattern: 'READY', count: 1 },
      timeoutMs: 2_000,
    });
    const two = await waitUntil({
      connection,
      condition: { kind: 'grep', path: filePath, pattern: 'READY', count: 2 },
      timeoutMs: 400,
      pollMs: 50,
    });
    check(
      'wait(grep): counts matching lines (one READY meets count 1, misses count 2)',
      one.met === true && one.observed.matches === 1 && two.met === false && two.timedOut === true,
      `one=${one.observed.matches} two=${two.observed.matches}`,
    );
    await connection.writeText(filePath, 'line one\nREADY\nREADY again\n');
    const later = await waitUntil({
      connection,
      condition: { kind: 'grep', path: filePath, pattern: 'READY', count: 2 },
      timeoutMs: 2_000,
    });
    check('wait(grep): a later append meets the higher count', later.met === true && later.observed.matches === 2, `matches=${later.observed.matches}`);
  }
  {
    const absentPattern = `presence-p1-no-such-process-${stamp}`;
    const absent = await waitUntil({
      connection,
      condition: { kind: 'process', pattern: absentPattern, alive: false },
      timeoutMs: 5_000,
      pollMs: 100,
    });
    check(
      'wait(process): pattern absence is met (the probe never matches its own shell)',
      absent.met === true && absent.observed.alive === false && absent.observed.matches === 0,
      JSON.stringify(absent.observed),
    );
    const deadPid = await waitUntil({
      connection,
      condition: { kind: 'process', pid: 999_999_999, alive: false },
      timeoutMs: 2_000,
    });
    check('wait(process): pid absence is met', deadPid.met === true && deadPid.observed.alive === false);

    const marker = `presence-p1-marker-${stamp}`;
    const marked = await pool1.pool.startJob(alias, { command: `exec -a ${marker} sleep 20`, cwd: remoteDir });
    jobIds.push(marked.id);
    const found = await waitUntil({
      connection,
      condition: { kind: 'process', pattern: marker, alive: true },
      timeoutMs: 5_000,
      pollMs: 100,
    });
    check('wait(process): a running marker process is met with a match count', found.met === true && found.observed.matches >= 1, JSON.stringify(found.observed));
    await pool1.pool.stopJob(marked.id).catch(() => {});
  }
  {
    const port = 19_000 + (stamp % 1_000);
    const server = await pool1.pool.startJob(alias, {
      command: `python3 -m http.server ${port} --bind 127.0.0.1`,
      cwd: remoteDir,
    });
    jobIds.push(server.id);
    try {
      const open = await waitUntil({
        connection,
        condition: { kind: 'port', port, state: 'open' },
        timeoutMs: 15_000,
        pollMs: 300,
      });
      check('wait(port): an opening TCP port is met', open.met === true && open.observed.ready === true, `port=${port} polls=${open.polls}`);
    } finally {
      await pool1.pool.stopJob(server.id).catch(() => {});
    }
    const closed = await waitUntil({
      connection,
      condition: { kind: 'port', port, state: 'closed' },
      timeoutMs: 10_000,
      pollMs: 250,
    });
    check('wait(port): a closed TCP port is met after the server stops', closed.met === true && closed.observed.ready === false);
  }
  {
    // A fake registry proves the job condition without a second real job.
    const fakePool = {
      state: 'running',
      async listJobs() {
        return [{ id: 'j-fake', host: alias, state: this.state, exitCode: this.state === 'exited' ? 0 : null }];
      },
    };
    const pending = await waitUntil({
      pool: fakePool,
      condition: { kind: 'job', jobId: 'j-fake' },
      timeoutMs: 300,
      pollMs: 50,
    });
    check('wait(job): a running job keeps polling and times out cleanly', pending.met === false && pending.timedOut === true, `polls=${pending.polls}`);
    fakePool.state = 'exited';
    const done = await waitUntil({ pool: fakePool, condition: { kind: 'job', jobId: 'j-fake' }, timeoutMs: 2_000, pollMs: 50 });
    check(
      'wait(job): a persisted/finished job is met with its exit state',
      done.met === true && done.observed.state === 'exited' && done.observed.exitCode === 0,
      JSON.stringify(done.observed),
    );
  }
  {
    // A real job that exits while the wait is polling.
    const slow = await pool1.pool.startJob(alias, { command: 'sleep 1; echo done', cwd: remoteDir });
    jobIds.push(slow.id);
    const result = await waitUntil({
      pool: pool1.pool,
      condition: { kind: 'job', jobId: slow.id },
      timeoutMs: 15_000,
      pollMs: 200,
    });
    check('wait(job): a real job is observed finishing', result.met === true && result.observed.state === 'exited', JSON.stringify(result.observed));
  }
  {
    let threw = null;
    try {
      await waitUntil({ connection, condition: { kind: 'nonsense' }, timeoutMs: 100 });
    } catch (error) {
      threw = error;
    }
    check('wait: an invalid condition is thrown, not timed out', Boolean(threw) && /unknown condition kind/.test(threw.message), threw?.message);
    let missingConnection = null;
    try {
      await waitUntil({ condition: { kind: 'file', path: '/tmp/x' }, timeoutMs: 100 });
    } catch (error) {
      missingConnection = error;
    }
    check('wait: a non-job condition without a connection is thrown', Boolean(missingConnection) && /connection/.test(missingConnection.message));
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 120);
    const aborted = await waitUntil({
      connection,
      condition: { kind: 'file', path: `${remoteDir}/never.txt` },
      timeoutMs: 5_000,
      pollMs: 100,
      signal: abort.signal,
    });
    check('wait: an aborted wait returns aborted:true instead of throwing', aborted.aborted === true && aborted.met === false);
    const normalized = normalizeWaitCondition({ kind: 'port', port: '8080', state: 'closed' });
    check('wait: normalizeWaitCondition validates and defaults', normalized.port === 8080 && normalized.state === 'closed');
  }

  // ------------------------------------------------- canonical observation keys
  {
    const urlKey = `presence://${alias}/data/x.txt`;
    const fromUrl = canonicalObservation(urlKey);
    check(
      'keys: a presence:// URL canonicalizes',
      fromUrl?.host === alias && fromUrl?.remotePath === '/data/x.txt' && fromUrl.key === urlKey,
      JSON.stringify(fromUrl),
    );
    const mount = mountPathFor(alias, '/data/x.txt');
    const fromMount = canonicalObservation(mount);
    check('keys: a mount path canonicalizes to the same identity', fromMount?.key === urlKey, fromMount?.key);
    const cwd = mountPathFor(alias, '/data');
    const fromRelative = canonicalObservation('x.txt', { cwd });
    check('keys: a workspace-relative path canonicalizes', fromRelative?.key === urlKey, fromRelative?.key);
    const fromAbsolute = canonicalObservation('/data/x.txt', { cwd });
    check('keys: an absolute remote path in a mounted session canonicalizes', fromAbsolute?.key === urlKey, fromAbsolute?.key);
    const fromExplicitHost = canonicalObservation('/data/x.txt', { cwd: 'D:\\tmp\\local', host: alias });
    check('keys: an absolute path in a LOCAL session uses the explicit host', fromExplicitHost?.key === urlKey, fromExplicitHost?.key);
    check('keys: a local Windows path is not a remote identity', canonicalObservation('D:\\tmp\\a.txt') === null);
    check('keys: an unknown presence host is rejected', canonicalObservation('presence://no-such-host/x') === null);
    check('keys: targetKey objects canonicalize', canonicalObservation({ targetKey: urlKey, displayPath: urlKey })?.key === urlKey);

    recordObservation('sess-keys', mount, 'v1');
    check(
      'keys: a remotely read file is found through every spelling',
      lookupObservation('sess-keys', urlKey) === 'v1' &&
        lookupObservation('sess-keys', mount) === 'v1' &&
        lookupObservation('sess-keys', 'x.txt', { cwd }) === 'v1',
      JSON.stringify(describeObservation('sess-keys', urlKey)),
    );
    check(
      'keys: the stored entry keeps host/remotePath for diagnostics',
      describeObservation('sess-keys', urlKey)?.host === alias && describeObservation('sess-keys', urlKey)?.remotePath === '/data/x.txt',
    );
    recordObservation('sess-keys', '/data/x.txt', 'v2', { host: alias });
    check('keys: an explicit host records like the URL spelling', lookupObservation('sess-keys', urlKey) === 'v2');
  }

  // ------------------------------------------------- observation event shape
  {
    const events = [];
    const handlers = new Map();
    const fakeCtx = {
      on(name, handler) {
        handlers.set(name, handler);
      },
      emit(name, ...args) {
        events.push({ name, args });
      },
      effect() {},
    };
    const fakeAgent = { session: { id: 'sess-events' } };
    const cwd = mountPathFor(alias, '/data');
    const target = (path) => ({ targetKey: `presence://${alias}${path}`, displayPath: `presence://${alias}${path}` });
    const fakeFs = {
      version: 'v1',
      async resolve(path, options) {
        const remote = canonicalObservation(path, { cwd: options?.cwd ?? cwd });
        if (!remote) return { targetKey: `local:${path}`, displayPath: path };
        return target(remote.remotePath);
      },
      async stat() {
        return { version: this.version, type: 'file' };
      },
    };
    const bridge = installObservationBridge(fakeCtx, { cwdOf: async () => cwd, late: { fs: fakeFs } });
    const exec = (extra = {}) => ({ name: 'presence_read', agent: fakeAgent, arguments: { host: alias, ...extra } });
    await bridge.observe(exec(), 'x.txt');
    const emitted = events.at(-1);
    check(
      'observation: publish uses the fs/observed (target, observation, actor) shape',
      emitted?.name === 'fs/observed' &&
        emitted.args[0]?.targetKey === `presence://${alias}/data/x.txt` &&
        emitted.args[1]?.kind === 'present' &&
        emitted.args[1]?.version === 'v1' &&
        emitted.args[2]?.agent === fakeAgent,
      JSON.stringify(emitted?.args?.slice(0, 2)),
    );
    check(
      'observation: a presence_read success is recorded under the canonical key',
      lookupObservation('sess-events', `presence://${alias}/data/x.txt`) === 'v1',
    );

    // A presence_write/edit success re-publishes at the new version.
    fakeFs.version = 'v2';
    await bridge.observe(exec({ host: alias }), mountPathFor(alias, '/data/x.txt'));
    check(
      'observation: a write/edit success re-publishes at the new version',
      lookupObservation('sess-events', `/data/x.txt`, { cwd }) === 'v2' &&
        events.at(-1)?.args?.[1]?.version === 'v2',
    );

    // Built-in read post-execute records without re-publishing (the read tool
    // already emitted its own event); built-in edit pre-execute repairs.
    const before = events.length;
    await handlers.get('tools/post-execute')(
      { name: 'read', agent: fakeAgent, arguments: { file_path: mountPathFor(alias, '/data/x.txt') } },
      {},
      async () => undefined,
    );
    check(
      'observation: a built-in read success records the target without a duplicate event',
      events.length === before && lookupObservation('sess-events', `/data/x.txt`, { cwd }) === 'v2',
    );
    const repairEvents = events.length;
    await handlers.get('tools/pre-execute')(
      { name: 'edit', agent: fakeAgent, arguments: { file_path: mountPathFor(alias, '/data/x.txt') } },
      async () => undefined,
    );
    check('observation: a built-in edit is repaired at the recorded version', events.length === repairEvents + 1);
    fakeFs.version = 'v3';
    const staleEvents = events.length;
    await handlers.get('tools/pre-execute')(
      { name: 'edit', agent: fakeAgent, arguments: { file_path: mountPathFor(alias, '/data/x.txt') } },
      async () => undefined,
    );
    check('observation: a changed file is NOT repaired', events.length === staleEvents);
    const resolved = await bridge.resolveObservation(exec(), mountPathFor(alias, '/data/x.txt'));
    check(
      'observation: resolveObservation accepts every spelling for one target',
      resolved?.target?.targetKey === `presence://${alias}/data/x.txt` && resolved?.canonical?.remotePath === '/data/x.txt',
      resolved?.target?.targetKey,
    );
  }

  // -------------------------------------------------------------- housekeeping
  await connection.exec(`rm -rf ${remoteDir}`).catch(() => {});
} catch (error) {
  check('probe completed without an unexpected error', false, error?.stack ?? String(error));
} finally {
  for (const pool of pools) {
    for (const id of jobIds) {
      await pool.stopJob(id).catch(() => {});
    }
    try {
      pool.dispose();
    } catch {
      /* already disposed */
    }
  }
  try {
    await connection?.exec(`rm -rf ${remoteDir}`);
  } catch {
    /* best effort */
  }
  connection?.end?.();
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
