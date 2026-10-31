// VW FEST HOLD'EM client. All server-provided text is written with textContent (never innerHTML).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const WS_URL = (() => { const q = new URLSearchParams(location.search).get('ws'); if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/ws$/.test(q)) return q; return window.HOLDEM_WS; })();
  const KEY = 'vwfest-holdem-v1';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const num = (n) => Number(n).toLocaleString('en-US');
  const S = { ws: null, prof: null, you: null, profiles: new Map(), lobby: null, board: null, tv: null, wantTable: false, retry: 0, everConnected: false, stopRetry: false, skew: 0, chatSeen: 0, lastErr: '' };
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

  // ---------- profile ----------
  const loadProf = () => { try { const o = JSON.parse(localStorage.getItem(KEY)); if (o && /^[A-Za-z0-9_-]{16,64}$/.test(o.token)) return o; } catch {} return null; };
  const saveProf = () => { try { localStorage.setItem(KEY, JSON.stringify(S.prof)); } catch {} };
  const newToken = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); };
  const avSrc = (a) => { if (typeof a === 'string') { if (/^p:(\d|1[01])$/.test(a)) return 'av/' + a.slice(2) + '.svg'; if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) return a; } return 'av/0.svg'; };
  const prof = (pid) => S.profiles.get(pid) || { name: '?', avatar: 'p:0' };
  const avImg = (a, cls, size) => { const i = el('img', cls); i.alt = ''; i.src = avSrc(a); if (size) { i.width = size; i.height = size; } return i; };

  let pickAv = 'p:0';
  function buildAvatars() {
    const g = $('avGrid'); g.replaceChildren();
    for (let i = 0; i < 12; i++) {
      const b = el('button', 'av'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', 'Avatar ' + (i + 1)); b.dataset.a = 'p:' + i; b.append(avImg('p:' + i));
      b.addEventListener('click', () => { pickAv = 'p:' + i; markAv(); }); g.append(b);
    }
    markAv();
  }
  function markAv() { document.querySelectorAll('#avGrid .av').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.a === pickAv))); }
  function showUploaded(a) {
    let b = document.querySelector('#avGrid .av.up');
    if (!b) { b = el('button', 'av up'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', 'Your upload'); $('avGrid').append(b); b.addEventListener('click', () => { pickAv = b.dataset.a; markAv(); }); }
    b.dataset.a = a; b.replaceChildren(avImg(a)); pickAv = a; markAv();
  }
  $('inFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    const note = $('upNote');
    if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 6e6) { note.textContent = 'Use a PNG, JPG or WebP under 6 MB.'; return; }
    try {
      const bmp = await createImageBitmap(f); const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d');
      const s = Math.min(bmp.width, bmp.height); x.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 96, 96);
      // The server accepts custom avatars up to 3000 bytes (they are broadcast to the whole room): shrink size/quality until it fits.
      const MAXB = 2900, bytes = (u) => Math.floor((u.length - 23) * 3 / 4); let url = '';
      for (const px of [96, 80, 64, 48]) {
        c.width = c.height = px; x.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, px, px);
        for (let q = 0.82; q >= 0.14; q -= 0.1) { url = c.toDataURL('image/jpeg', q); if (bytes(url) < MAXB) break; }
        if (bytes(url) < MAXB) break;
      }
      if (bytes(url) >= MAXB) { note.textContent = 'That image is too detailed, try another.'; return; }
      showUploaded(url); note.textContent = 'Uploaded ✓ (resized to fit, ' + Math.round(url.length * 0.75 / 1024 * 10) / 10 + ' KB)';
    } catch { note.textContent = 'Could not read that image.'; }
  });
  function profErr(m) { const e = $('profErr'); e.textContent = m || ''; e.classList.toggle('hidden', !m); }
  $('btnGo').addEventListener('click', () => {
    const name = $('inName').value.replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,12}[A-Za-z0-9]$/.test(name)) return profErr('Username must be 3-14 letters/numbers (spaces, _ and - ok).');
    profErr(''); S.prof = { token: (S.prof && S.prof.token) || newToken(), name, avatar: pickAv }; saveProf(); S.stopRetry = false; show('scrConnecting'); $('connMsg').textContent = 'Connecting…';
    if (S.ws && S.ws.readyState === 1) sendHello(); else connect();
  });
  $('inName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnGo').click(); });
  $('btnProfile').addEventListener('click', () => { $('inName').value = S.prof ? S.prof.name : ''; pickAv = S.prof ? S.prof.avatar : 'p:0'; if (pickAv.startsWith('data:')) showUploaded(pickAv); markAv(); show('scrProfile'); });

  // ---------- screens / ui ----------
  const SCREENS = ['scrProfile', 'scrLobby', 'scrTable', 'scrFull', 'scrConnecting'];
  function show(id) { SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id)); $('btnProfile').classList.toggle('hidden', !S.you || id === 'scrProfile'); window.scrollTo(0, 0); }
  function toast(msg, bad) { const t = el('div', 'toast' + (bad ? ' bad' : ''), msg); $('toasts').append(t); setTimeout(() => t.remove(), 4500); }
  function modal(nodes) { const b = $('mBody'); b.replaceChildren(...nodes); $('modal').classList.remove('hidden'); $('mClose').focus(); }
  $('mClose').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('btnRules').addEventListener('click', () => {
    const h = el('h2', null, "How it works"); const ul = el('ul');
    ['FREE TO PLAY. Play chips only: no cash, no prizes, no real money, nothing to buy or cash out.', 'Everyone starts with 1,000 play chips. Bust? You get a free reload.', 'Texas Hold\'em: 2 hole cards, 5 community cards, best 5-card hand wins. Blinds, side pots and showdown all handled for you.', 'Up to 6 players per table, 7 tables. The room holds 25 people (watchers count).', 'You get ~25 seconds to act; time out and you check or fold. Disconnect and you auto-fold.', 'Daily Cruise: every day 7:00 PM PT. Weekly Main Event: every Saturday 6:00 PM PT. Opt in from the lobby; blinds go up every few minutes; last one standing tops the winners board.', 'Keep chat and names friendly. Be a good neighbor at the meet.'].forEach((t) => ul.append(el('li', null, t)));
    modal([h, ul]);
  });

  // ---------- connection ----------
  function setConn(state, text) { const c = $('conn'); c.className = 'conn ' + state; c.textContent = '● ' + text; }
  function sendHello() { send({ t: 'hello', token: S.prof.token, name: S.prof.name, avatar: S.prof.avatar }); }
  function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
  function connect() {
    if (S.ws && S.ws.readyState <= 1) return;
    setConn('wait', 'connecting…');
    let ws; try { ws = new WebSocket(WS_URL); } catch { return retry(); }
    S.ws = ws;
    ws.onopen = () => { S.retry = 0; if (S.prof) sendHello(); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
    ws.onclose = () => { if (S.ws === ws) S.ws = null; setConn('off', 'offline'); if (!S.stopRetry) retry(); };
    ws.onerror = () => {};
  }
  function retry() {
    S.retry++; const d = Math.min(1500 * S.retry, 8000);
    if (!S.everConnected && S.prof) { show('scrConnecting'); $('connMsg').textContent = S.retry < 3 ? 'Connecting to the table…' : 'Waking up the free game server — this can take up to a minute. Hang tight (try ' + S.retry + ')…'; }
    else if (S.you) toast('Connection lost. Reconnecting…', true);
    setTimeout(connect, d);
  }
  setInterval(() => send({ t: 'ping' }), 25000);
  $('btnRetry').addEventListener('click', () => { S.stopRetry = false; show('scrConnecting'); if (S.ws) { try { S.ws.close(); } catch {} } connect(); });

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        S.everConnected = true; S.restore = true; S.you = m.you; S.skew = 0; setConn('on', 'online'); S.profiles.clear(); for (const p of m.profiles) S.profiles.set(p.pid, p); S.profiles.set(m.you.pid, m.you);
        $('meName').textContent = m.you.name; $('meAv').src = avSrc(m.you.avatar); $('meBank').textContent = num(m.you.bankroll); $('capN').textContent = m.cap;
        $('chatLog').replaceChildren(); $('chatLog2').replaceChildren(); S.chatSeen = 0; m.chat.forEach(addChat);
        if (!S.wantTable) show('scrLobby'); break;
      case 'profile': S.profiles.set(m.p.pid, m.p); if (S.you && m.p.pid === S.you.pid) { S.you = Object.assign(S.you, m.p); $('meName').textContent = S.you.name; $('meAv').src = avSrc(S.you.avatar); } if (S.lobby) renderLobby(); if (S.tv) renderTable(); break;
      case 'lobby': S.lobby = m; renderLobby(); break;
      case 'board': S.board = m; renderBoard(); break;
      case 'table': S.tv = m.v; S.skew = Date.now() - m.v.now; if (S.restore && m.v.me >= 0) S.wantTable = true; S.restore = false; if (S.wantTable && $('scrTable').classList.contains('hidden') && !modalOpen()) show('scrTable'); renderTable(); break;
      case 'goto': S.wantTable = true; show('scrTable'); break;
      case 'left': S.wantTable = false; S.tv = null; show('scrLobby'); break;
      case 'out': S.wantTable = false; S.tv = null; show('scrLobby'); modal([el('h2', null, m.place === 1 ? '🏆 Winner!' : 'Tournament over for you'), el('p', null, m.text)]); break;
      case 'chat': addChat(m.m); break;
      case 'toast': toast(m.msg); break;
      case 'kicked': S.stopRetry = true; toast(m.msg, true); show('scrFull'); break;
      case 'err':
        if (m.stage === 'hello') {
          if (m.full) { S.stopRetry = true; show('scrFull'); break; }
          S.prof && (S.stopRetry = true); show('scrProfile'); profErr(m.msg); $('inName').value = S.prof ? S.prof.name : ''; if (S.prof) pickAv = S.prof.avatar; markAv();
        } else toast(m.msg, true);
        break;
      default:
    }
  }
  const modalOpen = () => !$('modal').classList.contains('hidden');

  // ---------- chat ----------
  function addChat(c) {
    if (c.id <= S.chatSeen) return; S.chatSeen = c.id;
    for (const id of ['chatLog', 'chatLog2']) {
      const log = $(id), atEnd = log.scrollTop + log.clientHeight > log.scrollHeight - 30; const p = el('p');
      if (c.sys) { p.className = 'sys'; p.textContent = '★ ' + c.text; } else { p.append(el('b', null, c.name + ': '), document.createTextNode(c.text)); }
      log.append(p); while (log.childNodes.length > 80) log.firstChild.remove(); if (atEnd) log.scrollTop = log.scrollHeight;
    }
  }
  for (const [f, i] of [['chatForm', 'chatIn'], ['chatForm2', 'chatIn2']]) $(f).addEventListener('submit', (e) => { e.preventDefault(); const v = $(i).value.trim(); if (v) { send({ t: 'chat', text: v }); $(i).value = ''; } });

  // ---------- lobby ----------
  function ptFmt(ms) { return new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT'; }
  function cdFmt(ms) { if (ms <= 0) return '0:00'; const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + String(m).padStart(h || d ? 2 : 1, '0') + 'm ' + String(ss).padStart(2, '0') + 's'; }
  function renderLobby() {
    const L = S.lobby; if (!L) return;
    $('onlineN').textContent = L.online; $('capN').textContent = L.cap;
    const box = $('tables'); box.replaceChildren();
    for (const t of L.tables) {
      const c = el('div', 'tcard' + (t.seated >= t.max ? ' full' : ''));
      c.append(el('div', 'nm', t.name), el('div', 'bl', `Blinds ${t.sb}/${t.bb} · ${t.seated}/${t.max} seated${t.hand ? ' · hand in play' : ''}`));
      const d = el('div', 'dots'); for (let i = 0; i < t.max; i++) { const x = el('span', 'dot' + (t.players[i] ? ' f' : '')); if (t.players[i]) { x.append(avImg(prof(t.players[i]).avatar)); x.title = prof(t.players[i]).name; } d.append(x); }
      const row = el('div', 'row'); const j = el('button', 'btn', t.seated >= t.max ? 'Full' : 'Join'); j.type = 'button'; j.disabled = t.seated >= t.max; j.dataset.join = t.id; j.addEventListener('click', () => { S.wantTable = true; send({ t: 'watch', table: t.id }); send({ t: 'sit', table: t.id, seat: -1 }); });
      const w = el('button', 'btn ghost', 'Watch'); w.type = 'button'; w.dataset.watch = t.id; w.addEventListener('click', () => { S.wantTable = true; send({ t: 'watch', table: t.id }); });
      row.append(j, w); c.append(d, row); box.append(c);
    }
    const tb = $('tourneys'); tb.replaceChildren();
    for (const t of L.tourneys) tb.append(tourneyCard(t));
    tickCd();
  }
  function tourneyCard(t) {
    const c = el('div', 'tn'); c.dataset.kind = t.kind;
    c.append(el('div', 'nm', t.label), el('div', 'muted', t.when));
    const mine = S.you && t.regs.some((r) => r.pid === S.you.pid);
    if (t.status === 'registering') {
      c.append(el('div', 'muted', 'Starts ' + ptFmt(t.startAt)));
      const cd = el('div', 'cd'); cd.dataset.at = t.startAt; c.append(cd);
      c.append(el('div', 'st', `${t.regCount} registered · ${t.stack} chips each · min ${t.minPlayers} to start`));
      const ul = el('ul'); t.regs.forEach((r) => ul.append(el('li', null, r.name))); if (!t.regs.length) ul.append(el('li', null, 'No one yet. Be first!')); c.append(ul);
      const row = el('div', 'row'); const b = el('button', 'btn', mine ? 'Unregister' : 'Register (free)'); b.type = 'button'; b.dataset.reg = t.kind; b.addEventListener('click', () => send({ t: mine ? 'unreg' : 'reg', kind: t.kind })); row.append(b); c.append(row);
      c.append(el('div', 'fine', 'Blinds go up every ' + t.levelMin + ' min. Registered players must be in the room at start time. Play chips only, no prizes.'));
    } else {
      c.append(el('div', 'st', `LIVE · Level ${t.level} · blinds ${t.blinds[0]}/${t.blinds[1]} · ${t.remaining} of ${t.entrants} left`));
      const cd = el('div', 'cd'); cd.dataset.at = t.levelEnds; cd.dataset.pre = 'Next blinds in '; c.append(cd);
      const row = el('div', 'row'); (t.tables || []).forEach((x) => { const b = el('button', 'btn ghost sm', `Watch ${x.name.split('· ')[1] || x.name} (${x.n})`); b.type = 'button'; b.addEventListener('click', () => { S.wantTable = true; send({ t: 'watch', table: x.id }); }); row.append(b); }); c.append(row);
    }
    return c;
  }
  function tickCd() {
    document.querySelectorAll('.cd').forEach((e) => { const ms = +e.dataset.at - (Date.now() - S.skew * 0); e.textContent = (e.dataset.pre || '') + (!e.dataset.pre && ms <= 0 ? 'Starting… waiting for players' : cdFmt(ms)); });
  }
  setInterval(tickCd, 1000);
  function renderBoard() {
    const B = S.board; if (!B) return;
    const ol = $('liveBoard'); ol.replaceChildren();
    B.live.slice(0, 10).forEach((r) => { const li = el('li', S.you && r.pid === S.you.pid ? 'me' : ''); li.append(el('b', null, r.name), el('span', null, num(r.chips))); ol.append(li); });
    if (!B.live.length) ol.append(el('li', 'muted', 'Nobody here yet.'));
    if (S.you) { const mine = B.live.find((r) => r.pid === S.you.pid); if (mine) $('meBank').textContent = num(mine.chips); }
    const w = $('winBoard'); w.replaceChildren();
    B.winners.slice(0, 6).forEach((r) => { const li = el('li'); li.append(el('b', null, r.winner), el('span', null, `${r.kind === 'weekly' ? 'Weekly' : 'Daily'} · ${new Date(r.finishedAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' })}`)); w.append(li); });
    if (!B.winners.length) w.append(el('li', 'muted', 'No tournaments played yet.'));
    const t = $('topWins'); t.replaceChildren(); B.top.slice(0, 5).forEach((r) => { const li = el('li'); li.append(el('b', null, r.name), el('span', null, r.wins + (r.wins === 1 ? ' win' : ' wins'))); t.append(li); });
    if (!B.top.length) t.append(el('li', 'muted', '—'));
  }

  // ---------- table ----------
  const cardEl = (c, win) => {
    if (c === '??') return el('div', 'card back', '.');
    const r = c[0] === 'T' ? '10' : c[0], red = c[1] === 'h' || c[1] === 'd'; const d = el('div', 'card' + (red ? ' red' : '') + (win ? ' win' : ''));
    d.append(document.createTextNode(r), el('small', null, SUIT[c[1]])); return d;
  };
  let timerSeat = null;
  function renderTable() {
    const v = S.tv; if (!v) return;
    $('tName').textContent = v.name; $('tBlinds').textContent = `· blinds ${v.sb}/${v.bb}`;
    const meta = $('tMeta'); meta.textContent = v.meta ? `Level ${v.meta.level} · ${v.meta.remaining} players left · blinds up in ${cdFmt(v.meta.levelEnds - Date.now())}` : '';
    const base = v.me >= 0 ? v.me : 0, pos = (i) => (i - base + 6) % 6;
    const board = $('board'); board.replaceChildren(); v.board.forEach((c) => board.append(cardEl(c)));
    $('pot').textContent = v.pot > 0 ? 'Pot ' + num(v.pot) : '';
    $('phase').textContent = v.phase === 'idle' ? '' : v.phase === 'over' ? 'Hand complete' : v.phase;
    const winners = new Set(); if (v.last && (v.phase === 'over' || v.phase === 'idle')) v.last.pots.forEach((p) => p.winners.forEach((w) => winners.add(w.seat)));
    const seats = $('seats'); seats.replaceChildren(); timerSeat = null;
    v.seats.forEach((s, i) => {
      const p = pos(i);
      if (!s) {
        const c = el('div', 'seat pos' + p); if (v.me < 0 && v.kind === 'cash') { const e = el('div', 'empty'); const b = el('button', 'btn', 'Sit'); b.type = 'button'; b.dataset.seat = i; b.addEventListener('click', () => send({ t: 'sit', table: v.id, seat: i })); e.append(b); c.append(e); } else c.append(el('div', 'empty', 'Empty')); seats.append(c); return;
      }
      const c = el('div', 'seat pos' + p + (i === v.cur ? ' turn' : '') + (s.folded ? ' folded' : '') + (i === v.me ? ' me' : '') + (winners.has(i) ? ' winner' : '')); c.dataset.seat = i;
      const pl = el('div', 'pl'); pl.append(avImg(prof(s.pid).avatar, 'av2')); pl.append(el('div', 'sn', s.name), el('div', 'sc', num(s.chips)));
      const st = s.sitOut ? 'SITTING OUT' : s.away ? 'DISCONNECTED' : s.folded ? 'FOLDED' : s.allIn ? 'ALL-IN' : s.hand || (i === v.cur ? 'THINKING…' : '');
      pl.append(el('div', 'st', st));
      if (s.cards) { const hc = el('div', 'hc'); s.cards.forEach((x) => hc.append(cardEl(x))); pl.append(hc); }
      if (i === v.cur) { const tm = el('div', 'tm'), bar = el('i'); tm.append(bar); pl.append(tm); timerSeat = { bar, deadline: v.deadline + S.skew, total: v.deadline ? Math.max(1500, v.deadline - v.now) : 1 }; }
      if (i === v.dealer && v.phase !== 'idle') pl.append(el('div', 'dbtn', 'D'));
      c.append(pl); seats.append(c);
      if (s.bet > 0) { const b = el('div', 'bet pos' + p, num(s.bet)); seats.append(b); }
    });
    // banner
    const bn = $('banner'); let msg = '';
    const seated = v.seats.filter(Boolean).length;
    if (v.last && (v.phase === 'over' || v.phase === 'idle') && v.last.pots.length) msg = v.last.pots.map((p) => p.winners.map((w) => `${w.name} wins ${num(w.amount)}${w.hand ? ' with ' + w.hand : ''}`).join(' · ')).join('  |  ');
    else if (v.phase === 'idle') msg = seated < 2 ? (v.kind === 'cash' ? (v.me >= 0 ? 'Waiting for another player to sit down…' : 'Sit down to play: you start with your play chips.') : 'Waiting…') : 'Next hand starting…';
    bn.textContent = msg; bn.classList.toggle('hidden', !msg);
    // controls
    const ctl = $('controls'), sob = $('sitOutBar');
    sob.classList.toggle('hidden', !v.sitOut);
    if (v.act) {
      const a = v.act; ctl.classList.remove('hidden');
      $('aCall').textContent = a.toCall > 0 ? `Call ${num(a.toCall)}` : 'Check';
      const key = [v.handN, v.phase, v.cur, a.cur, a.min, a.max].join('|');
      document.querySelector('.raisebox').classList.toggle('hidden', !a.canRaise);
      if (key !== S.ctlKey) { S.ctlKey = key; const r = $('rRange'), n = $('rAmt'); r.min = a.min; r.max = a.max; r.value = a.min; n.min = a.min; n.max = a.max; n.value = a.min; $('aRaise').textContent = a.cur > 0 ? 'Raise to' : 'Bet'; }
    } else { ctl.classList.add('hidden'); S.ctlKey = null; }
    // log
    const lg = $('hlog'); lg.replaceChildren(); v.log.forEach((l) => lg.append(el('p', null, l))); lg.scrollTop = lg.scrollHeight;
  }
  function tickTimer() {
    if (timerSeat) { const left = timerSeat.deadline - Date.now(), f = Math.max(0, Math.min(1, left / timerSeat.total)); timerSeat.bar.style.transform = 'scaleX(' + f.toFixed(3) + ')'; timerSeat.bar.style.background = f < 0.3 ? '#ff5252' : ''; }
    requestAnimationFrame(tickTimer);
  }
  requestAnimationFrame(tickTimer);
  setInterval(() => { if (S.tv && S.tv.meta && !$('scrTable').classList.contains('hidden')) $('tMeta').textContent = `Level ${S.tv.meta.level} · ${S.tv.meta.remaining} players left · blinds up in ${cdFmt(S.tv.meta.levelEnds - Date.now())}`; }, 1000);
  // actions
  const act = (a, amt) => send({ t: 'act', a, amt });
  $('aFold').addEventListener('click', () => act('fold'));
  $('aCall').addEventListener('click', () => act('call'));
  $('aRaise').addEventListener('click', () => { const a = S.tv && S.tv.act; const x = +$('rAmt').value; act(a && x >= a.max ? 'allin' : 'raise', x); });
  $('rRange').addEventListener('input', () => { $('rAmt').value = $('rRange').value; });
  $('rAmt').addEventListener('input', () => { $('rRange').value = $('rAmt').value; });
  const setAmt = (x) => { const a = S.tv && S.tv.act; if (!a) return; x = Math.max(a.min, Math.min(a.max, Math.round(x))); $('rAmt').value = x; $('rRange').value = x; };
  $('qMin').addEventListener('click', () => setAmt(S.tv.act.min));
  $('qHalf').addEventListener('click', () => setAmt(S.tv.act.cur + (S.tv.pot + S.tv.act.toCall) / 2));
  $('qPot').addEventListener('click', () => setAmt(S.tv.act.cur + S.tv.pot + S.tv.act.toCall));
  $('qAll').addEventListener('click', () => setAmt(S.tv.act.max));
  $('aBack').addEventListener('click', () => send({ t: 'back' }));
  $('btnLobby').addEventListener('click', () => { S.wantTable = false; if (S.tv && S.tv.me < 0) send({ t: 'unwatch' }); show('scrLobby'); if (S.tv && S.tv.me >= 0) toast('You are still seated. Use "Leave table" to stand up.'); });
  $('btnLeave').addEventListener('click', () => { send({ t: 'leave' }); if (S.tv && S.tv.kind === 'tourney' && S.tv.me >= 0) toast('You stay in the tournament and will auto-fold. Rejoin from the lobby.'); });
  document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || $('scrTable').classList.contains('hidden') || !S.tv || !S.tv.act) return; if (e.key === 'f') act('fold'); if (e.key === 'c') act('call'); });

  // ---------- boot ----------
  buildAvatars();
  S.prof = loadProf();
  if (S.prof) { $('inName').value = S.prof.name; if (S.prof.avatar.startsWith('data:')) showUploaded(S.prof.avatar); else { pickAv = S.prof.avatar; markAv(); } show('scrConnecting'); connect(); }
  else { show('scrProfile'); connect(); }
  if (!S.prof) { /* socket only needed after profile; keep it simple: close until profile saved */ S.stopRetry = true; }
})();
