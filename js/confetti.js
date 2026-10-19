// 의존성 없는 가벼운 컨페티. 파티클이 모두 사라지면 루프를 멈춘다.

const canvas = document.getElementById('confetti');
const ctx = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let particles = [];
let running = false;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function palette() {
  const s = getComputedStyle(document.documentElement);
  return ['--t0', '--t1', '--t2', '--t3', '--t4', '--t6'].map((v) => s.getPropertyValue(v).trim());
}

export function burst(x = innerWidth / 2, y = innerHeight / 3, count = 110) {
  if (reduceMotion.matches) return;
  const host = document.querySelector('dialog[open]') ?? document.body;
  if (canvas.parentElement !== host) host.append(canvas);
  const colors = palette();
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 8;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 5,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: colors[i % colors.length],
      life: 0,
      ttl: 90 + Math.random() * 50,
    });
  }
  if (!running) {
    running = true;
    requestAnimationFrame(tick);
  }
}

function tick() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  particles = particles.filter((p) => p.life < p.ttl && p.y < innerHeight + 40);
  for (const p of particles) {
    p.life++;
    p.vx *= 0.985;
    p.vy = p.vy * 0.985 + 0.28;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 0.1)));
    ctx.restore();
  }
  if (particles.length) requestAnimationFrame(tick);
  else {
    running = false;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
  }
}
