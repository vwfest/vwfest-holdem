// Tournament schedule (America/Los_Angeles, DST-aware) + Postgres-schema persistence (PGlite stands in for Postgres).
process.env.PGLITE_DIR = '';
const assert = require('assert');
const { nextStart, dateId } = require('../server/tourney');
const db = require('../server/db');
const pt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'numeric', day: 'numeric' });
const at = (iso) => Date.parse(iso);
// Fri Oct 30 2026 11:00 PDT -> daily today 7 PM PDT, weekly Sat Oct 31 6 PM PDT
assert.strictEqual(pt(nextStart('daily', at('2026-10-30T18:00:00Z'))), 'Fri, 10/30, 7:00 PM');
assert.strictEqual(pt(nextStart('weekly', at('2026-10-30T18:00:00Z'))), 'Sat, 10/31, 6:00 PM');
// after Saturday 6 PM -> next Saturday, across the Nov 1 DST end (6 PM PST = 02:00Z)
const w2 = nextStart('weekly', at('2026-11-01T02:00:01Z')); assert.strictEqual(pt(w2), 'Sat, 11/7, 6:00 PM'); assert.strictEqual(new Date(w2).toISOString(), '2026-11-08T02:00:00.000Z');
// daily just after 7 PM -> tomorrow
assert.strictEqual(pt(nextStart('daily', at('2026-10-31T02:00:01Z'))), 'Sat, 10/31, 7:00 PM');
assert.strictEqual(dateId('weekly', w2), 'weekly-2026-11-07');
(async () => {
  await db.init(); assert(db.enabled, 'pglite db on');
  const t = { id: 'daily-2026-10-30', kind: 'daily', startAt: Date.now(), status: 'registering', entrants: 0 };
  await db.saveTournament(t); await db.addReg(t.id, 'h1', 'Ana'); await db.addReg(t.id, 'h2', 'Bob'); await db.addReg(t.id, 'h2', 'Bobby');
  assert.deepStrictEqual((await db.regs(t.id)).map((r) => r.name), ['Ana', 'Bobby']); await db.delReg(t.id, 'h1'); assert.strictEqual((await db.regs(t.id)).length, 1);
  await db.saveTournament({ ...t, status: 'done', entrants: 2, winner: 'Bobby', finishedAt: Date.now() }); await db.saveResults(t.id, [{ place: 1, name: 'Bobby' }, { place: 2, name: 'Ana' }]);
  assert.strictEqual((await db.recent())[0].winner, 'Bobby'); assert.strictEqual((await db.results(t.id)).length, 2); assert.strictEqual((await db.getTournament(t.id)).status, 'done');
  console.log('schedule + db ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
