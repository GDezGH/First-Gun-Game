/**
 * world.js — builds the arena: floor, perimeter, cover, lighting.
 *
 * The map is deliberately "gray-box": simple boxes, no imported models.
 * That keeps the repo light and makes the level trivial to edit — every
 * piece of cover is one line in BUILD below.
 *
 * Everything solid is registered in `colliders` as an axis-aligned box,
 * which both the player controller and the hit-scan weapons query.
 */

import * as THREE from './three.js';
import { GAME } from './config.js';
import { makeRng, rayAABB } from './mathutil.js';

/** Canvas-drawn texture so the repo ships zero image files. */
function gridTexture(size = 512, bg = '#15181d', line = '#232931', specks = 1400) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  // Concrete speckle.
  for (let i = 0; i < specks; i++) {
    const v = 18 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.10 + Math.random() * 0.22})`;
    const s = 1 + Math.random() * 2.4;
    g.fillRect(Math.random() * size, Math.random() * size, s, s);
  }

  // Tile grout.
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

/** Vertical gradient sky, drawn on the inside of a sphere. */
function skyDome() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#05070b');
  grad.addColorStop(0.45, '#0c1220');
  grad.addColorStop(0.72, '#1b2637');
  grad.addColorStop(0.88, '#3a3026');
  grad.addColorStop(1.00, '#5a3d1c');
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

export function buildWorld(scene) {
  const R = GAME.ARENA_RADIUS;

  /** Solid boxes the simulation collides against. */
  const colliders = [];
  /** Meshes that should receive bullet decals / impact effects. */
  const solidMeshes = [];
  /** Hand-picked enemy spawn candidates. */
  const spawnPoints = [];

  const floorTex = gridTexture(512, '#15181d', '#232931');
  floorTex.repeat.set(28, 28);
  const wallTex = gridTexture(512, '#1a1d23', '#2c333d', 900);
  wallTex.repeat.set(6, 2);
  const crateTex = gridTexture(256, '#33301f', '#4a4630', 700);
  crateTex.repeat.set(1, 1);

  const MATS = {
    floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0.02 }),
    wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, metalness: 0.05 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.85, metalness: 0.08 }),
    crate: new THREE.MeshStandardMaterial({ map: crateTex, color: 0x8a8358, roughness: 0.8, metalness: 0.15 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.42, metalness: 0.75 }),
    trim: new THREE.MeshStandardMaterial({
      color: 0xff8c1a, roughness: 0.4, metalness: 0.3,
      emissive: 0xff8c1a, emissiveIntensity: 0.55,
    }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff0d0, emissive: 0xffd9a0, emissiveIntensity: 2.4, roughness: 1,
    }),
  };

  /**
   * Add a box. Coordinates are the CENTRE of the box.
   * @param {object} o {x,y,z,w,h,d, mat, solid, shadow}
   */
  function box(o) {
    const { x, y, z, w, h, d } = o;
    const mat = o.mat || MATS.concrete;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = o.shadow !== false;
    mesh.receiveShadow = true;
    scene.add(mesh);

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
  // Sky + ground
  // ------------------------------------------------------------------
  scene.add(skyDome());

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 2, R * 2), MATS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // The floor is a collider too, so bullets thud into the ground.
  colliders.push({
    min: new THREE.Vector3(-R, -4, -R),
    max: new THREE.Vector3(R, 0, R),
  });

  // ------------------------------------------------------------------
  // Perimeter walls
  // ------------------------------------------------------------------
  const WALL_H = 9;
  const T = 2;
  box({ x: 0, y: WALL_H / 2, z: -R - T / 2, w: R * 2 + T * 2, h: WALL_H, d: T, mat: MATS.wall });
  box({ x: 0, y: WALL_H / 2, z: R + T / 2, w: R * 2 + T * 2, h: WALL_H, d: T, mat: MATS.wall });
  box({ x: -R - T / 2, y: WALL_H / 2, z: 0, w: T, h: WALL_H, d: R * 2, mat: MATS.wall });
  box({ x: R + T / 2, y: WALL_H / 2, z: 0, w: T, h: WALL_H, d: R * 2, mat: MATS.wall });

  // Accent trim along the top of each wall.
  [
    { x: 0, z: -R - T / 2, w: R * 2, d: 0.3 },
    { x: 0, z: R + T / 2, w: R * 2, d: 0.3 },
    { x: -R - T / 2, z: 0, w: 0.3, d: R * 2 },
    { x: R + T / 2, z: 0, w: 0.3, d: R * 2 },
  ].forEach((t) => box({ x: t.x, y: WALL_H + 0.25, z: t.z, w: t.w, h: 0.5, d: t.d, mat: MATS.trim, solid: false }));

  // ------------------------------------------------------------------
  // Centre platform with four pillars
  // ------------------------------------------------------------------
  box({ x: 0, y: 0.6, z: 0, w: 16, h: 1.2, d: 16, mat: MATS.concrete });
  [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]].forEach(([px, pz]) => {
    box({ x: px, y: 3.6, z: pz, w: 1.5, h: 6, d: 1.5, mat: MATS.concrete });
    box({ x: px, y: 6.9, z: pz, w: 2.0, h: 0.5, d: 2.0, mat: MATS.metal });
    box({ x: px, y: 7.35, z: pz, w: 1.0, h: 0.5, d: 1.0, mat: MATS.lamp, solid: false });
  });
  // Roof over the centre so snipers have to work for their angle.
  box({ x: 0, y: 7.9, z: 0, w: 18, h: 0.7, d: 18, mat: MATS.metal });

  // Steps up to the platform on two sides.
  [1, -1].forEach((s) => {
    box({ x: 0, y: 0.2, z: s * 9.4, w: 6, h: 0.4, d: 2.6, mat: MATS.concrete });
    box({ x: 0, y: 0.45, z: s * 8.2, w: 6, h: 0.3, d: 1.4, mat: MATS.concrete, solid: false });
  });

  // ------------------------------------------------------------------
  // Four corner bunkers (L-shaped cover)
  // ------------------------------------------------------------------
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  corners.forEach(([sx, sz]) => {
    const cx = sx * 30;
    const cz = sz * 30;
    box({ x: cx, y: 1.9, z: cz - sz * 5, w: 12, h: 3.8, d: 1.4, mat: MATS.wall });
    box({ x: cx - sx * 5, y: 1.9, z: cz, w: 1.4, h: 3.8, d: 12, mat: MATS.wall });
    // Crenellations on top for peeking.
    box({ x: cx + sx * 3, y: 4.2, z: cz - sz * 5, w: 3, h: 1.0, d: 1.4, mat: MATS.concrete });
    box({ x: cx - sx * 5, y: 4.2, z: cz + sz * 3, w: 1.4, h: 1.0, d: 3, mat: MATS.concrete });
  });

  // ------------------------------------------------------------------
  // Mid-field walls
  // ------------------------------------------------------------------
  box({ x: 0, y: 1.6, z: -20, w: 20, h: 3.2, d: 1.4, mat: MATS.wall });
  box({ x: 0, y: 1.6, z: 20, w: 20, h: 3.2, d: 1.4, mat: MATS.wall });
  box({ x: -20, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 20, mat: MATS.wall });
  box({ x: 20, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 20, mat: MATS.wall });

  // Gaps in those walls, plugged with low cover so the sightlines stay broken.
  [[-9, -20], [9, -20], [-9, 20], [9, 20]].forEach(([x, z]) =>
    box({ x, y: 0.6, z, w: 2.2, h: 1.2, d: 2.2, mat: MATS.crate })
  );

  // ------------------------------------------------------------------
  // Seeded crate scatter — same layout every run so the map is learnable
  // ------------------------------------------------------------------
  const rng = makeRng(0xc0ffee);
  const placed = [];
  const SX = GAME.PLAYER.SPAWN.x;
  const SZ = GAME.PLAYER.SPAWN.z;
  const overlaps = (x, z, r) =>
    placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) ||
    Math.abs(x) < 11 && Math.abs(z) < 11 ||          // keep the centre clear
    Math.abs(x) > R - 4 || Math.abs(z) > R - 4 ||    // keep off the walls
    // Keep the player spawn clear. Without this a 3 m crate stack used to
    // generate 2.8 m in front of the spawn, so you started facing a wall.
    (x - SX) ** 2 + (z - SZ) ** 2 < GAME.SPAWN_CLEARANCE ** 2;

  let guard = 0;
  while (placed.length < 46 && guard++ < 900) {
    const x = (rng() * 2 - 1) * (R - 6);
    const z = (rng() * 2 - 1) * (R - 6);
    const size = 1.6 + rng() * 1.6;
    if (overlaps(x, z, size)) continue;
    placed.push({ x, z, r: size });
    box({ x, y: size / 2, z, w: size, h: size, d: size, mat: MATS.crate });

    // Roughly 1 in 4 crates gets a stack on top.
    if (rng() < 0.26) {
      const s2 = size * (0.55 + rng() * 0.2);
      box({
        x: x + (rng() - 0.5) * 0.4,
        y: size + s2 / 2,
        z: z + (rng() - 0.5) * 0.4,
        w: s2, h: s2, d: s2,
        mat: MATS.crate,
      });
    }
  }

  // ------------------------------------------------------------------
  // Lighting
  // ------------------------------------------------------------------
  // Base illumination was 0.55 -- under ACES tone mapping that read almost
  // pitch black against the walls. Bumped so the arena is readable at a
  // glance; enemies were disappearing into the shadow side.
  scene.add(new THREE.HemisphereLight(0xaec4e4, 0x33302a, 1.15));

  const sun = new THREE.DirectionalLight(0xffd9b0, 2.3);
  sun.position.set(38, 55, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 190;
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  // Cool fill from the opposite side so shadows are readable, not black.
  const fill = new THREE.DirectionalLight(0x6f8fc0, 0.75);
  fill.position.set(-30, 22, -26);
  scene.add(fill);

  // Warm practicals over the centre platform.
  [[0, 0]].forEach(([x, z]) => {
    const p = new THREE.PointLight(0xffb870, 110, 48, 2);
    p.position.set(x, 7.0, z);
    scene.add(p);
  });

  // ------------------------------------------------------------------
  // Spawn points: a ring plus interior pockets
  // ------------------------------------------------------------------
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    spawnPoints.push(new THREE.Vector3(Math.cos(a) * (R - 7), 0, Math.sin(a) * (R - 7)));
  }
  [[-18, -18], [18, -18], [-18, 18], [18, 18], [-36, 0], [36, 0], [0, -36], [0, 36]].forEach(([x, z]) =>
    spawnPoints.push(new THREE.Vector3(x, 0, z))
  );

  return {
    colliders,
    solidMeshes,
    spawnPoints,
    materials: MATS,
    /** Pick a spawn point at least `minDist` from `awayFrom`. */
    pickSpawn(awayFrom, minDist) {
      let best = null;
      let bestD = -1;
      for (let i = 0; i < 10; i++) {
        const p = spawnPoints[(Math.random() * spawnPoints.length) | 0];
        const d = p.distanceTo(awayFrom);
        if (d > bestD) { bestD = d; best = p; }
        if (d > minDist + 14) return p.clone();
      }
      return (best || spawnPoints[0]).clone();
    },
    /**
     * True when a straight line between a and b is unobstructed.
     * Used for enemy line-of-sight checks.
     */
    hasLineOfSight(a, b) {
      const dir = LOS_DIR.subVectors(b, a);
      const dist = dir.length();
      if (dist < 1e-4) return true;
      dir.divideScalar(dist);
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        // Ignore the floor slab unless the ray actually points downward a lot.
        if (c.max.y === 0 && dir.y > -0.25) continue;
        const t = rayAABB(a, dir, c.min, c.max, LOS_NORMAL);
        if (t >= 0 && t < dist) return false;
      }
      return true;
    },
  };
}

/** Scratch vectors so line-of-sight checks never allocate per frame. */
const LOS_DIR = new THREE.Vector3();
const LOS_NORMAL = new THREE.Vector3();
