// Authoritative Texas Hold'em table (no networking in here). Cards live only on the server;
// getView(p) is the ONLY thing clients ever see and it hides every hole card except the viewer's own
// (others' are revealed only when they actually go to showdown / run-out).
const { shuffledDeck, cardStr, best, describe } = require('./cards');
const NSEATS = 6;
const STREETS = ['preflop', 'flop', 'turn', 'river'];

class Table {
  constructor(o) {
    this.id = o.id; this.name = o.name; this.kind = o.kind || 'cash';
    this.sb = o.sb; this.bb = o.bb; this.nextSb = o.sb; this.nextBb = o.bb;
    this.actionMs = o.actionMs || 25000; this.pauseMs = o.pauseMs ?? 3000; this.showdownMs = o.showdownMs ?? 6500; this.stepMs = o.stepMs ?? 1400;
    this.hooks = o.hooks || {};
    this.seats = Array(NSEATS).fill(null);
    this.phase = 'idle'; this.handN = 0; this.dealer = -1; this.board = []; this.deck = []; this.cur = -1;
    this.currentBet = 0; this.minRaise = this.bb; this.deadline = 0; this.t = null; this.last = null; this.log = []; this.lastRaiser = -1;
  }
  // ---------- helpers ----------
  _say(s) { this.log.push(s); if (this.log.length > 40) this.log.shift(); }
  _t(fn, ms) { clearTimeout(this.t); this.t = setTimeout(() => { this.t = null; try { fn(); } catch (e) { console.error('table timer', this.id, e); } }, ms); }
  _upd() { this.hooks.update && this.hooks.update(this); }
  seatOf(p) { return this.seats.findIndex(s => s && s.p === p); }
  count() { return this.seats.filter(Boolean).length; }
  inHand(s) { return s && s.cards.length > 0 && !s.folded; }
  _live() { return this.seats.map((s, i) => [s, i]).filter(([s]) => this.inHand(s)).map(([, i]) => i); }
  _canAct(s) { return this.inHand(s) && !s.allIn && s.chips > 0; }
  pot() { return this.seats.reduce((a, s) => a + (s ? s.total : 0), 0); }
  setBlinds(sb, bb) { this.nextSb = sb; this.nextBb = bb; if (this.phase === 'idle') { this.sb = sb; this.bb = bb; } }
  handActive() { return this.phase !== 'idle' && this.phase !== 'over'; }

  // ---------- seating ----------
  sit(p, idx, chips) {
    if (!(idx >= 0 && idx < NSEATS) || this.seats[idx] || this.seatOf(p) >= 0 || !(chips > 0)) return false;
    this.seats[idx] = { p, chips: Math.floor(chips), bet: 0, total: 0, folded: false, allIn: false, cards: [], needsAct: false, canRaise: true, sitOut: false, leaving: false, timeouts: 0, reveal: false, startChips: 0, handName: '' };
    this._say(`${p.name} sat down`); this._upd(); this.maybeStart(); return true;
  }
  // stand up: returns chips handed back now (0 if in a live hand: they fold and chips are returned after the hand)
  stand(p) {
    const i = this.seatOf(p); if (i < 0) return { chips: 0, deferred: false };
    const s = this.seats[i];
    if (this.handActive() && s.cards.length) {
      s.leaving = true;
      if (!s.folded) { if (this.phase !== 'over' && this.cur === i) this._doFold(i, true); else if (this.phase !== 'over') { s.folded = true; s.needsAct = false; this._say(`${p.name} left (folds)`); this._checkAfterOffTurn(); } }
      this._upd(); return { chips: 0, deferred: true };
    }
    const c = s.chips; this.seats[i] = null; this._say(`${p.name} left`); this._upd();
    return { chips: c, deferred: false };
  }
  unseat(i) { const s = this.seats[i]; this.seats[i] = null; return s; }
  _checkAfterOffTurn() {
    const live = this._live();
    if (live.length === 1 && this.phase !== 'over') this._awardUncontested(live[0]);
  }

  // ---------- hand lifecycle ----------
  maybeStart() {
    if (this.kind !== 'cash' || this.phase !== 'idle' || this.t) return;
    const n = this.seats.filter(s => s && s.chips > 0 && !s.sitOut).length;
    if (n >= 2) this._t(() => this.startHand(), this.pauseMs);
  }
  startHand() {
    if (this.handActive()) return false;
    const elig = [];
    this.seats.forEach((s, i) => { if (s && s.chips > 0 && (this.kind === 'tourney' || !s.sitOut)) elig.push(i); });
    if (elig.length < 2) { this.phase = 'idle'; this._upd(); return false; }
    this.sb = this.nextSb; this.bb = this.nextBb;
    this.handN++; this.board = []; this.deck = shuffledDeck(); this.last = null;
    for (const s of this.seats) if (s) { s.bet = 0; s.total = 0; s.folded = false; s.allIn = false; s.cards = []; s.reveal = false; s.handName = ''; s.needsAct = false; s.canRaise = true; }
    const after = (i) => { for (let k = 1; k <= NSEATS; k++) { const j = (i + k) % NSEATS; if (elig.includes(j)) return j; } return i; };
    this.dealer = this.dealer < 0 ? elig[Math.floor(Math.random() * elig.length)] : after(this.dealer);
    const sbI = elig.length === 2 ? this.dealer : after(this.dealer), bbI = after(sbI);
    for (const i of elig) { const s = this.seats[i]; s.startChips = s.chips; s.cards = [this.deck.pop(), this.deck.pop()]; }
    this.phase = 'preflop'; this.currentBet = 0; this.minRaise = this.bb;
    this._post(sbI, this.sb); this._post(bbI, this.bb);
    this.currentBet = Math.max(this.seats[sbI].bet, this.seats[bbI].bet); this.sbSeat = sbI; this.bbSeat = bbI;
    this._say(`— Hand #${this.handN} · blinds ${this.sb}/${this.bb} —`);
    for (const i of elig) { const s = this.seats[i]; s.needsAct = this._canAct(s); }
    this._beginBetting(bbI);
    return true;
  }
  _post(i, amt) { const s = this.seats[i], a = Math.min(amt, s.chips); s.chips -= a; s.bet += a; s.total += a; if (s.chips === 0) s.allIn = true; }
  _noBetting() {
    const ca = this.seats.filter(s => this._canAct(s));
    return ca.length === 0 || (ca.length === 1 && ca[0].bet >= this.currentBet);
  }
  _beginBetting(from) {
    if (this._noBetting()) { this._revealAllLive(); this.cur = -1; this.deadline = 0; this._upd(); return this._t(() => this._advance(), this.stepMs); }
    this.cur = this._nextToAct(from); this._setTurn();
  }
  _revealAllLive() { for (const s of this.seats) if (this.inHand(s)) s.reveal = true; }
  _nextToAct(from) { for (let k = 1; k <= NSEATS; k++) { const j = ((from < 0 ? NSEATS - 1 : from) + k) % NSEATS, s = this.seats[j]; if (s && this._canAct(s) && s.needsAct) return j; } return -1; }
  _setTurn() {
    const s = this.seats[this.cur]; this.deadline = Date.now() + this.actionMs; this._upd();
    const away = !s.p.connected || s.sitOut;
    this._t(() => this._timeout(), away ? 1300 : this.actionMs);
    if (away) this.deadline = Date.now() + 1300;
  }
  _timeout() {
    const i = this.cur, s = this.seats[i]; if (i < 0 || !s) return;
    const away = !s.p.connected || s.sitOut;
    if (!away) { s.timeouts++; if (s.timeouts >= 2 && this.kind === 'cash') { s.sitOut = true; this._say(`${s.p.name} is sitting out (timed out)`); } }
    const toCall = this.currentBet - s.bet;
    if (toCall <= 0) this._doCheck(i, true); else this._doFold(i, true);
  }

  // ---------- player actions ----------
  act(p, a, amt) {
    const i = this.seatOf(p); if (i < 0 || i !== this.cur || !this.handActive()) return 'Not your turn';
    const s = this.seats[i], toCall = this.currentBet - s.bet;
    amt = Math.floor(+amt);
    if (a === 'fold') { this._doFold(i); return null; }
    if (a === 'check') { if (toCall > 0) return 'Cannot check'; this._doCheck(i); return null; }
    if (a === 'call') { if (toCall <= 0) { this._doCheck(i); return null; } this._doCall(i); return null; }
    if (a === 'allin') { if (!s.canRaise && s.chips > toCall) return 'Betting is not re-opened, call or fold'; this._doRaise(i, s.bet + s.chips); return null; }
    if (a === 'raise') {
      if (!s.canRaise) return 'Betting is not re-opened, call or fold';
      if (!Number.isFinite(amt)) return 'Bad amount';
      const maxTo = s.bet + s.chips, minTo = this.currentBet + this.minRaise;
      if (amt > maxTo) return 'Not enough chips';
      if (amt < minTo && amt < maxTo) return `Minimum raise is to ${minTo}`;
      if (amt <= this.currentBet && amt < maxTo) return 'Bad amount';
      this._doRaise(i, amt); return null;
    }
    return 'Unknown action';
  }
  _doFold(i, auto) { const s = this.seats[i]; s.folded = true; s.needsAct = false; if (!auto) s.timeouts = 0; this._say(`${s.p.name} folds${auto ? ' (auto)' : ''}`); this._after(i); }
  _doCheck(i, auto) { const s = this.seats[i]; s.needsAct = false; if (!auto) s.timeouts = 0; this._say(`${s.p.name} checks${auto ? ' (auto)' : ''}`); this._after(i); }
  _doCall(i) { const s = this.seats[i], amt = Math.min(this.currentBet - s.bet, s.chips); s.chips -= amt; s.bet += amt; s.total += amt; s.needsAct = false; s.timeouts = 0; if (!s.chips) s.allIn = true; this._say(`${s.p.name} ${s.allIn ? 'is all-in' : 'calls'} ${amt}`); this._after(i); }
  _doRaise(i, to) {
    const s = this.seats[i]; const add = to - s.bet; const size = to - this.currentBet;
    if (to <= this.currentBet) return this._doCall(i);
    const wasBet = this.currentBet === 0;
    s.chips -= add; s.bet = to; s.total += add; s.needsAct = false; s.timeouts = 0; if (!s.chips) s.allIn = true;
    const full = size >= this.minRaise;
    for (let j = 0; j < NSEATS; j++) { if (j === i) continue; const o = this.seats[j]; if (!o || !this._canAct(o)) continue;
      if (full) { o.needsAct = true; o.canRaise = true; } else { if (!o.needsAct) o.canRaise = false; o.needsAct = true; } }
    if (full) this.minRaise = size;
    this.currentBet = to; this.lastRaiser = i;
    this._say(`${s.p.name} ${s.allIn ? 'is all-in' : wasBet ? 'bets' : 'raises'} to ${to}`); this._after(i);
  }
  _after(i) {
    this.cur = -1; this.deadline = 0;
    const live = this._live();
    if (live.length === 1) return this._awardUncontested(live[0]);
    const nxt = this._nextToAct(i);
    if (nxt >= 0) { this.cur = nxt; return this._setTurn(); }
    this._endRound();
  }
  _endRound() {
    // return any uncalled excess to the top contributor
    const arr = this.seats.map((s, i) => [s, i]).filter(([s]) => s && s.total > 0).sort((a, b) => b[0].total - a[0].total);
    if (arr.length >= 1) { const second = arr.length > 1 ? arr[1][0].total : 0, top = arr[0][0]; if (top.total > second) { const ex = top.total - second; top.total -= ex; top.chips += ex; top.bet -= Math.min(top.bet, ex); if (top.chips > 0) top.allIn = false; } }
    for (const s of this.seats) if (s) { s.bet = 0; s.needsAct = false; }
    this.currentBet = 0; this.minRaise = this.bb; this.cur = -1; this.deadline = 0; this.lastRaiser = -1;
    if (this.phase === 'river') return this._showdown();
    if (this._noBetting()) this._revealAllLive();
    this._upd();
    if (this._noBetting()) return this._t(() => this._advance(), this.stepMs);
    this._advance();
  }
  _advance() {
    if (this.phase === 'river') return this._endRound();
    const ph = STREETS[STREETS.indexOf(this.phase) + 1];
    this.deck.pop(); // burn
    const n = ph === 'flop' ? 3 : 1; for (let k = 0; k < n; k++) this.board.push(this.deck.pop());
    this.phase = ph; this.currentBet = 0; this.minRaise = this.bb;
    for (const s of this.seats) if (s) { s.bet = 0; s.canRaise = true; s.needsAct = this._canAct(s); }
    this._say(`${ph.toUpperCase()}: ${this.board.map(cardStr).join(' ')}`);
    if (this._noBetting()) { for (const s of this.seats) if (s) s.needsAct = false; this._revealAllLive(); this.cur = -1; this._upd(); return this._t(() => this.phase === 'river' ? this._showdown() : this._advance(), this.stepMs); }
    this.cur = this._nextToAct(this.dealer); this._setTurn();
  }

  // ---------- settlement ----------
  _pots() {
    const rem = this.seats.map(s => (s ? s.total : 0));
    const pots = [];
    for (;;) {
      const elig = this.seats.map((s, i) => [s, i]).filter(([s, i]) => s && this.inHand(s) && rem[i] > 0);
      if (!elig.length) break;
      const cap = Math.min(...elig.map(([, i]) => rem[i]));
      let amt = 0; const who = elig.map(([, i]) => i);
      for (let i = 0; i < NSEATS; i++) { const t = Math.min(rem[i], cap); amt += t; rem[i] -= t; }
      pots.push({ amount: amt, elig: who });
    }
    const left = rem.reduce((a, b) => a + b, 0);
    if (left > 0) { if (pots.length) pots[pots.length - 1].amount += left; else pots.push({ amount: left, elig: this._live() }); }
    return pots;
  }
  _awardUncontested(i) {
    clearTimeout(this.t); this.t = null;
    for (const s of this.seats) if (s) s.bet = 0;
    const s = this.seats[i], amt = this.pot(); s.chips += amt;
    this.last = { handN: this.handN, showdown: false, pots: [{ amount: amt, winners: [{ seat: i, name: s.p.name, amount: amt, hand: '' }] }] };
    this._say(`${s.p.name} wins ${amt}`); this._finish(2500);
  }
  _showdown() {
    this.phase = 'showdown'; this.cur = -1;
    const live = this._live(); const rank = {};
    for (const i of live) { const s = this.seats[i]; s.reveal = true; rank[i] = best([...s.cards, ...this.board]); s.handName = describe(rank[i]); }
    const pots = this._pots(); const out = [];
    const order = (i) => (i - this.dealer - 1 + NSEATS * 2) % NSEATS;
    for (const pot of pots) {
      const el = pot.elig.filter(i => rank[i] !== undefined); if (!el.length) continue;
      const top = Math.max(...el.map(i => rank[i])); const win = el.filter(i => rank[i] === top).sort((a, b) => order(a) - order(b));
      const share = Math.floor(pot.amount / win.length); let odd = pot.amount - share * win.length;
      const ws = win.map(i => { const a = share + (odd-- > 0 ? 1 : 0); this.seats[i].chips += a; return { seat: i, name: this.seats[i].p.name, amount: a, hand: this.seats[i].handName }; });
      out.push({ amount: pot.amount, winners: ws });
      this._say(`${ws.map(w => `${w.name} wins ${w.amount}`).join(', ')} with ${ws[0].hand}`);
    }
    this.last = { handN: this.handN, showdown: true, pots: out };
    this._finish(this.showdownMs);
  }
  _finish(ms) {
    this.phase = 'over'; this.cur = -1; this.deadline = 0; this._upd();
    this._t(() => this._cleanup(), ms);
  }
  _cleanup() {
    const gone = [];
    this.seats.forEach((s, i) => {
      if (!s) return;
      s.bet = 0; s.total = 0; s.cards = []; s.folded = false; s.allIn = false; s.reveal = false; s.handName = '';
      if (s.leaving) { this.seats[i] = null; gone.push({ p: s.p, chips: s.chips, why: 'left' }); }
      else if (s.chips <= 0 && this.kind === 'cash') { this.seats[i] = null; gone.push({ p: s.p, chips: 0, why: 'bust' }); }
      else if (this.kind === 'cash' && !s.p.connected) s.sitOut = true;
    });
    this.phase = 'idle'; this.board = []; this._upd();
    if (gone.length && this.hooks.gone) this.hooks.gone(this, gone);
    if (this.kind === 'cash') this.maybeStart();
    else if (this.hooks.handEnd) this.hooks.handEnd(this);
  }
  destroy() { clearTimeout(this.t); this.t = null; }

  // ---------- views ----------
  getView(p) {
    const me = p ? this.seatOf(p) : -1;
    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      let cards = null;
      if (s.cards.length) {
        if (i === me || s.reveal) cards = s.cards.map(cardStr);
        else if (!s.folded) cards = ['??', '??']; else cards = null;
      }
      return { pid: s.p.pid, name: s.p.name, chips: s.chips, bet: s.bet, folded: s.folded, allIn: s.allIn, sitOut: s.sitOut, away: !s.p.connected, cards, hand: s.reveal && !s.folded ? s.handName : '', inHand: s.cards.length > 0 };
    });
    const v = { id: this.id, name: this.name, kind: this.kind, sb: this.sb, bb: this.bb, phase: this.phase, handN: this.handN, dealer: this.dealer, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
      board: this.board.map(cardStr), pot: this.pot(), cur: this.cur, deadline: this.deadline, now: Date.now(), seats, me, last: this.last, log: this.log.slice(-8), actionMs: this.actionMs };
    if (me >= 0 && me === this.cur && this.handActive()) { const s = this.seats[me]; const toCall = Math.min(this.currentBet - s.bet, s.chips);
      v.act = { toCall, canRaise: s.canRaise && s.chips > toCall, min: Math.min(this.currentBet + this.minRaise, s.bet + s.chips), max: s.bet + s.chips, cur: this.currentBet }; }
    if (me >= 0 && this.seats[me].sitOut) v.sitOut = true;
    return v;
  }
}
module.exports = { Table, NSEATS };
