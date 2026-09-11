/**
 * hud.js — everything drawn in DOM rather than WebGL.
 *
 * Using DOM for the HUD instead of a canvas overlay keeps the text crisp
 * at any resolution and makes restyling a CSS-only job. Only values that
 * actually changed are written back, so the DOM is not thrashed each frame.
 */

import { GAME } from './config.js';

const $ = (id) => document.getElementById(id);

/** Project a world position to CSS pixel coordinates. */
const _ndc = { x: 0, y: 0 };
function projectToScreen(camera, worldPos, width, height, out) {
  const v = worldPos.clone().project(camera);
  out.x = (v.x * 0.5 + 0.5) * width;
  out.y = (-v.y * 0.5 + 0.5) * height;
  out.z = v.z;                       // >1 means behind the camera
  return out;
}

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {
      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      hitmarkerKill: $('hitmarker-kill'),
      damageNumbers: $('damage-numbers'),
      damageArcs: $('damage-arcs'),
      vignette: $('vignette'),
      waveNumber: $('wave-number'),
      enemiesLeft: $('enemies-left'),
      intermission: $('intermission'),
      intermissionText: $('intermission-text'),
      score: $('score'),
      kills: $('kills'),
      accuracy: $('accuracy'),
      healthValue: $('health-value'),
      healthFill: $('health-fill'),
      armorValue: $('armor-value'),
      armorFill: $('armor-fill'),
      weaponName: $('weapon-name'),
      ammoMag: $('ammo-mag'),
      ammoReserve: $('ammo-reserve'),
      ammoPips: $('ammo-pips'),
      weaponSlots: $('weapon-slots'),
      prompt: $('prompt'),
      killfeed: $('killfeed'),
      banner: $('banner'),
      bannerTitle: $('banner-title'),
      bannerSub: $('banner-sub'),
    };

    // Cache the last written values so we skip redundant DOM writes.
    this._last = {};
    this._screen = { x: 0, y: 0, z: 0 };
    this._pipCount = -1;
    this._activeSlot = -1;
    this._vignetteCritical = false;
    this._hmTimer = null;
    this._hmKillTimer = null;
    this._bannerTimer = null;
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  _set(key, node, prop, value) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    node[prop] = value;
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  updateVitals(player) {
    const hp = Math.ceil(player.health);
    this._set('hp', this.el.healthValue, 'textContent', String(hp));
    this.el.healthFill.style.width = `${(player.health / GAME.PLAYER.MAX_HEALTH) * 100}%`;
    const low = player.health <= 30;
    if (this._last.lowHp !== low) {
      this._last.lowHp = low;
      this.el.healthFill.classList.toggle('low', low);
    }

    const ar = Math.ceil(player.armor);
    this._set('ar', this.el.armorValue, 'textContent', String(ar));
    this.el.armorFill.style.width = `${(player.armor / GAME.PLAYER.MAX_ARMOR) * 100}%`;

    // Persistent red pulse while critically hurt.
    const critical = player.alive && player.health <= 25;
    if (critical !== this._vignetteCritical) {
      this._vignetteCritical = critical;
      this.el.vignette.classList.toggle('critical', critical);
    }
  }

  updateWeapon(weapons) {
    const slot = weapons.current;
    const def = slot.def;

    this._set('wname', this.el.weaponName, 'textContent', def.name);
    this._set('amag', this.el.ammoMag, 'textContent', String(slot.mag));
    this._set('ares', this.el.ammoReserve, 'textContent', String(slot.reserve));

    const empty = slot.mag === 0;
    if (this._last.empty !== empty) {
      this._last.empty = empty;
      this.el.ammoMag.classList.toggle('empty', empty);
    }

    // Ammo pips: one per round in the magazine (capped for big mags).
    const max = def.magSize;
    if (this._pipCount !== max) {
      this._pipCount = max;
      this.el.ammoPips.innerHTML = '';
      this._pips = [];
      for (let i = 0; i < max; i++) {
        const d = document.createElement('div');
        d.className = 'pip';
        this.el.ammoPips.appendChild(d);
        this._pips.push(d);
      }
    }
    for (let i = 0; i < this._pipCount; i++) {
      const on = i < slot.mag;
      if (this._pips[i].classList.contains('on') !== on) {
        this._pips[i].classList.toggle('on', on);
      }
    }

    if (this._activeSlot !== weapons.index) {
      this._activeSlot = weapons.index;
      [...this.el.weaponSlots.children].forEach((c, i) =>
        c.classList.toggle('active', i === weapons.index)
      );
    }
  }

  updateWave(wave, enemiesLeft, intermissionRemaining) {
    this._set('wave', this.el.waveNumber, 'textContent', String(wave));
    this._set('eleft', this.el.enemiesLeft, 'textContent', String(enemiesLeft));

    const showing = intermissionRemaining > 0;
    if (this._last.im !== showing) {
      this._last.im = showing;
      this.el.intermission.classList.toggle('hidden', !showing);
    }
    if (showing) {
      const secs = Math.ceil(intermissionRemaining);
      this._set('imtext', this.el.intermissionText, 'textContent',
        `NEXT WAVE IN ${secs}  —  RELOAD`);
    }
  }

  updateStats(score, kills, accuracy) {
    this._set('score', this.el.score, 'textContent', String(score));
    this._set('kills', this.el.kills, 'textContent', String(kills));
    this._set('acc', this.el.accuracy, 'textContent',
      accuracy === null ? '--' : `${accuracy.toFixed(0)}%`);
  }

  /** Widen the reticle with movement, recoil and weapon spread. */
  updateReticle(player, weapons) {
    const def = weapons.def;
    const flatSpeed = Math.hypot(player.vel.x, player.vel.z);
    const move = Math.min(1, flatSpeed / 8.6);
    const airborne = player.grounded ? 0 : 1;
    const kick = player.fireKick;
    const gap = 5 + def.spreadRads * 260 + move * 12 + airborne * 7 + kick * 9;
    this.el.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  hitmarker(kill = false) {
    const node = kill ? this.el.hitmarkerKill : this.el.hitmarker;
    node.classList.remove('show');
    // Force a reflow so the animation restarts on rapid hits.
    void node.offsetWidth;
    node.classList.add('show');
  }

  /** Floating damage number projected from the impact point. */
  damageNumber(camera, worldPos, amount, head) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = projectToScreen(camera, worldPos, w, h, this._screen);
    if (p.z > 1) return;

    const el = document.createElement('div');
    el.className = `dmg-num ${head ? 'crit' : 'body'}`;
    el.textContent = head ? `${Math.round(amount)}!` : String(Math.round(amount));
    el.style.left = `${p.x + (Math.random() * 26 - 13)}px`;
    el.style.top = `${p.y}px`;
    this.el.damageNumbers.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /** Red arc pointing at whatever just shot the player. */
  damageArc(camera, sourcePos) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = projectToScreen(camera, sourcePos, w, h, this._screen);

    // Angle from screen centre to the attacker, in degrees.
    const dx = p.x - w / 2;
    const dy = p.y - h / 2;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const el = document.createElement('div');
    el.className = 'dmg-arc';
    el.style.transform = `rotate(${angle + 90}deg)`;
    el.style.background =
      'conic-gradient(from 0deg, rgba(255,40,30,0.95) 0deg 42deg, rgba(255,40,30,0) 42deg 360deg)';
    el.style.maskImage =
      'radial-gradient(circle, transparent 58%, black 70%, black 100%)';
    el.style.webkitMaskImage = el.style.maskImage;
    this.el.damageArcs.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  /** Brief red flash on taking damage. */
  flashVignette(amount = 1) {
    this.el.vignette.style.opacity = String(Math.min(0.95, 0.25 + amount * 0.045));
    clearTimeout(this._vigTimer);
    this._vigTimer = setTimeout(() => {
      if (!this._vignetteCritical) this.el.vignette.style.opacity = '0';
    }, 180);
  }

  killfeed(text, crit = false) {
    const el = document.createElement('div');
    el.className = `kf-item${crit ? ' crit' : ''}`;
    el.textContent = text;
    this.el.killfeed.appendChild(el);
    // Keep the feed short.
    while (this.el.killfeed.children.length > 5) {
      this.el.killfeed.firstChild.remove();
    }
    setTimeout(() => el.remove(), 3200);
  }

  banner(title, sub = '', duration = 2200) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    this.el.banner.classList.remove('hidden', 'show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.el.banner.classList.add('hidden'), duration);
  }

  prompt(text) {
    if (!text) {
      this.el.prompt.classList.add('hidden');
      return;
    }
    this.el.prompt.textContent = text;
    this.el.prompt.classList.remove('hidden');
  }

  /** Clear transient layers between runs. */
  resetTransient() {
    this.el.damageNumbers.innerHTML = '';
    this.el.damageArcs.innerHTML = '';
    this.el.killfeed.innerHTML = '';
    this.el.vignette.style.opacity = '0';
    this.el.vignette.classList.remove('critical');
    this.el.prompt.classList.add('hidden');
    this.el.banner.classList.add('hidden');
    this._vignetteCritical = false;
  }
}
