// Probe for the Presence 0.18.0 file-operation layer: the presence_mkdir /
// presence_move / presence_copy / presence_chmod tools and the frozen
// src/path-ops.js helpers that /presence/api/path-op also imports.
//
//   node scripts/path-ops-probe.mjs [alias]
//
// src/tools.js imports @deepseek-ai/dsh-tools, which only exists inside the
// Harness runtime. A loader hook maps that specifier to an identity
// `defineTool`, so the real tool implementations run here unchanged.
//
// Everything it creates lives in /tmp on the remote machine and is removed at
// the end. Exit code is non-zero when any check fails.

import { register } from 'node:module';
import { PresencePool } from '../src/pool.js';
import { makeDirectory, movePath, copyPath, chmodPath } from '../src/path-ops.js';

const alias = process.argv[2] ?? 'server';

const stubSource = `export function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
    annotations: definition.annotations,
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

const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false };
const pool = new PresencePool(settings);
const { definePresenceTools } = await import('../src/tools.js');
const tools = new Map(
  definePresenceTools(pool, settings, { cwdOf: async () => null }).map((definition) => [definition.name, definition]),
);
const readOnlyTools = new Map(
  definePresenceTools(pool, { ...settings, readOnly: true }, { cwdOf: async () => null }).map((definition) => [
    definition.name,
    definition,
  ]),
);
const exec = {};
const call = (name, args = {}) => {
  const definition = tools.get(name);
  if (!definition) throw new Error(`tool ${name} is not defined`);
  return definition.execute({ host: alias, ...args }, exec);
};
const callReadOnly = (name, args = {}) => readOnlyTools.get(name).execute({ host: alias, ...args }, exec);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

function errorOf(error) {
  return error?.message ?? String(error);
}

const connection = await pool.connection(alias);
const stamp = Date.now();
const dir = `/tmp/presence-018-probe-${stamp}`;

async function statOf(path) {
  return connection.stat(path);
}

async function readRemote(path) {
  const info = await connection.stat(path);
  if (!info.exists) return null;
  return (await connection.readText(path, { length: info.size })).content;
}

try {
  // ---------------------------------------------------------------- fixtures
  const setup = await connection.exec(
    `mkdir -p ${dir}/tree/sub && ` +
      `printf 'alpha\\nbeta\\n' > ${dir}/a.txt && ` +
      `printf 'one\\ntwo\\nthree\\n' > ${dir}/move-src.txt && ` +
      `printf 'old\\n' > ${dir}/move-dst.txt && ` +
      `printf 'copy me\\n' > ${dir}/copy-src.txt && chmod 751 ${dir}/copy-src.txt && ` +
      `printf 'stale\\n' > ${dir}/tree/keep.txt && ` +
      `printf 'root-file\\n' > ${dir}/tree/root.txt && ` +
      `printf 'nested\\n' > ${dir}/tree/sub/nested.txt`,
  );
  check('fixtures created', setup.code === 0, String(setup.stderr ?? '').trim());

  // ------------------------------------------------------------------ mkdir
  const mkdirText = await call('presence_mkdir', { path: `${dir}/fresh/nested/deep` });
  const mkdirStat = await statOf(`${dir}/fresh/nested/deep`);
  check(
    'mkdir: creates a nested path (parents default true)',
    mkdirStat.exists === true && mkdirStat.isDir === true && mkdirText.includes('created directory'),
    mkdirText.split('\n')[0],
  );

  const mkdirAgain = await call('presence_mkdir', { path: `${dir}/fresh/nested/deep` });
  check('mkdir: idempotent on an existing directory', mkdirAgain.includes('already exists'), mkdirAgain.split('\n')[0]);

  let mkdirParentError = null;
  try {
    await call('presence_mkdir', { path: `${dir}/missing-parent/child`, parents: false });
  } catch (error) {
    mkdirParentError = errorOf(error);
  }
  check(
    'mkdir parents:false: missing parent is an actionable error',
    /parent directory|does not exist/.test(mkdirParentError ?? ''),
    (mkdirParentError ?? 'no error').slice(0, 90),
  );

  // ------------------------------------------------------------------- move
  const moveText = await call('presence_move', { from: `${dir}/move-src.txt`, to: `${dir}/move-new.txt` });
  const movedContent = await readRemote(`${dir}/move-new.txt`);
  const movedGone = await statOf(`${dir}/move-src.txt`);
  check(
    'move: renames a file and removes the source',
    movedContent === 'one\ntwo\nthree\n' && movedGone.exists === false && moveText.includes('moved'),
    moveText.split('\n')[0],
  );

  let moveRefuseError = null;
  try {
    await call('presence_move', { from: `${dir}/move-new.txt`, to: `${dir}/move-dst.txt` });
  } catch (error) {
    moveRefuseError = errorOf(error);
  }
  const dstUntouched = await readRemote(`${dir}/move-dst.txt`);
  check(
    'move: refuses an existing destination unless overwrite:true',
    /refusing to move onto|overwrite:true/.test(moveRefuseError ?? '') && dstUntouched === 'old\n',
    (moveRefuseError ?? 'no error').slice(0, 90),
  );

  const moveOverwriteText = await call('presence_move', {
    from: `${dir}/move-new.txt`,
    to: `${dir}/move-dst.txt`,
    overwrite: true,
  });
  const overwritten = await readRemote(`${dir}/move-dst.txt`);
  check(
    'move overwrite:true replaces the destination file',
    overwritten === 'one\ntwo\nthree\n' && moveOverwriteText.includes('moved'),
    moveOverwriteText.split('\n')[0],
  );

  // ------------------------------------------------------------------- copy
  const copyText = await call('presence_copy', { from: `${dir}/copy-src.txt`, to: `${dir}/copy-dst.txt` });
  const copyContent = await readRemote(`${dir}/copy-dst.txt`);
  const copyMode = await statOf(`${dir}/copy-dst.txt`);
  check(
    'copy: file content is preserved',
    copyContent === 'copy me\n' && copyMode.exists === true && copyMode.isFile === true,
    `content=${JSON.stringify(copyContent)} mode=${String(copyMode.mode).padStart(4, '0')}`,
  );
  check(
    'copy: file copy reports bytes/files and preserves 0751',
    copyText.includes('1 file(s)') && copyText.includes('8 B') && (copyMode.mode & 0o777) === 0o751,
    copyText.split('\n')[0],
  );

  let copyRefuseError = null;
  try {
    await call('presence_copy', { from: `${dir}/copy-src.txt`, to: `${dir}/copy-dst.txt` });
  } catch (error) {
    copyRefuseError = errorOf(error);
  }
  check(
    'copy: refuses an existing destination unless overwrite:true',
    /refusing to overwrite|overwrite:true/.test(copyRefuseError ?? ''),
    (copyRefuseError ?? 'no error').slice(0, 90),
  );

  await call('presence_copy', { from: `${dir}/copy-src.txt`, to: `${dir}/copy-dst.txt`, overwrite: true });
  check('copy overwrite:true replaces an existing file', (await readRemote(`${dir}/copy-dst.txt`)) === 'copy me\n');

  let copyDirError = null;
  try {
    await call('presence_copy', { from: `${dir}/tree`, to: `${dir}/tree-copy` });
  } catch (error) {
    copyDirError = errorOf(error);
  }
  check(
    'copy: a directory requires recursive:true',
    /is a directory/.test(copyDirError ?? '') && /recursive:true/.test(copyDirError ?? ''),
    (copyDirError ?? 'no error').slice(0, 90),
  );

  const copyTreeText = await call('presence_copy', { from: `${dir}/tree`, to: `${dir}/tree-copy`, recursive: true });
  const treeDiff = await connection.exec(`diff -r ${dir}/tree ${dir}/tree-copy >/dev/null 2>&1; echo $?`);
  const copyTreeStat = await statOf(`${dir}/tree-copy/sub/nested.txt`);
  check(
    'copy recursive:true copies the whole tree',
    treeDiff.stdout.trim() === '0' && copyTreeStat.exists === true && copyTreeText.includes('file(s)'),
    `${copyTreeText.split('\n')[0]} diffExit=${treeDiff.stdout.trim()}`,
  );

  // Replace an existing tree: a file that only existed in the old destination
  // must be gone after the overwrite, and the copied tree must be complete.
  await connection.exec(`printf 'stale\\n' > ${dir}/tree-copy/stale-only-in-dest.txt`);
  const copyTreeOverwrite = await call('presence_copy', {
    from: `${dir}/tree`,
    to: `${dir}/tree-copy`,
    recursive: true,
    overwrite: true,
  });
  const staleAfter = await statOf(`${dir}/tree-copy/stale-only-in-dest.txt`);
  const rootAfter = await statOf(`${dir}/tree-copy/root.txt`);
  const nestedAfter = await statOf(`${dir}/tree-copy/sub/nested.txt`);
  check(
    'copy recursive overwrite:true replaces the destination tree',
    staleAfter.exists === false && rootAfter.exists === true && nestedAfter.exists === true && copyTreeOverwrite.includes('copied'),
    copyTreeOverwrite.split('\n')[0],
  );

  // ------------------------------------------------------------------ chmod
  const chmodText = await call('presence_chmod', { path: `${dir}/a.txt`, mode: '600' });
  const chmodStat = await statOf(`${dir}/a.txt`);
  check(
    'chmod: string mode "600" is applied and reported',
    (chmodStat.mode & 0o777) === 0o600 && chmodText.includes('0600'),
    `${chmodText.split('\n')[0]} mode=${String(chmodStat.mode).padStart(4, '0')}`,
  );

  const chmodNumberText = await call('presence_chmod', { path: `${dir}/a.txt`, mode: 0o640 });
  const chmodNumberStat = await statOf(`${dir}/a.txt`);
  check(
    'chmod: octal number mode 0o640 is applied',
    (chmodNumberStat.mode & 0o777) === 0o640 && chmodNumberText.includes('0640'),
    `mode=${String(chmodNumberStat.mode).padStart(4, '0')}`,
  );

  const chmodRecursive = await call('presence_chmod', { path: `${dir}/tree`, mode: '700', recursive: true });
  const childMode = await statOf(`${dir}/tree/sub/nested.txt`);
  check(
    'chmod recursive:true applies to the tree',
    (childMode.mode & 0o777) === 0o700 && chmodRecursive.includes('-R 0700'),
    `${chmodRecursive.split('\n')[0]} child=${String(childMode.mode).padStart(4, '0')}`,
  );

  // ------------------------------------------------------- helper contracts
  const helperDir = await makeDirectory(connection, `${dir}/helper/dir`);
  check('helper makeDirectory returns {path}', helperDir.path === `${dir}/helper/dir`, JSON.stringify(helperDir));

  await connection.exec(`printf 'helper-source\\n' > ${dir}/helper-src.txt`);
  const helperCopy = await copyPath(connection, `${dir}/helper-src.txt`, `${dir}/helper-copy.txt`);
  check(
    'helper copyPath returns {from,to,bytes,files}',
    helperCopy.from === `${dir}/helper-src.txt` &&
      helperCopy.to === `${dir}/helper-copy.txt` &&
      helperCopy.bytes === 14 &&
      helperCopy.files === 1,
    JSON.stringify(helperCopy),
  );

  const helperMove = await movePath(connection, `${dir}/helper-copy.txt`, `${dir}/helper-moved.txt`);
  check(
    'helper movePath returns {from,to}',
    helperMove.from === `${dir}/helper-copy.txt` && helperMove.to === `${dir}/helper-moved.txt`,
    JSON.stringify(helperMove),
  );

  const helperChmod = await chmodPath(connection, `${dir}/helper-moved.txt`, '755');
  const helperChmodStat = await statOf(`${dir}/helper-moved.txt`);
  check(
    'helper chmodPath returns {path,mode:"0755"}',
    helperChmod.mode === '0755' && (helperChmodStat.mode & 0o777) === 0o755,
    JSON.stringify(helperChmod),
  );

  let helperRootError = null;
  try {
    await chmodPath(connection, '/', '777');
  } catch (error) {
    helperRootError = errorOf(error);
  }
  check('helper chmodPath refuses /', /refusing to chmod \//.test(helperRootError ?? ''), helperRootError ?? 'no error');

  // ------------------------------------------------------------- read-only
  let readOnlyError = null;
  try {
    await callReadOnly('presence_mkdir', { path: `${dir}/readonly-dir` });
  } catch (error) {
    readOnlyError = errorOf(error);
  }
  const readOnlyStat = await statOf(`${dir}/readonly-dir`);
  check(
    'read-only profile refuses mutating tools and creates nothing',
    /read-only/.test(readOnlyError ?? '') && readOnlyStat.exists === false,
    (readOnlyError ?? 'no error').slice(0, 90),
  );
} finally {
  await connection.exec(`rm -rf ${dir}`).catch(() => {});
  pool.dispose();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
