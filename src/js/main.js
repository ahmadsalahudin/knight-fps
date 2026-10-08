/* main.js - bootstrap: renderer, scene, lights, module init, start button, pause overlay, render loop.
   Every module call is guarded (missing module => skipped, throwing module => logged, loop keeps running).
   Boot order:  Assets.load -> World.build -> FX.init -> Weapon.init -> Game.init -> HUD.init
   Frame order (Main.step): Game.update, Sfx.update, Enemies.update, Waves.update, Combat.update, FX.update, Weapon.update;
                then renderer.render, Weapon.render (the viewmodel is drawn over the world).
   Exposes (for debug.js / QA): window.Main = { scene, camera, renderer, begin(), start(), step(dt), isStarted(),
   isPaused(), pause(), resume(), autoPause } and sets window.__bootReady = true once boot finished,
   window.__gameStarted = true on start.
   Main.step(dt) is one simulation frame without rendering: QA can fast-forward long stretches in-page with it
   (pause the virtual clock first so the real loop does not step in between).
   Pause: when the pointer lock is lost mid-game (Esc, alt-tab) the simulation pauses and a "click to resume" overlay
   re-captures the mouse. It is off by default under ?debug=1 (autoPause = false, QA never has a reliable lock). */
(function () {
  const errCount = {};
  // Call window[mod][fn](...args) if it exists; never throws. Logs the first few errors per call site.
  function call(mod, fn /* , ...args */) {
    const m = window[mod];
    if (!m || typeof m[fn] !== 'function') return undefined;
    try {
      return m[fn].apply(m, Array.prototype.slice.call(arguments, 2));
    } catch (e) {
      const k = mod + '.' + fn;
      errCount[k] = (errCount[k] || 0) + 1;
      if (errCount[k] <= 3) console.error('[main] ' + k + ' threw', e);
      return undefined;
    }
  }

  async function boot() {
    const startBtn = document.getElementById('startBtn');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Loading…'; }
    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xa8c8e8);
      scene.fog = new THREE.FogExp2(0x9fb98a, 0.018);
      const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(innerWidth, innerHeight);
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      // glTF colours are linear: assets.js sets Assets.srgbOutput so the renderer converts to sRGB on output.
      if (window.Assets && window.Assets.srgbOutput) renderer.outputEncoding = THREE.sRGBEncoding;
      document.body.appendChild(renderer.domElement);
      addEventListener('resize', () => {
        camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
        call('Weapon', 'resize', innerWidth, innerHeight);
      });

      scene.add(new THREE.HemisphereLight(0xbfd6e4, 0x6a8f5a, 0.95));
      const sun = new THREE.DirectionalLight(0xfff3d6, 1.05);
      sun.position.set(40, 60, 20); sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
      sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
      scene.add(sun);

      if (window.Assets && typeof window.Assets.load === 'function') await window.Assets.load();

      // Module init. World/Game are required, the rest are optional.
      window.World.build(scene);
      call('FX', 'init', scene, camera);
      call('Weapon', 'init', camera, renderer);
      window.Game.init(scene, camera, renderer);
      call('HUD', 'init');

      const clock = new THREE.Clock();
      const lockEl = document.getElementById('lock');
      const pauseEl = document.getElementById('pauseScreen');
      let started = false;
      let paused = false;

      // Ask for the pointer lock without leaving an unhandled rejection behind (Chrome rejects the request when it comes
      // too soon after Esc, or the page is not focused). `onFail` runs on a rejection and on 'pointerlockerror'.
      let onLockFail = null;
      function requestLock(onFail) {
        onLockFail = onFail || null;
        try {
          const p = renderer.domElement.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(function () { lockFailed(); });
        } catch (e) { console.warn('[main] pointer lock request failed', e); lockFailed(); }
      }
      function lockFailed() { const f = onLockFail; onLockFail = null; if (f) f(); }

      // begin(): leave the title screen and run the simulation loop, without starting any wave.
      function begin() {
        if (started) return false;
        started = true;
        window.__gameStarted = true;
        document.body.classList.add('playing');
        if (lockEl) lockEl.style.display = 'none';
        call('Sfx', 'init');                                 // START is a user gesture: the AudioContext may start now
        call('Sfx', 'ambient', true);                        // meadow wind and birds
        return true;
      }
      function startWaves() {
        if (!begin()) return;
        try { window.Waves.start(1); } catch (e) { console.error('Waves.start', e); }
      }

      function setPaused(on) {
        on = !!on;
        if (paused === on) return;
        paused = on;
        if (pauseEl) pauseEl.style.display = on ? 'flex' : 'none';
      }

      // One simulation frame (no rendering). Called by the loop and by QA fast-forwards.
      function step(dt) {
        if (!started || paused || window.Game.dead) return;
        const frozen = !!(window.__dbg && window.__dbg.frozen);   // ?debug=1: __dbg.freezeAI(true)
        call('Game', 'update', dt);
        call('Sfx', 'update', dt, window.Game.camera);       // the 3D audio listener follows the camera
        if (!frozen) {
          call('Enemies', 'update', dt, window.Game.playerObj.position);
          call('Waves', 'update', dt);
        }
        call('Combat', 'update', dt);
        call('FX', 'update', dt);
        call('Weapon', 'update', dt, {
          reloading: !!window.Game.reloading,
          moving: !!window.Game.moving,
          sprinting: !!window.Game.sprinting
        });
      }

      window.Main = {
        scene: scene, camera: camera, renderer: renderer,
        begin: begin, start: startWaves, step: step,
        isStarted: function () { return started; },
        isPaused: function () { return paused; },
        pause: function () { setPaused(true); },
        resume: function () { setPaused(false); },
        autoPause: !window.__dbg
      };

      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = 'START';
        startBtn.addEventListener('click', function () {
          requestLock();
          startWaves();  // unconditional: a refused lock (Brave/Firefox, headless) must not gate the waves
        });
      }
      // click on the pause overlay: resume at once; if the browser refuses the lock (Chrome blocks a re-lock for ~1 s after
      // Esc) the overlay comes back instead of leaving a running game that cannot be aimed.
      if (pauseEl) pauseEl.addEventListener('click', function () {
        requestLock(function () { if (started && window.Main.autoPause) setPaused(true); });
        setPaused(false);
      });
      document.addEventListener('pointerlockerror', lockFailed);

      document.addEventListener('pointerlockchange', function () {
        if (document.pointerLockElement) { onLockFail = null; startWaves(); setPaused(false); return; }
        // lock lost while playing (Esc / alt-tab): pause, unless the run is over
        const W = window.Waves;
        const over = window.Game.dead || (W && W.state === 'victory');
        if (started && !over && window.Main.autoPause) setPaused(true);
      });

      (function loop() {
        requestAnimationFrame(loop);
        const dt = Math.min(clock.getDelta(), 0.1);
        step(dt);
        try { renderer.render(scene, camera); } catch (e) {
          errCount.render = (errCount.render || 0) + 1;
          if (errCount.render <= 3) console.error('[main] renderer.render threw', e);
        }
        call('Weapon', 'render', renderer);
      })();

      window.__bootReady = true;
    } catch (e) {
      console.error('BOOTSTRAP FAIL', e);
      document.body.insertAdjacentHTML('beforeend', '<pre style="color:red;z-index:99;position:fixed;max-width:80vw;overflow:auto">' + e.stack + '</pre>');
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
