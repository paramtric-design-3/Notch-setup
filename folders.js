// BMO — Folder rules (a Hazel/Forel-style file automation, built clean-room for Windows).
// Watches folders and, when a file matches a rule's conditions, moves / copies / renames it or
// sends it to the Recycle Bin. Everything is local; nothing leaves the PC. Rules live in settings.
'use strict';

const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 1500;
const HISTORY_MAX = 80;

function tokens(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const q = Math.floor(d.getMonth() / 3) + 1;
  return { year: d.getFullYear(), month: p(d.getMonth() + 1), day: p(d.getDate()), quarter: q };
}
function fillTokens(str, date, file) {
  const t = tokens(date);
  const ext = path.extname(file);
  return String(str || '')
    .replace(/\{year\}/g, t.year).replace(/\{month\}/g, t.month).replace(/\{day\}/g, t.day).replace(/\{quarter\}/g, t.quarter)
    .replace(/\{name\}/g, path.basename(file, ext)).replace(/\{ext\}/g, ext.replace(/^\./, ''));
}
function globToRe(g) {
  const esc = String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

// Does one file (its stat) satisfy a rule?
function matches(rule, file, st) {
  const name = path.basename(file);
  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  const conds = rule.conditions || [];
  if (!conds.length) return false;
  const test = c => {
    const val = String(c.value == null ? '' : c.value);
    switch (c.field) {
      case 'name': {
        const n = name.toLowerCase(), v = val.toLowerCase();
        if (c.op === 'contains') return n.includes(v);
        if (c.op === 'startsWith') return n.startsWith(v);
        if (c.op === 'endsWith') return n.startsWith(v) || n.endsWith(v) ? n.endsWith(v) : false;
        if (c.op === 'matches') return globToRe(val).test(name);
        return false;
      }
      case 'ext': return val.toLowerCase().split(/[,\s]+/).filter(Boolean).includes(ext);
      case 'size': { const mb = st.size / (1024 * 1024); return c.op === '>' ? mb > +val : mb < +val; }
      case 'age': { const days = (Date.now() - st.mtimeMs) / 86400000; return c.op === 'olderThan' ? days > +val : days < +val; }
      default: return false;
    }
  };
  return (rule.match === 'any') ? conds.some(test) : conds.every(test);
}

function uniqueDest(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest), ext = path.extname(dest), base = path.basename(dest, ext);
  for (let i = 1; i < 1000; i++) { const p = path.join(dir, `${base} (${i})${ext}`); if (!fs.existsSync(p)) return p; }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

class Folders {
  constructor({ getSettings, setSettings, trashItem, log, onChange }) {
    this.getSettings = getSettings;            // () => settings.folderRules | undefined
    this.setSettings = setSettings;            // (folderRules) => void   (persists)
    this.trash = trashItem;                     // async (absPath) => void  (Recycle Bin)
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});     // () => void  (broadcast state)
    this.watchers = new Map();                  // folder -> fs.FSWatcher
    this.pending = new Map();                   // file -> timer
    this.history = [];
    this.recent = new Set();                    // files we just touched, to ignore our own events
  }

  config() { return this.getSettings() || { enabled: false, rules: [] }; }
  state() { const c = this.config(); return { enabled: !!c.enabled, rules: c.rules || [], history: this.history.slice(0, 40) }; }

  start() {
    this.stopAll();
    const c = this.config();
    if (!c.enabled) { this.onChange(); return; }
    const folders = new Set((c.rules || []).filter(r => r.enabled !== false && r.folder).map(r => r.folder));
    for (const f of folders) this.watch(f);
    this.onChange();
  }
  stopAll() { for (const w of this.watchers.values()) { try { w.close(); } catch { /* ignore */ } } this.watchers.clear(); }

  watch(folder) {
    if (this.watchers.has(folder) || !fs.existsSync(folder)) return;
    try {
      const w = fs.watch(folder, { recursive: true }, (_e, name) => { if (name) this.queue(path.join(folder, name)); });
      this.watchers.set(folder, w);
    } catch (e) { this.log('folders watch: ' + e.message); }
  }

  queue(file) {
    clearTimeout(this.pending.get(file));
    this.pending.set(file, setTimeout(() => { this.pending.delete(file); this.process(file); }, DEBOUNCE_MS));
  }

  // Apply the first matching rule (whose folder contains the file) to one file.
  async process(file) {
    if (this.recent.has(file)) return;
    let st; try { st = fs.statSync(file); } catch { return; }
    if (!st.isFile()) return;
    // wait until the file has stopped growing (still being written)
    await new Promise(r => setTimeout(r, 400));
    try { const s2 = fs.statSync(file); if (s2.size !== st.size) { this.queue(file); return; } st = s2; } catch { return; }
    const c = this.config();
    if (!c.enabled) return;
    for (const rule of (c.rules || [])) {
      if (rule.enabled === false || !rule.folder) continue;
      if (!file.toLowerCase().startsWith(rule.folder.toLowerCase())) continue;
      if (!rule.recursive && path.dirname(file).toLowerCase() !== rule.folder.toLowerCase()) continue;
      if (matches(rule, file, st)) { await this.apply(rule, file, st, false); return; }
    }
  }

  // Run a rule (or all) over the files already in its folder. dryRun returns planned actions only.
  async runNow(ruleId, dryRun) {
    const c = this.config();
    const rules = (c.rules || []).filter(r => (!ruleId || r.id === ruleId) && r.folder && r.enabled !== false);
    const planned = [];
    for (const rule of rules) {
      let entries = [];
      try { entries = this.listFiles(rule.folder, rule.recursive); } catch { continue; }
      for (const file of entries) {
        let st; try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile() || !matches(rule, file, st)) continue;
        const plan = await this.apply(rule, file, st, dryRun);
        if (plan) planned.push(plan);
      }
    }
    return planned;
  }

  listFiles(dir, recursive, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive) this.listFiles(p, true, out); }
      else out.push(p);
    }
    return out;
  }

  async apply(rule, file, st, dryRun) {
    const a = rule.action || {};
    const date = st.mtime || new Date();
    let from = file, to = null, kind = a.type, undoable = false;
    try {
      if (a.type === 'move' || a.type === 'copy') {
        const destDir = path.resolve(fillTokens(a.dest || '', date, file));
        to = uniqueDest(path.join(destDir, path.basename(file)));
        if (!dryRun) {
          fs.mkdirSync(destDir, { recursive: true });
          if (a.type === 'move') { this.mark(to); try { fs.renameSync(file, to); } catch { fs.copyFileSync(file, to); fs.rmSync(file); } undoable = true; }
          else { this.mark(to); fs.copyFileSync(file, to); undoable = true; }
        }
      } else if (a.type === 'rename') {
        const ext = path.extname(file);
        let base = fillTokens(a.pattern || '{name}', date, file);
        if (!path.extname(base)) base += ext;
        to = uniqueDest(path.join(path.dirname(file), base));
        if (!dryRun) { this.mark(to); fs.renameSync(file, to); undoable = true; }
      } else if (a.type === 'trash') {
        to = 'Recycle Bin';
        if (!dryRun) { await this.trash(file); }
      } else { return null; }
    } catch (e) { this.log(`folders ${a.type} ${file}: ${e.message}`); if (!dryRun) this.record({ at: Date.now(), rule: rule.name, kind, from, to, error: e.message }); return null; }

    if (!dryRun) this.record({ at: Date.now(), rule: rule.name, kind, from, to, undo: undoable ? { kind: a.type, from, to } : null });
    return { rule: rule.name, kind, from, to, dryRun: !!dryRun };
  }

  mark(file) { this.recent.add(file); setTimeout(() => this.recent.delete(file), 4000); }
  record(h) { this.history.unshift(h); this.history = this.history.slice(0, HISTORY_MAX); this.onChange(); }

  async undo(index) {
    const h = this.history[index];
    if (!h || !h.undo) return false;
    try {
      const u = h.undo;
      if (u.kind === 'move' || u.kind === 'rename') { this.mark(u.from); fs.mkdirSync(path.dirname(u.from), { recursive: true }); fs.renameSync(u.to, u.from); }
      else if (u.kind === 'copy') { fs.rmSync(u.to, { force: true }); }
      h.undone = true; this.onChange();
      return true;
    } catch (e) { this.log('folders undo: ' + e.message); return false; }
  }
  clearHistory() { this.history = []; this.onChange(); }
}

module.exports = { Folders };
