/* main.js — bootstrap: renderer, scene, lights, module init, start button, render loop.
   Every module call is guarded (missing module => skipped, throwing module => logged, loop keeps running).
   Boot order:  Assets.load -> World.build -> FX.init -> Weapon.init -> Game.init -> HUD.init
   Frame order: Game.update, Enemies.update, Waves.update, Smite.update, Combat.update, FX.update,
                Weapon.update, renderer.render, Weapon.render
   Exposes (for debug.js / QA): window.Main = { scene, camera, renderer, begin(), start(), isStarted() }
   and sets window.__bootReady = true once boot finished, window.__gameStarted = true on start. */
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
      // glTF materials need sRGB output; the legacy hand-written parser was tuned for linear output, so the
      // loader module opts in by setting Assets.srgbOutput = true (B1).
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

      // Assets (async-capable: the GLTFLoader version resolves after parsing; the legacy parser has no load()).
      if (window.Assets && typeof window.Assets.load === 'function') await window.Assets.load();

      // Module init. World/Game are required (they were required in the original too), the rest are optional.
      window.World.build(scene);
      call('FX', 'init', scene, camera);
      call('Weapon', 'init', camera, renderer);
      window.Game.init(scene, camera, renderer);
      call('HUD', 'init');

      const clock = new THREE.Clock();
      let started = false;

      // begin(): leave the title screen and run the simulation loop, without starting any wave.
      function begin() {
        if (started) return false;
        started = true;
        window.__gameStarted = true;
        document.getElementById('lock').style.display = 'none';
        return true;
      }
      function startWaves() {
        if (!begin()) return;
        try { window.Waves.start(1); } catch (e) { console.error('Waves.start', e); }
      }

      window.Main = { scene: scene, camera: camera, renderer: renderer, begin: begin, start: startWaves, isStarted: function () { return started; } };

      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = 'START';
        startBtn.addEventListener('click', function () {
          try { window.Game.controls.lock(); } catch (e) { console.error('lock', e); }
          startWaves();  // unconditional — Brave/Firefox lock must not gate waves
        });
      }

      document.addEventListener('pointerlockchange', function () {
        if (document.pointerLockElement) startWaves();
      });

      (function loop() {
        requestAnimationFrame(loop);
        const dt = Math.min(clock.getDelta(), 0.1);
        if (started && !window.Game.dead) {
          const frozen = !!(window.__dbg && window.__dbg.frozen);   // ?debug=1: __dbg.freezeAI(true)
          call('Game', 'update', dt);
          if (!frozen) {
            if (window.Enemies && typeof Enemies.update === 'function') {
              call('Enemies', 'update', dt, window.Game.playerObj.position.clone());
            }
            call('Waves', 'update', dt);
          }
          call('Smite', 'update', dt);
          call('Combat', 'update', dt);
          call('FX', 'update', dt);
          call('Weapon', 'update', dt, {
            reloading: !!window.Game.reloading,
            moving: !!window.Game.moving,
            sprinting: !!window.Game.sprinting
          });
          // live spawn badge (debug leftover from the original; harmless if the element is removed)
          const badge = document.getElementById('spawnBadge');
          if (badge && window.Enemies) badge.textContent = 'SPAWN OK (' + window.Enemies.list.length + ')';
        }
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
