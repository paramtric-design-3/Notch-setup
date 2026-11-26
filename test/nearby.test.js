// Nearby sharing (localsend.js): two instances on this PC send to each other, plus the cases a
// stranger on the network could try. Run with: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Nearby, safeParts, inside } = require('../localsend');

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `nearby-${name}-`));

function make(name, port, extra = {}) {
  const dir = tmp(name), downloads = tmp(name + '-dl');
  const cfg = { alias: name, receive: true, publicOk: false, pin: '', folder: '', ...extra };
  const events = { states: [], received: [] };
  const n = new Nearby({
    dir, downloads, port, discovery: false,
    config: () => cfg,
    send: (s, kind) => { events.states.push(s); if (kind === 'request' && n.onAsk) n.onAsk(s.request); },
    received: r => events.received.push(r),
  });
  n.network = 'private';
  return { n, cfg, dir, downloads, events };
}

// a raw request, as a stranger would send it
function raw(port, route, { body, query, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + new URLSearchParams(query) : '';
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port, method, path: `/api/localsend/v2/${route}${qs}`, rejectUnauthorized: false, agent: false,
      headers: data ? { 'Content-Length': data.length } : {} }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const info = { alias: 'Stranger', version: '2.1', deviceModel: 'X', deviceType: 'mobile', fingerprint: 'abc', port: 1, protocol: 'https' };
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };

test('names from the sender stay inside the folder', () => {
  assert.deepStrictEqual(safeParts('../../Windows/System32/evil.dll'), ['Windows', 'System32', 'evil.dll']);
  assert.deepStrictEqual(safeParts('..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat'), ['AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.bat']);
  assert.deepStrictEqual(safeParts('C:\\Users\\x\\a.txt'), ['C_', 'Users', 'x', 'a.txt']);
  assert.deepStrictEqual(safeParts('/etc/passwd'), ['etc', 'passwd']);
  assert.deepStrictEqual(safeParts('CON.txt'), ['_CON.txt']);
  assert.deepStrictEqual(safeParts('photo\u202Egpj.exe'), ['photogpj.exe']);
  assert.deepStrictEqual(safeParts('..'), ['file']);
  assert.deepStrictEqual(safeParts('a. . '), ['a']);
  assert.ok(!inside('/a/b', '/a/b'));
  assert.ok(!inside('/a/b', '/a/bc/x'));
  assert.ok(inside('/a/b', '/a/b/c'));
});

test('two instances find each other and send files and a folder', async t => {
  const A = make('Alpha', 53401), B = make('Bravo', 53402);
  await A.n.start(); await B.n.start();
  t.after(() => { A.n.stop(); B.n.stop(); });
  await until(() => A.n.status === 'on' && B.n.status === 'on');

  await A.n.addAddress('127.0.0.1', 53402);
  const dev = [...A.n.devices.values()].find(d => d.alias === 'Bravo');
  assert.ok(dev, 'A sees B');
  assert.ok([...B.n.devices.values()].some(d => d.alias === 'Alpha'), 'B sees A (two-way register)');

  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'one.txt'), 'hello');
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
  fs.writeFileSync(path.join(src, 'big.bin'), big);
  fs.mkdirSync(path.join(src, 'Album', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Album', 'sub', 'p.jpg'), 'jpg');
  fs.writeFileSync(path.join(B.downloads, 'one.txt'), 'already here');

  let asked = null;
  B.n.onAsk = r => { asked = r; setTimeout(() => B.n.decide(true), 50); };
  const res = await A.n.send(dev.id, [path.join(src, 'one.txt'), path.join(src, 'big.bin'), path.join(src, 'Album')]);
  assert.strictEqual(asked.count, 3);
  assert.strictEqual(asked.from, 'Alpha');
  await until(() => B.events.received.length === 1);
  const r = B.events.received[0];
  assert.strictEqual(r.count, 3);
  assert.strictEqual(fs.readFileSync(path.join(B.downloads, 'one (1).txt'), 'utf8'), 'hello', 'existing file kept, new one renamed');
  assert.strictEqual(fs.readFileSync(path.join(B.downloads, 'one.txt'), 'utf8'), 'already here');
  assert.ok(fs.readFileSync(path.join(B.downloads, 'big.bin')).equals(big));
  assert.strictEqual(fs.readFileSync(path.join(B.downloads, 'Album', 'sub', 'p.jpg'), 'utf8'), 'jpg');
  assert.ok(r.paths.includes(path.join(B.downloads, 'Album')), 'folder goes on the shelf as one item');
  assert.ok(!fs.readdirSync(B.downloads).some(f => f.endsWith('.notchpart')), 'no leftovers');
  await until(() => !A.n.out);
  assert.match(A.n.state().notice.text, /Sent 3 files to Bravo/);
  void res;
});

test('declined, PIN and lockout', async t => {
  const A = make('Alpha2', 53403), B = make('Bravo2', 53404, { pin: '4821' });
  await A.n.start(); await B.n.start();
  t.after(() => { A.n.stop(); B.n.stop(); });
  await until(() => A.n.status === 'on' && B.n.status === 'on');
  await A.n.addAddress('127.0.0.1', 53404);
  const dev = [...A.n.devices.values()].find(d => d.alias === 'Bravo2');
  const src = tmp('src2'); fs.writeFileSync(path.join(src, 'a.txt'), 'a');

  // no PIN yet: the notch asks for it
  const r1 = await A.n.send(dev.id, [path.join(src, 'a.txt')]);
  assert.deepStrictEqual(r1, { ok: false, pin: true });
  assert.strictEqual(A.n.state().pinFor, 'Bravo2');
  // right PIN, then B declines
  B.n.onAsk = () => setTimeout(() => B.n.decide(false), 20);
  await A.n.sendPin('4821');
  assert.match(A.n.state().notice.text, /declined/);
  assert.strictEqual(fs.readdirSync(B.downloads).length, 0);

  // a stranger guessing: 401 five times, then blocked
  for (let i = 0; i < 5; i++) assert.strictEqual((await raw(53404, 'prepare-upload', { query: { pin: '000' + i }, body: { info, files: {} } })).status, 401);
  assert.strictEqual((await raw(53404, 'prepare-upload', { query: { pin: '4821' }, body: { info, files: {} } })).status, 429, 'blocked even with the right PIN');
});

test('a stranger cannot write outside the folder, skip the prompt or overfill a file', async t => {
  const B = make('Bravo3', 53405);
  await B.n.start();
  t.after(() => B.n.stop());
  await until(() => B.n.status === 'on');
  const files = {
    a: { id: 'a', fileName: '../../escape.txt', size: 3, fileType: 'text/plain' },
    b: { id: 'b', fileName: '..\\..\\Startup\\run.bat', size: 3 },
    c: { id: 'c', fileName: 'ok.bin', size: 4, sha256: crypto.createHash('sha256').update('good').digest('hex') },
    d: { id: 'd', fileName: 'small.bin', size: 2 },
  };
  // upload without a session
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId: 'x', fileId: 'a', token: 'y' }, body: Buffer.from('abc') })).status, 403);
  // bad bodies
  assert.strictEqual((await raw(53405, 'prepare-upload', { body: Buffer.from('{not json') })).status, 400);
  assert.strictEqual((await raw(53405, 'prepare-upload', { body: { info, files: { x: { id: 'x', fileName: 'a', size: -1 } } } })).status, 400);

  B.n.onAsk = () => setTimeout(() => B.n.decide(true), 20);
  const p = await raw(53405, 'prepare-upload', { body: { info, files } });
  assert.strictEqual(p.status, 200);
  const { sessionId, files: tok } = JSON.parse(p.body);
  // a second request while one is busy
  assert.strictEqual((await raw(53405, 'prepare-upload', { body: { info, files } })).status, 409);
  // wrong token
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId, fileId: 'a', token: 'nope' }, body: Buffer.from('abc') })).status, 403);
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId, fileId: 'a', token: tok.a }, body: Buffer.from('abc') })).status, 200);
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId, fileId: 'a', token: tok.a }, body: Buffer.from('abc') })).status, 409, 'no second write');
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId, fileId: 'b', token: tok.b }, body: Buffer.from('xyz') })).status, 200);
  assert.strictEqual((await raw(53405, 'upload', { query: { sessionId, fileId: 'c', token: tok.c }, body: Buffer.from('evil') })).status, 422, 'checksum');
  const over = await raw(53405, 'upload', { query: { sessionId, fileId: 'd', token: tok.d }, body: crypto.randomBytes(5000) }).catch(() => ({ status: 'reset' }));
  assert.ok(over.status === 400 || over.status === 'reset', 'more data than announced is refused');
  await until(() => B.events.received.length === 1);

  // the refused upload's temp file is removed once its stream has closed
  await until(() => !fs.readdirSync(B.downloads).some(f => f.endsWith('.notchpart')), 3000);
  const all = [];
  const walk = d => { for (const f of fs.readdirSync(d)) { const p2 = path.join(d, f); fs.statSync(p2).isDirectory() ? walk(p2) : all.push(path.relative(B.downloads, p2)); } };
  walk(B.downloads);
  assert.deepStrictEqual(all.sort(), ['Startup' + path.sep + 'run.bat', 'escape.txt'].sort());
  assert.ok(!fs.existsSync(path.join(B.downloads, '..', 'escape.txt')));
});

test('nothing is accepted without an answer, and receiving off means 403', async t => {
  const B = make('Bravo4', 53406);
  await B.n.start();
  t.after(() => B.n.stop());
  await until(() => B.n.status === 'on');
  const files = { a: { id: 'a', fileName: 'a.txt', size: 1 } };
  // the sender gives up: the request disappears
  const req = https.request({ host: '127.0.0.1', port: 53406, method: 'POST', path: '/api/localsend/v2/prepare-upload', rejectUnauthorized: false, agent: false });
  req.on('error', () => {});
  req.end(JSON.stringify({ info, files }));
  await until(() => B.n.request);
  req.destroy();
  await until(() => !B.n.request);
  // a message is shown, and only "received" after accepting
  B.n.onAsk = r => { assert.strictEqual(r.text, 'hi there'); setTimeout(() => B.n.decide(true), 20); };
  const m = await raw(53406, 'prepare-upload', { body: { info, files: { t: { id: 't', fileName: 'x.txt', size: 8, fileType: 'text/plain', preview: 'hi there' } } } });
  assert.strictEqual(m.status, 204);
  assert.strictEqual(B.events.received[0].text, 'hi there');
  // public network: off
  B.n.setNetwork('public');
  assert.strictEqual(B.n.status, 'public');
  await assert.rejects(raw(53406, 'prepare-upload', { body: { info, files } }));
});
