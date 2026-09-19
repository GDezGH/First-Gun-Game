/**
 * pickups.js — health, armor and ammo drops left behind by dead bots.
 *
 * A drop is a spinning emissive shape on the floor. The player collects
 * one by walking within `RADIUS`. Drops despawn after PICKUPS.LIFETIME
 * seconds so the arena never fills with clutter.
 */

import * as THREE from './three.js';
import { PICKUPS } from './config.js';
import { audio } from './audio.js';
import { flatDistance } from './mathutil.js';

const RADIUS = 1.35;

const SHAPES = {
  health: () => new THREE.OctahedronGeometry(0.3, 0),
  armor: () => new THREE.BoxGeometry(0.42, 0.42, 0.18),
  ammo: () => new THREE.CylinderGeometry(0.16, 0.16, 0.36, 8),
};

const COLORS = {
  health: 0x3ddc84,
  armor: 0x4aa8ff,
  ammo: 0xffb020,
};

export class PickupManager {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this._geoCache = {};
    for (const k of Object.keys(SHAPES)) this._geoCache[k] = SHAPES[k]();
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.group);
      it.mesh.material.dispose();
    }
    this.items.length = 0;
  }

  /**
   * Roll drop tables for a freshly killed enemy.
   * @param {string} type 'health' | 'armor' | 'ammo'
   */
  spawn(type, position, weaponReserveMax) {
    const group = new THREE.Group();

    const mat = new THREE.MeshStandardMaterial({
      color: COLORS[type],
      emissive: COLORS[type],
      emissiveIntensity: 0.85,
      roughness: 0.35,
      metalness: 0.4,
    });
    const mesh = new THREE.Mesh(this._geoCache[type], mat);
    mesh.castShadow = false;
    group.add(mesh);

    // Halo ring so drops are visible at a distance.
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.52, 20),
      new THREE.MeshBasicMaterial({
        color: COLORS[type],
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.3;
    group.add(halo);

    group.position.set(position.x, 0.55, position.z);
    this.scene.add(group);

    this.items.push({
      type,
      group,
      mesh,
      halo,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      amount:
        type === 'health' ? PICKUPS.HEALTH_AMOUNT
          : type === 'armor' ? PICKUPS.ARMOR_AMOUNT
            : Math.ceil(weaponReserveMax * PICKUPS.AMMO_FRACTION),
    });
  }

  /** Roll every drop table for one kill. */
  rollFor(position, weaponReserveMax, rng = Math.random) {
    if (rng() < PICKUPS.DROP_HEALTH) this.spawn('health', position, weaponReserveMax);
    if (rng() < PICKUPS.DROP_ARMOR) this.spawn('armor', position, weaponReserveMax);
    if (rng() < PICKUPS.DROP_AMMO) this.spawn('ammo', position, weaponReserveMax);
  }

  /**
   * @returns {Array<{type:string, amount:number}>} what the player collected
   */
  update(dt, player, hooks) {
    const collected = [];

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      it.phase += dt * 2.4;

      it.group.position.y = 0.55 + Math.sin(it.phase) * 0.11;
      it.mesh.rotation.y += dt * 1.9;
      it.mesh.rotation.x += dt * 0.7;
      it.halo.rotation.z += dt * 0.6;

      // Blink out in the final seconds.
      if (it.age > PICKUPS.LIFETIME - 3) {
        const left = PICKUPS.LIFETIME - it.age;
        it.mesh.visible = ((left * 6) | 0) % 2 === 0;
        it.halo.visible = it.mesh.visible;
      }

      if (it.age > PICKUPS.LIFETIME) {
        this._remove(i);
        continue;
      }

      // Collect.
      const d = flatDistance(it.group.position, player.pos);
      const vertical = Math.abs(it.group.position.y - (player.pos.y + 0.6));
      if (d < RADIUS && vertical < 1.9) {
        collected.push({ type: it.type, amount: it.amount });
        audio.pickup(it.type);
        hooks?.onCollect?.(it);
        this._remove(i);
      }
    }

    return collected;
  }

  _remove(i) {
    const it = this.items[i];
    this.scene.remove(it.group);
    it.mesh.material.dispose();
    it.halo.material.dispose();
    this.items.splice(i, 1);
  }
}
