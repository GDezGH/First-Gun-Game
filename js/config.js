/**
 * config.js — every tunable number in the game lives here.
 *
 * Balancing a shooter is 90% tweaking these constants, so they are kept
 * in one file and exported as plain data. Change a number, reload, feel it.
 */

/** Core simulation + presentation settings. */
export const GAME = {
  VERSION: '0.1.0',

  /** Fixed-step physics so movement feels identical at 30 or 240 fps. */
  FIXED_TIMESTEP: 1 / 120,
  MAX_FRAME_TIME: 0.1,        // clamp huge dt (tab switch) to avoid tunneling

  ARENA_RADIUS: 46,           // half-size of the playable floor
  GRAVITY: 26,
  /** No scattered cover may generate within this radius of PLAYER.SPAWN. */
  SPAWN_CLEARANCE: 8,

  PLAYER: {
    EYE_HEIGHT: 1.68,
    RADIUS: 0.42,             // half-width for AABB collision
    HEIGHT: 1.80,
    WALK_SPEED: 5.6,
    SPRINT_SPEED: 8.6,
    AIR_CONTROL: 0.28,
    ACCEL_GROUND: 62,
    ACCEL_AIR: 14,
    FRICTION_GROUND: 12,
    JUMP_VELOCITY: 7.6,
    MAX_HEALTH: 100,
    MAX_ARMOR: 100,
    /** Armor soaks this fraction of incoming damage. */
    ARMOR_ABSORB: 0.55,
    /** Health regeneration kicks in after this many seconds without damage. */
    REGEN_DELAY: 5.0,
    REGEN_RATE: 7.0,          // hp / second
    // Open lane south of the centre platform. (0,0) is INSIDE the platform
    // box, which used to eject the player onto its roof on spawn.
    SPAWN: { x: 0, z: -14 },
  },

  /** Sensitivity is multiplied by this when converting mouse deltas to radians. */
  BASE_MOUSE_SENSITIVITY: 0.0022,

  /** View-feel tuning. Smoothing eases the camera toward the raw aim. */
  VIEW: {
    /** 0 = raw 1:1 mouse, >0 eases the view (recommended 0.6 for softness). */
    smoothing: 0.6,
    /** How quickly the smoothed view catches up (1/s). Higher = snappier. */
    smoothRate: 30,
    /** Head-bob amplitude multiplier (0 disables). */
    bobScale: 1.0,
  },

  WAVE: {
    /** Seconds of breathing room between waves. */
    INTERMISSION: 6.0,
    START_ENEMIES: 4,
    ENEMIES_PER_WAVE: 2.2,    // fractional on purpose; rounded per wave
    MAX_ENEMIES_ALIVE: 14,    // cap so the arena never becomes a lag soup
    SPAWN_MARGIN: 12,         // never spawn closer than this to the player
    HEALTH_SCALE: 0.14,       // per wave
    SPEED_SCALE: 0.035,       // per wave
    DAMAGE_SCALE: 0.06,       // per wave
  },

  SCORE: {
    GRUNT: 100,
    RUNNER: 85,
    HEAVY: 220,
    SNIPER: 180,
    HEADSHOT_MULT: 2,
    WAVE_CLEAR_BONUS: 250,
  },

  /** Camera punch. */
  SHAKE: {
    DAMAGE: 0.34,
    SHOTGUN_FIRE: 0.22,
    RIFLE_FIRE: 0.05,
    DECAY: 7.5,
  },

  STORAGE_KEY: 'first-gun-game.best',
};

/**
 * Weapon table.
 *
 * spreadRads      – half-angle of the bullet cone while standing still.
 * moveSpread      – extra cone added at full sprint speed (radians).
 * recoil          – vertical kick in degrees; `recoilH` is random horizontal.
 * recovery        – how fast the camera settles back after a kick (1/s).
 *
 * Fire modes (`mode`):
 *   'auto'  – holds fire until released / empty.
 *   'semi'  – one shot per trigger pull.
 *   'burst' – fires `burstCount` rounds at `burstRpm` per trigger pull.
 *
 * Aiming down sights (right mouse, hold):
 *   adsFov        – camera FOV while fully aimed (lower = more zoom).
 *   adsSpreadMult – multiplier on spread while aimed (< 1 = tighter).
 *   adsSensMult   – multiplier on mouse sensitivity while aimed.
 *   adsMoveMult   – multiplier on move speed while aimed.
 *   scoped        – true shows the circular scope overlay when aimed.
 */
export const WEAPONS = [
  {
    id: 'rifle',
    slot: 1,
    name: 'AR-15 WORKHORSE',
    shortName: 'RIFLE',
    mode: 'auto',
    damage: 24,
    headshotMult: 2.4,
    rpm: 660,
    auto: true,
    pellets: 1,
    magSize: 30,
    reserveMax: 240,
    startingReserve: 150,
    reloadTime: 1.85,
    spreadRads: 0.010,
    moveSpread: 0.030,
    recoil: 0.75,
    recoilH: 0.28,
    recovery: 9,
    range: 220,
    shake: GAME.SHAKE.RIFLE_FIRE,
    color: 0xffd27a,
    sfx: 'rifle',
    adsFov: 55,
    adsSpreadMult: 0.45,
    adsSensMult: 0.7,
    adsMoveMult: 0.6,
    scoped: false,
  },
  {
    id: 'pistol',
    slot: 2,
    name: 'M9 SIDEARM',
    shortName: 'SIDEARM',
    mode: 'semi',
    damage: 21,
    headshotMult: 2.8,
    rpm: 460,
    auto: false,
    pellets: 1,
    magSize: 14,
    reserveMax: 168,
    startingReserve: 70,
    reloadTime: 1.25,
    spreadRads: 0.005,
    moveSpread: 0.020,
    recoil: 1.15,
    recoilH: 0.4,
    recovery: 11,
    range: 160,
    shake: 0.09,
    color: 0xffe6b0,
    sfx: 'pistol',
    adsFov: 62,
    adsSpreadMult: 0.5,
    adsSensMult: 0.8,
    adsMoveMult: 0.85,
    scoped: false,
  },
  {
    id: 'shotgun',
    slot: 3,
    name: 'SPAS BREACHER',
    shortName: 'BREACHER',
    mode: 'semi',
    damage: 15,                 // per pellet
    headshotMult: 1.8,
    rpm: 85,
    auto: false,
    pellets: 9,
    magSize: 6,
    reserveMax: 48,
    startingReserve: 30,
    reloadTime: 2.5,
    spreadRads: 0.055,
    moveSpread: 0.030,
    recoil: 2.9,
    recoilH: 0.9,
    recovery: 5.5,
    range: 60,
    shake: GAME.SHAKE.SHOTGUN_FIRE,
    color: 0xffb15c,
    sfx: 'shotgun',
    adsFov: 66,
    adsSpreadMult: 0.8,
    adsSensMult: 0.85,
    adsMoveMult: 0.6,
    scoped: false,
  },
  {
    id: 'smg',
    slot: 4,
    name: 'VK-9 HORNET',
    shortName: 'SMG',
    mode: 'auto',
    damage: 13,
    headshotMult: 2.2,
    rpm: 1050,                  // shreds up close, falls off at range
    auto: true,
    pellets: 1,
    magSize: 40,
    reserveMax: 280,
    startingReserve: 160,
    reloadTime: 1.7,
    spreadRads: 0.020,
    moveSpread: 0.022,          // stays usable while mobile
    recoil: 0.5,
    recoilH: 0.55,              // buzzy horizontal climb
    recovery: 10,
    range: 120,
    shake: 0.04,
    color: 0xffe08a,
    sfx: 'smg',
    adsFov: 58,
    adsSpreadMult: 0.4,
    adsSensMult: 0.75,
    adsMoveMult: 0.75,
    scoped: false,
  },
  {
    id: 'dmr',
    slot: 5,
    name: 'M110 MARKSMAN',
    shortName: 'DMR',
    mode: 'semi',
    damage: 70,
    headshotMult: 2.6,
    rpm: 210,
    auto: false,
    pellets: 1,
    magSize: 10,
    reserveMax: 60,
    startingReserve: 40,
    reloadTime: 2.3,
    spreadRads: 0.004,
    moveSpread: 0.05,           // punishing if you shoot on the move
    recoil: 2.2,
    recoilH: 0.3,
    recovery: 7,
    range: 400,
    shake: 0.16,
    color: 0xcfe8ff,
    sfx: 'dmr',
    adsFov: 22,                 // big scope zoom
    adsSpreadMult: 0.12,        // laser-beam when aimed
    adsSensMult: 0.35,
    adsMoveMult: 0.45,
    scoped: true,
  },
  {
    id: 'burst',
    slot: 6,
    name: 'MK-3 TRIAD',
    shortName: 'BURST',
    mode: 'burst',
    burstCount: 3,
    burstRpm: 1100,             // rate INSIDE the burst
    damage: 20,
    headshotMult: 2.4,
    rpm: 660,                   // governs time between bursts
    auto: false,
    pellets: 1,
    magSize: 30,
    reserveMax: 240,
    startingReserve: 120,
    reloadTime: 1.9,
    spreadRads: 0.008,
    moveSpread: 0.026,
    recoil: 0.6,
    recoilH: 0.2,
    recovery: 9.5,
    range: 200,
    shake: 0.05,
    color: 0xb6ffd2,
    sfx: 'burst',
    adsFov: 52,
    adsSpreadMult: 0.35,
    adsSensMult: 0.7,
    adsMoveMult: 0.6,
    scoped: false,
  },
];

/**
 * Enemy archetypes. Values marked `perWave` are multiplied by (wave - 1)
 * and added to the base, so difficulty ramps without new code.
 */
export const ENEMY_TYPES = {
  grunt: {
    id: 'grunt',
    label: 'GRUNT',
    health: 70,
    speed: 3.1,
    damage: 9,
    fireInterval: 1.15,
    accuracy: 0.055,           // aim cone, radians
    preferredRange: 11,
    bodyColor: 0x3f8f4f,
    eyeColor: 0xb6ff5a,
    height: 1.75,
    score: GAME.SCORE.GRUNT,
    spawnWeight: 5,
  },
  runner: {
    id: 'runner',
    label: 'RUNNER',
    health: 45,
    speed: 6.0,
    damage: 7,
    fireInterval: 0.75,
    accuracy: 0.10,
    preferredRange: 6,
    bodyColor: 0xc9761b,
    eyeColor: 0xffd24a,
    height: 1.62,
    score: GAME.SCORE.RUNNER,
    spawnWeight: 4,
  },
  heavy: {
    id: 'heavy',
    label: 'HEAVY',
    health: 210,
    speed: 2.2,
    damage: 16,
    fireInterval: 1.7,
    accuracy: 0.075,
    preferredRange: 8,
    bodyColor: 0xa02626,
    eyeColor: 0xff5a4a,
    height: 2.0,
    score: GAME.SCORE.HEAVY,
    spawnWeight: 2,
  },
  sniper: {
    id: 'sniper',
    label: 'MARKSMAN',
    health: 85,
    speed: 2.6,
    damage: 24,
    fireInterval: 2.6,
    accuracy: 0.012,
    preferredRange: 26,
    bodyColor: 0x5a3fa8,
    eyeColor: 0xc46bff,
    height: 1.82,
    score: GAME.SCORE.SNIPER,
    spawnWeight: 2,
  },
  /** Dev-range target: never moves, never fires, never dies. For testing damage. */
  dummy: {
    id: 'dummy',
    label: 'DUMMY',
    health: 1e9,
    speed: 0,
    damage: 0,
    fireInterval: 9999,
    accuracy: 0,
    preferredRange: 0,
    bodyColor: 0x8a8f98,
    eyeColor: 0xffd24a,
    height: 1.75,
    score: 0,
    spawnWeight: 0,
    passive: true,
  },
};

/** Drop chances when an enemy dies. */
export const PICKUPS = {
  HEALTH_AMOUNT: 30,
  ARMOR_AMOUNT: 30,
  AMMO_FRACTION: 0.35,        // fraction of the current weapon's reserveMax
  DROP_HEALTH: 0.20,
  DROP_ARMOR: 0.10,
  DROP_AMMO: 0.30,
  LIFETIME: 22,               // seconds before a pickup despawns
};
