// Validate cordis patch files parse as YAML with the same parser the harness uses.
// Run under Electron-as-Node so app.asar imports resolve.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ASAR = process.env.DSH_ASAR ?? 'C:/Users/three/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const yamlModule = await import(pathToFileURL(`${ASAR}/dsh/node_modules/js-yaml/lib/js-yaml.mjs`).href).catch(async () => {
  return import(pathToFileURL(`${ASAR}/dsh/node_modules/js-yaml/index.js`).href);
});
const yaml = yamlModule.default ?? yamlModule;

const files = ['cordis.patch.yml', 'presets/fs.patch.yml', 'presets/safe.patch.yml'];
let failed = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  try {
    const doc = yaml.load(text);
    const entries = Array.isArray(doc) ? doc : [doc];
    const shapes = entries.map((entry) => (entry?.insert ? 'insert' : entry?.id ? `patch:${entry.id}` : 'invalid'));
    const terminal = entries.find((entry) => entry?.id === 'terminal-controller');
    const encoded = terminal?.config?.shell?.args?.find((arg) => typeof arg === 'string' && arg.length > 1000);
    console.log(`OK   ${file}: ${shapes.join(', ')}${terminal ? ` | shell=${terminal.config.shell.path} encoded=${encoded?.length ?? 0}b64` : ''}`);
    if (terminal) {
      const script = Buffer.from(encoded, 'base64').toString('utf16le');
      if (!script.includes('Get-PresenceMountsRoot')) throw new Error('decoded launcher does not contain the expected function');
    }
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${file}: ${error.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
