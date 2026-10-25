// Machines the user typed in by hand (an `ssh ...` command line or
// user@host[:port]) instead of adding them to ~/.ssh/config. Presence owns this
// store and never writes the ssh config file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_HOSTS = 100;

function storeDirectory() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'presence');
}

export function customHostsFile() {
  return join(storeDirectory(), 'hosts.json');
}

function expandHomeValue(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function normalizeEntry(input) {
  const alias = String(input.alias ?? '').trim();
  const hostname = String(input.hostname ?? '').trim();
  if (!alias || !hostname) throw new Error('alias and hostname are required');
  const port = Number(input.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${input.port}`);
  return {
    alias,
    hostname,
    port,
    user: typeof input.user === 'string' && input.user ? input.user : null,
    identityFile: Array.isArray(input.identityFile) ? input.identityFile.filter((file) => typeof file === 'string' && file) : [],
    forwardAgent: Boolean(input.forwardAgent),
    compression: input.compression !== false,
    proxyJump: typeof input.proxyJump === 'string' && input.proxyJump ? input.proxyJump : null,
    note: typeof input.note === 'string' ? input.note : '',
    source: 'manual',
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
  };
}

export function loadCustomHosts() {
  try {
    const parsed = JSON.parse(readFileSync(customHostsFile(), 'utf8'));
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.hosts) ? parsed.hosts : [];
    return items.map((item) => normalizeEntry(item)).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveCustomHosts(hosts) {
  mkdirSync(storeDirectory(), { recursive: true });
  const payload = JSON.stringify({ version: 1, hosts: hosts.slice(0, MAX_HOSTS) }, null, 2);
  writeFileSync(customHostsFile(), `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function customHost(alias) {
  return loadCustomHosts().find((entry) => entry.alias === alias) ?? null;
}

/** Split an ssh command line into tokens, honouring quotes and backslashes. */
export function tokenizeSshCommand(input) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  let escaped = false;
  for (const char of String(input ?? '')) {
    if (escaped) {
      current += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function parseTarget(token, into) {
  let rest = String(token ?? '');
  if (!rest) return;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/u.exec(rest);
  if (bracket) {
    into.hostname = bracket[1];
    if (bracket[2]) into.port = Number(bracket[2]);
    return;
  }
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    into.user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(':');
  if (colon > 0 && /^\d+$/u.test(rest.slice(colon + 1))) {
    into.port = Number(rest.slice(colon + 1));
    rest = rest.slice(0, colon);
  }
  into.hostname = rest;
}

/**
 * Parse an ssh command line (`ssh -p 2222 -i ~/.ssh/k user@host`) or a bare
 * `user@host[:port]` / `ssh://user@host:port` into connection fields.
 */
export function parseSshCommand(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('请输入 ssh 命令或 user@host[:port]');
  // Strip a shell prompt or a leading `ssh`.
  text = text.replace(/^[^A-Za-z0-9@"'/~[]*\$\s+/u, '');
  const warnings = [];
  const result = { hostname: null, user: null, port: null, identityFile: [], forwardAgent: false, compression: true, proxyJump: null };

  const uri = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/iu.exec(text);
  if (uri) {
    if (uri[1]) result.user = decodeURIComponent(uri[1]);
    result.hostname = uri[2].replace(/^\[|\]$/gu, '');
    if (uri[3]) result.port = Number(uri[3]);
    return { ...result, warnings };
  }

  let tokens = tokenizeSshCommand(text);
  if (tokens[0] === 'ssh') tokens = tokens.slice(1);
  const positional = [];

  const takeValue = (index, flag) => {
    const value = tokens[index + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少值`);
    return value;
  };
  const applyOption = (option) => {
    const [rawKey, ...rest] = String(option).split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim().replace(/^"|"$/gu, '');
    if (key === 'port') result.port = Number(value);
    else if (key === 'user') result.user = value;
    else if (key === 'hostname') result.hostname = value;
    else if (key === 'identityfile') result.identityFile.push(expandHomeValue(value));
    else if (key === 'forwardagent') result.forwardAgent = value === 'yes';
    else if (key === 'compression') result.compression = value !== 'no';
    else if (key === 'proxyjump') {
      result.proxyJump = value;
      warnings.push(`ProxyJump 暂不支持，会直接连接目标主机`);
    } else warnings.push(`未识别的 ssh 选项 -o ${rawKey}`);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positional.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const exact = token.slice(0, 2);
    if (['-p', '-l', '-i', '-o', '-J', '-F'].includes(exact) && token.length > 2) {
      // Attached value forms: -p22, -luser, -ikey
      const value = token.slice(2);
      if (exact === '-p') result.port = Number(value);
      else if (exact === '-l') result.user = value;
      else if (exact === '-i') result.identityFile.push(expandHomeValue(value));
      else if (exact === '-o') applyOption(value);
      else if (exact === '-J') {
        result.proxyJump = value;
        warnings.push('ProxyJump 暂不支持，会直接连接目标主机');
      } else if (exact === '-F') warnings.push(`已忽略 -F ${value}：只读取 ~/.ssh/config`);
      continue;
    }
    switch (token) {
      case '-p':
        result.port = Number(takeValue(index, '-p'));
        index += 1;
        break;
      case '-l':
        result.user = takeValue(index, '-l');
        index += 1;
        break;
      case '-i':
        result.identityFile.push(expandHomeValue(takeValue(index, '-i')));
        index += 1;
        break;
      case '-o':
        applyOption(takeValue(index, '-o'));
        index += 1;
        break;
      case '-J':
        result.proxyJump = takeValue(index, '-J');
        warnings.push('ProxyJump 暂不支持，会直接连接目标主机');
        index += 1;
        break;
      case '-F':
        warnings.push(`已忽略 -F ${takeValue(index, '-F')}：只读取 ~/.ssh/config`);
        index += 1;
        break;
      case '-A':
        result.forwardAgent = true;
        break;
      case '-C':
        result.compression = true;
        break;
      case '-a':
        result.forwardAgent = false;
        break;
      default:
        if (/^-[ACXYT46vq]+$/u.test(token)) {
          if (token.includes('A')) result.forwardAgent = true;
          if (token.includes('C')) result.compression = true;
        } else {
          warnings.push(`未识别的 ssh 参数 ${token}，已忽略`);
        }
    }
  }

  if (positional.length > 1) warnings.push(`忽略了多余的参数：${positional.slice(1).join(' ')}`);
  const target = positional[0];
  if (!target) throw new Error('没有找到目标主机（示例：user@host 或 ssh -p 22 user@host）');
  parseTarget(target, result);
  if (!result.hostname) throw new Error(`无法解析目标主机：${target}`);
  result.port = result.port ?? 22;
  return { ...result, warnings };
}

function sanitizeAlias(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^\w.@-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
}

function suggestAlias({ hostname, user }) {
  const base = sanitizeAlias(hostname) || 'manual';
  const suffix = user ? `-${sanitizeAlias(user)}` : '';
  return `${base}${suffix}`.slice(0, 64);
}

/** Add a manual host from an ssh command or explicit fields; alias must be free. */
export function addCustomHost({ text, alias, note, hostname, user, port, identityFile, takenAliases = [] } = {}) {
  const parsed = text && String(text).trim() ? parseSshCommand(text) : { warnings: [], identityFile: [] };
  const fields = {
    hostname: hostname ?? parsed.hostname,
    user: user ?? parsed.user,
    port: port ?? parsed.port ?? 22,
    identityFile: identityFile ?? parsed.identityFile ?? [],
    forwardAgent: parsed.forwardAgent ?? false,
    compression: parsed.compression !== false,
    proxyJump: parsed.proxyJump ?? null,
  };
  if (!fields.hostname) throw new Error('缺少主机名');
  const hosts = loadCustomHosts();
  const taken = new Set([...takenAliases, ...hosts.map((entry) => entry.alias)]);
  const requested = sanitizeAlias(alias);
  let finalAlias = requested;
  if (requested) {
    if (taken.has(requested)) {
      throw new Error(`别名 ${requested} 已被占用（ssh config 或已有手动主机），请换一个`);
    }
  } else {
    finalAlias = suggestAlias(fields);
    if (!finalAlias) throw new Error('无法生成别名，请手动填写');
    let counter = 2;
    while (taken.has(finalAlias)) {
      finalAlias = `${suggestAlias(fields)}-${counter}`;
      counter += 1;
      if (counter > 50) throw new Error('别名冲突过多，请手动指定');
    }
  }
  const entry = normalizeEntry({ ...fields, alias: finalAlias, note });
  saveCustomHosts([...hosts, entry]);
  return { entry, warnings: parsed.warnings ?? [] };
}

export function removeCustomHost(alias) {
  const hosts = loadCustomHosts();
  const next = hosts.filter((entry) => entry.alias !== alias);
  if (next.length === hosts.length) throw new Error(`no manual host "${alias}"`);
  saveCustomHosts(next);
  return next;
}
