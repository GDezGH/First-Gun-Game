/**
 * mathutil.js — small math helpers used by the simulation.
 *
 * Hit detection is done analytically (ray vs AABB / ray vs sphere) instead
 * of via THREE.Raycaster. It is exact for the primitive shapes the game
 * uses, allocation-free, and fast enough for hundreds of bullets a second.
 */

/** Deterministic PRNG (mulberry32) — same seed always yields the same map. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent smoothing: `rate` is roughly "units per second". */
export function damp(a, b, rate, dt) {
  return lerp(a, b, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current, target, maxDelta) {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}

/**
 * Ray vs axis-aligned bounding box (slab method).
 * Returns the entry distance `t`, or -1 on a miss.
 * Also fills `outNormal` with the face normal when hit.
 */
export function rayAABB(origin, dir, min, max, outNormal) {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = 0;
  let sign = 1;

  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
    const d = i === 0 ? dir.x : i === 1 ? dir.y : dir.z;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;

    if (Math.abs(d) < 1e-8) {
      // Ray parallel to this slab: it must already be inside.
      if (o < lo || o > hi) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }

    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;

    if (tmin > tmax || tmax < 0) return -1;
  }

  if (tmax < 0) return -1;                 // box fully behind the ray
  const t = tmin > 0 ? tmin : 0;           // origin inside the box -> t = 0

  if (outNormal) {
    outNormal.set(0, 0, 0);
    if (axis === 0) outNormal.x = sign;
    else if (axis === 1) outNormal.y = sign;
    else outNormal.z = sign;
  }
  return t;
}

/**
 * Ray vs sphere. Returns the entry distance `t`, or -1 on a miss.
 */
export function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;

  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return -1;           // sphere behind the ray

  const disc = b * b - c;
  if (disc < 0) return -1;

  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Shortest signed angle from `a` to `b`, in radians (-PI..PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Horizontal distance between two Vector3s (ignores Y). */
export function flatDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
