/**
 * enemies.js — hostile bots.
 *
 * Each bot is a small state machine:
 *   SPAWN  -> materialises, cannot act
 *   CHASE  -> closes to its preferred engagement range
 *   ATTACK -> fires when it has line of sight, on a cooldown
 *   DEAD   -> topples, fades, then is recycled
 *
 * Enemies use the same hit-scan rules as the player, which means cover
 * genuinely works in both directions: a bullet that hits a crate first
 * never reaches you.
 */

import * as THREE from './three.js';
import { ENEMY_TYPES, GAME } from './config.js';
import { audio } from './audio.js';
import { rayAABB, raySphere, clamp, flatDistance } from './mathutil.js';

const TYPE_KEYS = Object.keys(ENEMY_TYPES);

/** Weighted random archetype, loosened by wave number. Exported so the
 *  wave director in main.js uses exactly the same distribution. */
export function pickEnemyType(wave, rng = Math.random) {
  let total = 0;
  const weights = TYPE_KEYS.map((k) => {
    let w = ENEMY_TYPES[k].spawnWeight;
    // Heavies and snipers start showing up from wave 2, then get common.
    if (k === 'heavy' && wave < 2) w = 0;
    if (k === 'sniper' && wave < 2) w = 0;
    if (k === 'heavy') w += Math.min(3, (wave - 2) * 0.6);
    if (k === 'sniper') w += Math.min(3, (wave - 2) * 0.5);
    if (k === 'runner') w += Math.min(3, (wave - 3) * 0.4);
    total += w;
    return w;
  });
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return ENEMY_TYPES[TYPE_KEYS[i]];
  }
  return ENEMY_TYPES.grunt;
}

class Enemy {
  constructor(type, position, wave) {
    this.type = type;
    this.wave = wave;
    this.alive = true;
    this.removed = false;

    const scale = type.id === 'heavy' ? 1.18 : type.id === 'runner' ? 0.9 : 1.0;
    this.scale = scale;
    this.height = type.height * scale;

    this.maxHealth = Math.round(type.health * (1 + (wave - 1) * GAME.WAVE.HEALTH_SCALE));
    this.health = this.maxHealth;
    this.speed = type.speed * (1 + (wave - 1) * GAME.WAVE.SPEED_SCALE);
    this.damage = type.damage * (1 + (wave - 1) * GAME.WAVE.DAMAGE_SCALE);
    this.fireInterval = type.fireInterval;

    this.pos = position.clone();
    this.pos.y = 0;
    this.vel = new THREE.Vector3();
    this.facing = 0;

    this.state = 'spawn';
    this.stateTimer = 0.7;
    this.fireCooldown = 0.6 + Math.random() * 0.9;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 2;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.hitFlash = 0;
    this.deathTimer = 0;
    this.aimCharge = 0;

    // Hit volumes queried by traceBullet().
    this.headCenter = new THREE.Vector3();
    this.bodyCenter = new THREE.Vector3();
    this.headRadius = 0.27 * scale;
    this.bodyRadius = 0.5 * scale;

    this.group = new THREE.Group();
    this.group.position.copy(this.pos);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: type.bodyColor, roughness: 0.62, metalness: 0.28,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.7, metalness: 0.4 });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: type.eyeColor, emissive: type.eyeColor, emissiveIntensity: 2.2, roughness: 0.3,
    });

    this.bodyMat = bodyMat;
    this.eyeMat = eyeMat;

    // Torso
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.36 * scale, this.height * 0.44, 4, 10),
      bodyMat
    );
    torso.position.y = this.height * 0.52;
    torso.castShadow = true;
    this.group.add(torso);
    this.torso = torso;

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26 * scale, 14, 10), bodyMat);
    head.position.y = this.height - 0.16 * scale;
    head.castShadow = true;
    this.group.add(head);

    // Visor / eyes
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.30 * scale, 0.075 * scale, 0.06 * scale), eyeMat);
    visor.position.set(0, this.height - 0.17 * scale, 0.22 * scale);
    this.group.add(visor);
    this.visor = visor;

    // Shoulders + arms
    [-1, 1].forEach((s) => {
      const arm = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.085 * scale, 0.42 * scale, 3, 7),
        darkMat
      );
      arm.position.set(s * 0.42 * scale, this.height * 0.58, 0.06 * scale);
      arm.rotation.x = -0.55;
      arm.castShadow = true;
      this.group.add(arm);
    });

    // Weapon
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1 * scale, 0.11 * scale, 0.62 * scale), darkMat);
    gun.position.set(0.16 * scale, this.height * 0.55, 0.42 * scale);
    gun.castShadow = true;
    this.group.add(gun);

    // Legs
    this.legs = [];
    [-1, 1].forEach((s) => {
      const leg = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.105 * scale, 0.42 * scale, 3, 7),
        darkMat
      );
      leg.position.set(s * 0.17 * scale, this.height * 0.24, 0);
      leg.castShadow = true;
      this.group.add(leg);
      this.legs.push(leg);
    });

    this.group.scale.setScalar(0.001);   // grows in during SPAWN
  }

  get healthFraction() { return this.health / this.maxHealth; }

  /** Refresh the two spheres bullets are tested against. */
  syncHitVolumes() {
    this.headCenter.set(this.pos.x, this.pos.y + this.height - 0.16 * this.scale, this.pos.z);
    this.bodyCenter.set(this.pos.x, this.pos.y + this.height * 0.52, this.pos.z);
  }

  /** Muzzle position, for tracers and sound placement. */
  muzzleWorld(out) {
    return out.set(
      this.pos.x + Math.sin(this.facing) * 0.5,
      this.pos.y + this.height * 0.55,
      this.pos.z + Math.cos(this.facing) * 0.5
    );
  }
}

export class EnemyManager {
  constructor(scene) {
    this.scene = scene;
    /** @type {Enemy[]} */
    this.list = [];
    this.rng = Math.random;
    this.killedThisRun = 0;

    // Scratch vectors (no per-frame allocation).
    this._toPlayer = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._alt = new THREE.Vector3();
    this._pBody = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._shotDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._eyeTarget = new THREE.Vector3();
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  clear() {
    for (const e of this.list) {
      this.scene.remove(e.group);
      this._disposeGroup(e.group);
    }
    this.list.length = 0;
    this.killedThisRun = 0;
  }

  _disposeGroup(group) {
    group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }

  /** Spawn one bot at `position`. */
  spawn(type, position, wave) {
    const e = new Enemy(type, position, wave);
    e.syncHitVolumes();
    this.scene.add(e.group);
    this.list.push(e);
    return e;
  }

  /** Spawn a full wave. Returns the enemies created. */
  spawnWave(wave, world, playerPos, count) {
    const created = [];
    for (let i = 0; i < count; i++) {
      const type = pickEnemyType(wave, this.rng);
      const p = world.pickSpawn(playerPos, GAME.WAVE.SPAWN_MARGIN);
      // Small jitter so a group does not stack on one point.
      p.x += (this.rng() - 0.5) * 4;
      p.z += (this.rng() - 0.5) * 4;
      const e = this.spawn(type, p, wave);
      e.stateTimer = 0.45 + this.rng() * 0.5;
      created.push(e);
    }
    return created;
  }

  /**
   * Apply damage to an enemy.
   * @returns {boolean} true if this hit killed it
   */
  damage(enemy, amount, head, point, dir) {
    if (!enemy.alive) return false;
    // Passive dummies absorb infinite damage but never die, for damage testing.
    if (enemy.type.passive) {
      enemy.health = Math.max(1, enemy.health - amount);
      enemy.hitFlash = 0.12;
      return false;
    }
    enemy.health -= amount;
    enemy.hitFlash = 0.12;
    if (enemy.state === 'spawn') { /* still allowed to be shot */ }

    if (enemy.health <= 0) {
      this.kill(enemy, head, dir);
      return true;
    }
    return false;
  }

  kill(enemy, head, dir) {
    enemy.alive = false;
    enemy.state = 'dead';
    enemy.deathTimer = 0;
    this.killedThisRun++;

    const colour = enemy.type.bodyColor;
    this._probe.set(enemy.pos.x, enemy.pos.y + enemy.height * 0.5, enemy.pos.z);
    if (pointBurst) pointBurst(this._probe, colour, head ? 26 : 18, 5.5);

    // Topple in the direction of the shot.
    enemy._fallDir = dir ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    audio.impact(this._probe, this._probe, true);
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  /**
   * @param {object} hooks { onPlayerHit(amount, sourcePos), effects, world, player }
   */
  update(dt, player, world, effects, hooks) {
    const now = hooks.now;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];

      // ---------- dead: topple, fade, recycle -------------------------
      if (!e.alive) {
        e.deathTimer += dt;
        const k = Math.min(1, e.deathTimer / 0.5);
        // Rotate around the axis perpendicular to the shot direction so the
        // corpse topples away from the player.
        const axisX = e._fallDir ? e._fallDir.z : 1;
        const axisZ = e._fallDir ? -e._fallDir.x : 0;
        e.group.rotation.set(axisX * k * (Math.PI / 2), e.group.rotation.y, axisZ * k * (Math.PI / 2));
        // Sink into the floor over the last second so it clears the arena.
        const sink = Math.min(1, Math.max(0, (e.deathTimer - 1.3) / 1.0));
        e.group.position.y = e.pos.y - sink * 2.2;
        e.eyeMat.emissiveIntensity = 2.2 * (1 - k);
        if (e.deathTimer > 2.4) {
          this.scene.remove(e.group);
          this._disposeGroup(e.group);
          this.list.splice(i, 1);
        }
        continue;
      }

      // ---------- spawn-in animation -----------------------------------
      if (e.state === 'spawn') {
        e.stateTimer -= dt;
        const k = 1 - Math.max(0, e.stateTimer) / 0.9;
        e.group.scale.setScalar(Math.min(1, 0.001 + k * 1.2));
        e.eyeMat.emissiveIntensity = 2.2 + Math.sin(now * 24) * 1.6;
        e.syncHitVolumes();
        if (e.stateTimer <= 0) {
          e.state = 'chase';
          e.group.scale.setScalar(1);
          e.eyeMat.emissiveIntensity = 2.2;
        }
        continue;
      }

      // ---------- passive targets (dev dummies): idle, no AI -----------
      if (e.type.passive) {
        e.group.position.y = e.pos.y + Math.sin(now * 1.5) * 0.04;
        if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt);
        e.syncHitVolumes();
        continue;
      }

      const dist = flatDistance(e.pos, player.pos);

      // ---------- line of sight ----------------------------------------
      e.muzzleWorld(this._muzzle);
      this._eyeTarget.copy(player.pos).setY(player.pos.y + player.eyeHeight);
      const los = world.hasLineOfSight(this._muzzle, this._eyeTarget);

      // ---------- movement ----------------------------------------------
      this._toPlayer.set(player.pos.x - e.pos.x, 0, player.pos.z - e.pos.z);
      const toDist = this._toPlayer.length() || 1;
      this._toPlayer.divideScalar(toDist);

      // Face the player smoothly.
      const targetFacing = Math.atan2(this._toPlayer.x, this._toPlayer.z);
      let delta = targetFacing - e.facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      e.facing += delta * Math.min(1, dt * 7);

      // Strafe preference flips periodically.
      e.strafeTimer -= dt;
      if (e.strafeTimer <= 0) {
        e.strafeTimer = 1.2 + this.rng() * 2.4;
        e.strafeDir *= -1;
      }

      const range = e.type.preferredRange;
      this._wish.set(0, 0, 0);

      if (dist > range * 1.18) {
        this._wish.copy(this._toPlayer);
      } else if (dist < range * 0.72) {
        this._wish.copy(this._toPlayer).multiplyScalar(-1);
      }
      // Sidestep so bots do not clump into a single file.
      this._wish.x += -this._toPlayer.z * e.strafeDir * 0.75;
      this._wish.z += this._toPlayer.x * e.strafeDir * 0.75;

      // Separation from other bots.
      for (let j = 0; j < this.list.length; j++) {
        const o = this.list[j];
        if (o === e || !o.alive) continue;
        const dx = e.pos.x - o.pos.x;
        const dz = e.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.0001 && d2 < 3.2) {
          const d = Math.sqrt(d2);
          this._wish.x += (dx / d) * (1.6 - d) * 0.9;
          this._wish.z += (dz / d) * (1.6 - d) * 0.9;
        }
      }

      if (this._wish.lengthSq() > 0.0001) {
        this._wish.normalize();
        // Simple obstacle avoidance: if the way ahead is blocked, slide.
        if (this._blocked(world, e.pos, this._wish, 1.6)) {
          const alt = this._alt.set(-this._wish.z, 0, this._wish.x).multiplyScalar(e.strafeDir);
          if (!this._blocked(world, e.pos, alt, 1.6)) {
            this._wish.copy(alt);
          } else {
            this._wish.set(this._wish.z, 0, -this._wish.x).multiplyScalar(e.strafeDir);
          }
        }
      }

      const speedScale = e.state === 'attack' ? 0.35 : 1;
      e.pos.x += this._wish.x * e.speed * speedScale * dt;
      e.pos.z += this._wish.z * e.speed * speedScale * dt;

      // Stay inside the arena.
      const lim = GAME.ARENA_RADIUS - 2;
      e.pos.x = clamp(e.pos.x, -lim, lim);
      e.pos.z = clamp(e.pos.z, -lim, lim);

      e.group.position.set(e.pos.x, e.pos.y, e.pos.z);
      e.group.rotation.y = e.facing;

      // Walk animation.
      const moving = this._wish.lengthSq() > 0.001;
      e.bobPhase += dt * (moving ? e.speed * 2.2 : 1.2);
      const swing = moving ? Math.sin(e.bobPhase * 2.4) * 0.42 : 0;
      e.legs[0].rotation.x = swing;
      e.legs[1].rotation.x = -swing;
      e.group.position.y = e.pos.y + (moving ? Math.abs(Math.sin(e.bobPhase * 2.4)) * 0.05 : 0);

      e.syncHitVolumes();

      // ---------- combat ----------------------------------------------------
      e.fireCooldown -= dt;
      if (los && e.fireCooldown <= 0 && player.alive) {
        this._fireAt(e, player, world, effects, hooks);
        e.fireCooldown = e.fireInterval * (0.75 + this.rng() * 0.6);
      }

      // Sniper laser sight while it has an angle.
      if (e.type.id === 'sniper' && los) {
        e.aimCharge = Math.min(1, e.aimCharge + dt / e.fireInterval);
        e.eyeMat.emissiveIntensity = 2.2 + e.aimCharge * 5;
      } else {
        e.aimCharge = 0;
      }

      // ---------- hit flash -----------------------------------------------
      if (e.hitFlash > 0) {
        e.hitFlash -= dt;
        const f = Math.max(0, e.hitFlash / 0.12);
        e.bodyMat.emissive.setHex(0xffffff);
        e.bodyMat.emissiveIntensity = f * 0.9;
        if (e.hitFlash <= 0) e.bodyMat.emissiveIntensity = 0;
      }
    }
  }

  /** True when a short probe from `from` along `dir` hits the level. */
  _blocked(world, from, dir, dist) {
    const origin = this._probe.set(from.x, from.y + 1.0, from.z);
    for (let i = 0; i < world.colliders.length; i++) {
      const c = world.colliders[i];
      if (c.max.y <= 0.05) continue;              // floor
      if (c.min.y > 1.9) continue;                // overhead stuff
      const t = rayAABB(origin, dir, c.min, c.max, this._normal);
      if (t >= 0 && t < dist) return true;
    }
    return false;
  }

  /** Enemy opens fire on the player using the same hit-scan rules. */
  _fireAt(e, player, world, effects, hooks) {
    const muzzle = e.muzzleWorld(this._muzzle);
    const target = this._eyeTarget.copy(player.pos).setY(player.pos.y + player.eyeHeight);

    this._shotDir.subVectors(target, muzzle);
    const dist = this._shotDir.length();
    if (dist < 0.001) return;
    this._shotDir.divideScalar(dist);

    // Apply the bot's aim cone.
    const cone = e.type.accuracy * (1 + Math.min(0.8, dist / 60));
    this._up.set(0, 1, 0);
    this._right.crossVectors(this._shotDir, this._up).normalize();
    if (this._right.lengthSq() < 0.01) this._right.set(1, 0, 0);
    this._up.crossVectors(this._right, this._shotDir).normalize();

    const a = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * cone;
    this._shotDir
      .addScaledVector(this._right, Math.cos(a) * r)
      .addScaledVector(this._up, Math.sin(a) * r)
      .normalize();

    // Resolve against the player's body/head spheres and the level.
    const playerEye = this._eyeTarget;
    const bodyCenter = this._pBody.set(player.pos.x, player.pos.y + 0.95, player.pos.z);
    let tHit = Infinity;
    let hitPlayer = false;

    const tb = raySphere(muzzle, this._shotDir, bodyCenter, 0.52);
    if (tb >= 0 && tb < tHit) { tHit = tb; hitPlayer = true; }
    const th = raySphere(muzzle, this._shotDir, playerEye, 0.3);
    if (th >= 0 && th < tHit) { tHit = th; hitPlayer = true; }

    for (let i = 0; i < world.colliders.length; i++) {
      const c = world.colliders[i];
      const t = rayAABB(muzzle, this._shotDir, c.min, c.max, this._normal);
      if (t >= 0 && t < tHit) { tHit = t; hitPlayer = false; }
    }

    if (!isFinite(tHit)) tHit = 90;

    const end = new THREE.Vector3().copy(muzzle).addScaledVector(this._shotDir, tHit);
    effects.tracer(muzzle, end, 0xff5a3c);

    audio.enemyShoot(muzzle, playerEye);

    if (hitPlayer && player.alive) {
      const dealt = player.damage(e.damage, hooks.now, muzzle);
      if (dealt > 0) {
        audio.playerHurt();
        hooks.onPlayerHit?.(e.damage, e.pos, dealt);
      }
    } else {
      effects.impact(end, this._normal);
      // Near-miss whistle.
      const closest = end.distanceTo(playerEye);
      if (closest < 3.5 && this.rng() < 0.5) audio.whiz();
    }
  }
}

/**
 * Hook set by main.js so EnemyManager can spawn particles without
 * importing the effects module directly (keeps the dependency graph flat).
 */
export let pointBurst = null;
export function setBurstHandler(fn) { pointBurst = fn; }
