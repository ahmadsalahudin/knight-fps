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
| M | Mute / unmute (a small "MUTED" hint shows on the HUD) |
| Esc | Release the mouse and pause |

The title screen has a **difficulty** choice (Easy / Normal / Hard) and a **volume** slider. Both are remembered in the browser (`localStorage`).

Waves 1 to 4 bring 5, 7, 9 and 11 knights on Normal, spawned one at a time from the edge of the arena. You heal 25 HP between waves and get fully healed before the boss.
On wave 5 the boss arrives, with an HP bar, three telegraphed attacks (a sweep, a leap slam and a charge), two phase changes, and minions. Victory shows only after the boss dies.
Head shots kill a knight outright. Torso shots take about 3 hits and limbs about 4.

### Difficulty

The chosen level shows next to the wave counter (`WAVE 2 / 5 HARD`) and on the game-over and victory screens.

| | Easy | Normal | Hard |
|---|---|---|---|
| Enemy damage | x0.6 | x1 | x1.4 |
| Knight HP | x0.8 (80) | x1 (100) | x1.25 (125) |
| Knight speed | x0.9 | x1 | x1.15 |
| Knights per wave (waves 1-4) | 3 / 5 / 7 / 9 | 5 / 7 / 9 / 11 | 7 / 9 / 11 / 13 |
| Knight windup (telegraph) | normal | normal | 20 % shorter |
| Boss HP | x0.75 (1125) | x1 (1500) | x1.3 (1950) |
| Boss reach (sweep, slam, attack distance) | x0.9 | x1 | x1.15 |
| Heal after a wave | 40 HP | 25 HP | 15 HP |
| Knights that throw daggers | 20 % | 35 % | 50 % |

The table lives in `window.Difficulty` at the top of `src/js/waves.js`; the other modules read it when they spawn or hit.

### Thrown daggers

Some knights (chosen when they spawn, never the boss) throw a dagger instead of waiting for melee. A thrower that is 6-16 m away, walking
toward you and off its 5-8 s cooldown stops, raises its sword for about 0.6 s, then throws a small spinning dagger at where you are at that
moment. It flies at 18 m/s on a slight arc, so strafing dodges it. A hit within 0.6 m of your body costs 10 HP (x the difficulty damage
multiplier) and shows the red damage arc toward the thrower. A dagger that misses sparks on a tree or rock, or kicks up dust on the ground, lies there
for 5 s and is removed. Melee knights are unchanged.

### Sound

All audio is synthesized with WebAudio at run time, with no audio files. One master gain (with a compressor and a soft clip, so many overlapping sounds never clip)
feeds the speakers, and a shared convolution reverb with a generated 1.2 s decaying-noise impulse gives everything an outdoor tail.
Enemy sounds (footsteps with an armour jingle, sword swings, clangs, deaths, the boss roar and stomps, dagger throws and impacts) are 3D: an HRTF panner with
distance falloff, with the listener following the camera, so you can hear which way knights are coming from. The revolver has a crack, a low boom and a
reverb tail, varied slightly with every shot. A head shot is a sharp metallic ping, an armour hit a clank, and a kill a heavier crunch with the body and armour falling.
A dagger whooshes when thrown, whirrs in flight, and thuds, clangs or hurts when it lands. A quiet meadow loop (wind plus the odd bird) starts when you press START
and ducks during the boss fight. Press **M** to mute; the title-screen slider sets the volume.

Add `?debug=1` to the URL to enable `window.__dbg`: `godMode`, `skipToWave`, `spawn`, `freezeAI`,
`lookAt`, `killAll`, `state()` and more.

## Develop

The HTML is a build output, so don't edit it by hand. The source lives in `src/`:

```
src/index.template.html   markup, CSS, HUD skeleton, build placeholders
src/js/assets.js          GLTFLoader + SkeletonUtils loading, clips, bone lookup, normalization
src/js/world.js           ground, trees, rocks, circular boulder wall, colliders, staticTargets
src/js/sfx.js             WebAudio synthesized sounds: master chain, reverb, 3D positional audio, ambience, mute / volume
src/js/hud.js             ammo, HP, wave and boss bars, banners, hitmarkers, damage arcs
src/js/fx.js              pooled particles, tracers, decals, blood pools, camera shake
src/js/weapon.js          revolver viewmodel and hand (separate scene and camera), recoil, flash, reload
src/js/combat.js          hit zones, damage, knockback, helmet pop, dropped gear physics
src/js/enemies.js         animated Knight class (mixer, state machine, bone-attached gear, dagger throwing) + Enemies (incl. thrown daggers)
src/js/boss.js            Boss extends Knight
src/js/waves.js           Difficulty table, wave flow 1-4, boss wave 5, victory
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
npm run audio                                # renders every sound offline and checks it is audible, bounded and positional
npm run shots -- --list                      # named screenshot scenarios
npm run shots -- d2-full-run e1-gun-fire     # PNGs -> tools/qa/out/
```

The harness serves the repo over local HTTP and answers the
`https://cdn.jsdelivr.net/npm/three@0.147.0/...` requests from `node_modules/three`, so it runs offline.
It runs headless Chromium with SwiftShader WebGL and a virtual clock for frame-exact captures.
`npm run audio` cannot tell you how the sounds *sound*: it renders each one into an `OfflineAudioContext` and checks that it is not silent,
stays below 1.0 even with 60 sounds piled up, falls off with distance, pans left/right, and that mute and volume work. Listen to the game yourself for the rest.
Debug helpers for the daggers (with `?debug=1`): `__dbg.knightThrow(i?, flightSeconds?)` and `__dbg.daggers()`.

## Legacy files

The other root-level files are the earlier generation pipeline and its artifacts: the Python and JS pipeline scripts, the
json decision files, the jpg textures, and the old `*_out.html` pages. They are left untouched for reference, and
the current game does not use them.

## Credits

The 3D models (knight, gear, revolver, trees, rocks, grass) are from Quaternius CC0 asset packs.
