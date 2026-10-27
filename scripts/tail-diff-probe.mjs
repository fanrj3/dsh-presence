// Probe for the Presence 0.18.0 diff/tail layer: the presence_diff and
// presence_tail tools plus the frozen src/diff.js and src/tail.js helpers that
// /presence/api/diff and /presence/api/tail also import.
//
//   node scripts/tail-diff-probe.mjs [alias]
//
// src/tools.js imports @deepseek-ai/dsh-tools, which only exists inside the
// Harness runtime. A loader hook maps that specifier to an identity
// `defineTool`, so the real tool implementations run here unchanged.
//
// Remote fixtures live in /tmp and are removed at the end; the local file used
// by the localPath diff lives in the OS temp directory and is removed too.
// Exit code is non-zero when any check fails.

import { register } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePool } from '../src/pool.js';
import { diffLines } from '../src/diff.js';

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
const exec = {};
const call = (name, args = {}) => {
  const definition = tools.get(name);
  if (!definition) throw new Error(`tool ${name} is not defined`);
  return definition.execute({ host: alias, ...args }, exec);
};
const asJson = (value) => JSON.parse(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const dir = `/tmp/presence-018-tail-diff-${stamp}`;
const localDir = mkdtempSync(join(tmpdir(), 'presence-018-diff-'));

try {
  // ---------------------------------------------------------------- fixtures
  const setup = await connection.exec(
    `mkdir -p ${dir} && ` +
      `seq 1 1000 > ${dir}/count.txt && ` +
      `printf 'alpha\\nbeta\\ngamma\\ndelta\\n' > ${dir}/old.txt && ` +
      `printf 'alpha\\nBETA\\ngamma\\ndelta\\n' > ${dir}/new.txt && ` +
      `printf 'alpha\\nbeta\\ngamma\\ndelta\\n' > ${dir}/same-new.txt && ` +
      `printf 'alpha\\nbeta\\ngamma\\ndelta\\n' > ${dir}/same-old.txt && ` +
      `printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > ${dir}/small.txt && ` +
      `printf 'initial-1\\ninitial-2\\n' > ${dir}/append.log && ` +
      `printf 'x\\ny' > ${dir}/noeol.txt && ` +
      `printf 'local-diff\\n' > ${dir}/local-side.txt`,
  );
  check('fixtures created', setup.code === 0, String(setup.stderr ?? '').trim());

  // --------------------------------------------------------- diff helper API
  const identical = diffLines('alpha\nbeta\n', 'alpha\nbeta\n');
  check(
    'diff helper: identical input yields empty diff and zero counts',
    identical.diff === '' && identical.added === 0 && identical.removed === 0 && identical.truncated === false,
    JSON.stringify(identical),
  );

  const changed = diffLines('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n');
  check(
    'diff helper: one changed line gives added=1 removed=1 and a hunk',
    changed.added === 1 &&
      changed.removed === 1 &&
      changed.diff.startsWith('@@ -1,3 +1,3 @@') &&
      changed.diff.includes('-beta') &&
      changed.diff.includes('+BETA'),
    JSON.stringify(changed.diff),
  );

  const zeroContext = diffLines('a\nb\nc\n', 'a\nB\nc\n', { context: 0 });
  const zeroRows = zeroContext.diff.split('\n').filter((row) => !row.startsWith('@@'));
  check(
    'diff helper: context:0 emits only changed rows',
    zeroRows.length === 2 && zeroRows.every((row) => row.startsWith('-') || row.startsWith('+')),
    JSON.stringify(zeroContext.diff),
  );

  const truncated = diffLines('a\n', 'b\nc\nd\ne\nf\ng\n', { maxLines: 3 });
  check(
    'diff helper: maxLines truncates the rendered diff but counts the whole change',
    truncated.truncated === true && truncated.added === 6 && truncated.removed === 1,
    `truncated=${truncated.truncated} added=${truncated.added} removed=${truncated.removed}`,
  );

  const crlf = diffLines('a\r\nb\r\n', 'a\nb\n');
  check('diff helper: CRLF vs LF is not reported as a change', crlf.diff === '' && crlf.added === 0, JSON.stringify(crlf));

  // ------------------------------------------------------------- diff tool
  const remoteDiff = await call('presence_diff', { a: `${dir}/old.txt`, b: `${dir}/new.txt`, context: 1 });
  const remoteHeader = remoteDiff.split('\n')[0];
  check(
    'presence_diff remote vs remote: header + hunk + counts',
    remoteHeader.includes('+1 -1') && remoteDiff.includes('@@ ') && remoteDiff.includes('-beta') && remoteDiff.includes('+BETA'),
    remoteHeader,
  );

  const remoteJson = asJson(await call('presence_diff', { a: `${dir}/old.txt`, b: `${dir}/new.txt`, format: 'json' }));
  check(
    'presence_diff json: {stats:{added,removed}, diff, truncated}',
    remoteJson.stats?.added === 1 &&
      remoteJson.stats?.removed === 1 &&
      typeof remoteJson.diff === 'string' &&
      remoteJson.diff.includes('+BETA') &&
      remoteJson.truncated === false,
    JSON.stringify({ stats: remoteJson.stats, truncated: remoteJson.truncated }),
  );

  const noChanges = await call('presence_diff', { a: `${dir}/same-old.txt`, b: `${dir}/same-new.txt` });
  check('presence_diff: identical files return "(no changes)"', noChanges.includes('(no changes)'), noChanges.split('\n')[0]);

  const localFile = join(localDir, 'local-side.txt');
  writeFileSync(localFile, 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n', 'utf8');
  const localDiff = asJson(
    await call('presence_diff', { a: `${dir}/old.txt`, localPath: localFile, format: 'json' }),
  );
  check(
    'presence_diff localPath: CRLF local copy of an LF remote file is identical',
    localDiff.stats.added === 0 && localDiff.stats.removed === 0 && localDiff.diff === '',
    JSON.stringify(localDiff.stats),
  );

  const localChanged = await call('presence_diff', { a: `${dir}/local-side.txt`, localPath: localFile });
  check(
    'presence_diff localPath: change is detected and the local path is labelled',
    localChanged.includes(localFile) && localChanged.includes('-local-diff') && localChanged.includes('+alpha'),
    localChanged.split('\n')[0],
  );

  let bothError = null;
  try {
    await call('presence_diff', { a: `${dir}/old.txt`, b: `${dir}/new.txt`, localPath: localFile });
  } catch (error) {
    bothError = errorOf(error);
  }
  check('presence_diff: b plus localPath is rejected', /exactly one/.test(bothError ?? ''), (bothError ?? 'no error').slice(0, 80));

  let neitherError = null;
  try {
    await call('presence_diff', { a: `${dir}/old.txt` });
  } catch (error) {
    neitherError = errorOf(error);
  }
  check('presence_diff: neither b nor localPath is rejected', /exactly one/.test(neitherError ?? ''), (neitherError ?? 'no error').slice(0, 80));

  let missingError = null;
  try {
    await call('presence_diff', { a: `${dir}/missing.txt`, b: `${dir}/new.txt` });
  } catch (error) {
    missingError = errorOf(error);
  }
  check('presence_diff: a missing file is an actionable error', /does not exist/.test(missingError ?? ''), (missingError ?? 'no error').slice(0, 80));

  // ------------------------------------------------------------- tail tool
  const tailText = await call('presence_tail', { path: `${dir}/count.txt` });
  const tailLines = tailText.split('\n');
  if (tailLines.length > 0 && tailLines[tailLines.length - 1] === '') tailLines.pop();
  const tailHeader = tailLines[0];
  const tailBody = tailLines.slice(1);
  check(
    'presence_tail: default returns the last 200 of 1000 lines',
    tailBody.length === 200 &&
      tailBody[0] === '801' &&
      tailBody[tailBody.length - 1] === '1000' &&
      tailHeader.includes('200 line(s)') &&
      tailHeader.includes('truncated'),
    `${tailHeader} first=${tailBody[0]} last=${tailBody[tailBody.length - 1]}`,
  );

  const tailJson = asJson(await call('presence_tail', { path: `${dir}/count.txt`, format: 'json' }));
  check(
    'presence_tail json: path/lines/bytes/followedMs/truncated/text',
    tailJson.path === `${dir}/count.txt` &&
      tailJson.lines === 200 &&
      tailJson.bytes === Buffer.byteLength(tailJson.text, 'utf8') &&
      tailJson.followedMs === 0 &&
      tailJson.truncated === true &&
      tailJson.text.trimEnd().endsWith('1000'),
    JSON.stringify({
      path: tailJson.path,
      lines: tailJson.lines,
      bytes: tailJson.bytes,
      followedMs: tailJson.followedMs,
      truncated: tailJson.truncated,
    }),
  );

  const smallTail = asJson(await call('presence_tail', { path: `${dir}/small.txt`, lines: 50, format: 'json' }));
  check(
    'presence_tail: a small file returns every line and truncated:false',
    smallTail.lines === 5 && smallTail.truncated === false && smallTail.text.trimEnd().endsWith('five'),
    `lines=${smallTail.lines} truncated=${smallTail.truncated}`,
  );

  const tenLines = asJson(await call('presence_tail', { path: `${dir}/count.txt`, lines: 10, format: 'json' }));
  const ten = tenLines.text.split('\n').filter((line) => line !== '');
  check(
    'presence_tail: lines=10 returns 991..1000',
    ten.length === 10 && ten[0] === '991' && ten[9] === '1000' && tenLines.truncated === true,
    `first=${ten[0]} last=${ten[9]}`,
  );

  const noEol = asJson(await call('presence_tail', { path: `${dir}/noeol.txt`, lines: 1, format: 'json' }));
  check(
    'presence_tail: a file without a final newline returns its last line',
    noEol.lines === 1 && noEol.text === 'y',
    JSON.stringify(noEol.text),
  );

  // follow: append while the tool is waiting, then check both appends arrive.
  const followStarted = Date.now();
  const pendingTail = call('presence_tail', {
    path: `${dir}/append.log`,
    lines: 50,
    follow: true,
    timeoutMs: 1600,
    format: 'json',
  });
  await sleep(700);
  await connection.exec(`printf 'TAIL-APPEND-1\\n' >> ${dir}/append.log`);
  await sleep(300);
  await connection.exec(`printf 'TAIL-APPEND-2\\n' >> ${dir}/append.log`);
  const followed = asJson(await pendingTail);
  const followElapsed = Date.now() - followStarted;
  check(
    'presence_tail follow:true returns bytes appended during the window',
    followed.text.includes('TAIL-APPEND-1') &&
      followed.text.includes('TAIL-APPEND-2') &&
      followed.text.includes('initial-2') &&
      followed.followedMs >= 1200 &&
      followElapsed >= 1400,
    `followedMs=${followed.followedMs} elapsed=${followElapsed}`,
  );

  const followedLines = followed.text.split('\n').filter((line) => line !== '');
  check(
    'presence_tail follow: line count and byte count describe the returned text',
    followed.lines === followedLines.length && followed.bytes === Buffer.byteLength(followed.text, 'utf8'),
    `lines=${followed.lines}/${followedLines.length} bytes=${followed.bytes}`,
  );

  let tailMissingError = null;
  try {
    await call('presence_tail', { path: `${dir}/missing.txt` });
  } catch (error) {
    tailMissingError = errorOf(error);
  }
  check('presence_tail: a missing file is an actionable error', /does not exist/.test(tailMissingError ?? ''), (tailMissingError ?? 'no error').slice(0, 80));

  let tailDirError = null;
  try {
    await call('presence_tail', { path: dir });
  } catch (error) {
    tailDirError = errorOf(error);
  }
  check('presence_tail: a directory is refused', /is a directory/.test(tailDirError ?? ''), (tailDirError ?? 'no error').slice(0, 80));
} finally {
  await connection.exec(`rm -rf ${dir}`).catch(() => {});
  rmSync(localDir, { recursive: true, force: true });
  pool.dispose();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
