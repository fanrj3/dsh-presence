// Export-progress / resume / pipelined-read probe (0.20.2).
//
//   node scripts/export-progress-probe.mjs <alias>
//
// Creates small remote fixtures, then:
//   - verifies parallel readBytes returns byte-identical data and reports progress
//   - verifies presence_export writes ~/.dsh/presence/exports/latest.json
//   - verifies a second batch skips already-exported files (resume)
//   - verifies an aborted signal fails the export instead of hanging
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PresencePool } from '../src/pool.js';

const alias = process.argv[2] ?? 'server';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const stubSource = `export function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
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
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url);

const dshHome = join(tmpdir(), `presence-export-probe-home-${Date.now()}`);
const isolatedTemp = join(tmpdir(), `presence-export-probe-tmp-${Date.now()}`);
mkdirSync(dshHome, { recursive: true });
mkdirSync(isolatedTemp, { recursive: true });
// Keep this run's export folder (and manifest) isolated from the shared one.
process.env.TEMP = isolatedTemp;
process.env.TMP = isolatedTemp;
process.env.TMPDIR = isolatedTemp;
process.env.DSH_HOME = dshHome;

const { definePresenceTools } = await import('../src/tools.js');

const dir = `/tmp/presence-export-probe-${Date.now()}`;
const home = join(tmpdir(), `presence-export-probe-local-${Date.now()}`);
mkdirSync(home, { recursive: true });

const pool = new PresencePool({ maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false });
const settings = { maxChannels: 8, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false, defaultHost: null };
const tools = new Map(
  definePresenceTools(pool, settings, { cwdOf: async () => home, observe: null }).map((tool) => [tool.name, tool]),
);
const execCtx = { agent: null, signal: undefined };

try {
  const connection = await pool.connection(alias);
  await connection.exec(`rm -rf ${dir} && mkdir -p ${dir} && head -c 1048576 /dev/urandom > ${dir}/small.bin && head -c 3145728 /dev/urandom > ${dir}/medium.bin && head -c 4096 /dev/urandom > ${dir}/tiny.bin`);

  // 1) parallel readBytes is byte-identical to a single-lane read
  const parallel = await connection.readBytes(`${dir}/medium.bin`, { length: 3 * 1024 * 1024 });
  let sawProgress = false;
  const sequential = await connection.readBytes(`${dir}/medium.bin`, {
    length: 3 * 1024 * 1024,
    concurrency: 1,
    chunkSize: 1024 * 1024,
    onProgress: () => { sawProgress = true; },
  });
  check(
    'readBytes: parallel and sequential reads agree',
    createHash('sha256').update(parallel.buffer).digest('hex') === createHash('sha256').update(sequential.buffer).digest('hex'),
    `${parallel.buffer.length} bytes`,
  );
  check('readBytes: onProgress fires', sawProgress);

  // 2) batch export writes a live progress document and completes
  const first = JSON.parse(await tools.get('presence_export').execute({
    host: alias,
    paths: [`${dir}/tiny.bin`, `${dir}/small.bin`, `${dir}/medium.bin`],
    format: 'json',
  }, execCtx));
  check('export: batch exported all files', first.exported === 3 && first.failed === 0, JSON.stringify({ exported: first.exported, failed: first.failed }));
  check('export: progressPath returned and exists', typeof first.progressPath === 'string' && existsSync(first.progressPath), first.progressPath);
  const progress = JSON.parse(readFileSync(first.progressPath, 'utf8'));
  check('export: progress document is final', progress.done === 3 && progress.exported === 3 && progress.total === 3, JSON.stringify({ done: progress.done, total: progress.total }));

  // 3) second batch skips what is already local (resume)
  const second = JSON.parse(await tools.get('presence_export').execute({
    host: alias,
    paths: [`${dir}/tiny.bin`, `${dir}/small.bin`, `${dir}/medium.bin`],
    format: 'json',
  }, execCtx));
  check('export: second batch skips existing files', second.exported === 0 && second.skipped === 3, JSON.stringify({ exported: second.exported, skipped: second.skipped }));

  // 4) an aborted signal is surfaced as a per-file error, not a hang
  const controller = new AbortController();
  controller.abort();
  const aborted = await tools.get('presence_export').execute({
    host: alias,
    paths: [`${dir}/medium.bin`],
    format: 'json',
    skipExisting: false,
  }, { agent: null, signal: controller.signal });
  const abortedJson = JSON.parse(aborted);
  check('export: aborted signal reported as failure', abortedJson.failed === 1 && /aborted/i.test(abortedJson.errors[0]?.error ?? ''), JSON.stringify(abortedJson.errors));
} catch (error) {
  check('probe ran without throwing', false, error?.stack ?? String(error));
} finally {
  try {
    const connection = await pool.connection(alias);
    await connection.exec(`rm -rf ${dir}`);
  } catch { /* best effort */ }
  pool.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(dshHome, { recursive: true, force: true });
  rmSync(isolatedTemp, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
