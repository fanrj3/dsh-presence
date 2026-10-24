// Append-only diagnostics for the filesystem provider. Enabled always; the file
// stays tiny unless something is actually failing.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function logFile() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'presence', 'debug.log');
}

export function debugLog(tag, message) {
  try {
    const file = logFile();
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [${tag}] ${message}\n`, 'utf8');
  } catch {
    /* diagnostics never break the caller */
  }
}
