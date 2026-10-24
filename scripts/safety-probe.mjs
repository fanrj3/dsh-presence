// Safety probe: destructive-command guard + observation store.
//
//   node scripts/safety-probe.mjs [alias]
//
// Creates fixtures under /tmp on the remote host and removes them afterwards.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destructiveKind, guardDestructive } from '../src/destructive.js';
import { recordObservation, lookupObservation } from '../src/observed-store.js';
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

// ---------------------------------------------------------------- classification
const positive = {
  'rm -rf build': 'rm',
  'rm -r ./tmp': 'rm',
  'sudo rm -f x': 'rm?',
  'git clean -fdx': 'git-clean',
  'find . -name "*.log" -delete': 'find-delete',
  'dd if=/dev/zero of=/dev/sda': 'truncate',
};
for (const [command, expected] of Object.entries(positive)) {
  const kind = destructiveKind(command);
  const ok = expected === 'rm?' ? Boolean(kind) : kind === expected;
  check(`classify: ${command}`, ok, `-> ${kind}`);
}
for (const command of ['ls -la', 'rm file.txt', 'grep -rn x .', 'git clean -n', 'find . -name x']) {
  check(`benign: ${command}`, destructiveKind(command) === null, `-> ${destructiveKind(command)}`);
}

// ---------------------------------------------------------------- store
const storeDir = mkdtempSync(join(tmpdir(), 'presence-observed-'));
process.env.DSH_HOME = storeDir;
recordObservation('session-1', 'presence://h/a.ts', 'presence:1:1:f');
check('store round-trips a version', lookupObservation('session-1', 'presence://h/a.ts') === 'presence:1:1:f');
check('store isolates sessions', lookupObservation('session-2', 'presence://h/a.ts') === null);
rmSync(storeDir, { recursive: true, force: true });

// ---------------------------------------------------------------- guard on a real host
const connection = await PresenceConnection.connect(entry);
const root = `/tmp/presence-safe-${Date.now()}`;
try {
  await connection.exec(
    `mkdir -p ${root}/ws/build ${root}/ws/.git ${root}/ws/.tmesh && ` +
      `printf 'x\\n' > ${root}/ws/build/out.o && printf 'x\\n' > ${root}/ws/.tmesh/state && ` +
      `printf 'x\\n' > ${root}/ws/.git/config && cd ${root}/ws && git init -q .`,
  );
  const workspace = { path: `${root}/ws` };
  const base = { connection, cwd: `${root}/ws`, workspace, host: alias };

  // 1. unset variable: the exact shape of the reported incident
  let unsetError = null;
  try {
    await guardDestructive({ ...base, command: 'rm -rf $PRESENCE_UNSET_VAR/x', confirm: false });
  } catch (error) {
    unsetError = error;
  }
  check(
    'unset variable blocks the command',
    unsetError?.code === 'destructive_unset_variable',
    unsetError?.message?.split('\n')[0] ?? 'no error',
  );

  // 2. workspace root
  let rootError = null;
  try {
    await guardDestructive({ ...base, command: `rm -rf ${root}/ws`, confirm: true });
  } catch (error) {
    rootError = error;
  }
  check('workspace root is always refused', /workspace root/i.test(rootError?.message ?? ''), rootError?.message?.split('\n')[0] ?? 'no error');

  // 3. ancestor of the workspace
  let ancestorError = null;
  try {
    await guardDestructive({ ...base, command: 'rm -rf /tmp', confirm: true });
  } catch (error) {
    ancestorError = error;
  }
  check('workspace ancestor is refused', /ancestor/i.test(ancestorError?.message ?? ''), ancestorError?.message?.split('\n')[0] ?? 'no error');

  // 4. .git metadata
  let gitError = null;
  try {
    await guardDestructive({ ...base, command: `rm -rf ${root}/ws/.git`, confirm: true });
  } catch (error) {
    gitError = error;
  }
  check('.git metadata is refused', /git repository metadata/i.test(gitError?.message ?? ''), gitError?.message?.split('\n')[0] ?? 'no error');

  // 5. a safe destructive command produces a dry-run report and does not execute
  const safe = await guardDestructive({ ...base, command: 'rm -rf build', confirm: false });
  const buildStillThere = await connection.exec(`test -d ${root}/ws/build && echo yes || echo no`);
  check(
    'safe target: report lists it, nothing removed',
    Boolean(safe?.report.includes(`${root}/ws/build`)) && buildStillThere.stdout.trim() === 'yes',
    `report=${safe ? 'yes' : 'no'} build=${buildStillThere.stdout.trim()}`,
  );

  // 6. confirmed execution is the caller's step: the guard still returns a report
  const confirmed = await guardDestructive({ ...base, command: 'rm -rf build', confirm: true });
  check('confirmed destructive still pre-checks', Boolean(confirmed?.kind === 'rm'), `kind=${confirmed?.kind}`);

  // 7. empty (but set) variable expands to a parent path and is surfaced in the report
  const emptyVar = await guardDestructive({ ...base, command: 'J=""; rm -rf .tmesh/$J', confirm: false });
  check(
    'empty variable resolves to the collapsed path in the report',
    Boolean(emptyVar?.report.includes(`${root}/ws/.tmesh`)),
    emptyVar?.report.split('\n').slice(-2).join(' | ').slice(0, 160),
  );

  // 8. git clean dry-run lists untracked files without deleting them
  await connection.exec(`printf 'x\\n' > ${root}/ws/untracked.txt`);
  const clean = await guardDestructive({ ...base, command: 'git clean -fdx', confirm: false });
  const untracked = await connection.exec(`test -e ${root}/ws/untracked.txt && echo yes || echo no`);
  check(
    'git clean dry run lists untracked files',
    Boolean(clean?.report.includes('untracked.txt')) && untracked.stdout.trim() === 'yes',
    `listed=${Boolean(clean?.report.includes('untracked.txt'))} kept=${untracked.stdout.trim()}`,
  );

  // 9. trash: move a directory away recoverably, list it, restore it
  if (typeof connection.trash !== 'function') {
    check('trash support is available', false, 'connection.trash is missing');
  } else {
    const victim = `${root}/ws/build`;
    const trashed = await connection.trash(victim);
    const goneAfterTrash = await connection.exec(`test -e ${victim} && echo yes || echo no`);
    const trashList = await connection.listTrash({ limit: 5 });
    check(
      'trash moves the path and lists it',
      trashed.trashed !== false &&
        goneAfterTrash.stdout.trim() === 'no' &&
        trashList.some((entry) => entry.trashPath === trashed.trashPath),
      `trashed=${trashed.trashed} trashPath=${trashed.trashPath} listed=${trashList.length}`,
    );

    const restored = await connection.restoreTrash(trashed.trashPath, { to: victim });
    const backAgain = await connection.exec(`test -f ${victim}/out.o && echo yes || echo no`);
    check(
      'restore puts the path (and contents) back',
      backAgain.stdout.trim() === 'yes',
      `restored to ${restored.to ?? victim}`,
    );

    let rootRefusal = null;
    try {
      await connection.trash('/');
    } catch (error) {
      rootRefusal = error.message;
    }
    check('trash refuses /', Boolean(rootRefusal), (rootRefusal ?? 'no error').slice(0, 80));
  }
} finally {
  await connection.exec(`rm -rf ${root}; rm -rf ~/.dsh/presence-trash 2>/dev/null`);
  connection.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
