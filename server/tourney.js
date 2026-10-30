// Daily + weekly play-chip tournaments. Opt-in registration list, scheduled start in America/Los_Angeles,
// escalating blinds, hand-for-hand table play with balancing/final table, results + winners board. No cash prizes.
const { Table, NSEATS } = require('./table');
const { parts, ptToUtc } = require('./time');

const KINDS = {
  daily: { label: 'Daily Cruise', dow: null, hour: 19, min: 0, levelMin: 5, when: 'every day · 7:00 PM PT' },
  weekly: { label: 'Weekly Main Event', dow: 6, hour: 18, min: 0, levelMin: 8, when: 'every Saturday · 6:00 PM PT' },
};
const LEVELS = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [500, 1000], [750, 1500], [1000, 2000], [1500, 3000], [2500, 5000]];
const STACK = 1000, MIN_PLAYERS = 2, SEAT_ORDER = [0, 3, 1, 4, 2, 5];
const ord = n => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 < 4 ? n % 10 : 0]); };
const pad = n => String(n).padStart(2, '0');

function nextStart(kind, afterMs) {
  const K = KINDS[kind], p = parts(afterMs), base = Date.UTC(p.y, p.mo - 1, p.d);
  for (let i = 0; i < 10; i++) {
    const x = new Date(base + i * 86400000);
    if (K.dow !== null && x.getUTCDay() !== K.dow) continue;
    const t = ptToUtc(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), K.hour, K.min);
    if (t >= afterMs) return t;
  }
  throw new Error('no start');
}
const dateId = (kind, startMs) => { const p = parts(startMs + 60000); return `${kind}-${p.y}-${pad(p.mo)}-${pad(p.d)}`; };

class Tournaments {
  constructor(room, db, cfg = {}) {
    this.room = room; this.db = db; this.cur = {}; this.lateMs = cfg.lateMs ?? 10 * 60000; this.levelMs = cfg.levelMs || null; this.cfg = cfg;
    this.timing = cfg.timing || {}; this.timer = null;
  }
  async init() {
    for (const k of Object.keys(KINDS)) this.cur[k] = await this._make(k, Date.now() - this.lateMs);
    try { const rows = await this.db.recent(); this.room.winners = rows.map(r => ({ id: r.id, kind: r.kind, label: KINDS[r.kind] ? KINDS[r.kind].label : r.kind, winner: r.winner, entrants: r.entrants, finishedAt: new Date(r.finished_at).getTime() })); } catch {}
    this.timer = setInterval(() => this.tick().catch(e => console.error('tick', e)), 1000);
  }
  async _make(kind, after) {
    for (let n = 0; n < 5; n++) {
      const startAt = nextStart(kind, after), id = dateId(kind, startAt);
      const row = await this.db.getTournament(id);
      if (row && row.status !== 'registering') { after = startAt + 1; continue; }
      const t = { id, kind, label: KINDS[kind].label, startAt, status: 'registering', regs: new Map(), tables: [], level: 0, levelEnds: 0, results: [], told: {}, remaining: 0, entrants: 0 };
      for (const r of await this.db.regs(id)) t.regs.set(r.hash, { hash: r.hash, name: r.name });
      await this.db.saveTournament(t); this.room.dirtyLobby = true; return t;
    }
    throw new Error('cannot schedule');
  }
  close() { clearInterval(this.timer); for (const t of Object.values(this.cur)) if (t) for (const tb of t.tables) tb.destroy(); }

  // ---------- public ----------
  publicList() {
    return Object.values(this.cur).map(t => {
      const regs = [...t.regs.values()].map(r => { const p = this.room.players.get(r.hash); return { name: p ? p.name : r.name, pid: p ? p.pid : null }; });
      const o = { kind: t.kind, id: t.id, label: t.label, when: KINDS[t.kind].when, startAt: t.startAt, status: t.status, regCount: t.regs.size, regs, minPlayers: MIN_PLAYERS, stack: STACK, levelMin: KINDS[t.kind].levelMin };
      if (t.status === 'running' || t.status === 'finishing') { o.level = t.level + 1; o.blinds = LEVELS[t.level]; o.nextBlinds = LEVELS[Math.min(t.level + 1, LEVELS.length - 1)]; o.levelEnds = t.levelEnds; o.remaining = t.remaining; o.entrants = t.entrants; o.tables = t.tables.map(tb => ({ id: tb.id, name: tb.name, n: tb.count() })); o.results = t.results.slice().sort((a, b) => a.place - b.place).slice(0, 5); }
      return o;
    });
  }
  isRegistered(p, kind) { const t = this.cur[kind]; return !!(t && t.regs.has(p.hash)); }
  register(p, kind) {
    const t = this.cur[kind]; if (!t) return 'No such tournament';
    if (t.status !== 'registering') return 'Registration is closed';
    if (t.regs.size >= 25 && !t.regs.has(p.hash)) return 'Tournament is full';
    t.regs.set(p.hash, { hash: p.hash, name: p.name }); this.db.addReg(t.id, p.hash, p.name); this.room.dirtyLobby = true; return null;
  }
  unregister(p, kind) { const t = this.cur[kind]; if (!t || t.status !== 'registering') return 'Registration is closed'; t.regs.delete(p.hash); this.db.delReg(t.id, p.hash); this.room.dirtyLobby = true; return null; }
  // test/admin helper: bring the start time forward
  forceStart(kind, delayMs) { const t = this.cur[kind]; if (t && t.status === 'registering') { t.startAt = Date.now() + delayMs; this.room.dirtyLobby = true; } }

  // ---------- scheduler ----------
  async tick() {
    const now = Date.now();
    for (const t of Object.values(this.cur)) {
      if (t.status !== 'registering') continue;
      const left = t.startAt - now;
      if (left <= 600000 && left > 0 && !t.told.m10 && t.regs.size) { t.told.m10 = 1; this.room.sys(`${t.label} starts in ${Math.ceil(left / 60000)} min — ${t.regs.size} registered. Sign up in the lobby!`); }
      if (left <= 60000 && left > 0 && !t.told.m1 && t.regs.size) { t.told.m1 = 1; this.room.sys(`${t.label} starts in 1 minute. Registered players: stay in the room!`); }
      if (left <= 0) {
        const here = [...t.regs.values()].map(r => this.room.players.get(r.hash)).filter(p => p && p.connected);
        if (here.length >= MIN_PLAYERS) this.start(t, here);
        else if (now > t.startAt + this.lateMs) await this.cancel(t);
        else if (!t.told.wait) { t.told.wait = 1; this.room.sys(`${t.label}: waiting for at least ${MIN_PLAYERS} registered players to be in the room…`); }
      }
    }
  }
  async cancel(t) {
    t.status = 'cancelled'; await this.db.saveTournament({ ...t, entrants: 0 });
    this.room.sys(`${t.label} cancelled: not enough registered players. Next one is open for sign-up.`);
    this.cur[t.kind] = await this._make(t.kind, Math.max(Date.now(), t.startAt + 1));
  }
  start(t, players) {
    t.status = 'running'; t.entrants = players.length; t.remaining = players.length; t.level = 0;
    const lvMs = this.levelMs || KINDS[t.kind].levelMin * 60000; t.levelMs = lvMs; t.levelEnds = Date.now() + lvMs;
    for (const [h] of t.regs) if (!players.some(p => p.hash === h)) { t.regs.delete(h); this.db.delReg(t.id, h); }
    for (const p of players) if (p.tableId) this.room.standUp(p);
    const arr = players.slice().sort(() => Math.random() - 0.5);
    const nt = Math.ceil(arr.length / NSEATS), tables = [];
    for (let k = 0; k < nt; k++) tables.push(this._newTable(t, k + 1));
    arr.forEach((p, i) => { const tb = tables[i % nt]; const used = tb.count(); tb.sit(p, SEAT_ORDER[used], STACK); this._attach(p, tb); });
    t.tables = tables;
    this.db.saveTournament(t);
    this.room.sys(`🏁 ${t.label} is underway: ${t.entrants} players, ${STACK} chips each. Good luck!`);
    setTimeout(() => { for (const tb of t.tables) tb.startHand(); }, this.timing.firstHandMs ?? 4000);
  }
  _newTable(t, k) {
    const tb = new Table({ id: `${t.id}-${k}`, name: `${t.label} · Table ${k}`, kind: 'tourney', sb: LEVELS[0][0], bb: LEVELS[0][1], actionMs: 20000, ...this.timing,
      hooks: { update: x => this.room.hooks().update(x), handEnd: x => this.onHandEnd(t, x) } });
    tb.meta = () => ({ tid: t.id, label: t.label, level: t.level + 1, levelEnds: t.levelEnds, remaining: t.remaining, entrants: t.entrants, next: LEVELS[Math.min(t.level + 1, LEVELS.length - 1)] });
    this.room.tables.set(tb.id, tb); return tb;
  }
  _attach(p, tb) { p.tableId = tb.id; p.viewing = tb.id; this.room.send(p, { t: 'goto', table: tb.id }); this.room.dirtyTables.add(tb.id); }

  // ---------- running ----------
  onHandEnd(t, tb) {
    if (t.status !== 'running') return;
    if (!t.tables.every(x => x.phase === 'idle')) return;
    this.round(t);
  }
  round(t) {
    const total = t.tables.reduce((a, x) => a + x.count(), 0); const busted = [];
    for (const tb of t.tables) tb.seats.forEach((s, i) => { if (s && s.chips <= 0) busted.push({ tb, i, s }); });
    busted.sort((a, b) => a.s.startChips - b.s.startChips || Math.random() - 0.5);
    busted.forEach((b, k) => { const place = total - k; const p = b.s.p; b.tb.unseat(b.i); t.results.push({ place, name: p.name }); if (p.tableId === b.tb.id) p.tableId = null; if (p.viewing === b.tb.id) p.viewing = null;
      this.room.send(p, { t: 'out', place, label: t.label, text: `You finished ${ord(place)} in the ${t.label}.` }); this.room.dirtyTables.add(b.tb.id); });
    t.remaining = total - busted.length;
    if (busted.length) this.room.sys(`${busted.map(b => b.s.p.name).join(', ')} eliminated (${t.remaining} left).`);
    if (t.remaining <= 1) return this.finish(t);
    if (Date.now() >= t.levelEnds) { t.level = Math.min(t.level + 1, LEVELS.length - 1); t.levelEnds = Date.now() + t.levelMs; for (const tb of t.tables) tb.setBlinds(...LEVELS[t.level]); this.room.sys(`${t.label}: blinds up to ${LEVELS[t.level][0]}/${LEVELS[t.level][1]}.`); }
    this.rebalance(t);
    this.room.dirtyLobby = true;
    setTimeout(() => { if (t.status === 'running') for (const tb of t.tables) tb.startHand(); }, this.timing.betweenHandsMs ?? 3500);
  }
  rebalance(t) {
    const need = Math.ceil(t.remaining / NSEATS);
    const move = (from, to) => { const idxs = from.seats.map((s, i) => (s ? i : -1)).filter(i => i >= 0); const i = idxs[Math.floor(Math.random() * idxs.length)]; const free = to.seats.map((s, j) => (s ? -1 : j)).filter(j => j >= 0); const j = SEAT_ORDER.find(x => free.includes(x)) ?? free[0]; const s = from.unseat(i); to.seats[j] = s; this._attach(s.p, to); to._say(`${s.p.name} joined the table`); };
    while (t.tables.length > need) {
      t.tables.sort((a, b) => a.count() - b.count()); const brk = t.tables.shift();
      while (brk.count()) { const dest = t.tables.slice().sort((a, b) => a.count() - b.count())[0]; move(brk, dest); }
      this.room.tables.delete(brk.id); brk.destroy(); this.room.sys(`Table ${brk.name.split('· ')[1]} broken; players moved.`);
    }
    for (let g = 0; g < 20; g++) { const s = t.tables.slice().sort((a, b) => a.count() - b.count()); const lo = s[0], hi = s[s.length - 1]; if (hi.count() - lo.count() < 2) break; move(hi, lo); }
    for (const tb of t.tables) this.room.dirtyTables.add(tb.id);
  }
  finish(t) {
    t.status = 'finishing';
    const w = t.tables.map(tb => tb.seats.find(Boolean)).find(Boolean);
    const winner = w ? w.p.name : '—';
    t.results.push({ place: 1, name: winner }); t.winner = winner; t.finishedAt = Date.now();
    const rec = { id: t.id, kind: t.kind, label: t.label, winner, entrants: t.entrants, finishedAt: t.finishedAt };
    this.room.winners.unshift(rec); if (this.room.winners.length > 30) this.room.winners.pop();
    this.room.sys(`🏆 ${winner} wins the ${t.label}! (${t.entrants} players, play chips only)`);
    if (w) { this.room.send(w.p, { t: 'out', place: 1, label: t.label, text: `🏆 You won the ${t.label}!` }); }
    t.status = 'done'; t.remaining = 0;
    this.db.saveTournament(t); this.db.saveResults(t.id, t.results);
    this.room.dirtyLobby = this.room.dirtyBoard = true;
    this.room.lastBoard = 0;
    const tables = t.tables; t.tables = [];
    setTimeout(() => {
      for (const tb of tables) { for (const s of tb.seats) if (s) { const p = s.p; if (p.tableId === tb.id) p.tableId = null; if (p.viewing === tb.id) p.viewing = null; } this.room.tables.delete(tb.id); tb.destroy(); }
      this.room.dirtyLobby = true;
    }, this.timing.endLingerMs ?? 15000);
    this._make(t.kind, Math.max(Date.now(), t.startAt + 1)).then(n => { this.cur[t.kind] = n; this.room.dirtyLobby = true; }).catch(e => console.error(e));
  }
}
module.exports = { Tournaments, nextStart, KINDS, LEVELS, dateId };
