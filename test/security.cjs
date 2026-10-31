// Security regression tests (local server only, no DB). Usage: node test/security.cjs
const { spawn } = require('child_process'); const WebSocket = require('ws');
const PORT = 3171, B = `http://127.0.0.1:${PORT}`, ORIGIN = 'https://vwfest.github.io';
let fails = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, RENDER: 'true', HOLDEM_TEST: '', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
srv.stderr.on('data', d => process.stderr.write(d));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/healthz')).ok) return; } catch {} await sleep(200); } throw new Error('server did not start'); };
// open a ws; resolves {ws, status} where status is the HTTP status on rejection or 101 when upgraded
const open = (headers) => new Promise(res => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
  const msgs = []; ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  ws.on('open', () => res({ ws, status: 101, msgs })); ws.on('unexpected-response', (rq, r) => { res({ ws, status: r.statusCode, msgs }); r.resume(); }); ws.on('error', () => {});
});
const tok = () => [...Array(24)].map(() => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.random() * 36 | 0]).join('');
const hello = (c, name, token = tok()) => { c.ws.send(JSON.stringify({ t: 'hello', token, name, avatar: 'p:1' })); return token; };
const until = async (c, f, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = [...c.msgs].reverse().find(f); if (m) return m; await sleep(100); } return null; };
(async () => {
  await wait();
  // --- origin
  let c = await open({}); ok(c.status === 403, 'WebSocket without Origin refused');
  c = await open({ origin: 'https://evil.example' }); ok(c.status === 403, 'WebSocket from foreign Origin refused');
  const hr = await fetch(B + '/api/status', { headers: { origin: 'https://evil.example' } }); ok(hr.status === 403, 'HTTP API refuses foreign Origin');
  ok(/camera=\(\)/.test((await fetch(B + '/healthz')).headers.get('permissions-policy') || ''), 'Permissions-Policy header present');
  // --- per-IP connection cap keyed on the real client IP (default 8), not a spoofable X-Forwarded-For
  const many = []; for (let i = 0; i < 9; i++) many.push(await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': `10.0.${i}.1, 203.0.113.9` }));
  ok(many.slice(0, 8).every(m => m.status === 101) && many[8].status === 429, 'ws per-IP cap holds when X-Forwarded-For is rotated');
  const fresh = await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.8' }); ok(fresh.status === 101, 'a different client IP is unaffected'); fresh.ws.close();
  many.forEach(m => m.ws.close && m.ws.close()); await sleep(300);
  // --- names / hello validation
  c = await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.20' });
  for (const n of ['Admin', 'VW FEST', 'Dealer', '<script>x</script>', "a'; DROP TABLE x;--", 'fuuuck', 'ab']) {
    hello(c, n); const e = await until(c, m => m.t === 'err' && m.stage === 'hello'); ok(!!e, 'name rejected: ' + n); c.msgs.length = 0; }
  c.ws.send(JSON.stringify({ t: 'hello', token: 'short', name: 'Okname', avatar: 'p:1' })); ok(!!(await until(c, m => m.t === 'err')), 'short session token rejected'); c.msgs.length = 0;
  c.ws.send(JSON.stringify({ t: 'hello', token: tok(), name: 'Okname', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })); ok(!!(await until(c, m => m.t === 'err')), 'SVG/other data: avatar rejected'); c.msgs.length = 0;
  const av = n => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 7)]).toString('base64');
  c.ws.send(JSON.stringify({ t: 'hello', token: tok(), name: 'BigAvatar', avatar: av(5000) })); ok(!!(await until(c, m => m.t === 'err' && m.stage === 'hello')), 'custom avatar of 5 KB refused (cap ~3 KB, it is broadcast to the room)'); c.msgs.length = 0;
  c.ws.send(JSON.stringify({ t: 'hello', token: tok(), name: 'BigAvatar', avatar: av(11000) })); ok(!!(await until(c, m => m.t === 'err' && m.stage === 'hello')), 'custom avatar of 11 KB refused'); c.msgs.length = 0;
  c.ws.send(JSON.stringify({ t: 'act', a: 'raise', amt: 1e9 })); ok(!!(await until(c, m => m.t === 'err' && /hello/.test(m.msg))), 'actions before hello refused'); c.ws.close();
  { const d = await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.24' }); d.ws.send(JSON.stringify({ t: 'hello', token: tok(), name: 'TinyAvatar', avatar: av(2800) })); ok(!!(await until(d, m => m.t === 'welcome')), 'custom avatar of 2.8 KB accepted'); d.ws.close(); }
  // --- hidden cards: opponent hole cards are never sent before showdown
  const A = await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.21' }), Bc = await open({ origin: ORIGIN, 'cf-connecting-ip': '198.51.100.22' });
  hello(A, 'Alice1'); hello(Bc, 'Bobby2'); await until(A, m => m.t === 'welcome'); await until(Bc, m => m.t === 'welcome');
  A.ws.send(JSON.stringify({ t: 'sit', table: 't1', seat: 0 })); Bc.ws.send(JSON.stringify({ t: 'sit', table: 't1', seat: 1 }));
  const dealt = m => m.t === 'table' && m.v.seats.some(s => s && s.cards);
  const va = await until(A, dealt, 20000); ok(!!va, 'hand dealt');
  if (va) {
    const meA = va.v.me, other = va.v.seats.find((s, i) => s && i !== meA);
    ok(va.v.seats[meA].cards.every(x => /^[2-9TJQKA][shdc]$/.test(x)), 'player sees own hole cards');
    ok(other.cards.every(x => x === '??'), 'opponent hole cards are masked ("??") in the payload');
    const raw = JSON.stringify(A.msgs); const vb = [...Bc.msgs].reverse().find(dealt); const bc = vb && vb.v.seats[vb.v.me].cards;
    ok(bc && !bc.some(x => raw.includes('"' + x + '"') && !(va.v.board || []).includes(x)), "opponent's real cards appear nowhere in the other client's messages");
  }
  // --- invalid actions / amounts never corrupt state or crash
  for (const [a, amt] of [['raise', 'Infinity'], ['raise', -5], ['raise', null], ['raise', { x: 1 }], ['raise', 1e12], ['bogus', 1], [{ $ne: 1 }, 1]]) A.ws.send(JSON.stringify({ t: 'act', a, amt }));
  A.ws.send(JSON.stringify({ t: 'sit', table: 't1', seat: 1.5 })); A.ws.send(JSON.stringify({ t: 'sit', table: { a: 1 }, seat: 0 })); A.ws.send(Buffer.from([1, 2, 3]));
  await sleep(500); const h2 = await fetch(B + '/healthz'); ok(h2.ok, 'server alive after malformed actions/binary frame');
  // --- chat: control chars / links stripped, flood limited, oversized frame closes the socket
  Bc.msgs.length = 0; Bc.ws.send(JSON.stringify({ t: 'chat', text: 'hi\u202e evil https://phish.example/x \u0000there' }));
  const ch = await until(Bc, m => m.t === 'chat', 4000); ok(ch && !/https?:|\u202e|\u0000/.test(ch.m.text) && /\[link\]/.test(ch.m.text), 'chat strips links + bidi/control characters');
  let closed = false; Bc.ws.on('close', () => closed = true); Bc.ws.send('x'.repeat(30000)); await sleep(500); ok(closed, 'oversized frame (>20 KB) closes the connection');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); srv.kill(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
