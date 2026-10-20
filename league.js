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

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), 3000); }
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
      if (phase === 'GameStart' || phase === 'InProgress' || phase === 'Reconnect') await this.loadGame();
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
      game: this.game && { queue: this.game.queue && this.game.queue.name, time: this.game.time, players: this.game.players },
    };
    const sig = JSON.stringify({ ...data, game: data.game && { ...data.game, time: 0 } });
    if (sig === this.lastSent) return;
    this.lastSent = sig;
    this.send(data);
  }
}

module.exports = { League, request, rankOf, QUEUES };
