# Knights of the Meadow: Fix Plan

This plan is the shared brief for the queen agent and every worker. It has four parts:
what is broken (with root causes), the target architecture, the module contracts,
and the wave schedule.

The game ships as a single self-contained HTML file: `knights_out_final.html`.
That file is ~2 MB because nearly all of it is base64 GLB data on a handful of
huge lines. **Never open it with the Read tool.** After Wave A, all code lives in
`src/` and the HTML is a build output.

---

## 1. Diagnosis: what is broken and why

### 1.1 Revolver is not placed like an FPS viewmodel
- `Assets.parse()` normalizes **every** asset to 1.8 units tall. The revolver is
  short and long, so it gets blown up to ~5.7 units long, then `scale 0.22`
  leaves it ~1.25 units long, held 0.55 units from the eye. It is gigantic.
- In the revolver GLB, after glTF's Z-up to Y-up node rotation, the **barrel points +X**,
  the grip is at the −X end, and "up" is +Y. To point the barrel away from the
  camera (−Z) you need `rotation.y = +π/2`. The code instead uses
  `GUN_BASE_X = π/2`, which rolls the gun onto its side and points it the wrong way.
- `Game.update()` overwrites the rig position every frame (`z → -0.55`, `y → -0.26`),
  so the `init()` placement is meaningless.
- The gun is in the main scene, so it clips into knights and trees when you get close.
- There are no hands or arms holding it.

### 1.2 Knights' armor/sword/shield are not on their bodies
- `assets/knight.glb` is a **fully rigged Quaternius knight**: 1 skin, 45 nodes, and
  12 animation clips (`HumanArmature|Walking`, `Run`, `Run_swordAttack`,
  `Run_swordRight`, `Idle`, `Idle_swordLeft`, `Idle_swordRight`, `Death`, `Roll`,
  `Roll_sword`, `Jump`, `swordAttackJump`). Materials: `Armor`, `Boots`, `Skin`. It
  has no textures and no sword or shield mesh.
- The hand-written GLB parser ignores `skins`, `JOINTS_0/WEIGHTS_0`, and
  `animations`. The knight renders as a static mesh in its bind pose.
- The helmet, shield, and sword are added to the *wrapper group* at guessed offsets
  (`_top * 0.92`, `±_top * 0.32`), with arbitrary rotations (`rotation.z = ±π/2`).
  They float beside the body instead of being parented to bones.
- Useful bone names: `Head`, `Neck`, `Torso`, `Abdomen`, `Hips`, `Shoulder.L/R`,
  `UpperArm.L/R`, `LowerArm.L/R`, `Palm.L/R`, `MiddleHand.L/R`, `Fingers.L/R`,
  `UpperLeg.L/R`, `LowerLeg.L/R`, `Foot.L/R`.
- The armature and mesh nodes carry a **×100 scale**. A prop parented to a bone
  inherits roughly ×100 × wrapper-normalization scale, so props must be sized in
  world units and converted. The simplest approach is to place the prop in world space and
  call `bone.attach(prop)`, which preserves the world transform.

### 1.3 Knights have no movement or attack animation
- This follows from 1.2: there is no `AnimationMixer` and no clip playback. The only
  "animation" is a 5 cm vertical bob and setting `rotation.x` on the
  floating shield and sword.
- The strafing logic increments timers but never moves the knight.
- Knights overlap each other and walk through trees and rocks.

### 1.4 No gunshot animation
- Firing snaps `gunRig.position.z = -0.38` and `rotation.x += 0.28` for one frame,
  and the next frame's lerp hides it. There is no muzzle flash, light,
  smoke, hammer or cylinder motion, camera kick, tracer, or impact effect.
- The reload "animation" is a sine wobble around the wrong axis.

### 1.5 The boss never appears
- `Waves.complete()` increments `current` and then does `if (current >= 5) victory()`.
  Finishing wave 4 sets `current = 5` and shows **victory before wave 5 ever starts**.
- `Boss` constructor calls `Assets.get('greatsword')`, an asset that does not exist,
  so `null.scale` throws. Even if it reached spawn, it would crash.
- `Sfx.bossRoar` does not exist; it would also throw.
- `super()` builds a full knight (mesh, helmet, shield, sword) and then discards it.
- `Boss.update()` never updates `this.lookAt` (a zero vector) and never faces the
  player, so the boss would stand still.
- `swingBig()` raycasts against **enemies** instead of the player, so it can never hit.
- Minions spawn at the boss's position every phase without limits.
- Wave completion is checked as "every enemy in the list is dying". Enemies spawn
  over time (`respawnPending`), so killing the first ones fast completes the wave
  early. Spawns are also driven by both `setTimeout` and `update()`.

### 1.6 Killing enemies is unrealistic
- `die()` sets `rotation.x = π/2; rotation.z = π/4` in one frame. The knight
  snaps flat, pivoting around its feet.
- `userData.fade` counts down but is never applied to any material.
- The dead enemy is removed from `Enemies.list` but **never from the scene**, so
  T-posed corpses pile up forever.
- There is no hit reaction, no knockback, no blood or sparks, and no hit zones.
  Every hit does 34 damage against 40 HP, so it is always exactly two shots, head or toe.
  Swords and shields stay glued to the corpse.

### 1.7 Other defects found
- A debug "SPAWN OK (n)" badge is left on the HUD.
- The HUD module creates duplicate fallback elements. `setWave` shows "BEST" mid-game.
- The `Smite` power-up is dead code: nothing ever calls `activate()`.
- Enemy speed alternates by wave parity (`waveNumber % 2`), which is arbitrary.
- Renderer colour space is not set up for glTF materials (`outputEncoding`).
- The unused `Frog` and `pistol` assets add ~860 KB to the shipped file.

---

## 2. Target architecture

```
src/
  index.template.html     # markup + CSS + HUD skeleton, with build placeholders
  js/
    assets.js     # window.Assets: GLTFLoader + SkeletonUtils, clips, normalization
    world.js      # window.World:  ground, props, colliders, staticTargets
    sfx.js        # window.Sfx:    WebAudio synth sounds
    hud.js        # window.HUD:    DOM HUD (ammo, HP, wave, banners, boss bar)
    fx.js         # window.FX:     particles, tracers, decals, blood pools, shake
    weapon.js     # window.Weapon: revolver viewmodel, hands, fire/reload animation
    combat.js     # window.Combat: hit zones, damage, knockback, death props
    enemies.js    # window.Knight, window.Enemies: animated knights + manager
    boss.js       # window.Boss:   boss knight (extends Knight)
    waves.js      # window.Waves:  wave flow 1-4 knights, 5 = boss, victory
    game.js       # window.Game, window.Player: movement, firing, damage
    debug.js      # window.__dbg:  only active with ?debug=1, used by QA
    main.js       # bootstrap: renderer, lights, await Assets.load(), loop
tools/
  build.mjs       # embeds assets/*.glb + concatenates src/js -> knights_out_final.html
  qa/             # Playwright harness (serves locally, routes CDN to node_modules/three)
```

- **three.js r147** stays on the CDN (jsdelivr), plus `examples/js/loaders/GLTFLoader.js`,
  `examples/js/utils/SkeletonUtils.js`, and `examples/js/controls/PointerLockControls.js`.
  r147 is the last release that ships the non-module `examples/js` builds.
- jsdelivr is **blocked in the dev container**. The QA harness installs
  `three@0.147.0` as a devDependency and uses Playwright `page.route` to serve the
  CDN URLs from `node_modules/three`.
- Chromium is pre-installed at `/opt/pw-browsers`. Never run `playwright install`.
  Use the global playwright (`/opt/node22/lib/node_modules/playwright`), or
  `executablePath` pointing at the pre-installed Chromium.
- Script order in the built HTML: CDN three → CDN addons → `window.ASSETS = {...}` →
  assets, world, sfx, hud, fx, weapon, combat, enemies, boss, waves, game, debug, main.
- Only embed the assets that are used: knight, knight_helmet1, knight_shield,
  knight_boss_shield, knight_sword, revolver, birch_tree, grass, grass_2, rock.

---

## 3. Module contracts

Every module is a plain script that assigns one global. Cross-module calls are
always guarded (`if (window.FX && FX.sparks) ...`) so a module can land before its
callers or consumers.

### Assets (`src/js/assets.js`)
- `Assets.load(): Promise<void>` parses every `window.ASSETS` entry with
  `new THREE.GLTFLoader().parse(arrayBuffer, '', ok, err)` and caches `{scene, animations}`.
- `Assets.get(name, opts?)` returns a **new** `THREE.Group` wrapper whose origin is
  at the bottom-center of the asset's bounding box. It clones with
  `THREE.SkeletonUtils.clone` so skinned meshes animate independently.
  - `opts.height` (default 1.8): uniform scale so the bounding-box height equals this.
  - `opts.length`: alternative, scales so the longest horizontal extent equals this.
  - `opts.raw: true`: no recentering or normalization.
  - Return value must keep world-prop call sites working as before (`World` relies on
    the 1.8 default).
- `Assets.clips(name): THREE.AnimationClip[]`. Clip names have the `HumanArmature|`
  prefix stripped (`'Walking'`, `'Run'`, `'Death'`, `'Run_swordAttack'`, ...).
- Materials: convert or tune for this lighting (metalness ≤ 0.4, roughness ≥ 0.45) so
  the dark `Armor` material reads as steel, not black. Keep `castShadow`. Keep
  `frustumCulled = false` on skinned meshes only, because their bind-pose bounds are wrong.

### World (`src/js/world.js`)
- `World.build(scene)`, `World.colliders: {x,z,r}[]` (unchanged).
- New: `World.staticTargets: Object3D[]` (ground + trees + rocks) for bullet
  impact raycasts.

### FX (`src/js/fx.js`)
- `FX.init(scene, camera)`, `FX.update(dt)`.
- `FX.sparks(point, normal, count?)`: metal-on-armor hit.
- `FX.blood(point, dir, amount?)`: spray particles with gravity.
- `FX.dust(point, normal)`: ground, tree, or rock impact.
- `FX.smoke(point, dir?)`: muzzle smoke puff.
- `FX.tracer(from, to)`: brief streak.
- `FX.bloodPool(position, radius)`: ground decal that grows, then fades over ~20 s.
- `FX.impactDecal(point, normal)`: optional bullet mark on world surfaces.
- `FX.shake(amount)` and `FX.shakeOffset` (`THREE.Vector3`, updated in `FX.update`).
  `Game` adds it to the camera position after movement.
- Pooled and capped. No per-shot allocation of geometries or materials.

### Weapon (`src/js/weapon.js`)
- `Weapon.init(camera, renderer)` builds the revolver viewmodel plus simple low-poly hand/forearm
  in its own `Weapon.scene` with its own `Weapon.camera`, which matches the main
  camera's aspect at a fixed viewmodel FOV of about 60.
- `Weapon.render(renderer)` runs after the world render: `renderer.autoClear=false`,
  `clearDepth()`, render the viewmodel scene, restore. **No clipping into the world.**
- Revolver normalization must not depend on `Assets.get` defaults. Measure the
  bounding box and scale so the gun is ~0.30 units long. Barrel → −Z
  (`rotation.y = +π/2` from authored), held lower-right, muzzle near the crosshair line.
- `Weapon.fire()` plays the recoil animation (kick back + muzzle climb + slight roll,
  spring recovery ~180 ms), the hammer drop, a cylinder rotation by 60°, the muzzle flash
  (additive sprite/cone, ~50 ms, random roll), and a short-lived `PointLight` in the
  **world** scene at the muzzle. Returns the muzzle world position for tracers.
- `Weapon.reload(ms)`: tilt the gun left and up, swing the cylinder out, spin it, and snap it back,
  timed to `ms`.
- `Weapon.update(dt, {moving, sprinting, aimDelta})`: walk bob, sprint lowering,
  mouse-lag sway, idle breathing.
- `Weapon.muzzleWorldPosition(target: Vector3)`.

### Combat (`src/js/combat.js`)
- `Combat.zoneFor(enemy, intersection) → 'head' | 'torso' | 'limb'`, based on the
  hit object (helmet ⇒ head) and the distance of `hit.point` to `enemy.bones.head` /
  arm and leg bones.
- `Combat.damageFor(zone, enemy)`. Knights have 100 HP. A revolver head shot kills
  (~150), the torso takes 3 shots (~40), limbs take ~4 shots (~28). The boss multiplies HP, not damage.
- `Combat.onHit(enemy, hit, dir)`: sparks (armor/helmet) plus a little blood, a small
  knockback impulse handed to the enemy, and the hitmarker kind ('hit' | 'head').
- `Combat.onKill(enemy, hit, dir)`: on a head shot the helmet pops off with velocity and spin.
  The sword and shield detach to world (`scene.attach`) and fall with gravity, a
  ground bounce, and friction. Spawns a blood pool and the 'kill' hitmarker.
- `Combat.update(dt)` simulates loose props and despawns them after ~15 s.

### Knight and Enemies (`src/js/enemies.js`)
- `class Knight` (exported as `window.Knight` so `Boss` can extend it):
  - `.mesh` is the root `Group` in the scene. `mesh.userData.enemy = this`.
  - `.type` ('knight'), `.hp`, `.maxHp`, `.dead`, `.bones {head, torso, hips,
    handR, handL, armL, armR, legL, legR}`, `.helmet`, `.sword`, `.shield`.
  - `.mixer` (`THREE.AnimationMixer`) and `.actions{}` keyed by clip name, with
    cross-fades (~0.25 s) between states.
  - States: `approach` (Walking, or Run at a distance or on later waves, speed matched
    to the clip so feet don't skate), `combatIdle` (Idle_swordRight), `windup`
    (start of the attack clip, telegraph ≥ 0.45 s), `attack` (Run_swordAttack played in
    place; damage is applied **at the swing frame**, only if the player is in front and in
    range), `recover`, `stagger` (procedural torso pitch-back after the mixer
    update, ~0.25 s), and `dead` (Death clip, clamp last frame).
  - The helmet is attached to `Head`, the sword to the right hand (`Palm.R`/`MiddleHand.R`, blade
    along the forearm), and the shield to the left forearm (`LowerArm.L`, face outward).
    **Verify visually with screenshots.**
  - Movement: separation from other knights, steering around `World.colliders`,
    faces the player with smoothed yaw. The model's forward axis must be verified;
    don't assume `lookAt` is correct.
  - `.takeHit({damage, zone, point, dir})` applies damage, sets stagger, and calls `die()` at ≤ 0.
  - `.die(hit)` plays Death, calls `Combat.onKill`, lingers ~8 s, sinks into the
    ground over 2 s, **removes from the scene**, and disposes of its resources. Notifies
    `Waves.onEnemyKilled(this)` exactly once.
- `Enemies`: `list`, `add(e)`, `update(dt, playerPos)`, `rayTargets()` (live
  enemies' meshes), `aliveCount()`, `findByObject(obj)` (walk up the parents to
  `userData.enemy`), `clear()`.

### Boss (`src/js/boss.js`)
- `class Boss extends Knight` (`window.Boss`). The model is ~2.3× knight height (~4.2 u) with a
  gold/dark armor tint, the `knight_boss_shield`, and a scaled-up `knight_sword` as a
  greatsword. HP ~1500, with name and HP shown via `HUD.bossBar`.
- Phases at 66% and 33%: faster, with new attacks. Attacks: a wide sweep (Run_swordAttack),
  a leap slam (`swordAttackJump`, AoE with a ground shockwave via FX and shake), and
  a charge (Run). Each has a clear telegraph and a damage frame tested against the **player**.
- Summons at most 2 minions per phase transition, at a spawn ring and not on top of the boss.
- Death: a slow, heavy Death clip, a big FX burst, and `Waves.onEnemyKilled` → victory.

### Waves (`src/js/waves.js`)
- Waves 1–4 are knights (5, 7, 9, 11), spawned one at a time from the arena edge (ring
  radius ~30, away from the player's view direction when possible). Wave 5 is **Boss**.
- Track `pending` (not yet spawned) and `alive`. A wave completes only when both are 0.
- Between waves: 4 s countdown banner. Wave 5 gets a boss intro banner and roar.
- Victory only after the boss dies. `HUD.victory(stats)`.
- `Waves.onEnemyKilled(enemy)` updates the kill counter and HUD "enemies left".

### HUD and Sfx
- `HUD`: `init`, `setWave(n, total)`, `banner(title, sub, ms)`,
  `updateAmmo(ammo, max, reloading)`, `updateHP(hp)`, `playerHit(fromAngle?)`
  (directional damage indicator), `hitmark('hit'|'head'|'kill')`,
  `bossBar(show, frac, name)`, `setKills(n)`, `setEnemiesLeft(n)`,
  `gameOver(stats)`, `victory(stats)`. Remove the SPAWN badge and the duplicate
  fallback element creation.
- `Sfx`: `shoot` (layered noise burst + low thump + tail), `dryFire`,
  `reload`, `cock`, `swing` (whoosh), `clang` (sword vs armor), `armorHit`,
  `fleshHit`, `hurt`, `death`, `bossRoar`, `footstep`, `waveStart`, `victory`.

### Game / Player (`src/js/game.js`)
- Keeps the movement, colliders, and HP from today. On fire: `Weapon.fire()`, then a hitscan against
  `Enemies.rayTargets()` **and** `World.staticTargets`, take the nearest.
  - Enemy: `Combat.zoneFor` → `Combat.damageFor` → `enemy.takeHit` → `Combat.onHit`
    or `onKill` → `HUD.hitmark`.
  - World: `FX.dust` + `FX.impactDecal`.
  - Always: `FX.tracer(muzzle, point)`, `FX.shake(small)`, `Sfx.shoot`.
- Reload: `Weapon.reload(1600)`. Camera kick on fire (pitch up, recover).
- Player hurt: `HUD.playerHit(angle from attacker)`, `FX.shake`.

### Debug (`src/js/debug.js`, only with `?debug=1`)
`__dbg.godMode(on)`, `__dbg.skipToWave(n)`, `__dbg.spawn('knight'|'boss', dist,
angleDeg)`, `__dbg.freezeAI(on)`, `__dbg.lookAt(x,y,z)`, `__dbg.killAll()`,
`__dbg.state()` returns a JSON snapshot (wave, alive, pending, hp, ammo, enemies with
state and clip names). Modules may add their own `__dbg.<module>` helpers.

### Main (`src/js/main.js`)
Creates the renderer (`outputEncoding = THREE.sRGBEncoding`, shadows), scene, fog, and lights.
Shows "Loading…" on the start button until `await Assets.load()` resolves. Then it runs
`World.build`, `FX.init`, `Weapon.init`, `Game.init`, and `HUD.init`. Start button → pointer lock
+ `Waves.start(1)`. Loop: `Game.update`, `Enemies.update`, `Waves.update`,
`Combat.update`, `FX.update`, `Weapon.update`, `renderer.render`, `Weapon.render`.
Each call is guarded so the loop survives a missing module.

---

## 4. Waves of work

Rules for every worker:
- **Own only the files assigned to you.** Workers run concurrently in one checkout.
  If you need a change in someone else's file, report it in your result instead of making it.
- Never read `knights_out_final.html` with the Read tool. Rebuild it with `node tools/build.mjs`.
- Do not `git commit` or push. The queen commits after each wave.
- Before reporting done: `node tools/build.mjs`, then the QA smoke test. Then **look at
  screenshots** of your feature with the Read tool on the PNG. Report what you verified, with
  screenshot paths, and anything left unverified.

| Wave | Worker | Owns | Goal |
|---|---|---|---|
| A | A1 | `src/**`, `tools/build.mjs` | Mechanically extract today's code into the `src/` modules above, with no behavior change. Write the build script, create the guarded `main.js` loop and `debug.js`, and verify the built file boots like the original. |
| A | A2 | `tools/qa/**`, `package.json` | Playwright harness with local server, CDN → `node_modules/three` routing, smoke test (boot, no console errors, start, spawn, fire, hit), and screenshot helpers. Includes `npm run build` / `npm run qa` scripts. |
| B | B1 | `assets.js`, `world.js` | GLTFLoader + SkeletonUtils loader, clips, materials, `staticTargets`, async boot. |
| B | B2 | `weapon.js`, `game.js` | FPS viewmodel placement, hands, fire/reload animations, muzzle flash and light, camera kick, firing pipeline per the contracts. |
| B | B3 | `fx.js` | Pooled particles, tracers, decals, blood pools, shake. |
| B | B4 | `waves.js`, `hud.js`, `sfx.js`, `index.template.html` | Fixed wave flow (boss wave 5, alive/pending), HUD API, better SFX, remove debug badge. |
| C | C1 | `enemies.js` | Animated knights with bone-attached gear, state machine, steering, death lifecycle. |
| C | C2 | `combat.js` | Hit zones, damage model, hit and kill reactions, physics props, blood pools. |
| D | D1 | `boss.js` | Boss per contract. |
| D | D2 | glue only, as assigned by the queen | Integration pass: run the full game flow via `__dbg`, fix cross-module mismatches. Report anything outside its scope. |
| E | E1 | review | Visual QA: screenshot sweep (gun idle/fire/reload, knight walk/attack close-up, gear placement from front/side, death sequence, boss intro/attack/death). Fixes small issues, reports large ones. |
| E | E2 | review | Code review for runtime errors, leaks (meshes never removed, listeners), perf (allocations per frame), and gameplay balance. Fixes or reports. |
| F | as needed | from E's reports | Fix wave, then the queen runs the final full QA and updates the README. |

### Acceptance criteria (all must be shown with screenshots or `__dbg.state()`)
1. The revolver sits lower-right, barrel forward, sized like an FPS pistol, with no clipping.
   It visibly recoils, flashes, and lights the scene when fired, and plays a reload animation.
2. The knights' helmet is on the head, the sword is in the right hand, and the shield is on the left forearm. All three
   stay attached through walking, attacking, and dying.
3. Knights visibly walk or run with leg animation, wind up, and swing the sword. Damage
   only lands on the swing.
4. Shots produce a tracer, impact FX, and hit reactions. A head shot pops the helmet. Kills play the Death
   animation, the gear drops, a blood pool forms, and the corpse sinks and is removed from the scene.
5. Waves 1→4 progress correctly, wave 5 spawns the boss with an intro and HP bar, and victory
   only shows after the boss dies.
6. There are no console errors in a full scripted playthrough with `?debug=1` (god mode, skip waves).
