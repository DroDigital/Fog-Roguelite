// End-to-end smoke test: builds nothing, serves dist/ with `vite preview`, drives the
// game headlessly through Playwright and asserts the core loops work without errors.
//
//   npm run build && npm run smoke
//
// Requires the `playwright` package and a Chromium build (npx playwright install chromium).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    // also honour NODE_PATH / globally installed playwright
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    chromium = null;
  }
}
if (!chromium) {
  console.error('playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const PORT = 4199;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await sleep(2500);

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/?autostart&seed=1234&noloop&q=low`);
  await page.waitForFunction(() => window.game && window.game.player && window.game.state === 'playing', null, { timeout: 120000 });

  const r = await page.evaluate(() => {
    const g = window.game;
    const out = {};
    const P = () => g.player.pos;
    const fwd = () => ({ x: -Math.sin(g.player.yaw), z: -Math.cos(g.player.yaw) });
    const ahead = (d) => P().clone().add({ x: fwd().x * d, y: 0, z: fwd().z * d });
    g.spawnT = 1e9;
    g.player.iframes = 1e9;
    for (let i = 0; i < 3; i++) g.frame(1 / 60, i === 2);

    // melee severs a limb
    const a = g.spawnEnemy('hollow', ahead(1.8));
    a.state = 'idle';
    g.player.pitch = -0.1;
    for (let k = 0; k < 6 && a.alive; k++) {
      g.input.inject('Mouse0', true); g.frame(1 / 60, false); g.input.inject('Mouse0', false);
      for (let i = 0; i < 45; i++) g.frame(1 / 60, false);
    }
    out.meleeKill = !a.alive;
    out.dbgA = [a.state, Math.round(a.hp), +a.pos.distanceTo(P()).toFixed(2), Math.round(g.player.stamina)];

    // direct dismemberment API
    const b = g.spawnEnemy('hollow', ahead(2));
    b.state = 'idle';
    g.frame(1 / 60, false);
    b.hit({ seg: 3, point: b.joints[5].clone(), dir: b.pos.clone().sub(P()).normalize(), damage: 40, sever: 2, blunt: false, stagger: 1, crit: false, source: 'melee' });
    out.severed = !b.segAlive[3];

    // posture break + execution
    b.addPosture(1e4);
    g.player.yaw = Math.atan2(-(b.pos.x - P().x), -(b.pos.z - P().z));
    g.frame(1 / 60, false);
    g.input.inject('KeyE', true); g.frame(1 / 60, false); g.input.inject('KeyE', false);
    for (let i = 0; i < 90; i++) g.frame(1 / 60, false);
    out.executed = !b.alive && !b.segAlive[1];
    out.dbgB = [b.state, +b.joints[1].distanceTo(g.camera.position).toFixed(2), !!g.player.executing];

    // crossbow headshot
    const c = g.spawnEnemy('hollow', ahead(8));
    c.state = 'idle';
    g.input.inject('Digit2', true); g.frame(1 / 60, false); g.input.inject('Digit2', false);
    for (let i = 0; i < 30; i++) g.frame(1 / 60, false);
    const h = c.joints[2], e = g.camera.position;
    g.player.yaw = Math.atan2(-(h.x - e.x), -(h.z - e.z));
    g.player.pitch = Math.atan2(h.y - e.y, Math.hypot(h.x - e.x, h.z - e.z)) + 0.008;
    for (let i = 0; i < 3; i++) g.frame(1 / 60, false);
    g.input.inject('Mouse0', true); g.frame(1 / 60, false); g.input.inject('Mouse0', false);
    for (let i = 0; i < 40; i++) g.frame(1 / 60, false);
    out.boltKill = !c.alive;

    // boss + beacons exist
    g.spawnBoss();
    for (let i = 0; i < 120; i++) g.frame(1 / 60, false);
    out.boss = !!g.boss && g.boss.alive;
    out.beacons = g.world.beaconsNear(0, 0, 400).length;

    // soak: random input across the live director
    g.spawnT = 2;
    const keys = ['KeyW', 'KeyA', 'KeyD', 'ShiftLeft', 'Space', 'Mouse0', 'Mouse2', 'Digit1', 'Digit2', 'KeyQ', 'KeyF', 'KeyR'];
    for (let i = 0; i < 3000; i++) {
      if (g.state === 'levelup') document.querySelector('#l-choices .choice').click();
      g.input.inject('KeyW', true);
      if (i % 7 === 0) g.input.inject(keys[(Math.random() * keys.length) | 0], Math.random() < 0.6);
      g.input.mouseDX = Math.sin(i * 0.01) * 8;
      g.frame(1 / 60, i % 500 === 0);
    }
    out.soakState = g.state;
    out.travelled = Math.round(g.player.distance);
    return out;
  });

  console.log(JSON.stringify(r));
  check('melee swings kill a hollow', r.meleeKill);
  check('a limb can be severed', r.severed);
  check('guard-broken foe can be executed', r.executed);
  check('crossbow bolt kills', r.boltKill);
  check('boss spawns', r.boss);
  check('beacons are generated', r.beacons >= 2, `(${r.beacons})`);
  check('soak run completes', ['playing', 'levelup', 'dying', 'dead'].includes(r.soakState), r.soakState);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
