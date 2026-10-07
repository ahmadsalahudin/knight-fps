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
};
