/**
 * weapons.js — weapon state machine, hit-scan resolution and viewmodel.
 *
 * Firing model
 * ------------
 * Every shot is a ray cast from the camera. The cone of fire is a
 * half-angle in radians; each pellet gets a random direction inside it.
 * The ray is tested against (a) every solid box in the level and
 * (b) two spheres per enemy — head and torso — and the nearest hit wins.
 * That is classic "hit-scan", which is what most arena shooters use
 * because it is instant, deterministic and trivially networkable later.
 */

import * as THREE from './three.js';
import { WEAPONS } from './config.js';
import { audio } from './audio.js';
import { rayAABB, raySphere, clamp } from './mathutil.js';

// ---------------------------------------------------------------------
// Hit-scan
// ---------------------------------------------------------------------

const _normal = new THREE.Vector3();
const _point = new THREE.Vector3();

/**
 * Cast one bullet.
 * @returns {{t:number, point:THREE.Vector3, normal:THREE.Vector3|null,
 *            enemy:Object|null, head:boolean, surface:'enemy'|'world'|null}}
 */
export function traceBullet(origin, dir, maxDist, world, enemies, out) {
  out.t = maxDist;
  out.point = null;
  out.normal = null;
  out.enemy = null;
  out.head = false;
  out.surface = null;

  // --- world geometry ------------------------------------------------
  const colliders = world.colliders;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const t = rayAABB(origin, dir, c.min, c.max, _normal);
    if (t >= 0 && t < out.t) {
      out.t = t;
      out.normal = _normal.clone();
      out.enemy = null;
      out.head = false;
      out.surface = 'world';
    }
  }

  // --- enemies (head sphere + torso sphere) ---------------------------
  if (enemies) {
    for (let i = 0; i < enemies.list.length; i++) {
      const e = enemies.list[i];
      if (!e.alive) continue;

      const th = raySphere(origin, dir, e.headCenter, e.headRadius);
      if (th >= 0 && th < out.t) {
        out.t = th; out.enemy = e; out.head = true; out.normal = null; out.surface = 'enemy';
      }
      const tb = raySphere(origin, dir, e.bodyCenter, e.bodyRadius);
      if (tb >= 0 && tb < out.t) {
        out.t = tb; out.enemy = e; out.head = false; out.normal = null; out.surface = 'enemy';
      }
    }
  }

  if (out.surface) {
    out.point = _point.copy(origin).addScaledVector(dir, out.t);
  }
  return out;
}

// ---------------------------------------------------------------------
// Procedural viewmodel
// ---------------------------------------------------------------------

/** Builds a low-poly gun mesh from a few boxes; no model files needed. */
function buildGunMesh(def) {
  const group = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.45, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.6, metalness: 0.6 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x2e2620, roughness: 0.9, metalness: 0.1 });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xff8c1a, roughness: 0.4, metalness: 0.4,
    emissive: 0xff6a00, emissiveIntensity: 0.4,
  });

  const add = (w, h, d, x, y, z, mat, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.rotation.z = rz;
    group.add(m);
    return m;
  };

  if (def.id === 'shotgun') {
    add(0.075, 0.085, 0.62, 0, 0, -0.16, steel);          // receiver
    add(0.062, 0.062, 0.72, 0, 0.012, -0.62, dark);       // barrel
    add(0.07, 0.05, 0.3, 0, -0.055, -0.55, grip);         // pump
    add(0.07, 0.11, 0.24, 0, -0.05, 0.22, grip, 0.28);    // stock
    add(0.05, 0.13, 0.09, 0, -0.11, -0.02, dark, -0.22);  // grip
    add(0.012, 0.03, 0.012, 0, 0.062, -0.72, accent);     // bead sight
  } else if (def.id === 'pistol') {
    add(0.055, 0.06, 0.24, 0, 0.02, -0.08, steel);        // slide
    add(0.05, 0.045, 0.2, 0, -0.005, -0.06, dark);        // frame
    add(0.05, 0.14, 0.075, 0, -0.1, 0.03, grip, -0.2);    // grip
    add(0.01, 0.018, 0.01, 0, 0.062, -0.18, accent);      // front sight
    add(0.01, 0.018, 0.01, 0, 0.062, 0.02, accent);       // rear sight
  } else {
    add(0.062, 0.08, 0.5, 0, 0, -0.12, steel);            // receiver
    add(0.045, 0.045, 0.46, 0, 0.006, -0.6, dark);        // barrel
    add(0.05, 0.055, 0.22, 0, 0.0, -0.42, dark);          // handguard
    add(0.055, 0.16, 0.075, 0, -0.115, -0.06, dark, -0.16); // pistol grip
    add(0.05, 0.16, 0.075, 0, -0.1, -0.24, steel, 0.1);   // magazine
    add(0.055, 0.085, 0.22, 0, -0.01, 0.23, grip);        // stock
    add(0.045, 0.035, 0.14, 0, 0.065, -0.1, dark);        // rail
    add(0.01, 0.022, 0.01, 0, 0.09, -0.66, accent);       // front sight
    add(0.01, 0.022, 0.01, 0, 0.09, 0.0, accent);         // rear sight
  }

  // Muzzle anchor used for tracers, flash and casing ejection.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, def.id === 'shotgun' ? -1.0 : def.id === 'pistol' ? -0.22 : -0.86);
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

    this.slots = WEAPONS.map((def) => ({
      def,
      mag: def.magSize,
      reserve: def.startingReserve,
    }));

    this.index = 0;
    this.meshes = [];
    this.activeMesh = null;

    // Timers
    this.cooldown = 0;          // time until the next shot is allowed
    this.reloadTimer = 0;       // >0 while reloading
    this.reloadStepFired = [false, false, false];
    this.switchTimer = 0;       // lower/raise animation
    this.switchTarget = -1;

    // Viewmodel animation state
    this.recoilZ = 0;
    this.recoilRot = 0;
    this.reloadPose = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.bob = 0;
    this.lastAimX = 0;
    this.lastAimY = 0;

    this.shotsFired = 0;
    this.shotsHit = 0;

    this._trace = {};
    this._muzzleWorld = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._spreadDir = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();

    // One gun mesh per weapon, all parented to the camera.
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

  /** Reset for a fresh run. */
  reset() {
    this.slots.forEach((s) => { s.mag = s.def.magSize; s.reserve = s.def.startingReserve; });
    this.index = 0;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.switchTarget = -1;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.meshes.forEach((m, i) => { m.visible = i === 0; });
    this.activeMesh = this.meshes[0];
    this.recoilZ = 0;
    this.recoilRot = 0;
    this.reloadPose = 0;
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  switchTo(i) {
    if (i === this.index || i < 0 || i >= this.slots.length) return;
    if (this.switchTimer > 0) return;
    this.switchTarget = i;
    this.switchTimer = 0.42;
    this.cancelReload();
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
    audio.reload(0);
    return true;
  }

  cancelReload() {
    if (this.reloadTimer > 0) {
      this.reloadTimer = 0;
      return true;
    }
    return false;
  }

  get isReloading() { return this.reloadTimer > 0; }
  get canFire() {
    return this.cooldown <= 0 && this.reloadTimer <= 0 && this.switchTimer <= 0;
  }

  // ------------------------------------------------------------------
  // Firing
  // ------------------------------------------------------------------

  /**
   * Attempt to fire.
   * @returns {object} result describing what happened, for the HUD.
   */
  fire(player, enemies) {
    const slot = this.current;
    const def = slot.def;

    if (!this.canFire) return { fired: false, dryFire: false };

    if (slot.mag <= 0) {
      audio.dryFire();
      this.cooldown = 0.25;
      this.startReload();
      return { fired: false, dryFire: true };
    }

    slot.mag--;
    this.shotsFired++;
    this.cooldown = 60 / def.rpm;

    // Cone widens while moving.
    const flatSpeed = Math.hypot(player.vel.x, player.vel.z);
    const moveFactor = clamp(flatSpeed / 8.6, 0, 1);
    const airFactor = player.grounded ? 0 : 1.6;
    const spread = def.spreadRads + def.moveSpread * moveFactor + def.spreadRads * airFactor;

    const origin = player.eyePosition();
    const aim = player.aimDirection(this._dir);

    // Build a basis around the aim vector so the cone is circular.
    this._up.set(0, 1, 0);
    this._right.crossVectors(aim, this._up).normalize();
    if (this._right.lengthSq() < 0.01) this._right.set(1, 0, 0);
    this._up.crossVectors(this._right, aim).normalize();

    // Muzzle world position for the tracer and flash.
    this.activeMesh.userData.muzzle.getWorldPosition(this._muzzleWorld);

    const result = { fired: true, dryFire: false, hits: [], kills: [], weapon: def };

    for (let p = 0; p < def.pellets; p++) {
      // Random point in a disc, projected onto the sphere.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      this._spreadDir
        .copy(aim)
        .addScaledVector(this._right, Math.cos(a) * r)
        .addScaledVector(this._up, Math.sin(a) * r)
        .normalize();

      const hit = traceBullet(origin, this._spreadDir, def.range, this.world, enemies, this._trace);

      const endPoint = hit.point
        ? hit.point.clone()
        : this._spreadDir.clone().multiplyScalar(def.range).add(origin);

      this.effects.tracer(this._muzzleWorld, endPoint, def.color);

      if (hit.surface === 'enemy') {
        this.shotsHit++;
        const mult = hit.head ? def.headshotMult : 1;
        const dmg = def.damage * mult;
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

    // Recoil: camera kick + viewmodel punch.
    player.addRecoil(def.recoil, def.recoilH);
    this.recoilZ = Math.min(0.14, this.recoilZ + 0.055 + def.recoil * 0.012);
    this.recoilRot = Math.min(0.42, this.recoilRot + 0.13 + def.recoil * 0.03);
    player.addShake(def.shake);

    audio.shoot(def.sfx);
    return result;
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  update(dt, player, input) {
    const def = this.def;

    this.cooldown = Math.max(0, this.cooldown - dt);

    // --- reload sequencing -------------------------------------------
    if (this.reloadTimer > 0) {
      const total = this.current.def.reloadTime;
      const progress = 1 - this.reloadTimer / total;
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);

      // Play the mag-out / mag-in / bolt clicks at the right moments.
      if (!this.reloadStepFired[1] && progress > 0.36) { this.reloadStepFired[1] = true; audio.reload(1); }
      if (!this.reloadStepFired[2] && progress > 0.78) { this.reloadStepFired[2] = true; audio.reload(2); }

      if (this.reloadTimer <= 0) {
        const need = this.current.def.magSize - this.current.mag;
        const take = Math.min(need, this.current.reserve);
        this.current.mag += take;
        this.current.reserve -= take;
      }
    }

    // --- weapon switching ---------------------------------------------
    if (this.switchTimer > 0) {
      this.switchTimer = Math.max(0, this.switchTimer - dt);
      // Swap meshes at the bottom of the lower/raise arc (halfway point).
      if (this.switchTimer <= 0.21 && this.switchTarget >= 0) {
        this.meshes[this.index].visible = false;
        this.index = this.switchTarget;
        this.switchTarget = -1;
        this.meshes[this.index].visible = true;
        this.activeMesh = this.meshes[this.index];
      }
    }

    // --- auto reload when empty ----------------------------------------
    if (this.current.mag <= 0 && this.reloadTimer <= 0 && this.current.reserve > 0) {
      this.startReload();
    }

    // --- viewmodel animation --------------------------------------------
    this.recoilZ = Math.max(0, this.recoilZ - dt * 1.5);
    this.recoilRot = Math.max(0, this.recoilRot - dt * 5.5);

    // Reload pose: down and to the side, easing in and out.
    if (this.reloadTimer > 0) {
      const total = def.reloadTime;
      const t = 1 - this.reloadTimer / total;
      this.reloadPose = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) * (0.9 + total * 0.1);
    } else {
      this.reloadPose = Math.max(0, this.reloadPose - dt * 6);
    }

    // Sway follows mouse movement.
    const dx = player.yaw - this.lastAimX;
    const dy = player.pitch - this.lastAimY;
    this.lastAimX = player.yaw;
    this.lastAimY = player.pitch;
    this.swayX += (-clamp(dx * 9, -0.05, 0.05) - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (clamp(dy * 9, -0.04, 0.04) - this.swayY) * Math.min(1, dt * 9);

    // Walk bob.
    const flatSpeed = Math.hypot(player.vel.x, player.vel.z);
    if (player.grounded && flatSpeed > 0.6) {
      this.bob += dt * (input.sprint ? 13 : 9);
    }
    const bobAmt = player.grounded ? Math.min(flatSpeed / 8.6, 1) : 0;

    // Lower the gun while switching.
    const switchDip = this.switchTimer > 0
      ? Math.sin((1 - this.switchTimer / 0.42) * Math.PI) * 0.28
      : 0;

    // Sprint pose: gun tucked to the side.
    const sprinting = input.sprint && input.forward && player.grounded;
    const sprintPose = sprinting ? 1 : 0;
    this._sprintPose = (this._sprintPose ?? 0) + (sprintPose - (this._sprintPose ?? 0)) * Math.min(1, dt * 8);
    const sp = this._sprintPose;

    this.rig.position.set(
      0.20 + this.swayX + Math.cos(this.bob) * 0.012 * bobAmt + this.reloadPose * 0.03 + sp * 0.06,
      -0.19 + this.swayY + Math.sin(this.bob * 2) * 0.014 * bobAmt - this.reloadPose * 0.16 - switchDip - sp * 0.09,
      -0.42 + this.recoilZ * 0.55 + this.reloadPose * 0.05 + sp * 0.1
    );
    this.rig.rotation.set(
      this.recoilRot * 0.5 + this.reloadPose * 0.55 + sp * 0.22,
      this.swayX * 2.2 - this.reloadPose * 0.18 + sp * 0.55,
      this.swayY * 1.4 + this.reloadPose * 0.3 + sp * 0.2
    );
  }

  /** Accuracy as a percentage, or null if nothing has been fired yet. */
  get accuracy() {
    if (this.shotsFired === 0) return null;
    return (this.shotsHit / this.shotsFired) * 100;
  }
}
