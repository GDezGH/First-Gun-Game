/**
 * player.js — first-person controller.
 *
 * Responsibilities:
 *   - mouse look with separate recoil offsets that recover over time
 *   - AABB movement with ground snapping and step-up
 *   - gravity, jumping, sprinting, head bob, footstep cadence
 *   - health / armor and damage response
 *
 * `pos` is the position of the player's FEET. The camera sits at
 * `pos.y + EYE_HEIGHT` plus bob and shake offsets.
 */

import * as THREE from './three.js';
import { GAME } from './config.js';
import { audio } from './audio.js';
import { clamp, damp } from './mathutil.js';

const P = GAME.PLAYER;

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;

    this.pos = new THREE.Vector3(P.SPAWN.x, 0, P.SPAWN.z);
    this.vel = new THREE.Vector3();

    this.yaw = 0;
    this.pitch = 0;

    // Recoil is tracked separately from the player's aim so it can recover
    // smoothly without fighting mouse input.
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this.shakeAmp = 0;
    this.shakeTime = 0;

    this.grounded = false;
    this.wasGrounded = false;
    this.coyoteTime = 0;
    this.landImpact = 0;

    this.health = P.MAX_HEALTH;
    this.armor = 0;
    this.lastDamageTime = -999;
    this.alive = true;

    this.bobPhase = 0;
    this.stepAccum = 0;
    this.sensitivity = 1;

    /** Set for a few frames after firing, used to widen the reticle. */
    this.fireKick = 0;

    // Scratch objects reused every frame (no per-frame allocation).
    this._boxMin = new THREE.Vector3();
    this._boxMax = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._desired = new THREE.Vector3();
  }

  reset() {
    this.pos.set(P.SPAWN.x, 0, P.SPAWN.z);
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.health = P.MAX_HEALTH;
    this.armor = 0;
    this.alive = true;
    this.shakeAmp = 0;
    this.fireKick = 0;
    this.landImpact = 0;

    // The spawn point is on flat ground, so start grounded. Leaving this
    // false meant coyoteTime was still 0 on the first frame and the player
    // could not jump until gravity had re-detected the floor.
    this.grounded = true;
    this.wasGrounded = true;
    this.coyoteTime = 0.12;
  }

  get eyeHeight() { return P.EYE_HEIGHT; }

  eyePosition(out = this._eye) {
    return out.set(this.pos.x, this.pos.y + P.EYE_HEIGHT, this.pos.z);
  }

  /** Current aim direction including recoil recovery offsets. */
  aimDirection(out = this._dir) {
    const cp = Math.cos(this.pitch + this.recoilPitch);
    return out.set(
      -Math.sin(this.yaw + this.recoilYaw) * cp,
      Math.sin(this.pitch + this.recoilPitch),
      -Math.cos(this.yaw + this.recoilYaw) * cp
    ).normalize();
  }

  /** Apply a mouse movement (already scaled by sensitivity). */
  look(dx, dy) {
    this.yaw -= dx;
    this.pitch -= dy;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  }

  /** Kick the camera. Vertical is deterministic; horizontal is randomised. */
  addRecoil(verticalDeg, horizontalDeg) {
    const v = THREE.MathUtils.degToRad(verticalDeg);
    const h = THREE.MathUtils.degToRad(horizontalDeg);
    this.recoilPitch += v;
    this.recoilYaw += (Math.random() * 2 - 1) * h;
    // Never let recoil push the view past straight up.
    if (this.pitch + this.recoilPitch > Math.PI / 2 - 0.001) {
      this.recoilPitch = Math.PI / 2 - 0.001 - this.pitch;
    }
    this.fireKick = 1;
  }

  addShake(amount) {
    this.shakeAmp = Math.min(1.2, this.shakeAmp + amount);
  }

  // ------------------------------------------------------------------
  // Damage
  // ------------------------------------------------------------------

  /**
   * @returns {number} health actually lost (0 if armor absorbed everything)
   */
  damage(amount, now, sourcePos) {
    if (!this.alive) return 0;

    let toArmor = 0;
    if (this.armor > 0) {
      toArmor = Math.min(this.armor, amount * P.ARMOR_ABSORB);
      this.armor -= toArmor;
    }
    const toHealth = amount - toArmor;
    this.health = Math.max(0, this.health - toHealth);
    this.lastDamageTime = now;

    this.addShake(GAME.SHAKE.DAMAGE * (0.5 + amount / 40));
    if (this.health <= 0) this.alive = false;
    return toHealth;
  }

  heal(amount) {
    this.health = Math.min(P.MAX_HEALTH, this.health + amount);
  }

  addArmor(amount) {
    this.armor = Math.min(P.MAX_ARMOR, this.armor + amount);
  }

  // ------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------

  update(dt, input, now) {
    // --- wish direction from input, in world space -------------------
    const forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera looks down -Z at yaw 0, so forward is (-sin, 0, -cos).
    this._wish.set(
      (-sin * forward) + (cos * strafe),
      0,
      (-cos * forward) + (-sin * strafe)
    );
    if (this._wish.lengthSq() > 0) this._wish.normalize();

    const wantSprint = input.sprint && forward > 0 && this.grounded;
    const targetSpeed = wantSprint ? P.SPRINT_SPEED : P.WALK_SPEED;

    // --- accelerate / friction --------------------------------------
    // Airborne momentum: if we are already travelling faster than the
    // current target (e.g. we sprint-jumped), hold that speed instead of
    // bleeding back down to walk speed. In the air you steer, you do not
    // brake -- otherwise jumping while sprinting silently kills momentum.
    const flatSpeed = Math.hypot(this.vel.x, this.vel.z);
    const desiredSpeed = (!this.grounded && flatSpeed > targetSpeed) ? flatSpeed : targetSpeed;

    const accel = this.grounded ? P.ACCEL_GROUND : P.ACCEL_AIR;
    // NOTE: copy before scaling. multiplyScalar() mutates in place, and
    // _wish is read again below for the friction test.
    const desired = this._desired.copy(this._wish).multiplyScalar(desiredSpeed);
    const hasInput = this._wish.lengthSq() > 0;

    const k = Math.min(1, accel * dt / Math.max(targetSpeed, 1));
    this.vel.x += (desired.x - this.vel.x) * k;
    this.vel.z += (desired.z - this.vel.z) * k;

    if (this.grounded && !hasInput) {
      const drop = Math.max(this.vel.length(), P.WALK_SPEED) * P.FRICTION_GROUND * dt;
      const len = this.vel.length();
      if (len > 0) {
        const scale = Math.max(0, len - drop) / len;
        this.vel.x *= scale;
        this.vel.z *= scale;
      }
    }

    // --- jump ---------------------------------------------------------
    this.coyoteTime = this.grounded ? 0.12 : Math.max(0, this.coyoteTime - dt);
    if (input.jump && this.coyoteTime > 0) {
      this.vel.y = P.JUMP_VELOCITY;
      this.grounded = false;
      this.coyoteTime = 0;
      audio.jump();
    }

    // --- gravity ------------------------------------------------------
    this.vel.y -= GAME.GRAVITY * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    // --- integrate + collide ------------------------------------------
    this.wasGrounded = this.grounded;
    this.grounded = false;

    this.moveAxis('y', this.vel.y * dt);
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);

    // Landing feedback.
    if (this.grounded && !this.wasGrounded) {
      audio.land(this.landImpact > 12);
    }

    // Keep the player inside the arena even if a collision is missed.
    const lim = GAME.ARENA_RADIUS - 1;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
    if (this.pos.y < 0) { this.pos.y = 0; this.vel.y = 0; this.grounded = true; }

    // --- recoil recovery ----------------------------------------------
    const rec = input.recovery ?? 9;
    this.recoilPitch = damp(this.recoilPitch, 0, rec, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, rec, dt);
    this.fireKick = Math.max(0, this.fireKick - dt * 5.5);

    // --- health regen ---------------------------------------------------
    if (this.alive && now - this.lastDamageTime > P.REGEN_DELAY && this.health < P.MAX_HEALTH) {
      this.health = Math.min(P.MAX_HEALTH, this.health + P.REGEN_RATE * dt);
    }

    // --- head bob + footsteps -------------------------------------------
    // Recomputed AFTER integration: this is the speed we actually achieved.
    const travelSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && travelSpeed > 0.6) {
      const rate = input.sprint ? 13 : 9;
      this.bobPhase += dt * rate;
      this.stepAccum += travelSpeed * dt;
      if (this.stepAccum > 2.3) {
        this.stepAccum = 0;
        audio.footstep();
      }
    } else {
      this.bobPhase += dt * 1.5;
    }

    // --- write to camera ---------------------------------------------------
    this.shakeAmp = Math.max(0, this.shakeAmp - GAME.SHAKE.DECAY * dt * this.shakeAmp - dt * 0.4);
    this.shakeTime += dt * 40;
    const s = this.shakeAmp;
    const shakeP = Math.sin(this.shakeTime * 1.7) * 0.02 * s;
    const shakeY = Math.sin(this.shakeTime * 1.31 + 1.1) * 0.02 * s;
    const shakeR = Math.sin(this.shakeTime * 2.13 + 2.2) * 0.026 * s;

    const bobAmount = this.grounded ? Math.min(travelSpeed / P.SPRINT_SPEED, 1) : 0;
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.035 * bobAmount;

    this.camera.position.set(
      this.pos.x + Math.cos(this.yaw) * bobX,
      this.pos.y + P.EYE_HEIGHT + bobY,
      this.pos.z - Math.sin(this.yaw) * bobX
    );
    this.camera.rotation.set(
      this.pitch + this.recoilPitch + shakeP,
      this.yaw + this.recoilYaw + shakeY,
      shakeR + Math.cos(this.bobPhase) * 0.004 * bobAmount,
      'YXZ'
    );

    return this.alive;
  }

  // ------------------------------------------------------------------
  // Collision
  // ------------------------------------------------------------------

  /** Fill the scratch AABB for the player at the current position. */
  _bounds() {
    this._boxMin.set(this.pos.x - P.RADIUS, this.pos.y, this.pos.z - P.RADIUS);
    this._boxMax.set(this.pos.x + P.RADIUS, this.pos.y + P.HEIGHT, this.pos.z + P.RADIUS);
  }

  _intersects(c) {
    return (
      this._boxMin.x < c.max.x && this._boxMax.x > c.min.x &&
      this._boxMin.y < c.max.y && this._boxMax.y > c.min.y &&
      this._boxMin.z < c.max.z && this._boxMax.z > c.min.z
    );
  }

  /**
   * Move along one axis and resolve penetration.
   * Vertical moves set `grounded`; horizontal moves attempt a step-up
   * so low cover does not feel like an invisible wall.
   */
  moveAxis(axis, amount) {
    if (amount === 0) {
      // Still need to detect ground when standing still.
      if (axis === 'y') this._probeGround();
      return;
    }

    const before = this.pos[axis];
    this.pos[axis] += amount;
    this._bounds();

    const colliders = this.world.colliders;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!this._intersects(c)) continue;

      if (axis === 'y') {
        if (amount < 0) {
          this.pos.y = c.max.y;
          this.landImpact = -this.vel.y;
          this.vel.y = 0;
          this.grounded = true;
        } else {
          this.pos.y = c.min.y - P.HEIGHT;
          this.vel.y = 0;
        }
        this._bounds();
      } else {
        // Try stepping over low obstacles before giving up.
        if (this.grounded && this._tryStepUp(axis, amount)) {
          this._bounds();
          continue;
        }
        this.pos[axis] = before;
        this.vel[axis] = 0;
        this._bounds();
        break;
      }
    }

    if (axis === 'y' && !this.grounded && amount < 0) this._probeGround();
  }

  /** Nudge upward by the step height and see whether the move clears. */
  _tryStepUp(axis, amount) {
    const STEP = 0.45;
    const savedY = this.pos.y;
    this.pos.y += STEP;
    this._bounds();

    let clear = true;
    for (let i = 0; i < this.world.colliders.length; i++) {
      const c = this.world.colliders[i];
      if (c.max.y <= savedY + 0.05) continue;      // not a real obstacle
      if (this._intersects(c)) { clear = false; break; }
    }
    if (!clear) {
      this.pos.y = savedY;
      this._bounds();
      return false;
    }

    // Snap down onto whatever we stepped onto.
    const targetY = this.pos.y;
    for (let drop = 0; drop <= STEP; drop += 0.05) {
      this.pos.y = targetY - drop;
      this._bounds();
      let hit = null;
      for (let i = 0; i < this.world.colliders.length; i++) {
        const c = this.world.colliders[i];
        if (c.max.y > savedY + 0.05 && c.max.y <= targetY + 0.01 && this._intersects(c)) { hit = c; break; }
      }
      if (hit) { this.pos.y = hit.max.y; this.grounded = true; break; }
    }
    this._bounds();
    return true;
  }

  /** Ground check used when the player is stationary. */
  _probeGround() {
    this._bounds();
    const probe = {
      min: new THREE.Vector3(this._boxMin.x, this.pos.y - 0.06, this._boxMin.z),
      max: new THREE.Vector3(this._boxMax.x, this.pos.y + 0.02, this._boxMax.z),
    };
    for (let i = 0; i < this.world.colliders.length; i++) {
      const c = this.world.colliders[i];
      if (
        probe.min.x < c.max.x && probe.max.x > c.min.x &&
        probe.min.y < c.max.y && probe.max.y > c.min.y &&
        probe.min.z < c.max.z && probe.max.z > c.min.z
      ) {
        this.grounded = true;
        this.pos.y = c.max.y;
        this._bounds();
        return;
      }
    }
  }
}
