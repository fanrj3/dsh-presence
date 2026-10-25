// Presence panel — the browser half. The user picks a machine, walks its
// filesystem, and turns a folder into a remote workspace. The chosen workspace
// is what the agent is told to work against.

window.__ModuleLoader__.load({
  id: 'dsh-presence',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/api/presence';

    async function request(path, body) {
      const response = await fetch(API + path, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    const C = {
      soft: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    // Interaction states (hover / active / focus / motion) need real CSS: inline
    // styles cannot express pseudo-classes. One prefixed stylesheet is injected
    // once; every colour comes from the theme tokens so light and dark both work.
    const STYLE_ID = 'dsh-presence-ui';
    const CSS = `
      /* OpenDesign token contract applied on top of the DSH theme:
         motion-fast 130ms / motion-base 220ms / ease-standard cubic-bezier(.2,0,0,1);
         radii 8/12/20; focus ring 4px accent at 28%; accent hover/active via color-mix.
         Colour still comes from --dsw-alias-* so light and dark both stay correct. */
      .dp-ui {
        --dp-fast: 130ms;
        --dp-base: 220ms;
        --dp-ease: cubic-bezier(0.2, 0, 0, 1);
        --dp-radius-sm: 8px;
        --dp-radius-md: 12px;
        --dp-radius-lg: 20px;
        --dp-accent: var(--dsw-alias-brand-primary);
        --dp-accent-hover: color-mix(in oklab, var(--dp-accent), black 8%);
        --dp-accent-active: color-mix(in oklab, var(--dp-accent), black 14%);
        --dp-ring: 0 0 0 4px color-mix(in srgb, var(--dp-accent) 28%, transparent);
        --dp-elev-ring: 0 0 0 1px var(--dsw-alias-border-l1);
      }
      .dp-ui *, .dp-ui *::before, .dp-ui *::after { box-sizing: border-box; }

      /* ---- buttons: hover lifts, active presses, focus shows a 4px ring ---- */
      .dp-btn {
        font: inherit; font-size: 13px; line-height: 20px; padding: 5px 14px;
        border-radius: var(--dp-radius-sm); white-space: nowrap; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-primary);
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          border-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-base) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-btn:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2);
        border-color: var(--dsw-alias-border-l2);
        transform: translateY(-1px);
        box-shadow: var(--dp-elev-ring);
      }
      .dp-btn:active:not(:disabled) { transform: translateY(0) scale(.98); box-shadow: none; }
      .dp-btn:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-btn:disabled { opacity: .45; cursor: not-allowed; }
      .dp-btn--sm { font-size: 12px; padding: 3px 10px; }

      .dp-btn--primary {
        border-color: transparent; background: var(--dp-accent); color: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .14);
      }
      .dp-btn--primary:hover:not(:disabled) {
        background: var(--dp-accent-hover); border-color: transparent;
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, .2);
      }
      .dp-btn--primary:active:not(:disabled) { background: var(--dp-accent-active); }
      .dp-btn--primary:focus-visible { box-shadow: var(--dp-ring); }

      /* ---- card: ring at rest, soft raised shadow on hover ---- */
      .dp-card {
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dp-radius-lg);
        overflow: hidden;
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: var(--dp-elev-ring);
        transition:
          box-shadow var(--dp-base) var(--dp-ease),
          border-color var(--dp-base) var(--dp-ease);
        animation: dp-in var(--dp-base) var(--dp-ease) both;
      }
      .dp-card:hover { box-shadow: 0 8px 28px rgba(0, 0, 0, .1); border-color: var(--dsw-alias-border-l2); }
      @keyframes dp-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: none; }
      }

      /* ---- list rows ---- */
      .dp-row {
        display: flex; width: 100%; align-items: center; gap: 10px;
        padding: 8px 12px; border: 0; border-radius: var(--dp-radius-md);
        background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; text-align: left; cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-row:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .dp-row:active:not(:disabled) { transform: scale(.995); }
      .dp-row:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-row:disabled { cursor: not-allowed; }

      .dp-icon {
        width: 26px; height: 26px; border-radius: var(--dp-radius-sm); flex: 0 0 auto;
        background: var(--dsw-alias-bg-layer-2);
        display: grid; place-items: center; font-size: 13px;
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-row:hover:not(:disabled) .dp-icon { background: var(--dsw-alias-bg-base); }

      /* ---- breadcrumbs ---- */
      .dp-crumb {
        border: 0; background: transparent; padding: 3px 8px;
        border-radius: var(--dp-radius-sm); font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-secondary); cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-crumb:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .dp-crumb:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-crumb--current { color: var(--dsw-alias-label-primary); font-weight: 600; cursor: default; }
      .dp-crumb--current:hover { background: transparent; }

      /* ---- icon button (back arrow) ---- */
      .dp-iconbtn {
        width: 28px; height: 28px; border-radius: var(--dp-radius-sm); flex: 0 0 auto;
        border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font-size: 13px; line-height: 28px; cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-iconbtn:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .dp-iconbtn:active:not(:disabled) { transform: scale(.92); }
      .dp-iconbtn:focus-visible { outline: none; box-shadow: var(--dp-ring); }

      /* ---- filter input ---- */
      .dp-input {
        width: 100%; padding: 6px 10px; font-size: 12px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dp-radius-sm); outline: none;
        transition:
          border-color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-fast) var(--dp-ease),
          background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-input::placeholder { color: var(--dsw-alias-label-secondary); }
      .dp-input:hover { border-color: var(--dsw-alias-border-l2); }
      .dp-input:focus { border-color: var(--dp-accent); box-shadow: var(--dp-ring); }

      /* ---- workspace rows ---- */
      .dp-ws {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: var(--dp-radius-md);
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-ws:hover { background: var(--dsw-alias-bg-layer-2); }

      @media (prefers-reduced-motion: reduce) {
        .dp-btn, .dp-row, .dp-crumb, .dp-iconbtn, .dp-input, .dp-ws, .dp-card {
          transition: none; animation: none;
        }
        .dp-btn:hover:not(:disabled) { transform: none; }
      }

      /* loading spinner (settings panel + remote file pane) */
      @keyframes dp-spin { to { transform: rotate(360deg); } }
      .dp-spin {
        border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l1);
        border-top-color: var(--dsw-alias-brand-primary);
        animation: dp-spin .8s linear infinite;
      }

      /* -------------------------------------------------- remote file pane */
      .dp-pane {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--dsw-alias-label-primary); font-size: 13px; position: relative;
      }
      .dp-pane-toolbar {
        display: flex; align-items: center; gap: 4px;
        padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        flex: 0 0 auto;
      }
      .dp-pane-toolbar .dp-tool {
        display: inline-flex; align-items: center; gap: 4px;
        height: 26px; padding: 0 8px; border: 0; border-radius: 8px;
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; cursor: pointer;
        transition: background-color 130ms cubic-bezier(.2,0,0,1), color 130ms cubic-bezier(.2,0,0,1);
      }
      .dp-pane-toolbar .dp-tool:hover {
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .dp-pane-toolbar .dp-tool:active { transform: scale(.97); }
      .dp-pane-toolbar .dp-tool:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-pane-path {
        display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
        padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        flex: 0 0 auto;
      }
      .dp-pane-filter { padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; }
      .dp-pane-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 14px; }
      .dp-pane-row {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 5px 8px; border: 0; border-radius: 8px;
        background: transparent; color: inherit; font: inherit;
        text-align: left; cursor: pointer;
        transition: background-color 130ms cubic-bezier(.2,0,0,1), transform 120ms cubic-bezier(.2,0,0,1);
      }
      .dp-pane-row:hover { background: var(--dsw-alias-bg-layer-2); }
      .dp-pane-row:active { transform: scale(.995); }
      .dp-pane-row:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-pane-row.is-selected { background: var(--dsw-alias-bg-layer-2); }
      .dp-icon-tile {
        width: 22px; height: 22px; border-radius: 6px; flex: 0 0 auto;
        display: grid; place-items: center; font-size: 12px;
        background: var(--dsw-alias-bg-layer-2);
        transition: background-color 130ms cubic-bezier(.2,0,0,1);
      }
      .dp-pane-row:hover .dp-icon-tile { background: var(--dsw-alias-bg-base); }
      .dp-pane-row .dp-name {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-pane-row .dp-meta {
        color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
      }
      .dp-pane-actions {
        display: flex; gap: 2px; flex: 0 0 auto; opacity: .35;
        transition: opacity 130ms cubic-bezier(.2,0,0,1);
      }
      .dp-pane-row:hover .dp-pane-actions, .dp-pane-row:focus-within .dp-pane-actions { opacity: 1; }
      .dp-pane-actions .dp-iconbtn { width: 22px; height: 22px; line-height: 22px; font-size: 12px; background: transparent; color: var(--dsw-alias-label-secondary); }
      .dp-pane-actions .dp-iconbtn:hover { background: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); transform: none; }

      .dp-drop {
        position: absolute; inset: 8px; z-index: 8;
        display: flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
        border: 2px dashed var(--dsw-alias-brand-primary); border-radius: 12px;
        color: var(--dsw-alias-label-primary); font-size: 13px; pointer-events: none;
      }

      .dp-progress {
        position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 9;
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px; padding: 8px 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, .18);
        display: flex; flex-direction: column; gap: 6px;
        backdrop-filter: blur(6px);
      }
      .dp-progress-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dp-progress-track { height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l1); overflow: hidden; }
      .dp-progress-fill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width 120ms linear; }
      .dp-progress-fill.is-indeterminate { width: 40% !important; animation: dp-indeterminate 1.1s ease-in-out infinite; }
      @keyframes dp-indeterminate {
        0% { margin-left: 0; }
        50% { margin-left: 60%; }
        100% { margin-left: 0; }
      }

      /* -------------------------------------------------------- preview */
      .dp-overlay {
        position: absolute; inset: 0; z-index: 20;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, .45);
      }
      .dp-modal {
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .32);
        width: min(94%, 860px); max-height: 88%;
        display: flex; flex-direction: column; overflow: hidden;
      }
      .dp-modal-head {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .dp-modal-body {
        margin: 10px 12px; border-radius: 10px; overflow: auto;
        background: var(--dsw-alias-bg-layer-2);
      }
      .dp-modal-foot {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
      }
      .dp-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 1px 7px; border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2);
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
      }

      /* ---------------------------------------------------------- code */
      .dp-code {
        margin: 0; padding: 10px 12px; overflow: auto; max-height: 64vh;
        font-family: "JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace,
          SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; line-height: 19px; tab-size: 4;
      }
      .dp-code-line { display: flex; gap: 14px; }
      .dp-code-num {
        flex: 0 0 auto; width: 3.4em; text-align: right;
        color: var(--dsw-alias-label-secondary); opacity: .6; user-select: none;
      }
      .dp-code-text { white-space: pre; flex: 1 1 auto; }
      .dp-code-comment { color: var(--dsw-alias-label-secondary); font-style: italic; }
      .dp-code-string { color: #15803d; }
      .dp-code-keyword { color: #7c3aed; }
      .dp-code-number { color: #b45309; }
      .dp-code-function { color: #0369a1; }
      @media (prefers-color-scheme: dark) {
        .dp-code-string { color: #86efac; }
        .dp-code-keyword { color: #c4b5fd; }
        .dp-code-number { color: #fdba74; }
        .dp-code-function { color: #93c5fd; }
      }
      .dp-plain {
        margin: 0; padding: 10px 12px; overflow: auto; max-height: 64vh;
        font-family: "JetBrains Mono", "Cascadia Code", ui-monospace, SFMono-Regular,
          Menlo, Consolas, monospace;
        font-size: 12px; line-height: 19px; white-space: pre-wrap; word-break: break-word;
      }
    `;
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    function Button({ label, onClick, primary, disabled, small }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        className: [
          'dp-btn',
          small ? 'dp-btn--sm' : '',
          primary ? 'dp-btn--primary' : '',
        ].filter(Boolean).join(' '),
      }, label);
    }

    function Banner({ children }) {
      return h('div', {
        role: 'alert',
        style: {
          margin: '10px 0',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          color: C.error,
          background: C.soft,
          border: `1px solid ${C.error}`,
        },
      }, children);
    }

    /** 1536 → "1.5 KB" — compact, for a file list column. */
    function humanSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    /**
     * Remote folder browser: machine badge, breadcrumb pills, optional filter,
     * icon rows with metadata, and an inline file preview. Used both for picking
     * a new workspace folder and for browsing an existing one.
     */
    function BrowserCard({ host, crumbs, entries, dirsOnly, busy, onOpenDir, onOpenFile, onBack, preview, hint }) {
      const [filter, setFilter] = useState('');
      const current = crumbs.at(-1)?.path ?? '/';
      // Navigating to another folder starts from an unfiltered view.
      useEffect(() => {
        setFilter('');
      }, [current]);
      const dirs = entries.filter((entry) => entry.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name));
      const files = dirsOnly
        ? []
        : entries.filter((entry) => entry.kind !== 'dir').sort((a, b) => a.name.localeCompare(b.name));
      const needle = filter.trim().toLowerCase();
      const visible = [...dirs, ...files].filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
      const atRoot = crumbs.length <= 1;

      const row = (entry) => h('button', {
        key: entry.path,
        type: 'button',
        disabled: busy,
        title: entry.path,
        className: 'dp-row',
        onClick: () => (entry.kind === 'dir' ? onOpenDir(entry.path) : onOpenFile?.(entry.path)),
      }, [
        h('span', { key: 'icon', className: 'dp-icon' }, entry.kind === 'dir' ? '📁' : '📄'),
        h('span', {
          key: 'name',
          style: {
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', fontSize: 13,
          },
        }, entry.name),
        typeof entry.size === 'number' && entry.kind !== 'dir'
          ? h('span', { key: 'size', style: { color: C.muted, fontSize: 11, flex: '0 0 auto' } }, humanSize(entry.size))
          : null,
        entry.kind === 'dir'
          ? h('span', { key: 'go', style: { color: C.muted, fontSize: 14, flex: '0 0 auto' } }, '›')
          : null,
      ]);

      return h('div', {
        className: 'dp-card',
      }, [
        h('div', {
          key: 'head',
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 10px', borderBottom: `1px solid ${C.border}`,
          },
        }, [
          atRoot
            ? null
            : h('button', {
                key: 'back',
                type: 'button',
                title: '返回上层',
                disabled: busy,
                onClick: onBack,
                className: 'dp-iconbtn',
              }, '←'),
          h('span', {
            key: 'host',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5, flex: '0 0 auto',
              padding: '3px 8px', borderRadius: 999, background: C.soft, fontSize: 11, color: C.muted,
            },
          }, [
            h('span', { key: 'dot', style: { width: 6, height: 6, borderRadius: '50%', background: C.ok } }),
            host,
          ]),
          h('span', {
            key: 'path',
            style: {
              flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.muted,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right',
            },
          }, crumbs.at(-1)?.path ?? '/'),
          h('span', { key: 'count', style: { fontSize: 11, color: C.muted, flex: '0 0 auto' } }, `${visible.length} 项`),
        ]),
        h('div', {
          key: 'crumbs',
          style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1,
            padding: '6px 10px', borderBottom: `1px solid ${C.border}`,
          },
        }, crumbs.map((crumb, index) => h('span', {
          key: `${crumb.path}#${index}`,
          style: { display: 'inline-flex', alignItems: 'center', gap: 1 },
        }, [
          index > 0 ? h('span', { key: 'sep', style: { color: C.muted, fontSize: 11, padding: '0 1px' } }, '›') : null,
          h('button', {
            key: 'crumb',
            type: 'button',
            disabled: busy,
            onClick: () => onOpenDir(crumb.path),
            className: index === crumbs.length - 1 ? 'dp-crumb dp-crumb--current' : 'dp-crumb',
          }, index === 0 ? '/' : crumb.name),
        ]))),
        entries.length > 8
          ? h('div', {
              key: 'filter',
              style: { padding: '7px 10px', borderBottom: `1px solid ${C.border}` },
            }, h('input', {
              value: filter,
              placeholder: '筛选当前文件夹…',
              onChange: (event) => setFilter(event.target.value),
              className: 'dp-input',
            }))
          : null,
        h('div', {
          key: 'list',
          style: { maxHeight: 330, overflowY: 'auto', padding: 6 },
        }, visible.length === 0
          ? h('div', {
              style: { padding: '26px 12px', textAlign: 'center', color: C.muted, fontSize: 12 },
            }, [
              h('div', { key: 'i', style: { fontSize: 20, marginBottom: 6, opacity: 0.7 } }, '📂'),
              h('div', { key: 't' }, needle ? '没有匹配的条目' : dirsOnly ? '这个文件夹里没有子文件夹' : '空文件夹'),
            ])
          : visible.map(row)),
        preview
          ? h('div', { key: 'preview', style: { borderTop: `1px solid ${C.border}` } }, [
              h('div', {
                key: 'head',
                style: {
                  padding: '7px 10px', fontSize: 11, color: C.muted,
                  display: 'flex', gap: 8, alignItems: 'center',
                },
              }, [
                h('span', { key: 'label', style: { flex: '0 0 auto' } }, '预览'),
                h('span', {
                  key: 'path',
                  style: {
                    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', fontFamily: MONO,
                  },
                }, preview.path),
                preview.truncated ? h('span', { key: 'more', style: { flex: '0 0 auto' } }, '已截断') : null,
              ]),
              h('pre', {
                key: 'content',
                style: {
                  margin: 0, padding: '0 12px 12px', maxHeight: 280, overflow: 'auto',
                  fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', fontFamily: MONO,
                },
              }, preview.content),
            ])
          : null,
        hint
          ? h('div', {
              key: 'hint',
              style: {
                padding: '7px 10px', borderTop: `1px solid ${C.border}`,
                fontSize: 11, color: C.muted,
              },
            }, hint)
          : null,
      ]);
    }

    // ------------------------------------------------------------- spinner
    function Spinner({ label, size = 16 }) {
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 12 },
      }, [
        h('span', {
          key: 'ring',
          className: 'dp-spin',
          style: { width: size, height: size, display: 'inline-block', flex: '0 0 auto' },
        }),
        label ? h('span', { key: 'label' }, label) : null,
      ]);
    }

    // ------------------------------------------------- remote file browser
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
    const TEXT_EXTENSIONS = new Set([
      'txt', 'md', 'markdown', 'json', 'jsonc', 'log', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'conf',
      'cfg', 'xml', 'tex', 'properties', 'gitignore', 'env', 'lock', 'make', 'mk',
    ]);
    const CODE_EXTENSIONS = new Set([
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp',
      'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'sql', 'html', 'htm', 'css', 'scss', 'less',
      'gradle', 'dockerfile', 'vue', 'svelte', 'lua', 'pl', 'swift', 'dart',
    ]);
    const CODE_KEYWORDS = new Set([
      'if', 'else', 'elif', 'for', 'while', 'def', 'class', 'return', 'import', 'from', 'try', 'except',
      'finally', 'with', 'as', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass',
      'raise', 'yield', 'global', 'nonlocal', 'assert', 'del', 'break', 'continue', 'async', 'await', 'const',
      'let', 'var', 'function', 'new', 'typeof', 'instanceof', 'export', 'default', 'extends', 'super', 'switch',
      'case', 'do', 'throw', 'catch', 'interface', 'enum', 'implements', 'public', 'private', 'protected',
      'static', 'final', 'void', 'int', 'float', 'double', 'bool', 'char', 'string', 'struct', 'typedef',
      'unsigned', 'signed', 'long', 'short', 'self', 'this', 'null', 'undefined', 'true', 'false', 'package',
      'func', 'type', 'map', 'range', 'defer', 'go', 'chan', 'select', 'use', 'mod', 'pub', 'fn', 'impl',
      'match', 'mut', 'print', 'end',
    ]);
    const CODE_LINE_RE = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

    function extensionOf(name) {
      if (typeof name !== 'string') return '';
      const index = name.lastIndexOf('.');
      return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
    }

    function isImageName(name) {
      return IMAGE_EXTENSIONS.has(extensionOf(name));
    }

    function isCodeName(name) {
      return CODE_EXTENSIONS.has(extensionOf(name));
    }

    function isTextName(name) {
      return TEXT_EXTENSIONS.has(extensionOf(name)) || isCodeName(name) || extensionOf(name) === '';
    }

    function rawUrlFor(host, path, download) {
      const query = `host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`;
      return `${API}/raw?${query}${download ? '&download=1' : ''}`;
    }

    function formatMoment(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const date = new Date(ms);
      const ago = Date.now() - ms;
      if (ago >= 0 && ago < 60_000) return '刚刚';
      if (ago >= 0 && ago < 3_600_000) return `${Math.floor(ago / 60_000)} 分钟前`;
      if (ago >= 0 && ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} 小时前`;
      return `${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0, 5)}`;
    }

    /** Split one code line into coloured tokens (no HTML, so nothing can inject). */
    function tokenizeCodeLine(line) {
      const tokens = [];
      let index = 0;
      CODE_LINE_RE.lastIndex = 0;
      let match = CODE_LINE_RE.exec(line);
      while (match !== null) {
        if (match.index > index) tokens.push({ kind: 'plain', text: line.slice(index, match.index) });
        if (match[1]) tokens.push({ kind: 'comment', text: match[1] });
        else if (match[2]) tokens.push({ kind: 'string', text: match[2] });
        else if (match[3]) tokens.push({ kind: 'number', text: match[3] });
        else {
          const word = match[4];
          const after = line.slice(match.index + word.length);
          if (CODE_KEYWORDS.has(word)) tokens.push({ kind: 'keyword', text: word });
          else if (/^\s*\(/u.test(after)) tokens.push({ kind: 'function', text: word });
          else tokens.push({ kind: 'plain', text: word });
        }
        index = match.index + match[0].length;
        match = CODE_LINE_RE.exec(line);
      }
      if (index < line.length) tokens.push({ kind: 'plain', text: line.slice(index) });
      return tokens;
    }

    /** Line-numbered code view with lightweight highlighting. */
    function CodeView({ content }) {
      const lines = String(content ?? '').split('\n');
      return h('pre', { className: 'dp-code' }, h('code', null, lines.map((line, lineIndex) => h('div', {
        key: lineIndex,
        className: 'dp-code-line',
      }, [
        h('span', { key: 'n', className: 'dp-code-num' }, String(lineIndex + 1)),
        h('span', { key: 't', className: 'dp-code-text' },
          line === ''
            ? ' '
            : tokenizeCodeLine(line).map((token, tokenIndex) => h('span', {
                key: tokenIndex,
                className: `dp-code-${token.kind}`,
              }, token.text))),
      ]))));
    }

    /** Save a URL through the native dialog when available, else a download link. */
    async function saveUrlAs(url, name) {
      try {
        if (typeof window.showSaveFilePicker === 'function') {
          const handle = await window.showSaveFilePicker({ suggestedName: name });
          const writable = await handle.createWritable();
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.body.pipeTo(writable);
          return true;
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
        if (error instanceof TypeError) return false; // picker unavailable: fall through
        throw error;
      }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    }

    function saveRemoteFile(host, path, name) {
      return saveUrlAs(rawUrlFor(host, path, true), name);
    }

    /** Upload one File to a remote directory, reporting byte progress. */
    function uploadRemoteFile(host, dir, file, onProgress, nameOverride) {
      return new Promise((resolve, reject) => {
        const name = nameOverride ?? file.name;
        const query =
          `host=${encodeURIComponent(host)}&dir=${encodeURIComponent(dir)}` +
          `&name=${encodeURIComponent(name)}`;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/upload?${query}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable) onProgress(event.loaded);
        };
        xhr.onload = () => {
          const data = xhr.response;
          if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) resolve(data);
          else reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('上传失败：网络错误'));
        xhr.send(file);
      });
    }

    async function mkdirRemote(host, path) {
      return request(`/mkdir?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`, {});
    }

    /** Recursively read a dropped/picked directory into a flat file list. */
    async function readEntryTree(entry, prefix, out) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        out.push({ file, relative: prefix ? `${prefix}/${file.name}` : file.name });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch || batch.length === 0) break;
        for (const child of batch) await readEntryTree(child, childPrefix, out);
      }
    }

    async function collectDroppedFiles(dataTransfer) {
      const out = [];
      const items = Array.from(dataTransfer.items ?? []);
      let usedEntries = false;
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          usedEntries = true;
          await readEntryTree(entry, '', out);
        } else {
          const file = item.getAsFile();
          if (file) out.push({ file, relative: file.name });
        }
      }
      if (!usedEntries && out.length === 0) {
        for (const file of Array.from(dataTransfer.files ?? [])) out.push({ file, relative: file.name });
      }
      return out;
    }

    /** Upload files (with folder structure) under `basePath`. */
    async function uploadFilesTree(host, basePath, items, onProgress) {
      const base = basePath.replace(/\/+$/u, '') || '/';
      const totalBytes = items.reduce((sum, item) => sum + (item.file.size ?? 0), 0);
      let sentBytes = 0;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const parts = item.relative.split('/');
        const name = parts.pop();
        const relativeDir = parts.join('/');
        const dir = relativeDir ? `${base}/${relativeDir}` : base;
        if (relativeDir) await mkdirRemote(host, dir);
        onProgress?.({ done: index, total: items.length, bytes: sentBytes, totalBytes, current: item.relative });
        await uploadRemoteFile(host, dir, item.file, (loaded) => {
          onProgress?.({ done: index, total: items.length, bytes: sentBytes + loaded, totalBytes, current: item.relative });
        }, name);
        sentBytes += item.file.size ?? 0;
      }
      onProgress?.({ done: items.length, total: items.length, bytes: sentBytes, totalBytes, current: '' });
      return { files: items.length, bytes: sentBytes };
    }

    /**
     * Download a remote directory into a real local folder tree. The web layer
     * cannot drag a DIRECTORY out (Chromium's DownloadURL only carries one file),
     * so the equivalent of Xftp's "download folder" is picking a destination
     * folder and materialising the tree there.
     */
    async function downloadFolderTree(host, remotePath, name, onProgress) {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('当前环境不支持选择本地文件夹（需要 File System Access API）');
      }
      const destination = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (!destination) return null;
      const rootHandle = await destination.getDirectoryHandle(name, { create: true });
      const progress = { files: 0, bytes: 0, current: name };
      const walk = async (dirPath, handle) => {
        const data = await request(`/entries?host=${encodeURIComponent(host)}&path=${encodeURIComponent(dirPath)}`);
        for (const entry of data.entries ?? []) {
          if (entry.name === '.' || entry.name === '..') continue;
          if (entry.kind === 'dir') {
            const sub = await handle.getDirectoryHandle(entry.name, { create: true });
            await walk(entry.path, sub);
            continue;
          }
          progress.current = entry.path;
          onProgress?.({ ...progress });
          const fileHandle = await handle.getFileHandle(entry.name, { create: true });
          const writable = await fileHandle.createWritable();
          try {
            const response = await fetch(rawUrlFor(host, entry.path, true));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await response.body.pipeTo(writable);
          } catch (error) {
            await writable.abort?.().catch?.(() => {});
            throw new Error(`${entry.path}: ${error.message}`);
          }
          progress.files += 1;
          progress.bytes += entry.size ?? 0;
          onProgress?.({ ...progress });
        }
      };
      await walk(remotePath, rootHandle);
      return progress;
    }

    /**
     * The right-bar file browser: a remote directory pane that accepts dropped
     * files and folders (upload), previews images/text/code, and downloads
     * files or whole folders to disk.
     */
    function RemoteFilesPanel({ sessionId }) {
      const [hosts, setHosts] = useState([]);
      const [host, setHost] = useState(null);
      const [path, setPath] = useState('/');
      const [crumbs, setCrumbs] = useState([]);
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [filter, setFilter] = useState('');
      const [dragOver, setDragOver] = useState(false);
      const [job, setJob] = useState(null);
      const [preview, setPreview] = useState(null);
      const [selected, setSelected] = useState(null);
      const [creatingFolder, setCreatingFolder] = useState(null);
      const fileInput = useRef(null);
      const folderInput = useRef(null);
      const rootRef = useRef(null);
      const dropHandler = useRef(null);

      const load = useCallback(async (nextHost, nextPath) => {
        if (!nextHost) return;
        setLoading(true);
        setError(null);
        try {
          const query = `host=${encodeURIComponent(nextHost)}&path=${encodeURIComponent(nextPath)}`;
          const data = await request(`/entries?${query}`);
          setHost(nextHost);
          setPath(data.path);
          setCrumbs(data.crumbs ?? []);
          setEntries(data.entries ?? []);
          setSelected(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }, []);

      // First open: follow the session's workspace, else the first registered one.
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const state = await request('/state');
            if (cancelled) return;
            setHosts(state.hosts ?? []);
            let target = null;
            if (sessionId) {
              try {
                const context = await request(`/context?sessionId=${encodeURIComponent(sessionId)}`);
                target = context.workspace ?? null;
              } catch {
                target = null;
              }
            }
            if (!target) {
              const listing = await request('/workspaces');
              target = (listing.workspaces ?? [])[0] ?? null;
            }
            if (cancelled) return;
            if (target) await load(target.host, target.path);
            else {
              setLoading(false);
              setError('还没有远程工作区：先到「设置 → Presence」新建一个。');
            }
          } catch (err) {
            if (!cancelled) {
              setError(err.message);
              setLoading(false);
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [sessionId, load]);

      const visible = entries.filter((entry) => {
        if (!filter.trim()) return true;
        return entry.name.toLowerCase().includes(filter.trim().toLowerCase());
      });

      const startUpload = async (items) => {
        if (!items || items.length === 0) return;
        if (!host) {
          setError('还没有选择远程目录');
          return;
        }
        setJob({ kind: 'upload', label: `上传 0/${items.length}`, percent: 0, detail: '' });
        try {
          const result = await uploadFilesTree(host, path, items, (progress) => {
            setJob({
              kind: 'upload',
              label: `上传 ${progress.done}/${progress.total}`,
              percent: Math.round((progress.bytes / Math.max(1, progress.totalBytes)) * 100),
              detail: progress.current,
            });
          });
          setJob({ kind: 'done', label: `已上传 ${result.files} 个文件`, percent: 100, detail: humanSize(result.bytes) });
          await load(host, path);
          setTimeout(() => setJob(null), 2500);
        } catch (err) {
          setError(err.message);
          setJob(null);
        }
      };

      // Capture-phase drop handling: the chat composer also listens for drops on
      // the document, and without stopping propagation a dropped file both
      // uploads here AND attaches to the conversation.
      useEffect(() => {
        dropHandler.current = startUpload;
      });
      useEffect(() => {
        const inside = (event) => {
          const root = rootRef.current;
          return Boolean(root) && event.target instanceof Node && root.contains(event.target);
        };
        const onDragOver = (event) => {
          if (!inside(event)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        };
        const onDragLeave = (event) => {
          if (!inside(event)) return;
          event.stopPropagation();
          setDragOver(false);
        };
        const onDrop = (event) => {
          if (!inside(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          const dataTransfer = event.dataTransfer;
          if (!dataTransfer) return;
          collectDroppedFiles(dataTransfer)
            .then((items) => dropHandler.current?.(items))
            .catch((err) => setError(err.message));
        };
        window.addEventListener('dragenter', onDragOver, true);
        window.addEventListener('dragover', onDragOver, true);
        window.addEventListener('dragleave', onDragLeave, true);
        window.addEventListener('drop', onDrop, true);
        return () => {
          window.removeEventListener('dragenter', onDragOver, true);
          window.removeEventListener('dragover', onDragOver, true);
          window.removeEventListener('dragleave', onDragLeave, true);
          window.removeEventListener('drop', onDrop, true);
        };
      }, []);

      const openEntry = async (entry) => {
        if (entry.kind === 'dir') {
          await load(host, entry.path);
          return;
        }
        if (isImageName(entry.name)) {
          setPreview({ name: entry.name, path: entry.path, size: entry.size, kind: 'image', url: rawUrlFor(host, entry.path, false) });
          return;
        }
        if (isTextName(entry.name) || entry.size <= 256 * 1024) {
          try {
            setPreview({ name: entry.name, path: entry.path, size: entry.size, kind: 'loading' });
            const data = await request(`/file?host=${encodeURIComponent(host)}&path=${encodeURIComponent(entry.path)}`);
            setPreview({
              name: entry.name,
              path: entry.path,
              size: entry.size,
              kind: 'text',
              content: data.content,
              truncated: data.truncated,
              code: isCodeName(entry.name),
            });
            return;
          } catch (err) {
            setPreview(null);
            setError(`${err.message}（将改用保存对话框）`);
          }
        }
        setPreview(null);
        await saveRemoteFile(host, entry.path, entry.name).catch((err) => setError(err.message));
      };

      const downloadEntry = async (entry) => {
        try {
          if (entry.kind === 'dir') {
            setJob({ kind: 'download', label: `下载文件夹 ${entry.name}`, percent: null, detail: '选择本地目标文件夹…' });
            const result = await downloadFolderTree(host, entry.path, entry.name, (progress) => {
              setJob({
                kind: 'download',
                label: `下载 ${progress.files} 个文件`,
                percent: null,
                detail: `${progress.current} · ${humanSize(progress.bytes)}`,
              });
            });
            if (result) {
              setJob({ kind: 'done', label: `已下载 ${result.files} 个文件`, percent: 100, detail: humanSize(result.bytes) });
              setTimeout(() => setJob(null), 2500);
            } else {
              setJob(null);
            }
            return;
          }
          await saveRemoteFile(host, entry.path, entry.name);
        } catch (err) {
          setError(err.message);
          setJob(null);
        }
      };

      const createFolder = async () => {
        const name = (creatingFolder ?? '').trim();
        if (!name) {
          setCreatingFolder(null);
          return;
        }
        const target = `${path.replace(/\/+$/u, '')}/${name}`;
        try {
          await mkdirRemote(host, target);
          setCreatingFolder(null);
          await load(host, path);
        } catch (err) {
          setError(err.message);
        }
      };

      const removeEntry = async (entry) => {
        if (!window.confirm(`把「${entry.name}」移到远端回收站？（可用 presence_trash 恢复）`)) return;
        try {
          await request(`/remove?host=${encodeURIComponent(host)}&path=${encodeURIComponent(entry.path)}`, {});
          await load(host, path);
        } catch (err) {
          setError(err.message);
        }
      };

      const actions = (entry) => [
        h('button', {
          key: 'save',
          type: 'button',
          title: entry.kind === 'dir' ? '下载文件夹到本地' : '保存到本地',
          className: 'dp-iconbtn',
          onClick: (event) => {
            event.stopPropagation();
            downloadEntry(entry);
          },
        }, '↓'),
        h('button', {
          key: 'delete',
          type: 'button',
          title: '移到回收站',
          className: 'dp-iconbtn',
          onClick: (event) => {
            event.stopPropagation();
            removeEntry(entry);
          },
        }, '🗑'),
      ];

      return h('div', {
        ref: rootRef,
        className: 'dp-pane',
        style: { position: 'relative', flex: '1 1 auto', minHeight: 0, height: '100%' },
      }, [
        h('div', { key: 'toolbar', className: 'dp-pane-toolbar' }, [
          h('select', {
            key: 'host',
            className: 'dp-input',
            style: { width: 'auto', maxWidth: 120, height: 26, padding: '0 6px', fontSize: 12 },
            value: host ?? '',
            onChange: (event) => {
              const next = event.target.value;
              if (next) load(next, '/');
            },
          }, hosts.map((item) => h('option', { key: item.alias, value: item.alias }, item.alias))),
          h('div', { key: 'spacer', style: { flex: 1 } }),
          h('button', {
            key: 'upload-file',
            type: 'button',
            className: 'dp-tool',
            title: '上传文件',
            onClick: () => fileInput.current?.click(),
          }, '＋ 文件'),
          h('button', {
            key: 'upload-folder',
            type: 'button',
            className: 'dp-tool',
            title: '上传文件夹',
            onClick: () => folderInput.current?.click(),
          }, '＋ 文件夹'),
          h('button', {
            key: 'mkdir',
            type: 'button',
            className: 'dp-tool',
            title: '新建文件夹',
            onClick: () => setCreatingFolder(''),
          }, '新建'),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dp-tool',
            title: '刷新',
            onClick: () => load(host, path),
          }, '⟳'),
          h('input', {
            key: 'file-input',
            ref: fileInput,
            type: 'file',
            multiple: true,
            style: { display: 'none' },
            onChange: async (event) => {
              const files = Array.from(event.target.files ?? []).map((file) => ({ file, relative: file.name }));
              event.target.value = '';
              await startUpload(files);
            },
          }),
          h('input', {
            key: 'folder-input',
            ref: folderInput,
            type: 'file',
            multiple: true,
            webkitdirectory: 'true',
            directory: 'true',
            style: { display: 'none' },
            onChange: async (event) => {
              const files = Array.from(event.target.files ?? []);
              const items = files.map((file) => ({
                file,
                relative: (file.webkitRelativePath || file.name).replace(/\\/gu, '/'),
              }));
              event.target.value = '';
              await startUpload(items);
            },
          }),
        ]),
        h('div', {
          key: 'pathbar',
          className: 'dp-pane-path',
        }, crumbs.map((crumb, index) => h('span', { key: `${crumb.path}#${index}`, style: { display: 'inline-flex', alignItems: 'center' } }, [
          index > 0 ? h('span', { key: 'sep', style: { color: C.muted, fontSize: 11, padding: '0 1px' } }, '›') : null,
          h('button', {
            key: 'crumb',
            type: 'button',
            className: index === crumbs.length - 1 ? 'dp-crumb dp-crumb--current' : 'dp-crumb',
            onClick: () => load(host, crumb.path),
          }, index === 0 ? '/' : crumb.name),
        ]))),
        h('div', { key: 'filter', className: 'dp-pane-filter' },
          h('input', {
            className: 'dp-input',
            value: filter,
            placeholder: '筛选当前目录…',
            onChange: (event) => setFilter(event.target.value),
          })),
        error
          ? h('div', {
              key: 'error',
              style: { margin: '8px 10px', padding: '6px 10px', borderRadius: 8, background: C.soft, color: C.error, fontSize: 12 },
            }, error)
          : null,
        creatingFolder !== null
          ? h('div', {
              key: 'newfolder',
              style: { display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}` },
            }, [
              h('input', {
                key: 'name',
                className: 'dp-input',
                autoFocus: true,
                placeholder: '文件夹名称',
                value: creatingFolder,
                onChange: (event) => setCreatingFolder(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') createFolder();
                  if (event.key === 'Escape') setCreatingFolder(null);
                },
              }),
              Button({ label: '创建', onClick: createFolder, primary: true, small: true }),
            ])
          : null,
        h('div', { key: 'list', className: 'dp-pane-list' },
          loading
            ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '28px 0' } }, h(Spinner, { label: '加载中…' }))
            : visible.length === 0
              ? h('div', { style: { textAlign: 'center', color: C.muted, padding: '28px 0', fontSize: 12 } }, '这个目录是空的')
              : visible.map((entry) => h('div', {
                  key: entry.path,
                  className: `dp-pane-row${selected === entry.path ? ' is-selected' : ''}`,
                  role: 'button',
                  tabIndex: 0,
                  title: entry.kind === 'dir' ? `${entry.path}（双击进入，↓ 下载文件夹）` : entry.path,
                  draggable: entry.kind !== 'dir',
                  onDragStart: (event) => {
                    if (entry.kind === 'dir') return;
                    try {
                      event.dataTransfer.setData(
                        'DownloadURL',
                        `application/octet-stream:${entry.name}:${new URL(rawUrlFor(host, entry.path, true), window.location.href).href}`,
                      );
                      event.dataTransfer.effectAllowed = 'copy';
                    } catch {
                      /* the OS may refuse; the ↓ button still works */
                    }
                  },
                  onClick: () => setSelected(entry.path),
                  onDoubleClick: () => openEntry(entry),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') openEntry(entry);
                  },
                }, [
                  h('span', { key: 'icon', className: 'dp-icon-tile' }, entry.kind === 'dir' ? '📁' : (isImageName(entry.name) ? '🖼' : '📄')),
                  h('span', { key: 'name', className: 'dp-name' }, entry.name),
                  h('span', { key: 'size', className: 'dp-meta' }, entry.kind === 'dir' ? '' : humanSize(entry.size)),
                  h('span', { key: 'time', className: 'dp-meta', style: { width: 62, textAlign: 'right' } }, formatMoment(entry.mtime)),
                  h('span', { key: 'actions', className: 'dp-pane-actions' }, actions(entry)),
                ]))),
        dragOver
          ? h('div', { key: 'drop', className: 'dp-drop' }, `松开把文件 / 文件夹上传到 ${path}`)
          : null,
        job
          ? h('div', { key: 'job', className: 'dp-progress' }, [
              h('div', { key: 'head', className: 'dp-progress-head' }, [
                h('span', { key: 'label', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, job.label),
                job.kind === 'done'
                  ? h('span', { key: 'ok', style: { color: C.ok } }, '完成')
                  : h('span', { key: 'pct' }, job.percent === null ? '' : `${job.percent}%`),
              ]),
              h('div', { key: 'track', className: 'dp-progress-track' },
                h('div', {
                  key: 'fill',
                  className: job.percent === null ? 'dp-progress-fill is-indeterminate' : 'dp-progress-fill',
                  style: { width: `${job.percent ?? 40}%` },
                })),
              job.detail
                ? h('div', {
                    key: 'detail',
                    style: {
                      fontSize: 10.5, color: C.muted, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left',
                    },
                  }, job.detail)
                : null,
            ])
          : null,
        preview
          ? h('div', {
              key: 'overlay',
              className: 'dp-overlay',
              onClick: () => setPreview(null),
            }, h('div', {
              key: 'modal',
              className: 'dp-modal',
              onClick: (event) => event.stopPropagation(),
            }, [
              h('div', { key: 'head', className: 'dp-modal-head' }, [
                h('span', { key: 'icon', className: 'dp-icon-tile' }, isImageName(preview.name) ? '🖼' : '📄'),
                h('span', {
                  key: 'name',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 },
                }, preview.name),
                preview.kind === 'text'
                  ? h('span', { key: 'chip', className: 'dp-chip' }, preview.code ? extensionOf(preview.name).toUpperCase() || 'CODE' : '文本')
                  : null,
                preview.kind === 'image' ? h('span', { key: 'chip', className: 'dp-chip' }, '图片') : null,
                h('span', { key: 'size', style: { color: C.muted, fontSize: 11 } }, humanSize(preview.size)),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'dp-iconbtn',
                  onClick: () => setPreview(null),
                }, '×'),
              ]),
              h('div', { key: 'body', className: 'dp-modal-body' },
                preview.kind === 'loading'
                  ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: 24 } }, h(Spinner, { label: '读取中…' }))
                  : preview.kind === 'image'
                    ? h('img', { src: preview.url, style: { maxWidth: '100%', display: 'block', margin: '0 auto' } })
                    : preview.code
                      ? h(CodeView, { content: preview.content })
                      : h('pre', { className: 'dp-plain' }, preview.content ?? '')),
              h('div', { key: 'foot', className: 'dp-modal-foot' }, [
                h('span', {
                  key: 'path',
                  style: {
                    flex: 1, minWidth: 0, color: C.muted, fontSize: 11,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  },
                }, preview.path),
                preview.truncated ? h('span', { key: 'trunc', style: { color: C.muted, fontSize: 11 } }, '仅显示前 256 KiB') : null,
                Button({
                  label: '保存到本地',
                  small: true,
                  onClick: () => saveRemoteFile(host, preview.path, preview.name).catch((err) => setError(err.message)),
                }),
              ]),
            ]))
          : null,
      ]);
    }

    function PresencePanel() {
      const [mode, setMode] = useState('list');
      const [hosts, setHosts] = useState([]);
      const [workspaces, setWorkspaces] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [browse, setBrowse] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [pendingHost, setPendingHost] = useState(null);
      const [password, setPassword] = useState('');
      const [remember, setRemember] = useState(false);
      const [files, setFiles] = useState(null);
      const [preview, setPreview] = useState(null);
      const [loadingList, setLoadingList] = useState(true);

      const loadList = useCallback(async () => {
        try {
          const [state, listing] = await Promise.all([request('/state'), request('/workspaces')]);
          setHosts(state.hosts ?? []);
          setWorkspaces(listing.workspaces ?? []);
          setActiveId(listing.active ?? null);
          setError(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoadingList(false);
        }
      }, []);

      useEffect(() => {
        ensureStyles();
        loadList();
      }, [loadList]);

      const openBrowser = useCallback(async (host, path) => {
        setBusy(true);
        setError(null);
        try {
          const query = new URLSearchParams({ host });
          if (path) query.set('path', path);
          const data = await request(`/browse?${query.toString()}`);
          setBrowse(data);
          setMode('browse');
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      /** Browse the files of an existing workspace. */
      const openFiles = useCallback(async (host, path) => {
        setBusy(true);
        setError(null);
        setPreview(null);
        try {
          const query = new URLSearchParams({ host });
          if (path) query.set('path', path);
          const data = await request(`/browse?${query.toString()}`);
          setFiles(data);
          setMode('files');
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const openFile = useCallback(async (host, path) => {
        setBusy(true);
        setError(null);
        try {
          const query = new URLSearchParams({ host, path });
          setPreview(await request(`/file?${query.toString()}`));
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      /** Connect first, so a password host asks before it tries to browse. */
      const pickHost = useCallback(async (host, secret) => {
        setBusy(true);
        setError(null);
        try {
          await request('/connect', { host, password: secret ?? '', remember: secret ? remember : false });
          setPendingHost(null);
          setPassword('');
          setRemember(false);
          await openBrowser(host);
        } catch (err) {
          if (/password|authenticat/i.test(err.message)) {
            setPendingHost(host);
            setError(err.message);
          } else {
            setError(err.message);
          }
        } finally {
          setBusy(false);
        }
      }, [openBrowser, remember]);

      const chooseFolder = useCallback(async () => {
        if (!browse) return;
        setBusy(true);
        setError(null);
        try {
          await request('/workspaces', { host: browse.host, path: browse.path });
          await loadList();
          setMode('list');
          setBrowse(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, [browse, loadList]);

      const activate = useCallback(async (id) => {
        setBusy(true);
        try {
          const result = await request('/workspaces', { activate: id });
          setActiveId(result.active ?? null);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const remove = useCallback(async (id) => {
        setBusy(true);
        try {
          const result = await request('/workspaces', { remove: id });
          setWorkspaces(result.workspaces ?? []);
          if (activeId === id) setActiveId(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, [activeId]);

      const header = h('header', {
        style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 },
      }, [
        h('h2', { key: 'title', style: { fontSize: 16, fontWeight: 600, margin: 0 } }, '远程工作区'),
        h('span', {
          key: 'count',
          style: { color: C.muted, fontSize: 12 },
        }, mode === 'browse'
          ? `${browse?.host ?? ''} · ${browse?.entries?.length ?? 0} 个文件夹`
          : `${workspaces.length} 个工作区`),
        h('div', { key: 'spacer', style: { flex: 1 } }),
        mode === 'list'
          ? Button({ label: '新建', onClick: () => { setMode('new'); setError(null); }, primary: true })
          : Button({ label: '返回', onClick: () => { setMode('list'); setBrowse(null); setFiles(null); setPreview(null); setError(null); } }),
      ]);

      let body;

      if (mode === 'new') {
        body = h('div', { style: { marginTop: 12, borderTop: `1px solid ${C.border}` } },
          hosts.length === 0
            ? h('p', { style: { color: C.muted, fontSize: 13, padding: '12px 0' } }, '~/.ssh/config 里没有可用的机器。')
            : hosts.flatMap((host) => {
                const row = h('button', {
                  key: host.alias,
                  type: 'button',
                  onClick: () => pickHost(host.alias),
                  disabled: busy,
                  style: {
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 8px',
                    border: 'none',
                    borderBottom: `1px solid ${C.border}`,
                    background: 'transparent',
                    color: C.text,
                    font: 'inherit',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: busy ? 'default' : 'pointer',
                  },
                }, [
                  h('span', {
                    key: 'dot',
                    style: {
                      width: 8, height: 8, borderRadius: '50%',
                      background: host.connected ? C.ok : C.muted,
                      flex: '0 0 auto',
                    },
                  }),
                  h('span', { key: 'alias', style: { fontWeight: 600, minWidth: 110 } }, host.alias),
                  h('span', {
                    key: 'where',
                    style: { color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, `${host.user ?? '?'}@${host.hostname}:${host.port}`),
                  h('span', { key: 'go', style: { color: C.muted } }, '选择 ›'),
                ]);
                if (pendingHost !== host.alias) return [row];
                return [
                  row,
                  h('div', {
                    key: `${host.alias}:password`,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      padding: '10px 12px', background: C.soft, borderBottom: `1px solid ${C.border}`,
                    },
                  }, [
                    h('input', {
                      key: 'pwd',
                      type: 'password',
                      value: password,
                      placeholder: `${host.alias} 的 SSH 密码`,
                      autoFocus: true,
                      onChange: (event) => setPassword(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && password) pickHost(host.alias, password);
                      },
                      style: {
                        flex: '1 1 200px', minWidth: 160, font: 'inherit', fontSize: 13,
                        padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
                        background: 'var(--dsw-alias-bg-layer-1)', color: C.text,
                      },
                    }),
                    h('label', {
                      key: 'remember',
                      style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted },
                    }, [
                      h('input', {
                        key: 'checkbox', type: 'checkbox', checked: remember,
                        onChange: (event) => setRemember(event.target.checked),
                      }),
                      h('span', { key: 'label' }, '记住这台'),
                    ]),
                    Button({ label: '连接', onClick: () => pickHost(host.alias, password), primary: true, disabled: !password || busy }),
                  ]),
                ];
              }));
      } else if (mode === 'browse' && browse) {
        const crumbs = browse.crumbs ?? [];
        const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : undefined;
        body = h('div', { style: { marginTop: 12 } }, [
          h(BrowserCard, {
            key: 'browser',
            host: browse.host,
            crumbs,
            entries: browse.entries ?? [],
            dirsOnly: true,
            busy,
            onOpenDir: (path) => openBrowser(browse.host, path),
            onBack: () => (parent ? openBrowser(browse.host, parent) : undefined),
            hint: '点击文件夹进入下一层；选好后点下面的「用这个文件夹」',
          }),
          h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 } }, [
            h('div', { key: 'spacer', style: { flex: 1 } }),
            Button({ label: busy ? '创建中…' : '用这个文件夹', onClick: chooseFolder, primary: true, disabled: busy }),
          ]),
        ]);
      } else if (mode === 'files' && files) {
        const crumbs = files.crumbs ?? [];
        const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : undefined;
        body = h('div', { style: { marginTop: 12 } }, [
          h(BrowserCard, {
            key: 'browser',
            host: files.host,
            crumbs,
            entries: files.entries ?? [],
            busy,
            onOpenDir: (path) => openFiles(files.host, path),
            onOpenFile: (path) => openFile(files.host, path),
            onBack: () => (parent ? openFiles(files.host, parent) : undefined),
            preview,
            hint: '点击文件夹进入 · 点击文件在下方预览',
          }),
        ]);
      } else {
        // Group the remote workspaces by machine: one header per host carrying
        // that machine's connection state, then the folders it owns. The dot is
        // about the MACHINE being connected, not about a "current workspace".
        const byHost = new Map();
        for (const workspace of workspaces) {
          if (!byHost.has(workspace.host)) byHost.set(workspace.host, []);
          byHost.get(workspace.host).push(workspace);
        }
        const hostState = new Map(hosts.map((host) => [host.alias, host]));
        const groups = [...byHost.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        body = h('div', { style: { marginTop: 12 } },
          workspaces.length === 0
            ? h('div', { style: { padding: '18px 0', color: C.muted, fontSize: 13 } }, [
                h('div', { key: 'a', style: { marginBottom: 8 } }, '还没有远程工作区。'),
                h('div', { key: 'b', style: { fontSize: 12 } }, '点右上角「新建」，选一台机器，然后在它的目录树里挑一个项目文件夹。'),
              ])
            : groups.map(([alias, folders]) => {
                const host = hostState.get(alias);
                const connected = Boolean(host?.connected);
                return h('div', { key: alias, style: { marginTop: 14 } }, [
                  h('div', {
                    key: 'head',
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 0', borderBottom: `1px solid ${C.border}`,
                    },
                  }, [
                    h('span', {
                      key: 'dot',
                      title: connected ? '已连接' : '未连接',
                      style: {
                        width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
                        background: connected ? C.ok : C.muted,
                      },
                    }),
                    h('span', { key: 'name', style: { fontWeight: 600, fontSize: 13 } }, alias),
                    host
                      ? h('span', {
                          key: 'where',
                          style: { color: C.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        }, `${host.user ?? '?'}@${host.hostname}:${host.port}`)
                      : null,
                    h('span', {
                      key: 'state',
                      style: { color: connected ? C.ok : C.muted, fontSize: 12 },
                    }, connected ? '已连接' : '未连接'),
                    h('div', { key: 'spacer', style: { flex: 1 } }),
                    connected ? null : Button({ label: '连接', onClick: () => pickHost(alias), small: true, disabled: busy }),
                  ]),
                  ...folders.map((workspace) => h('div', {
                    key: workspace.id,
                    className: 'dp-ws',
                    style: {
                      padding: '8px 8px 8px 17px', borderBottom: `1px solid ${C.border}`,
                    },
                  }, [
                    h('span', { key: 'icon', style: { color: C.muted } }, '📁'),
                    h('div', { key: 'id', style: { flex: 1, minWidth: 0 } }, [
                      h('div', { key: 'title', style: { fontSize: 13, fontWeight: 500 } }, workspace.title),
                      h('div', {
                        key: 'path',
                        style: {
                          fontSize: 12, color: C.muted,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                      }, workspace.path),
                    ]),
                    Button({ label: '浏览文件', onClick: () => openFiles(workspace.host, workspace.path), small: true, disabled: busy }),
                    Button({ label: '移除', onClick: () => remove(workspace.id), small: true, disabled: busy }),
                  ])),
                ]);
              }));
      }

      return h('section', {
        className: 'dp-ui',
        style: { color: C.text, fontSize: 14, padding: '4px 0 24px', maxWidth: 780 },
      }, [
        header,
        h('p', {
          key: 'sub',
          style: { color: C.muted, fontSize: 12, margin: '2px 0 0' },
        }, '选一台机器和一个远程文件夹，agent 就只在这个文件夹里工作，连接常驻复用，远端不安装任何东西。'),
        error ? h(Banner, { key: 'error' }, error) : null,
        loadingList
          ? h('div', {
              key: 'loading',
              style: { display: 'flex', justifyContent: 'center', padding: '44px 0' },
            }, h(Spinner, { label: '正在加载工作区…', size: 18 }))
          : h('div', { key: 'content' }, [busy && mode !== 'list'
              ? h('div', {
                  key: 'busy',
                  style: { display: 'flex', justifyContent: 'center', padding: '12px 0' },
                }, h(Spinner, { label: '加载中…' }))
              : null, body]),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'presence',
          order: 55,
          label: 'Presence',
        }, PresencePanel));

        // Right-sidebar file browser (like an Xftp pane). Optional: it mounts
        // only when the shipped sidebar services are present, and a failure here
        // must never take the settings panel down with it.
        const tabId = 'dsh-presence/files';
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => {
            try {
              return scope.sidebarRightTabs.register({
                id: tabId,
                kind: 'presence-files',
                multiple: false,
                priority: 'extension',
                title: () => '远程文件',
                guide: [{
                  id: 'open',
                  order: 40,
                  title: () => '远程文件',
                  description: () => '拖拽上传/下载远程文件，双击预览图片与文本',
                }],
              });
            } catch (error) {
              console.error('[presence] sidebar tab registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.tab');
          scope.effect(() => {
            try {
              return scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                name: 'sidebar.right.pane.tab',
                key: tabId,
              }, RemoteFilesPanel));
            } catch (error) {
              console.error('[presence] sidebar pane registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.pane');
        });
      },
    };
  },
});
