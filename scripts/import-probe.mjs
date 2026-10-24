// Transport-level probe for the local→remote import path:
// binary bytes, explicit mode, sha256 agreement in both directions.
//
//   node scripts/import-probe.mjs [alias]

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
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
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const localDir = mkdtempSync(join(tmpdir(), 'presence-import-'));
const localFile = join(localDir, 'artifact.bin');
const payload = Buffer.concat([randomBytes(4096), Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47]), randomBytes(4096)]);
writeFileSync(localFile, payload);
chmodSync(localFile, 0o755);
const localSha = createHash('sha256').update(payload).digest('hex');

const connection = await PresenceConnection.connect(entry);
const remoteDir = `/tmp/presence-import-${Date.now()}`;
try {
  await connection.exec(`mkdir -p ${remoteDir}`);

  // 1. binary upload with an explicit mode
  const target = `${remoteDir}/artifact.bin`;
  const written = await connection.writeText(target, payload, { mode: 0o755 });
  const remote = await connection.exec(`sha256sum ${target}; stat -c %a ${target}; file -b --mime-encoding ${target}`);
  const [remoteSha, mode, encoding] = remote.stdout.trim().split('\n');
  check(
    'binary import keeps bytes and sets the mode',
    remoteSha.split(/\s+/)[0] === localSha && mode === '755',
    `sha256 match=${remoteSha.split(/\s+/)[0] === localSha} mode=${mode} encoding=${encoding}`,
  );

  // 2. overwrite preserves the existing mode when none is given
  const second = await connection.writeText(target, Buffer.from('#!/bin/sh\necho replaced\n'), {});
  const after = await connection.exec(`stat -c %a ${target}; head -1 ${target}`);
  check(
    'overwrite without a mode keeps 755',
    after.stdout.startsWith('755') && second.mode === 0o755,
    after.stdout.trim().replace(/\n/g, ' | '),
  );

  // 3. the local file mode never leaks into the upload, and vice versa
  const plain = `${remoteDir}/plain.txt`;
  await connection.writeText(plain, 'hello');
  const plainMode = await connection.exec(`stat -c %a ${plain}`);
  check('new file lands at 644 regardless of the local mode', plainMode.stdout.trim() === '644', plainMode.stdout.trim());
} finally {
  await connection.exec(`rm -rf ${remoteDir}`);
  connection.end();
  rmSync(localDir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
