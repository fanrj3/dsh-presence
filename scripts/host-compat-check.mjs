// Host-compatibility check: load this plugin against the *shipped* Harness
// runtime and prove it activates.
//
// The tool body only runs under Electron-as-Node because the harness packages
// live inside app.asar and its ESM imports are resolved by the harness loader
// at runtime, not by plain Node:
//
//   $env:ELECTRON_RUN_AS_NODE = '1'
//   & 'C:\Users\three\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
//       scripts\host-compat-check.mjs
//
// It maps the four packages this plugin imports from the harness
// (@deepseek-ai/{dsh-tools,dsh-fs,dsh-fs-sandbox,schemastery}) plus cordis to
// their files inside app.asar, provides stub services for the late
// `ctx.inject` callbacks, calls the real `apply()`, and asserts all tools were
// registered. Run it after every DSH update: 0.2.1-rc.5 started rejecting
// object parameter schemas without an explicit `additionalProperties`, which
// failed activation with a JsonSchemaError before this check existed.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const ASAR =
  process.env.DSH_ASAR ??
  'C:/Users/three/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

const MODULES = {
  '@deepseek-ai/cordis': `${ASAR}/dsh/node_modules/@deepseek-ai/cordis/lib/index.js`,
  '@deepseek-ai/dsh-tools': `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`,
  '@deepseek-ai/dsh-fs': `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-fs/lib/index.js`,
  '@deepseek-ai/dsh-fs-sandbox': `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js`,
  '@deepseek-ai/schemastery': `${ASAR}/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs`,
};

const hook = `
const M = ${JSON.stringify(MODULES)};
export async function resolve(specifier, context, nextResolve) {
  if (M[specifier]) return { url: 'file:///' + M[specifier].replace(/\\\\/g, '/'), shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

process.on('unhandledRejection', (error) => {
  console.error('UNHANDLED REJECTION:', error?.stack ?? String(error));
  process.exitCode = 1;
});
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error?.stack ?? String(error));
  process.exitCode = 1;
});

const cordis = await import(pathToFileURL(MODULES['@deepseek-ai/cordis']).href);
const Context = cordis.Context ?? cordis.default?.Context;
if (typeof Context !== 'function') {
  console.error('host-compat-check: the shipped cordis exposes no Context');
  process.exit(2);
}

const registered = [];
const ctx = new Context();
ctx.provide('tools', {
  register(definition) {
    registered.push(definition.name);
    return () => {};
  },
  get(name) {
    return registered.includes(name) ? { name } : undefined;
  },
});
// Stub the services the plugin's late `ctx.inject` callbacks touch so those
// callbacks actually run; a synchronous throw there would fail the fiber.
ctx.provide('systemPrompt', {
  context: () => () => {},
  section: () => () => {},
  getSectionOrder: () => 0,
});
ctx.provide('webServer', { register: () => () => {} });
ctx.provide('workingDirectory', { ensure: async () => null });
ctx.provide('agents', { list: () => [], get: () => undefined });
ctx.provide('fileReferences', { list: async () => [] });
ctx.provide('credentials', { get: async () => null, set: async () => {} });
ctx.provide('registry', { create: async () => ({ id: 'x', path: 'D:/tmp', title: 'x' }) });
ctx.provide('fs', {
  read: async () => ({ content: '' }),
  write: async () => ({}),
  stat: async () => ({ exists: false }),
});

const plugin = await import('../index.js');
try {
  const fiber = ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    Config: plugin.Config,
    apply: plugin.apply,
  });
  await fiber;
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (registered.length !== 25) {
    console.error(`host-compat-check: expected 25 tools, registered ${registered.length}`);
    process.exit(1);
  }
  console.log(`host-compat-check: ACTIVATED OK with ${registered.length} tools`);
} catch (error) {
  console.error('host-compat-check: ACTIVATION FAILED');
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
