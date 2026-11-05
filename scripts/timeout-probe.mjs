// Timeout / retry probe (0.21.2).
//
//   node scripts/timeout-probe.mjs [alias]
//
// Verifies the transport timeout helpers, the fast-tool hard timeouts and the
// read-only retry wrapper. The real hang path (a dead SFTP request) is covered
// by the per-request timeout in connection.mjs; here the timeout policy itself
// is asserted without waiting for a dead network.
import { register } from 'node:module';

import { isTransientError, sftpRetries, sftpTimeoutMs, withRetry } from '../src/core/retry.js';
import { PresencePool } from '../src/pool.js';

const alias = process.argv[2] ?? 'server';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- helpers
const originalTimeout = process.env.PRESENCE_SFTP_TIMEOUT_MS;
const originalRetries = process.env.PRESENCE_SFTP_RETRIES;
try {
  delete process.env.PRESENCE_SFTP_TIMEOUT_MS;
  delete process.env.PRESENCE_SFTP_RETRIES;
  check('sftp timeout defaults to 30 s', sftpTimeoutMs() === 30_000, String(sftpTimeoutMs()));
  check('sftp retries default to 1', sftpRetries() === 1, String(sftpRetries()));

  process.env.PRESENCE_SFTP_TIMEOUT_MS = '500';
  check('sftp timeout honours the env override', sftpTimeoutMs() === 1_000, `${sftpTimeoutMs()} (clamped to 1 s floor)`);
  process.env.PRESENCE_SFTP_TIMEOUT_MS = '999999';
  check('sftp timeout is capped', sftpTimeoutMs() === 300_000, String(sftpTimeoutMs()));
  process.env.PRESENCE_SFTP_RETRIES = '9';
  check('sftp retries are capped', sftpRetries() === 3, String(sftpRetries()));

  check('timeout errors are transient', isTransientError(Object.assign(new Error('SFTP stat timed out after 30000 ms'), { code: 'timeout' })));
  check('reset errors are transient', isTransientError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  check('permission errors are not transient', !isTransientError(Object.assign(new Error('permission denied'), { code: 3 })));

  let attempts = 0;
  const retried = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error('timed out'), { code: 'timeout' });
      return 'ok';
    },
    { attempts: 2, delayMs: 10 },
  );
  check('withRetry retries once and succeeds', retried.value === 'ok' && retried.attempts === 2, JSON.stringify({ attempts, value: retried.value }));

  let verifiedCalled = false;
  const verified = await withRetry(
    async () => {
      throw Object.assign(new Error('timed out'), { code: 'timeout' });
    },
    {
      attempts: 2,
      delayMs: 10,
      verify: async () => {
        verifiedCalled = true;
        return true;
      },
    },
  );
  check('withRetry treats a verified side effect as success', verified.verified === true && verifiedCalled);

  let nonTransientAttempts = 0;
  let nonTransientError = null;
  try {
    await withRetry(
      async () => {
        nonTransientAttempts += 1;
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      },
      { attempts: 3, delayMs: 5 },
    );
  } catch (error) {
    nonTransientError = error;
  }
  check('withRetry does not retry non-transient errors', nonTransientAttempts === 1 && nonTransientError?.code === 'ENOENT');
} finally {
  if (originalTimeout === undefined) delete process.env.PRESENCE_SFTP_TIMEOUT_MS;
  else process.env.PRESENCE_SFTP_TIMEOUT_MS = originalTimeout;
  if (originalRetries === undefined) delete process.env.PRESENCE_SFTP_RETRIES;
  else process.env.PRESENCE_SFTP_RETRIES = originalRetries;
}

// ---------------------------------------------------------------- tool timeouts
const stubSource = `export function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
    timeoutMs: definition.timeoutMs,
    execute: definition.execute,
  };
}
`;
const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;
const hookSource = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url);

const dshHome = `${process.env.TEMP ?? '/tmp'}\\timeout-probe-${Date.now()}`;
process.env.DSH_HOME = dshHome;
const { definePresenceTools } = await import('../src/tools.js');

const pool = new PresencePool({ maxChannels: 4, connectTimeoutMs: 20_000, idleTimeoutMs: 600_000, readOnly: false });
const tools = new Map(
  definePresenceTools(pool, { maxChannels: 4, connectTimeoutMs: 20_000, idleTimeoutMs: 600_000, readOnly: false }, { cwdOf: async () => null })
    .map((tool) => [tool.name, tool]),
);
const expected = {
  presence_edit: 60_000,
  presence_write: 60_000,
  presence_read: 60_000,
  presence_stat: 30_000,
  presence_search: 120_000,
  presence_glob: 120_000,
};
for (const [name, timeoutMs] of Object.entries(expected)) {
  check(`${name} carries a ${timeoutMs / 1000}s tool timeout`, tools.get(name)?.timeoutMs === timeoutMs, String(tools.get(name)?.timeoutMs));
}
for (const name of ['presence_exec', 'presence_jobs', 'presence_wait', 'presence_export', 'presence_import', 'presence_terminal']) {
  check(`${name} has no hard tool timeout (its own timeout semantics win)`, tools.get(name)?.timeoutMs === undefined, String(tools.get(name)?.timeoutMs));
}

// ---------------------------------------------------------------- live round trip
try {
  const connection = await pool.connection(alias);
  const started = Date.now();
  const info = await connection.stat('/');
  check('a real SFTP stat still succeeds promptly', info.exists === true && Date.now() - started < 10_000, `${Date.now() - started} ms`);
} catch (error) {
  check('a real SFTP stat still succeeds promptly', false, error?.message ?? String(error));
} finally {
  pool.dispose();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
