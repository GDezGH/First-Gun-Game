/**
 * play.test.js — end-to-end test suite driven by a real browser.
 *
 * Two phases:
 *
 *   Phase A (integration) — the real requestAnimationFrame loop runs.
 *     Asserts the game boots, renders, and throws nothing.
 *
 *   Phase B (logic) — the rAF loop is frozen by putting the game in
 *     'paused', and step(1/120) is called by hand. This decouples the
 *     simulation from the renderer, which matters because software
 *     WebGL renders at ~3 fps and would otherwise run the whole game at
 *     22% speed and make every timing assertion lie.
 *
 * Run:  node play.test.js
 */

const puppeteer = require('puppeteer');
const URL = process.env.URL || 'http://127.0.0.1:8080/';

let passed = 0, failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? `  ->  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : String(v);

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader',
           '--use-gl=angle', '--use-angle=swiftshader',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const consoleErrors = [], pageErrors = [], notFound = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

  // Headless Chromium will not grant a real pointer lock; fake the two things
  // the game actually reads.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true, get: () => window.__fakeLocked || null,
    });
    Element.prototype.requestPointerLock = function () {
      window.__fakeLocked = this;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    document.exitPointerLock = function () {
      window.__fakeLocked = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
  });

  // ======================================================================
  // PHASE A — integration
  // ======================================================================

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  check('game boots and exposes __fgg',
    await page.evaluate(() => typeof window.__fgg === 'object' && !!window.__fgg.player));
  check('main menu visible on load',
    await page.evaluate(() => !document.getElementById('menu-main').classList.contains('hidden')));

  const geo = await page.evaluate(() => ({
    colliders: window.__fgg.world.colliders.length,
    spawnPoints: window.__fgg.world.spawnPoints.length,
    weapons: window.__fgg.weapons.slots.length,
  }));
  check('arena built with solid geometry', geo.colliders > 40, `${geo.colliders} colliders`);
  check('six weapons loaded', geo.weapons === 6, `${geo.weapons} slots`);
  check('spawn points generated', geo.spawnPoints > 20, `${geo.spawnPoints}`);

  await page.click('#btn-start');
  await sleep(400);
  check('DEPLOY starts a run',
    (await page.evaluate(() => window.__fgg.state.mode)) === 'playing');

  // Spawn must not be embedded in geometry (regression: it used to be inside
  // the centre platform, which ejected the player onto its roof).
  const spawn = await page.evaluate(() => ({
    y: window.__fgg.player.pos.y, grounded: window.__fgg.player.grounded,
  }));
  check('player spawns standing on the floor, not inside geometry',
    near(spawn.y, 0, 0.01) && spawn.grounded, `y=${spawn.y}`);

  const perf = await page.evaluate(() => new Promise((res) => {
    // Discard a short warm-up: under software GL the first frames pay a one-time
    // shader-compilation stall that would skew the sample. We assert the renderer
    // SUSTAINS frames, which still fails hard if rendering is actually broken.
    let n = 0; let t0 = null; const warm = performance.now();
    const tick = () => {
      if (performance.now() - warm < 600) { requestAnimationFrame(tick); return; }
      if (t0 === null) t0 = performance.now();
      n++;
      performance.now() - t0 < 2000 ? requestAnimationFrame(tick)
        : res({ fps: n / 2, calls: window.__fgg.renderer.info.render.calls });
    };
    requestAnimationFrame(tick);
  }));
  check('renderer produces frames', perf.fps > 2, `${perf.fps.toFixed(1)} fps (swiftshader)`);
  check('scene draws geometry', perf.calls > 20, `${perf.calls} draw calls`);

  // ======================================================================
  // PHASE B — logic, with the render loop frozen
  // ======================================================================

  // Helper installed in the page: resets to a known state and runs N ticks
  // of simulation with a given set of held keys.
  await page.evaluate(() => {
    window.__t = {
      /** Freeze the rAF loop and reset the world to a clean slate. */
      reset() {
        const g = window.__fgg;
        g.state.mode = 'paused';           // frame loop now skips step()
        for (const k of Object.keys(g.input.keys)) delete g.input.keys[k];
        g.input.buttons[0] = false;
        g.enemies.clear(); g.pickups.clear(); g.effects.clear();
        g.player.reset(); g.weapons.reset();
        Object.assign(g.state, {
          wave: 0, score: 0, kills: 0, time: 0,
          intermission: 0, spawnQueue: 0, spawnTimer: 0,
          wantFire: false, triggerHeld: false,
        });
        return g;
      },
      /** Run n fixed ticks. keys = {KeyW:true,...}; hold is toggled around. */
      run(n, keys = {}) {
        const g = window.__fgg;
        for (const [k, v] of Object.entries(keys)) g.input.keys[k] = v;
        for (let i = 0; i < n; i++) g.step(1 / 120);
        for (const k of Object.keys(keys)) delete g.input.keys[k];
        return g;
      },
      /** Hold the trigger for n ticks of the current weapon. */
      fire(n) {
        const g = window.__fgg;
        g.weapons.pullTrigger(g.player, g.enemies);
        for (let i = 0; i < n; i++) g.step(1 / 120);
        g.weapons.releaseTrigger();
        return g;
      },
      /** A throwaway grunt with no behaviour, placed at (x, y, z). */
      dummy(x, y, z, hp = 60) {
        const g = window.__fgg;
        const e = g.enemies.spawn({
          id: 'grunt', label: 'GRUNT', health: hp, speed: 0, damage: 0,
          fireInterval: 9999, accuracy: 1.5, preferredRange: 6,
          bodyColor: 0x3f8f4f, eyeColor: 0xb6ff5a, height: 1.75,
          score: 100, spawnWeight: 1,
        }, { clone: () => window.__fgg.player.pos.clone().set(x, y, z) }, 1);
        e.pos.set(x, y, z);
        e.state = 'chase'; e.stateTimer = 0; e.group.scale.setScalar(1);
        e.group.position.set(x, y, z);
        e.syncHitVolumes();
        return e;
      },
    };
  });

  // ---- movement -------------------------------------------------------
  const move = await page.evaluate(() => {
    const t = window.__t; t.reset();
    // Run the movement test on the open 16x16 centre platform so the result
    // measures the controller, not how far away the nearest wall happens to be.
    window.__fgg.player.pos.set(0, 1.2, 0);
    window.__fgg.player.grounded = true;
    const s = { ...window.__fgg.player.pos };
    t.run(120, { KeyW: true });                       // exactly 1.00 s
    const p = window.__fgg.player;
    return { dist: Math.hypot(p.pos.z - s.z, p.pos.x - s.x), speed: Math.hypot(p.vel.x, p.vel.z) };
  });
  check('W walks forward at WALK_SPEED', near(move.dist, 5.6, 0.6) && near(move.speed, 5.6, 0.05),
    `${fmt(move.dist)}m in 1s, ${fmt(move.speed)} m/s`);

  const sprint = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.player.pos.set(0, 1.2, 0);
    g.player.grounded = true;
    // Assert on PEAK speed, not the speed at an arbitrary tick -- the player
    // may have run off the platform by then.
    let peak = 0;
    for (let i = 0; i < 180; i++) {
      t.run(1, { KeyW: true });
      peak = Math.max(peak, Math.hypot(g.player.vel.x, g.player.vel.z));
    }
    return peak;
  });
  check('auto-sprint reaches SPRINT_SPEED', near(sprint, 8.6, 0.05), `peak ${fmt(sprint)} m/s`);

  // Regression: sprinting used to cancel the instant you left the ground,
  // because wantSprint required `grounded`. Air control then braked you back
  // to walk speed, so sprint-jumping silently killed your momentum.
  const momentum = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.player.pos.set(0, 1.2, 0);
    g.player.grounded = true;
    for (let i = 0; i < 90; i++) t.run(1, { KeyW: true });
    const beforeJump = Math.hypot(g.player.vel.x, g.player.vel.z);
    t.run(2, { KeyW: true, Space: true });
    let airSpeed = 0, ticks = 0;
    for (let i = 0; i < 40 && !g.player.grounded; i++) {
      t.run(1, { KeyW: true });
      airSpeed = Math.hypot(g.player.vel.x, g.player.vel.z);
      ticks++;
    }
    return { beforeJump, airSpeed, ticks };
  });
  check('sprint momentum survives a jump',
    momentum.ticks > 5 && momentum.airSpeed > momentum.beforeJump * 0.9,
    `${fmt(momentum.beforeJump)} -> ${fmt(momentum.airSpeed)} m/s over ${momentum.ticks} airborne ticks`);

  const jump = await page.evaluate(() => {
    const t = window.__t; t.reset();
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      t.run(1, i < 3 ? { Space: true } : {});
      peak = Math.max(peak, window.__fgg.player.pos.y);
    }
    return { peak, finalY: window.__fgg.player.pos.y, grounded: window.__fgg.player.grounded };
  });
  // v^2 / 2g = 7.6^2 / (2*26) = 1.11 m
  check('jump reaches the expected apex', near(jump.peak, 1.11, 0.12), `peak ${fmt(jump.peak)}m`);
  check('gravity returns the player to the floor',
    near(jump.finalY, 0, 0.01) && jump.grounded, `y=${fmt(jump.finalY)}`);

  const blocked = await page.evaluate(() => {
    const t = window.__t; t.reset();
    // Spawn faces -Z toward the mid-field wall at z=-20; walk into it.
    t.run(600, { KeyW: true });
    const p = window.__fgg.player;
    return { z: p.pos.z, speed: Math.hypot(p.vel.x, p.vel.z) };
  });
  check('walls stop the player (collision works)',
    blocked.z > -19.6 && blocked.speed < 0.5, `stopped at z=${fmt(blocked.z)}`);

  const contained = await page.evaluate(() => {
    const t = window.__t; t.reset();
    window.__fgg.player.pos.set(44, 0, 0);
    t.run(400, { KeyW: true });
    window.__fgg.player.yaw = -Math.PI / 2;          // face +X, into the boundary
    t.run(400, { KeyW: true });
    return { x: window.__fgg.player.pos.x, z: window.__fgg.player.pos.z };
  });
  check('player cannot leave the arena',
    Math.abs(contained.x) < 46 && Math.abs(contained.z) < 46,
    `x=${fmt(contained.x,1)} z=${fmt(contained.z,1)}`);

  // ---- weapons --------------------------------------------------------
  const swap = await page.evaluate(() => {
    const t = window.__t; t.reset();
    window.__fgg.weapons.switchTo(2);
    t.run(90);
    return window.__fgg.weapons.index;
  });
  check('switching to slot 3 selects the shotgun', swap === 2, `index=${swap}`);

  const reload = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const w = window.__fgg.weapons;
    w.current.mag = 1;
    const res0 = w.current.reserve;
    w.startReload();
    t.run(Math.ceil(w.def.reloadTime * 120) + 30);
    return { mag: w.current.mag, size: w.def.magSize, used: res0 - w.current.reserve };
  });
  check('reload refills the magazine from the reserve',
    reload.mag === reload.size && reload.used === reload.size - 1, JSON.stringify(reload));

  const fire = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    const mag0 = g.weapons.current.mag;
    t.fire(120);                                       // 1 s of full-auto
    return { spent: mag0 - g.weapons.current.mag, shots: g.weapons.shotsFired };
  });
  // 660 rpm for ~0.9 s of the second (first shot is immediate) => ~10 rounds
  check('full-auto fire consumes ammo through the real fire path',
    fire.spent > 5 && fire.shots === fire.spent, JSON.stringify(fire));

  const semi = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.weapons.switchTo(1); t.run(90);                  // pistol = semi-auto
    t.fire(120);                                       // hold the trigger a full second
    return g.weapons.shotsFired;
  });
  check('semi-auto fires once per trigger pull', semi === 1, `${semi} shots`);

  // ---- fire modes & ADS --------------------------------------------------
  const burst = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.weapons.switchTo(5); t.run(90);              // MK-3 TRIAD = burst (index 5)
    g.weapons.pullTrigger(g.player, g.enemies);
    t.run(2);                                      // pull released almost immediately
    g.weapons.releaseTrigger();
    t.run(60);                                     // let the burst finish on its own
    return { shots: g.weapons.shotsFired, id: g.weapons.def.id };
  });
  check('burst mode fires exactly 3 rounds per pull', burst.shots === 3 && burst.id === 'burst',
    `${burst.shots} shots (${burst.id})`);

  const smg = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.weapons.switchTo(3); t.run(90);              // VK-9 HORNET (index 3)
    g.weapons.pullTrigger(g.player, g.enemies);
    t.run(120);                                    // 1 s of full auto at 1050 rpm
    g.weapons.releaseTrigger();
    return g.weapons.shotsFired;
  });
  check('SMG full-auto approaches its high rate of fire', smg > 12, `${smg} shots in 1s`);

  const ads = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.weapons.switchTo(4); t.run(90);              // M110 MARKSMAN (index 4)
    const fovHip = g.weapons.getFov(78);
    g.weapons.setAim(true);
    t.run(120);                                    // 1 s to ease ADS in
    const adsVal = g.weapons.ads;
    const fovAds = g.weapons.getFov(78);
    const sens = g.weapons.getSensMult();
    return { fovHip, fovAds, adsVal, sens, scoped: g.weapons.def.scoped };
  });
  check('holding aim eases ADS in and zooms the FOV',
    ads.adsVal > 0.9 && ads.fovAds < ads.fovHip - 20,
    `fov ${fmt(ads.fovHip)} -> ${fmt(ads.fovAds)}, ads=${fmt(ads.adsVal)}`);
  check('ADS lowers sensitivity for precision', ads.sens < 0.6, `sens x${fmt(ads.sens)}`);
  check('DMR is flagged scoped (scope overlay shows)', ads.scoped === true);

  const dmrDmg = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.weapons.switchTo(4); t.run(90);
    const e = window.__t.dummy(0, g.player.pos.y + 0.77, g.player.pos.z - 4, 200);
    g.weapons.setAim(true); t.run(120);            // aim to tighten spread
    g.weapons.pullTrigger(g.player, g.enemies);
    t.run(2); g.weapons.releaseTrigger();
    return { hp: e.health };
  });
  check('DMR body shot deals 70 damage', near(200 - dmrDmg.hp, 70, 0.01), `${200 - dmrDmg.hp}`);

  // ---- hit detection ---------------------------------------------------
  const dmg = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    // Head: enemy feet level with the player -> a horizontal ray crosses the
    // head sphere (centre 1.59, r 0.27) at eye height 1.68.
    const shootOnce = () => { g.weapons.cooldown = 0; t.fire(1); };
    const head = window.__t.dummy(0, g.player.pos.y, g.player.pos.z - 4);
    const hpHead0 = head.health;
    shootOnce();
    const headDmg = hpHead0 - head.health;

    // Body: raise the enemy so its torso centre sits exactly at eye height.
    const body = window.__t.dummy(0, g.player.pos.y + 0.77, g.player.pos.z - 4);
    const hpBody0 = body.health;
    shootOnce();
    const bodyDmg = hpBody0 - body.health;

    return { headDmg, bodyDmg, ratio: headDmg / bodyDmg };
  });
  check('rifle body shot deals base damage', near(dmg.bodyDmg, 24, 0.01), `${dmg.bodyDmg}`);
  check('headshots deal the headshot multiplier',
    near(dmg.headDmg, 24 * 2.4, 0.01), `${dmg.headDmg}`);
  check('headshots beat body shots', dmg.ratio > 2, `ratio ${fmt(dmg.ratio)}`);

  const kill = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    const e = window.__t.dummy(0, g.player.pos.y + 0.77, g.player.pos.z - 4, 40);
    g.weapons.pullTrigger(g.player, g.enemies);
    let n = 0;
    while (e.alive && n++ < 30) t.run(6);              // fire through step()
    g.weapons.releaseTrigger();
    return { alive: e.alive, kills: g.state.kills, score: g.state.score, shots: n };
  });
  check('an enemy can be killed through the real fire path', !kill.alive, `${kill.shots} pulls`);
  check('a kill increments the kill counter', kill.kills === 1, `${kill.kills}`);
  check('a kill awards score', kill.score > 0, `${kill.score}`);

  const cover = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    // Mid-field wall sits at z=-20 (spans x -10..10, y 0..3.2).
    const behind = window.__t.dummy(0, 0, -26);
    const hp0 = behind.health;
    g.player.pos.set(0, 0, -14); g.player.yaw = 0; g.player.pitch = 0;
    t.fire(60);
    return { delta: hp0 - behind.health };
  });
  check('cover blocks bullets (wall between shooter and target)',
    cover.delta === 0, `damage through wall: ${cover.delta}`);

  // ---- waves ------------------------------------------------------------
  const wave = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.state.intermission = 3.0;
    t.run(120 * 14);                                    // 14 s of sim
    return { wave: g.state.wave, alive: g.enemies.aliveCount, listed: g.enemies.list.length };
  });
  check('wave 1 starts after the intermission', wave.wave === 1, `wave=${wave.wave}`);
  check('wave 1 spawns enemies into the arena',
    wave.listed > 0 && wave.alive > 0, JSON.stringify(wave));

  const clearWave = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.state.intermission = 3.0;
    t.run(120 * 14);                                    // wave 1 spawns
    const spawned = g.enemies.aliveCount;
    g.enemies.list.forEach((e) => g.enemies.damage(e, 99999, false, null, null));
    const scoreBefore = g.state.score;
    t.run(120 * 2);
    return {
      spawned,
      score: g.state.score,
      bonusAwarded: g.state.score > scoreBefore,
      intermissionRestarted: g.state.intermission > 0,
    };
  });
  check('clearing a wave awards the bonus and starts the next intermission',
    clearWave.bonusAwarded && clearWave.intermissionRestarted, JSON.stringify(clearWave));

  // ---- enemies fight back ------------------------------------------------
  const enemyFire = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    // 4 m north of the spawn: close enough for line of sight, and in front
    // of the mid-field wall at z=-20 rather than behind it.
    const e = window.__t.dummy(0, 0, g.player.pos.z - 4);
    e.fireCooldown = 0;
    e.damage = 25;
    const hp0 = g.player.health;
    for (let i = 0; i < 400 && g.player.health === hp0; i++) {
      e.fireCooldown = 0; t.run(1);
    }
    return { lost: hp0 - g.player.health };
  });
  check('enemies can shoot and damage the player', enemyFire.lost > 0, `lost ${enemyFire.lost} hp`);

  // ---- pickups ------------------------------------------------------------
  const pickup = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.player.health = 40; g.player.armor = 0;
    g.weapons.current.reserve = 0;
    g.pickups.spawn('health', { x: g.player.pos.x, y: 0.5, z: g.player.pos.z - 1 }, 240);
    g.pickups.spawn('armor', { x: g.player.pos.x, y: 0.5, z: g.player.pos.z - 1 }, 240);
    g.pickups.spawn('ammo', { x: g.player.pos.x, y: 0.5, z: g.player.pos.z - 1 }, 240);
    t.run(30, { KeyW: true });
    return {
      health: g.player.health, armor: g.player.armor,
      reserve: g.weapons.current.reserve, left: g.pickups.items.length,
    };
  });
  check('health pickup heals', pickup.health > 40, `${pickup.health}`);
  check('armor pickup grants armor', pickup.armor > 0, `${pickup.armor}`);
  check('ammo pickup refills the reserve', pickup.reserve > 0, `${pickup.reserve}`);
  check('collected pickups are removed', pickup.left === 0, `${pickup.left} left`);

  // ---- damage, armor, death -------------------------------------------------
  const armor = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.player.health = 100; g.player.armor = 100;
    const lost = g.player.damage(20, g.state.time, g.player.pos);
    return { lost, armor: g.player.armor, health: g.player.health };
  });
  // ARMOR_ABSORB is 0.55: armor takes 11 of a 20-damage hit, health takes 9.
  check('armor soaks its 55% share of incoming damage',
    near(100 - armor.armor, 11, 0.01) && near(100 - armor.health, 9, 0.01),
    JSON.stringify(armor));

  const death = await page.evaluate(() => {
    const t = window.__t; t.reset();
    const g = window.__fgg;
    g.state.mode = 'playing';
    g.player.health = 1; g.player.armor = 0;
    g.player.damage(999, g.state.time, g.player.pos);
    t.run(2);
    return {
      alive: g.player.alive, mode: g.state.mode,
      overVisible: !document.getElementById('menu-over').classList.contains('hidden'),
      stats: document.getElementById('final-stats').textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  check('the player can die', !death.alive);
  check('death opens the game-over screen',
    death.mode === 'over' && death.overVisible, `mode=${death.mode}`);
  check('final stats are rendered', /SCORE/.test(death.stats) && /WAVE REACHED/.test(death.stats),
    death.stats.slice(0, 70));

  const restart = await page.evaluate(() => {
    const g = window.__fgg;
    document.getElementById('btn-again').click();
    return {
      mode: g.state.mode, health: g.player.health, score: g.state.score,
      mag: g.weapons.current.mag, enemies: g.enemies.list.length,
    };
  });
  check('RUN IT BACK resets the run',
    restart.mode === 'playing' && restart.health === 100 && restart.score === 0
      && restart.mag === 30 && restart.enemies === 0, JSON.stringify(restart));

  // ---- v0.3.0: multi-map, dev range, camera smoothing -----------------------
  const maps = await page.evaluate(() => {
    const g = window.__fgg;
    const res = {};
    for (const m of g.MAPS) {
      try { g.loadMap(m.id); res[m.id] = g.world.colliders.length > 0 && g.world.mapId === m.id; }
      catch (e) { res[m.id] = 'THREW ' + e.message; }
    }
    return res;
  });
  check('all seven maps build without error',
    Object.values(maps).every((v) => v === true), JSON.stringify(maps));

  const cam = await page.evaluate(() => {
    const g = window.__fgg;
    g.loadMap('arena'); g.player.reset();
    g.player.yaw = 1.0; g.player.viewYaw = 0;
    for (let i = 0; i < 10; i++) g.player.applyCamera(1 / 60);
    return g.player.viewYaw;
  });
  check('camera view eases toward the raw aim (smoothing)',
    cam > 0.5 && cam < 1.0, `${cam.toFixed(3)}`);

  const dev = await page.evaluate(() => {
    const g = window.__fgg;
    g.state.mapId = 'dev'; g.startRun();
    const dummies = g.enemies.list.filter((e) => e.type.passive).length;
    const h0 = g.player.health;
    g.player.damage(50, g.state.time, g.player.pos);
    const godBlocks = g.player.health === h0;
    g.weapons.cooldown = 0;
    const m0 = g.weapons.current.mag;
    g.weapons._shootOnce(g.player, g.enemies);
    const ammoHeld = g.weapons.current.mag === m0;
    const d = g.enemies.list.find((e) => e.type.passive);
    const killed = g.enemies.damage(d, 9999, false, d.pos, null);
    return {
      devMode: g.state.devMode, dummies, godBlocks,
      infAmmo: g.weapons.infiniteAmmo, ammoHeld,
      dummySurvives: d.alive && killed === false,
    };
  });
  check('dev range enables dev mode with passive dummies',
    dev.devMode && dev.dummies >= 5, JSON.stringify(dev));
  check('dev god mode blocks incoming damage', dev.godBlocks, JSON.stringify(dev));
  check('dev infinite ammo does not consume rounds', dev.infAmmo && dev.ammoHeld, JSON.stringify(dev));
  check('dev dummies absorb damage but never die', dev.dummySurvives, JSON.stringify(dev));

  const noclip = await page.evaluate(() => {
    const g = window.__fgg; const t = window.__t;
    t.reset();
    g.player.noclip = true;
    g.player.pos.set(0, 0, 0); g.player.vel.set(0, 0, 0);
    g.input.keys.Space = true;
    t.run(60);
    g.input.keys.Space = false;
    const y = g.player.pos.y;
    g.player.noclip = false;
    return y;
  });
  check('dev noclip lets the player fly (ignores gravity)', noclip > 1, `y=${noclip.toFixed(2)}`);

  // ---- hygiene ---------------------------------------------------------------
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check('no 404 responses', notFound.length === 0, notFound.join(', '));

  await page.screenshot({ path: '/home/user/.verify/gameplay.png' });
  await browser.close();

  console.log('\nFirst Gun Game — browser test suite\n' + '='.repeat(60));
  console.log(results.join('\n'));
  console.log('='.repeat(60));
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST HARNESS CRASHED:', err);
  process.exit(2);
});
