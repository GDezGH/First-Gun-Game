/**
 * weapons.js — weapon state, fire modes, aiming down sights, and viewmodels.
 *
 * Firing model
 * ------------
 * The manager OWNS the trigger now. main.js only reports intent
 * (`pullTrigger` / `releaseTrigger` / `setAim`) and drains the results queue
 * each frame. That lets fire modes that outlive a single frame — bursts,
 * full-auto cadence — live in one place and stay deterministic.
 *
 * Hit detection is unchanged: every shot is a ray tested against the level's
 * AABBs and each enemy's head/torso spheres; nearest hit wins.
 *
 * Aiming down sights
 * ------------------
 * `ads` is a 0..1 value eased toward 1 while the aim key is held. It drives:
 *   - camera FOV        (getFov)
 *   - mouse sensitivity (getSensMult)
 *   - spread tightening (inside _shootOnce)
 *   - move speed        (read by the player via input.speedMult)
 *   - the viewmodel pose (gun centres into the sights)
 */

import * as THREE from './three.js';
import { WEAPONS } from './config.js';
import { audio } from './audio.js';
import { rayAABB, raySphere, clamp, lerp } from './mathutil.js';

// ---------------------------------------------------------------------
// Hit-scan (unchanged)
// ---------------------------------------------------------------------

const _normal = new THREE.Vector3();
const _point = new THREE.Vector3();

export function traceBullet(origin, dir, maxDist, world, enemies, out) {
  out.t = maxDist;
  out.point = null;
  out.normal = null;
  out.enemy = null;
  out.head = false;
  out.surface = null;

  const colliders = world.colliders;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const t = rayAABB(origin, dir, c.min, c.max, _normal);
    if (t >= 0 && t < out.t) {
      out.t = t;
      out.normal = _normal.clone();
      out.enemy = null; out.head = false; out.surface = 'world';
    }
  }

  if (enemies) {
    for (let i = 0; i < enemies.list.length; i++) {
      const e = enemies.list[i];
      if (!e.alive) continue;
      const th = raySphere(origin, dir, e.headCenter, e.headRadius);
      if (th >= 0 && th < out.t) { out.t = th; out.enemy = e; out.head = true; out.normal = null; out.surface = 'enemy'; }
      const tb = raySphere(origin, dir, e.bodyCenter, e.bodyRadius);
      if (tb >= 0 && tb < out.t) { out.t = tb; out.enemy = e; out.head = false; out.normal = null; out.surface = 'enemy'; }
    }
  }

  if (out.surface) out.point = _point.copy(origin).addScaledVector(dir, out.t);
  return out;
}

// ---------------------------------------------------------------------
// Procedural viewmodels — distinct, detailed 3D guns (no model files)
// ---------------------------------------------------------------------

function buildGunMesh(def) {
  const group = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.42, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.6, metalness: 0.6 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.9, metalness: 0.08 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x6b5a3a, roughness: 0.85, metalness: 0.1 });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xff8c1a, roughness: 0.4, metalness: 0.4, emissive: 0xff6a00, emissiveIntensity: 0.5,
  });
  const lens = new THREE.MeshStandardMaterial({
    color: 0x88ccff, emissive: 0x66aaff, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.3,
  });

  const add = (geo, x, y, z, mat, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    group.add(m);
    return m;
  };
  const box = (w, h, d, x, y, z, mat, rx, ry, rz) => add(new THREE.BoxGeometry(w, h, d), x, y, z, mat, rx, ry, rz);
  const cyl = (r1, r2, len, x, y, z, mat, rx = Math.PI / 2) =>
    add(new THREE.CylinderGeometry(r1, r2, len, 14), x, y, z, mat, rx);

  let muzzleZ = -0.8;

  switch (def.id) {
    case 'pistol': {
      box(0.055, 0.062, 0.26, 0, 0.02, -0.09, steel);          // slide
      box(0.05, 0.045, 0.2, 0, -0.006, -0.06, dark);           // frame
      box(0.05, 0.15, 0.075, 0, -0.105, 0.03, polymer, -0.22); // grip
      cyl(0.02, 0.02, 0.06, 0, 0.02, -0.24, dark);             // muzzle
      box(0.01, 0.02, 0.01, 0, 0.065, -0.2, accent);           // front sight
      box(0.012, 0.02, 0.012, 0, 0.065, 0.02, accent);         // rear sight
      muzzleZ = -0.26;
      break;
    }
    case 'shotgun': {
      box(0.075, 0.09, 0.5, 0, 0, -0.14, steel);               // receiver
      cyl(0.032, 0.032, 0.66, 0, 0.012, -0.6, dark);           // barrel
      cyl(0.028, 0.028, 0.4, 0, -0.045, -0.5, steel);          // mag tube
      box(0.07, 0.055, 0.3, 0, -0.05, -0.5, polymer);          // pump
      box(0.07, 0.11, 0.26, 0, -0.05, 0.2, polymer, 0.3);      // stock
      box(0.05, 0.14, 0.09, 0, -0.115, -0.02, polymer, -0.25); // grip
      box(0.012, 0.03, 0.012, 0, 0.06, -0.86, accent);         // bead
      muzzleZ = -0.96;
      break;
    }
    case 'smg': {
      box(0.06, 0.075, 0.4, 0, 0, -0.1, steel);                // compact receiver
      cyl(0.026, 0.026, 0.3, 0, 0.008, -0.44, dark);           // short barrel
      box(0.05, 0.05, 0.16, 0, 0.0, -0.34, polymer);           // handguard
      box(0.05, 0.2, 0.07, 0, -0.13, -0.1, steel, 0.1);        // long mag
      box(0.05, 0.1, 0.08, 0, -0.1, 0.06, polymer, -0.2);      // grip
      box(0.05, 0.06, 0.14, 0, -0.01, 0.16, steel);            // stub stock
      cyl(0.02, 0.024, 0.08, 0, 0.008, -0.6, dark);            // muzzle boost
      box(0.01, 0.02, 0.01, 0, 0.06, -0.56, accent);
      muzzleZ = -0.64;
      break;
    }
    case 'dmr': {
      box(0.06, 0.08, 0.56, 0, 0, -0.16, steel);               // long receiver
      cyl(0.024, 0.024, 0.78, 0, 0.01, -0.8, dark);            // heavy barrel
      cyl(0.03, 0.034, 0.1, 0, 0.01, -1.2, dark);              // muzzle brake
      box(0.05, 0.05, 0.4, 0, 0.0, -0.5, polymer);             // handguard
      box(0.05, 0.16, 0.08, 0, -0.12, -0.1, polymer, -0.2);    // grip
      box(0.05, 0.14, 0.075, 0, -0.1, -0.28, steel, 0.08);     // mag
      box(0.05, 0.09, 0.3, 0, -0.02, 0.26, polymer);           // stock
      // Scope: tube + objective lens + turrets.
      cyl(0.035, 0.035, 0.34, 0, 0.1, -0.12, dark, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 16), 0, 0.1, -0.3, lens, Math.PI / 2);
      cyl(0.012, 0.012, 0.05, 0, 0.145, -0.12, accent, 0);
      cyl(0.012, 0.012, 0.05, 0.035, 0.1, -0.12, accent, Math.PI / 2);
      box(0.01, 0.02, 0.01, 0, 0.075, -0.6, accent);
      muzzleZ = -1.26;
      break;
    }
    case 'burst': {
      box(0.06, 0.08, 0.46, 0, 0, -0.12, steel);               // receiver
      cyl(0.024, 0.024, 0.42, 0, 0.008, -0.55, dark);          // barrel
      box(0.05, 0.05, 0.26, 0, 0.0, -0.4, tan);                // handguard
      box(0.045, 0.13, 0.07, 0, -0.11, -0.06, polymer, -0.18); // grip
      box(0.05, 0.15, 0.075, 0, -0.1, -0.24, steel, 0.1);      // mag
      box(0.05, 0.08, 0.2, 0, -0.01, 0.22, tan);               // stock
      box(0.045, 0.035, 0.12, 0, 0.062, -0.1, dark);           // rail
      box(0.01, 0.02, 0.01, 0, 0.085, -0.6, accent);
      muzzleZ = -0.78;
      break;
    }
    default: { // rifle
      box(0.062, 0.08, 0.5, 0, 0, -0.12, steel);
      cyl(0.022, 0.022, 0.44, 0, 0.006, -0.6, dark);
      cyl(0.028, 0.03, 0.08, 0, 0.006, -0.84, dark);           // flash hider
      box(0.05, 0.055, 0.24, 0, 0.0, -0.42, polymer);
      box(0.04, 0.05, 0.1, 0, -0.07, -0.4, polymer, -0.5);     // angled grip
      box(0.055, 0.16, 0.075, 0, -0.115, -0.06, polymer, -0.16);
      box(0.05, 0.16, 0.075, 0, -0.1, -0.24, steel, 0.1);
      box(0.055, 0.085, 0.22, 0, -0.01, 0.23, polymer);
      box(0.045, 0.035, 0.14, 0, 0.065, -0.1, dark);
      box(0.01, 0.022, 0.01, 0, 0.09, -0.72, accent);
      box(0.01, 0.022, 0.01, 0, 0.09, 0.0, accent);
      muzzleZ = -0.88;
      break;
    }
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, muzzleZ);
  group.add(muzzle);
  group.userData.muzzle = muzzle;

  group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return group;
}

// ---------------------------------------------------------------------
// Weapon manager
// ---------------------------------------------------------------------

export class WeaponManager {
  constructor(camera, world, effects) {
    this.camera = camera;
    this.world = world;
    this.effects = effects;

    this.slots = WEAPONS.map((def) => ({ def, mag: def.magSize, reserve: def.startingReserve }));
    this.index = 0;
    this.meshes = [];
    this.activeMesh = null;

    // Trigger / fire-mode state (owned here).
    this.triggerHeld = false;
    this._semiLatch = false;       // one shot per pull for semi
    this._semiQueued = false;
    this._burstQueued = false;
    this.burstRemaining = 0;

    this.cooldown = 0;
    this.reloadTimer = 0;
    this.reloadStepFired = [false, false, false];
    this.switchTimer = 0;
    this.switchTarget = -1;

    // Aiming down sights.
    this.ads = 0;
    this._aimHeld = false;

    // Viewmodel animation.
    this.recoilZ = 0;
    this.recoilRot = 0;
    this.reloadPose = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.bob = 0;
    this.lastAimX = 0;
    this.lastAimY = 0;
    this._sprintPose = 0;

    this.shotsFired = 0;
    this.shotsHit = 0;

    /** Results queued for main.js to consume (hits, kills). */
    this._results = [];

    this._trace = {};
    this._muzzleWorld = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._spreadDir = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();

    this.rig = new THREE.Group();
    this.rig.position.set(0.20, -0.19, -0.42);
    camera.add(this.rig);

    this.slots.forEach((slot, i) => {
      const mesh = buildGunMesh(slot.def);
      mesh.visible = i === 0;
      this.rig.add(mesh);
      this.meshes.push(mesh);
    });
    this.activeMesh = this.meshes[0];
  }

  get current() { return this.slots[this.index]; }
  get def() { return this.current.def; }

  reset() {
    this.slots.forEach((s) => { s.mag = s.def.magSize; s.reserve = s.def.startingReserve; });
    this.index = 0;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.switchTarget = -1;
    this.triggerHeld = false;
    this._semiLatch = false;
    this._semiQueued = false;
    this._burstQueued = false;
    this.burstRemaining = 0;
    this.ads = 0;
    this._aimHeld = false;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this._results.length = 0;
    this.meshes.forEach((m, i) => { m.visible = i === 0; });
    this.activeMesh = this.meshes[0];
    this.recoilZ = 0; this.recoilRot = 0; this.reloadPose = 0;
  }

  // ------------------------------------------------------------------
  // Intent (called by main.js)
  // ------------------------------------------------------------------

  pullTrigger(player, enemies) {
    this.triggerHeld = true;
    if (this.def.mode === 'semi') {
      if (!this._semiLatch) { this._semiQueued = true; this._semiLatch = true; }
    } else if (this.def.mode === 'burst') {
      if (this.burstRemaining <= 0) this._burstQueued = true;
    }
  }

  releaseTrigger() {
    this.triggerHeld = false;
    this._semiLatch = false;
  }

  setAim(held) { this._aimHeld = held; }

  // ------------------------------------------------------------------
  // Aiming helpers
  // ------------------------------------------------------------------

  getFov(baseFov) { return lerp(baseFov, this.def.adsFov, this.ads); }
  getSensMult() { return lerp(1, this.def.adsSensMult, this.ads); }
  getMoveMult() { return lerp(1, this.def.adsMoveMult, this.ads); }

  switchTo(i) {
    if (i === this.index || i < 0 || i >= this.slots.length) return;
    if (this.switchTimer > 0) return;
    this.switchTarget = i;
    this.switchTimer = 0.42;
    this.cancelReload();
    this.burstRemaining = 0;
    this.releaseTrigger();
    audio.weaponSwitch();
  }

  cycle(delta) {
    const n = this.slots.length;
    this.switchTo((this.index + delta + n) % n);
  }

  startReload() {
    const s = this.current;
    if (this.reloadTimer > 0 || this.switchTimer > 0) return false;
    if (s.mag >= s.def.magSize || s.reserve <= 0) return false;
    this.reloadTimer = s.def.reloadTime;
    this.reloadStepFired = [false, false, false];
    this.burstRemaining = 0;
    audio.reload(0);
    return true;
  }

  cancelReload() {
    if (this.reloadTimer > 0) { this.reloadTimer = 0; return true; }
    return false;
  }

  get isReloading() { return this.reloadTimer > 0; }
  get canFire() { return this.cooldown <= 0 && this.reloadTimer <= 0 && this.switchTimer <= 0; }

  // ------------------------------------------------------------------
  // Firing
  // ------------------------------------------------------------------

  /** Perform a single shot event; queue the result for main.js. */
  _shootOnce(player, enemies) {
    const slot = this.current;
    const def = slot.def;

    if (!this.infiniteAmmo && slot.mag <= 0) { audio.dryFire(); return; }

    if (!this.infiniteAmmo) slot.mag--;
    this.shotsFired++;

    // Cone: base + movement, tightened by how far we are aimed.
    const flatSpeed = Math.hypot(player.vel.x, player.vel.z);
    const moveFactor = clamp(flatSpeed / 8.6, 0, 1);
    const airFactor = player.grounded ? 0 : 1.6;
    const adsTighten = lerp(1, def.adsSpreadMult, this.ads);
    const spread = (def.spreadRads + def.moveSpread * moveFactor + def.spreadRads * airFactor) * adsTighten;

    const origin = player.eyePosition();
    const aim = player.aimDirection(this._dir);

    this._up.set(0, 1, 0);
    this._right.crossVectors(aim, this._up).normalize();
    if (this._right.lengthSq() < 0.01) this._right.set(1, 0, 0);
    this._up.crossVectors(this._right, aim).normalize();

    this.activeMesh.userData.muzzle.getWorldPosition(this._muzzleWorld);

    const result = { fired: true, dryFire: false, hits: [], kills: [], weapon: def };

    for (let p = 0; p < def.pellets; p++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      this._spreadDir.copy(aim)
        .addScaledVector(this._right, Math.cos(a) * r)
        .addScaledVector(this._up, Math.sin(a) * r)
        .normalize();

      const hit = traceBullet(origin, this._spreadDir, def.range, this.world, enemies, this._trace);
      const endPoint = hit.point ? hit.point.clone() : this._spreadDir.clone().multiplyScalar(def.range).add(origin);
      this.effects.tracer(this._muzzleWorld, endPoint, def.color);

      if (hit.surface === 'enemy') {
        this.shotsHit++;
        const dmg = def.damage * (hit.head ? def.headshotMult : 1);
        const killed = enemies.damage(hit.enemy, dmg, hit.head, hit.point, this._spreadDir);
        result.hits.push({ enemy: hit.enemy, head: hit.head, damage: dmg, point: hit.point.clone() });
        if (killed) result.kills.push({ enemy: hit.enemy, head: hit.head });
        this.effects.blood(hit.point, this._spreadDir);
        audio.impact(hit.point, origin, true);
      } else if (hit.surface === 'world') {
        this.effects.impact(hit.point, hit.normal);
        audio.impact(hit.point, origin, false);
      }
    }

    this.effects.muzzleFlash(this._muzzleWorld, aim, def.id === 'shotgun' ? 1.7 : 1.0);
    this.effects.shellCasing(this._muzzleWorld, player);

    // Recoil is damped while aimed so ADS genuinely helps control.
    const recoilScale = lerp(1, 0.65, this.ads);
    player.addRecoil(def.recoil * recoilScale, def.recoilH * recoilScale);
    this.recoilZ = Math.min(0.14, this.recoilZ + 0.055 + def.recoil * 0.012);
    this.recoilRot = Math.min(0.42, this.recoilRot + 0.13 + def.recoil * 0.03);
    player.addShake(def.shake * lerp(1, 0.7, this.ads));

    audio.shoot(def.sfx);
    this._results.push(result);
  }

  /** Drain queued fire results (main.js calls once per frame). */
  drainResults() {
    const out = this._results;
    this._results = [];
    return out;
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  update(dt, player, input, enemies) {
    const def = this.def;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // --- aim down sights ---------------------------------------------
    const wantAim = this._aimHeld && this.switchTimer <= 0 && !this.isReloading;
    this.ads += ((wantAim ? 1 : 0) - this.ads) * Math.min(1, dt * 12);
    this.ads = clamp(this.ads, 0, 1);

    // --- reload sequencing -------------------------------------------
    if (this.reloadTimer > 0) {
      const total = this.current.def.reloadTime;
      const progress = 1 - this.reloadTimer / total;
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (!this.reloadStepFired[1] && progress > 0.36) { this.reloadStepFired[1] = true; audio.reload(1); }
      if (!this.reloadStepFired[2] && progress > 0.78) { this.reloadStepFired[2] = true; audio.reload(2); }
      if (this.reloadTimer <= 0) {
        const need = this.current.def.magSize - this.current.mag;
        const take = Math.min(need, this.current.reserve);
        this.current.mag += take;
        this.current.reserve -= take;
      }
    }

    // --- weapon switching --------------------------------------------
    if (this.switchTimer > 0) {
      this.switchTimer = Math.max(0, this.switchTimer - dt);
      if (this.switchTimer <= 0.21 && this.switchTarget >= 0) {
        this.meshes[this.index].visible = false;
        this.index = this.switchTarget;
        this.switchTarget = -1;
        this.meshes[this.index].visible = true;
        this.activeMesh = this.meshes[this.index];
      }
    }

    // --- auto reload when empty ---------------------------------------
    if (this.current.mag <= 0 && this.reloadTimer <= 0 && this.current.reserve > 0) this.startReload();

    // --- firing state machine ----------------------------------------
    const canShoot = this.reloadTimer <= 0 && this.switchTimer <= 0 && player.alive;
    if (canShoot) {
      if (this._semiQueued) {
        this._semiQueued = false;
        if (this.cooldown <= 0 && this.current.mag > 0) {
          this._shootOnce(player, enemies);
          this.cooldown = 60 / def.rpm;
        }
      } else if (this._burstQueued) {
        this._burstQueued = false;
        if (this.cooldown <= 0 && this.current.mag > 0) {
          this.burstRemaining = def.burstCount - 1;
          this._shootOnce(player, enemies);
          this.cooldown = 60 / def.burstRpm;
        }
      } else if (this.burstRemaining > 0) {
        if (this.cooldown <= 0 && this.current.mag > 0) {
          this._shootOnce(player, enemies);
          this.burstRemaining--;
          this.cooldown = 60 / def.burstRpm;
        }
      } else if (def.mode === 'auto' && this.triggerHeld) {
        if (this.cooldown <= 0 && this.current.mag > 0) {
          this._shootOnce(player, enemies);
          this.cooldown = 60 / def.rpm;
        }
      }
    }

    // --- viewmodel animation ------------------------------------------
    this.recoilZ = Math.max(0, this.recoilZ - dt * 1.5);
    this.recoilRot = Math.max(0, this.recoilRot - dt * 5.5);

    if (this.reloadTimer > 0) {
      const total = def.reloadTime;
      const t = 1 - this.reloadTimer / total;
      this.reloadPose = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) * (0.9 + total * 0.1);
    } else {
      this.reloadPose = Math.max(0, this.reloadPose - dt * 6);
    }

    const dx = player.yaw - this.lastAimX;
    const dy = player.pitch - this.lastAimY;
    this.lastAimX = player.yaw;
    this.lastAimY = player.pitch;
    this.swayX += (-clamp(dx * 9, -0.05, 0.05) - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (clamp(dy * 9, -0.04, 0.04) - this.swayY) * Math.min(1, dt * 9);

    const flatSpeed = Math.hypot(player.vel.x, player.vel.z);
    if (player.grounded && flatSpeed > 0.6) this.bob += dt * (input.sprint ? 13 : 9);
    const bobAmt = player.grounded ? Math.min(flatSpeed / 8.6, 1) : 0;

    const switchDip = this.switchTimer > 0 ? Math.sin((1 - this.switchTimer / 0.42) * Math.PI) * 0.28 : 0;
    const sprinting = input.sprint && input.forward && player.grounded;
    this._sprintPose += ((sprinting ? 1 : 0) - this._sprintPose) * Math.min(1, dt * 8);
    const sp = this._sprintPose;

    // ADS centres the gun into the sights.
    const hipX = 0.20, adsX = def.scoped ? 0.0 : 0.0;
    const hipY = -0.19, adsY = -0.152;
    const hipZ = -0.42, adsZ = def.scoped ? -0.30 : -0.36;
    const ax = lerp(hipX, adsX, this.ads);
    const ay = lerp(hipY, adsY, this.ads);
    const az = lerp(hipZ, adsZ, this.ads);

    this.rig.position.set(
      ax + this.swayX * (1 - this.ads * 0.7) + Math.cos(this.bob) * 0.012 * bobAmt * (1 - this.ads)
        + this.reloadPose * 0.03 + sp * 0.06,
      ay + this.swayY * (1 - this.ads * 0.7) + Math.sin(this.bob * 2) * 0.014 * bobAmt * (1 - this.ads)
        - this.reloadPose * 0.16 - switchDip - sp * 0.09,
      az + this.recoilZ * 0.55 * (1 - this.ads * 0.4) + this.reloadPose * 0.05 + sp * 0.1
    );
    this.rig.rotation.set(
      this.recoilRot * 0.5 + this.reloadPose * 0.55 + sp * 0.22,
      this.swayX * 2.2 * (1 - this.ads) - this.reloadPose * 0.18 + sp * 0.55,
      this.swayY * 1.4 * (1 - this.ads) + this.reloadPose * 0.3 + sp * 0.2
    );
  }

  get accuracy() {
    if (this.shotsFired === 0) return null;
    return (this.shotsHit / this.shotsFired) * 100;
  }
}
