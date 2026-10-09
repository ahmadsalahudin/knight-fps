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
   Controls: WASD / arrow keys move, Shift sprints, mouse aims (pointer lock), left button fires, right button throws a grenade (like G,
   grenade.js; the browser context menu is suppressed on the canvas), R reloads, F / V kick.
   Touch (touch.js): window.TouchInput feeds an analog move vector (input.analog / ax / ay) and a sprint flag through getInput; the KICK button calls Game.tryKick.

   Kick (melee): tryKick() starts it (0.9 s cooldown, not while reloading or dead), asks Weapon.kick() for the viewmodel animation
   ({ impactAt, duration } in seconds, or null = the weapon declines; without Weapon.kick it uses KICK_IMPACT / KICK_DURATION) and, impactAt
   later, _kickImpact() hits up to 3 living enemies, nearest first, that are within KICK_REACH m (horizontal) and +-38 degrees of the
   camera's horizontal forward: knights take 30 damage (torso, chest height, dir = forward) through enemy.takeHit, then Combat.onHit /
   onKill for sparks, sound and knockback, a further 7 m/s shove along forward and an interruption into 'stagger' (also mid windup / attack;
   not a charging or stumbling rusher); the boss takes 15 and is neither shoved nor staggered (its reach adds KICK_BIG m per metre of extra
   size, as it never stands closer than ~4 m). Kills go through _onKill like bullet kills (Waves dedupes, the grenade streak follows).
   Sfx.kickWhoosh on a miss, Sfx.kickThud on a hit. Debug (?debug=1): __dbg.kick(instant?). */
window.getInput = function () {
  const input = { forward: false, backward: false, left: false, right: false, sprint: false, analog: false, ax: 0, ay: 0 };
  const keys = {};
  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'KeyR') { if (window.Game && Game.tryReload) Game.tryReload(); }
    else if ((e.code === 'KeyF' || e.code === 'KeyV') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { if (window.Game && Game.tryKick) Game.tryKick(); }
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });
  // A key released while the window was in the background (alt-tab, Esc pause + alt-tab) never delivers its keyup: without
  // this the player would keep walking / sprinting on its own after coming back.
  window.addEventListener('blur', function () { for (const k in keys) keys[k] = false; });
  return function () {
    input.forward = !!(keys['KeyW'] || keys['ArrowUp']);
    input.backward = !!(keys['KeyS'] || keys['ArrowDown']);
    input.left = !!(keys['KeyA'] || keys['ArrowLeft']);
    input.right = !!(keys['KeyD'] || keys['ArrowRight']);
    input.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    input.analog = false; input.ax = 0; input.ay = 0;
    // on-screen stick (touch.js): analog strafe / forward in -1..1; the keys win when one is held
    const T = window.TouchInput;
    if (T && T.active && (T.ax || T.ay) && !(input.forward || input.backward || input.left || input.right)) {
      input.analog = true; input.ax = T.ax; input.ay = T.ay;
      input.forward = T.ay > 0.15; input.backward = T.ay < -0.15; input.right = T.ax > 0.15; input.left = T.ax < -0.15;
    }
    if (T && T.active && T.sprint) input.sprint = true;
    return input;
  };
};

(function () {
  const MAX_AMMO = 6;
  const MAX_HP = 100;
  const ARENA_RADIUS_FALLBACK = 49;     // only used when World.arenaRadius is missing
  const RELOAD_MS = 1600;
  const FIRE_GATE_MS = 350;
  const FALLBACK_DAMAGE = 34;     // used only when Combat.damageFor is absent
  const KICK_COOLDOWN = 0.9;                       // s from one kick to the next
  const KICK_IMPACT = 0.17, KICK_DURATION = 0.5;   // s: used when Weapon.kick does not exist (impact after the press, whole animation)
  const KICK_REACH = 2.3, KICK_BIG = 0.9;          // m from the player (horizontal); + KICK_BIG per metre a body is bigger than a knight (the boss)
  const KICK_COS = Math.cos(38 * Math.PI / 180);   // within +-38 degrees of the camera's horizontal forward
  const KICK_MAX = 3;                              // targets per kick, nearest first
  const KICK_DAMAGE = 30, KICK_DAMAGE_BOSS = 15, KICK_PUSH = 7;
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  const _origin = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _kE = [null, null, null], _kD = [0, 0, 0];  // the kick's chosen targets and their distances (scratch, sorted by distance)

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
    playerHP: MAX_HP,
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
      this._kick = { p: 0, pv: 0, y: 0, yv: 0 };          // camera recoil spring state
      this._kickApplied = { p: 0, y: 0 };                  // portion of the kick currently baked into the camera
      this._shakeApplied = new THREE.Vector3();            // shake offset currently added to the camera position
      this._stride = 0;
      this._raycaster = new THREE.Raycaster();
      document.addEventListener('mousedown', function (e) {
        if (!document.pointerLockElement) return;
        if (e.button === 0) self.tryFire();
        else if (e.button === 2 && window.Grenade && Grenade.throwIt) Grenade.throwIt();      // right button = G
      });
      renderer.domElement.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // the right button is a game control

      // melee kick (see the header): cooldown, time left until the foot lands (-1 = no kick under way)
      this.kicks = 0;
      this._kickCool = 0;
      this._kickWait = -1;
      this._kickBtn = document.getElementById('tKick');   // touch button: dimmed during the cooldown

      this.getInput = window.getInput();

      // HUD init
      if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, false);
      if (window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
      this._installDebug();
    },

    // an outside push on the player (m/s, decays in a fraction of a second): the shield rush shoves you back with it
    shove: function (vx, vz) {
      const s = this._shove || (this._shove = { x: 0, z: 0 });
      s.x += vx; s.z += vz;
      const l = Math.hypot(s.x, s.z);
      if (l > 14) { s.x *= 14 / l; s.z *= 14 / l; }
    },

    tryReload: function () {
      if (this.dead || this.reloadTimer > 0 || this.ammo === MAX_AMMO) return;
      this.reloadTimer = RELOAD_MS;
      this.reloading = true;
      if (window.Sfx && Sfx.reload) Sfx.reload();
      if (window.Weapon && Weapon.reload) Weapon.reload(RELOAD_MS);
      if (window.HUD && HUD.updateAmmo) HUD.updateAmmo(this.ammo, MAX_AMMO, true);
    },

    // ---- melee kick -----------------------------------------------------------------------------------------------------
    // F / V / the KICK button. Starts the kick; _kickImpact() lands it Weapon.kick()'s impactAt seconds later. force (debug) skips the
    // cooldown / reload / not-started checks.
    tryKick: function (force) {
      if (this.dead || this._kickWait >= 0) return false;
      if (!force) {
        if (this._kickCool > 0 || this.reloadTimer > 0) return false;
        const M = window.Main;
        if (M && ((M.isStarted && !M.isStarted()) || (M.isPaused && M.isPaused()))) return false;
      }
      let impactAt = KICK_IMPACT, duration = KICK_DURATION;
      if (window.Weapon && typeof Weapon.kick === 'function') {
        let r;
        try { r = Weapon.kick(); } catch (e) { console.error('[Game] Weapon.kick', e); r = undefined; }     // a throwing viewmodel must not cancel the kick
        if (r === null) return false;                                                                    // the weapon declines (busy)
        if (r && isFinite(r.impactAt) && r.impactAt >= 0) impactAt = r.impactAt;
        if (r && isFinite(r.duration) && r.duration > 0) duration = r.duration;
      }
      this._kickWait = impactAt;
      this._kickCool = KICK_COOLDOWN;
      this._kickInfo = { impactAt: impactAt, duration: duration };
      this.kicks++;
      if (this._kickBtn) this._kickBtn.classList.add('cool');
      return true;
    },

    // The foot lands: the camera's horizontal forward (fx, fz) decides who is in front. Returns a plain summary under ?debug=1, else null.
    _kickImpact: function () {
      const list = window.Enemies && Enemies.list, pp = this.playerObj.position;
      this.camera.updateMatrixWorld(true);
      this.camera.getWorldDirection(_dir);
      let fx = _dir.x, fz = _dir.z, fl = Math.hypot(fx, fz);
      if (fl < 0.05) {                    // looking (almost) straight up or down: the camera's up vector points the way the body faces
        _tmp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const s = _dir.y < 0 ? 1 : -1;
        fx = _tmp.x * s; fz = _tmp.z * s; fl = Math.hypot(fx, fz);
      }
      if (fl < 1e-4) { fx = 0; fz = -1; fl = 1; }
      fx /= fl; fz /= fl;

      // the (at most KICK_MAX) nearest living enemies in reach and inside the cone
      let n = 0;
      for (let i = 0; list && i < list.length; i++) {
        const e = list[i];
        if (!e || !e.mesh || e._removed || isDead(e)) continue;
        const p = e.mesh.position, S = e.sizeScale || 1;
        const dx = p.x - pp.x, dz = p.z - pp.z, d = Math.hypot(dx, dz);
        if (d > KICK_REACH + KICK_BIG * (S - 1)) continue;
        if (d > 0.4 && (dx * fx + dz * fz) / d < KICK_COS) continue;           // (right on top of you counts as in front)
        let j = n < KICK_MAX ? n : KICK_MAX - 1;
        if (n >= KICK_MAX && d >= _kD[j]) continue;
        while (j > 0 && _kD[j - 1] > d) { _kE[j] = _kE[j - 1]; _kD[j] = _kD[j - 1]; j--; }
        _kE[j] = e; _kD[j] = d;
        if (n < KICK_MAX) n++;
      }

      const dir = new THREE.Vector3(fx, 0, fz);
      let killed = 0, firstPoint = null;
      const info = window.__dbg ? { hits: [], kills: 0, forward: [fx, fz] } : null;
      for (let i = 0; i < n; i++) {
        const e = _kE[i]; _kE[i] = null;
        const point = this._kickEnemy(e, fx, fz, dir, info);
        if (!firstPoint) firstPoint = point;
        if (isDead(e)) killed++;
      }

      if (n) {
        if (window.HUD && HUD.hitmark) HUD.hitmark(killed ? 'kill' : 'hit');
        if (window.Sfx && Sfx.kickThud) { try { Sfx.kickThud(firstPoint); } catch (e) { /* ignore */ } }
        if (window.FX && FX.shake) FX.shake(0.2);
        this._kick.pv -= 0.8;                                                  // the view dips into the blow
      } else {
        if (window.Sfx && Sfx.kickWhoosh) { try { Sfx.kickWhoosh(); } catch (e) { /* ignore */ } }
        this._kick.pv -= 0.3;
      }
      if (info) { info.hit = n; info.kills = killed; this.lastKick = info; }
      return info;
    },

    // One enemy takes the kick; returns the point it was hit at.
    _kickEnemy: function (e, fx, fz, dir, info) {
      const p = e.mesh.position, S = e.sizeScale || 1, boss = e.type === 'boss';
      // chest height (the boss: its leg), on the side facing the player
      const point = new THREE.Vector3(p.x - fx * 0.3 * S, boss ? 1.2 : 1.1 * S, p.z - fz * 0.3 * S);
      const hitData = { damage: boss ? KICK_DAMAGE_BOSS : KICK_DAMAGE, zone: 'torso', point: point, dir: dir.clone(), kick: true };
      const hp0 = e.hp, wasDead = isDead(e);
      try {
        if (typeof e.takeHit === 'function') e.takeHit(hitData);
      } catch (err) { console.error('[Game] kick hit failed', err); }
      const killed = !wasDead && isDead(e);

      if (window.Combat) {                                     // sparks, armour sound, knockback / the death reaction
        try {
          if (killed) { if (!e._killFx && Combat.onKill) Combat.onKill(e, hitData, dir); }
          else if (Combat.onHit) Combat.onHit(e, hitData, dir);
        } catch (err) { console.error('[Game] Combat reaction (kick)', err); }
      }
      if (!boss) {
        if (typeof e.applyImpulse === 'function') { try { e.applyImpulse(new THREE.Vector3(fx * KICK_PUSH, 0, fz * KICK_PUSH)); } catch (err) { /* ignore */ } }
        const st = e.state;      // knocked off balance, whatever it was doing, except a charge in full flight (and its stumble, which is its own opening)
        if (!killed && typeof e.setState === 'function' && st !== 'rush' && st !== 'stumble') {
          if (st !== 'stagger') e.setState('stagger'); else e.stateT = 0;
        }
      }
      if (killed) this._onKill(e);
      if (info) info.hits.push({ type: e.type || null, dmg: hitData.damage, hp0: hp0, hp: e.hp, killed: killed, state: e.state, dist: Math.round(Math.hypot(p.x - this.playerObj.position.x, p.z - this.playerObj.position.z) * 100) / 100 });
      return point;
    },

    _installDebug: function () {
      if (!window.__dbg) return;
      const G = this;
      // __dbg.kick(): press the kick (forced: no cooldown / reload / title screen checks); the foot lands impactAt seconds of game time later.
      // __dbg.kick(true): land it at once and return { hit, kills, hits: [{ type, dmg, hp0, hp, killed, state, dist }] } (also Game.lastKick).
      window.__dbg.kick = function (instant) {
        if (!G.tryKick(true)) return { ok: false };
        if (!instant) return { ok: true, impactAt: G._kickInfo.impactAt, duration: G._kickInfo.duration };
        G._kickWait = -1;
        return Object.assign({ ok: true }, G._kickImpact());
      };
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
      if (hitInfo && window.__dbg) window.__lastHitInfo = hitInfo;      // QA only (?debug=1): production keeps no reference to the last enemy
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
        this._kickWait = -1;                                   // a kick under way never lands
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

    // Restore HP (capped at 100). Waves calls it when a wave is cleared: there is no other healing, so damage taken early
    // would otherwise carry into the boss fight for good. Returns the HP actually restored.
    heal: function (amount) {
      if (this.dead || !(amount > 0)) return 0;
      const before = this.playerHP;
      this.playerHP = Math.min(MAX_HP, before + amount);
      if (this.playerHP !== before && window.HUD && HUD.updateHP) HUD.updateHP(this.playerHP);
      return this.playerHP - before;
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

    // Safety net for the rock wall. The wall's colliders keep enemies inside, but enemies.js resolves "do not stand on the camera"
    // (a push of up to ~3 m away from the player) AFTER its collider pass, so a boss that ends a charge on top of a player who
    // stands at the wall is shoved outward, and the next collider pass then ejects it on the FAR side of the wall: it would stay
    // outside forever (shots hit the wall, it cannot reach the player). Anything past the wall's centre line is put back inside,
    // 3 m behind the clamp circle. Normal positions never get there (colliders hold enemies at r <= ~49.9).
    _leashEnemies: function () {
      const list = window.Enemies && Enemies.list;
      if (!list) return;
      const W = window.World;
      const limit = ((W && W.ringRadius) || 51.6) - 1.0;
      const back = ((W && W.arenaRadius) || ARENA_RADIUS_FALLBACK) - 3;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const p = e && e.mesh && e.mesh.position;
        if (!p) continue;
        const r = Math.hypot(p.x, p.z);
        if (r <= limit) continue;
        p.x *= back / r; p.z *= back / r;
        if (e._vel) { e._vel.x = 0; e._vel.z = 0; }
        if (e.knockback) { e.knockback.x = 0; e.knockback.z = 0; }
      }
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
      if (this._kickCool > 0) {
        this._kickCool -= dt;
        if (this._kickCool <= 0 && this._kickBtn) this._kickBtn.classList.remove('cool');
      }
      if (this._kickWait >= 0) {
        this._kickWait -= dt;
        if (this._kickWait < 0) { this._kickWait = -1; if (!this.dead) this._kickImpact(); }
      }
      this._applyKick(dt);
      this._leashEnemies();                                    // keeps strays inside the wall (see above); runs even without focus

      // touch screens never have the pointer lock, and some mobile browsers report hasFocus() false while a finger is down: no guard there
      if (!document.hasFocus() && !(window.TouchInput && TouchInput.active)) {                // pointer lock optional in QA (headless may not lock) — focus is what matters
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
      if (input.analog) {                                      // touch stick: speed follows how far it is pushed
        this.controls.moveForward(input.ay * step);
        this.controls.moveRight(input.ax * step);
      } else {
        if (input.forward) this.controls.moveForward(step);
        if (input.backward) this.controls.moveForward(-step);
        if (input.left) this.controls.moveRight(-step);
        if (input.right) this.controls.moveRight(step);
      }

      const sv = this._shove;
      if (sv && (sv.x || sv.z)) {
        p.x += sv.x * dt; p.z += sv.z * dt;
        const k = Math.exp(-7 * dt);
        sv.x *= k; sv.z *= k;
        if (Math.abs(sv.x) + Math.abs(sv.z) < 0.05) { sv.x = 0; sv.z = 0; }
      }

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
      // arena edge: a circle just inside the rock wall (World.arenaRadius). Projecting onto it keeps the tangential motion,
      // so walking diagonally into the wall slides along it instead of sticking.
      const lim = (window.World && World.arenaRadius) || ARENA_RADIUS_FALLBACK;
      const rr = Math.hypot(p.x, p.z);
      if (rr > lim) { p.x *= lim / rr; p.z *= lim / rr; }
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
