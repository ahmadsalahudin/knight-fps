/* boss.js - window.Boss extends Knight  (Worker D1, docs/FIX_PLAN.md "Boss", diagnosis 1.5)

   The Iron Warlord: a golden, horn-helmed armoured giant, 2.8x the height of a knight (5 m), 1500 HP, with a tower shield and a
   scaled-up greatsword. It is a Knight (same skinned model, bone-mounted gear, mixer, state machine, steering, death lifecycle) and only
   overrides the hooks that enemies.js exposes (updateAI, speedFor, startWindup, onDamageFrame, onEnter, takeHit, onDeath, ...).

   new Boss()   no arguments (waves.js and __dbg.spawn('boss') call it that way). opts (optional) are merged over the defaults.
   Fields: everything Knight has + phase (1..3), atk ('sweep'|'leap'|'charge'|'roar'|null), displayName 'The Iron Warlord',
           type 'boss', hp / maxHp (1500), knockbackScale 0.1, minions[] (summoned Knights).
   Telegraphs (every attack has one, >= 0.5 s):
        sweep   Run_swordAttack, the sword rises and holds (windup 1.0 s -> 0.62 s over the phases); a red fan on the ground (the
                exact hit area, 6.4 m reach, 140 degrees) fills up; damage once, on the swing frame, if the player is inside it.
        leap    swordAttackJump: a crouch, a red ring on the ground at the landing spot fills up (the exact AoE, 5.0 - 5.8 m),
                the boss leaps (the landing spot is locked half way through the crouch) and lands on it: damage on the landing
                frame, shockwave ring + dust ring + camera shake (FX.shake).
        charge  (phase 2+) the sword rises and holds while a red strip is drawn on the ground along the locked run line, then
                a straight Run at 11-13 m/s; damage once if it reaches the player; it stumbles (vulnerable) afterwards.
   Phases: 66 % and 33 % of maxHp. A phase change is a roar (sword up, shake, shockwave, glow), it is faster (walk / run speed,
        windups, recovery, cooldowns), unlocks the charge (phase 2) and a double sweep (phase 3) and summons 2 minions (Knights)
        on the arena ring, away from the player and the boss (never on top of the boss). Minions are not tracked by Waves.
   The boss never staggers from bullets (a tiny flinch only). HUD.bossBar is refreshed every frame and hidden on death.
   Death: the slow Death clip (x0.6), a spark / blood / smoke burst, a thud with shake and a dust ring when it hits the ground;
        Waves.onEnemyKilled is called once by Knight.die().

   QA (?debug=1, installed on the first Boss): __dbg.boss.info(), .force('sweep'|'leap'|'charge'|'roar'), .phase(n), .hold(on),
        .clip(name, t) (freeze a clip pose), .gear(), .tele().
*/
(() => {
  'use strict';
  if (!window.Knight) { console.error('[Boss] window.Knight is missing (enemies.js must load first)'); return; }

  const Knight = window.Knight;
  const V3 = THREE.Vector3;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

  // ------------------------------------------------------------------------------------------------------------------------
  // tuning
  // ------------------------------------------------------------------------------------------------------------------------
  const SIZE = 2.8;                       // x the 1.8 m knight = 5.0 m
  const HP = 1500;                        // 38 torso shots (40), 10 head shots (150): about 30-45 body shots, fewer with head shots
  const NAME = 'The Iron Warlord';
  const ATTACK = 'Run_swordAttack', JUMP = 'swordAttackJump';
  const ATK_RAISE = 0.17;                 // clip time of the raised sword in Run_swordAttack (see enemies.js)
  const J = { takeoff: 0.42, land: 0.66 }; // clip times of swordAttackJump: gather + sword back (0-0.42), sword overhead in flight, slam pose (0.66+)

  const DMG = { sweep: 22, slam: 30, charge: 28 };            // player HP 100; x1.0 / 1.1 / 1.2 by phase
  const SWEEP_R = 6.4, SWEEP_COS = Math.cos(70 * Math.PI / 180);   // reach (m) and half angle of the sweep, from the boss centre
  const LEAP_MIN = 9, LEAP_MAX = 26;
  const CHARGE_MIN = 11, CHARGE_MAX = 32, CHARGE_HIT_R = 2.5;     // hit radius around the boss while it charges; also half the strip width
  const WIDTH = 1.22;                     // x / z stretch on top of the uniform size
  const BODY_R = 0.42 * SIZE;
  const ARENA_LIMIT = 57;
  const DEATH_IMPACT = 1.6;               // seconds after the lethal hit (Death clip x0.6) when the body hits the ground

  // per phase (index = phase)
  const PH = [null,
    { walk: 2.3, run: 7.0, windup: 1.00, strike: 0.46, recover: 0.95, gap: 0.55, leapCd: 8.0, leapWind: 1.00, air: 0.85, leapEnd: 1.25, slam: 5.0, charge: false },
    { walk: 3.0, run: 8.2, windup: 0.80, strike: 0.40, recover: 0.75, gap: 0.40, leapCd: 6.5, leapWind: 0.85, air: 0.75, leapEnd: 1.05, slam: 5.4, charge: true,
      chargeCd: 9.0, chargeWind: 1.00, chargeSpeed: 11.5, chargeEnd: 1.40 },
    { walk: 3.7, run: 9.4, windup: 0.62, strike: 0.36, recover: 0.55, gap: 0.30, leapCd: 5.0, leapWind: 0.70, air: 0.65, leapEnd: 0.90, slam: 5.8, charge: true,
      chargeCd: 7.0, chargeWind: 0.80, chargeSpeed: 13.0, chargeEnd: 1.15, combo: true },
  ];

  // Gear fit (metres of a 1.8 m knight, multiplied by SIZE; see Knight.GEAR). The helmet / sword reuse the knight's mount, only larger.
  const GEAR = {
    helmet: { scale: 0.30 },
    sword: { scale: 0.335 },
    shield: { asset: 'knight_boss_shield', scale: 0.24, pos: [0.02, 0.15, 0.24], rot: [0, 1.3, 0] },
  };

  // paint (linear working colours; the renderer converts to sRGB)
  const PAINT = {
    armor: [0.72, 0.39, 0.045], armorEmissive: [0.06, 0.03, 0.0],
    helmet: { Grey: [0.74, 0.43, 0.06], DarkGrey: [0.05, 0.045, 0.04] },
    horn: [0.70, 0.62, 0.44],
    pauldron: [0.07, 0.07, 0.08],
    blade: [0.74, 0.76, 0.82],
  };

  const FAN_EDGES = ['fanEdgeL', 'fanEdgeR'], STRIP_EDGES = ['stripEdgeL', 'stripEdgeR'], EDGE_SIGN = [1, -1];   // telegraph edge meshes (no per-frame arrays)

  function sceneOf() { return (window.Game && Game.scene) || (window.Main && Main.scene) || null; }
  function playerPos() { return window.Game && Game.playerObj ? Game.playerObj.position : null; }

  // ------------------------------------------------------------------------------------------------------------------------
  // Boss
  // ------------------------------------------------------------------------------------------------------------------------
  class Boss extends Knight {
    constructor(opts) {
      opts = opts || {};
      super(Object.assign({
        type: 'boss', displayName: NAME, scale: SIZE, hp: HP, maxHp: HP, damage: DMG.sweep, knockbackScale: 0.1, gear: GEAR,
      }, opts));
      // timings of the base attack (sweep); everything else is driven by the phase table
      this.attackStart = 2.2 * this.sizeScale;     // starts a sweep from here (the sweep reaches 6.4 m)
      this.stopDist = 1.55 * this.sizeScale;
      this.lungeSpeed = 1.2 * this.sizeScale;      // a small step into the swing
      this.turnRate = 3.2;
      this.turnRateAttack = 2.0;

      this.phase = 1;
      this.atk = null;
      this.minions = [];
      this._roarPending = 0;                  // phase changes waiting for a quiet moment
      this._gap = 1.0;
      this._leapCd = 3.5;
      this._chargeCd = 6;
      this._combo = 0;
      this._leap = { sx: 0, sz: 0, tx: 0, tz: 0, h: 4, locked: false };
      this._cdir = new V3(0, 0, 1);
      this._cTravel = 0; this._cLen = 20; this._cSpeed = 0; this._cHit = false; this._cCrash = false; this._cEndT = 1.2;
      this._flash = 0;
      this._glow = 0; this._glowTarget = 0;
      this._tele = null;
      this._wave = null;                      // expanding shockwave ring { t, x, z, R }
      this._barShown = false;
      this._deathEvents = [];
      this._roarFx = 0;
      this._stepAcc = 0;

      // a broader build than the knight's slim frame (the whole posed model is stretched across x / z)
      this.model.scale.x *= WIDTH; this.model.scale.z *= WIDTH;
      this._paint();
      this._addHorns();
      this._addPauldrons();
      this._buildExtraClips();
      installDebug();

      // the arrival: it stands, raises the sword and roars before it starts to walk
      this.atk = 'roar';
      this._roarKind = 'intro';
      this.windupTime = 1.5;
      this.setState('windup');
    }

    // -------------------------------------------------------------------------------------------------------------------
    // looks
    // -------------------------------------------------------------------------------------------------------------------
    _paint() {
      // armour: this boss owns its Armor material (Knight cloned it), so repainting it touches nobody else
      this._armorMats = [];
      this._owned.forEach((m) => {
        if (m.name !== 'Armor') return;
        m.color.setRGB(PAINT.armor[0], PAINT.armor[1], PAINT.armor[2]);
        m.metalness = 0.4; m.roughness = 0.38;
        m.emissive.setRGB(PAINT.armorEmissive[0], PAINT.armorEmissive[1], PAINT.armorEmissive[2]);
        m._baseEmissive = m.emissive.clone();
        this._armorMats.push(m);
      });
      // gear materials are shared through the asset cache: give the boss its own copies before recolouring
      this._gearMats = [];
      const own = (obj, recolour) => {
        if (!obj) return;
        const map = new Map();
        obj.traverse((o) => {
          if (!o.isMesh) return;
          const dup = (m) => {
            if (!map.has(m)) {
              const c = m.clone();
              if (c.emissive) c._baseEmissive = c.emissive.clone();
              if (recolour) recolour(c);
              map.set(m, c);
              this._gearMats.push(c);
            }
            return map.get(m);
          };
          o.material = Array.isArray(o.material) ? o.material.map(dup) : dup(o.material);
        });
      };
      own(this.helmet, (m) => {
        const c = PAINT.helmet[m.name];
        if (c) { m.color.setRGB(c[0], c[1], c[2]); m.metalness = 0.4; m.roughness = 0.4; }
      });
      own(this.sword, (m) => {
        if (m.name === 'Metal') { m.color.setRGB(PAINT.blade[0], PAINT.blade[1], PAINT.blade[2]); m.metalness = 0.4; m.roughness = 0.35; this._blade = m; }
      });
      own(this.shield, null);
    }

    // a pair of curved horns on the helmet (child of the helmet: they come off with it)
    _addHorns() {
      if (!this.helmet) return;
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PAINT.horn[0], PAINT.horn[1], PAINT.horn[2]), metalness: 0.1, roughness: 0.55 });
      this._gearMats.push(mat);
      for (const side of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([
          new V3(side * 0.52, 0.50, 0.02), new V3(side * 0.82, 0.62, 0.05), new V3(side * 1.06, 0.92, 0.10),
          new V3(side * 1.10, 1.30, 0.16), new V3(side * 0.96, 1.68, 0.22),
        ]);
        const segs = 18, rad = 8;
        const geo = new THREE.TubeGeometry(curve, segs, 0.15, rad, false);
        // taper the tube to a point
        const pos = geo.attributes.position, c = new V3(), v = new V3();
        for (let i = 0; i <= segs; i++) {
          curve.getPointAt(i / segs, c);
          const k = Math.max(0.04, 1 - Math.pow(i / segs, 1.2));
          for (let j = 0; j <= rad; j++) {
            const idx = i * (rad + 1) + j;
            v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
            pos.setXYZ(idx, v.x, v.y, v.z);
          }
        }
        geo.computeVertexNormals();
        const horn = new THREE.Mesh(geo, mat);
        horn.castShadow = true;
        horn.name = 'horn';
        this.helmet.add(horn);
        (this._hornGeos || (this._hornGeos = [])).push(geo);
      }
    }

    // spiked pauldrons on the shoulders: authored in world metres at the final size, converted to the bone's local space
    _addPauldrons() {
      const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PAINT.pauldron[0], PAINT.pauldron[1], PAINT.pauldron[2]), metalness: 0.4, roughness: 0.42,
        emissive: new THREE.Color(0, 0, 0) });
      const spike = new THREE.MeshStandardMaterial({ color: new THREE.Color(PAINT.horn[0], PAINT.horn[1], PAINT.horn[2]), metalness: 0.2, roughness: 0.5 });
      this._gearMats.push(dark, spike);
      const k = this.sizeScale / 2.8;
      this._shGeos = [new THREE.SphereGeometry(1, 16, 10, 0, TAU, 0, Math.PI * 0.6), new THREE.ConeGeometry(0.12, 0.7, 7)];
      this.mesh.updateMatrixWorld(true);
      const q = new THREE.Quaternion(), ws = new V3();
      this._pauldrons = [];
      for (const side of ['L', 'R']) {
        const bone = this._bone('Shoulder.' + side) || this._bone('UpperArm.' + side);
        if (!bone) continue;
        const out = side === 'L' ? 1 : -1;                          // knight-local +x is its left (it faces +z)
        const root = new THREE.Group();
        root.name = 'pauldron';
        const dome = new THREE.Mesh(this._shGeos[0], dark);
        dome.scale.set(0.62 * k, 0.40 * k, 0.62 * k);
        dome.castShadow = true;
        root.add(dome);
        for (let i = 0; i < 3; i++) {
          const sp = new THREE.Mesh(this._shGeos[1], spike);
          const a = (i - 1) * 0.62;                                  // fan of spikes, outward and up
          sp.position.set(out * Math.sin(Math.abs(a) + 0.35) * 0.5 * k * (a < 0 ? 0.6 : 1), 0.30 * k + Math.cos(a) * 0.12 * k, a * 0.34 * k);
          sp.rotation.set(0, 0, -out * (0.45 + Math.abs(a) * 0.5));
          sp.scale.setScalar(k * 1.3);
          sp.castShadow = true;
          root.add(sp);
        }
        bone.add(root);
        const wp = bone.getWorldPosition(new V3());
        wp.x += out * 0.14 * k; wp.y += 0.1 * k;
        root.position.copy(bone.worldToLocal(wp.clone()));
        bone.getWorldQuaternion(q);
        root.quaternion.copy(q.invert());
        bone.getWorldScale(ws);
        root.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
        this._pauldrons.push(root);
      }
    }

    // swordAttackJump on both layers (Knight only builds the clips it uses itself)
    _buildExtraClips() {
      const set = Knight.getClipSets()[JUMP];
      if (!set) { console.warn('[Boss] missing clip ' + JUMP); return; }
      const up = this.mixer.clipAction(set.upper), lo = this.mixer.clipAction(set.lower);
      for (const a of [up, lo]) { a.setLoop(THREE.LoopOnce, Infinity); a.clampWhenFinished = true; }
      this.actions[JUMP] = up;
      this.lowerActions[JUMP] = lo;
      const d = set.full.duration;
      J.dur = d;
    }

    // -------------------------------------------------------------------------------------------------------------------
    // decisions
    // -------------------------------------------------------------------------------------------------------------------
    get P() { return PH[this.phase]; }

    updateAI(dt, ctx) {
      this._gap -= dt; this._leapCd -= dt; this._chargeCd -= dt;
      const st = this.state;
      const P = this.P;
      switch (st) {
        case 'approach':
          this._decide(ctx);
          if (this.state === 'approach' && ctx.dist <= this.attackStart) { this._idleWait = 0.25 + Math.random() * 0.25; this.setState('combatIdle'); }
          break;
        case 'combatIdle':
          if (ctx.dist > this.attackStart * 1.06) { this.setState('approach'); break; }      // out of sweep range: close in (never stand still)
          this._decide(ctx);
          break;
        case 'windup':
          if (this.atk === 'roar') this._tickRoar(dt, ctx);
          else if (this.stateT >= this.windupTime) this.startStrike();
          break;
        case 'attack': {
          const t = this._attackClipT();
          if (!this._hitDone && t >= 0.36) { this._hitDone = true; this.onDamageFrame(ctx); }
          if (this.stateT >= this.strikeTime) this.setState('recover');
          break;
        }
        case 'recover':
          if (this.stateT >= this.recoverTime) this._afterAttack();
          break;
        case 'leapWind':
          if (!this._leap.locked) this._aimLeap(ctx);
          if (this.stateT >= 0.5 * P.leapWind) this._leap.locked = true;
          if (this.stateT >= P.leapWind) this.setState('leap');
          break;
        case 'leap':
          if (this.stateT >= P.air) this._land();
          break;
        case 'leapEnd':
          if (this.stateT >= this._endT) this._afterAttack();
          break;
        case 'chargeWind':
          if (this.stateT < 0.5 * P.chargeWind) this._aimCharge(ctx);
          if (this.stateT >= P.chargeWind) this.setState('charge');
          break;
        case 'charge':
          this._tickCharge(dt, ctx);
          break;
        case 'chargeEnd':
          if (this.stateT >= this._endT) this._afterAttack();
          break;
        default: break;
      }
    }

    _decide(ctx) {
      if (this.dead) return;
      const P = this.P;
      if (this._roarPending > 0) { this.startRoar('phase'); return; }
      if (this._gap > 0) return;
      const d = ctx.dist, fe = this._facingError(ctx);
      if (this._leapCd <= 0 && d > LEAP_MIN && d < LEAP_MAX && fe < 0.9) { this.startLeap(ctx); return; }
      if (P.charge && this._chargeCd <= 0 && d > CHARGE_MIN && d < CHARGE_MAX && fe < 0.5) { this.startCharge(ctx); return; }
      if (d <= this.attackStart * 1.05 && fe < 0.6 && (this.state !== 'combatIdle' || this.stateT >= this._idleWait)) this.startWindup();
    }

    _afterAttack() {
      const P = this.P;
      this.atk = null;
      if (this._combo > 0 && this.state === 'recover') { this._combo--; this.startWindup(true); return; }
      this._combo = 0;
      this._gap = P.gap;
      this._idleWait = 0.1 + Math.random() * 0.2;
      this.setState('combatIdle');
    }

    speedFor(dist, wave) {
      const P = this.P;
      const wantRun = this.gait === 'Run' ? dist > 9 : dist > 13;
      const slow = clamp((dist - this.stopDist) / (1.6 * this.sizeScale), 0.45, 1);
      return wantRun ? { gait: 'Run', speed: P.run } : { gait: 'Walking', speed: P.walk * Math.min(1, slow + 0.25) };
    }

    // -------------------------------------------------------------------------------------------------------------------
    // sweep
    // -------------------------------------------------------------------------------------------------------------------
    startWindup(second) {
      const P = this.P;
      this.atk = 'sweep';
      if (P.combo && !second) this._combo = 1;
      this.windupTime = second ? Math.max(0.5, P.windup * 0.8) : P.windup;
      this.strikeTime = P.strike;
      this.recoverTime = (this._combo > 0) ? 0.3 : P.recover;
      this.setState('windup');
    }

    startStrike() {
      this.setState('attack');
      if (window.Sfx && Sfx.swing) { try { Sfx.swing(true); } catch (e) { /* ignore */ } }
    }

    // damage frame of the sweep: the player inside the fan drawn on the ground
    onDamageFrame(ctx) {
      const pp = playerPos();
      if (!pp || !window.Player || !Player.hurt) return;
      const p = this.mesh.position;
      const dx = pp.x - p.x, dz = pp.z - p.z;
      const dist = Math.hypot(dx, dz);
      this._shake(0.28);
      this._dustAt(p.x + Math.sin(this._yaw) * 2.6, p.z + Math.cos(this._yaw) * 2.6, 0.8);
      this._tele && (this._teleFlash = 1);
      if (dist > SWEEP_R) return;
      const fx = Math.sin(this._yaw), fz = Math.cos(this._yaw);
      const cos = dist > 1e-4 ? (fx * dx + fz * dz) / dist : 1;
      if (cos < SWEEP_COS) return;
      if (window.Sfx && Sfx.clang) { try { Sfx.clang(); } catch (e) { /* ignore */ } }
      Player.hurt(Math.round(DMG.sweep * (1 + 0.1 * (this.phase - 1))), this);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // leap slam
    // -------------------------------------------------------------------------------------------------------------------
    startLeap(ctx) {
      this.atk = 'leap';
      this._leapCd = this.P.leapCd;
      this._leap.locked = false;
      this._aimLeap(ctx);
      this.setState('leapWind');
    }

    _aimLeap(ctx) {
      const p = this.mesh.position, L = this._leap;
      const d = clamp(ctx.dist - 4.6, 3.2, LEAP_MAX);          // lands 4.6 m short of the player: the ring still covers a player who stands still
      L.sx = p.x; L.sz = p.z;
      L.tx = p.x + ctx.nx * d; L.tz = p.z + ctx.nz * d;
      const half = ARENA_LIMIT;
      L.tx = clamp(L.tx, -half, half); L.tz = clamp(L.tz, -half, half);
      L.h = clamp(2.6 + d * 0.16, 3.0, 6.0);
    }

    _land() {
      const L = this._leap, p = this.mesh.position, P = this.P;
      p.x = L.tx; p.z = L.tz; p.y = 0;
      // push out of trees / rocks the boss came down on
      const cols = window.World && World.colliders;
      if (cols) {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i], ox = p.x - c.x, oz = p.z - c.z, d = Math.hypot(ox, oz), min = c.r + BODY_R * 0.8;
          if (d < min && d > 1e-5) { p.x += ox / d * (min - d); p.z += oz / d * (min - d); }
        }
      }
      this._endT = P.leapEnd;
      this.setState('leapEnd');
      this._slam(p.x, p.z, P.slam);
    }

    // the ground slam: AoE damage + shockwave ring + dust ring + shake
    _slam(x, z, R) {
      const pp = playerPos();
      this._shake(1.0);
      this._wave = { t: 0, x: x, z: z, R: R * 1.45 };
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * TAU;
        this._dustAt(x + Math.cos(a) * R * 0.8, z + Math.sin(a) * R * 0.8, 1.3);
      }
      if (window.FX && FX.sparks) { try { FX.sparks(new V3(x, 0.2, z), new V3(0, 1, 0), 26); } catch (e) { /* ignore */ } }
      if (window.Sfx) {
        try { if (Sfx.footstep) Sfx.footstep('boss'); if (Sfx.clang) Sfx.clang(); if (Sfx.armorHit) Sfx.armorHit(); } catch (e) { /* ignore */ }
      }
      if (!pp || !window.Player || !Player.hurt) return;
      if (Math.hypot(pp.x - x, pp.z - z) <= R) Player.hurt(Math.round(DMG.slam * (1 + 0.1 * (this.phase - 1))), this);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // charge
    // -------------------------------------------------------------------------------------------------------------------
    startCharge(ctx) {
      this.atk = 'charge';
      this._chargeCd = this.P.chargeCd;
      this._aimCharge(ctx);
      this.setState('chargeWind');
    }

    _aimCharge(ctx) {
      this._cdir.set(ctx.nx, 0, ctx.nz);
      if (this._cdir.lengthSq() < 1e-6) this._cdir.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
      this._cdir.normalize();
      this._cLen = clamp(ctx.dist + 9, 16, 30);
    }

    _tickCharge(dt, ctx) {
      const P = this.P, p = this.mesh.position, dir = this._cdir;
      this._cSpeed += (P.chargeSpeed - this._cSpeed) * (1 - Math.exp(-5 * dt));
      const step = this._cSpeed * dt;
      p.x += dir.x * step; p.z += dir.z * step; p.y = 0;
      this._cTravel += step;
      const ts = this._cSpeed / (Knight.CLIP_SPEED.Run * this.sizeScale);
      if (this._cur.lower) this._cur.lower.setEffectiveTimeScale(ts);
      if (this._cur.upper) this._cur.upper.setEffectiveTimeScale(ts);
      let end = false, crash = false;
      // a tree or a rock stops it (and stuns it)
      const cols = window.World && World.colliders;
      if (cols) {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i], ox = p.x - c.x, oz = p.z - c.z, d = Math.hypot(ox, oz), min = c.r + BODY_R * 0.85;
          if (d < min) { if (d > 1e-5) { p.x += ox / d * (min - d); p.z += oz / d * (min - d); } crash = true; }
        }
      }
      if (Math.abs(p.x) >= ARENA_LIMIT || Math.abs(p.z) >= ARENA_LIMIT) { p.x = clamp(p.x, -ARENA_LIMIT, ARENA_LIMIT); p.z = clamp(p.z, -ARENA_LIMIT, ARENA_LIMIT); crash = true; }
      const pp = playerPos();
      if (!this._cHit && pp && Math.hypot(pp.x - p.x, pp.z - p.z) < CHARGE_HIT_R) {
        this._cHit = true;
        if (window.Player && Player.hurt) {
          if (window.Sfx && Sfx.clang) { try { Sfx.clang(); } catch (e) { /* ignore */ } }
          Player.hurt(Math.round(DMG.charge * (1 + 0.1 * (this.phase - 1))), this);
        }
        end = true;
      }
      if (this._cTravel >= this._cLen || this.stateT > 2.4) end = true;
      if (crash) {
        end = true;
        this._cCrash = true;
        this._shake(0.7);
        this._dustAt(p.x + dir.x * 1.5, p.z + dir.z * 1.5, 1.2);
        this._dustAt(p.x + dir.x * 1.5 + 1, p.z + dir.z * 1.5, 1.0);
        if (window.Sfx && Sfx.clang) { try { Sfx.clang(); } catch (e) { /* ignore */ } }
      }
      if (end) {
        this._endT = P.chargeEnd + (this._cCrash ? 0.8 : 0);
        this.setState('chargeEnd');
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // roar, phases, minions
    // -------------------------------------------------------------------------------------------------------------------
    startRoar(kind) {
      this.atk = 'roar';
      this._roarKind = kind || 'phase';
      this.windupTime = kind === 'intro' ? 1.5 : 1.6;
      this._roarFx = 0;
      if (this._roarPending > 0) this._roarPending--;
      this.setState('windup');
    }

    _tickRoar(dt, ctx) {
      const t = this.stateT;
      if (this._roarFx < 1 && t >= 0.35) {
        this._roarFx = 1;
        this._shake(0.55);
        this._wave = { t: 0, x: this.mesh.position.x, z: this.mesh.position.z, R: 11 };
        if (this._roarKind === 'phase') {
          if (window.Sfx && Sfx.bossRoar) { try { Sfx.bossRoar(); } catch (e) { /* ignore */ } }
          this._summon(2);
        }
      }
      if (this._roarFx < 2 && t >= 0.95) { this._roarFx = 2; this._shake(0.35); }
      if (t >= this.windupTime) {
        this.atk = null;
        this._gap = 0.4;
        this._idleWait = 0.1;
        this.setState('combatIdle');
      }
    }

    _checkPhase() {
      if (this.dead) return;
      const r = this.hp / this.maxHp;
      const want = r <= 0.33 ? 3 : (r <= 0.66 ? 2 : 1);
      while (this.phase < want) {
        this.phase++;
        this._roarPending++;
        this._glowTarget = this.phase === 2 ? 0.45 : 1;
      }
    }

    // a point on the arena ring, away from the player and the boss, not inside a collider
    _ringPoint() {
      const pp = playerPos(), bp = this.mesh.position;
      const cols = (window.World && World.colliders) || [];
      let best = null, bestScore = -1e9;
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * TAU, r = 27 + Math.random() * 3;
        const x = Math.sin(a) * r, z = Math.cos(a) * r;
        let ok = true;
        for (const c of cols) { if (Math.hypot(x - c.x, z - c.z) < c.r + 1.6) { ok = false; break; } }
        if (!ok) continue;
        const dB = Math.hypot(x - bp.x, z - bp.z);
        const dP = pp ? Math.hypot(x - pp.x, z - pp.z) : 30;
        if (dB < 9 || dP < 14) continue;
        const score = Math.min(dP, 36) + Math.random() * 6;
        if (score > bestScore) { bestScore = score; best = { x: x, z: z }; }
      }
      if (!best) {                                                  // fallback: beside the boss, 9 m away
        const a = Math.random() * TAU;
        best = { x: clamp(bp.x + Math.sin(a) * 9, -ARENA_LIMIT, ARENA_LIMIT), z: clamp(bp.z + Math.cos(a) * 9, -ARENA_LIMIT, ARENA_LIMIT) };
      }
      return best;
    }

    _summon(n) {
      if (!window.Enemies || !Enemies.add) return;
      this.minions = this.minions.filter((m) => m && !m.dead && !m._removed);
      const room = Math.max(0, 4 - this.minions.length);
      for (let i = 0; i < Math.min(n, 2, room); i++) {
        try {
          const pt = this._ringPoint();
          const m = new Knight({ speedScale: 1.08 });
          m.isMinion = true;
          m.waveNumber = this.waveNumber;
          m.mesh.position.set(pt.x, 0, pt.z);
          Enemies.add(m);
          this.minions.push(m);
          this._dustAt(pt.x, pt.z, 1.6);
        } catch (err) { console.error('[Boss] could not summon a minion', err); }
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // state hooks
    // -------------------------------------------------------------------------------------------------------------------
    onEnter(state, prev) {
      switch (state) {
        case 'leapWind':
          this._playBoth(JUMP, 0.25); this._setJumpTime(0); this.currentClip = JUMP;
          break;
        case 'leap': this._leap.locked = true; break;
        case 'leapEnd': this.currentClip = JUMP; break;
        case 'chargeWind': this._playStateAnim('windup', 0.25); break;
        case 'charge':
          this._cTravel = 0; this._cSpeed = 1.5; this._cHit = false; this._cCrash = false;
          this.gait = 'Run'; this._playBoth('Run', 0.2); this.currentClip = 'Run';
          if (window.Sfx && Sfx.swing) { try { Sfx.swing(true); } catch (e) { /* ignore */ } }
          break;
        case 'chargeEnd': this._playStateAnim('combatIdle', 0.35); break;
        default: break;
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // movement / turning / animation overrides for the custom states
    // -------------------------------------------------------------------------------------------------------------------
    _custom() {
      const s = this.state;
      return s === 'leapWind' || s === 'leap' || s === 'leapEnd' || s === 'chargeWind' || s === 'charge' || s === 'chargeEnd';
    }

    _move(dt, ctx) {
      const s = this.state;
      if (!this._custom()) { super._move(dt, ctx); return; }
      const p = this.mesh.position;
      this._speed = 0; this._vel.set(0, 0, 0);
      this._decayKnockback(dt);
      if (s === 'leap') {
        const L = this._leap, u = clamp(this.stateT / this.P.air, 0, 1);
        p.x = lerp(L.sx, L.tx, u); p.z = lerp(L.sz, L.tz, u);
        p.y = L.h * 4 * u * (1 - u);
      } else if (s === 'chargeEnd') {
        // slide to a stop
        this._cSpeed *= Math.exp(-4.5 * dt);
        p.x += this._cdir.x * this._cSpeed * dt; p.z += this._cdir.z * this._cSpeed * dt;
        p.y = 0;
      } else {
        p.y = 0;
      }
    }

    _turn(dt, ctx) {
      const s = this.state;
      if (!this._custom()) { super._turn(dt, ctx); return; }
      let target = null, rate = 0;
      if (s === 'leapWind') { target = Math.atan2(this._leap.tx - this._leap.sx, this._leap.tz - this._leap.sz); rate = 4.0; }
      else if (s === 'chargeWind') { target = Math.atan2(this._cdir.x, this._cdir.z); rate = 4.5; }
      else if (s === 'leap') { target = Math.atan2(this._leap.tx - this._leap.sx, this._leap.tz - this._leap.sz); rate = 4.0; }
      else if (s === 'charge') { target = Math.atan2(this._cdir.x, this._cdir.z); rate = 6; }
      if (target === null) return;
      this._yaw += clamp(angDiff(this._yaw, target), -rate * dt, rate * dt);
      this.mesh.rotation.y = this._yaw;
    }

    _setJumpTime(t) {
      const a = this.actions[JUMP], b = this.lowerActions[JUMP];
      for (const x of [a, b]) { if (!x) continue; x.time = clamp(t, 0, (J.dur || 1.16) - 1e-3); x.setEffectiveTimeScale(0); }
    }

    _animate(dt, ctx) {
      const s = this.state;
      if (s === 'leapWind') this._setJumpTime(lerp(0, J.takeoff, smooth(this.stateT / this.P.leapWind)));
      else if (s === 'leap') this._setJumpTime(lerp(J.takeoff, J.land, clamp(this.stateT / this.P.air, 0, 1)));
      else if (s === 'leapEnd') this._setJumpTime(lerp(J.land, J.dur || 1.16, smooth(this.stateT / (this._endT * 0.8))));
      else if (s === 'chargeWind') {
        const a = this.actions[ATTACK];
        if (a && this._cur.upper === a) { a.time = lerp(0, ATK_RAISE, smooth(this.stateT / 0.45)); a.setEffectiveTimeScale(0); }
      }
      super._animate(dt, ctx);
      this._updateLook(dt);
      this._updateTele(dt);
    }

    // heavy boots, only close by
    _footsteps(ctx) {
      const s = this.state;
      if ((s !== 'approach' && s !== 'charge') || !window.Sfx || !Sfx.footstep) return;
      const a = this._cur.lower;
      if (!a) return;
      const clip = a.getClip();
      const step = Math.floor((a.time / clip.duration) * 2);
      if (step !== this._stepPhase) {
        this._stepPhase = step;
        if (ctx.dist > 40) return;
        try { Sfx.footstep('boss'); } catch (e) { /* ignore */ }
        this._shake(s === 'charge' ? 0.16 : 0.07);
      }
    }

    // armour flash on a hit + glow of the later phases
    _updateLook(dt) {
      this._flash = Math.max(0, this._flash - dt * 5);
      this._glow += (this._glowTarget - this._glow) * (1 - Math.exp(-2.5 * dt));
      const g = this._glow, f = this._flash;
      for (let i = 0; i < this._armorMats.length; i++) {
        const m = this._armorMats[i], b = m._baseEmissive;
        m.emissive.setRGB(b.r + g * 0.30 + f * 0.30, b.g + g * 0.035 + f * 0.20, b.b + f * 0.10);
      }
      if (this._blade) {
        const b = this._blade._baseEmissive;
        this._blade.emissive.setRGB(b.r + g * 0.55 + f * 0.1, b.g + g * 0.07, b.b);
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // frame
    // -------------------------------------------------------------------------------------------------------------------
    update(dt, target, waveNumber) {
      if (!this._placed) this._placeInView();
      super.update(dt, target, waveNumber);
      if (this.dead || this._removed) return;
      // boss bar every frame (waves.js also does it: same values)
      if (window.HUD && HUD.bossBar) { HUD.bossBar(true, Math.max(0, this.hp) / this.maxHp, this.displayName || NAME); this._barShown = true; }
    }

    // The wave's spawner prefers points behind the player; the boss's arrival has to be SEEN, so a boss that Waves spawned outside
    // the view cone (~55 degrees) is moved onto the arena in front of the player, 17-21 m away (big in the frame, still room for the
    // intro roar), clear of trees and rocks.
    _placeInView() {
      this._placed = true;
      if (!(window.Waves && Waves.boss === this) || !window.Game || !Game.camera) return;
      const pp = playerPos();
      if (!pp) return;
      const d = new V3();
      Game.camera.getWorldDirection(d); d.y = 0;
      if (d.lengthSq() < 1e-4) return;
      d.normalize();
      const p = this.mesh.position;
      const rx = p.x - pp.x, rz = p.z - pp.z, rl = Math.hypot(rx, rz) || 1;
      if ((rx * d.x + rz * d.z) / rl > 0.57) return;
      const cols = (window.World && World.colliders) || [];
      for (let i = 0; i < 16; i++) {
        const a = (Math.random() - 0.5) * 0.8, c = Math.cos(a), s = Math.sin(a);
        const R = 17 + Math.random() * 4;
        const x = pp.x + (d.x * c - d.z * s) * R, z = pp.z + (d.x * s + d.z * c) * R;
        if (Math.abs(x) > 54 || Math.abs(z) > 54) continue;
        let ok = true;
        for (const col of cols) { if (Math.hypot(x - col.x, z - col.z) < col.r + 3) { ok = false; break; } }
        if (!ok) continue;
        p.x = x; p.z = z;
        this._yaw = Math.atan2(pp.x - x, pp.z - z);
        this.mesh.rotation.y = this._yaw;
        return;
      }
    }

    _reactToHit(hit) {
      this._flash = 1;
      const d = hit.dir;
      if (d) {
        const sy = Math.sin(this._yaw), cy = Math.cos(this._yaw);
        this._flinchDir.set(d.x * cy - d.z * sy, 0, d.x * sy + d.z * cy);
        if (this._flinchDir.lengthSq() > 1e-6) this._flinchDir.normalize(); else this._flinchDir.set(0, 0, -1);
      } else this._flinchDir.set(0, 0, -1);
      this._flinch = 1;
      this._flinchPow = hit.zone === 'head' ? 0.12 : 0.06;      // a shudder, never a stagger: the boss keeps its attack
    }

    takeHit(hit) {
      const killed = super.takeHit(hit);
      if (!killed) this._checkPhase();
      return killed;
    }

    // -------------------------------------------------------------------------------------------------------------------
    // death
    // -------------------------------------------------------------------------------------------------------------------
    onDeath(hit) {
      this.atk = null;
      this.mesh.position.y = 0;
      if (window.HUD && HUD.bossBar) { try { HUD.bossBar(false); } catch (e) { /* ignore */ } }
      this._barShown = false;
      this._hideTele();
      this._glowTarget = 0;
      if (this.actions.Death) this.actions.Death.setEffectiveTimeScale(0.6);       // slow, heavy fall
      this._targetYaw = null;
      // fall to the side of the player's line of fire instead of spinning round or onto the camera
      const pp = playerPos(), p = this.mesh.position;
      let base = this._yaw;
      if (pp) base = Math.atan2(pp.x - p.x, pp.z - p.z);
      this._deathYaw = base + (Math.random() < 0.5 ? 1 : -1) * Math.PI * 0.5;
      const c = new V3(p.x, 2.2, p.z);
      this._shake(0.8);
      if (window.FX) {
        try {
          if (FX.sparks) { FX.sparks(c, new V3(0, 1, 0), 40); FX.sparks(c, new V3(0.8, 0.3, 0.2), 24); FX.sparks(c, new V3(-0.8, 0.3, -0.2), 24); }
          if (FX.blood) FX.blood(c, hit && hit.dir ? hit.dir : new V3(0, 0, -1), 24);
          if (FX.smoke) FX.smoke(c, new V3(0, 1, 0), 2.2);
        } catch (e) { /* ignore */ }
      }
      if (window.Sfx && Sfx.bossRoar) { try { Sfx.bossRoar(); } catch (e) { /* ignore */ } }
      const at = (t, fn) => this._deathEvents.push({ t: t, fn: fn, done: false });
      at(0.9, () => { this._shake(0.35); if (window.Sfx && Sfx.footstep) { try { Sfx.footstep('boss'); } catch (e) { /* ignore */ } } });
      at(DEATH_IMPACT, () => {
        this._shake(1.0);
        const q = this.mesh.position;
        const f = new V3(Math.sin(this._yaw), 0, Math.cos(this._yaw));
        if (window.Sfx) { try { if (Sfx.footstep) Sfx.footstep('boss'); if (Sfx.clang) Sfx.clang(); } catch (e) { /* ignore */ } }
        for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; this._dustAt(q.x + f.x * 2.2 + Math.cos(a) * 2.6, q.z + f.z * 2.2 + Math.sin(a) * 2.6, 1.4); }
        this._wave = { t: 0, x: q.x + f.x * 2.2, z: q.z + f.z * 2.2, R: 9 };
      });
    }

    _updateDead(dt) {
      if (this._deathYaw !== undefined) {
        const err = angDiff(this._yaw, this._deathYaw);
        this._yaw += clamp(err, -2.2 * dt, 2.2 * dt);
        this.mesh.rotation.y = this._yaw;
      }
      super._updateDead(dt);
      const ev = this._deathEvents;
      for (let i = 0; i < ev.length; i++) if (!ev[i].done && this._deadT >= ev[i].t) { ev[i].done = true; try { ev[i].fn(); } catch (e) { /* ignore */ } }
      this._updateLook(dt);
      this._updateTele(dt);
    }

    dispose() {
      if (this._removed) return;
      if (this._barShown && window.HUD && HUD.bossBar) { try { HUD.bossBar(false); } catch (e) { /* ignore */ } }
      this._barShown = false;
      if (this._tele) {
        const T = this._tele;
        for (const k of Object.keys(T.meshes)) { const m = T.meshes[k]; if (m.parent) m.parent.remove(m); }
        for (const g of T.geos) g.dispose();
        for (const m of T.mats) m.dispose();
        this._tele = null;
      }
      for (const m of this._gearMats || []) { try { m.dispose(); } catch (e) { /* ignore */ } }
      for (const g of this._hornGeos || []) { try { g.dispose(); } catch (e) { /* ignore */ } }
      for (const g of this._shGeos || []) { try { g.dispose(); } catch (e) { /* ignore */ } }
      super.dispose();
    }

    // -------------------------------------------------------------------------------------------------------------------
    // effects helpers
    // -------------------------------------------------------------------------------------------------------------------
    _shake(a) {
      if (!window.FX || !FX.shake) return;
      const pp = playerPos(), p = this.mesh.position;
      const d = pp ? Math.hypot(pp.x - p.x, pp.z - p.z) : 10;
      try { FX.shake(a * clamp(1.25 - d / 38, 0.2, 1)); } catch (e) { /* ignore */ }
    }

    _dustAt(x, z, scale) {
      if (window.FX && FX.dust) { try { FX.dust(new V3(x, 0.05, z), new V3(0, 1, 0), scale); } catch (e) { /* ignore */ } }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // ground telegraphs (what the next hit will cover) + the shockwave ring
    // -------------------------------------------------------------------------------------------------------------------
    _ensureTele() {
      if (this._tele) return this._tele;
      const scene = this.mesh.parent || sceneOf();
      if (!scene) return null;
      const geos = [], mats = [], meshes = {};
      const mat = (color, opacity) => {
        const m = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false, side: THREE.DoubleSide, fog: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        mats.push(m);
        return m;
      };
      const mk = (name, geo, m, order) => {
        geos.push(geo);
        const o = new THREE.Mesh(geo, m);
        o.name = 'boss-tele:' + name;
        o.visible = false; o.frustumCulled = false; o.renderOrder = order; o.castShadow = false; o.receiveShadow = false;
        scene.add(o);
        meshes[name] = o;
        return o;
      };
      const half = Math.acos(SWEEP_COS);
      const fan = new THREE.CircleGeometry(1, 40, -Math.PI / 2 - half, half * 2); fan.rotateX(-Math.PI / 2);
      const disc = new THREE.CircleGeometry(1, 56); disc.rotateX(-Math.PI / 2);
      const ring = new THREE.RingGeometry(0.94, 1, 64); ring.rotateX(-Math.PI / 2);
      const wave = new THREE.RingGeometry(0.82, 1, 64); wave.rotateX(-Math.PI / 2);
      const strip = new THREE.PlaneGeometry(1, 1); strip.rotateX(-Math.PI / 2); strip.translate(0, 0, 0.5);
      const arc = new THREE.RingGeometry(0.97, 1, 48, 1, -Math.PI / 2 - half, half * 2); arc.rotateX(-Math.PI / 2);
      const edge = new THREE.PlaneGeometry(1, 1); edge.rotateX(-Math.PI / 2); edge.translate(0, 0, 0.5);
      mk('fanBase', fan, mat(0xff1a08, 0.30), 4);
      mk('fanFill', fan, mat(0xff2a05, 0.5), 5);
      mk('fanArc', arc, mat(0xffa040, 0.95), 6);
      mk('fanEdgeL', edge, mat(0xffa040, 0.95), 6);
      mk('fanEdgeR', edge, mat(0xffa040, 0.95), 6);
      mk('discBase', disc, mat(0xff1a08, 0.28), 4);
      mk('discFill', disc, mat(0xff2a05, 0.48), 5);
      mk('ring', ring, mat(0xffa040, 0.95), 6);
      mk('stripBase', strip, mat(0xff1a08, 0.28), 4);
      mk('stripFill', strip, mat(0xff2a05, 0.48), 5);
      mk('stripEdgeL', edge, mat(0xffa040, 0.95), 6);
      mk('stripEdgeR', edge, mat(0xffa040, 0.95), 6);
      mk('wave', wave, mat(0xffd9a0, 0.8), 7);
      this._tele = { meshes: meshes, geos: geos, mats: mats, names: Object.keys(meshes) };     // names: cached, _updateTele runs every frame
      return this._tele;
    }

    _hideTele() {
      const T = this._tele;
      if (!T) return;
      for (let i = 0; i < T.names.length; i++) T.meshes[T.names[i]].visible = false;
    }

    _updateTele(dt) {
      const W = this._wave;
      const st = this.state;
      const wantTele = !this.dead && (st === 'windup' || st === 'attack' || st === 'leapWind' || st === 'leap' || st === 'chargeWind' || st === 'charge');
      if (!wantTele && !W) { if (this._tele) this._hideTele(); return; }
      const T = this._ensureTele();
      if (!T) return;
      const M = T.meshes;
      for (let i = 0; i < T.names.length; i++) if (T.names[i] !== 'wave') M[T.names[i]].visible = false;
      const p = this.mesh.position;
      const pulse = 0.5 + 0.5 * Math.sin(this._t * 14);
      this._teleFlash = Math.max(0, (this._teleFlash || 0) - dt * 4);

      if (wantTele) {
        const P = this.P;
        if ((st === 'windup' || st === 'attack') && this.atk === 'sweep') {
          const u = st === 'windup' ? clamp(this.stateT / this.windupTime, 0, 1) : 1;
          const R = SWEEP_R;
          M.fanBase.visible = true; M.fanBase.position.set(p.x, 0.05, p.z); M.fanBase.rotation.y = this._yaw; M.fanBase.scale.set(R, 1, R);
          M.fanBase.material.opacity = 0.28 + 0.08 * pulse;
          const f = st === 'windup' ? lerp(0.12, 1, smooth(u)) : 1;
          M.fanFill.visible = true; M.fanFill.position.set(p.x, 0.055, p.z); M.fanFill.rotation.y = this._yaw; M.fanFill.scale.set(R * f, 1, R * f);
          M.fanFill.material.opacity = st === 'windup' ? 0.32 + 0.3 * u : 0.6 + 0.4 * this._teleFlash;
          const half = Math.acos(SWEEP_COS);
          M.fanArc.visible = true; M.fanArc.position.set(p.x, 0.06, p.z); M.fanArc.rotation.y = this._yaw; M.fanArc.scale.set(R, 1, R);
          for (let i = 0; i < 2; i++) {
            const k = FAN_EDGES[i], sg = EDGE_SIGN[i];
            M[k].visible = true; M[k].position.set(p.x, 0.06, p.z); M[k].rotation.y = this._yaw + sg * half; M[k].scale.set(0.16, 1, R);
          }
        } else if (st === 'leapWind' || st === 'leap') {
          const L = this._leap, R = P.slam;
          const u = st === 'leapWind' ? clamp(this.stateT / P.leapWind, 0, 1) : 1;
          M.discBase.visible = true; M.discBase.position.set(L.tx, 0.05, L.tz); M.discBase.scale.set(R, 1, R);
          M.discBase.material.opacity = 0.26 + 0.08 * pulse;
          M.discFill.visible = true; M.discFill.position.set(L.tx, 0.055, L.tz); M.discFill.scale.set(R * lerp(0.1, 1, smooth(u)), 1, R * lerp(0.1, 1, smooth(u)));
          M.discFill.material.opacity = 0.32 + 0.3 * u;
          M.ring.visible = true; M.ring.position.set(L.tx, 0.06, L.tz); M.ring.scale.set(R, 1, R);
          M.ring.material.opacity = L.locked ? 0.7 + 0.3 * pulse : 0.55;
        } else if (st === 'chargeWind' || st === 'charge') {
          const w = CHARGE_HIT_R * 2, len = this._cLen;
          const u = st === 'chargeWind' ? clamp(this.stateT / P.chargeWind, 0, 1) : 1;
          const sx = st === 'charge' ? p.x - this._cdir.x * this._cTravel : p.x, sz = st === 'charge' ? p.z - this._cdir.z * this._cTravel : p.z;
          const yaw = Math.atan2(this._cdir.x, this._cdir.z);
          M.stripBase.visible = true; M.stripBase.position.set(sx, 0.05, sz); M.stripBase.rotation.y = yaw; M.stripBase.scale.set(w, 1, len);
          M.stripBase.material.opacity = 0.26 + 0.08 * pulse;
          M.stripFill.visible = true; M.stripFill.position.set(sx, 0.055, sz); M.stripFill.rotation.y = yaw;
          M.stripFill.scale.set(w, 1, len * (st === 'chargeWind' ? lerp(0.08, 1, smooth(u)) : 1));
          M.stripFill.material.opacity = st === 'chargeWind' ? 0.3 + 0.3 * u : 0.45;
          const px = Math.cos(yaw), pz = -Math.sin(yaw);               // the strip's sideways axis
          for (let i = 0; i < 2; i++) {
            const k = STRIP_EDGES[i], sg = EDGE_SIGN[i];
            M[k].visible = true; M[k].position.set(sx + px * sg * w / 2, 0.06, sz + pz * sg * w / 2); M[k].rotation.y = yaw; M[k].scale.set(0.16, 1, len);
          }
        }
      }

      if (W) {
        W.t += dt;
        const u = W.t / 0.65;
        if (u >= 1) { this._wave = null; M.wave.visible = false; }
        else {
          const r = Math.max(0.2, W.R * (0.15 + 0.85 * (1 - Math.pow(1 - u, 2))));
          M.wave.visible = true; M.wave.position.set(W.x, 0.07, W.z); M.wave.scale.set(r, 1, r);
          M.wave.material.opacity = 0.8 * (1 - u);
        }
      } else M.wave.visible = false;
    }
  }

  Boss.PHASES = PH;
  Boss.NAME = NAME;
  Boss.SIZE = SIZE;
  window.Boss = Boss;

  // ------------------------------------------------------------------------------------------------------------------------
  // QA helpers (?debug=1; installed when the first Boss is built: debug.js loads after this file)
  // ------------------------------------------------------------------------------------------------------------------------
  let dbgDone = false;
  function installDebug() {
    if (dbgDone || !window.__dbg) return;
    dbgDone = true;
    const round = (v) => Math.round(v * 1000) / 1000;
    const find = () => (window.Enemies ? Enemies.list.find((e) => e instanceof Boss && !e._removed) : null) || null;
    const ctxFor = (b) => {
      const pp = playerPos(), p = b.mesh.position;
      const dx = pp.x - p.x, dz = pp.z - p.z, d = Math.hypot(dx, dz) || 1;
      return { dist: d, dx: dx, dz: dz, nx: dx / d, nz: dz / d, wave: b.waveNumber };
    };
    window.__dbg.boss = {
      info() {
        const b = find();
        if (!b) return null;
        const p = b.mesh.position, pp = playerPos();
        return { phase: b.phase, state: b.state, atk: b.atk, clip: b.currentClip, hp: b.hp, maxHp: b.maxHp, dead: b.dead, hold: b.hold,
          pos: [round(p.x), round(p.y), round(p.z)], yaw: round(b._yaw), dist: pp ? round(Math.hypot(pp.x - p.x, pp.z - p.z)) : null,
          stateT: round(b.stateT), cds: { gap: round(b._gap), leap: round(b._leapCd), charge: round(b._chargeCd) }, pendingRoars: b._roarPending,
          minions: b.minions.filter((m) => !m.dead && !m._removed).length, height: round(b.height), glow: round(b._glow), combo: b._combo };
      },
      // start an attack right now (the AI keeps running): 'sweep' | 'leap' | 'charge' | 'roar'
      force(kind) {
        const b = find();
        if (!b) return null;
        b.hold = false;
        const ctx = ctxFor(b);
        b._gap = 0;
        if (kind === 'sweep') b.startWindup();
        else if (kind === 'leap') b.startLeap(ctx);
        else if (kind === 'charge') { if (b.phase < 2) b.phase = 2; b.startCharge(ctx); }
        else if (kind === 'roar') b.startRoar('phase');
        return this.info();
      },
      // jump to phase n: set the HP just below its threshold (takeHit is the real path, so minions + roar happen)
      phase(n) {
        const b = find();
        if (!b) return null;
        const hp = n >= 3 ? 0.32 : n === 2 ? 0.65 : 1;
        b.hp = Math.max(1, Math.floor(b.maxHp * hp));
        b._checkPhase();
        return this.info();
      },
      hold(on) { const b = find(); if (!b) return null; b.hold = on === undefined ? true : !!on; return b.hold; },
      // freeze a clip pose of the knight rig (debug): clip name + time in s
      clip(name, t) {
        const b = find();
        if (!b) return null;
        b.hold = true;
        b.setState('combatIdle');
        b.mixer.stopAllAction();
        const set = Knight.getClipSets()[name];
        if (!set) return null;
        const a = b.mixer.clipAction(set.full);
        a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
        a.time = t; a.setEffectiveTimeScale(0); a.setEffectiveWeight(1);
        b.mixer.update(0);
        return { name: name, t: t, dur: round(set.full.duration) };
      },
      gear() {
        const b = find();
        if (!b) return null;
        b.mesh.updateMatrixWorld(true);
        const out = {};
        for (const [kind, bone] of [['helmet', 'Head'], ['sword', 'Palm.R'], ['shield', 'LowerArm.L']]) {
          const g = b[kind];
          if (!g) { out[kind] = null; continue; }
          const gp = g.getWorldPosition(new V3()), bp = Assets.bone(b.model, bone).getWorldPosition(new V3());
          out[kind] = { dist: round(gp.distanceTo(bp)), parent: g.parent && (g.parent.userData.name || g.parent.name) };
        }
        return out;
      },
      tele() {
        const b = find();
        if (!b || !b._tele) return null;
        const out = {};
        for (const k of Object.keys(b._tele.meshes)) { const m = b._tele.meshes[k]; if (m.visible) out[k] = { pos: m.position.toArray().map(round), scale: m.scale.toArray().map(round), op: round(m.material.opacity) }; }
        return out;
      },
      constants() { return { SIZE: SIZE, HP: HP, PH: PH, DMG: DMG, SWEEP_R: SWEEP_R, J: J }; },
    };
  }
})();
