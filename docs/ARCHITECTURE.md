# Architecture

Notes for whoever picks this up next (probably future-you).

## The frame

`main.js` owns one `requestAnimationFrame` loop:

```
frame(now)
  ├─ dt = clamp(now - last, 0, MAX_FRAME_TIME)
  ├─ if playing:
  │    accumulator += dt
  │    while accumulator >= FIXED_TIMESTEP:   # 1/120 s
  │        step(FIXED_TIMESTEP)
  │    update HUD (once per rendered frame)
  └─ renderer.render(scene, camera)
```

Physics runs on a **fixed 120 Hz timestep** so movement, recoil recovery and
AI speeds are framerate-independent. A `guard` counter caps catch-up iterations
at 20 so a stalled tab cannot spiral into a freeze.

`step(dt)` order matters: player → fire → weapons → enemies → pickups →
wave director → effects. Player first means the AI always reacts to the
position the player actually occupies this tick.

## State machine

`menu → playing ⇄ paused → over → playing`

Losing pointer lock mid-fight **auto-pauses** rather than leaving the player
with a free mouse and no aim. That single decision prevents most of the
"how did I die" reports an FPS gets.

## Hit detection

Everything is a ray. `mathutil.js` has two primitives:

- `rayAABB(origin, dir, min, max, outNormal)` — slab method, returns entry `t` or `-1`
- `raySphere(origin, dir, center, radius)` — returns entry `t` or `-1`

`traceBullet()` in `weapons.js` runs one ray against **every** level box and
**both** spheres of **every** live enemy, keeping the smallest `t`. Nearest hit
wins. No spatial partitioning yet — at 14 enemies × ~60 boxes it is not needed.
If the arena grows, bucket the boxes into a grid first.

Enemies have two spheres each: a torso and a smaller head sphere. That is what
makes headshots possible without a skeletal mesh.

`EnemyManager._fireAt()` uses the exact same primitives against the player's
torso/head spheres and the level. **This is why cover works both ways** — it is
literally the same function with the arguments swapped.

## Collision

The player is an AABB (0.84 × 1.80 m). `Player.moveAxis()` integrates one axis
at a time and resolves penetration, which avoids the corner-catching you get
from resolving all three axes at once.

Two details worth keeping:

- **Coyote time** (0.12 s) — jumping just after walking off a ledge still works.
- **Step-up** (0.45 m) — a blocked horizontal move is retried 0.45 m higher and
  snapped back down. Without it, low crates feel like invisible walls.

## Recoil

Recoil is stored as `recoilPitch` / `recoilYaw` **separate** from the player's
`pitch` / `yaw`, and decays with `damp()` toward zero every frame. The camera
renders `pitch + recoilPitch`. Adding recoil directly to the aim angle is the
classic mistake — it makes recoil permanent and the gun drifts upward forever.

## Allocation discipline

Nothing in the hot path allocates. Managers hold scratch `Vector3`s as fields
(`this._wish`, `this._probe`, `this._toPlayer`, …) and reuse them.

**Watch out:** scratch vectors alias. `_blocked()` overwrites `this._probe`
with its ray origin, so obstacle avoidance must use a *different* scratch
vector (`this._alt`). Reusing the same one silently corrupts the avoidance
direction. This bug existed once and cost 20 minutes.

Similarly, avoid flipping `material.transparent` per frame — it forces a shader
recompile. Corpses sink into the floor instead of fading for exactly this reason.

## Waves

`updateWaves()` is the director:

1. Drip-feed `spawnQueue` at ~3.6 bots/s, capped at `MAX_ENEMIES_ALIVE` so a
   20-bot wave does not all pop in on one frame.
2. When `intermission > 0`, count it down, then `beginWave()`.
3. When the queue is empty and nothing is alive, award the wave bonus and start
   the next intermission.

`pickEnemyType()` is exported from `enemies.js` and used by the director too,
so there is exactly **one** archetype distribution in the codebase.

## Effects pooling

`Pool` hands out the next inactive item, or recycles the oldest if every item
is busy. Tracers (90), particles (220), casings (40), rings (24), bullet holes (48).

Bullet holes live 14 s and fade over the last 3 — long enough to read the
gunfight, short enough that the arena does not fill with decals.

## Audio

`audio.js` builds everything from three primitives: `_burst` (noise through a
sweeping lowpass), `_thump` (pitch-dropping sine), `_blip` (short oscillator).
Every effect is a layered combination.

`AudioContext` cannot be created before a user gesture, so `audio.init()` is
called from the first click and is safe to call repeatedly. Construction is
wrapped in try/catch — **audio failure must never stop the game.**

World sounds get quadratic distance attenuation; the player's own gun does not.

## Where to change things

| I want to… | Edit |
| --- | --- |
| Rebalance any weapon | `config.js` → `WEAPONS` |
| Add a weapon | `config.js` → `WEAPONS`, plus a branch in `buildGunMesh()` |
| Add an enemy class | `config.js` → `ENEMY_TYPES` (nothing else) |
| Change the map | `world.js` → `BUILD` section |
| Change difficulty curve | `config.js` → `GAME.WAVE` |
| Restyle the HUD | `css/style.css` |
| Upgrade three.js | drop a new file in `vendor/`, update `js/three.js` |
