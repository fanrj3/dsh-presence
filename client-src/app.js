// Presence client application. This module is bundled into ../client.js by
// scripts/build-client.mjs - edit here, never in the generated file.

import { mountCodeView } from './editor.js';

export function createApp({ React }) {
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
      soft: 'var(--dsw-alias-bg-module-platform)',
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
        background: var(--dsw-alias-interactive-bg-hover);
        border-color: var(--dsw-alias-border-l3);
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
      .dp-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-row:active:not(:disabled) { transform: scale(.995); }
      .dp-row:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-row:disabled { cursor: not-allowed; }

      .dp-icon {
        width: 26px; height: 26px; border-radius: var(--dp-radius-sm); flex: 0 0 auto;
        background: var(--dsw-alias-bg-module-platform);
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
        background: var(--dsw-alias-interactive-bg-hover);
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
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-iconbtn:active:not(:disabled) { transform: scale(.92); }
      .dp-iconbtn:focus-visible { outline: none; box-shadow: var(--dp-ring); }

      /* ---- filter input ---- */
      .dp-input {
        width: 100%; padding: 6px 10px; font-size: 12px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-module-platform);
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dp-radius-sm); outline: none;
        transition:
          border-color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-fast) var(--dp-ease),
          background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-input::placeholder { color: var(--dsw-alias-label-secondary); }
      .dp-input:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-input:focus { border-color: var(--dp-accent); box-shadow: var(--dp-ring); }

      /* ---- workspace rows ---- */
      .dp-ws {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: var(--dp-radius-md);
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-ws:hover { background: var(--dsw-alias-interactive-bg-hover); }

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

      /* -------------------------------------------------- remote file pane
         Uses the harness theme's own interaction tokens (bg-layer-1 and
         bg-layer-2 are the SAME colour in the light theme, which is why hover
         was invisible), plus the theme motion/radius tokens. */
      .dp-pane {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--dsw-alias-label-primary); font-size: 13px; position: relative;
        background: transparent;
        --dp-fast: var(--ds-transition-duration-fast, .1s);
        --dp-ease: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
      }
      .dp-pane, .dp-pane .dp-entry, .dp-pane .dp-toolbar, .dp-pane .dp-path,
      .dp-pane .dp-columns, .dp-pane .dp-filter, .dp-pane .dp-crumbs {
        -webkit-user-select: none; user-select: none;
      }
      .dp-pane .dp-code, .dp-pane .dp-plain, .dp-pane .dp-input,
      .dp-pane .dp-modal-path, .dp-pane select { -webkit-user-select: text; user-select: text; }

      /* toolbar */
      .dp-toolbar {
        display: flex; align-items: center; gap: 4px;
        padding: 6px 8px; min-height: 40px; box-sizing: border-box;
        border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-toolbar-icon { color: var(--dsw-alias-label-tertiary); display: inline-flex; }
      .dp-select {
        height: 28px; padding: 0 8px; max-width: 136px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; outline: none; cursor: pointer;
        transition: border-color var(--dp-fast) var(--dp-ease), box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-select:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-select:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent); }

      .dp-tool {
        display: inline-flex; align-items: center; gap: 6px;
        height: 28px; padding: 0 10px;
        border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-tool:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-tool:active { background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 70%, var(--dsw-alias-border-l3)); }
      .dp-tool:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-tool--primary {
        border-color: var(--dsw-alias-border-l3);
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
        color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
      }
      .dp-tool--primary:hover {
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
        color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
        filter: brightness(1.04);
      }

      /* path bar */
      .dp-path {
        display: flex; align-items: center; gap: 1px; flex-wrap: wrap;
        padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-path-part { display: inline-flex; align-items: center; }
      .dp-pane .dp-path-sep { color: var(--dsw-alias-label-tertiary); display: inline-flex; margin: 0 1px; }
      .dp-pane .dp-crumb {
        border: 1px solid transparent; background: transparent;
        padding: 2px 8px; border-radius: 999px; max-width: 160px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-secondary); cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-pane .dp-crumb:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-pane .dp-crumb:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-crumb--current {
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary);
        font-weight: 500; cursor: default;
      }
      .dp-crumb--current:hover { background: var(--dsw-alias-bg-module-platform); }

      /* filter */
      .dp-filter { position: relative; padding: 6px 8px; flex: 0 0 auto; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .dp-filter-icon {
        position: absolute; left: 18px; top: 50%; transform: translateY(-50%);
        color: var(--dsw-alias-label-tertiary); display: inline-flex; pointer-events: none;
      }
      .dp-pane .dp-input {
        width: 100%; height: 28px; box-sizing: border-box; padding: 0 10px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; outline: none;
        transition: border-color var(--dp-fast) var(--dp-ease), box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-filter .dp-input { padding-left: 28px; }
      .dp-pane .dp-input::placeholder { color: var(--dsw-alias-label-tertiary); }
      .dp-pane .dp-input:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-pane .dp-input:focus-visible {
        border-color: var(--dsw-alias-state-business-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
      }

      /* column header + list */
      .dp-columns {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px 4px 44px;
        font-size: 11px; color: var(--dsw-alias-label-tertiary);
        border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-col-name { flex: 1; min-width: 0; }
      .dp-col-size { width: 64px; flex: 0 0 auto; text-align: right; }
      .dp-col-time { width: 76px; flex: 0 0 auto; text-align: right; }
      .dp-col-actions { width: 52px; flex: 0 0 auto; }

      .dp-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 18px; }
      .dp-loading { display: flex; justify-content: center; padding: 32px 0; }

      .dp-entry {
        display: flex; align-items: center; gap: 10px; width: 100%;
        min-height: 34px; padding: 4px 8px; box-sizing: border-box;
        border: 0; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: inherit; font: inherit;
        text-align: left; cursor: default;
        transition: background-color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-entry.is-selected { background: var(--dsw-alias-bg-multi-select); }
      .dp-entry:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: -2px;
      }
      .dp-entry:active { background: var(--dsw-alias-bg-module-platform); }

      .dp-tile {
        width: 26px; height: 26px; flex: 0 0 auto;
        display: grid; place-items: center;
        border-radius: var(--dsw-radius-xs, 4px);
        color: var(--dsw-alias-label-tertiary);
        background: transparent;
        transition: background-color var(--dp-fast) var(--dp-ease), color var(--dp-fast) var(--dp-ease);
      }
      .dp-tile--dir { color: var(--dsw-alias-state-business-primary); }
      .dp-tile--image { color: var(--dsw-alias-state-success-primary); }
      .dp-entry:hover .dp-tile { background: var(--dsw-alias-bg-module-platform); }
      .dp-entry:hover .dp-tile--dir { color: var(--dsw-alias-state-business-primary); }

      .dp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
      .dp-meta {
        color: var(--dsw-alias-label-tertiary); font-size: 11.5px;
        flex: 0 0 auto; font-variant-numeric: tabular-nums; text-align: right;
      }
      .dp-entry .dp-col-size, .dp-entry .dp-col-time { line-height: 20px; }

      .dp-factions {
        display: flex; gap: 2px; width: 52px; flex: 0 0 auto; justify-content: flex-end;
        opacity: 0; transition: opacity var(--dp-fast) var(--dp-ease);
      }
      .dp-entry:hover .dp-factions, .dp-entry:focus-within .dp-factions, .dp-entry.is-selected .dp-factions { opacity: 1; }
      .dp-pane .dp-iconbtn {
        width: 24px; height: 24px; padding: 0;
        display: grid; place-items: center;
        border: 0; border-radius: var(--dsw-radius-xs, 4px);
        background: transparent; color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease), color var(--dp-fast) var(--dp-ease);
      }
      .dp-pane .dp-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dp-pane .dp-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }

      .dp-empty {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        padding: 44px 16px; color: var(--dsw-alias-label-tertiary); font-size: 12px;
      }
      .dp-empty-icon {
        width: 40px; height: 40px; display: grid; place-items: center;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }

      .dp-drop {
        position: absolute; inset: 8px; z-index: 8;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));
        border: 1px dashed var(--dsw-alias-state-business-primary);
        border-radius: var(--dsw-radius-md, 12px);
        color: var(--dsw-alias-label-primary); font-size: 13px;
        pointer-events: none;
      }

      /* progress */
      .dp-progress {
        position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 9;
        padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
      }
      .dp-progress-head {
        display: flex; align-items: center; gap: 8px;
        font-size: 11.5px; color: var(--dsw-alias-label-secondary);
      }
      .dp-progress-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dp-progress-ok { color: var(--dsw-alias-state-success-primary); }
      .dp-progress-track {
        height: 4px; border-radius: 999px; overflow: hidden;
        background: var(--dsw-alias-bg-module-platform);
      }
      .dp-progress-fill {
        height: 100%; border-radius: 999px;
        background: var(--dsw-alias-state-business-primary);
        transition: width 120ms linear;
      }
      .dp-progress-fill.is-indeterminate { width: 40% !important; animation: dp-indeterminate 1.1s var(--dp-ease) infinite; }
      .dp-progress-detail {
        font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      @keyframes dp-indeterminate {
        0% { margin-left: 0; }
        50% { margin-left: 60%; }
        100% { margin-left: 0; }
      }

      /* banner */
      .dp-banner {
        display: flex; align-items: flex-start; gap: 8px;
        margin: 8px; padding: 8px 12px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
        border-radius: var(--dsw-radius-sm, 8px);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
        color: var(--dsw-alias-state-error-primary);
        font-size: 12px; line-height: 18px;
      }

      /* preview */
      .dp-overlay {
        position: absolute; inset: 0; z-index: 20;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, .32);
        animation: dp-fade var(--ds-transition-duration-fast, .1s) var(--dp-ease) both;
      }
      .dp-modal {
        display: flex; flex-direction: column; overflow: hidden;
        width: min(94%, 900px); max-height: 88%;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease) both;
      }
      @keyframes dp-modal-in {
        from { opacity: 0; transform: translateY(6px) scale(.995); }
        to { opacity: 1; transform: none; }
      }
      .dp-modal-head {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);
      }
      .dp-modal-icon {
        width: 26px; height: 26px; display: grid; place-items: center; flex: 0 0 auto;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .dp-modal-title { font-size: 13px; font-weight: 600; }
      .dp-modal-body { margin: 10px 12px; border-radius: var(--dsw-radius-sm, 8px); overflow: auto; background: var(--dsw-alias-bg-module-platform); }
      .dp-preview-image { max-width: 100%; display: block; margin: 0 auto; }
      .dp-modal-foot {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2);
      }
      .dp-modal-path {
        flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-chip {
        display: inline-flex; align-items: center; padding: 1px 8px;
        border-radius: 999px; background: var(--dsw-alias-bg-module-platform);
        font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-secondary);
      }

      /* code preview: CodeMirror 6 mounts here */
      .dp-cm {
        height: 62vh; min-height: 180px; overflow: hidden;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
      }
      .dp-cm .cm-editor { height: 100%; }
      .dp-plain {
        margin: 0; padding: 10px 12px; overflow: auto; max-height: 62vh;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
        font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
      }

      /* image / video / audio / pdf preview */
      .dp-preview-image { max-width: 100%; max-height: 62vh; display: block; margin: 0 auto; }
      .dp-media { display: block; width: 100%; max-height: 62vh; background: transparent; }
      .dp-audio-wrap { padding: 28px 20px; display: flex; justify-content: center; }
      .dp-audio-wrap .dp-media { max-width: 520px; }
      .dp-pdf { display: block; width: 100%; height: 62vh; border: 0; background: var(--dsw-alias-bg-base); }

      /* auth prompt */
      .dp-auth {
        display: flex; flex-direction: column; gap: 12px;
        width: min(92%, 380px); padding: 18px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease) both;
      }
      .dp-auth-head { display: flex; align-items: center; gap: 10px; }
      .dp-auth-icon {
        width: 30px; height: 30px; display: grid; place-items: center;
        border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .dp-auth-title { font-size: 13px; font-weight: 600; }
      .dp-auth-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .dp-auth-row { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dp-auth-actions { display: flex; justify-content: flex-end; gap: 8px; }
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
    // Stroke icons (Lucide geometry) so the pane uses real UI icons instead of emoji.
    const ICONS = {
      folder: ['M4 7a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'],
      file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
      code: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M10 12l-2 2 2 2', 'M14 12l2 2-2 2'],
      text: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
      image: ['M4 5h16v14H4z', 'M9 11a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z', 'M4 16l4.5-4.5 3.5 3.5 3-3L20 15'],
      download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
      trash: ['M4 7h16', 'M10 11v5', 'M14 11v5', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
      plus: ['M12 5v14', 'M5 12h14'],
      'folder-plus': ['M4 7a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M12 12v5', 'M9.5 14.5h5'],
      refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v5h-5'],
      upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
      chevron: ['M9 6l6 6-6 6'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      lock: ['M7 10V8a5 5 0 0 1 10 0v2', 'M5 10h14v10H5z'],
      check: ['M4 12l5 5L20 6'],
      alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 8v5', 'M12 16.5v.5'],
      server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M7.5 7h.01', 'M7.5 17h.01'],
      search: ['M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z', 'M20 20l-3.6-3.6'],
      play: ['M8 5l11 7-11 7z'],
      music: ['M9 17V5l10-2v12', 'M9 17a3 3 0 1 1-6 0a3 3 0 0 1 6 0z', 'M19 15a3 3 0 1 1-6 0a3 3 0 0 1 6 0z'],
    };

    function Icon({ name, size = 16, style }) {
      const paths = ICONS[name] ?? ICONS.file;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto', display: 'block', ...style },
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

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

    const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi']);
    const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);

    /** Which inline preview a file gets: 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'text' | null. */
    function previewKindOf(name) {
      const extension = extensionOf(name);
      if (IMAGE_EXTENSIONS.has(extension)) return 'image';
      if (VIDEO_EXTENSIONS.has(extension)) return 'video';
      if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
      if (extension === 'pdf') return 'pdf';
      if (isCodeName(name)) return 'code';
      if (isTextName(name)) return 'text';
      return null;
    }

    function entryIconName(entry) {
      if (entry.kind === 'dir') return 'folder';
      const kind = previewKindOf(entry.name);
      if (kind === 'image') return 'image';
      if (kind === 'video') return 'play';
      if (kind === 'audio') return 'music';
      if (kind === 'code') return 'code';
      if (kind === 'text' || kind === 'pdf') return 'text';
      return 'file';
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

    /** Read-only CodeMirror 6 view: syntax highlighting, line numbers, fold. */
    function CodeView({ content, name }) {
      const host = useRef(null);
      useEffect(() => {
        let disposed = false;
        let handle = null;
        if (!host.current) return undefined;
        mountCodeView(host.current, { content, name }).then((created) => {
          if (disposed) created?.destroy();
          else handle = created;
        });
        return () => {
          disposed = true;
          handle?.destroy();
        };
      }, [content, name]);
      return h('div', { ref: host, className: 'dp-cm' });
    }

    /** Does this API error mean the host could not authenticate? */
    function isAuthMessage(text) {
      const message = String(text ?? '');
      return /authentication failed|no usable key|no password|password was supplied|Permission denied \(publickey|Host key verification failed/iu.test(message);
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
      let destination;
      try {
        destination = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (error) {
        // Closing the picker is a cancellation, not a failure.
        if (error && (error.name === 'AbortError' || error.name === 'SecurityError')) return null;
        throw error;
      }
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
      const [auth, setAuth] = useState(null);
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
          setAuth(null);
        } catch (err) {
          // A password-only host cannot connect silently: ask instead of showing
          // the raw ssh failure.
          if (isAuthMessage(err.message)) {
            setEntries([]);
            setLoading(false);
            setAuth({ host: nextHost, path: nextPath, password: '', remember: false, error: null, busy: false });
            return;
          }
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }, []);

      const submitPassword = async () => {
        if (!auth) return;
        setAuth({ ...auth, busy: true, error: null });
        try {
          await request('/connect', {
            host: auth.host,
            password: auth.password,
            remember: auth.remember,
          });
          const next = { host: auth.host, path: auth.path };
          setAuth(null);
          await load(next.host, next.path);
        } catch (err) {
          setAuth({ ...auth, busy: false, error: err.message });
        }
      };

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

      // Escape closes the preview or the password prompt.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (preview) setPreview(null);
          else if (auth) setAuth(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [preview, auth]);

      const openEntry = async (entry) => {
        if (entry.kind === 'dir') {
          await load(host, entry.path);
          return;
        }
        const kind = previewKindOf(entry.name);
        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
          setPreview({
            name: entry.name,
            path: entry.path,
            size: entry.size,
            kind,
            url: rawUrlFor(host, entry.path, false),
          });
          return;
        }
        if (kind === 'code' || kind === 'text' || entry.size <= 256 * 1024) {
          try {
            setPreview({ name: entry.name, path: entry.path, size: entry.size, kind: 'loading' });
            const data = await request(`/file?host=${encodeURIComponent(host)}&path=${encodeURIComponent(entry.path)}`);
            setPreview({
              name: entry.name,
              path: entry.path,
              size: entry.size,
              kind: kind === 'code' ? 'code' : 'text',
              content: data.content,
              truncated: data.truncated,
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

      const rowActions = (entry) => h('span', { key: 'actions', className: 'dp-factions' }, [
        h('button', {
          key: 'save',
          type: 'button',
          className: 'dp-iconbtn',
          title: entry.kind === 'dir' ? '下载文件夹到本地' : '保存到本地',
          onClick: (event) => {
            event.stopPropagation();
            downloadEntry(entry);
          },
        }, h(Icon, { name: 'download', size: 15 })),
        h('button', {
          key: 'delete',
          type: 'button',
          className: 'dp-iconbtn',
          title: '移到回收站',
          onClick: (event) => {
            event.stopPropagation();
            removeEntry(entry);
          },
        }, h(Icon, { name: 'trash', size: 15 })),
      ]);

      return h('div', {
        ref: rootRef,
        className: 'dp-pane',
        style: { position: 'relative', flex: '1 1 auto', minHeight: 0, height: '100%' },
      }, [
        h('div', { key: 'toolbar', className: 'dp-toolbar' }, [
          h('span', { key: 'host-icon', className: 'dp-toolbar-icon' }, h(Icon, { name: 'server', size: 15 })),
          h('select', {
            key: 'host',
            className: 'dp-select',
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
          }, [h(Icon, { key: 'i', name: 'upload', size: 15 }), h('span', { key: 't' }, '文件')]),
          h('button', {
            key: 'upload-folder',
            type: 'button',
            className: 'dp-tool',
            title: '上传文件夹',
            onClick: () => folderInput.current?.click(),
          }, [h(Icon, { key: 'i', name: 'folder', size: 15 }), h('span', { key: 't' }, '文件夹')]),
          h('button', {
            key: 'mkdir',
            type: 'button',
            className: 'dp-tool',
            title: '新建文件夹',
            onClick: () => setCreatingFolder(''),
          }, [h(Icon, { key: 'i', name: 'folder-plus', size: 15 })]),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dp-tool',
            title: '刷新',
            onClick: () => load(host, path),
          }, [h(Icon, { key: 'i', name: 'refresh', size: 15 })]),
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
        h('div', { key: 'pathbar', className: 'dp-path' },
          crumbs.map((crumb, index) => h('span', { key: `${crumb.path}#${index}`, className: 'dp-path-part' }, [
            index > 0
              ? h('span', { key: 'sep', className: 'dp-path-sep' }, h(Icon, { name: 'chevron', size: 12 }))
              : null,
            h('button', {
              key: 'crumb',
              type: 'button',
              className: index === crumbs.length - 1 ? 'dp-crumb dp-crumb--current' : 'dp-crumb',
              onClick: () => load(host, crumb.path),
            }, index === 0 ? '/' : crumb.name),
          ]))),
        h('div', { key: 'filter', className: 'dp-filter' }, [
          h('span', { key: 'icon', className: 'dp-filter-icon' }, h(Icon, { name: 'search', size: 14 })),
          h('input', {
            key: 'input',
            className: 'dp-input',
            value: filter,
            placeholder: '筛选当前目录…',
            onChange: (event) => setFilter(event.target.value),
          }),
        ]),
        error ? h('div', { key: 'error', className: 'dp-banner' }, [
          h(Icon, { key: 'i', name: 'alert', size: 14 }),
          h('span', { key: 't' }, error),
        ]) : null,
        creatingFolder !== null
          ? h('div', { key: 'newfolder', className: 'dp-newfolder' }, [
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
              h('button', { key: 'create', type: 'button', className: 'dp-tool dp-tool--primary', onClick: createFolder }, '创建'),
            ])
          : null,
        h('div', { key: 'columns', className: 'dp-columns' }, [
          h('span', { key: 'name', className: 'dp-col-name' }, '名称'),
          h('span', { key: 'size', className: 'dp-col-size' }, '大小'),
          h('span', { key: 'time', className: 'dp-col-time' }, '修改时间'),
          h('span', { key: 'actions', className: 'dp-col-actions' }),
        ]),
        h('div', { key: 'list', className: 'dp-list' },
          loading
            ? h('div', { className: 'dp-loading' }, h(Spinner, { label: '加载中…' }))
            : visible.length === 0
              ? h('div', { key: 'empty', className: 'dp-empty' }, [
                  h('span', { key: 'icon', className: 'dp-empty-icon' }, h(Icon, { name: filter.trim() ? 'search' : 'folder', size: 22 })),
                  h('span', { key: 'text' }, filter.trim() ? '没有匹配的条目' : '这个目录是空的'),
                ])
              : visible.map((entry) => h('div', {
                  key: entry.path,
                  className: `dp-entry${selected === entry.path ? ' is-selected' : ''}`,
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
                  h('span', { key: 'icon', className: `dp-tile dp-tile--${entry.kind}` }, h(Icon, { name: entryIconName(entry), size: 16 })),
                  h('span', { key: 'name', className: 'dp-name' }, entry.name),
                  h('span', { key: 'size', className: 'dp-meta dp-col-size' }, entry.kind === 'dir' ? '—' : humanSize(entry.size)),
                  h('span', { key: 'time', className: 'dp-meta dp-col-time' }, formatMoment(entry.mtime)),
                  rowActions(entry),
                ]))),
        dragOver
          ? h('div', { key: 'drop', className: 'dp-drop' }, [
              h(Icon, { key: 'i', name: 'upload', size: 22 }),
              h('span', { key: 't' }, `松开上传到 ${path}`),
            ])
          : null,
        job
          ? h('div', { key: 'job', className: 'dp-progress' }, [
              h('div', { key: 'head', className: 'dp-progress-head' }, [
                h(Icon, { key: 'i', name: job.kind === 'done' ? 'check' : 'download', size: 13 }),
                h('span', { key: 'label', className: 'dp-progress-label' }, job.label),
                job.kind === 'done'
                  ? h('span', { key: 'ok', className: 'dp-progress-ok' }, job.detail)
                  : h('span', { key: 'pct' }, job.percent === null ? '' : `${job.percent}%`),
              ]),
              h('div', { key: 'track', className: 'dp-progress-track' },
                h('div', {
                  key: 'fill',
                  className: job.percent === null ? 'dp-progress-fill is-indeterminate' : 'dp-progress-fill',
                  style: { width: `${job.percent ?? 40}%` },
                })),
              job.detail && job.kind !== 'done'
                ? h('div', { key: 'detail', className: 'dp-progress-detail' }, job.detail)
                : null,
            ])
          : null,
        auth
          ? h('div', {
              key: 'auth-overlay',
              className: 'dp-overlay',
              onClick: () => setAuth(null),
            }, h('div', {
              key: 'auth',
              className: 'dp-auth',
              onClick: (event) => event.stopPropagation(),
            }, [
              h('div', { key: 'head', className: 'dp-auth-head' }, [
                h('span', { key: 'icon', className: 'dp-auth-icon' }, h(Icon, { name: 'lock', size: 18 })),
                h('span', { key: 'title', className: 'dp-auth-title' }, `连接 ${auth.host}`),
              ]),
              h('div', { key: 'hint', className: 'dp-auth-hint' },
                '这台机器需要密码登录。密码默认只保存在内存里，勾选「记住这台」才会交给凭据服务保管。'),
              h('input', {
                key: 'password',
                className: 'dp-input',
                type: 'password',
                autoFocus: true,
                placeholder: 'SSH 密码',
                value: auth.password,
                onChange: (event) => setAuth({ ...auth, password: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitPassword();
                  if (event.key === 'Escape') setAuth(null);
                },
              }),
              h('label', { key: 'remember', className: 'dp-auth-row' }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: auth.remember,
                  onChange: (event) => setAuth({ ...auth, remember: event.target.checked }),
                }),
                h('span', { key: 't' }, '记住这台'),
              ]),
              auth.error ? h('div', { key: 'err', className: 'dp-banner', style: { margin: 0 } }, auth.error) : null,
              h('div', { key: 'actions', className: 'dp-auth-actions' }, [
                h('button', { key: 'cancel', type: 'button', className: 'dp-tool', onClick: () => setAuth(null) }, '取消'),
                h('button', {
                  key: 'connect',
                  type: 'button',
                  className: 'dp-tool dp-tool--primary',
                  disabled: auth.busy || !auth.password,
                  onClick: submitPassword,
                }, auth.busy ? '连接中…' : '连接'),
              ]),
            ]))
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
                h('span', { key: 'icon', className: 'dp-modal-icon' }, h(Icon, {
                  name: entryIconName({ kind: 'file', name: preview.name }),
                  size: 16,
                })),
                h('span', {
                  key: 'name',
                  className: 'dp-modal-title',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, preview.name),
                preview.kind === 'code'
                  ? h('span', { key: 'chip', className: 'dp-chip' }, extensionOf(preview.name).toUpperCase() || 'CODE')
                  : preview.kind === 'text'
                    ? h('span', { key: 'chip', className: 'dp-chip' }, '文本')
                    : preview.kind === 'image'
                      ? h('span', { key: 'chip', className: 'dp-chip' }, '图片')
                      : preview.kind === 'video'
                        ? h('span', { key: 'chip', className: 'dp-chip' }, '视频')
                        : preview.kind === 'audio'
                          ? h('span', { key: 'chip', className: 'dp-chip' }, '音频')
                          : preview.kind === 'pdf'
                            ? h('span', { key: 'chip', className: 'dp-chip' }, 'PDF')
                            : null,
                h('span', { key: 'size', className: 'dp-meta' }, humanSize(preview.size)),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'dp-iconbtn',
                  title: '关闭 (Esc)',
                  onClick: () => setPreview(null),
                }, h(Icon, { name: 'x', size: 16 })),
              ]),
              h('div', { key: 'body', className: 'dp-modal-body' },
                preview.kind === 'loading'
                  ? h('div', { className: 'dp-loading' }, h(Spinner, { label: '读取中…' }))
                  : preview.kind === 'image'
                    ? h('img', { key: 'img', src: preview.url, className: 'dp-preview-image' })
                    : preview.kind === 'video'
                      ? h('video', {
                          key: 'video',
                          src: preview.url,
                          controls: true,
                          autoPlay: false,
                          className: 'dp-media',
                        })
                      : preview.kind === 'audio'
                        ? h('div', { key: 'audio', className: 'dp-audio-wrap' }, h('audio', {
                            src: preview.url,
                            controls: true,
                            autoPlay: false,
                            className: 'dp-media',
                          }))
                        : preview.kind === 'pdf'
                          ? h('iframe', {
                              key: 'pdf',
                              src: preview.url,
                              title: preview.name,
                              className: 'dp-pdf',
                            })
                          : preview.kind === 'code'
                            ? h(CodeView, { content: preview.content, name: preview.name })
                            : h('pre', { className: 'dp-plain' }, preview.content ?? '')),
              h('div', { key: 'foot', className: 'dp-modal-foot' }, [
                h('span', { key: 'path', className: 'dp-modal-path' }, preview.path),
                preview.truncated ? h('span', { key: 'trunc', className: 'dp-meta' }, '仅显示前 256 KiB') : null,
                h('button', {
                  key: 'save',
                  type: 'button',
                  className: 'dp-tool dp-tool--primary',
                  onClick: () => saveRemoteFile(host, preview.path, preview.name).catch((err) => setError(err.message)),
                }, [h(Icon, { key: 'i', name: 'download', size: 15 }), h('span', { key: 't' }, '保存到本地')]),
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
}
