// Isolated preflight for the filesystem provider.
//
// Loads the real Cordis + fs packages out of the harness asar (Electron must run
// as Node), evaluates the real `src/fs-provider.js`, loads it as a plugin on a
// fresh Context, and asserts the path matrix.
//
//   $env:ELECTRON_RUN_AS_NODE=1
//   & 'C:\...\DeepSeek Harness.exe' scripts\isolated-check.mjs

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as mounts from '../src/mounts.js';
import { shared } from '../src/shared.js';

const ASAR = process.env.DSH_ASAR ?? 'C:/Users/three/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const NM = `${ASAR}/dsh/node_modules/@deepseek-ai`;
const WORKSPACE = process.env.PRESENCE_DIR ?? 'D:/04_Dev/Presence';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[check]', ...args);

const fromAsar = (pkg, file = 'lib/index.js') => import(pathToFileURL(`${NM}/${pkg}/${file}`).href);

const cordis = await fromAsar('cordis');
const fsPkg = await fromAsar('dsh-fs');
const sandboxPkg = await fromAsar('dsh-fs-sandbox');
const { Context, Service } = cordis;
const { FsError, FsVersion } = fsPkg;
const { SandboxedFileSystem } = sandboxPkg;

shared.mountsRoot = mounts.mountsRoot();

class Policy extends Service {
  constructor(ctx) {
    super(ctx, 'sandboxPolicy');
    this.defaultMode = 'workspace-write';
  }
  resolve() {
    return { mode: 'workspace-write', workspaceRoot: null };
  }
}

// Generic ESM import rewrite: every import becomes a destructuring from __deps.
const source = readFileSync(`${WORKSPACE}/src/fs-provider.js`, 'utf8');
const deps = {
  '@deepseek-ai/dsh-fs-sandbox': { SandboxedFileSystem },
  '@deepseek-ai/dsh-fs': { FsError, FsVersion },
  './shared.js': { shared },
  './debug.js': { debugLog: () => {} },
  './core/ssh-config.mjs': {
    listHosts: () => [{ alias: 'server' }, { alias: 'other-host' }],
  },
  './mounts.js': mounts,
  'node:url': { pathToFileURL },
  'node:string_decoder': { StringDecoder: (await import('node:string_decoder')).StringDecoder },
};
const body = source
  .replace(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';$/gm, (_m, names, spec) => {
    const local = names
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => {
        const [imported, alias] = name.split(/\s+as\s+/);
        return alias ? `${imported.trim()}: ${alias.trim()}` : imported.trim();
      })
      .join(', ');
    return `const { ${local} } = __deps[${JSON.stringify(spec)}];`;
  })
  .replace(/^import\s+(\w+)\s+from\s+'([^']+)';$/gm, (_m, name, spec) => `const ${name} = __deps[${JSON.stringify(spec)}].default;`)
  .replace('export default class PresenceFileSystem', 'class PresenceFileSystem')
  .concat('\nreturn PresenceFileSystem;\n');

const PresenceFileSystem = new Function('__deps', body)(deps);
log('provider evaluated:', typeof PresenceFileSystem);

const ctx = new Context();
new Policy(ctx);
ctx.plugin(PresenceFileSystem, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 });
await sleep(200);
const provider = ctx.get('fs');
log('ctx.fs registered:', Boolean(provider));
if (!provider) process.exit(4);

const mountCwd = mounts.mountPathFor('server', '/srv/workspace');
const matrix = [
  ['C:\\Users\\three\\AppData\\Local\\Temp\\x.md', 'local'],
  ['D:/04_Dev/Presence/README.md', 'local'],
  ['/srv/workspace/docs/a.md', 'remote'],
  ['docs/a.md', 'remote'],
  ['presence://server/srv/workspace/docs/a.md', 'remote'],
  [`${mountCwd}/docs/a.md`, 'remote'],
];
let ok = 0;
for (const [input, expected] of matrix) {
  const target = await provider.resolve(input, { cwd: mountCwd });
  const kind = String(target.targetKey).startsWith('presence://') ? 'remote' : 'local';
  const pass = kind === expected;
  ok += pass ? 1 : 0;
  log(`${pass ? 'ok  ' : 'FAIL'} matrix ${expected.padEnd(6)} ${input} -> ${kind}`);
}

// lstat must route a mount path to the remote; without a live pool it fails
// inside the provider, which still proves it did not hit the local disk.
const surfaced = await provider.lstat(`${mountCwd}/docs/a.md`, { cwd: mountCwd }, undefined).then(
  () => 'resolved',
  (error) => `${error.code ?? ''}:${error.message}`,
);
log('lstat mount path ->', surfaced);

// workspace-write fence: a path outside the policy root must be denied.
let realpathAnswer = '/home/user/x.txt';
deps['./shared.js'].shared.pool = {
  connection: async () => ({
    stat: async () => ({ exists: true, size: 1, mtime: 1, isDir: false }),
    readText: async () => ({ content: 'x' }),
    writeText: async () => {},
    exec: async (command) => {
      if (String(command).includes('realpath')) return { code: 0, stdout: `${realpathAnswer}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    homePath: async () => '/home/user',
  }),
};
const outside = await provider
  .writeText(
    { targetKey: 'presence://server/elsewhere/x.txt', displayPath: 'presence://server/elsewhere/x.txt' },
    'data',
    undefined,
    undefined,
    { mode: 'workspace-write', workspaceRoot: mountCwd },
  )
  .then(
    () => 'ALLOWED',
    (error) => error.code ?? error.message,
  );
log('fence outside workspace ->', outside);

// symlink escape: the path LOOKS inside the workspace but resolves outside.
realpathAnswer = '/srv/workspace/x.txt';
const escaped = await provider
  .writeText(
    { targetKey: 'presence://server/srv/app/tentlink/x.txt', displayPath: 'presence://server/srv/app/tentlink/x.txt' },
    'data',
    undefined,
    undefined,
    { mode: 'workspace-write', workspaceRoot: mounts.mountPathFor('server', '/srv/app') },
  )
  .then(
    () => 'ALLOWED',
    (error) => error.code ?? error.message,
  );
log('fence symlink escape ->', escaped);

// a symlink that resolves INSIDE the workspace must stay writable.
realpathAnswer = '/srv/app/real/x.txt';
const insideLink = await provider
  .writeText(
    { targetKey: 'presence://server/srv/app/link/x.txt', displayPath: 'presence://server/srv/app/link/x.txt' },
    'data',
    undefined,
    undefined,
    { mode: 'workspace-write', workspaceRoot: mounts.mountPathFor('server', '/srv/app') },
  )
  .then(
    () => 'ALLOWED',
    (error) => error.code ?? error.message,
  );
log('fence inside symlink ->', insideLink);

const passed =
  ok === matrix.length &&
  String(outside).includes('FS_SANDBOX_DENIED') &&
  String(escaped).includes('FS_SANDBOX_DENIED') &&
  String(insideLink) === 'ALLOWED';
log(`\npath matrix ${ok}/${matrix.length}; fence outside=${outside}; escape=${escaped}; inside=${insideLink}`);
process.exit(passed ? 0 : 1);
