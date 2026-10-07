/* debug.js — window.__dbg, active ONLY when the page is opened with ?debug=1 (used by tools/qa).
   Best-effort against whatever the other modules currently expose: every helper checks for the optional
   APIs of later waves (Enemies.clear, enemy.takeHit, Waves.stop, ...) and falls back to the original code.
   Modules may attach their own helpers as __dbg.<module> (debug.js loads before main.js runs any init).

   __dbg.godMode(on)                 player takes no damage
   __dbg.skipToWave(n)               clear enemies, start wave n (starts the sim loop if still on the title screen)
   __dbg.spawn(type, dist, angleDeg) 'knight'|'boss'; angleDeg 0 = straight ahead, + = to the right. Returns its snapshot
   __dbg.freezeAI(on)                main loop stops Enemies.update / Waves.update
   __dbg.lookAt(x, y, z)             aim the camera at a world point (also accepts {x,y,z} or [x,y,z])
   __dbg.killAll()                   kill every living enemy through the normal damage path
   __dbg.state()                     JSON snapshot (wave, alive, pending, hp, ammo, enemies with state + clip names)
   extras: begin(), start(), fire(), teleport(x, z, yawDeg?), clear(), ready() */
(function () {
  let enabled = false;
  try { enabled = /[?&]debug=1(?:&|#|$)/.test(location.search); } catch (e) { enabled = false; }
  if (!enabled) return;

  const dbg = { frozen: false, god: false };

  const round = (v) => Math.round(v * 1000) / 1000;
  const playerPos = () => (window.Game && Game.playerObj) ? Game.playerObj.position : null;

  // ---- god mode: wrap Game.hurt once; the wrapper honours dbg.god -------------------------------------------
  function installGodWrap() {
    const G = window.Game;
    if (!G || typeof G.hurt !== 'function' || G.hurt.__dbgWrapped) return;
    const orig = G.hurt;
    G.hurt = function () {
      if (dbg.god) return;
      return orig.apply(this, arguments);
    };
    G.hurt.__dbgWrapped = true;
  }

  // ---- helpers ----------------------------------------------------------------------------------------------
  function isDead(e) {
    return !!(e.dead || (e.mesh && e.mesh.userData && e.mesh.userData.dying));
  }

  function clipName(e) {
    if (typeof e.currentClip === 'string') return e.currentClip;
    if (e.actions && typeof e.actions === 'object') {
      let best = null, bw = 0;
      for (const k of Object.keys(e.actions)) {
        const a = e.actions[k];
        if (!a || typeof a.isRunning !== 'function' || !a.isRunning()) continue;
        const w = typeof a.getEffectiveWeight === 'function' ? a.getEffectiveWeight() : 1;
        if (w > bw) { bw = w; best = k; }
      }
      return best;
    }
    return null;
  }

  function describe(e) {
    const ud = (e.mesh && e.mesh.userData) || {};
    const p = e.mesh ? e.mesh.position : null;
    const pp = playerPos();
    return {
      type: e.type || ud.type || null,
      hp: e.hp !== undefined ? e.hp : (ud.hp !== undefined ? ud.hp : null),
      maxHp: e.maxHp !== undefined ? e.maxHp : null,
      state: e.state !== undefined ? e.state : null,
      clip: clipName(e),
      dead: isDead(e),
      pos: p ? [round(p.x), round(p.y), round(p.z)] : null,
      dist: (p && pp) ? round(Math.hypot(p.x - pp.x, p.z - pp.z)) : null
    };
  }

  function clearEnemies() {
    const E = window.Enemies;
    if (!E) return;
    if (typeof E.clear === 'function') { E.clear(); return; }
    const scene = window.Game && Game.scene;
    for (const e of E.list.slice()) { if (scene && e.mesh) scene.remove(e.mesh); }
    E.list.length = 0;
  }

  // ---- public API -------------------------------------------------------------------------------------------
  dbg.ready = function () { return !!window.__bootReady; };

  dbg.begin = function () { return !!(window.Main && Main.begin && Main.begin()); };
  dbg.start = function () { if (window.Main && Main.start) Main.start(); };

  dbg.godMode = function (on) {
    dbg.god = (on === undefined) ? true : !!on;
    if (window.Game) Game.godMode = dbg.god;   // game.js may also honour this flag directly
    installGodWrap();
    return dbg.god;
  };

  dbg.clear = function () { clearEnemies(); };

  dbg.skipToWave = function (n) {
    n = Math.max(1, Math.floor(Number(n) || 1));
    dbg.begin();
    clearEnemies();
    const W = window.Waves;
    if (!W) return false;
    // stop whatever the previous wave was still doing (pending spawns, timers)
    if (typeof W.stop === 'function') W.stop();
    else { W.active = false; W.respawnPending = 0; if ('pending' in W) W.pending = 0; }
    W.start(n);
    return true;
  };

  dbg.spawn = function (type, dist, angleDeg) {
    type = type || 'knight';
    dist = (dist === undefined) ? 8 : Number(dist);
    const a = (angleDeg === undefined ? 0 : Number(angleDeg)) * Math.PI / 180;
    dbg.begin();
    const cam = Game.camera;
    const f = new THREE.Vector3();
    cam.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);        // camera-right on the ground plane
    const p = Game.playerObj.position;
    const x = p.x + f.x * Math.cos(a) * dist + r.x * Math.sin(a) * dist;
    const z = p.z + f.z * Math.cos(a) * dist + r.z * Math.sin(a) * dist;
    const Cls = (type === 'boss') ? window.Boss : window.Knight;
    if (!Cls) throw new Error('__dbg.spawn: class for "' + type + '" is not available');
    const k = new Cls();
    k.mesh.position.set(x, 0, z);
    Enemies.add(k);
    return describe(k);
  };

  dbg.freezeAI = function (on) {
    dbg.frozen = (on === undefined) ? true : !!on;
    return dbg.frozen;
  };

  dbg.lookAt = function (x, y, z) {
    if (Array.isArray(x)) { z = x[2]; y = x[1]; x = x[0]; }
    else if (x && typeof x === 'object') { z = x.z; y = x.y; x = x.x; }
    Game.camera.lookAt(Number(x), Number(y), Number(z));
    return true;
  };

  dbg.teleport = function (x, z, yawDeg) {
    const p = Game.playerObj.position;
    p.x = Number(x); p.z = Number(z); p.y = 1.7;
    if (yawDeg !== undefined) {
      const q = Game.camera;
      q.rotation.order = 'YXZ';
      q.rotation.set(0, Number(yawDeg) * Math.PI / 180, 0);
    }
    return true;
  };

  dbg.fire = function () { return Game.tryFire(); };

  dbg.killAll = function () {
    const E = window.Enemies;
    if (!E) return 0;
    let n = 0;
    for (const e of E.list.slice()) {
      if (isDead(e)) continue;
      const p = e.mesh.position;
      if (typeof e.takeHit === 'function') {
        e.takeHit({ damage: 1e6, zone: 'torso', point: new THREE.Vector3(p.x, 1, p.z), dir: new THREE.Vector3(0, 0, -1) });
      } else if (typeof E.hurt === 'function') {
        E.hurt(e.mesh, 1e6);
      } else if (typeof e.die === 'function') {
        e.die();
      }
      n++;
    }
    return n;
  };

  dbg.state = function () {
    const G = window.Game || {}, W = window.Waves || {}, E = window.Enemies || { list: [] };
    const enemies = E.list.map(describe);
    const pp = playerPos();
    let yaw = null;
    if (G.camera) {
      const d = new THREE.Vector3(); G.camera.getWorldDirection(d);
      yaw = round(Math.atan2(-d.x, -d.z) * 180 / Math.PI);   // 0 = looking down -Z, + = turning left
    }
    const pending = (W.pending !== undefined) ? W.pending : W.respawnPending;
    const alive = (typeof E.aliveCount === 'function') ? E.aliveCount() : enemies.filter(e => !e.dead).length;
    return JSON.parse(JSON.stringify({
      started: !!(window.Main && Main.isStarted && Main.isStarted()),
      wave: W.current !== undefined ? W.current : null,
      waveActive: W.active !== undefined ? !!W.active : null,
      pending: pending !== undefined ? pending : null,
      alive: alive,
      hp: G.playerHP !== undefined ? G.playerHP : null,
      ammo: G.ammo !== undefined ? G.ammo : null,
      reloading: !!(G.reloadTimer > 0),
      kills: G.kills !== undefined ? G.kills : null,
      shots: G.shots !== undefined ? G.shots : null,
      dead: !!G.dead,
      godMode: dbg.god,
      frozen: dbg.frozen,
      player: pp ? { x: round(pp.x), y: round(pp.y), z: round(pp.z), yawDeg: yaw } : null,
      enemies: enemies
    }));
  };

  window.__dbg = dbg;
})();
