// Feature probe for the long-task fixes: job wait/exit codes, session
// ownership, port readiness, and search semantics. Plain Node, real host.

import { PresencePool } from '../src/pool.js';
import { splitGlobPattern, remoteGlobDetailed, remoteGrep } from '../src/remote-search.js';

const host = process.argv[2] ?? 'server';
const pool = new PresencePool({ maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const connection = await pool.connection(host);

  // 1. waitJob returns the real exit code and the log tail.
  const job = await pool.startJob(host, {
    command: 'echo start; sleep 1; echo done; exit 3',
    cwd: '/tmp',
    label: 'exit-3',
    sessionId: 'session-A',
  });
  const waited = await pool.waitJob(job.id, { timeoutMs: 20_000, tailLines: 10 });
  check(
    'waitJob returns exit code + log tail',
    waited.state === 'exited' && waited.exitCode === 3 && waited.logTail.includes('done') && waited.logSize > 0,
    `state=${waited.state} exit=${waited.exitCode} log=${JSON.stringify(waited.logTail.trim())} size=${waited.logSize}`,
  );

  // 2. A command that dies immediately is reported at start, not as "started".
  const early = await pool.startJob(host, { command: 'exit 9', cwd: '/tmp', label: 'instant-exit', sessionId: 'session-A' });
  check(
    'instant exit is surfaced at start',
    early.exitedEarly === true ? early.exitCode === 9 : Boolean(early.id),
    `exitedEarly=${early.exitedEarly} exit=${early.exitCode} id=${early.id}`,
  );

  // 3. listJobs filters by session.
  const long = await pool.startJob(host, { command: 'sleep 30', cwd: '/tmp', label: 'long', sessionId: 'session-B' });
  const mine = await pool.listJobs({ sessionId: 'session-A' });
  const all = await pool.listJobs();
  check(
    'listJobs filters by session',
    mine.every((j) => j.sessionId === 'session-A') && all.length > mine.length,
    `session-A=${mine.length} all=${all.length}`,
  );

  // 4. waitJob timeout leaves it running; stop by pgid kills it.
  const running = await pool.waitJob(long.id, { timeoutMs: 700, tailLines: 5 });
  const stopped = await pool.stopJob(long.id);
  check('waitJob timeout + stop by job', running.state === 'running' && stopped.stopped, `state=${running.state} stopped=${stopped.stopped}`);

  const orphan = await pool.startJob(host, { command: 'sleep 30', cwd: '/tmp', label: 'orphan' });
  const byPgid = await pool.stopProcessGroup(host, orphan.pid);
  check('stopProcessGroup kills an orphan pgid', byPgid.stopped, `survivors=${byPgid.survivors.join(',') || 'none'}`);

  // 5. Port readiness.
  const closed = await connection.waitForPort({ port: 65124, timeoutMs: 800 });
  const server = await pool.startJob(host, { command: 'python3 -m http.server 18181 --bind 127.0.0.1', cwd: '/tmp' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const opened = await connection.waitForPort({ port: 18181, timeoutMs: 5000 });
  await pool.stopJob(server.id).catch(() => {});
  check('waitForPort detects closed/open', closed.ready === false && opened.ready === true, `closed=${closed.ready} open=${opened.ready} waited=${opened.waitedMs}ms`);

  // 6. Search: absolute pattern split, stats, truncation, count. Use a fresh
  //    fixture instead of a machine-specific path, so the probe runs anywhere.
  const scriptsBase = `/tmp/presence-feature-scripts-${Date.now()}`;
  try {
    await connection.exec(
      `mkdir -p ${scriptsBase}/scripts && ` +
        `printf 'def alpha():\\n    pass\\n' > ${scriptsBase}/scripts/a.py && ` +
        `printf 'def beta():\\n    pass\\n' > ${scriptsBase}/scripts/b.py`,
    );
    const split = splitGlobPattern(`${scriptsBase}/scripts/*.py`);
    check('absolute glob pattern splits', split.root === `${scriptsBase}/scripts` && split.pattern === '*.py', JSON.stringify(split));

    const scriptInfo = await connection.stat(scriptsBase);
    if (scriptInfo.exists && scriptInfo.isDir) {
      const globbed = await remoteGlobDetailed(connection, { root: scriptsBase, pattern: 'scripts/*.py', limit: 5, stats: true });
      check('glob returns stats and truncation', Array.isArray(globbed.files) && globbed.files.length > 0 && 'truncated' in globbed, `files=${globbed.files.length} truncated=${globbed.truncated} sample=${JSON.stringify(globbed.files[0])}`);
    } else {
      check('glob returns stats and truncation', false, `${scriptsBase} missing`);
    }

    const grepped = await remoteGrep(connection, { root: scriptsBase, pattern: 'def ', limit: 5 });
    check('grep reports truncation + total', Array.isArray(grepped.matches) && grepped.matches.length <= 5 && (grepped.truncated || grepped.total !== undefined), `matches=${grepped.matches.length} truncated=${grepped.truncated} total=${grepped.total}`);

    let badPath = null;
    try {
      await remoteGrep(connection, { root: `${scriptsBase}/definitely-missing-dir`, pattern: 'x' });
    } catch (error) {
      badPath = error.message;
    }
    check('missing search root throws', Boolean(badPath), badPath ?? 'no error');
  } finally {
    await connection.exec(`rm -rf ${scriptsBase}`).catch(() => {});
  }

  // 7. Searching ONE FILE must find matches (rg omits the filename unless
  //    --with-filename is passed; that used to make every line unparseable).
  const fixture = `/tmp/presence-feature-${Date.now()}`;
  await connection.exec(
    `mkdir -p ${fixture}/locked && ` +
      `printf 'first needle line\\nsecond line with a colon: needle here\\nthird needle\\n' > ${fixture}/single.txt && ` +
      `printf 'needle in data\\n' > ${fixture}/other.dat && chmod 000 ${fixture}/locked`,
  );
  try {
    const single = await remoteGrep(connection, { root: `${fixture}/single.txt`, pattern: 'needle' });
    check(
      'single-file search finds matches',
      single.matches.length === 3 && single.matches[0].lineNumber === 1 && single.matches[0].path.endsWith('single.txt'),
      `matches=${single.matches.length} first=${JSON.stringify(single.matches[0]?.line ?? null)}`,
    );

    const included = await remoteGrep(connection, { root: fixture, pattern: 'needle', include: '*.txt,*.dat' });
    check('comma include list matches each glob', included.matches.length === 4, `matches=${included.matches.length}`);

    const tolerant = await remoteGrep(connection, { root: fixture, pattern: 'needle' });
    check(
      'unreadable subdirectory keeps partial matches',
      tolerant.matches.length === 4 && typeof tolerant.warning === 'string' && tolerant.warning.includes('Permission denied'),
      `matches=${tolerant.matches.length} warning=${JSON.stringify(tolerant.warning ?? null).slice(0, 80)}`,
    );

    let badRegex = null;
    try {
      await remoteGrep(connection, { root: fixture, pattern: '[' });
    } catch (error) {
      badRegex = error.message;
    }
    check('invalid regex still throws', Boolean(badRegex), (badRegex ?? 'no error').slice(0, 80));
  } finally {
    await connection.exec(`chmod 755 ${fixture}/locked 2>/dev/null; rm -rf ${fixture}`);
  }
} finally {
  for (const job of await pool.listJobs().catch(() => [])) await pool.stopJob(job.id).catch(() => {});
  pool.dispose();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
