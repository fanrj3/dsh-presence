// Pure-helper probe for the 0.21.0 wait dock (client-ui).
//
//   node scripts/wait-ui-probe.mjs
//
// Exercises the helpers app.js uses for the floating dock — payload tolerance,
// finished-entry filtering, collapsed/expanded thresholds, progress formatting
// and ETA maths — without a browser, DSH runtime or network.
import {
  ETA_WINDOW_MS,
  FINISHED_HOLD_MS,
  MAX_LAST_LINE,
  POLL_COLLAPSED_MS,
  POLL_EXPANDED_MS,
  SAMPLE_CAP,
  computeEta,
  dockPresentation,
  elapsedMs,
  filterVisibleWaits,
  formatClock,
  formatDurationShort,
  formatElapsed,
  formatProgress,
  normalizeProgress,
  normalizeSamples,
  normalizeTimestamp,
  normalizeWait,
  normalizeWaitsPayload,
  pillLabelText,
  progressRatio,
  reduceSamples,
  waitIsFinished,
  waitVisible,
} from '../client-src/waits-ui.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
};

const NOW = 1_000_000;
const at = (offsetMs) => NOW + offsetMs;
const waitRow = (overrides = {}) => ({
  id: 'w-1',
  kind: 'job',
  host: 'lthpc',
  label: 'build kernel',
  startedAt: at(-30_000),
  updatedAt: at(-1_000),
  timeoutMs: 600_000,
  state: 'running',
  meta: {},
  progress: { done: null, total: null, unit: null, note: null },
  lastLine: null,
  exitCode: null,
  error: null,
  samples: [],
  ...overrides,
});

console.log('constants');
eq('FINISHED_HOLD_MS is 10 s', FINISHED_HOLD_MS, 10_000);
eq('expanded poll is 1500 ms', POLL_EXPANDED_MS, 1_500);
eq('collapsed poll is 5000 ms', POLL_COLLAPSED_MS, 5_000);
eq('ETA window is 60 s', ETA_WINDOW_MS, 60_000);
eq('sample cap is 240', SAMPLE_CAP, 240);

console.log('\nformatting');
eq('formatElapsed 0', formatElapsed(0), '00:00');
eq('formatElapsed 65 s', formatElapsed(65_000), '01:05');
eq('formatElapsed 59:59', formatElapsed(3_599_000), '59:59');
eq('formatElapsed 60 min stays mm:ss', formatElapsed(3_600_000), '60:00');
eq('formatElapsed negative clamps', formatElapsed(-500), '00:00');
eq('formatElapsed null', formatElapsed(null), '00:00');
eq('formatDurationShort 0', formatDurationShort(0), '0s');
eq('formatDurationShort 45 s', formatDurationShort(45_000), '45s');
eq('formatDurationShort 90 s rounds up', formatDurationShort(90_000), '2m');
eq('formatDurationShort 3 h 59 m rounds to next hour', formatDurationShort(3_599_000), '1h');
eq('formatDurationShort 2 h 5 m', formatDurationShort(7_500_000), '2h 5m');
eq('formatClock normalises to local HH:MM:SS',
  formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05');
eq('formatClock invalid is empty', formatClock('nope'), '');
eq('normalizeTimestamp numeric string', normalizeTimestamp('12.5'), 12.5);
eq('normalizeTimestamp invalid falls back', normalizeTimestamp(undefined, 77), 77);

console.log('\npayload tolerance');
eq('null payload', normalizeWaitsPayload(null, NOW), { now: NOW, waits: [] });
eq('waits not an array', normalizeWaitsPayload({ now: 5, waits: 'nope' }, NOW), { now: 5, waits: [] });
eq('now invalid falls back', normalizeWaitsPayload({ now: 'soon', waits: [] }, NOW).now, NOW);
const mixed = normalizeWaitsPayload({
  now: NOW,
  waits: [
    { id: 'w-1', state: 'done', label: 'a' },
    { id: '', label: 'drop me' },
    null,
    'nope',
    { id: 'w-2', state: 'not-a-state' },
  ],
}, NOW);
eq('junk entries dropped, tolerant state', mixed.waits.map((wait) => [wait.id, wait.state]), [['w-1', 'done'], ['w-2', 'running']]);
eq('empty label falls back to id', mixed.waits[1].label, 'w-2');
eq('missing kind defaults to job', mixed.waits[0].kind, 'job');
eq('missing host is null', mixed.waits[0].host, null);
eq('missing progress fields are null',
  mixed.waits[0].progress, { done: null, total: null, unit: null, note: null });

const detailed = normalizeWait({
  id: 'w-9',
  kind: 'wait',
  host: 'lthpc-v6',
  label: '   ',
  startedAt: at(-20_000),
  state: 'timeout',
  timeoutMs: '2500',
  progress: { done: '5', total: 'oops', unit: '', note: 'pages' },
  meta: { jobId: 7, condition: 'file', logPath: '/tmp/x.log', command: 'sleep 1', ignored: { deep: true } },
  lastLine: 'x'.repeat(900),
  exitCode: '0',
  error: 12,
  samples: [{ at: at(-1000), done: 4 }, { at: at(-500), done: 'bad', total: 10 }],
}, NOW);
eq('wait kept its kind', detailed.kind, 'wait');
eq('blank label falls back to id', detailed.label, 'w-9');
eq('updatedAt falls back to startedAt', detailed.updatedAt, at(-20_000));
eq('timeoutMs coerced', detailed.timeoutMs, 2500);
eq('progress done coerced, bad total null', detailed.progress.done, 5);
eq('progress total null, unit null, note kept',
  [detailed.progress.total, detailed.progress.unit, detailed.progress.note], [null, null, 'pages']);
eq('meta keeps only string fields',
  detailed.meta, { condition: 'file', logPath: '/tmp/x.log', command: 'sleep 1' });
eq('lastLine clipped to MAX_LAST_LINE', detailed.lastLine.length, MAX_LAST_LINE);
eq('exitCode coerced', detailed.exitCode, 0);
eq('non-string error dropped', detailed.error, null);
eq('samples tolerate a partial row', detailed.samples, [
  { at: at(-1000), done: 4, total: null },
  { at: at(-500), done: null, total: 10 },
]);
check('entries without id are rejected', normalizeWait({ label: 'x' }) === null);
check('null entry is rejected', normalizeWait(null) === null);

console.log('\nsamples');
const many = Array.from({ length: 300 }, (_value, index) => ({ at: index * 1000, done: index, total: 300 }));
const capped = normalizeSamples(many);
eq('sample cap', capped.length, SAMPLE_CAP);
eq('cap keeps the newest rows', [capped[0].at, capped.at(-1).at], [60_000, 299_000]);
eq('duplicate timestamp keeps newest reading',
  normalizeSamples([{ at: 1000, done: 1 }, { at: 1000, done: 2 }]),
  [{ at: 1000, done: 2, total: null }]);
eq('out-of-order rows are skipped',
  normalizeSamples([{ at: 2000, done: 2 }, { at: 1000, done: 1 }]),
  [{ at: 2000, done: 2, total: null }]);
eq('rows without numeric done/total are skipped',
  normalizeSamples([{ at: 1000 }, { at: 2000, done: 1 }]).length, 1);
eq('negative progress is nulled',
  normalizeProgress({ done: -1, total: 0 }), { done: null, total: 0, unit: null, note: null });

console.log('\nfinished window');
check('running is always visible', waitVisible(waitRow(), NOW));
check('finished 9999 ms ago is visible',
  waitVisible(waitRow({ state: 'done', updatedAt: at(-9_999) }), NOW));
check('finished at the 10 s boundary is hidden',
  waitVisible(waitRow({ state: 'done', updatedAt: at(-FINISHED_HOLD_MS) }), NOW) === false);
check('finished without updatedAt is hidden',
  waitVisible(waitRow({ state: 'error', startedAt: at(-1000), updatedAt: null }), NOW) === false);
check('future timestamp (clock skew) stays visible',
  waitVisible(waitRow({ state: 'done', updatedAt: at(+5_000) }), NOW));
check('custom hold window respected',
  waitVisible(waitRow({ state: 'done', updatedAt: at(-600) }), NOW, 500) === false);
check('waitIsFinished distinguishes running', waitIsFinished(waitRow()) === false);
eq('filterVisibleWaits keeps running + recent finished',
  filterVisibleWaits([
    waitRow({ id: 'a' }),
    waitRow({ id: 'b', state: 'done', updatedAt: at(-2_000) }),
    waitRow({ id: 'c', state: 'done', updatedAt: at(-20_000) }),
  ], NOW).map((wait) => wait.id), ['a', 'b']);

console.log('\ndock thresholds');
const hidden = dockPresentation({ waits: [], now: NOW });
eq('empty waits hide the dock', [hidden.mode, hidden.running, hidden.finished], ['hidden', 0, 0]);
eq('hidden still polls on the collapsed interval', hidden.pollMs, POLL_COLLAPSED_MS);
eq('expanded + empty stays hidden',
  dockPresentation({ expanded: true, waits: [], now: NOW }).mode, 'hidden');
const collapsed = dockPresentation({
  waits: [waitRow({ id: 'a' }), waitRow({ id: 'b', state: 'done', updatedAt: at(-1_000) })],
  now: NOW,
});
eq('collapsed counts', [collapsed.mode, collapsed.running, collapsed.finished], ['collapsed', 1, 1]);
eq('collapsed spinner with a running wait', collapsed.showSpinner, true);
eq('collapsed poll interval', collapsed.pollMs, POLL_COLLAPSED_MS);
const expanded = dockPresentation({
  expanded: true,
  waits: [waitRow({ id: 'a' }), waitRow({ id: 'b', state: 'done', updatedAt: at(-1_000) })],
  now: NOW,
});
eq('expanded mode and counts', [expanded.mode, expanded.running, expanded.finished], ['expanded', 1, 1]);
eq('expanded poll interval', expanded.pollMs, POLL_EXPANDED_MS);
eq('finished-only still shows the dock',
  dockPresentation({ waits: [waitRow({ state: 'timeout', updatedAt: at(-500) })], now: NOW }).mode, 'collapsed');
eq('finished-only after the window hides the dock',
  dockPresentation({ waits: [waitRow({ state: 'error', updatedAt: at(-11_000) })], now: NOW }).mode, 'hidden');
eq('showSpinner is false for finished-only',
  dockPresentation({ waits: [waitRow({ state: 'done', updatedAt: at(-100) })], now: NOW }).showSpinner, false);

console.log('\nprogress');
eq('progressRatio half', progressRatio({ done: 50, total: 100 }), 0.5);
eq('progressRatio clamps above one', progressRatio({ done: 120, total: 100 }), 1);
eq('progressRatio clamps below zero', progressRatio({ done: -5, total: 100 }), 0);
eq('progressRatio without total', progressRatio({ done: 5 }), null);
eq('progressRatio with zero total', progressRatio({ done: 0, total: 0 }), null);
eq('formatProgress done/total/unit', formatProgress({ done: 12, total: 100, unit: 'steps' }), '12/100 steps');
eq('formatProgress done only', formatProgress({ done: 12, unit: 'files' }), '12 files');
eq('formatProgress note only', formatProgress({ note: 'reading remote file' }), 'reading remote file');
eq('formatProgress empty', formatProgress({}), null);

console.log('\nETA maths');
const steady = computeEta([
  { at: at(-20_000), done: 10, total: 100 },
  { at: at(0), done: 30, total: 100 },
], { now: NOW, done: 30, total: 100 });
eq('steady rate 1/s and 70 s ETA', [steady.ratePerSecond, steady.etaMs, steady.reason], [1, 70_000, null]);
const stalled = computeEta([
  { at: at(-20_000), done: 30 },
  { at: at(0), done: 30 },
], { now: NOW, done: 30, total: 100 });
eq('zero rate is stalled, not Infinity', [stalled.etaMs, stalled.reason], [null, 'stalled']);
const negative = computeEta([
  { at: at(-20_000), done: 40 },
  { at: at(0), done: 10 },
], { now: NOW, done: 10, total: 100 });
eq('negative rate is stalled', [negative.etaMs, negative.reason], [null, 'stalled']);
const single = computeEta([{ at: at(0), done: 10 }], { now: NOW, done: 10, total: 100 });
eq('one sample is insufficient', [single.etaMs, single.reason, single.used], [null, 'insufficient', 1]);
const noTotal = computeEta([{ at: at(-10_000), done: 1 }], { now: NOW, done: 1, total: null });
eq('missing total is non-numeric', noTotal.reason, 'non-numeric');
const complete = computeEta([], { now: NOW, done: 100, total: 100 });
eq('done >= total is complete with zero ETA', [complete.etaMs, complete.reason, complete.remaining], [0, 'complete', 0]);
const windowed = computeEta([
  { at: at(-120_000), done: 0, total: 100 },
  { at: at(-10_000), done: 5, total: 100 },
  { at: at(0), done: 5, total: 100 },
], { now: NOW, done: 5, total: 100 });
eq('samples outside the 60 s window are ignored (stalled)', windowed.reason, 'stalled');
const skew = computeEta([
  { at: at(-10_000), done: 1, total: 100 },
  { at: at(+30_000), done: 9, total: 100 },
], { now: NOW, done: 9, total: 100 });
eq('far-future samples are ignored', skew.reason, 'insufficient');

console.log('\nsample reduction');
const spark = reduceSamples(Array.from({ length: 10 }, (_value, index) => ({
  at: index * 1000, done: index, total: 9,
})), { maxPoints: 4, now: 9_000 });
eq('reduction keeps the point cap', spark.length, 4);
eq('reduction keeps both ends', [spark[0].done, spark.at(-1).done], [0, 9]);
check('reduction stays ascending', spark.every((row, index) => index === 0 || row.at > spark[index - 1].at));
eq('reduction window filter', reduceSamples([
  { at: 0, done: 0 },
  { at: 9_000, done: 9 },
], { maxPoints: 8, windowMs: 5_000, now: 9_000 }).map((row) => row.done), [9]);
eq('reduction handles junk', reduceSamples(null).length, 0);

console.log('\nmisc');
eq('elapsedMs normal', elapsedMs(waitRow({ startedAt: at(-5_000) }), NOW), 5_000);
eq('elapsedMs clock skew clamps', elapsedMs(waitRow({ startedAt: at(+5_000) }), NOW), 0);
eq('elapsedMs missing start', elapsedMs(waitRow({ startedAt: null }), NOW), 0);
eq('pillLabelText empty', pillLabelText([]), null);
const pill = pillLabelText([
  waitRow({ id: 'a', state: 'done', label: 'finished first', updatedAt: at(-500) }),
  waitRow({ id: 'b', label: 'running second' }),
]);
eq('pill prefers the running label', pill, { count: 2, label: 'running second' });
const clipped = pillLabelText([waitRow({ label: 'x'.repeat(100) })], 10);
eq('pill clips long labels', [clipped.label.length, clipped.label.endsWith('…')], [10, true]);

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\nwait-ui-probe: ${passed}/${results.length} passed${failed > 0 ? ` (${failed} failed)` : ''}`);
if (failed > 0) process.exitCode = 1;
