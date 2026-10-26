// WALL-E — Microsoft To Do.
// Signs in with Microsoft's device-code flow (you type a short code on Microsoft's own page; WALL-E
// never sees your password), keeps the sign-in encrypted on this PC, and syncs one To Do list
// through Microsoft Graph: open tasks, complete / uncomplete, important, add.
'use strict';

const fs = require('fs');
const path = require('path');

const LOGIN = process.env.NOTCH_MS_LOGIN || 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = process.env.NOTCH_MS_GRAPH || 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Tasks.ReadWrite offline_access';

class Todo {
  constructor({ dir, safeStorage, send, log, getSettings, fetchImpl }) {
    this.file = path.join(dir, 'todo-signin.bin');
    this.safe = safeStorage;
    this.send = send;                 // (state) => void
    this.log = log || (() => {});
    this.settings = getSettings;      // () => settings.todo
    this.fetch = fetchImpl || fetch;
    this.token = this.load();         // { access, refresh, expires }
    this.state = { status: this.token ? 'loading' : 'signedout', tasks: [], list: null };
    this.timer = null;
  }

  // ------------------------------------------------------------ token storage (encrypted with Windows' own protection)
  load() {
    try {
      const buf = fs.readFileSync(this.file);
      const json = this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(buf) : buf.toString('utf8');
      return JSON.parse(json);
    } catch { return null; }
  }
  save(t) {
    this.token = t;
    try {
      if (!t) { fs.rmSync(this.file, { force: true }); return; }
      const json = JSON.stringify(t);
      fs.writeFileSync(this.file, this.safe && this.safe.isEncryptionAvailable() ? this.safe.encryptString(json) : json);
    } catch (e) { this.log('todo save: ' + e.message); }
  }

  emit(patch) { this.state = { ...this.state, ...patch }; this.send(this.state); }
  clientId() { return String((this.settings() || {}).clientId || '').trim(); }

  // ------------------------------------------------------------ sign in (device code)
  async signIn() {
    const id = this.clientId();
    if (!id) return { ok: false, error: 'Add your client ID first (see the steps below)' };
    const res = await this.fetch(`${LOGIN}/devicecode`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, scope: SCOPE }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.device_code) return { ok: false, error: d.error_description ? String(d.error_description).split('\n')[0] : 'Microsoft refused the sign-in (check the client ID)' };
    this.emit({ status: 'pending', code: d.user_code, url: d.verification_uri || 'https://microsoft.com/devicelogin' });
    this.poll(id, d.device_code, (d.interval || 5) * 1000, Date.now() + (d.expires_in || 900) * 1000);
    return { ok: true, code: d.user_code, url: d.verification_uri || 'https://microsoft.com/devicelogin' };
  }
  async poll(id, deviceCode, every, until) {
    clearTimeout(this.pollTimer);
    if (Date.now() > until) { this.emit({ status: 'signedout', code: null, error: 'The code expired, try again' }); return; }
    this.pollTimer = setTimeout(async () => {
      try {
        const res = await this.fetch(`${LOGIN}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: id, device_code: deviceCode }) });
        const d = await res.json().catch(() => ({}));
        if (d.access_token) { this.keep(d); this.emit({ status: 'loading', code: null, error: null }); this.sync(); this.start(); return; }
        if (d.error === 'authorization_pending') return this.poll(id, deviceCode, every, until);
        if (d.error === 'slow_down') return this.poll(id, deviceCode, every + 5000, until);
        this.emit({ status: 'signedout', code: null, error: d.error === 'expired_token' ? 'The code expired, try again' : d.error === 'authorization_declined' ? 'Sign-in was cancelled' : 'Sign-in failed' });
      } catch (e) { this.poll(id, deviceCode, every, until); }
    }, every);
  }
  keep(d) {
    this.save({ access: d.access_token, refresh: d.refresh_token || (this.token && this.token.refresh), expires: Date.now() + ((d.expires_in || 3600) - 120) * 1000 });
  }
  signOut() {
    clearTimeout(this.pollTimer); this.stop();
    this.save(null);
    this.emit({ status: 'signedout', tasks: [], list: null, code: null, error: null });
  }

  // ------------------------------------------------------------ Graph
  async access() {
    if (!this.token) throw new Error('signed out');
    if (Date.now() < this.token.expires) return this.token.access;
    const res = await this.fetch(`${LOGIN}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.clientId(), refresh_token: this.token.refresh, scope: SCOPE }) });
    const d = await res.json().catch(() => ({}));
    if (!d.access_token) {
      if (d.error === 'invalid_grant') { this.save(null); this.emit({ status: 'signedout', tasks: [], error: 'Signed out by Microsoft, sign in again' }); }
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    this.keep(d);
    return this.token.access;
  }
  async graph(method, p, body) {
    const res = await this.fetch(GRAPH + p, { method, headers: { Authorization: 'Bearer ' + await this.access(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error((d && d.error && d.error.message) || `HTTP ${res.status}`);
    return d;
  }

  async lists() {
    const d = await this.graph('GET', '/me/todo/lists?$top=100');
    return ((d && d.value) || []).map(l => ({ id: l.id, name: l.displayName, isDefault: l.wellknownListName === 'defaultList' }));
  }
  async listId() {
    const want = (this.settings() || {}).listId;
    if (this.cachedLists && want && this.cachedLists.some(l => l.id === want)) return want;
    this.cachedLists = await this.lists();
    const l = this.cachedLists.find(x => x.id === want) || this.cachedLists.find(x => x.isDefault) || this.cachedLists[0];
    this.listName = l ? l.name : '';
    return l && l.id;
  }

  async sync() {
    if (!this.token) return;
    if (this.syncing) return;
    this.syncing = true;
    try {
      const id = await this.listId();
      if (!id) { this.emit({ status: 'ok', tasks: [], list: null }); return; }
      const name = (this.cachedLists.find(l => l.id === id) || {}).name || '';
      const d = await this.graph('GET', `/me/todo/lists/${encodeURIComponent(id)}/tasks?$top=100&$filter=${encodeURIComponent("status ne 'completed'")}`);
      const tasks = ((d && d.value) || []).map(t => ({
        id: t.id, title: t.title || '', done: t.status === 'completed', important: t.importance === 'high',
        due: t.dueDateTime && t.dueDateTime.dateTime ? t.dueDateTime.dateTime.slice(0, 10) : '', created: t.createdDateTime || '',
      }));
      // important first, then by due date, then newest first (like To Do's own list)
      tasks.sort((a, b) => (b.important - a.important) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) || (a.created < b.created ? 1 : -1));
      // tasks you just ticked stay visible (struck through) for a moment
      const keep = (this.state.tasks || []).filter(t => t.done && t.doneAt && Date.now() - t.doneAt < 8000 && !tasks.some(x => x.id === t.id));
      this.emit({ status: 'ok', tasks: [...tasks, ...keep], list: { id, name }, error: null, at: Date.now() });
    } catch (e) {
      this.log('todo sync: ' + e.message);
      if (this.token) this.emit({ status: this.state.tasks && this.state.tasks.length ? 'ok' : 'error', error: 'Could not reach Microsoft To Do' });
    } finally { this.syncing = false; }
  }

  async setDone(taskId, done) {
    const list = this.state.list; if (!list) return;
    this.emit({ tasks: this.state.tasks.map(t => t.id === taskId ? { ...t, done, doneAt: done ? Date.now() : 0 } : t) });   // show it right away
    try { await this.graph('PATCH', `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(taskId)}`, { status: done ? 'completed' : 'notStarted' }); }
    catch (e) { this.log('todo done: ' + e.message); }
    setTimeout(() => this.sync(), done ? 8500 : 300);
  }
  async setImportant(taskId, important) {
    const list = this.state.list; if (!list) return;
    this.emit({ tasks: this.state.tasks.map(t => t.id === taskId ? { ...t, important } : t) });
    try { await this.graph('PATCH', `/me/todo/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(taskId)}`, { importance: important ? 'high' : 'normal' }); }
    catch (e) { this.log('todo important: ' + e.message); }
    this.sync();
  }
  async add(title) {
    title = String(title || '').trim().slice(0, 255);
    const list = this.state.list; if (!title || !list) return;
    this.emit({ tasks: [{ id: 'new-' + Date.now(), title, done: false, important: false, due: '', pending: true }, ...this.state.tasks] });
    try { await this.graph('POST', `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`, { title }); }
    catch (e) { this.log('todo add: ' + e.message); }
    this.sync();
  }

  start() {
    if (this.timer || !this.token) return;
    this.timer = setInterval(() => this.sync(), 60 * 1000);   // changes from your phone show up within a minute
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  listChanged() { this.cachedLists = null; this.sync(); }
}

module.exports = { Todo };
