// P0 transport probe: progress normalization, spill guarantee, timeout
// semantics, SIGPIPE, and the pool's connection trust state.
//
//   node scripts/p0-transport-probe.mjs [alias]
//
// Plain Node, no DSH imports, against the real host in ~/.ssh/config. Remote
// fixtures live in /tmp and are removed at the end. A temporary ssh config
// (DSH_SSH_CONFIG) gives the retry/degraded checks a deterministic failure:
// 127.0.0.1:1 is refused instantly.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePool, classifyConnectionError } from '../src/pool.js';
import { normalizeProgress } from '../src/core/connection.mjs';
import { readSshConfig } from '../src/core/ssh-config.mjs';

const host = process.argv[2] ?? 'server';
const entry = readSshConfig().get(host);
if (!entry) {
  console.error(`no host "${host}" in ~/.ssh/config`);
  process.exit(1);
}

const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
const EXEC_CAP = 256 * 1024; // connection.mjs OUTPUT_CAP_BYTES
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const previousConfig = process.env.DSH_SSH_CONFIG;
const setConfigEnv = (value) => {
  if (value === undefined) delete process.env.DSH_SSH_CONFIG;
  else process.env.DSH_SSH_CONFIG = value;
};
const tempDirectory = mkdtempSync(join(tmpdir(), 'presence-p0-'));
const sshConfig = (name, body) => {
  const path = join(tempDirectory, name);
  writeFileSync(path, body);
  return path;
};

// ---------------------------------------------------------------- unit checks

check(
  "normalizeProgress last keeps only a line's final carriage-return state",
  normalizeProgress('a\rb\rc\n', 'last') === 'c\n',
  JSON.stringify(normalizeProgress('a\rb\rc\n', 'last')),
);
check(
  'normalizeProgress all turns every CR into a line break',
  normalizeProgress('a\rb\rc\n', 'all') === 'a\nb\nc\n',
  JSON.stringify(normalizeProgress('a\rb\rc\n', 'all')),
);
check(
  'normalizeProgress strip only removes CR',
  normalizeProgress('a\rb\rc\n', 'strip') === 'abc\n',
  JSON.stringify(normalizeProgress('a\rb\rc\n', 'strip')),
);
check(
  'normalizeProgress all folds CRLF to LF',
  normalizeProgress('a\r\nb\r\n', 'all') === 'a\nb\n',
  JSON.stringify(normalizeProgress('a\r\nb\r\n', 'all')),
);
check(
  'normalizeProgress leaves plain text untouched',
  normalizeProgress('x\ny\n', 'last') === 'x\ny\n',
  JSON.stringify(normalizeProgress('x\ny\n', 'last')),
);

const classifierCases = [
  ['connection refused: nothing is listening on that port', 'transient'],
  ['hostname could not be resolved', 'transient'],
  ['timed out during the SSH handshake', 'transient'],
  ['connection closed before the handshake finished', 'transient'],
  ['authentication failed: no usable key, and no password was supplied', 'fatal'],
  ['the private key is passphrase-protected; supply the passphrase', 'fatal'],
  ['no host "nope" in ~/.ssh/config or manual hosts', 'fatal'],
];
const classifierWrong = classifierCases
  .map(([message, expected]) => ({ message, expected, got: classifyConnectionError(new Error(message)) }))
  .filter((row) => row.got !== row.expected);
check(
  'classifier separates transient failures from fatal ones',
  classifierWrong.length === 0,
  classifierWrong.length ? JSON.stringify(classifierWrong) : `${classifierCases.length} cases`,
);

// ------------------------------------------ retry against a deterministic dead host

setConfigEnv(
  sshConfig(
    'ssh_config_dead',
    ['Host presence-p0-dead', '  HostName 127.0.0.1', '  Port 1', '  User nobody', ''].join('\n'),
  ),
);
const deadPool = new PresencePool(settings);
try {
  const before = deadPool.hostState('presence-p0-dead');
  check(
    'hostState before any attempt is idle',
    before.connected === false &&
      before.state === 'idle' &&
      before.lastError === null &&
      before.lastErrorAt === null &&
      before.retries === 0,
    JSON.stringify(before),
  );

  const started = Date.now();
  let retryError = null;
  try {
    await deadPool.connection('presence-p0-dead');
  } catch (error) {
    retryError = error;
  }
  const elapsed = Date.now() - started;
  const failed = deadPool.hostState('presence-p0-dead');
  check(
    'a transient connect failure is retried twice with backoff',
    Boolean(retryError) && /refused/i.test(retryError?.message ?? '') && elapsed >= 700 && failed.retries === 2,
    `elapsed=${elapsed}ms retries=${failed.retries} error=${retryError?.message ?? ''}`,
  );
  check(
    'hostState reports error + lastError after the last attempt failed',
    failed.connected === false &&
      failed.state === 'error' &&
      typeof failed.lastErrorAt === 'number' &&
      /refused/i.test(failed.lastError ?? ''),
    JSON.stringify(failed),
  );

  const row = deadPool.hosts().find((item) => item.alias === 'presence-p0-dead');
  check(
    'hosts() rows carry state + lastError',
    Boolean(row) && 'state' in row && 'lastError' in row && row.state === 'error' && /refused/i.test(row.lastError ?? ''),
    JSON.stringify(row ?? null),
  );

  const fatalStarted = Date.now();
  let fatalError = null;
  try {
    await deadPool.connection('presence-p0-unknown');
  } catch (error) {
    fatalError = error;
  }
  const fatalElapsed = Date.now() - fatalStarted;
  check(
    'an unknown host fails immediately without retries',
    Boolean(fatalError) &&
      /no host/i.test(fatalError?.message ?? '') &&
      fatalElapsed < 300 &&
      deadPool.hostState('presence-p0-unknown').state === 'idle',
    `elapsed=${fatalElapsed}ms error=${fatalError?.message ?? ''}`,
  );

  await deadPool.disconnect('presence-p0-dead');
  const reset = deadPool.hostState('presence-p0-dead');
  check(
    'disconnect() resets hostState to idle',
    reset.connected === false && reset.state === 'idle' && reset.lastError === null && reset.retries === 0,
    JSON.stringify(reset),
  );
} finally {
  deadPool.dispose();
  setConfigEnv(previousConfig);
}

// -------------------------------------------------------------- live host checks

const pool = new PresencePool(settings);
let connection = null;
const spilled = [];
try {
  const before = pool.hostState(host);
  check(
    'hostState before connecting to the real host is idle',
    before.connected === false && before.state === 'idle' && before.lastError === null,
    JSON.stringify(before),
  );

  connection = await pool.connection(host);
  const live = pool.hostState(host);
  check(
    'hostState after connecting is connected',
    live.connected === true && live.state === 'connected' && live.lastError === null && live.retries === 0,
    JSON.stringify(live),
  );
  const hostRow = pool.hosts().find((item) => item.alias === host);
  check(
    'hosts() row for the real host carries state + lastError',
    Boolean(hostRow) && hostRow.connected === true && hostRow.state === 'connected' && hostRow.lastError === null,
    JSON.stringify(hostRow ?? null),
  );

  // --- progress normalization (applied before sizing/clipping) --------------
  const carriageCommand = String.raw`printf 'a\rb\rc\n'`;
  const last = await connection.exec(carriageCommand);
  check(
    "progress 'last' is the default and keeps the final carriage-return state",
    last.stdout === 'c\n',
    JSON.stringify(last.stdout),
  );
  const all = await connection.exec(carriageCommand, { progress: 'all' });
  check("progress 'all' turns CR into line breaks", all.stdout === 'a\nb\nc\n', JSON.stringify(all.stdout));
  const strip = await connection.exec(carriageCommand, { progress: 'strip' });
  check("progress 'strip' drops CR", strip.stdout === 'abc\n', JSON.stringify(strip.stdout));
  const stderrCr = await connection.exec(String.raw`printf 'a\rb\rc\n' >&2`);
  check(
    "progress 'last' applies to stderr too",
    stderrCr.stderr === 'c\n' && stderrCr.stdout === '',
    `stdout=${JSON.stringify(stderrCr.stdout)} stderr=${JSON.stringify(stderrCr.stderr)}`,
  );
  const noNewline = await connection.exec(String.raw`printf 'x\ry'`, { progress: 'last' });
  check('progress last handles a final line without a newline', noNewline.stdout === 'y', JSON.stringify(noNewline.stdout));

  // --- spill guarantee ------------------------------------------------------
  const big = await connection.exec('seq 1 200000');
  const remoteBigBytes = Number((await connection.exec('seq 1 200000 | wc -c')).stdout.trim());
  check(
    'oversized stdout reports a spill path and its bytes',
    big.stdoutTruncated === true &&
      typeof big.stdoutFile === 'string' &&
      big.stdoutFile.startsWith('/tmp/presence-exec-') &&
      Boolean(big.stdoutFileBytes) &&
      big.stdoutFileBytes > EXEC_CAP,
    `file=${big.stdoutFile} bytes=${big.stdoutFileBytes} remote=${remoteBigBytes}`,
  );
  if (big.stdoutFile) spilled.push(big.stdoutFile);
  check(
    'the in-memory head stops exactly at the cap',
    big.stdout.length === EXEC_CAP && big.stdout.startsWith('1\n2\n'),
    `head=${big.stdout.length}`,
  );
  if (big.stdoutFile) {
    const size = Number((await connection.exec(`wc -c < ${shq(big.stdoutFile)}`)).stdout.trim());
    const tail = await connection.exec(`tail -c 8 ${shq(big.stdoutFile)}`);
    check(
      'the spill file holds the complete capture',
      size === big.stdoutFileBytes && size === remoteBigBytes,
      `wc=${size} reported=${big.stdoutFileBytes} seq=${remoteBigBytes}`,
    );
    check('the spill file ends with the last output line', tail.stdout.includes('200000'), JSON.stringify(tail.stdout));
  } else {
    check('the spill file holds the complete capture', false, 'no stdoutFile');
    check('the spill file ends with the last output line', false, 'no stdoutFile');
  }

  const progressSpill = await connection.exec(String.raw`printf 'a\rb\rc\n'; seq 1 200000`);
  if (progressSpill.stdoutFile) spilled.push(progressSpill.stdoutFile);
  check(
    'progress normalization happens before clipping and spilling',
    progressSpill.stdoutTruncated === true &&
      progressSpill.stdout.startsWith('c\n') &&
      progressSpill.stdoutFileBytes === remoteBigBytes + 'c\n'.length,
    `head=${JSON.stringify(progressSpill.stdout.slice(0, 20))} bytes=${progressSpill.stdoutFileBytes}`,
  );
  if (progressSpill.stdoutFile) {
    const head = await connection.readText(progressSpill.stdoutFile, { length: 32 });
    check(
      'the spill file holds the normalized stream (no CR)',
      head.content.startsWith('c\n') && !head.content.includes('\r'),
      JSON.stringify(head.content.slice(0, 24)),
    );
  } else {
    check('the spill file holds the normalized stream (no CR)', false, 'no stdoutFile');
  }

  const stderrBig = await connection.exec('seq 1 200000 >&2');
  if (stderrBig.stderrFile) spilled.push(stderrBig.stderrFile);
  check(
    'oversized stderr spills to its own file',
    stderrBig.stderrTruncated === true &&
      typeof stderrBig.stderrFile === 'string' &&
      stderrBig.stderrFile.includes('-stderr') &&
      stderrBig.stderrFileBytes === remoteBigBytes &&
      stderrBig.stdout === '',
    `file=${stderrBig.stderrFile} bytes=${stderrBig.stderrFileBytes}`,
  );

  // --- a failed spill is reported, never dropped ----------------------------
  const originalWrite = connection.writeText.bind(connection);
  const attempted = [];
  connection.writeText = async (path) => {
    attempted.push(path);
    throw new Error('ENOSPC: no space left on device');
  };
  let failedSpill = null;
  try {
    failedSpill = await connection.exec('seq 1 200000', { maxOutputBytes: 16 * 1024 });
  } finally {
    connection.writeText = originalWrite;
  }
  check(
    'a failed spill is retried once and then reported with its reason',
    failedSpill.stdoutTruncated === true &&
      failedSpill.stdoutFile === null &&
      'stdoutFile' in failedSpill &&
      failedSpill.stdoutFileBytes === 0 &&
      /ENOSPC/.test(failedSpill.stdoutFileError ?? '') &&
      attempted.length === 2 &&
      /-retry\.log$/.test(attempted[1] ?? ''),
    `attempts=${attempted.join(', ')} error=${failedSpill.stdoutFileError ?? ''}`,
  );

  // --- timeout semantics + partial output ----------------------------------
  const timeoutStarted = Date.now();
  const timed = await connection.exec(String.raw`printf 'before-timeout\n'; sleep 5`, { timeoutMs: 800 });
  const timeoutElapsed = Date.now() - timeoutStarted;
  check(
    'a timeout keeps partial output and reports the kill sequence',
    timed.timedOut === true &&
      timed.killed === true &&
      Array.isArray(timed.killSequence) &&
      timed.killSequence.join(',') === 'SIGTERM,SIGKILL' &&
      timed.code === 124 &&
      timed.stdout.includes('before-timeout') &&
      timeoutElapsed < 3000,
    `timedOut=${timed.timedOut} killed=${timed.killed} code=${timed.code} sequence=${timed.killSequence} elapsed=${timeoutElapsed}ms stdout=${JSON.stringify(timed.stdout)}`,
  );
  const timedBig = await connection.exec('seq 1 200000; sleep 3', { timeoutMs: 1_500 });
  if (timedBig.stdoutFile) spilled.push(timedBig.stdoutFile);
  check(
    'a timeout spills the partial output when it exceeds the cap',
    timedBig.timedOut === true &&
      timedBig.stdoutTruncated === true &&
      typeof timedBig.stdoutFile === 'string' &&
      timedBig.stdoutFileBytes === remoteBigBytes,
    `file=${timedBig.stdoutFile} bytes=${timedBig.stdoutFileBytes} code=${timedBig.code}`,
  );

  // --- SIGPIPE --------------------------------------------------------------
  const sigpipe = await connection.exec('set -o pipefail; seq 1 100000 | head -1');
  check(
    'SIGPIPE is flagged without rewriting the exit code',
    sigpipe.sigpipe === true && sigpipe.code === 141,
    `code=${sigpipe.code} signal=${sigpipe.signal} sigpipe=${sigpipe.sigpipe}`,
  );

  // --- connection reuse / reconnect / degraded ------------------------------
  const reused = await pool.connection(host);
  check('a live cached connection is reused', reused === connection, reused === connection ? 'same object' : 'new object');

  await pool.disconnect(host);
  const disconnected = pool.hostState(host);
  check(
    'disconnect() resets the real host to idle',
    disconnected.connected === false && disconnected.state === 'idle' && disconnected.lastError === null,
    JSON.stringify(disconnected),
  );
  connection = await pool.connection(host);
  const reconnected = pool.hostState(host);
  check(
    'connection() reconnects after a disconnect',
    connection !== reused && connection.closed === false && reconnected.connected === true && reconnected.state === 'connected',
    JSON.stringify(reconnected),
  );

  // Degraded = a recent failure, then a working connection. The temp config
  // points the real alias at a refused port, so the retry path runs for real.
  await pool.disconnect(host);
  setConfigEnv(
    sshConfig(
      'ssh_config_refused',
      [`Host ${host}`, '  HostName 127.0.0.1', '  Port 1', '  User nobody', ''].join('\n'),
    ),
  );
  let transientError = null;
  try {
    await pool.connection(host);
  } catch (error) {
    transientError = error;
  }
  setConfigEnv(previousConfig);
  const errored = pool.hostState(host);
  check(
    'a transient failure on the real alias retries and reports error',
    Boolean(transientError) && errored.state === 'error' && errored.retries === 2 && /refused/i.test(errored.lastError ?? ''),
    `retries=${errored.retries} state=${errored.state} error=${errored.lastError ?? ''}`,
  );
  connection = await pool.connection(host);
  const degraded = pool.hostState(host);
  check(
    'degraded = a recent failure plus a usable connection',
    degraded.connected === true &&
      degraded.state === 'degraded' &&
      /refused/i.test(degraded.lastError ?? '') &&
      typeof degraded.lastErrorAt === 'number',
    JSON.stringify(degraded),
  );
  const degradedRow = pool.hosts().find((item) => item.alias === host);
  check(
    'hosts() renders the degraded state with its last error',
    degradedRow?.state === 'degraded' && degradedRow?.connected === true && /refused/i.test(degradedRow?.lastError ?? ''),
    JSON.stringify(degradedRow ?? null),
  );
} catch (error) {
  console.error(`probe aborted: ${error?.stack ?? error}`);
  check('probe completed without aborting', false, String(error?.message ?? error));
} finally {
  setConfigEnv(previousConfig);
  try {
    if (connection && spilled.length > 0) {
      await connection.exec(`rm -f -- ${[...new Set(spilled)].map(shq).join(' ')}`);
    }
  } catch {
    /* cleanup is best effort */
  }
  try {
    pool.dispose();
  } catch {
    /* already gone */
  }
  rmSync(tempDirectory, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
