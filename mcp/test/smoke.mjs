// Protocol smoke test with the in-memory transport (no child process, so it
// runs inside sandboxes that block spawn-with-pipes).
//
//   node mcp/test/smoke.mjs
//
// Verifies: initialize, tools/list (20 tools), presence_list_hosts against the
// real ~/.ssh/config (no network), and schema presence for every tool.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../app.mjs';
import { TOOL_NAMES } from '../tools.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 'presence-smoke', version: '0.0.0' });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const info = client.getServerVersion?.() ?? null;
  check('initialize 成功', Boolean(info?.name === 'presence'), info ? `${info.name}@${info.version}` : 'no server info');

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const missing = TOOL_NAMES.filter((name) => !names.includes(name));
  check(`tools/list 返回 ${TOOL_NAMES.length} 个工具`, names.length === TOOL_NAMES.length && missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : names.join(', '));

  const withSchema = tools.filter((tool) => tool.inputSchema && typeof tool.inputSchema === 'object');
  check('每个工具都有 inputSchema', withSchema.length === tools.length, `${withSchema.length}/${tools.length}`);

  const hosts = await client.callTool({ name: 'presence_list_hosts', arguments: {} });
  const hostText = hosts.content?.[0]?.text ?? '';
  check('presence_list_hosts 可调用', hosts.isError !== true && /alias/u.test(hostText), hostText.split('\n')[0]);
  check('主机列表含真实主机', /server|sub2api|server1/u.test(hostText), hostText.split('\n').slice(1, 3).join(' | '));

  const status = await client.callTool({ name: 'presence_status', arguments: {} });
  let statusBody = null;
  try { statusBody = JSON.parse(status.content?.[0]?.text ?? 'null'); } catch { statusBody = null; }
  check('presence_status 返回有效 JSON', status.isError !== true && statusBody?.server === 'presence-mcp' &&
    Array.isArray(statusBody?.hosts) && typeof statusBody?.uptimeMs === 'number' && statusBody.uptimeMs >= 0 &&
    typeof statusBody?.node === 'string' && /^v\d+/u.test(statusBody.node),
    statusBody ? `tools=${statusBody.tools ?? '?'} hosts=${statusBody.hosts.length} node=${statusBody.node} uptimeMs=${statusBody.uptimeMs}` : 'invalid JSON');

  const readTool = tools.find((tool) => tool.name === 'presence_read');
  const execTool = tools.find((tool) => tool.name === 'presence_exec');
  check('只读工具有 readOnlyHint', readTool?.annotations?.readOnlyHint === true, JSON.stringify(readTool?.annotations ?? null));
  check('exec 有 destructiveHint', execTool?.annotations?.destructiveHint === true, JSON.stringify(execTool?.annotations ?? null));

  const bad = await client.callTool({ name: 'presence_connect', arguments: { host: 'definitely-not-a-host' } });
  const badText = bad.content?.[0]?.text ?? '';
  check('未知主机返回可读错误 + 提示', bad.isError === true && /no host/u.test(badText) && /hint:/u.test(badText), badText.slice(0, 140));
} catch (error) {
  check('smoke run', false, error?.stack ?? String(error));
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
