// The room: connected players (cap 25), 7 cash tables x 6 seats, chat, live leaderboard, tournaments.
const crypto = require('crypto');
const { Table, NSEATS } = require('./table');
const { cleanName, cleanChat } = require('./filter');

const ROOM_CAP = 25, START_CHIPS = 1000;
const CASH_TABLES = [
  ['Bug Bay', 5, 10], ['Bus Stop', 5, 10], ['Ghia Garage', 10, 20], ['Thing Thursday', 10, 20],
  ['Baja Bash', 10, 20], ['Split-Window Lounge', 25, 50], ['209 High Rollers', 25, 50],
];
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Custom avatars are re-broadcast to everyone in the room, so keep them tiny (~4 KB as a data URL; the client resizes to fit).
const AV_MAX_BYTES = 3000, AV_MAX_CHARS = 4100;
const AV_RE = /^p:(?:[0-9]|1[0-1])$/;

function validAvatar(a) {
  if (typeof a !== 'string') return null;
  if (AV_RE.test(a)) return a;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(a);
  if (!m || a.length > AV_MAX_CHARS) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > AV_MAX_BYTES) return null;
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && buf.slice(0, 4).toString('hex') === '89504e47') || (m[1] === 'webp' && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
  return ok ? a : null;
}

class Room {
  constructor(opts = {}) {
    this.opts = opts; this.players = new Map(); this.byName = new Map(); this.tables = new Map(); this.chat = []; this.chatId = 0;
    this.dirtyLobby = false; this.dirtyBoard = false; this.dirtyTables = new Set(); this.tourney = null; this.winners = [];
    const T = opts.timing || {};
    CASH_TABLES.forEach(([name, sb, bb], i) => {
      const id = 't' + (i + 1);
      this.tables.set(id, new Table({ id, name, kind: 'cash', sb, bb, hooks: this._hooks(), ...T }));
    });
    this.timer = setInterval(() => this.flush(), 120);
    this.sweeper = setInterval(() => this.sweep(), 5000);
  }
  _hooks() { return { update: t => { this.dirtyTables.add(t.id); this.dirtyLobby = true; this.dirtyBoard = true; }, gone: (t, gone) => this.onGone(t, gone) }; }
  hooks() { return this._hooks(); }
  onlineCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  // ---------- profiles / connections ----------
  hello(ws, msg) {
    const token = typeof msg.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(msg.token) ? msg.token : null;
    if (!token) return { err: 'Bad session token' };
    const hash = sha(token); let p = this.players.get(hash);
    const name = cleanName(msg.name); const avatar = validAvatar(msg.avatar);
    if (!name) return { err: 'Pick a username of 3-14 letters/numbers (spaces, _ and - ok). Keep it clean.' };
    if (!avatar) return { err: 'Pick an avatar (or upload a small image, max about 3 KB).' };
    const key = name.toLowerCase(); const owner = this.byName.get(key);
    if (owner && owner !== hash) { const op = this.players.get(owner); if (op && (op.connected || Date.now() - op.lastSeen < 6 * 3600e3)) return { err: 'That username is taken, try another.' }; }
    if (!p || !p.connected) { if (this.onlineCount() >= ROOM_CAP) return { err: 'room full', full: true }; }
    if (!p) { p = { pid: crypto.randomBytes(4).toString('hex'), hash, name, avatar, bankroll: START_CHIPS, connected: false, ws: null, tableId: null, viewing: null, lastSeen: Date.now(), reloads: 0 }; this.players.set(hash, p); }
    if (p.ws && p.ws !== ws) { try { p.ws.send(JSON.stringify({ t: 'kicked', msg: 'Signed in from another tab or device.' })); p.ws.close(4000); } catch {} p.ws.player = null; }
    if (p.name.toLowerCase() !== key) { if (this.byName.get(p.name.toLowerCase()) === hash) this.byName.delete(p.name.toLowerCase()); }
    p.name = name; p.avatar = avatar; this.byName.set(key, hash);
    p.ws = ws; ws.player = p; p.connected = true; p.lastSeen = Date.now();
    // update display names on any table seat (same object ref) automatically; refresh profile for others
    this.dirtyLobby = this.dirtyBoard = true; if (p.tableId) this.dirtyTables.add(p.tableId);
    return { p };
  }
  disconnect(ws) {
    const p = ws.player; if (!p || p.ws !== ws) return;
    p.connected = false; p.ws = null; p.lastSeen = Date.now(); p.discAt = Date.now(); p.viewing = p.tableId ? p.tableId : null;
    if (p.tableId) this.dirtyTables.add(p.tableId);
    this.dirtyLobby = this.dirtyBoard = true;
  }
  send(p, o) { if (p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(o)); } catch {} } }
  bcast(o) { const s = JSON.stringify(o); for (const p of this.players.values()) if (p.connected && p.ws && p.ws.readyState === 1) { try { p.ws.send(s); } catch {} } }
  sweep() {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.connected && p.tableId) { const t = this.tables.get(p.tableId); if (t && t.kind === 'cash' && now - p.discAt > 45000) this.standUp(p); }
    }
    for (const [h, p] of this.players) if (!p.connected && now - p.lastSeen > 6 * 3600e3 && !p.tableId) { this.players.delete(h); if (this.byName.get(p.name.toLowerCase()) === h) this.byName.delete(p.name.toLowerCase()); }
  }

  // ---------- seating ----------
  watch(p, id) { const t = this.tables.get(id); if (!t) return 'No such table'; if (p.tableId && p.tableId !== id) return 'Leave your table first'; p.viewing = id; this.dirtyTables.add(id); return null; }
  sit(p, id, seat) {
    const t = this.tables.get(id); if (!t || t.kind !== 'cash') return 'No such table';
    if (p.tableId) return 'You are already seated';
    if (seat === -1) { seat = [0, 3, 1, 4, 2, 5].find(i => !t.seats[i]); if (seat === undefined) return 'Table is full'; }
    if (!Number.isInteger(seat) || seat < 0 || seat >= NSEATS) return 'Bad seat';
    if (t.seats[seat]) return 'Seat taken';
    if (p.bankroll <= 0) { p.bankroll = START_CHIPS; p.reloads++; }
    const chips = p.bankroll;
    if (!t.sit(p, seat, chips)) return 'Could not sit';
    p.bankroll = 0; p.tableId = id; p.viewing = id; this.dirtyBoard = true; return null;
  }
  standUp(p) {
    const t = p.tableId && this.tables.get(p.tableId);
    if (t) {
      if (t.kind === 'tourney') { const i = t.seatOf(p); if (i >= 0) t.seats[i].sitOut = true; p.viewing = null; this.dirtyTables.add(t.id); return; }
      const r = t.stand(p); p.bankroll += r.chips; if (!r.deferred) p.tableId = null;
    }
    p.viewing = null; this.dirtyLobby = this.dirtyBoard = true;
  }
  onGone(t, gone) {
    for (const g of gone) {
      const p = g.p; p.bankroll += g.chips; if (p.tableId === t.id) p.tableId = null;
      if (g.why === 'bust') { p.bankroll = START_CHIPS; p.reloads++; this.send(p, { t: 'toast', msg: `Busted at ${t.name}! Free reload: ${START_CHIPS} play chips. Sit back down any time.` }); }
      if (p.viewing === t.id) this.dirtyTables.add(t.id);
    }
    this.dirtyBoard = true;
  }
  back(p) { const t = p.tableId && this.tables.get(p.tableId); if (!t) return; const i = t.seatOf(p); if (i < 0) return; const s = t.seats[i]; s.sitOut = false; s.timeouts = 0; t.maybeStart(); t._upd(); }

  // ---------- chat ----------
  say(p, text) {
    const t = cleanChat(text); if (!t) return;
    const m = { id: ++this.chatId, ts: Date.now(), pid: p.pid, name: p.name, text: t };
    this.chat.push(m); if (this.chat.length > 60) this.chat.shift(); this.bcast({ t: 'chat', m });
  }
  sys(text) { const m = { id: ++this.chatId, ts: Date.now(), name: 'VW FEST', text, sys: true }; this.chat.push(m); if (this.chat.length > 60) this.chat.shift(); this.bcast({ t: 'chat', m }); }

  // ---------- views ----------
  profile(p) { return { pid: p.pid, name: p.name, avatar: p.avatar }; }
  lobby() {
    const tables = []; for (const t of this.tables.values()) if (t.kind === 'cash') tables.push({ id: t.id, name: t.name, sb: t.sb, bb: t.bb, seated: t.count(), max: NSEATS, hand: t.handActive(), players: t.seats.filter(Boolean).map(s => s.p.pid) });
    return { t: 'lobby', online: this.onlineCount(), cap: ROOM_CAP, tables, tourneys: this.tourney ? this.tourney.publicList() : [], now: Date.now() };
  }
  board() {
    const live = []; for (const p of this.players.values()) if (p.connected) { let c = p.bankroll; const t = p.tableId && this.tables.get(p.tableId); if (t && t.kind === 'cash') { const i = t.seatOf(p); if (i >= 0) c += t.seats[i].chips; } live.push({ pid: p.pid, name: p.name, chips: c, tourney: !!(t && t.kind === 'tourney') }); }
    live.sort((a, b) => b.chips - a.chips);
    return { t: 'board', live: live.slice(0, 25), winners: this.winners.slice(0, 12), top: this.topWinners() };
  }
  topWinners() { const m = new Map(); for (const w of this.winners) { const k = w.winner; if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([name, wins]) => ({ name, wins })).sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, 8); }
  profilesFor(ids) { const out = []; for (const p of this.players.values()) if (ids.has(p.pid)) out.push(this.profile(p)); return out; }
  tableView(t, p) { const v = t.getView(p); if (t.meta) v.meta = typeof t.meta === 'function' ? t.meta() : t.meta; return v; }

  flush() {
    if (this.dirtyTables.size) {
      const ids = [...this.dirtyTables]; this.dirtyTables.clear();
      for (const id of ids) { const t = this.tables.get(id); if (!t) continue;
        for (const p of this.players.values()) if (p.connected && p.viewing === id) this.send(p, { t: 'table', v: this.tableView(t, p) }); }
    }
    if (this.dirtyLobby) { this.dirtyLobby = false; this.bcast(this.lobby()); }
    if (this.dirtyBoard && Date.now() - (this.lastBoard || 0) > 1500) { this.dirtyBoard = false; this.lastBoard = Date.now(); this.bcast(this.board()); }
  }
  // everything the client needs when it first connects
  welcome(p) {
    const profiles = [...this.players.values()].filter(x => x.connected || x.tableId).map(x => this.profile(x));
    this.send(p, { t: 'welcome', you: { pid: p.pid, name: p.name, avatar: p.avatar, bankroll: p.bankroll }, profiles, chat: this.chat.slice(-40), cap: ROOM_CAP });
    this.send(p, this.lobby()); this.send(p, this.board());
    if (p.tableId || p.viewing) { const t = this.tables.get(p.tableId || p.viewing); if (t) { p.viewing = t.id; this.send(p, { t: 'table', v: this.tableView(t, p) }); } }
    this.bcast({ t: 'profile', p: this.profile(p) });
  }
  close() { clearInterval(this.timer); clearInterval(this.sweeper); for (const t of this.tables.values()) t.destroy(); }
}
module.exports = { Room, ROOM_CAP, START_CHIPS, validAvatar };
