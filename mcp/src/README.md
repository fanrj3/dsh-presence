# Vendored Presence kernel

This directory is a **verbatim copy** of the plugin kernel from the repository's
`src/` tree (`src/pool.js`, `src/core/connection.mjs`, ...), vendored so that the
published `presence-mcp` package is self-contained and does not need the plugin
checkout next to it.

- Do not edit these files by hand. Change the plugin source and re-run
  `node scripts/sync-kernel.mjs` from `mcp/`.
- `npm pack` / `npm publish` run `node scripts/sync-kernel.mjs --check`, which
  fails when this copy drifted from the plugin source.
- The relative layout is preserved (`src/core/...`, `src/...`) so the kernel's own
  relative imports keep working unchanged.
