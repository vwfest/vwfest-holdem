// VW FEST HOLD'EM server: Express (health/status API) + WebSocket game transport. Server is authoritative.
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { clientIp, useClientIp } = require('./clientip');
const { Room } = require('./room');
const { Tournaments, KINDS } = require('./tourney');

const TEST = process.env.HOLDEM_TEST === '1';
const PROD = process.env.NODE_ENV === 'production';
const ORIGINS = new Set(['https://vwfest.github.io', ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const MAX_PER_IP = +(process.env.MAX_PER_IP || (TEST ? 100 : 8));
const PORT = +(process.env.PORT || 3000);
const TIMING = TEST ? { actionMs: +(process.env.T_ACTION || 4000), pauseMs: 300, showdownMs: 700, stepMs: 200 } : {};

const app = express();
app.set('trust proxy', 1); app.disable('x-powered-by');
useClientIp(app);
app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'no-referrer' } }));
// CORS: only the allowed origins (never *)
app.use((req, res, next) => {
  const o = req.get('origin');
  if (o && ORIGINS.has(o)) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); res.set('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type'); }
  else if (o && req.path.startsWith('/api')) return res.status(403).json({ error: 'origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// tiny per-IP HTTP limiter
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
app.use('/api', (req, res, next) => { const k = req.ip; const n = (hits.get(k) || 0) + 1; hits.set(k, n); if (n > 120) return res.status(429).json({ error: 'Too many requests' }); next(); });
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/', (req, res) => res.type('text').send("VW FEST HOLD'EM game server (play chips only, no cash). Play at https://vwfest.github.io/vwfest-holdem/"));

const room = new Room({ timing: TIMING });
let tourney;
app.get('/api/status', (req, res) => {
  const l = room.lobby();
  res.json({ ok: true, online: l.online, cap: l.cap, seated: l.tables.reduce((a, t) => a + t.seated, 0), tables: l.tables.length,
    tournaments: l.tourneys.map(t => ({ kind: t.kind, label: t.label, startAt: t.startAt, status: t.status, registered: t.regCount })), winners: room.winners.slice(0, 5) });
});
if (TEST) {
  app.post('/api/test/start/:kind', (req, res) => { tourney.forceStart(req.params.kind, +(req.query.in || 1500)); res.json({ ok: true }); });
}
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { res.status(500).json({ error: 'server' }); }); // eslint-disable-line

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 20000, perMessageDeflate: false });
const perIp = new Map();
const ipOf = req => clientIp(req); // CF-Connecting-IP behind Render; the last X-Forwarded-For entry is the Cloudflare edge (shared by many users)
server.on('upgrade', (req, socket, head) => {
  const reject = (c, m) => { socket.write(`HTTP/1.1 ${c} ${m}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!req.url.startsWith('/ws')) return reject(404, 'Not Found');
  const o = req.headers.origin;
  if (!o || !ORIGINS.has(o)) return reject(403, 'Forbidden');
  const ip = ipOf(req); if ((perIp.get(ip) || 0) >= MAX_PER_IP) return reject(429, 'Too Many Requests');
  if (wss.clients.size >= 80) return reject(503, 'Busy');
  wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; perIp.set(ip, (perIp.get(ip) || 0) + 1); wss.emit('connection', ws, req); });
});

const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
wss.on('connection', ws => {
  ws.player = null; ws.alive = true; ws.tokens = 25; ws.strikes = 0; ws.lastChat = []; 
  const helloTimer = setTimeout(() => { if (!ws.player) ws.close(4001); }, 10000);
  const refill = setInterval(() => { ws.tokens = Math.min(25, ws.tokens + 5); }, 1000);
  ws.on('pong', () => { ws.alive = true; });
  const err = (msg, extra) => { try { ws.send(JSON.stringify({ t: 'err', msg, ...extra })); } catch {} };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(1003);
    if (--ws.tokens < 0) { if (++ws.strikes > 5) return ws.close(4008); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return err('bad message'); }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return err('bad message');
    const p = ws.player;
    if (m.t === 'ping') return ws.send('{"t":"pong"}');
    if (m.t === 'hello') {
      const r = room.hello(ws, m);
      if (r.err) { err(r.err, { fatal: true, full: !!r.full, stage: 'hello' }); if (r.full) setTimeout(() => ws.close(4002), 100); return; }
      clearTimeout(helloTimer); room.welcome(r.p); return;
    }
    if (!p || p.ws !== ws) return err('say hello first');
    let e = null;
    switch (m.t) {
      case 'watch': e = typeof m.table === 'string' ? room.watch(p, m.table) : 'bad table'; break;
      case 'sit': e = typeof m.table === 'string' ? room.sit(p, m.table, m.seat) : 'bad table'; break;
      case 'unwatch': if (!p.tableId) p.viewing = null; break;
      case 'leave': room.standUp(p); room.send(p, { t: 'left' }); break;
      case 'back': room.back(p); break;
      case 'act': {
        const t = p.tableId && room.tables.get(p.tableId);
        if (!t) { e = 'You are not at a table'; break; }
        if (!ACTIONS.has(m.a)) { e = 'bad action'; break; }
        e = t.act(p, m.a, m.amt);
        break;
      }
      case 'chat': {
        const now = Date.now(); ws.lastChat = ws.lastChat.filter(x => now - x < 10000);
        if (ws.lastChat.length >= 5 || (ws.lastChat.length && now - ws.lastChat[ws.lastChat.length - 1] < 800)) { e = 'Slow down your chat'; break; }
        ws.lastChat.push(now); room.say(p, m.text); break;
      }
      case 'reg': e = tourney && KINDS[m.kind] ? tourney.register(p, m.kind) : 'bad tournament'; break;
      case 'unreg': e = tourney && KINDS[m.kind] ? tourney.unregister(p, m.kind) : 'bad tournament'; break;
      default: e = 'unknown message';
    }
    if (e) err(e);
  });
  ws.on('close', () => { clearTimeout(helloTimer); clearInterval(refill); const n = (perIp.get(ws.ip) || 1) - 1; if (n <= 0) perIp.delete(ws.ip); else perIp.set(ws.ip, n); room.disconnect(ws); });
  ws.on('error', () => {});
});
const hb = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch {} } }, 25000);

async function main() {
  await db.init().catch(e => console.error('db init failed, running in-memory:', e.message));
  tourney = new Tournaments(room, db, { levelMs: TEST ? +(process.env.T_LEVEL_MS || 20000) : null, lateMs: TEST ? 15000 : undefined, timing: TEST ? { ...TIMING, firstHandMs: 500, betweenHandsMs: 500, endLingerMs: 3000 } : {} });
  room.tourney = tourney; await tourney.init();
  server.listen(PORT, () => console.log(`holdem listening :${PORT} db=${db.enabled ? 'on' : 'off'} test=${TEST}`));
}
main().catch(e => { console.error(e); process.exit(1); });
process.on('SIGTERM', () => { clearInterval(hb); room.close(); tourney && tourney.close(); server.close(); setTimeout(() => process.exit(0), 500).unref(); });
module.exports = { app, server, room };
