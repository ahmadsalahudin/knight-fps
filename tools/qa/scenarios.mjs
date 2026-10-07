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

};
