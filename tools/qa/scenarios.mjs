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
