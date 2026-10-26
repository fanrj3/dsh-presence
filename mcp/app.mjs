// Server factory: transport-independent so the in-memory smoke test can use it.
// Log to stderr only — stdout carries JSON-RPC.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.mjs';

export const VERSION = '0.2.3';

const INSTRUCTIONS = `Presence exposes remote machines from ~/.ssh/config as if they were local.

Start with presence_list_hosts, then presence_connect. Every other tool reuses the same persistent
SSH connection (no per-call handshake, nothing installed on the remote side).

Conventions:
- Paths: absolute (/srv/app/x), home-relative (~/x), presence://host/abs, or relative to
  PRESENCE_WORKSPACE (env "host:/abs/path") / PRESENCE_CWD.
- Exec defaults to that workspace directory; pass cwd for another directory.
- Destructive commands (rm -r, git clean, find -delete, truncate) are dry-run until confirm=true.
- Long-running servers: presence_exec background=true, then presence_jobs wait/stop.
- Verify a service with presence_http_probe (forward + GET + assertions + cleanup in one call);
  check listeners with presence_port_probe and file metadata/hashes with presence_stat.
- Pass format="json" for machine-readable results instead of parsing the text tables.
- Prefer presence_trash over rm -rf; it is recoverable on the remote side.
- Detached jobs and terminals outlive this MCP process: stop them when done.`;

export function createServer() {
  const server = new McpServer(
    { name: 'presence', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}
