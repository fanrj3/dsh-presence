// Remote listening-port discovery for the Ports panel.
//
// The far side needs no agent: a single `ss` (or `netstat`) run through the
// existing exec channel lists what is listening. Results are cached for a few
// seconds because the client polls, and errors are quarantined for the same
// window so an unreachable machine is asked once, not once per poll.
//
// Beyond the raw list, the panel wants two things this module keeps:
//   - `firstSeen` per port, so a port is only "new" the first scan that saw it;
//   - `forwarded`, derived from the pool's live tunnels so the chip state is
//     always the truth even when this cache is stale.

const SCAN_TTL_MS = 5_000;
const ERROR_TTL_MS = 5_000;
const IDLE_EXPIRY_MS = 60_000;
const MAX_FIRST_SEEN = 5_000;
const SCAN_TIMEOUT_MS = 10_000;

/** Split `addr:port`, `[::1]:22` or `*:8080`; null when the field is not one. */
function splitAddressPort(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const colon = text.lastIndexOf(':');
  if (colon < 0) return null;
  const port = Number(text.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let address = text.slice(0, colon);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address === '') address = '*';
  return { address, port };
}

/** Process name/pid out of an `ss -p` `users:(("name",pid=N,fd=M))` tail. */
function processInfo(line) {
  const users = /users:\(\("([^"]+)",pid=(\d+)/u.exec(line);
  if (users) return { pid: Number(users[2]), process: users[1] };
  // `netstat -p` spells the same thing as a trailing `pid/name`.
  const netstat = /(?:^|\s)(\d+)\/([^\s/]+)\s*$/u.exec(line);
  if (netstat) return { pid: Number(netstat[1]), process: netstat[2] };
  return { pid: null, process: null };
}

/**
 * Parse `ss -ltn` / `ss -ltnp` / `netstat -ltn` output into unique listening
 * ports. Columns are `[Proto] State Recv-Q Send-Q Local:Port Peer:Port ...`;
 * `ss` puts LISTEN in the first column while `netstat` puts it last, so both
 * spellings are accepted. One entry per port: a service bound on both `0.0.0.0`
 * and `[::]` is one forwardable port.
 *
 * @returns {{ ports: Array<{port:number,address:string,pid:number|null,process:string|null}>, hasProcessInfo: boolean }}
 */
export function parseSsOutput(text) {
  const ports = [];
  const seen = new Set();
  let hasProcessInfo = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:State|Proto)\s/iu.test(line)) continue;
    if (/^Active Internet connections/iu.test(line)) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 4) continue;
    const first = fields[0].toUpperCase();
    const last = fields[fields.length - 1].toUpperCase();
    if (!first.startsWith('LISTEN') && last !== 'LISTEN' && last !== 'LISTENING') continue;
    // Local address:Port lives in column 4 for both tools; tolerate a variant
    // layout by trying the neighbouring columns before giving up.
    let local = splitAddressPort(fields[3]);
    if (!local) {
      for (const index of [2, 4, 5]) {
        local = splitAddressPort(fields[index]);
        if (local) break;
      }
    }
    if (!local) continue;
    const info = processInfo(line);
    if (info.process !== null) hasProcessInfo = true;
    if (seen.has(local.port)) continue;
    seen.add(local.port);
    ports.push({ port: local.port, address: local.address, pid: info.pid, process: info.process });
  }
  ports.sort((left, right) => left.port - right.port);
  return { ports, hasProcessInfo };
}

/**
 * One remote scan: ask `ss -ltnp` (process names included where the kernel
 * allows), fall back to `ss -ltn`, then to `netstat -ltn`. The first answer
 * that parses wins; a host with none of the tools throws the last failure.
 */
async function scanRemote(connection) {
  const attempts = [
    'ss -ltnp 2>/dev/null',
    'ss -ltn 2>/dev/null',
    'netstat -ltnp 2>/dev/null',
    'netstat -ltn 2>/dev/null',
  ];
  let lastError = null;
  for (const command of attempts) {
    let result;
    try {
      result = await connection.exec(command, { timeoutMs: SCAN_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      continue;
    }
    const parsed = parseSsOutput(result?.stdout ?? '');
    // `ss -p` can come back empty for a non-root user on some builds; the plain
    // forms still list the ports, so keep going only while nothing parsed.
    if (parsed.ports.length > 0) return parsed.ports;
  }
  if (lastError) throw lastError;
  throw new Error('could not read listening ports (no usable ss/netstat output on the host)');
}

/**
 * Per-host cache in front of `scanRemote`. The pool is only used for its
 * connection channel and its live tunnel list; this class keeps no SSH state.
 */
export class PortDiscovery {
  #pool;
  #enabled;
  #cache = new Map();
  #errors = new Map();
  #lastQueried = new Map();
  #firstSeen = new Map();
  // Ports a just-opened tunnel mentioned, only trusted until the next fresh
  // scan: the live pool list stays authoritative.
  #forwardedOverrides = new Map();
  #inflight = new Map();

  constructor(pool, { enabled = true } = {}) {
    this.#pool = pool;
    this.#enabled = enabled;
  }

  get enabled() {
    return this.#enabled;
  }

  /** Ports the pool has a live tunnel for on this host. The authoritative set. */
  #forwardedPorts(host) {
    const ports = new Set();
    try {
      for (const tunnel of this.#pool.listTunnels()) {
        if (tunnel.host === host && Number.isInteger(tunnel.remotePort)) ports.add(tunnel.remotePort);
      }
    } catch {
      /* the tunnel list is a display nicety; never fail a scan for it */
    }
    return ports;
  }

  #decorate(host, ports, { overrides = false } = {}) {
    const forwarded = this.#forwardedPorts(host);
    if (overrides) {
      const remembered = this.#forwardedOverrides.get(host);
      if (remembered) {
        const now = Date.now();
        for (const [port, at] of remembered) {
          if (now - at > SCAN_TTL_MS) remembered.delete(port);
          else forwarded.add(port);
        }
        if (remembered.size === 0) this.#forwardedOverrides.delete(host);
      }
    }
    const firstSeen = this.#firstSeen.get(host) ?? new Map();
    return ports.map((entry) => ({
      port: entry.port,
      address: entry.address,
      pid: entry.pid ?? null,
      process: entry.process ?? null,
      firstSeen: firstSeen.get(entry.port) ?? Date.now(),
      forwarded: forwarded.has(entry.port),
    }));
  }

  /**
   * List listening ports on one host.
   * @param host - ssh alias.
   * @param options.force - bypass the short cache (the client's refresh button).
   * @returns `{ host, ports, new }`; `new` holds the ports seen for the first time.
   */
  async scan(host, { force = false } = {}) {
    const alias = String(host ?? '').trim();
    if (!alias) throw new Error('host is required');
    if (!this.#enabled) return { host: alias, ports: [], new: [], disabled: true };

    const now = Date.now();
    const lastQuery = this.#lastQueried.get(alias) ?? 0;
    this.#lastQueried.set(alias, now);
    // Asked once and then left alone for a minute: drop the result so the next
    // visit starts clean instead of serving a lookup from minutes ago.
    if (!force && now - lastQuery > IDLE_EXPIRY_MS) this.#cache.delete(alias);

    const cached = this.#cache.get(alias);
    if (!force && cached && now - cached.at < SCAN_TTL_MS) {
      return { host: alias, ports: this.#decorate(alias, cached.ports, { overrides: true }), new: [] };
    }

    const failure = this.#errors.get(alias);
    if (!force && failure && now - failure.at < ERROR_TTL_MS) throw failure.error;

    const pending = this.#inflight.get(alias);
    if (pending) {
      // A scan for this host is already in flight: share it instead of asking
      // the machine twice for the same answer.
      const { ports, fresh } = await pending;
      return {
        host: alias,
        ports: this.#decorate(alias, ports),
        new: this.#decorate(alias, ports.filter((entry) => fresh.includes(entry.port))),
      };
    }

    const operation = (async () => {
      const connection = await this.#pool.connection(alias);
      const ports = await scanRemote(connection);
      const firstSeen = this.#firstSeen.get(alias) ?? new Map();
      if (!this.#firstSeen.has(alias)) this.#firstSeen.set(alias, firstSeen);
      const fresh = [];
      for (const entry of ports) {
        if (!firstSeen.has(entry.port)) {
          firstSeen.set(entry.port, now);
          fresh.push(entry.port);
        }
      }
      // First-seen history is only a toast dedupe; bound it on a long-lived app.
      if (firstSeen.size > MAX_FIRST_SEEN) {
        const keep = [...firstSeen.entries()].sort((left, right) => right[1] - left[1]).slice(0, MAX_FIRST_SEEN);
        this.#firstSeen.set(alias, new Map(keep));
      }
      this.#cache.set(alias, { at: Date.now(), ports, fresh });
      this.#errors.delete(alias);
      return { ports, fresh };
    })();

    this.#inflight.set(alias, operation);
    try {
      const { ports, fresh } = await operation;
      // A fresh scan is authoritative; anything remembered before it is stale.
      this.#forwardedOverrides.delete(alias);
      return {
        host: alias,
        ports: this.#decorate(alias, ports),
        new: this.#decorate(alias, ports.filter((entry) => fresh.includes(entry.port))),
      };
    } catch (error) {
      this.#errors.set(alias, { at: Date.now(), error });
      throw error;
    } finally {
      if (this.#inflight.get(alias) === operation) this.#inflight.delete(alias);
    }
  }

  /**
   * Tell discovery that a tunnel was just opened, so a cached scan stops
   * claiming the port is not forwarded before the next scan runs. The override
   * is dropped by the next fresh scan, where the live tunnel list is the truth.
   */
  rememberForwarded(host, tunnel) {
    const alias = String(host ?? '').trim();
    const remotePort = Number(tunnel?.remotePort);
    if (!alias || !Number.isInteger(remotePort)) return;
    const remembered = this.#forwardedOverrides.get(alias) ?? new Map();
    remembered.set(remotePort, Date.now());
    this.#forwardedOverrides.set(alias, remembered);
  }

  /** Forget every cached scan (plugin reload / explicit diagnostics). */
  clear() {
    this.#cache.clear();
    this.#errors.clear();
    this.#lastQueried.clear();
    this.#firstSeen.clear();
    this.#forwardedOverrides.clear();
  }
}
