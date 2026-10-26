// Remote workspaces the user created: one machine plus one folder. Presence
// owns this registry; a DSH workspace stays what it is (a local directory) until
// the fs provider lands, so this is the binding the agent reads today.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function storeDirectory() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'presence');
}

function storeFile() {
  return join(storeDirectory(), 'workspaces.json');
}

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8'));
    if (Array.isArray(parsed)) return { active: null, items: parsed };
    return {
      active: typeof parsed.active === 'string' ? parsed.active : null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return { active: null, items: [] };
  }
}

function writeStore(store) {
  mkdirSync(storeDirectory(), { recursive: true });
  writeFileSync(storeFile(), `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function listWorkspaces() {
  return readStore().items;
}

/** The workspace the agent should treat as its project root, if any. */
export function activeWorkspace() {
  const store = readStore();
  return store.items.find((entry) => entry.id === store.active) ?? null;
}

export function activateWorkspace(id) {
  const store = readStore();
  store.active = store.items.some((entry) => entry.id === id) ? id : null;
  writeStore(store);
  return store.items.find((entry) => entry.id === store.active) ?? null;
}

/** Create or reuse the workspace for one (host, remote path) pair. */
export function upsertWorkspace({ host, path, title }) {
  const store = readStore();
  const existing = store.items.find((entry) => entry.host === host && entry.path === path);
  if (existing) return existing;
  const name = title || path.split('/').filter(Boolean).at(-1) || path;
  const entry = {
    id: `w-${randomUUID().slice(0, 8)}`,
    host,
    path,
    title: name,
    createdAt: new Date().toISOString(),
  };
  store.items = [entry, ...store.items];
  writeStore(store);
  return entry;
}

export function removeWorkspace(id) {
  const store = readStore();
  const before = store.items.length;
  store.items = store.items.filter((entry) => entry.id !== id);
  if (store.active === id) store.active = null;
  writeStore(store);
  return store.items.length !== before;
}
