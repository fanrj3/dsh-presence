// Local path helpers kept in their own module so tools.js stays readable.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';

const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FILES = 50;

/** Directory where remote files are materialised for the desktop GUI. */
export function exportDirectory() {
  return join(tmpdir(), 'presence-exports');
}

/** Delete stale exports so the folder does not grow without bound. */
export function pruneExports(folder) {
  try {
    const entries = readdirSync(folder)
      .map((name) => {
        const path = join(folder, name);
        try {
          return { path, at: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const entry of entries.slice(MAX_FILES)) unlinkSync(entry.path);
    for (const entry of entries) {
      if (entry.at < cutoff) unlinkSync(entry.path);
    }
  } catch {
    /* cleanup is best effort */
  }
}

export { join, dirname, resolve, sep };
