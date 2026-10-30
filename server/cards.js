// Cards are ints 0..51: rank = c % 13 (0 = '2' … 12 = 'A'), suit = floor(c / 13) (s h d c).
const crypto = require('crypto');
const RANKS = '23456789TJQKA', SUITS = 'shdc';
const cardStr = c => RANKS[c % 13] + SUITS[(c / 13) | 0];
const CAT = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
const RNAME = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];

function shuffledDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
// score of exactly 5 cards: category * 13^5 + tiebreak ranks in base 13
function eval5(cs) {
  const r = cs.map(c => c % 13).sort((a, b) => b - a);
  const flush = cs.every(c => ((c / 13) | 0) === ((cs[0] / 13) | 0));
  const cnt = {}; for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
  const groups = Object.entries(cnt).map(([k, v]) => [v, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let straightHigh = -1;
  if (groups.length === 5) {
    if (r[0] - r[4] === 4) straightHigh = r[0];
    else if (r[0] === 12 && r[1] === 3 && r[2] === 2 && r[3] === 1 && r[4] === 0) straightHigh = 3; // wheel
  }
  let cat, tb;
  if (straightHigh >= 0 && flush) { cat = 8; tb = [straightHigh]; }
  else if (groups[0][0] === 4) { cat = 7; tb = [groups[0][1], groups[1][1]]; }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; tb = [groups[0][1], groups[1][1]]; }
  else if (flush) { cat = 5; tb = r; }
  else if (straightHigh >= 0) { cat = 4; tb = [straightHigh]; }
  else if (groups[0][0] === 3) { cat = 3; tb = groups.map(g => g[1]); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; tb = groups.map(g => g[1]); }
  else if (groups[0][0] === 2) { cat = 1; tb = groups.map(g => g[1]); }
  else { cat = 0; tb = r; }
  let s = cat; for (let i = 0; i < 5; i++) s = s * 13 + (tb[i] || 0);
  return s;
}
// best 5 of up to 7 cards
function best(cs) {
  if (cs.length === 5) return eval5(cs);
  let b = -1; const n = cs.length;
  for (let a = 0; a < n - 4; a++) for (let b2 = a + 1; b2 < n - 3; b2++) for (let c = b2 + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const s = eval5([cs[a], cs[b2], cs[c], cs[d], cs[e]]); if (s > b) b = s;
    }
  return b;
}
const catOf = s => Math.floor(s / 371293);
function describe(s) {
  const cat = catOf(s); const tb = []; let x = s - cat * 371293;
  for (let i = 4; i >= 0; i--) { tb[i] = x % 13; x = Math.floor(x / 13); }
  const n = i => RNAME[tb[i]];
  switch (cat) {
    case 8: return tb[0] === 12 ? 'Royal Flush' : `Straight Flush, ${n(0)} high`;
    case 7: return `Four of a Kind, ${n(0)}s`;
    case 6: return `Full House, ${n(0)}s full of ${n(1)}s`;
    case 5: return `Flush, ${n(0)} high`;
    case 4: return `Straight, ${n(0)} high`;
    case 3: return `Three of a Kind, ${n(0)}s`;
    case 2: return `Two Pair, ${n(0)}s and ${n(1)}s`;
    case 1: return `Pair of ${n(0)}s`;
    default: return `High Card ${n(0)}`;
  }
}
module.exports = { shuffledDeck, cardStr, best, describe, CAT };
