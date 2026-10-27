// WALL-E — see-through taskbar through TranslucentTB.
// TranslucentTB (free, Microsoft Store) does the actual work. WALL-E writes its documented settings
// file (it reloads that by itself), hides its tray icon, and starts it when needed, so the look is
// chosen in WALL-E's Settings and TranslucentTB stays out of sight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PFN = '28017CharlesMilette.TranslucentTB_v826wp6bftszj';
const STORE = 'ms-windows-store://pdp/?productid=9PF4KZ2VN4W9';
const pkgDir = () => path.join(process.env.LOCALAPPDATA || '', 'Packages', PFN);
const settingsFile = () => path.join(pkgDir(), 'RoamingState', 'settings.json');

function installed() {
  return process.platform === 'win32' && fs.existsSync(pkgDir());
}

function run(cmd, args) {
  return new Promise(res => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, out) => res(err ? '' : String(out || ''))));
}
async function running() {
  const out = await run('tasklist', ['/FI', 'IMAGENAME eq TranslucentTB.exe', '/NH']);
  return /TranslucentTB\.exe/i.test(out);
}

// The Store app's id inside its package (read once from its manifest).
let appId = null;
async function appUserModelId() {
  if (appId) return appId;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-AppxPackage -Name '28017CharlesMilette.TranslucentTB'; if ($p) { ((Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object -First 1).Id }`]);
  const id = out.trim().split(/\r?\n/).pop();
  appId = `${PFN}!${id || 'TranslucentTB'}`;
  return appId;
}

// One look for every situation, so the taskbar looks the same with or without open windows.
function appearance(mode, dark) {
  const tint = dark ? '101010' : 'F2F2F2';
  const look = {
    clear: { accent: 'clear', color: '#00000000' },
    blur: { accent: 'blur', color: `#${tint}20`, blur_radius: 12.0 },
    acrylic: { accent: 'acrylic', color: `#${tint}40` },
  }[mode] || { accent: 'normal', color: '#00000000' };
  return { ...look, show_peek: false, show_line: false };
}

function write(mode, dark) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* none yet */ }
  const a = appearance(mode, dark);
  const off = st => ({ ...(cur[st] || {}), ...a, enabled: false });
  const next = {
    ...cur,
    $schema: 'https://TranslucentTB.github.io/settings.schema.json',
    desktop_appearance: { ...(cur.desktop_appearance || {}), ...a },
    visible_window_appearance: { ...off('visible_window_appearance'), rules: (cur.visible_window_appearance || {}).rules || { window_class: {}, window_title: {}, process_name: {} } },
    maximized_window_appearance: { ...off('maximized_window_appearance'), rules: (cur.maximized_window_appearance || {}).rules || { window_class: {}, window_title: {}, process_name: {} } },
    start_opened_appearance: off('start_opened_appearance'),
    search_opened_appearance: off('search_opened_appearance'),
    task_view_opened_appearance: off('task_view_opened_appearance'),
    battery_saver_appearance: off('battery_saver_appearance'),
    hide_tray: true,
  };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

// mode: 'off' | 'clear' | 'blur' | 'acrylic'. Returns a short status for Settings.
async function apply(mode, dark, log = () => {}) {
  if (!installed()) return { ok: false, installed: false };
  try {
    if (mode === 'off') {
      if (await running()) {
        write('off', dark);   // back to Windows' own look first, then close it
        setTimeout(() => run('taskkill', ['/IM', 'TranslucentTB.exe']), 1500);
      }
      return { ok: true, installed: true };
    }
    write(mode, dark);
    if (!(await running())) spawn('explorer.exe', [`shell:AppsFolder\\${await appUserModelId()}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, installed: true };
  } catch (e) {
    log('taskbar: ' + e.message);
    return { ok: false, installed: true, error: e.message };
  }
}

module.exports = { apply, installed, STORE };
