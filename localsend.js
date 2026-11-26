// Nearby sharing: LocalSend (protocol v2) inside the notch.
// Finds phones and PCs that run LocalSend on the same network, receives files from them (always
// after you accept) and sends files to them. Spec: https://github.com/localsend/protocol
//
// Everything stays on the local network. Transfers use HTTPS with a self-signed certificate, like
// the LocalSend apps: that encrypts the data, but doesn't prove who's on the other side, so the
// accept prompt (and the optional PIN) is what keeps strangers out.
//
// No Electron in here (main.js passes in what's needed), so it can be tested with plain Node.
'use strict';

const dgram = require('dgram');
const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MCAST = '224.0.0.167';
const PORT = 53317;
const API = '/api/localsend/v2';
const VERSION = '2.1';

const MAX_JSON = 4 * 1024 * 1024;   // prepare-upload with text previews
const MAX_FILES = 1000;
const MAX_DEPTH = 8;                // folder levels inside one transfer
const ASK_MS = 60 * 1000;           // an unanswered request is declined after a minute
const IDLE_MS = 2 * 60 * 1000;      // a transfer that stops sending data is closed after two minutes
const KEEP_FREE = 500 * 1024 * 1024;
const DEVICE_TTL = 15 * 60 * 1000;
const RATE = { n: 30, ms: 10 * 1000 };   // requests per address (uploads not counted)
const PIN_TRIES = 5, PIN_BLOCK_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- names and paths
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// One folder or file name, safe on Windows: no path parts, no reserved names or characters.
function cleanSegment(s) {
  let x = String(s || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_')
    .replace(/[‪-‮⁦-⁩]/g, '')   // no right-to-left tricks ("txt.exe" shown as "exe.txt")
    .replace(/[. ]+$/, '')
    .trim();
  if (!x || x === '.' || x === '..') return '';
  if (RESERVED.test(x)) x = '_' + x;
  if (x.length > 120) {
    const ext = path.extname(x).slice(0, 16);
    x = x.slice(0, 120 - ext.length) + ext;
  }
  return x;
}

// "folder/sub/file.txt" from the sender → safe parts. "..", drive letters and absolute paths are dropped.
function safeParts(name) {
  const parts = String(name || '').split(/[\\/]+/).map(cleanSegment).filter(Boolean);
  if (!parts.length) return ['file'];
  if (parts.length > MAX_DEPTH) return [...parts.slice(0, MAX_DEPTH - 1), parts[parts.length - 1]];
  return parts;
}

// True only if `p` is inside `dir` (after resolving).
function inside(dir, p) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// "name.ext", "name (1).ext", "name (2).ext"… whichever doesn't exist yet.
function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base} ${crypto.randomUUID()}${ext}`);
}

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.apk': 'application/vnd.android.package-archive',
};
const fileType = n => TYPES[path.extname(n).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------- network
const PRIVATE = ip => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
// Virtual adapters (WSL, Hyper-V, VPNs) aren't where your phone is.
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|tailscale|zerotier|tap|tun|vpn|bluetooth|docker/i;
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && PRIVATE(a.address)) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}
const cleanIp = ip => String(ip || '').replace(/^::ffff:/, '');

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function reply(res, code, body) {
  if (res.headersSent) return;
  if (body === undefined) { res.writeHead(code); res.end(); return; }
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- the module
class Nearby {
  /**
   * opts.dir         where the certificate is kept
   * opts.config()    { alias, receive, publicOk, pin, folder }
   * opts.downloads   default folder for received files
   * opts.send(state) the state for the notch
   * opts.received({ paths, from, text }) after a transfer in (or an accepted message)
   * opts.log(msg)
   * opts.port / opts.mport / opts.discovery  (tests)
   */
  constructor(opts) {
    this.o = opts;
    this.port = opts.port || PORT;
    this.mport = opts.mport || PORT;
    this.discoveryOn = opts.discovery !== false;
    this.log = opts.log || (() => {});
    this.devices = new Map();
    this.network = 'unknown';       // 'private' | 'public' | 'unknown' (from Windows)
    this.status = 'starting';
    this.statusText = '';
    this.request = null;            // an incoming transfer waiting for accept/decline
    this.session = null;            // the incoming transfer in progress
    this.out = null;                // the outgoing transfer in progress
    this.pinFor = null;             // the device that asked for a PIN
    this.pins = new Map();          // PINs you typed for other devices (memory only)
    this.rate = new Map();
    this.pinFails = new Map();
    this.server = null;
    this.udp = null;
    this.lastScan = 0;
    this.scanning = false;
    this.notice = null;             // last result line ("Sent 3 files to …")
  }

  cfg() { return { alias: 'Notch PC', receive: true, publicOk: false, pin: '', folder: '', ...(this.o.config() || {}) }; }
  alias() { return String(this.cfg().alias || '').trim().slice(0, 40) || 'Notch PC'; }
  folder() {
    const f = String(this.cfg().folder || '').trim();
    return f && path.isAbsolute(f) ? f : this.o.downloads;
  }
  // Receiving is off on public networks (café, school, station) unless you allowed it.
  allowed() { return this.network !== 'public' || !!this.cfg().publicOk; }

  info(withPort = true) {
    const i = { alias: this.alias(), version: VERSION, deviceModel: 'Windows', deviceType: 'desktop', fingerprint: this.fingerprint, download: false };
    if (withPort) { i.port = this.port; i.protocol = 'https'; }
    return i;
  }

  // ------------------------------------------------------------ start / stop
  async start() {
    await this.loadCert();
    this.ready = true;
    this.prune = setInterval(() => this.pruneDevices(), 60 * 1000);
    this.idle = setInterval(() => this.checkIdle(), 10 * 1000);
    this.apply();
  }

  stop() {
    clearInterval(this.prune); clearInterval(this.idle); clearTimeout(this.retry);
    this.stopServer(); this.stopDiscovery();
    if (this.session) this.endSession('stopped');
    if (this.out) this.cancelSend();
  }

  // Called when the settings or the network change.
  apply() {
    if (!this.ready) return;   // start() applies once the certificate is there
    const want = this.cfg().receive && this.allowed();
    if (want && !this.server) this.startServer();
    if (!want && this.server) this.stopServer();
    if (!want) {
      this.status = this.cfg().receive ? 'public' : 'off';
      if (this.request) this.decide(false);
    }
    if (this.discoveryOn && this.allowed() && !this.udp) this.startDiscovery();
    if ((!this.allowed() || !this.discoveryOn) && this.udp) this.stopDiscovery();
    this.emit();
  }

  setNetwork(kind) {
    if (kind === this.network) return;
    this.network = kind;
    this.log(`nearby: network is ${kind}`);
    this.apply();
  }

  async loadCert() {
    const file = path.join(this.o.dir, 'nearby-cert.json');
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      const x = new crypto.X509Certificate(c.cert);
      if (new Date(x.validTo) > new Date(Date.now() + 30 * 864e5)) { this.setCert(c); return; }
    } catch { /* none yet, or unreadable: make a new one */ }
    const selfsigned = require('selfsigned');
    const notAfter = new Date(); notAfter.setFullYear(notAfter.getFullYear() + 10);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'LocalSend User' }], { keySize: 2048, algorithm: 'sha256', notAfterDate: notAfter });
    const c = { key: pems.private, cert: pems.cert };
    try { fs.mkdirSync(this.o.dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 }); } catch (e) { this.log('nearby: could not save certificate: ' + e.message); }
    this.setCert(c);
  }
  setCert(c) {
    this.cert = c;
    // the protocol's fingerprint in HTTPS mode: SHA-256 of the certificate
    this.fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(c.cert).raw).digest('hex').toUpperCase();
  }

  // ------------------------------------------------------------ server (receiving)
  startServer() {
    const srv = https.createServer({ key: this.cert.key, cert: this.cert.cert, requestTimeout: 0, headersTimeout: 15000 }, (req, res) => {
      this.handle(req, res).catch(e => { this.log('nearby: ' + e.message); reply(res, 500); });
    });
    srv.on('error', e => {
      this.server = null;
      if (e.code === 'EADDRINUSE') {
        this.status = 'port';
        this.log(`nearby: port ${this.port} is in use`);
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.apply(), 30 * 1000);
      } else { this.status = 'error'; this.statusText = e.message; this.log('nearby server: ' + e.message); }
      this.emit();
    });
    srv.listen(this.port, '0.0.0.0', () => {
      this.status = 'on'; this.log(`nearby: receiving on port ${this.port}`);
      this.emit();
      this.announce(true);
    });
    this.server = srv;
  }
  stopServer() {
    if (!this.server) return;
    try { this.server.close(); this.server.closeAllConnections && this.server.closeAllConnections(); } catch { /* closed */ }
    this.server = null;
  }

  limited(ip) {
    const now = Date.now();
    const r = this.rate.get(ip) || { n: 0, at: now };
    if (now - r.at > RATE.ms) { r.n = 0; r.at = now; }
    r.n++;
    this.rate.set(ip, r);
    if (this.rate.size > 500) this.rate.clear();
    return r.n > RATE.n;
  }

  async handle(req, res) {
    const ip = cleanIp(req.socket.remoteAddress);
    const url = new URL(req.url, 'https://localhost');
    if (!url.pathname.startsWith(API + '/')) return reply(res, 404);
    const route = url.pathname.slice(API.length + 1);
    if (req.method === 'GET' && route === 'info') return reply(res, 200, this.info(false));
    if (req.method !== 'POST') return reply(res, 405);
    if (route === 'upload') return this.upload(req, res, url, ip);
    if (this.limited(ip)) return reply(res, 429);
    if (route === 'register') {
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return reply(res, 400); }
      this.upsert(body, ip);
      return reply(res, 200, this.info(true));
    }
    if (route === 'prepare-upload') return this.prepare(req, res, url, ip);
    if (route === 'cancel') {
      const s = this.session;
      if (s && s.ip === ip && url.searchParams.get('sessionId') === s.id) this.endSession('cancelled');
      else if (this.request && this.request.ip === ip) this.decide(false);
      return reply(res, 200);
    }
    return reply(res, 404);
  }

  async prepare(req, res, url, ip) {
    if (!this.server || !this.cfg().receive || !this.allowed()) return reply(res, 403);
    // PIN: after 5 wrong tries this address has to wait 5 minutes
    const pin = String(this.cfg().pin || '').trim();
    if (pin) {
      const f = this.pinFails.get(ip);
      if (f && f.until > Date.now()) return reply(res, 429);
      const given = url.searchParams.get('pin');
      if (!given) return reply(res, 401);
      if (!sameText(given, pin)) {
        const n = (f && !(f.until && f.until <= Date.now()) ? f.n : 0) + 1;   // a block that ran out starts over
        this.pinFails.set(ip, { n, until: n >= PIN_TRIES ? Date.now() + PIN_BLOCK_MS : 0 });
        this.log(`nearby: wrong PIN from ${ip} (${n})`);
        return reply(res, 401);
      }
      this.pinFails.delete(ip);
    }
    if (this.session || this.request) return reply(res, 409);

    let body;
    try { body = JSON.parse(await readBody(req, MAX_JSON)); } catch { return reply(res, 400); }
    const info = body && typeof body.info === 'object' && body.info ? body.info : null;
    const list = body && typeof body.files === 'object' && body.files ? Object.values(body.files) : null;
    if (!info || !list || !list.length || list.length > MAX_FILES) return reply(res, 400);
    const files = [];
    for (const f of list) {
      if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 200) return reply(res, 400);
      if (typeof f.fileName !== 'string' || !f.fileName || f.fileName.length > 1024) return reply(res, 400);
      const size = Number(f.size);
      if (!Number.isSafeInteger(size) || size < 0) return reply(res, 400);
      files.push({
        id: f.id, name: f.fileName, size, type: typeof f.fileType === 'string' ? f.fileType : '',
        sha256: typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.sha256) ? f.sha256.toLowerCase() : null,
        preview: typeof f.preview === 'string' ? f.preview : null,
      });
    }
    if (new Set(files.map(f => f.id)).size !== files.length) return reply(res, 400);
    if (this.session || this.request) return reply(res, 409);   // another request came in meanwhile
    const from = this.upsert(info, ip);
    // A message (LocalSend's "Text"): one text "file" whose text comes along as the preview.
    const text = files.length === 1 && /^text\//.test(files[0].type) && files[0].preview != null ? files[0].preview.slice(0, 100000) : null;
    const total = files.reduce((a, f) => a + f.size, 0);

    const dir = this.folder();
    if (!text) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const st = fs.statfsSync(dir);
        if (total > st.bavail * st.bsize - KEEP_FREE) {
          this.note(`${from.alias} wanted to send ${fmtSize(total)}, but there isn't enough space`, 'warn');
          return reply(res, 403);
        }
      } catch (e) { this.log('nearby: folder: ' + e.message); return reply(res, 500); }
    }

    // Ask. The sender's request stays open until you answer (or a minute passes).
    const id = crypto.randomUUID();
    const ok = await new Promise(resolve => {
      this.request = { id, ip, from, files, text, total, resolve };
      this.request.timer = setTimeout(() => this.decide(false), ASK_MS);
      req.socket.once('close', () => { if (this.request && this.request.id === id) this.decide(false); });
      this.emit('request');
    });
    if (res.destroyed || res.writableEnded) return;
    if (!ok) return reply(res, 403);
    if (text != null) {
      this.o.received({ paths: [], from: from.alias, text });
      return reply(res, 204);
    }
    const s = {
      id: crypto.randomUUID(), ip, from, dir, total, bytes: 0, last: Date.now(), tops: new Map(),
      files: new Map(files.map(f => [f.id, { ...f, token: crypto.randomBytes(24).toString('hex'), state: 'waiting' }])),
      saved: [], failed: 0,
    };
    this.session = s;
    this.emit();
    return reply(res, 200, { sessionId: s.id, files: Object.fromEntries([...s.files.values()].map(f => [f.id, f.token])) });
  }

  // Accept or decline the waiting request (from the notch).
  decide(ok) {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = null;
    r.resolve(!!ok);
    this.emit();
  }

  // Where a received file goes: inside the folder, with a fresh name if it already exists.
  // A folder sent from the phone keeps its structure, under one new top folder per transfer.
  target(s, name) {
    const parts = safeParts(name);
    let dir = s.dir;
    if (parts.length > 1) {
      const top = parts[0];
      if (!s.tops.has(top)) s.tops.set(top, path.basename(uniquePath(s.dir, top)));
      dir = path.join(s.dir, s.tops.get(top), ...parts.slice(1, -1));
    }
    const p = uniquePath(dir, parts[parts.length - 1]);
    if (!inside(s.dir, p)) throw new Error('unsafe path');
    return p;
  }

  async upload(req, res, url, ip) {
    const s = this.session;
    const q = k => url.searchParams.get(k);
    if (!q('sessionId') || !q('fileId') || !q('token')) return reply(res, 400);
    if (!s || s.id !== q('sessionId')) return reply(res, s ? 409 : 403);
    if (s.ip !== ip) return reply(res, 403);
    const f = s.files.get(q('fileId'));
    if (!f || !sameText(q('token'), f.token)) return reply(res, 403);
    if (f.state !== 'waiting') return reply(res, 409);
    f.state = 'writing';

    let dest, tmp;
    try {
      dest = this.target(s, f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      tmp = path.join(path.dirname(dest), `.${crypto.randomBytes(6).toString('hex')}.notchpart`);
    } catch (e) { f.state = 'failed'; s.failed++; this.log('nearby: ' + e.message); this.afterFile(s); return reply(res, 500); }

    const hash = f.sha256 ? crypto.createHash('sha256') : null;
    const outStream = fs.createWriteStream(tmp, { flags: 'wx' });
    let n = 0, bad = 0;
    // the half-written file goes once the stream has really let go of it
    const dropTmp = () => { if (outStream.closed) fs.rm(tmp, { force: true }, () => {}); else outStream.once('close', () => fs.rm(tmp, { force: true }, () => {})); };
    const fail = (code, why) => {
      if (f.state !== 'writing') return;
      f.state = 'failed'; s.failed++;
      outStream.destroy();
      dropTmp();
      this.log(`nearby: ${f.name}: ${why}`);
      reply(res, code);
      this.afterFile(s);
    };
    req.on('data', c => {
      n += c.length;
      if (n > f.size) { bad = 1; req.unpipe(outStream); req.destroy(); fail(400, 'more data than announced'); return; }
      if (hash) hash.update(c);
      s.bytes += c.length; s.last = Date.now();
      this.progress();
    });
    req.on('aborted', () => fail(400, 'sender stopped'));
    req.on('error', () => fail(400, 'connection error'));
    outStream.on('error', e => fail(500, e.message));
    req.pipe(outStream);
    outStream.on('finish', () => {
      if (bad || f.state !== 'writing' || this.session !== s) { dropTmp(); return; }
      if (n !== f.size) return fail(400, `got ${n} of ${f.size} bytes`);
      if (hash && hash.digest('hex') !== f.sha256) return fail(422, 'checksum mismatch');
      try {
        if (fs.existsSync(dest)) dest = uniquePath(path.dirname(dest), path.basename(dest));
        fs.renameSync(tmp, dest);
        markFromInternet(dest);
      } catch (e) { return fail(500, e.message); }
      f.state = 'done';
      s.saved.push(dest);
      reply(res, 200);
      this.afterFile(s);
    });
  }

  afterFile(s) {
    if (this.session !== s) return;
    this.emit();
    if ([...s.files.values()].every(f => f.state === 'done' || f.state === 'failed')) this.endSession('done');
  }

  // The incoming transfer is over: finished, cancelled by the sender, stopped, or idle too long.
  endSession(why) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    for (const f of s.files.values()) if (f.state === 'waiting' || f.state === 'writing') f.state = 'failed';
    // received files go on the shelf: whole folders as one item
    const roots = [...new Set(s.saved.map(p => {
      const rel = path.relative(s.dir, p).split(path.sep);
      return rel.length > 1 ? path.join(s.dir, rel[0]) : p;
    }))];
    if (roots.length) this.o.received({ paths: roots, from: s.from.alias, count: s.saved.length, failed: s.files.size - s.saved.length, why });
    else if (why !== 'done') this.note(`Transfer from ${s.from.alias} ${why === 'idle' ? 'stopped' : 'was cancelled'}`, 'warn');
    this.emit();
  }

  checkIdle() {
    if (this.session && Date.now() - this.session.last > IDLE_MS) { this.log('nearby: transfer idle, closing'); this.endSession('idle'); }
  }

  // ------------------------------------------------------------ discovery
  startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', e => { this.log('nearby udp: ' + e.message); this.stopDiscovery(); });
    sock.on('message', (msg, rinfo) => this.onUdp(msg, rinfo));
    sock.bind(this.mport, () => {
      try { sock.setMulticastTTL(1); sock.setMulticastLoopback(false); } catch { /* fine */ }
      for (const a of lanAddresses()) { try { sock.addMembership(MCAST, a.address); } catch { /* not on this adapter */ } }
      this.announce(true);
    });
    this.udp = sock;
  }
  stopDiscovery() { if (this.udp) { try { this.udp.close(); } catch { /* closed */ } this.udp = null; } }

  // Say hello on every network adapter (only while this PC can receive).
  announce(isAnnounce) {
    if (!this.udp || !this.server) return;
    const msg = Buffer.from(JSON.stringify({ ...this.info(true), announce: !!isAnnounce, announcement: !!isAnnounce }));
    for (const a of lanAddresses()) {
      try { this.udp.setMulticastInterface(a.address); this.udp.send(msg, this.mport, MCAST); } catch { /* adapter gone */ }
    }
  }

  onUdp(msg, rinfo) {
    if (msg.length > 16 * 1024) return;
    let d; try { d = JSON.parse(msg); } catch { return; }
    if (!d || typeof d !== 'object' || !d.fingerprint || d.fingerprint === this.fingerprint) return;
    const dev = this.upsert(d, rinfo.address);
    if (!dev) return;
    // Someone just opened LocalSend: tell them about us, over HTTP, or else over multicast.
    if ((d.announce || d.announcement) && this.server) this.register(dev).catch(() => this.announce(false));
  }

  // Add or refresh a device from its info.
  upsert(d, ip) {
    if (!d || typeof d !== 'object' || !ip) return null;
    if (d.fingerprint && d.fingerprint === this.fingerprint) return null;
    const port = Number.isInteger(d.port) && d.port > 0 && d.port < 65536 ? d.port : PORT;
    const id = String(d.fingerprint || `${ip}:${port}`).slice(0, 128);
    const prev = this.devices.get(id);
    const dev = {
      id, ip, port,
      protocol: d.protocol === 'http' ? 'http' : 'https',
      alias: String(d.alias || 'Unknown device').replace(/[\u0000-\u001f]/g, '').slice(0, 40),
      type: ['mobile', 'desktop', 'web', 'headless', 'server'].includes(d.deviceType) ? d.deviceType : 'desktop',
      model: d.deviceModel ? String(d.deviceModel).slice(0, 40) : '',
      seen: Date.now(),
    };
    this.devices.set(id, dev);
    if (this.devices.size > 64) {
      const oldest = [...this.devices.values()].sort((a, b) => a.seen - b.seen)[0];
      this.devices.delete(oldest.id);
    }
    if (!prev || prev.alias !== dev.alias || prev.ip !== dev.ip) this.emit();
    return dev;
  }

  pruneDevices() {
    const now = Date.now(); let gone = false;
    for (const [id, d] of this.devices) if (now - d.seen > DEVICE_TTL && !(this.out && this.out.dev.id === id)) { this.devices.delete(id); gone = true; }
    if (gone) this.emit();
  }

  async register(dev, timeout = 3000) {
    const r = await this.call(dev, 'register', { body: Buffer.from(JSON.stringify(this.info(true))), timeout });
    if (r.status === 200) { try { this.upsert({ ...JSON.parse(r.body), port: dev.port, protocol: dev.protocol }, dev.ip); } catch { /* fine */ } }
    return r;
  }

  // The notch was opened: look around. Multicast first; if that finds nobody, ask every address
  // on the local network (LocalSend's fallback for networks that block multicast).
  async search(force) {
    if (!this.allowed()) return;
    this.announce(true);
    if (this.scanning || (!force && Date.now() - this.lastScan < 60 * 1000)) return;
    await new Promise(r => setTimeout(r, force ? 0 : 2500));
    if (!force && this.devices.size) return;
    this.scanning = true; this.lastScan = Date.now(); this.emit();
    try {
      const mine = new Set(lanAddresses().map(a => a.address));
      const targets = [];
      for (const a of lanAddresses()) {
        const base = a.address.split('.').slice(0, 3).join('.');
        for (let i = 1; i < 255; i++) { const ip = `${base}.${i}`; if (!mine.has(ip)) targets.push(ip); }
      }
      let k = 0;
      const worker = async () => {
        while (k < targets.length) {
          const ip = targets[k++];
          try { await this.register({ ip, port: PORT, protocol: 'https' }, 1500); } catch { /* nobody there */ }
        }
      };
      await Promise.all(Array.from({ length: 48 }, worker));
    } finally { this.scanning = false; this.emit(); }
  }

  // Add a device by address (tests, or a network that blocks both multicast and scanning).
  async addAddress(ip, port = PORT) { return this.register({ ip, port, protocol: 'https' }); }

  // ------------------------------------------------------------ client (sending)
  // One HTTPS request to another LocalSend device. Their certificate is self-signed, so it can't
  // be checked against anything: as in LocalSend itself, the network is the trust boundary.
  call(dev, route, { body, query, timeout = 10000, stream, size, onSocket } = {}) {
    return new Promise((resolve, reject) => {
      const mod = dev.protocol === 'http' ? http : https;
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      const headers = { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' };
      if (stream) headers['Content-Length'] = size; else if (body) headers['Content-Length'] = body.length;
      const req = mod.request({
        host: dev.ip, port: dev.port, method: 'POST', path: `${API}/${route}${qs}`, headers,
        rejectUnauthorized: false, agent: false, timeout,
      }, res => {
        const chunks = []; let n = 0;
        res.on('data', c => { n += c.length; if (n < 1024 * 1024) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (onSocket) onSocket(req);
      if (stream) { stream.on('error', e => req.destroy(e)); stream.pipe(req); }
      else req.end(body);
    });
  }

  // Files and folders → the list LocalSend expects ("Folder/sub/file.jpg" for things inside folders).
  collect(paths) {
    const out = [];
    const walk = (abs, rel, depth) => {
      if (out.length >= MAX_FILES) return;
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) return;
        let names = []; try { names = fs.readdirSync(abs); } catch { return; }
        for (const n of names) if (n !== 'desktop.ini' && n !== 'Thumbs.db') walk(path.join(abs, n), rel + '/' + n, depth + 1);
      } else if (st.isFile()) {
        out.push({ id: crypto.randomUUID(), abs, name: rel, size: st.size, type: fileType(abs), modified: st.mtime.toISOString() });
      }
    };
    for (const p of paths) walk(p, path.basename(p), 0);
    return out;
  }

  async send(deviceId, paths) {
    const dev = this.devices.get(deviceId);
    if (!dev) return { ok: false, error: 'That device is no longer around' };
    if (this.out) return { ok: false, error: 'Already sending' };
    const files = this.collect(paths || []);
    if (!files.length) return { ok: false, error: 'Nothing to send' };
    this.lastPaths = paths;
    const out = { dev, paths, files, reqs: new Set(), cancelled: false, phase: 'asking', bytes: 0, total: files.reduce((a, f) => a + f.size, 0), done: 0 };
    this.out = out; this.pinFor = null; this.notice = null;
    this.emit();
    const finish = (msg, tone) => { if (this.out === out) this.out = null; if (msg) this.note(msg, tone); else this.emit(); };
    try {
      const body = {
        info: this.info(true),
        files: Object.fromEntries(files.map(f => [f.id, { id: f.id, fileName: f.name, size: f.size, fileType: f.type, sha256: null, preview: null, metadata: { modified: f.modified } }])),
      };
      const pin = this.pins.get(dev.id);
      // the other side shows its accept prompt now; give it time
      const r = await this.call(dev, 'prepare-upload', { body: Buffer.from(JSON.stringify(body)), query: pin ? { pin } : null, timeout: 3 * 60 * 1000, onSocket: q => out.reqs.add(q) });
      if (out.cancelled) return finish();
      if (r.status === 401) { this.pins.delete(dev.id); this.pinFor = dev.id; this.out = null; this.emit(); return { ok: false, pin: true }; }
      if (r.status === 403) return finish(`${dev.alias} declined`, 'warn');
      if (r.status === 409) return finish(`${dev.alias} is busy with another transfer`, 'warn');
      if (r.status === 429) return finish(`${dev.alias} asked to wait a moment`, 'warn');
      if (r.status === 204) return finish(`Sent to ${dev.alias}`);
      if (r.status !== 200) return finish(`${dev.alias} answered with an error (${r.status})`, 'warn');
      let ans; try { ans = JSON.parse(r.body); } catch { return finish(`${dev.alias} sent an answer that couldn't be read`, 'warn'); }
      const tokens = (ans && ans.files) || {};
      out.phase = 'sending'; out.session = ans.sessionId;
      this.emit();
      let sent = 0;
      for (const f of files) {
        if (out.cancelled) break;
        if (!tokens[f.id]) { out.bytes += f.size; continue; }   // the receiver skipped this one
        out.file = path.basename(f.abs);
        const before = out.bytes;
        const stream = fs.createReadStream(f.abs);
        stream.on('data', c => { out.bytes += c.length; this.progress(); });
        const u = await this.call(dev, 'upload', { stream, size: f.size, query: { sessionId: ans.sessionId, fileId: f.id, token: tokens[f.id] }, timeout: 60 * 1000, onSocket: q => out.reqs.add(q) })
          .catch(e => ({ status: 0, error: e.message }));
        if (out.cancelled) break;
        if (u.status !== 200) { out.bytes = before + f.size; this.log(`nearby: upload ${f.name}: ${u.status || u.error}`); continue; }
        sent++; out.done = sent;
      }
      if (out.cancelled) return finish(`Stopped sending to ${dev.alias}`, 'warn');
      const n = files.length;
      if (sent === n) return finish(`Sent ${n === 1 ? path.basename(files[0].abs) : n + ' files'} to ${dev.alias}`);
      return finish(`Sent ${sent} of ${n} files to ${dev.alias}`, 'warn');
    } catch (e) {
      if (out.cancelled) return finish();
      this.log('nearby send: ' + e.message);
      return finish(`Couldn't reach ${dev.alias}`, 'warn');
    }
  }

  // The PIN the other device asked for: try again with it.
  sendPin(pin) {
    const id = this.pinFor;
    const p = String(pin || '').trim();
    if (!id || !p || !this.lastPaths) { this.pinFor = null; this.emit(); return; }
    this.pins.set(id, p.slice(0, 64));
    this.pinFor = null;
    return this.send(id, this.lastPaths);
  }

  cancelSend() {
    const out = this.out;
    if (this.pinFor) { this.pinFor = null; this.emit(); }
    if (!out) return;
    out.cancelled = true;
    if (out.session) this.call(out.dev, 'cancel', { query: { sessionId: out.session }, timeout: 3000 }).catch(() => {});
    for (const q of out.reqs) { try { q.destroy(); } catch { /* done */ } }
    this.out = null;
    this.emit();
  }

  // ------------------------------------------------------------ state for the notch
  note(text, tone) { this.notice = { text, tone: tone || '', at: Date.now() }; this.emit('notice'); }

  progress() {
    if (this.progTimer) return;
    this.progTimer = setTimeout(() => { this.progTimer = null; this.emit(); }, 200);
  }

  state() {
    const s = this.session, o = this.out, r = this.request;
    return {
      status: this.status, network: this.network, alias: this.alias(), scanning: this.scanning,
      devices: [...this.devices.values()].sort((a, b) => b.seen - a.seen).slice(0, 8)
        .map(d => ({ id: d.id, alias: d.alias, type: d.type, model: d.model, ip: d.ip })),
      request: r ? {
        id: r.id, from: r.from.alias, type: r.from.type, count: r.files.length, total: r.total,
        names: r.files.slice(0, 3).map(f => safeParts(f.name).join('/')), text: r.text != null ? r.text.slice(0, 400) : null,
      } : null,
      transfer: s ? { dir: 'in', peer: s.from.alias, bytes: s.bytes, total: s.total, count: s.files.size, done: s.saved.length }
        : o ? { dir: 'out', peer: o.dev.alias, phase: o.phase, bytes: o.bytes, total: o.total, count: o.files.length, done: o.done, file: o.file || '' } : null,
      pinFor: this.pinFor ? ((this.devices.get(this.pinFor) || {}).alias || 'This device') : null,
      notice: this.notice && Date.now() - this.notice.at < 8000 ? this.notice : null,
    };
  }
  emit(kind) { try { this.o.send(this.state(), kind || ''); } catch (e) { this.log('nearby emit: ' + e.message); } }
}

// Windows treats files from the network as "from the internet" (SmartScreen warns before running
// them), the same as a download from a browser.
function markFromInternet(p) {
  if (process.platform !== 'win32') return;
  try { fs.writeFileSync(p + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); } catch { /* not NTFS */ }
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

module.exports = { Nearby, safeParts, cleanSegment, inside, fmtSize, PORT };
