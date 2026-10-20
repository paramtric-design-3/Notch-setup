// FJBC Notch — League of Legends mode.
// Talks only to the League client on this PC (its local API, the same one tools like
// Porofessor use) and to the game's live data while a match runs. No Riot account key.
// Ranks are looked up once the game is loading, never in champ select (Riot doesn't allow
// revealing the hidden names there).
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LIVE_PORT = 2999;
// Both servers use self-signed certificates and only listen on 127.0.0.1.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });

function request(port, p, auth, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port, path: p, method: 'GET', agent, timeout,
      headers: { Accept: 'application/json', ...(auth ? { Authorization: 'Basic ' + Buffer.from('riot:' + auth).toString('base64') } : {}) },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${p}`));
        try { resolve(body ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

const QUEUES = {
  420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay',
  450: 'ARAM', 1700: 'Arena', 1900: 'URF', 900: 'ARURF', 830: 'Co-op vs AI', 840: 'Co-op vs AI', 850: 'Co-op vs AI',
};

function rankOf(entry) {
  if (!entry || !entry.tier || entry.tier === 'NONE' || entry.tier === '') return null;
  return {
    tier: entry.tier, division: entry.division && entry.division !== 'NA' ? entry.division : '',
    lp: entry.leaguePoints || 0, wins: entry.wins || 0, losses: entry.losses || 0,
  };
}

class League {
  constructor({ send, log, cacheDir, fetchImpl }) {
    this.send = send;               // (data) => void, to the island
    this.log = log || (() => {});
    this.cacheDir = cacheDir;
    this.fetch = fetchImpl || fetch;
    this.lcu = null;                // { port, token }
    this.phase = 'None';
    this.me = null;
    this.meAt = 0;
    this.game = null;               // current roster
    this.gameKey = '';
    this.players = new Map();       // riotId -> looked-up info, for this game
    this.ddVersion = null;
    this.icons = new Map();
    this.timer = null;
    this.busy = false;
    this.lastSent = '';
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), 1500); }
  stop() { clearInterval(this.timer); this.timer = null; }

  setClient(info) {
    const key = info ? `${info.port}:${info.token}` : '';
    const was = this.lcu ? `${this.lcu.port}:${this.lcu.token}` : '';
    if (key === was) return;
    this.lcu = info || null;
    if (!info) { this.me = null; this.phase = 'None'; this.endGame(); }
    this.meAt = 0;
    this.tick();
  }

  lcuGet(p) { return this.lcu ? request(this.lcu.port, p, this.lcu.token) : Promise.reject(new Error('no client')); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.lcu) { this.emit(); return; }
      // phase: None, Lobby, Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress, EndOfGame…
      let phase = this.phase;
      try { phase = (await this.lcuGet('/lol-gameflow/v1/gameflow-phase')) || 'None'; } catch { /* client busy */ }
      const changed = phase !== this.phase;
      this.phase = phase;
      if (changed && (phase === 'EndOfGame' || phase === 'Lobby' || phase === 'None')) { this.endGame(); this.meAt = 0; }
      if (!this.me || Date.now() - this.meAt > 5 * 60 * 1000) await this.loadMe();
      this.opggProbe();
      if (phase === 'GameStart' || phase === 'InProgress' || phase === 'Reconnect') { this.cs = null; await this.loadGame(); }
      if (phase === 'ChampSelect') await this.loadChampSelect(changed);
      else if (this.cs) { this.cs = null; this.csChamp = 0; }
      if (!this.history || Date.now() - this.historyAt > 10 * 60 * 1000 || (changed && phase === 'EndOfGame')) await this.loadHistory();
      this.emit();
    } catch (e) {
      this.log('league: ' + e.message);
    } finally {
      this.busy = false;
    }
  }

  async loadMe() {
    try {
      const s = await this.lcuGet('/lol-summoner/v1/current-summoner');
      if (!s || !s.puuid) return;
      const r = await this.lcuGet(`/lol-ranked/v1/ranked-stats/${s.puuid}`).catch(() => null);
      const q = (r && r.queueMap) || {};
      this.me = {
        puuid: s.puuid, name: s.gameName || s.displayName || '', tag: s.tagLine || '',
        solo: rankOf(q.RANKED_SOLO_5x5), flex: rankOf(q.RANKED_FLEX_SR),
      };
      this.meAt = Date.now();
    } catch (e) { this.log('league me: ' + e.message); }
  }

  // ---------------------------------------------------------------- champions (id <-> name)
  async loadChampions() {
    if (this.champs) return this.champs;
    try {
      if (!this.ddVersion) {
        const v = await (await this.fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
        this.ddVersion = Array.isArray(v) && v[0];
      }
      const d = await (await this.fetch(`https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/data/en_US/champion.json`)).json();
      const map = {};
      for (const c of Object.values(d.data || {})) map[+c.key] = { key: c.id, name: c.name };
      this.champs = map;
    } catch (e) {
      // Fall back to the client's own list (names only).
      try {
        const list = await this.lcuGet('/lol-game-data/assets/v1/champion-summary.json');
        const map = {};
        for (const c of list || []) if (c.id > 0) map[c.id] = { key: String(c.alias || c.name).replace(/[^A-Za-z]/g, ''), name: c.name };
        this.champs = map;
      } catch { this.log('league champions: ' + e.message); }
    }
    return this.champs;
  }
  champ(id) {
    const c = this.champs && this.champs[id];
    return c ? { id, key: c.key, name: c.name, icon: this.icons.get(c.key) || null } : (id ? { id, key: '', name: `#${id}`, icon: null } : null);
  }

  // ---------------------------------------------------------------- your recent games (for your stats and pick ideas)
  async loadHistory() {
    this.historyAt = Date.now();
    if (!this.me) return;
    try {
      const mh = await this.lcuGet(`/lol-match-history/v1/products/lol/${this.me.puuid}/matches?begIndex=0&endIndex=49`);
      const games = (mh && mh.games && mh.games.games) || [];
      this.history = games.map(g => {
        const p = (g.participants || [])[0] || {};
        const st = p.stats || {};
        const tl = p.timeline || {};
        const lane = tl.lane === 'BOTTOM' ? (tl.role === 'DUO_SUPPORT' ? 'utility' : 'bottom') : ({ TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', MID: 'middle' }[tl.lane] || '');
        return { champ: p.championId, win: !!st.win, k: st.kills || 0, d: st.deaths || 0, a: st.assists || 0, lane, queue: g.queueId };
      }).filter(g => g.champ);
      await this.loadChampions();
      this.loadIcons(this.topChamps('', 6).map(c => c.key).filter(Boolean));
    } catch (e) { this.log('league history: ' + e.message); }
  }
  statsFor(champId) {
    const gs = (this.history || []).filter(g => g.champ === champId);
    if (!gs.length) return null;
    const w = gs.filter(g => g.win).length;
    const k = gs.reduce((a, g) => a + g.k, 0), d = gs.reduce((a, g) => a + g.d, 0), a2 = gs.reduce((a, g) => a + g.a, 0);
    return { games: gs.length, wins: w, kda: d ? Math.round((k + a2) / d * 10) / 10 : k + a2 };
  }
  topChamps(lane, n = 5) {
    const by = new Map();
    for (const g of this.history || []) if (!lane || g.lane === lane) by.set(g.champ, (by.get(g.champ) || 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => ({ ...this.champ(id), stats: this.statsFor(id) }));
  }

  // ---------------------------------------------------------------- champ select
  async loadChampSelect(entered) {
    await this.loadChampions();
    let s;
    try { s = await this.lcuGet('/lol-champ-select/v1/session'); } catch { s = null; }
    if (!s || !Array.isArray(s.myTeam)) return;
    const meCell = s.localPlayerCellId;
    const actions = (s.actions || []).flat();
    const lockedCells = new Set(actions.filter(a => a.type === 'pick' && a.completed).map(a => a.actorCellId));
    const allies = s.myTeam.map(p => {
      const id = p.championId || p.championPickIntent || 0;
      return { me: p.cellId === meCell, position: p.assignedPosition || '', champ: this.champ(id), locked: !!p.championId && lockedCells.has(p.cellId) };
    });
    const mine = allies.find(a => a.me) || {};
    const enemies = (s.theirTeam || []).map(p => this.champ(p.championId)).filter(Boolean);
    const bans = s.bans || {};
    const banList = [...(bans.myTeamBans || []), ...(bans.theirTeamBans || [])].filter(x => x > 0);
    const actionBans = actions.filter(a => a.type === 'ban' && a.completed && a.championId > 0).map(a => a.championId);
    const timer = s.timer || {};
    const myChamp = mine.champ ? mine.champ.id : 0;
    if (myChamp !== this.csChamp) {
      this.csChamp = myChamp;
      this.csRunes = null;
      if (myChamp) this.loadRecommendedRunes(myChamp, mine.position);
    }
    if (entered) this.send({ type: 'cs-start', position: mine.position });
    this.cs = {
      position: mine.position || '', timeLeft: Math.max(0, Math.round(timer.adjustedTimeLeftInPhase || 0)), timerPhase: timer.phase || '',
      at: Date.now(), me: mine.champ ? { ...mine.champ, locked: mine.locked, stats: this.statsFor(mine.champ.id) } : null,
      allies, enemies, bans: [...new Set([...banList, ...actionBans])].map(id => this.champ(id)),
      runes: this.csRunes, ideas: this.topChamps(mine.position || '', 4),
    };
    this.loadIcons([...allies.map(a => a.champ && a.champ.key), ...enemies.map(e => e.key), ...this.cs.bans.map(b => b && b.key), ...this.cs.ideas.map(i => i.key)].filter(Boolean));
  }

  // Riot's own recommended rune pages, from the client.
  async loadRecommendedRunes(champId, position) {
    const pos = ({ middle: 'MIDDLE', top: 'TOP', jungle: 'JUNGLE', bottom: 'BOTTOM', utility: 'UTILITY' })[position] || 'NONE';
    try {
      let pages = await this.lcuGet(`/lol-perks/v1/recommended-pages/champion/${champId}/position/${pos}/map/11`).catch(() => null);
      if ((!pages || !pages.length) && pos !== 'NONE') pages = await this.lcuGet(`/lol-perks/v1/recommended-pages/champion/${champId}/position/NONE/map/11`).catch(() => null);
      const p = Array.isArray(pages) && pages[0];
      if (!p) { this.log(`league runes: none for ${champId}/${pos}`); return; }
      const styles = await this.lcuGet('/lol-perks/v1/styles').catch(() => []);
      const styleName = id => ((styles || []).find(x => x.id === id) || {}).name || '';
      const perks = (p.perks || []).map(x => typeof x === 'object' ? x : { id: x });
      const keystone = p.keystone || perks[0] || {};
      this.csRunes = {
        primary: p.primaryPerkStyleId, secondary: p.secondaryPerkStyleId,
        primaryName: styleName(p.primaryPerkStyleId), secondaryName: styleName(p.secondaryPerkStyleId),
        keystone: keystone.name || '', perkIds: perks.map(x => x.id).filter(Boolean),
        names: perks.map(x => x.name).filter(Boolean),
      };
      if (this.cs) { this.cs.runes = this.csRunes; this.emit(); }
    } catch (e) { this.log('league runes: ' + e.message); }
  }

  // Create (or update) a rune page named "Notch: <champion>" and make it current.
  async importRunes() {
    const r = this.csRunes;
    const me = this.cs && this.cs.me;
    if (!r || !me || r.perkIds.length < 6) return { ok: false, error: 'No recommended runes yet' };
    const body = { name: `Notch: ${me.name}`, primaryStyleId: r.primary, subStyleId: r.secondary, selectedPerkIds: r.perkIds, current: true };
    try {
      const pages = (await this.lcuGet('/lol-perks/v1/pages')) || [];
      const ours = pages.find(p => /^Notch:/.test(p.name || '') && p.isEditable);
      if (ours) await this.lcuSend('DELETE', `/lol-perks/v1/pages/${ours.id}`);
      await this.lcuSend('POST', '/lol-perks/v1/pages', body);
      return { ok: true };
    } catch (e) {
      this.log('league import runes: ' + e.message);
      return { ok: false, error: /400|limit|max/i.test(e.message) ? 'All rune pages are in use: delete one in the client first' : 'Could not create the rune page' };
    }
  }

  lcuSend(method, p, body) {
    return new Promise((resolve, reject) => {
      if (!this.lcu) return reject(new Error('no client'));
      const data = body ? JSON.stringify(body) : '';
      const r = https.request({
        host: '127.0.0.1', port: this.lcu.port, path: p, method, agent, timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Basic ' + Buffer.from('riot:' + this.lcu.token).toString('base64') },
      }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode} ${b.slice(0, 120)}`)) : resolve(b)); });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      r.end(data);
    });
  }

  // ---------------------------------------------------------------- OP.GG open data (one-time format check)
  // OP.GG publishes its champion data (counters, builds, runes) at https://mcp-api.op.gg/mcp.
  // Ask once which tools and parameters it has and save one sample answer, so the next
  // version can use it. Written to opgg-sample.json in the app's settings folder.
  async opggProbe() {
    if (this.opggDone) return;
    this.opggDone = true;
    const file = path.join(this.cacheDir, 'opgg-sample.json');
    try { if (Date.now() - fs.statSync(file).mtimeMs < 24 * 3600 * 1000) return; } catch { /* not yet */ }
    const url = 'https://mcp-api.op.gg/mcp';
    let session = null, id = 0;
    const call = async (method, params, notify = false) => {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
      });
      session = res.headers.get('mcp-session-id') || session;
      const text = await res.text();
      if (notify) return null;
      const json = text.trim().startsWith('{') ? text : (text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop() || 'null');
      return JSON.parse(json);
    };
    const out = { at: new Date().toISOString() };
    try {
      out.init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fjbc-notch', version: '1' } });
      await call('notifications/initialized', {}, true);
      const tools = await call('tools/list', {});
      out.tools = ((tools && tools.result && tools.result.tools) || []).filter(t => /^lol/.test(t.name));
      const t = out.tools.find(x => /champion_analysis|champion-analysis/.test(x.name));
      if (t) {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const pick = (k, want) => {
          const en = props[k] && (props[k].enum || (props[k].items && props[k].items.enum));
          if (!en) return want[0];
          return en.find(v => want.some(w => String(v).toLowerCase() === w.toLowerCase())) || en[0];
        };
        const args = {};
        if (props.champion) args.champion = pick('champion', ['AHRI', 'Ahri', 'ahri']);
        if (props.position) args.position = pick('position', ['mid', 'middle', 'MID']);
        if (props.game_mode) args.game_mode = pick('game_mode', ['ranked', 'RANKED']);
        if (props.lang) args.lang = pick('lang', ['en_US', 'en']);
        if (props.desired_output_fields) args.desired_output_fields = ['data'];
        out.args = args;
        out.sample = await call('tools/call', { name: t.name, arguments: args });
      }
    } catch (e) { out.error = String(e && e.message || e); }
    try { fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch { /* ignore */ }
    this.log('opgg probe: ' + (out.error || `${(out.tools || []).length} tools, sample ${out.sample ? 'saved' : 'missing'}`));
  }

  endGame() { this.game = null; this.gameKey = ''; this.players.clear(); }

  async loadGame() {
    let live;
    try { live = await request(LIVE_PORT, '/liveclientdata/allgamedata', null, 2500); } catch { live = null; }
    if (!live || !Array.isArray(live.allPlayers) || !live.allPlayers.length) return;   // still loading
    const key = live.allPlayers.map(p => (p.riotId || p.summonerName) + p.championName).join('|');
    let queue = null;
    if (key !== this.gameKey) {
      this.gameKey = key;
      try {
        const sess = await this.lcuGet('/lol-gameflow/v1/session');
        const q = sess && sess.gameData && sess.gameData.queue;
        queue = q ? { id: q.id, name: QUEUES[q.id] || q.description || q.shortName || '', type: q.type || '' } : null;
      } catch { /* not important */ }
      this.game = { queue, mode: (live.gameData && live.gameData.gameMode) || '', players: [] };
      this.send({ type: 'game-start', queue: queue && queue.name });
    }
    const meId = live.activePlayer && (live.activePlayer.riotId || live.activePlayer.summonerName);
    this.game.time = Math.round((live.gameData && live.gameData.gameTime) || 0);
    this.game.players = live.allPlayers.map(p => {
      const riotId = p.riotId || (p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagLine}` : p.summonerName) || '';
      const [name, tag] = riotId.split('#');
      const champKey = String(p.rawChampionName || '').replace(/^game_character_displayname_/, '') || String(p.championName || '').replace(/[^A-Za-z]/g, '');
      const info = this.players.get(riotId);
      return {
        team: p.team === 'CHAOS' ? 'red' : 'blue', champ: p.championName || champKey, champKey,
        icon: this.icons.get(champKey) || null, name: name || p.summonerName || '?', tag: tag || '',
        me: !!meId && (riotId === meId || p.summonerName === meId), bot: !!p.isBot,
        position: p.position || '', ...(info || { loading: !p.isBot }),
      };
    });
    // Look players up a few at a time; each finished lookup shows up right away.
    const todo = this.game.players.filter(p => !p.bot && !this.players.has(`${p.name}#${p.tag}`));
    for (const p of todo) this.players.set(`${p.name}#${p.tag}`, { loading: true });
    this.lookupAll(todo, queue);
    this.loadIcons(this.game.players.map(p => p.champKey));
  }

  async lookupAll(list, queue) {
    const flex = queue && queue.id === 440;
    const run = async p => {
      const id = `${p.name}#${p.tag}`;
      try {
        let s = null;
        if (p.tag) s = await this.lcuGet(`/lol-summoner/v1/alias/lookup?gameName=${encodeURIComponent(p.name)}&tagLine=${encodeURIComponent(p.tag)}`).catch(() => null);
        if (!s || !s.puuid) s = await this.lcuGet(`/lol-summoner/v1/summoners?name=${encodeURIComponent(p.tag ? id : p.name)}`).catch(() => null);
        if (!s || !s.puuid) { this.players.set(id, { loading: false, unknown: true }); return; }
        const [r, mh] = await Promise.all([
          this.lcuGet(`/lol-ranked/v1/ranked-stats/${s.puuid}`).catch(() => null),
          this.lcuGet(`/lol-match-history/v1/products/lol/${s.puuid}/matches?begIndex=0&endIndex=9`).catch(() => null),
        ]);
        const q = (r && r.queueMap) || {};
        const games = (mh && mh.games && mh.games.games) || [];
        const recent = games.map(g => {
          const part = (g.participants || [])[0];
          return part && part.stats ? !!part.stats.win : null;
        }).filter(x => x !== null).slice(0, 10);
        this.players.set(id, {
          loading: false, rank: rankOf(flex ? q.RANKED_FLEX_SR : q.RANKED_SOLO_5x5) || null,
          other: rankOf(flex ? q.RANKED_SOLO_5x5 : q.RANKED_FLEX_SR) || null, recent, level: s.summonerLevel || 0,
        });
      } catch (e) {
        this.players.set(id, { loading: false, unknown: true });
        this.log('league lookup: ' + e.message);
      }
      this.refreshRoster();
      this.emit();
    };
    const queueList = list.slice();
    const workers = Array.from({ length: 3 }, async () => { while (queueList.length) await run(queueList.shift()); });
    await Promise.all(workers);
  }

  refreshRoster() {
    if (!this.game) return;
    this.game.players = this.game.players.map(p => ({ ...p, icon: this.icons.get(p.champKey) || p.icon, ...(this.players.get(`${p.name}#${p.tag}`) || {}) }));
  }

  // Champion pictures from Riot's Data Dragon, cached on disk.
  async loadIcons(keys) {
    if (Date.now() < (this.iconRetryAt || 0)) return;
    try {
      if (!this.ddVersion) {
        const v = await (await this.fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
        this.ddVersion = Array.isArray(v) && v[0];
      }
      if (!this.ddVersion) return;
      const dir = path.join(this.cacheDir, 'champions');
      fs.mkdirSync(dir, { recursive: true });
      let any = false;
      for (const k of [...new Set(keys)].filter(k => k && !this.icons.has(k))) {
        const file = path.join(dir, `${k}.png`);
        let buf = null;
        try { buf = fs.readFileSync(file); } catch {
          const res = await this.fetch(`https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/champion/${encodeURIComponent(k)}.png`);
          if (res.ok) { buf = Buffer.from(await res.arrayBuffer()); fs.writeFileSync(file, buf); }
        }
        if (buf) { this.icons.set(k, 'data:image/png;base64,' + buf.toString('base64')); any = true; }
      }
      if (any) { this.refreshRoster(); this.emit(); }
    } catch (e) { this.iconRetryAt = Date.now() + 60 * 1000; this.log('league icons: ' + e.message); }
  }

  emit() {
    const data = {
      type: 'state', client: !!this.lcu, phase: this.phase,
      me: this.me && { name: this.me.name, tag: this.me.tag, solo: this.me.solo, flex: this.me.flex },
      cs: this.cs && { ...this.cs, me: this.cs.me && { ...this.cs.me, icon: this.icons.get(this.cs.me.key) || this.cs.me.icon },
        allies: this.cs.allies.map(a => ({ ...a, champ: a.champ && { ...a.champ, icon: this.icons.get(a.champ.key) || null } })),
        enemies: this.cs.enemies.map(e => ({ ...e, icon: this.icons.get(e.key) || null })),
        bans: this.cs.bans.filter(Boolean).map(b => ({ ...b, icon: this.icons.get(b.key) || null })),
        ideas: this.cs.ideas.map(i => ({ ...i, icon: this.icons.get(i.key) || null })) },
      top: this.history ? this.topChamps('', 6) .map(c => ({ ...c, icon: this.icons.get(c.key) || null })) : [],
      game: this.game && { queue: this.game.queue && this.game.queue.name, time: this.game.time, players: this.game.players },
    };
    const sig = JSON.stringify({ ...data, game: data.game && { ...data.game, time: 0 }, cs: data.cs && { ...data.cs, at: 0, timeLeft: Math.round(data.cs.timeLeft / 5000) } });
    if (sig === this.lastSent) return;
    this.lastSent = sig;
    this.send(data);
  }
}

module.exports = { League, request, rankOf, QUEUES };
