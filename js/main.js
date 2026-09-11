/**
 * main.js — bootstrap, game state machine and the frame loop.
 *
 * Flow
 * ----
 *   MENU ──DEPLOY──▶ PLAYING ──Esc──▶ PAUSED
 *                      │  ▲              │
 *                      │  └───RESUME─────┘
 *                      ▼
 *                    OVER ──RUN IT BACK──▶ PLAYING
 *
 * The simulation runs on a fixed timestep (see GAME.FIXED_TIMESTEP) so
 * movement and recoil behave identically at 30 fps and 240 fps, while
 * rendering happens once per animation frame.
 */

import * as THREE from './three.js';
import { GAME, WEAPONS, PICKUPS } from './config.js';
import { audio } from './audio.js';
import { buildWorld } from './world.js';
import { Player } from './player.js';
import { WeaponManager } from './weapons.js';
import { Effects } from './effects.js';
import { EnemyManager, setBurstHandler, pickEnemyType } from './enemies.js';
import { PickupManager } from './pickups.js';
import { HUD } from './hud.js';
import { Input } from './input.js';

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

const canvas = document.getElementById('scene');
const fatalBox = document.getElementById('fatal');

function fatal(err) {
  console.error(err);
  fatalBox.classList.remove('hidden');
  fatalBox.querySelector('pre').textContent =
    `First Gun Game failed to start.\n\n${err && err.stack ? err.stack : err}\n\n` +
    `This usually means WebGL is unavailable in this browser.`;
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
} catch (err) {
  fatal(err);
}

if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal(new Error('WebGL context was lost (GPU reset or driver crash). Reload the page.'));
  });

  boot();
}

// ---------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------

function boot() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x141a24, 0.0075);

  const camera = new THREE.PerspectiveCamera(
    78, window.innerWidth / window.innerHeight, 0.05, 600
  );
  scene.add(camera);

  const world = buildWorld(scene);
  const effects = new Effects(scene);
  const enemies = new EnemyManager(scene);
  const pickups = new PickupManager(scene);
  const player = new Player(camera, world);
  const weapons = new WeaponManager(camera, world, effects);
  const hud = new HUD();
  const input = new Input(canvas);

  // Let the enemy module spawn death particles without importing Effects.
  setBurstHandler((point, color, count, speed) => effects.burst(point, color, count, speed, 10));

  // --- persistent settings ---------------------------------------------
  const settings = loadSettings();
  input.sensitivity = settings.sensitivity;
  audio.setVolume(settings.volume);

  // --- run state --------------------------------------------------------
  const state = {
    mode: 'menu',              // menu | playing | paused | over
    wave: 0,
    score: 0,
    kills: 0,
    time: 0,                   // seconds elapsed in the run
    intermission: GAME.WAVE.INTERMISSION,
    enemiesThisWave: 0,
    spawnQueue: 0,             // bots still waiting to materialise
    spawnTimer: 0,
    wantFire: false,           // mouse button 0 is held
    triggerHeld: false,        // semi-auto latch: one shot per click
  };

  let accumulator = 0;
  let lastTime = performance.now();

  // =====================================================================
  // Input wiring
  // =====================================================================

  // Input already applies the sensitivity multiplier; these are radians.
  input.onLook = (dx, dy) => {
    if (state.mode !== 'playing') return;
    player.look(dx, dy);
  };

  input.onFireDown = () => {
    if (state.mode === 'playing' && input.locked) state.wantFire = true;
  };
  input.onFireUp = () => { state.wantFire = false; state.triggerHeld = false; };

  input.onReload = () => {
    if (state.mode === 'playing') weapons.startReload();
  };

  input.onSlot = (i) => {
    if (state.mode === 'playing') weapons.switchTo(i);
  };

  input.onCycleWeapon = (dir) => {
    if (state.mode === 'playing') weapons.cycle(dir);
  };

  input.onPause = () => {
    if (state.mode === 'playing') pause();
    else if (state.mode === 'paused') resume();
  };

  input.onLockChange = (locked) => {
    const nudge = document.getElementById('click-to-lock');
    if (state.mode === 'playing' && !locked) {
      // Losing the cursor mid-fight pauses rather than leaving the player
      // defenceless with a free mouse.
      pause();
    }
    nudge.classList.toggle('hidden', !(state.mode === 'playing' && !locked));
  };

  canvas.addEventListener('click', () => {
    audio.init();
    if (state.mode === 'playing' && !input.locked) input.requestLock();
  });

  // =====================================================================
  // Menu wiring
  // =====================================================================

  const screens = {
    main: document.getElementById('menu-main'),
    pause: document.getElementById('menu-pause'),
    over: document.getElementById('menu-over'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
    if (!name) Object.values(screens).forEach((el) => el.classList.add('hidden'));
  }

  const bind = (id, fn) => document.getElementById(id).addEventListener('click', () => {
    audio.init();
    audio.uiClick();
    fn();
  });

  bind('btn-start', () => startRun());
  bind('btn-resume', () => resume());
  bind('btn-restart', () => startRun());
  bind('btn-quit', () => quitToMenu());
  bind('btn-again', () => startRun());
  bind('btn-menu', () => quitToMenu());

  // Settings sliders
  const sensInput = document.getElementById('set-sens');
  const sensValue = document.getElementById('set-sens-value');
  const volInput = document.getElementById('set-vol');
  const volValue = document.getElementById('set-vol-value');

  sensInput.value = String(Math.round(settings.sensitivity * 100));
  sensValue.textContent = settings.sensitivity.toFixed(2);
  volInput.value = String(Math.round(settings.volume * 100));
  volValue.textContent = `${Math.round(settings.volume * 100)}%`;

  sensInput.addEventListener('input', () => {
    const v = Number(sensInput.value) / 100;
    input.sensitivity = v;
    sensValue.textContent = v.toFixed(2);
    saveSettings({ sensitivity: v });
  });

  volInput.addEventListener('input', () => {
    const v = Number(volInput.value) / 100;
    audio.setVolume(v);
    volValue.textContent = `${Math.round(v * 100)}%`;
    saveSettings({ volume: v });
  });

  renderBestScore();

  // =====================================================================
  // Run lifecycle
  // =====================================================================

  function startRun() {
    // Reset everything.
    enemies.clear();
    pickups.clear();
    effects.clear();
    hud.resetTransient();

    player.reset();
    weapons.reset();

    state.mode = 'playing';
    state.wave = 0;
    state.score = 0;
    state.kills = 0;
    state.time = 0;
    state.spawnQueue = 0;
    state.spawnTimer = 0;
    state.intermission = 3.0;       // short grace period before wave 1
    state.wantFire = false;
    state.triggerHeld = false;

    showScreen(null);
    hud.show();
    input.requestLock();
  }

  function pause() {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    input.releaseLock();
    showScreen('pause');
  }

  function resume() {
    if (state.mode !== 'paused') return;
    state.mode = 'playing';
    showScreen(null);
    input.requestLock();
    lastTime = performance.now();     // avoid a giant dt jump
    accumulator = 0;
  }

  function quitToMenu() {
    state.mode = 'menu';
    enemies.clear();
    pickups.clear();
    effects.clear();
    hud.hide();
    hud.resetTransient();
    input.releaseLock();
    renderBestScore();
    showScreen('main');
    document.getElementById('click-to-lock').classList.add('hidden');
  }

  function gameOver() {
    state.mode = 'over';
    input.releaseLock();
    audio.death();
    audio.gameOver();
    hud.hide();
    document.getElementById('click-to-lock').classList.add('hidden');

    const best = saveBest(state.score);
    const acc = weapons.accuracy;

    document.getElementById('final-stats').innerHTML = `
      <div class="big"><span>SCORE</span><span>${state.score}</span></div>
      <div class="big"><span>WAVE REACHED</span><span>${state.wave}</span></div>
      <div><span>KILLS</span><span>${state.kills}</span></div>
      <div><span>ACCURACY</span><span>${acc === null ? '--' : acc.toFixed(1) + '%'}</span></div>
      <div><span>SHOTS FIRED</span><span>${weapons.shotsFired}</span></div>
      <div><span>TIME SURVIVED</span><span>${formatTime(state.time)}</span></div>
      <div><span>BEST SCORE</span><span>${best}</span></div>
      <div><span>NEW RECORD</span><span>${state.score >= best && state.score > 0 ? 'YES' : 'no'}</span></div>
    `;
    showScreen('over');
  }

  // =====================================================================
  // Simulation step (fixed timestep)
  // =====================================================================

  function step(dt) {
    state.time += dt;

    // --- player ---------------------------------------------------------
    const move = input.moveState;
    move.recovery = weapons.def.recovery;
    const alive = player.update(dt, move, state.time);

    if (!alive && state.mode === 'playing') {
      gameOver();
      return;
    }

    // --- firing -----------------------------------------------------------
    const def = weapons.def;
    if (state.wantFire && player.alive) {
      if (def.auto || !state.triggerHeld) {
        if (weapons.canFire) {
          state.triggerHeld = true;
          handleFireResult(weapons.fire(player, enemies));
        }
      }
    }
    weapons.update(dt, player, move);

    // --- enemies ------------------------------------------------------------
    enemies.update(dt, player, world, effects, {
      now: state.time,
      onPlayerHit: (amount, sourcePos) => {
        hud.damageArc(camera, sourcePos);
        hud.flashVignette(amount);
      },
    });

    // --- pickups --------------------------------------------------------------
    const collected = pickups.update(dt, player, {
      onCollect: (it) => effects.burst(it.group.position, 0xffffff, 10, 2.4, 4),
    });
    for (const c of collected) {
      if (c.type === 'health') player.heal(c.amount);
      else if (c.type === 'armor') player.addArmor(c.amount);
      else {
        const slot = weapons.current;
        slot.reserve = Math.min(slot.def.reserveMax, slot.reserve + c.amount);
      }
    }

    // --- wave director -----------------------------------------------------------
    updateWaves(dt);

    effects.update(dt, camera);
  }

  /** Translate a fire result into HUD feedback and score. */
  function handleFireResult(result) {
    if (!result.fired) return;

    for (const h of result.hits) {
      hud.damageNumber(camera, h.point, h.damage, h.head);
    }
    if (result.hits.length > 0) {
      hud.hitmarker(result.kills.length > 0);
      audio.hitmarker(result.kills.length > 0);
    }

    for (const k of result.kills) {
      const e = k.enemy;
      const base = e.type.score;
      const gained = Math.round(base * (k.head ? GAME.SCORE.HEADSHOT_MULT : 1));
      state.score += gained;
      state.kills++;
      hud.killfeed(
        `${k.head ? 'HEADSHOT' : 'ELIMINATED'} — ${e.type.label}  +${gained}`,
        k.head
      );
      pickups.rollFor(
        new THREE.Vector3(e.pos.x, 0.5, e.pos.z),
        weapons.current.def.reserveMax
      );
    }
  }

  /** Spawn waves, track the queue and detect wave clears. */
  function updateWaves(dt) {
    const alive = enemies.aliveCount;

    // Drip-feed the queue so a big wave does not all pop in at once.
    if (state.spawnQueue > 0) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0 && alive < GAME.WAVE.MAX_ENEMIES_ALIVE) {
        state.spawnQueue--;
        state.spawnTimer = 0.28;
        const type = pickEnemyType(state.wave);
        const pos = world.pickSpawn(player.pos, GAME.WAVE.SPAWN_MARGIN);
        enemies.spawn(type, pos, state.wave);
      }
    }

    // Between waves.
    if (state.intermission > 0) {
      state.intermission -= dt;
      if (state.intermission <= 0) beginWave();
      hud.updateWave(Math.max(1, state.wave), alive + state.spawnQueue, state.intermission);
      return;
    }

    // Wave cleared.
    if (state.spawnQueue === 0 && alive === 0 && state.wave > 0) {
      const bonus = GAME.SCORE.WAVE_CLEAR_BONUS * state.wave;
      state.score += bonus;
      hud.killfeed(`WAVE ${state.wave} CLEARED  +${bonus}`, true);
      hud.banner('WAVE CLEAR', `+${bonus} BONUS`);
      audio.waveStart(state.wave);
      state.intermission = GAME.WAVE.INTERMISSION;
    }

    hud.updateWave(state.wave, alive + state.spawnQueue, state.intermission);
  }

  function beginWave() {
    state.wave++;
    const count = Math.round(GAME.WAVE.START_ENEMIES + (state.wave - 1) * GAME.WAVE.ENEMIES_PER_WAVE);
    state.enemiesThisWave = count;
    state.spawnQueue = count;
    state.spawnTimer = 0;
    state.intermission = 0;

    hud.banner(`WAVE ${state.wave}`, count < 8 ? 'HOLD THE LINE' : 'THEY ARE COMING');
    audio.waveStart(state.wave);

    // Top the player up a little at the start of each wave.
    if (state.wave > 1) {
      player.heal(12);
      weapons.current.reserve = Math.min(
        weapons.current.def.reserveMax,
        weapons.current.reserve + Math.ceil(weapons.current.def.magSize * 1.5)
      );
    }
  }

  // =====================================================================
  // Frame loop
  // =====================================================================

  function frame(now) {
    requestAnimationFrame(frame);

    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, GAME.MAX_FRAME_TIME);

    if (state.mode === 'playing') {
      accumulator += dt;
      let guard = 0;
      while (accumulator >= GAME.FIXED_TIMESTEP && guard++ < 20) {
        step(GAME.FIXED_TIMESTEP);
        accumulator -= GAME.FIXED_TIMESTEP;
      }
      if (guard >= 20) accumulator = 0;    // dropped too far behind; resync

      // HUD is cheap enough to refresh every rendered frame.
      hud.updateVitals(player);
      hud.updateWeapon(weapons);
      hud.updateStats(state.score, state.kills, weapons.accuracy);
      hud.updateReticle(player, weapons);

      // Context-sensitive prompts.
      if (weapons.isReloading) hud.prompt('RELOADING…');
      else if (weapons.current.mag === 0 && weapons.current.reserve === 0) hud.prompt('OUT OF AMMO — SWITCH WEAPON');
      else if (weapons.current.mag === 0) hud.prompt('PRESS R TO RELOAD');
      else hud.prompt(null);
    } else if (state.mode === 'menu') {
      // Slow cinematic drift behind the main menu.
      weapons.rig.visible = false;
      camera.position.set(0, 9, 34);
      camera.lookAt(0, 2, 0);
      camera.rotation.z = Math.sin(now * 0.00008) * 0.06;
      effects.update(dt, camera);
    }

    if (state.mode !== 'menu' && !weapons.rig.visible) weapons.rig.visible = true;

    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Kick off.
  showScreen('main');
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------------
  // Debug handle. Handy from the browser console while developing:
  //   __fgg.player.health = 1
  //   __fgg.enemies.spawn(__fgg.enemyTypes.heavy, new THREE.Vector3(5,0,5), 4)
  //   __fgg.state.score += 9999
  // ---------------------------------------------------------------------
  window.__fgg = {
    state, scene, camera, renderer, world, player, weapons,
    enemies, pickups, effects, hud, input,
    startRun, pause, resume, quitToMenu, gameOver, step,
  };
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('first-gun-game.settings') || '{}'); } catch { /* ignore */ }
  return {
    sensitivity: typeof stored.sensitivity === 'number' ? stored.sensitivity : 1,
    volume: typeof stored.volume === 'number' ? stored.volume : 0.7,
  };
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem('first-gun-game.settings', JSON.stringify(next)); } catch { /* ignore */ }
}

function readBest() {
  try { return Number(localStorage.getItem(GAME.STORAGE_KEY) || 0) || 0; } catch { return 0; }
}

function saveBest(score) {
  const best = Math.max(readBest(), score);
  try { localStorage.setItem(GAME.STORAGE_KEY, String(best)); } catch { /* ignore */ }
  return best;
}

function renderBestScore() {
  const el = document.getElementById('best-score');
  const best = readBest();
  el.textContent = best > 0 ? `  //  BEST ${best}` : '';
}

// Exported for debugging from the console and for automated tests.
export { GAME, WEAPONS, PICKUPS, formatTime };
