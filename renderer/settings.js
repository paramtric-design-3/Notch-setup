'use strict';
const api = window.notch;
const $ = s => document.querySelector(s);
const NAMES = { league: 'League of Legends', music: 'Music', weather: 'Weather', messages: 'Messages', controls: 'Quick controls', calendar: 'Next event', timer: 'Focus timer', shelf: 'Shelf', todo: 'To Do' };
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
  const ov = S.overlay || { show: true, place: 'minimap' };
  $('#ovShow').checked = ov.show !== false;
  $('#ovTab').checked = ov.onTab !== false;
  if (document.activeElement !== $('#ovOpacity')) $('#ovOpacity').value = Math.round((1 - (ov.opacity == null ? 1 : ov.opacity)) * 100);
  $('#ovOpacityVal').textContent = $('#ovOpacity').value + '%';
  document.querySelectorAll('#ovPlace button').forEach(b => b.classList.toggle('on', b.dataset.v === (ov.place || 'minimap')));
  $('#ovCustom').hidden = ov.place !== 'custom';
  if (document.activeElement !== $('#city')) $('#city').value = S.city || '';
  if (document.activeElement !== $('#msgApps')) $('#msgApps').value = S.messageApps || '';

  // a feature's settings only show while its tile is on
  document.querySelectorAll('section[data-tile]').forEach(sec => {
    const tile = S.tiles.find(x => x.id === sec.dataset.tile);
    sec.hidden = !(tile && tile.show);
  });

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

// Foldable sections (remembered on this PC).
let FOLDED = {};
try { FOLDED = JSON.parse(localStorage.getItem('folded') || '{}'); } catch { FOLDED = {}; }
document.querySelectorAll('section > h2').forEach(h => {
  const key = h.textContent.trim();
  if (FOLDED[key]) h.parentElement.classList.add('folded');
  h.onclick = () => {
    const f = h.parentElement.classList.toggle('folded');
    FOLDED[key] = f;
    try { localStorage.setItem('folded', JSON.stringify(FOLDED)); } catch { /* fine */ }
  };
});

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
  $('#ovShow').onchange = e => save({ overlay: { ...(S.overlay || {}), show: e.target.checked } });
  $('#ovTab').onchange = e => save({ overlay: { ...(S.overlay || {}), onTab: e.target.checked } });
  // 0% is solid, higher lets the game show through (up to 80%); saved while you slide
  $('#ovOpacity').oninput = e => { $('#ovOpacityVal').textContent = e.target.value + '%'; save({ overlay: { ...(S.overlay || {}), opacity: 1 - +e.target.value / 100 } }); };
  document.querySelectorAll('#ovPlace button').forEach(b => b.onclick = () => save({ overlay: { ...(S.overlay || {}), place: b.dataset.v } }));
  bindText('#city', 'city', '#citySaved');
  bindText('#msgApps', 'messageApps', '#appsSaved');
  api.on('settings', s => { S = s; render(); });
  // Microsoft To Do
  let TD = await api.invoke('todo-state').catch(() => null);
  const tdLists = async () => {
    const lists = await api.invoke('todo-lists').catch(() => []);
    const sel = $('#tdList');
    $('#tdListRow').hidden = !lists.length;
    if (!lists.length) return;
    const cur = (S.todo && S.todo.listId) || (lists.find(l => l.isDefault) || lists[0]).id;
    sel.innerHTML = lists.map(l => `<option value="${l.id}">${l.name.replace(/[<>&]/g, '')}</option>`).join('');
    sel.value = cur;
  };
  const tdRender = () => {
    const st = (TD && TD.status) || 'signedout';
    const btn = $('#tdSign');
    $('#tdClient').value = document.activeElement === $('#tdClient') ? $('#tdClient').value : ((S.todo && S.todo.clientId) || '');
    if (st === 'signedout') { $('#tdStatus').textContent = (TD && TD.error) || 'Not connected'; btn.textContent = 'Sign in'; btn.className = 'btn primary'; btn.disabled = false; $('#tdListRow').hidden = true; }
    else if (st === 'pending') { $('#tdStatus').textContent = `Paste code ${TD.code} on Microsoft's page (it's on your clipboard)`; btn.textContent = 'Cancel'; btn.className = 'btn'; }
    else { $('#tdStatus').textContent = st === 'error' ? (TD.error || 'Could not reach To Do') : `Connected${TD.list ? ' · ' + TD.list.name : ''} · ${(TD.tasks || []).filter(t => !t.done).length} open`; btn.textContent = 'Sign out'; btn.className = 'btn'; }
  };
  api.on('todo', d => { const was = TD && TD.status; TD = d; tdRender(); if (d.status === 'ok' && was !== 'ok') tdLists(); });
  $('#tdSign').onclick = async () => {
    const st = (TD && TD.status) || 'signedout';
    if (st === 'signedout') {
      $('#tdSign').disabled = true;
      const r = await api.invoke('todo-signin');
      $('#tdSign').disabled = false;
      if (!r.ok) { $('#tdStatus').textContent = r.error; if (/client ID/i.test(r.error)) $('#tdSteps').open = true; }
    } else await api.invoke('todo-signout');
  };
  const commitClient = () => { const v = $('#tdClient').value.trim(); if (v !== ((S.todo && S.todo.clientId) || '')) { save({ todo: { ...(S.todo || {}), clientId: v } }); flash('#tdSaved'); } };
  $('#tdClient').addEventListener('change', commitClient);
  $('#tdClient').addEventListener('keydown', e => { if (e.key === 'Enter') { commitClient(); e.target.blur(); } });
  $('#tdList').onchange = e => save({ todo: { ...(S.todo || {}), listId: e.target.value } });
  document.querySelectorAll('a[data-ext]').forEach(a => a.onclick = e => { e.preventDefault(); api.send('open-url', a.href); });
  tdRender();
  if (TD && TD.status === 'ok') tdLists();
})();
