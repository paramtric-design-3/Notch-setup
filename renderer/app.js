// FJBC Notch — island renderer.
'use strict';

const api = window.notch;
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const island = $('#island');
const tilesView = $('#tiles');
const peekView = $('#peek');
const permView = $('#perm');
const compactL = $('.compact-l');
const compactR = $('.compact-r');

const NOTCH_W = 200, NOTCH_H = 32, COMPACT_W = 328, PEEK_W = 360, PERM_W = 580;

// ------------------------------------------------------------------ data
const D = {
  settings: null,
  media: null, art: null, lyrics: { key: '', lines: [] },
  radios: {}, volume: null, brightness: null, dark: null,
  weather: null, messages: null, calendar: null,
  timer: { total: 25 * 60 * 1000, left: 25 * 60 * 1000, running: false, endsAt: 0 },
  claude: null,           // { state, step, detail, at }
  perms: [],              // queue of { id, tool, command, cwd }
};

// ------------------------------------------------------------------ state machine
let state = 'rest';        // rest | compact | peek | open | perm
let pinned = false;
let hovering = false;
let hoverTimer = null, leaveTimer = null, peekTimer = null;
const peekQueue = [];
let currentPeek = null;

function wantCompact() {
  if (D.claude && D.claude.state === 'working') return 'claude';
  if (D.timer.running) return 'timer';
  if (D.media && D.media.playing) return 'music';
  return null;
}

let lastOpenSent = null;
function setState(next) {
  if (D.perms.length) next = 'perm';
  state = next;
  island.className = 's-' + next;
  if (next === 'open') renderTiles();
  if (next === 'compact' || next === 'rest') renderCompact();
  sizeIsland();
  const open = next === 'open' || next === 'perm';
  if (open !== lastOpenSent) { lastOpenSent = open; api.send('island-open', open); }   // only real changes reach the helper
  startTicker();
}

function settle() {
  // Pick the right resting state when nothing is forcing one.
  if (D.perms.length) return setState('perm');
  if (hovering || pinned) return setState('open');
  if (currentPeek) return setState('peek');
  return setState(wantCompact() ? 'compact' : 'rest');
}

function sizeIsland() {
  let w = NOTCH_W, h = NOTCH_H;
  if (state === 'compact') w = COMPACT_W;
  else if (state === 'peek') { w = PEEK_W; h = NOTCH_H + peekView.offsetHeight; }
  else if (state === 'perm') { w = PERM_W; h = NOTCH_H + permView.offsetHeight; }
  else if (state === 'open') { w = Math.max(tilesView.offsetWidth, NOTCH_W + 80); h = NOTCH_H + tilesView.offsetHeight; }
  island.style.width = w + 'px';
  island.style.height = h + 'px';
  fitWindow(w, h, state === 'open' || state === 'peek' || state === 'perm');
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

island.addEventListener('mouseenter', () => {
  hovering = true;
  clearTimeout(leaveTimer);
  clearTimeout(hoverTimer);
  if (state !== 'open' && state !== 'perm') hoverTimer = setTimeout(() => { if (hovering) setState('open'); }, 250);
});
island.addEventListener('mouseleave', () => {
  hovering = false;
  clearTimeout(hoverTimer);
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => { if (!hovering && !pinned && state === 'open') settle(); }, 180);
});
island.addEventListener('click', e => {
  if (e.target.closest('button, pre, a')) return;
  if (state === 'open') { pinned = !pinned; island.classList.toggle('pinned', pinned); if (!pinned && !hovering) settle(); }
  else if (state !== 'perm') { pinned = true; setState('open'); }
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
const TILE = {
  music(size) {
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

function renderTiles() {
  if (!D.settings) return;
  tilesView.replaceChildren(...D.settings.tiles.filter(x => x.show).map(x => TILE[x.id](Math.max(1, Math.min(3, x.size || 2)))));
  if (!tilesView.children.length) tilesView.innerHTML = `<div class="tile w3"><div class="empty">All tiles are hidden. Right-click to open Settings.</div></div>`;
  tick();
  if (state === 'open') sizeIsland();
}

function rerenderTile(id) {
  if (state !== 'open' || !D.settings) return;
  const cfg = D.settings.tiles.find(t => t.id === id);
  if (!cfg || !cfg.show) return;
  const old = tilesView.querySelector(`.tile.${id}`);
  const fresh = TILE[id](Math.max(1, Math.min(3, cfg.size || 2)));
  if (old) old.replaceWith(fresh); else renderTiles();
  tick();
}

// tile actions
tilesView.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
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
tilesView.addEventListener('wheel', e => {
  const b = e.target.closest('[data-q="vol"], [data-q="bright"]');
  if (!b) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 4 : -4;
  api.send('helper', b.dataset.q === 'vol' ? { c: 'vol', delta } : { c: 'bright', delta: delta * 2 });
}, { passive: false });

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
    if (kind === 'claude') {
      compactL.innerHTML = '<div class="ico" data-step></div>';
      compactR.innerHTML = `<div class="workgrid">${'<i></i>'.repeat(9)}</div>`;
    } else if (kind === 'timer') {
      compactL.innerHTML = `<div class="ico">${I.timer}</div>`;
      compactR.innerHTML = '<span class="ctext" data-ctimer></span>';
    } else if (kind === 'music') {
      compactL.innerHTML = '<div class="mini-art spin" data-art></div>';
      compactR.innerHTML = '<div class="eq" data-eq><i></i><i></i><i></i><i></i></div>';
    } else {
      compactL.innerHTML = ''; compactR.innerHTML = '';
    }
  }
  if (kind === 'claude') {
    const step = D.claude.step || 'think';
    if (step !== compactStep) { compactStep = step; compactL.querySelector('[data-step]').innerHTML = I[step] || I.think; }
  } else if (kind === 'timer') {
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
  const need = (state === 'open' && (D.media || D.timer.running)) || (state === 'compact' && D.timer.running) || D.timer.running;
  if (need && !ticker) ticker = setInterval(tick, 500);
  if (!need && ticker) { clearInterval(ticker); ticker = null; }
}

function tick() {
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
  if (state !== 'open' && state !== 'perm') setState('peek');
  peekTimer = setTimeout(nextPeek, p.ms || 3000);
}

// ------------------------------------------------------------------ Claude Code permission
function renderPerm() {
  const p = D.perms[0];
  if (!p) { permView.innerHTML = ''; return; }
  permView.innerHTML = `
    <div class="phead">
      <div class="pico">${I.run}</div>
      <div style="min-width:0"><div class="pt">Claude Code wants to use ${esc(p.tool)}</div>
      <div class="ps ellipsis">${esc(p.cwd)}</div></div>
      ${D.perms.length > 1 ? `<span class="more">+${D.perms.length - 1} waiting</span>` : ''}
    </div>
    <pre data-cmd></pre>
    <div class="pfoot">
      <span class="hint" data-hint></span>
      <button class="pbtn deny" data-perm="deny">Deny <kbd>Ctrl+Alt+N</kbd></button>
      <button class="pbtn allow" data-perm="allow" disabled>Allow <kbd>Ctrl+Alt+Y</kbd></button>
    </div>`;
  const pre = permView.querySelector('[data-cmd]');
  pre.textContent = p.command;           // the whole command, never shortened
  pre.addEventListener('scroll', checkPermRead);
  requestAnimationFrame(() => { checkPermRead(); sizeIsland(); });
}

function permFullyShown() {
  const pre = permView.querySelector('[data-cmd]');
  return !!pre && pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 2;
}
function checkPermRead() {
  const ok = permFullyShown();
  const allow = permView.querySelector('[data-perm="allow"]');
  const hint = permView.querySelector('[data-hint]');
  if (!allow) return;
  allow.disabled = !ok;
  hint.textContent = ok ? 'Whole command shown' : 'Scroll to the end of the command to allow';
  hint.classList.toggle('need', !ok);
}

function answerPerm(behavior) {
  const p = D.perms[0];
  if (!p) return;
  if (behavior === 'allow' && !permFullyShown()) return;   // never approve an unseen part
  api.send('perm-answer', { id: p.id, behavior });
  D.perms.shift();
  if (D.perms.length) { renderPerm(); setState('perm'); }
  else { pinned = false; settle(); }
}
permView.addEventListener('click', e => {
  const b = e.target.closest('[data-perm]');
  if (b && !b.disabled) answerPerm(b.dataset.perm);
});

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
  else if (p.kind === 'claude') peek({ icon: I.bell, title: p.title, sub: p.sub, ms: 4000 });
  else if (p.kind === 'update') peek({ icon: I.download, title: p.title, sub: p.sub, ms: p.ms || 3500 });
  else peek(p);
});

let claudeIdle = null;
api.on('claude', c => {
  clearTimeout(claudeIdle);
  if (c.state === 'done') {
    D.claude = null;
    peek({ icon: I.check, title: 'Done', sub: `Claude Code finished in ${fmtDur(c.took)}`, ms: 4000 });
  } else {
    D.claude = { ...c, at: Date.now() };
    claudeIdle = setTimeout(() => { D.claude = null; if (state === 'compact') settle(); }, 10 * 60 * 1000);
    if (state === 'compact') renderCompact();
    else if (state === 'rest') settle();
  }
  if (state === 'compact' && !D.claude) settle();
});
api.on('claude-perm', p => {
  D.perms.push(p);
  if (D.perms.length === 1) renderPerm(); else renderPerm();
  setState('perm');
});
api.on('claude-perm-cancel', ({ id }) => {
  const i = D.perms.findIndex(p => p.id === id);
  if (i < 0) return;
  D.perms.splice(i, 1);
  renderPerm();
  if (!D.perms.length) settle(); else sizeIsland();
});
api.on('perm-key', k => answerPerm(k));

// ------------------------------------------------------------------ boot
(async () => {
  try {
    const init = await api.invoke('initial-state');
    D.settings = init.settings;
    const s = init.state || {};
    D.media = s.media || null; D.radios = s.radios || {}; D.volume = s.volume; D.brightness = s.brightness; D.dark = s.dark;
  } catch { /* main sends settings shortly */ }
  applyTheme();
  settle();
  watchBattery();
})();
