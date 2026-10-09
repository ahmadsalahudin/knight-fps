# Knights of the Meadow: Browser FPS

A first-person shooter built with three.js r147. You hold a meadow with a revolver
against waves of armoured, animated knights (4, 5 or 6 waves depending on the difficulty), then fight the Iron Warlord, a
giant boss knight, in the last one. The whole game ships as one self-contained file,
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
| G | Throw a bonus grenade (earned by a kill streak) |
| M | Mute / unmute (a small "MUTED" hint shows on the HUD) |
| Esc | Release the mouse and pause |

### Touch controls

On phones and tablets (and with `?touch=1` on a desktop browser for testing) the game shows on-screen controls, best in landscape:

| Control | Action |
|---|---|
| Left thumb, anywhere on the left side | Floating stick: move at an analog speed, push it to the edge to sprint |
| Right thumb, anywhere on the right | Drag to aim |
| FIRE | Shoot (one shot per tap, like the mouse). Keep the finger on it and drag to aim while shooting |
| GRENADE | Appears above FIRE while you hold bonus grenades |
| RELOAD | Reload |
| SPRINT | Latch sprint on / off |
| Top right: pause, mute | The touch versions of Esc and M |

Touch mode turns itself on when the primary pointer is coarse or on the first touch; starting with a mouse turns it off again, and `?touch=0` forces it off.
Touch screens have no pointer lock, so the game never asks for it there. It pauses when the page is hidden or the phone is turned upright
(tap the screen to resume), and tries fullscreen + landscape when you press START. The HUD moves out of the way of the thumbs.
The module is `src/js/touch.js`.

**Phones and tablets.** The game is plain WebGL + WebAudio and has no phone-specific build. On touch devices it renders lighter (pixel ratio capped at 1.75, a 1024 px
shadow map, no MSAA on 2x+ screens) and steps the resolution down by itself if frames stay slow. `npm run mobile` checks seven phone / tablet profiles in emulation
(sizes, pixel ratios, user agents, coarse pointer): the controls fit and do not overlap the HUD, touch targets are at least 44 px, and the game runs. Emulation
runs in Chromium, so it does not replace trying it on a real iPhone (Safari) and a real Android phone.

The title screen has a **difficulty** choice (Easy / Normal / Hard) and a **volume** slider. Both are remembered in the browser (`localStorage`).

The knight waves bring 5, 7, 9, 11 and 13 knights on Normal, spawned one at a time from the edge of the arena. You heal 25 HP between waves and get fully healed before the boss.
In the last wave (wave 5 on Normal) the boss arrives, with an HP bar, three telegraphed attacks (a sweep, a leap slam and a charge), two phase changes, and minions. Victory shows only after the boss dies.
Head shots kill a knight outright. Torso shots take about 3 hits and limbs about 4.

### Difficulty

The chosen level shows next to the wave counter (`WAVE 2 / 5 HARD`) and on the game-over and victory screens.

| | Easy | Normal | Hard |
|---|---|---|---|
| Enemy damage | x0.6 | x1 | x1.4 |
| Knight HP | x0.8 (80) | x1 (100) | x1.25 (125) |
| Knight speed | x0.9 | x1 | x1.15 |
| Waves in a run (the last is the boss) | 4 | 5 | 6 |
| Knights per wave | 3 / 5 / 7 | 5 / 7 / 9 / 11 | 7 / 9 / 11 / 13 / 15 |
| Knight windup (telegraph) | normal | normal | 20 % shorter |
| Boss HP | x0.75 (1125) | x1 (1500) | x1.3 (1950) |
| Boss reach (sweep, slam, attack distance) | x0.9 | x1 | x1.15 |
| Heal after a wave | 40 HP | 25 HP | 15 HP |
| Knights that throw daggers | 20 % | 35 % | 50 % |
| Knights that do the shield rush | 10 % | 20 % | 35 % |
| Kill streak that earns grenades | 4 kills: +1 | 5 kills: +1 | 6 kills: +1 |

The table lives in `window.Difficulty` at the top of `src/js/waves.js`; the other modules read it when they spawn or hit.

### Thrown daggers

Some knights (chosen when they spawn, never the boss) throw a dagger instead of waiting for melee. A thrower that is 6-16 m away, walking
toward you and off its 5-8 s cooldown stops, raises its sword for about 0.6 s, then throws a small spinning dagger at where you are at that
moment. It flies at 18 m/s on a slight arc, so strafing dodges it. A hit within 0.6 m of your body costs 10 HP (x the difficulty damage
multiplier) and shows the red damage arc toward the thrower. A dagger that misses sparks on a tree or rock, or kicks up dust on the ground, lies there
for 5 s and is removed. Melee knights are unchanged.

### Shield rush

A share of the knights (chosen at spawn, never the boss, never a dagger thrower) have a third attack. A rusher 7-18 m away with a clear straight
line to you stops, shouts, and a **red strip** on the ground shows where it will charge. The strip follows you until 0.3 s before the charge, then locks
(it flashes). The knight then runs along the locked line at 8 m/s. If it reaches you it hits for 16 HP (x the difficulty damage multiplier) and shoves
you back; **sidestep** it and the knight overshoots and **stumbles** for 1.4 s (also when it crashes into a tree or rock), during which it takes 1.5x
damage. Shooting a rusher while the strip is showing breaks the charge. After a cooldown of 9-13 s it can do it again.
Debug: `__dbg.knightRush(i?)`.

### Knight animation touches

* **Shield rush:** during the red-strip wind-up and the charge the knight's shield arm is posed procedurally (upper arm and forearm re-aimed, then rolled so the shield face looks along the charge), eased in and out; `_extraPose` in `enemies.js`.
* **Sword swing:** the swing keeps the clip but adds a torso twist back during the wind-up, a fast whip through the strike (the clip time follows an ease-in curve) and a forward lean, then eases out in the recovery. Dagger throws and the boss are unchanged.
* Screenshots: `npm run shots -- knight-shield knight-swing`.

### Iron Warlord entrance

The boss no longer just stands there: it drops out of the sky (0.9 s fall from 30 m), lands with a slam (shockwave ring, ring of dust, sparks, a hard camera shake, a white screen flash and the armour clang), and only then raises the sword and roars. The landing does no damage (`_tickDrop` in `boss.js`).

### Bonus weapon: grenades

You start every run with **1 grenade**. Kill several knights in a row (each within 8 s of the last; 4 / 5 / 6 on Easy / Normal / Hard) and you are given one more (at most 6 carried). The HUD
shows the streak and its timer, and the grenades you hold. Press **G** (or tap **GRENADE** on a touch screen) to lob one in an arc: it bounces off the ground,
trees and rocks, and goes off on touching a knight or when its 2 s fuse ends (the LED blinks faster as it burns down). The blast reaches 6.5 m with a falloff:
a knight dies within about 2.5 m, the boss takes 35 %, knights are thrown back and flying daggers are destroyed. It also hurts **you** (up to 30 HP x the difficulty
multiplier, plus a shove) inside 4.5 m, so throw it at something that is not standing on you. Kills by grenade keep the streak going.
Debug: `__dbg.grenade.give(n) / .throw() / .state() / .tick(sec)`.

### The revolver

The revolver is built in code (`src/js/gunmodel.js`, no model file), after an antique engraved pistol: a long octagonal barrel in dark
steel with silver engraved lines and a gold muzzle ring, a bright silver frame and cylinder covered in generated arabesque scrollwork (with
an oval cartouche on the cylinder), a swan-neck hammer, a thin scrolled trigger guard, and a walnut bird's-head grip with a cross inlay and
an engraved silver butt cap with a lanyard ring. All textures (engraving with matching bump map, walnut grain, steel) are drawn on canvases
at load time (5 textures, at most 1024 px, about 55k triangles). The header of `gunmodel.js` is the contract with `weapon.js` (gun space,
cylinder swing / spin pivots, hammer pivot, grip landmarks the hands are fitted to); if it ever fails, the old GLB revolver is used.
Review sheet: `node tools/qa/gunshot.mjs [outPrefix]` renders first person, a left profile, a close-up with the hand, a shot and two reload
frames into one PNG.

### Revolver hands and reload

The first-person hands are rigged, skinned models (the MIT WebXR generic hands), re-skinned with a generated pale skin texture, with fingernails (glossy plates raycast onto the fingertips and parented to the last joints). Their 25 joints
are a flat list, so `weapon.js` poses them with its own small forward-kinematics solver (`_poseHand`): the right hand is a firm grip, high on
the grip with the web of the hand on the backstrap, the index finger through the guard onto the trigger, the other three wrapped round the
grip and the thumb along the left of the frame. A wrist bend lets the forearm leave down and to the right, and a lofted forearm starts on the
model's own wrist edge and runs into a leather band and the sleeve.

The reload follows how it is done (and how shooters like Hunt: Showdown or Half-Life 2 show it): the gun rolls left and the left hand comes up
under the frame, the cylinder swings out into the palm, the thumb strokes the ejector rod with the muzzle up and six empties drop, the hand
dips out of view and comes back with a speedloader, lines it up behind the chambers, pushes it in and twists it to release the rounds, pulls
the empty loader away, then the palm swings the cylinder shut and the hand leaves. If the hand models were missing, the old procedural hands
and reload are used. Tuning: `__dbg.weapon.grip({ at, roll, wrist, scale, pose })` (with `?debug=1`) re-poses the right hand live.

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
src/js/gunmodel.js        the procedural engraved revolver (geometry, canvas textures, moving parts; contract in its header)
src/js/weapon.js          revolver viewmodel, rigged pale hands (grip pose + FK), recoil, flash, speedloader reload (separate scene and camera)
src/js/combat.js          hit zones, damage, knockback, helmet pop, dropped gear physics
src/js/enemies.js         animated Knight class (mixer, state machine, bone-attached gear, dagger throw, shield rush) + Enemies (incl. thrown daggers)
src/js/boss.js            Boss extends Knight
src/js/waves.js           Difficulty table, wave flow (4 / 5 / 6 waves, the last is the boss), victory
src/js/game.js            player movement, hitscan firing, damage
src/js/touch.js           on-screen touch controls (stick, aim drag, fire / reload / sprint / grenade / pause / mute)
src/js/grenade.js         bonus weapon: kill-streak grenades (throw physics, blast, HUD)
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
npm run touch                                # drives the touch controls with real multi-touch events (844x390 landscape)
npm run mobile                               # iPhone / Android / iPad profiles: layout, touch targets, overlaps, adaptive resolution
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

The 3D models (knight, gear, trees, rocks, grass, and the fallback revolver) are from Quaternius CC0 asset packs. The revolver shown in game is procedural.
The first-person hands (`assets/hand_right.glb`, `assets/hand_left.glb`) are the WebXR "generic hand" models from
[`@webxr-input-profiles/assets`](https://github.com/immersive-web/webxr-input-profiles), MIT licensed (Copyright (c) 2019 Amazon, see `assets/HANDS_LICENSE.md`).
