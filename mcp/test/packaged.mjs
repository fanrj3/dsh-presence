// Packaged-install test: drive an *installed* presence-mcp bin (from `npm pack`
// + `npm install <tarball>` in a scratch directory), not the repo checkout.
//
//   node test/packaged.mjs "C:\Temp\presence-mcp-install-test\node_modules\presence-mcp"
//   node test/packaged.mjs "C:\Temp\presence-mcp-install-test\node_modules\.bin\presence-mcp.cmd"
//
// Accepts either the installed package directory (its package.json `bin` is
// used) or the bin shim itself. It proves the package is self-contained: the
// vendored kernel has to load from node_modules, with no ../../src next to it.
//
// The script itself runs from the repo (it needs @modelcontextprotocol/sdk,
// which is also a dependency of the installed package).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function usage(message) {
  console.error(`packaged: ${message}`);
  console.error('usage: node test/packaged.mjs <installed-package-dir|installed-bin>');
  process.exit(2);
}

const arg = process.argv[2];
if (!arg) usage('missing path to the installed package or bin');
if (!existsSync(arg)) usage(`no such path: ${arg}`);

let bin = resolve(arg);
if (statSync(bin).isDirectory()) {
  const packageJson = join(bin, 'package.json');
  if (existsSync(packageJson)) {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
    const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['presence-mcp'];
    if (!entry) usage(`${packageJson} has no presence-mcp bin entry`);
    bin = resolve(bin, entry);
  } else {
    // A node_modules/.bin directory: use the shim npm generated.
    bin = join(bin, process.platform === 'win32' ? 'presence-mcp.cmd' : 'presence-mcp');
  }
}
if (!existsSync(bin)) usage(`missing bin: ${bin}`);
console.log(`# bin: ${bin}`);

/** Spawn the installed bin the same way a client would. */
function launcher() {
  if (process.platform === 'win32' && /\.cmd$/iu.test(bin)) {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin] };
  }
  if (/\.(?:mjs|cjs|js)$/iu.test(bin)) return { command: process.execPath, args: [bin] };
  return { command: bin, args: [] };
}

function runCli(...extra) {
  const { command, args } = launcher();
  const result = spawnSync(command, [...args, ...extra], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const version = runCli('--version');
check('已安装 bin --version', version.status === 0 && /^\d+\.\d+\.\d+\s*$/u.test(version.stdout.trim()),
  JSON.stringify(version.stdout.trim() || version.stderr.trim().slice(0, 120)));

const cliCheck = runCli('--check');
let cliCheckBody = null;
try { cliCheckBody = JSON.parse(cliCheck.stdout); } catch { cliCheckBody = null; }
check('已安装 bin --check 输出 JSON（20 工具）',
  cliCheck.status === 0 && cliCheckBody?.server === 'presence-mcp' && cliCheckBody?.tools === 20 &&
    Array.isArray(cliCheckBody?.hosts),
  cliCheckBody ? `version=${cliCheckBody.version} tools=${cliCheckBody.tools} hosts=${cliCheckBody.hosts.length}` :
    cliCheck.stderr.trim().slice(0, 160));

const help = runCli('--help');
check('已安装 bin --help', help.status === 0 && /presence-mcp/u.test(help.stdout) && /--check/u.test(help.stdout),
  help.stdout.split('\n')[0]);

const { command, args } = launcher();
const transport = new StdioClientTransport({
  command,
  args,
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'presence-packaged', version: '0.0.0' });
const watchdog = setTimeout(() => {
  console.error('packaged: timed out talking to the installed bin');
  process.exit(1);
}, 60_000);
watchdog.unref?.();

try {
  await client.connect(transport);
  const info = client.getServerVersion?.() ?? null;
  check('stdio initialize', info?.name === 'presence' && info?.version === '0.2.0', `${info?.name}@${info?.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  check('stdio tools/list 返回 20 个工具',
    names.length === 20 && names.includes('presence_status') && names.includes('presence_forward'),
    `${names.length} tools`);

  const hosts = await client.callTool({ name: 'presence_list_hosts', arguments: {} });
  const hostText = hosts.content?.[0]?.text ?? '';
  check('stdio presence_list_hosts（vendored ssh-config 生效）',
    hosts.isError !== true && /alias/u.test(hostText) && hostText.includes('\t'),
    hostText.split('\n')[1] ?? '');

  const status = await client.callTool({ name: 'presence_status', arguments: {} });
  let statusBody = null;
  try { statusBody = JSON.parse(status.content?.[0]?.text ?? 'null'); } catch { statusBody = null; }
  check('stdio presence_status（vendored kernel 生效）',
    status.isError !== true && statusBody?.server === 'presence-mcp' && statusBody?.tools === 20 &&
      typeof statusBody?.uptimeMs === 'number' && typeof statusBody?.node === 'string',
    statusBody ? `node=${statusBody.node} uptimeMs=${statusBody.uptimeMs}` : 'invalid JSON');
} catch (error) {
  check('packaged run', false, error?.stack ?? String(error));
} finally {
  clearTimeout(watchdog);
  await client.close().catch(() => {});
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
