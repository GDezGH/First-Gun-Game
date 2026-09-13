/**
 * world.js — arena construction, theming and the map registry.
 *
 * A map is a THEME (sky, fog, lights, palette) plus a LAYOUT (the boxes that
 * form cover). `buildWorld(scene, mapId)` composes both. Every solid box is
 * registered in `colliders` as an AABB for the player and the hit-scan.
 *
 * Maps shipped:
 *   arena   — the original dusk industrial yard (balanced, learnable)
 *   foundry — warm, high-contrast, containers and catwalks, hard sun
 *   glacier — cold and bright, ice spires and raised shelves, soft shadows
 *   neon    — night city, tight corridors, emissive trim, coloured lights
 *   dev     — a firing range for testing: distance lanes, cover, dummy row
 */

import * as THREE from './three.js';
import { GAME } from './config.js';
import { makeRng, rayAABB } from './mathutil.js';

/** Metadata shown in the map selector. */
export const MAPS = [
  { id: 'arena',   name: 'BLACKSITE ARENA', desc: 'Dusk industrial yard. Balanced sightlines.' },
  { id: 'foundry', name: 'MOLTEN FOUNDRY',  desc: 'Hot sun, hard shadows, container stacks.' },
  { id: 'glacier', name: 'GLACIER LINE',    desc: 'Bright cold light, ice spires, high shelves.' },
  { id: 'neon',    name: 'NEON DISTRICT',   desc: 'Night city. Tight lanes, coloured light.' },
  { id: 'dev',     name: 'DEV RANGE',       desc: 'Firing range. Dummies, lanes, dev tools.' },
];

const THEMES = {
  arena: {
    sky: ['#05070b', '#0c1220', '#1b2637', '#3a3026', '#5a3d1c'],
    fog: 0x141a24, fogD: 0.0075,
    hemi: [0xaec4e4, 0x33302a, 1.15], sun: [0xffd9b0, 2.3], sunPos: [38, 55, 24],
    fill: [0x6f8fc0, 0.75], trim: 0xff8c1a,
    floor: '#15181d', wall: '#1a1d23', crate: '#33301f', crateTint: 0x8a8358,
  },
  foundry: {
    sky: ['#120602', '#2a0d04', '#4a1a08', '#7a2f0c', '#b3520f'],
    fog: 0x2a1208, fogD: 0.010,
    hemi: [0xffc9a0, 0x3a2013, 1.3], sun: [0xffb060, 3.0], sunPos: [20, 40, -30],
    fill: [0xff7040, 0.6], trim: 0xff4d00,
    floor: '#221612', wall: '#2a1a14', crate: '#3a2417', crateTint: 0x9a6a3a,
  },
  glacier: {
    sky: ['#dfe9f5', '#c2d4e8', '#a8c0dc', '#e8f0f8', '#ffffff'],
    fog: 0xcfdcea, fogD: 0.006,
    hemi: [0xffffff, 0x9db4cc, 1.6], sun: [0xfff2dd, 2.6], sunPos: [-30, 60, 20],
    fill: [0xbcd4ee, 0.9], trim: 0x66d9ff,
    floor: '#dfe7ef', wall: '#c6d3e0', crate: '#9fb4c8', crateTint: 0xbcd0e2,
  },
  neon: {
    sky: ['#020208', '#070716', '#0d0d24', '#141433', '#1d1d4a'],
    fog: 0x070712, fogD: 0.012,
    hemi: [0x40406a, 0x101018, 0.8], sun: [0x8899ff, 1.2], sunPos: [30, 50, -20],
    fill: [0xff44aa, 0.5], trim: 0x22e6ff,
    floor: '#0c0c14', wall: '#12121e', crate: '#1a1a2a', crateTint: 0x4a4a6a,
  },
  dev: {
    sky: ['#0a0f0a', '#101810', '#182418', '#20301f', '#2a4026'],
    fog: 0x142014, fogD: 0.006,
    hemi: [0xd8ffd8, 0x2a3a2a, 1.4], sun: [0xfff6dd, 2.6], sunPos: [30, 60, 30],
    fill: [0xaaffaa, 0.7], trim: 0x3dff7a,
    floor: '#18201a', wall: '#202a22', crate: '#2a3a2c', crateTint: 0x7a9a7c,
  },
};

function gridTexture(size = 512, bg = '#15181d', line = '#232931', specks = 1400) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < specks; i++) {
    const v = 18 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.10 + Math.random() * 0.22})`;
    const s = 1 + Math.random() * 2.4;
    g.fillRect(Math.random() * size, Math.random() * size, s, s);
  }
  g.strokeStyle = line;
  g.lineWidth = 2;
  const step = size / 4;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function skyDome(colors) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  colors.forEach((col, i) => grad.addColorStop(i / (colors.length - 1), col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(420, 24, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })
  );
  mesh.name = 'sky';
  return mesh;
}

export function buildWorld(scene, mapId = 'arena') {
  const theme = THEMES[mapId] || THEMES.arena;
  const R = GAME.ARENA_RADIUS;

  const colliders = [];
  const solidMeshes = [];
  const spawnPoints = [];

  const worldGroup = new THREE.Group();
  worldGroup.name = 'world';
  scene.add(worldGroup);
  worldGroup.add(skyDome(theme.sky));
  scene.fog = new THREE.FogExp2(theme.fog, theme.fogD);

  const floorTex = gridTexture(512, theme.floor, '#232931');
  floorTex.repeat.set(28, 28);
  const wallTex = gridTexture(512, theme.wall, '#2c333d', 900);
  wallTex.repeat.set(6, 2);
  const crateTex = gridTexture(256, theme.crate, '#4a4630', 700);

  const MATS = {
    floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0.02 }),
    wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, metalness: 0.05 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.85, metalness: 0.08 }),
    crate: new THREE.MeshStandardMaterial({ map: crateTex, color: theme.crateTint, roughness: 0.8, metalness: 0.15 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.42, metalness: 0.75 }),
    trim: new THREE.MeshStandardMaterial({ color: theme.trim, roughness: 0.4, metalness: 0.3, emissive: theme.trim, emissiveIntensity: 0.7 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffd9a0, emissiveIntensity: 2.4, roughness: 1 }),
  };

  function box(o) {
    const { x, y, z, w, h, d } = o;
    const mat = o.mat || MATS.concrete;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = o.shadow !== false;
    mesh.receiveShadow = true;
    worldGroup.add(mesh);
    if (o.solid !== false) {
      colliders.push({
        min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
        max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
      });
      solidMeshes.push(mesh);
    }
    return mesh;
  }

  // ------------------------------------------------------------------
  // Ground + lights (shared across maps)
  // ------------------------------------------------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 2, R * 2), MATS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  worldGroup.add(floor);
  colliders.push({ min: new THREE.Vector3(-R, -4, -R), max: new THREE.Vector3(R, 0, R) });

  worldGroup.add(new THREE.HemisphereLight(theme.hemi[0], theme.hemi[1], theme.hemi[2]));
  const sun = new THREE.DirectionalLight(theme.sun[0], theme.sun[1]);
  sun.position.set(...theme.sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  worldGroup.add(sun);
  const fill = new THREE.DirectionalLight(theme.fill[0], theme.fill[1]);
  fill.position.set(-30, 22, -26);
  worldGroup.add(fill);

  // Perimeter walls shared by every full-size map.
  const WALL_H = 9, T = 2;
  const perimeter = () => {
    box({ x: 0, y: WALL_H / 2, z: -R - T / 2, w: R * 2 + T * 2, h: WALL_H, d: T, mat: MATS.wall });
    box({ x: 0, y: WALL_H / 2, z: R + T / 2, w: R * 2 + T * 2, h: WALL_H, d: T, mat: MATS.wall });
    box({ x: -R - T / 2, y: WALL_H / 2, z: 0, w: T, h: WALL_H, d: R * 2, mat: MATS.wall });
    box({ x: R + T / 2, y: WALL_H / 2, z: 0, w: T, h: WALL_H, d: R * 2, mat: MATS.wall });
    [
      { x: 0, z: -R - T / 2, w: R * 2, d: 0.3 }, { x: 0, z: R + T / 2, w: R * 2, d: 0.3 },
      { x: -R - T / 2, z: 0, w: 0.3, d: R * 2 }, { x: R + T / 2, z: 0, w: 0.3, d: R * 2 },
    ].forEach((t) => box({ x: t.x, y: WALL_H + 0.25, z: t.z, w: t.w, h: 0.5, d: t.d, mat: MATS.trim, solid: false }));
  };

  const ringSpawns = () => {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      spawnPoints.push(new THREE.Vector3(Math.cos(a) * (R - 7), 0, Math.sin(a) * (R - 7)));
    }
    [[-18, -18], [18, -18], [-18, 18], [18, 18], [-36, 0], [36, 0], [0, -36], [0, 36]]
      .forEach(([x, z]) => spawnPoints.push(new THREE.Vector3(x, 0, z)));
  };

  const scatterCrates = (seed, count, clearSpawn) => {
    const rng = makeRng(seed);
    const placed = [];
    const overlaps = (x, z, r) =>
      placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) ||
      Math.abs(x) < 11 && Math.abs(z) < 11 ||
      Math.abs(x) > R - 4 || Math.abs(z) > R - 4 ||
      (clearSpawn && (x - clearSpawn.x) ** 2 + (z - clearSpawn.z) ** 2 < GAME.SPAWN_CLEARANCE ** 2);
    let guard = 0;
    while (placed.length < count && guard++ < 1200) {
      const x = (rng() * 2 - 1) * (R - 6);
      const z = (rng() * 2 - 1) * (R - 6);
      const size = 1.6 + rng() * 1.6;
      if (overlaps(x, z, size)) continue;
      placed.push({ x, z, r: size });
      box({ x, y: size / 2, z, w: size, h: size, d: size, mat: MATS.crate });
      if (rng() < 0.26) {
        const s2 = size * (0.55 + rng() * 0.2);
        box({ x: x + (rng() - 0.5) * 0.4, y: size + s2 / 2, z: z + (rng() - 0.5) * 0.4, w: s2, h: s2, d: s2, mat: MATS.crate });
      }
    }
  };

  // Per-map spawn point (kept clear of cover).
  let spawn = new THREE.Vector3(GAME.PLAYER.SPAWN.x, 0, GAME.PLAYER.SPAWN.z);

  // ------------------------------------------------------------------
  // Layouts
  // ------------------------------------------------------------------
  if (mapId === 'foundry') {
    perimeter();
    spawn = new THREE.Vector3(0, 0, -14);
    [[-20, -10], [20, -10], [-20, 12], [20, 12]].forEach(([x, z]) => {
      box({ x, y: 1.3, z, w: 10, h: 2.6, d: 3, mat: MATS.metal });
      box({ x: x + 2, y: 3.9, z, w: 6, h: 2.6, d: 3, mat: MATS.crate });
    });
    box({ x: 0, y: 0.5, z: 0, w: 14, h: 1, d: 14, mat: MATS.concrete });
    [[-5.5, -5.5], [5.5, -5.5], [-5.5, 5.5], [5.5, 5.5]].forEach(([x, z]) =>
      box({ x, y: 3.4, z, w: 1.4, h: 5.8, d: 1.4, mat: MATS.concrete }));
    box({ x: 0, y: 7.2, z: 0, w: 16, h: 0.7, d: 16, mat: MATS.metal });
    box({ x: 0, y: 1.4, z: -24, w: 26, h: 2.8, d: 1.4, mat: MATS.wall });
    box({ x: 0, y: 1.4, z: 24, w: 26, h: 2.8, d: 1.4, mat: MATS.wall });
    scatterCrates(0xf00d, 30, spawn);
    ringSpawns();
  } else if (mapId === 'glacier') {
    perimeter();
    spawn = new THREE.Vector3(0, 0, -14);
    const spire = (x, z, h) => box({ x, y: h / 2, z, w: 1.6, h, d: 1.6, mat: MATS.crate });
    spire(-14, -6, 7); spire(14, -6, 8); spire(-14, 8, 6); spire(14, 8, 7);
    spire(-6, -20, 5); spire(6, -20, 5); spire(0, 16, 6);
    box({ x: -28, y: 0.7, z: 0, w: 10, h: 1.4, d: 26, mat: MATS.concrete });
    box({ x: 28, y: 0.7, z: 0, w: 10, h: 1.4, d: 26, mat: MATS.concrete });
    box({ x: -28, y: 2.0, z: 0, w: 6, h: 1.2, d: 20, mat: MATS.concrete });
    box({ x: 28, y: 2.0, z: 0, w: 6, h: 1.2, d: 20, mat: MATS.concrete });
    box({ x: 0, y: 1.2, z: -8, w: 18, h: 2.4, d: 1.4, mat: MATS.wall });
    box({ x: 0, y: 1.2, z: 8, w: 18, h: 2.4, d: 1.4, mat: MATS.wall });
    scatterCrates(0x1ce, 26, spawn);
    ringSpawns();
  } else if (mapId === 'neon') {
    perimeter();
    spawn = new THREE.Vector3(0, 0, -14);
    const block = (x, z, w, d) => box({ x, y: 3.2, z, w, h: 6.4, d, mat: MATS.wall });
    block(-16, -8, 12, 12); block(16, -8, 12, 12); block(-16, 12, 12, 10); block(16, 12, 12, 10);
    [[-16, -8], [16, -8], [-16, 12], [16, 12]].forEach(([x, z]) =>
      box({ x, y: 6.6, z, w: 12, h: 0.3, d: 0.3, mat: MATS.trim, solid: false }));
    [[-10, 0, 0x22e6ff], [10, 0, 0xff44aa], [0, 18, 0x22e6ff]].forEach(([x, z, col]) => {
      const p = new THREE.PointLight(col, 70, 40, 2);
      p.position.set(x, 6, z);
      worldGroup.add(p);
    });
    box({ x: 0, y: 1.0, z: 0, w: 8, h: 2, d: 8, mat: MATS.concrete });
    scatterCrates(0x0e0, 22, spawn);
    ringSpawns();
  } else if (mapId === 'dev') {
    const DR = 30;
    const wall = (x, z, w, d) => box({ x, y: 4, z, w, h: 8, d, mat: MATS.wall });
    wall(0, -DR - 1, DR * 2 + 4, 2); wall(0, DR + 1, DR * 2 + 4, 2);
    wall(-DR - 1, 0, 2, DR * 2); wall(DR + 1, 0, 2, DR * 2);
    colliders.push({ min: new THREE.Vector3(-DR, -4, -DR), max: new THREE.Vector3(DR, 0, DR) });
    spawn = new THREE.Vector3(0, 0, 24);
    [-10, -15, -20, -25].forEach((z) =>
      box({ x: 0, y: 0.03, z, w: 40, h: 0.06, d: 0.3, mat: MATS.trim, solid: false }));
    box({ x: -6, y: 0.8, z: -6, w: 2.4, h: 1.6, d: 2.4, mat: MATS.crate });
    box({ x: 6, y: 0.8, z: -12, w: 2.4, h: 1.6, d: 2.4, mat: MATS.crate });
    box({ x: 0, y: 1.2, z: -18, w: 6, h: 2.4, d: 1.4, mat: MATS.wall });
    [-12, -8, -4, 4, 8, 12].forEach((x) =>
      box({ x, y: 0.5, z: 20, w: 1, h: 1, d: 1, mat: MATS.concrete }));
  } else {
    // ---- default: arena ----
    perimeter();
    spawn = new THREE.Vector3(GAME.PLAYER.SPAWN.x, 0, GAME.PLAYER.SPAWN.z);
    box({ x: 0, y: 0.6, z: 0, w: 16, h: 1.2, d: 16, mat: MATS.concrete });
    [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]].forEach(([px, pz]) => {
      box({ x: px, y: 3.6, z: pz, w: 1.5, h: 6, d: 1.5, mat: MATS.concrete });
      box({ x: px, y: 6.9, z: pz, w: 2.0, h: 0.5, d: 2.0, mat: MATS.metal });
      box({ x: px, y: 7.35, z: pz, w: 1.0, h: 0.5, d: 1.0, mat: MATS.lamp, solid: false });
    });
    box({ x: 0, y: 7.9, z: 0, w: 18, h: 0.7, d: 18, mat: MATS.metal });
    [1, -1].forEach((s) => {
      box({ x: 0, y: 0.2, z: s * 9.4, w: 6, h: 0.4, d: 2.6, mat: MATS.concrete });
      box({ x: 0, y: 0.45, z: s * 8.2, w: 6, h: 0.3, d: 1.4, mat: MATS.concrete, solid: false });
    });
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    corners.forEach(([sx, sz]) => {
      const cx = sx * 30, cz = sz * 30;
      box({ x: cx, y: 1.9, z: cz - sz * 5, w: 12, h: 3.8, d: 1.4, mat: MATS.wall });
      box({ x: cx - sx * 5, y: 1.9, z: cz, w: 1.4, h: 3.8, d: 12, mat: MATS.wall });
      box({ x: cx + sx * 3, y: 4.2, z: cz - sz * 5, w: 3, h: 1.0, d: 1.4, mat: MATS.concrete });
      box({ x: cx - sx * 5, y: 4.2, z: cz + sz * 3, w: 1.4, h: 1.0, d: 3, mat: MATS.concrete });
    });
    box({ x: 0, y: 1.6, z: -20, w: 20, h: 3.2, d: 1.4, mat: MATS.wall });
    box({ x: 0, y: 1.6, z: 20, w: 20, h: 3.2, d: 1.4, mat: MATS.wall });
    box({ x: -20, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 20, mat: MATS.wall });
    box({ x: 20, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 20, mat: MATS.wall });
    [[-9, -20], [9, -20], [-9, 20], [9, 20]].forEach(([x, z]) =>
      box({ x, y: 0.6, z, w: 2.2, h: 1.2, d: 2.2, mat: MATS.crate }));
    scatterCrates(0xc0ffee, 46, spawn);
    const p = new THREE.PointLight(0xffb870, 110, 48, 2);
    p.position.set(0, 7.0, 0);
    worldGroup.add(p);
    ringSpawns();
  }

  return {
    mapId,
    theme,
    colliders,
    solidMeshes,
    spawnPoints,
    spawn,
    materials: MATS,
    group: worldGroup,
    /** Removes every world object and frees its GPU resources. */
    dispose() {
      scene.remove(worldGroup);
      worldGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
    },
    pickSpawn(awayFrom, minDist) {
      if (spawnPoints.length === 0) return new THREE.Vector3(0, 0, -20);
      let best = null, bestD = -1;
      for (let i = 0; i < 10; i++) {
        const p = spawnPoints[(Math.random() * spawnPoints.length) | 0];
        const d = p.distanceTo(awayFrom);
        if (d > bestD) { bestD = d; best = p; }
        if (d > minDist + 14) return p.clone();
      }
      return (best || spawnPoints[0]).clone();
    },
    hasLineOfSight(a, b) {
      const dir = LOS_DIR.subVectors(b, a);
      const dist = dir.length();
      if (dist < 1e-4) return true;
      dir.divideScalar(dist);
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        if (c.max.y === 0 && dir.y > -0.25) continue;
        const t = rayAABB(a, dir, c.min, c.max, LOS_NORMAL);
        if (t >= 0 && t < dist) return false;
      }
      return true;
    },
  };
}

const LOS_DIR = new THREE.Vector3();
const LOS_NORMAL = new THREE.Vector3();
