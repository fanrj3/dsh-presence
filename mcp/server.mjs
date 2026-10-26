#!/usr/bin/env node
// stdio entry point: `node mcp/server.mjs` (or the `presence-mcp` bin).
//
// Diagnostics (safe to run by hand, they never speak the protocol):
//   node mcp/server.mjs --version
//   node mcp/server.mjs --check     print env/host/tool summary as JSON, exit 0
//   node mcp/server.mjs --help

import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from './app.mjs';
import { TOOL_NAMES } from './tools.mjs';
import { knownHosts, settings } from './lib/core.mjs';

const HELP = `presence-mcp ${VERSION}

Usage:
  presence-mcp                   stdio MCP server (for Codex / Claude Code / OpenCode / Cursor ...)
  presence-mcp --check           print environment, hosts and tool count as JSON, then exit
  presence-mcp --version         print version
  presence-mcp --help            this text

  From a source checkout use "node mcp/server.mjs" with the same flags.

Environment:
  PRESENCE_HOST                  default ssh alias when a tool call omits "host"
  PRESENCE_WORKSPACE             host:/abs/path - default host and root for relative paths
  PRESENCE_CWD                   /abs/path - root for relative paths when no workspace is set
  PRESENCE_READ_ONLY=1           refuse write / edit / import / trash restore
  PRESENCE_PASSWORD_<ALIAS>      SSH password for one host (alias uppercased, non-alnum -> _)
  PRESENCE_MAX_CHANNELS          per-connection channel limit (default 8)
  PRESENCE_CONNECT_TIMEOUT_MS    connect timeout (default 25000)
  PRESENCE_IDLE_TIMEOUT_MS       idle disconnect (default 900000)

Logs go to stderr; stdout is the JSON-RPC channel.`;

export async function start() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`presence-mcp ${VERSION} ready on stdio (${TOOL_NAMES.length} tools)`);
  // A real client keeps stdin open for the session; when EOF arrives we still
  // give in-flight tool calls a grace period (file-redirect tests, stdin hijack).
  const graceMs = Number(process.env.PRESENCE_SHUTDOWN_GRACE_MS ?? 150);
  const shutdown = (code = 0) => {
    server.close().catch(() => {});
    setTimeout(() => process.exit(code), Number.isFinite(graceMs) ? Math.max(0, graceMs) : 150);
  };
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
}

function check() {
  const hosts = knownHosts();
  const summary = {
    server: 'presence-mcp',
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cwd: process.cwd(),
    tools: TOOL_NAMES.length,
    toolNames: TOOL_NAMES,
    env: {
      defaultHost: settings.defaultHost,
      workspace: settings.workspace,
      defaultCwd: settings.defaultCwd,
      readOnly: settings.readOnly,
      maxChannels: settings.maxChannels,
    },
    hosts: hosts.map((entry) => ({
      alias: entry.alias,
      address: `${entry.user ?? '?'}@${entry.hostname}:${entry.port}`,
      source: entry.source,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return Promise.resolve(0);
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return Promise.resolve(0);
  }
  if (argv.includes('--check')) {
    try {
      return Promise.resolve(check());
    } catch (error) {
      console.error('check failed:', error?.message ?? error);
      return Promise.resolve(1);
    }
  }
  return start()
    .then(() => null)
    .catch((error) => {
      console.error('presence-mcp failed to start:', error?.stack ?? error);
      return 1;
    });
}

const isEntry = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== null) process.exit(code ?? 0);
  });
}
