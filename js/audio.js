/**
 * audio.js — every sound in the game is synthesised at runtime.
 *
 * No .wav / .mp3 files ship in this repo. Web Audio nodes build each
 * effect from noise bursts, oscillators and filters, which keeps the
 * project small and makes the sound trivially tweakable.
 *
 * `audio.init()` must be called from a user gesture (click/keypress) —
 * browsers block AudioContext until then.
 */

/** A tiny noise buffer, generated once and reused. */
function makeNoiseBuffer(ctx, seconds = 1) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.volume = 0.7;
    this.muted = false;
    /** Distance above which sounds are inaudible. */
    this.falloffDistance = 60;
  }

  get ready() { return this.ctx !== null && this.ctx.state !== 'closed'; }

  /** Call from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;                       // no Web Audio: game still runs silent
    try {
      this.ctx = new Ctx();
    } catch (err) {
      // Audio is a nicety, not a requirement. Fail silent, keep playing.
      console.warn('[audio] could not create AudioContext:', err);
      this.ctx = null;
      return;
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    // Gentle limiter so layered gunshots never clip into distortion.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.002;
    this.compressor.release.value = 0.18;

    this.master.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    this.noise = makeNoiseBuffer(this.ctx, 1.2);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    // Called from the settings slider before any gesture, so ctx may be null.
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  /** 1 = full volume, 0 = out of earshot. Applies a little lowpass too. */
  _distanceGain(position, listenerPos) {
    if (!position) return 1;
    const d = position.distanceTo(listenerPos);
    return Math.max(0, 1 - d / this.falloffDistance);
  }

  /** Convenience: create a gain node pre-attenuated for a world position. */
  _spatial(position, listenerPos, base = 1) {
    const g = this.ctx.createGain();
    const att = this._distanceGain(position, listenerPos);
    g.gain.value = base * att * att;        // quadratic-ish falloff
    g.connect(this.master);
    return { node: g, attenuation: att };
  }

  // ------------------------------------------------------------------
  // Building blocks
  // ------------------------------------------------------------------

  /** A short noise burst through a sweeping lowpass: the core of a gunshot. */
  _burst({ dest, duration = 0.16, fromHz = 5200, toHz = 500, peak = 0.9, q = 1.0, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.3;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, toHz), t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    src.start(t);
    src.stop(t + duration + 0.02);
  }

  /** A pitched thump — the low-frequency body of an explosion or heavy shot. */
  _thump({ dest, duration = 0.2, fromHz = 160, toHz = 42, peak = 0.8, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** A short pitched blip used for UI ticks and hit confirmation. */
  _blip({ dest, freq = 1200, duration = 0.06, peak = 0.3, type = 'square', delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // ------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------

  /** Fired by the player: no distance attenuation, always punchy. */
  shoot(kind = 'rifle') {
    if (!this.ready) return;
    const out = this.master;
    const jitter = Math.random() * 0.002;

    if (kind === 'shotgun') {
      this._burst({ dest: out, duration: 0.30, fromHz: 3200, toHz: 240, peak: 0.95, q: 0.8, delay: jitter });
      this._thump({ dest: out, duration: 0.34, fromHz: 130, toHz: 34, peak: 1.0, delay: jitter });
      this._burst({ dest: out, duration: 0.5, fromHz: 900, toHz: 180, peak: 0.22, q: 0.6, delay: jitter + 0.04 });
    } else if (kind === 'pistol') {
      this._burst({ dest: out, duration: 0.14, fromHz: 4600, toHz: 700, peak: 0.72, q: 1.1, delay: jitter });
      this._thump({ dest: out, duration: 0.13, fromHz: 220, toHz: 70, peak: 0.4, delay: jitter });
    } else {
      this._burst({ dest: out, duration: 0.11, fromHz: 6200, toHz: 900, peak: 0.6, q: 1.2, delay: jitter });
      this._thump({ dest: out, duration: 0.10, fromHz: 260, toHz: 85, peak: 0.32, delay: jitter });
    }
  }

  /** An enemy shooting somewhere in the world. */
  enemyShoot(position, listenerPos) {
    if (!this.ready) return;
    const { node, attenuation } = this._spatial(position, listenerPos, 0.85);
    if (attenuation <= 0.001) return;
    this._burst({ dest: node, duration: 0.16, fromHz: 3800, toHz: 520, peak: 0.7, q: 1.0 });
    this._thump({ dest: node, duration: 0.14, fromHz: 200, toHz: 60, peak: 0.35 });
  }

  hitmarker(kill = false) {
    if (!this.ready) return;
    const out = this.master;
    if (kill) {
      this._blip({ dest: out, freq: 1500, duration: 0.07, peak: 0.32 });
      this._blip({ dest: out, freq: 2250, duration: 0.09, peak: 0.26, delay: 0.055 });
    } else {
      this._blip({ dest: out, freq: 1750, duration: 0.045, peak: 0.26, type: 'triangle' });
    }
  }

  /** Bullet hitting metal/stone near or around the player. */
  impact(position, listenerPos, flesh = false) {
    if (!this.ready) return;
    const { node, attenuation } = this._spatial(position, listenerPos, 0.5);
    if (attenuation <= 0.001) return;
    if (flesh) {
      this._burst({ dest: node, duration: 0.09, fromHz: 1100, toHz: 300, peak: 0.45, q: 0.7 });
    } else {
      this._burst({ dest: node, duration: 0.07, fromHz: 4200, toHz: 1500, peak: 0.32, q: 2.2 });
      this._blip({ dest: node, freq: 2600 + Math.random() * 1400, duration: 0.04, peak: 0.1, type: 'triangle' });
    }
  }

  /** The bullet cracking past your ear. */
  whiz() {
    if (!this.ready) return;
    const out = this.master;
    this._burst({ dest: out, duration: 0.12, fromHz: 2400, toHz: 700, peak: 0.3, q: 3.5 });
  }

  /** The player being hit. */
  playerHurt() {
    if (!this.ready) return;
    const out = this.master;
    this._thump({ dest: out, duration: 0.24, fromHz: 150, toHz: 45, peak: 0.55 });
    this._burst({ dest: out, duration: 0.2, fromHz: 900, toHz: 200, peak: 0.4, q: 0.8 });
  }

  death() {
    if (!this.ready) return;
    const out = this.master;
    this._thump({ dest: out, duration: 1.1, fromHz: 120, toHz: 28, peak: 0.8 });
    this._burst({ dest: out, duration: 1.0, fromHz: 700, toHz: 120, peak: 0.35, q: 0.7 });
  }

  /** Mechanical clicks for magazine out / magazine in / bolt release. */
  reload(step = 0) {
    if (!this.ready) return;
    const out = this.master;
    if (step === 0) {
      this._burst({ dest: out, duration: 0.05, fromHz: 2600, toHz: 1200, peak: 0.28, q: 3 });
      this._blip({ dest: out, freq: 420, duration: 0.05, peak: 0.16, type: 'square' });
    } else if (step === 1) {
      this._burst({ dest: out, duration: 0.05, fromHz: 2000, toHz: 900, peak: 0.24, q: 3 });
      this._blip({ dest: out, freq: 520, duration: 0.05, peak: 0.14, type: 'square' });
    } else {
      this._burst({ dest: out, duration: 0.06, fromHz: 3400, toHz: 1500, peak: 0.36, q: 3.5 });
      this._blip({ dest: out, freq: 700, duration: 0.06, peak: 0.18, type: 'square' });
    }
  }

  /** Dry fire on an empty magazine. */
  dryFire() {
    if (!this.ready) return;
    this._blip({ dest: this.master, freq: 900, duration: 0.035, peak: 0.2, type: 'square' });
  }

  weaponSwitch() {
    if (!this.ready) return;
    const out = this.master;
    this._burst({ dest: out, duration: 0.07, fromHz: 2800, toHz: 1100, peak: 0.24, q: 2.6 });
    this._blip({ dest: out, freq: 330, duration: 0.06, peak: 0.12, type: 'square', delay: 0.04 });
  }

  jump() {
    if (!this.ready) return;
    this._burst({ dest: this.master, duration: 0.07, fromHz: 700, toHz: 260, peak: 0.16, q: 1.2 });
  }

  land(hard = false) {
    if (!this.ready) return;
    this._thump({ dest: this.master, duration: hard ? 0.18 : 0.1, fromHz: hard ? 140 : 190, toHz: 50, peak: hard ? 0.34 : 0.16 });
  }

  footstep() {
    if (!this.ready) return;
    this._burst({
      dest: this.master,
      duration: 0.05,
      fromHz: 500 + Math.random() * 260,
      toHz: 150,
      peak: 0.075,
      q: 1.1,
    });
  }

  pickup(kind = 'health') {
    if (!this.ready) return;
    const out = this.master;
    const base = kind === 'ammo' ? 620 : kind === 'armor' ? 500 : 760;
    this._blip({ dest: out, freq: base, duration: 0.07, peak: 0.2, type: 'sine' });
    this._blip({ dest: out, freq: base * 1.5, duration: 0.1, peak: 0.16, type: 'sine', delay: 0.06 });
  }

  /** Wave fanfare. `down` = you died. */
  waveStart(wave) {
    if (!this.ready) return;
    const out = this.master;
    const root = 300 + Math.min(wave, 10) * 8;
    [0, 4, 7].forEach((semi, i) => {
      this._blip({
        dest: out,
        freq: root * Math.pow(2, semi / 12),
        duration: 0.28,
        peak: 0.14,
        type: 'sawtooth',
        delay: i * 0.09,
      });
    });
  }

  gameOver() {
    if (!this.ready) return;
    const out = this.master;
    [0, -3, -7, -12].forEach((semi, i) => {
      this._blip({
        dest: out,
        freq: 320 * Math.pow(2, semi / 12),
        duration: 0.5,
        peak: 0.17,
        type: 'sawtooth',
        delay: i * 0.2,
      });
    });
  }

  uiClick() {
    if (!this.ready) return;
    this._blip({ dest: this.master, freq: 900, duration: 0.05, peak: 0.18, type: 'square' });
  }
}

/** Single shared instance. */
export const audio = new AudioEngine();
