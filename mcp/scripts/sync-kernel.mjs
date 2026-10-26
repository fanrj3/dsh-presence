#!/usr/bin/env node
// Maintenance helper: keep the vendored Presence kernel in sync with the
// plugin tree that lives next to this package in the repository.
//
//   node scripts/sync-kernel.mjs           copy ../../src/<closure> -> src/
//   node scripts/sync-kernel.mjs --check   verify the vendored copy is identical
//
// The published package ships the vendored copy (`mcp/src/`); this script is
// only for people working inside the repo, where `../../src` exists. `prepack`
// runs the --check mode so a stale copy can never be published by accident.
//
// The closure is computed from the actual relative imports of the entry
// modules, so a new kernel dependency is either vendored or fails the check.
// Copied files stay byte-identical: their own relative imports keep working
// because the layout under src/ mirrors ../../src.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, '..');
const KERNEL_ROOT = resolve(MCP_ROOT, '..', 'src');
const TARGET_ROOT = resolve(MCP_ROOT, 'src');

// Entry modules the MCP server imports from the kernel. Everything under
// src/core/ is pulled in transitively (connection.mjs, ssh-config.mjs, ...).
const SEEDS = [
  'pool.js',
  'custom-hosts.js',
  'remote-search.js',
  'destructive.js',
  'localpaths.js',
  'mounts.js',
  'workspaces.js',
];

const STATIC_RE = /\b(?:import|export)\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gu;
const SIDE_EFFECT_RE = /\bimport\s+['"]([^'"]+)['"]/gu;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

function fail(message) {
  console.error(`sync-kernel: ${message}`);
  process.exit(1);
}

function walkImports(file) {
  const text = readFileSync(file, 'utf8');
  const specifiers = new Set();
  for (const pattern of [STATIC_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) specifiers.add(match[1]);
  }
  return [...specifiers].filter((specifier) => specifier.startsWith('.'));
}

/** Resolve a relative specifier relative to `fromFile`, trying the usual extensions. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, resolve(base, 'index.js'), resolve(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

/** Compute the transitive closure of relative imports starting at SEEDS. */
function closure() {
  if (!existsSync(KERNEL_ROOT)) {
    fail(`plugin kernel not found at ${KERNEL_ROOT} (run from the repository checkout, not from an installed package)`);
  }
  const seen = new Set();
  const queue = SEEDS.map((seed) => {
    const file = resolve(KERNEL_ROOT, seed);
    if (!existsSync(file)) fail(`seed module missing: ${relative(KERNEL_ROOT, file)}`);
    return file;
  });
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!within(KERNEL_ROOT, file)) fail(`closure escaped ${KERNEL_ROOT}: ${file}`);
    seen.add(file);
    for (const specifier of walkImports(file)) {
      const next = resolveRelative(file, specifier);
      if (!next) fail(`${relative(KERNEL_ROOT, file)} imports "${specifier}" which does not exist`);
      if (!within(KERNEL_ROOT, next)) fail(`${relative(KERNEL_ROOT, file)} imports "${specifier}" outside the kernel root`);
      if (!seen.has(next)) queue.push(next);
    }
  }
  return [...seen].map((file) => relative(KERNEL_ROOT, file).split(sep).join('/')).sort();
}

/** Fail when a runtime file still reaches outside the package with a relative import. */
function assertSelfContained() {
  const problems = [];
  const skip = new Set(['node_modules', '.git', '.npm-cache']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:mjs|cjs|js)$/u.test(entry.name)) continue;
      for (const specifier of walkImports(full)) {
        const target = resolveRelative(full, specifier);
        if (!target) {
          problems.push(`${relative(MCP_ROOT, full)} imports "${specifier}" which does not exist`);
        } else if (!within(MCP_ROOT, target)) {
          problems.push(`${relative(MCP_ROOT, full)} imports "${specifier}" outside mcp/`);
        }
      }
    }
  };
  walk(MCP_ROOT);
  if (problems.length > 0) {
    fail(`package is not self-contained:\n  ${problems.join('\n  ')}`);
  }
}

function main(argv) {
  const check = argv.includes('--check');
  const files = closure();

  if (check) {
    const drifted = [];
    for (const rel of files) {
      const source = resolve(KERNEL_ROOT, rel);
      const target = resolve(TARGET_ROOT, rel);
      if (!existsSync(target)) {
        drifted.push(`missing ${rel}`);
        continue;
      }
      if (!readFileSync(source).equals(readFileSync(target))) drifted.push(`differs ${rel}`);
    }
    // A removed kernel module leaves a stale vendored file behind: also drift.
    if (existsSync(TARGET_ROOT)) {
      const expected = new Set(files);
      const extra = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(?:mjs|cjs|js)$/u.test(entry.name)) {
            const rel = relative(TARGET_ROOT, full).split(sep).join('/');
            if (!expected.has(rel)) extra.push(rel);
          }
        }
      };
      walk(TARGET_ROOT);
      for (const rel of extra.sort()) drifted.push(`stale ${rel}`);
    }
    if (drifted.length > 0) {
      fail(`vendored kernel is out of date (run: node scripts/sync-kernel.mjs)\n  ${drifted.join('\n  ')}`);
    }
    assertSelfContained();
    console.log(`sync-kernel: ${files.length} file(s) up to date`);
    for (const rel of files) console.log(`  ok ${rel}`);
    return 0;
  }

  for (const rel of files) {
    const source = resolve(KERNEL_ROOT, rel);
    const target = resolve(TARGET_ROOT, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`  copied ${relative(KERNEL_ROOT, source)} -> ${relative(MCP_ROOT, target)}`);
  }
  assertSelfContained();
  console.log(`sync-kernel: ${files.length} file(s) copied`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
