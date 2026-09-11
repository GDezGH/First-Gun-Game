/**
 * effects.js — pooled visual effects: tracers, impacts, blood, muzzle
 * flash, shell casings and hit sparks.
 *
 * Everything is pooled. A busy firefight can spawn several hundred
 * effects a second, and allocating a new Mesh for each one would
 * thrash the garbage collector and stutter the frame rate.
 */

import * as THREE from './three.js';

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();

class Pool {
  constructor(scene, count, make) {
    this.items = [];
    for (let i = 0; i < count; i++) {
      const obj = make();
      obj.visible = false;
      scene.add(obj.object);
      this.items.push(obj);
    }
    this.cursor = 0;
  }

  /** Grab the next free item, recycling the oldest if all are busy. */
  next() {
    for (let i = 0; i < this.items.length; i++) {
      const idx = (this.cursor + i) % this.items.length;
      if (!this.items[idx].active) {
        this.cursor = (idx + 1) % this.items.length;
        return this.items[idx];
      }
    }
    this.cursor = (this.cursor + 1) % this.items.length;
    return this.items[this.cursor];
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // --- tracers -------------------------------------------------------
    const tracerGeo = new THREE.CylinderGeometry(0.018, 0.006, 1, 5, 1, true);
    this.tracers = new Pool(scene, 90, () => ({
      active: false,
      life: 0,
      maxLife: 0,
      object: new THREE.Mesh(
        tracerGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd27a,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      ),
    }));

    // --- particles (sparks, blood, dust) --------------------------------
    const sparkGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
    this.particles = new Pool(scene, 220, () => ({
      active: false,
      life: 0,
      maxLife: 0,
      vel: new THREE.Vector3(),
      gravity: 0,
      object: new THREE.Mesh(
        sparkGeo,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false })
      ),
    }));

    // --- shell casings ---------------------------------------------------
    const caseGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.062, 6);
    const caseMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.35, metalness: 0.9 });
    this.casings = new Pool(scene, 40, () => ({
      active: false,
      life: 0,
      maxLife: 0,
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      object: new THREE.Mesh(caseGeo, caseMat),
    }));

    // --- muzzle flash light (shared, just pulsed) --------------------------
    this.flashLight = new THREE.PointLight(0xffb060, 0, 16, 2);
    this.flashLight.visible = false;
    scene.add(this.flashLight);

    // --- muzzle flash sprite ------------------------------------------------
    this.flashMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffcc88,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      })
    );
    this.flashMesh.visible = false;
    scene.add(this.flashMesh);
    this.flashLife = 0;

    // --- impact ring -----------------------------------------------------------
    const ringGeo = new THREE.RingGeometry(0.06, 0.16, 14);
    this.rings = new Pool(scene, 24, () => ({
      active: false,
      life: 0,
      maxLife: 0,
      object: new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd9a0,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        })
      ),
    }));

    // --- bullet holes (decals), recycled after a while -------------------------
    const holeGeo = new THREE.CircleGeometry(0.055, 8);
    this.holes = new Pool(scene, 48, () => ({
      active: false,
      life: 0,
      maxLife: 0,
      object: new THREE.Mesh(
        holeGeo,
        new THREE.MeshBasicMaterial({
          color: 0x0a0a0a,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        })
      ),
    }));
  }

  // ------------------------------------------------------------------
  // Spawners
  // ------------------------------------------------------------------

  tracer(from, to, color = 0xffd27a) {
    _dir.subVectors(to, from);
    const len = _dir.length();
    if (len < 0.05) return;
    _dir.divideScalar(len);

    const t = this.tracers.next();
    t.active = true;
    t.life = t.maxLife = 0.075;
    t.object.visible = true;
    t.object.material.color.setHex(color);
    t.object.material.opacity = 1;

    _mid.copy(from).addScaledVector(_dir, len / 2);
    t.object.position.copy(_mid);
    _q.setFromUnitVectors(UP, _dir);
    t.object.quaternion.copy(_q);
    t.object.scale.set(1, len, 1);
  }

  /** Bright spark burst where a bullet hit the world. */
  impact(point, normal) {
    const n = normal || UP;
    for (let i = 0; i < 7; i++) {
      const p = this.particles.next();
      p.active = true;
      p.life = p.maxLife = 0.28 + Math.random() * 0.25;
      p.gravity = 14;
      p.object.visible = true;
      p.object.material.color.setHex(i % 3 === 0 ? 0xfff0c0 : 0xff9a3c);
      p.object.position.copy(point);
      p.vel.copy(n).multiplyScalar(1.5 + Math.random() * 2.5);
      p.vel.x += (Math.random() - 0.5) * 3.5;
      p.vel.y += (Math.random() - 0.5) * 3.5;
      p.vel.z += (Math.random() - 0.5) * 3.5;
      p.object.scale.setScalar(0.6 + Math.random() * 0.7);
    }

    // Flash ring facing away from the surface.
    const r = this.rings.next();
    r.active = true;
    r.life = r.maxLife = 0.16;
    r.object.visible = true;
    r.object.material.opacity = 1;
    r.object.position.copy(point).addScaledVector(n, 0.012);
    _q.setFromUnitVectors(UP, n);
    r.object.quaternion.copy(_q);
    r.object.scale.setScalar(1);

    // Decal.
    const h = this.holes.next();
    h.active = true;
    h.life = h.maxLife = 14;
    h.object.visible = true;
    h.object.material.opacity = 0.9;
    h.object.position.copy(point).addScaledVector(n, 0.014);
    _q.setFromUnitVectors(UP, n);
    h.object.quaternion.copy(_q);
  }

  /** Dark red burst for hitting flesh. */
  blood(point, dir) {
    for (let i = 0; i < 9; i++) {
      const p = this.particles.next();
      p.active = true;
      p.life = p.maxLife = 0.35 + Math.random() * 0.3;
      p.gravity = 18;
      p.object.visible = true;
      p.object.material.color.setHex(i % 4 === 0 ? 0xff3b30 : 0x8e1410);
      p.object.position.copy(point);
      p.vel.copy(dir).multiplyScalar(1.2 + Math.random() * 2.2);
      p.vel.x += (Math.random() - 0.5) * 3;
      p.vel.y += (Math.random() - 0.5) * 3;
      p.vel.z += (Math.random() - 0.5) * 3;
      p.object.scale.setScalar(0.7 + Math.random() * 0.9);
    }
  }

  muzzleFlash(position, dir, scale = 1) {
    this.flashLife = 0.055;
    this.flashMesh.visible = true;
    this.flashMesh.position.copy(position).addScaledVector(dir, 0.05);
    this.flashMesh.lookAt(_v.copy(position).addScaledVector(dir, 5));
    this.flashMesh.scale.setScalar((0.34 + Math.random() * 0.16) * scale);
    this.flashMesh.material.opacity = 0.95;
    this.flashMesh.rotateZ(Math.random() * Math.PI);

    this.flashLight.visible = true;
    this.flashLight.position.copy(position);
    this.flashLight.intensity = 26 * scale;
  }

  /** Eject a spent casing to the shooter's right. */
  shellCasing(muzzlePos, player) {
    const c = this.casings.next();
    c.active = true;
    c.life = c.maxLife = 4.5;
    c.object.visible = true;
    c.object.position.copy(muzzlePos);

    // Right vector of the player's view.
    const yaw = player.yaw;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    c.vel.set(
      rx * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5,
      1.9 + Math.random() * 0.9,
      rz * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5
    );
    c.spin.set(
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22
    );
  }

  /** Generic burst used for explosions, pickups and enemy deaths. */
  burst(point, color, count = 16, speed = 4, gravity = 12) {
    for (let i = 0; i < count; i++) {
      const p = this.particles.next();
      p.active = true;
      p.life = p.maxLife = 0.4 + Math.random() * 0.5;
      p.gravity = gravity;
      p.object.visible = true;
      p.object.material.color.setHex(color);
      p.object.position.copy(point);
      p.vel.set(
        (Math.random() - 0.5) * 2,
        Math.random() * 0.8,
        (Math.random() - 0.5) * 2
      ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      p.object.scale.setScalar(0.6 + Math.random() * 1.1);
    }
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  update(dt, camera) {
    // Tracers
    for (const t of this.tracers.items) {
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) { t.active = false; t.object.visible = false; continue; }
      t.object.material.opacity = t.life / t.maxLife;
      t.object.scale.x = t.object.scale.z = 0.4 + (t.life / t.maxLife) * 0.6;
    }

    // Particles
    for (const p of this.particles.items) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; p.object.visible = false; continue; }
      p.vel.y -= p.gravity * dt;
      p.object.position.addScaledVector(p.vel, dt);
      if (p.object.position.y < 0.03) {
        p.object.position.y = 0.03;
        p.vel.y *= -0.32;
        p.vel.x *= 0.7;
        p.vel.z *= 0.7;
      }
      p.object.material.opacity = Math.min(1, p.life / p.maxLife * 1.6);
      p.object.rotation.x += dt * 6;
      p.object.rotation.y += dt * 5;
    }

    // Casings
    for (const c of this.casings.items) {
      if (!c.active) continue;
      c.life -= dt;
      if (c.life <= 0) { c.active = false; c.object.visible = false; continue; }
      c.vel.y -= 22 * dt;
      c.object.position.addScaledVector(c.vel, dt);
      if (c.object.position.y < 0.03) {
        c.object.position.y = 0.03;
        c.vel.y *= -0.34;
        c.vel.x *= 0.55;
        c.vel.z *= 0.55;
        c.spin.multiplyScalar(0.5);
      }
      c.object.rotation.x += c.spin.x * dt;
      c.object.rotation.y += c.spin.y * dt;
      c.object.rotation.z += c.spin.z * dt;
      if (c.life < 0.5) c.object.visible = ((c.life * 8) | 0) % 2 === 0;
    }

    // Rings
    for (const r of this.rings.items) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) { r.active = false; r.object.visible = false; continue; }
      const k = 1 - r.life / r.maxLife;
      r.object.scale.setScalar(1 + k * 3.2);
      r.object.material.opacity = (1 - k) * 0.9;
    }

    // Bullet holes fade out over their lifetime.
    for (const h of this.holes.items) {
      if (!h.active) continue;
      h.life -= dt;
      if (h.life <= 0) { h.active = false; h.object.visible = false; continue; }
      h.object.material.opacity = Math.min(0.9, h.life / 3);
    }

    // Muzzle flash
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = Math.max(0, this.flashLife / 0.055);
      this.flashMesh.material.opacity = k * 0.95;
      this.flashLight.intensity = 26 * k;
      if (this.flashLife <= 0) {
        this.flashMesh.visible = false;
        this.flashLight.visible = false;
      }
    }
  }

  /** Clear every effect (used when a run restarts). */
  clear() {
    for (const group of [this.tracers, this.particles, this.casings, this.rings, this.holes]) {
      for (const it of group.items) { it.active = false; it.object.visible = false; }
    }
    this.flashLife = 0;
    this.flashMesh.visible = false;
    this.flashLight.visible = false;
  }
}
