// Small line icons (currentColor). Drawn for WALL-E.
'use strict';
const I = (() => {
  const s = (d, vb = 24, extra = '') =>
    `<svg viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const f = (d, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" fill="currentColor">${d}</svg>`;
  return {
    prev: f('<path d="M11.5 6.5v11L4 12zM20 6.5v11L12.5 12z"/>'),
    next: f('<path d="M12.5 6.5v11L20 12zM4 6.5v11L11.5 12z"/>'),
    play: f('<path d="M7 5v14l12-7z"/>'),
    pause: f('<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>'),
    note: s('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    wifi: s('<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.7 15.8a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19" r=".9" fill="currentColor"/>'),
    bt: s('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>'),
    contrast: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
    volume: s('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    mute: s('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
    sun: s('<circle cx="12" cy="12" r="3.6"/><path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>'),
    grid: s('<rect x="4" y="4" width="4" height="4" rx="1"/><rect x="10" y="4" width="4" height="4" rx="1"/><rect x="16" y="4" width="4" height="4" rx="1"/><rect x="4" y="10" width="4" height="4" rx="1"/><rect x="10" y="10" width="4" height="4" rx="1"/><rect x="16" y="10" width="4" height="4" rx="1"/><rect x="4" y="16" width="4" height="4" rx="1"/><rect x="10" y="16" width="4" height="4" rx="1"/><rect x="16" y="16" width="4" height="4" rx="1"/>'),
    speaker: s('<rect x="6" y="3" width="12" height="18" rx="2.5"/><circle cx="12" cy="14" r="3.2"/><circle cx="12" cy="7.2" r="1" fill="currentColor"/>'),
    headphones: s('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>'),
    monitor: s('<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>'),
    bars: s('<path d="M5 20v-7M12 20V5M19 20v-10M3 20h18"/>'),
    // League positions, in the style of the client's own role icons (filled; faded parts at 35%).
    roleTop: f('<path d="M3 3h13l-4 4H7v5l-4 4z"/><path d="M10 10h4v4h-4z"/><path d="M21 8v13H8l4-4h5v-5z" opacity=".35"/>'),
    roleBot: f('<path d="M21 21H8l4-4h5v-5l4-4z"/><path d="M10 10h4v4h-4z"/><path d="M3 16V3h13l-4 4H7v5z" opacity=".35"/>'),
    roleMid: f('<path d="M3 21v-3L18 3h3v3L6 21z"/><path d="M3 3h10l-3 3H6v4l-3 3zM21 21H11l3-3h4v-4l3-3z" opacity=".35"/>'),
    roleJungle: f('<path d="M6.5 2.5c3.2 3 4.8 7.2 4.8 11.4L10 21c-1-4-3.3-7-6.5-9.2 2 0 3.3.6 4.4 1.7-.4-3.8-.9-7.3-1.4-11zM17.5 2.5c-.5 3.7-1 7.2-1.4 11 1.1-1.1 2.4-1.7 4.4-1.7-3.2 2.2-5.5 5.2-6.5 9.2l-1.3-7.1c0-4.2 1.6-8.4 4.8-11.4z"/>'),
    roleSupport: f('<path d="M9 3h6l-1.2 3.4h-3.6zM1.5 7.2h7.3l2 2.8-2.2 3H5.8l-1.2-3zM22.5 7.2h-7.3l-2 2.8 2.2 3h2.8l1.2-3zM10.4 11.5h3.2l1 8.3L12 22l-2.6-2.2z"/>'),
    podium: s('<path d="M9 21V9h6v12M3 21v-7h6M15 21v-4h6v4M2 21h20"/><path d="M12 3l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 5.1l2-.3z" fill="currentColor" stroke="none"/>'),
    swords: s('<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5L18 3h3v3l-3.5 8.5M5 14l4 4M7 17l-3 3M3 19l2 2"/>'),
    trophy: s('<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5A3 3 0 0 0 7 10.4M17 6h2.5v1.5A3 3 0 0 1 17 10.4"/><path d="M12 14v3.5M8.5 20.5h7M9.5 17.5h5v3h-5z"/>'),
    chevron: s('<path d="M9.5 6l6 6-6 6"/>'),
    pin: s('<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>'),
    chat: s('<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>'),
    calendar: s('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    timer: s('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 2.5h5"/>'),
    reset: s('<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>'),
    bolt: f('<path d="M13 2L5 13.5h6L10 22l9-12h-6z"/>'),
    battery: s('<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/>'),
    check: s('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 24, 'stroke-width="2.2"'),
    download: s('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
    bell: s('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    // Claude Code steps
    read: s('<path d="M4 5.5h6a2 2 0 0 1 2 2V20a1.5 1.5 0 0 0-1.5-1.5H4z"/><path d="M20 5.5h-6a2 2 0 0 0-2 2V20a1.5 1.5 0 0 1 1.5-1.5H20z"/>'),
    edit: s('<path d="M15 4.5l4.5 4.5L9 19.5H4.5V15z"/><path d="M13 6.5l4.5 4.5"/>'),
    run: s('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>'),
    search: s('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
    think: s('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
    // weather (still icons)
    w_sun: '<svg viewBox="0 0 48 48"><g stroke="var(--sun)" stroke-width="2.6" stroke-linecap="round"><path d="M24 5v4M24 39v4M5 24h4M39 24h4M10.6 10.6l2.8 2.8M34.6 34.6l2.8 2.8M10.6 37.4l2.8-2.8M34.6 13.4l2.8-2.8"/></g><circle cx="24" cy="24" r="8.5" fill="var(--sun)"/></svg>',
    w_partly: '<svg viewBox="0 0 48 48"><g stroke="var(--sun)" stroke-width="2.4" stroke-linecap="round"><path d="M30 5v3.5M41.5 16.5H45M38.1 8.9l-2.5 2.5M21.9 8.9l2.5 2.5"/></g><circle cx="30" cy="17" r="7" fill="var(--sun)"/><path d="M14 40h20a8 8 0 0 0 .8-16 10.5 10.5 0 0 0-20.2 3A6.5 6.5 0 0 0 14 40z" fill="var(--cloud)"/></svg>',
    w_cloud: '<svg viewBox="0 0 48 48"><path d="M13 38h22a8.5 8.5 0 0 0 .9-17A11 11 0 0 0 14.6 24 7 7 0 0 0 13 38z" fill="var(--cloud)"/></svg>',
    w_fog: '<svg viewBox="0 0 48 48"><path d="M13 30h22a8.5 8.5 0 0 0 .9-17A11 11 0 0 0 14.6 16 7 7 0 0 0 13 30z" fill="var(--cloud)"/><g stroke="var(--cloud-dark)" stroke-width="2.6" stroke-linecap="round"><path d="M9 36h28M14 42h24"/></g></svg>',
    w_rain: '<svg viewBox="0 0 48 48"><path d="M13 30h22a8.5 8.5 0 0 0 .9-17A11 11 0 0 0 14.6 16 7 7 0 0 0 13 30z" fill="var(--cloud)"/><g stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round"><path d="M17 35l-2 5M25 35l-2 5M33 35l-2 5"/></g></svg>',
    w_snow: '<svg viewBox="0 0 48 48"><path d="M13 30h22a8.5 8.5 0 0 0 .9-17A11 11 0 0 0 14.6 16 7 7 0 0 0 13 30z" fill="var(--cloud)"/><g fill="var(--accent)"><circle cx="16" cy="37" r="2"/><circle cx="24" cy="40" r="2"/><circle cx="32" cy="37" r="2"/></g></svg>',
    w_storm: '<svg viewBox="0 0 48 48"><path d="M13 30h22a8.5 8.5 0 0 0 .9-17A11 11 0 0 0 14.6 16 7 7 0 0 0 13 30z" fill="var(--cloud-dark)"/><path d="M25 31l-5 8h5l-2 6 7-9h-5l2-5z" fill="var(--sun)"/></svg>',
    w_moon: '<svg viewBox="0 0 48 48"><path d="M30 8a15 15 0 1 0 10 25A13 13 0 0 1 30 8z" fill="var(--moon)"/></svg>',
  };
})();
