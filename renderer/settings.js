'use strict';
const api = window.notch;
const $ = s => document.querySelector(s);
const NAMES = { music: 'Music', weather: 'Weather', messages: 'Messages', controls: 'Quick controls', calendar: 'Next event', timer: 'Focus timer' };
let S = null;

const save = async patch => { S = await api.invoke('set-settings', patch); render(); };
const flash = id => { const e = $(id); e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 1200); };

let DISPLAYS = [];
let UP = null;
function renderUpdate() {
  if (!UP) return;
  const t = $('#upText'), b = $('#upBtn');
  b.disabled = false; b.className = 'btn';
  if (!UP.packaged) { t.textContent = `Version ${UP.current} · updates only work in the installed app`; b.disabled = true; return; }
  switch (UP.state) {
    case 'checking': t.textContent = `Version ${UP.current} · checking…`; b.disabled = true; break;
    case 'downloading': t.textContent = `Downloading ${UP.version} · ${UP.percent}%`; b.disabled = true; break;
    case 'ready': t.textContent = `Version ${UP.version} is ready to install`; b.textContent = 'Restart now'; b.className = 'btn primary'; return;
    default: t.textContent = `Version ${UP.current}` + (UP.error ? ' · last check failed' : ' · up to date');
  }
  b.textContent = 'Check now';
}
function renderDisplays() {
  const sel = $('#display');
  const opts = [['primary', 'Main screen'], ['mouse', 'Screen with the mouse'], ...DISPLAYS.map(d => [d.id, d.name])];
  const cur = String(S.display || 'primary');
  // keep a remembered screen visible even while it's unplugged
  if (!opts.some(o => o[0] === cur)) opts.push([cur, (S.displayLabel || 'Saved screen') + ' (not connected)']);
  sel.innerHTML = opts.map(([v, n]) => `<option value="${v}">${n.replace(/[<>&]/g, '')}</option>`).join('');
  sel.value = cur;
}

function render() {
  document.documentElement.dataset.theme = S.theme === 'dark' ? 'dark' : 'white';
  document.querySelectorAll('#theme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.theme));
  $('#login').checked = !!S.launchAtLogin;
  renderDisplays();
  $('#msgAll').checked = !!S.messageAllApps;
  $('#peekApps').checked = !!S.peeks.apps;
  $('#peekPower').checked = !!S.peeks.power;
  if (document.activeElement !== $('#city')) $('#city').value = S.city || '';
  if (document.activeElement !== $('#msgApps')) $('#msgApps').value = S.messageApps || '';
  if (document.activeElement !== $('#cal')) $('#cal').value = S.calendarUrl || '';

  const box = $('#tiles');
  box.innerHTML = '';
  S.tiles.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <label class="switch"><input type="checkbox" ${t.show ? 'checked' : ''}><span></span></label>
      <span class="grow">${NAMES[t.id]}</span>
      <div class="seg">${[1, 2, 3].map(n => `<button data-size="${n}" class="${t.size === n ? 'on' : ''}">${n}</button>`).join('')}</div>
      <button class="arrow" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move left">↑</button>
      <button class="arrow" data-move="1" ${i === S.tiles.length - 1 ? 'disabled' : ''} title="Move right">↓</button>`;
    row.querySelector('input').onchange = e => save({ tiles: S.tiles.map((x, j) => j === i ? { ...x, show: e.target.checked } : x) });
    row.querySelectorAll('[data-size]').forEach(b => b.onclick = () => save({ tiles: S.tiles.map((x, j) => j === i ? { ...x, size: +b.dataset.size } : x) }));
    row.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
      const k = i + +b.dataset.move;
      const arr = S.tiles.slice();
      [arr[i], arr[k]] = [arr[k], arr[i]];
      save({ tiles: arr });
    });
    box.append(row);
  });
}

function bindText(id, key, savedId) {
  const input = $(id);
  const commit = () => { if ((S[key] || '') !== input.value.trim()) { save({ [key]: input.value.trim() }); flash(savedId); } };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); input.blur(); } });
}

(async () => {
  S = await api.invoke('get-settings');
  DISPLAYS = await api.invoke('get-displays');
  render();
  $('#display').onchange = e => save({ display: e.target.value });
  $('#identify').onclick = () => api.send('identify-screens');
  api.on('displays', d => { DISPLAYS = d; renderDisplays(); });
  UP = await api.invoke('get-update'); renderUpdate();
  api.on('update', u => { UP = u; renderUpdate(); });
  $('#upBtn').onclick = () => api.send(UP && UP.state === 'ready' ? 'install-update' : 'check-updates');
  document.querySelectorAll('#theme button').forEach(b => b.onclick = () => save({ theme: b.dataset.v }));
  $('#login').onchange = e => save({ launchAtLogin: e.target.checked });
  $('#msgAll').onchange = e => save({ messageAllApps: e.target.checked });
  $('#peekApps').onchange = e => save({ peeks: { ...S.peeks, apps: e.target.checked } });
  $('#peekPower').onchange = e => save({ peeks: { ...S.peeks, power: e.target.checked } });
  bindText('#city', 'city', '#citySaved');
  bindText('#msgApps', 'messageApps', '#appsSaved');
  bindText('#cal', 'calendarUrl', '#calSaved');
  const snip = await api.invoke('claude-snippet');
  $('#snippet').textContent = snip;
  $('#copy').onclick = async () => { await api.invoke('copy-text', snip); flash('#copied'); };
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const NICE = { PreToolUse: 'a tool step', PermissionRequest: 'a permission request', Stop: 'a finished task', UserPromptSubmit: 'a new prompt', Notification: 'a notification' };
  const showCC = c => {
    const el = $('#ccStatus');
    if (!c) return;
    if (c.error) { el.innerHTML = `<b style="color:var(--accent)">Not listening:</b> ${c.error.replace(/[<>&]/g, '')}`; return; }
    if (!c.lastAt) { el.innerHTML = '<b>Not connected yet.</b> <span class="sub">No message from Claude Code so far. Check the lines are in settings.json, then restart Claude Code.</span>'; return; }
    el.innerHTML = `<b style="color:var(--accent)">Connected.</b> <span class="sub">Last message: ${NICE[c.lastEvent] || c.lastEvent}, ${ago(c.lastAt)}.</span>`;
  };
  let CC = await api.invoke('claude-status'); showCC(CC);
  api.on('claude-status', c => { CC = c; showCC(c); });
  setInterval(() => showCC(CC), 15000);
  api.on('settings', s => { S = s; render(); });
})();
