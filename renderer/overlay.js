'use strict';
// In-game item overlay: next item to buy, the rest of the build, next skill.
const box = document.getElementById('o');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
window.notch.on('overlay', p => {
  const b = p && p.build;
  if (!b || b.unsupported || b.loading || b.failed) { box.className = ''; return; }
  const pics = p.pics || {};
  const img = id => pics['item:' + id] ? `<img src="${pics['item:' + id]}" alt="">` : '';
  const ownedLeft = (b.owned || []).slice();
  const got = new Set();
  for (const id of [...b.boots, ...b.core, ...b.later]) { const i = ownedLeft.indexOf(id); if (i >= 0) { got.add(id); ownedLeft.splice(i, 1); } }
  const order = [...b.core, ...b.boots, ...b.later];
  const next = order.find(id => !got.has(id));
  const path = [...b.boots, ...b.core, ...b.later];
  const lvl = b.level || 1;
  const nextSkill = (b.skills || [])[lvl];
  const names = b.names || {};
  box.className = 'show' + (p.place === 'left' ? ' left' : '');
  box.innerHTML = `
    ${next ? `<div class="next">${img(next) || '<span class="ph"></span>'}<div class="nl"><small>Buy next</small><b>${esc(names[next] || 'Item ' + next)}</b></div></div>`
      : '<div class="next done"><div class="nl"><small>Build</small><b>Full build done ✓</b></div></div>'}
    <div class="path">${path.map((id, i) => `${i === b.boots.length && b.boots.length ? '<span class="sep">›</span>' : ''}${i === b.boots.length + b.core.length && b.later.length ? '<span class="sep">›</span>' : ''}<span class="it ${got.has(id) ? 'own' : ''} ${id === next ? 'nx' : ''}" title="${esc(names[id] || '')}">${img(id)}</span>`).join('')}</div>
    ${(b.situational || []).length ? `<div class="sit"><small class="sl">Vs their team</small>${b.situational.map(x => `<span class="sc"><span class="it sitit ${(b.owned || []).includes(x.id) ? 'own' : ''}" title="${esc(x.name)} · ${esc(x.why)}">${img(x.id)}</span><span class="st">${esc(x.tag || '')}</span></span>`).join('')}</div>` : ''}
    <span class="grip" title="Drag to move"><i></i></span>
`;
});

// Hovering the tile makes the overlay take the mouse (the rest of the window stays click-through),
// and dragging anywhere on it moves it.
let overGrip = false, dragging = false;
document.addEventListener('mousemove', e => {
  const on = !!(e.target && e.target.closest && e.target.closest('#o'));
  if (on !== overGrip && !dragging) { overGrip = on; window.notch.send('overlay-mouse', on); }
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#o')) return;
  e.preventDefault(); dragging = true; document.body.classList.add('dragging');
  window.notch.send('overlay-drag', true);
});
const stop = () => { if (!dragging) return; dragging = false; overGrip = false; document.body.classList.remove('dragging'); window.notch.send('overlay-drag', false); };
document.addEventListener('mouseup', stop);
window.addEventListener('blur', stop);
document.addEventListener('mouseleave', () => { if (overGrip && !dragging) { overGrip = false; window.notch.send('overlay-mouse', false); } });
