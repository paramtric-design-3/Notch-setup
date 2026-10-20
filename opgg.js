// FJBC Notch — OP.GG open champion data (https://mcp-api.op.gg/mcp).
// OP.GG publishes counters, builds, runes and lane tier lists through an open MCP endpoint
// (no key). Answers come in a compact "class notation":
//   class Foo: a,b,c
//   ...
//   Foo(1,"x",[Bar(2)])
// parse() turns that into plain objects using the declared field names.
'use strict';

const URL_ = 'https://mcp-api.op.gg/mcp';

// ---------------------------------------------------------------- class-notation parser
function parse(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (text[0] === '{' || text[0] === '[') { try { return JSON.parse(text); } catch { /* fall through */ } }
  const classes = {};
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^class\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(lines[i].trim());
    if (m) { classes[m[1]] = m[2].split(',').map(s => s.trim()).filter(Boolean); continue; }
    if (lines[i].trim() === '') continue;
    break;
  }
  const src = lines.slice(i).join('\n');
  let p = 0;
  const ws = () => { while (p < src.length && /\s/.test(src[p])) p++; };
  const fail = msg => { throw new Error(`opgg parse: ${msg} at ${p}`); };
  function value() {
    ws();
    const c = src[p];
    if (c === '"' || c === "'") return str(c);
    if (c === '[') {
      p++; const out = [];
      ws(); if (src[p] === ']') { p++; return out; }
      for (;;) { out.push(value()); ws(); if (src[p] === ',') { p++; continue; } if (src[p] === ']') { p++; return out; } fail('expected , or ]'); }
    }
    if (c === '{') {   // dict, just in case
      p++; const out = {};
      ws(); if (src[p] === '}') { p++; return out; }
      for (;;) {
        const k = value(); ws(); if (src[p] !== ':') fail('expected :'); p++;
        out[String(k)] = value(); ws();
        if (src[p] === ',') { p++; continue; } if (src[p] === '}') { p++; return out; } fail('expected , or }');
      }
    }
    if (/[-+\d.]/.test(c)) {
      const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(p, p + 40));
      if (!m) fail('bad number');
      p += m[0].length; return Number(m[0]);
    }
    const m = /^[A-Za-z_][\w]*/.exec(src.slice(p, p + 80));
    if (!m) fail(`unexpected ${JSON.stringify(c)}`);
    const name = m[0]; p += name.length; ws();
    if (src[p] !== '(') {
      if (name === 'true' || name === 'True') return true;
      if (name === 'false' || name === 'False') return false;
      if (name === 'null' || name === 'None' || name === 'undefined') return null;
      return name;
    }
    p++;
    const args = [];
    ws();
    if (src[p] === ')') p++;
    else for (;;) { args.push(value()); ws(); if (src[p] === ',') { p++; continue; } if (src[p] === ')') { p++; break; } fail('expected , or )'); }
    const fields = classes[name];
    if (!fields) return args.length === 1 ? args[0] : args;
    const o = {};
    fields.forEach((f, k) => { o[f] = k < args.length ? args[k] : null; });
    return o;
  }
  function str(q) {
    let s = '';
    p++;
    while (p < src.length && src[p] !== q) {
      if (src[p] === '\\') {
        const n = src[p + 1];
        if (n === 'u') { s += String.fromCharCode(parseInt(src.slice(p + 2, p + 6), 16)); p += 6; continue; }
        s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[n] ?? n; p += 2; continue;
      }
      s += src[p++];
    }
    p++;
    return s;
  }
  return value();
}

// ---------------------------------------------------------------- client
class Opgg {
  constructor({ fetchImpl, log }) {
    this.fetch = fetchImpl || fetch;
    this.log = log || (() => {});
    this.session = null;
    this.id = 0;
    this.ready = null;
  }

  async rpc(method, params, notify = false) {
    const res = await this.fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const text = await res.text();
    if (notify) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = text.trim().startsWith('{') ? text : (text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop() || 'null');
    const out = JSON.parse(json);
    if (out && out.error) throw new Error(out.error.message || 'rpc error');
    return out && out.result;
  }

  init() {
    if (!this.ready) {
      this.ready = (async () => {
        this.session = null;
        await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fjbc-notch', version: '1' } });
        await this.rpc('notifications/initialized', {}, true);
      })().catch(e => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  // Calls a tool and returns the parsed answer (throws when OP.GG says it failed).
  async call(name, args) {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.init();
      try { result = await this.rpc('tools/call', { name, arguments: args }); break; } catch (e) {
        if (attempt) throw e;
        this.ready = null;   // session expired: start a new one
      }
    }
    const text = ((result && result.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result && result.isError) throw new Error(text.slice(0, 160) || 'tool error');
    if (result && result.structuredContent && !text) return result.structuredContent;
    return parse(text);
  }
}

// ---------------------------------------------------------------- names and positions
// Our positions (from the League client) -> OP.GG's.
const POS = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };

// OP.GG wants champion names in UPPER_SNAKE_CASE (LEE_SIN). Some names are spelled differently
// there, so a few guesses are tried in order.
function nameCandidates(name, key) {
  const fromName = String(name || '').replace(/['.]/g, '').replace(/&.*$/, '').trim().split(/\s+/).join('_').toUpperCase();
  const fromKey = String(key || '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  const glued = String(name || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return [...new Set([fromName, fromKey, glued].filter(Boolean))];
}

module.exports = { Opgg, parse, POS, nameCandidates };
