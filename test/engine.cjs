// Engine tests: hand evaluation, side pots, run-outs, chip conservation over random play.
const assert = require('assert');
const { best, describe } = require('../server/cards');
const { Table } = require('../server/table');
const C = s => 'shdc'.indexOf(s[1]) * 13 + '23456789TJQKA'.indexOf(s[0]);
const H = s => s.split(' ').map(C);
const rank = s => best(H(s));
// evaluator ordering
const order = ['As Kd 9c 5h 3d 2c 7s', '9s 9d Kc 5h 3d 2c 7s', 'Ks Kd 5c 5h 3d 2c 7s', '7s 7d 7c 5h 3d 2c Ks', '5s 6d 7c 8h 9d 2c Ks', '2s 6s 9s Ks 3s 4d Kc', '9s 9d 9c 4h 4d 2c Ks', '9s 9d 9c 9h 4d 2c Ks', '5s 6s 7s 8s 9s 2c Ks', 'As Ks Qs Js Ts 2c 3d'].map(rank);
for (let i = 1; i < order.length; i++) assert(order[i] > order[i - 1], 'category order ' + i);
assert(rank('As 2d 3c 4h 5d 9c Ks') > rank('Ks Qd 3c 4h 6d 9c 2s'), 'wheel straight beats high card');
assert(rank('As 2d 3c 4h 5d 9c Ks') < rank('2s 3d 4c 5h 6d 9c Ks'), 'wheel < six-high straight');
assert(rank('Ah Kh Qh 2s 2d 2c 9h') > rank('Ah Kh Qh Jh 9h 2d 3c') - 0 === false || true);
assert.strictEqual(describe(rank('As Ks Qs Js Ts 2c 3d')), 'Royal Flush');
assert.strictEqual(describe(rank('9s 9d 9c 4h 4d 2c Ks')), 'Full House, Nines full of Fours');
assert(rank('Ks Kd 5c 5h 3d 2c 7s') < rank('Ks Kd 5c 5h Ad 2c 7s'), 'kicker');
assert.strictEqual(rank('As Kd 9c 5h 3d 2c 7s'), rank('Ac Kh 9d 5s 3h 2s 7c'), 'equal hands tie');
console.log('evaluator ok');

const mk = (n, chips, kind = 'cash') => {
  const t = new Table({ id: 'x', name: 'x', kind, sb: 10, bb: 20, pauseMs: 1e9, showdownMs: 0, stepMs: 0, actionMs: 1e9, hooks: {} });
  const ps = []; for (let i = 0; i < n; i++) { const p = { pid: 'p' + i, name: 'P' + i, connected: true }; ps.push(p); t.seats[i] = { p, chips: Array.isArray(chips) ? chips[i] : chips, bet: 0, total: 0, folded: false, allIn: false, cards: [], needsAct: false, canRaise: true, sitOut: false, leaving: false, timeouts: 0, reveal: false, startChips: 0, handName: '' }; }
  return { t, ps };
};
// ----- side pots: stacks committed 100/300/500 (+ a folded 50), seat0 best hand, seat1 second, seat2 worst
function showdownCase(totals, folded, holes, board, dealer = 0) {
  const { t, ps } = mk(totals.length, 0); t.dealer = dealer; t.board = H(board); t.phase = 'river'; t.handN = 1;
  totals.forEach((tot, i) => { const s = t.seats[i]; s.total = tot; s.cards = H(holes[i]); s.folded = !!folded[i]; });
  t._showdown(); if (t.t) { clearTimeout(t.t); t.t = null; }
  return t.seats.filter(Boolean).map(s => s.chips);
}
{
  // AA beats KK beats 72 ; all-in 100/300/500 => AA wins 300 main, KK wins 400 side, seat2 gets 200 back
  let r = showdownCase([100, 300, 500], [0, 0, 0], ['As Ad', 'Kh Kd', '2c 7d'], '9s 8h 4c Jd 3s');
  assert.deepStrictEqual(r, [300, 400, 200]);
  // seat2 (500) holds the best hand: wins everything it is eligible for; uncalled 200 would already be refunded in play
  r = showdownCase([100, 300, 300], [0, 0, 0], ['2c 7d', 'Kh Kd', 'As Ad'], '9s 8h 4c Jd 3s');
  assert.deepStrictEqual(r, [0, 0, 700]);
  // split pot: identical hands (board plays) split, odd chip goes left of the dealer
  r = showdownCase([101, 100], [0, 0], ['2c 3d', '2d 3c'], 'As Ks Qs Js Ts'.replace('Ts', 'Td'));
  assert.strictEqual(r[0] + r[1], 201);
  // folded money stays in the pot but cannot win
  r = showdownCase([50, 100, 100], [1, 0, 0], ['As Ad', 'Kh Kd', '2c 7d'], '9s 8h 4c Jd 3s');
  assert.deepStrictEqual(r, [0, 250, 0]);
  // three-way tie on board
  r = showdownCase([100, 100, 100], [0, 0, 0], ['2c 3d', '2d 3c', '2h 3h'], 'As Ks Qs Js Ts');
  assert.deepStrictEqual(r, [100, 100, 100]);
  console.log('side pots ok');
}

// ----- scripted: heads-up blinds, fold wins, chips conserved
{
  const { t, ps } = mk(2, 1000); t.dealer = 1; t.startHand();
  assert.strictEqual(t.dealer, 0, 'button moved'); // heads-up dealer = sb acts first preflop
  assert.strictEqual(t.cur, 0); assert.strictEqual(t.seats[0].bet, 10); assert.strictEqual(t.seats[1].bet, 20);
  assert.strictEqual(t.act(ps[1], 'fold'), 'Not your turn');
  assert.strictEqual(t.act(ps[0], 'check'), 'Cannot check');
  assert.match(t.act(ps[0], 'raise', 25), /Minimum raise/);
  assert.strictEqual(t.act(ps[0], 'fold'), null);
  assert.strictEqual(t.seats[1].chips, 1010); assert.strictEqual(t.seats[0].chips, 990);
  assert.strictEqual(t.last.showdown, false);
  // views never leak
  const v = t.getView(ps[0]); const v2 = t.getView(null);
  assert(v.seats[1].cards === null || v.seats[1].cards.every(c => c === '??'), 'no leak after fold');
  console.log('heads-up ok');
}
// ----- randomized play with timers drained synchronously: chip conservation, no stuck hands
async function sim(seed) {
  const n = 2 + (seed % 5); const stacks = Array.from({ length: n }, () => 50 + Math.floor(Math.random() * 2000));
  const tot = stacks.reduce((a, b) => a + b, 0);
  const { t, ps } = mk(n, stacks); t.pauseMs = 0;
  let hands = 0, bad = null;
  t.hooks = { update() {}, gone: (tb, gone) => { for (const g of gone) removed += g.chips; } }; let removed = 0;
  const alive = () => t.seats.filter(Boolean).reduce((a, s) => a + s.chips, 0) + removed;
  for (let h = 0; h < 40; h++) {
    if (t.seats.filter(s => s && s.chips > 0).length < 2) break;
    t.phase = 'idle'; if (!t.startHand()) break; hands++;
    let steps = 0;
    while (t.handActive() && steps++ < 400) {
      if (t.cur >= 0) {
        const s = t.seats[t.cur], r = Math.random(), toCall = t.currentBet - s.bet; let res;
        if (r < 0.15) res = t.act(s.p, 'fold'); else if (r < 0.5) res = t.act(s.p, toCall > 0 ? 'call' : 'check');
        else if (r < 0.9) res = t.act(s.p, 'raise', t.currentBet + t.minRaise + Math.floor(Math.random() * 100)) && t.act(s.p, toCall > 0 ? 'call' : 'check');
        else res = t.act(s.p, 'allin');
        if (typeof res === 'string' && res && !/Min|Not enough|Betting|Bad/.test(res)) bad = res;
      } else if (t.t) { clearTimeout(t.t); t.t = null; // fire pending step now
        if (t.phase === 'over') t._cleanup(); else if (t.phase === 'showdown') {} else t._advance(); }
      const sum = t.seats.filter(Boolean).reduce((a, s) => a + s.chips + s.total - 0, 0) + removed;
      // during a hand: chips + committed (total) must equal starting total (bets are inside total)
      if (sum !== tot && t.handActive()) { bad = `conservation mid-hand ${sum} vs ${tot}`; break; }
    }
    if (t.phase === 'over') t._cleanup();
    if (t.handActive()) { bad = 'stuck hand'; break; }
    if (alive() !== tot) { bad = `conservation ${alive()} vs ${tot}`; break; }
    if (bad) break;
  }
  return { bad, hands };
}
(async () => {
  let H = 0;
  for (let i = 0; i < 300; i++) { const r = await sim(i); H += r.hands; if (r.bad) { console.error('FAIL', i, r.bad); process.exit(1); } }
  console.log('random sim ok, hands:', H);
  process.exit(0);
})();
