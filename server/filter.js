// Name + chat filtering. Names: 3-14 chars, letters/numbers/space/_/-, no profanity (leet-speak aware).
const BAD = ['fuck','shit','bitch','cunt','dick','cock','pussy','nigg','fag','whore','slut','rape','nazi','hitler','asshole','bastard','retard','penis','vagina','porn','kike','spic','chink','twat','wank','tits','boob','dildo','molest','pedo','kkk','isis','coon','tranny','wetback','gook','fuk','fck','fvck','phuck'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't' };
const flat = s => s.toLowerCase().replace(/[0134578@$!+]/g, c => LEET[c]).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
const flat2 = s => s.toLowerCase().replace(/[0134578@$!+]/g, c => LEET[c]).replace(/[^a-z]/g, '');
const BADF = BAD.map(w => w.replace(/(.)\1+/g, '$1')).filter(w => w.length >= 4);
const dirty = s => { const a = flat(s), b = flat2(s); return BADF.some(w => a.includes(w)) || BAD.some(w => b.includes(w)); };
// names that could be mistaken for staff, the house/dealer, or system chat lines ("VW FEST" is the sender of system messages)
const RESERVED = /^(admin|administrator|mod|moderator|staff|support|system|server|vwfest|vw fest|vwfestofficial|official|dealer|house|host|owner|bot|null|undefined)$/;
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _\-]{1,12}[A-Za-z0-9]$/.test(n)) return null;
  if (dirty(n)) return null;
  if (RESERVED.test(n.toLowerCase().replace(/[ _-]+/g, ' ').trim()) || RESERVED.test(n.toLowerCase().replace(/[ _-]+/g, ''))) return null;
  return n;
}
function cleanChat(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null; if (t.length > 140) t = t.slice(0, 140);
  t = t.replace(/(https?:\/\/|www\.)\S+/gi, '[link]');
  t = t.split(' ').map(w => (dirty(w) ? '*'.repeat(Math.min(w.length, 8)) : w)).join(' ');
  return t;
}
module.exports = { cleanName, cleanChat, dirty };
