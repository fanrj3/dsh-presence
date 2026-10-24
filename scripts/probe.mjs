// Zero-install probe: prove that a machine from ~/.ssh/config becomes usable
// without uploading, installing, or configuring anything on the far side.
//
//   node scripts/probe.mjs server

import { PresenceConnection } from '../src/core/connection.mjs';
import { listHosts, readSshConfig } from '../src/core/ssh-config.mjs';

const alias = process.argv[2] ?? 'server';
const config = readSshConfig();
const entry = config.get(alias);

if (!entry) {
  console.error(`no host "${alias}" in ~/.ssh/config`);
  console.error(`known: ${listHosts().map((host) => host.alias).join(', ') || '(none)'}`);
  process.exit(1);
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const row = (name, values) => {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `${name.padEnd(26)} n=${String(values.length).padStart(3)}  avg=${avg.toFixed(2).padStart(7)}ms  p50=${percentile(values, 50)
      .toFixed(2)
      .padStart(7)}ms  p95=${percentile(values, 95).toFixed(2).padStart(7)}ms`,
  );
};
const ok = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

console.log(`\n=== Presence zero-install probe → ${alias} (${entry.user ?? '?'}@${entry.hostname}:${entry.port}) ===\n`);

const started = performance.now();
const connection = await PresenceConnection.connect(entry);
const connectMs = performance.now() - started;
console.log(`connected in ${connectMs.toFixed(0)}ms (one handshake, nothing installed on the host)\n`);

const uname = await connection.exec('uname -srm');
ok('remote exec', uname.code === 0, uname.stdout.trim());

const home = (await connection.realpath('.')).replace(/\/+$/, '');
const where = await connection.exec('printf "%s" "$(id -un) $(hostname)"');
console.log(`remote identity: ${where.stdout.trim()} · home ${home}\n`);

// latency ---------------------------------------------------------------
const stats = [];
for (let i = 0; i < 100; i += 1) {
  const t = performance.now();
  await connection.stat('/etc/hostname');
  stats.push(performance.now() - t);
}
row('sftp stat', stats);

const execMs = [];
for (let i = 0; i < 50; i += 1) {
  const t = performance.now();
  await connection.exec('true');
  execMs.push(performance.now() - t);
}
row('exec channel', execMs);

const burstStart = performance.now();
await Promise.all(Array.from({ length: 8 }, () => connection.exec('echo concurrent')));
console.log(`\n8 concurrent exec channels in ${(performance.now() - burstStart).toFixed(0)}ms (one connection, no extra handshakes)`);

const pipelineStart = performance.now();
await Promise.all(Array.from({ length: 50 }, () => connection.stat('/etc/hostname')));
console.log(`50 pipelined sftp stats in ${(performance.now() - pipelineStart).toFixed(0)}ms\n`);

// real work -------------------------------------------------------------
const scratch = `${home}/presence-probe-${Date.now()}.txt`;
const payload = 'alpha\nbeta\ngamma\n';
await connection.writeText(scratch, payload);
const read = await connection.readText(scratch);
ok('sftp write + read', read.content === payload, `${read.size} bytes`);

const edit = await connection.editText(scratch, 'beta', 'BETA');
ok('sftp edit', edit.replaced === 1, `${edit.bytes} bytes`);

const ambiguous = await connection.editText(scratch, 'a', 'A').then(
  () => ({ code: 'no-error' }),
  (error) => error,
);
ok('ambiguous edit rejected', ambiguous.code === 'ambiguous', ambiguous.message);

const listing = await connection.list(home);
ok('sftp list', listing.length > 0, `${listing.length} entries, first: ${listing[0]?.name}`);

const grep = await connection.exec(`rg -n --no-heading -S BETA ${JSON.stringify(scratch)} || true`);
ok('remote rg', grep.stdout.includes('BETA'), grep.stdout.trim().split('\n')[0]);

// a terminal that lives on the connection --------------------------------
const shell = await connection.shell({ cols: 100, rows: 30 });
let ptyOutput = '';
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 8000);
  shell.on('data', (chunk) => {
    ptyOutput += chunk;
    // the echoed command contains the literal marker; only the expanded result
    // starts with `PRESENCE_PTY_OK:/`
    if (/PRESENCE_PTY_OK:\//.test(ptyOutput)) {
      clearTimeout(timer);
      resolve();
    }
  });
  shell.write('printf "PRESENCE_PTY_OK:%s\\n" "$(pwd)"; exit\n');
});
ok('interactive pty', /PRESENCE_PTY_OK:\//.test(ptyOutput), ptyOutput.replace(/\r/g, '').trim().split('\n').pop());

await connection.exec(`rm -f ${JSON.stringify(scratch)}`);
connection.end();

console.log(`\n=== ${alias} is now a local-feeling workspace with zero setup on the host ===`);
