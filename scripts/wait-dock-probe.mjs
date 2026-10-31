// Wait-dock probe (0.21): registry + API + tool instrumentation, real host.
//
//   node scripts/wait-dock-probe.mjs [alias]
//
// No DSH runtime: a loader hook maps @deepseek-ai/dsh-tools to an identity
// `defineTool`, then the real tool implementations run against a real host.
//
// Covers:
//   - wait registry lifecycle: entry shape, samples cadence/240 cap, lastLine/
//     error clipping, end-freeze, list ordering, activeOnly, prune window,
//     maxEntries (finished first, then oldest running), clear/dispose,
//     unknown ids never throwing;
//   - waitUntil onPoll: called after non-final polls only, observed/polls/
//     elapsedMs/met:false, throwing callback harmless, return shape unchanged;
//   - GET /presence/api/waits: payload shape, `?active=1` filter, absent
//     registry => empty list, loopback fence, both route spellings;
//   - presence_jobs wait on a real `sleep` job with a fake `Epoch 3/10` log line
//     and progressPattern/progressUnit/label; running entry visible mid-wait;
//     done/timeout end states; text output gains progress only with a pattern;
//   - presence_wait file with progressTotal + label (live progress, done bytes);
//     job condition (host null); timeout end state; result payload unchanged.
//
// Fixtures live under /tmp and are removed; jobs are stopped in `finally`.

import { register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { PresencePool } from '../src/pool.js';
import { createWaitRegistry } from '../src/waits.js';
import { waitUntil } from '../src/wait.js';
import { presenceRoutes } from '../src/api.js';

const alias = process.argv[2] ?? 'server';
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const remoteDir = `/tmp/presence-waitdock-${stamp}`;
const fakeHome = mkdtempSync(join(tmpdir(), 'presence-waitdock-home-'));
process.env.DSH_HOME = fakeHome;

// ---------------------------------------------------------------- dsh-tools stub
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
const { definePresenceTools } = await import('../src/tools.js');

// ------------------------------------------------------------------- harness
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asJson = (value) => JSON.parse(value);
const expectError = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const ENTRY_KEYS = [
  'error',
  'exitCode',
  'host',
  'id',
  'kind',
  'label',
  'lastLine',
  'meta',
  'progress',
  'samples',
  'startedAt',
  'state',
  'timeoutMs',
  'updatedAt',
].sort();

// ------------------------------------------------------------- fake clock
/** Run a synchronous section with a controllable Date.now(). */
function withFakeClock(start, run) {
  const realNow = Date.now;
  let fakeNow = start;
  Date.now = () => fakeNow;
  const clock = {
    advance(ms) {
      fakeNow += ms;
      return fakeNow;
    },
    now() {
      return fakeNow;
    },
  };
  try {
    return run(clock);
  } finally {
    Date.now = realNow;
  }
}

// -------------------------------------------------------------- 1. registry
function probeRegistry() {
  console.log('\n=== wait registry ===');
  withFakeClock(1_000_000, (clock) => {
    const registry = createWaitRegistry({ keepFinishedMs: 60_000, maxEntries: 50 });
    const entry = registry.begin({
      kind: 'wait',
      host: alias,
      label: 'probe wait',
      timeoutMs: 5_000,
      meta: { condition: '{"kind":"file"}', jobId: 'j1', ignoredKey: 'drop me' },
    });
    check('begin returns the frozen entry shape', entry && /^w-\d+$/.test(entry.id) && Object.keys(entry).sort().join(',') === ENTRY_KEYS.join(','), JSON.stringify(entry));
    check(
      'begin seeds a running entry with empty progress/samples',
      entry.state === 'running' &&
        entry.kind === 'wait' &&
        entry.host === alias &&
        entry.timeoutMs === 5_000 &&
        entry.progress.done === null &&
        entry.progress.total === null &&
        entry.samples.length === 0,
    );
    check(
      'meta keeps known keys as strings only',
      entry.meta.condition === '{"kind":"file"}' && entry.meta.jobId === 'j1' && !('ignoredKey' in entry.meta),
      JSON.stringify(entry.meta),
    );
    check('get returns the same entry by id', registry.get(entry.id)?.id === entry.id && registry.get('w-nope') === null);

    registry.update(entry.id, { progress: { done: 1, total: 10, unit: 'bytes' } });
    clock.advance(100);
    registry.update(entry.id, { progress: { done: 2 } });
    clock.advance(500);
    registry.update(entry.id, { progress: { done: 3 } });
    let live = registry.get(entry.id);
    check(
      'samples respect the 500 ms spacing and keep newest last',
      live.samples.length === 2 && live.samples[0].done === 1 && live.samples[1].done === 3 && live.samples[1].at - live.samples[0].at >= 500,
      JSON.stringify(live.samples),
    );
    check('progress patch merges and keeps unit', live.progress.done === 3 && live.progress.total === 10 && live.progress.unit === 'bytes');

    for (let index = 0; index < 300; index += 1) {
      clock.advance(500);
      registry.update(entry.id, { progress: { done: index, total: 300 } });
    }
    live = registry.get(entry.id);
    check('samples are capped at 240', live.samples.length === 240, `len=${live.samples.length}`);
    check('the cap drops the oldest samples (newest last)', live.samples.at(-1).done === 299);

    registry.update(entry.id, { lastLine: 'x'.repeat(400), error: 'e'.repeat(600), exitCode: 7, state: 'running' });
    live = registry.get(entry.id);
    check('lastLine/error are clipped and exitCode kept', live.lastLine.length === 300 && live.error.length === 500 && live.exitCode === 7, `line=${live.lastLine.length} error=${live.error.length}`);

    clock.advance(10);
    const ended = registry.end(entry.id, { state: 'done', exitCode: 0 });
    check('end applies the final patch', ended.state === 'done' && ended.exitCode === 0 && ended.updatedAt >= ended.startedAt);
    clock.advance(600);
    registry.update(entry.id, { state: 'running', lastLine: 'after end' });
    live = registry.get(entry.id);
    check('a finished entry is frozen against later updates', live.state === 'done' && live.lastLine !== 'after end');
    check('unknown ids are a no-op, never a throw', registry.update('w-unknown', { state: 'done' }) === null && registry.end(undefined) === null && registry.update(entry.id, null) !== null);

    // list ordering + activeOnly + clone isolation
    const first = registry.begin({ kind: 'wait', label: 'first' });
    clock.advance(5);
    const second = registry.begin({ kind: 'job', label: 'second' });
    const all = registry.list();
    check(
      'list sorts by startedAt and reports both states',
      all.length === 3 && all[0].id === ended.id && all[1].id === first.id && all[2].id === second.id,
      all.map((row) => row.id).join(','),
    );
    const active = registry.list({ activeOnly: true });
    check('activeOnly keeps running entries only', active.length === 2 && active.every((row) => row.state === 'running'));
    all[1].meta.mutated = 'yes';
    check('list returns serializable copies', registry.get(first.id).meta.mutated === undefined);

    registry.clear();
    check('clear empties the registry', registry.list().length === 0 && registry.get(first.id) === null);
  });

  // prune window (finished entry disappears) + maxEntries cap.
  withFakeClock(2_000_000, (clock) => {
    const registry = createWaitRegistry({ keepFinishedMs: 1_000, maxEntries: 50 });
    const old = registry.begin({ label: 'old' });
    clock.advance(10);
    registry.end(old.id, { state: 'done' });
    clock.advance(500);
    check('a finished entry stays inside the keep window', registry.list().length === 1);
    clock.advance(600);
    check('a finished entry is pruned after the keep window', registry.list().length === 0);

    const capped = createWaitRegistry({ keepFinishedMs: 60_000, maxEntries: 3 });
    const c1 = capped.begin({ label: 'c1' });
    clock.advance(1);
    const c2 = capped.begin({ label: 'c2' });
    clock.advance(1);
    const c3 = capped.begin({ label: 'c3' });
    capped.end(c1.id, { state: 'done' });
    clock.advance(1);
    const c4 = capped.begin({ label: 'c4' });
    const cappedIds = capped.list().map((row) => row.id);
    check(
      'maxEntries evicts the oldest finished entry first',
      cappedIds.length === 3 && !cappedIds.includes(c1.id) && cappedIds.includes(c2.id) && cappedIds.includes(c3.id) && cappedIds.includes(c4.id),
      cappedIds.join(','),
    );

    const hard = createWaitRegistry({ keepFinishedMs: 60_000, maxEntries: 2 });
    const h1 = hard.begin({ label: 'h1' });
    clock.advance(1);
    const h2 = hard.begin({ label: 'h2' });
    clock.advance(1);
    const h3 = hard.begin({ label: 'h3' });
    const hardIds = hard.list().map((row) => row.id);
    check(
      'maxEntries also bounds a flood of running waits',
      hardIds.length === 2 && !hardIds.includes(h1.id) && hardIds.includes(h2.id) && hardIds.includes(h3.id),
      hardIds.join(','),
    );

    const disposed = createWaitRegistry();
    disposed.begin({ label: 'before dispose' });
    disposed.dispose();
    check('dispose clears and disables the registry', disposed.begin({ label: 'after' }) === null && disposed.list().length === 0);
  });
}

// ------------------------------------------------------------ 2. onPoll hook
async function probeOnPoll() {
  console.log('\n=== waitUntil onPoll ===');
  let statCalls = 0;
  const connection = {
    async stat(path) {
      statCalls += 1;
      return { path, exists: statCalls >= 2, size: 0, mtime: 0, isDir: false };
    },
  };
  const polls = [];
  const result = await waitUntil({
    connection,
    condition: { kind: 'file', path: '/tmp/does-not-matter' },
    timeoutMs: 2_000,
    pollMs: 10,
    onPoll: (poll) => polls.push(poll),
  });
  check(
    'onPoll sees every non-final poll with met:false',
    polls.length >= 1 &&
      polls.every(
        (poll) =>
          poll.met === false &&
          typeof poll.polls === 'number' &&
          typeof poll.elapsedMs === 'number' &&
          poll.observed &&
          typeof poll.observed === 'object',
      ),
    `${polls.length} poll(s): ${JSON.stringify(polls[0])}`,
  );
  check(
    'waitUntil returns its unchanged shape',
    result.met === true && result.timedOut === false && result.polls >= 2 && Object.keys(result).sort().join(',') === 'condition,elapsedMs,met,observed,polls,timedOut',
    Object.keys(result).sort().join(','),
  );

  let thrown = 0;
  const result2 = await waitUntil({
    connection: { async stat(path) { return { path, exists: true, size: 1, mtime: 0, isDir: false }; } },
    condition: { kind: 'file', path: '/tmp/x' },
    timeoutMs: 1_000,
    pollMs: 10,
    onPoll: () => {
      thrown += 1;
      throw new Error('progress callback exploded');
    },
  });
  check('a throwing onPoll does not break the wait', result2.met === true && thrown === 0);
}

// ---------------------------------------------------------------- 3. Web API
class ProbeRequest extends PassThrough {
  constructor({ method = 'GET', url, remoteAddress = '127.0.0.1' }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3846' };
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

async function callRoute(routes, method, path, { remoteAddress = '127.0.0.1' } = {}) {
  const request = new ProbeRequest({ method, url: path, remoteAddress });
  const response = new ProbeResponse();
  const handler = routes.get(path.split('?')[0]);
  if (typeof handler !== 'function') throw new Error(`no route for ${path.split('?')[0]}`);
  const pending = handler(request, response);
  request.end();
  await pending;
  await response.finished();
  return { status: response.statusCode, json: () => response.json() };
}

async function probeApi() {
  console.log('\n=== GET /presence/api/waits ===');
  const fakePool = { hosts: () => [], listTerminals: () => [] };
  const registry = createWaitRegistry();
  const running = registry.begin({ kind: 'wait', host: alias, label: 'api running', timeoutMs: 60_000, meta: { condition: '{"kind":"file"}' } });
  registry.update(running.id, { progress: { done: 4, total: 10, unit: 'bytes' }, lastLine: '4 of 10' });
  const finished = registry.begin({ kind: 'job', host: alias, label: 'api finished', timeoutMs: 1_000 });
  registry.end(finished.id, { state: 'done', exitCode: 0 });

  const routes = new Map(presenceRoutes(fakePool, { waits: registry }).map((route) => [route.path, route.handler]));
  check(
    'the waits route is registered under both prefixes',
    routes.has('/presence/api/waits') && routes.has('/api/presence/waits'),
    `${routes.size} routes`,
  );

  const all = await callRoute(routes, 'GET', '/presence/api/waits');
  const payload = all.json();
  check(
    'payload is {ok, now, waits[]} with full entries',
    all.status === 200 &&
      payload.ok === true &&
      typeof payload.now === 'number' &&
      Array.isArray(payload.waits) &&
      payload.waits.length === 2 &&
      Object.keys(payload.waits[0]).sort().join(',') === ENTRY_KEYS.join(',') &&
      Array.isArray(payload.waits[0].samples) &&
      payload.waits[0].progress.unit === 'bytes',
    JSON.stringify(payload.waits.map((row) => `${row.id}:${row.state}`)),
  );

  const active = await callRoute(routes, 'GET', '/presence/api/waits?active=1');
  const activePayload = active.json();
  check(
    '?active=1 filters to running waits',
    activePayload.waits.length === 1 && activePayload.waits[0].state === 'running' && activePayload.waits[0].id === running.id,
    JSON.stringify(activePayload.waits.map((row) => row.state)),
  );

  const otherPrefix = await callRoute(routes, 'GET', '/api/presence/waits?active=1');
  check('the /api/presence spelling answers the same payload', otherPrefix.json().waits.length === 1);

  const noRegistry = new Map(presenceRoutes(fakePool, {}).map((route) => [route.path, route.handler]));
  const empty = await callRoute(noRegistry, 'GET', '/presence/api/waits');
  check(
    'an absent registry answers {ok:true, waits:[]}',
    empty.json().ok === true && Array.isArray(empty.json().waits) && empty.json().waits.length === 0,
  );

  const fenced = await callRoute(routes, 'GET', '/presence/api/waits', { remoteAddress: '10.0.0.7' });
  check('the loopback fence still refuses another machine', fenced.status === 403 && fenced.json().ok === false);
  registry.dispose();
}

// ------------------------------------------------------------- 4. real tools
let pool = null;
let tools = null;
const startedJobs = [];
const execCtx = { agent: null, signal: undefined };
const callTool = async (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not defined`);
  return tool.execute({ host: alias, ...args }, execCtx);
};
const startJob = async (command, label) => {
  const job = await pool.startJob(alias, { command, cwd: remoteDir, label });
  startedJobs.push(job.id);
  return job;
};

async function probeJobsWait(waits) {
  console.log('\n=== presence_jobs wait (live progress) ===');
  const job = await startJob(`sleep 1; printf 'Epoch 3/10\\n'; sleep 2`, 'waitdock-progress');
  const pending = callTool('presence_jobs', {
    action: 'wait',
    jobId: job.id,
    timeoutMs: 20_000,
    tailLines: 10,
    label: 'waitdock-job',
    progressPattern: 'Epoch\\s+(\\d+)/(\\d+)',
    progressUnit: 'epochs',
    format: 'json',
  });
  await sleep(1_500);
  const live = waits.list({ activeOnly: true }).find((entry) => entry.kind === 'job');
  check(
    'a running job wait is visible in the dock mid-wait',
    Boolean(live) && live.label === 'waitdock-job' && live.host === alias && live.meta.jobId === job.id && Boolean(live.meta.logPath),
    JSON.stringify(live ? { label: live.label, host: live.host, meta: live.meta, progress: live.progress } : null),
  );
  check(
    'the dock shows the parsed progress and the last log line while running',
    live?.progress?.done === 3 && live?.progress?.total === 10 && live?.progress?.unit === 'epochs' && String(live?.lastLine ?? '').includes('Epoch 3/10'),
    JSON.stringify(live ? { progress: live.progress, lastLine: live.lastLine } : null),
  );

  const json = asJson(await pending);
  check(
    'the JSON report keeps its shape and adds progress only with a pattern',
    json.id === job.id &&
      json.state === 'exited' &&
      json.timedOut === false &&
      json.exitCode === 0 &&
      json.progress.done === 3 &&
      json.progress.total === 10 &&
      json.progress.unit === 'epochs',
    JSON.stringify(json),
  );
  const finished = waits.list().find((entry) => entry.meta?.jobId === job.id);
  check(
    'the finished wait is frozen as done with exitCode and lastLine',
    finished?.state === 'done' && finished?.exitCode === 0 && String(finished?.lastLine ?? '').includes('Epoch 3/10') && finished?.progress?.done === 3,
    JSON.stringify(finished ? { state: finished.state, exitCode: finished.exitCode, progress: finished.progress } : null),
  );

  // Text output: unchanged without a pattern, one added line with one.
  const textJob = await startJob(`sleep 0.3; printf 'Step 1/2\\n'`, 'waitdock-text');
  const text = await callTool('presence_jobs', {
    action: 'wait',
    jobId: textJob.id,
    timeoutMs: 15_000,
    label: 'waitdock-text',
    progressPattern: 'Step\\s+(\\d+)/(\\d+)',
    format: 'text',
  });
  check(
    'text wait gains a progress line when a pattern was used',
    text.startsWith(`job ${textJob.id} on ${alias}: state=exited`) && text.includes('progress: 1/2 steps'),
    text.split('\n').slice(-2).join(' | '),
  );

  const timeoutJob = await startJob('sleep 30', 'waitdock-timeout');
  const timeoutJson = asJson(
    await callTool('presence_jobs', { action: 'wait', jobId: timeoutJob.id, timeoutMs: 800, format: 'json', label: 'waitdock-timeout' }),
  );
  const timeoutEntry = waits.list().find((entry) => entry.meta?.jobId === timeoutJob.id);
  check(
    'a job wait timeout keeps the JSON shape and ends the entry as timeout',
    timeoutJson.timedOut === true && timeoutJson.exitSummary === null && timeoutJson.state !== 'exited' && !('progress' in timeoutJson) && timeoutEntry?.state === 'timeout',
    `state=${timeoutJson.state} timedOut=${timeoutJson.timedOut} entry=${timeoutEntry?.state}`,
  );
  const timeoutText = await callTool('presence_jobs', { action: 'wait', jobId: timeoutJob.id, timeoutMs: 500, format: 'text' });
  check(
    'the timeout text report keeps the 0.20 wording and adds no progress line',
    timeoutText.startsWith(`job ${timeoutJob.id} on ${alias}: state=`) && timeoutText.includes('did not exit within') && !timeoutText.includes('progress:'),
    timeoutText.split('\n')[0],
  );
  await pool.stopJob(timeoutJob.id).catch(() => {});

  const badPattern = await expectError(() =>
    callTool('presence_jobs', { action: 'wait', jobId: job.id, timeoutMs: 500, progressPattern: 'no-groups-here' }),
  );
  check('a progressPattern without two groups is rejected before waiting', Boolean(badPattern) && badPattern.includes('two capture groups'), badPattern);
}

async function probePresenceWait(waits) {
  console.log('\n=== presence_wait (live progress) ===');
  const growJob = await startJob(`sleep 2; head -c 30 /dev/zero > ${remoteDir}/grow.bin`, 'waitdock-grow');
  const target = `${remoteDir}/grow.bin`;
  const pending = callTool('presence_wait', {
    file: { path: target, minBytes: 20 },
    timeoutMs: 20_000,
    pollMs: 200,
    label: 'waitdock-file',
    progressTotal: 30,
    format: 'json',
  });
  await sleep(600);
  const live = waits.list({ activeOnly: true }).find((entry) => entry.kind === 'wait');
  check(
    'a running presence_wait is visible in the dock mid-wait',
    Boolean(live) && live.label === 'waitdock-file' && live.host === alias && live.meta.condition.includes('"kind":"file"'),
    JSON.stringify(live ? { label: live.label, host: live.host, progress: live.progress } : null),
  );
  const json = asJson(await pending);
  check(
    'presence_wait file result is unchanged (no progress field) and met',
    json.met === true &&
      json.timedOut === false &&
      json.observed?.exists === true &&
      Object.keys(json).sort().join(',') === 'condition,elapsedMs,met,observed,polls,timedOut',
    Object.keys(json).sort().join(','),
  );
  const finished = waits.list().find((entry) => entry.meta?.condition?.includes('"kind":"file"'));
  check(
    'file progress reports done bytes, progressTotal and the bytes unit',
    finished?.state === 'done' && finished?.progress?.done >= 20 && finished?.progress?.total === 30 && finished?.progress?.unit === 'bytes' && finished?.samples.length >= 1,
    JSON.stringify(finished ? { state: finished.state, progress: finished.progress, samples: finished.samples.length } : null),
  );
  await pool.stopJob(growJob.id).catch(() => {});

  // A condition that never becomes true: timeout end state, result unchanged.
  const timeoutJson = asJson(
    await callTool('presence_wait', {
      file: { path: `${remoteDir}/never-appears.bin` },
      timeoutMs: 700,
      pollMs: 100,
      label: 'waitdock-timeout-file',
      format: 'json',
    }),
  );
  const timeoutEntry = waits.list().find((entry) => entry.label === 'waitdock-timeout-file');
  check(
    'a presence_wait timeout ends the entry as timeout and keeps met:false',
    timeoutJson.met === false && timeoutJson.timedOut === true && timeoutEntry?.state === 'timeout',
    `met=${timeoutJson.met} entry=${timeoutEntry?.state}`,
  );

  // Job condition: host null, state-only progress; process lastLine.
  const shortJob = await startJob('sleep 1', 'waitdock-short');
  const jobResult = asJson(
    await callTool('presence_wait', { job: { jobId: shortJob.id }, timeoutMs: 15_000, pollMs: 200, label: 'waitdock-job-condition', format: 'json' }),
  );
  const jobEntry = waits.list().find((entry) => entry.label === 'waitdock-job-condition');
  check(
    'a job-condition wait ends done with host null and the job state as lastLine',
    jobResult.met === true && jobEntry?.state === 'done' && jobEntry?.host === null && jobEntry?.lastLine === 'exited',
    JSON.stringify(jobEntry ? { state: jobEntry.state, host: jobEntry.host, lastLine: jobEntry.lastLine } : null),
  );

  const sleeper = await startJob('sleep 30', 'waitdock-sleeper');
  const processJson = asJson(
    await callTool('presence_wait', {
      process: { pid: sleeper.pid, alive: true },
      timeoutMs: 10_000,
      pollMs: 200,
      label: 'waitdock-process',
      format: 'json',
    }),
  );
  const processEntry = waits.list().find((entry) => entry.label === 'waitdock-process');
  check(
    'process waits map observed.alive to lastLine alive/gone',
    processJson.met === true && processEntry?.state === 'done' && processEntry?.lastLine === 'alive',
    JSON.stringify(processEntry ? { state: processEntry.state, lastLine: processEntry.lastLine } : null),
  );
  await pool.stopJob(sleeper.id).catch(() => {});
}

// ------------------------------------------------------------------- driver
try {
  probeRegistry();
  await probeOnPoll();
  await probeApi();

  const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false, defaultHost: null };
  const waits = createWaitRegistry();
  pool = new PresencePool(settings);
  tools = new Map(definePresenceTools(pool, settings, { cwdOf: async () => null, waits }).map((tool) => [tool.name, tool]));
  check('the tool surface still defines 25 tools', tools.size === 25, `${tools.size} tools`);
  check('definePresenceTools accepts the waits option without changing names', tools.has('presence_wait') && tools.has('presence_jobs'));

  const connection = await pool.connection(alias);
  await connection.exec(`mkdir -p ${remoteDir}`);
  console.log(`\nconnected to ${alias}; fixtures in ${remoteDir}`);

  await probeJobsWait(waits);
  await probePresenceWait(waits);
} catch (error) {
  console.error(`\nprobe crashed: ${error?.stack ?? String(error)}`);
  results.push({ name: 'probe completed', ok: false });
} finally {
  try {
    if (pool) {
      for (const id of startedJobs) await pool.stopJob(id).catch(() => {});
      const connection = await pool.connection(alias).catch(() => null);
      if (connection) await connection.exec(`rm -rf ${remoteDir}`).catch(() => {});
      pool.dispose();
    }
  } catch {
    /* cleanup is best effort */
  }
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const entry of failed) console.log(`  FAILED: ${entry.name}`);
process.exit(failed.length === 0 ? 0 : 1);
