// Read-only CodeMirror 6 viewer used by the file preview.
//
// CodeMirror is bundled into ../client.js by scripts/build-client.mjs, so this
// module is only used at build time (never resolved at runtime).

import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { foldGutter, HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

const FONT_STACK =
  'var(--ds-font-family-code, "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", "Microsoft YaHei", ui-monospace, monospace)';

function palette(dark) {
  return dark
    ? {
        keyword: '#c4b5fd',
        string: '#86efac',
        number: '#fdba74',
        comment: '#9ca3af',
        function: '#93c5fd',
        type: '#f0abfc',
        variable: '#e5e7eb',
        operator: '#a5b4fc',
        heading: '#f9a8d4',
        link: '#67e8f9',
      }
    : {
        keyword: '#7c3aed',
        string: '#15803d',
        number: '#b45309',
        comment: '#6b7280',
        function: '#0369a1',
        type: '#a21caf',
        variable: '#111827',
        operator: '#4338ca',
        heading: '#be185d',
        link: '#0e7490',
      };
}

function highlightStyle(colors) {
  return HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: colors.comment, fontStyle: 'italic' },
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: colors.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: colors.string },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: colors.number },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: colors.function },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.attributeName], color: colors.type },
    { tag: [tags.propertyName, tags.definition(tags.variableName)], color: colors.variable },
    { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: colors.operator },
    { tag: [tags.heading, tags.strong], color: colors.heading, fontWeight: '600' },
    { tag: [tags.link, tags.url], color: colors.link, textDecoration: 'underline' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.meta, tags.processingInstruction], color: colors.comment },
  ]);
}

function themeFor(dark, colors) {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: dark ? '#e5e7eb' : '#111827',
        fontSize: '12.5px',
        height: '100%',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: FONT_STACK,
        lineHeight: '1.6',
        overflow: 'auto',
      },
      '.cm-content': { padding: '10px 0' },
      '.cm-line': { padding: '0 12px 0 8px' },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: dark ? '#6b7280' : '#9ca3af',
        border: 'none',
        paddingLeft: '4px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', minWidth: '34px' },
      '.cm-activeLine': { backgroundColor: dark ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.025)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: dark ? '#9ca3af' : '#6b7280' },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: dark ? 'rgba(147,197,253,.25)' : 'rgba(59,130,246,.18)',
      },
      '.cm-cursor': { display: 'none' },
      '.cm-foldGutter .cm-gutterElement': { color: dark ? '#6b7280' : '#9ca3af', cursor: 'pointer' },
      '.cm-searchMatch': { backgroundColor: dark ? 'rgba(250,204,21,.25)' : 'rgba(250,204,21,.35)' },
    },
    { dark },
  );
}

async function languageFor(filename) {
  try {
    const description = LanguageDescription.matchFilename(languages, String(filename ?? ''));
    if (!description) return null;
    const support = await description.load();
    return support ?? null;
  } catch {
    return null;
  }
}

function prefersDark(host) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-layer-1').trim();
    const match = /^#([0-9a-f]{6})$/iu.exec(raw);
    if (match) {
      const value = Number.parseInt(match[1], 16);
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * Mount a read-only CodeMirror view into `host`.
 * @returns `{ destroy }` so the React wrapper can clean up.
 */
export async function mountCodeView(host, { content, name }) {
  if (!host) return null;
  const dark = prefersDark(host);
  const support = await languageFor(name);
  const state = EditorState.create({
    doc: String(content ?? ''),
    extensions: [
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Preview of ${name ?? 'file'}` }),
      themeFor(dark, palette(dark)),
      syntaxHighlighting(highlightStyle(palette(dark))),
      support ? support : [],
    ],
  });
  const view = new EditorView({ state, parent: host });
  return {
    view,
    destroy() {
      try {
        view.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}
