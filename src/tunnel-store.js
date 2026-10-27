// Saved port-forward presets.
//
// A preset is "forward remotePort on host to a local port, and optionally bring
// it back automatically after the machine reconnects". The panel and the
// auto-restore hook share this store; like custom-hosts.js it is one small JSON
// file under ~/.dsh/presence and Presence owns it (nothing is installed on the
// remote machine).
//
// Shapes are frozen by .scratch/feat-0.18/CONTRACTS.md:
//   { id, host, remoteHost, remotePort, localPort, label, autoRestore, createdAt }

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_PRESETS = 100;
const MAX_LABEL = 80;
const DEFAULT_REMOTE_HOST = '127.0.0.1';

function storeDirectory() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'presence');
}

/** Absolute path of the tunnel preset store. */
export function tunnelsFile() {
  return join(storeDirectory(), 'tunnels.json');
}

function newPresetId() {
  return `p-${randomUUID().slice(0, 8)}`;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Accept the `host:port` / `[host]:port` spelling the port panel also accepts in
 * its single remote-host field. Returns the split values (port may be null).
 */
function splitRemoteHost(value) {
  const text = String(value ?? '').trim();
  if (!text) return { remoteHost: DEFAULT_REMOTE_HOST, remotePort: null };
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(text);
  if (bracketed) return { remoteHost: bracketed[1], remotePort: Number(bracketed[2]) };
  const plain = /^[^:]+:(\d{1,5})$/u.exec(text);
  if (plain) return { remoteHost: text.slice(0, text.lastIndexOf(':')), remotePort: Number(plain[1]) };
  return { remoteHost: text, remotePort: null };
}

/**
 * Build a preset from caller input plus the record it replaces (if any).
 * Throws on input a preset cannot represent; the API turns that into a 4xx.
 */
function normalizePreset(input = {}, previous = null) {
  const host = String(input.host ?? previous?.host ?? '').trim();
  if (!host) throw new Error('host is required');

  let remoteHost = typeof input.remoteHost === 'string' && input.remoteHost.trim()
    ? input.remoteHost
    : (previous?.remoteHost ?? DEFAULT_REMOTE_HOST);
  let remotePortValue = input.remotePort ?? previous?.remotePort ?? null;
  const split = splitRemoteHost(remoteHost);
  remoteHost = split.remoteHost;
  if (split.remotePort !== null) remotePortValue = split.remotePort;
  const remotePort = validPort(remotePortValue);
  if (remotePort === null) throw new Error(`remotePort must be 1-65535, got ${JSON.stringify(input.remotePort)}`);

  let localPort = null;
  const localInput = input.localPort ?? previous?.localPort ?? null;
  if (localInput !== null && localInput !== undefined && localInput !== '') {
    localPort = validPort(localInput);
    if (localPort === null) throw new Error(`localPort must be 1-65535, got ${JSON.stringify(input.localPort)}`);
  }

  const labelInput = input.label ?? previous?.label;
  const label = typeof labelInput === 'string' ? labelInput.trim().slice(0, MAX_LABEL) : '';

  const autoRestore = input.autoRestore === undefined
    ? Boolean(previous?.autoRestore)
    : input.autoRestore === true;

  const id = previous?.id ?? (typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 64) : newPresetId());
  const createdAt = previous?.createdAt
    ?? (typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString());

  return { id, host, remoteHost, remotePort, localPort, label, autoRestore, createdAt };
}

/** Tolerant reading of a stored record; a bad row is dropped instead of thrown. */
function presetFromStored(item) {
  try {
    const host = String(item?.host ?? '').trim();
    const remotePort = validPort(item?.remotePort);
    if (!host || remotePort === null) return null;
    const localPort = item?.localPort === null || item?.localPort === undefined ? null : validPort(item.localPort);
    const remote = splitRemoteHost(item?.remoteHost);
    return {
      id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : newPresetId(),
      host,
      remoteHost: remote.remoteHost,
      remotePort,
      localPort,
      label: typeof item?.label === 'string' ? item.label.trim().slice(0, MAX_LABEL) : '',
      autoRestore: item?.autoRestore === true,
      createdAt: typeof item?.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Move a corrupt store out of the way instead of losing the user's presets to
 * the next write, then start from scratch. Never throws: a broken rename (a
 * read-only home, say) leaves the next load to fail the same harmless way.
 */
function quarantineCorruptStore(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    renameSync(file, `${file}.corrupt-${stamp}`);
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* the next successful save replaces it */
    }
  }
}

/** Read every preset; a missing, unreadable or corrupt file yields `[]`. */
export function loadPresets() {
  const file = tunnelsFile();
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantineCorruptStore(file);
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.presets) ? parsed.presets : [];
  const byKey = new Map();
  for (const item of items) {
    const preset = presetFromStored(item);
    if (!preset) continue;
    byKey.set(`${preset.host}\0${preset.remoteHost}\0${preset.remotePort}`, preset);
  }
  return [...byKey.values()].slice(0, MAX_PRESETS);
}

/** Atomically replace the store (temp file + rename, 0600 like the other stores). */
export function savePresets(presets) {
  const normalized = [];
  for (const item of Array.isArray(presets) ? presets : []) {
    try {
      normalized.push(normalizePreset(item));
    } catch {
      /* skip a row that cannot be represented */
    }
  }
  const file = tunnelsFile();
  mkdirSync(storeDirectory(), { recursive: true });
  const payload = `${JSON.stringify({ version: 1, presets: normalized.slice(0, MAX_PRESETS) }, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    // Windows can refuse renaming over a file another process holds open. Fall
    // back to a direct write so the save still lands, then drop the temp file.
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 });
  }
  return normalized.slice(0, MAX_PRESETS);
}

/** Create a preset, or update the one with the same host/remote target. */
export function upsertPreset(input = {}) {
  const presets = loadPresets();
  const explicitId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
  const host = String(input.host ?? '').trim();
  let remoteHost = typeof input.remoteHost === 'string' && input.remoteHost.trim()
    ? input.remoteHost
    : DEFAULT_REMOTE_HOST;
  const split = splitRemoteHost(remoteHost);
  remoteHost = split.remoteHost;
  const remotePort = validPort(input.remotePort ?? split.remotePort);
  const keyIndex = presets.findIndex(
    (preset) =>
      preset.host === host &&
      preset.remoteHost === remoteHost &&
      (remotePort === null || preset.remotePort === remotePort),
  );
  // An explicit id wins; otherwise the (host, remoteHost, remotePort) target is
  // the identity, so re-saving the same forward updates it in place.
  const idIndex = explicitId ? presets.findIndex((preset) => preset.id === explicitId) : -1;
  const index = idIndex >= 0 ? idIndex : keyIndex;
  const previous = index >= 0 ? presets[index] : null;
  const preset = normalizePreset(input, previous);
  if (index >= 0) presets[index] = preset;
  else {
    if (presets.length >= MAX_PRESETS) throw new Error(`too many saved port presets (max ${MAX_PRESETS})`);
    presets.push(preset);
  }
  savePresets(presets);
  return preset;
}

/**
 * Remove one preset. `{ id }` wins when given; otherwise host plus remotePort
 * (and, when supplied, remoteHost) identifies the target.
 */
export function removePreset(query = {}) {
  const id = typeof query.id === 'string' && query.id.trim() ? query.id.trim() : null;
  const host = String(query.host ?? '').trim();
  const remotePort = query.remotePort === undefined || query.remotePort === null || query.remotePort === ''
    ? null
    : validPort(query.remotePort);
  const remoteHostRaw = typeof query.remoteHost === 'string' && query.remoteHost.trim() ? query.remoteHost.trim() : null;
  if (!id && !host) throw new Error('id or host is required');
  const presets = loadPresets();
  const index = presets.findIndex((preset) => {
    if (id) return preset.id === id;
    if (preset.host !== host) return false;
    if (remotePort !== null && preset.remotePort !== remotePort) return false;
    if (remoteHostRaw !== null && preset.remoteHost !== splitRemoteHost(remoteHostRaw).remoteHost) return false;
    return true;
  });
  if (index < 0) return false;
  presets.splice(index, 1);
  savePresets(presets);
  return true;
}

/**
 * File-backed owner of the preset list. All state lives in the JSON file, so a
 * second instance (or a probe) sees exactly what the plugin sees.
 */
export class TunnelStore {
  /** Absolute store path, exposed for diagnostics. */
  get file() {
    return tunnelsFile();
  }

  load() {
    return loadPresets();
  }

  list() {
    return loadPresets();
  }

  save(presets) {
    return savePresets(presets);
  }

  upsert(input = {}) {
    return upsertPreset(input);
  }

  remove(query = {}) {
    return removePreset(query);
  }
}
