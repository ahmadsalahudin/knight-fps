/* game.js — window.Game, window.Player, window.getInput
   Extracted from the single-file build. The revolver viewmodel code moved to weapon.js (Weapon.init/fire/update);
   everything else is unchanged. */
window.getInput = function () {
  const input = { forward: false, backward: false, left: false, right: false, sprint: false };
  const keys = {};
  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'KeyR') { if (window.Game && Game.tryReload) Game.tryReload(); }
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });
  return function () {
    input.forward = !!(keys['KeyW'] || keys['ArrowUp']);
    input.backward = !!(keys['KeyS'] || keys['ArrowDown']);
    input.left = !!(keys['KeyA'] || keys['ArrowLeft']);
    input.right = !!(keys['KeyD'] || keys['ArrowRight']);
    input.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    return input;
  };
};

window.Game = {
  playerHP: 100,
  kills: 0,
  shots: 0,
  dead: false,
  reloading: false,   // true on frames where the reload branch of update() ran (drives the gun flourish)
  moving: false,
  sprinting: false,

  init: function (scene, camera, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    const self = this;

    this.controls = new THREE.PointerLockControls(camera, renderer.domElement);
    this.playerObj = this.controls.getObject();
    this.playerObj.position.set(0, 1.7, 0);
    scene.add(this.playerObj);

    // revolver viewmodel is created by Weapon.init() (weapon.js), called from main.js before Game.init

    // fire on mousedown (semi-auto, 350ms gate)
    this.fireCooldown = 0;
    this.ammo = 6;
    this.reloadTimer = 0;
    document.addEventListener('mousedown', function (e) {
      if (document.pointerLockElement && e.button === 0) self.tryFire();
    });

    this.getInput = window.getInput();

    // HUD ammo init
    if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, 6, false);
    if (window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
  },

  tryReload: function () {
    if (this.reloadTimer > 0 || this.ammo === 6) return;
    this.reloadTimer = 1600;
    if (window.Sfx && Sfx.reload) Sfx.reload();
    if (window.Weapon && Weapon.reload) Weapon.reload(1600);
  },

  tryFire: function () {
    if (this.dead || this.reloadTimer > 0 || this.fireCooldown > 0) return;
    if (this.ammo <= 0) { this.tryReload(); return; }
    this.ammo--;
    this.fireCooldown = 350;
    this.shots++;
    if (window.Sfx && Sfx.shoot) Sfx.shoot();
    if (window.Smite && Smite.arm) { const _s = {}; Smite.arm(_s); this._lastShot = _s; }
    if (window.Weapon && Weapon.fire) Weapon.fire();

    // hitscan against enemies — origin at CAMERA world position (rig parent offsets must not shift ray)
    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const rc = new THREE.Raycaster(origin, dir, 0.1, 200);
    if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, 6, false);

    const targets = window.Enemies && Enemies.rayTargets ? Enemies.rayTargets() : [];
    const hits = rc.intersectObjects(targets, true);
    if (hits.length) {
      // enemy roots are IN targets; walk up from hit child until we hit a root in targets
      let node = hits[0].object;
      while (node && !targets.includes(node)) node = node.parent;
      if (node) {
        window.Enemies.hurt(node, 34, hits[0].point);
        const hitInfo = { object: node, point: hits[0].point, distance: hits[0].distance, shot: this._lastShot || null };
        if (window.Smite && Smite.maybeApply) Smite.maybeApply(hitInfo);
        if (window.HUD && HUD.hitmark) HUD.hitmark();
        window.__lastHitInfo = hitInfo;
        return hitInfo;
      }
    }
  },

  hurt: function (dmg) {
    if (this.dead) return;
    this.playerHP = Math.max(0, this.playerHP - dmg);
    if (window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
    if (window.HUD && HUD.playerHit) HUD.playerHit();
    if (this.playerHP <= 0) {
      this.dead = true;
      document.exitPointerLock();
      const best = Number(localStorage.getItem('kf_best') || 0);
      const wave = window.Waves && Waves.current !== undefined ? (window.Waves.current.call ? window.Waves.current() : window.Waves.current) : 1;
      if (wave > best) localStorage.setItem('kf_best', String(wave));
      if (window.HUD && HUD.gameOver) HUD.gameOver(wave, wave > best);
    }
  },

  update: function (dt) {
    if (this.fireCooldown > 0) this.fireCooldown -= dt * 1000;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt * 1000;
      if (this.reloadTimer <= 0) {
        this.ammo = 6;
        if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, 6, false);
      }
      this.reloading = true;   // main.js passes this to Weapon.update() for the reload flourish
      return;
    }
    this.reloading = false;
    if (!document.hasFocus()) return;  // pointer lock optional in QA (headless may not lock) — focus is what matters

    const input = this.getInput();
    const speed = input.sprint ? 11 : 6;
    this.moving = !!(input.forward || input.backward || input.left || input.right);   // read by main.js -> Weapon.update
    this.sprinting = !!input.sprint;

    // r147-native movement: moveForward/moveRight handle yaw-correct axes internally.
    // (never hand-rolled: my applyAxisAngle(yaw) version inverted A/D)
    const step = speed * dt;
    if (input.forward) this.controls.moveForward(step);
    if (input.backward) this.controls.moveForward(-step);
    if (input.left) this.controls.moveRight(-step);
    if (input.right) this.controls.moveRight(step);

    // collider clamp: don't fight movement — only cancel penetration after the move
    const p = this.playerObj.position;
    for (const c of window.World.colliders) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < c.r + 0.45) {
        const push = (c.r + 0.45 - d);
        p.x += (dx / (d || 1)) * push;
        p.z += (dz / (d || 1)) * push;
      }
    }
    p.x = Math.max(-58, Math.min(58, p.x));
    p.z = Math.max(-58, Math.min(58, p.z));
    p.y = 1.7;
  }
};

window.Player = {
  hurt: function (dmg) {
    if (window.Sfx && Sfx.hurt) Sfx.hurt();
    window.Game.hurt(dmg);
  },
  hp: function () { return window.Game.playerHP; },
  fire: function () { return window.Game.tryFire.apply(window.Game, arguments); },
  get position() {
    return (window.Game && window.Game.playerObj) ? window.Game.playerObj.position : new THREE.Vector3();
  }
};
