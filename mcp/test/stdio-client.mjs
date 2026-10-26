// Real stdio round-trip: spawns `node mcp/server.mjs` and talks MCP over pipes.
// Run this where child-process pipes are allowed (normal shell, NOT inside the
// DSH sandbox):
//
//   node mcp/test/stdio-client.mjs
//
// It is the closest thing to what Codex / Claude Code / OpenCode do when they
// start the server.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')],
  env: { ...process.env, PRESENCE_HOST: process.env.PRESENCE_HOST ?? 'server' },
  stderr: 'inherit',
});
const client = new Client({ name: 'presence-stdio-smoke', version: '0.0.0' });

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  const started = Date.now();
  await client.connect(transport);
  check('stdio initialize', true, `${Date.now() - started} ms`);

  const { tools } = await client.listTools();
  check('tools/list over stdio', tools.length >= 15, `${tools.length} tools`);

  const hosts = await client.callTool({ name: 'presence_list_hosts', arguments: {} });
  const hostText = hosts.content?.[0]?.text ?? '';
  check('presence_list_hosts over stdio', hosts.isError !== true && /alias/u.test(hostText), hostText.split('\n')[1] ?? '');

  const status = await client.callTool({ name: 'presence_status', arguments: {} });
  check('presence_status over stdio', status.isError !== true && status.content?.[0]?.text?.includes('presence-mcp'));
} catch (error) {
  check('stdio client run', false, error?.stack ?? String(error));
} finally {
  await client.close().catch(() => {});
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
