// End-to-end probe for background jobs and port forwarding, using only the
// transport-layer modules (no DSH imports).

import { PresencePool } from '../src/pool.js';

const host = process.argv[2] ?? 'server';
const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
const pool = new PresencePool(settings);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const connection = await pool.connection(host);

  // 1. background job: pid is the job's own group, log fills up, stop kills it
  const job = await pool.startJob(host, {
    command: 'for i in 1 2 3 4 5; do echo tick $i; sleep 1; done',
    cwd: '/tmp',
  });
  check('startJob returns id/pid/log', Boolean(job.id) && Boolean(job.pid) && Boolean(job.logPath), JSON.stringify(job));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const log = await connection.exec(`cat ${job.logPath}`);
  check('job log is flushed while running', log.stdout.includes('tick 1'), JSON.stringify(log.stdout.trim()));
  const killed = await pool.stopJob(job.id);
  const survivors = await connection.exec(`ps -o pid= -g ${job.pid} 2>/dev/null | wc -l`);
  check('stopJob kills the process group', killed.stopped && Number(survivors.stdout.trim()) === 0, `survivors=${survivors.stdout.trim()}`);

  // 2. listJobs reports liveness
  const list = await pool.listJobs();
  check('listJobs returns known jobs', Array.isArray(list) && list.length >= 1, list.map((j) => `${j.id}:${j.state}`).join(','));

  // 3. tunnel preflight: closed port must fail fast, open port must work
  let closedError = null;
  try {
    await pool.openTunnel(host, { remotePort: 65123 });
  } catch (error) {
    closedError = error.message;
  }
  check('openTunnel rejects a closed remote port', Boolean(closedError), closedError ?? 'no error');

  const server = await pool.startJob(host, {
    command: 'python3 -m http.server 18080 --bind 127.0.0.1',
    cwd: '/tmp',
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const tunnel = await pool.openTunnel(host, { remotePort: 18080 });
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/`);
    check('tunnel reaches a live remote service', response.ok, `HTTP ${response.status} via 127.0.0.1:${tunnel.localPort}`);
    await pool.closeTunnel(tunnel.id);
  } finally {
    await pool.stopJob(server.id).catch(() => {});
  }
} finally {
  pool.dispose();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
