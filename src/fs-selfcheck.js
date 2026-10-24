// Read-only rehearsal for the filesystem provider.
//
// It builds the provider's methods on a prototype object WITHOUT registering the
// `fs` service, then exercises the presence:// code path against a real host.
// A failure here is contained to this one plugin row: ctx.fs is untouched.

import { writeFileSync } from 'node:fs';
import PresenceFileSystem from './fs-provider.js';
import { shared } from './shared.js';

const DEFAULT_REPORT = 'D:\\04_Dev\\Presence\\selfcheck-report.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dryProbe() {
  // Object.create gives every method without running the Service constructor,
  // which is what would otherwise register `ctx.fs` as a side effect.
  const probe = Object.create(PresenceFileSystem.prototype);
  probe.config = { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 };
  probe.internals = {};
  probe.locks = new Map();
  probe.ctx = { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } };
  return probe;
}

export function apply(ctx, config = {}) {
  const host = config.host ?? 'server';
  const reportPath = config.reportPath ?? DEFAULT_REPORT;
  const steps = [];

  const record = async (name, run) => {
    const started = Date.now();
    try {
      const detail = await run();
      steps.push({ step: name, ok: true, ms: Date.now() - started, detail });
      return detail;
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        ms: Date.now() - started,
        error: error?.message ?? String(error),
        code: error?.code,
      });
      return undefined;
    }
  };

  const check = async () => {
    for (let attempt = 0; attempt < 40 && !shared.pool; attempt += 1) await sleep(250);
    if (!shared.pool) throw new Error('the Presence pool is not running; load the presence row first');

    const probe = dryProbe();
    const root = `presence://${host}`;
    const file = `${root}/etc/hostname`;
    const scratch = `${root}/tmp/presence-selfcheck-${Date.now()}.txt`;
    const payload = 'presence selfcheck\nalpha\nbeta\n';

    const target = await record('resolve', () => probe.resolve(file));
    if (!target) return;
    await record('stat', () => probe.stat(target));
    await record('readText', async () => {
      const text = await probe.readText(target);
      return { bytes: text.length, sample: text.trim().slice(0, 60) };
    });
    await record('listDir /', async () => {
      const rootTarget = await probe.resolve(`${root}/`);
      const entries = await probe.listDir(rootTarget);
      return { count: entries.length, sample: entries.slice(0, 5).map((entry) => `${entry.name}:${entry.type}`) };
    });
    await record('readBytes capped', async () => {
      const bytes = await probe.readBytes(target, undefined, 1024);
      return { bytes: bytes.length };
    });
    await record('readByteRange', async () => {
      const bytes = await probe.readByteRange(target, { offset: 0, length: 8 }, undefined);
      return { bytes: bytes.length };
    });
    await record('contains', async () => {
      const parent = await probe.resolve(`${root}/etc`);
      return { contained: probe.contains(parent, target) };
    });

    const scratchTarget = await record('resolve scratch', () => probe.resolve(scratch));
    if (!scratchTarget) return;

    await record('writeText create', () => probe.writeText(scratchTarget, payload));
    await record('readText after create', async () => {
      const text = await probe.readText(scratchTarget);
      if (text !== payload) throw new Error('content mismatch after create');
      return { bytes: text.length };
    });
    await record('editText', async () => {
      const current = await probe.stat(scratchTarget);
      const outcome = await probe.editText(
        scratchTarget,
        { oldString: 'alpha', newString: 'ALPHA', replaceAll: false },
        { kind: 'replaceIfVersion', version: current.version },
      );
      return { version: String(outcome.version), changed: outcome.before !== outcome.after };
    });
    await record('readText after edit', async () => {
      const text = await probe.readText(scratchTarget);
      if (!text.includes('ALPHA')) throw new Error('edit was not applied');
      return { bytes: text.length };
    });
    await record('stale version rejected', async () => {
      try {
        await probe.writeText(scratchTarget, 'nope', { kind: 'replaceIfVersion', version: 'presence:0:0:f' });
      } catch (error) {
        return { code: error.code ?? error.message };
      }
      throw new Error('a stale version was accepted');
    });
    await record('cleanup', async () => {
      const connection = await shared.pool.connection(host);
      // `scratch` is a presence URL; the connection wants the remote path.
      const remotePath = scratch.slice(`presence://${host}`.length);
      await connection.unlink(remotePath);
      return { removed: remotePath };
    });
  };

  check()
    .then(() => {
      const ok = steps.every((step) => step.ok);
      const report = { ok, host, checkedAt: new Date().toISOString(), steps };
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`[presence-selfcheck] ${ok ? 'PASS' : 'FAIL'} ${steps.filter((s) => s.ok).length}/${steps.length}`);
      for (const step of steps) console.log(`[presence-selfcheck] ${step.ok ? 'ok  ' : 'FAIL'} ${step.step} (${step.ms}ms)${step.error ? `: ${step.error}` : ''}`);
    })
    .catch((error) => {
      writeFileSync(reportPath, `${JSON.stringify({ ok: false, error: error?.message ?? String(error), steps }, null, 2)}\n`, 'utf8');
      console.log(`[presence-selfcheck] FAIL ${error?.message ?? error}`);
    });
}
