// WALL-E — drag files out the way Explorer (and Dropshelf) do it.
// Electron's own startDrag draws the file path next to the cursor. Here Windows runs the drag
// instead (SHDoDragDrop with the shell's own data object), so you get the file's thumbnail and the
// "Move" / "Copy" label. It must run on the thread that owns WALL-E's window while the mouse button
// is still down, which is the Electron main thread: hence a plain FFI call (koffi), no helper.
'use strict';

let api = null;
function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const ole32 = koffi.load('ole32.dll');
    api = {
      koffi,
      SHParseDisplayName: shell32.func('int __stdcall SHParseDisplayName(str16 name, void *bc, _Out_ void **pidl, uint32_t sfgaoIn, _Out_ uint32_t *sfgaoOut)'),
      SHCreateShellItemArrayFromIDLists: shell32.func('int __stdcall SHCreateShellItemArrayFromIDLists(uint32_t cidl, void **pidls, _Out_ void **items)'),
      SHDoDragDrop: shell32.func('int __stdcall SHDoDragDrop(void *hwnd, void *data, void *dropSource, uint32_t okEffects, _Out_ uint32_t *effect)'),
      CoCreateInstance: ole32.func('int __stdcall CoCreateInstance(void *clsid, void *outer, uint32_t ctx, void *iid, _Out_ void **obj)'),
      CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void *p)'),
      BindToHandler: koffi.proto('int __stdcall BindToHandler(void *self, void *bc, void *bhid, void *riid, _Out_ void **out)'),
      InitializeFromWindow: koffi.proto('int __stdcall InitializeFromWindow(void *self, void *hwnd, void *pt, void *data)'),
      Release: koffi.proto('uint32_t __stdcall Release(void *self)'),
      DwmSetWindowAttribute: koffi.load('dwmapi.dll').func('int __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, _In_ uint32_t *value, uint32_t size)'),
    };
  } catch (e) { api = false; module.exports.error = e.message; }
  return api;
}

function guid(s) {   // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -> 16 bytes, the way Windows lays a GUID out
  const h = s.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}
const BHID_DataObject = guid('B8C0BD9F-ED24-455c-83E6-D5390C4FE8C4');
const IID_IDataObject = guid('0000010e-0000-0000-C000-000000000046');
const CLSID_DragDropHelper = guid('4657278A-411B-11D2-839A-00C04FD918D0');
const IID_IDragSourceHelper = guid('DE5BF786-477A-11D2-839D-00C04FD918D0');

// Calls method number `index` of a COM object.
function vcall(a, obj, index, proto, ...args) {
  const vtbl = a.koffi.decode(obj, 'void *');
  const fn = a.koffi.decode(vtbl, index * 8, 'void *');
  return a.koffi.call(fn, proto, obj, ...args);
}

// Runs the drag (blocks until it's dropped or cancelled). Returns null when it can't be done here,
// otherwise { hr, effect, dropped }.
function drag(paths) {
  const a = load();
  if (!a) return null;
  const pidls = [];
  let items = null, data = null, helper = null;
  try {
    for (const p of paths) {
      const out = [null], sf = [0];
      if (a.SHParseDisplayName(p, null, out, 0, sf) === 0 && out[0]) pidls.push(out[0]);
    }
    if (!pidls.length) return null;
    const outItems = [null];
    if (a.SHCreateShellItemArrayFromIDLists(pidls.length, pidls, outItems) !== 0 || !outItems[0]) return null;
    items = outItems[0];
    const outData = [null];
    if (vcall(a, items, 3, a.BindToHandler, null, BHID_DataObject, IID_IDataObject, outData) !== 0 || !outData[0]) return null;
    data = outData[0];
    // the thumbnail under the cursor, made by Windows from the files themselves
    const outHelper = [null];
    if (a.CoCreateInstance(CLSID_DragDropHelper, null, 1, IID_IDragSourceHelper, outHelper) === 0 && outHelper[0]) {
      helper = outHelper[0];
      try { vcall(a, helper, 4, a.InitializeFromWindow, null, null, data); } catch { /* plain drag image then */ }
    }
    const eff = [0];
    const hr = a.SHDoDragDrop(null, data, null, 1 | 2 | 4, eff) >>> 0;   // copy, move, link
    return { hr, effect: eff[0], dropped: hr === 0x00040100 };
  } finally {
    for (const o of [helper, data, items]) if (o) { try { vcall(a, o, 2, a.Release); } catch { /* ignore */ } }
    for (const p of pidls) a.CoTaskMemFree(p);
  }
}

// Colours a window's title bar (Windows 11): dark or light caption, background and text colour.
function titleBar(hwndBuf, dark, bg, fg) {
  const a = load();
  if (!a || !hwndBuf || hwndBuf.length < 4) return false;
  const hwnd = hwndBuf.length >= 8 ? hwndBuf.readBigInt64LE(0) : BigInt(hwndBuf.readInt32LE(0));
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16); };   // COLORREF is 0x00BBGGRR
  try {
    const set = (attr, v) => a.DwmSetWindowAttribute(hwnd, attr, [v >>> 0], 4);
    set(20, dark ? 1 : 0);          // DWMWA_USE_IMMERSIVE_DARK_MODE
    set(35, rgb(bg));               // DWMWA_CAPTION_COLOR
    set(36, rgb(fg));               // DWMWA_TEXT_COLOR
    return true;
  } catch { return false; }
}

module.exports = { drag, titleBar, available: () => !!load(), error: '' };
