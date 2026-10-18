'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ON = new Set([
  'settings', 'media', 'art', 'lyrics', 'radios', 'volume', 'brightness', 'dark',
  'weather', 'messages', 'calendar', 'peek', 'claude', 'claude-perm', 'claude-perm-cancel', 'perm-key', 'displays', 'update', 'claude-status', 'claude-sessions',
]);
const SEND = new Set(['island-size', 'island-open', 'helper', 'perm-answer', 'open-settings', 'open-url', 'refresh-all', 'identify-screens', 'check-updates', 'install-update', 'claude-sessions-request']);
const INVOKE = new Set(['get-settings', 'set-settings', 'claude-snippet', 'copy-text', 'initial-state', 'get-displays', 'get-update', 'claude-status']);

contextBridge.exposeInMainWorld('notch', {
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.has(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked')),
});
