# 🧊 Cube Racer (browser edition)

Multiplayer cube racing in the browser. **Zero dependencies** — push to GitHub, deploy on Render, done.

## Deploy (about 3 minutes)

**1. Put it on GitHub**
1. Create an empty repo on github.com (e.g. `cube-racer`).
2. Upload the files **inside** this folder so that `package.json`, `server.js` and `public/` sit at the **top level** of the repo (not inside a sub-folder). From a terminal in this folder:
   ```
   git init && git add . && git commit -m "cube racer"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/cube-racer.git
   git push -u origin main
   ```

**2. Deploy on Render (recommended: no render.yaml needed)**
1. https://render.com → **New +** → **Web Service** → connect your GitHub repo.
2. Fill in:
   | Field | Value |
   |---|---|
   | Language / Runtime | **Node** |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |
   | Advanced → Health Check Path | `/healthz` (optional) |
3. **Create Web Service**, wait for "Live", open your `https://…onrender.com` URL.

*Repo has the project inside a sub-folder?* Either move the files to the top level, or set **Root Directory** to that folder name in the form above.

*(Optional)* `render.yaml` is included for **New + → Blueprint**, but Blueprints can ask for a payment method and the file must sit at the repo root, so the manual route above is the safer one.

Every `git push` redeploys automatically.

> **Free plan note:** Render's free tier puts the app to sleep after ~15 minutes of no traffic; the first visit afterwards takes ~30–60s to wake. Keep it at **1 instance** (rooms live in server memory).

## Playing
- **Quick Race** drops you into an open room (or makes one). **Create private room** gives a 4-letter code / invite link to send friends.
- The host presses **Start race**. 3 laps. Solo practice works too.
- **Keys:** W/↑ gas · S/↓ brake & reverse · A D/←→ steer · **Space** jump · **Shift** boost (3.5s cooldown) · **R** respawn. Touch buttons appear on phones.

## What's in it
| You asked for | Where |
|---|---|
| MS-Paint-style T-shaped skin editor (front centre, left/right sides, top/bottom/back) with pencil, eraser, fill, colour picker, palette, brush size, undo/redo | `public/js/skin.js` |
| Saved skins + saved customization (skin + decorations + name) | browser `localStorage`, UI in `public/js/main.js` |
| Ears, eyes, horns, hats, wings, back items with size limits so they can't block views | `public/js/cosmetics.js` (user size slider **plus** a hard per-slot bounding-box cap) |
| Arcade physics: acceleration, boost, jump, ramps, obstacles, checkpoints, laps, positions | `public/js/sim.js`, `track.js` |
| Rotation never tumbles; yaw follows steering; pitch/roll follows the surface (ramps, banks, walls, a full loop); held in the air, smooth re-align on landing | `sim.js` → `stepCar` |
| Online multiplayer with synced movement, rotation, race state, custom skins and cosmetics | `server.js` + `public/js/net.js` |
| Menu, customization, lobby, race HUD, results | `public/index.html`, `main.js` |

## Run locally
```
npm start          # http://localhost:3000
npm test           # physics bot + server + client smoke tests (needs Node 22 for the built-in WebSocket client)
```

## Tweaking
- **Track:** the course is a short list in `buildTrack()` (`public/js/track.js`): `S` straight, `T` turn (with banking), `P` pitch/ramp, `GAP` jump gap, `LOOP`. If you change lengths, run `node test/closure.mjs` — the last sample must land one spacing behind the first.
- **Feel:** all handling numbers are in `PHYS` at the top of `public/js/sim.js`.
- **Laps / checkpoints:** `LAPS`, `CP_COUNT` in `track.js`.

## Known limits (honest list)
- Cars don't collide with each other (ghost racing) — keeps online play smooth.
- Each player simulates their own car and reports it (fine for friends; not cheat-proof). The server does validate checkpoint order, laps, results, names, skins and decoration IDs.
- The 3D library (three.js) loads from the jsDelivr CDN; if a network blocks it, the page shows an error banner.
