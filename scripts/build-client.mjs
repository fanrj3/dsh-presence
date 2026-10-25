// Bundle client-src/ into the single client.js the module loader serves.
//
//   node scripts/build-client.mjs
//
// Build-only dependencies (rollup, CodeMirror) live in .dev/ and are installed
// with:  npm install --prefix .dev --ignore-scripts rollup @rollup/plugin-node-resolve
//        @rollup/plugin-commonjs codemirror @codemirror/language-data @codemirror/theme-one-dark
// They are never shipped; the bundle is self-contained.

import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const devModules = join(root, '.dev', 'node_modules');
const localModules = join(root, 'client-src', 'node_modules');

if (!existsSync(devModules)) {
  console.error('build-client: .dev/node_modules is missing. Install the build-only deps first (see header).');
  process.exit(1);
}
// client-src/node_modules is a build-local mirror so rollup resolves bare
// imports; re-copy it whenever .dev changed (new build dependency installed).
const devStamp = existsSync(join(devModules, '.package-lock.json'))
  ? statSync(join(devModules, '.package-lock.json')).mtimeMs
  : statSync(devModules).mtimeMs;
const localStamp = existsSync(localModules) ? statSync(localModules).mtimeMs : 0;
if (localStamp < devStamp) {
  rmSync(localModules, { recursive: true, force: true });
  cpSync(devModules, localModules, { recursive: true });
}

const load = (specifier) => import(pathToFileURL(join(localModules, specifier)).href);
const { rollup } = await load('rollup/dist/es/rollup.js');
const resolveModule = await load('@rollup/plugin-node-resolve/dist/es/index.js');
const commonjsModule = await load('@rollup/plugin-commonjs/dist/es/index.js');
const nodeResolve = resolveModule.nodeResolve ?? resolveModule.default;
const commonjs = commonjsModule.default ?? commonjsModule.commonjs;

// Minify when the optional terser plugin is installed; a readable bundle is
// still correct, just larger.
let terser = null;
try {
  const terserModule = await load('@rollup/plugin-terser/dist/es/index.js');
  terser = terserModule.default ?? terserModule.terser;
} catch {
  terser = null;
}

const minify = !process.argv.includes('--no-minify') && terser !== null;

const started = Date.now();
const bundle = await rollup({
  input: join(root, 'client-src', 'entry.js'),
  plugins: [
    nodeResolve({ browser: true, preferBuiltins: false, extensions: ['.js', '.mjs'] }),
    commonjs({ include: /node_modules/u, transformMixedEsModules: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'THIS_IS_UNDEFINED') return;
    warn(warning);
  },
});

const output = join(root, 'client.js');
await bundle.write({
  file: output,
  format: 'iife',
  sourcemap: false,
  inlineDynamicImports: true,
  plugins: minify ? [terser({ format: { comments: false } })] : [],
});
await bundle.close();

const size = statSync(output).size;
console.log(`build-client: client.js ${(size / 1024).toFixed(0)} KiB (minified: ${minify}) in ${Date.now() - started} ms`);
