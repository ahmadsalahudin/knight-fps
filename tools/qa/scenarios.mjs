// Screenshot scenario registry for tools/qa/shoot.mjs.  EXTEND ME.
//
//   node tools/qa/shoot.mjs --list
//   node tools/qa/shoot.mjs gun-fire knight-close
//
// A scenario is either an async function (page, h) or an object
//   { desc, start = true, god = true, viewport?, query?, run: async (page, h) => {...} }
// `start`  : click START (and reset the view) before run(); set false for the title screen.
// `god`    : __dbg.godMode(true) after start so wandering knights cannot kill the player.
// `run`    : sets the scene up and calls `h.shot()` (-> tools/qa/out/<scenario>.png, then <scenario>-2.png, ...)
//            or `h.shot('label')` (-> tools/qa/out/<scenario>-label.png). Whatever run() returns is printed as JSON.
//
// Helpers on `h` (see lib.mjs createHelpers for the full list):
//   h.boot() h.start() h.wait(ms) h.frames(n) h.waitFor(fn, arg, timeoutMs)
//   h.dbg(name, ...args)  h.godMode(on) h.freezeAI(on) h.killAll() h.skipToWave(n) h.lookAt(x,y,z) h.state()
//   h.spawn(type, dist, angleDeg) -> {i,x,y,z,hp,dist,...}   h.aimAt(enemy, heightAboveFeet)   h.enemies()  h.player()
//   h.clean()  (stop waves + remove enemies + freezeAI)    h.fire() -> {fired, method}
//   h.pause() h.resume() h.advance(ms[, stepMs]) h.timeScale(s)   <- virtual game clock (performance.now)
//   h.shot([label]) h.eval(fn, arg) h.warn(msg) h.log(...)
//
// Deterministic recipe for animation frames: h.pause(); <trigger the action>; await h.advance(30); await h.shot();
// (headless swiftshader renders at only ~5-10 fps, so never rely on real-time waits for animation timing).

export const scenarios = {
  boot: {
    desc: 'Title screen right after load (START overlay), no input.',
    start: false,
    run: async (page, h) => {
      await h.wait(500);
      await h.shot();
    },
  },

  'gun-idle': {
    desc: 'First-person view with the revolver at rest, arena cleared, level view.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(400);
      await h.shot();
    },
  },

  'gun-fire': {
    desc: 'Revolver ~30 ms after a shot (muzzle flash, recoil) and again ~110 ms after (recovery).',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(400);
      const f = await h.fire();
      await h.advance(30);
      await h.shot('30ms');
      await h.advance(80);
      await h.shot('110ms');
      return f;
    },
  },

  'knight-close': {
    desc: 'One knight spawned 4 m ahead, AI frozen, camera aimed at its torso.',
    run: async (page, h) => {
      await h.clean();
      const k = await h.spawn('knight', 4, 0);
      if (!k) h.warn('knight-close: __dbg.spawn unavailable; screenshotting whatever is in view');
      else await h.aimAt(k, 1.1);
      await h.pause();
      await h.advance(500);
      await h.shot();
      return k;
    },
  },

  'wave-state': {
    desc: 'Prints __dbg.state() (JSON) a moment after wave 1 starts and saves a screenshot.',
    run: async (page, h) => {
      await h.wait(1500);
      const state = await h.state();
      await h.shot();
      return state;
    },
  },

  // ---- B1 (assets.js / world.js) ----------------------------------------------------------------------------------
  'b1-knight-clips': {
    desc: 'B1: logs Assets.clips("knight") names/durations and the knight bone names (original glTF + sanitised).',
    start: false,
    run: async (page, h) => {
      const info = await page.evaluate(() => {
        const k = Assets.get('knight');
        const bones = Assets.bones(k);
        const sanitised = {};
        for (const [orig, b] of Object.entries(bones)) sanitised[orig] = b.name;
        return {
          loaded: Assets.isLoaded(), failed: Assets.failed, srgbOutput: Assets.srgbOutput,
          names: Assets.names(),
          clips: Assets.clips('knight').map((c) => `${c.name} (${c.duration.toFixed(2)}s, ${c.tracks.length} tracks)`),
          anyPrefixLeft: Assets.clips('knight').some((c) => c.name.includes('|')),
          boneNames: Object.keys(bones),
          sanitisedBoneNames: sanitised,
          boneLookup: ['Head', 'Palm.R', 'Palm.L', 'LowerArm.L', 'Torso', 'Hips'].map((n) => [n, !!Assets.bone(k, n)]),
          knightNativeSize: Assets.size('knight'),
          knightWrapperScale: k.scale.x,
          raw: (() => { const r = Assets.get('knight', { raw: true }); return { scale: r.scale.x, pos: r.children[0].position.toArray() }; })(),
        };
      });
      h.log('clips:', JSON.stringify(info.clips));
      h.log('bones:', info.boneNames.join(', '));
      return info;
    },
  },

  'b1-world': {
    desc: 'B1: the meadow in sRGB output: level view forward, then turned 90 degrees to the right (trees, rocks, grass).',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(300);
      await h.shot('forward');
      await h.lookAt(20, 3, -4);
      await h.advance(100);
      await h.shot('right');
      return page.evaluate(() => {
        // staticTargets raycast sanity: straight down from the player must hit the ground, a ray at a tree trunk its mesh
        const rc = new THREE.Raycaster(); const p = Game.playerObj.position;
        rc.set(new THREE.Vector3(p.x, 5, p.z), new THREE.Vector3(0, -1, 0));
        const down = rc.intersectObjects(World.staticTargets, true)[0];
        const tree = World.staticTargets.find((o) => o.userData.asset === 'birch_tree');
        const tp = tree.position; let toTree = null;
        for (let y = 0.5; y < 7 && !toTree; y += 0.5) for (let dx = -1.5; dx <= 1.5 && !toTree; dx += 0.5) {
          rc.set(new THREE.Vector3(tp.x + dx, y, tp.z + 12), new THREE.Vector3(0, 0, -1));
          toTree = rc.intersectObjects([tree], true)[0] || null;
        }
        return { colliders: World.colliders.length, staticTargets: World.staticTargets.length,
          groundIsFirst: World.staticTargets[0].name === 'ground',
          rayDown: down && { obj: down.object.name || down.object.type, dist: +down.distance.toFixed(2) },
          rayAtTree: toTree && { mesh: toTree.object.name, dist: +toTree.distance.toFixed(2) } };
      });
    },
  },

  'b1-knight-close': {
    desc: 'B1: game knight (old enemies.js rig, bind pose) 3 m ahead, aimed at its torso.',
    run: async (page, h) => {
      await h.clean();
      const k = await h.spawn('knight', 3, 0);
      if (k) await h.aimAt(k, 1.0);
      await h.pause();
      await h.advance(300);
      await h.shot();
      return k;
    },
  },

  'b1-knight-pose': {
    desc: 'B1: standalone Assets.get("knight") instances 3 m ahead playing Walking / Run_swordAttack / Death via a mixer (proves skinning + clip names).',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      const info = await page.evaluate(() => {
        const cam = Game.camera; const scene = Game.scene;
        window.__b1 = [];
        const defs = [['Walking', 0.3, -1.6], ['Run_swordAttack', 0.35, 0], ['Death', 1.0, 1.6]];
        for (const [clipName, t, x] of defs) {
          const m = Assets.get('knight');
          m.position.set(x, 0, -3.2);
          m.rotation.y = 0;   // model faces +Z in bind pose? record by screenshot
          scene.add(m);
          const mixer = new THREE.AnimationMixer(m);
          const a = mixer.clipAction(Assets.clip('knight', clipName));
          a.play(); mixer.setTime(t);
          window.__b1.push(m);
        }
        cam.lookAt(0, 1.0, -3.2);
        return window.__b1.map((m) => { const b = new THREE.Box3().setFromObject(m); return { min: b.min.toArray().map((v) => +v.toFixed(2)), max: b.max.toArray().map((v) => +v.toFixed(2)) }; });
      });
      await h.pause();
      await h.advance(200);
      await h.shot();
      return info;
    },
  },
  'b3-fx-demo': {
    desc: 'B3: __dbg.fx.demo() 5 m ahead (dust, sparks, blood, blood pool, bullet decals, muzzle smoke, tracers) at ~50 ms, ~400 ms and ~2.2 s.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(300);
      const spawned = await page.evaluate(() => __dbg.fx.demo());
      await h.advance(50, 25);
      await h.shot('50ms');
      const s50 = await page.evaluate(() => __dbg.fx.stats());
      await h.advance(350, 50);
      await h.shot('400ms');
      const s400 = await page.evaluate(() => __dbg.fx.stats());
      await h.advance(1800, 50);
      await h.shot('2s');
      const s2000 = await page.evaluate(() => __dbg.fx.stats());
      return { spawned, s50, s400, s2000 };
    },
  },

  'b3-fx-close': {
    desc: 'B3: same FX demo at 2.4 m with the camera pitched down 0.3 rad (size/readability close up) at ~50 ms and ~250 ms.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => { Game.camera.rotation.x = -0.3; });
      await h.pause();
      await h.advance(300);
      await page.evaluate(() => __dbg.fx.demo(2.4));
      await h.advance(50, 25);
      await h.shot('50ms');
      await h.advance(200, 50);
      await h.shot('250ms');
      return await page.evaluate(() => __dbg.fx.stats());
    },
  },

  'b4-hud': {
    desc: 'B4: HUD forced on: wave banner, boss bar (62%), HP 38 + low-HP pulse, 3 rounds, two directional damage arcs, hitmarker kinds (crops).',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await page.evaluate(() => {
        HUD.setWave(3, 5); HUD.setKills(7); HUD.setEnemiesLeft(6);
        HUD.updateAmmo(3, 6, false); HUD.updateHP(38);
        HUD.bossBar(true, 1, 'The Iron Warlord'); HUD.bossBar(true, 0.62, 'The Iron Warlord');
        HUD.banner('Wave 3', '9 knights approach', 8000);
        HUD.playerHit(1.15); HUD.playerHit(-2.5);   // front-right, rear-left
        HUD.hitmark('head');
      });
      await h.advance(120, 30);
      await h.shot();
      const crop = { x: 560, y: 300, width: 160, height: 120 };
      for (const kind of ['hit', 'head', 'kill']) {
        await page.evaluate((k) => HUD.hitmark(k), kind);
        await h.advance(45, 15);
        await h.shot('mark-' + kind, { clip: crop });
      }
      return await page.evaluate(() => ({ banner: document.getElementById('bannerTitle').textContent, boss: document.getElementById('bossPct').textContent }));
    },
  },

  'b4-wave-flow': {
    desc: 'B4: godMode, walk waves 1->5 with __dbg.killAll/skipToWave, log state at each step, capture banners, boss intro, boss bar, victory.',
    run: async (page, h) => {
      const log = [];
      const snap = async (label) => {
        const w = await page.evaluate(() => Waves.snapshot());
        const s = await h.state();
        log.push({ label, wave: w.wave, st: w.state, pend: w.pending, alive: w.alive, kills: w.kills, cd: w.countdown,
          listLen: s && s.enemies ? s.enemies.length : null, bossErr: w.bossError, fallback: w.bossFallback });
        return w;
      };
      await h.clean();
      await h.godMode(true);
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(() => { __dbg.clear(); Waves.stop(); Waves.start(1); });
      await h.advance(200, 100);
      await h.shot('w1-banner');
      await snap('w1 start');
      for (let n = 1; n <= 4; n++) {
        if (n > 1) { await h.advance(300, 100); await snap('w' + n + ' start'); }
        // kill whatever is out; the wave must NOT complete while knights are still pending
        let guard = 0, checkedEarly = false;
        for (;;) {
          await h.advance(500, 100);
          const w = await page.evaluate(() => Waves.snapshot());
          if (!checkedEarly && w.pending > 0) { await h.killAll(); checkedEarly = true; await h.advance(200, 100); await snap('w' + n + ' after first kill (pending>0, still fighting)'); }
          if (w.state === 'countdown' || ++guard > 80) break;
          if (w.alive > 0) await h.killAll();
        }
        await snap('w' + n + ' cleared');
        await h.advance(300, 100);
        await h.shot('w' + n + '-countdown');
        await h.advance(4300, 100);
      }
      // wave 5: boss
      await h.advance(100, 100);
      await snap('w5 start');
      await h.shot('w5-intro');
      await h.advance(2500, 100);
      await snap('w5 +2.6s (boss spawned?)');
      await h.shot('w5-boss');
      await h.killAll();
      await h.advance(300, 100);
      await snap('w5 boss killed');
      await h.advance(3600, 100);
      await snap('victory');
      await h.shot('victory');
      return log;
    },
  },

  // ---- B2 (weapon.js / game.js) ------------------------------------------------------------------------------------
  'b2-gun-idle': {
    desc: 'B2: revolver viewmodel at rest (lower right, barrel forward, gloved hand), level view, arena empty.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(400);
      await h.shot();
      return page.evaluate(() => window.__dbg && __dbg.weapon && __dbg.weapon.state());
    },
  },

  'b2-gun-fire': {
    desc: 'B2: one shot, virtual clock paused: flash + recoil at ~30 ms, ~70 ms, recovery at ~200 ms and ~400 ms (world light, camera kick, tracer).',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(400);
      const f = await h.fire();
      const st = () => page.evaluate(() => __dbg.weapon.state());
      await h.advance(30);
      await h.shot('30ms');
      const s30 = await st();
      await h.advance(40);
      await h.shot('70ms');
      await h.advance(130);
      await h.shot('200ms');
      const s200 = await st();
      await h.advance(200);
      await h.shot('400ms');
      return { fire: f, s30, s200, ammo: await page.evaluate(() => [Game.ammo, Game.shots]) };
    },
  },

  'b2-gun-reload-mid': {
    desc: 'B2: reload animation (tilt, cylinder swung out, left hand loading) at ~400 ms, ~850 ms and ~1300 ms; ammo refills at 1600 ms.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      await h.advance(300);
      const f = await h.fire();                       // spend a round so R is allowed
      await h.advance(60);
      await page.evaluate(() => Game.tryReload());
      await h.advance(400);
      await h.shot('400ms');
      await h.advance(450);
      await h.shot('850ms');
      await h.advance(450);
      await h.shot('1300ms');
      const mid = await page.evaluate(() => ({ ammo: Game.ammo, reloadTimer: Math.round(Game.reloadTimer), weapon: __dbg.weapon.state().reloading }));
      await h.advance(500);
      const end = await page.evaluate(() => ({ ammo: Game.ammo, reloadTimer: Math.round(Game.reloadTimer), weapon: __dbg.weapon.state().reloading }));
      return { fire: f, mid, end };
    },
  },

  'b2-gun-near-knight': {
    desc: 'B2: knight 1 m ahead (AI frozen), camera on its torso: the viewmodel is drawn over it (no clipping); then a point-blank shot.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      const k = await h.spawn('knight', 1.0, 0);
      if (k) await h.aimAt(k, 1.2);
      await h.pause();
      await h.advance(300);
      await h.shot('before');
      const f = await h.fire();
      await h.advance(35);
      await h.shot('fired');
      const res = await page.evaluate(() => ({ ammo: Game.ammo, shots: Game.shots, hits: Game.hits, kills: Game.kills, hp: Enemies.list.map((e) => (e.hp !== undefined ? e.hp : e.mesh.userData.hp)), lastHit: window.__lastHitInfo ? { zone: window.__lastHitInfo.zone, damage: window.__lastHitInfo.damage, killed: window.__lastHitInfo.killed, distance: +window.__lastHitInfo.distance.toFixed(2) } : null }));
      return { knight: k, fire: f, res };
    },
  },

  // ---- C2 (combat.js) ----------------------------------------------------------------------------------------------
  // ---- C1 (enemies.js: animated knights, bone-attached gear, state machine, death lifecycle) ---------------------------------
  // Knights are posed with __dbg.knight.pose(i, state, progress) (AI + movement held, animation running) so frames are deterministic.
  // Long stretches of game time are fast-forwarded inside the page (c1FastForward, no rendering) because swiftshader is slow.
  'c1-gear-front': {
    desc: 'C1: knight 2.2 m ahead in combat idle, front view: helmet on the head, sword in the right fist, shield on the left forearm.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      const k = await h.spawn('knight', 2.2, 0);
      await page.evaluate((i) => __dbg.knight.pose(i, 'combatIdle', 0), k.i);
      await h.freezeAI(false);
      await h.aimAt(k, 1.0);
      await h.pause();
      await h.advance(600, 50);
      await h.shot();
      return { knight: k, gear: await page.evaluate((i) => __dbg.knight.gear(i), k.i), info: await page.evaluate((i) => __dbg.knight.info(i), k.i) };
    },
  },

  'c1-gear-side': {
    desc: 'C1: same knight turned to show its right side (sword), left side (shield) and back, in combat idle.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      const k = await h.spawn('knight', 2.4, 0);
      await page.evaluate((i) => __dbg.knight.pose(i, 'combatIdle', 0), k.i);
      await h.freezeAI(false);
      await h.aimAt(k, 1.0);
      await h.pause();
      const out = {};
      for (const [label, yaw] of [['right', Math.PI / 2], ['left', -Math.PI / 2], ['back', Math.PI]]) {
        await page.evaluate(([i, y]) => __dbg.knight.pose(i, 'combatIdle', 0, y), [k.i, yaw]);
        await h.advance(500, 50);
        await h.shot(label);
        out[label] = await page.evaluate((i) => __dbg.knight.gear(i), k.i);
      }
      return out;
    },
  },

  'c1-walk': {
    desc: 'C1: two knights walking / running toward the player; two frames 0.35 s apart (legs must differ), feet speed matched to ground speed.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      await h.spawn('knight', 6, -14);
      await h.spawn('knight', 15, 16);
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(c1FastForward, { sec: 0.7 });
      const feet = () => page.evaluate(() => Enemies.list.map((e) => { const f = (n) => Assets.bone(e.model, n).getWorldPosition(new THREE.Vector3()); const l = f('Foot.L'), r = f('Foot.R'); return { clip: e.currentClip, state: e.state, speed: +e._speed.toFixed(2), footLy: +l.y.toFixed(3), footRy: +r.y.toFixed(3), footDz: +(l.z - r.z).toFixed(3), x: +e.mesh.position.x.toFixed(2), z: +e.mesh.position.z.toFixed(2) }; }));
      const f1 = await feet();
      await h.aimAt({ x: -1.5, y: 0, z: -5.5 }, 1.0);
      await h.advance(40, 20);
      await h.shot('a');
      await page.evaluate(c1FastForward, { sec: 0.33 });
      await h.advance(40, 20);
      const f2 = await feet();
      await h.shot('b');
      return { frame1: f1, frame2: f2 };
    },
  },

  'c1-walk-side': {
    desc: 'C1: side view of a walking knight and a running knight (the fast-forward uses a fake player position so they walk across the view): gear stays on the body, two frames 0.3 s apart.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      await h.spawn('knight', 6, 0);
      await h.spawn('knight', 6, 0);
      await page.evaluate(() => { Enemies.list[0].mesh.position.set(-1.2, 0, -7.5); Enemies.list[1].mesh.position.set(1.4, 0, -2.0); });
      // AI stays frozen for the rendered frames (the camera is the player); c1FastForward drives Enemies.update itself
      await h.pause();
      const target = { x: 0, z: -17.5 };      // 10 m from the walker (walks), 15.5 m from the runner (runs); both move along -Z, the camera looks along +X
      await page.evaluate(c1FastForward, { sec: 0.8, target });
      const place = () => page.evaluate(() => { const c = Game.camera; c.position.set(5.2, 1.5, -7.5); c.lookAt(0, 1.0, -7.2); c.updateMatrixWorld(true); });
      const rep = () => page.evaluate(() => Enemies.list.map((e) => { e.mesh.updateMatrixWorld(true); return { clip: e.currentClip, state: e.state, speed: +e._speed.toFixed(2), x: +e.mesh.position.x.toFixed(2), z: +e.mesh.position.z.toFixed(2), gear: ['helmet:Head', 'sword:Palm.R', 'shield:LowerArm.L'].map((q) => { const [k, b] = q.split(':'); return +e[k].getWorldPosition(new THREE.Vector3()).distanceTo(Assets.bone(e.model, b).getWorldPosition(new THREE.Vector3())).toFixed(3); }) }; }));
      const out = [];
      for (const lab of ['a', 'b', 'c']) {
        await page.evaluate(() => { Game.update = function () {}; });   // keep the free camera where we put it
        await place();
        await h.advance(30, 15);
        await h.shot(lab);
        out.push(await rep());
        await page.evaluate(c1FastForward, { sec: 0.2, target });
      }
      return out;
    },
  },

  'c1-waves-ff': {
    desc: 'C1: integration without rendering: waves 1-5 with Waves.update + Enemies.update + Combat.update, everything killed through __dbg.killAll; logs wave transitions, kills, list length and scene child count (leak check).',
    viewport: { width: 480, height: 270 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      const r = await page.evaluate(c1WaveRun, { maxT: 600 });
      await h.advance(60, 30);
      await h.shot();
      return r;
    },
  },

  'c1-windup': {
    desc: 'C1: telegraph of the sword attack: the sword rises and holds (start, middle, end of the 0.7 s windup), front and side view.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      const k = await h.spawn('knight', 2.3, 0);
      await h.freezeAI(false);
      await h.aimAt(k, 1.1);
      await h.pause();
      const out = [];
      for (const p of [0, 0.5, 1]) {
        await page.evaluate(([i, p]) => __dbg.knight.pose(i, 'windup', p), [k.i, p]);
        await page.evaluate(c1FastForward, { sec: 0.4 });   // let the crossfade finish
        await h.advance(40, 20);
        await h.shot('front-' + Math.round(p * 100));
        out.push(await page.evaluate((i) => __dbg.knight.info(i), k.i));
      }
      await page.evaluate((i) => __dbg.knight.pose(i, 'windup', 1, Math.PI / 2), k.i);
      await h.advance(100, 50);
      await h.shot('side-100');
      return { info: out, windupTime: await page.evaluate((i) => Enemies.list[i].windupTime, k.i) };
    },
  },

  'c1-attack-swing': {
    desc: 'C1: the strike seen from the side (raised, damage frame, follow-through) and from the front; gear distances stay constant.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      const k = await h.spawn('knight', 2.5, 0);
      await h.freezeAI(false);
      await h.aimAt(k, 1.1);
      await h.pause();
      const gear = [];
      for (const u of [0.05, 0.4, 0.61, 0.85]) {
        await page.evaluate(([i, u]) => __dbg.knight.pose(i, 'attack', u, Math.PI / 2), [k.i, u]);   // right side (sword arm) toward the camera
        await page.evaluate(c1FastForward, { sec: 0.35 });
        await h.advance(40, 20);
        await h.shot('side-' + Math.round(u * 100));
        gear.push({ u, g: await page.evaluate((i) => __dbg.knight.gear(i), k.i) });
      }
      await page.evaluate(([i, u]) => __dbg.knight.pose(i, 'attack', u, 0), [k.i, 0.61]);
      await page.evaluate(c1FastForward, { sec: 0.35 });
      await h.advance(40, 20);
      await h.shot('front-61');
      return { gear };
    },
  },

  'c1-attack-live': {
    desc: 'C1: live attack on a non-god player (no rendering, fast-forwarded): the state machine cycle and the HP of the player; damage must land only at the swing frame.',
    viewport: { width: 480, height: 270 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      const k = await h.spawn('knight', 6, 0);
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(() => { __dbg.godMode(false); Game.godMode = false; Game.playerHP = 100; });
      const r = await page.evaluate(c1FastForward, { sec: 14, step: 1 / 60, record: k.i });
      await page.evaluate(() => { __dbg.godMode(true); });
      await h.advance(60, 30);
      await h.shot();
      return r;
    },
  },

  'c1-death-sequence': {
    desc: 'C1: lethal hit on a knight: Death clip at 0 s, 1 s, 9 s (corpse sinking), 11 s (removed from the scene); gear flags and __dbg.state() logged.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      const k = await h.spawn('knight', 3.2, 0);
      await page.evaluate((i) => __dbg.knight.pose(i, 'combatIdle', 0), k.i);
      await h.freezeAI(false);
      await h.aimAt(k, 0.9);
      await h.pause();
      await h.advance(300, 50);
      await page.evaluate((i) => { window.__c1k = Enemies.list[i]; }, k.i);
      const snap = (label) => page.evaluate((label) => {
        const e = window.__c1k;
        return { label, dead: e.dead, state: e.state, clip: e.currentClip, inList: Enemies.list.includes(e), inScene: !!e.mesh.parent, y: +e.mesh.position.y.toFixed(2),
          loose: { helmet: !!(e.helmet && e.helmet.userData.loose), sword: !!(e.sword && e.sword.userData.loose), shield: !!(e.shield && e.shield.userData.loose) },
          kills: Game.kills, alive: Enemies.aliveCount(), listLen: Enemies.list.length };
      }, label);
      const log = [await snap('before')];
      await page.evaluate(() => __dbg.killAll());
      log.push(await snap('hit+0 (dead set synchronously)'));
      await h.advance(60, 30);
      await h.shot('0s');
      await page.evaluate(c1FastForward, { sec: 0.94 });
      await h.advance(60, 30);
      await h.shot('1s');
      log.push(await snap('1 s'));
      await page.evaluate(c1FastForward, { sec: 2.9 });
      await page.evaluate(() => { const p = window.__c1k.mesh.position; Game.camera.lookAt(p.x, 0.2, p.z); });
      await h.advance(60, 30);
      await h.shot('4s');
      log.push(await snap('4 s'));
      await page.evaluate(c1FastForward, { sec: 4.9 });
      await h.advance(60, 30);
      await h.shot('9s');
      log.push(await snap('9 s'));
      await page.evaluate(c1FastForward, { sec: 1.9 });
      await h.advance(60, 30);
      await h.shot('11s');
      log.push(await snap('11 s'));
      return { log, state: await h.state() };
    },
  },

  'c1-hit-stagger': {
    desc: 'C1: a body shot on an approaching knight: stagger (torso pitch-back, state stagger), knockback, then it recovers and keeps coming.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      const k = await h.spawn('knight', 4.5, 0);
      await h.freezeAI(false);
      await h.aimAt(k, 1.1);
      await h.pause();
      await h.advance(200, 50);
      const info = () => page.evaluate((i) => { const e = Enemies.list[i]; return { st: e.state, hp: e.hp, flinch: +e._flinch.toFixed(2), kb: [+e.knockback.x.toFixed(2), +e.knockback.z.toFixed(2)], z: +e.mesh.position.z.toFixed(2) }; }, k.i);
      const out = [await info()];
      const f = await h.fire();
      await h.advance(80, 20);
      await h.shot('80ms');
      out.push(await info());
      await page.evaluate(c1FastForward, { sec: 0.3 });
      out.push(await info());
      await page.evaluate(c1FastForward, { sec: 0.7 });
      await h.advance(40, 20);
      out.push(await info());
      await h.shot('1s');
      return { fire: f, out };
    },
  },

  'c1-steer': {
    desc: 'C1: six knights converge on the player through the trees: min spacing between knights and collider penetration over 14 s (fast-forwarded) + two frames.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      for (let a = 0; a < 6; a++) await h.dbg('spawn', 'knight', 14 + (a % 2) * 5, -150 + a * 60);
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(() => { __dbg.godMode(true); });
      const r1 = await page.evaluate(c1FastForward, { sec: 9, metrics: true });
      await h.aimAt({ x: 0, y: 0, z: -3 }, 1.0);
      await h.advance(40, 20);
      await h.shot('mid');
      const r2 = await page.evaluate(c1FastForward, { sec: 5, metrics: true });
      await h.advance(40, 20);
      await h.shot('end');
      return { first9s: r1.metrics, last5s: r2.metrics, states: (await h.state()).enemies.map((e) => e.state) };
    },
  },

  'c2-zones': {
    desc: 'C2: Combat.zoneFor / damageFor for scripted rays (boots to helmet, centre and arms) on a real knight, plus bone-less mocks; shots with and without the zone shapes drawn.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      let k = await h.spawn('knight', 2.8, 0);
      const gear = await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; return e ? { helmet: !!e.helmet, bones: !!e.bones } : null; });
      if (!gear || !gear.bones || !gear.helmet) {            // legacy enemies.js: gear is not on bones, use the rigged mock built by c2SpawnMock
        await h.clean();
        k = await page.evaluate(c2SpawnMock, { dist: 2.8, hp: 100 });
      }
      if (k) await h.aimAt(k, 0.95);
      await h.pause();
      await h.advance(400);
      await h.shot('plain');
      const res = await page.evaluate(() => {
        const e = Enemies.list[Enemies.list.length - 1];
        const cam = Game.camera, o = cam.getWorldPosition(new THREE.Vector3());
        const base = e.mesh.getWorldPosition(new THREE.Vector3());
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion); right.y = 0; right.normalize();
        const rc = new THREE.Raycaster();
        // [label, lateral offset from the body axis (+ = screen right), height above the feet]
        const rays = [['boot', 0.17, 0.10], ['shin', -0.17, 0.35], ['thigh', 0.17, 0.50], ['pelvis', 0, 0.62], ['belly', 0, 0.85], ['chest', 0, 1.10],
          ['upper chest', 0, 1.28], ['forearm L', -0.28, 0.85], ['upper arm R', 0.24, 1.05], ['hand R', 0.30, 0.55], ['shoulder', -0.30, 1.22], ['neck', 0, 1.36], ['face', 0, 1.55], ['helmet top', 0, 1.74]];
        const rows = [];
        for (const [name, lat, hy] of rays) {
          const t = new THREE.Vector3(base.x, base.y + hy, base.z).addScaledVector(right, lat);
          rc.set(o, t.clone().sub(o).normalize());
          const hits = rc.intersectObject(e.mesh, true);
          if (!hits.length) { rows.push({ name, miss: true }); continue; }
          const hit = hits[0];
          const zone = Combat.zoneFor(e, hit);
          const dmg = Combat.damageFor(zone, e);
          rows.push({ name, zone, dmg, y: +(hit.point.y - base.y).toFixed(2), lat: +hit.point.clone().sub(base).dot(right).toFixed(2), obj: hit.object.name || hit.object.type });
        }
        // rays aimed straight at skeleton joints (the front-most surface in the way decides the hit point)
        if (window.Assets && Assets.bone) {
          for (const bn of ['Neck', 'Torso', 'Abdomen', 'UpperArm.L', 'LowerArm.L', 'Palm.L', 'LowerArm.R', 'Palm.R', 'LowerLeg.L', 'LowerLeg.R', 'Foot.R']) {
            const bo = Assets.bone(e.mesh, bn);
            if (!bo) continue;
            const t = bo.getWorldPosition(new THREE.Vector3());
            rc.set(o, t.clone().sub(o).normalize());
            const hits = rc.intersectObject(e.mesh, true);
            if (!hits.length) { rows.push({ name: 'bone ' + bn, miss: true }); continue; }
            const zone = Combat.zoneFor(e, hits[0]);
            rows.push({ name: 'bone ' + bn, zone, dmg: Combat.damageFor(zone, e), y: +(hits[0].point.y - base.y).toFixed(2), lat: +hits[0].point.clone().sub(base).dot(right).toFixed(2), obj: hits[0].object.name || hits[0].object.type });
          }
        }
        // helmet child => head regardless of the point
        let helmetRow = null;
        if (e.helmet) { let hm = null; e.helmet.traverse((m) => { if (!hm && m.isMesh) hm = m; }); if (hm) helmetRow = Combat.zoneFor(e, { object: hm, point: new THREE.Vector3(base.x, base.y + 0.3, base.z) }); }
        // bone-less mocks: fallback on height / lateral offset
        const mockRows = [];
        for (const H of [1.8, 4.2]) {
          const m = { mesh: new THREE.Group(), height: H };
          m.mesh.position.set(10, 0, -10);
          const f = H / 1.8;
          for (const [n, lat, hy] of [['legs', 0.1, 0.3], ['torso', 0.0, 0.95], ['arm', 0.5, 0.9], ['head', 0.0, 1.62]]) {
            const z = Combat.zoneFor(m, { point: new THREE.Vector3(10 + lat * f, hy * f, -10) });
            mockRows.push({ H, n, zone: z, dmg: Combat.damageFor(z, m) });
          }
        }
        // onHit on a mock: sparks / blood guarded, knockback vector, return value
        const mk = { mesh: new THREE.Group(), height: 1.8, type: 'knight' };
        mk.mesh.position.set(10, 0, -10); Game.scene.add(mk.mesh);
        const ret = Combat.onHit(mk, { point: new THREE.Vector3(10, 1.0, -10) }, new THREE.Vector3(0, 0, -1));
        const kb = mk.knockback ? mk.knockback.toArray().map((x) => +x.toFixed(2)) : null;
        const ret2 = Combat.onHit(mk, { zone: 'head', point: new THREE.Vector3(10, 1.6, -10) }, new THREE.Vector3(0, 0, -1));
        Game.scene.remove(mk.mesh);
        // draw the zone shapes
        const sh = Combat.zoneShapes(e);
        const g = new THREE.Group(); g.name = 'c2-zone-debug';
        const ball = (p, r, col) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.75, depthTest: false })); m.position.fromArray(p); m.renderOrder = 999; g.add(m); };
        const chain = (a, b, r, col) => { for (let i = 0; i <= 6; i++) { const t = i / 6; ball([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], r, col); } };
        if (sh.head) ball(sh.head.c, sh.head.r, 0xff2020);
        if (sh.torso) chain(sh.torso.a, sh.torso.b, sh.torso.r, 0x3070ff);
        sh.arms.forEach((a) => { for (let i = 0; i + 1 < a.pts.length; i++) chain(a.pts[i], a.pts[i + 1], a.r, 0x20e020); });
        sh.legs.forEach((a) => { for (let i = 0; i + 1 < a.pts.length; i++) chain(a.pts[i], a.pts[i + 1], a.r, 0xffd020); });
        if (sh.pelvisY !== null) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.01), new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false, side: THREE.DoubleSide })); pl.position.set(base.x, sh.pelvisY, base.z); pl.renderOrder = 999; g.add(pl); }
        Main.scene.add(g);
        return { rows, helmetRow, mockRows, onHit: [ret, ret2], knockback: kb, scale: sh.s, bones: sh.bones, shapeHead: sh.head };
      });
      await h.advance(100);
      await h.shot('zones');
      await page.evaluate(() => { const g = Main.scene.getObjectByName('c2-zone-debug'); if (g) Main.scene.remove(g); });
      h.log(res.rows.map((r) => `${r.name.padEnd(12)} ${r.miss ? 'MISS' : `${r.zone.padEnd(6)} ${String(r.dmg).padStart(3)}  y=${r.y} lat=${r.lat} (${r.obj})`}`).join('\n   '));
      return res;
    },
  },

  'c2-kill-props': {
    desc: 'C2: headshot kill: helmet pops (0.15 s / 0.3 s), sword + shield drop and settle (2 s / 5 s), blood pool spreads; props are removed after ~15 s.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      let k = await h.spawn('knight', 2.6, 0);
      let gear = await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; return e ? { helmet: !!e.helmet, sword: !!e.sword, shield: !!e.shield, bones: !!e.bones } : null; });
      if (!gear || !gear.bones || !gear.helmet) {            // enemies.js has no bone-attached gear (yet): use a mock knight built here
        await h.clean();
        k = await page.evaluate(c2SpawnMock, { dist: 2.6, hp: 100 });
        gear = { mock: true, helmet: true, sword: true, shield: true, bones: true };
      }
      if (k) await h.aimAt(k, 1.58);
      await h.pause();
      await h.advance(300);
      await h.shot('before');
      await page.evaluate(() => { if (!Enemies.list.some((e) => e.mock)) __dbg.freezeAI(false); });   // real knights: run the AI so the Death clip plays
      const f = await h.fire();
      const snap = () => page.evaluate(() => ({ stats: Combat.stats(), props: window.__dbg && __dbg.combat ? __dbg.combat.props() : null,
        hit: window.__lastHitInfo ? { zone: __lastHitInfo.zone, damage: __lastHitInfo.damage, killed: __lastHitInfo.killed } : null,
        fx: window.FX && FX.stats ? FX.stats() : null }));
      await h.advance(120, 30);
      await h.shot('0.12s');
      await h.advance(180, 30);
      const s03 = await snap();
      await h.shot('0.3s');
      await h.advance(300, 30);
      await h.shot('0.6s');
      await h.advance(1400, 100);
      // look down at where the gear landed
      await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; const p = e ? e.mesh.position : { x: 0, z: -2.6 }; Game.camera.lookAt(p.x, 0.15, p.z); });
      await h.advance(100, 33);
      const s2 = await snap();
      await h.shot('2s');
      await h.advance(3000, 100);
      const s5 = await snap();
      await h.shot('5s');
      // 5 s -> 12 s -> 16 s: step the simulation by hand (no rendering), the clock stays paused
      const stepSim = (n) => page.evaluate((k) => { for (let i = 0; i < k; i++) { Enemies.update(0.1, Game.playerObj.position); Combat.update(0.1); if (window.FX) FX.update(0.1); } }, n);
      await stepSim(70);
      const s12 = await snap();
      await stepSim(40);
      const s16 = await snap();
      await h.advance(100, 33);
      await h.shot('16s');
      return { gear, fire: f, s03, s2, s5, s12, s16 };
    },
  },

  'c2-kill-torso': {
    desc: 'C2: body-shot kill (no helmet pop): hit reaction shots, then sword + shield drop, pool under the body.',
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      let k = await h.spawn('knight', 2.6, 0);
      const gear = await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; return e ? { helmet: !!e.helmet, bones: !!e.bones } : null; });
      if (!gear || !gear.bones || !gear.helmet) {
        await h.clean();
        k = await page.evaluate(c2SpawnMock, { dist: 2.6, hp: 100 });
      }
      if (k) await h.aimAt(k, 1.1);
      await h.pause();
      await h.advance(300);
      await page.evaluate(() => { if (!Enemies.list.some((e) => e.mock)) __dbg.freezeAI(false); });   // real knights: AI on (reaction, knockback, Death clip)
      const log = [];
      for (let i = 0; i < 6; i++) {
        const dead = await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; return !e || !!(e.dead || (e.mesh.userData && e.mesh.userData.dying)); });
        if (dead) break;
        await h.fire();
        await h.advance(60, 16);
        if (i === 0) await h.shot('hit1');
        log.push(await page.evaluate(() => ({ hp: (Enemies.list[Enemies.list.length - 1] || {}).hp, z: +(Enemies.list[Enemies.list.length - 1] || { mesh: { position: {} } }).mesh.position.z.toFixed(2), zone: __lastHitInfo && __lastHitInfo.zone, dmg: __lastHitInfo && __lastHitInfo.damage, kb: (Enemies.list[Enemies.list.length - 1] || {}).knockback ? Enemies.list[Enemies.list.length - 1].knockback.toArray().map((x) => +x.toFixed(2)) : null })));
        await h.advance(400, 33);
      }
      await h.shot('kill');
      await h.advance(500, 33);
      await page.evaluate(() => { const e = Enemies.list[Enemies.list.length - 1]; const p = e ? e.mesh.position : { x: 0, z: -2.6 }; Game.camera.lookAt(p.x, 0.15, p.z); });
      await h.advance(1500, 33);
      await h.shot('2s');
      return { log, stats: await page.evaluate(() => Combat.stats()) };
    },
  },

  // ---- D2 (glue: main.js / game.js / waves.js / hud.js / debug.js / template) -------------------------------------------
  'd2-start-screen': {
    desc: 'D2: title screen with the accurate controls list (WASD / Shift / mouse / click / R / Esc) and the goal line.',
    start: false,
    viewport: { width: 960, height: 540 },
    run: async (page, h) => {
      await h.wait(300);
      await h.shot();
      const info = await page.evaluate(() => ({ text: document.getElementById('lock').innerText.replace(/\s+/g, ' ').trim(), btn: document.getElementById('startBtn').textContent }));
      // small windows: nothing may be clipped (the START button must stay reachable) -> d2-start-screen-<w>x<h>.png
      info.fits = {};
      for (const [w, hh] of [[640, 360], [480, 270], [360, 640]]) {
        await page.setViewportSize({ width: w, height: hh });
        await h.wait(200);
        await h.shot(w + 'x' + hh);
        info.fits[w + 'x' + hh] = await page.evaluate(() => { const r = document.getElementById('startBtn').getBoundingClientRect(), l = document.getElementById('lock');
          return { btnInView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, scrolls: l.scrollHeight > l.clientHeight + 1, hScroll: l.scrollWidth > l.clientWidth + 1 }; });
      }
      return info;
    },
  },

  'd2-damage-arc': {
    desc: 'D2: Player.hurt(dmg, attacker) draws the damage arc towards the attacker: knight on the left => arc on the left; then all four sides, then after turning the view.',
    god: false,
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      // four frozen knights 6 m from the player: left, right, behind, ahead
      await page.evaluate(() => { for (const a of [-90, 90, 180, 0]) __dbg.spawn('knight', 6, a); });
      await h.advance(100, 50);
      const arcs = () => page.evaluate(() => [...document.querySelectorAll('#dmgDirs .dmg-arc')]
        .filter((el) => el.style.visibility === 'visible' && +el.style.opacity > 0.05)
        .map((el) => +(/rotate\((-?[\d.]+)deg/.exec(el.style.transform) || [0, NaN])[1]));
      const hurt = (...idx) => page.evaluate((ix) => { for (const i of ix) Player.hurt(8, Enemies.list[i]); return Game.playerHP; }, idx);
      const out = {};
      const near = (a, b) => Math.abs(((a - b + 540) % 360) - 180) < 8;   // degrees, wrap-safe
      // 1) attacker on the left
      await hurt(0);
      await h.advance(120, 60);
      out.left = await arcs();
      await h.shot('left');
      await h.advance(1400, 350);
      // 2) all four sides at once
      await hurt(1, 2, 3, 0);
      await h.advance(120, 60);
      out.all = await arcs();
      await h.shot('all');
      await h.advance(1400, 350);
      // 3) turn the view 90 degrees to the left (towards the left knight): that knight is now ahead, the one that was ahead is on the right
      await page.evaluate(() => { const p = Enemies.list[0].mesh.position; __dbg.lookAt(p.x, 1.7, p.z); });
      await h.frames(3);
      await hurt(0, 3);
      await h.advance(120, 60);
      out.turned = await arcs();
      await h.shot('turned');
      out.hp = await page.evaluate(() => Game.playerHP);
      // 4) a REAL attack: a live knight 2.2 m to the left, AI running, view straight ahead: its sword hit must draw the arc on the left
      await h.advance(1400, 350);
      await h.clean();
      await h.resetView();
      await h.freezeAI(false);
      await page.evaluate(() => { __dbg.spawn('knight', 2.2, -90); });
      out.live = await page.evaluate(() => {
        const hp0 = Game.playerHP; let t = 0;
        while (Game.playerHP === hp0 && t < 25) { Main.step(1 / 30); t += 1 / 30; }
        const k = Enemies.list[0];
        return { hurtAfterSec: +t.toFixed(1), hp: [hp0, Game.playerHP], knight: [+k.mesh.position.x.toFixed(2), +k.mesh.position.z.toFixed(2)], state: k.state };
      });
      await h.advance(150, 75);
      out.liveArcs = await arcs();
      await h.shot('live-left');
      // assertions: -90 = left, +90 = right, 180 = behind, 0 = ahead
      const has = (list, a) => list.some((x) => near(x, a));
      const fail = [];
      if (!(out.left.length === 1 && has(out.left, -90))) fail.push('left knight did not give exactly one arc at -90deg: ' + JSON.stringify(out.left));
      for (const a of [-90, 90, 180, 0]) if (!has(out.all, a)) fail.push('missing arc at ' + a + ' in ' + JSON.stringify(out.all));
      if (!(has(out.turned, 0) && has(out.turned, 90))) fail.push('after turning left: expected arcs at 0 and +90, got ' + JSON.stringify(out.turned));
      if (!(out.live.hp[1] < out.live.hp[0])) fail.push('the live knight never hurt the player: ' + JSON.stringify(out.live));
      if (!(out.liveArcs.length >= 1 && has(out.liveArcs, -90))) fail.push('live attack from the left did not draw an arc at -90deg: ' + JSON.stringify(out.liveArcs) + ' ' + JSON.stringify(out.live));
      if (fail.length) throw new Error('damage arc check failed: ' + fail.join(' | '));
      return out;
    },
  },

  'd2-pause': {
    desc: 'D2: losing the pointer lock mid-game pauses the simulation (overlay + frozen enemies); clicking the overlay resumes.',
    viewport: { width: 640, height: 360 },
    run: async (page, h) => {
      await h.clean();
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(() => { Main.autoPause = true; __dbg.spawn('knight', 12, 0); if (document.pointerLockElement) document.exitPointerLock(); });
      await h.advance(300, 50);
      await page.evaluate(() => { if (Main.isPaused()) Main.resume(); });   // a real lock exit (headless granted the lock) may have paused already
      const pos = () => page.evaluate(() => { const e = Enemies.list[0]; return [e.mesh.position.x, e.mesh.position.z].map((v) => +v.toFixed(3)); });
      const p0 = await pos();
      await h.advance(500, 50);
      const p1 = await pos();
      // simulate "lock lost": the handler reads document.pointerLockElement (null by now) on any pointerlockchange
      await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
      await h.advance(100, 50);
      const paused = await page.evaluate(() => ({ paused: Main.isPaused(), shown: getComputedStyle(document.getElementById('pauseScreen')).display }));
      await h.shot('paused');
      const p2 = await pos();
      await h.advance(800, 50);
      const p3 = await pos();
      await page.evaluate(() => { Main.renderer.domElement.requestPointerLock = () => undefined; });   // the lock is neither granted nor refused: a click must still resume
      await page.evaluate(() => document.getElementById('pauseScreen').click());
      await h.advance(500, 50);
      const p4 = await pos();
      const after = await page.evaluate(() => ({ paused: Main.isPaused(), shown: getComputedStyle(document.getElementById('pauseScreen')).display }));
      // the browser refuses the re-lock (Chrome blocks it for ~1 s after Esc): the rejected request must bring the overlay back
      await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
      await h.advance(100, 50);
      await page.evaluate(() => { Main.renderer.domElement.requestPointerLock = () => Promise.resolve(); });
      await page.evaluate(() => document.getElementById('pauseScreen').click());
      await h.advance(100, 50);
      const resumed2 = await page.evaluate(() => Main.isPaused());
      await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));   // paused again
      await h.advance(100, 50);
      await page.evaluate(() => { Main.renderer.domElement.requestPointerLock = () => Promise.reject(new DOMException('refused', 'SecurityError')); });
      await page.evaluate(() => document.getElementById('pauseScreen').click());
      await h.advance(100, 50);
      const refused = await page.evaluate(() => ({ paused: Main.isPaused(), shown: getComputedStyle(document.getElementById('pauseScreen')).display }));
      await page.evaluate(() => { Main.renderer.domElement.requestPointerLock = () => undefined; });
      await page.evaluate(() => document.getElementById('pauseScreen').click());
      await h.advance(100, 50);
      const resumed3 = await page.evaluate(() => Main.isPaused());
      const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05;
      const fail = [];
      if (!moved(p0, p1)) fail.push('knight did not move before the pause');
      if (!paused.paused || paused.shown !== 'flex') fail.push('not paused: ' + JSON.stringify(paused));
      if (moved(p2, p3)) fail.push('knight moved while paused');
      if (after.paused || after.shown !== 'none') fail.push('did not resume: ' + JSON.stringify(after));
      if (!moved(p3, p4)) fail.push('knight did not move after resume');
      if (resumed2) fail.push('second click did not resume');
      if (!refused.paused || refused.shown !== 'flex') fail.push('a refused re-lock did not bring the pause overlay back: ' + JSON.stringify(refused));
      if (resumed3) fail.push('third click did not resume');
      if (fail.length) throw new Error('pause check failed: ' + fail.join(' | '));
      return { p0, p1, p2, p3, p4, paused, after, resumed2, refused, resumed3 };
    },
  },

  'd2-gameover': {
    desc: 'D2: the player dies (two Player.hurt hits while wave 1 runs): game-over screen with stats, no pause overlay although the pointer lock is released, simulation stops (enemies freeze).',
    god: false,
    viewport: { width: 640, height: 360 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.freezeAI(false);
      await h.pause();
      await page.evaluate(() => { Main.autoPause = true; __dbg.spawn('knight', 14, 30); });
      await h.advance(300, 50);
      await page.evaluate(() => { Player.hurt(60, Enemies.list[0]); });
      await h.advance(100, 50);
      const alive = await page.evaluate(() => ({ dead: Game.dead, hp: Game.playerHP, go: getComputedStyle(document.getElementById('gameOverScreen')).display }));
      await page.evaluate(() => { Player.hurt(60, Enemies.list[0]); });
      await h.advance(300, 50);
      const pos = () => page.evaluate(() => { const e = Enemies.list[0]; return [e.mesh.position.x, e.mesh.position.z].map((v) => +v.toFixed(3)); });
      const p0 = await pos();
      await h.advance(600, 50);
      const p1 = await pos();
      await h.shot('over');
      const end = await page.evaluate(() => ({ dead: Game.dead, hp: Game.playerHP, paused: Main.isPaused(), go: getComputedStyle(document.getElementById('gameOverScreen')).display,
        text: document.getElementById('gameOverScreen').innerText.replace(/\s+/g, ' ').trim(), restart: !!document.getElementById('restartButton') }));
      const fail = [];
      if (alive.dead || alive.go !== 'none') fail.push('dead / game over after the first hit: ' + JSON.stringify(alive));
      if (!end.dead || end.hp !== 0) fail.push('player not dead: ' + JSON.stringify(end));
      if (end.go === 'none') fail.push('game over screen not shown');
      if (end.paused) fail.push('pause overlay shown on top of the game over screen');
      if (Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) > 0.01) fail.push('enemies kept moving after the player died');
      if (!/wave/i.test(end.text)) fail.push('no wave in the stats: ' + end.text);
      if (h.errors.length) fail.push('console errors: ' + h.errors.slice(0, 2).join(' || ').slice(0, 400));
      if (fail.length) throw new Error('game over check failed: ' + fail.join(' | '));
      return { alive, end, p0, p1 };
    },
  },

  'd2-boss-fight': {
    desc: 'D2: wave 5 only (skipToWave(5), godMode): the real Boss is shot dead with aimed shots; the boss bar, minions and victory timing are logged; victory must only show after the boss died.',
    viewport: { width: 640, height: 360 },
    run: async (page, h) => {
      const problems = [];
      const drive = (opts) => page.evaluate(d2Drive, opts);
      const snap = () => page.evaluate(() => { const b = Waves.boss, pp = Game.playerObj.position;
        return { ws: Waves.state, kills: Waves.kills, boss: b && { hp: b.hp, st: b.state, atk: b.atk, ph: b.phase, dead: b.dead, d: +Math.hypot(b.mesh.position.x - pp.x, b.mesh.position.z - pp.z).toFixed(1) },
          minions: Enemies.list.filter((e) => !e.dead && e !== b).length, left: document.getElementById('enemiesLeft').textContent, bar: getComputedStyle(document.getElementById('bossBar')).display,
          victory: getComputedStyle(document.getElementById('victoryScreen')).display, shots: Game.shots, hits: Game.hits, ammo: Game.ammo }; });
      await h.pause();
      await h.resetView();
      await page.evaluate(() => __dbg.skipToWave(5));
      await h.advance(300, 100);
      await h.shot('intro');
      await drive({ maxSec: 20, stop: 'boss', shoot: false });
      await h.advance(200, 100);
      const log = [{ at: 'boss spawned', ...(await snap()) }];
      await h.shot('boss');
      let reached = false;
      for (let i = 0; i < 50 && !reached; i++) {
        const r = await drive({ maxSec: 4, stop: 'bossDead', shoot: true, bossFirst: true });
        reached = r.reached;
        if (r.victoryEarly) problems.push('victory screen shown while the boss lived');
        if (i % 2 === 1 || reached) log.push({ at: 'fight +' + (i + 1) * 4 + 's', ...(await snap()) });
        if (i === 3 && !reached) { await h.advance(200, 100); await h.shot('fight'); }
      }
      if (!reached) problems.push('boss was not killed by shots within 200 s of game time');
      log.push({ at: 'boss dead', ...(await snap()) });
      if (log[log.length - 1].victory !== 'none') problems.push('victory visible at the moment of death');
      await h.advance(600, 150);
      await h.shot('dying');
      const rv = await drive({ maxSec: 15, stop: 'victory', shoot: false });
      if (!rv.reached) problems.push('no victory after the boss died');
      await h.advance(400, 100);
      await h.shot('victory');
      log.push({ at: 'victory', ...(await snap()) });
      if (h.errors.length) problems.push('console errors: ' + h.errors.slice(0, 2).join(' || ').slice(0, 500));
      if (problems.length) throw new Error('d2-boss-fight: ' + problems.join(' | ') + ' LOG ' + JSON.stringify(log).slice(0, 1500));
      return log;
    },
  },

  'd2-full-run': {
    desc: 'D2: scripted playthrough (?debug=1, godMode): waves 1-4 killed with real revolver shots (head aim, R to reload), wave 5 boss until it dies, victory only after that; __dbg.state() logged at every step, zero console errors required.',
    viewport: { width: 640, height: 360 },
    run: async (page, h) => {
      const t0 = Date.now();
      const log = [];
      const problems = [];
      const brief = (label, extra) => page.evaluate((lab) => {
        const s = __dbg.state();
        return { label: lab, wave: s.wave, ws: s.waves && s.waves.state, pend: s.pending, alive: s.alive, listLen: s.enemies.length,
          kills: s.kills, shots: s.shots, ammo: s.ammo, hp: s.hp, boss: s.waves && s.waves.boss, bossKilled: s.waves && s.waves.bossKilled,
          victoryShown: s.screens.victory, gameOverShown: s.screens.gameOver, godMode: s.godMode };
      }, label).then((r) => { const o = Object.assign(r, extra || {}); log.push(o); h.log(JSON.stringify(o)); return o; });
      const drive = (opts) => page.evaluate(d2Drive, opts);

      await h.pause();
      await h.resetView();
      await brief('start');
      await h.advance(600, 150);
      await h.shot('w1-banner');

      // ---- waves 1-4: knights killed by aimed shots
      for (let n = 1; n <= 4; n++) {
        const r1 = await drive({ maxSec: 7, stop: 'never', shoot: true });
        await h.advance(200, 100);
        if (n === 1 || n === 3) await h.shot('w' + n + '-fight');
        await brief('w' + n + ' fighting', { stepShots: r1.shots, killedByShots: r1.killedByShots });
        const r2 = await drive({ maxSec: 150, stop: 'countdown', shoot: true });
        if (!r2.reached) {
          const why = await page.evaluate(() => ({ w: Waves.snapshot(), ammo: Game.ammo, reloadTimer: Game.reloadTimer, shots: Game.shots, hits: Game.hits,
            enemies: Enemies.list.map((e) => ({ st: e.state, hp: e.hp, dead: e.dead, pos: e.mesh.position.toArray().map((x) => +x.toFixed(1)) })) }));
          problems.push('wave ' + n + ' did not clear by shots within 150 s of game time (fallback killAll): ' + JSON.stringify(why).slice(0, 700));
          await h.killAll(); await drive({ maxSec: 30, stop: 'countdown', shoot: false });
        }
        if (r1.victoryEarly || r2.victoryEarly) problems.push('victory screen shown early in wave ' + n);
        await brief('w' + n + ' cleared', { shotsUsed: r1.shots + r2.shots, byShots: r1.killedByShots + r2.killedByShots, reloadsByKey: r1.reloadKeys + r2.reloadKeys, mouseDown: r1.viaMouse + r2.viaMouse, direct: r1.viaDirect + r2.viaDirect, wallMs: Date.now() - t0 });
        await h.advance(300, 150);
        await h.shot('w' + n + '-cleared');
        // countdown -> next wave starts by itself
        const r3 = await drive({ maxSec: 12, stop: 'wave:' + (n + 1), shoot: false });
        if (!r3.reached) problems.push('wave ' + (n + 1) + ' did not start after the countdown');
        if (r3.victoryEarly) problems.push('victory screen during countdown ' + n);
      }

      // ---- wave 5: boss
      await brief('w5 started');
      await h.advance(200, 100);
      await h.shot('w5-intro');
      const rb = await drive({ maxSec: 20, stop: 'boss', shoot: false });
      if (!rb.reached) problems.push('the boss never appeared');
      await h.advance(200, 100);
      const bossInfo = await page.evaluate(() => { const b = Waves.boss; return b ? { ctor: b.constructor.name, type: b.type, hp: b.hp, maxHp: b.maxHp, name: b.displayName || null, fallback: Waves.bossFallback, err: Waves.bossError, scale: b.mesh.scale.x } : null; });
      await brief('w5 boss on the field', { bossInfo });
      await h.shot('w5-boss');
      if (bossInfo && bossInfo.fallback) h.warn('boss is the STAND-IN knight: ' + bossInfo.err);

      let r = await drive({ maxSec: 90, stop: 'bossHalf', shoot: true, bossFirst: true });
      await h.advance(200, 100);
      await h.shot('w5-boss-half');
      await brief('w5 boss <= 50% hp', { reached: r.reached, stepShots: r.shots, minionsAlive: await page.evaluate(() => Enemies.list.filter((e) => !e.dead && e !== Waves.boss).length) });
      if (r.victoryEarly) problems.push('victory screen shown while the boss lived (<=50%)');
      r = await drive({ maxSec: 150, stop: 'bossDead', shoot: true, bossFirst: true });
      if (!r.reached) {
        const why = await page.evaluate(() => { const b = Waves.boss, pp = Game.playerObj.position; return { boss: b && { hp: b.hp, st: b.state, atk: b.atk, ph: b.phase, dead: b.dead, pos: b.mesh.position.toArray().map((x) => +x.toFixed(1)), dist: +Math.hypot(b.mesh.position.x - pp.x, b.mesh.position.z - pp.z).toFixed(1) },
          player: pp.toArray().map((x) => +x.toFixed(1)), ammo: Game.ammo, reloadTimer: Game.reloadTimer, shots: Game.shots, hits: Game.hits,
          last: window.__lastHitInfo && { zone: window.__lastHitInfo.zone, dist: window.__lastHitInfo.distance, killed: window.__lastHitInfo.killed, enemy: window.__lastHitInfo.enemy && window.__lastHitInfo.enemy.type },
          list: Enemies.list.map((e) => ({ t: e.type, st: e.state, hp: e.hp, dead: e.dead })) }; });
        problems.push('boss not killed by shots within 150 s (fallback killAll): ' + JSON.stringify(why).slice(0, 900));
        await h.shot('w5-boss-stuck');
        await h.killAll(); await drive({ maxSec: 5, stop: 'bossDead', shoot: false });
      }
      if (r.victoryEarly) problems.push('victory screen shown before the boss died');
      const atDeath = await brief('w5 boss dead (death animation)');
      if (atDeath.victoryShown) problems.push('victory screen is already up at the moment the boss died (expected a short delay)');
      if (atDeath.ws !== 'victory-wait') problems.push('Waves.state at boss death is ' + atDeath.ws + ' (expected victory-wait)');
      await h.advance(600, 150);
      await h.shot('w5-boss-dying');
      const rv = await drive({ maxSec: 15, stop: 'victory', shoot: false });
      if (!rv.reached) problems.push('victory never came after the boss died');
      await h.advance(400, 100);
      await h.shot('victory');
      const end = await brief('victory', { wallMs: Date.now() - t0 });
      if (!end.victoryShown) problems.push('victory screen not visible at the end');
      if (end.ws !== 'victory') problems.push('final Waves.state ' + end.ws);
      if (end.kills < 5 + 7 + 9 + 11 + 1) problems.push('kills ' + end.kills + ' < 33');

      const errs = h.errors.slice();
      if (errs.length) problems.push('console/page errors: ' + errs.slice(0, 3).join(' || ').slice(0, 600));
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { OUT_DIR } = await import('./lib.mjs');
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, 'd2-full-run.json'), JSON.stringify({ problems, errors: errs, log }, null, 1));
      } catch (e) { h.log('could not write the log: ' + e.message); }
      const summary = { ok: problems.length === 0, problems, errors: errs.length, steps: log.length, last: log[log.length - 1], wallSec: Math.round((Date.now() - t0) / 1000) };
      if (problems.length) throw new Error('d2-full-run problems: ' + JSON.stringify(summary).slice(0, 1500));
      return summary;
    },
  },
  // ---- D1 (boss.js). The boss is staged with __dbg.boss.* (force an attack, jump to a phase, freeze a clip pose); long stretches are
  // fast-forwarded in the page (d1Until, no rendering) because swiftshader is slow, rendered frames use h.advance on the virtual clock.
  'd1-boss-intro': {
    desc: 'D1: wave 5 via skipToWave(5): the Boss wave banner, then the boss on the arena ring (4.9 m giant, golden, horned) with the boss bar, then walking in.',
    viewport: { width: 960, height: 540 },
    run: async (page, h) => {
      await h.resetView();
      await h.pause();
      await h.skipToWave(5);
      await h.advance(800, 50);
      await h.shot('banner');
      await h.advance(1800, 50);
      const at = () => page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'), pp = Game.playerObj.position;
        return b ? { x: +b.mesh.position.x.toFixed(1), z: +b.mesh.position.z.toFixed(1), dist: +Math.hypot(b.mesh.position.x - pp.x, b.mesh.position.z - pp.z).toFixed(1), state: b.state, atk: b.atk, hp: b.hp,
          bar: getComputedStyle(document.getElementById('bossBar')).display, barName: document.getElementById('bossName').textContent, barPct: document.getElementById('bossPct').textContent } : null; });
      const a1 = await at();
      if (!a1) throw new Error('d1-boss-intro: the boss did not appear');
      await h.aimAt({ x: a1.x, y: 0, z: a1.z }, 2.4);
      await h.advance(200, 50);
      await h.shot('arrival');
      // it walks in: 7 s later it is much closer
      await page.evaluate(c1FastForward, { sec: 6, step: 1 / 30 });
      const a2 = await at();
      await h.aimAt({ x: a2.x, y: 0, z: a2.z }, 2.4);
      await h.advance(100, 50);
      await h.shot('approach');
      return { arrival: a1, approach: a2, wave: await page.evaluate(() => Waves.snapshot()), state: await h.state() };
    },
  },

  'd1-boss-gear': {
    desc: 'D1: the boss next to a knight (size), then front / right / left / back and a head close-up: helmet + horns on the head, greatsword in the right fist, tower shield on the left forearm, pauldrons.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      await h.spawn('knight', 7.5, 12);
      await h.spawn('boss', 9, -6);
      await page.evaluate(() => { for (const e of Enemies.list) { e.hold = true; } const b = Enemies.list.find((e) => e.type === 'boss'); b.setState('combatIdle'); });
      await h.aimAt({ x: -1, y: 0, z: -9 }, 2.0);
      await h.pause();
      await h.advance(300, 50);
      await h.shot('size');
      await page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'); b.mesh.position.set(0, 0, -8); b._yaw = 0; b.mesh.rotation.y = 0; Enemies.list.find((e) => e.type === 'knight').mesh.position.set(40, 0, 40); });
      await h.aimAt({ x: 0, y: 0, z: -8 }, 2.6);
      await h.advance(150, 50);
      await h.shot('front');
      for (const [lab, yaw] of [['right', Math.PI / 2], ['left', -Math.PI / 2], ['back', Math.PI]]) {
        await page.evaluate((y) => { const b = Enemies.list.find((e) => e.type === 'boss'); b._yaw = y; b.mesh.rotation.y = y; }, yaw);
        await h.advance(100, 50);
        await h.shot(lab);
      }
      await page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'); b.mesh.position.set(0, 0, -5); b._yaw = 0; b.mesh.rotation.y = 0; });
      await h.aimAt({ x: 0, y: 0, z: -5 }, 3.6);
      await h.advance(100, 50);
      await h.shot('head');
      return { gear: await page.evaluate(() => __dbg.boss.gear()), info: await page.evaluate(() => __dbg.boss.info()) };
    },
  },

  'd1-boss-sweep-windup': {
    desc: 'D1: the sweep telegraph: the sword rises and holds while a red fan (the exact hit area) fills up on the ground; frames at 0.25 / 0.6 / 1.0 s of the windup and at the swing; then (no rendering) the damage is logged: Player.hurt only at the swing frame.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.spawn('boss', 8.5, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.atk = null; b.setState('combatIdle'); b._gap = 0; __dbg.boss.force('sweep'); });
      await h.aimAt({ x: 0, y: 0, z: -8.5 }, 2.0);
      await h.freezeAI(false);
      await h.pause();
      const info = () => page.evaluate(() => __dbg.boss.info());
      const out = {};
      await h.advance(250, 33); await h.shot('windup-25'); out.t25 = await info();
      await h.advance(350, 33); await h.shot('windup-60'); out.t60 = await info();
      await h.advance(380, 33); await h.shot('windup-100'); out.t100 = await info();
      out.tele = await page.evaluate(() => __dbg.boss.tele());
      await h.advance(300, 33); await h.shot('strike'); out.strike = await info();
      // damage timing, not rendered: the player stands 5.5 m in front of the boss and takes the sweep (god mode off)
      await h.clean();
      await page.evaluate(() => { __dbg.godMode(false); Game.godMode = false; Game.playerHP = 100; });
      await h.spawn('boss', 5.5, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.atk = null; b.setState('combatIdle'); b._gap = 0; b._leapCd = 99; __dbg.boss.force('sweep'); });
      out.dmg = await page.evaluate(d1Until, { sec: 4, until: "b.state==='combatIdle'" });
      await page.evaluate(() => { __dbg.godMode(true); });
      return out;
    },
  },

  'd1-boss-leap-land': {
    desc: 'D1: the leap slam: ring on the ground at the landing spot (the exact AoE) while the boss crouches, the boss in the air, the landing (shockwave ring, dust ring, shake), then the stunned recovery; viewed from the side. Then (not rendered) the damage: only on the landing frame.',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      await h.spawn('boss', 17, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.atk = null; b.setState('combatIdle'); b._gap = 0; __dbg.boss.force('leap'); });
      await h.freezeAI(false);
      await h.pause();
      const out = {};
      await h.advance(520, 33);                                   // the landing spot is locked now: step aside to watch from the side
      await page.evaluate(() => { __dbg.teleport(11, -8); __dbg.lookAt(0, 2.2, -8); });
      await h.advance(380, 33); await h.shot('crouch');           // t = 0.9 s
      out.crouch = await page.evaluate(() => __dbg.boss.info());
      await h.advance(520, 33); await h.shot('air');              // t = 1.42 s
      out.air = await page.evaluate(() => __dbg.boss.info());
      await h.advance(520, 33); await h.shot('land');             // t = 1.94 s: just landed
      out.land = await page.evaluate(() => __dbg.boss.info());
      await h.advance(500, 33); await h.shot('after');
      out.tele = await page.evaluate(() => __dbg.boss.tele());
      // damage timing, not rendered: the player stays where the boss locks on (god mode off)
      await h.clean();
      await page.evaluate(() => { __dbg.teleport(0, 0, 0); __dbg.godMode(false); Game.godMode = false; Game.playerHP = 100; });
      await h.spawn('boss', 17, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.atk = null; b.setState('combatIdle'); b._gap = 0; __dbg.boss.force('leap'); });
      out.dmg = await page.evaluate(d1Until, { sec: 5, until: "b.state==='combatIdle'" });
      await page.evaluate(() => { __dbg.godMode(true); });
      return out;
    },
  },

  'd1-boss-charge': {
    desc: 'D1: the charge (phase 2): red strip along the locked run line while the sword is raised, the straight run, the stumble afterwards; then the damage log (a player who stays in the line is hit once, a player who steps out is not).',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await page.evaluate(() => window.Weapon && Weapon.setVisible && Weapon.setVisible(false));
      await h.spawn('boss', 20, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.phase = 2; b.atk = null; b.setState('combatIdle'); b._gap = 0; __dbg.boss.force('charge'); });
      await h.freezeAI(false);
      await h.pause();
      const out = {};
      await h.advance(700, 33); await h.shot('windup'); out.windup = await page.evaluate(() => __dbg.boss.info());
      out.tele = await page.evaluate(() => __dbg.boss.tele());
      await page.evaluate(() => { __dbg.teleport(7, -8); __dbg.lookAt(0, 1.6, -8); });   // step out of the line and watch from the side
      await h.advance(560, 33); await h.shot('run'); out.run = await page.evaluate(() => __dbg.boss.info());
      await h.advance(500, 33); await h.shot('through');
      await page.evaluate(c1FastForward, { sec: 0.6 });
      await h.advance(100, 33); await h.shot('stumble'); out.stumble = await page.evaluate(() => __dbg.boss.info());
      // damage log (not rendered): in the line -> one hit; stepped aside -> none
      for (const aside of [false, true]) {
        await h.clean();
        await page.evaluate(() => { __dbg.teleport(0, 0, 0); __dbg.godMode(false); Game.godMode = false; Game.playerHP = 100; });
        await h.spawn('boss', 20, 0);
        await page.evaluate(() => { const b = Enemies.list[0]; b.phase = 2; b.atk = null; b.setState('combatIdle'); b._gap = 0; __dbg.boss.force('charge'); });
        await page.evaluate(d1Until, { sec: 0.8, until: "b.state==='charge'" });
        if (aside) await page.evaluate(() => { Game.playerObj.position.x += 6; });
        out[aside ? 'dmgAside' : 'dmgInLine'] = await page.evaluate(d1Until, { sec: 4, until: "b.state==='combatIdle'" });
      }
      await page.evaluate(() => { __dbg.godMode(true); });
      return out;
    },
  },

  'd1-boss-phase2': {
    desc: 'D1: crossing 66 % HP: the roar (sword up, shockwave ring, glow), 2 minions appear on the arena ring (not on the boss) and run in; crossing 33 % adds 2 more (max 4 alive) and the glow gets stronger.',
    viewport: { width: 960, height: 540 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.spawn('boss', 13, 0);
      await h.freezeAI(false);
      await h.pause();
      const info = () => page.evaluate(() => __dbg.boss.info());
      const out = {};
      await page.evaluate(d1Until, { sec: 2, until: "b.state==='combatIdle'" });             // the arrival roar is over
      out.before = await info();
      await page.evaluate(() => __dbg.boss.phase(2));
      await page.evaluate(d1Until, { sec: 1, until: "b.state==='windup'&&b.atk==='roar'" });
      await h.aimAt(await page.evaluate(() => { const p = Enemies.list[0].mesh.position; return { x: p.x, y: 0, z: p.z }; }), 3.0);
      await h.advance(520, 33); await h.shot('roar');
      out.roar = await info();
      out.minionsAt = await page.evaluate(() => Enemies.list.filter((e) => e.isMinion).map((e) => ({ x: +e.mesh.position.x.toFixed(1), z: +e.mesh.position.z.toFixed(1), fromBoss: +Math.hypot(e.mesh.position.x - Enemies.list[0].mesh.position.x, e.mesh.position.z - Enemies.list[0].mesh.position.z).toFixed(1) })));
      // the first minion where it appeared on the arena ring, then close to the player
      await h.aimAt(await page.evaluate(() => { const m = Enemies.list.find((e) => e.isMinion); const p = m.mesh.position; return { x: p.x, y: 0, z: p.z }; }), 1.0);
      await h.advance(200, 33); await h.shot('minion-spawn');
      await page.evaluate(d1Until, { sec: 8 });
      await h.aimAt(await page.evaluate(() => { const ms = Enemies.list.filter((e) => e.isMinion && !e.dead); const p = Game.playerObj.position;
        ms.sort((a, b) => Math.hypot(a.mesh.position.x - p.x, a.mesh.position.z - p.z) - Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z)); const q = ms[0].mesh.position; return { x: q.x, y: 0, z: q.z }; }), 1.1);
      await h.advance(100, 33); await h.shot('minion-arrives');
      out.afterPhase2 = await info();
      await page.evaluate(() => __dbg.boss.phase(3));
      await page.evaluate(d1Until, { sec: 2.2, until: "b.state==='windup'&&b.atk==='roar'&&b.stateT>0.6" });
      await h.aimAt(await page.evaluate(() => { const p = Enemies.list[0].mesh.position; return { x: p.x, y: 0, z: p.z }; }), 3.0);
      await h.advance(120, 33); await h.shot('phase3');
      out.afterPhase3 = await info();
      await page.evaluate(d1Until, { sec: 2.5 });
      out.final = await info();
      out.state = await h.state();
      return out;
    },
  },

  'd1-boss-death': {
    desc: 'D1: wave 5, the boss is killed (takeHit): the Death clip at 0.6x speed, burst at 0.5 s, the thud at ~1.6 s, the state at 3 s; the boss bar hides, Waves counts one kill, victory comes after the delay.',
    viewport: { width: 960, height: 540 },
    run: async (page, h) => {
      await h.resetView();
      await h.pause();
      await h.skipToWave(5);
      await h.advance(2300, 50);
      await page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'); b.mesh.position.set(0, 0, -10); b._yaw = 0; b.mesh.rotation.y = 0; });
      await page.evaluate(c1FastForward, { sec: 2.2 });                 // the arrival roar is over, it is walking in
      const snap = () => page.evaluate(() => { const b = Waves.boss; return { boss: { hp: b.hp, dead: b.dead, state: b.state, clip: b.currentClip, inList: Enemies.list.includes(b), loose: ['helmet', 'sword', 'shield'].map((k) => !!(b[k] && b[k].userData.loose)) },
        waves: Waves.snapshot(), kills: Game.kills, bar: getComputedStyle(document.getElementById('bossBar')).display, victory: getComputedStyle(document.getElementById('victoryScreen')).display }; });
      const out = { before: await snap() };
      await page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'); const p = b.mesh.position; b.takeHit({ damage: 1e6, zone: 'torso', point: new THREE.Vector3(p.x, 3, p.z + 1), dir: new THREE.Vector3(0, 0, -1) }); });
      out.at0 = await snap();
      await page.evaluate(() => { const p = Waves.boss.mesh.position; __dbg.lookAt(p.x, 2.0, p.z); });
      await h.advance(500, 33); await h.shot('0.5s');
      out.at05 = await snap();
      await h.advance(1100, 33); await h.shot('1.6s');
      await page.evaluate(c1FastForward, { sec: 1.3 });
      await h.advance(100, 33); await h.shot('3s');
      out.at3 = await snap();
      await h.advance(1400, 100); await h.shot('victory');
      out.end = await snap();
      out.state = await h.state();
      return out;
    },
  },

  'd1-boss-soak': {
    desc: 'D1: AI soak without rendering (60 s of game time per run, player HP topped up each frame): a player who stands still, one who kites on a circle (r 14 m and r 26 m), and phase 3 from the start; logs how often each attack ran, the damage per attack, the longest time spent in each state (no stuck states), min / max boss distance and that the boss stays inside the arena.',
    viewport: { width: 480, height: 270 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      const runs = {};
      for (const [name, cfg] of [['still', { sec: 60 }], ['kite14', { sec: 60, kite: 14 }], ['kite26', { sec: 60, kite: 26 }], ['phase3-still', { sec: 40, hp: 0.3 }], ['phase3-kite14', { sec: 40, hp: 0.3, kite: 14 }]]) {
        await h.clean();
        await page.evaluate(() => { __dbg.teleport(0, 0, 0); __dbg.godMode(false); Game.godMode = false; });
        await h.spawn('boss', 14, 0);
        runs[name] = await page.evaluate(d1Soak, cfg);
      }
      await page.evaluate(() => { __dbg.godMode(true); Game.playerHP = 100; });
      await h.advance(60, 30);
      await h.shot();
      return runs;
    },
  },

  'd1-boss-shots': {
    desc: 'D1: real revolver shots at the boss: hit zones on the giant body (head / torso / limb), damage per zone and the shot counts to kill (logged).',
    viewport: { width: 800, height: 450 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.spawn('boss', 12, 0);
      await page.evaluate(() => { const b = Enemies.list[0]; b.hold = true; b.setState('combatIdle'); });
      await h.pause();
      const rows = [];
      for (const [label, hgt, dx] of [['head', 4.1, 0], ['chest', 2.8, 0], ['belly', 2.0, 0], ['thigh', 0.9, 0.3], ['shin', 0.35, 0.55]]) {
        await h.lookAt(dx, hgt, -12);
        await h.frames(2);
        const hp0 = await page.evaluate(() => Enemies.list[0].hp);
        await page.evaluate(() => { Game.fireCooldown = 0; Game.reloadTimer = 0; Game.ammo = 6; });
        await h.fire();
        await h.advance(120, 30);
        rows.push(await page.evaluate(([label, hp0]) => { const i = window.__lastHitInfo || {}; return { aim: label, zone: i.zone, dmg: i.damage, hpAfter: Enemies.list[0].hp, lost: hp0 - Enemies.list[0].hp }; }, [label, hp0]));
      }
      await h.shot();
      const dmg = { head: 150, torso: 40, limb: 28 };
      return { rows, hp: 1500, torsoShotsToKill: Math.ceil(1500 / dmg.torso), headShotsToKill: Math.ceil(1500 / dmg.head), mixed25pctHeads: Math.ceil(1500 / (0.25 * dmg.head + 0.75 * dmg.torso)) };
    },
  },

  'd1-boss-lifecycle': {
    desc: 'D1: no rendering. Clearing the arena while the boss telegraphs (no leftover telegraph meshes, bar hidden), then a boss that is killed: the corpse lingers, sinks and is removed from the scene and the list, nothing stays in the scene, the boss bar stays hidden; minion cap (never more than 4 alive, 2 per phase change).',
    viewport: { width: 480, height: 270 },
    run: async (page, h) => {
      await h.clean();
      await h.resetView();
      await h.pause();
      const count = () => page.evaluate(() => { let tele = 0, boss = 0; Game.scene.traverse((o) => { if (o.name && o.name.indexOf('boss-tele:') === 0) tele++; if (o.userData && o.userData.enemy && o.userData.enemy.type === 'boss') boss++; });
        return { tele, boss, list: Enemies.list.length, bar: getComputedStyle(document.getElementById('bossBar')).display }; });
      const out = { start: await count() };
      await h.spawn('boss', 14, 0);
      await page.evaluate(d1Until, { sec: 2.2, until: "b.state==='combatIdle'" });
      await page.evaluate(() => { __dbg.boss.force('sweep'); });
      await page.evaluate(d1Until, { sec: 0.6 });
      out.telegraphing = await count();
      await page.evaluate(() => Enemies.clear());
      out.afterClear = await count();
      // a second boss: phases (minion cap), then death and removal
      await h.spawn('boss', 14, 0);
      await page.evaluate(d1Until, { sec: 2.2, until: "b.state==='combatIdle'" });
      const minions = [];
      for (const ph of [2, 3]) {
        await page.evaluate((n) => __dbg.boss.phase(n), ph);
        await page.evaluate(d1Until, { sec: 3 });
        minions.push(await page.evaluate(() => ({ alive: Enemies.list.filter((e) => e.isMinion && !e.dead).length, total: Enemies.list.filter((e) => e.isMinion).length })));
      }
      out.minions = minions;
      await page.evaluate(() => { const b = Enemies.list.find((e) => e.type === 'boss'); const p = b.mesh.position; b.takeHit({ damage: 1e6, zone: 'head', point: new THREE.Vector3(p.x, 4, p.z + 1), dir: new THREE.Vector3(0, 0, -1) }); });
      out.dead = await count();
      await page.evaluate(d1Until, { sec: 0.1 });
      await page.evaluate(() => { const pp = Game.playerObj.position; for (let t = 0; t < 14; t += 1 / 30) { Enemies.update(1 / 30, pp.clone()); Combat.update(1 / 30); FX.update(1 / 30); } });
      out.after14s = await count();
      out.helmetLoose = await page.evaluate(() => { let n = 0; Game.scene.traverse((o) => { if (o.userData && o.userData.loose) n++; }); return n; });
      return out;
    },
  },

};

// C1 helper: advance the game simulation by `sec` seconds WITHOUT rendering (the same per-frame calls main.js makes).
// a = { sec, step = 1/30, record?: enemy index (log state / player HP changes), metrics?: true (spacing, collider penetration, distance) }
// Runs inside the page (serialised by page.evaluate), so it must not reference anything from this module.
function c1FastForward(a) {
  const step = a.step || 1 / 30;
  const pp = a.target ? { x: a.target.x, y: 1.7, z: a.target.z, clone() { return this; } } : Game.playerObj.position;   // optional fake player position (walk away from the camera)
  const log = [];
  let last = '';
  const m = { minPair: 99, worstPen: 0, minPlayer: 99 };
  let t = 0;
  for (; t < a.sec - 1e-9; t += step) {
    Enemies.update(step, pp.clone());
    if (window.Combat && Combat.update) Combat.update(step);
    if (window.FX && FX.update) FX.update(step);
    if (a.record !== undefined) {
      const e = Enemies.list[a.record];
      if (e) {
        const key = e.state + '|' + Game.playerHP;
        if (key !== last) {
          last = key;
          e.mesh.updateMatrixWorld(true);
          const gd = ['helmet:Head', 'sword:Palm.R', 'shield:LowerArm.L'].map((x) => { const [k, b] = x.split(':'); return +e[k].getWorldPosition(new THREE.Vector3()).distanceTo(Assets.bone(e.model, b).getWorldPosition(new THREE.Vector3())).toFixed(3); });
          log.push({ t: +t.toFixed(2), st: e.state, stateT: +e.stateT.toFixed(2), hp: Game.playerHP, clipT: e.state === 'attack' ? +e._attackClipT().toFixed(2) : null, dist: +Math.hypot(e.mesh.position.x - pp.x, e.mesh.position.z - pp.z).toFixed(2), gearDist: gd });
        }
      }
    }
    if (a.metrics) {
      const es = Enemies.list.filter((e) => !e.dead);
      for (let i = 0; i < es.length; i++) {
        const p = es[i].mesh.position;
        m.minPlayer = Math.min(m.minPlayer, Math.hypot(p.x - pp.x, p.z - pp.z));
        if (t > 4) for (let j = i + 1; j < es.length; j++) m.minPair = Math.min(m.minPair, Math.hypot(p.x - es[j].mesh.position.x, p.z - es[j].mesh.position.z));
        for (const c of World.colliders) m.worstPen = Math.max(m.worstPen, c.r - Math.hypot(p.x - c.x, p.z - c.z));
      }
    }
  }
  return { log, metrics: a.metrics ? { minPairDistanceAfter4s: +m.minPair.toFixed(2), worstColliderPenetration: +m.worstPen.toFixed(2), minDistanceToPlayer: +m.minPlayer.toFixed(2) } : undefined };
}

// C1 helper: play the whole wave flow (1 -> 5 -> victory) in the page without rendering and report transitions + leaks.
function c1WaveRun(a) {
  const dt = 1 / 30;
  const pp = Game.playerObj.position;
  __dbg.godMode(true);
  __dbg.freezeAI(true);                 // the main loop must not double-update while we drive the frame ourselves
  const scene0 = Game.scene.children.length;
  Enemies.clear();
  Waves.stop();
  Waves.start(1);
  const log = [];
  let last = '', t = 0, nextKill = 0, maxList = 0, maxScene = 0;
  while (t < (a.maxT || 600)) {
    Waves.update(dt);
    Enemies.update(dt, pp.clone());
    if (window.Combat && Combat.update) Combat.update(dt);
    if (window.FX && FX.update) FX.update(dt);
    t += dt;
    if (t >= nextKill) { nextKill = t + 0.7; __dbg.killAll(); }
    maxList = Math.max(maxList, Enemies.list.length);
    maxScene = Math.max(maxScene, Game.scene.children.length);
    const w = Waves.snapshot();
    const key = w.wave + '|' + w.state;
    if (key !== last) {
      last = key;
      log.push({ t: +t.toFixed(1), wave: w.wave, state: w.state, pending: w.pending, alive: w.alive, kills: w.kills, list: Enemies.list.length, scene: Game.scene.children.length, boss: w.boss, bossErr: w.bossError ? String(w.bossError).slice(0, 60) : null });
    }
    if (w.state === 'victory' || w.state === 'error') break;
  }
  // let the last corpses linger, sink and be removed (10 s + loose props 15 s)
  for (let i = 0; i < 30 * 30; i++) { Waves.update(dt); Enemies.update(dt, pp.clone()); if (window.Combat && Combat.update) Combat.update(dt); if (window.FX && FX.update) FX.update(dt); }
  return { log, endedAt: +t.toFixed(1), maxList, maxScene, sceneBefore: scene0, sceneAfter: Game.scene.children.length, listAfter: Enemies.list.length, kills: Waves.kills };
}

// C2 helper: a rigged mock knight (bone-attached helmet / sword / shield, Death clip on kill) for testing combat.js while enemies.js is
// still the legacy one. Runs inside the page (serialised by page.evaluate), so it must not reference anything from this module.
function c2SpawnMock(opts) {
  const mesh = Assets.get('knight');
  const hp = opts.hp || 100;
  const e = { mesh, type: 'knight', hp, maxHp: hp, dead: false, state: 'mock', mock: true };
  mesh.userData = { enemy: e, type: 'knight' };
  const cam = Game.camera, f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
  const pp = Game.playerObj.position;
  mesh.position.set(pp.x + f.x * opts.dist, 0, pp.z + f.z * opts.dist);
  mesh.lookAt(pp.x, 0, pp.z);
  Game.scene.add(mesh);
  const mixer = new THREE.AnimationMixer(mesh);
  const clips = Assets.clips('knight');
  const idle = mixer.clipAction(clips.find((c) => c.name === 'Idle_swordRight')); idle.play(); mixer.update(0.4);
  e.mixer = mixer;
  mesh.updateMatrixWorld(true);
  const B = (n) => Assets.bone(mesh, n);
  e.bones = { head: B('Head'), torso: B('Torso'), hips: B('Hips'), handR: B('Palm.R'), handL: B('Palm.L'), armL: B('LowerArm.L'), armR: B('LowerArm.R'), legL: B('UpperLeg.L'), legR: B('UpperLeg.R') };
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const yaw = mesh.rotation.y;
  // helmet on the head (world placement, then attach to the bone: keeps the world transform)
  const helmet = Assets.get('knight_helmet1', { height: 0.5 });
  helmet.position.copy(wp(e.bones.head)).add(new THREE.Vector3(0, 0.0, 0)); helmet.rotation.y = yaw;
  Game.scene.add(helmet); helmet.updateMatrixWorld(true); e.bones.head.attach(helmet); e.helmet = helmet;
  // sword in the right hand, blade up and a little forward
  const sword = Assets.get('knight_sword', { height: 1.1 });
  sword.position.copy(wp(e.bones.handR)).add(new THREE.Vector3(0, -0.12, 0)); sword.rotation.set(0.25, yaw, 0);
  Game.scene.add(sword); sword.updateMatrixWorld(true); e.bones.handR.attach(sword); e.sword = sword;
  // shield on the left forearm, facing outward
  const shield = Assets.get('knight_shield', { height: 0.75 });
  const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  shield.position.copy(wp(e.bones.armL)).addScaledVector(side, 0.12).add(new THREE.Vector3(0, 0.12, 0.0)); shield.rotation.set(0, yaw + Math.PI / 2, 0);
  Game.scene.add(shield); shield.updateMatrixWorld(true); e.bones.armL.attach(shield); e.shield = shield;
  // gameplay surface used by Game / Enemies
  e.takeHit = function (hit) {
    if (this.dead) return;
    this.hp -= hit.damage;
    if (this.hp <= 0) {
      this.dead = true; this.state = 'dead'; this.mesh.userData.dying = true;
      idle.stop();
      const d = mixer.clipAction(clips.find((c) => c.name === 'Death')); d.setLoop(THREE.LoopOnce, 1); d.clampWhenFinished = true; d.reset().play();
      if (window.Combat && Combat.onKill && !this._killFx) Combat.onKill(this, hit, hit.dir);
    }
  };
  e.update = function () {};
  Enemies.list.push(e);
  if (!window.__c2Hook) {                                   // advance mock mixers with the game's own frame loop
    window.__c2Hook = true;
    const orig = Combat.update;
    Combat.update = function (dt) { orig.call(Combat, dt); for (const m of Enemies.list) if (m.mock && m.mixer) m.mixer.update(dt); };
  }
  const p = mesh.position;
  return { i: Enemies.list.length - 1, x: p.x, y: p.y, z: p.z, hp: e.hp, dist: opts.dist, mock: true };
}

// D2 helper (runs in the page, serialised by page.evaluate): drive the REAL frame (Main.step) without rendering and play the
// game with a bot: aim the camera at the head of a live enemy, fire through the real input path (a mousedown on the canvas when the
// pointer is locked, else Game.tryFire), press R (a real keydown) to reload. The virtual clock must be paused so the page's own loop
// does not step in between. a: { maxSec, dt?, shoot, bossFirst, stop: 'never'|'countdown'|'wave:N'|'boss'|'bossHalf'|'bossDead'|'victory' }
function d2Drive(a) {
  const dt = a.dt || 1 / 30;
  const G = Game, cam = G.camera;
  const S = (window.__d2 = window.__d2 || { blocked: new Map(), t: 0 });
  const out = { reached: false, steps: 0, shots: 0, killedByShots: 0, reloadKeys: 0, viaMouse: 0, viaDirect: 0, victoryEarly: false };
  const v = new THREE.Vector3();
  const victoryShown = () => getComputedStyle(document.getElementById('victoryScreen')).display !== 'none';
  const done = () => {
    const w = Waves, b = w.boss;
    switch (a.stop) {
      case 'countdown': return w.state === 'countdown';
      case 'boss': return !!b;
      case 'bossHalf': return !!b && typeof b.hp === 'number' && b.hp <= b.maxHp * 0.5;
      case 'bossDead': return w.bossKilled === true;
      case 'victory': return w.state === 'victory';
      default:
        if (typeof a.stop === 'string' && a.stop.startsWith('wave:')) return w.current === +a.stop.slice(5) && w.state === 'fighting';
        return false;
    }
  };
  const aimPoint = (e, out3) => {
    const sc = e.sizeScale || 1;
    if (e.bones && e.bones.head) { e.bones.head.getWorldPosition(out3); out3.y += 0.235 * sc; }
    else { out3.copy(e.mesh.position); out3.y += (e.height || 1.8) * 0.85; }
    return out3;
  };
  const bot = () => {
    if (G.dead) return;
    const pp = G.playerObj.position;
    // reload when empty (or when idle and not full)
    if (G.reloadTimer <= 0 && G.ammo <= 0) {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
      out.reloadKeys++;
      return;
    }
    if (G.reloadTimer > 0 || G.fireCooldown > 0) return;
    let target = null, best = Infinity;
    for (const e of Enemies.list) {
      if (e.dead || !e.mesh || !e.mesh.parent) continue;
      const bu = S.blocked.get(e);
      if (bu && S.t < bu) continue;
      let d = Math.hypot(e.mesh.position.x - pp.x, e.mesh.position.z - pp.z);
      if (a.bossFirst && e === Waves.boss) d -= 1000;
      if (d < best) { best = d; target = e; }
    }
    if (!target) return;
    target.mesh.updateMatrixWorld(true);        // the aim point reads bone world matrices (fast-forward does not render)
    aimPoint(target, v);
    cam.lookAt(v);
    cam.updateMatrixWorld(true);
    const shots0 = G.shots, hits0 = G.hits, kills0 = Waves.kills;
    let hit;
    if (document.pointerLockElement) {
      const c = document.querySelector('canvas');
      c.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true, view: window }));
      c.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true, cancelable: true, view: window }));
      if (G.shots !== shots0) out.viaMouse++;
    }
    if (G.shots === shots0) { hit = G.tryFire(); if (G.shots !== shots0) out.viaDirect++; }
    if (G.shots !== shots0) {
      out.shots++;
      if (G.hits === hits0) S.blocked.set(target, S.t + 1.0);          // a tree / rock was in the way: pick someone else for a moment
      else if (window.__lastHitInfo && window.__lastHitInfo.killed) out.killedByShots++;
    }
  };
  while (out.steps < Math.ceil(a.maxSec / dt)) {
    if (a.shoot) bot();
    Main.step(dt);
    S.t += dt;
    out.steps++;
    if (!Waves.bossKilled && victoryShown()) out.victoryEarly = true;
    if (done()) { out.reached = true; break; }
  }
  out.t = +S.t.toFixed(1);
  return out;
}

// D1 helper: run the simulation WITHOUT rendering until `until` (an expression on b = the boss) holds or `sec` elapsed.
// Logs every state / atk / phase / player-HP change: a = { sec, step = 1/30, until? }. Runs inside the page (serialised by page.evaluate).
function d1Until(a) {
  const step = a.step || 1 / 30;
  const pp = Game.playerObj.position;
  const b = Enemies.list.find((e) => e.type === 'boss');
  const f = a.until ? new Function('b', 'return (' + a.until + ');') : null;
  const log = [];
  let last = '', t = 0;
  for (; t < a.sec - 1e-9; t += step) {
    Enemies.update(step, pp.clone());
    if (window.Combat && Combat.update) Combat.update(step);
    if (window.FX && FX.update) FX.update(step);
    const key = b.state + '|' + b.atk + '|' + b.phase + '|' + Game.playerHP;
    if (key !== last) {
      last = key;
      log.push({ t: +t.toFixed(2), st: b.state, atk: b.atk, ph: b.phase, playerHP: Game.playerHP, dist: +Math.hypot(b.mesh.position.x - pp.x, b.mesh.position.z - pp.z).toFixed(1), y: +b.mesh.position.y.toFixed(2), stateT: +b.stateT.toFixed(2) });
    }
    if (f && t > 0.05 && f(b)) { t += step; break; }
  }
  return { simulated: +t.toFixed(2), log, info: __dbg.boss.info() };
}

// D1 helper: AI soak (no rendering). a = { sec, kite?: radius (the player runs a circle at 6 m/s), hp?: boss HP fraction to start with }.
function d1Soak(a) {
  const dt = 1 / 30;
  const pp = Game.playerObj.position;
  const b = Enemies.list.find((e) => e.type === 'boss');
  if (a.hp) { b.hp = Math.round(b.maxHp * a.hp); b._checkPhase(); }
  const cnt = { sweep: 0, sweepCombo2: 0, leap: 0, charge: 0, roar: 0 }, dmg = { sweep: 0, leap: 0, charge: 0, other: 0 };
  const stateT = {}, maxState = {};
  let last = '', ang = 0, minD = 99, maxD = 0, worstXZ = 0, hits = 0;
  const kinds = {};
  let prevAtk = null;
  for (let t = 0; t < a.sec; t += dt) {
    if (a.kite) { ang += 6 / a.kite * dt; pp.x = Math.sin(ang) * a.kite; pp.z = Math.cos(ang) * a.kite; pp.y = 1.7; }
    const hp0 = Game.playerHP;
    Enemies.update(dt, pp.clone());
    if (window.Combat && Combat.update) Combat.update(dt);
    if (window.FX && FX.update) FX.update(dt);
    const key = b.state + '|' + b.atk;
    if (key !== last) {
      if (b.state === 'windup' && b.atk === 'sweep') cnt.sweep++;
      else if (b.state === 'windup' && b.atk === 'roar') cnt.roar++;
      else if (b.state === 'leapWind') cnt.leap++;
      else if (b.state === 'chargeWind') cnt.charge++;
      last = key; stateT[key] = 0;
    }
    stateT[key] += dt; maxState[key] = Math.max(maxState[key] || 0, stateT[key]);
    const d = hp0 - Game.playerHP;
    if (d > 0) { hits++; const k = b.atk === 'sweep' ? 'sweep' : b.atk === 'leap' ? 'leap' : b.atk === 'charge' ? 'charge' : 'other'; dmg[k] += d; }
    Game.playerHP = 100;
    const dist = Math.hypot(b.mesh.position.x - pp.x, b.mesh.position.z - pp.z);
    minD = Math.min(minD, dist); maxD = Math.max(maxD, dist);
    worstXZ = Math.max(worstXZ, Math.abs(b.mesh.position.x), Math.abs(b.mesh.position.z));
  }
  const r = (x) => Math.round(x * 100) / 100;
  const ms = {}; for (const k of Object.keys(maxState)) ms[k] = r(maxState[k]);
  return { sec: a.sec, attacks: cnt, damageToPlayer: dmg, hits, longestInState: ms, minDist: r(minD), maxDist: r(maxD), maxAbsCoord: r(worstXZ), phase: b.phase, minions: Enemies.list.filter((e) => e.isMinion && !e.dead).length, listLen: Enemies.list.length };
}
