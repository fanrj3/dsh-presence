// Make a remote folder a first-class filesystem location.
//
// This backend answers `presence://<alias>/<absolute-path>` and delegates every
// other path to the shipped sandboxed local provider, so the rest of the
// harness — workspaces, the file tree, read/write/edit/grep — keeps working
// exactly as before for local files and reaches the remote machine otherwise.

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs';
import { shared } from './shared.js';
import { debugLog } from './debug.js';
import { listHosts } from './core/ssh-config.mjs';
import { mountPathFor, parseMountPath, resolveRemoteInput } from './mounts.js';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const SCHEME = 'presence://';
const READ_CAP = 32 * 1024 * 1024;
const WATCH_INTERVAL_MS = 2000;

const TEXT_ERRORS = { notText: 'FS_NOT_TEXT', notFound: 'FS_NOT_FOUND' };

/** POSIX single-quote escaping for remote shell commands. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Canonical remote path with symlinks resolved (`realpath -m` never fails on a
 * missing leaf). Returns null when the machine cannot answer, so callers fall
 * back to the lexical path instead of denying legitimate writes.
 */
async function realRemotePath(connection, path) {
  const result = await connection.exec(`realpath -m -- ${shellQuote(path)}`, { timeoutMs: 15_000 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const real = result.stdout.trim();
  return real.startsWith('/') ? real : null;
}

function isPresencePath(path) {
  return typeof path === 'string' && path.startsWith(SCHEME);
}

function isPresenceTarget(target) {
  return isPresencePath(target?.targetKey);
}

/** Lexical POSIX normalization: `..` may not climb above the remote root. */
function normalizePath(path) {
  const parts = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parse(url) {
  const rest = url.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '/' : normalizePath(rest.slice(slash));
  return { host, path, url: `${SCHEME}${host}${path}` };
}

function joinPath(base, path) {
  return normalizePath(`${base}/${path}`);
}

function toTarget(url) {
  const parsed = parse(url);
  return { targetKey: parsed.url, displayPath: parsed.url };
}

function presentError(error, action, displayPath) {
  if (error instanceof FsError) return error;
  const message = error?.message ?? String(error);
  if (/no such file|not exist|ENOENT/i.test(message)) {
    return new FsError(`cannot ${action} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error });
  }
  return new FsError(`cannot ${action} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error });
}

export default class PresenceFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy'];

  connectionFor(host, displayPath, action) {
    const pool = shared.pool;
    if (!pool) {
      throw new FsError(`cannot ${action} "${displayPath}": Presence is not active`, 'FS_IO_ERROR');
    }
    return Promise.resolve(pool.connection(host)).catch((error) => {
      debugLog('connection', `${action} ${displayPath} host=${host} :: ${error?.message}\n${new Error().stack}`);
      throw presentError(error, action, displayPath);
    });
  }

  versionOfInfo(info) {
    return FsVersion(`presence:${info.mtime}:${info.size}:${info.isDir ? 'd' : 'f'}`);
  }

  // ------------------------------------------------------------- identity

  async resolve(path, opts) {
    const cwd = opts?.cwd ?? this.config.cwd;
    const result = this.resolveSync(path, cwd, opts);
    if (isPresenceTarget(result) && !this.knownHosts().has(parse(String(result.targetKey)).host)) {
      debugLog('bad-resolve', `path=${JSON.stringify(path)} cwd=${JSON.stringify(cwd)} -> ${result.targetKey}\n${new Error().stack}`);
    }
    return result;
  }

  resolveSync(path, cwd, opts) {
    // One resolver for every spelling: presence URL, mount path, POSIX absolute
    // inside a remote session, or a workspace-relative path. A local absolute
    // path (e.g. C:\...) stays local and falls through to the shipped backend.
    const remote = resolveRemoteInput(cwd, path);
    if (remote) return toTarget(`${SCHEME}${remote.host}${remote.path}`);
    return super.resolve(path, opts);
  }

  /** Record a presence URL whose host is not an ssh alias — almost always a mangled path. */
  audit(url, where) {
    const { host } = parse(url);
    if (this.knownHosts().has(host)) return;
    debugLog('bad-url', `${where} url=${url} host=${host}\n${new Error().stack}`);
  }

  knownHosts() {
    if (!this.hostCache || Date.now() - this.hostCache.at > 10_000) {
      let aliases = new Set();
      try {
        aliases = new Set(listHosts().map((entry) => entry.alias));
      } catch {
        /* keep empty */
      }
      this.hostCache = { at: Date.now(), aliases };
    }
    return this.hostCache.aliases;
  }

  processPath(target) {
    if (isPresenceTarget(target)) {
      // Consumers treat this as a host path: they join `.git`, store it as a
      // session cwd, hand it to child processes. Returning the `presence://`
      // URL here mangles every one of those, so give back the local mount
      // marker — `resolve()` maps it straight back to the remote path.
      const { host, path } = parse(target.targetKey);
      try {
        return mountPathFor(host, path);
      } catch {
        return target.targetKey;
      }
    }
    return super.processPath(target);
  }

  processPathFromHostPath(hostPath) {
    return super.processPathFromHostPath(hostPath);
  }

  fileUrl(target) {
    if (isPresenceTarget(target)) return pathToFileURL(this.processPath(target)).href;
    return super.fileUrl(target);
  }

  contains(parent, child) {
    if (isPresenceTarget(parent) && isPresenceTarget(child)) {
      const left = String(parent.targetKey);
      const right = String(child.targetKey);
      return right === left || right.startsWith(left.endsWith('/') ? left : `${left}/`);
    }
    return super.contains(parent, child);
  }

  // ------------------------------------------------------------ metadata

  async stat(target, signal) {
    if (!isPresenceTarget(target)) return super.stat(target, signal);
    signal?.throwIfAborted?.();
    const { host, path } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'stat');
    const info = await connection.stat(path).catch((error) => {
      throw presentError(error, 'stat', target.displayPath);
    });
    if (!info.exists) return undefined;
    return { version: this.versionOfInfo(info), type: info.isDir ? 'directory' : 'file', size: info.size };
  }

  async lstat(path, opts, signal) {
    const cwd = opts?.cwd ?? this.config.cwd;
    // Route every remote spelling, not just `presence://`: the workspace-file
    // API lists/inspects a remote workspace using its MOUNT path, which used to
    // fall through to the empty local marker directory and report not-found.
    const remote = resolveRemoteInput(cwd, path);
    if (!remote) return super.lstat(path, opts, signal);
    const target = toTarget(`${SCHEME}${remote.host}${remote.path}`);
    return this.stat(target, signal);
  }

  // -------------------------------------------------------------- reading

  async readText(target, signal) {
    if (!isPresenceTarget(target)) return super.readText(target, signal);
    const { host, path } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'read');
    const info = await connection.stat(path).catch((error) => {
      throw presentError(error, 'read', target.displayPath);
    });
    if (!info.exists) throw new FsError(`cannot read "${target.displayPath}": not found`, TEXT_ERRORS.notFound);
    if (info.isDir) throw new FsError(`cannot read "${target.displayPath}": is a directory`, 'FS_NOT_REGULAR_FILE');
    if (info.size > READ_CAP) {
      // Never hand back a silently truncated file: the tool layer's line counts
      // would be wrong. Say what to do instead.
      throw new FsError(
        `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${READ_CAP}-byte limit — ` +
          'use presence_read with offset/limit, or presence_exec (head/tail/sed) for large remote files',
        'FS_TOO_LARGE',
      );
    }
    const { content } = await connection
      .readText(path, { length: READ_CAP })
      .catch((error) => {
        throw presentError(error, 'read', target.displayPath);
      });
    if (content.includes('\u0000')) throw new FsError(`cannot read "${target.displayPath}": binary file`, TEXT_ERRORS.notText);
    return content;
  }

  streamText(target, signal) {
    if (!isPresenceTarget(target)) return super.streamText(target, signal);
    const self = this;
    const { host, path } = parse(target.targetKey);
    return (async function* stream() {
      signal?.throwIfAborted?.();
      const connection = await self.connectionFor(host, target.displayPath, 'read');
      // Stream to EOF instead of loading a capped prefix: the read tool counts
      // lines from this stream, and a silent cap makes its totals wrong (a 573 MB
      // CSV was reported as 78k lines instead of 1.35M). UTF-8 boundaries are
      // preserved by decoding through a StringDecoder.
      const decoder = new StringDecoder('utf8');
      const step = 1024 * 1024;
      for (let offset = 0; ; offset += step) {
        signal?.throwIfAborted?.();
        const { buffer } = await connection.readBytes(path, { offset, length: step });
        if (!buffer || buffer.length === 0) break;
        const text = decoder.write(buffer);
        if (text) yield text;
        if (buffer.length < step) break;
      }
      const tail = decoder.end();
      if (tail) yield tail;
    })();
  }

  async readBytes(target, signal, maxBytes) {
    if (!isPresenceTarget(target)) return super.readBytes(target, signal, maxBytes);
    const info = await this.stat(target, signal);
    if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND');
    if (info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE');
    }
    return this.readWindow(target, { offset: 0, length: maxBytes });
  }

  async readByteRange(target, range, signal) {
    if (!isPresenceTarget(target)) return super.readByteRange(target, range, signal);
    return this.readWindow(target, range);
  }

  async readWindow(target, range) {
    const { host, path } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'read');
    const { buffer } = await connection
      .readBytes(path, { offset: range.offset ?? 0, length: range.length })
      .catch((error) => {
        throw presentError(error, 'read', target.displayPath);
      });
    return buffer;
  }

  async listDir(target, signal) {
    if (!isPresenceTarget(target)) return super.listDir(target, signal);
    const { host, path } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'list');
    const info = await connection.stat(path).catch((error) => {
      throw presentError(error, 'list', target.displayPath);
    });
    if (!info.exists) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND');
    if (!info.isDir) throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY');
    const entries = await connection.list(path).catch((error) => {
      throw presentError(error, 'list', target.displayPath);
    });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.kind === 'dir' ? 'directory' : entry.kind === 'link' ? 'symlink' : 'file',
      target: toTarget(`${SCHEME}${host}${joinPath(path, entry.name)}`),
      version: FsVersion(`presence:${entry.mtime}:${entry.size}:${entry.kind === 'dir' ? 'd' : 'f'}`),
      size: entry.size,
    }));
  }

  // ------------------------------------------------------------- mutation

  /**
   * Preserve the sandbox's intent for remote writes: read-only refuses, and a
   * workspace-write session may only write inside the workspace the user
   * created. `danger-full-access` passes.
   *
   * Containment is checked twice: the spelled path must be inside the session
   * workspace, and so must its REMOTE realpath. Without the second check a
   * symlink inside the workspace (`ln -s /srv/workspace tentlink`) would let a write
   * escape the sandbox.
   */
  async fenceFor(target, sandboxPolicy, connection) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy?.resolve?.();
    const mode = policy?.mode;
    if (mode === 'danger-full-access') return;
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED');
    }
    // workspace-write: the writable boundary is the SESSION's own workspace root
    // (the policy carries it), not whichever workspace was opened last.
    const sessionRoot = policy?.workspaceRoot ?? null;
    const mounted = sessionRoot ? parseMountPath(sessionRoot) : null;
    const parsed = parse(String(target.targetKey));
    const root = mounted ? normalizePath(mounted.path).replace(/\/+$/, '') : null;
    const key = normalizePath(parsed.path).replace(/\/+$/, '');
    const contained =
      Boolean(root) && parsed.host === mounted.host && (root === '' || key === root || key.startsWith(`${root}/`));
    if (!contained) {
      throw new FsError(
        `cannot write "${target.displayPath}": outside this session's workspace (${sessionRoot ?? 'none'}) under workspace-write mode`,
        'FS_SANDBOX_DENIED',
      );
    }

    const real = await realRemotePath(connection, parsed.path).catch(() => null);
    if (real && real !== key) {
      const realContained = root === '' || real === root || real.startsWith(`${root}/`);
      if (!realContained) {
        throw new FsError(
          `cannot write "${target.displayPath}": it is a symlink resolving to ${real}, outside this session's workspace`,
          'FS_SANDBOX_DENIED',
        );
      }
    }
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    if (!isPresenceTarget(target)) return super.writeText(target, content, expected, signal, sandboxPolicy);
    const { host, path } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'write');
    await this.fenceFor(target, sandboxPolicy, connection);
    return this.withLock(target.targetKey, async () => {
      const existing = await this.stat(target, signal);
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION');
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      const before = existing ? await this.readText(target, signal) : null;
      // The shipped local backend also refuses to create missing parents; the
      // tool layer creates them for the model, but a direct ctx.fs write should
      // not fail with a bare ENOENT either.
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent && !existing) {
        await connection.exec(`mkdir -p ${shellQuote(parent)}`, { timeoutMs: 30_000 }).catch(() => {});
      }
      await connection.writeText(path, content).catch((error) => {
        throw presentError(error, 'write', target.displayPath);
      });
      const after = await this.stat(target, signal);
      return {
        operation: existing ? 'update' : 'create',
        version: after?.version ?? FsVersion(`missing:${target.targetKey}`),
        before,
        after: content,
      };
    });
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    if (!isPresenceTarget(target)) return super.editText(target, edit, expected, signal, sandboxPolicy);
    const { host } = parse(target.targetKey);
    const connection = await this.connectionFor(host, target.displayPath, 'write');
    await this.fenceFor(target, sandboxPolicy, connection);
    return this.withLock(target.targetKey, async () => {
      const existing = await this.stat(target, signal);
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file not found`, 'FS_NOT_FOUND');
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
      }
      const original = await this.readText(target, signal);
      const occurrences = original.split(edit.oldString).length - 1;
      if (occurrences === 0) {
        throw new FsError(`cannot edit "${target.displayPath}": oldString was not found`, 'FS_EDIT_NOT_FOUND');
      }
      if (occurrences > 1 && !edit.replaceAll) {
        throw new FsError(`cannot edit "${target.displayPath}": oldString appears ${occurrences} times`, 'FS_AMBIGUOUS_EDIT');
      }
      const updated = edit.replaceAll ? original.split(edit.oldString).join(edit.newString) : original.replace(edit.oldString, edit.newString);
      const { host, path } = parse(target.targetKey);
      const connection = await this.connectionFor(host, target.displayPath, 'edit');
      await connection.writeText(path, updated).catch((error) => {
        throw presentError(error, 'edit', target.displayPath);
      });
      const after = await this.stat(target, signal);
      return { version: after?.version ?? FsVersion(`missing:${target.targetKey}`), before: original, after: updated };
    });
  }

  // -------------------------------------------------------------- watching

  async watch(target, changed, signal) {
    if (!isPresenceTarget(target)) return super.watch(target, changed, signal);
    signal?.throwIfAborted?.();
    let last;
    try {
      last = (await this.stat(target, signal))?.version;
    } catch {
      last = undefined;
    }
    const timer = setInterval(() => {
      this.stat(target)
        .then((info) => {
          const version = info?.version;
          if (version !== last) {
            last = version;
            changed();
          }
        })
        .catch((error) => changed(error instanceof Error ? error : new Error(String(error))));
    }, WATCH_INTERVAL_MS);
    timer.unref?.();
    return async () => clearInterval(timer);
  }
}
