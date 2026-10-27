// Pure line diff: no dependencies, no I/O. Produces the body of a unified diff
// (hunk headers plus `+`/`-`/space rows, no `---`/`+++` file headers, because
// the helper does not know the file names) and the exact added/removed line
// counts. Used by the presence_diff agent tool and by /presence/api/diff.
//
// Trailing CRs are normalised away before comparing, so a remote LF file and a
// local Windows copy of the same content do not report every line as changed.
//
// The output is capped by line count and byte count. `added`/`removed` always
// count the whole change; only the rendered `diff` string is shortened, and
// `truncated` says it was.

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_BYTES = 64 * 1024;
// Bounded LCS table: two unrelated large files would be O(n*m) cells. Past this
// budget the changed middle is rendered as a whole replacement, which is still
// a correct unified diff, only not a minimal one.
const MAX_LCS_CELLS = 1_000_000;

function toInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** Lines without the final-newline artifact; a trailing CR is not content. */
export function splitDiffLines(value) {
  const raw = String(value ?? '');
  if (raw === '') return [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].endsWith('\r')) lines[index] = lines[index].slice(0, -1);
  }
  return lines;
}

/**
 * Insert/delete script for the changed middle, from a bounded LCS table.
 * Line numbers are not assigned here; the caller owns absolute positions.
 */
function middleOps(oldLines, newLines) {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const ops = [];
  if (oldCount === 0) {
    for (const line of newLines) ops.push({ kind: '+', text: line });
    return ops;
  }
  if (newCount === 0) {
    for (const line of oldLines) ops.push({ kind: '-', text: line });
    return ops;
  }
  if ((oldCount + 1) * (newCount + 1) > MAX_LCS_CELLS) {
    for (const line of oldLines) ops.push({ kind: '-', text: line });
    for (const line of newLines) ops.push({ kind: '+', text: line });
    return ops;
  }
  const width = newCount + 1;
  const table = new Uint32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i -= 1) {
    const row = i * width;
    const next = (i + 1) * width;
    for (let j = newCount - 1; j >= 0; j -= 1) {
      const oldLine = oldLines[i];
      const newLine = newLines[j];
      table[row + j] = oldLine === newLine
        ? table[next + j + 1] + 1
        : Math.max(table[next + j], table[row + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: ' ', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: '-', text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: '+', text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldCount) {
    ops.push({ kind: '-', text: oldLines[i] });
    i += 1;
  }
  while (j < newCount) {
    ops.push({ kind: '+', text: newLines[j] });
    j += 1;
  }
  return ops;
}

/**
 * Unified line diff of `before` against `after`.
 *
 * @param {string} before
 * @param {string} after
 * @param {{context?: number, maxLines?: number, maxBytes?: number}} [options]
 * @returns {{diff: string, added: number, removed: number, truncated: boolean}}
 */
export function diffLines(before, after, { context = DEFAULT_CONTEXT, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const ctx = toInt(context, DEFAULT_CONTEXT, 0, 200);
  const lineCap = toInt(maxLines, DEFAULT_MAX_LINES, 1, 1_000_000);
  const byteCap = toInt(maxBytes, DEFAULT_MAX_BYTES, 64, 64 * 1024 * 1024);
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);

  let same = oldLines.length === newLines.length;
  if (same) {
    for (let index = 0; index < oldLines.length; index += 1) {
      if (oldLines[index] !== newLines[index]) {
        same = false;
        break;
      }
    }
  }
  if (same) return { diff: '', added: 0, removed: 0, truncated: false };

  const shared = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ kind: ' ', text: oldLines[index] });
  const middle = middleOps(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
  );
  for (const op of middle) ops.push(op);
  for (let index = oldLines.length - suffix; index < oldLines.length; index += 1) {
    ops.push({ kind: ' ', text: oldLines[index] });
  }

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === '+') added += 1;
    else if (op.kind === '-') removed += 1;
  }

  // Absolute line numbers before each op, so hunk headers are exact and cheap.
  const oldBefore = new Uint32Array(ops.length + 1);
  const newBefore = new Uint32Array(ops.length + 1);
  const changes = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    oldBefore[index + 1] = oldBefore[index] + (op.kind === '+' ? 0 : 1);
    newBefore[index + 1] = newBefore[index] + (op.kind === '-' ? 0 : 1);
    if (op.kind !== ' ') changes.push(index);
  }

  const rows = [];
  let usedBytes = 0;
  let truncated = false;
  const pushRow = (row) => {
    const bytes = Buffer.byteLength(row, 'utf8') + (rows.length > 0 ? 1 : 0);
    if (rows.length + 1 > lineCap || usedBytes + bytes > byteCap) return false;
    rows.push(row);
    usedBytes += bytes;
    return true;
  };

  let pointer = 0;
  while (pointer < changes.length) {
    const first = changes[pointer];
    let last = first;
    let next = pointer + 1;
    // Two changes share a hunk when the unchanged gap fits twice the context.
    while (next < changes.length && changes[next] - last - 1 <= 2 * ctx) {
      last = changes[next];
      next += 1;
    }
    const start = Math.max(0, first - ctx);
    const end = Math.min(ops.length - 1, last + ctx);
    const header =
      `@@ -${oldBefore[start] + 1},${oldBefore[end + 1] - oldBefore[start]} ` +
      `+${newBefore[start] + 1},${newBefore[end + 1] - newBefore[start]} @@`;
    if (!pushRow(header)) {
      truncated = true;
      break;
    }
    let cut = false;
    for (let index = start; index <= end; index += 1) {
      const op = ops[index];
      if (!pushRow(`${op.kind}${op.text}`)) {
        truncated = true;
        cut = true;
        break;
      }
    }
    if (cut) break;
    pointer = next;
  }

  return { diff: rows.join('\n'), added, removed, truncated };
}
