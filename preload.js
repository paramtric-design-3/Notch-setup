'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ON = new Set([
  'settings', 'media', 'art', 'lyrics', 'radios', 'volume', 'brightness', 'dark',
  'weather', 'messages', 'calendar', 'peek', 'displays', 'update', 'pointer', 'outputs', 'league', 'overlay', 'shelf', 'todo', 'appout', 'shelfdrag', 'taskbar-state',
]);
const SEND = new Set(['island-size', 'island-open', 'helper', 'open-settings', 'open-url', 'refresh-all', 'identify-screens', 'check-updates', 'install-update', 'overlay-mouse', 'overlay-drag', 'shelf-drag', 'shelf-open', 'todo-done', 'todo-important', 'todo-add', 'todo-sync', 'island-focus', 'taskbar-install']);
const INVOKE = new Set(['get-settings', 'set-settings', 'copy-text', 'initial-state', 'get-displays', 'get-update', 'league-import-runes', 'shelf-add', 'shelf-remove', 'shelf-clear', 'shelf-list', 'todo-signin', 'todo-signout', 'todo-lists', 'todo-state', 'taskbar-state']);

contextBridge.exposeInMainWorld('notch', {
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.has(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked')),
  // the real path of a file dropped on the window (for the shelf)
  pathFor: f => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
});
