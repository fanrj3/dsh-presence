// Process-wide hand-off between the plugin half (which owns the connections)
// and the filesystem backend (which is constructed as its own Cordis service).

export const shared = {
  /** The live connection pool, or null while the plugin is not loaded. */
  pool: null,
  /**
   * Local directory whose subtree stands for remote paths:
   * `<mountsRoot>/<host>/<absolute remote path>`. The directory exists on disk so
   * the workspace registry's `node:fs` realpath check passes; the fs provider
   * maps everything under it back to the remote machine.
   */
  mountsRoot: null,
};
