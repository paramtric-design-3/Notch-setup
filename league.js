// WALL-E — League of Legends mode.
// Talks only to the League client on this PC (its local API, the same one tools like
// Porofessor use) and to the game's live data while a match runs. No Riot account key.
// Ranks are looked up once the game is loading, never in champ select (Riot doesn't allow
// revealing the hidden names there).
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { Opgg, POS, nameCandidates, findWinRate } = require('./opgg');

const LIVE_PORT = 2999;
const OUR_POS = { top: 'top', jungle: 'jungle', mid: 'middle', adc: 'bottom', support: 'utility' };
const META_TTL = 6 * 3600 * 1000;      // OP.GG tier lists and builds change once a patch, roughly
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
  constructor({ send, log, cacheDir, fetchImpl, trimImage }) {
    this.trimImage = trimImage || null;   // (png Buffer) => smaller png Buffer, cut to the emblem
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
    this.opgg = new Opgg({ fetchImpl: this.fetch, log: this.log });
    this.analysis = new Map();      // `${champId}:${position}` -> { at, data }
    this.opggNames = new Map();     // champId -> the name OP.GG knows it by
    this.matchups = new Map();      // `${mine}:${theirs}:${lane}` -> { winRate, games } | null
    this.sentIcons = new Set();
    this.meta = null; this.metaAt = 0;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(cacheDir, 'opgg-meta.json'), 'utf8'));
      if (m && m.v === 2 && m.lanes && m.roles && Date.now() - m.at < META_TTL) { this.meta = m.lanes; this.roleRates = m.roles; this.metaAt = m.at; }
    } catch { /* first run */ }
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), 1500); }
  stop() { clearInterval(this.timer); this.timer = null; }

  setClient(info) {
    const key = info ? `${info.port}:${info.token}` : '';
    const was = this.lcu ? `${this.lcu.port}:${this.lcu.token}` : '';
    if (key === was) return;
    this.lcu = info || null;
    if (!info) { this.me = null; if (this.phase !== 'InProgress') { this.phase = 'None'; this.endGame(); } }
    this.meAt = 0;
    this.tick();
  }

  lcuGet(p) { return this.lcu ? request(this.lcu.port, p, this.lcu.token) : Promise.reject(new Error('no client')); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // The game itself answers on port 2999 while you play, also when the League client closes
      // during games (its "Close client during game" setting): go by that first.
      const liveUp = await request(LIVE_PORT, '/liveclientdata/gamestats', null, 900).then(x => !!x, () => false);
      if (!this.lcu) {
        if (liveUp) {
          if (this.phase !== 'InProgress') this.log('league: in game without the client open, using the game data');
          this.phase = 'InProgress';
          this.cs = null;
          await this.loadGame();
        } else if (this.phase === 'InProgress') { this.phase = 'None'; this.endGame(); }
        this.emit();
        return;
      }
      // phase: None, Lobby, Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress, EndOfGame…
      let phase = this.phase;
      try { phase = (await this.lcuGet('/lol-gameflow/v1/gameflow-phase')) || 'None'; } catch { /* client busy */ }
      if (liveUp && !['GameStart', 'InProgress', 'Reconnect'].includes(phase)) phase = 'InProgress';
      const changed = phase !== this.phase;
      this.phase = phase;
      if (changed && (phase === 'EndOfGame' || phase === 'Lobby' || phase === 'None')) { this.endGame(); this.meAt = 0; }
      if (!this.me || Date.now() - this.meAt > 5 * 60 * 1000) await this.loadMe();
      this.loadMeta();
      if (phase === 'GameStart' || phase === 'InProgress' || phase === 'Reconnect') { this.cs = null; await this.loadGame(); }
      if (changed || (phase === 'ChampSelect' && !this.modeAt)) await this.loadMode(phase);
      if (phase === 'ChampSelect' && !this.noHelper) await this.loadChampSelect(changed);
      else if (this.cs) { this.cs = null; this.csChamp = 0; }
      if (!this.history || Date.now() - this.historyAt > 10 * 60 * 1000 || (changed && phase === 'EndOfGame')) await this.loadHistory();
      this.emit();
    } catch (e) {
      this.log('league: ' + e.message);
    } finally {
      this.busy = false;
    }
  }

  // Which game mode is queued. ARAM (Howling Abyss) and Arena have random or very different
  // picks, so the champ select helper stays out of the way there.
  async loadMode(phase) {
    this.modeAt = Date.now();
    if (phase === 'None') { this.mode = null; this.noHelper = false; return; }
    try {
      const g = await this.lcuGet('/lol-gameflow/v1/session');
      const gd = (g && g.gameData) || {};
      const q = gd.queue || {};
      const gm = String(q.gameMode || (g && g.map && g.map.gameMode) || '').toUpperCase();
      const mapId = q.mapId || (g && g.map && g.map.id) || 0;
      const arena = gm === 'CHERRY' || q.id === 1700 || q.id === 1710;
      const aram = !arena && (mapId === 12 || gm === 'ARAM' || q.id === 450 || q.id === 100);
      this.mode = arena ? 'Arena' : aram ? 'ARAM' : (QUEUES[q.id] || '');
      this.noHelper = arena || aram;
    } catch { this.mode = null; this.noHelper = false; }
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
      for (const c of Object.values(d.data || {})) map[+c.key] = { key: c.id, name: c.name, tags: c.tags || [], info: c.info || {} };
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
        return { champ: p.championId, win: !!st.win, k: st.kills || 0, d: st.deaths || 0, a: st.assists || 0, lane, queue: g.queueId, at: g.gameCreation || 0, dur: g.gameDuration || 0, remake: (g.gameDuration || 0) > 0 && g.gameDuration < 300 };
      }).filter(g => g.champ);
      await this.loadChampions();
      this.loadIcons([...this.topChamps('', 6), ...this.history.slice().sort((a, b) => b.at - a.at).slice(0, 6).map(g => this.champ(g.champ))].map(c => c && c.key).filter(Boolean));
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

  mainLane() {
    const n = {};
    for (const g of this.history || []) if (g.lane && (g.queue === 420 || g.queue === 440 || g.queue === 400)) n[g.lane] = (n[g.lane] || 0) + 1;
    const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    return best ? POS[best[0]] : 'jungle';
  }

  // ---------------------------------------------------------------- champ select
  async loadChampSelect(entered) {
    await this.loadChampions();
    let s;
    try { s = await this.lcuGet('/lol-champ-select/v1/session'); } catch { s = null; }
    if (!s || !Array.isArray(s.myTeam)) return;
    const meCell = s.localPlayerCellId;
    const timer = s.timer || {};
    const actions = (s.actions || []).flat();
    const lockedCells = new Set(actions.filter(a => a.type === 'pick' && a.completed).map(a => a.actorCellId));
    const inProgress = new Set(actions.filter(a => a.isInProgress && !a.completed).map(a => a.actorCellId));
    // Pick order and "Picking next", like the client: actions come in turns (one array per turn).
    const turns = (s.actions || []).filter(Array.isArray);
    const pickTurn = new Map();
    turns.forEach((turn, i) => { for (const a of turn) if (a.type === 'pick' && !pickTurn.has(a.actorCellId)) pickTurn.set(a.actorCellId, i); });
    const curTurn = turns.findIndex(t => t.some(a => a.isInProgress && !a.completed));
    const nextPickers = new Set();
    if (curTurn >= 0) {
      const nt = turns.slice(curTurn + 1).find(t => t.some(a => a.type === 'pick' && !a.completed));
      for (const a of nt || []) if (a.type === 'pick') nextPickers.add(a.actorCellId);
    }
    const order = cell => (pickTurn.has(cell) ? pickTurn.get(cell) : 99) * 10 + (cell % 10) / 10;
    const status = (cell, locked) => locked ? 'Locked in' : inProgress.has(cell) ? (actions.find(a => a.isInProgress && a.actorCellId === cell).type === 'ban' ? 'Banning…' : 'Picking…') : nextPickers.has(cell) ? 'Picking next…' : 'Waiting';
    // Anonymous names in ranked ("Murk Wolf"), from the client's per-player info, asked once per champ select.
    const gameId = (s.gameId || s.id || '') + ':' + s.localPlayerCellId;
    if (this.aliasFor !== gameId) { this.aliasFor = gameId; this.aliases = new Map(); }
    for (const p of [...s.myTeam, ...(s.theirTeam || [])]) {
      if (p.cellId == null || this.aliases.has(p.cellId)) continue;
      this.aliases.set(p.cellId, '');
      this.lcuGet(`/lol-champ-select/v1/summoners/${p.cellId}`).then(x => {
        const n = x && (x.gameName || x.displayName || x.summonerName || '');
        if (n) { this.aliases.set(p.cellId, n); }
      }).catch(() => {});
    }
    const allies = s.myTeam.map(p => {
      const id = p.championId || p.championPickIntent || 0;
      const locked = !!p.championId && lockedCells.has(p.cellId);
      return {
        me: p.cellId === meCell, position: p.assignedPosition || '', champ: this.champ(id), locked,
        name: p.gameName || p.summonerName || this.aliases.get(p.cellId) || '', status: status(p.cellId, locked), cell: p.cellId, turn: inProgress.has(p.cellId), spells: [p.spell1Id, p.spell2Id].filter(x => x > 0),
      };
    });
    allies.sort((a, b) => order(a.cell) - order(b.cell));
    const enemyRows = (s.theirTeam || []).map((p, i) => ({ champ: p.championId ? this.champ(p.championId) : null, status: p.championId ? (lockedCells.has(p.cellId) ? 'Locked in' : 'Hovering') : status(p.cellId, false), n: i + 1, cell: p.cellId, turn: inProgress.has(p.cellId) }))
      .sort((a, b) => order(a.cell) - order(b.cell)).map((r, i) => ({ ...r, n: i + 1 }));
    const cur = actions.find(a => a.isInProgress && !a.completed);
    const stage = cur ? cur.type : (timer.phase === 'FINALIZATION' ? 'final' : (timer.phase === 'PLANNING' ? 'ban' : 'pick'));
    const mine = allies.find(a => a.me) || {};
    const enemies = (s.theirTeam || []).map(p => this.champ(p.championId)).filter(Boolean);
    const bans = s.bans || {};
    const banList = [...(bans.myTeamBans || []), ...(bans.theirTeamBans || [])].filter(x => x > 0);
    const actionBans = actions.filter(a => a.type === 'ban' && a.completed && a.championId > 0).map(a => a.championId);
    // Bans per team, 5 slots each (null = not banned yet or skipped), like u.gg's bar.
    const myCells = new Set(s.myTeam.map(p => p.cellId));
    const side = mine => {
      const fromActions = actions.filter(a => a.type === 'ban' && myCells.has(a.actorCellId) === mine).map(a => (a.completed && a.championId > 0 ? a.championId : 0));
      const fromBans = (mine ? bans.myTeamBans : bans.theirTeamBans) || [];
      const ids = fromBans.length ? fromBans.map(x => (x > 0 ? x : 0)) : fromActions;
      return Array.from({ length: 5 }, (_, i) => ids[i] || 0);
    };
    const banSides = { mine: side(true), theirs: side(false) };
    if (entered) this.send({ type: 'cs-start', position: mine.position });
    // Estimated roles: allies without an assigned role (blind pick) and the whole enemy team.
    const allyGuess = this.estimateRoles(allies.filter(a => !a.position && a.champ).map(a => a.champ.id), allies.map(a => POS[a.position]).filter(Boolean));
    for (const a of allies) if (!a.position && a.champ && allyGuess[a.champ.id]) { a.guess = allyGuess[a.champ.id].position; a.sure = allyGuess[a.champ.id].sure; }
    const enemyGuess = this.estimateRoles(enemies.map(e => e.id));
    for (const e of enemies) if (enemyGuess[e.id]) { e.guess = enemyGuess[e.id].position; e.sure = enemyGuess[e.id].sure; }
    // No assigned role (blind pick, normals): use your champion's estimated role, or its main lane.
    let myPos = mine.position || mine.guess || '';
    if (myPos) this.lastMyPos = myPos;
    if (!myPos && mine.champ) myPos = this.mainLaneOf(mine.champ.id);
    const myChamp = mine.champ ? mine.champ.id : 0;
    if (myChamp !== this.csChamp || myPos !== this.csPos) {
      if (myChamp !== this.csChamp) this.csRunes = null;
      this.csChamp = myChamp;
      this.csPos = myPos;
      this.csOpgg = null;
      this.csOpggFailed = false;
      if (myChamp) { if (!this.csRunes) this.loadRecommendedRunes(myChamp, myPos); this.loadAnalysis(myChamp, myPos); }
    }
    const opponent = myPos ? enemies.find(e => e.guess === myPos) || null : null;
    if (opponent) this.loadOpponent(opponent.id, myPos);
    // Lane opponent is clear (they picked a champion that mostly plays your lane): look up how
    // the likely picks do against them, head to head.
    const clearOpp = opponent && opponent.sure ? opponent : null;
    if (clearOpp && !mine.locked) {
      this.loadCounterPicks(clearOpp, myPos, allies, enemies);
      if (this.counterPeekFor !== clearOpp.id) { this.counterPeekFor = clearOpp.id; this.send({ type: 'cs-counter', name: clearOpp.name, role: ({ top: 'Top', jungle: 'Jungle', middle: 'Mid', bottom: 'Bot', utility: 'Support' })[myPos] || '' }); }
    }
    for (const e of enemies) if (e.guess) this.queueAnalysis(e.id, e.guess);
    for (const a of allies) {
      const pos = a.position || a.guess;
      a.winRate = a.champ && pos ? this.laneWinRate(a.champ.id, pos) : 0;
    }
    for (const e of enemies) e.winRate = e.guess ? this.laneWinRate(e.id, e.guess) : 0;
    this.cs = {
      position: mine.position || '', timeLeft: Math.max(0, Math.round(timer.adjustedTimeLeftInPhase || 0)), timerPhase: timer.phase || '',
      at: Date.now(), me: mine.champ ? { ...mine.champ, locked: mine.locked, stats: this.statsFor(mine.champ.id) } : null,
      allies, enemies, bans: [...new Set([...banList, ...actionBans])].map(id => this.champ(id)),
      runes: this.csRunes, ideas: this.topChamps(mine.position || '', 4),
      opgg: this.opggView(this.csOpgg), meta: mine.position ? this.metaFor(mine.position, 5) : [],
      myPos, opponent: opponent && { ...opponent }, clearOpp: clearOpp && { id: clearOpp.id, name: clearOpp.name }, picks: [], banSides, stage, enemyRows, opggFailed: !!this.csOpggFailed,
    };
    this.csUnavailable = new Set([...this.cs.bans.filter(Boolean).map(b => b.id), ...enemies.map(e => e.id), ...allies.filter(a => a.champ && !a.me).map(a => a.champ.id)]);
    this.refreshPicks();
    this.loadIcons([...allies.map(a => a.champ && a.champ.key), ...enemies.map(e => e.key), ...this.cs.bans.map(b => b && b.key), ...this.cs.ideas.map(i => i.key), ...this.cs.meta.map(m => m.key), ...this.cs.picks.map(m => m.key), ...(this.cs.banList || []).map(m => m.key), ...(this.cs.laneTop || []).map(m => m.key), ...allies.flatMap(a => (a.spells || []).map(x => 'spell:' + x))].filter(Boolean));
  }
  // Is this champion really played in this lane (OP.GG play rates)? Unknown champions pass.
  playsLane(id, lane) {
    const r = this.roleRates && this.roleRates[id];
    if (!r || !lane) return true;
    const max = Math.max(...Object.values(r), 0);
    return (r[lane] || 0) >= Math.max(0.05, max * 0.15);
  }
  mainLaneOf(id) {
    const r = (this.roleRates && this.roleRates[id]) || {};
    const best = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
    return best ? OUR_POS[best[0]] : '';
  }
  // Head-to-head win rates (OP.GG lane matchups) for the picks worth considering against your
  // lane opponent: champions known to beat them, your own champions in this role and the patch's best.
  loadCounterPicks(opp, myPos, allies, enemies) {
    const lane = POS[myPos];
    if (!lane) return;
    const key = `${opp.id}:${lane}`;
    const taken = new Set([...allies.filter(a => a.champ && !a.me).map(a => a.champ.id), ...enemies.map(e => e.id)]);
    const known = this.analysis.get(`${opp.id}:${lane}`);
    const cands = [
      ...((known && known.data && known.data.counters) || []).map(c => c.id).filter(id => this.playsLane(id, lane)),
      ...this.topChamps(myPos, 6).map(c => c.id),
      ...((this.meta && this.meta[lane]) || []).slice(0, 10).map(m => m.id),
    ].filter(id => id && !taken.has(id));
    const todo = [...new Set(cands)].slice(0, 16).filter(id => !this.matchups.has(`${id}:${opp.id}:${lane}`));
    if (!todo.length) { if (this.counterKey !== key) { this.counterKey = key; this.refreshPicks(); } return; }
    this.counterKey = key;
    for (const id of todo) this.matchups.set(`${id}:${opp.id}:${lane}`, undefined);   // pending
    const run = async id => {
      const k = `${id}:${opp.id}:${lane}`;
      const me = this.champs[id], them = this.champs[opp.id];
      let res = null;
      if (me && them) {
        const mine = this.opggNames.has(id) ? [this.opggNames.get(id)] : nameCandidates(me.name, me.key);
        const theirs = this.opggNames.has(opp.id) ? [this.opggNames.get(opp.id)] : nameCandidates(them.name, them.key);
        for (const a of mine) {
          let ok = false;
          for (const b of theirs) {
            try {
              const out = await this.opgg.call('lol_get_lane_matchup_guide', { position: lane, my_champion: a, opponent_champion: b, lang: 'en_US' });
              this.opggNames.set(id, a); this.opggNames.set(opp.id, b); ok = true;
              res = findWinRate(out);
              if (!this.matchupSampled) {
                this.matchupSampled = true;
                try { fs.writeFileSync(path.join(this.cacheDir, 'opgg-matchup-sample.json'), JSON.stringify({ at: new Date().toISOString(), args: { a, b, lane }, found: res, text: String((out && out.__text) || '').slice(0, 20000) }, null, 1)); } catch { /* ignore */ }
              }
              break;
            } catch (e) { if (!/champion|not found|invalid/i.test(e.message)) { this.log(`opgg matchup ${me.name} vs ${them.name}: ${e.message}`); ok = true; break; } }
          }
          if (ok) break;
        }
      }
      this.matchups.set(k, res);
      if (this.cs) { this.refreshPicks(); this.emit(); }
    };
    const queue = todo.slice();
    for (let w = 0; w < 3; w++) (async () => { while (queue.length) await run(queue.shift()); })();
    this.refreshPicks();
  }

  gameBuild() {
    const m = this.game && this.game.mine;
    if (!m) return null;
    if (!m.champId || !m.mode) return { unsupported: true, gm: m.gm || '', mapNo: m.mapNo || 0, champ: m.champId ? this.champ(m.champId) : null };
    const lane = m.mode !== 'ranked' ? 'none' : (POS[m.pos] || 'none');
    const hit = this.analysis.get(m.mode === 'ranked' ? `${m.champId}:${lane}` : `${m.champId}:${lane}:${m.mode}`);
    const champ = this.champ(m.champId);
    if (!hit) return { loading: true, champ, pos: m.pos, mode: m.mode };
    const a = hit.data;
    if (!a) return { failed: true, champ, pos: m.pos, mode: m.mode };
    const want = [...a.core, ...a.later];
    const icons = [...a.starter, ...a.boots, ...want].map(i => 'item:' + i);
    if (a.runes) icons.push('rune:' + a.runes.keystoneId, 'rune:' + a.runes.secondary);
    if (icons.some(k => !this.icons.has(k))) this.loadIcons(icons);
    if (!this.itemNames && !this.itemNamesLoading && this.ddVersion) {
      this.itemNamesLoading = true;
      this.ddJson('item.json').then(d => { this.itemNames = Object.fromEntries(Object.entries((d && d.data) || {}).map(([k, v]) => [k, v.name])); this.emit(); }).catch(() => { this.itemNamesLoading = false; });
    }
    const nm = this.itemNames || {};
    return {
      names: Object.fromEntries([...a.starter, ...a.boots, ...a.core, ...a.later].map(i => [i, nm[i] || ''])),
      champ, pos: m.pos, mode: m.mode, level: m.level, owned: m.items,
      starter: a.starter, boots: a.boots, core: a.core, later: a.later, skills: a.skills, maxOrder: a.maxOrder,
      situational: this.situational(m, [...a.core, ...a.later, ...a.boots]),
      runes: a.runes && { keystone: a.runes.keystone, keystoneId: a.runes.keystoneId, primaryName: a.runes.primaryName, secondaryName: a.runes.secondaryName, secondary: a.runes.secondary },
      winRate: a.winRate, tier: a.tier,
    };
  }

  // Situational items against the enemy team: anti-heal vs healers, magic resist vs mostly magic
  // damage, armor vs mostly physical, penetration vs tanks, safety vs assassins; picked for your
  // kind of champion and checked against Riot's item list.
  situational(m, inBuild) {
    if (!this.game || !this.champs || !this.itemData) { this.loadItemData(); return []; }
    const meP = (this.game.players || []).find(p => p.me);
    if (!meP) return [];
    const byKey = {};
    for (const [id, c] of Object.entries(this.champs)) byKey[c.key] = { ...c, id: +id };
    const enemies = this.game.players.filter(p => p.team !== meP.team).map(p => byKey[p.champKey]).filter(Boolean);
    if (!enemies.length) return [];
    const me = this.champs[m.champId] || {};
    const tags = me.tags || [], info = me.info || {};
    const cls = tags.includes('Marksman') ? 'adc'
      : tags[0] === 'Tank' || (tags.includes('Tank') && tags.includes('Support')) ? 'tank'
      : (info.magic || 0) > (info.attack || 0) ? 'ap'
      : tags[0] === 'Assassin' ? 'assassin' : tags[0] === 'Support' ? 'ap' : 'fighter';
    const ap = enemies.filter(e => (e.tags || []).includes('Mage') || (e.info && e.info.magic > e.info.attack));
    const ad = enemies.filter(e => !ap.includes(e));
    const tanks = enemies.filter(e => (e.tags || [])[0] === 'Tank' || ((e.tags || []).includes('Tank') && (e.info || {}).defense >= 7));
    const assassins = enemies.filter(e => (e.tags || [])[0] === 'Assassin');
    const HEAL = new Set(['Aatrox', 'Soraka', 'Yuumi', 'Sona', 'Nami', 'DrMundo', 'Vladimir', 'Sylas', 'Swain', 'Warwick', 'Fiddlesticks', 'Briar', 'Olaf', 'Volibear', 'Illaoi', 'Trundle', 'Zac', 'Milio', 'Gwen', 'Nasus', 'Belveth', 'Viego', 'Senna', 'Seraphine', 'Renata', 'Taric', 'Maokai', 'Kayn', 'Irelia', 'Udyr', 'Samira', 'Yorick', 'Mordekaiser', 'Fizz']);
    const healers = enemies.filter(e => HEAL.has(e.key));
    const names = list => list.slice(0, 3).map(e => e.name).join(', ');
    const pick = { // per kind of champion: [anti-heal, vs magic, vs physical, vs tanks, vs assassins]
      adc: [3033, 3091, 3026, 3036, 3026], fighter: [6609, 3065, 6333, 3071, 6053], assassin: [6609, 3156, 6333, 6694, 3026],
      ap: [3165, 3102, 3157, 3135, 3157], tank: [3075, 4401, 3143, null, null],
    }[cls];
    const out = [];
    const add = (id, why, tag, vs) => {
      if (!id || out.some(o => o.id === id)) return;
      const it = this.itemData[id];
      if (!it || (it.gold && it.gold.purchasable === false) || (it.maps && it.maps[m.mode === 'aram' ? '12' : '11'] === false)) return;
      out.push({ id, why, tag, vs: (vs || []).map(e => e.key), inBuild: inBuild.includes(id) });
    };
    if (healers.length >= (cls === 'tank' ? 2 : 1)) add(pick[0], `Anti-heal · ${names(healers)}`, 'Anti-heal', healers);
    if (ap.length >= 3) add(pick[1], `${ap.length} magic damage · ${names(ap)}`, 'Magic resist', ap);
    if (ad.length >= 4) add(pick[2], `${ad.length} physical damage`, 'Armor', ad);
    if (tanks.length >= 2 && pick[3]) add(pick[3], `Tanks · ${names(tanks)}`, 'Vs tanks', tanks);
    if (assassins.length >= 2 && pick[4]) add(pick[4], `Assassins · ${names(assassins)}`, 'Safety', assassins);
    if (cls !== 'adc' && cls !== 'ap') add(ap.length >= 3 ? 3111 : ad.length >= 4 ? 3047 : null, ap.length >= 3 ? 'Boots vs magic and crowd control' : 'Boots vs physical damage', 'Boots', ap.length >= 3 ? ap : ad);
    const icons = out.map(o => 'item:' + o.id).filter(k => !this.icons.has(k));
    if (icons.length) this.loadIcons(icons);
    return out.slice(0, 4).map(o => ({ ...o, name: (this.itemData[o.id] || {}).name || '' }));
  }
  loadItemData() {
    if (this.itemData || this.itemDataLoading || !this.ddVersion) return;
    this.itemDataLoading = true;
    this.ddJson('item.json').then(d => { this.itemData = (d && d.data) || {}; this.itemNames = Object.fromEntries(Object.entries(this.itemData).map(([k, v]) => [k, v.name])); this.emit(); })
      .catch(() => { this.itemDataLoading = false; });
  }

  laneWinRate(id, position) {
    const m = ((this.meta && this.meta[POS[position]]) || []).find(x => x.id === id);
    return m ? m.winRate : 0;
  }
  // Champions that beat an enemy pick (OP.GG), loaded one at a time in the background.
  queueAnalysis(id, position) {
    const key = `${id}:${POS[position]}`;
    this.aQueued = this.aQueued || new Set();
    if (this.aQueued.has(key)) return;
    this.aQueued.add(key);
    this.aChain = (this.aChain || Promise.resolve()).then(() => this.loadAnalysis(id, position, true)).then(() => { if (this.cs) this.emit(); }).catch(() => {});
  }
  countersOf(id, position) {
    const a = this.analysis.get(`${id}:${POS[position]}`);
    const myLane = this.cs && POS[this.cs.myPos];
    return ((a && a.data && a.data.counters) || []).filter(c => this.playsLane(c.id, myLane)).slice(0, 3).map(c => ({ ...this.champ(c.id), ...(this.champs && this.champs[c.id] ? {} : { name: c.name }), winRate: 1 - c.winRate }));
  }
  refreshPicks() {
    if (!this.cs) return;
    this.cs.picks = this.suggestPicks(this.cs.myPos, this.cs.opponent, this.csUnavailable || new Set());
    const opp = this.cs.clearOpp, cl = POS[this.cs.myPos];
    if (opp && cl) {
      const pool = new Map(this.topChamps(this.cs.myPos, 10).filter(c => c.stats).map(c => [c.id, c.stats]));
      const rows = [], unav = this.csUnavailable || new Set();
      let pending = 0;
      for (const [k, v] of this.matchups) {
        const [id, oid, l] = k.split(':');
        if (+oid !== opp.id || l !== cl) continue;
        if (v === undefined) { pending++; continue; }
        if (!v || unav.has(+id)) continue;
        const st = pool.get(+id);
        rows.push({ ...this.champ(+id), winRate: v.winRate, games: v.games, mine: st ? `you ${Math.round(100 * st.wins / st.games)}% · ${st.games}g` : '' });
      }
      rows.sort((a, b) => b.winRate - a.winRate);
      this.cs.counterPicks = rows.slice(0, 10);
      this.cs.counterPending = pending;
      this.loadIcons(this.cs.counterPicks.map(c => c.key).filter(Boolean));
    } else { this.cs.counterPicks = []; this.cs.counterPending = 0; }
    const lane = POS[this.cs.myPos];
    const list = (this.meta && this.meta[lane]) || [];
    this.cs.banList = list.slice().sort((a, b) => b.banRate - a.banRate).slice(0, 10).map(m => ({ ...this.champ(m.id), banRate: m.banRate, winRate: m.winRate, games: m.play, banned: (this.csUnavailable || new Set()).has(m.id) }));
    this.cs.laneTop = list.slice(0, 10).map(m => ({ ...this.champ(m.id), winRate: m.winRate, tier: m.tier, games: m.play, taken: (this.csUnavailable || new Set()).has(m.id) }));
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
        keystone: keystone.name || '', keystoneId: keystone.id || (perks[0] || {}).id || 0, perkIds: perks.map(x => x.id).filter(Boolean),
        names: perks.map(x => x.name).filter(Boolean),
        spells: (p.summonerSpellIds || []).filter(x => x > 0),
      };
      const r = this.csRunes;
      if (this.cs) { this.cs.runes = r; this.emit(); }
      // the full trees and pictures, like for OP.GG's page
      this.loadIcons(['rune:' + r.primary, 'rune:' + r.secondary, ...r.perkIds.slice(0, 6).map(x => 'rune:' + x), ...r.spells.map(x => 'spell:' + x)]);
      this.attachRuneTree(r).then(() => { if (this.cs && this.csRunes === r) { this.cs.runes = { ...r }; this.emit(); } });
    } catch (e) { this.log('league runes: ' + e.message); }
  }

  // Create (or update) a rune page named "WALL-E: <champion>" and make it current.
  // OP.GG's most played page (all 9 choices) is used when it's there, else Riot's recommendation.
  // Import runes (and summoner spells) from the source you picked: 'opgg' or 'riot' (the League client's own).
  async importRunes(source) {
    const o = this.csOpgg && this.csOpgg.runes;
    const useOpgg = source !== 'riot' && o && o.perkIds.length === 9;
    const r = useOpgg ? o : (this.csRunes || (o && o.perkIds.length === 9 ? o : null));
    const riotSpells = (this.csRunes && this.csRunes.spells) || [];
    const spells = useOpgg ? (this.csOpgg.spells || []) : (riotSpells.length === 2 ? riotSpells : ((this.csOpgg && this.csOpgg.spells) || []));
    const spellsDone = await this.importSpells(spells);
    const me = this.cs && this.cs.me;
    if (!r || !me || r.perkIds.length < 6) return { ok: false, error: 'No recommended runes yet' };
    const body = { name: `WALL-E: ${me.name}`, primaryStyleId: r.primary, subStyleId: r.secondary, selectedPerkIds: r.perkIds, current: true };
    try {
      const pages = (await this.lcuGet('/lol-perks/v1/pages')) || [];
      const ours = pages.find(p => /^(Notch|WALL-E):/.test(p.name || '') && p.isEditable);
      if (ours) await this.lcuSend('DELETE', `/lol-perks/v1/pages/${ours.id}`);
      try { await this.lcuSend('POST', '/lol-perks/v1/pages', body); } catch (e) {
        if (!/max pages|400/i.test(e.message)) throw e;
        // Every rune page is in use: replace the page that's selected now (as u.gg and Porofessor do).
        const cur = (pages.find(p => p.current && p.isEditable)) || pages.find(p => p.isEditable);
        if (!cur) throw e;
        await this.lcuSend('DELETE', `/lol-perks/v1/pages/${cur.id}`);
        await this.lcuSend('POST', '/lol-perks/v1/pages', body);
        return { ok: true, source: r === o ? 'OP.GG' : 'League client', replaced: cur.name || '', spells: spellsDone };
      }
      return { ok: true, source: r === o ? 'OP.GG' : 'League client', spells: spellsDone };
    } catch (e) {
      this.log('league import runes: ' + e.message);
      return { ok: false, error: /400|limit|max/i.test(e.message) ? 'All rune pages are in use: delete one in the client first' : 'Could not create the rune page' };
    }
  }

  // Pick the two summoner spells in champ select. Flash stays on the key you already have it on.
  async importSpells(ids) {
    ids = (ids || []).filter(x => x > 0).slice(0, 2);
    if (ids.length !== 2) return false;
    try {
      const s = await this.lcuGet('/lol-champ-select/v1/session').catch(() => null);
      const me = s && (s.myTeam || []).find(p => p.cellId === s.localPlayerCellId);
      let [a, b] = ids;
      if (me && (me.spell1Id === b || me.spell2Id === a)) [a, b] = [b, a];   // keep each spell on the key it's on now
      await this.lcuSend('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: a, spell2Id: b });
      return true;
    } catch (e) { this.log('league import spells: ' + e.message); return false; }
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

  // ---------------------------------------------------------------- OP.GG open data
  // Lane tier lists (like the ones on OP.GG, u.gg or Mobalytics) and, in champ select, counters,
  // items, skill order and runes for your champion. Free and keyless; see opgg.js.
  async loadMeta() {
    if (this.metaLoading || Date.now() - this.metaAt < (this.meta ? META_TTL : 10 * 60 * 1000)) {
      // Tier list read from disk: make sure its pictures load too.
      if (this.meta && !this.metaIconsAsked && this.champs) {
        this.metaIconsAsked = true;
        this.loadIcons(Object.values(this.meta).flatMap(l => l.slice(0, 12)).map(x => (this.champs[x.id] || {}).key).filter(Boolean));
      } else if (this.meta && !this.champs) this.loadChampions();
      return;
    }
    this.metaLoading = true;
    this.metaAt = Date.now();          // also the retry delay when it fails
    try {
      await this.loadChampions();
      let out;
      try { out = await this.opgg.call('lol_list_lane_meta_champions', { position: 'all', lang: 'en_US', desired_output_fields: ['data'] }); } catch (e) {
        const f = '{ban_rate,champion,is_rip,kda,pick_rate,play,rank,role_rate,tier,win_rate}';
        out = await this.opgg.call('lol_list_lane_meta_champions', { position: 'all', lang: 'en_US', desired_output_fields: ['top', 'jungle', 'mid', 'adc', 'support'].map(p => `data.positions.${p}[].${f}`) });
      }
      const positions = (out && out.data && out.data.positions) || (out && out.positions) || {};
      const lanes = {}, roles = {};
      for (const [lane, list] of Object.entries(positions)) {
        if (!Array.isArray(list)) continue;
        // How often each champion is played in this lane, for guessing roles in champ select.
        for (const x of list) {
          const cid = x && this.champIdOf(x.champion !== undefined ? x.champion : (x.champion_id || x.champion_name));
          if (!cid) continue;
          const rate = x.role_rate != null ? +x.role_rate : (+x.pick_rate || 0.01);
          (roles[cid] = roles[cid] || {})[lane] = x.is_rip ? rate * 0.3 : rate;
        }
        lanes[lane] = list.filter(x => x && !x.is_rip).map(x => ({
          id: this.champIdOf(x.champion !== undefined ? x.champion : (x.champion_id || x.champion_name)),
          tier: +x.tier || 0, rank: +x.rank || 0, winRate: +x.win_rate || 0, pickRate: +x.pick_rate || 0, banRate: +x.ban_rate || 0,
          prev: +x.rank_prev || 0, play: +x.play || 0,
        })).filter(x => x.id).sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.tier - b.tier || b.winRate - a.winRate).slice(0, 80);
      }
      if (!Object.keys(lanes).length) throw new Error('no lanes in answer');
      this.meta = lanes;
      this.roleRates = roles;
      try { fs.writeFileSync(path.join(this.cacheDir, 'opgg-meta.json'), JSON.stringify({ v: 2, at: this.metaAt, lanes, roles })); } catch { /* ignore */ }
      this.log(`opgg meta: ${Object.entries(lanes).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    } catch (e) { this.log('opgg meta: ' + e.message); }
    finally { this.metaLoading = false; }
    if (this.meta) { this.metaIconsAsked = true; this.loadIcons(Object.values(this.meta).flatMap(l => l.slice(0, 12)).map(x => (this.champs[x.id] || {}).key).filter(Boolean)); }
    this.emit();
  }

  // OP.GG may name a champion by id, by name or by an object; find our id.
  champIdOf(v) {
    if (v && typeof v === 'object') return this.champIdOf(v.id || v.champion_id || v.key || v.name);
    if (typeof v === 'number' || /^\d+$/.test(String(v))) return +v;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const want = norm(v);
    if (!want || !this.champs) return 0;
    for (const [id, c] of Object.entries(this.champs)) if (norm(c.name) === want || norm(c.key) === want) return +id;
    const alias = { monkeyking: 'wukong', nunu: 'nunuwillump', renata: 'renataglasc' }[want];
    if (alias) for (const [id, c] of Object.entries(this.champs)) if (norm(c.name) === alias) return +id;
    return 0;
  }

  // Guess which lane each champion plays: try every way to spread them over the free lanes
  // and keep the one where the champions are most often played in those lanes (OP.GG play rates).
  estimateRoles(ids, taken = []) {
    const lanes = ['top', 'jungle', 'mid', 'adc', 'support'].filter(l => !taken.includes(l));
    const list = ids.filter(Boolean).slice(0, lanes.length);
    if (!list.length || !this.roleRates) return {};
    const rate = (id, l) => Math.max(0.005, ((this.roleRates[id] || {})[l]) || 0);
    let best = null, bestScore = -Infinity;
    const walk = (i, used, pick, score) => {
      if (i === list.length) { if (score > bestScore) { bestScore = score; best = pick.slice(); } return; }
      for (const l of lanes) if (!used.has(l)) { used.add(l); pick.push(l); walk(i + 1, used, pick, score + Math.log(rate(list[i], l))); pick.pop(); used.delete(l); }
    };
    walk(0, new Set(), [], 0);
    const out = {};
    list.forEach((id, i) => {
      const l = best[i], r = rate(id, l);
      const total = Object.values(this.roleRates[id] || {}).reduce((a, b) => a + b, 0) || r;
      out[id] = { lane: l, position: OUR_POS[l], sure: r / total >= 0.7 };
    });
    return out;
  }

  // Pick suggestions for your lane: champions that beat your likely lane opponent, then your own
  // good champions in this role, then the strongest picks of the patch.
  suggestPicks(position, opponent, unavailable) {
    const lane = POS[position];
    if (!lane) return [];
    const out = new Map();
    const names = {};
    const add = (id, why, score, name) => {
      if (!id || unavailable.has(id)) return;
      if (name) names[id] = name;
      const cur = out.get(id);
      if (cur) { cur.why.push(why); cur.score += score; } else out.set(id, { id, why: [why], score });
    };
    const mine = new Map(this.topChamps(position, 8).filter(c => c.stats).map(c => [c.id, c.stats]));
    const vs = opponent && this.analysis.get(`${opponent.id}:${lane}`);
    for (const c of ((vs && vs.data && vs.data.counters) || []).filter(c => this.playsLane(c.id, lane))) add(c.id, `beats ${opponent.name} ${Math.round(100 * (1 - c.winRate))}%`, 3 + (1 - c.winRate - 0.5) * 20, c.name);
    for (const [id, st] of mine) {
      const w = st.wins / st.games;
      if (st.games >= 2 && w >= 0.45) add(id, `you ${Math.round(100 * w)}% · ${st.games}g`, 1.5 + w + Math.min(st.games, 10) / 10);
    }
    if (opponent) for (const [k, v] of this.matchups) {
      const [id, oid, l] = k.split(':');
      if (v && +oid === opponent.id && l === lane && v.winRate >= 0.5) add(+id, `${Math.round(100 * v.winRate)}% vs ${opponent.name}`, 2 + (v.winRate - 0.5) * 30);
    }
    for (const m of ((this.meta && this.meta[lane]) || []).slice(0, 8)) add(m.id, `${['', 'OP', 'Strong', 'Good', 'Average', 'Weak'][m.tier] || 'Meta'} tier`, (6 - (m.tier || 5)) * 0.6);
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 5).map(x => {
      const meta = ((this.meta && this.meta[lane]) || []).find(m => m.id === x.id);
      return { ...this.champ(x.id), ...(this.champs && this.champs[x.id] ? {} : { name: names[x.id] || `#${x.id}` }), why: x.why.slice(0, 2).join(' · '), tier: meta ? meta.tier : 0, mine: mine.has(x.id) };
    });
  }

  // Counters and builds for the enemy who is probably in your lane (for counter-pick ideas).
  async loadOpponent(champId, position) {
    const key = `${champId}:${POS[position]}`;
    if (this.oppKey === key) return;
    this.oppKey = key;
    await this.loadAnalysis(champId, position, true);
    if (this.cs) { this.refreshPicks(); this.emit(); }
  }

  metaFor(position, n) {
    const lane = POS[position] || position;
    return ((this.meta && this.meta[lane]) || []).slice(0, n).map(x => ({ ...this.champ(x.id), tier: x.tier, rank: x.rank, prev: x.prev, winRate: x.winRate, pickRate: x.pickRate, banRate: x.banRate }));
  }

  // Counters, build, skills and runes for one champion in one lane.
  async loadAnalysis(champId, position, cacheOnly = false, gameMode = 'ranked') {
    const lane = gameMode !== 'ranked' ? 'none' : (POS[position] || 'none');
    const id = gameMode === 'ranked' ? `${champId}:${lane}` : `${champId}:${lane}:${gameMode}`;
    const hit = this.analysis.get(id);
    if (hit && Date.now() - hit.at < META_TTL) { if (!cacheOnly) this.useAnalysis(champId, hit.data); return; }
    const c = this.champs && this.champs[champId];
    if (!c) return;
    const names = this.opggNames.has(champId) ? [this.opggNames.get(champId)] : nameCandidates(c.name, c.key);
    let data = null, lastErr = null;
    // ARAM/URF have no lanes, but OP.GG only takes some position values there: try them in turn
    // (and remember the one that works).
    this.modePos = this.modePos || {};
    const positions = gameMode === 'ranked' ? [lane]
      : [...new Set([this.modePos[gameMode], 'all', 'none', POS[this.mainLaneOf(champId)], 'mid', 'adc', 'top', 'jungle', 'support'].filter(Boolean))];
    outer: for (const pos of positions) {
      for (const name of names) {
        try {
          const out = await this.opgg.call('lol_get_champion_analysis', { champion: name, position: pos, game_mode: gameMode, lang: 'en_US', desired_output_fields: ['data'] });
          const d = out && (out.data || out);
          if (d && (d.summary || d.core_items || d.runes)) { data = d; this.opggNames.set(champId, name); if (gameMode !== 'ranked') this.modePos[gameMode] = pos; break outer; }
        } catch (e) {
          lastErr = e;
          if (/position/i.test(e.message)) continue outer;   // this position isn't accepted: next one
        }
      }
    }
    if (!data) {
      this.log(`opgg ${c.name}/${lane}: ${lastErr ? lastErr.message : 'no data'}`);
      if (!cacheOnly && this.csChamp === champId) { this.csOpggFailed = true; if (this.cs) { this.cs.opggFailed = true; this.emit(); } }       this.analysis.set(id, { at: Date.now() - META_TTL + 2 * 60 * 1000, data: null });
      return;
    }
    const avg = (data.summary && data.summary.average_stats) || {};
    const lanePos = ((data.summary && data.summary.positions) || []).find(p => String(p.name || '').toLowerCase() === lane) || null;
    const ls = (lanePos && lanePos.stats) || {};
    const ids = x => ((x && x.ids) || []).filter(v => typeof v === 'number');
    const counter = x => ({ id: x.champion_id, name: x.champion_name || '', winRate: +x.my_win_rate || (x.win_rate ? 1 - x.win_rate : 0), games: x.play || 0 });
    const r = data.runes || {};
    const a = {
      lane,
      tier: avg.tier || (ls.tier_data && ls.tier_data.tier) || 0,
      rank: avg.rank || (ls.tier_data && ls.tier_data.rank) || 0,
      winRate: ls.win_rate || avg.win_rate || 0, pickRate: ls.pick_rate || avg.pick_rate || 0, banRate: ls.ban_rate || avg.ban_rate || 0,
      games: ls.play || avg.play || 0,
      // counters in this lane (OP.GG's per-position list, where win = this champion's wins), then the general ones
      counters: (() => {
        const laneC = ((lanePos && lanePos.counters) || []).filter(x => x && x.champion_id && x.play).map(x => ({ id: x.champion_id, name: x.champion_name || '', winRate: x.win / x.play, games: x.play }));
        const seen = new Set(laneC.map(x => x.id));
        return [...laneC, ...(data.weak_counters || []).filter(x => x && x.champion_id && !seen.has(x.champion_id)).map(counter)].slice(0, 8);
      })(),
      goodVs: (data.strong_counters || []).filter(x => x && x.champion_id).map(counter).slice(0, 8),
      starter: ids(data.starter_items), boots: ids(data.boots), core: ids(data.core_items),
      // late items: the most picked 4th, 5th and 6th item (skipping ones already in the core)
      later: [data.fourth_items, data.fifth_items, data.sixth_items].reduce((acc, l) => {
        const pick = (Array.isArray(l) ? l : []).map(ids).flat().find(x => !ids(data.core_items).includes(x) && !acc.includes(x));
        return pick ? [...acc, pick] : acc;
      }, []),
      spells: ids(data.summoner_spells),
      skills: ((data.skills && data.skills.order) || []).slice(0, 15),
      maxOrder: ((data.skill_masteries && data.skill_masteries.ids) || []).filter(x => typeof x === 'string'),
      runes: r.primary_page_id ? {
        primary: r.primary_page_id, secondary: r.secondary_page_id, primaryName: r.primary_page_name || '', secondaryName: r.secondary_page_name || '',
        keystone: (r.primary_rune_names || [])[0] || '', keystoneId: (r.primary_rune_ids || [])[0] || 0,
        perkIds: [...(r.primary_rune_ids || []), ...(r.secondary_rune_ids || []), ...(r.stat_mod_ids || [])].filter(x => typeof x === 'number'),
        names: [...(r.primary_rune_names || []), ...(r.secondary_rune_names || [])].filter(x => typeof x === 'string'),
        winRate: r.play ? r.win / r.play : 0,
      } : null,
    };
    this.analysis.set(id, { at: Date.now(), data: a });
    if (!cacheOnly) this.useAnalysis(champId, a);
    else this.loadIcons(a.counters.map(x => (this.champs[x.id] || {}).key).filter(Boolean));
  }

  useAnalysis(champId, a) {
    if (!a || this.csChamp !== champId) return;
    this.csOpgg = a;
    const keys = [...a.counters, ...a.goodVs].map(x => (this.champs[x.id] || {}).key).filter(Boolean);
    const r = a.runes;
    this.loadIcons([...keys, ...[...a.starter, ...a.boots, ...a.core].map(i => 'item:' + i), ...a.spells.map(i => 'spell:' + i),
      ...(r ? ['rune:' + r.primary, 'rune:' + r.secondary, ...r.perkIds.slice(0, 6).map(x => 'rune:' + x)] : [])]);
    if (this.cs) { this.cs.opgg = this.opggView(a); this.emit(); }
    if (r && !r.tree) this.attachRuneTree(r).then(() => { if (this.cs && this.csOpgg === a) { this.cs.opgg = this.opggView(a); this.emit(); } });
  }

  // Every row of both rune trees (Riot's runesReforged), so the page can be drawn like the client:
  // all choices, the picked ones lit.
  async attachRuneTree(r) {
    try {
      if (!this.ddVersion) return;
      const d = await this.ddJson('runesReforged.json');
      const style = id => (d || []).find(x => x.id === id);
      const p = style(r.primary), sc = style(r.secondary);
      if (!p || !sc) return;
      const rows = st => (st.slots || []).map(sl => (sl.runes || []).map(x => ({ id: x.id, name: x.name })));
      r.tree = { primary: rows(p), secondary: rows(sc).slice(1) };
      r.shardRows = [[5008, 5005, 5007], [5008, 5010, 5001], [5011, 5013, 5001]];
      this.loadIcons([...r.tree.primary.flat(), ...r.tree.secondary.flat()].map(x => 'rune:' + x.id));
      this.loadShardIcons([...new Set(r.shardRows.flat())]);
    } catch (e) { this.log('rune tree: ' + e.message); }
  }
  // Stat shard icons aren't on Data Dragon: from the client, or CommunityDragon.
  async loadShardIcons(ids) {
    const FILE = { 5008: 'StatModsAdaptiveForceIcon', 5005: 'StatModsAttackSpeedIcon', 5007: 'StatModsCDRScalingIcon', 5010: 'StatModsMovementSpeedIcon', 5001: 'StatModsHealthPlusIcon', 5011: 'StatModsHealthScalingIcon', 5013: 'StatModsTenacityIcon' };
    for (const id of ids) {
      const k = 'shard:' + id;
      if (this.icons.has(k) || !FILE[id]) continue;
      this.icons.set(k, null);
      const dir = path.join(this.cacheDir, 'shards'), file = path.join(dir, `${id}.png`);
      let buf = null;
      try { buf = fs.readFileSync(file); } catch {
        if (this.lcu) buf = await this.lcuBinary(`/lol-game-data/assets/v1/perk-images/StatMods/${FILE[id]}.png`).catch(() => null);
        if (!buf) {
          const res = await this.fetch(`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perk-images/statmods/${FILE[id].toLowerCase()}.png`).catch(() => null);
          if (res && res.ok) buf = Buffer.from(await res.arrayBuffer());
        }
        if (buf) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); } catch { /* ignore */ } }
      }
      if (buf) { this.icons.set(k, 'data:image/png;base64,' + buf.toString('base64')); this.emit(); }
      else this.icons.delete(k);
    }
  }

  opggView(a) {
    if (!a) return null;
    const ch = x => ({ ...this.champ(x.id), ...(this.champs && this.champs[x.id] ? {} : { name: x.name || `#${x.id}` }), winRate: x.winRate, games: x.games });
    const mine = x => this.playsLane(x.id, a.lane);
    return { ...a, counters: a.counters.filter(mine).slice(0, 5).map(ch), goodVs: a.goodVs.filter(mine).slice(0, 5).map(ch) };
  }

  endGame() { this.game = null; this.gameKey = ''; this.gameBuildKey = ''; this.players.clear(); }

  async loadGame() {
    let live;
    try { live = await request(LIVE_PORT, '/liveclientdata/allgamedata', null, 2500); } catch { live = null; }
    if (!live || !Array.isArray(live.allPlayers) || !live.allPlayers.length) return;   // still loading
    await this.loadChampions();
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
    // Your build for this game (OP.GG), with what you already own.
    // Find yourself among the players: the game names players in a few ways (riotId "Name#TAG",
    // riotIdGameName, summonerName), and which ones are filled in varies.
    const norm = x => String(x || '').toLowerCase().replace(/\s+/g, '');
    const ap = live.activePlayer || {};
    const mine = new Set([ap.riotId, ap.summonerName, ap.riotIdGameName, ap.riotIdGameName && ap.riotIdTagLine ? `${ap.riotIdGameName}#${ap.riotIdTagLine}` : '',
      this.me && this.me.name, this.me && this.me.tag ? `${this.me.name}#${this.me.tag}` : ''].filter(Boolean).flatMap(x => [norm(x), norm(String(x).split('#')[0])]));
    const ids = p => [p.riotId, p.summonerName, p.riotIdGameName, p.riotIdGameName && p.riotIdTagLine ? `${p.riotIdGameName}#${p.riotIdTagLine}` : ''].filter(Boolean).map(norm);
    let meP = live.allPlayers.find(p => ids(p).some(x => mine.has(x)));
    if (!meP) meP = live.allPlayers.find(p => ids(p).some(x => mine.has(x.split('#')[0])));
    if (!meP && this.mineWhy !== 'nome') { this.mineWhy = 'nome'; this.log(`league build: you not found among players; you: ${[...mine].join('/') || '-'}; players: ${live.allPlayers.map(p => ids(p)[0] || '?').join(', ')}`); }
    if (meP) {
      await this.loadChampions();
      const key = String(meP.rawChampionName || '').replace(/^game_character_displayname_/, '');
      const cid = this.champIdOf(key || meP.championName);
      const gm = String((live.gameData && live.gameData.gameMode) || '').toUpperCase();
      const mapNo = +((live.gameData && live.gameData.mapNumber) || 0);
      // ARAM by its map (Howling Abyss is map 12), so every ARAM variant (Mayhem…) counts;
      // Summoner's Rift (map 11) uses the ranked builds.
      const mode = mapNo === 12 || /ARAM|KIWI/.test(gm) ? 'aram' : gm === 'URF' || gm === 'ARURF' ? 'urf' : (mapNo === 11 || gm === 'CLASSIC') ? 'ranked' : '';
      let pos = ({ TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', MID: 'middle', BOTTOM: 'bottom', UTILITY: 'utility', SUPPORT: 'utility' })[String(meP.position || '').toUpperCase()] || '';
      if (!pos && mode === 'ranked') pos = (this.cs && this.cs.myPos) || this.lastMyPos || this.mainLaneOf(cid);
      if (!cid || !mode) { const why = `game ${gm || '?'} on map ${mapNo || '?'}, champion ${key || meP.championName || '?'} -> ${cid || 'not found'}`; if (this.mineWhy !== why) { this.mineWhy = why; this.log('league build: ' + why); } }
      this.game.mine = { champId: cid, pos, mode, gm, mapNo, level: (live.activePlayer && live.activePlayer.level) || meP.level || 1, items: (meP.items || []).map(i => i.itemID).filter(Boolean) };
      if (cid && mode) {
        const bk = `${cid}:${pos}:${mode}`;
        const gb = this.gameBuild();
        const retry = gb && gb.failed && Date.now() - (this.gameBuildAt || 0) > 2 * 60 * 1000;
        if (this.gameBuildKey !== bk || retry) {
          this.gameBuildKey = bk; this.gameBuildAt = Date.now();
          if (retry) { const lane = mode !== 'ranked' ? 'none' : (POS[pos] || 'none'); this.analysis.delete(mode === 'ranked' ? `${cid}:${lane}` : `${cid}:${lane}:${mode}`); }
          this.loadAnalysis(cid, pos, true, mode).then(() => this.emit());
        }
      }
    }
    this.game.players = live.allPlayers.map(p => {
      const riotId = p.riotId || (p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagLine}` : p.summonerName) || '';
      const [name, tag] = riotId.split('#');
      // Riot's own key for the picture: look the name up in the champion list (the game's raw name
      // can differ for some champions and skins), else fall back to the raw name.
      const rawKey = String(p.rawChampionName || '').replace(/^game_character_displayname_/, '') || String(p.championName || '').replace(/[^A-Za-z]/g, '');
      const cidKey = this.champs ? this.champIdOf(rawKey) || this.champIdOf(p.championName) : 0;
      const champKey = (cidKey && this.champs[cidKey] && this.champs[cidKey].key) || rawKey;
      const info = this.players.get(riotId);
      return {
        team: p.team === 'CHAOS' ? 'red' : 'blue', champ: p.championName || champKey, champKey,
        icon: this.icons.get(champKey) || null, name: name || p.summonerName || '?', tag: tag || '',
        me: meP ? p === meP : !!meId && (riotId === meId || p.summonerName === meId), bot: !!p.isBot,
        position: p.position || '', ...(info || { loading: !p.isBot }),
      };
    });
    // Look players up a few at a time; each finished lookup shows up right away.
    const todo = this.game.players.filter(p => !p.bot && !this.players.has(`${p.name}#${p.tag}`));
    for (const p of todo) this.players.set(`${p.name}#${p.tag}`, { loading: true });
    // ARAM: no rank lookups (the scoreboard isn't shown there)
    if (!(this.game.mine && this.game.mine.mode === 'aram')) this.lookupAll(todo, queue);
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

  // Pictures from Riot's Data Dragon, cached on disk: champions by key ("Ahri"), and
  // "item:3118", "spell:4" and "rune:8112" for builds.
  async ddJson(file) {
    this.dd = this.dd || {};
    if (!this.dd[file]) this.dd[file] = this.fetch(`https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/data/en_US/${file}`).then(r => r.json()).catch(e => { this.dd[file] = null; throw e; });
    return this.dd[file];
  }
  async iconUrl(k) {
    const v = this.ddVersion;
    const [kind, id] = k.includes(':') ? k.split(':') : ['champion', k];
    if (kind === 'champion') return [`https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${encodeURIComponent(id)}.png`, 'champions', id];
    if (kind === 'item') return [`https://ddragon.leagueoflegends.com/cdn/${v}/img/item/${+id}.png`, 'items', id];
    if (kind === 'spell') {
      const d = await this.ddJson('summoner.json');
      const s = Object.values((d && d.data) || {}).find(x => String(x.key) === String(id));
      return s ? [`https://ddragon.leagueoflegends.com/cdn/${v}/img/spell/${s.image.full}`, 'spells', id] : null;
    }
    if (kind === 'rune') {
      const d = await this.ddJson('runesReforged.json');
      let icon = null;
      for (const st of d || []) {
        if (String(st.id) === id) icon = st.icon;
        for (const sl of st.slots || []) for (const r of sl.runes || []) if (String(r.id) === id) icon = r.icon;
      }
      return icon ? [`https://ddragon.leagueoflegends.com/cdn/img/${icon}`, 'runes', id] : null;
    }
    return null;
  }
  async loadIcons(keys) {
    if (Date.now() < (this.iconRetryAt || 0)) return;
    try {
      if (!this.ddVersion) {
        const v = await (await this.fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
        this.ddVersion = Array.isArray(v) && v[0];
      }
      if (!this.ddVersion) return;
      let any = false;
      this.iconBusy = this.iconBusy || new Set();
      for (const k of [...new Set(keys)].filter(k => k && !/:0$/.test(k) && !this.icons.has(k) && !this.iconBusy.has(k))) {
        this.iconBusy.add(k);
        try {
          const [, folder, name] = k.includes(':') ? [null, { item: 'items', spell: 'spells', rune: 'runes' }[k.split(':')[0]], k.split(':')[1]] : [null, 'champions', k];
          if (!folder) continue;
          const dir = path.join(this.cacheDir, folder);
          const file = path.join(dir, `${name}.png`);
          let buf = null;
          try { buf = fs.readFileSync(file); } catch {
            const u = await this.iconUrl(k);
            if (!u) { this.icons.set(k, null); continue; }
            const res = await this.fetch(u[0]);
            if (res.ok) { buf = Buffer.from(await res.arrayBuffer()); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); }
          }
          if (buf) { this.icons.set(k, 'data:image/png;base64,' + buf.toString('base64')); any = true; }
        } finally { this.iconBusy.delete(k); }
      }
      if (any) { this.refreshRoster(); this.emit(); }
    } catch (e) { this.iconRetryAt = Date.now() + 60 * 1000; this.log('league icons: ' + e.message); }
  }

  // Rank emblems (Iron … Challenger): from the League client itself, or CommunityDragon (which
  // mirrors the client's files) when the client doesn't hand them out. Cut to size and cached.
  async loadTierIcons(tiers) {
    this.tierBusy = this.tierBusy || new Set();
    for (const t of [...new Set(tiers)].filter(t => t && !this.icons.has('tier:' + t) && !this.tierBusy.has(t))) {
      if (Date.now() < ((this.tierRetry || {})[t] || 0)) continue;
      this.tierBusy.add(t);
      try {
        const name = t.toLowerCase();
        const dir = path.join(this.cacheDir, 'tiers');
        const file = path.join(dir, `${name}.png`);
        let buf = null;
        try { buf = fs.readFileSync(file); } catch {
          const p = `/lol-static-assets/images/ranked-emblem/emblem-${name}.png`;
          if (this.lcu) buf = await this.lcuBinary(p).catch(() => null);
          if (!buf) {
            const res = await this.fetch(`https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${name}.png`);
            if (res.ok) buf = Buffer.from(await res.arrayBuffer());
          }
          if (buf && this.trimImage) { try { buf = this.trimImage(buf) || buf; } catch { /* keep the original */ } }
          if (buf) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); }
        }
        if (buf) { this.icons.set('tier:' + t, 'data:image/png;base64,' + buf.toString('base64')); this.emit(); }
        else (this.tierRetry = this.tierRetry || {})[t] = Date.now() + 60 * 1000;
      } catch (e) { (this.tierRetry = this.tierRetry || {})[t] = Date.now() + 60 * 1000; this.log('league emblem: ' + e.message); }
      finally { this.tierBusy.delete(t); }
    }
  }
  lcuBinary(p) {
    return new Promise((resolve, reject) => {
      if (!this.lcu) return reject(new Error('no client'));
      const r = https.request({ host: '127.0.0.1', port: this.lcu.port, path: p, method: 'GET', agent, timeout: 5000, headers: { Authorization: 'Basic ' + Buffer.from('riot:' + this.lcu.token).toString('base64') } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => res.statusCode === 200 && /image/.test(res.headers['content-type'] || 'image') ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`)));
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      r.end();
    });
  }

  emit() {
    // emblems for every rank on screen
    const tiers = [];
    if (this.me) for (const r of [this.me.solo, this.me.flex]) if (r && r.tier) tiers.push(r.tier);
    if (this.game) for (const p of this.game.players || []) if (p.rank && p.rank.tier) tiers.push(p.rank.tier);
    if (tiers.some(t => !this.icons.has('tier:' + t))) this.loadTierIcons(tiers);
    const data = {
      type: 'state', client: !!this.lcu || this.phase === 'InProgress', phase: this.phase, mode: this.mode || '',
      me: this.me && { name: this.me.name, tag: this.me.tag, solo: this.me.solo, flex: this.me.flex },
      cs: this.cs && { ...this.cs, me: this.cs.me && { ...this.cs.me, icon: this.icons.get(this.cs.me.key) || this.cs.me.icon },
        allies: this.cs.allies.map(a => ({ ...a, champ: a.champ && { ...a.champ, icon: this.icons.get(a.champ.key) || null } })),
        enemies: this.cs.enemies.map(e => ({ ...e, icon: this.icons.get(e.key) || null })),
        bans: this.cs.bans.filter(Boolean).map(b => ({ ...b, icon: this.icons.get(b.key) || null })),
        banSides: this.cs.banSides && Object.fromEntries(Object.entries(this.cs.banSides).map(([k, ids]) => [k, ids.map(id => { const c = id ? this.champ(id) : null; return c && { ...c, icon: this.icons.get(c.key) || null }; })])),
        ideas: this.cs.ideas.map(i => ({ ...i, icon: this.icons.get(i.key) || null })),
        picks: (this.cs.picks || []).map(i => ({ ...i, icon: this.icons.get(i.key) || null })),
        counterPicks: (this.cs.counterPicks || []).map(i => ({ ...i, icon: this.icons.get(i.key) || null })),
        enemies: this.cs.enemies.map(e => ({ ...e, icon: this.icons.get(e.key) || null, counters: e.guess ? this.countersOf(e.id, e.guess) : [] })) },
      top: this.history ? this.topChamps('', 6) .map(c => ({ ...c, icon: this.icons.get(c.key) || null })) : [],
      recent: this.history ? this.history.slice().sort((a, b) => b.at - a.at).slice(0, 6).map(g => ({ ...this.champ(g.champ), icon: this.icons.get((this.champ(g.champ) || {}).key) || null, win: g.win, remake: g.remake, k: g.k, d: g.d, a: g.a, lane: g.lane, queue: QUEUES[g.queue] || 'Custom', at: g.at, dur: g.dur })) : [],
      game: this.game && { queue: this.game.queue && this.game.queue.name, time: this.game.time, players: this.game.players, build: this.gameBuild(), aram: !!(this.game.mine && this.game.mine.mode === 'aram') },
      meta: this.meta ? Object.fromEntries(Object.keys(this.meta).map(l => [l, this.metaFor(l, 10).map(({ icon, ...c }) => c)])) : null,
      mainLane: this.mainLane(),
    };
    // Pictures go once; the island keeps them (meta and builds refer to them by key).
    const fresh = {};
    for (const [k, v] of this.icons) if (v && !this.sentIcons.has(k)) fresh[k] = v;
    if (Object.keys(fresh).length) data.icons = fresh;
    const sig = JSON.stringify({ ...data, game: data.game && { ...data.game, time: 0 }, cs: data.cs && { ...data.cs, at: 0, timeLeft: Math.round(data.cs.timeLeft / 5000) } });
    if (sig === this.lastSent) return;
    this.lastSent = sig;
    for (const k of Object.keys(data.icons || {})) this.sentIcons.add(k);
    this.send(data);
  }
}

module.exports = { League, request, rankOf, QUEUES };
