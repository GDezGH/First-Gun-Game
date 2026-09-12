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
 * spreadRads   – half-angle of the bullet cone while standing still.
 * moveSpread   – extra cone added at full sprint speed (radians).
 * recoil       – vertical kick in degrees; `recoilH` is random horizontal.
 * recovery     – how fast the camera settles back after a kick (1/s).
 */
export const WEAPONS = [
  {
    id: 'rifle',
    slot: 1,
    name: 'AR-15 WORKHORSE',
    shortName: 'RIFLE',
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
    penetration: 0,           // future use: shoot through thin cover
    shake: GAME.SHAKE.RIFLE_FIRE,
    color: 0xffd27a,
    sfx: 'rifle',
  },
  {
    id: 'pistol',
    slot: 2,
    name: 'M9 SIDEARM',
    shortName: 'SIDEARM',
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
    penetration: 0,
    shake: 0.09,
    color: 0xffe6b0,
    sfx: 'pistol',
  },
  {
    id: 'shotgun',
    slot: 3,
    name: 'SPAS BREACHER',
    shortName: 'BREACHER',
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
    penetration: 0,
    shake: GAME.SHAKE.SHOTGUN_FIRE,
    color: 0xffb15c,
    sfx: 'shotgun',
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
