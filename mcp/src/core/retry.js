// Network timeouts and retries for the remote transport.
//
// SFTP has no per-request timeout of its own: a dead TCP connection leaves a
// request pending forever, which is why an edit could hang far past any sane
// duration. Every SFTP call is bounded here, read-only calls are retried, and
// the fast tools carry a tool-level timeout so the agent gets an error (and can
// retry) instead of waiting.

/** Error codes worth retrying automatically (a dead or reset link). */
const TRANSIENT_CODES = new Set([
  'timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

export function isTransientError(error) {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  return /timed? ?out|timeout/i.test(String(error.message ?? ''));
}

/** Per-SFTP-request timeout in ms (PRESENCE_SFTP_TIMEOUT_MS, default 30 s). */
export function sftpTimeoutMs() {
  const raw = Number(process.env.PRESENCE_SFTP_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 30_000;
  return Math.min(300_000, Math.max(1_000, Math.floor(raw)));
}

/** Extra attempts for read-only SFTP requests (PRESENCE_SFTP_RETRIES, default 1). */
export function sftpRetries() {
  const raw = Number(process.env.PRESENCE_SFTP_RETRIES);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(3, Math.max(0, Math.floor(raw)));
}

/**
 * Run an idempotent operation with retries on transient failures.
 *
 * @param run attempt function (1-based attempt number is passed)
 * @param options.attempts total attempts (default 2)
 * @param options.verify optional `async () => boolean`; when it returns true
 *   after a failure, the operation is treated as applied (a timed-out write
 *   that actually landed must not be retried).
 */
export async function withRetry(run, { attempts = 2, delayMs = 150, verify = null } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { value: await run(attempt), attempts: attempt, verified: false };
    } catch (error) {
      lastError = error;
      if (verify) {
        try {
          if (await verify()) return { value: null, attempts: attempt, verified: true };
        } catch {
          /* verification is best effort */
        }
      }
      if (!isTransientError(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
