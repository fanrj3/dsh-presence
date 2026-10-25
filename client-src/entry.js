// Entry point for the bundled client half. scripts/build-client.mjs turns this
// module graph into ../client.js (an IIFE that registers with the module loader).

import { createApp } from './app.js';

window.__ModuleLoader__.load({
  id: 'dsh-presence',
  factory(require) {
    const React = require('react');
    return createApp({ React });
  },
});
