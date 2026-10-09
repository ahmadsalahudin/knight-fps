/* grenade.js - window.Grenade: the bonus weapon. A run of kills earns hand grenades.

   Earning:  kills in a row (each within STREAK_WINDOW seconds of the last) fill the streak; at Difficulty.streak (Easy 4, Normal 5, Hard 6)
             you are given Difficulty.nades grenades (1 on every level; at most MAX_CARRY carried). A run starts with START_NADES = 1 and the streak starts again.
             Kills by grenade count too, so a good throw chains into the next reward.
   Using:    G (desktop) or the GRENADE button (touch) lobs one in an arc from the camera. It bounces off the ground, trees and rocks,
             detonates the moment it touches a knight, or when its 2 s fuse runs out (the LED on it blinks faster and faster).
   Blast:    RADIUS m, linear falloff from MAX_DAMAGE at the centre (a knight dies inside ~2.5 m, a boss takes 35 %), knights are thrown
             back, thrown daggers in the blast are destroyed. YOU are hurt too, up to SELF_DAMAGE x difficulty damage inside SELF_R m, and
             shoved: throw it at something that is not standing on you.
   Hooks:    Waves.onEnemyKilled -> Grenade.onKill(enemy); Waves.start(1) -> Grenade.reset(); main.js: init(scene, camera) once, update(dt) per frame.
   HUD:      #grenadeBox (pips, desktop), #streakBox (STREAK n / N with the time left), #tGrenade (touch button, only while you hold grenades).
   Debug (?debug=1): __dbg.grenade = { give(n), throw(), state(), list() }.

   One persistent PointLight (intensity 0 until a blast) is added in init(), so no light is ever added mid-game (that would recompile every
   lit material); everything else is plain meshes that are removed again, with their own materials disposed. */
(function () {
  'use strict';

  const V3 = THREE.Vector3;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const GRAVITY = 16, THROW_SPEED = 17, THROW_LIFT = 3.6;      // m/s^2, m/s along the view, m/s added upward
  const FUSE = 2.0, COOLDOWN = 0.7, MAX_CARRY = 6, STREAK_WINDOW = 8, START_NADES = 1;
  const R_BALL = 0.09;
  const RADIUS = 6.5, MAX_DAMAGE = 150, BOSS_FACTOR = 0.35;
  const SELF_R = 4.5, SELF_DAMAGE = 30;
  const NEUTRAL = { streak: 5, nades: 1, dmg: 1 };
  const diff = () => (window.Difficulty && Difficulty.get()) || NEUTRAL;
  const el = (id) => document.getElementById(id);

  const G = {
    count: 0,
    streak: 0,
    live: [],                 // grenades in the air / on the ground: { mesh, led, vel, age, nextBeep }
    fx: [],                   // explosion visuals
    _cool: 0,
    _streakT: 0,
    _scene: null,
    _light: null,
    _shared: null,

    // ---------------------------------------------------------------------------------------------- setup
    init: function (scene) {
      this._scene = scene;
      const light = new THREE.PointLight(0xffa24a, 0, 22, 2);
      light.position.set(0, 3, 0);
      scene.add(light);
      this._light = light;
      this._lightT = 1;
      this._installDebug();
      this._hud();
    },

    reset: function () {
      this.clear();
      this.count = START_NADES; this.streak = 0; this._streakT = 0; this._cool = 0;
      this._hud();
    },

    // remove every grenade and explosion visual (Waves.skipTo / debug clears call this through Enemies.clear)
    clear: function () {
      for (let i = this.live.length - 1; i >= 0; i--) this._drop(this.live[i]);
      this.live.length = 0;
      for (let i = this.fx.length - 1; i >= 0; i--) this._dropFx(this.fx[i]);
      this.fx.length = 0;
      if (this._light) this._light.intensity = 0;
    },

    give: function (n) {
      this.count = clamp(this.count + n, 0, MAX_CARRY);
      this._hud();
    },

    // ---------------------------------------------------------------------------------------------- the streak
    onKill: function (enemy) {
      const W = window.Waves;
      if (W && (W.state === 'victory-wait' || W.state === 'victory')) return;      // the boss's minions fall with it: no reward for that
      const need = diff().streak;
      this.streak++;
      this._streakT = STREAK_WINDOW;
      if (this.streak >= need) {
        this.streak = 0; this._streakT = 0;
        const n = diff().nades;
        const before = this.count;
        this.give(n);
        if (window.HUD && HUD.banner) { try { HUD.banner('Bonus weapon', 'Grenades +' + (this.count - before) + ' - ' + (window.TouchInput && TouchInput.active ? 'tap GRENADE' : 'press G'), 2600, { kind: 'clear' }); } catch (e) { /* ignore */ } }
        if (window.Sfx && Sfx.bonus) { try { Sfx.bonus(); } catch (e) { /* ignore */ } }
      }
      this._hud();
    },

    // ---------------------------------------------------------------------------------------------- throwing
    throwIt: function (force) {
      const Gm = window.Game, cam = Gm && Gm.camera;
      if (!cam || !this._scene || Gm.dead) return false;
      if (!force && (this.count <= 0 || this._cool > 0)) return false;
      if (window.Main && ((Main.isStarted && !Main.isStarted()) || (Main.isPaused && Main.isPaused()))) return false;
      if (!force) this.count--;
      this._cool = COOLDOWN;
      cam.updateMatrixWorld(true);
      const dir = new V3(), right = new V3(), pos = new V3();
      cam.getWorldDirection(dir);
      right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      cam.getWorldPosition(pos);
      pos.addScaledVector(dir, 0.55).addScaledVector(right, 0.2);
      pos.y -= 0.16;
      const vel = dir.clone().multiplyScalar(THROW_SPEED);
      vel.y += THROW_LIFT;
      const gr = this._make();
      gr.mesh.position.copy(pos);
      gr.vel = vel;
      gr.spinAxis = new V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this._scene.add(gr.mesh);
      this.live.push(gr);
      // the revolver dips as the other hand throws
      if (window.Weapon && Weapon.S && Weapon.S.kh) { try { Weapon.S.kh.kick(0.03); Weapon.S.kz.kick(0.012); } catch (e) { /* ignore */ } }
      if (window.Sfx && Sfx.grenadeThrow) { try { Sfx.grenadeThrow(); } catch (e) { /* ignore */ } }
      this._hud();
      return gr;
    },

    _shared_: function () {
      if (this._shared) return this._shared;
      this._shared = {
        ball: new THREE.SphereGeometry(R_BALL, 12, 9),
        cap: new THREE.CylinderGeometry(0.028, 0.034, 0.05, 8),
        led: new THREE.SphereGeometry(0.02, 8, 6),
        body: new THREE.MeshStandardMaterial({ color: 0x4a5a2c, roughness: 0.55, metalness: 0.35 }),
        steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.8 }),
        fire: new THREE.SphereGeometry(1, 16, 12),
        ring: new THREE.RingGeometry(0.88, 1, 40),
      };
      this._shared.ring.rotateX(-Math.PI / 2);
      return this._shared;
    },

    _make: function () {
      const S = this._shared_();
      const mesh = new THREE.Group();
      mesh.name = 'grenade';
      mesh.add(new THREE.Mesh(S.ball, S.body));
      const cap = new THREE.Mesh(S.cap, S.steel); cap.position.y = R_BALL + 0.01; mesh.add(cap);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
      const led = new THREE.Mesh(S.led, ledMat); led.position.set(0.05, R_BALL * 0.8, 0.04); mesh.add(led);
      mesh.traverse((o) => { o.castShadow = false; });
      return { mesh, led, ledMat, vel: null, age: 0, beepT: 0, rest: false, spinAxis: null };
    },

    _drop: function (g) {
      if (g.mesh.parent) g.mesh.parent.remove(g.mesh);
      if (g.ledMat) g.ledMat.dispose();          // geometry and the other materials are shared
    },

    // ---------------------------------------------------------------------------------------------- per frame
    update: function (dt) {
      dt = clamp(dt || 0, 0, 0.1);
      if (this._cool > 0) this._cool -= dt;
      if (this.streak > 0) {
        this._streakT -= dt;
        if (this._streakT <= 0) { this.streak = 0; this._hud(); } else this._hudStreak();
      }
      if (this.live.length) this._tickLive(dt);
      if (this.fx.length) this._tickFx(dt);
      else if (this._light && this._light.intensity > 0) this._light.intensity = 0;
    },

    _tickLive: function (dt) {
      const cols = window.World && World.colliders;
      const list = window.Enemies && Enemies.list;
      for (let i = this.live.length - 1; i >= 0; i--) {
        const g = this.live[i], p = g.mesh.position, v = g.vel;
        g.age += dt;
        // the LED blinks faster as the fuse burns down
        const u = clamp(g.age / FUSE, 0, 1), rate = 7 + 22 * u * u;
        g.beepT += dt * rate;
        const on = Math.sin(g.beepT * Math.PI * 2) > 0;
        g.led.visible = on;
        if (on && !g._lit) { g._lit = true; if (window.Sfx && Sfx.grenadeBeep && g.age > 0.3) { try { Sfx.grenadeBeep(p); } catch (e) { /* ignore */ } } }
        if (!on) g._lit = false;

        let boom = g.age >= FUSE;
        const n = clamp(Math.ceil(dt / 0.011), 1, 12), h = dt / n;
        for (let s = 0; s < n && !boom; s++) {
          v.y -= GRAVITY * h;
          p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
          // ground: bounce, lose energy, roll to a stop
          if (p.y < R_BALL) {
            p.y = R_BALL;
            if (v.y < 0) {
              const hit = -v.y;
              v.y = hit > 1.6 ? hit * 0.42 : 0;
              v.x *= 0.72; v.z *= 0.72;
              if (hit > 2.2 && window.Sfx && Sfx.grenadeBounce) { try { Sfx.grenadeBounce(p); } catch (e) { /* ignore */ } }
            }
            const f = Math.exp(-3.2 * h); v.x *= f; v.z *= f;
          }
          // trees and rocks: reflect the horizontal velocity
          if (cols) {
            for (let c = 0; c < cols.length; c++) {
              const q = cols[c];
              const ox = p.x - q.x, oz = p.z - q.z, d = Math.hypot(ox, oz), min = q.r + R_BALL;
              if (d < min && p.y < 5 && d > 1e-4) {
                const nx = ox / d, nz = oz / d, vn = v.x * nx + v.z * nz;
                p.x = q.x + nx * min; p.z = q.z + nz * min;
                if (vn < 0) { v.x -= 1.5 * vn * nx; v.z -= 1.5 * vn * nz; if (-vn > 2.5 && window.Sfx && Sfx.grenadeBounce) { try { Sfx.grenadeBounce(p); } catch (e) { /* ignore */ } } }
              }
            }
          }
          // a knight in the way: it goes off against them
          if (list) {
            for (let k = 0; k < list.length; k++) {
              const e = list[k];
              if (e.dead || !e.mesh) continue;
              const ep = e.mesh.position, sz = e.sizeScale || 1;
              if (Math.hypot(p.x - ep.x, p.z - ep.z) < 0.62 * sz + R_BALL && p.y < 1.9 * sz) { boom = true; break; }
            }
          }
        }
        g.mesh.rotateOnAxis(g.spinAxis, (Math.hypot(v.x, v.y, v.z) > 1.5 ? 9 : 1) * dt);
        if (p.y < -2 || Math.hypot(p.x, p.z) > 90) { this._drop(g); this.live.splice(i, 1); continue; }
        if (boom) { this._explode(p.clone()); this._drop(g); this.live.splice(i, 1); }
      }
    },

    // ---------------------------------------------------------------------------------------------- the blast
    _explode: function (c) {
      const list = window.Enemies && Enemies.list ? Enemies.list.slice() : [];
      let hits = 0, kills = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.dead || !e.mesh || typeof e.takeHit !== 'function') continue;
        const ep = e.mesh.position, sz = e.sizeScale || 1;
        const chest = new V3(ep.x, 0.9 * sz, ep.z);
        const d = chest.distanceTo(c) - 0.35 * sz;                       // measured to the body, not the centre line
        if (d >= RADIUS) continue;
        const f = clamp(1 - Math.max(0, d) / RADIUS, 0, 1);
        let dmg = MAX_DAMAGE * f;
        if (e.type === 'boss') dmg *= BOSS_FACTOR;
        const dir = new V3(ep.x - c.x, 0, ep.z - c.z);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        hits++;
        try {
          if (e.applyImpulse) e.applyImpulse(new V3(dir.x * (4 + 10 * f), 0, dir.z * (4 + 10 * f)));
          const was = e.dead;
          e.takeHit({ damage: dmg, zone: 'torso', point: chest, dir: dir });
          if (!was && e.dead) kills++;
          if (window.FX && FX.blood && !was) FX.blood(chest, dir, e.dead ? 11 : 4);
        } catch (err) { console.error('[Grenade] blast on enemy', err); }
      }
      if (hits && window.HUD && HUD.hitmark) { try { HUD.hitmark(kills ? 'kill' : 'hit'); } catch (e) { /* ignore */ } }
      // daggers in the air are blown up with the rest
      if (window.Enemies && Enemies.daggers) {
        for (let i = Enemies.daggers.length - 1; i >= 0; i--) {
          const d = Enemies.daggers[i];
          if (d.mesh.position.distanceTo(c) < RADIUS * 0.8) { Enemies._removeDagger(d); Enemies.daggers.splice(i, 1); }
        }
      }
      // and so is the thrower
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      let dPlayer = 99;
      if (pp) {
        dPlayer = Math.hypot(pp.x - c.x, (pp.y - 0.5) - c.y, pp.z - c.z);
        if (dPlayer < SELF_R && !Game.dead) {
          const f = 1 - dPlayer / SELF_R;
          const dmg = Math.max(1, Math.round(SELF_DAMAGE * f * diff().dmg));
          const away = new V3(pp.x - c.x, 0, pp.z - c.z);
          if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
          away.normalize();
          if (window.Game && Game.shove) Game.shove(away.x * 10 * f, away.z * 10 * f);
          if (window.Player && Player.hurt) Player.hurt(dmg, { x: c.x, z: c.z });
        }
      }
      // visuals + sound
      this._blastFx(c, dPlayer);
      if (window.Sfx && Sfx.explosion) { try { Sfx.explosion(c); } catch (e) { /* ignore */ } }
    },

    _blastFx: function (c, dPlayer) {
      const S = this._shared_(), scene = this._scene;
      const up = new V3(0, 1, 0), ground = new V3(c.x, 0.03, c.z);
      if (window.FX) {
        try {
          if (FX.sparks) FX.sparks(c, up, 30);
          if (FX.dust) { FX.dust(ground, up, 2.2); FX.dust(ground, up, 1.4); }
          if (FX.smoke) FX.smoke(c, up, 2.2);
          if (FX.impactDecal && c.y < 1.2) FX.impactDecal(ground, up);
          if (FX.shake) FX.shake(clamp(1.1 - dPlayer / 28, 0.12, 0.95));
        } catch (e) { /* ignore */ }
      }
      // an orange fireball (normal blending: additive washes out to white against the sky) with a small hot core
      const fire = new THREE.Mesh(S.fire, new THREE.MeshBasicMaterial({ color: 0xff7418, transparent: true, opacity: 0.85, depthWrite: false }));
      const core = new THREE.Mesh(S.fire, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }));
      const ring = new THREE.Mesh(S.ring, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      fire.position.copy(c); core.position.copy(c); ring.position.set(c.x, 0.08, c.z);
      [fire, core, ring].forEach((m) => { m.frustumCulled = false; m.renderOrder = 6; scene.add(m); });
      this.fx.push({ t: 0, fire, core, ring });
      if (this._light) { this._light.position.set(c.x, Math.max(1.2, c.y + 1), c.z); this._light.intensity = 9; this._lightT = 0; }
    },

    _tickFx: function (dt) {
      for (let i = this.fx.length - 1; i >= 0; i--) {
        const e = this.fx[i];
        e.t += dt;
        const a = clamp(e.t / 0.5, 0, 1), fireA = clamp(e.t / 0.42, 0, 1);
        e.fire.scale.setScalar(0.4 + (RADIUS * 0.36) * (1 - Math.pow(1 - fireA, 3)));
        e.fire.material.opacity = 0.85 * (1 - fireA) * (1 - fireA);
        const coreA = clamp(e.t / 0.2, 0, 1);
        e.core.scale.setScalar(0.3 + 1.1 * coreA);
        e.core.material.opacity = 1 - coreA;
        const rs = RADIUS * (1 - Math.pow(1 - a, 2));
        e.ring.scale.setScalar(Math.max(0.01, rs));
        e.ring.material.opacity = 0.8 * (1 - a);
        if (e.t >= 0.55) { this._dropFx(e); this.fx.splice(i, 1); }
      }
      if (this._light) {
        this._lightT += dt;
        this._light.intensity = Math.max(0, 9 * (1 - this._lightT / 0.35));
      }
    },

    _dropFx: function (e) {
      [e.fire, e.core, e.ring].forEach((m) => { if (m.parent) m.parent.remove(m); m.material.dispose(); });   // geometries are shared
    },

    // ---------------------------------------------------------------------------------------------- HUD
    _hud: function () {
      const need = diff().streak;
      const box = el('grenadeBox'), pips = el('grenadePips'), btn = el('tGrenade');
      if (box) box.style.display = this.count > 0 ? 'flex' : 'none';
      if (pips && pips.childElementCount !== this.count) {
        pips.textContent = '';
        for (let i = 0; i < this.count; i++) { const s = document.createElement('i'); s.className = 'nade-pip'; pips.appendChild(s); }
      }
      if (btn) { btn.style.display = this.count > 0 ? 'flex' : 'none'; btn.textContent = ''; const t = document.createElement('span'); t.textContent = 'GRENADE'; const n = document.createElement('b'); n.textContent = 'x' + this.count; btn.appendChild(t); btn.appendChild(n); }
      const sb = el('streakBox');
      if (sb) sb.style.display = this.streak > 0 ? 'block' : 'none';
      const st = el('streakText'); if (st) st.textContent = 'STREAK ' + this.streak + ' / ' + need;
      this._hudStreak();
    },
    _hudStreak: function () {
      const bar = el('streakFill');
      if (bar) bar.style.width = Math.round(clamp(this._streakT / STREAK_WINDOW, 0, 1) * 100) + '%';
    },

    state: function () {
      return { count: this.count, streak: this.streak, streakNeeded: diff().streak, streakT: Math.round(this._streakT * 100) / 100, live: this.live.length, fx: this.fx.length };
    },

    _installDebug: function () {
      if (!window.__dbg) return;
      window.__dbg.grenade = {
        give: (n) => { G.give(n === undefined ? 2 : n); return G.state(); },
        throw: (force) => { const g = G.throwIt(force !== false); return g ? { pos: g.mesh.position.toArray(), vel: g.vel.toArray() } : null; },
        state: () => G.state(),
        list: () => G.live.map((g) => ({ pos: g.mesh.position.toArray().map((x) => Math.round(x * 100) / 100), age: Math.round(g.age * 100) / 100 })),
        // fast-forward the grenades and explosion visuals by `sec` (a frozen AI does not stop them, but headless frames are slow)
        tick: (sec) => { const n = Math.max(1, Math.round((sec || 0.1) / 0.033)); for (let i = 0; i < n; i++) { G.update(0.033); } return G.state(); },
      };
    },
  };

  // G throws a grenade (desktop)
  try {
    document.addEventListener('keydown', function (e) { if (e.code === 'KeyG' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) G.throwIt(); });
  } catch (e) { /* ignore */ }

  window.Grenade = G;
})();
