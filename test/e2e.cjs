// End-to-end: protocol/security checks (raw WebSocket) + multi-client Playwright hands + tournament flow + screenshots.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const SP = 3200, WP = 3201, ORIGIN = `http://127.0.0.1:${WP}`, SHOTS = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let server, web;

async function startServers() {
  server = spawn('node', ['server/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: SP, HOLDEM_TEST: '1', ALLOWED_ORIGINS: ORIGIN, PGLITE_DIR: '', T_LEVEL_MS: '9000', T_ACTION: '4000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d)); let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) up = true; });
  for (let i = 0; i < 100 && !up; i++) await sleep(100);
  assert(up, 'server up');
  const docs = path.join(__dirname, '..', 'docs');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
  web = http.createServer((req, res) => {
    const u = req.url.split('?')[0]; const f = path.join(docs, u === '/' ? 'index.html' : u); if (!f.startsWith(docs) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(f);
    if (u === '/') body = Buffer.from(String(body).replace('wss://vwfest-holdem.onrender.com', `wss://vwfest-holdem.onrender.com ws://127.0.0.1:${SP}`)); // only change: allow the local test server in connect-src
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(body);
  }).listen(WP);
}

// ---------- raw client ----------
class Raw {
  constructor(name, opts = {}) { this.name = name; this.token = opts.token || 'tok' + name + '_'.repeat(16) + Math.random().toString(36).slice(2, 10); this.msgs = []; this.avatar = opts.avatar || 'p:1'; this.origin = 'origin' in opts ? opts.origin : ORIGIN; }
  open() { return new Promise((res, rej) => { this.ws = new WebSocket(`ws://127.0.0.1:${SP}/ws`, this.origin ? { origin: this.origin } : {}); this.ws.on('message', (d) => { try { this.msgs.push(JSON.parse(d)); } catch {} }); this.ws.on('open', res); this.ws.on('error', rej); this.ws.on('unexpected-response', (q, r) => rej(new Error('HTTP ' + r.statusCode))); this.ws.on('close', (c) => { this.closed = c; }); }); }
  send(o) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  hello(name = this.name) { this.send({ t: 'hello', token: this.token, name, avatar: this.avatar }); }
  async wait(pred, ms = 4000) { const t0 = Date.now(); for (;;) { const m = this.msgs.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error('timeout waiting ' + pred); await sleep(40); } }
  close() { try { this.ws.close(); } catch {} }
}

async function rawTests() {
  // origin lock
  await assert.rejects(new Raw('evil', { origin: 'https://evil.example' }).open(), /403/);
  await assert.rejects(new Raw('noorigin', { origin: null }).open().catch((e) => { throw e; }), /403|Unexpected|socket/i);
  const st = await (await fetch(`http://127.0.0.1:${SP}/api/status`, { headers: { Origin: 'https://evil.example' } }));
  assert.strictEqual(st.status, 403);
  const ok = await fetch(`http://127.0.0.1:${SP}/api/status`, { headers: { Origin: 'https://vwfest.github.io' } });
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://vwfest.github.io');
  const csp = ok.headers.get('content-security-policy'); assert(/default-src 'none'/.test(csp), 'server CSP');
  log('origin/CORS lock ok');
  // validation
  const a = new Raw('Alpha'); await a.open();
  a.send('not json'); await a.wait((m) => m.t === 'err');
  a.hello('fuck'); const e1 = await a.wait((m) => m.t === 'err' && m.stage === 'hello'); assert(/username/i.test(e1.msg));
  a.msgs.length = 0; a.avatar = 'data:image/png;base64,AAAA'; a.hello('Alpha'); await a.wait((m) => m.t === 'err' && m.stage === 'hello'); a.msgs.length = 0;
  a.avatar = 'p:1'; a.hello('Alpha'); await a.wait((m) => m.t === 'welcome');
  const b = new Raw('alpha2'); await b.open(); b.hello('ALPHA'); const dup = await b.wait((m) => m.t === 'err' && m.stage === 'hello'); assert(/taken/i.test(dup.msg));
  log('username filter + unique ok');
  // act without sitting / unknown messages
  a.msgs.length = 0; a.send({ t: 'act', a: 'raise', amt: 5 }); await a.wait((m) => m.t === 'err'); a.send({ t: 'sit', table: 't99', seat: 0 }); await a.wait((m) => m.t === 'err');
  a.send({ t: 'sit', table: 't1', seat: 9 }); await a.wait((m) => m.t === 'err' && /seat/i.test(m.msg));
  // table cap: 6 seat, 7th rejected
  const six = []; for (let i = 0; i < 7; i++) { const c = new Raw('Six' + i); await c.open(); c.hello(); await c.wait((m) => m.t === 'welcome'); six.push(c); }
  for (let i = 0; i < 6; i++) six[i].send({ t: 'sit', table: 't7', seat: -1 });
  await sleep(300); six[6].send({ t: 'sit', table: 't7', seat: -1 }); const full = await six[6].wait((m) => m.t === 'err'); assert(/full|taken/i.test(full.msg));
  const lob = [...six[0].msgs].reverse().find((m) => m.t === 'lobby'); assert.strictEqual(lob.tables.length, 7); assert.strictEqual(lob.tables.find((t) => t.id === 't7').seated, 6);
  log('7 tables x 6 seats ok');
  // leak check: the table view for a viewer never contains other players' hole cards pre-showdown
  await six[0].wait((m) => m.t === 'table' && m.v.phase === 'preflop', 6000);
  for (const c of six.slice(0, 6)) for (const m of c.msgs.filter((m) => m.t === 'table' && m.v.phase === 'preflop')) m.v.seats.forEach((s, i) => { if (s && i !== m.v.me) assert(!s.cards || s.cards.every((x) => x === '??'), 'hole card leak'); });
  const spec = six[6]; spec.send({ t: 'watch', table: 't7' }); const sv = await spec.wait((m) => m.t === 'table' && m.v.id === 't7'); assert(sv.v.seats.every((s) => !s || !s.cards || s.cards.every((x) => x === '??')), 'spectator sees hole cards'); assert(!sv.v.act);
  log('no hole-card leakage to opponents/spectators ok');
  six.forEach((c) => c.close()); b.close();
  // rate limit: flood closes the socket, server survives
  const f = new Raw('Flood'); await f.open(); f.hello(); await f.wait((m) => m.t === 'welcome');
  for (let i = 0; i < 400; i++) { try { f.send({ t: 'ping' }); } catch {} }
  await sleep(500); for (let i = 0; i < 300; i++) { try { f.send({ t: 'ping' }); } catch {} } await sleep(500); assert(f.closed, 'flood connection closed');
  const alive = await fetch(`http://127.0.0.1:${SP}/healthz`); assert.strictEqual(alive.status, 200);
  // oversize payload
  const o = new Raw('Big'); await o.open(); o.send('x'.repeat(30000)); await sleep(300); assert(o.closed, 'oversize closed');
  // chat filter + rate limit
  const cc = new Raw('Chatty'); await cc.open(); cc.hello(); await cc.wait((m) => m.t === 'welcome'); cc.send({ t: 'chat', text: 'hi <b>there</b> http://spam.com shit' });
  const cm = await cc.wait((m) => m.t === 'chat' && m.m.name === 'Chatty'); assert(!/spam\.com/.test(cm.m.text) && !/shit/.test(cm.m.text), cm.m.text);
  cc.send({ t: 'chat', text: 'again' }); await cc.wait((m) => m.t === 'err' && /Slow/.test(m.msg));
  log('rate limit / payload cap / chat filter ok');
  // room cap 25
  const crowd = []; for (let i = 0; i < 25; i++) { const c = new Raw('Cr' + String(i).padStart(2, '0')); await c.open(); c.hello(); const r = await c.wait((m) => m.t === 'welcome' || (m.t === 'err' && m.stage === 'hello'), 5000); crowd.push([c, r]); }
  const welcomed = crowd.filter(([, r]) => r.t === 'welcome').length; // alpha + chatty + flood? (flood closed) -> total online must be exactly 25
  const full2 = crowd.filter(([, r]) => r.t === 'err' && r.full).length; assert(full2 >= 1, 'room full rejects beyond 25');
  const lb = await (await fetch(`http://127.0.0.1:${SP}/api/status`)).json(); assert.strictEqual(lb.online, 25, 'online capped at 25 (got ' + lb.online + ')');
  crowd.forEach(([c]) => c.close()); a.close(); cc.close(); o.close();
  log('room cap 25 ok (welcomed ' + welcomed + ', rejected ' + full2 + ')');
  await sleep(600);
}

// ---------- browser ----------
async function mkPlayer(browser, name, opts = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errs.push(m.text()); });
  page.frames = []; page.on('websocket', (ws) => { ws.on('framereceived', (f) => { try { const m = JSON.parse(f.payload); if (m.t === 'table') page.frames.push(m.v); } catch {} }); });
  await page.goto(`${ORIGIN}/?ws=ws://127.0.0.1:${SP}/ws`);
  return { ctx, page, name, errs, manual: false, mode: 'call' };
}
async function register(p, name, avIdx = 0, file) {
  const { page } = p; await page.fill('#inName', name);
  if (file) { await page.setInputFiles('#inFile', { name: 'me.png', mimeType: 'image/png', buffer: file }); await page.waitForFunction(() => /Uploaded/.test(document.getElementById('upNote').textContent), null, { timeout: 5000 }); }
  else await page.click(`#avGrid .av[data-a="p:${avIdx}"]`);
  await page.click('#btnGo'); await page.waitForSelector('#scrLobby:not(.hidden)', { timeout: 10000 });
}
async function bot(p) { // one decision, if it's our turn
  const { page } = p; if (p.manual || p.stopped || page.isClosed()) return;
  try {
    const back = await page.evaluate(() => { const b = document.getElementById('sitOutBar'); return b && !b.classList.contains('hidden'); });
    if (back) { await page.click('#aBack', { timeout: 500 }); return; }
    const vis = await page.evaluate(() => { const c = document.getElementById('controls'); return c && !c.classList.contains('hidden'); });
    if (!vis) return;
    if (p.stopAtFlop && await page.evaluate(() => document.querySelectorAll('#board .card').length >= 3)) { p.stopped = true; return; }
    if (p.mode === 'allin') { const canRaise = await page.evaluate(() => !document.querySelector('.raisebox').classList.contains('hidden')); if (canRaise) { await page.click('#qAll', { timeout: 500 }); await page.click('#aRaise', { timeout: 500 }); } else await page.click('#aCall', { timeout: 500 }); return; }
    const r = Math.random();
    if (r < 0.12) await page.click('#aFold', { timeout: 500 }); else if (r < 0.3 && await page.evaluate(() => !document.querySelector('.raisebox').classList.contains('hidden'))) await page.click('#aRaise', { timeout: 500 }); else await page.click('#aCall', { timeout: 500 });
  } catch {}
}
async function runBots(ps, ms, until) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await Promise.all(ps.map(bot)); if (until && await until()) return true; await sleep(180); } return false; }

async function main() {
  await startServers();
  await rawTests();
  const browser = await chromium.launch();
  // generate a large PNG avatar on the fly
  const gp = await browser.newPage(); const dataUrl = await gp.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 600, 400); g.addColorStop(0, '#e8641a'); g.addColorStop(1, '#7b1f6f'); x.fillStyle = g; x.fillRect(0, 0, 600, 400); x.fillStyle = '#fff'; x.font = '200px sans-serif'; x.fillText('VW', 100, 280); return c.toDataURL('image/png'); }); await gp.close();
  const png = Buffer.from(dataUrl.split(',')[1], 'base64'); log('upload source png bytes', png.length);

  // profile screen screenshots (fresh)
  const names = ['Ana Bus', 'Bob Beetle', 'Cat Ghia', 'Dan Thing'];
  const ps = []; for (let i = 0; i < 4; i++) ps.push(await mkPlayer(browser, names[i]));
  await ps[0].page.waitForSelector('#scrProfile:not(.hidden)'); await ps[0].page.screenshot({ path: path.join(SHOTS, 'desktop-1-profile.png') });
  // bad name rejected client+server, then ok
  await ps[0].page.fill('#inName', 'fuck'); await ps[0].page.click('#btnGo'); await ps[0].page.waitForSelector('#profErr:not(.hidden)');
  await register(ps[0], 'Ana Bus', 0); await register(ps[1], 'Bob Beetle', 1, png); await register(ps[2], 'Cat Ghia', 2); await register(ps[3], 'Dan Thing', 3);
  // duplicate name rejected
  const dupe = await mkPlayer(browser, 'dupe'); await dupe.page.fill('#inName', 'ana bus'); await dupe.page.click('#avGrid .av >> nth=5'); await dupe.page.click('#btnGo');
  await dupe.page.waitForFunction(() => /taken/i.test(document.getElementById('profErr').textContent), null, { timeout: 8000 }); await dupe.ctx.close();
  log('profiles (preset + resized upload), filter, unique ok');
  const uploaded = await ps[1].page.evaluate(() => localStorage.getItem('vwfest-holdem-v1')); const ua = JSON.parse(uploaded).avatar; assert(ua.startsWith('data:image/jpeg'), 'upload resized to jpeg'); assert(ua.length < 16000, 'upload size-limited');

  // lobby: 7 tables with join buttons + seat counts
  const lp = ps[0].page; await lp.waitForFunction(() => document.querySelectorAll('#tables .tcard').length === 7);
  assert.strictEqual(await lp.locator('#tables .tcard button[data-join]').count(), 7); assert(/\/25/.test(await lp.locator('.online').innerText()));
  await lp.screenshot({ path: path.join(SHOTS, 'desktop-2-lobby.png'), fullPage: true });

  // everyone joins table 1
  for (const p of ps) await p.page.click('button[data-join="t1"]');
  for (const p of ps) await p.page.waitForSelector('#scrTable:not(.hidden)');
  await ps[0].page.waitForFunction(() => document.querySelectorAll('#seats .seat .pl').length === 4);
  await lp.waitForFunction(() => document.querySelector('#banner') != null);
  // play hands; Ana pauses for screenshots on first decision
  const turnOf = (p) => async () => p.stopped;
  ps[0].stopAtFlop = true;
  assert(await runBots(ps, 60000, turnOf(ps[0])), 'Ana got a post-flop turn');
  await ps[0].page.screenshot({ path: path.join(SHOTS, 'desktop-3-table.png'), fullPage: true });
  ps[0].stopped = false; ps[0].stopAtFlop = false;
  let hands = 0; const seenHands = new Set();
  const handsDone = async () => { const hn = await ps[1].page.evaluate(() => document.getElementById('hlog').textContent.match(/Hand #\d+/g) || []); hn.forEach((h) => seenHands.add(h)); return seenHands.size >= 6; };
  const sums = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { await Promise.all(ps.map(bot)); if (await handsDone()) break; await sleep(150); }
  assert(seenHands.size >= 6, 'played >=6 hands, saw ' + seenHands.size);
  // chip conservation from the latest idle/over view of player 1
  const last = ps[1].page.frames.filter((v) => v.phase === 'idle' || v.phase === 'over').slice(-1)[0];
  const tot = last.seats.filter(Boolean).reduce((a, s) => a + s.chips, 0); log('seats', last.seats.filter(Boolean).map((s) => s.name + ':' + s.chips).join(', ')); assert.strictEqual(tot, 4000, 'chips conserved (4 x 1000), got ' + tot);
  // no leakage seen by any browser client before showdown
  for (const p of ps) for (const v of p.page.frames) if (v.phase === 'preflop') v.seats.forEach((s, i) => { if (s && i !== v.me) assert(!s.cards || s.cards.every((x) => x === '??'), 'leak in browser frames'); });
  log('multi-client hands ok:', seenHands.size, 'hands; chips conserved; no leaks');
  // showdown screenshot: catch a frame with revealed cards
  await runBots(ps, 40000, async () => { const t = await ps[0].page.evaluate(() => /with /.test(document.getElementById('banner').textContent) && document.querySelectorAll('#seats .seat .hc .card:not(.back)').length >= 3); return t; });
  await ps[0].page.screenshot({ path: path.join(SHOTS, 'desktop-4-showdown.png'), fullPage: true });
  // disconnect auto-fold: close Dan; the game keeps going and his seat shows as disconnected
  await ps[3].ctx.close(); const before = ps[0].page.frames.length; await runBots(ps.slice(0, 3), 12000);
  const dv = ps[0].page.frames.slice(-1)[0]; assert(ps[0].page.frames.length > before + 3, 'game continued after disconnect');
  assert(dv.seats.filter(Boolean).some((s) => s.name === 'Dan Thing' && (s.away || s.folded || s.sitOut)), 'disconnected player is marked / auto-folded');
  log('disconnect auto-fold ok');
  // chat from table
  await ps[0].page.fill('#chatIn2', 'gg from the 209'); await ps[0].page.press('#chatIn2', 'Enter'); await ps[1].page.waitForFunction(() => /gg from the 209/.test(document.getElementById('chatLog2').textContent));
  // all leave to lobby
  for (const p of ps.slice(0, 3)) { await p.page.click('#btnLeave'); await p.page.waitForSelector('#scrLobby:not(.hidden)'); }
  await ps[0].page.waitForFunction(() => /\b[01]\/6 seated/.test(document.querySelector('#tables .tcard').innerText));

  // ---- tournament flow ----
  const T = ps.slice(0, 3);
  // Dan was closed; reopen a fresh Dan on the same token (restore) by new context
  const lobbyShot = async (file, mobile) => {};
  for (const p of T) { await p.page.waitForSelector('#tourneys .tn'); }
  assert.strictEqual(await T[0].page.locator('#tourneys .tn').count(), 2);
  const txt = await T[0].page.locator('#tourneys').innerText(); assert(/Daily Cruise/.test(txt) && /Weekly Main Event/.test(txt) && /7:00 PM PT/.test(txt) && /6:00 PM PT/.test(txt) && /Saturday/.test(txt));
  for (const p of T) { await p.page.click('button[data-reg="daily"]'); }
  await T[0].page.waitForFunction(() => /3 registered/.test(document.querySelector('.tn[data-kind="daily"]').innerText));
  await T[0].page.waitForFunction(() => document.querySelector('button[data-reg="daily"]').textContent === 'Unregister');
  await T[0].page.screenshot({ path: path.join(SHOTS, 'desktop-5-tournament-registration.png'), fullPage: true });
  await fetch(`http://127.0.0.1:${SP}/api/test/start/daily?in=2500`, { method: 'POST' });
  for (const p of T) await p.page.waitForSelector('#scrTable:not(.hidden)', { timeout: 15000 });
  await T[0].page.waitForFunction(() => /Level 1/.test(document.getElementById('tMeta').textContent));
  log('tournament started, registered players seated automatically');
  await T[0].page.waitForFunction(() => document.querySelectorAll('#seats .seat.me .hc .card').length === 2 && document.querySelectorAll('#seats .seat .pl').length === 3);
  T.forEach((p) => { p.mode = 'allin'; });
  await T[0].page.screenshot({ path: path.join(SHOTS, 'desktop-6-tournament-table.png'), fullPage: true });
  const finished = await runBots(T, 150000, async () => (await fetch(`http://127.0.0.1:${SP}/api/status`).then((r) => r.json())).winners.length > 0);
  assert(finished, 'tournament finished with a winner');
  const st2 = await (await fetch(`http://127.0.0.1:${SP}/api/status`)).json(); const winner = st2.winners[0].winner; log('tournament winner:', winner);
  assert(names.includes(winner));
  await sleep(600);
  // each player sees result modal; winners board shows the name
  for (const p of T) await p.page.waitForSelector('#scrLobby:not(.hidden)', { timeout: 20000 });
  await T[0].page.waitForFunction((w) => document.getElementById('winBoard').textContent.includes(w), winner, { timeout: 10000 });
  await T[0].page.waitForTimeout(500); await T[0].page.screenshot({ path: path.join(SHOTS, 'desktop-7-lobby-after-tournament.png'), fullPage: true });
  log('tournament flow ok: register -> scheduled start -> escalating play -> results + winners board');

  // ---- mobile ----
  const m = [await mkPlayer(browser, 'Mia Mobile', { mobile: true }), await mkPlayer(browser, 'Ned Notch')];
  await m[0].page.screenshot({ path: path.join(SHOTS, 'mobile-1-profile.png') });
  await register(m[0], 'Mia Mobile', 4); await register(m[1], 'Ned Notch', 5);
  await sleep(500); await m[0].page.screenshot({ path: path.join(SHOTS, 'mobile-2-lobby.png'), fullPage: true });
  await m[0].page.click('button[data-join="t3"]'); await m[1].page.click('button[data-join="t3"]');
  m[0].stopAtFlop = true; assert(await runBots(m, 60000, turnOf(m[0])), 'Mia turn');
  await m[0].page.screenshot({ path: path.join(SHOTS, 'mobile-3-table.png'), fullPage: true });
  m[0].stopped = false;
  const mw = await m[0].page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert(mw, 'no horizontal overflow on mobile');
  await ps[0].page.screenshot({ path: path.join(SHOTS, 'desktop-8-lobby-final.png'), fullPage: true });
  // CSP/console errors
  const allErrs = [...ps, ...m].flatMap((p) => p.errs).filter((e) => !/Failed to load resource|ERR_/.test(e)); assert.strictEqual(allErrs.length, 0, 'console/CSP errors: ' + allErrs.join(' | '));
  log('mobile ok; no console/CSP errors');
  // persistence: tournaments row saved
  await browser.close();
  log('ALL E2E OK');
}
main().then(() => { server.kill(); web.close(); process.exit(0); }).catch((e) => { console.error('E2E FAIL', e); try { server.kill(); web.close(); } catch {} process.exit(1); });
