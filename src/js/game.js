/* game.js — window.Game, window.Player, window.getInput  (B2)
   Movement, colliders, HP and the firing pipeline.

   Firing pipeline (docs/FIX_PLAN.md "Game / Player"):
     Weapon.fire() -> muzzle position; hitscan from the camera centre against Enemies.rayTargets() AND
     World.staticTargets, nearest wins.
       enemy : Combat.zoneFor -> Combat.damageFor -> enemy.takeHit({damage,zone,point,dir})
               -> Combat.onHit / Combat.onKill -> HUD.hitmark('hit'|'head'|'kill')
       world : FX.dust + FX.impactDecal
       always: FX.tracer(muzzle, point), FX.shake, Sfx.shoot, camera kick
   Every cross-module call is guarded, so any module can be missing.
   Kills: Waves owns the kill counter when Waves.onEnemyKilled exists; otherwise Game counts them itself.
   Controls: WASD / arrow keys move, Shift sprints, mouse aims (pointer lock), left button fires, R reloads. */
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

(function () {
  const MAX_AMMO = 6;
  const RELOAD_MS = 1600;
  const FIRE_GATE_MS = 350;
  const FALLBACK_DAMAGE = 34;     // used only when Combat.damageFor is absent
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  const _origin = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  function isDead(e) {
    return !!e && (e.dead === true || (typeof e.hp === 'number' && e.hp <= 0));
  }

  // first intersection whose object (and all of its ancestors) is visible
  function firstVisible(hits) {
    for (let i = 0; i < hits.length; i++) {
      let o = hits[i].object, ok = true;
      while (o) { if (o.visible === false) { ok = false; break; } o = o.parent; }
      if (ok) return hits[i];
    }
    return null;
  }

  // Raycasts read the world matrices and the skeleton as of the LAST render (skinned meshes are tested at their posed
  // vertices via skeleton.boneMatrices). Refresh the targets first so a shot is exact even when the frame is stale
  // (long frame, or a headless fast-forward that steps the simulation without rendering).
  function refreshTargets(list) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      m.updateMatrixWorld(true);
      m.traverse(function (o) { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
    }
  }

  // damped spring used for the camera kick (angle in radians)
  function kickStep(k, dt) {
    const w = 22, z = 0.8, n = Math.max(1, Math.ceil(dt / 0.006)), h = dt / n;
    for (let i = 0; i < n; i++) {
      k.pv += (-w * w * k.p - 2 * z * w * k.pv) * h; k.p += k.pv * h;
      k.yv += (-w * w * k.y - 2 * z * w * k.yv) * h; k.y += k.yv * h;
    }
  }

  window.Game = {
    playerHP: 100,
    shots: 0,
    hits: 0,
    headshots: 0,
    dead: false,
    godMode: false,
    reloading: false,   // true while a reload is in progress (main.js passes it to Weapon.update; Weapon ignores it)
    moving: false,
    sprinting: false,
    maxAmmo: MAX_AMMO,

    // Kill counter. If Waves owns the count (Waves.onEnemyKilled exists) its number is the truth.
    get kills() {
      if (window.Waves && typeof Waves.onEnemyKilled === 'function' && typeof Waves.kills === 'number') return Waves.kills;
      return this._kills || 0;
    },
    set kills(v) { this._kills = v; },

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
      this.ammo = MAX_AMMO;
      this.reloadTimer = 0;
      this._kills = 0;
      this._kick = { p: 0, pv: 0, y: 0, yv: 0 };          // camera kick spring state
      this._kickApplied = { p: 0, y: 0 };                  // portion of the kick currently baked into the camera
      this._shakeApplied = new THREE.Vector3();            // shake offset currently added to the camera position
      this._stride = 0;
      this._raycaster = new THREE.Raycaster();
      document.addEventListener('mousedown', function (e) {
        if (document.pointerLockElement && e.button === 0) self.tryFire();
      });

      this.getInput = window.getInput();

      // HUD init
      if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, false);
      if (window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
    },

    tryReload: function () {
      if (this.dead || this.reloadTimer > 0 || this.ammo === MAX_AMMO) return;
      this.reloadTimer = RELOAD_MS;
      this.reloading = true;
      if (window.Sfx && Sfx.reload) Sfx.reload();
      if (window.Weapon && Weapon.reload) Weapon.reload(RELOAD_MS);
      if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, true);
    },

    // Resolve the enemy object (Knight / Boss) from a mesh that was hit.
    _enemyFromObject: function (obj) {
      let enemy = null;
      if (window.Enemies && typeof Enemies.findByObject === 'function') {
        try { enemy = Enemies.findByObject(obj); } catch (e) { enemy = null; }
      }
      if (enemy) return enemy;
      for (let n = obj; n && !enemy; n = n.parent) {
        if (n.userData && n.userData.enemy) enemy = n.userData.enemy;
        else if (window.Enemies && Enemies.list) enemy = Enemies.list.find(function (e) { return e.mesh === n; }) || null;
      }
      return enemy;
    },

    tryFire: function () {
      if (this.dead || this.reloadTimer > 0 || this.fireCooldown > 0) return;
      if (this.ammo <= 0) {
        if (window.Sfx && Sfx.dryFire) Sfx.dryFire();
        this.tryReload();
        return;
      }
      this.ammo--;
      this.fireCooldown = FIRE_GATE_MS;
      this.shots++;
      if (window.Sfx && Sfx.shoot) Sfx.shoot();
      if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, false);

      // ray: from the camera centre along its view direction (the viewmodel never shifts the aim)
      const camera = this.camera;
      camera.updateMatrixWorld(true);
      camera.getWorldPosition(_origin);
      camera.getWorldDirection(_dir);
      const origin = _origin.clone(), dir = _dir.clone();

      // viewmodel animation; returns the muzzle in world space (for the tracer)
      let muzzle = null;
      if (window.Weapon && Weapon.fire) {
        try { muzzle = Weapon.fire(); } catch (e) { muzzle = null; }
      }
      if (!muzzle || !isFinite(muzzle.x)) muzzle = origin.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0.12, -0.12, 0).applyQuaternion(camera.quaternion));

      // camera kick (pitch up, slight random yaw) + small shake
      const k = this._kick;
      k.pv += 0.8 + Math.random() * 0.2;
      k.yv += (Math.random() - 0.5) * 0.24;
      if (window.FX && FX.shake) FX.shake(0.07);

      // ---- hitscan: nearest of enemies and static world geometry -------------------------------------------------
      const rc = this._raycaster;
      rc.set(origin, dir);
      rc.near = 0.1; rc.far = 200;
      const eTargets = (window.Enemies && Enemies.rayTargets) ? Enemies.rayTargets() : [];
      refreshTargets(eTargets);
      const eHit = eTargets.length ? firstVisible(rc.intersectObjects(eTargets, true)) : null;
      const sTargets = (window.World && World.staticTargets) ? World.staticTargets : null;
      const wHit = (sTargets && sTargets.length) ? firstVisible(rc.intersectObjects(sTargets, true)) : null;

      let hitInfo = null;
      let endPoint = null;
      if (eHit && (!wHit || eHit.distance <= wHit.distance)) {
        endPoint = eHit.point.clone();
        hitInfo = this._hitEnemy(eHit, eTargets, dir);
      } else if (wHit) {
        endPoint = wHit.point.clone();
        this._hitWorld(wHit, dir);
      } else {
        endPoint = origin.clone().addScaledVector(dir, 120);
      }

      if (window.FX && FX.tracer) FX.tracer(muzzle, endPoint);
      if (hitInfo) window.__lastHitInfo = hitInfo;
      return hitInfo || undefined;
    },

    _hitWorld: function (hit, dir) {
      const n = new THREE.Vector3(0, 1, 0);
      if (hit.face && hit.face.normal) n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (n.dot(dir) > 0) n.negate();
      if (window.FX && FX.dust) FX.dust(hit.point, n);
      if (window.FX && FX.impactDecal) FX.impactDecal(hit.point, n);
    },

    _hitEnemy: function (hit, targets, dir) {
      // root mesh (member of rayTargets) containing the hit object
      let root = hit.object;
      while (root && targets.indexOf(root) < 0) root = root.parent;
      const enemy = this._enemyFromObject(hit.object) || this._enemyFromObject(root);
      const point = hit.point.clone();
      const hitInfo = { object: root || hit.object, enemy: enemy, point: point, distance: hit.distance,
        zone: 'torso', damage: 0, killed: false };
      this.hits++;

      let zone = 'torso', damage = FALLBACK_DAMAGE;
      if (enemy && window.Combat) {
        try { if (Combat.zoneFor) zone = Combat.zoneFor(enemy, hit) || 'torso'; } catch (e) { console.error('[Game] Combat.zoneFor', e); }
        try { if (Combat.damageFor) { const d = Combat.damageFor(zone, enemy); if (typeof d === 'number' && isFinite(d)) damage = d; } } catch (e) { console.error('[Game] Combat.damageFor', e); }
      }
      hitInfo.zone = zone; hitInfo.damage = damage;
      if (zone === 'head') this.headshots++;

      const wasDead = isDead(enemy);
      const hitData = { damage: damage, zone: zone, point: point.clone(), dir: dir.clone() };
      try {
        if (enemy && typeof enemy.takeHit === 'function') enemy.takeHit(hitData);
      } catch (e) { console.error('[Game] enemy hit failed', e); }
      const killed = !wasDead && isDead(enemy);
      hitInfo.killed = killed;

      // hit / kill reactions (sparks, blood, knockback, loose gear ...) live in Combat; plain FX fallback otherwise
      let kind = killed ? 'kill' : (zone === 'head' ? 'head' : 'hit');
      if (window.Combat) {
        try {
          if (killed) {
            // the enemy's own die() already called Combat.onKill (Knight.die); Combat flags that with enemy._killFx
            if (!enemy._killFx && Combat.onKill) { const r = Combat.onKill(enemy, hit, dir); if (r === 'hit' || r === 'head' || r === 'kill') kind = r; }
          } else if (Combat.onHit) {
            const r = Combat.onHit(enemy, hit, dir);
            if (r === 'hit' || r === 'head') kind = r;
          }
        } catch (e) { console.error('[Game] Combat reaction', e); }
      }
      if (window.HUD && HUD.hitmark) HUD.hitmark(kind);

      if (killed) this._onKill(enemy);
      return hitInfo;
    },

    // Waves owns the kill counter when it exists (onEnemyKilled is deduped per enemy there, so the enemy's own die()
    // calling it as well can never double count); otherwise count here.
    _onKill: function (enemy) {
      if (window.Waves && typeof Waves.onEnemyKilled === 'function') {
        try { Waves.onEnemyKilled(enemy); } catch (e) { console.error('[Game] Waves.onEnemyKilled', e); }
        return;
      }
      if (enemy && enemy.__gameCounted) return;
      if (enemy) enemy.__gameCounted = true;
      this.kills = (this._kills || 0) + 1;
      if (window.HUD && HUD.setKills) HUD.setKills(this._kills);
    },

    stats: function () {
      return { kills: this.kills, shots: this.shots, hits: this.hits, headshots: this.headshots,
        accuracy: this.shots ? this.hits / this.shots : 0 };
    },

    // dmg: hit points; from (optional): Vector3 / Object3D / enemy / {x,z} the attack came from (drives the HUD arc)
    hurt: function (dmg, from) {
      if (this.dead || this.godMode) return;
      this.playerHP = Math.max(0, this.playerHP - dmg);
      if (window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
      if (window.HUD && HUD.playerHit) HUD.playerHit(this._attackerPos(from));
      if (window.FX && FX.shake) FX.shake(0.3);
      this._kick.pv -= 0.35;                                   // small jolt: the view dips for a moment
      if (this.playerHP <= 0) {
        this.dead = true;
        this.reloadTimer = 0; this.reloading = false;
        this._removeShake();
        try { document.exitPointerLock(); } catch (e) { /* ignore */ }
        let best = 0;
        try { best = Number(localStorage.getItem('kf_best') || 0); } catch (e) { best = 0; }
        const wave = this._wave();
        const isBest = wave > best;
        if (isBest) { try { localStorage.setItem('kf_best', String(wave)); } catch (e) { /* ignore */ } }
        if (window.HUD && HUD.gameOver) {
          const st = this.stats();
          let ws = null;
          try { ws = (window.Waves && Waves.stats) ? Waves.stats() : null; } catch (e) { ws = null; }
          HUD.gameOver(Object.assign({ wave: wave, kills: st.kills, shots: st.shots, hits: st.hits, headshots: st.headshots,
            accuracy: st.accuracy, best: Math.max(best, wave) }, ws || {}, { newBest: isBest, isBest: isBest }));
        }
      }
    },

    _wave: function () {
      const W = window.Waves;
      if (!W || W.current === undefined) return 1;
      return typeof W.current === 'function' ? W.current() : W.current;
    },

    // World position {x, z} of whatever attacked (Vector3 / Object3D / enemy / {x,z}); undefined when unknown.
    // HUD.playerHit turns it into a view-relative arrow (0 = ahead, +PI/2 = right, PI = behind) and keeps tracking it.
    _attackerPos: function (from) {
      if (!from) return undefined;
      let p = null;
      if (from.isVector3) p = from;
      else if (from.isObject3D) p = from.getWorldPosition(_tmp);
      else if (from.mesh && from.mesh.position) p = from.mesh.position;
      else if (typeof from.x === 'number' && typeof from.z === 'number') p = from;
      return p ? { x: p.x, z: p.z } : undefined;
    },

    _removeShake: function () {
      if (this._shakeApplied && this.playerObj) {
        this.playerObj.position.sub(this._shakeApplied);
        this._shakeApplied.set(0, 0, 0);
      }
    },

    _applyShake: function () {
      if (window.FX && FX.shakeOffset && this.playerObj) {
        this._shakeApplied.copy(FX.shakeOffset);
        this.playerObj.position.add(this._shakeApplied);
      }
    },

    // bake the change of the kick spring into the camera orientation (pitch about local X, yaw about world Y)
    _applyKick: function (dt) {
      const k = this._kick, a = this._kickApplied, cam = this.camera;
      kickStep(k, dt);
      const dp = k.p - a.p, dy = k.y - a.y;
      if (Math.abs(dp) > 1e-7) { _q.setFromAxisAngle(X_AXIS, dp); cam.quaternion.multiply(_q); }
      if (Math.abs(dy) > 1e-7) { _q.setFromAxisAngle(Y_AXIS, dy); cam.quaternion.premultiply(_q); }
      a.p = k.p; a.y = k.y;
    },

    update: function (dt) {
      this._removeShake();                                     // back to the true (un-shaken) position

      if (this.fireCooldown > 0) this.fireCooldown -= dt * 1000;
      if (this.reloadTimer > 0) {
        this.reloadTimer -= dt * 1000;
        if (this.reloadTimer <= 0) {
          this.reloadTimer = 0;
          this.ammo = MAX_AMMO;
          if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, false);
          if (window.Sfx && Sfx.cock) Sfx.cock();
        }
      }
      this.reloading = this.reloadTimer > 0;
      this._applyKick(dt);

      if (!document.hasFocus()) {                              // pointer lock optional in QA (headless may not lock) — focus is what matters
        this.moving = false; this.sprinting = false;
        this._applyShake();
        return;
      }

      // movement is allowed while reloading
      const input = this.getInput();
      const speed = input.sprint ? 11 : 6;
      this.moving = !!(input.forward || input.backward || input.left || input.right);   // read by main.js -> Weapon.update
      this.sprinting = !!input.sprint && this.moving;

      const p = this.playerObj.position;
      const px = p.x, pz = p.z;

      // r147-native movement: moveForward/moveRight handle yaw-correct axes internally.
      // (never hand-rolled: my applyAxisAngle(yaw) version inverted A/D)
      const step = speed * dt;
      if (input.forward) this.controls.moveForward(step);
      if (input.backward) this.controls.moveForward(-step);
      if (input.left) this.controls.moveRight(-step);
      if (input.right) this.controls.moveRight(step);

      // collider clamp: don't fight movement — only cancel penetration after the move
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

      // footsteps by distance walked
      if (this.moving) {
        this._stride += Math.hypot(p.x - px, p.z - pz);
        const stride = this.sprinting ? 3.1 : 2.2;
        if (this._stride >= stride) {
          this._stride -= stride;
          if (window.Sfx && Sfx.footstep) Sfx.footstep(this.sprinting);
        }
      } else {
        this._stride = 0;
      }

      this._applyShake();                                      // shake rides on top of the final position
    }
  };

  // Enemy attacks call Player.hurt(dmg, attacker): `attacker` (enemy / Object3D / Vector3 / {x,z}) orients the HUD arc.
  window.Player = {
    hurt: function (dmg, from) {
      const G = window.Game;
      if (G.dead || G.godMode) return;                         // no pain sound while dead or in god mode
      if (window.Sfx && Sfx.hurt) Sfx.hurt();
      G.hurt(dmg, from);
    }
  };
})();
