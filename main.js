// FJBC Notch — a Dynamic Island for Windows.
// Main process: island window, tray menu, settings, Windows helper, weather,
// lyrics, messages, calendar and the local endpoint for Claude Code hooks.
'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, powerMonitor,
  clipboard, shell, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The window is sized to the island itself (the renderer reports its size), so it
// catches clicks normally and never covers the apps around it.
let winSize = { w: 240, h: 40 };

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('com.fjbc.notch');

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = {
  theme: 'white',               // 'white' | 'dark'
  city: 'Amsterdam',
  launchAtLogin: false,
  display: 'primary',          // 'primary' | 'mouse' | a display id
  displayLabel: '',             // remembered name, used if the id changes
  calendarUrl: '',              // ICS link (Outlook: Settings > Calendar > Shared calendars > Publish)
  messageApps: 'WhatsApp, Telegram, Signal, Teams, Discord, Messenger, Slack, Instagram, Phone Link, YourPhone, Mail, Outlook',
  messageAllApps: false,
  peeks: { apps: false, power: true, claudeApp: true },
  schema: 2,
  tiles: [
    { id: 'claude', show: true, size: 3 },
    { id: 'music', show: true, size: 3 },
    { id: 'weather', show: true, size: 2 },
    { id: 'messages', show: true, size: 3 },
    { id: 'controls', show: true, size: 2 },
    { id: 'calendar', show: false, size: 2 },
    { id: 'timer', show: false, size: 2 },
  ],
};

let settingsPath;
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings = { ...settings, ...saved, peeks: { ...settings.peeks, ...(saved.peeks || {}) } };
    // keep any tile added in a newer version
    const ids = new Set(settings.tiles.map(t => t.id));
    for (const t of DEFAULT_SETTINGS.tiles) if (!ids.has(t.id)) settings.tiles.push({ ...t });
    settings.tiles = settings.tiles.filter(t => DEFAULT_SETTINGS.tiles.some(d => d.id === t.id));
    // 1.9.0: Claude Code tile first, app open/close bubbles off.
    if (!saved.schema || saved.schema < 2) {
      settings.tiles = [{ id: 'claude', show: true, size: 3 }, ...settings.tiles.filter(t => t.id !== 'claude')];
      settings.peeks = { ...settings.peeks, apps: false };
      settings.schema = 2;
      saveSettings();
    }
  } catch { /* first run */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('save settings', e); }
}

function applySettings(next, { fromSettingsWindow = false } = {}) {
  const prevCity = settings.city;
  const prevCal = settings.calendarUrl;
  const prevDisplay = settings.display;
  settings = { ...settings, ...next };
  if (settings.display !== prevDisplay) {
    const d = screen.getAllDisplays().find(x => String(x.id) === String(settings.display));
    settings.displayLabel = d ? displayName(d, 0, true) : '';
    placeIsland(true);
  }
  saveSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  broadcast('settings', settings);
  if (settings.city !== prevCity) refreshWeather(true);
  if (settings.calendarUrl !== prevCal) refreshCalendar(true);
  refreshMessages();
  buildTrayMenu();
  if (!fromSettingsWindow && settingsWin) settingsWin.webContents.send('settings', settings);
}

// ---------------------------------------------------------------- windows
let island = null;
let settingsWin = null;
let tray = null;
let islandOpen = false;

// ---------------------------------------------------------------- which screen
function displayName(d, index, bare = false) {
  const primary = d.id === screen.getPrimaryDisplay().id;
  const size = `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`;
  const name = (d.label && d.label.trim()) || (d.internal ? 'Built-in screen' : `Screen ${index + 1}`);
  if (bare) return `${name} ${size}`;
  return `${name} · ${size}${primary ? ' (main)' : ''}`;
}

function listDisplays() {
  const all = screen.getAllDisplays();
  return all.map((d, i) => ({ id: String(d.id), name: displayName(d, i), primary: d.id === screen.getPrimaryDisplay().id }));
}

function targetDisplay() {
  const all = screen.getAllDisplays();
  const want = settings.display || 'primary';
  if (want === 'mouse') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (want !== 'primary') {
    const byId = all.find(d => String(d.id) === String(want));
    if (byId) return byId;
    // The id can change after a driver update or replugging: fall back to the remembered name.
    const byName = settings.displayLabel && all.find(d => displayName(d, 0, true) === settings.displayLabel);
    if (byName) return byName;
  }
  return screen.getPrimaryDisplay();
}

let placedOn = null;
function islandBounds(d = targetDisplay()) {
  const b = d.bounds;
  return { x: Math.round(b.x + (b.width - winSize.w) / 2), y: b.y, width: winSize.w, height: winSize.h };
}

function placeIsland(force = false) {
  if (!island || island.isDestroyed()) return;
  const d = targetDisplay();
  if (!force && placedOn === d.id) return;
  placedOn = d.id;
  const b = islandBounds(d);
  island.setBounds(b);
  island.setBounds(b);   // second call settles size when moving between screens with different scaling
}

// "Screen with the mouse": move over while the island is closed.
setInterval(() => {
  if (settings.display === 'mouse' && !islandOpen) placeIsland();
}, 600);

let identifyWins = [];
function identifyScreens() {
  for (const w of identifyWins) if (!w.isDestroyed()) w.close();
  identifyWins = screen.getAllDisplays().map((d, i) => {
    const w = new BrowserWindow({
      x: Math.round(d.bounds.x + d.bounds.width / 2 - 170), y: Math.round(d.bounds.y + d.bounds.height / 2 - 110),
      width: 340, height: 220, frame: false, transparent: true, resizable: false, skipTaskbar: true,
      focusable: false, alwaysOnTop: true, show: false, hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    const dark = settings.theme === 'dark';
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:transparent;font-family:'Segoe UI Variable Display','Segoe UI',sans-serif">
      <div style="background:${dark ? '#111111' : '#F7F8FA'};color:${dark ? '#ECECEC' : '#1E2129'};border-radius:24px;padding:22px 34px;text-align:center;box-shadow:0 14px 34px rgba(0,0,0,.25)">
      <div style="font-size:84px;font-weight:300;line-height:1">${i + 1}</div>
      <div style="font-size:14px;color:${dark ? '#9A9A9A' : '#545A69'};margin-top:8px">${displayName(d, i).replace(/[<>&]/g, '')}</div></div></body>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.showInactive());
    return w;
  });
  setTimeout(() => { for (const w of identifyWins) if (!w.isDestroyed()) w.close(); identifyWins = []; }, 2500);
}

function createIsland() {
  island = new BrowserWindow({
    ...islandBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,          // never steals focus
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setMenu(null);
  island.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  island.once('ready-to-show', () => island.showInactive());

  // Follow the pointer from here rather than relying on the window's mouse events,
  // which Windows can drop while another window of this app (Settings) is in front.
  let lastPointer = '';
  setInterval(() => {
    if (!island || island.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = island.getBounds();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    const msg = inside ? { x: c.x - b.x, y: c.y - b.y } : null;
    const key = msg ? `${msg.x},${msg.y}` : 'out';
    if (key === lastPointer) return;
    lastPointer = key;
    island.webContents.send('pointer', msg);
  }, 100);

  // Some full-screen apps push themselves on top; re-assert gently.
  setInterval(() => {
    if (!island || island.isDestroyed()) return;
    island.setAlwaysOnTop(true, 'screen-saver');
    island.moveTop();
  }, 3000);

  const reposition = () => { placeIsland(true); buildTrayMenu(); broadcast('displays', listDisplays()); };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  placedOn = targetDisplay().id;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 720, minWidth: 460, minHeight: 520,
    title: 'FJBC Notch settings',
    backgroundColor: settings.theme === 'dark' ? '#111111' : '#F7F8FA',
    autoHideMenuBar: true,
    icon: trayImage(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function broadcast(channel, data) {
  for (const w of [island, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}
function toIsland(channel, data) {
  if (island && !island.isDestroyed()) island.webContents.send(channel, data);
}

// ---------------------------------------------------------------- tray
function trayImage() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
}

const TILE_NAMES = {
  claude: 'Claude', music: 'Music', weather: 'Weather', messages: 'Messages',
  controls: 'Quick controls', calendar: 'Next event', timer: 'Focus timer',
};

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `FJBC Notch ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Tiles', submenu: settings.tiles.map(t => ({
        label: TILE_NAMES[t.id], type: 'checkbox', checked: t.show,
        click: () => applySettings({ tiles: settings.tiles.map(x => x.id === t.id ? { ...x, show: !x.show } : x) }),
      })),
    },
    {
      label: 'Screen', submenu: [
        { label: 'Main screen', type: 'radio', checked: (settings.display || 'primary') === 'primary', click: () => applySettings({ display: 'primary' }) },
        { label: 'Screen with the mouse', type: 'radio', checked: settings.display === 'mouse', click: () => applySettings({ display: 'mouse' }) },
        { type: 'separator' },
        ...listDisplays().map(d => ({
          label: d.name, type: 'radio', checked: String(settings.display) === d.id,
          click: () => applySettings({ display: d.id }),
        })),
        { type: 'separator' },
        { label: 'Identify screens', click: identifyScreens },
      ],
    },
    {
      label: 'Theme', submenu: [
        { label: 'White Matte', type: 'radio', checked: settings.theme === 'white', click: () => applySettings({ theme: 'white' }) },
        { label: 'Dark Matte', type: 'radio', checked: settings.theme === 'dark', click: () => applySettings({ theme: 'dark' }) },
      ],
    },
    { label: `Weather city: ${settings.city || '—'}…`, click: openSettings },
    { label: 'Launch at login', type: 'checkbox', checked: !!settings.launchAtLogin, click: () => applySettings({ launchAtLogin: !settings.launchAtLogin }) },
    { type: 'separator' },
    updateMenuItem(),
    { label: 'Settings…', click: openSettings },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('FJBC Notch');
  tray.on('click', openSettings);
  buildTrayMenu();
}

// ---------------------------------------------------------------- Windows helper (PowerShell)
let helper = null;
let helperBuf = '';
let helperRestarts = 0;
const state = { media: null, radios: {}, volume: null, brightness: null, dark: null };

function helperPath() {
  // Not inside asar (packaged with asar disabled), so PowerShell can read it.
  return path.join(__dirname, 'helper', 'helper.ps1');
}

function startHelper() {
  if (process.platform !== 'win32') return;
  helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', helperPath(),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', chunk => {
    helperBuf += chunk;
    let i;
    while ((i = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, i).trim();
      helperBuf = helperBuf.slice(i + 1);
      if (line) { try { onHelperMessage(JSON.parse(line)); } catch { /* ignore partial */ } }
    }
  });
  helper.stderr.on('data', d => console.error('[helper]', String(d).trim()));
  helper.on('exit', code => {
    helper = null;
    if (quitting) return;
    if (helperRestarts++ < 5) setTimeout(startHelper, 2000 * helperRestarts);
  });
  sendHelper({ c: 'mode', open: islandOpen });
}

function sendHelper(cmd) {
  if (helper && helper.stdin.writable) helper.stdin.write(JSON.stringify(cmd) + '\n');
}

let lastTrackKey = '';
let appsBaselineDone = false;

async function onHelperMessage(m) {
  switch (m.t) {
    case 'media': {
      state.media = m.data;
      toIsland('media', m.data);
      const key = m.data ? `${m.data.artist}|${m.data.title}` : '';
      if (key && key !== lastTrackKey) {
        lastTrackKey = key;
        const lyr = await getLyrics(m.data);
        if (`${state.media?.artist}|${state.media?.title}` === key) toIsland('lyrics', { key, lines: lyr });
      }
      break;
    }
    case 'art': {
      const a = m.data || {};
      if (a.src) { toIsland('art', a); break; }
      // The player gave no cover: look it up online by artist and title.
      const want = a.key;
      const media = state.media;
      const src = media && `${media.artist}|${media.title}` === want ? await lookupCover(media) : null;
      if (`${state.media?.artist}|${state.media?.title}` === want) toIsland('art', { key: want, src });
      break;
    }
    case 'radios': state.radios = m.data; toIsland('radios', m.data); break;
    case 'volume': state.volume = m.data; toIsland('volume', m.data); break;
    case 'brightness': state.brightness = m.data; toIsland('brightness', m.data); break;
    case 'dark': state.dark = m.data; toIsland('dark', m.data); break;
    case 'apps': {
      if (!appsBaselineDone) { appsBaselineDone = true; break; }  // no peeks for apps already open
      if (!settings.peeks.apps) break;
      for (const a of (m.data.opened || []).slice(0, 2)) peekApp(a, 'opened');
      for (const a of (m.data.closed || []).slice(0, 2)) peekApp(a, 'closed');
      break;
    }
    case 'fg': {
      // You switched to the Claude app: everything it announced before now counts as dealt with.
      if (/^claude$/i.test(String(m.data && m.data.name || ''))) markClaudeHandled();
      break;
    }
    case 'claudebusy': {
      claudeBusy = !!(m.data && m.data.busy);
      helperLog(`claude ${claudeBusy ? 'working' : 'quiet'} (${m.data && m.data.pct}% cpu)`);   // for tuning the threshold
      toIsland('claude-busy', claudeBusy);
      break;
    }
    case 'log': helperLog(m.data); break;
  }
}

async function peekApp(a, verb) {
  let icon = null;
  try {
    if (a.path) icon = (await app.getFileIcon(a.path, { size: 'normal' })).toDataURL();
  } catch { /* no icon */ }
  toIsland('peek', { kind: 'app', title: a.name, sub: verb === 'opened' ? 'Opened' : 'Closed', icon });
}

// ---------------------------------------------------------------- HTTP helper
async function getJSON(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'FJBC-Notch/1.0 (personal desktop app)' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- weather (Open-Meteo, no key)
let weatherTimer = null;
let geoCache = { city: null, loc: null };

async function refreshWeather(force) {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(() => refreshWeather(), 15 * 60 * 1000);
  const city = (settings.city || '').trim();
  if (!city) { toIsland('weather', { error: 'Set a city in Settings' }); return; }
  try {
    if (force || geoCache.city !== city) {
      const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(city)}`);
      const r = g && g.results && g.results[0];
      if (!r) { toIsland('weather', { error: `City not found: ${city}` }); return; }
      geoCache = { city, loc: { lat: r.latitude, lon: r.longitude, name: r.name } };
    }
    const { lat, lon, name } = geoCache.loc;
    const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
    toIsland('weather', {
      city: name,
      temp: Math.round(w.current.temperature_2m),
      code: w.current.weather_code,
      isDay: !!w.current.is_day,
      hi: Math.round(w.daily.temperature_2m_max[0]),
      lo: Math.round(w.daily.temperature_2m_min[0]),
    });
  } catch (e) {
    toIsland('weather', { error: 'Weather unavailable' });
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(() => refreshWeather(), 2 * 60 * 1000);
  }
}

// ---------------------------------------------------------------- helper log (for troubleshooting)
function helperLog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'helper.log');
    try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old'); } catch { /* no log yet */ }
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* never let logging break the app */ }
}

// ---------------------------------------------------------------- album covers (fallback when the player has none)
// Uses the iTunes Search API (free, no key, no account). Cached on disk, including "not found".
function coverCacheDir() {
  const d = path.join(app.getPath('userData'), 'covers');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function lookupCover(m) {
  if (!m || !m.title) return null;
  const key = crypto.createHash('sha1').update(`${m.artist}|${m.title}`.toLowerCase()).digest('hex');
  const dir = coverCacheDir();
  const img = path.join(dir, key + '.jpg');
  const miss = path.join(dir, key + '.none');
  try { return 'data:image/jpeg;base64,' + fs.readFileSync(img).toString('base64'); } catch { /* not cached */ }
  try { if (Date.now() - fs.statSync(miss).mtimeMs < 7 * 864e5) return null; } catch { /* not marked missing */ }
  try {
    // Players sometimes put "Artist - Title" in the title, or the album artist in the artist field.
    const artist = String(m.artist || '').split(/,|&| feat\.? | ft\.? /i)[0].trim();
    const term = `${artist} ${String(m.title).replace(/\(.*?\)|\[.*?\]/g, '')}`.trim();
    const r = await getJSON('https://itunes.apple.com/search?' + new URLSearchParams({ term, media: 'music', entity: 'song', limit: '10' }));
    const results = (r && r.results) || [];
    const t = norm(m.title), a = norm(artist);
    const pick = results.find(x => norm(x.trackName) === t && (!a || norm(x.artistName).includes(a) || a.includes(norm(x.artistName))))
      || results.find(x => norm(x.trackName).startsWith(t) && (!a || norm(x.artistName).includes(a)))
      || results.find(x => a && norm(x.artistName).includes(a) && m.album && norm(x.collectionName) === norm(m.album));
    if (!pick || !pick.artworkUrl100) { fs.writeFileSync(miss, ''); return null; }
    const url = pick.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    const res = await fetch(url, { headers: { 'User-Agent': 'FJBC-Notch/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(img, buf);
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    helperLog('cover lookup: ' + e.message);
    return null;
  }
}

// ---------------------------------------------------------------- lyrics (LRCLIB, no key, cached)
function lyricsCacheDir() {
  const d = path.join(app.getPath('userData'), 'lyrics');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function parseLrc(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const t of tags) out.push({ t: (parseInt(t[1], 10) * 60 + parseFloat(t[2])) * 1000, l: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function getLyrics(m) {
  if (!m || !m.title) return [];
  const key = crypto.createHash('sha1').update(`${m.artist}|${m.title}`.toLowerCase()).digest('hex');
  const file = path.join(lyricsCacheDir(), key + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  let lines = [];
  try {
    const q = new URLSearchParams({ track_name: m.title, artist_name: m.artist || '' });
    if (m.album) q.set('album_name', m.album);
    if (m.durMs > 0) q.set('duration', String(Math.round(m.durMs / 1000)));
    let r = await getJSON('https://lrclib.net/api/get?' + q.toString());
    if (!r || !r.syncedLyrics) {
      const s = await getJSON('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: m.title, artist_name: m.artist || '' }));
      r = Array.isArray(s) ? s.find(x => x.syncedLyrics) : null;
    }
    lines = r && r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
    fs.writeFileSync(file, JSON.stringify(lines));   // also caches "no lyrics"
  } catch { /* offline: try again next time */ }
  return lines;
}

// ---------------------------------------------------------------- messages (Windows notification database, read-only, local)
let messagesTimer = null;

function appLabel(primaryId) {
  const id = String(primaryId || '');
  const known = [
    [/whatsapp/i, 'WhatsApp'], [/telegram/i, 'Telegram'], [/signal/i, 'Signal'], [/teams/i, 'Teams'],
    [/discord/i, 'Discord'], [/messenger/i, 'Messenger'], [/slack/i, 'Slack'], [/instagram/i, 'Instagram'],
    [/yourphone|phonelink/i, 'Phone Link'], [/outlook|olk/i, 'Outlook'], [/windowscommunicationsapps|mail/i, 'Mail'],
  ];
  for (const [re, n] of known) if (re.test(id)) return n;
  const base = id.split('!')[0].split('\\').pop().split('_')[0].split('.').pop();
  return base || 'App';
}

function decodeXml(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').trim();
}

function filetimeToMs(ft) {
  // FILETIME: 100-ns ticks since 1601-01-01
  const n = typeof ft === 'bigint' ? ft : BigInt(ft);
  return Number(n / 10000n - 11644473600000n);
}

function readNotifications() {
  if (process.platform !== 'win32') return { error: 'Windows only' };
  const src = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
  if (!fs.existsSync(src)) return { error: 'No notification database found' };
  // Copy the database (and its WAL) so we never lock the one Windows is using.
  const tmp = path.join(os.tmpdir(), 'fjbc-notch-wpn');
  fs.mkdirSync(tmp, { recursive: true });
  const dst = path.join(tmp, 'wpn.db');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.copyFileSync(src + ext, dst + ext); } catch { try { fs.rmSync(dst + ext, { force: true }); } catch {} }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dst, { readOnly: false });   // needs write to replay the WAL copy
  try {
    db.exec('PRAGMA query_only = 1');
    const stmt = db.prepare(`
      SELECT n.Id AS id, n.Payload AS payload, n.ArrivalTime AS arrival, h.PrimaryId AS appId
      FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
      WHERE n.Type = 'toast'
      ORDER BY n.ArrivalTime DESC LIMIT 300`);
    stmt.setReadBigInts(true);   // FILETIME values are larger than 2^53
    const rows = stmt.all();
    return { rows };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- Claude desktop app (chats and Cowork)
// Chats and Cowork run on Anthropic's servers, so the only local signal is the Windows
// notifications the Claude app sends ("<chat name>: Claude needs your input to continue").
// Watch the notification database and turn Claude's toasts into bubbles and tile entries.
let claudeAppSeen = null;
let claudeBusy = false;
let claudeAppSig = '';
let claudeAppItems = [];
const isClaudeApp = id => /^Claude_[a-z0-9]+!Claude$/i.test(String(id)) || /anthropic/i.test(String(id));

function classifyClaude(msg) {
  if (/needs? your (input|approval|permission)|waiting for you|approve|permission/i.test(msg)) return 'input';
  if (/finished|done|complete|ready|replied|responded/i.test(msg)) return 'done';
  return 'info';
}

function pollClaudeApp(force = false) {
  if (process.platform !== 'win32' || settings.peeks.claudeApp === false) return;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
  let sig = '';
  try { sig = ['', '-wal'].map(e => { try { const st = fs.statSync(base + e); return st.mtimeMs + ':' + st.size; } catch { return '-'; } }).join('|'); } catch {}
  if (!force && sig === claudeAppSig) return;
  claudeAppSig = sig;
  let res;
  try { res = readNotifications(); } catch (e) { helperLog('claude app: ' + e.message); return; }
  if (!res || res.error) return;
  const items = [];
  for (const r of res.rows) {
    if (!isClaudeApp(r.appId)) continue;
    const xml = Buffer.isBuffer(r.payload) || ArrayBuffer.isView(r.payload) ? Buffer.from(r.payload).toString('utf8') : String(r.payload || '');
    const texts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)].map(x => decodeXml(x[1])).filter(Boolean);
    if (!texts.length) continue;
    const title = texts.length > 1 ? texts[0] : 'Claude';
    const message = texts.length > 1 ? texts.slice(1).join(' · ') : texts[0];
    items.push({ id: String(r.id), appId: String(r.appId), title, message, kind: classifyClaude(message), at: filetimeToMs(r.arrival) });
  }
  items.sort((a, b) => b.at - a.at);
  const fresh = claudeAppSeen ? items.filter(i => !claudeAppSeen.has(i.id)) : [];
  claudeAppSeen = new Set([...(claudeAppSeen || []), ...items.map(i => i.id)]);
  for (const i of fresh.slice(0, 3).reverse()) {
    toIsland('peek', { kind: 'claude-app', title: i.title, sub: i.message, tone: i.kind, ms: i.kind === 'input' ? 6000 : 4000 });
  }
  claudeAppItems = items.slice(0, 10);
  sendClaudeApp();
}

// Only what still matters: not dealt with, a 'needs you' from the last hour,
// or a 'done' from the last 10 minutes.
function relevantClaudeItems() {
  const now = Date.now();
  const handledAt = settings.claudeHandledAt || 0;
  return claudeAppItems.filter(i => i.at > handledAt &&
    (i.kind === 'input' ? now - i.at < 60 * 60 * 1000 : now - i.at < 10 * 60 * 1000));
}
function sendClaudeApp() { toIsland('claude-app', relevantClaudeItems()); }
function markClaudeHandled() {
  const before = relevantClaudeItems().length;
  settings.claudeHandledAt = Date.now();
  saveSettings();
  if (before) sendClaudeApp();
}
setInterval(sendClaudeApp, 60 * 1000);   // let old ones expire

function refreshMessages() {
  clearTimeout(messagesTimer);
  messagesTimer = setTimeout(refreshMessages, islandOpen ? 15000 : 60000);
  const tile = settings.tiles.find(t => t.id === 'messages');
  if (!tile || !tile.show) return;
  try {
    const res = readNotifications();
    if (res.error) { toIsland('messages', { error: res.error }); return; }
    const allowed = settings.messageApps.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const convos = new Map();
    for (const r of res.rows) {
      if (isClaudeApp(r.appId)) continue;   // Claude has its own tile
      const appName = appLabel(r.appId);
      if (!settings.messageAllApps && !allowed.some(a => appName.toLowerCase().includes(a) || String(r.appId).toLowerCase().includes(a.replace(/\s/g, '')))) continue;
      const xml = Buffer.isBuffer(r.payload) || ArrayBuffer.isView(r.payload) ? Buffer.from(r.payload).toString('utf8') : String(r.payload || '');
      const texts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)].map(x => decodeXml(x[1])).filter(Boolean);
      if (!texts.length) continue;
      const name = texts[0];
      const line = texts.slice(1).join(' · ') || '';
      const k = appName + '|' + name;
      const at = filetimeToMs(r.arrival);
      const c = convos.get(k);
      if (c) c.count++;
      else convos.set(k, { app: appName, name, line, at, count: 1 });
    }
    toIsland('messages', { items: [...convos.values()].sort((a, b) => b.at - a.at).slice(0, 6) });
  } catch (e) {
    toIsland('messages', { error: 'Could not read notifications' });
    console.error('messages', e);
  }
}

// ---------------------------------------------------------------- calendar (ICS link, optional)
let calTimer = null;

function icsDate(v) {
  // 20261017T090000Z | 20261017T090000 | 20261017
  const m = String(v).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

function parseIcs(text) {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const events = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = k => { const m = body.match(new RegExp('^' + k + '(?:;[^:\\n]*)?:(.*)$', 'm')); return m ? m[1].trim() : null; };
    const start = icsDate(get('DTSTART'));
    if (!start) continue;
    const allDay = /DTSTART;VALUE=DATE:/.test(body);
    const rrule = get('RRULE');
    let ev = { title: (get('SUMMARY') || 'Event').replace(/\\,/g, ',').replace(/\\n/g, ' '), start, allDay, location: (get('LOCATION') || '').replace(/\\,/g, ',') };
    // Simple weekly/daily recurrences: move to the next occurrence.
    if (rrule) {
      const freq = (rrule.match(/FREQ=(\w+)/) || [])[1];
      const until = icsDate((rrule.match(/UNTIL=([^;]+)/) || [])[1] || '');
      const step = freq === 'DAILY' ? 864e5 : freq === 'WEEKLY' ? 7 * 864e5 : 0;
      if (step) {
        const now = Date.now();
        let t = start;
        if (t < now) t += Math.ceil((now - t) / step) * step;
        if (!until || t <= until) ev.start = t;
      }
    }
    events.push(ev);
  }
  return events;
}

async function refreshCalendar() {
  clearTimeout(calTimer);
  calTimer = setTimeout(refreshCalendar, 10 * 60 * 1000);
  const url = (settings.calendarUrl || '').trim().replace(/^webcal:/i, 'https:');
  if (!url) { toIsland('calendar', { error: 'Add a calendar link in Settings' }); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FJBC-Notch/1.0' } });
    const txt = await r.text();
    const now = Date.now();
    const next = parseIcs(txt).filter(e => e.start >= now - 15 * 60000).sort((a, b) => a.start - b.start)[0];
    toIsland('calendar', next ? { event: next } : { empty: true });
  } catch { toIsland('calendar', { error: 'Calendar unavailable' }); }
}

// ---------------------------------------------------------------- auto-update (GitHub releases)
// Checks paramtric-design-3/Notch-setup releases at start, every 5 minutes, and after sleep or unlock.
// Downloads quietly, then installs by itself as soon as you've been idle for a minute with the notch closed
// (or straight away from the tray, or when the app quits).
const update = { state: 'idle', version: null, percent: 0, error: null, manual: false };
let autoUpdater = null;

function setUpdate(patch) {
  Object.assign(update, patch);
  buildTrayMenu();
  broadcast('update', { ...update, current: app.getVersion(), packaged: app.isPackaged });
}

function updateMenuItem() {
  switch (update.state) {
    case 'checking': return { label: 'Checking for updates…', enabled: false };
    case 'downloading': return { label: `Downloading update ${update.percent}%…`, enabled: false };
    case 'ready': return { label: `Restart to update to ${update.version}`, click: installUpdate };
    default: return { label: 'Check for updates', click: () => checkForUpdates(true), enabled: app.isPackaged };
  }
}

function setupUpdater() {
  if (!app.isPackaged) return;            // only the installed app updates itself
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', error: null }));
  autoUpdater.on('update-available', info => setUpdate({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => {
    const pct = Math.round(p.percent || 0);
    if (pct !== update.percent) setUpdate({ percent: pct });
  });
  autoUpdater.on('update-not-available', () => {
    if (update.manual) toIsland('peek', { kind: 'update', title: 'FJBC Notch is up to date', sub: `Version ${app.getVersion()}` });
    setUpdate({ state: 'idle', manual: false });
  });
  autoUpdater.on('update-downloaded', info => {
    setUpdate({ state: 'ready', version: info.version, manual: false });
    toIsland('peek', { kind: 'update', title: `Update ${info.version} ready`, sub: 'Installing now, back in a few seconds', ms: 3000 });
    waitForIdleThenInstall();
  });
  autoUpdater.on('error', e => {
    if (update.manual) toIsland('peek', { kind: 'update', title: 'Could not check for updates', sub: 'Try again later' });
    setUpdate({ state: update.state === 'ready' ? 'ready' : 'idle', error: String(e && e.message || e).slice(0, 200), manual: false });
  });
  setTimeout(() => checkForUpdates(false), 15 * 1000);
  setInterval(() => checkForUpdates(false), UPDATE_EVERY_MS);
  // A PC that slept through a release checks as soon as it's back.
  const soon = () => setTimeout(() => checkForUpdates(false), 5000);
  powerMonitor.on('resume', soon);
  powerMonitor.on('unlock-screen', soon);
  // Locking the PC is a good moment to install a waiting update.
  powerMonitor.on('lock-screen', () => { if (update.state === 'ready') installUpdate(); });
}

function checkForUpdates(manual) {
  if (!autoUpdater || update.state === 'checking' || update.state === 'downloading') return;
  if (update.state === 'ready') { if (manual) installUpdate(); return; }
  update.manual = !!manual;
  autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ });
}

const UPDATE_EVERY_MS = 5 * 60 * 1000;
let idleWatch = null;

function waitForIdleThenInstall() {
  clearInterval(idleWatch);
  idleWatch = setInterval(() => {
    if (update.state !== 'ready') { clearInterval(idleWatch); return; }
    // Install as soon as the notch is closed: the restart takes a few seconds and
    // waiting for an idle minute meant updates sat there while you worked.
    if (islandOpen) return;
    clearInterval(idleWatch);
    toIsland('peek', { kind: 'update', title: `Updating to ${update.version}`, sub: 'Back in a few seconds', ms: 2500 });
    setTimeout(installUpdate, 2500);
  }, 3 * 1000);
}

function installUpdate() {
  if (!autoUpdater || update.state !== 'ready') return;
  quitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));   // silent install, start again afterwards
}

// ---------------------------------------------------------------- IPC
ipcMain.on('island-size', (_e, size) => {
  if (!island || island.isDestroyed() || !size) return;
  const w = Math.max(60, Math.min(2000, Math.round(size.w / 2) * 2));   // even width keeps it centred on the pixel
  const h = Math.max(20, Math.min(1000, Math.round(size.h)));
  if (w === winSize.w && h === winSize.h) return;
  winSize = { w, h };
  const d = screen.getAllDisplays().find(x => x.id === placedOn) || targetDisplay();
  island.setBounds(islandBounds(d));
});
ipcMain.on('island-open', (_e, open) => {
  islandOpen = !!open;
  sendHelper({ c: 'mode', open: islandOpen });
  if (islandOpen) refreshMessages();
});
ipcMain.on('helper', (_e, cmd) => sendHelper(cmd));
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('open-url', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, next) => { applySettings(next, { fromSettingsWindow: true }); return settings; });
ipcMain.handle('copy-text', (_e, t) => { clipboard.writeText(String(t)); return true; });
ipcMain.handle('initial-state', () => ({ settings, state }));
// Bring the Claude desktop app to the front. Its notifications carry no link to a
// specific chat, so this opens the app; the waiting chat is at the top of its list.
ipcMain.on('open-claude', (_e, appId) => {
  markClaudeHandled();
  const id = isClaudeApp(appId) ? String(appId) : (claudeAppItems[0] && claudeAppItems[0].appId);
  if (process.platform === 'win32' && id && /^[\w.!-]+$/.test(id)) {
    spawn('explorer.exe', [`shell:AppsFolder\\${id}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    shell.openExternal('claude://').catch(() => {});
  }
});
ipcMain.on('claude-app-request', () => { sendClaudeApp(); toIsland('claude-busy', claudeBusy); });
ipcMain.handle('get-displays', () => listDisplays());
ipcMain.handle('get-update', () => ({ ...update, current: app.getVersion(), packaged: app.isPackaged }));
ipcMain.on('check-updates', () => checkForUpdates(true));
ipcMain.on('install-update', () => installUpdate());
ipcMain.on('identify-screens', () => identifyScreens());
ipcMain.on('refresh-all', () => { refreshWeather(); refreshMessages(); refreshCalendar(); });

// ---------------------------------------------------------------- lifecycle
let quitting = false;

app.whenReady().then(() => {
  loadSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  createIsland();
  createTray();
  startHelper();
  setupUpdater();
  island.webContents.once('did-finish-load', () => {
    toIsland('settings', settings);
    refreshWeather(true);
    refreshMessages();
    refreshCalendar();
    pollClaudeApp(true);
  });
  setInterval(() => pollClaudeApp(false), 2000);
  nativeTheme.on('updated', () => toIsland('dark', { on: nativeTheme.shouldUseDarkColors }));
});

app.on('second-instance', openSettings);
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => {
  quitting = true;
  if (helper) { try { helper.kill(); } catch {} }
});
