// Remote file operations shared by the presence_mkdir / presence_move /
// presence_copy / presence_chmod tools and by the /presence/api/path-op route.
//
// Small files travel as SFTP bytes (read then atomic write); whole directory
// trees and large files use one quoted remote `cp`/`chmod`/`mkdir` command so
// nothing is streamed through this process's memory. Every error is an
// `Error` with an actionable message; callers turn it into {ok:false,error} or
// a tool failure.
//
// Paths are absolute remote paths. The callers (tools, API) resolve
// workspace-relative, `~/...`, presence:// and mount-path spellings first.

// Files up to this size are copied through SFTP bytes; larger files use a
// remote `cp` command. Keeps this process's memory bounded.
const FILE_STREAM_CAP = 8 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;
const COPY_TIMEOUT_MS = 300_000;

/** POSIX single-quoting for the remote shell. */
function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function requirePath(value, label) {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) throw new Error(`${label} must be a non-empty remote path`);
  if (path.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  if (!path.startsWith('/')) {
    throw new Error(`${label} must be an absolute remote path, got ${JSON.stringify(path)}`);
  }
  if (path === '/') return '/';
  return path.replace(/\/+$/, '');
}

function dirName(path) {
  if (path === '/') return '/';
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function parseModeValue(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0o7777) {
      throw new Error(`mode must be an octal number such as 0o755, got ${String(value)}`);
    }
    return value;
  }
  const match = /^(?:0o)?0?([0-7]{1,4})$/.exec(String(value ?? '').trim());
  if (!match) throw new Error(`mode must be an octal string such as "755" or "0644", got ${JSON.stringify(value)}`);
  return Number.parseInt(match[1], 8);
}

function modeString(value) {
  const mode = Number(value);
  if (!Number.isInteger(mode) || mode < 0) return null;
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

async function sftpChannel(connection) {
  if (!connection || !('sftp' in connection)) {
    throw new Error('this Presence build has no SFTP support; update the plugin');
  }
  return connection.sftp;
}

/** One promisified SFTP wrapper call. */
async function sftpCall(connection, method, ...args) {
  const channel = await sftpChannel(connection);
  if (typeof channel[method] !== 'function') {
    throw new Error(`this Presence build has no SFTP ${method} support; update the plugin`);
  }
  return new Promise((resolve, reject) => {
    channel[method](...args, (error, ...results) => {
      if (error) reject(error);
      else resolve(results.length > 1 ? results : results[0]);
    });
  });
}

function isMissing(error) {
  return error?.code === 2 || /no such file|not found/i.test(String(error?.message ?? ''));
}

/** lstat: the literal directory entry, never the link target. */
async function pathInfo(connection, path) {
  try {
    const info = await sftpCall(connection, 'lstat', path);
    return {
      path,
      exists: true,
      size: Number(info?.size) || 0,
      mode: typeof info?.mode === 'number' ? info.mode & 0o7777 : null,
      isDir: Boolean(info?.isDirectory?.()),
      isFile: Boolean(info?.isFile?.()),
      isLink: Boolean(info?.isSymbolicLink?.()),
    };
  } catch (error) {
    if (isMissing(error)) {
      return { path, exists: false, size: 0, mode: null, isDir: false, isFile: false, isLink: false };
    }
    throw new Error(`cannot inspect ${path}: ${error?.message ?? String(error)}`);
  }
}

async function runExec(connection, command, timeoutMs = EXEC_TIMEOUT_MS) {
  if (typeof connection?.exec !== 'function') {
    throw new Error('this Presence build has no remote exec support; update the plugin');
  }
  try {
    return await connection.exec(command, { timeoutMs });
  } catch (error) {
    throw new Error(`remote command failed (${command}): ${error?.message ?? String(error)}`);
  }
}

function execDetail(result) {
  const stderr = String(result?.stderr ?? '').trim();
  if (stderr) return stderr;
  if (result?.timedOut === true) return 'the command hit its deadline';
  return `exit ${result?.code ?? '?'}`;
}

/** Best-effort size/count of a copied tree; omitted when the host cannot say. */
async function measureTree(connection, path) {
  try {
    const result = await connection.exec(
      `du -sb -- ${shq(path)} 2>/dev/null | cut -f1; find ${shq(path)} -type f 2>/dev/null | wc -l`,
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) return {};
    const lines = String(result.stdout ?? '').trim().split('\n');
    const bytes = Number(lines[0]);
    const files = Number(lines[1]);
    return {
      ...(Number.isFinite(bytes) && lines[0] !== '' ? { bytes } : {}),
      ...(Number.isFinite(files) && lines[1] !== '' ? { files } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Create one remote directory. With `recursive:true` (the default) missing
 * parents are created and an existing directory is a success; with
 * `recursive:false` the parent must already exist and the call is still
 * idempotent when the target is already a directory.
 *
 * @returns {Promise<{path: string}>}
 */
export async function makeDirectory(connection, target, { recursive = true } = {}) {
  const path = requirePath(target, 'path');
  const existing = await pathInfo(connection, path);
  if (existing.exists) {
    if (existing.isDir) return { path };
    throw new Error(`cannot create ${path}: a file already exists at that path`);
  }
  if (recursive) {
    const result = await runExec(connection, `mkdir -p -- ${shq(path)}`, 30_000);
    if (result.code !== 0) throw new Error(`could not create ${path}: ${execDetail(result)}`);
    const created = await pathInfo(connection, path);
    if (!created.exists) throw new Error(`mkdir reported success but ${path} does not exist`);
    return { path };
  }
  const parent = dirName(path);
  if (parent !== path) {
    const parentInfo = await pathInfo(connection, parent);
    if (!parentInfo.exists) {
      throw new Error(`cannot create ${path}: parent directory ${parent} does not exist (pass recursive:true to create it)`);
    }
    if (!parentInfo.isDir) throw new Error(`cannot create ${path}: ${parent} is not a directory`);
  }
  try {
    await sftpCall(connection, 'mkdir', path);
  } catch (error) {
    const after = await pathInfo(connection, path).catch(() => ({ exists: false, isDir: false }));
    if (after.exists && after.isDir) return { path };
    throw new Error(`could not create directory ${path}: ${error?.message ?? String(error)}`);
  }
  return { path };
}

/**
 * Rename/move one path on the host. `to` is the exact new path (it is not
 * treated as a directory to move into). Overwriting an existing file needs
 * `overwrite:true`; an existing directory is never merged into.
 *
 * @returns {Promise<{from: string, to: string}>}
 */
export async function movePath(connection, from, to, { overwrite = false } = {}) {
  const source = requirePath(from, 'from');
  const destination = requirePath(to, 'to');
  if (source === '/') throw new Error('refusing to move /');
  if (destination === '/') throw new Error('refusing to move onto /');
  if (source === destination) return { from: source, to: destination };

  const info = await pathInfo(connection, source);
  if (!info.exists) throw new Error(`cannot move ${source}: it does not exist`);

  const parent = dirName(destination);
  if (parent !== '/') {
    const parentInfo = await pathInfo(connection, parent);
    if (!parentInfo.exists) {
      throw new Error(`cannot move to ${destination}: ${parent} does not exist (create it first with presence_mkdir)`);
    }
    if (!parentInfo.isDir) throw new Error(`cannot move to ${destination}: ${parent} is not a directory`);
  }

  const target = await pathInfo(connection, destination);
  if (target.exists) {
    if (!overwrite) {
      throw new Error(`refusing to move onto ${destination}: it already exists; pass overwrite:true to replace it`);
    }
    if (target.isDir) {
      throw new Error(
        `refusing to replace the directory ${destination}: move it aside first (presence_trash) or choose a new name`,
      );
    }
    if (info.isDir) {
      throw new Error(`refusing to move directory ${source} onto the file ${destination}; choose a different name`);
    }
  }

  try {
    if (overwrite && target.exists) {
      try {
        await sftpCall(connection, 'ext_openssh_rename', source, destination);
      } catch {
        // Servers without the posix-rename extension: replace explicitly.
        await sftpCall(connection, 'unlink', destination);
        await sftpCall(connection, 'rename', source, destination);
      }
    } else {
      await sftpCall(connection, 'rename', source, destination);
    }
  } catch (error) {
    throw new Error(`could not move ${source} to ${destination}: ${error?.message ?? String(error)}`);
  }

  const moved = await pathInfo(connection, destination).catch(() => ({ exists: false }));
  if (!moved.exists) throw new Error(`move reported success but ${destination} does not exist`);
  const remained = await pathInfo(connection, source).catch(() => ({ exists: true }));
  if (remained.exists) throw new Error(`move reported success but ${source} still exists`);
  return { from: source, to: destination };
}

/**
 * Copy one remote file or directory. `to` is the exact destination path.
 * A directory source requires `recursive:true` and is copied with a remote
 * `cp -a`; a file source is streamed through SFTP when small and copied with a
 * remote `cp -p` when large. Overwriting is always explicit.
 *
 * @returns {Promise<{from: string, to: string, bytes?: number, files?: number}>}
 */
export async function copyPath(connection, from, to, { recursive = false, overwrite = false } = {}) {
  const source = requirePath(from, 'from');
  const destination = requirePath(to, 'to');
  if (source === '/') throw new Error('refusing to copy / (choose a path inside the filesystem)');
  if (destination === '/') throw new Error('refusing to copy onto /');
  if (source === destination) throw new Error('from and to are the same path');

  let sourceInfo;
  try {
    sourceInfo = await connection.stat(source);
  } catch (error) {
    throw new Error(`cannot inspect ${source}: ${error?.message ?? String(error)}`);
  }
  if (!sourceInfo.exists) throw new Error(`cannot copy ${source}: it does not exist`);
  const isDirectory = sourceInfo.isDir === true;
  if (isDirectory && !recursive) {
    throw new Error(`${source} is a directory; pass recursive:true to copy it`);
  }

  const parent = dirName(destination);
  if (parent !== '/') {
    const parentInfo = await pathInfo(connection, parent);
    if (!parentInfo.exists) {
      throw new Error(`cannot copy to ${destination}: ${parent} does not exist (create it first with presence_mkdir)`);
    }
    if (!parentInfo.isDir) throw new Error(`cannot copy to ${destination}: ${parent} is not a directory`);
  }

  const target = await pathInfo(connection, destination);
  if (target.exists && !overwrite) {
    throw new Error(`refusing to overwrite ${destination}: it already exists; pass overwrite:true to replace it`);
  }
  if (target.exists && target.isLink) {
    // Writing through a link would modify whatever it points at.
    throw new Error(`refusing to copy onto ${destination}: it is a symlink (remove it, or copy to a new path)`);
  }

  if (isDirectory) {
    return copyDirectory(connection, source, destination, { overwrite, target });
  }

  if (target.exists && target.isDir) {
    throw new Error(`cannot copy the file ${source} onto the directory ${destination}; choose a file path`);
  }
  return copyFile(connection, source, destination, { overwrite, sourceInfo });
}

async function copyFile(connection, source, destination, { overwrite, sourceInfo }) {
  const size = Number(sourceInfo.size) || 0;
  const mode = typeof sourceInfo.mode === 'number' ? sourceInfo.mode : null;
  if (size <= FILE_STREAM_CAP) {
    const { buffer } = await connection.readBytes(source, { offset: 0, length: size });
    try {
      await connection.writeBytes(destination, buffer, mode === null ? {} : { mode });
    } catch (error) {
      throw new Error(`could not write ${destination}: ${error?.message ?? String(error)}`);
    }
    return { from: source, to: destination, bytes: buffer.length, files: 1 };
  }
  // Large file: never pull it through this process; one remote copy command.
  const result = await runExec(connection, `cp -p -- ${shq(source)} ${shq(destination)}`, COPY_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`could not copy ${source} to ${destination}: ${execDetail(result)}`);
  return {
    from: source,
    to: destination,
    bytes: size,
    files: 1,
  };
}

async function copyDirectory(connection, source, destination, { overwrite, target }) {
  // Replacing a whole tree is staged: move the old directory aside first, copy,
  // and only delete the aside copy once the new tree is complete. A failed copy
  // restores the old directory instead of leaving a half-replaced tree.
  let backup = null;
  if (target.exists) {
    const home = typeof connection.homePath === 'function' ? await connection.homePath().catch(() => null) : null;
    if (home && destination === home.replace(/\/+$/, '')) {
      throw new Error(`refusing to replace the remote home directory ${destination}`);
    }
    backup = `${destination}.presence-replaced-${process.pid}-${Date.now()}`;
    try {
      await sftpCall(connection, 'rename', destination, backup);
    } catch (error) {
      throw new Error(`cannot replace ${destination}: ${error?.message ?? String(error)}`);
    }
  }
  try {
    const result = await runExec(connection, `cp -a -- ${shq(source)} ${shq(destination)}`, COPY_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`could not copy ${source} to ${destination}: ${execDetail(result)}`);
  } catch (error) {
    if (backup) {
      await sftpCall(connection, 'rename', backup, destination).catch(() => {});
    }
    throw error;
  }
  if (backup) {
    await connection.exec(`rm -rf -- ${shq(backup)}`, { timeoutMs: COPY_TIMEOUT_MS }).catch(() => {});
  }
  const measured = await measureTree(connection, destination);
  return {
    from: source,
    to: destination,
    ...(measured.bytes === undefined ? {} : { bytes: measured.bytes }),
    ...(measured.files === undefined ? {} : { files: measured.files }),
  };
}

/**
 * Change one remote path's mode (an octal number or "755"/"0644" string).
 * With `recursive:true` a directory is changed with a remote `chmod -R`.
 *
 * @returns {Promise<{path: string, mode: string}>} the applied octal mode.
 */
export async function chmodPath(connection, target, mode, { recursive = false } = {}) {
  const path = requirePath(target, 'path');
  if (path === '/') throw new Error('refusing to chmod /');
  const value = parseModeValue(mode);
  const info = await pathInfo(connection, path);
  if (!info.exists) throw new Error(`cannot chmod ${path}: it does not exist`);

  if (recursive && info.isDir) {
    const result = await runExec(connection, `chmod -R ${value.toString(8)} -- ${shq(path)}`, EXEC_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`could not chmod -R ${path}: ${execDetail(result)}`);
  } else {
    try {
      await connection.chmod(path, value);
    } catch (error) {
      throw new Error(`could not chmod ${path}: ${error?.message ?? String(error)}`);
    }
  }

  const after = await connection.stat(path).catch(() => null);
  const applied = after && after.exists && typeof after.mode === 'number' ? after.mode : value;
  return { path, mode: modeString(applied) ?? modeString(value) };
}
