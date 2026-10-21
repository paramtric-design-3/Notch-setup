'use strict';
// In-game item overlay: next item to buy, the rest of the build, next skill.
const box = document.getElementById('o');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
window.notch.on('overlay', p => {
  const b = p && p.build;
  if (!b) { box.className = ''; return; }
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
    <div class="meta">${nextSkill && lvl < 18 ? `Level ${lvl + 1}: <i>${esc(nextSkill)}</i>` : ''}${b.maxOrder && b.maxOrder.length ? `<span>Max ${b.maxOrder.map(esc).join(' › ')}</span>` : ''}<span>· OP.GG</span></div>`;
});
