// Optional persistence for tournaments (registrations, results, winners board) in its own Postgres schema ("holdem").
// DATABASE_URL -> Postgres; PGLITE_DIR (tests/dev) -> embedded PGlite; neither -> in-memory only (db.enabled=false).
const pgSsl = require('./pgssl');
const SCHEMA = (process.env.DB_SCHEMA || 'holdem').replace(/[^a-z0-9_]/gi, '');
let q = null; const api = { enabled: false, S: SCHEMA };
const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
CREATE TABLE IF NOT EXISTS ${SCHEMA}.tournaments (id TEXT PRIMARY KEY, kind TEXT NOT NULL, start_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'registering', entrants INT NOT NULL DEFAULT 0, winner TEXT, finished_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS ${SCHEMA}.registrations (tid TEXT NOT NULL, hash TEXT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tid, hash));
CREATE TABLE IF NOT EXISTS ${SCHEMA}.results (tid TEXT NOT NULL, place INT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (tid, place))
`;
// RLS on, no policies: the shared Supabase REST API can never read these tables. The server role owns them and bypasses RLS.
const RLS = ['tournaments', 'registrations', 'results'].map(t => `ALTER TABLE ${SCHEMA}.${t} ENABLE ROW LEVEL SECURITY`);
api.init = async () => {
  const stmts = DDL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, ssl: pgSsl() });
    pool.on('error', e => console.error('pg pool error', e.message));
    q = (t, p) => pool.query(t, p);
    for (const s of stmts) await pool.query(s);
    for (const s of RLS) await pool.query(s).catch(e => console.error('rls:', e.message)); // best effort
  } else if (process.env.PGLITE_DIR !== undefined) {
    const { PGlite } = require('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE_DIR || undefined);
    q = (t, p) => db.query(t, p);
    for (const s of stmts) await db.exec(s);
    for (const s of RLS) await db.exec(s);
  } else return;
  api.enabled = true;
};
const safe = async (t, p) => { if (!api.enabled) return { rows: [] }; try { return await q(t, p); } catch (e) { console.error('db', e.message); return { rows: [] }; } };
api.getTournament = async id => (await safe(`SELECT * FROM ${SCHEMA}.tournaments WHERE id=$1`, [id])).rows[0];
api.saveTournament = t => safe(`INSERT INTO ${SCHEMA}.tournaments (id,kind,start_at,status,entrants,winner,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, entrants=EXCLUDED.entrants, winner=EXCLUDED.winner, finished_at=EXCLUDED.finished_at`,
  [t.id, t.kind, new Date(t.startAt), t.status, t.entrants || 0, t.winner || null, t.finishedAt ? new Date(t.finishedAt) : null]);
api.regs = async tid => (await safe(`SELECT hash,name FROM ${SCHEMA}.registrations WHERE tid=$1 ORDER BY created_at`, [tid])).rows;
api.addReg = (tid, hash, name) => safe(`INSERT INTO ${SCHEMA}.registrations (tid,hash,name) VALUES ($1,$2,$3) ON CONFLICT (tid,hash) DO UPDATE SET name=EXCLUDED.name`, [tid, hash, name]);
api.delReg = (tid, hash) => safe(`DELETE FROM ${SCHEMA}.registrations WHERE tid=$1 AND hash=$2`, [tid, hash]);
api.saveResults = async (tid, results) => { for (const r of results) await safe(`INSERT INTO ${SCHEMA}.results (tid,place,name) VALUES ($1,$2,$3) ON CONFLICT (tid,place) DO UPDATE SET name=EXCLUDED.name`, [tid, r.place, r.name]); };
api.recent = async () => (await safe(`SELECT id,kind,start_at,entrants,winner,finished_at FROM ${SCHEMA}.tournaments WHERE status='done' ORDER BY finished_at DESC LIMIT 30`)).rows;
api.results = async tid => (await safe(`SELECT place,name FROM ${SCHEMA}.results WHERE tid=$1 ORDER BY place LIMIT 10`, [tid])).rows;
module.exports = api;
