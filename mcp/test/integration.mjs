// End-to-end test against a real machine, through the MCP client/server pair
// (in-memory transport, so no child process is spawned).
//
//   node mcp/test/integration.mjs [host]
//
// Uses /tmp/presence-mcp-test-<pid> on the remote and cleans it up. Requires a
// reachable host with key auth (the same one the plugin uses).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const host = process.argv[2] ?? process.env.PRESENCE_TEST_HOST ?? 'server';
const remoteRoot = `/tmp/presence-mcp-test-${Date.now().toString(36)}`;
// Must be set before importing the runtime: settings are read at module load.
process.env.PRESENCE_WORKSPACE = `${host}:${remoteRoot}`;

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../app.mjs');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 'presence-integration', version: '0.0.0' });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.map((item) => item.text ?? '').join('\n') ?? '';
  return { text, isError: response.isError === true };
}

let localTemp = null;
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // 1. exec: text, JSON, saveStdout, and saveStdout skipped on a failure
  const echo = await call('presence_exec', { host, command: 'echo hello-from-mcp && uname -s', cwd: '/tmp' });
  check('presence_exec', !echo.isError && echo.text.includes('hello-from-mcp'), echo.text.split('\n')[1]);

  // 1a. hosts + connect as structured data
  const hostsJsonResult = await call('presence_list_hosts', { format: 'json' });
  const hostsJson = parseJson(hostsJsonResult.text);
  const hostRow = Array.isArray(hostsJson) ? hostsJson.find((row) => row.alias === host) : null;
  check('presence_list_hosts format=json',
    !hostsJsonResult.isError && Array.isArray(hostsJson) && hostsJson.length > 0 &&
      typeof hostRow?.address === 'string' && hostRow.address.includes(hostRow?.hostname ?? '\u0000') &&
      typeof hostRow?.user === 'string' && typeof hostRow?.port === 'number' &&
      typeof hostRow?.source === 'string' && (hostRow?.state === 'idle' || hostRow?.state === 'connected') &&
      typeof hostRow?.connected === 'boolean' && typeof hostRow?.default === 'boolean',
    hostsJsonResult.text.slice(0, 240));

  const connectJsonResult = await call('presence_connect', { host, format: 'json' });
  const connectJson = parseJson(connectJsonResult.text);
  check('presence_connect format=json',
    !connectJsonResult.isError && connectJson?.host === host &&
      typeof connectJson?.user === 'string' && connectJson.user.length > 0 &&
      typeof connectJson?.hostname === 'string' && typeof connectJson?.kernel === 'string' &&
      typeof connectJson?.arch === 'string' && typeof connectJson?.platform === 'string' &&
      typeof connectJson?.connectedAtMs === 'number',
    connectJsonResult.text.slice(0, 240));

  const runtimeStatusResult = await call('presence_status', {});
  const runtimeStatus = parseJson(runtimeStatusResult.text);
  check('presence_status 含 uptimeMs / node',
    !runtimeStatusResult.isError && runtimeStatus?.server === 'presence-mcp' &&
      typeof runtimeStatus?.uptimeMs === 'number' && runtimeStatus.uptimeMs >= 0 &&
      runtimeStatus.uptimeMs < 60 * 60 * 1000 && typeof runtimeStatus?.node === 'string' &&
      /^v\d+\./u.test(runtimeStatus.node),
    `server=${runtimeStatus?.server} node=${runtimeStatus?.node} uptimeMs=${runtimeStatus?.uptimeMs}`);

  const execJsonResult = await call('presence_exec', {
    host,
    command: 'printf "json-out\\n"; printf "json-err\\n" >&2; exit 7',
    cwd: '/tmp',
    format: 'json',
  });
  const execJson = parseJson(execJsonResult.text);
  check('presence_exec format=json',
    !execJsonResult.isError && execJson?.exitCode === 7 && execJson?.signal === null &&
      execJson?.cwd === '/tmp' && execJson?.timedOut === false &&
      typeof execJson?.durationMs === 'number' && execJson?.stdout.includes('json-out') &&
      execJson?.stderr.includes('json-err') && execJson?.stdoutTruncated === false,
    execJsonResult.text.slice(0, 180));

  const bigOutResult = await call('presence_exec', { host, command: 'seq 1 10000', cwd: '/tmp', format: 'json' });
  const bigOut = parseJson(bigOutResult.text);
  check('presence_exec format=json 裁剪后仍是合法 JSON',
    !bigOutResult.isError && bigOut?.stdoutTruncated === true && bigOutResult.text.length <= 33 * 1024 &&
      typeof bigOut?.stdout === 'string' && bigOut.stdout.length <= 16 * 1024 + 100,
    `${bigOutResult.text.length} chars, stdout=${bigOut?.stdout?.length ?? '?'} chars, truncated=${bigOut?.stdoutTruncated}`);

  const timeoutResult = await call('presence_exec', {
    host,
    command: 'sleep 5',
    cwd: '/tmp',
    timeoutMs: 1000,
    format: 'json',
  });
  const timeoutBody = parseJson(timeoutResult.text);
  check('presence_exec format=json 超时仍返回结构',
    timeoutBody?.timedOut === true && (timeoutBody?.exitCode === 124 || timeoutBody?.exitCode === null),
    timeoutResult.text.slice(0, 160));

  const saveTarget = `${remoteRoot}/saved/stdout.txt`;
  const saved = await call('presence_exec', {
    host,
    command: 'printf "saved-line\\n"',
    cwd: '/tmp',
    format: 'json',
    saveStdout: saveTarget,
  });
  const savedBody = parseJson(saved.text);
  check('presence_exec saveStdout',
    !saved.isError && savedBody?.exitCode === 0 && savedBody?.savedStdout?.path === saveTarget &&
      savedBody?.savedStdout?.sizeBytes === 11,
    saved.text.slice(0, 180));
  const savedRead = await call('presence_read', { host, path: saveTarget, raw: true });
  check('saveStdout 内容字节一致', !savedRead.isError && savedRead.text === 'saved-line\n', JSON.stringify(savedRead.text));

  const skippedTarget = `${remoteRoot}/saved/never.txt`;
  const skipped = await call('presence_exec', {
    host,
    command: 'printf "no-save"; exit 2',
    cwd: '/tmp',
    format: 'json',
    saveStdout: skippedTarget,
  });
  const skippedBody = parseJson(skipped.text);
  const skippedExists = await call('presence_exec', {
    host,
    command: `test -e ${skippedTarget} && echo present || echo absent`,
  });
  check('saveStdout 只在 exit 0 时写',
    skippedBody?.savedStdoutSkipped?.path === skippedTarget && !skippedBody?.savedStdout &&
      skippedExists.text.includes('absent'),
    skipped.text.slice(0, 160));

  // 1b. exec script mode: no shell quoting, temp file cleaned up, structured JSON
  const scripted = await call('presence_exec', {
    host,
    script: 'printf "script-ok\\n"\npwd\n',
    cwd: '/tmp',
  });
  check('presence_exec script',
    !scripted.isError && scripted.text.includes('script-ok') && scripted.text.includes('/tmp'),
    scripted.text.split('\n')[1]);

  const scriptJsonResult = await call('presence_exec', {
    host,
    script: 'printf "script-json\\n"\nexit 3',
    cwd: '/tmp',
    format: 'json',
  });
  const scriptJson = parseJson(scriptJsonResult.text);
  check('presence_exec script format=json',
    !scriptJsonResult.isError && scriptJson?.exitCode === 3 && scriptJson?.script === true &&
      scriptJson?.cwd === '/tmp' && scriptJson?.command?.includes('presence-exec-') &&
      scriptJson?.stdout?.includes('script-json'),
    scriptJsonResult.text.slice(0, 200));

  const bothModes = await call('presence_exec', { host, command: 'echo hi', script: 'echo hi' });
  check('presence_exec command/script 互斥',
    bothModes.isError && /either command or script/u.test(bothModes.text), bothModes.text.slice(0, 140));

  const neitherMode = await call('presence_exec', { host });
  check('presence_exec 缺 command/script 报错',
    neitherMode.isError && /command or script is required/u.test(neitherMode.text), neitherMode.text.slice(0, 140));

  // 2. make the workspace and write/read/edit a file (relative path)
  await call('presence_exec', { host, command: `mkdir -p ${remoteRoot}/sub`, confirm: true });
  const written = await call('presence_write', { host, path: 'sub/a.txt', content: 'alpha\nbeta\n' });
  check('presence_write', !written.isError && written.text.includes('wrote'), written.text);

  const writeJsonResult = await call('presence_write', {
    host,
    path: 'sub/b.txt',
    content: 'one\ntwo\n',
    mode: '640',
    format: 'json',
  });
  const writeBody = parseJson(writeJsonResult.text);
  check('presence_write format=json 报告实际 mode',
    !writeJsonResult.isError && writeBody?.sizeBytes === 8 && writeBody?.mode === '0640' &&
      writeBody?.modeNumeric === 0o640 && /^[0-9a-f]{64}$/u.test(writeBody?.sha256 ?? ''),
    writeJsonResult.text.slice(0, 180));

  const read1 = await call('presence_read', { host, path: 'sub/a.txt' });
  check('presence_read', !read1.isError && read1.text.includes('2') && read1.text.includes('beta'), read1.text.split('\n')[1]);
  const raw = await call('presence_read', { host, path: 'sub/a.txt', numbered: false });
  check('presence_read numbered=false 返回裸文本', !raw.isError && raw.text.startsWith('alpha') && !/^\s*\d+\s\s/mu.test(raw.text.split('\n')[0]),
    JSON.stringify(raw.text.slice(0, 24)));
  const rawExact = await call('presence_read', { host, path: 'sub/a.txt', raw: true });
  check('presence_read raw=true 精确内容且无 trailer',
    !rawExact.isError && rawExact.text === 'alpha\nbeta\n',
    JSON.stringify(rawExact.text));

  const manyText = await call('presence_read_many', { host, paths: ['sub/a.txt', 'sub/b.txt'], raw: true });
  check('presence_read_many 文本',
    !manyText.isError && manyText.text.includes('=== ') && manyText.text.includes('alpha') &&
      manyText.text.includes('one'),
    manyText.text.split('\n')[0]);
  const manyJsonResult = await call('presence_read_many', {
    host,
    paths: ['sub/a.txt', 'sub/b.txt'],
    format: 'json',
  });
  const manyJson = parseJson(manyJsonResult.text);
  check('presence_read_many format=json',
    !manyJsonResult.isError && Array.isArray(manyJson) && manyJson.length === 2 &&
      manyJson[0].content === 'alpha\nbeta\n' && manyJson[1].content === 'one\ntwo\n' &&
      manyJson[0].sizeBytes === 11 && manyJson[0].truncated === false,
    manyJsonResult.text.slice(0, 180));

  await call('presence_write', { host, path: 'medium.txt', content: `${'y'.repeat(99)}\n`.repeat(20) });
  for (const name of ['budget1.txt', 'budget2.txt', 'budget3.txt', 'budget4.txt']) {
    await call('presence_write', { host, path: name, content: `${'z'.repeat(999)}\n` });
  }

  await call('presence_exec', { host, command: `seq 1 10000 > ${remoteRoot}/big.txt`, confirm: true });
  const bigManyResult = await call('presence_read_many', {
    host,
    paths: ['big.txt'],
    limit: 20000,
    format: 'json',
  });
  const bigMany = parseJson(bigManyResult.text);
  check('presence_read_many 裁剪后仍是合法 JSON',
    !bigManyResult.isError && Array.isArray(bigMany) && bigMany[0]?.truncated === true &&
      bigManyResult.text.length <= 33 * 1024 && typeof bigMany[0]?.content === 'string',
    `${bigManyResult.text.length} chars, content=${bigMany[0]?.content?.length ?? '?'} chars`);

  const capManyResult = await call('presence_read_many', {
    host,
    paths: ['big.txt'],
    limit: 20000,
    format: 'json',
  });
  const capMany = parseJson(capManyResult.text)?.[0];
  check('presence_read_many 每文件默认上限 16 KiB',
    !capManyResult.isError && capMany?.truncated === true && capMany?.truncatedByTotal === false &&
      capMany?.readBytes === 16384 && Buffer.byteLength(capMany?.content ?? '', 'utf8') === capMany?.readBytes &&
      capMany?.sizeBytes > capMany?.readBytes && typeof capMany?.totalLines === 'number',
    `read=${capMany?.readBytes} size=${capMany?.sizeBytes} lines=${capMany?.totalLines}`);

  const smallCapResult = await call('presence_read_many', {
    host,
    paths: ['medium.txt'],
    maxBytesPerFile: 100,
    format: 'json',
  });
  const smallCap = parseJson(smallCapResult.text)?.[0];
  check('presence_read_many maxBytesPerFile 可配置',
    !smallCapResult.isError && smallCap?.readBytes === 100 && smallCap?.truncated === true &&
      smallCap?.sizeBytes === 2000 && smallCap?.truncatedByTotal === false,
    smallCapResult.text.slice(0, 200));

  const expectedAlphaSha = createHash('sha256').update('alpha\nbeta\n', 'utf8').digest('hex');
  const hashManyResult = await call('presence_read_many', {
    host,
    paths: ['sub/a.txt', 'big.txt'],
    limit: 20000,
    hash: true,
    format: 'json',
  });
  const hashMany = parseJson(hashManyResult.text) ?? [];
  check('presence_read_many hash=true 完整文件 sha256',
    !hashManyResult.isError && hashMany[0]?.truncated === false && hashMany[0]?.sha256 === expectedAlphaSha,
    `sha256=${hashMany[0]?.sha256} expected=${expectedAlphaSha}`);
  check('presence_read_many hash=true 截断文件 sha256=null',
    hashMany[1]?.truncated === true && hashMany[1]?.sha256 === null,
    `truncated=${hashMany[1]?.truncated} sha256=${String(hashMany[1]?.sha256)}`);
  check('presence_read_many 未请求 hash 时无 sha256 字段',
    !Object.hasOwn(manyJson?.[0] ?? {}, 'sha256') && !Object.hasOwn(capMany ?? {}, 'sha256'),
    JSON.stringify(Object.keys(manyJson?.[0] ?? {})));
  const hashTextResult = await call('presence_read_many', {
    host,
    paths: ['sub/a.txt', 'big.txt'],
    raw: true,
    maxBytesPerFile: 64,
    hash: true,
  });
  check('presence_read_many hash=true 文本含 sha256 行',
    !hashTextResult.isError &&
      hashTextResult.text.includes(`sha256: ${expectedAlphaSha}`) &&
      /sha256: null/u.test(hashTextResult.text),
    hashTextResult.text.split('\n').slice(0, 3).join(' | '));

  const budgetResult = await call('presence_read_many', {
    host,
    paths: ['budget1.txt', 'budget2.txt', 'budget3.txt', 'budget4.txt'],
    maxBytesTotal: 2500,
    format: 'json',
  });
  const budgetItems = parseJson(budgetResult.text) ?? [];
  const budgetBytes = budgetItems.reduce((sum, item) => sum + (item.readBytes ?? 0), 0);
  check('presence_read_many maxBytesTotal 从尾部裁剪',
    !budgetResult.isError && budgetBytes === 2500 && budgetItems[0]?.readBytes === 1000 &&
      budgetItems[0]?.truncatedByTotal === false && budgetItems[2]?.readBytes === 500 &&
      budgetItems[2]?.truncatedByTotal === true && budgetItems[3]?.readBytes === 0 &&
      budgetItems[3]?.truncatedByTotal === true,
    `total=${budgetBytes} reads=${budgetItems.map((item) => item.readBytes).join(',')}`);

  const manyNoteResult = await call('presence_read_many', {
    host,
    paths: ['sub/a.txt', 'big.txt'],
    raw: true,
    maxBytesPerFile: 64,
  });
  check('presence_read_many 文本截断注记 + 总计',
    !manyNoteResult.isError &&
      /… \[truncated: showing 64 of \d+ bytes\]/u.test(manyNoteResult.text) &&
      /total: 2 files, \d+ bytes/u.test(manyNoteResult.text),
    manyNoteResult.text.split('\n').at(-2));

  const lsEntries = await call('presence_ls', { host, path: 'sub' });
  check('presence_ls 列目录', !lsEntries.isError && lsEntries.text.includes('a.txt') && lsEntries.text.includes('file'), lsEntries.text.split('\n')[1]);
  const lsJsonResult = await call('presence_ls', { host, path: 'sub', format: 'json' });
  const lsJson = parseJson(lsJsonResult.text);
  const aRow = Array.isArray(lsJson) ? lsJson.find((entry) => entry.name === 'a.txt') : null;
  check('presence_ls format=json',
    !lsJsonResult.isError && Array.isArray(lsJson) && aRow?.kind === 'file' && aRow?.sizeBytes === 11 &&
      typeof aRow?.mtimeMs === 'number' && /Z$/u.test(aRow?.mtimeISO ?? ''),
    lsJsonResult.text.slice(0, 180));

  await call('presence_write', { host, path: 'tree/root.txt', content: 'alpha\nbeta\n' });
  await call('presence_write', { host, path: 'tree/sub/five.txt', content: 'five\n' });
  await call('presence_write', { host, path: 'tree/sub/deep/ab.txt', content: 'ab\n' });
  const treeJsonResult = await call('presence_ls', {
    host,
    path: 'tree',
    recursive: true,
    totalBytes: true,
    format: 'json',
  });
  const treeJson = parseJson(treeJsonResult.text);
  const subRow = Array.isArray(treeJson) ? treeJson.find((entry) => entry.name === 'sub') : null;
  const deepRow = Array.isArray(treeJson) ? treeJson.find((entry) => entry.name === 'deep') : null;
  const rootRow = Array.isArray(treeJson) ? treeJson.find((entry) => entry.name === 'root.txt') : null;
  check('presence_ls recursive + totalBytes format=json',
    !treeJsonResult.isError && Array.isArray(treeJson) && treeJson.length === 5 &&
      subRow?.isDir === true && subRow?.recursiveBytes === 8 && subRow?.depth === 1 &&
      deepRow?.recursiveBytes === 3 && rootRow?.isDir === false && rootRow?.sizeBytes === 11,
    treeJsonResult.text.slice(0, 220));

  const treeTextResult = await call('presence_ls', {
    host,
    path: 'tree',
    recursive: true,
    totalBytes: true,
  });
  check('presence_ls 文本 total footer',
    !treeTextResult.isError && /total: 3 files, 19 bytes/u.test(treeTextResult.text) &&
      treeTextResult.text.includes('sub/deep/ab.txt'),
    treeTextResult.text.split('\n').at(-1));

  // 2b. presence_stat: metadata + sha256, missing paths are data, not errors
  const statHash = createHash('sha256').update('alpha\nbeta\n').digest('hex');
  const statJsonResult = await call('presence_stat', {
    host,
    paths: ['sub/a.txt', 'nope/missing.txt', 'sub'],
    hash: true,
    format: 'json',
  });
  const statRows = parseJson(statJsonResult.text);
  check('presence_stat exists/missing/hash format=json',
    !statJsonResult.isError && Array.isArray(statRows) && statRows.length === 3 &&
      statRows[0]?.exists === true && statRows[0]?.type === 'file' && statRows[0]?.sizeBytes === 11 &&
      statRows[0]?.mode === '0644' && statRows[0]?.sha256 === statHash &&
      /T.*Z$/u.test(statRows[0]?.mtimeISO ?? '') && typeof statRows[0]?.mtimeMs === 'number' &&
      statRows[1]?.exists === false && statRows[1]?.type === 'missing' &&
      statRows[1]?.sizeBytes === null && statRows[1]?.mode === null && statRows[1]?.sha256 === null &&
      statRows[2]?.type === 'dir',
    statJsonResult.text.slice(0, 260));
  const statTextResult = await call('presence_stat', {
    host,
    paths: ['sub/a.txt', 'nope/missing.txt'],
  });
  check('presence_stat 文本表 + 缺失统计',
    !statTextResult.isError && statTextResult.text.includes('file') &&
      statTextResult.text.includes('missing') &&
      /2 path\(s\): 1 found, 1 missing/u.test(statTextResult.text),
    statTextResult.text.split('\n').at(-1));

  const edited = await call('presence_edit', { host, path: 'sub/a.txt', oldText: 'beta', newText: 'gamma' });
  check('presence_edit', !edited.isError && edited.text.includes('1 replacement'), edited.text.split('\n')[0]);
  check('presence_edit 返回 diff',
    edited.text.includes('@@') && edited.text.includes('- beta') && edited.text.includes('+ gamma'),
    edited.text.split('\n').slice(1, 5).join(' | '));
  const read2 = await call('presence_read', { host, path: 'sub/a.txt' });
  check('edit 生效', read2.text.includes('gamma') && !read2.text.includes('beta'));

  const dryRunResult = await call('presence_edit', {
    host,
    path: 'sub/a.txt',
    oldText: 'gamma',
    newText: 'delta-longer',
    dryRun: true,
    format: 'json',
  });
  const dryRun = parseJson(dryRunResult.text);
  check('presence_edit dryRun format=json（actual/projected 尺寸）',
    !dryRunResult.isError && dryRun?.dryRun === true && dryRun?.replaced === 1 &&
      dryRun?.actualSizeBytes === 12 && dryRun?.projectedSizeBytes === 19 && dryRun?.sizeBytes === 12 &&
      dryRun?.diff.includes('gamma') && dryRun?.diff.includes('delta-longer'),
    dryRunResult.text.slice(0, 200));
  const dryRunTextResult = await call('presence_edit', {
    host,
    path: 'sub/a.txt',
    oldText: 'gamma',
    newText: 'delta',
    dryRun: true,
  });
  check('presence_edit dryRun 文本标注 dry run: N B → M B projected',
    !dryRunTextResult.isError && /dry run: 12 B → 12 B projected/u.test(dryRunTextResult.text),
    dryRunTextResult.text.split('\n')[0]);
  const afterDryRun = await call('presence_read', { host, path: 'sub/a.txt', raw: true });
  check('dryRun 不写文件', afterDryRun.text === 'alpha\ngamma\n', JSON.stringify(afterDryRun.text));

  // 2c. presence_write ifMatchSha256: optimistic lock, both hashes on mismatch
  const currentSha = createHash('sha256').update('alpha\ngamma\n').digest('hex');
  const guardedWriteResult = await call('presence_write', {
    host,
    path: 'sub/a.txt',
    content: 'alpha\ngamma\n',
    ifMatchSha256: currentSha,
    format: 'json',
  });
  const guardedWrite = parseJson(guardedWriteResult.text);
  check('presence_write ifMatchSha256 匹配时写入',
    !guardedWriteResult.isError && guardedWrite?.sha256 === currentSha,
    guardedWriteResult.text.slice(0, 200));
  const staleHash = '0'.repeat(64);
  const staleWrite = await call('presence_write', {
    host,
    path: 'sub/a.txt',
    content: 'clobbered\n',
    ifMatchSha256: staleHash,
  });
  check('presence_write ifMatchSha256 不匹配时报错（含双方哈希）',
    staleWrite.isError && /ifMatchSha256 mismatch/u.test(staleWrite.text) &&
      staleWrite.text.includes(currentSha) && staleWrite.text.includes(staleHash),
    staleWrite.text.slice(0, 240));
  const afterStale = await call('presence_read', { host, path: 'sub/a.txt', raw: true });
  check('ifMatchSha256 不匹配时不写文件', afterStale.text === 'alpha\ngamma\n', JSON.stringify(afterStale.text));

  await call('presence_write', { host, path: 'lines.txt', content: 'one\ntwo\nthree\nfour\n' });
  const lineEditResult = await call('presence_edit', {
    host,
    path: 'lines.txt',
    startLine: 2,
    endLine: 3,
    newText: 'TWO\nTHREE',
    format: 'json',
  });
  const lineEdit = parseJson(lineEditResult.text);
  const lineRead = await call('presence_read', { host, path: 'lines.txt', raw: true });
  check('presence_edit 行范围替换',
    !lineEditResult.isError && lineEdit?.mode === 'lines' && lineEdit?.replaced === 2 &&
      lineEdit?.startLine === 2 && lineEdit?.endLine === 3 &&
      lineEdit?.diff.includes('- two') && lineEdit?.diff.includes('+ TWO') &&
      lineRead.text === 'one\nTWO\nTHREE\nfour\n',
    lineEditResult.text.slice(0, 220));

  const lineDryResult = await call('presence_edit', {
    host,
    path: 'lines.txt',
    startLine: 1,
    endLine: 1,
    newText: 'ONE',
    dryRun: true,
    format: 'json',
  });
  const lineDry = parseJson(lineDryResult.text);
  const lineAfterDry = await call('presence_read', { host, path: 'lines.txt', raw: true });
  check('presence_edit 行范围 dryRun 不写',
    !lineDryResult.isError && lineDry?.dryRun === true && lineDry?.replaced === 1 &&
      lineAfterDry.text === 'one\nTWO\nTHREE\nfour\n',
    lineDryResult.text.slice(0, 180));

  const deleteResult = await call('presence_edit', {
    host,
    path: 'lines.txt',
    startLine: 2,
    endLine: 3,
    newText: '',
    format: 'json',
  });
  const deleteBody = parseJson(deleteResult.text);
  const deleteRead = await call('presence_read', { host, path: 'lines.txt', raw: true });
  check('presence_edit 行范围删除（newText 为空）',
    !deleteResult.isError && deleteBody?.replaced === 2 && deleteBody?.mode === 'lines' &&
      deleteRead.text === 'one\nfour\n',
    deleteResult.text.slice(0, 180));

  const lineConflict = await call('presence_edit', {
    host,
    path: 'lines.txt',
    oldText: 'one',
    startLine: 1,
    endLine: 1,
    newText: 'X',
  });
  check('presence_edit 行范围与 oldText 互斥',
    lineConflict.isError && /not both/u.test(lineConflict.text), lineConflict.text.slice(0, 160));

  const lineOutOfRange = await call('presence_edit', {
    host,
    path: 'lines.txt',
    startLine: 99,
    endLine: 100,
    newText: 'X',
  });
  check('presence_edit 行号越界报错',
    lineOutOfRange.isError && /beyond the end/u.test(lineOutOfRange.text), lineOutOfRange.text.slice(0, 160));

  // 3. search + glob
  const search = await call('presence_search', { host, pattern: 'gamma', path: remoteRoot });
  check('presence_search', !search.isError && search.text.includes('a.txt'), search.text.split('\n')[1]);
  const searchJsonResult = await call('presence_search', {
    host,
    pattern: 'gamma',
    path: remoteRoot,
    format: 'json',
  });
  const searchJson = parseJson(searchJsonResult.text);
  const searchHit = Array.isArray(searchJson?.matches) ? searchJson.matches[0] : null;
  check('presence_search format=json',
    !searchJsonResult.isError && searchJson?.pattern === 'gamma' && searchJson?.root === remoteRoot &&
      searchJson?.countOnly === false && searchJson?.matchCount >= 1 &&
      typeof searchHit?.file === 'string' && searchHit.file.endsWith('a.txt') &&
      searchHit?.line === 2 && searchHit?.text === 'gamma',
    searchJsonResult.text.slice(0, 240));
  const searchCountOnlyResult = await call('presence_search', {
    host,
    pattern: 'gamma',
    path: remoteRoot,
    countOnly: true,
    format: 'json',
  });
  const searchCountJson = parseJson(searchCountOnlyResult.text);
  check('presence_search countOnly format=json',
    !searchCountOnlyResult.isError && searchCountJson?.countOnly === true &&
      searchCountJson?.matchCount >= 1 && Array.isArray(searchCountJson?.matches) &&
      searchCountJson.matches.length === 0,
    searchCountOnlyResult.text.slice(0, 180));

  const glob = await call('presence_glob', { host, pattern: '**/*.txt', path: remoteRoot });
  check('presence_glob', !glob.isError && glob.text.includes('a.txt'), glob.text.split('\n')[0]);
  const globJsonResult = await call('presence_glob', {
    host,
    pattern: '**/*.txt',
    path: remoteRoot,
    format: 'json',
  });
  const globJson = parseJson(globJsonResult.text);
  const globRow = Array.isArray(globJson) ? globJson.find((entry) => String(entry.path).endsWith('a.txt')) : null;
  check('presence_glob format=json',
    !globJsonResult.isError && Array.isArray(globJson) &&
      globRow?.sizeBytes === 12 && typeof globRow?.mtimeMs === 'number' &&
      /T.*Z$/u.test(globRow?.mtimeISO ?? ''),
    globJsonResult.text.slice(0, 240));

  // 4. import local -> remote, then export back and compare sha256
  localTemp = mkdtempSync(join(tmpdir(), 'presence-mcp-local-'));
  const localFile = join(localTemp, 'blob.bin');
  const payload = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0, 255]);
  writeFileSync(localFile, payload);
  const imported = await call('presence_import', { host, source: localFile, to: `${remoteRoot}/blob.bin` });
  check('presence_import', !imported.isError && imported.text.includes('sha256'), imported.text);
  const payloadSha = createHash('sha256').update(payload).digest('hex');
  const importJsonResult = await call('presence_import', {
    host,
    source: localFile,
    to: `${remoteRoot}/blob-json.bin`,
    format: 'json',
  });
  const importJson = parseJson(importJsonResult.text);
  check('presence_import format=json（完整 sha256 + mode）',
    !importJsonResult.isError && importJson?.remotePath === `${remoteRoot}/blob-json.bin` &&
      importJson?.localPath === localFile && importJson?.sizeBytes === payload.length &&
      importJson?.sha256 === payloadSha && importJson?.mode === '0644',
    importJsonResult.text.slice(0, 260));
  const exported = await call('presence_export', { host, path: `${remoteRoot}/blob.bin`, to: localTemp });
  const localCopy = /→ (\S+) \(/u.exec(exported.text)?.[1];
  const roundTrip = localCopy ? readFileSync(localCopy) : Buffer.alloc(0);
  check('presence_export 字节一致', !exported.isError && createHash('sha256').update(roundTrip).digest('hex') ===
    createHash('sha256').update(payload).digest('hex'), localCopy ?? exported.text);

  const exportJsonResult = await call('presence_export', {
    host,
    path: `${remoteRoot}/blob.bin`,
    to: localTemp,
    name: 'custom-blob.bin',
    format: 'json',
  });
  const exportJson = parseJson(exportJsonResult.text);
  const exportJsonBytes = exportJson?.localPath ? readFileSync(exportJson.localPath) : Buffer.alloc(0);
  check('presence_export format=json + name',
    !exportJsonResult.isError && exportJson?.remotePath === `${remoteRoot}/blob.bin` &&
      exportJson?.localPath?.endsWith('custom-blob.bin') && exportJson?.sizeBytes === payload.length &&
      /^[0-9a-f]{64}$/u.test(exportJson?.sha256 ?? '') && exportJsonBytes.equals(payload),
    exportJsonResult.text.slice(0, 220));

  const sanitizedExportResult = await call('presence_export', {
    host,
    path: `${remoteRoot}/blob.bin`,
    to: localTemp,
    name: '../nested/renamed.bin',
    format: 'json',
  });
  const sanitizedExport = parseJson(sanitizedExportResult.text);
  check('presence_export name 清理路径分隔符',
    !sanitizedExportResult.isError && basename(sanitizedExport?.localPath ?? '') === 'renamed.bin' &&
      resolve(dirname(sanitizedExport?.localPath ?? '')) === resolve(localTemp),
    sanitizedExportResult.text.slice(0, 220));

  // 5. trash + restore: text, JSON, path filter and newest-first ordering
  const trashed = await call('presence_trash', { host, action: 'trash', path: `${remoteRoot}/blob.bin` });
  const trashPath = /→ (\S+) \(/u.exec(trashed.text)?.[1];
  check('presence_trash', !trashed.isError && Boolean(trashPath), trashed.text);
  const listed = await call('presence_trash', { host, action: 'list' });
  check('trash list 包含它', listed.text.includes('blob.bin') || trashed.isError, listed.text.split('\n')[0]);
  const trashListJsonResult = await call('presence_trash', {
    host,
    action: 'list',
    path: 'blob.bin',
    format: 'json',
  });
  const trashListJson = parseJson(trashListJsonResult.text);
  check('presence_trash list format=json + 过滤/时间',
    !trashListJsonResult.isError && Array.isArray(trashListJson) && trashListJson.length > 0 &&
      trashListJson.every((entry) => entry.trashPath.includes('blob.bin')) &&
      trashListJson.every((entry) => typeof entry.name === 'string') &&
      // one time field only: movedAtISO, no movedAt/movedAtMs duplicates
      trashListJson.every((entry) => /T.*Z$/u.test(entry.movedAtISO ?? '')) &&
      trashListJson.every((entry) => !('movedAt' in entry) && !('movedAtMs' in entry)),
    trashListJsonResult.text.slice(0, 200));
  if (trashPath) {
    const restored = await call('presence_trash', { host, action: 'restore', trashPath, to: `${remoteRoot}/blob.bin` });
    check('trash restore', !restored.isError && restored.text.includes('restored'), restored.text);
  }

  await call('presence_write', { host, path: 'trash-json.txt', content: 'trash me\n' });
  const trashJsonResult = await call('presence_trash', {
    host,
    action: 'trash',
    path: 'trash-json.txt',
    format: 'json',
  });
  const trashJson = parseJson(trashJsonResult.text);
  check('presence_trash trash format=json',
    !trashJsonResult.isError && trashJson?.sourceRemoved === true && trashJson?.sizeBytes === 9 &&
      typeof trashJson?.strategy === 'string' && trashJson?.restoreHint.includes(trashJson?.trashPath ?? '\u0000'),
    trashJsonResult.text.slice(0, 200));
  const newestJsonResult = await call('presence_trash', {
    host,
    action: 'list',
    path: 'trash-json.txt',
    format: 'json',
  });
  const newestJson = parseJson(newestJsonResult.text);
  check('presence_trash list 最新在前',
    Array.isArray(newestJson) && newestJson[0]?.name === 'trash-json.txt',
    newestJsonResult.text.slice(0, 160));
  if (trashJson?.trashPath) {
    const restoreJsonResult = await call('presence_trash', {
      host,
      action: 'restore',
      trashPath: trashJson.trashPath,
      to: `${remoteRoot}/trash-json.txt`,
      format: 'json',
    });
    const restoreJson = parseJson(restoreJsonResult.text);
    check('presence_trash restore format=json',
      !restoreJsonResult.isError && restoreJson?.restored === true &&
        typeof restoreJson?.to === 'string' && restoreJson.to.endsWith('/trash-json.txt'),
      restoreJsonResult.text.slice(0, 160));
  }

  // 5b. batch trash: paths[] reports one result per path
  await call('presence_write', { host, path: 'batch/a1.txt', content: 'a1\n' });
  await call('presence_write', { host, path: 'batch/a2.txt', content: 'a2\n' });
  const batchTrashResult = await call('presence_trash', {
    host,
    action: 'trash',
    paths: ['batch/a1.txt', 'batch/a2.txt'],
    format: 'json',
  });
  const batchTrash = parseJson(batchTrashResult.text);
  const batchRows = Array.isArray(batchTrash?.results) ? batchTrash.results : [];
  check('presence_trash 批量 paths[] format=json',
    !batchTrashResult.isError && batchRows.length === 2 && batchTrash?.trashed === 2 && batchTrash?.failed === 0 &&
      batchRows.every((row) => row.sourceRemoved === true && row.sizeBytes === 3 &&
        typeof row.trashPath === 'string' && row.restoreHint.includes(row.trashPath)),
    batchTrashResult.text.slice(0, 260));
  const batchPartialResult = await call('presence_trash', {
    host,
    action: 'trash',
    paths: ['batch/a3-missing.txt'],
    format: 'json',
  });
  const batchPartial = parseJson(batchPartialResult.text);
  check('presence_trash 批量部分失败仍返回逐项结果',
    !batchPartialResult.isError && batchPartial?.failed === 1 && batchPartial?.trashed === 0 &&
      typeof batchPartial?.results?.[0]?.error === 'string',
    batchPartialResult.text.slice(0, 200));
  for (const row of batchRows) {
    if (row?.trashPath) {
      await call('presence_trash', { host, action: 'restore', trashPath: row.trashPath, to: row.path });
    }
  }

  // 6. background job + forward: run a tiny HTTP server remotely, tunnel it, fetch it
  const port = 18800 + Math.floor(Math.random() * 300);
  const started = await call('presence_exec', {
    host,
    command: `cd ${remoteRoot} && python3 -m http.server ${port}`,
    background: true,
    label: 'mcp-http',
    waitForPort: port,
  });
  const jobId = /job (\S+)/u.exec(started.text)?.[1];
  const jobPid = Number(/pid (\d+)/u.exec(started.text)?.[1] ?? 0);
  check('presence_exec background + waitForPort',
    !started.isError && Boolean(jobId) && started.text.includes(`port ${port} accepts TCP`),
    started.text.split('\n').at(-1));

  const port2 = port + 1;
  const startedJsonResult = await call('presence_exec', {
    host,
    command: `cd ${remoteRoot} && python3 -m http.server ${port2}`,
    background: true,
    label: 'mcp-http-json',
    format: 'json',
    waitForPort: port2,
  });
  const startedJson = parseJson(startedJsonResult.text);
  const jobId2 = startedJson?.jobId;
  check('presence_exec background format=json 结构',
    !startedJsonResult.isError && typeof jobId2 === 'string' && typeof startedJson?.pid === 'number' &&
      startedJson?.cwd === remoteRoot && typeof startedJson?.command === 'string' &&
      startedJson.command.includes('http.server') && typeof startedJson?.logPath === 'string' &&
      startedJson?.label === 'mcp-http-json' && startedJson?.ready === true &&
      typeof startedJson?.waitedMs === 'number',
    startedJsonResult.text.slice(0, 240));

  // 6a. port_probe against the live servers
  const probeOpenResult = await call('presence_port_probe', {
    host,
    ports: [port, port2],
    expect: 'open',
    format: 'json',
  });
  const probeOpen = parseJson(probeOpenResult.text);
  const probeOpenRows = Array.isArray(probeOpen) ? probeOpen : [];
  check('presence_port_probe expect=open format=json',
    !probeOpenResult.isError && probeOpenRows.length === 2 &&
      probeOpenRows.every((row) => row.listening === true && row.ok === true && row.probe === 'accepted') &&
      probeOpenRows.some((row) => typeof row.pid === 'number' && typeof row.process === 'string'),
    probeOpenResult.text.slice(0, 260));
  const probeWrongResult = await call('presence_port_probe', {
    host,
    ports: [port],
    expect: 'closed',
    format: 'json',
  });
  const probeWrong = parseJson(probeWrongResult.text);
  check('presence_port_probe ok 与实际状态比较',
    !probeWrongResult.isError && probeWrong?.[0]?.listening === true && probeWrong?.[0]?.ok === false,
    probeWrongResult.text.slice(0, 200));
  const probeTextResult = await call('presence_port_probe', { host, ports: [port], expect: 'open' });
  check('presence_port_probe 文本表',
    !probeTextResult.isError && /port\tlistening\tpid\tprocess\tprobe\tok/u.test(probeTextResult.text) &&
      /expect: open · pass: yes/u.test(probeTextResult.text),
    probeTextResult.text.split('\n').at(-1));

  const jobsJsonResult = await call('presence_jobs', { action: 'list', format: 'json' });
  const jobsJson = parseJson(jobsJsonResult.text);
  check('presence_jobs list format=json',
    !jobsJsonResult.isError && Array.isArray(jobsJson) && jobsJson.some((job) => job.id === jobId),
    jobsJsonResult.text.slice(0, 180));

  const statusResult = await call('presence_jobs', { action: 'status', jobId, format: 'json' });
  const jobStatus = parseJson(statusResult.text);
  check('presence_jobs status format=json',
    !statusResult.isError && jobStatus?.id === jobId && jobStatus?.state === 'running' &&
      jobStatus?.pid === jobPid && typeof jobStatus?.startedAt === 'number' &&
      typeof jobStatus?.logPath === 'string' && typeof jobStatus?.logSize === 'number' &&
      // a running job has no exit yet: null, not the string "unknown"
      jobStatus?.exitSummary === null,
    statusResult.text.slice(0, 220));

  const waitTimedOutResult = await call('presence_jobs', {
    action: 'wait',
    jobId,
    timeoutMs: 1000,
    format: 'json',
  });
  const waitTimedOut = parseJson(waitTimedOutResult.text);
  check('presence_jobs wait timedOut',
    !waitTimedOutResult.isError && waitTimedOut?.state === 'running' &&
      waitTimedOut?.timedOut === true && waitTimedOut?.exitSummary === null,
    waitTimedOutResult.text.slice(0, 200));

  // 6b. http_probe: forward + GET + assertions + close + port release, one call
  const httpProbeResult = await call('presence_http_probe', {
    host,
    remotePort: port,
    paths: ['/', '/sub/a.txt'],
    expectStatus: [200],
    expectBody: ['alpha'],
    format: 'json',
  });
  const httpProbe = parseJson(httpProbeResult.text);
  const httpRows = Array.isArray(httpProbe?.results) ? httpProbe.results : [];
  check('presence_http_probe 200 + body + 端口释放',
    !httpProbeResult.isError && httpProbe?.remotePort === port && typeof httpProbe?.forwardId === 'string' &&
      typeof httpProbe?.localPort === 'number' && httpRows.length === 2 &&
      httpRows.every((row) => row.status === 200) && httpRows[0]?.bytes > 0 &&
      httpRows[0]?.bodyMatched === false && httpRows[1]?.bytes === 12 && httpRows[1]?.bodyMatched === true &&
      typeof httpRows[1]?.contentType === 'string' &&
      httpProbe?.missingBody?.length === 0 && httpProbe?.pass === true && httpProbe?.portReleased === true,
    httpProbeResult.text.slice(0, 280));
  const forwardsAfterProbe = parseJson((await call('presence_forward', { action: 'list', format: 'json' })).text);
  check('presence_http_probe 关闭了隧道',
    Array.isArray(forwardsAfterProbe) && !forwardsAfterProbe.some((entry) => entry.id === httpProbe?.forwardId),
    JSON.stringify(forwardsAfterProbe).slice(0, 180));
  const httpProbeFailResult = await call('presence_http_probe', {
    host,
    remotePort: port,
    paths: ['/no-such-path-xyz'],
    expectBody: ['definitely-not-in-the-body'],
    format: 'json',
  });
  const httpProbeFail = parseJson(httpProbeFailResult.text);
  check('presence_http_probe 断言失败时 pass=false',
    !httpProbeFailResult.isError && httpProbeFail?.pass === false &&
      httpProbeFail?.missingBody?.includes('definitely-not-in-the-body') &&
      httpProbeFail?.results?.[0]?.status === 404 && httpProbeFail?.portReleased === true,
    httpProbeFailResult.text.slice(0, 240));

  const forwarded = await call('presence_forward', {
    host,
    action: 'open',
    remotePort: port,
    format: 'json',
  });
  const tunnel = parseJson(forwarded.text);
  const localUrl = tunnel?.url;
  check('presence_forward open format=json',
    !forwarded.isError && tunnel?.state === 'open' && tunnel?.localHost === '127.0.0.1' &&
      typeof tunnel?.id === 'string' && tunnel?.remotePort === port &&
      tunnel?.url === `http://127.0.0.1:${tunnel?.localPort}` &&
      typeof tunnel?.requestedLocalPort === 'number' && typeof tunnel?.localPortFallback === 'boolean',
    forwarded.text.slice(0, 200));
  check('presence_forward open 含 createdAt（ISO + 毫秒）',
    typeof tunnel?.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(tunnel.createdAt) &&
      Math.abs(Date.parse(tunnel.createdAt) - Date.now()) < 120_000,
    `createdAt=${tunnel?.createdAt}`);
  if (localUrl) {
    const response = await fetch(localUrl);
    const body = await response.text();
    check('经隧道访问远端 HTTP 服务', response.ok && /Directory listing|http\.server/iu.test(body), `HTTP ${response.status}, ${body.length} bytes`);
  }
  const forwardListResult = await call('presence_forward', { action: 'list', format: 'json' });
  const forwardList = parseJson(forwardListResult.text);
  check('presence_forward list format=json',
    Array.isArray(forwardList) && forwardList.some((entry) =>
      entry.id === tunnel?.id && entry.url === localUrl && entry.localHost === '127.0.0.1' && entry.state === 'open' &&
      entry.createdAt === tunnel?.createdAt),
    forwardListResult.text.slice(0, 180));
  const closed = await call('presence_forward', { action: 'close', forwardId: tunnel?.id, format: 'json' });
  const closedBody = parseJson(closed.text);
  check('presence_forward close format=json',
    !closed.isError && closedBody?.id === tunnel?.id && closedBody?.closed === true &&
      closedBody?.state === 'closed' && closedBody?.localPort === tunnel?.localPort &&
      closedBody?.portReleased === true,
    closed.text);

  const reopened = await call('presence_forward', { host, action: 'open', remotePort: port, format: 'json' });
  const reopenedBody = parseJson(reopened.text);
  const closedTextResult = await call('presence_forward', { action: 'close', forwardId: reopenedBody?.id });
  check('presence_forward close 文本含 released',
    !closedTextResult.isError && /released: yes/u.test(closedTextResult.text),
    closedTextResult.text);

  if (jobId) {
    const stopped = await call('presence_jobs', { action: 'stop', jobId, port, format: 'json' });
    const stopBody = parseJson(stopped.text);
    check('presence_jobs stop verify + portReleased + format=json',
      !stopped.isError && stopBody?.stopped === true && stopBody?.alive === false &&
        stopBody?.port === port && stopBody?.portReleased === true &&
        Object.hasOwn(stopBody ?? {}, 'exitCode'),
      stopped.text.slice(0, 240));
  }
  const stopped2 = await call('presence_jobs', { action: 'stop', jobId: jobId2, format: 'json' });
  const stopBody2 = parseJson(stopped2.text);
  check('presence_jobs stop exitSummary',
    !stopped2.isError && stopBody2?.stopped === true &&
      /^signal 14\d \(SIG[A-Z0-9]+\)$|^code \d+$/u.test(stopBody2?.exitSummary ?? ''),
    stopped2.text.slice(0, 200));

  const probeClosedResult = await call('presence_port_probe', {
    host,
    ports: [port, port2],
    expect: 'closed',
    waitMs: 5000,
    format: 'json',
  });
  const probeClosed = parseJson(probeClosedResult.text);
  check('presence_port_probe waitMs 等到端口关闭',
    !probeClosedResult.isError && Array.isArray(probeClosed) && probeClosed.length === 2 &&
      probeClosed.every((row) => row.listening === false && row.probe === 'refused' && row.ok === true),
    probeClosedResult.text.slice(0, 220));

  const jobsAfterStop = parseJson((await call('presence_jobs', { action: 'list', format: 'json' })).text);
  check('presence_jobs list 默认隐藏 exited',
    Array.isArray(jobsAfterStop) && jobsAfterStop.every((job) => job.state !== 'exited') &&
      !jobsAfterStop.some((job) => job.id === jobId),
    JSON.stringify(jobsAfterStop).slice(0, 180));

  const jobsAll = parseJson((await call('presence_jobs', { action: 'list', format: 'json', all: true })).text);
  check('presence_jobs list all=true 含历史',
    Array.isArray(jobsAll) && jobsAll.some((job) => job.id === jobId) &&
      jobsAll.some((job) => job.id === jobId2),
    JSON.stringify(jobsAll.map((job) => `${job.id}:${job.state}`)).slice(0, 180));

  const purgedOne = parseJson((await call('presence_jobs', { action: 'purge', jobId, format: 'json' })).text);
  const jobsAllAfterPurge = parseJson((await call('presence_jobs', { action: 'list', format: 'json', all: true })).text);
  check('presence_jobs purge jobId',
    Array.isArray(purgedOne?.purged) && purgedOne.purged.includes(jobId) &&
      Array.isArray(jobsAllAfterPurge) && !jobsAllAfterPurge.some((job) => job.id === jobId),
    JSON.stringify(purgedOne).slice(0, 180));

  const purgedAll = parseJson((await call('presence_jobs', { action: 'purge', all: true, format: 'json' })).text);
  const jobsAllFinal = parseJson((await call('presence_jobs', { action: 'list', format: 'json', all: true })).text);
  check('presence_jobs purge all=true',
    Array.isArray(purgedAll?.purged) && purgedAll.purged.includes(jobId2) &&
      Array.isArray(jobsAllFinal) && !jobsAllFinal.some((job) => job.id === jobId || job.id === jobId2),
    JSON.stringify(jobsAllFinal).slice(0, 180));

  // 6c. destructive exec dry-run: structured JSON, clean text, nothing removed
  await call('presence_exec', {
    host,
    command: `mkdir -p ${remoteRoot}/dry-run-dir && printf x > ${remoteRoot}/dry-run-dir/file.txt`,
  });
  const dryExecResult = await call('presence_exec', {
    host,
    command: `rm -rf ${remoteRoot}/dry-run-dir`,
    format: 'json',
  });
  const dryExec = parseJson(dryExecResult.text);
  const dryTargets = Array.isArray(dryExec?.targets) ? dryExec.targets : [];
  check('presence_exec destructive dry-run format=json',
    !dryExecResult.isError && dryExec?.dryRun === true && dryExec?.requiresConfirm === true &&
      dryExec?.command === `rm -rf ${remoteRoot}/dry-run-dir` &&
      typeof dryExec?.report === 'string' && !dryExec.report.includes('\uFFFD') &&
      /nothing was executed yet/u.test(dryExec.report) &&
      dryTargets.some((target) => target.endsWith('dry-run-dir')),
    dryExecResult.text.slice(0, 300));
  const stillThereResult = await call('presence_stat', {
    host,
    paths: ['dry-run-dir/file.txt'],
    format: 'json',
  });
  const stillThere = parseJson(stillThereResult.text);
  check('destructive dry-run 未删除目标', stillThere?.[0]?.exists === true, stillThereResult.text.slice(0, 160));

  // 7. terminal
  const opened = await call('presence_terminal', { host, action: 'open' });
  const terminalId = /terminal (\S+)/u.exec(opened.text)?.[1];
  check('presence_terminal open', !opened.isError && Boolean(terminalId), opened.text.split('\n')[0]);
  if (terminalId) {
    const typed = await call('presence_terminal', { action: 'write', terminalId, data: 'echo TERM_OK_123\n' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const read = await call('presence_terminal', { action: 'read', terminalId, waitMs: 1500 });
    const combined = typed.text + read.text;
    check('terminal 往返', combined.includes('TERM_OK_123'), combined.slice(0, 120));
    const closedTerm = await call('presence_terminal', { action: 'close', terminalId });
    check('presence_terminal close', !closedTerm.isError && closedTerm.text.includes('closed'), closedTerm.text);
  }

  // 7b. terminal JSON: open (cwd/shell/reused), ackOnly write, read, list, close
  const terminalOpenJsonResult = await call('presence_terminal', { host, action: 'open', format: 'json' });
  const terminalOpenJson = parseJson(terminalOpenJsonResult.text);
  check('presence_terminal open format=json',
    !terminalOpenJsonResult.isError && typeof terminalOpenJson?.terminalId === 'string' &&
      terminalOpenJson?.host === host && terminalOpenJson?.cwd === remoteRoot &&
      terminalOpenJson?.shell === 'bash' && terminalOpenJson?.reused === false,
    terminalOpenJsonResult.text.slice(0, 200));
  if (terminalOpenJson?.terminalId) {
    const jsonTermId = terminalOpenJson.terminalId;
    const ackData = 'echo TERM_JSON_OK\n';
    const jsonWriteResult = await call('presence_terminal', {
      action: 'write',
      terminalId: jsonTermId,
      data: ackData,
      ackOnly: true,
      format: 'json',
    });
    const jsonWrite = parseJson(jsonWriteResult.text);
    check('presence_terminal write ackOnly format=json',
      !jsonWriteResult.isError && jsonWrite?.terminalId === jsonTermId &&
        jsonWrite?.writtenBytes === Buffer.byteLength(ackData) && jsonWrite?.output === null,
      jsonWriteResult.text.slice(0, 200));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const jsonReadResult = await call('presence_terminal', {
      action: 'read',
      terminalId: jsonTermId,
      waitMs: 2000,
      format: 'json',
    });
    const jsonRead = parseJson(jsonReadResult.text);
    check('presence_terminal read format=json（输出留给 read）',
      !jsonReadResult.isError && jsonRead?.terminalId === jsonTermId && jsonRead?.closed === false &&
        String(jsonRead?.output).includes('TERM_JSON_OK'),
      jsonReadResult.text.slice(0, 200));
    const terminalListJsonResult = await call('presence_terminal', { action: 'list', format: 'json' });
    const terminalListJson = parseJson(terminalListJsonResult.text);
    check('presence_terminal list format=json',
      !terminalListJsonResult.isError && Array.isArray(terminalListJson) &&
        terminalListJson.some((entry) =>
          entry.terminalId === jsonTermId && entry.host === host && entry.closed === false),
      terminalListJsonResult.text.slice(0, 200));
    const terminalCloseJsonResult = await call('presence_terminal', {
      action: 'close',
      terminalId: jsonTermId,
      format: 'json',
    });
    const terminalCloseJson = parseJson(terminalCloseJsonResult.text);
    check('presence_terminal close format=json',
      !terminalCloseJsonResult.isError && terminalCloseJson?.terminalId === jsonTermId &&
        terminalCloseJson?.closed === true,
      terminalCloseJsonResult.text.slice(0, 160));
  }
} catch (error) {
  check('integration run', false, error?.stack ?? String(error));
} finally {
  try {
    await call('presence_exec', { host, command: `rm -rf ${remoteRoot}`, confirm: true });
  } catch {
    /* best effort */
  }
  if (localTemp) rmSync(localTemp, { recursive: true, force: true });
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
