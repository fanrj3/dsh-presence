// Regression: a dead SSH client must never crash the process through a port
// forward, and forwards must be closed when their connection goes away.
//
//   node scripts/tunnel-crash-probe.mjs
//
// No network: a fake ssh2 client whose forwardOut throws synchronously (what
// ssh2 1.17 does when the client is not connected) reproduces the crash that
// killed the DSH host (`Not connected` at client.js:1400).

import net from 'node:net';

import { PresenceConnection } from '../src/core/connection.mjs';
import { PresencePool } from '../src/pool.js';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

function fakeClient({ forwardThrows = true } = {}) {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    end() {},
    forwardOut() {
      if (forwardThrows) throw new Error('Not connected');
    },
  };
}

// ---- 1. synchronous throw inside the local listener must be swallowed
const uncaught = [];
const onUncaught = (error) => uncaught.push(error);
process.on('uncaughtException', onUncaught);

const client = fakeClient();
const connection = new PresenceConnection(client, { alias: 'fake-host', maxChannels: 2 }, '');
let tunnel = null;
try {
  tunnel = await connection.tunnel({ remotePort: 8080 });
  check('tunnel() 本地监听就绪', Number.isInteger(tunnel.localPort) && tunnel.localPort > 0, `127.0.0.1:${tunnel.localPort}`);

  await new Promise((resolve) => {
    const probe = net.connect(tunnel.localPort, '127.0.0.1');
    probe.once('connect', () => { probe.destroy(); resolve(); });
    probe.once('error', () => resolve());
  });
  await sleep(150);
  check('客户端不可用时本地连接不会崩进程', uncaught.length === 0, uncaught.map((e) => e.message).join('; ') || '0 uncaught');

  // ---- 2. ssh client close closes every tunnel of that connection
  client.handlers.get('close')?.();
  await sleep(120);
  check('SSH 断开后隧道被关闭', await portRefused(tunnel.localPort), `port ${tunnel.localPort} refused`);
} finally {
  await tunnel?.close().catch(() => {});
  process.removeListener('uncaughtException', onUncaught);
}

// ---- 3. pool.disconnect(host) closes that host's forwards
const pool = new PresencePool({ maxChannels: 2, connectTimeoutMs: 25_000, idleTimeoutMs: 900_000, readOnly: false });
const closed = [];
const fakeTunnel = {
  host: 'fake-host',
  localPort: 4242,
  remoteHost: '127.0.0.1',
  remotePort: 8080,
  close: async () => { closed.push('closed'); },
};
const fakeConnection = {
  probePort: async () => ({ checked: true, target: '127.0.0.1:8080' }),
  tunnel: async () => fakeTunnel,
  end() {},
};
pool.connection = async () => fakeConnection;
const opened = await pool.openTunnel('fake-host', { remotePort: 8080 });
check('pool 记录转发', pool.listTunnels().some((item) => item.id === opened.id));
await pool.disconnect('fake-host');
check('disconnect(host) 关闭该 host 的转发', closed.length === 1 && pool.listTunnels().length === 0, `${closed.length} close(s), ${pool.listTunnels().length} left`);
pool.dispose();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
