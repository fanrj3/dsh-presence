// Read ~/.ssh/config so the plugin offers exactly the machines the user
// already has, with the same hostname/port/user/key they already use.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadCustomHosts } from '../custom-hosts.js';

export function sshDirectory() {
  return process.env.DSH_SSH_DIR || join(homedir(), '.ssh');
}

export function configPath() {
  return process.env.DSH_SSH_CONFIG || join(sshDirectory(), 'config');
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** ssh_config allows a value wrapped in one pair of quotes; the quotes are not part of it. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Minimal but faithful parser: Host blocks, the keywords Presence needs, and
 * global defaults. Match/Include are skipped rather than mis-parsed.
 */
export function parseSshConfig(text, { baseDir = sshDirectory(), depth = 0 } = {}) {
  const entries = new Map();
  const defaults = {};
  let current = null;

  const assign = (target, key, value) => {
    const lower = key.toLowerCase();
    if (lower === 'identityfile') {
      const file = expandHome(unquote(value));
      target.identityFile = target.identityFile ?? [];
      target.identityFile.push(isAbsolute(file) ? file : resolve(baseDir, file));
    } else if (lower === 'hostname') target.hostname = unquote(value);
    else if (lower === 'user') target.user = value;
    else if (lower === 'port') target.port = Number(value) || 22;
    else if (lower === 'proxyjump') target.proxyJump = value;
    else if (lower === 'proxycommand') target.proxyCommand = value;
    else if (lower === 'exitonforwardfailure') target.exitOnForwardFailure = value === 'yes';
    else if (lower === 'servername') target.serverName = value;
    else if (lower === 'addressfamily') target.addressFamily = value;
    else if (lower === 'listenaddress') target.listenAddress = value;
    else if (lower === 'forwardagent') target.forwardAgent = value === 'yes';
    else if (lower === 'compression') target.compression = value === 'yes';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(/[\s=]+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(' ').trim();
    if (!value) continue;

    if (key === 'host') {
      current = null;
      for (const pattern of value.split(/\s+/)) {
        if (pattern === '*' || pattern.includes('?') || pattern.includes('!')) continue;
        const entry = entries.get(pattern) ?? { alias: pattern };
        entries.set(pattern, entry);
        current = entry;
      }
    } else if (key === 'match') {
      current = null;
    } else if (key === 'include') {
      if (depth < 4) {
        for (const pattern of value.split(/\s+/)) {
          const file = resolve(baseDir, expandHome(pattern));
          if (existsSync(file) && statSync(file).isFile()) {
            for (const [alias, entry] of parseSshConfig(readFileSync(file, 'utf8'), { baseDir, depth: depth + 1 })) {
              if (!entries.has(alias)) entries.set(alias, entry);
            }
          }
        }
      }
    } else if (current) {
      assign(current, key, value);
    } else {
      assign(defaults, key, value);
    }
  }

  for (const entry of entries.values()) {
    entry.hostname = entry.hostname ?? entry.alias;
    entry.port = entry.port ?? 22;
    entry.user = entry.user ?? defaults.user;
    entry.identityFile = entry.identityFile ?? defaults.identityFile;
    entry.proxyJump = entry.proxyJump ?? defaults.proxyJump;
    entry.proxyCommand = entry.proxyCommand ?? defaults.proxyCommand;
  }
  return entries;
}

/** The ssh config file alone, without the manual hosts Presence stores itself. */
export function readSshConfigEntries() {
  const file = configPath();
  if (!existsSync(file)) return new Map();
  return parseSshConfig(readFileSync(file, 'utf8'), { baseDir: sshDirectory() });
}

/** ssh config plus the hosts the user typed in manually (manual wins on add). */
export function readSshConfig() {
  const entries = readSshConfigEntries();
  for (const entry of loadCustomHosts()) {
    if (!entries.has(entry.alias)) entries.set(entry.alias, entry);
  }
  return entries;
}

/** Hosts worth showing in a picker: config hosts with a HostName, plus manual ones. */
export function listHosts() {
  return [...readSshConfig().values()]
    .filter((entry) => entry.hostname && (entry.source === 'manual' || entry.hostname !== entry.alias))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Default private keys present on this machine, most specific first. */
export function defaultKeys() {
  const dir = sshDirectory();
  if (!existsSync(dir)) return [];
  const preferred = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  const found = preferred.map((name) => join(dir, name)).filter((path) => existsSync(path));
  const others = readdirSync(dir)
    .filter((name) => !name.endsWith('.pub') && !preferred.includes(name) && /^id_/.test(name))
    .map((name) => join(dir, name));
  return [...found, ...others].filter((path) => !isAbsolute(path) === false && statSync(path).isFile());
}
