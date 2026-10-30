// Docs probe for Presence 0.20.0: README / README.zh-CN / docs/RELEASE anchors.
//
//   node scripts/p1-docs-probe.mjs
//
// Pure text assertions: no network, no SSH host and no DSH process needed. It
// protects the 0.20.0 documentation contract: the local-vs-remote session
// warning, the 25-tool table (with presence_wait, without the stale presence_ls
// row), presence_wait / persisted jobs / batch transfer / append anchors, the
// release section and bilingual sync between the two READMEs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

const readme = read('README.md');
const readmeZh = read('README.zh-CN.md');
const release = read('docs/RELEASE.md');

/** Collapse newlines/indentation so wrapped markdown lines still match. */
const flat = (text) => String(text).replace(/\s+/gu, ' ');

let checks = 0;
let failures = 0;
function check(label, run) {
  checks += 1;
  try {
    const detail = run();
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } catch (error) {
    failures += 1;
    const message = String(error?.message ?? error);
    console.log(`FAIL  ${label}\n      ${message.split('\n').join('\n      ')}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Slice one `## <heading>` section (up to the next `## `). */
const section = (text, heading) => {
  const start = text.indexOf(`## ${heading}`);
  expect(start >= 0, `missing section "## ${heading}"`);
  const rest = text.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return end >= 0 ? rest.slice(0, end) : rest;
};
/** The tool-table rows in a README: `| \`presence_x\` | description |`. */
const toolRows = (text) =>
  text
    .split('\n')
    .filter((line) => /^\| `presence_[a-z_]+`/u.test(line))
    .map((line) => ({ name: line.match(/^\| `(presence_[a-z_]+)`/u)[1], line }));

// ---------------------------------------------------------------- canonical set
// The 24 tools registered in 0.19.0 plus the 0.20.0 condition primitive.
const EXPECTED_TOOLS = [
  'presence_chmod',
  'presence_connect',
  'presence_copy',
  'presence_diff',
  'presence_edit',
  'presence_exec',
  'presence_export',
  'presence_forward',
  'presence_glob',
  'presence_hosts',
  'presence_http_probe',
  'presence_import',
  'presence_jobs',
  'presence_mkdir',
  'presence_move',
  'presence_port_probe',
  'presence_read',
  'presence_read_many',
  'presence_search',
  'presence_stat',
  'presence_tail',
  'presence_terminal',
  'presence_trash',
  'presence_wait',
  'presence_write',
];

// ---------------------------------------------------------------------- hygiene
for (const [file, text] of [
  ['README.md', readme],
  ['README.zh-CN.md', readmeZh],
  ['docs/RELEASE.md', release],
]) {
  check(`${file}: non-empty`, () => {
    expect(text.trim().length > 400, `only ${text.trim().length} characters`);
    return `${text.length} chars`;
  });
  // Written as a code point on purpose: this file must not itself contain the
  // mojibake sequence it looks for in the docs.
  const MOJIBAKE_CHAR = String.fromCharCode(0x9225);
  check(`${file}: no replacement characters or mojibake`, () => {
    expect(!text.includes('\uFFFD'), 'contains U+FFFD replacement character');
    expect(!text.includes(MOJIBAKE_CHAR), 'contains the U+9225 mojibake sequence');
    return 'clean';
  });
}

// ------------------------------------------------- version + session-scope warning
for (const [label, text, phrase] of [
  ['README.md', readme, 'A local session is not bound to a remote workspace'],
  ['README.zh-CN.md', readmeZh, '本地会话不会绑定远端工作区'],
]) {
  check(`${label}: version 0.20.1 in install and development commands`, () => {
    const body = flat(text);
    expect(body.includes('@rjfan/dsh-presence@0.20.1'), 'missing install version @rjfan/dsh-presence@0.20.1');
    expect(body.includes('-Version 0.20.1'), 'missing package.ps1 -Version 0.20.1');
    expect(body.includes('presence-plugin-0.20.1.zip'), 'missing dist/presence-plugin-0.20.1.zip');
    expect(!body.includes('@rjfan/dsh-presence@0.19.0'), 'stale 0.19.0 install version');
    return '0.20.1';
  });
  check(`${label}: local-vs-remote session warning near the top`, () => {
    const at = flat(text).indexOf(phrase);
    expect(at >= 0, `missing phrase: ${phrase}`);
    const why = flat(text).indexOf(label === 'README.md' ? ' Why ' : ' 为什么不是');
    expect(why > at, 'warning should precede the Why section');
    const warning = flat(text).slice(at, at + 900);
    expect(
      warning.includes('PRESENCE_HOST') && /explicit `host`|显式传 `host`/u.test(warning),
      'warning does not mention an explicit host / PRESENCE_HOST',
    );
    return `at char ${at}`;
  });
  check(`${label}: tools intro states the local-session host requirement`, () => {
    const tools = flat(section(text, label === 'README.md' ? 'Tools' : '工具'));
    expect(
      /local\*\* session must pass|本地\*\* 会话必须显式传/u.test(tools),
      'tools intro does not require an explicit host for a local session',
    );
    expect(tools.includes('PRESENCE_HOST'), 'tools intro does not mention PRESENCE_HOST');
    return 'yes';
  });
}

// ------------------------------------------------------------------ README tools
check('README.md: "25 tools"', () => {
  expect(flat(readme).includes('exposes 25 tools'), 'missing "exposes 25 tools"');
  return '25';
});
check('README.zh-CN.md: "提供 25 个工具"', () => {
  expect(flat(readmeZh).includes('提供 25 个工具'), 'missing "提供 25 个工具"');
  return '25';
});

for (const [label, text] of [
  ['README.md', readme],
  ['README.zh-CN.md', readmeZh],
]) {
  check(`${label}: tool table has exactly the 25 registered tools`, () => {
    const rows = toolRows(text);
    expect(rows.length === 25, `found ${rows.length} tool rows, expected 25`);
    const names = rows.map((row) => row.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    expect(
      JSON.stringify(names) === JSON.stringify(expected),
      `tool names differ: extra=[${names.filter((name) => !expected.includes(name)).join(',')}] ` +
        `missing=[${expected.filter((name) => !names.includes(name)).join(',')}]`,
    );
    expect(
      !rows.some((row) => row.name === 'presence_ls'),
      'stale presence_ls row is back (never registered as a DSH tool)',
    );
    return '25 rows';
  });
  check(`${label}: every tool row has a description`, () => {
    // Chinese descriptions are denser than English ones; require real content,
    // not an empty or one-word cell.
    const minLength = label === 'README.md' ? 20 : 6;
    const thin = toolRows(text).filter(
      (row) => row.line.replace(/^\| `[^`]+` \|/u, '').trim().length < minLength,
    );
    expect(thin.length === 0, `rows without a description: ${thin.map((row) => row.name).join(', ')}`);
    return 'ok';
  });
  check(`${label}: presence_wait row documents conditions and met:false`, () => {
    const row = toolRows(text).find((entry) => entry.name === 'presence_wait');
    expect(Boolean(row), 'missing presence_wait row');
    const body = flat(row.line);
    for (const anchor of ['file', 'grep', 'process', 'port', 'job', 'met:false', 'timedOut']) {
      expect(body.includes(anchor), `presence_wait row misses "${anchor}"`);
    }
    return 'conditions + timeout contract';
  });
  check(`${label}: batch transfer + append anchors`, () => {
    const body = flat(text);
    expect(body.includes('paths[]'), 'missing paths[]');
    expect(body.includes('glob'), 'missing glob');
    expect(body.includes('commandLogPath'), 'missing commandLogPath');
    expect(body.includes('PRESENCE_JOBS_FILE'), 'missing PRESENCE_JOBS_FILE');
    expect(/name-<sha8>|name-&lt;sha8&gt;/u.test(body), 'missing name-<sha8> collision rule');
    expect(body.includes('mode: "append"') || body.includes('mode:"append"'), 'missing append mode');
    expect(body.includes('jobs.json'), 'missing jobs.json');
    return 'batch/append/jobs';
  });
}

check('presence_write row: ifMatchSha256 is overwrite-only (append rejects it)', () => {
  const row = (text) => flat(toolRows(text).find((entry) => entry.name === 'presence_write')?.line ?? '');
  const en = row(readme);
  expect(en.includes('overwrite-only'), 'README.md presence_write row does not say ifMatchSha256 is overwrite-only');
  expect(/append rejects/u.test(en), 'README.md presence_write row does not say append rejects ifMatchSha256');
  const zh = row(readmeZh);
  expect(zh.includes('仅 overwrite 有效'), 'README.zh-CN.md presence_write row does not say ifMatchSha256 is overwrite-only');
  expect(zh.includes('报错'), 'README.zh-CN.md presence_write row does not say append errors');
  return 'reject, not ignore';
});
check('presence_write row: mode also accepts an octal permission string', () => {
  const en = flat(toolRows(readme).find((entry) => entry.name === 'presence_write')?.line ?? '');
  const zh = flat(toolRows(readmeZh).find((entry) => entry.name === 'presence_write')?.line ?? '');
  expect(en.includes('octal'), 'README.md does not mention the octal mode overload');
  expect(zh.includes('八进制'), 'README.zh-CN.md does not mention the octal mode overload');
  return 'documented';
});

// ------------------------------------------------------------ sections + anchors
const SECTION_PAIRS = [
  ['Tools', '工具'],
  ['Which tool for which path', '路径与工具怎么选'],
  ['Long-running tasks', '长时间任务'],
  ['Known limits', '已知边界'],
  ['Batch transfer and append', '批量传输与追加写'],
];
for (const [en, zh] of SECTION_PAIRS) {
  const marker = en === 'Batch transfer and append' ? '###' : '##';
  check(`bilingual section: ${marker} ${en} / ${marker} ${zh}`, () => {
    expect(readme.includes(`${marker} ${en}`), `README.md is missing "${marker} ${en}"`);
    expect(readmeZh.includes(`${marker} ${zh}`), `README.zh-CN.md is missing "${marker} ${zh}"`);
    return 'both';
  });
}

const LONG_EN = flat(section(readme, 'Long-running tasks'));
for (const anchor of ['presence_exec', 'background: true', 'presence_jobs', 'presence_tail', 'presence_wait', 'commandLogPath']) {
  check(`Long-running tasks recipe mentions ${anchor}`, () => {
    expect(LONG_EN.includes(anchor), `missing "${anchor}"`);
    return 'ok';
  });
}
const LONG_ZH = flat(section(readmeZh, '长时间任务'));
for (const anchor of ['presence_exec', 'background: true', 'presence_jobs', 'presence_tail', 'presence_wait', 'commandLogPath']) {
  check(`长时间任务 recipe mentions ${anchor}`, () => {
    expect(LONG_ZH.includes(anchor), `missing "${anchor}"`);
    return 'ok';
  });
}

check('Long-running tasks explains met:false is not an error', () => {
  expect(flat(readme).includes('met:false'), 'README.md does not say met:false');
  expect(flat(readmeZh).includes('met:false'), 'README.zh-CN.md does not say met:false');
  return 'ok';
});
check('Known limits documents restart-unknown persisted jobs', () => {
  const limits = flat(section(readme, 'Known limits'));
  expect(limits.includes('unknown'), 'does not document unknown state');
  expect(limits.includes('jobs.json'), 'does not name jobs.json');
  expect(limits.includes('commandLogPath ?? logPath'), 'does not say which log to tail');
  expect(limits.includes('exit code may be missing'), 'does not warn that an exit code may be missing');
  const limitsZh = flat(section(readmeZh, '已知边界'));
  expect(limitsZh.includes('unknown'), 'zh does not document unknown state');
  expect(limitsZh.includes('jobs.json'), 'zh does not name jobs.json');
  expect(limitsZh.includes('commandLogPath ?? logPath'), 'zh does not say which log to tail');
  expect(limitsZh.includes('退出码可能缺失'), 'zh does not warn that an exit code may be missing');
  return 'ok';
});
check('Known limits documents the "Local sessions" intended behaviour', () => {
  const limits = flat(section(readme, 'Known limits'));
  expect(limits.includes('**Local sessions.**'), 'README.md Known limits misses the "**Local sessions.**" note');
  expect(limits.includes('intended 0.20 behavior'), 'README.md does not say it is intended behaviour');
  expect(limits.includes('PRESENCE_HOST'), 'README.md does not mention the PRESENCE_HOST opt-in');
  expect(/pass an explicit host/u.test(limits), 'README.md does not quote the explicit-host error');
  const limitsZh = flat(section(readmeZh, '已知边界'));
  expect(limitsZh.includes('本地会话（有意行为）'), 'README.zh-CN.md 已知边界 misses the local-sessions note');
  expect(limitsZh.includes('有意'), 'README.zh-CN.md does not say it is intended behaviour');
  expect(limitsZh.includes('PRESENCE_HOST'), 'README.zh-CN.md does not mention the PRESENCE_HOST opt-in');
  expect(/pass an explicit host/u.test(limitsZh), 'README.zh-CN.md does not quote the explicit-host error');
  return 'ok';
});
check('README documents the /state job row fields', () => {
  for (const [label, text] of [
    ['README.md', readme],
    ['README.zh-CN.md', readmeZh],
  ]) {
    const body = flat(text);
    expect(body.includes('/presence/api/state'), `${label} does not mention /presence/api/state`);
    expect(body.includes('persisted'), `${label} does not mention the persisted flag`);
  }
  return 'pid/pgid/commandLogPath/persisted';
});
check('README explains commandLogPath vs logPath', () => {
  for (const [label, text] of [
    ['README.md', readme],
    ['README.zh-CN.md', readmeZh],
  ]) {
    expect(flat(text).includes('commandLogPath ?? logPath'), `${label} does not document commandLogPath ?? logPath`);
  }
  return 'both';
});
check('Safety/limits document that exec cat does not count as a read', () => {
  const safety = flat(section(readme, 'Safety and recovery'));
  expect(/exec cat|cat file/u.test(safety), 'README.md Safety does not mention exec cat/cat file');
  expect(/does \*\*not\*\* count|not count/u.test(safety), 'README.md Safety does not state it does not count');
  const limitsZh = flat(section(readmeZh, '已知边界'));
  expect(limitsZh.includes('exec cat'), 'README.zh-CN.md 已知边界 does not mention exec cat');
  expect(limitsZh.includes('不会'), 'README.zh-CN.md 已知边界 does not state it does not count');
  return 'ok';
});
check('Which-tool table has the local-session note', () => {
  expect(
    flat(section(readme, 'Which tool for which path')).includes('cwd outside the mounts root'),
    'README.md which-tool note missing',
  );
  expect(
    flat(section(readmeZh, '路径与工具怎么选')).includes('cwd 不在挂载根下'),
    'README.zh-CN.md which-tool note missing',
  );
  return 'ok';
});

// ------------------------------------------------------------------- release doc
check('docs/RELEASE.md: v0.20.0 section header', () => {
  expect(
    release.includes('## v0.20.0 — hotfix + P1 batch'),
    'missing "## v0.20.0 — hotfix + P1 batch"',
  );
  return 'header exact';
});
check('docs/RELEASE.md: v0.20.0 precedes v0.19.0', () => {
  const v20 = release.indexOf('## v0.20.0');
  const v19 = release.indexOf('## v0.19.0');
  expect(v20 >= 0 && v19 >= 0, 'missing a version section');
  expect(v20 < v19, 'v0.20.0 is not the newest section');
  return 'newest';
});
check('docs/RELEASE.md: v0.20.1 compatibility hotfix is the newest section', () => {
  const v201 = release.indexOf('## v0.20.1');
  const v200 = release.indexOf('## v0.20.0');
  expect(v201 >= 0 && v200 >= 0, 'missing the v0.20.1 section');
  expect(v201 < v200, 'v0.20.1 is not above v0.20.0');
  expect(release.includes('DSH 0.2.1-rc.5'), 'missing the DSH compatibility note');
  expect(release.includes('additionalProperties'), 'missing the schema hotfix explanation');
  return 'newest';
});
check('docs/RELEASE.md: v0.20.0 covers hotfix + P1 items', () => {
  const start = release.indexOf('## v0.20.0');
  const next = release.indexOf('## v0.19.0');
  const body = flat(release.slice(start, next > start ? next : undefined));
  const anchors = [
    ['会话不再静默解析到远端工作区', 'hotfix section'],
    ['presence_wait', 'wait tool'],
    ['jobs.json', 'job registry'],
    ['commandLogPath', 'command log'],
    ['append', 'append mode'],
    ['批量', 'batch transfer'],
    ['读后写', 'guard notes'],
    ['验证', 'verification list'],
  ];
  for (const [anchor, what] of anchors) {
    expect(body.includes(anchor), `missing ${what} anchor "${anchor}"`);
  }
  return `${anchors.length} anchors`;
});

// ------------------------------------------------------------------------ summary
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
