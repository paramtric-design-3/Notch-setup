'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ON = new Set([
  'settings', 'media', 'art', 'lyrics', 'radios', 'volume', 'brightness', 'dark',
  'weather', 'messages', 'calendar', 'peek', 'displays', 'update', 'pointer', 'outputs', 'league',
]);
const SEND = new Set(['island-size', 'island-open', 'helper', 'open-settings', 'open-url', 'refresh-all', 'identify-screens', 'check-updates', 'install-update']);
const INVOKE = new Set(['get-settings', 'set-settings', 'copy-text', 'initial-state', 'get-displays', 'get-update']);

contextBridge.exposeInMainWorld('notch', {
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.has(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked')),
});
