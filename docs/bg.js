// Live VW background: dusk sky, retro sun, neon grid, cruising air-cooled VWs with headlights, sparkles + neon sign,
// plus a slow crossfading slideshow of VW Fest scenes. Pure canvas, no network. Respects prefers-reduced-motion.
(() => {
  const cv = document.getElementById('bg'), ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1;
  const resize = () => { dpr = Math.min(window.devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight; cv.width = W * dpr | 0; cv.height = H * dpr | 0; cv.style.width = W + 'px'; cv.style.height = H + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  addEventListener('resize', resize); resize();
  const P = {
    beetle: new Path2D('M8 70c0-12 4-18 16-20 8-12 20-18 34-12 12 2 22 10 26 20 4 4 4 8 4 12z'),
    ghia: new Path2D('M6 70c0-8 6-10 16-12 10-10 24-14 38-8 12 2 22 6 30 12 2 2 2 4 2 8z'),
  };
  const COL = ['#e8641a', '#f2b705', '#e0322b', '#3fb6a8', '#c7a63a', '#ff5fa2', '#7fd1ff'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.55, r: rnd(0.4, 1.6), p: Math.random() * 6.28 }));
  const sparks = Array.from({ length: 36 }, () => ({ x: Math.random(), y: Math.random(), s: rnd(3, 9), v: rnd(0.01, 0.05), p: Math.random() * 6.28, c: ['#ffd23f', '#ff5fa2', '#7fd1ff', '#fff'][Math.random() * 4 | 0] }));
  let cars = [];
  const spawn = (initial) => {
    const dir = Math.random() < 0.5 ? 1 : -1, lane = Math.random() < 0.5 ? 0 : 1, type = ['bus', 'beetle', 'ghia', 'thing'][Math.random() * 4 | 0];
    cars.push({ dir, lane, type, c: COL[Math.random() * COL.length | 0], x: initial ? rnd(0, 1) : (dir > 0 ? -0.25 : 1.25), v: rnd(0.035, 0.075) * dir, s: 0, ph: Math.random() * 6 });
  };
  for (let i = 0; i < 4; i++) spawn(true);
  function drawCar(c, t) {
    const horizon = H * 0.62, roadTop = horizon + 8, laneY = roadTop + (c.lane ? 0.62 : 0.28) * (H - roadTop);
    const sc = (0.5 + (c.lane ? 0.55 : 0.22)) * Math.min(W, 1000) / 900 * 1.15, x = c.x * W, y = laneY + Math.sin(t * 6 + c.ph) * 0.8;
    ctx.save(); ctx.translate(x, y); ctx.scale(c.dir * sc, sc); ctx.translate(-48, -74);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(48, 82, 44, 5, 0, 0, 6.3); ctx.fill();
    ctx.shadowColor = c.c; ctx.shadowBlur = 14;
    ctx.fillStyle = c.c;
    if (c.type === 'beetle') ctx.fill(P.beetle); else if (c.type === 'ghia') ctx.fill(P.ghia);
    else if (c.type === 'bus') { ctx.beginPath(); ctx.roundRect(8, 38, 80, 34, 8); ctx.fill(); ctx.fillStyle = '#f5ecd5'; ctx.fillRect(8, 52, 80, 18); }
    else { ctx.fillRect(10, 44, 76, 28); ctx.fillStyle = '#222'; ctx.fillRect(48, 30, 3, 15); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(160,215,240,.75)';
    if (c.type === 'bus') for (let i = 0; i < 4; i++) ctx.fillRect(14 + i * 15, 43, 11, 9);
    else if (c.type === 'thing') ctx.fillRect(34, 32, 15, 12); else ctx.fillRect(28, 50, 30, 8);
    ctx.fillStyle = '#111'; for (const wx of [26, 70]) { ctx.beginPath(); ctx.arc(wx, 72, 8, 0, 6.3); ctx.fill(); ctx.fillStyle = '#bbb'; ctx.beginPath(); ctx.arc(wx, 72, 3.4, 0, 6.3); ctx.fill(); ctx.fillStyle = '#111'; }
    // headlight + beam
    const g = ctx.createLinearGradient(86, 0, 160, 0); g.addColorStop(0, 'rgba(255,240,170,.55)'); g.addColorStop(1, 'rgba(255,240,170,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(86, 62); ctx.lineTo(170, 52); ctx.lineTo(170, 80); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff6c9'; ctx.beginPath(); ctx.arc(86, 62, 3.2, 0, 6.3); ctx.fill();
    ctx.restore();
  }
  function sparkle(x, y, s, col, a) {
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a; ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.quadraticCurveTo(0, 0, s, 0); ctx.quadraticCurveTo(0, 0, 0, s); ctx.quadraticCurveTo(0, 0, -s, 0); ctx.quadraticCurveTo(0, 0, 0, -s); ctx.fill(); ctx.restore();
  }
  let last = 0, t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    const horizon = H * 0.62;
    let g = ctx.createLinearGradient(0, 0, 0, horizon); g.addColorStop(0, '#0b0620'); g.addColorStop(0.55, '#3a0f55'); g.addColorStop(1, '#ff6b35'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, horizon + 1);
    for (const s of stars) { ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.4 + s.p)); ctx.fillStyle = '#fff'; ctx.fillRect(s.x * W, s.y * H, s.r, s.r); } ctx.globalAlpha = 1;
    // retro sun with slits
    const sx = W * 0.5, sr = Math.min(W, H) * 0.19; ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, horizon); ctx.clip();
    g = ctx.createLinearGradient(0, horizon - sr * 1.6, 0, horizon + sr * 0.2); g.addColorStop(0, '#ffe27a'); g.addColorStop(1, '#ff3d7f'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, horizon - sr * 0.55, sr, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#2a0b3f'; for (let i = 0; i < 6; i++) { const yy = horizon - sr * 0.55 + sr * (0.1 + i * 0.16); ctx.fillRect(sx - sr, yy, sr * 2, 1.5 + i * 1.2); } ctx.restore();
    // ground + neon grid
    g = ctx.createLinearGradient(0, horizon, 0, H); g.addColorStop(0, '#1a0830'); g.addColorStop(1, '#0a0614'); ctx.fillStyle = g; ctx.fillRect(0, horizon, W, H - horizon);
    ctx.strokeStyle = 'rgba(255,60,200,.55)'; ctx.lineWidth = 1; ctx.shadowColor = '#ff3cc8'; ctx.shadowBlur = 6;
    for (let i = -14; i <= 14; i++) { ctx.beginPath(); ctx.moveTo(sx + i * 12, horizon); ctx.lineTo(sx + i * W * 0.16, H); ctx.stroke(); }
    const off = (t * 0.25) % 1; for (let i = 0; i < 12; i++) { const k = ((i + off) / 12) ** 2.2, y = horizon + k * (H - horizon); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.shadowBlur = 0;
    // road
    const rt = horizon + 8; ctx.fillStyle = 'rgba(14,12,14,.82)'; ctx.fillRect(0, rt, W, H - rt);
    ctx.strokeStyle = 'rgba(232,163,23,.8)'; ctx.setLineDash([36, 28]); ctx.lineDashOffset = -t * 60; ctx.lineWidth = 3; ctx.beginPath(); const my = rt + 0.45 * (H - rt); ctx.moveTo(0, my); ctx.lineTo(W, my); ctx.stroke(); ctx.setLineDash([]);
    // neon sign
    const na = 0.75 + 0.25 * Math.sin(t * 3) * (Math.sin(t * 13) > -0.9 ? 1 : 0.3);
    ctx.save(); ctx.globalAlpha = na; ctx.font = `900 ${Math.max(18, Math.min(W * 0.045, 54))}px Anton, Impact, sans-serif`; ctx.textAlign = 'center'; ctx.shadowColor = '#ff3cc8'; ctx.shadowBlur = 22; ctx.fillStyle = '#ffd6f5'; ctx.fillText('$VWFEST', W * 0.5, horizon * 0.30); ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 14; ctx.font = `600 ${Math.max(10, Math.min(W * 0.016, 18))}px Rajdhani, sans-serif`; ctx.fillStyle = '#b8f6ff'; ctx.fillText('AIR-COOLED · HOLD\u2019EM · 209', W * 0.5, horizon * 0.30 + 24); ctx.restore();
    // cars
    for (const c of cars) { if (!reduce) c.x += c.v * dt; }
    cars = cars.filter(c => c.x > -0.35 && c.x < 1.35); while (cars.length < 5) spawn(false);
    cars.sort((a, b) => a.lane - b.lane); for (const c of cars) drawCar(c, t);
    // sparkles
    for (const s of sparks) { const a = 0.15 + 0.7 * Math.abs(Math.sin(t * (0.8 + s.v * 20) + s.p)); s.y -= s.v * dt * (reduce ? 0 : 1); if (s.y < -0.05) { s.y = 1.02; s.x = Math.random(); } sparkle(s.x * W, s.y * H, s.s, s.c, a * 0.8); }
    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // slideshow (VW Fest scenes), slow crossfade + Ken Burns
  const imgs = ['bg/race.jpg', 'bg/drag.jpg', 'bg/zombies.jpg'], a = document.getElementById('sl1'), b = document.getElementById('sl2');
  let i = 0, front = a; a.classList.add('on');
  if (!reduce) setInterval(() => { i = (i + 1) % imgs.length; const back = front === a ? b : a; back.src = imgs[i]; back.classList.add('on'); front.classList.remove('on'); front = back; }, 9000);
})();
