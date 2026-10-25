// WALL-E — island renderer.
'use strict';

const api = window.notch;
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const island = $('#island');
const tilesView = $('#tiles');
const peekView = $('#peek');
const compactL = $('.compact-l');
const compactR = $('.compact-r');

// No camera on this screen: no dead space in the middle, and no black band when open.
const NOTCH_W = 120, NOTCH_H = 30, COMPACT_W = 132, COMPACT_TIMER_W = 140, PEEK_W = 360, PERM_W = 580;

// ------------------------------------------------------------------ data
const D = {
  settings: null,
  media: null, art: null, lyrics: { key: '', lines: [] },
  radios: {}, volume: null, brightness: null, dark: null,
  weather: null, messages: null, calendar: null,
  timer: { total: 25 * 60 * 1000, left: 25 * 60 * 1000, running: false, endsAt: 0 },
  league: null,           // League client state: { client, phase, me, game, cs, top }
  leagueOpen: false,      // the League tile was clicked open
  outputs: [], outPicker: false,   // sound output devices and whether the picker is open
};

// ------------------------------------------------------------------ state machine
let state = 'rest';        // rest | compact | peek | open
let pinned = false;
let hovering = false;
let hoverTimer = null, leaveTimer = null, peekTimer = null;
const peekQueue = [];
let currentPeek = null;

function wantCompact() {
  if (D.timer.running) return 'timer';
  if (D.media && D.media.playing) return 'music';
  return null;
}

let lastOpenSent = null;
let csShownOnce = false;
let csPinned = false;   // the pin was set by champ select, not by you
function setState(next) {
  state = next;
  island.className = 's-' + next;
  if (next !== 'open') D.outPicker = false;
  if (next === 'open') renderTiles();
  if (next === 'compact' || next === 'rest') renderCompact();
  sizeIsland();
  const open = next === 'open';
  if (open !== lastOpenSent) { lastOpenSent = open; api.send('island-open', open); }   // only real changes reach the helper
  startTicker();
}

function settle() {
  // Pick the right resting state when nothing is forcing one.
  if (hovering || pinned) return setState('open');
  if (currentPeek) return setState('peek');
  return setState(wantCompact() ? 'compact' : 'rest');
}

function sizeIsland() {
  let w = NOTCH_W, h = NOTCH_H;
  if (state === 'compact') { const k = wantCompact(); w = k === 'timer' ? COMPACT_TIMER_W : COMPACT_W; }
  else if (state === 'peek') { w = PEEK_W; h = peekView.offsetHeight; }
  else if (state === 'open') { w = Math.max(tilesView.offsetWidth, NOTCH_W + 80); h = tilesView.offsetHeight; }
  island.style.width = w + 'px';
  island.style.height = h + 'px';
  fitWindow(w, h, state === 'open' || state === 'peek');
}

// ------------------------------------------------------------------ window size
// The window hugs the island: it grows before the island animates bigger,
// and shrinks after the island has finished animating smaller.
const EAR = 10;
let winW = 0, winH = 0, shrinkTimer = null;
function fitWindow(w, h, shadow) {
  const padX = shadow ? 40 : 0, padB = shadow ? 56 : 0;
  const W = w + 2 * EAR + 2 * padX, H = h + padB;
  clearTimeout(shrinkTimer);
  if (W > winW || H > winH) {
    winW = Math.max(W, winW); winH = Math.max(H, winH);
    api.send('island-size', { w: winW, h: winH });
  }
  shrinkTimer = setTimeout(() => {
    if (W === winW && H === winH) return;
    winW = W; winH = H;
    api.send('island-size', { w: W, h: H });
  }, 650);
}

// Hover. The app tracks the pointer itself (see 'pointer' below) because Windows doesn't
// always tell this window that the mouse left, e.g. while Settings is in front.
function pointerEnter() {
  if (hovering) return;
  hovering = true;
  clearTimeout(leaveTimer);
  clearTimeout(hoverTimer);
  if (state !== 'open') hoverTimer = setTimeout(() => { if (hovering) setState('open'); }, 250);
}
function pointerLeave() {
  if (!hovering) return;
  hovering = false;
  clearTimeout(hoverTimer);
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => { if (!hovering && !pinned && state === 'open') settle(); }, 180);
}
island.addEventListener('mouseenter', pointerEnter);
island.addEventListener('mouseleave', pointerLeave);
api.on('pointer', p => {
  if (!p) return pointerLeave();                 // pointer is outside the window
  const r = island.getBoundingClientRect();
  const inside = p.x >= r.left - EAR && p.x <= r.right + EAR && p.y >= r.top && p.y <= r.bottom;
  inside ? pointerEnter() : pointerLeave();
});

island.addEventListener('click', e => {
  if (e.target.closest('button, pre, a')) return;
  if (state === 'open' && e.target.closest('.tile.league.clickable')) return;   // handled by the tile
  if (state === 'open') { csPinned = false; pinned = !pinned; island.classList.toggle('pinned', pinned); if (!pinned && !hovering) settle(); }
  else { pinned = true; setState('open'); }
});
island.addEventListener('contextmenu', e => { e.preventDefault(); api.send('open-settings'); });

// ------------------------------------------------------------------ helpers
const fmtTime = ms => { if (!(ms >= 0)) return '0:00'; const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtDur = ms => { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`; return `${Math.floor(m / 60)}h ${m % 60}m`; };
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function msgWhen(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(t);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function mediaPos() {
  const m = D.media;
  if (!m) return 0;
  let p = m.posMs || 0;
  if (m.playing && m.updatedAt > 0) p += Date.now() - m.updatedAt;
  return Math.max(0, Math.min(p, m.durMs || p));
}

function currentLyric() {
  const m = D.media;
  if (!m || D.lyrics.key !== `${m.artist}|${m.title}`) return '';
  const p = mediaPos() + 250;
  let line = '';
  for (const l of D.lyrics.lines) { if (l.t <= p) line = l.l; else break; }
  return line;
}

function weatherIcon(code, isDay) {
  if ([0, 1].includes(code)) return isDay ? I.w_sun : I.w_moon;
  if (code === 2) return isDay ? I.w_partly : I.w_cloud;
  if (code === 3) return I.w_cloud;
  if ([45, 48].includes(code)) return I.w_fog;
  if ([71, 73, 75, 77, 85, 86].includes(code)) return I.w_snow;
  if ([95, 96, 99].includes(code)) return I.w_storm;
  if (code >= 51) return I.w_rain;
  return I.w_cloud;
}

// ------------------------------------------------------------------ tiles
// A yellow folder, like the ones in Explorer, for folders on the shelf.
const FOLDER_PIC = `<svg class="shfolder" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h6.2l2.6 2.7h12.2A2.5 2.5 0 0 1 29 11.2V24a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 24z" fill="#E0A526"/><path d="M3 12.6A2.5 2.5 0 0 1 5.5 10.1h21A2.5 2.5 0 0 1 29 12.6V24a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 24z" fill="#F7C948"/></svg>`;

// The shelf's outline, drawn like the folder icon: a tab on the left that slopes down into the body.
function folderOutline(size) {
  const W = size * CELL + (size - 1) * GAP, H = 112, tw = Math.round(W * (size === 1 ? 0.42 : 0.34)), th = 11, r = 16, tr = 9, dx = 9;
  const p = `M0.5 ${H - r} V${tr + 0.5} Q0.5 0.5 ${tr + 0.5} 0.5 H${tw} Q${tw + 3} 0.5 ${tw + 5} 3 L${tw + dx} ${th - 1} Q${tw + dx + 2} ${th + 0.5} ${tw + dx + 5} ${th + 0.5} H${W - r} Q${W - 0.5} ${th + 0.5} ${W - 0.5} ${th + r} V${H - r} Q${W - 0.5} ${H - 0.5} ${W - r} ${H - 0.5} H${r} Q0.5 ${H - 0.5} 0.5 ${H - r} Z`;
  return `<svg class="shoutline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${p}"/></svg>`;
}

const TILE = {
  music(size) {
    if (D.outPicker && size > 1) return outputsPicker(size);
    const t = el('div', `tile music w${size}`);
    const m = D.media;
    const art = D.art && m && D.art.key === `${m.artist}|${m.title}` ? D.art.src : null;
    if (art) t.classList.add('has-art');
    const coverStyle = art ? `style="background-image:url('${art}')"` : '';
    const cover = art ? `<div class="cover" ${coverStyle}></div>` : `<div class="cover ph">${I.note}</div>`;
    const discLabel = art ? `style="--disc-label:url('${art}')"` : '';
    t.innerHTML = `<div class="bgart" ${coverStyle}></div>
      <div class="vinyl ${m && m.playing ? 'playing' : ''}" ${discLabel}><div class="disc"></div>${cover}</div>`;
    if (size === 1) {
      if (m) t.insertAdjacentHTML('beforeend', `<div class="playover"><button class="ibtn" data-media="toggle">${m.playing ? I.pause : I.play}</button></div>`);
      return t;
    }
    const meta = el('div', 'meta');
    if (!m) {
      meta.innerHTML = `<div class="title ellipsis">Nothing playing</div><div class="artist ellipsis">Play something in Spotify, your browser or any player</div>`;
    } else {
      meta.innerHTML = `
        <div class="title ellipsis">${esc(m.title)}</div>
        <div class="artist ellipsis">${esc(m.artist || m.album || '')}</div>
        <div class="lyric ellipsis" data-lyric></div>
        <div class="bar"><i data-bar></i></div>
        <div class="row">
          <span class="time" data-pos>0:00</span>
          <div class="ctl">
            <button class="ibtn" data-media="prev" title="Previous">${I.prev}</button>
            <button class="ibtn big" data-media="toggle" title="Play/Pause">${m.playing ? I.pause : I.play}</button>
            <button class="ibtn" data-media="next" title="Next">${I.next}</button>
          </div>
          <span class="time r">${fmtTime(m.durMs)}</span>
        </div>`;
    }
    t.append(meta);
    if (D.outputs.length > 1) {
      const cur = D.outputs.find(o => o.default);
      t.insertAdjacentHTML('beforeend', `<button class="ibtn outbtn" data-out title="Sound output: ${esc(cur ? cur.name : '')}">${outputIcon(cur)}</button>`);
    }
    return t;
  },

  weather(size) {
    const t = el('div', `tile weather w${size}`);
    const w = D.weather;
    if (!w) { t.innerHTML = `<div class="empty">Loading weather…</div>`; return t; }
    if (w.error) { t.innerHTML = `<div class="empty">${esc(w.error)}</div>`; return t; }
    t.innerHTML = `
      <div class="top"><div class="temp">${w.temp}°</div><div class="wicon">${weatherIcon(w.code, w.isDay)}</div></div>
      <div><div class="city ellipsis">${esc(w.city)}</div><div class="hl">H ${w.hi}°&nbsp;&nbsp;L ${w.lo}°</div></div>`;
    return t;
  },

  shelf(size) {   // eslint-disable-line
    const t = el('div', `tile shelf w${size}`);
    const list = D.shelf || [];
    const outline = folderOutline(size);
    if (!list.length) { t.innerHTML = `${outline}<div class="empty"><div class="ico">${I.folder}</div>${size > 1 ? 'Drop files or folders here to hold them' : 'Drop here'}</div>`; return t; }
    if (size === 1) {
      t.innerHTML = `${outline}<div class="shfile solo" draggable="true" data-shelfall title="Drag out all ${list.length}">${list[0].dir ? FOLDER_PIC : list[0].icon ? `<img src="${list[0].icon}" alt="">` : I.file}${list.length > 1 ? `<span class="badge">${list.length}</span>` : ''}</div>`;
      return t;
    }
    const shown = list.slice().reverse();   // newest first, one row you can scroll
    t.innerHTML = `${outline}
      <div class="shhead">
        <span class="shact">${list.length > 1 ? `<span class="shall" draggable="true" data-shelfall title="Drag all ${list.length} out">All ${list.length}</span>` : ''}<button class="shclear" data-shelfclear title="Clear the shelf">Clear</button></span></div>
      <div class="shlist">${shown.map(x => `
        <div class="shfile" draggable="true" data-shelfid="${esc(x.id)}" title="${esc(x.path)}&#10;Drag out to copy or move · double-click to show in its folder">
          ${x.dir ? FOLDER_PIC : x.icon ? `<img src="${x.icon}" alt="">` : `<span class="shph">${I.file}</span>`}
          <span class="shname ellipsis">${esc(x.name)}</span>
          <button class="shx" data-shelfx="${esc(x.id)}" title="Remove from the shelf">×</button>
        </div>`).join('')}</div>`;
    return t;
  },

  messages(size) {
    const t = el('div', `tile messages w${size}`);
    const m = D.messages;
    if (!m) { t.innerHTML = `<div class="empty">Loading…</div>`; return t; }
    if (m.error) { t.innerHTML = `<div class="empty"><div class="ico">${I.chat}</div>${esc(m.error)}</div>`; return t; }
    if (!m.items.length) { t.innerHTML = `<div class="empty"><div class="ico">${I.chat}</div>No new messages</div>`; return t; }
    if (size === 1) {
      const n = m.items.reduce((a, b) => a + b.count, 0);
      t.innerHTML = `<div class="big-ico">${I.chat}</div><span class="badge">${n}</span>`;
      return t;
    }
    const items = m.items.slice(0, 2);
    t.innerHTML = items.map(c => `
      <div class="msg">
        <div class="head">
          <span class="name ellipsis">${esc(c.name)}</span>
          ${c.count > 1 ? `<span class="badge">${c.count}</span>` : ''}
          ${size === 3 ? `<span class="app">${esc(c.app)}</span>` : ''}
          <span class="when">${msgWhen(c.at)}</span>
        </div>
        <div class="line ellipsis">${esc(c.line)}</div>
      </div>`).join('');
    return t;
  },

  controls(size) {
    const t = el('div', `tile controls w${size}`);
    const r = D.radios || {};
    const v = D.volume, b = D.brightness;
    const btn = (key, icon, on, title, extra = '', cls = '') =>
      `<button class="qbtn ${on ? 'on' : ''} ${cls}" data-q="${key}" title="${title}">${icon}${extra}</button>`;
    const volIcon = v && (v.muted || v.level === 0) ? I.mute : I.volume;
    const volLvl = v ? `<span class="lvl">${v.muted ? 'muted' : v.level + '%'}</span>` : '';
    const brLvl = b && b.supported ? `<span class="lvl">${b.level}%</span>` : '';
    const all = {
      wifi: btn('wifi', I.wifi, r.wifi === true, 'Wi-Fi', '', r.wifi == null ? 'na' : ''),
      bt: btn('bt', I.bt, r.bt === true, 'Bluetooth', '', r.bt == null ? 'na' : ''),
      dark: btn('dark', I.contrast, D.dark && D.dark.on, 'Dark mode'),
      vol: btn('vol', volIcon, false, 'Volume — click to mute, scroll to change', volLvl, v ? 'has-lvl' : ''),
      bright: btn('bright', I.sun, false, b && b.supported === false ? 'Brightness (laptop screens only)' : 'Brightness — scroll to change', brLvl, (b && b.supported === false ? 'na ' : '') + (brLvl ? 'has-lvl' : '')),
      apps: btn('apps', I.grid, false, 'Start'),
    };
    const order = size === 1 ? ['wifi', 'vol', 'dark', 'apps'] : ['wifi', 'bt', 'dark', 'vol', 'bright', 'apps'];
    t.innerHTML = order.map(k => all[k]).join('');
    return t;
  },

  calendar(size) {
    const t = el('div', `tile calendar w${size}`);
    const c = D.calendar;
    if (!c) { t.innerHTML = `<div class="empty">Loading…</div>`; return t; }
    if (c.error) { t.innerHTML = `<div class="empty"><div class="ico">${I.calendar}</div>${esc(c.error)}</div>`; return t; }
    if (c.empty || !c.event) { t.innerHTML = `<div class="empty"><div class="ico">${I.calendar}</div>Nothing coming up</div>`; return t; }
    const e = c.event;
    const mins = Math.round((e.start - Date.now()) / 60000);
    const d = new Date(e.start), now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    let when;
    if (mins <= 0) when = 'Now';
    else if (mins < 60) when = `In ${mins} min`;
    else if (d.toDateString() === now.toDateString()) when = e.allDay ? 'Today' : `Today ${hhmm(e.start)}`;
    else if (d.toDateString() === tomorrow.toDateString()) when = e.allDay ? 'Tomorrow' : `Tomorrow ${hhmm(e.start)}`;
    else when = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + (e.allDay ? '' : ' ' + hhmm(e.start));
    t.innerHTML = `${size > 1 ? '<div class="label">Next</div>' : ''}
      <div class="etitle">${esc(e.title)}</div>
      <div class="ewhen ellipsis">${esc(when)}${size === 3 && e.location ? ' · ' + esc(e.location) : ''}</div>`;
    return t;
  },

  league(size) {
    const L = D.league;
    const g = L && L.game;
    if (L && L.cs) return leagueChampSelect(L.cs);
    if (g && g.players && g.players.length) return leagueGame(g);
    if (D.leagueOpen && L && L.me) return leagueChampions(L);
    const t = el('div', `tile league w${size}`);
    const me = L && L.me;
    if (!me) { t.innerHTML = `<div class="empty"><div class="ico">${I.trophy}</div>League client is starting…</div>`; return t; }
    const line = (label, r) => r
      ? `<div class="lrow"><span class="lq">${label}</span>${rankPill(r)}<span class="lwr">${wr(r)}</span></div>`
      : `<div class="lrow"><span class="lq">${label}</span><span class="muted">Unranked</span></div>`;
    const phase = { Lobby: 'In lobby', Matchmaking: 'In queue', ReadyCheck: 'Match found', ChampSelect: 'Champ select', GameStart: 'Game starting', InProgress: 'In game', EndOfGame: 'Game over' }[L.phase] || 'League open';
    const phaseText = L.mode && L.phase !== 'Lobby' && L.phase !== 'None' ? `${phase} · ${L.mode}` : phase;
    t.classList.add('clickable');
    t.title = 'Show your champions and the tier list';
    if (size === 1) {
      const best = me.solo || me.flex;
      const em = best && LICON['tier:' + best.tier];
      t.innerHTML = `<div class="lbig">${em ? `<img class="lembbig" src="${em}" alt="">` : I.trophy}</div>${best ? `<span class="lpill" style="--tier:${(TIER[best.tier] || [0, '#888'])[1]}">${(TIER[best.tier] || [best.tier[0]])[0]}${DIV[best.division] || ''}<span class="llp">${best.lp} LP</span></span>` : '<span class="muted">Unranked</span>'}`;
      return t;
    }
    t.innerHTML = `
      <div class="chead"><span class="cstatus ellipsis">${esc(me.name)}<span class="muted">#${esc(me.tag)}</span></span><span class="cfolder">${esc(phaseText)}</span></div>
      ${line('Solo', me.solo)}${size > 1 ? line('Flex', me.flex) : ''}`;
    return t;
  },

  timer(size) {
    const t = el('div', `tile timer w${size}`);
    const T = D.timer;
    t.innerHTML = `
      <div><div class="tval ${T.running ? 'run' : ''}" data-tval>${fmtTime(timerLeft())}</div>
      <div class="tlabel">Focus</div></div>
      <div class="tctl">
        <button class="ibtn primary" data-timer="toggle" title="${T.running ? 'Pause' : 'Start'}">${T.running ? I.pause : I.play}</button>
        ${size > 1 || !T.running ? `<button class="ibtn" data-timer="reset" title="Reset">${I.reset}</button>` : ''}
      </div>`;
    return t;
  },
};

const CELL = 84, GAP = 8, PAD = 12, MAX_CELLS = 10;
const leagueWide = () => !!(D.league && (D.league.cs || D.league.game || (D.leagueOpen && D.league.me)));
function layoutWidth(shown) {
  // Rows of at most 10 cells.
  const rows = []; let cur = 0;
  for (const x of shown) {
    const size = Math.max(1, Math.min(3, x.size || 2));
    if (x.id === 'league' && leagueWide()) { if (cur) rows.push(cur); rows.push(MAX_CELLS); cur = 0; continue; }
    if (cur && cur + size > MAX_CELLS) { rows.push(cur); cur = 0; }
    cur += size;
  }
  if (cur) rows.push(cur);
  const cells = Math.max(2, ...rows);
  return cells * CELL + (cells - 1) * GAP + 2 * PAD;
}
function renderTiles() {
  if (!D.settings) return;
  let shown = D.settings.tiles.filter(x => x.show && (x.id !== 'league' || (D.league && D.league.client))
    && (x.id !== 'shelf' || D.dragging || (D.shelf || []).length));   // the shelf shows while you drag files, or while it holds some
  if (D.dragging && shown.some(x => x.id === 'shelf')) shown = shown.filter(x => x.id === 'shelf');   // dragging files in: only the shelf
  else if (leagueWide()) shown = shown.filter(x => x.id === 'league');   // the League panel takes the whole notch
  tilesView.style.width = layoutWidth(shown) + 'px';
  tilesView.replaceChildren(...shown.map(x => TILE[x.id](Math.max(1, Math.min(3, x.size || 2)))));
  if (!tilesView.children.length) tilesView.innerHTML = `<div class="tile w3"><div class="empty">All tiles are hidden. Right-click to open Settings.</div></div>`;
  tick();
  if (state === 'open') sizeIsland();
}

// Keep the window the size of what's inside, also when a tile changes on its own (champ select
// filling in, pictures arriving): otherwise the bottom gets cut off.
let resizeQueued = false;
new ResizeObserver(() => {
  if (state !== 'open' || resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; if (state === 'open') sizeIsland(); });
}).observe(tilesView);

function rerenderTile(id) {
  if (state !== 'open' || !D.settings) return;
  const cfg = D.settings.tiles.find(t => t.id === id);
  if (!cfg || !cfg.show) return;
  const old = tilesView.querySelector(`.tile.${id}`);
  const fresh = TILE[id](Math.max(1, Math.min(3, cfg.size || 2)));
  if (old && old.outerHTML === fresh.outerHTML) return;   // nothing changed: don't redraw (no flicker)
  if (old) old.replaceWith(fresh); else renderTiles();
  tick();
  sizeIsland();
}

// tile actions
tilesView.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) {
    const lt = e.target.closest('.tile.league.clickable');
    if (lt) { D.leagueOpen = !D.leagueOpen; renderTiles(); sizeIsland(); }
    return;
  }
  if (b.dataset.url) { api.send('open-url', b.dataset.url); return; }
  if (b.dataset.cstab) { D.csTab = b.dataset.cstab; rerenderTile('league'); return; }
  if (b.dataset.shelfx) { D.shelf = await api.invoke('shelf-remove', b.dataset.shelfx); renderTiles(); return; }
  if (b.dataset.shelfclear !== undefined) { D.shelf = await api.invoke('shelf-clear'); renderTiles(); return; }
  if (b.dataset.tierlane) { D.tierLane = b.dataset.tierlane; rerenderTile('league'); return; }
  if (b.dataset.import !== undefined) {
    b.disabled = true; b.textContent = 'Importing…';
    const res = await api.invoke('league-import-runes').catch(() => ({ ok: false, error: 'Could not reach League' }));
    b.textContent = res.ok ? `${res.source || ''} runes imported ✓` : 'Import runes';
    b.disabled = !!res.ok;
    if (!res.ok) peek({ icon: I.trophy, title: 'Runes not imported', sub: res.error || '', ms: 4000 });
    else if (res.replaced) peek({ icon: I.trophy, title: 'Runes imported', sub: `All pages were in use, so "${res.replaced}" was replaced`, ms: 5000 });
    return;
  }
  if (b.dataset.out !== undefined) { D.outPicker = true; api.send('helper', { c: 'outputs' }); rerenderTile('music'); return; }
  if (b.dataset.outclose !== undefined) { D.outPicker = false; rerenderTile('music'); return; }
  if (b.dataset.outid) {
    api.send('helper', { c: 'setoutput', id: b.dataset.outid });
    D.outputs = D.outputs.map(o => ({ ...o, default: o.id === b.dataset.outid }));   // show it right away
    D.outPicker = false; rerenderTile('music'); return;
  }
  if (b.dataset.media) api.send('helper', { c: 'media', a: b.dataset.media });
  if (b.dataset.q) {
    const k = b.dataset.q;
    if (k === 'wifi') { api.send('helper', { c: 'radio', kind: 'wifi' }); }
    if (k === 'bt') { api.send('helper', { c: 'radio', kind: 'bt' }); }
    if (k === 'dark') api.send('helper', { c: 'dark' });
    if (k === 'vol') api.send('helper', { c: 'vol', mute: true });
    if (k === 'bright') {
      const lv = D.brightness && D.brightness.level;
      api.send('helper', { c: 'bright', set: lv >= 90 ? 30 : lv >= 55 ? 100 : 60 });
    }
    if (k === 'apps') api.send('helper', { c: 'start' });
  }
  if (b.dataset.timer === 'toggle') timerToggle();
  if (b.dataset.timer === 'reset') timerReset();
});
// Shelf: drag a held file out (Windows does the copy or move), double-click shows it in its folder.
tilesView.addEventListener('dragstart', e => {
  const one = e.target.closest('[data-shelfid]'), all = e.target.closest('[data-shelfall]');
  if (!one && !all) return;
  e.preventDefault();
  api.send('shelf-drag', all ? (D.shelf || []).map(x => x.id) : [one.dataset.shelfid]);
});
tilesView.addEventListener('wheel', e => {
  const row = e.target.closest('.shlist');
  if (row && row.scrollWidth > row.clientWidth) { e.preventDefault(); row.scrollLeft += e.deltaY || e.deltaX; }
}, { passive: false });
tilesView.addEventListener('dblclick', e => { const one = e.target.closest('[data-shelfid]'); if (one) api.send('shelf-open', one.dataset.shelfid); });
// Dropping files on WALL-E: it opens while you drag over it, and holds what you drop.
const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
let dropDepth = 0;
const shelfOn = () => D.settings && D.settings.tiles.some(t => t.id === 'shelf' && t.show);
document.addEventListener('dragenter', e => {
  if (!hasFiles(e) || !shelfOn()) return;
  dropDepth++;
  document.body.classList.add('dropping');
  if (!D.dragging) { D.dragging = true; renderTiles(); }
  hovering = true; clearTimeout(leaveTimer);
  if (state !== 'open') setState('open');
});
document.addEventListener('dragover', e => { if (hasFiles(e) && shelfOn()) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } });
document.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) { document.body.classList.remove('dropping'); D.dragging = false; renderTiles(); pointerLeave(); }
});
document.addEventListener('drop', async e => {
  if (!hasFiles(e) || !shelfOn()) return;
  e.preventDefault();
  dropDepth = 0; document.body.classList.remove('dropping'); D.dragging = false;
  const paths = [...e.dataTransfer.files].map(f => api.pathFor ? api.pathFor(f) : '').filter(Boolean);
  if (paths.length) D.shelf = await api.invoke('shelf-add', paths).catch(() => D.shelf);
  renderTiles();
});

tilesView.addEventListener('wheel', e => {
  const b = e.target.closest('[data-q="vol"], [data-q="bright"]');
  if (!b) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 4 : -4;
  api.send('helper', b.dataset.q === 'vol' ? { c: 'vol', delta } : { c: 'bright', delta: delta * 2 });
}, { passive: false });

// ------------------------------------------------------------------ League of Legends
const TIER = {
  IRON: ['I', '#7a6f6a'], BRONZE: ['B', '#a5735a'], SILVER: ['S', '#9aa6b2'], GOLD: ['G', '#d6a84c'],
  PLATINUM: ['P', '#4fb3a9'], EMERALD: ['E', '#2fb36f'], DIAMOND: ['D', '#6b8ff0'], MASTER: ['M', '#a66be0'],
  GRANDMASTER: ['GM', '#e05a5a'], CHALLENGER: ['C', '#f0c96a'],
};
const DIV = { I: 1, II: 2, III: 3, IV: 4 };
function rankPill(r) {
  if (!r) return '<span class="lpill none">Unranked</span>';
  const [ab, color] = TIER[r.tier] || [r.tier.slice(0, 1), '#888'];
  const div = DIV[r.division] ? DIV[r.division] : '';
  const em = LICON['tier:' + r.tier];
  return `${em ? `<img class="lemb" src="${em}" alt="" title="${esc(r.tier.charAt(0) + r.tier.slice(1).toLowerCase())}${r.division ? ' ' + esc(r.division) : ''}">` : ''}<span class="lpill" style="--tier:${color}">${ab}${div}<span class="llp">${r.lp} LP</span></span>`;
}
function wr(r) {
  const games = (r.wins || 0) + (r.losses || 0);
  if (!games) return '';
  const pct = Math.round(100 * r.wins / games);
  return `<b class="${pct >= 55 ? 'hot' : pct < 47 ? 'cold' : ''}">${pct}%</b> ${games}g`;
}
function leagueGame(g) {
  const t = el('div', 'tile league game');
  const side = team => g.players.filter(p => p.team === team).map(p => {
    const form = (p.recent || []).slice(0, 10).map(w => `<i class="${w ? 'w' : 'l'}"></i>`).join('');
    const r = p.rank;
    return `<div class="lp ${p.me ? 'me' : ''}">
      <span class="lch">${p.icon ? `<img src="${p.icon}" alt="">` : esc((p.champ || '?').slice(0, 2))}</span>
      <span class="lname ellipsis" title="${esc(p.name)}#${esc(p.tag)} · ${esc(p.champ)}">${esc(p.name)}</span>
      <span class="lrank">${p.bot ? '<span class="lpill none">Bot</span>' : p.loading ? '<span class="lpill none">…</span>' : rankPill(r)}</span>
      <span class="lwr">${r ? wr(r) : ''}</span>
    </div>`;
  }).join('');
  t.innerHTML = `
    <div class="lhead"><span class="cstatus">${I.trophy}${esc(g.queue || 'In game')}</span><span class="muted">Win rate: this season</span></div>
    ${gameBuild(g.build)}
    <div class="lteams"><div class="lteam blue">${side('blue')}</div><div class="lteam red">${side('red')}</div></div>`;
  return t;
}

// Your build in game: OP.GG's items with what you own ticked and the next one highlighted,
// and the skill order with the next level-up highlighted.
function gameBuild(b) {
  if (!b) return '';
  const title = `<span class="gbtitle">${chIcon(b.champ, 'lch')}<b>Your build</b><span class="muted">${esc((b.champ && b.champ.name) || '')}${b.mode === 'aram' ? ' · ARAM' : b.mode === 'urf' ? ' · URF' : b.pos ? ' · ' + esc(ROLE[b.pos] || '') : ''} · OP.GG</span></span>`;
  if (b.unsupported) return '';
  if (b.loading || b.failed) return `<div class="gbuild">${title}<span class="muted">${b.failed ? 'OP.GG has no build for this champion here' : 'Loading the build…'}</span></div>`;
  const owned = (b.owned || []).slice();
  const has = id => { const i = owned.indexOf(id); if (i < 0) return false; owned.splice(i, 1); return true; };
  const want = [...b.boots, ...b.core, ...b.later];
  const got = new Set(want.filter(id => (b.owned || []).includes(id)));
  const next = [...b.core, ...b.boots, ...b.later].find(id => !got.has(id));
  const item = (id, label) => {
    const own = got.has(id) && has(id);
    return `<span class="gitem ${own ? 'own' : ''} ${id === next ? 'next' : ''}" title="${esc(label)}${own ? ' · you have it' : id === next ? ' · buy next' : ''}">${imgIcon('item:' + id, '')}${own ? `<i>${I.check}</i>` : ''}${id === next ? '<em>Next</em>' : ''}</span>`;
  };
  const lvl = b.level || 1;
  const skills = (b.skills || []).map((k, i) => `<i class="${i < lvl ? 'done' : ''} ${i === lvl ? 'nxt' : ''} ${k === 'R' ? 'r' : ''}" title="Level ${i + 1}">${esc(k)}</i>`).join('');
  return `<div class="gbuild">
    ${title}
    <span class="gitems"><span class="glabel">Start</span>${b.starter.map(id => `<span class="gitem start">${imgIcon('item:' + id, 'Start')}</span>`).join('')}<span class="oarrow">›</span>${b.boots.map(id => item(id, 'Boots')).join('')}${b.core.map(id => item(id, 'Core')).join('')}${b.later.length ? `<span class="oarrow">›</span>${b.later.map(id => item(id, 'Later')).join('')}` : ''}</span>
    ${(b.situational || []).length ? `<span class="gsit"><span class="glabel">Vs their team</span>${b.situational.map(x => `<span class="gitem sit ${(b.owned || []).includes(x.id) ? 'own' : ''}" title="${esc(x.name)} · ${esc(x.why)}">${imgIcon('item:' + x.id, '')}${(b.owned || []).includes(x.id) ? `<i>${I.check}</i>` : ''}<small>${esc(x.tag || '')}</small></span>`).join('')}</span>` : ''}
    ${b.runes ? `<span class="grunes">${imgIcon('rune:' + b.runes.keystoneId, b.runes.keystone)}<b>${esc(b.runes.keystone)}</b>${imgIcon('rune:' + b.runes.secondary, b.runes.secondaryName)}</span>` : ''}
  </div>`;
}

// champ select helper and your champions
const ROLE = { top: 'Top', jungle: 'Jungle', middle: 'Mid', bottom: 'Bot', utility: 'Support' };
const UGG_ROLE = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };
function uggUrl(champ, position, page = 'build') {
  let slug = String((champ && champ.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  slug = { nunuwillump: 'nunu', renataglasc: 'renata' }[slug] || slug;
  const role = UGG_ROLE[position];
  return `https://u.gg/lol/champions/${slug}/${page}${role ? `?role=${role}` : ''}`;
}
const LICON = {};   // pictures by key: champion key, "item:3118", "spell:4", "rune:8112"
const chIcon = (c, cls = 'lch') => {
  const src = c && (c.icon || LICON[c.key]);
  return `<span class="${cls}">${src ? `<img src="${src}" alt="">` : esc(((c && c.name) || '?').slice(0, 2))}</span>`;
};
const imgIcon = (k, title) => LICON[k] ? `<img class="lit" src="${LICON[k]}" alt="" title="${esc(title || '')}">` : `<span class="lit none" title="${esc(title || '')}"></span>`;
const OPGG_TIER = { 1: ['OP', '#F29A4A'], 2: ['Strong', '#d6a84c'], 3: ['Good', '#6b8ff0'], 4: ['Average', '#8a8a8a'], 5: ['Weak', '#6a6a6a'] };
const tierPill = t => { const [n, c] = OPGG_TIER[t] || OPGG_TIER[t === 0 ? 1 : -1] || ['–', '#666']; return `<span class="ltier" style="--tier:${c}">${n}</span>`; };
const pct = x => Math.round((x || 0) * 1000) / 10 + '%';
const LANES = [['top', 'Top'], ['jungle', 'Jungle'], ['mid', 'Mid'], ['adc', 'Bot'], ['support', 'Support']];
function opggUrl(champ, lane) {
  const slug = String((champ && champ.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = { nunuwillump: 'nunu', renataglasc: 'renata', wukong: 'monkeyking' }[slug] || slug;
  return `https://op.gg/lol/champions/${s2}/build${lane && lane !== 'all' ? '/' + lane : ''}`;
}
// OP.GG's build for the champion you hover or lock: counters, items, skills.
const SHARDS = { 5001: 'Health scaling', 5002: 'Armor', 5003: 'Magic resist', 5005: 'Attack speed', 5007: 'Ability haste', 5008: 'Adaptive force', 5010: 'Move speed', 5011: 'Health', 5013: 'Tenacity & slow resist' };
// The full rune page OP.GG suggests (the one Import runes creates), drawn like the client:
// every choice in each row, the picked ones lit, the rest greyed out.
function runePage(r) {
  if (!r || !r.perkIds || r.perkIds.length < 6) return '';
  const picked = new Set(r.perkIds.slice(0, 6));
  const shards = r.perkIds.slice(6, 9);
  const names = {};
  for (const row of [...((r.tree && r.tree.primary) || []), ...((r.tree && r.tree.secondary) || [])]) for (const x of row) names[x.id] = x.name;
  const dot = (id, on, big) => `<span class="rdot ${on ? 'on' : ''} ${big ? 'big' : ''}" title="${esc(names[id] || '')}">${LICON['rune:' + id] ? `<img src="${LICON['rune:' + id]}" alt="">` : ''}</span>`;
  const row = (list, big) => `<div class="rrow">${list.map(x => dot(x.id, picked.has(x.id), big)).join('')}</div>`;
  const head = (id, name) => `<div class="rstyle">${imgIcon('rune:' + id, name)}<b>${esc(name)}</b></div>`;
  if (!r.tree) return `<div class="rpage"><div class="rhead"><span class="olabel">Rune page</span><span class="muted">Loading…</span></div></div>`;
  const shardRow = (opts, i) => `<div class="rrow shards">${opts.map(id => `<span class="rshard ${shards[i] === id ? 'on' : ''}" title="${esc(SHARDS[id] || '')}">${LICON['shard:' + id] ? `<img src="${LICON['shard:' + id]}" alt="">` : ''}</span>`).join('')}</div>`;
  return `<div class="rpage">
    <div class="rhead"><span class="olabel">Rune page</span></div>
    <div class="rtrees">
      <div class="rtree">${head(r.primary, r.primaryName)}${row(r.tree.primary[0] || [], true)}<i class="rline"></i>${r.tree.primary.slice(1).map(x => row(x)).join('')}</div>
      <div class="rtree">${head(r.secondary, r.secondaryName)}${r.tree.secondary.map(x => row(x)).join('')}<i class="rline"></i>${(r.shardRows || []).map(shardRow).join('')}</div>
    </div>
  </div>`;
}
function opggBlock(o, me) {
  if (!o) return `<div class="opgg muted">${D.league && D.league.cs && D.league.cs.opggFailed ? 'OP.GG has no build for this champion in this role' : 'Loading OP.GG counters and build…'}</div>`;
  const cw = (list, cls) => list.map(c => `<button class="ocw" data-url="${esc(opggUrl(c, o.lane))}" title="${esc(c.name)}: you win ${pct(c.winRate)} of ${c.games} games">${chIcon(c, 'lch sm')}<span class="${cls}">${Math.round(c.winRate * 100)}%</span></button>`).join('');
  const items = (ids, label) => ids.length ? `<span class="obuild">${ids.map(i => imgIcon('item:' + i, label)).join('')}</span>` : '';
  const r = o.runes;
  return `<div class="opgg">
    <div class="orow">${tierPill(o.tier)}<span class="muted osrc">OP.GG · ranked</span></div>
    <div class="orow"><span class="olabel">Build</span>${o.spells.map(i => imgIcon('spell:' + i, 'Summoner spell')).join('')}<span class="osep"></span>${items(o.starter, 'Start')}<span class="oarrow">›</span>${items(o.boots, 'Boots')}<span class="oarrow">›</span>${items(o.core, 'Core')}</div>
  </div>`;
}
function tierList(L) {
  const lane = D.tierLane || L.mainLane || 'jungle';
  const list = (L.meta && L.meta[lane]) || [];
  return `<div class="ltl">
    <div class="lcolhead"><span class="cstatus">OP.GG tier list</span><span class="muted">Ranked · this patch · click a champion for its build</span></div>
    <div class="ltabs">${LANES.map(([k, n]) => `<button class="ltab ${k === lane ? 'on' : ''}" data-tierlane="${k}">${roleIcon(k)}${n}</button>`).join('')}</div>
    <div class="ltlist" style="grid-template-rows: repeat(${Math.max(1, Math.ceil(list.length / 2))}, 1fr)">${list.length ? list.map((c, i) => `
      <button class="ltrow" data-url="${esc(opggUrl(c, lane))}" title="${esc(c.name)} build on OP.GG"><span class="ltrank">${c.rank || i + 1}</span>${chIcon(c, 'lch sm')}<span class="ellipsis ltname">${esc(c.name)}</span>${tierPill(c.tier)}<span class="ltnum"><b>${pct(c.winRate)}</b></span><span class="ltnum muted">${pct(c.pickRate)}</span><span class="ltnum muted">${pct(c.banRate)}</span></button>`).join('')
      : `<div class="muted">${L.meta ? 'No tier list for this lane' : 'Loading the tier list from OP.GG…'}</div>`}</div>
    ${list.length ? '<div class="lthead muted"><span>Win · Pick · Ban</span></div>' : ''}
  </div>`;
}
function statLine(st) {
  if (!st) return '<span class="muted">No recent games on this champion</span>';
  const pct = Math.round(100 * st.wins / st.games);
  return `<b class="${pct >= 55 ? 'hot' : pct < 47 ? 'cold' : ''}">${pct}%</b> · ${st.games} game${st.games === 1 ? '' : 's'} · ${st.kda} KDA`;
}
function csTimeLeft(cs) { return Math.max(0, cs.timeLeft - (Date.now() - cs.at)); }
const ROLE_SHORT = { top: 'TOP', jungle: 'JGL', middle: 'MID', bottom: 'BOT', utility: 'SUP' };
const ROLE_ICON = { top: 'roleTop', jungle: 'roleJungle', middle: 'roleMid', bottom: 'roleBot', utility: 'roleSupport', mid: 'roleMid', adc: 'roleBot', support: 'roleSupport' };
const roleIcon = p => (ROLE_ICON[p] && I[ROLE_ICON[p]]) || '';
const pct0 = x => Math.round((x || 0) * 1000) / 10 + '%';
const games = n => n ? (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n) + ' games' : '';
function ulist(items, value, label, cls, empty) {
  if (!items.length) return `<div class="muted uempty">${empty}</div>`;
  const max = Math.max(...items.map(value), 0.0001);
  return items.map(c => `<button class="urow ${c.banned || c.taken ? 'dim' : ''} ${cls(c)}" data-url="${esc(opggUrl(c, c.lane || ''))}" title="${esc(c.name)} on OP.GG">
    ${chIcon(c)}<span class="umid"><span class="ellipsis">${esc(c.name)}</span><span class="ubar"><i style="width:${Math.max(4, Math.round(100 * value(c) / max))}%"></i></span></span>
    <span class="uval"><b>${label(c)}</b><span class="muted">${esc(c.sub || games(c.games))}</span></span></button>`).join('');
}
function csAutoTab(cs) {
  if (cs.stage === 'ban') return 'ban';
  if (cs.stage === 'final' || (cs.me && cs.me.locked)) return 'loadout';
  return 'pick';
}
function leagueChampSelect(cs) {
  const t = el('div', 'tile league game cs ugg');
  const me = cs.me;
  const pos = ROLE[cs.myPos || cs.position] || '';
  const lane = UGG_ROLE[cs.myPos || cs.position] || '';
  const auto = csAutoTab(cs);
  const autoKey = `${cs.stage}:${!!(me && me.locked)}`;
  if (D.csTabKey !== autoKey) { D.csTabKey = autoKey; D.csTab = auto; }
  const tab = D.csTab || auto;

  // ---- teams (left)
  const allyRows = cs.allies.map(a => {
    const p = a.position || a.guess;
    return `<div class="uplayer ${a.me ? 'me' : ''} ${a.champ ? '' : 'vacant'} ${a.turn ? 'turn' : ''} ${a.status === 'Picking next…' ? 'nextup' : ''}">
      <span class="urole" title="${esc(ROLE[p] || '')}${!a.position && a.guess ? ' (estimated)' : ''}">${roleIcon(p)}${!a.position && a.guess && !a.sure ? '<i>?</i>' : ''}</span>
      ${chIcon(a.champ, 'uch' + (a.champ && !a.locked ? ' hover' : ''))}
      <span class="uname"><b class="ellipsis">${esc(a.name || (a.me ? 'You' : ROLE[p] || 'Teammate'))}</b><span class="ustat ${a.champ && !a.locked ? 'hovering' : ''}">${a.locked ? 'Locked in' : a.champ ? `Hovering <b>${esc(a.champ.name)}</b>${a.status === 'Picking…' ? ' · picking now' : ''}` : esc(a.status)}</span></span>
      <span class="uwr">${a.winRate ? `<b>${pct0(a.winRate)}</b><span class="muted">${esc(ROLE[p] || '')} WR</span>` : ''}</span>
      <span class="uspells">${(a.spells || []).map(x => imgIcon('spell:' + x, 'Summoner spell')).join('')}</span>
    </div>`;
  }).join('');
  const byId = new Map(cs.enemies.map(e => [e.id, e]));
  const enemyRows = (cs.enemyRows || cs.enemies.map((e, i) => ({ champ: e, status: 'Locked in', n: i + 1 }))).map(r => {
    const e = r.champ && (byId.get(r.champ.id) || r.champ);
    const isOpp = e && cs.opponent && cs.opponent.id === e.id;
    return `<div class="uplayer enemy ${e ? '' : 'vacant'} ${isOpp ? 'opp' : ''} ${r.turn ? 'turn' : ''}">
      ${chIcon(e, 'uch')}
      <span class="uname"><b class="ellipsis">${e ? esc(e.name) : 'Enemy ' + r.n}</b><span class="ustat">${e && e.guess ? `<span class="upred">${roleIcon(e.guess)}${esc(ROLE[e.guess])}${e.sure ? '' : '?'}</span>${isOpp ? ' your lane' : ' predicted'}` : esc(r.status)}</span></span>
      <span class="uwr">${e && e.winRate ? `<b>${pct0(e.winRate)}</b><span class="muted">${esc(ROLE[e.guess] || '')} WR</span>` : ''}</span>
      <span class="ucount">${e && e.counters && e.counters.length ? `<span class="ucicons" title="Picks for your role that beat ${esc(e.name)}">${e.counters.map(c => `<span title="${esc(c.name)} wins ${pct0(c.winRate)} vs ${esc(e.name)}">${chIcon(c, 'lch sm')}<i>${Math.round(c.winRate * 100)}%</i></span>`).join('')}</span>` : ''}</span>
    </div>`;
  }).join('');

  // ---- panel (right)
  const o = cs.opgg;
  let body;
  if (tab === 'ban') {
    const counters = (o && o.counters) || [];
    body = `<div class="ucols">
      <div class="ucol"><div class="uhead">Most banned ${esc(pos || 'champions')}<span class="muted">Ban rate</span></div>
        ${ulist((cs.banList || []).map(c => ({ ...c, lane })), c => c.banRate, c => pct0(c.banRate) + ' BR', () => 'ban', 'Loading OP.GG ban rates…')}</div>
      <div class="ucol">${me && counters.length
        ? `<div class="uhead">${esc(me.name)} counters<span class="muted">Your win rate</span></div>${ulist(counters.map(c => ({ ...c, lane })), c => 1 - c.winRate, c => pct0(c.winRate) + ' WR', () => 'bad', '')}`
        : `<div class="uhead">Strongest ${esc(pos || '')} picks<span class="muted">Win rate</span></div>${ulist((cs.laneTop || []).slice(0, 8).map(c => ({ ...c, lane })), c => c.winRate - 0.45, c => pct0(c.winRate) + ' WR', () => '', 'Loading the tier list…')}`}</div>
    </div>`;
  } else if (tab === 'pick') {
    const vs = cs.opponent && cs.enemies.find(e => e.id === cs.opponent.id);
    const beat = (vs && vs.counters) || [];
    body = `<div class="ucols">
      <div class="ucol"><div class="uhead">Suggested for ${esc(pos || 'you')}<span class="muted">Why</span></div>
        ${(cs.picks || []).length ? cs.picks.map(c => `<button class="urow pick" data-url="${esc(opggUrl(c, lane))}" title="${esc(c.name)} build on OP.GG">${chIcon(c)}<span class="umid"><span class="ellipsis">${esc(c.name)}</span><span class="muted ellipsis usub">${esc(c.why)}</span></span><span class="uval">${c.tier ? tierPill(c.tier) : ''}</span></button>`).join('') : '<div class="muted uempty">Suggestions appear once OP.GG\'s tier list has loaded</div>'}</div>
      <div class="ucol">${cs.clearOpp && ((cs.counterPicks || []).length || cs.counterPending)
        ? `<div class="uhead">Counter picks vs ${esc(cs.clearOpp.name)}<span class="muted">Your win rate</span></div>${(cs.counterPicks || []).length
            ? ulist(cs.counterPicks.map(c => ({ ...c, lane, sub: c.mine || games(c.games) })), c => c.winRate - 0.42, c => pct0(c.winRate) + ' WR', c => c.winRate >= 0.5 ? 'good' : 'bad', '')
            : ''}${cs.counterPending ? `<div class="muted uempty">Checking ${cs.counterPending} more matchup${cs.counterPending === 1 ? '' : 's'} on OP.GG…</div>` : ''}`
        : beat.length
        ? `<div class="uhead">Beats ${esc(vs.name)}<span class="muted">Their win rate</span></div>${ulist(beat.map(c => ({ ...c, lane, sub: '' })), c => c.winRate, c => pct0(c.winRate) + ' WR', () => 'good', '')}`
        : `<div class="uhead">Strongest ${esc(pos || '')} picks<span class="muted">Win rate</span></div>${ulist((cs.laneTop || []).slice(0, 8).map(c => ({ ...c, lane })), c => c.winRate - 0.45, c => pct0(c.winRate) + ' WR', () => 'good', 'Loading the tier list…')}`}</div>
    </div>`;
  } else {
    const r = (o && o.runes) || cs.runes;
    body = me ? `<div class="uload">
      <div class="csme">
        ${chIcon(me, 'csbig')}
        <div class="csinfo">
          <div class="csname">${esc(me.name)} <span class="muted">${me.locked ? 'locked in' : 'hovering'}</span></div>
          <div class="csstat">Your games: ${statLine(me.stats)}</div>
          <div class="csrunes">${r ? `${o && o.runes ? imgIcon('rune:' + o.runes.keystoneId, r.keystone) : I.trophy}<b>${esc(r.keystone || r.primaryName)}</b>&nbsp;· ${esc(r.primaryName)} + ${esc(r.secondaryName)}${o && o.runes ? '<span class="muted">&nbsp;(OP.GG)</span>' : ''}` : '<span class="muted">Loading recommended runes…</span>'}</div>
        </div>
      </div>
      <div class="csbtns">
          <button class="pbtn allow" data-import ${r && r.perkIds && r.perkIds.length >= 6 ? '' : 'disabled'}>Import ${o && o.runes ? 'OP.GG ' : ''}runes</button>
          <button class="pbtn" data-url="${esc(opggUrl(me, o && o.lane))}">OP.GG ↗</button>
          <button class="pbtn" data-url="${esc(uggUrl(me, cs.position, 'build'))}">u.gg ↗</button>
      </div>
      ${opggBlock(o, me)}
      ${runePage(o && o.runes)}
    </div>` : '<div class="muted uempty">Hover a champion to see its build, skills and runes</div>';
  }
  const bs = cs.banSides || { mine: [], theirs: [] };
  const banRow = (list, cls) => `<span class="cbans ${cls}">${list.map(b => b ? `<span class="cban" title="Banned: ${esc(b.name)}">${chIcon(b, 'lch')}</span>` : '<span class="cban none">✕</span>').join('')}</span>`;
  t.innerHTML = `
    <div class="lhead csbar"><span class="cstatus">${I.trophy}Champ select${pos ? ' · ' + pos : ''}</span>
      <span class="csbanbar">${banRow(bs.mine, 'blue')}<span class="cstimer" data-cstimer>${fmtTime(csTimeLeft(cs))}</span>${banRow(bs.theirs, 'red')}</span><span></span></div>
    <div class="ugrid">
      <div class="uteams"><div class="uteam blue">${allyRows}</div><div class="uteam red">${enemyRows}</div></div>
      <div class="upanel">
        <div class="utabs">${[['ban', 'Ban'], ['pick', 'Pick'], ['loadout', 'Loadout']].map(([k, n]) => `<button class="utab ${tab === k ? 'on' : ''}" data-cstab="${k}">${n}</button>`).join('')}</div>
        <div class="ubody">${body}</div>
      </div>
    </div>`;
  return t;
}
function leagueChampions(L) {
  const t = el('div', 'tile league game champs clickable');
  const list = L.top || [];
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return !ms ? '' : m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const QSHORT = { 'Ranked Solo/Duo': 'Solo/Duo', 'Ranked Flex': 'Flex', 'Normal Draft': 'Draft', 'Normal Blind': 'Blind', 'Co-op vs AI': 'Co-op' };
  const recent = L.recent || [];
  t.innerHTML = `
    <div class="lsplit three">
      <div class="lcol">
        <div class="lcolhead"><span class="cstatus">Last games</span><span class="muted">Click an empty spot to close</span></div>
        <div class="lgames">${recent.length ? recent.map(g => `
          <button class="lgame ${g.remake ? 'remake' : g.win ? 'win' : 'loss'}" data-url="${esc(opggUrl(g, ''))}" title="${esc(g.name)} · ${esc(g.queue)}${g.dur ? ' · ' + Math.round(g.dur / 60) + ' min' : ''}">
            ${chIcon(g, 'lch')}<span class="lgres">${g.remake ? 'Remake' : g.win ? 'Win' : 'Loss'}</span>
            <span class="lgkda"><b>${g.k}/${g.d}/${g.a}</b><span class="muted">${esc(QSHORT[g.queue] || g.queue)}</span></span>
            <span class="muted lgago">${ago(g.at)}</span></button>`).join('') : '<div class="muted">No recent games yet.</div>'}</div>
      </div>
      <div class="lcol">
        <div class="lcolhead"><span class="cstatus">Your champions</span><span class="muted">Last 50 games</span></div>
        <div class="lchamps">${list.length ? list.map(c => `
          <button class="lchamp" data-url="${esc(opggUrl(c, ''))}">${chIcon(c, 'lch')}<span class="ellipsis lcn">${esc(c.name)}</span><span class="lcs">${c.stats ? `<b class="${Math.round(100 * c.stats.wins / c.stats.games) >= 55 ? 'hot' : ''}">${Math.round(100 * c.stats.wins / c.stats.games)}%</b> ${c.stats.games}g · ${c.stats.kda}` : ''}</span></button>`).join('') : '<div class="muted">Play a few games and your champions show up here.</div>'}</div>
      </div>
      ${tierList(L)}
    </div>`;
  return t;
}

// ------------------------------------------------------------------ sound output picker
function outputIcon(o) {
  const n = String((o && o.name) || '').toLowerCase();
  if (/head|airpods|buds|earphone|koptelefoon|oortjes|wh-|wf-/.test(n)) return I.headphones;
  if (/monitor|display|hdmi|nvidia|amd high definition|tv|lg |samsung|dell|msi|mag /.test(n)) return I.monitor;
  return I.speaker;
}
function outputsPicker(size) {
  const t = el('div', `tile music picker w${size}`);
  t.innerHTML = `
    <div class="phead"><span>Sound output</span><button class="ibtn" data-outclose title="Back">${I.chevron}</button></div>
    <div class="plist">${D.outputs.map(o => `
      <button class="pitem ${o.default ? 'on' : ''}" data-outid="${esc(o.id)}">
        <span class="pico">${outputIcon(o)}</span><span class="pname ellipsis">${esc(o.name || 'Unknown device')}</span>${o.default ? `<span class="pcheck">${I.check}</span>` : ''}
      </button>`).join('')}</div>`;
  return t;
}

// ------------------------------------------------------------------ focus timer
function timerLeft() { const T = D.timer; return T.running ? Math.max(0, T.endsAt - Date.now()) : T.left; }
function timerToggle() {
  const T = D.timer;
  if (T.running) { T.left = timerLeft(); T.running = false; }
  else { if (T.left <= 0) T.left = T.total; T.endsAt = Date.now() + T.left; T.running = true; }
  rerenderTile('timer'); startTicker();
  if (state === 'compact' || state === 'rest') settle();
}
function timerReset() { Object.assign(D.timer, { running: false, left: D.timer.total }); rerenderTile('timer'); if (state !== 'open') settle(); }

// ------------------------------------------------------------------ compact
// The compact parts are built once per kind and then only updated in place,
// so the spinning cover and the bars keep moving smoothly instead of restarting.
let compactKind = null, compactArt = null, compactStep = null;
function renderCompact() {
  const kind = wantCompact();
  if (kind !== compactKind) {
    compactKind = kind; compactArt = null; compactStep = null;
    if (kind === 'timer') {
      compactL.innerHTML = `<div class="ico">${I.timer}</div>`;
      compactR.innerHTML = '<span class="ctext" data-ctimer></span>';
    } else if (kind === 'music') {
      compactL.innerHTML = '<div class="mini-art spin" data-art></div>';
      compactR.innerHTML = '<div class="eq" data-eq><i></i><i></i><i></i><i></i></div>';
    } else {
      compactL.innerHTML = ''; compactR.innerHTML = '';
    }
  }
  if (kind === 'timer') {
    compactR.querySelector('[data-ctimer]').textContent = fmtTime(timerLeft());
  } else if (kind === 'music') {
    const m = D.media;
    const art = D.art && m && D.art.key === `${m.artist}|${m.title}` ? D.art.src : null;
    const disc = compactL.querySelector('[data-art]');
    if (art !== compactArt) { compactArt = art; disc.style.backgroundImage = art ? `url('${art}')` : ''; }
    disc.style.animationPlayState = m && m.playing ? 'running' : 'paused';   // freeze where it is, no snap back
    compactR.querySelector('[data-eq]').classList.toggle('paused', !(m && m.playing));
  }
}

// ------------------------------------------------------------------ ticker (only while something on screen moves)
let ticker = null;
function startTicker() {
  const need = (state === 'open' && (D.media || D.timer.running || (D.league && D.league.cs))) || D.timer.running;
  if (need && !ticker) ticker = setInterval(tick, 500);
  if (!need && ticker) { clearInterval(ticker); ticker = null; }
}

function tick() {
  const cst = document.querySelector('[data-cstimer]');
  if (cst && D.league && D.league.cs) cst.textContent = fmtTime(csTimeLeft(D.league.cs));
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtTime(Date.now() - +el.dataset.since);
  if (D.timer.running && timerLeft() <= 0) {
    D.timer.running = false; D.timer.left = 0;
    peek({ icon: I.timer, title: 'Focus session done', sub: '25 minutes — take a short break' });
    rerenderTile('timer'); settle();
  }
  if (state === 'open') {
    const m = D.media;
    if (m) {
      const p = mediaPos();
      const bar = tilesView.querySelector('[data-bar]');
      if (bar) bar.style.width = (m.durMs ? Math.min(100, p / m.durMs * 100) : 0) + '%';
      const pos = tilesView.querySelector('[data-pos]');
      if (pos) pos.textContent = fmtTime(p);
      const ly = tilesView.querySelector('[data-lyric]');
      if (ly) { const l = currentLyric(); if (ly.textContent !== l) ly.textContent = l; }
    }
    const tv = tilesView.querySelector('[data-tval]');
    if (tv) tv.textContent = fmtTime(timerLeft());
  }
  if (state === 'compact') {
    const ct = compactR.querySelector('[data-ctimer]');
    if (ct) ct.textContent = fmtTime(timerLeft());
  }
}

// ------------------------------------------------------------------ peeks
function peek(p) {
  peekQueue.push(p);
  if (!currentPeek) nextPeek();
}
function nextPeek() {
  clearTimeout(peekTimer);
  currentPeek = peekQueue.shift() || null;
  if (!currentPeek) { if (state === 'peek') settle(); return; }
  const p = currentPeek;
  const iconHtml = p.img ? `<img src="${esc(p.img)}" alt="">` : (p.icon || I.bell);
  peekView.innerHTML = `
    <div class="picon ${p.tone || ''}">${iconHtml}</div>
    <div class="ptext"><div class="ptitle ellipsis">${esc(p.title)}</div><div class="psub ellipsis">${esc(p.sub || '')}</div></div>`;
  if (state !== 'open') setState('peek');
  peekTimer = setTimeout(nextPeek, p.ms || 3000);
}

// ------------------------------------------------------------------ battery and charger
let batt = null, lastBattWarn = 100;
async function watchBattery() {
  if (!navigator.getBattery) return;
  try { batt = await navigator.getBattery(); } catch { return; }
  const isLaptop = () => !(batt.charging && batt.level === 1 && batt.chargingTime === 0);
  batt.addEventListener('chargingchange', () => {
    if (!D.settings || !D.settings.peeks.power || !isLaptop()) return;
    if (batt.charging) { lastBattWarn = 100; peek({ icon: I.bolt, title: 'Charging', sub: `${Math.round(batt.level * 100)}%` }); }
    else peek({ icon: I.battery, title: 'On battery', sub: `${Math.round(batt.level * 100)}%` });
  });
  batt.addEventListener('levelchange', () => {
    if (!D.settings || !D.settings.peeks.power || batt.charging) return;
    const pct = Math.round(batt.level * 100);
    if (pct <= 10 && lastBattWarn > 10) { lastBattWarn = 10; peek({ icon: I.battery, tone: 'danger', title: 'Battery at 10%', sub: 'Plug in soon', ms: 4000 }); }
    else if (pct <= 20 && lastBattWarn > 20) { lastBattWarn = 20; peek({ icon: I.battery, tone: 'warn', title: 'Battery at 20%', sub: 'Consider plugging in', ms: 4000 }); }
  });
}

// ------------------------------------------------------------------ events from main
function applyTheme() { document.documentElement.dataset.theme = D.settings && D.settings.theme === 'dark' ? 'dark' : 'white'; }

api.on('settings', s => { D.settings = s; applyTheme(); if (state === 'open') renderTiles(); });
api.on('media', m => {
  const was = D.media && D.media.playing;
  const trackChanged = !D.media || !m || D.media.title !== m.title || D.media.artist !== m.artist;
  D.media = m;
  if (state === 'open') {
    // keep DOM stable during playback; only rebuild when something visible changed
    if (trackChanged || was !== (m && m.playing)) rerenderTile('music');
  } else if (state === 'compact' || state === 'rest') {
    // Only change state when compact should appear or go away; otherwise update it in place.
    if ((state === 'compact') !== !!wantCompact()) settle();
    else if (state === 'compact') renderCompact();
  }
  startTicker();
});
api.on('art', a => { D.art = a; rerenderTile('music'); if (state === 'compact') renderCompact(); });
api.on('lyrics', l => { D.lyrics = l; });
api.on('radios', r => { D.radios = r; rerenderTile('controls'); });
api.on('volume', v => { D.volume = v; rerenderTile('controls'); });
api.on('brightness', b => { D.brightness = b; rerenderTile('controls'); });
api.on('dark', d => { D.dark = d; rerenderTile('controls'); });
api.on('weather', w => { D.weather = w; rerenderTile('weather'); });
api.on('messages', m => { D.messages = m; rerenderTile('messages'); });
api.on('calendar', c => { D.calendar = c; rerenderTile('calendar'); });
api.on('peek', p => {
  if (p.kind === 'app') peek({ img: p.icon, icon: I.grid, title: p.title, sub: p.sub });
  else if (p.kind === 'league') peek({ icon: I.trophy, title: p.title, sub: p.sub, ms: p.ms || 4000 });
  else if (p.kind === 'update') peek({ icon: I.download, title: p.title, sub: p.sub, ms: p.ms || 3500 });
  else peek(p);
});

api.on('shelf', list => { const had = (D.shelf || []).length > 0; D.shelf = list || []; if (had !== (D.shelf.length > 0)) renderTiles(); else rerenderTile('shelf'); });
api.on('outputs', list => { D.outputs = list || []; rerenderTile('music'); });
api.on('league', L => {
  const wideBefore = leagueWide();
  const clientBefore = !!(D.league && D.league.client);
  if (L && L.cs && !(D.league && D.league.cs)) D.leagueOpen = false;
  if (L && L.icons) Object.assign(LICON, L.icons);
  D.league = L;
  const layoutChanged = clientBefore !== !!(L && L.client) || wideBefore !== leagueWide();
  // Champ select opens the notch by itself so the helper is right there.
  // Champ select no longer opens the notch by itself: hover it to see the draft, like any other time.
  // Champ select is over: let go of the pin it set, so the notch closes again (and updates can install).
  if (!(L && L.cs)) {
    csShownOnce = false;
    if (csPinned) { csPinned = false; if (pinned) { pinned = false; island.classList.remove('pinned'); if (!hovering) settle(); } }
  }
  startTicker();
  if (state === 'open') { if (layoutChanged) renderTiles(); else rerenderTile('league'); }
});
// ------------------------------------------------------------------ boot
(async () => {
  try {
    const init = await api.invoke('initial-state');
    D.settings = init.settings;
    const s = init.state || {};
    D.media = s.media || null; D.league = s.league || null; if (D.league && D.league.icons) Object.assign(LICON, D.league.icons); D.outputs = s.outputs || []; D.shelf = s.shelf || []; D.radios = s.radios || {}; D.volume = s.volume; D.brightness = s.brightness; D.dark = s.dark;
  } catch { /* main sends settings shortly */ }
  applyTheme();
  settle();
  watchBattery();
})();
