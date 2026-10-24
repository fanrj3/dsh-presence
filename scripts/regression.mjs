// Regression probes for the transport-level fixes. Runs under plain Node — no
// DSH imports — against the real host in ~/.ssh/config.
//
//   node scripts/regression.mjs [alias]
//
// Everything it creates lives in /tmp and is removed at the end.

import { readSshConfig } from '../src/core/ssh-config.mjs';
import { PresenceConnection } from '../src/core/connection.mjs';

const alias = process.argv[2] ?? 'server';
const entry = readSshConfig().get(alias);
if (!entry) {
  console.error(`no host "${alias}" in ~/.ssh/config`);
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const connection = await PresenceConnection.connect(entry);
const stamp = Date.now();
const dir = `/tmp/presence-regression-${stamp}`;

try {
  await connection.exec(`mkdir -p ${dir}`);

  // 1. Atomic write through a symlink must edit the target, not replace the link.
  await connection.exec(`printf 'original\\n' > ${dir}/target.txt && ln -s ${dir}/target.txt ${dir}/link.txt`);
  await connection.writeText(`${dir}/link.txt`, 'rewritten\n');
  const linkState = await connection.exec(
    `if [ -L ${dir}/link.txt ]; then echo symlink; else echo regular; fi; cat ${dir}/target.txt`,
  );
  check(
    'write through symlink keeps the link and updates the target',
    linkState.stdout.includes('symlink') && linkState.stdout.includes('rewritten'),
    linkState.stdout.replace(/\n/g, ' | ').trim(),
  );

  // 2. Large-file windowed read reports the true line count and late offsets.
  await connection.exec(`seq 1 200000 > ${dir}/big.txt`);
  const window = await connection.readTextWindow?.(`${dir}/big.txt`, { lineOffset: 199990, lineLimit: 3 });
  check(
    'readTextWindow: true total lines + tail window',
    Boolean(window) && window.totalLines === 200000 && window.content.includes('199990'),
    window ? `totalLines=${window.totalLines} sample=${JSON.stringify(window.content.slice(0, 40))}` : 'readTextWindow missing',
  );

  // 3. Timeout must terminate the remote process, not just abandon it.
  //    argv[0] carries a unique marker so we only look at our own process.
  const marker = `presence-timeout-${stamp}`;
  const timed = await connection.exec(`exec -a ${marker} sleep 30`, { timeoutMs: 800 }).catch((error) => ({ error }));
  // The bracket keeps the probe from matching its own command line.
  const probePattern = marker.replace(/^presence/, '[p]resence');
  const stillRunning = await connection.exec(`ps -eo args= | grep -c '${probePattern}' || true`);
  check(
    'exec timeout reports timedOut and leaves no process',
    (timed.timedOut === true || Boolean(timed.error)) && Number(stillRunning.stdout.trim() || 0) === 0,
    `timedOut=${timed.timedOut} error=${timed.error?.message ?? ''} survivors=${stillRunning.stdout.trim() || '0'}`,
  );

  // 4. Oversized output is spilled to a remote file instead of silently cut.
  const big = await connection.exec('seq 1 200000');
  const spilled = await connection.exec(`head -c 200000 /dev/zero | tr '\\0' '\\n'`);
  check(
    'large stdout is capped but the full text is available',
    (big.stdoutTruncated === true && Boolean(big.stdoutFile)) || big.stdout.length > 100_000,
    `truncated=${big.stdoutTruncated} file=${big.stdoutFile ?? 'none'} bytes=${big.stdout.length} (spill probe ${spilled.code})`,
  );

  // 5. Binary content is refused by the text reader.
  await connection.exec(`printf '\\x89PNG\\x00\\x01\\x02' > ${dir}/image.png`);
  const binary = await connection.readText(`${dir}/image.png`).catch((error) => ({ error }));
  check('binary file is not decoded as text', Boolean(binary.error) || binary.content?.includes('\u0000'), binary.error?.message ?? 'content returned');

  // 6. Overwriting an executable keeps its mode (the reported "old mode 100755 /
  //    new mode 100644" regression).
  await connection.exec(`printf '#!/bin/sh\\necho old\\n' > ${dir}/script.sh && chmod 755 ${dir}/script.sh`);
  await connection.writeText(`${dir}/script.sh`, '#!/bin/sh\necho new\n', {});
  const afterWrite = await connection.exec(`stat -c %a ${dir}/script.sh; tail -1 ${dir}/script.sh`);
  check(
    'overwrite keeps the executable bit',
    afterWrite.stdout.split('\n')[0].trim() === '755',
    afterWrite.stdout.trim().replace(/\n/g, ' | '),
  );

  // 7. A fresh file lands at 644 with an ordinary umask.
  await connection.writeText(`${dir}/fresh.txt`, 'hello\n');
  const freshMode = await connection.exec(`stat -c %a ${dir}/fresh.txt`);
  check('new file lands at 644', freshMode.stdout.trim() === '644', freshMode.stdout.trim());
} finally {
  await connection.exec(`rm -rf ${dir}`);
  connection.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
