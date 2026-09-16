# Running First Gun Game on your laptop + how the code works

A plain-English guide. No prior developer knowledge assumed.

---

## Part 1 — The one big idea

**This game is a website, and your browser is the "game engine runner".**

Everything you see (3D world, guns, enemies, sound) is produced by JavaScript
running *inside a browser tab*, using three.js for 3D and WebGL for drawing.
There is no separate `.exe` and nothing to install to *play* — the folder of
files **is** the whole game.

So "without a browser" has an honest answer:

- You **cannot** avoid a browser *engine* — WebGL 3D only runs in one
  (Chrome/Edge/Firefox/Safari, or an app that embeds one, like Electron).
- You **can** avoid the *internet and any online preview*: run the game
  **100% locally and offline** on your laptop. That is what this guide shows.

---

## Part 2 — Get the code onto your laptop

You do **not** paste anything into a browser. You put the *folder* on your
laptop. Two ways:

**Way A — Download a ZIP (easiest, no tools needed):**
1. Go to `https://github.com/GDezGH/First-Gun-Game`
2. Click the green **Code** button → **Download ZIP**.
3. Unzip it anywhere (e.g. Desktop). You now have a folder called
   `First-Gun-Game`.

**Way B — Clone with git (if you have git installed):**
```
git clone https://github.com/GDezGH/First-Gun-Game.git
```

Either way you end up with this folder structure (this IS the game):

```
First-Gun-Game/
  index.html          <- the page the browser opens (the "app shell")
  server.js           <- tiny local web server (see Part 3)
  css/style.css       <- all the visuals for menus + HUD
  js/                 <- the game logic (one file per job, see Part 5)
  vendor/three.module.js  <- the 3D engine, stored locally (offline!)
  docs/, tests/       <- docs and the automated test suite
```

---

## Part 3 — Run it (two options)

### Option 1 — With Node.js (recommended, this is what `server.js` is for)
1. Install Node.js once from `https://nodejs.org` (LTS).
2. Open a terminal **inside the folder** and run:
   ```
   node server.js
   ```
3. Open your browser and go to: **http://localhost:8080**
4. Click **DEPLOY**, then click once to capture the mouse. Play.

### Option 2 — Without Node.js (use Python, already on most laptops)
In the folder run:
```
python3 -m http.server 8080
```
then open **http://localhost:8080**.

### Why can't I just double-click `index.html`?
Browsers **refuse to load ES-module JavaScript from a `file://` page** (a
security rule called CORS). The game's files are ES modules, so they must be
served over a tiny local web server — which is exactly what `server.js`
(or Python) does. That's the only reason the server exists.

### Want it to *feel* like a desktop app (no browser chrome)?
In Chrome/Edge, open `http://localhost:8080`, then menu → **Save/Install as
app** (or launch with `chrome --app=http://localhost:8080`). It opens in its
own window like a native game. (Under the hood it's still a browser engine —
that's unavoidable for WebGL, see Part 1.)

---

## Part 4 — What happens when it runs (the flow)

1. The browser loads **index.html**. At the bottom it says
   `<script type="module" src="./js/main.js">`, so it loads **main.js**.
2. **main.js** imports every other file, then builds the 3D scene:
   renderer + camera, the map (`world.js`), you (`player.js`), guns
   (`weapons.js`), enemies, effects, HUD, input, audio.
3. It shows the **main menu** and starts a loop with
   `requestAnimationFrame` (runs ~60+ times a second):
   - **Simulate** a fixed time step (`step()`): move player, fire bullets,
     run enemy AI, spawn waves, update pickups.
   - **Draw** the frame and refresh the HUD.
4. Your mouse/keyboard set flags in `input.js`; the sim reads them each step.
5. When you shoot, `weapons.js` fires an invisible ray (hitscan), checks it
   against walls (`world.js` colliders) and enemy hit-boxes, then reports
   damage → HUD numbers, hitmarkers, sound.

---

## Part 5 — What each file does

| File | Job |
| --- | --- |
| `index.html` | The page: canvas + HUD + menus (just structure). |
| `css/style.css` | All colours, menus, HUD styling, animations. |
| `js/main.js` | The conductor: boot, game loop, state (menu/playing/paused/dead), wires everything together. |
| `js/config.js` | **All the numbers** — weapons, enemy stats, wave pacing, player speed, camera feel. *Edit this to rebalance the game.* |
| `js/three.js` | 1-line shim that re-exports the engine from `vendor/`. |
| `vendor/three.module.js` | The three.js 3D engine, stored locally (offline). |
| `js/world.js` | Builds each map (theme + boxes/cover) and the invisible collision boxes. |
| `js/player.js` | Your movement, jumping, collision, and the smoothed camera. |
| `js/weapons.js` | The 6 guns, fire modes, recoil, aim-down-sights, 3D gun models, hit-scan. |
| `js/enemies.js` | Enemy AI (chase/strafe/shoot), spawning, taking damage. |
| `js/effects.js` | Tracers, sparks, blood, shell casings (pooled particles). |
| `js/pickups.js` | Health/armor/ammo drops. |
| `js/hud.js` | Updates the on-screen DOM (health bar, ammo, killfeed…). |
| `js/input.js` | Keyboard/mouse + pointer-lock. |
| `js/audio.js` | All sound, synthesised live (no audio files). |
| `js/mathutil.js` | Small math helpers (random, ray-vs-box, smoothing). |
| `server.js` | Tiny local web server so modules load (see Part 3). |
| `tests/play.test.js` | Automated browser tests (needs `npm i` + network once). |

---

## Part 6 — "Where do I paste code?" (if you ever edit it)

You edit the **files on disk** with any text editor (VS Code, Notepad++…),
save, then **reload the browser tab**. The server sends fresh files with no
caching, so changes appear immediately. There is nothing to paste into the
browser and no build step.

Most fun edits live in `js/config.js` (damage, rpm, speeds, wave sizes).

---

## Quick reference card

```
# run locally
node server.js            # or: python3 -m http.server 8080
# play
open http://localhost:8080
# controls
WASD move · mouse look/fire · RMB aim · Shift sprint · Space jump
R reload · 1-6 weapons · wheel cycle · Esc pause
# dev range (pick DEV RANGE map): G god · B inf-ammo · H heal · J dummy
K enemy · L clear · M next map · N noclip · T slow-mo
```
