/**
 * input.js — keyboard, mouse and pointer-lock handling.
 *
 * Mouse look only works while the pointer is locked; browsers require an
 * explicit user gesture for that, so the game asks for the lock on click
 * and shows a nudge whenever the lock is lost (Esc, alt-tab, etc).
 */

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    /** Currently held keys, keyed by KeyboardEvent.code. */
    this.keys = Object.create(null);
    /** Currently held mouse buttons, keyed by button index. */
    this.buttons = Object.create(null);

    this.sensitivity = 1;
    this.locked = false;

    /** Callbacks wired up by main.js. */
    this.onLook = () => {};
    this.onFireDown = () => {};
    this.onFireUp = () => {};
    this.onCycleWeapon = () => {};
    this.onReload = () => {};
    this.onSlot = () => {};
    this.onPause = () => {};
    this.onLockChange = () => {};

    this._bind();
  }

  _bind() {
    const c = this.canvas;

    // ---- keyboard ---------------------------------------------------
    window.addEventListener('keydown', (e) => {
      // Never let the browser scroll or trigger shortcuts mid-game.
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.repeat) {
        // Only weapon-slot and reload repeat intentionally.
        return;
      }
      this.keys[e.code] = true;

      switch (e.code) {
        case 'KeyR': this.onReload(); break;
        case 'Digit1': this.onSlot(0); break;
        case 'Digit2': this.onSlot(1); break;
        case 'Digit3': this.onSlot(2); break;
        case 'Escape': this.onPause(); break;
        default: break;
      }
    });

    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // Losing window focus should release every key, or the player would
    // keep sprinting forever after alt-tabbing back.
    window.addEventListener('blur', () => {
      for (const k of Object.keys(this.keys)) this.keys[k] = false;
      for (const b of Object.keys(this.buttons)) this.buttons[b] = false;
      this.onFireUp();
    });

    // ---- mouse --------------------------------------------------------
    c.addEventListener('mousedown', (e) => {
      this.buttons[e.button] = true;
      if (e.button === 0) this.onFireDown();
      // Right button is reserved for aim-down-sights in a later version.
    });

    window.addEventListener('mouseup', (e) => {
      this.buttons[e.button] = false;
      if (e.button === 0) this.onFireUp();
    });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = this.sensitivity * 0.0022;
      this.onLook(e.movementX * k, e.movementY * k);
    });

    c.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.onCycleWeapon(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    // ---- pointer lock ---------------------------------------------------
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      if (!this.locked) {
        for (const k of Object.keys(this.keys)) this.keys[k] = false;
        this.buttons[0] = false;
        this.onFireUp();
      }
      this.onLockChange(this.locked);
    });

    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this.onLockChange(false);
    });
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock?.();
    // Chrome returns a promise; a rejection here is not fatal.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  releaseLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Snapshot of movement intent for the player controller. */
  get moveState() {
    const k = this.keys;
    return {
      forward: !!(k.KeyW || k.ArrowUp),
      back: !!(k.KeyS || k.ArrowDown),
      left: !!(k.KeyA || k.ArrowLeft),
      right: !!(k.KeyD || k.ArrowRight),
      jump: !!k.Space,
      sprint: !!(k.ShiftLeft || k.ShiftRight),
    };
  }

  get firing() { return !!this.buttons[0]; }
}
