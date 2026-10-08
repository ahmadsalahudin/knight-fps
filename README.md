# Knights of the Meadow: Browser FPS

A first-person shooter built with three.js r147. You hold a meadow with a revolver
against four waves of armoured, animated knights, then fight the Iron Warlord, a
giant boss knight, on wave 5. The whole game ships as one self-contained file,
`knights_out_final.html`. All models are embedded as base64 GLB, and three.js loads from the jsdelivr CDN.

## Play

```bash
npm run build                    # only needed after editing src/
python3 -m http.server 8877      # or: node tools/qa/serve.mjs 8877
# open http://127.0.0.1:8877/knights_out_final.html
```

| Input | Action |
|---|---|
| W A S D / arrow keys | Move |
| Shift | Sprint |
| Mouse | Aim |
| Left click | Fire (6-shot revolver) |
| R | Reload |
| Esc | Release the mouse and pause |

Waves 1 to 4 bring 5, 7, 9 and 11 knights, spawned one at a time from the edge of the arena. You heal 25 HP between waves and get fully healed before the boss.
On wave 5 the boss arrives, with an HP bar, three telegraphed attacks (a sweep, a leap slam and a charge), two phase changes, and minions. Victory shows only after the boss dies.
Head shots kill a knight outright. Torso shots take about 3 hits and limbs about 4.

Add `?debug=1` to the URL to enable `window.__dbg`: `godMode`, `skipToWave`, `spawn`, `freezeAI`,
`lookAt`, `killAll`, `state()` and more.

## Deploy to a VPS

`deploy/install.sh` sets everything up from the VPS's own terminal. It installs a web server (Caddy, or the nginx
that is already running), downloads `knights_out_final.html` from this repo, serves it as the site's page, and
sets up HTTPS for a domain. It supports Debian/Ubuntu and Fedora/RHEL-family servers with systemd.

1. In your DNS provider, add an `A` record for the game's host name (for example `knights` under
   `ahmadsalahudin.tech`) pointing to the VPS's IP address.
2. On the VPS, run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ahmadsalahudin/knight-fps/main/deploy/install.sh \
     | sudo bash -s -- --domain knights.ahmadsalahudin.tech --email you@example.com
   ```

3. Open `https://knights.ahmadsalahudin.tech/`. The certificate is issued as soon as the DNS record reaches the
   server, so the first visit may take a minute after the record is created.

Without a domain, run the same command with no options and play at `http://<server-ip>/`.

| Later | Command (append to `curl -fsSL …/deploy/install.sh \| sudo bash -s --`) |
|---|---|
| Update to the latest game | `--update` |
| Undo the last update | `--rollback` |
| See what is deployed | `--status` |
| Remove the site | `--uninstall` |

Other options: `--server caddy|nginx`, `--port N` (no domain), `--ref <branch/tag/commit>`, `--dir <web root>`;
see `--help`. Settings are saved in `/etc/knights-deploy.conf`, so a later run with no options repeats the same
setup. If Apache already uses port 80, the script stops and explains the options instead of breaking the site.

## Develop

The HTML is a build output, so don't edit it by hand. The source lives in `src/`:

```
src/index.template.html   markup, CSS, HUD skeleton, build placeholders
src/js/assets.js          GLTFLoader + SkeletonUtils loading, clips, bone lookup, normalization
src/js/world.js           ground, trees, rocks, circular boulder wall, colliders, staticTargets
src/js/sfx.js             WebAudio synthesized sounds
src/js/hud.js             ammo, HP, wave and boss bars, banners, hitmarkers, damage arcs
src/js/fx.js              pooled particles, tracers, decals, blood pools, camera shake
src/js/weapon.js          revolver viewmodel and hand (separate scene and camera), recoil, flash, reload
src/js/combat.js          hit zones, damage, knockback, helmet pop, dropped gear physics
src/js/enemies.js         animated Knight class (mixer, state machine, bone-attached gear) + Enemies
src/js/boss.js            Boss extends Knight
src/js/waves.js           wave flow 1-4, boss wave 5, victory
src/js/game.js            player movement, hitscan firing, damage
src/js/debug.js           __dbg helpers (only with ?debug=1)
src/js/main.js            renderer, lights, async asset load, guarded main loop
tools/build.mjs           embeds the used assets/*.glb + concatenates the modules into knights_out_final.html
tools/qa/                 Playwright harness (see tools/qa/README.md)
docs/FIX_PLAN.md          diagnosis, module contracts, and acceptance criteria
```

### Test

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i     # once; uses a pre-installed Chromium
npm run build
npm run qa                                   # smoke test: prints SMOKE PASS/FAIL
npm run shots -- --list                      # named screenshot scenarios
npm run shots -- d2-full-run e1-gun-fire     # PNGs -> tools/qa/out/
```

The harness serves the repo over local HTTP and answers the
`https://cdn.jsdelivr.net/npm/three@0.147.0/...` requests from `node_modules/three`, so it runs offline.
It runs headless Chromium with SwiftShader WebGL and a virtual clock for frame-exact captures.

## Legacy files

The other root-level files are the earlier generation pipeline and its artifacts: the Python and JS pipeline scripts, the
json decision files, the jpg textures, and the old `*_out.html` pages. They are left untouched for reference, and
the current game does not use them.

## Credits

The 3D models (knight, gear, revolver, trees, rocks, grass) are from Quaternius CC0 asset packs.
