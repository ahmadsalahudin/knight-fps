/* enemies.js — window.Knight, window.Enemies  (Worker C1, docs/FIX_PLAN.md "Knight and Enemies", diagnosis 1.2 / 1.3 / 1.6)

   Animated knights: a skinned Assets.get('knight') clone driven by a THREE.AnimationMixer, with the helmet / sword / shield
   mounted ON BONES (Head, Palm.R, LowerArm.L), a small state machine, steering around World.colliders, and a death lifecycle.

   ---- class Knight (window.Knight; boss.js extends it) -------------------------------------------------------------------
   new Knight(opts?)   opts (all optional):
        scale         height multiplier of the 1.8 m knight (default 1). Gear, speeds, ranges and hit zones follow it.
        hp / maxHp    default 100
        tint          THREE.Color-able, multiplied into this knight's own copy of the 'Armor' material (default: slight random shade)
        speedScale    multiplier of the walk / run speed
        damage        player damage per sword hit (default 15), range / reach scale with `scale`
        helmet:false  no helmet;  gear:{helmet|sword|shield:{asset, scale, pos, rot, bone}}  overrides the fit (see GEAR below)
        type          'knight' (default)
   Fields: mesh (root Group in the scene, mesh.userData.enemy = this), model (the Assets wrapper), type, hp, maxHp, dead, state,
        currentClip, height, bones {head,torso,hips,handR,handL,armL,armR,legL,legR}, helmet, sword, shield (Assets wrappers
        parented to bones), mixer, actions{} (upper/full-body actions by clip name), lowerActions{} (lower-body layer),
        knockback (Vector3, m/s), knockbackScale.
   States: approach | combatIdle | windup | attack | recover | stagger | dead.
   Animation is layered: the LOWER body (hips, legs, feet) and the UPPER body (spine, head, arms, hands) each crossfade (0.25 s)
        on their own, so a knight stands planted (Idle_swordRight legs) while its upper body plays Run_swordAttack.
   Hooks for subclasses (Boss): override any of
        updateAI(dt, ctx)        state machine tick (ctx = {dist, dx, dz, nx, nz, wave})
        onEnter(state, prev)     called after every setState()
        startWindup()/startStrike()/onDamageFrame(): the damage frame, default = sword reach test + Player.hurt(damage, this)
        speedFor(dist, wave)     {gait:'Walking'|'Run', speed} while approaching
        die(hit) / takeHit(hit)  call super
   Public: takeHit({damage, zone, point, dir}), die(hit), applyImpulse(Vector3), setState(name),
        update(dt, playerPos, waveNumber), dispose().
   Knockback protocol with combat.js: Combat calls enemy.applyImpulse(Vector3) (m/s); the knight owns decay and movement.
   Thrown daggers: a share of the knights (Difficulty.throwers: Easy 20 %, Normal 35 %, Hard 50 %; chosen at spawn, never the boss) throw
        a dagger when they are 6-16 m from the player, walking, and their 5-8 s throw cooldown is ready: they stop, wind up ~0.6 s
        (the sword-raise windup) and release. Enemies.daggers holds the projectiles (see "Daggers" below); knight.thrower / ._throwCd.
   Shield rush: a share of the knights (Difficulty.rushers: Easy 10 %, Normal 20 %, Hard 35 %; never a thrower, never the boss) charge in a
        straight line when they are 7-18 m away and their 9-13 s cooldown is ready. States: rushWind (0.85 s: they stop, face you, a red strip
        on the ground shows the line, it locks 0.3 s before the charge) -> rush (8 m/s along the locked line, 1.5 m to hit: 16 damage x
        difficulty and a shove) -> stumble (1.4 s after a miss or a crash into a tree / rock, 0.5 s after a hit; takes 1.5x damage).
        Shooting a knight during rushWind breaks the charge. Debug: __dbg.knightRush(i?).
   Difficulty (waves.js): knight HP / speed / damage / windup time scale with window.Difficulty; the boss applies its own (boss.js).
   Loose gear: combat.js re-parents helmet / sword / shield into physics holders on death (userData.loose = true); after that this
        module never touches them again.

   ---- Enemies --------------------------------------------------------------------------------------------------------------
   list, add(e), update(dt, playerPos), rayTargets(), aliveCount(), findByObject(obj), clear(), remove(e)
   daggers[], throwDagger(thrower, target?), _tickDaggers(dt)   (ticked by update(), emptied by clear())
   Debug (?debug=1, installed lazily): __dbg.knight.pose(i, state, progress), .gear(i), .info(i),
        __dbg.knightRush(i?)  the knight (default: the nearest living one) starts its shield rush wind-up at once,
        __dbg.knightThrow(i?, flightSec?)  the knight (default: the nearest living one) throws at once, no windup / cooldown / range check;
        flightSec advances the dagger that long right away (use it with a frozen AI), __dbg.daggers() lists the daggers in flight.
*/
(() => {
  'use strict';

  const V3 = THREE.Vector3;
  const Q = THREE.Quaternion;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

  // ------------------------------------------------------------------------------------------------------------------------
  // tuning
  // ------------------------------------------------------------------------------------------------------------------------
  const MODEL_HEIGHT = 1.8;
  const FADE = 0.25;                                  // crossfade between clips (s)
  const ATTACK_CLIP = 'Run_swordAttack';
  const IDLE_CLIP = 'Idle_swordRight';
  // ground speed (m/s) of the clip at the 1.8 m model, measured from the planted foot: matching it stops the feet from skating
  const CLIP_SPEED = { Walking: 0.92, Run: 3.6 };
  // clip time (s) of the sword attack: raised sword -> strike -> end. The telegraph pose is the raised sword (t ~ 0.15).
  const ATK_RAISE = 0.17, ATK_DAMAGE_T = 0.36, ATK_STRIKE_END = 0.52, ATK_END = 0.82;
  const LINGER = 8, SINK = 2, SINK_DEPTH = 0.55;      // corpse: stays 8 s, sinks for 2 s, then is removed
  const BODY_R = 0.42;                                // collision radius of a 1.8 m knight
  const ARENA = 58;
  const DEATH_TURN = 4;                               // rad/s: how fast a falling knight turns toward its fall direction
  // thrown dagger
  const THROW_MIN = 6, THROW_MAX = 16;                // throw only from this distance (m) to the player
  const THROW_WINDUP = 0.6, THROW_RELEASE = 0.12;     // s of windup; the hand is released this long after the arm starts to swing
  const DAGGER_SPEED = 18, DAGGER_G = 6;              // m/s, and the gravity (m/s^2) that bends the flight into a slight arc
  const DAGGER_SIZE = 0.5, DAGGER_SPIN = 17;          // m, rad/s end over end
  const DAGGER_DAMAGE = 10, DAGGER_HIT_R = 0.6;       // base damage (x Difficulty.dmg), and the reach of the player's body
  const DAGGER_LIE = 5, DAGGER_MAX = 12;              // s a landed dagger stays; most daggers alive at once
  // shield rush
  const RUSH_MIN = 7, RUSH_MAX = 18, RUSH_WIND = 0.85, RUSH_LOCK = 0.3;     // distance window (m), telegraph (s), line locks this long before the charge
  const RUSH_SPEED = 8, RUSH_HIT_R = 1.5, RUSH_DAMAGE = 16, RUSH_SHOVE = 9;  // m/s, m, base damage, m/s given to the player
  const RUSH_STUMBLE_MISS = 1.4, RUSH_STUMBLE_HIT = 0.5, STUMBLE_DAMAGE = 1.5;
  const NEUTRAL = { dmg: 1, hp: 1, windup: 1, speed: 1, reach: 1, throwers: 0.35, rushers: 0.2 };
  const diff = () => (window.Difficulty && Difficulty.get()) || NEUTRAL;

  // Gear fit, measured on the 1.8 m knight. pos is in METRES inside the bone's own axes (x, y, z of the bone), rot in radians
  // (bone-local), scale in metres per native glTF unit. Everything is multiplied by the knight's scale at mount time.
  //   Head      axes ~ world axes at rest, helmet front (+Z, nasal bar) = face direction; head box (0.38 x 0.48 x 0.44 m).
  //   Palm.R    local X is the fist's long axis (the four fingers stack along it): the grip axis. Blade out of the fist = -X.
  //   LowerArm.L local Y runs along the forearm, +Z points away from the body at rest, so the shield face (+Z) faces outward;
  //             it is turned 0.75 rad about the forearm so the face also looks forward and reads from the front.
  const GEAR = {
    helmet: { asset: 'knight_helmet1', bone: 'Head', pos: [0, 0.235, -0.032], rot: [0, 0, 0], scale: 0.29 },
    sword: { asset: 'knight_sword', bone: 'Palm.R', pos: [0.04, 0.025, -0.02], rot: [Math.PI / 2, 0, Math.PI / 2], scale: 0.30 },
    shield: { asset: 'knight_shield', bone: 'LowerArm.L', pos: [0.06, 0.17, 0.17], rot: [0, 0.75, 0], scale: 0.30 },
  };

  // upper-body tracks: spine, head, arms, hands, fingers. Everything else (Body, legs, feet) is the lower body.
  const UPPER_RE = /^(Abdomen|Torso|Neck|Head|Shoulder|UpperArm|LowerArm|Palm|MiddleHand|Fingers|Thumb)/;

  // scratch
  const _v2 = new V3(), _v3 = new V3(), _v4 = new V3(), _v5 = new V3(), _v6 = new V3(), _up = new V3(0, 1, 0);
  const _v1 = new V3(), _q1 = new Q(), _q2 = new Q(), _sp = new V3();
  const AX = new V3(1, 0, 0), AZ = new V3(0, 0, 1);

  // Split every clip once into a lower and an upper body clip (clips are shared by all knights).
  let clipSets = null;
  function getClipSets() {
    if (clipSets) return clipSets;
    clipSets = {};
    for (const c of Assets.clips('knight')) {
      const up = c.tracks.filter((t) => UPPER_RE.test(t.name));
      const lo = c.tracks.filter((t) => !UPPER_RE.test(t.name));
      clipSets[c.name] = {
        full: c,
        upper: new THREE.AnimationClip(c.name + '.upper', c.duration, up),
        lower: new THREE.AnimationClip(c.name + '.lower', c.duration, lo),
      };
    }
    return clipSets;
  }

  function sceneOf() {
    return (window.Game && Game.scene) || (window.Main && Main.scene) || null;
  }

  const _qv = new V3();
  const _q1v = (v) => _qv.copy(v);

  // where a knight's sound comes from: above its feet (scratch vector, valid until the next call)
  function soundAt(k, h) {
    const p = k.mesh.position;
    return _sp.set(p.x, h === undefined ? 1.2 * k.sizeScale : h, p.z);
  }
  function sfx(name, a, b) {
    if (!window.Sfx || !Sfx[name]) return;
    try { Sfx[name](a, b); } catch (e) { /* audio never breaks the game */ }
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Knight
  // ------------------------------------------------------------------------------------------------------------------------
  class Knight {
    constructor(opts) {
      opts = opts || {};
      this.opts = opts;
      this.type = opts.type || 'knight';
      this.sizeScale = opts.scale > 0 ? opts.scale : 1;
      this.height = MODEL_HEIGHT * this.sizeScale;
      this.maxHp = opts.maxHp > 0 ? opts.maxHp : (opts.hp > 0 ? opts.hp : 100);
      this.hp = opts.hp > 0 ? opts.hp : this.maxHp;
      this.dead = false;
      this.damage = opts.damage > 0 ? opts.damage : 15;
      this.speedScale = opts.speedScale > 0 ? opts.speedScale : 1;
      // difficulty: wave knights (and the boss's minions) only. The boss and its stand-in apply their own multipliers.
      const D = diff();
      if (this.type === 'knight') {
        if (!(opts.hp > 0) && !(opts.maxHp > 0)) { this.maxHp = Math.max(1, Math.round(this.maxHp * D.hp)); this.hp = this.maxHp; }
        this.speedScale *= D.speed;
      }
      // dagger throwers are chosen at spawn
      const roll = Math.random();                 // one roll: throwers, then rushers, then plain swordsmen (the shares are exact and exclusive)
      this.thrower = this.type === 'knight' && roll < D.throwers;
      this._throwCd = 5 + Math.random() * 3;      // s until the next throw is allowed (5-8 s, random per knight)
      this._throwing = false;                     // the current windup / recover is a throw, not a sword swing
      this._thrown = false;
      // shield rushers are another share of the knights (never a thrower), also chosen at spawn
      this.rusher = this.type === 'knight' && !this.thrower && roll < D.throwers + (D.rushers || 0);
      this._rushCd = 6 + Math.random() * 4;       // s until the first rush may start
      this._rushDir = new V3(0, 0, 1);
      this._shieldW = 0; this._ov = [];
      this._rushLen = 12; this._rushed = 0; this._rushHit = false; this._strip = null;
      this.knockbackScale = typeof opts.knockbackScale === 'number' ? opts.knockbackScale : 1;
      this.knockback = new V3();
      this.waveNumber = 1;
      this.displayName = opts.displayName || null;

      // timings (s) and ranges (m); subclasses may change them after super()
      this.windupTime = 0.7;                      // telegraph: the sword rises and holds (>= 0.45 s)
      this.strikeTime = 0.38;
      this.recoverTime = 0.45;
      this.attackStart = 2.1 * this.sizeScale;    // distance (to the player) that starts a windup
      this.attackReach = 2.5 * this.sizeScale;    // distance at the damage frame that still connects (the strike lunges ~0.5 m)
      this.lungeSpeed = 2.6 * this.sizeScale;     // m/s forward during the first part of the strike
      this.attackCone = 0.35;                     // cos of the half angle in front of the knight that connects
      this.stopDist = 1.55 * this.sizeScale;      // never walk closer than this
      this.turnRate = 6.0;                        // rad/s while moving
      this.turnRateAttack = 2.6;                  // rad/s during windup / strike

      // randomised so a crowd does not move in lockstep
      this._speedVar = 0.92 + Math.random() * 0.16;
      this._idleWait = 0.25 + Math.random() * 0.3;

      // ---- scene graph ---------------------------------------------------------------------------------------------
      this.mesh = new THREE.Group();
      this.mesh.name = 'knight';
      this.mesh.userData.enemy = this;
      this.mesh.userData.type = this.type;
      const model = Assets.get('knight', { height: this.height, cloneMaterials: true });
      if (!model) throw new Error('Knight: asset "knight" is not available (Assets.load() not finished?)');
      this.model = model;
      this.mesh.add(model);

      this._owned = new Set();                    // materials cloned for this knight (disposed with it)
      this._skinned = [];
      model.traverse((o) => {
        if (o.isMesh) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => this._owned.add(m));
          if (o.isSkinnedMesh) this._skinned.push(o);
        }
      });
      this._tintArmor(opts.tint);

      const B = Assets.bones(model);
      this._bonesByName = B;
      this.bones = {
        head: B['Head'], torso: B['Torso'], hips: B['Hips'], handR: B['Palm.R'], handL: B['Palm.L'],
        armL: B['LowerArm.L'], armR: B['LowerArm.R'], legL: B['UpperLeg.L'], legR: B['UpperLeg.R'],
      };

      // gear is mounted on bones while the model is at the origin (its bone matrices are valid, scale 1)
      this.mesh.updateMatrixWorld(true);
      this.helmet = opts.helmet === false ? null : this._mount('helmet');
      this.sword = this._mount('sword');
      this.shield = this._mount('shield');

      // ---- animation -----------------------------------------------------------------------------------------------
      this._buildAnimation();

      // ---- state ---------------------------------------------------------------------------------------------------
      this.state = 'approach';
      this.prevState = null;
      this.stateT = 0;
      this.gait = 'Walking';
      this.currentClip = 'Walking';
      this.hold = false;                          // debug: AI + movement frozen, animation keeps running
      this._cool = 0;                             // seconds before the next windup is allowed
      this._hitDone = false;
      this._stumbleT = 1;                         // s the current stumble lasts
      this._flinch = 0;                           // procedural hit reaction 1 -> 0
      this._flinchDir = new V3();
      this._flinchPow = 0.4;
      this._pT = new Q(); this._pH = new Q(); this._pOn = false;    // procedural rotation currently added on top of the torso / head bone
      this._vel = new V3();
      this._speed = 0;
      this._yaw = 0;
      this._stepPhase = 0;
      this._t = 0;
      this._deadT = 0;
      this._removed = false;
      this._targetYaw = null;
      this._ctx = { dist: 99, dx: 0, dz: 1, nx: 0, nz: 1, wave: 1 };
      this._playStateAnim('approach', 0);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // construction helpers
    // -------------------------------------------------------------------------------------------------------------------
    _tintArmor(tint) {
      const shade = 0.9 + Math.random() * 0.2;
      const col = tint !== undefined && tint !== null ? new THREE.Color(tint) : null;
      this._owned.forEach((m) => {
        if (m.name !== 'Armor' || !m.color) return;
        if (col) m.color.multiply(col); else m.color.multiplyScalar(shade);
      });
    }

    _bone(name) {
      return this._bonesByName[name] || Assets.bone(this.model, name);
    }

    // Place a gear asset on a bone. Spec values are metres at the 1.8 m size; bone-local units are converted through the bone's
    // world scale (the glTF armature node carries x100, the wrapper ~0.32 on top), so the gear keeps its size in the world.
    _mount(kind) {
      const spec = Object.assign({}, GEAR[kind], this.opts.gear && this.opts.gear[kind]);
      const bone = this._bone(spec.bone);
      if (!bone) { console.warn('[Knight] no bone "' + spec.bone + '" for the ' + kind); return null; }
      const obj = Assets.get(spec.asset, { raw: true });
      if (!obj) return null;
      obj.name = kind;
      bone.getWorldScale(_v1);
      const k = this.sizeScale / _v1.x;           // bone-local units per metre of a 1.8 m knight
      obj.position.set(spec.pos[0] * k, spec.pos[1] * k, spec.pos[2] * k);
      obj.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      obj.scale.setScalar(spec.scale * k);
      bone.add(obj);
      obj.userData.gearKind = kind;
      return obj;
    }

    _buildAnimation() {
      const sets = getClipSets();
      this.mixer = new THREE.AnimationMixer(this.model);
      this.actions = {};                          // upper body (or full body for Death), keyed by clip name
      this.lowerActions = {};                     // lower body layer
      this._cur = { upper: null, lower: null };
      for (const name of ['Walking', 'Run', IDLE_CLIP, ATTACK_CLIP, 'Death']) {
        const set = sets[name];
        if (!set) { console.warn('[Knight] missing clip ' + name); continue; }
        const full = name === 'Death';
        const up = this.mixer.clipAction(full ? set.full : set.upper);
        const lo = full ? null : this.mixer.clipAction(set.lower);
        const once = name === ATTACK_CLIP || full;
        for (const a of [up, lo]) {
          if (!a) continue;
          a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
          a.clampWhenFinished = once;
        }
        this.actions[name] = up;
        if (lo) this.lowerActions[name] = lo;
      }
    }

    // Start `name` on one layer, crossfading from whatever played there. Returns the action.
    _play(layer, name, fade) {
      const table = layer === 'lower' ? this.lowerActions : this.actions;
      const a = table[name];
      if (!a) return null;
      const cur = this._cur[layer];
      if (cur === a) return a;
      a.enabled = true;
      a.reset();
      a.setEffectiveTimeScale(1);
      a.setEffectiveWeight(1);
      if (cur && fade > 0) a.crossFadeFrom(cur, fade, false);
      else { if (cur) cur.stop(); }
      a.play();
      this._cur[layer] = a;
      return a;
    }

    _playBoth(name, fade) {
      this._play('lower', name, fade);
      return this._play('upper', name, fade);
    }

    // Choose the clips of a state (called from setState()).
    _playStateAnim(state, fade) {
      switch (state) {
        case 'approach': this._playBoth(this.gait, fade); this.currentClip = this.gait; break;
        case 'combatIdle': case 'stagger': this._playBoth(IDLE_CLIP, fade); this.currentClip = IDLE_CLIP; break;
        case 'windup': {
          this._play('lower', IDLE_CLIP, fade);
          const a = this._play('upper', ATTACK_CLIP, fade);
          if (a) a.setEffectiveTimeScale(0);      // its time is driven by the state timer (telegraph / strike / recover)
          this.currentClip = ATTACK_CLIP;
          break;
        }
        case 'dead': {
          const d = this.actions['Death'];
          if (!d) break;
          const l = this._cur.lower, u = this._cur.upper;
          d.enabled = true; d.reset(); d.setEffectiveTimeScale(1); d.setEffectiveWeight(1);
          d.fadeIn(0.12); d.play();
          if (l) l.fadeOut(0.12);
          if (u) u.fadeOut(0.12);
          this._cur.lower = d; this._cur.upper = d;
          this.currentClip = 'Death';
          break;
        }
        default: break;
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // state machine
    // -------------------------------------------------------------------------------------------------------------------
    setState(name) {
      if (this.dead && name !== 'dead') return;
      const prev = this.state;
      this.prevState = prev;
      this.state = name;
      this.stateT = 0;
      if (name === 'windup') { this._hitDone = false; }
      if (name !== 'windup' && name !== 'recover') this._throwing = false;
      if (name !== 'rushWind') this._stripOff();
      if (name === 'approach') this._playStateAnim('approach', FADE);
      else if (name === 'combatIdle' || name === 'stagger') this._playStateAnim(name, FADE);
      else if (name === 'rushWind' || name === 'stumble') this._playStateAnim('combatIdle', FADE);
      else if (name === 'rush') { this.gait = 'Run'; this._playBoth('Run', 0.15); this.currentClip = 'Run'; }
      else if (name === 'windup') this._playStateAnim('windup', FADE * 0.8);
      else if ((name === 'attack' || name === 'recover') && this._cur.upper !== this.actions[ATTACK_CLIP]) this._playStateAnim('windup', 0.1);   // jumped in (debug / subclass)
      else if (name === 'dead') this._playStateAnim('dead', 0.12);
      this.onEnter(name, prev);
    }

    onEnter(state, prev) { /* hook for subclasses */ }

    // gait + speed (m/s) while approaching
    speedFor(dist, wave) {
      const w = Math.max(1, wave || 1);
      const k = this._speedVar * this.speedScale;
      const walk = (1.25 + 0.12 * (w - 1)) * k;
      const run = (2.9 + 0.2 * (w - 1)) * k;
      const runDist = w >= 3 ? 3.4 * this.sizeScale : (w === 2 ? 9 : 11) * this.sizeScale;
      // hysteresis so the clip does not flicker around the threshold
      const wantRun = this.gait === 'Run' ? dist > runDist * 0.75 : dist > runDist;
      const slow = clamp((dist - this.stopDist) / (1.6 * this.sizeScale), 0.45, 1);
      return wantRun ? { gait: 'Run', speed: run * slow } : { gait: 'Walking', speed: walk * Math.min(1, slow + 0.25) };
    }

    updateAI(dt, ctx) {
      const st = this.state;
      this._cool -= dt;
      this._throwCd -= dt;
      this._rushCd -= dt;
      const dist = ctx.dist;
      switch (st) {
        case 'approach': {
          if (dist <= this.attackStart) { this._idleWait = 0.2 + Math.random() * 0.35; this.setState('combatIdle'); }
          else if (this.thrower && this._throwCd <= 0 && dist >= THROW_MIN && dist <= THROW_MAX && this._facingError(ctx) < 0.7
            && Enemies.daggers.length < DAGGER_MAX) this.startThrow();
          else if (this.rusher && this._rushCd <= 0 && dist >= RUSH_MIN && dist <= RUSH_MAX && this._facingError(ctx) < 0.5 && this._rushPathClear(ctx)) this.startRush();
          break;
        }
        case 'combatIdle': {
          if (dist > this.attackStart * 1.35) { this.setState('approach'); break; }
          if (this.stateT >= this._idleWait && this._cool <= 0 && this._facingError(ctx) < 0.6) this.startWindup();
          break;
        }
        case 'windup': {
          if (this.stateT >= this.windupTime) { if (this._throwing) this.setState('recover'); else this.startStrike(); }
          break;
        }
        case 'attack': {
          const t = this._attackClipT();
          if (!this._hitDone && t >= ATK_DAMAGE_T) { this._hitDone = true; this.onDamageFrame(ctx); }
          if (this.stateT >= this.strikeTime) this.setState('recover');
          break;
        }
        case 'recover': {
          if (this._throwing) {
            if (!this._thrown && this.stateT >= THROW_RELEASE) { this._thrown = true; this.throwDagger(); }
            if (this.stateT >= this.recoverTime) { this._cool = Math.max(this._cool, 0.5); this.setState('approach'); }
            break;
          }
          if (this.stateT >= this.recoverTime) { this._cool = 0.25 + Math.random() * 0.5; this._idleWait = 0.1; this.setState('combatIdle'); }
          break;
        }
        case 'rushWind': {
          // the strip follows the player until it locks 0.3 s before the charge
          if (this.stateT < RUSH_WIND - RUSH_LOCK) this._rushDir.set(ctx.nx, 0, ctx.nz);
          this._stripUpdate(this.stateT / RUSH_WIND, this.stateT >= RUSH_WIND - RUSH_LOCK);
          if (this.stateT >= RUSH_WIND) this._launchRush(ctx);
          break;
        }
        case 'rush': this._rushTick(dt, ctx); break;
        case 'stumble': {
          if (this.stateT >= this._stumbleT) { this._cool = 0.3; this.setState(dist <= this.attackStart * 1.2 ? 'combatIdle' : 'approach'); }
          break;
        }
        case 'stagger': {
          if (this.stateT >= 0.3) {
            this._cool = Math.max(this._cool, 0.3);
            this.setState(dist <= this.attackStart * 1.2 ? 'combatIdle' : 'approach');
          }
          break;
        }
        default: break;
      }
    }

    startWindup() {
      this._throwing = false;
      // Hard: 20 % shorter telegraph (never below the 0.45 s a player needs to read it)
      this.windupTime = Math.max(0.45, Math.max(0.5, 0.72 - 0.04 * (Math.max(1, this.waveNumber) - 1)) * diff().windup);
      this.setState('windup');
    }

    // Stop, raise the sword (the normal windup) and throw a dagger instead of striking.
    startThrow() {
      this._throwing = true;
      this._thrown = false;
      this._throwCd = 5 + Math.random() * 3;
      this.windupTime = Math.max(0.45, THROW_WINDUP * diff().windup);
      this.setState('windup');
    }

    // ---- shield rush ----------------------------------------------------------------------------------------------------
    // the straight line to the player must be free of trees and rocks (they would end the charge at once)
    _rushPathClear(ctx) {
      const cols = window.World && World.colliders;
      if (!cols) return true;
      const len = Math.min(ctx.dist + 2, 20), p = this.mesh.position;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const ox = c.x - p.x, oz = c.z - p.z;
        const along = ox * ctx.nx + oz * ctx.nz;
        if (along < 0 || along > len) continue;
        if (Math.abs(ox * ctx.nz - oz * ctx.nx) < c.r + 0.9) return false;
      }
      return true;
    }

    startRush() {
      this._rushCd = 9 + Math.random() * 4;
      this._rushHit = false; this._rushed = 0;
      this.setState('rushWind');
      sfx('rushCry', soundAt(this));
    }

    _stripOn() {
      if (!this._strip) {
        const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
        const m = new THREE.MeshBasicMaterial({ color: 0xff3a22, transparent: true, opacity: 0.3, depthWrite: false });
        const mesh = new THREE.Mesh(g, m);
        mesh.renderOrder = 4; mesh.frustumCulled = false; mesh.visible = false;
        this._strip = mesh;
      }
      const scene = sceneOf();
      if (scene && !this._strip.parent) scene.add(this._strip);
      this._strip.visible = true;
    }
    _stripUpdate(u, locked) {
      this._stripOn();
      const s = this._strip, p = this.mesh.position, d = this._rushDir;
      const len = this._rushLength();
      s.position.set(p.x + d.x * len / 2, 0.06, p.z + d.z * len / 2);
      s.rotation.y = Math.atan2(d.x, d.z);
      s.scale.set(RUSH_HIT_R * 2 * this.sizeScale, 1, len);
      s.material.opacity = locked ? 0.7 + 0.2 * Math.sin(this._t * 40) : 0.38 + 0.3 * clamp(u, 0, 1);
      s.material.color.setHex(locked ? 0xff0a00 : 0xd00000);
    }
    _rushLength() { return clamp((this._ctx.dist || 10) + 4, 9, 22); }
    _stripOff() { if (this._strip) { this._strip.visible = false; if (this._strip.parent) this._strip.parent.remove(this._strip); } }

    _launchRush(ctx) {
      this._rushLen = this._rushLength();
      this._yaw = Math.atan2(this._rushDir.x, this._rushDir.z);
      this.mesh.rotation.y = this._yaw;
      this.setState('rush');
      sfx('swing', true, soundAt(this));
    }

    _rushTick(dt, ctx) {
      this._rushed += RUSH_SPEED * dt;
      const p = this.mesh.position;
      // hit: the player is within reach of the shield
      if (!this._rushHit && ctx.dist < RUSH_HIT_R * this.sizeScale) {
        this._rushHit = true;
        const d = this._rushDir;
        if (window.Player && Player.hurt) Player.hurt(Math.max(1, Math.round(RUSH_DAMAGE * diff().dmg)), this);
        if (window.Game && Game.shove) Game.shove(d.x * RUSH_SHOVE, d.z * RUSH_SHOVE);
        if (window.FX && FX.sparks) { try { FX.sparks(_sp.set(p.x + d.x * 0.8, 1.1, p.z + d.z * 0.8), _qv.set(-d.x, 0.3, -d.z), 10); } catch (e) { /* ignore */ } }
        sfx('clang', soundAt(this));
        this._endRush(RUSH_STUMBLE_HIT);
        return;
      }
      // crash: a tree or rock, or the end of the line
      let crash = this._rushed >= this._rushLen;
      const cols = window.World && World.colliders;
      if (!crash && cols) {
        const R = BODY_R * this.sizeScale + 0.35;
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          if (Math.hypot(p.x - c.x, p.z - c.z) < c.r + R) { crash = true; break; }
        }
      }
      if (crash) {
        if (this._rushed < this._rushLen && window.FX && FX.dust) { try { FX.dust(_sp.set(p.x, 0.05, p.z), new V3(0, 1, 0), 0.6); } catch (e) { /* ignore */ } sfx('clang', soundAt(this)); }
        this._endRush(RUSH_STUMBLE_MISS);
      }
    }

    _endRush(stumble) {
      this._stumbleT = stumble;
      this.setState('stumble');
    }

    // Release a dagger from the right hand at where the player is now (the range / cooldown checks are in updateAI).
    throwDagger() {
      const E = window.Enemies;
      if (!E || !E.throwDagger) return null;
      return E.throwDagger(this);
    }

    startStrike() {
      this.setState('attack');
      sfx('swing', false, soundAt(this));
    }

    // Damage frame of the sword swing: only when the player is in front and within reach.
    onDamageFrame(ctx) {
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      if (!pp || !window.Player || !Player.hurt) return;
      const p = this.mesh.position;
      const dx = pp.x - p.x, dz = pp.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > this.attackReach) return;
      const fx = Math.sin(this._yaw), fz = Math.cos(this._yaw);
      const cos = dist > 1e-4 ? (fx * dx + fz * dz) / dist : 1;
      if (cos < this.attackCone) return;
      if (Math.random() < 0.5) sfx('clang', soundAt(this));
      Player.hurt(Math.max(1, Math.round(this.damage * diff().dmg)), this);
    }

    // Clip time (s) of the attack animation for the current state / timer.
    _attackClipT() {
      switch (this.state) {
        case 'windup': {
          const u = clamp(this.stateT / this.windupTime, 0, 1);
          // rise quickly to the raised sword, then creep a little further (tension) until the strike
          return u < 0.4 ? lerp(0.0, 0.15, smooth(u / 0.4)) : lerp(0.15, ATK_RAISE, (u - 0.4) / 0.6);
        }
        case 'attack': {
          const u = clamp(this.stateT / this.strikeTime, 0, 1);
          return lerp(ATK_RAISE, ATK_STRIKE_END, Math.pow(u, 1.8));       // slow start, whips through the end of the arc
        }
        case 'recover': {
          const u = clamp(this.stateT / this.recoverTime, 0, 1);
          // a throw swings the raised arm through in the first 40 % (no jump from the raised pose), then settles
          if (this._throwing) return u < 0.4 ? lerp(ATK_RAISE, ATK_STRIKE_END, smooth(u / 0.4)) : lerp(ATK_STRIKE_END, ATK_END, smooth((u - 0.4) / 0.6));
          return lerp(ATK_STRIKE_END, ATK_END, smooth(u));
        }
        default: return 0;
      }
    }

    _facingError(ctx) {
      return Math.abs(angDiff(this._yaw, Math.atan2(ctx.dx, ctx.dz)));
    }

    // -------------------------------------------------------------------------------------------------------------------
    // per-frame update
    // -------------------------------------------------------------------------------------------------------------------
    update(dt, playerPos, waveNumber) {
      if (this._removed) return;
      if (waveNumber) this.waveNumber = waveNumber;
      this._t += dt;
      if (this.dead) { this._updateDead(dt); return; }

      const p = this.mesh.position;
      const ctx = this._ctx;
      if (playerPos) {
        ctx.dx = playerPos.x - p.x; ctx.dz = playerPos.z - p.z;
        ctx.dist = Math.hypot(ctx.dx, ctx.dz);
        if (ctx.dist > 1e-5) { ctx.nx = ctx.dx / ctx.dist; ctx.nz = ctx.dz / ctx.dist; }
      }
      ctx.wave = this.waveNumber;

      if (!this.hold) {
        this.stateT += dt;
        this.updateAI(dt, ctx);
        this._move(dt, ctx);
        this._turn(dt, ctx);
      } else {
        this._decayKnockback(dt);
      }
      this._animate(dt, ctx);
    }

    _turn(dt, ctx) {
      if (ctx.dist < 1e-3 || this.state === 'rush') return;                 // a charging knight keeps its line
      const rate = (this.state === 'windup' || this.state === 'attack' || this.state === 'recover' || this.state === 'rushWind') ? this.turnRateAttack : this.turnRate;
      const err = angDiff(this._yaw, Math.atan2(ctx.dx, ctx.dz));
      this._yaw += clamp(err, -rate * dt, rate * dt);
      this.mesh.rotation.y = this._yaw;
    }

    _decayKnockback(dt) {
      const k = Math.exp(-6 * dt);
      this.knockback.x *= k; this.knockback.z *= k;
      if (Math.abs(this.knockback.x) < 1e-3) this.knockback.x = 0;
      if (Math.abs(this.knockback.z) < 1e-3) this.knockback.z = 0;
    }

    // steering (approach only) + knockback + collisions
    _move(dt, ctx) {
      const p = this.mesh.position;
      const S = this.sizeScale;
      const R = BODY_R * S;
      let tx = 0, tz = 0;

      if (this.state === 'approach') {
        const sp = this.speedFor(ctx.dist, this.waveNumber);
        if (sp.gait !== this.gait) { this.gait = sp.gait; this._playBoth(this.gait, FADE); this.currentClip = this.gait; }
        this._speed = sp.speed;
        let dx = ctx.nx, dz = ctx.nz;
        const cols = window.World && World.colliders;
        // trees and rocks: steer around the ones in the way (tangent away from the obstacle, on the side of the target)
        if (cols) {
          for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const ox = p.x - c.x, oz = p.z - c.z;
            const d = Math.hypot(ox, oz);
            const reach = c.r + R + 1.3 * S;
            if (d >= reach || d < 1e-4) continue;
            const nx = ox / d, nz = oz / d;
            const ahead = -(nx * ctx.nx + nz * ctx.nz);      // > 0: the obstacle lies between us and the player
            if (ahead < -0.25) continue;
            let tgx = -nz, tgz = nx;
            if (tgx * ctx.nx + tgz * ctx.nz < 0) { tgx = -tgx; tgz = -tgz; }
            const w = clamp(1 - (d - c.r - R) / (1.3 * S), 0, 1);
            dx += (tgx * 1.4 + nx * 0.7) * w;
            dz += (tgz * 1.4 + nz * 0.7) * w;
          }
        }
        // other knights: keep apart
        const list = window.Enemies ? Enemies.list : null;
        if (list) {
          const sep = 1.25 * S;
          for (let i = 0; i < list.length; i++) {
            const o = list[i];
            if (o === this || o.dead || !o.mesh) continue;
            const ox = p.x - o.mesh.position.x, oz = p.z - o.mesh.position.z;
            const d = Math.hypot(ox, oz);
            const so = sep * 0.5 * (1 + (o.sizeScale || 1));
            if (d >= so || d < 1e-4) continue;
            const w = (so - d) / so * 1.6;
            dx += ox / d * w; dz += oz / d * w;
          }
        }
        const l = Math.hypot(dx, dz);
        if (l > 1e-5) { dx /= l; dz /= l; }
        tx = dx * this._speed; tz = dz * this._speed;
        // feet: playback rate follows the ground speed, so the stride matches the movement
        const ts = this._speed / (CLIP_SPEED[this.gait] * S);
        if (this._cur.lower) this._cur.lower.setEffectiveTimeScale(ts);
        if (this._cur.upper) this._cur.upper.setEffectiveTimeScale(ts);
      } else if (this.state === 'rush') {
        this._speed = RUSH_SPEED * Math.min(1.2, this.speedScale);
        tx = this._rushDir.x * this._speed; tz = this._rushDir.z * this._speed;
        const ts = this._speed / (CLIP_SPEED.Run * S);
        if (this._cur.lower) this._cur.lower.setEffectiveTimeScale(ts);
        if (this._cur.upper) this._cur.upper.setEffectiveTimeScale(ts);
      } else {
        this._speed = 0;
        if (this.state === 'attack' && ctx.dist > this.stopDist * 1.05) {
          // a short step into the swing so the blade actually reaches the player
          const f = clamp(1 - this.stateT / (this.strikeTime * 0.7), 0, 1);
          tx = ctx.nx * this.lungeSpeed * f; tz = ctx.nz * this.lungeSpeed * f;
        }
      }

      // velocity eases toward the target (no jerks when the state changes)
      const a = 1 - Math.exp(-9 * dt);
      this._vel.x += (tx - this._vel.x) * a;
      this._vel.z += (tz - this._vel.z) * a;

      p.x += (this._vel.x + this.knockback.x) * dt;
      p.z += (this._vel.z + this.knockback.z) * dt;
      this._decayKnockback(dt);

      // collisions: colliders, other knights, the player, the arena edge
      this._resolve(p, R, ctx);
      p.y = 0;
    }

    _resolve(p, R, ctx) {
      const S = this.sizeScale;
      // do not walk into the camera (before the collider pass, so a collider can never be pushed through)
      if (ctx.dist < this.stopDist * 0.7 && ctx.dist > 1e-4) {
        const k = (this.stopDist * 0.7 - ctx.dist);
        p.x -= ctx.nx * k; p.z -= ctx.nz * k;
        // never let that push shove a body into the boundary wall (the collider pass would eject it outside)
        const lim = ((window.World && World.arenaRadius) || 49) - 1, r = Math.hypot(p.x, p.z);
        if (r > lim) { p.x *= lim / r; p.z *= lim / r; }
      }
      const cols = window.World && World.colliders;
      if (cols) {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          const ox = p.x - c.x, oz = p.z - c.z;
          const d = Math.hypot(ox, oz);
          const min = c.r + R;
          if (d < min) {
            const k = d > 1e-5 ? (min - d) / d : 0;
            if (d > 1e-5) { p.x += ox * k; p.z += oz * k; } else { p.x += min; }
          }
        }
      }
      const list = window.Enemies ? Enemies.list : null;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (o === this || o.dead || !o.mesh) continue;
          const op = o.mesh.position;
          const ox = p.x - op.x, oz = p.z - op.z;
          const d = Math.hypot(ox, oz);
          const min = (BODY_R * S + BODY_R * (o.sizeScale || 1)) * 0.85;
          if (d < min && d > 1e-5) { const k = (min - d) / d * 0.5; p.x += ox * k; p.z += oz * k; }
        }
      }
      p.x = clamp(p.x, -ARENA, ARENA);
      p.z = clamp(p.z, -ARENA, ARENA);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // animation + procedural reactions (after the mixer)
    // -------------------------------------------------------------------------------------------------------------------
    _animate(dt, ctx) {
      // time-driven attack layer
      if (this.state === 'windup' || this.state === 'attack' || this.state === 'recover') {
        const a = this.actions[ATTACK_CLIP];
        if (a && this._cur.upper === a) a.time = this._attackClipT();
        // the recovery hands the upper body back to the idle pose
        if (this.state === 'recover' && this.stateT > this.recoverTime * 0.45 && !this.hold) this._play('upper', IDLE_CLIP, 0.3);
        // attack layer timing must not advance on its own
        if (a) a.setEffectiveTimeScale(0);
      }
      this._undoProcedural();
      this.mixer.update(dt);
      this._proceduralPose(dt);
      this._footsteps(ctx);
    }

    // The flinch is added on top of the mixer's pose every frame. The mixer only writes a bone when its clip value CHANGED, so a bone
    // whose clip is static at that moment (the head during the sword swing) would keep last frame's rotation and gain a new one every
    // frame: a knight shot mid-swing spun its head round by up to ~3 rad. So the added rotation is taken off again before the mixer runs.
    _undoProcedural() {
      if (this._ov && this._ov.length) {            // swing twist / shield pose: put the pre-override rotations back (last in, first out)
        for (let i = this._ov.length - 1; i >= 0; i--) this._ov[i].bone.quaternion.copy(this._ov[i].q);
        this._ov.length = 0;
      }
      if (!this._pOn) return;
      this._pOn = false;
      const torso = this.bones.torso, head = this.bones.head;
      if (torso) torso.quaternion.multiply(_q1.copy(this._pT).invert());
      if (head) head.quaternion.multiply(_q1.copy(this._pH).invert());
    }

    // ---- bone overrides on top of the mixer (swing twist, shield arm). Each one is remembered so _undoProcedural can take it off again.
    _ovSave(bone) { if (!this._ov) this._ov = []; this._ov.push({ bone: bone, q: bone.quaternion.clone() }); }

    // rotate `bone` about a WORLD axis by `ang` (needs fresh world matrices on its parent chain): q' = P^-1 R P q
    _ovRotate(bone, axis, ang) {
      this._ovSave(bone);
      bone.parent.getWorldQuaternion(_q1);
      _q2.setFromAxisAngle(axis, ang);
      bone.quaternion.premultiply(_q1).premultiply(_q2).premultiply(_q1.invert());
      bone.updateMatrixWorld(true);
    }

    // swing the bone so the segment bone -> child points along `dir` (world), blended by w
    _ovAim(bone, child, dir, w) {
      this._ovSave(bone);
      bone.getWorldPosition(_v1); child.getWorldPosition(_v2);
      _v2.sub(_v1).normalize();
      const d = new Q().setFromUnitVectors(_v2, dir);
      d.slerp(new Q(), 1 - w);
      const P = bone.parent.getWorldQuaternion(new Q());
      const W = bone.getWorldQuaternion(new Q());
      bone.quaternion.copy(P.invert().multiply(d.multiply(W)));
      bone.updateMatrixWorld(true);
    }

    // turn / lean the torso through the sword swing and bring the shield up for the charge
    _extraPose(dt) {
      const st = this.state;
      const bones = this.bones;
      let twist = 0, lean = 0, shieldTarget = 0;
      if (this.type === 'knight' && !this._throwing) {
        if (st === 'windup') { const u = clamp(this.stateT / this.windupTime, 0, 1); const k = smooth(Math.min(1, u / 0.6)); twist = -0.34 * k; lean = -0.06 * k; }
        else if (st === 'attack') { const u = clamp(this.stateT / this.strikeTime, 0, 1); const k = Math.pow(u, 1.8); twist = lerp(-0.34, 0.5, k); lean = lerp(-0.06, 0.2, k); }
        else if (st === 'recover') { const u = clamp(this.stateT / this.recoverTime, 0, 1); const k = smooth(Math.min(1, u * 1.25)); twist = lerp(0.5, 0, k); lean = lerp(0.2, 0, k); }
      }
      if (this.type === 'knight' && (st === 'rushWind' || st === 'rush')) shieldTarget = 1;
      this._shieldW += (shieldTarget - this._shieldW) * Math.min(1, dt * (shieldTarget ? 11 : 7));
      if (this._shieldW < 0.01) this._shieldW = 0;
      if (Math.abs(twist) < 0.002 && Math.abs(lean) < 0.002 && this._shieldW === 0) return;
      this.mesh.updateMatrixWorld(true);
      const yaw = this.mesh.rotation.y, sn = Math.sin(yaw), cs = Math.cos(yaw);
      if (bones.torso && (twist || lean)) {
        _v3.set(0, 1, 0);
        this._ovTorso(bones.torso, _v3, twist, _v4.set(cs, 0, -sn), lean);
      }
      const W = this._shieldW;
      const fore = bones.armL, upper = fore && fore.parent, hand = bones.handL;
      if (W > 0 && fore && upper && hand && this.shield) {
        const f = _v5.set(sn, 0, cs);
        _v1.copy(fore.getWorldPosition(_v1)).sub(this.mesh.position);
        const side = (_v1.x * cs - _v1.z * sn) >= 0 ? 1 : -1;
        const out = _v6.set(cs * side, 0, -sn * side);
        // upper arm forward and slightly out, forearm up and forward: the shield stands in front of the chest
        const dU = new V3().copy(f).multiplyScalar(0.62).addScaledVector(out, 0.22).addScaledVector(_up, -0.5).normalize();
        this._ovAim(upper, fore, dU, W);
        const dF = new V3().copy(f).multiplyScalar(0.3).addScaledVector(out, -0.1).addScaledVector(_up, 0.92).normalize();
        this._ovAim(fore, hand, dF, W);
        // roll the forearm about its axis until the shield face (+Z of the shield, the side facing out) looks along the charge
        this.shield.updateWorldMatrix(true, false);
        const nrm = new V3(0, 0, 1).transformDirection(this.shield.matrixWorld);
        const axis = new V3().copy(dF);
        const a = nrm.clone().addScaledVector(axis, -nrm.dot(axis)).normalize();
        const b = f.clone().addScaledVector(axis, -f.dot(axis)).normalize();
        let ang = Math.acos(clamp(a.dot(b), -1, 1)); if (new V3().crossVectors(a, b).dot(axis) < 0) ang = -ang;
        this._ovRotate(fore, axis, ang * W);
      }
    }

    // twist about the world up axis, then lean about the knight's lateral axis
    _ovTorso(bone, up, twist, lat, lean) {
      this._ovRotate(bone, up, twist);
      if (lean) this._ovRotate(bone, lat, lean);
    }

    _proceduralPose(dt) {
      this._flinchPose(dt);
      this._extraPose(dt);       // after the flinch, so _undoProcedural takes them off in the opposite order
    }

    _flinchPose(dt) {
      if (this._flinch <= 0.001) { this._flinch = 0; return; }
      this._flinch = Math.max(0, this._flinch - dt / 0.32);
      const k = Math.sin(clamp(this._flinch, 0, 1) * Math.PI * 0.5);   // 1 -> 0 ease
      const amt = k * this._flinchPow;
      const torso = this.bones.torso, head = this.bones.head;
      const d = this._flinchDir;
      if (torso) {
        // push along the bullet direction (knight-local x / z): about X tilts toward +Z, about Z toward -X
        _q1.setFromAxisAngle(AX, amt * d.z);
        _q2.setFromAxisAngle(AZ, -amt * d.x);
        this._pT.copy(_q1).multiply(_q2);
        torso.quaternion.multiply(this._pT);
      }
      if (head) {
        _q1.setFromAxisAngle(AX, amt * 0.7 * d.z);
        _q2.setFromAxisAngle(AZ, -amt * 0.7 * d.x);
        this._pH.copy(_q1).multiply(_q2);
        head.quaternion.multiply(this._pH);
      }
      this._pOn = true;
    }

    // a boot-on-ground sound (with an armour jingle) once per half stride, positional, audible up to ~32 m, lightly rate limited
    _footsteps(ctx) {
      if ((this.state !== 'approach' && this.state !== 'rush') || !window.Sfx || !Sfx.footstep || ctx.dist > 32) return;
      const a = this._cur.lower;
      if (!a) return;
      const clip = a.getClip();
      const ph = (a.time / clip.duration) * 2;
      const step = Math.floor(ph);
      if (step !== this._stepPhase) {
        this._stepPhase = step;
        const E = window.Enemies;
        if (E && Math.abs(E._clock - E._lastStepAt) < 0.04) return;      // at most ~25 boot sounds a second over the whole crowd
        if (E) E._lastStepAt = E._clock;
        sfx('footstep', 'knight', soundAt(this, 0.1));
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // damage
    // -------------------------------------------------------------------------------------------------------------------
    applyImpulse(v) {
      if (!v) return;
      this.knockback.x += v.x; this.knockback.z += v.z;
      const l = Math.hypot(this.knockback.x, this.knockback.z);
      if (l > 7) { this.knockback.x *= 7 / l; this.knockback.z *= 7 / l; }
    }

    // hit = { damage, zone, point, dir }. Sets `dead` synchronously when the knight drops to 0 HP.
    takeHit(hit) {
      if (this.dead || this._removed) return false;
      hit = hit || {};
      let dmg = typeof hit.damage === 'number' && isFinite(hit.damage) ? hit.damage : 0;
      if (this.state === 'stumble') dmg *= STUMBLE_DAMAGE;                 // off balance after a missed charge
      this.hp -= dmg;
      if (this.hp <= 0) {
        this.hp = 0;
        this.dead = true;
        this.die(hit);
        return true;
      }
      this._reactToHit(hit);
      return false;
    }

    _reactToHit(hit) {
      const zone = hit.zone || 'torso';
      // procedural torso pitch, in the knight's own frame
      const d = hit.dir;
      if (d) {
        const sy = Math.sin(this._yaw), cy = Math.cos(this._yaw);
        // world -> local (yaw about Y): local x = dx*cy - dz*sy, local z = dx*sy + dz*cy
        _v1.set(d.x * cy - d.z * sy, 0, d.x * sy + d.z * cy);
        if (_v1.lengthSq() > 1e-6) _v1.normalize(); else _v1.set(0, 0, -1);
        this._flinchDir.copy(_v1);
      } else this._flinchDir.set(0, 0, -1);
      this._flinch = 1;
      this._flinchPow = zone === 'head' ? 0.55 : (zone === 'limb' ? 0.3 : 0.42);       // peak torso pitch (rad); the head adds 0.7x of it on top
      // a hit while winding up breaks the telegraph; the strike itself is not interrupted
      if (this.state === 'attack' || this.state === 'recover' || this.state === 'rush' || this.state === 'stumble') return;
      if (this.state !== 'stagger') this.setState('stagger');
      else this.stateT = 0;
    }

    die(hit) {
      this.dead = true;
      hit = hit || {};
      this._stripOff();
      if (this.state !== 'dead') {
        this.state = 'dead';
        this.stateT = 0;
        this._playStateAnim('dead', 0.12);
      }
      this._deadT = 0;
      // fall the way the bullet was travelling: the Death clip topples toward the model's +Z
      const d = hit.dir;
      if (d && (Math.abs(d.x) + Math.abs(d.z)) > 1e-3) {
        // turn at most a quarter circle (a frontal kill topples sideways instead of pirouetting 180 deg to show its back)
        const turn = clamp(angDiff(this._yaw, Math.atan2(d.x, d.z)), -Math.PI / 2, Math.PI / 2);
        this._targetYaw = this._yaw + turn;
      }
      this._flinch = 0;
      if (!this._killFx && window.Combat && Combat.onKill) {
        try { Combat.onKill(this, hit, hit.dir); } catch (e) { console.error('[Knight] Combat.onKill', e); }
      }
      if (window.Waves && Waves.onEnemyKilled) {
        try { Waves.onEnemyKilled(this); } catch (e) { console.error('[Knight] Waves.onEnemyKilled', e); }
      }
      this.onDeath(hit);
    }

    onDeath(hit) { /* hook for subclasses */ }

    _updateDead(dt) {
      this._deadT += dt;
      // turn to the fall direction during the first part of the Death clip
      if (this._targetYaw !== null) {
        const err = angDiff(this._yaw, this._targetYaw);
        this._yaw += clamp(err, -DEATH_TURN * dt, DEATH_TURN * dt);
        this.mesh.rotation.y = this._yaw;
        if (Math.abs(err) < 0.01) this._targetYaw = null;
      }
      const p = this.mesh.position;
      if (this.knockback.x !== 0 || this.knockback.z !== 0) {
        p.x += this.knockback.x * dt; p.z += this.knockback.z * dt;
        this._decayKnockback(dt);
      }
      this._undoProcedural();
      this.mixer.update(dt);
      if (this._deadT > LINGER) {
        const u = clamp((this._deadT - LINGER) / SINK, 0, 1);
        p.y = -SINK_DEPTH * this.sizeScale * u * u * (3 - 2 * u);
        if (u >= 1) this._remove();
      }
    }

    _remove() {
      if (this._removed) return;
      if (window.Enemies && Enemies.remove) Enemies.remove(this);
      else this.dispose();
    }

    // free what this knight owns: its cloned materials and the mixer. Shared geometry and the shared gear materials stay.
    dispose() {
      if (this._removed) return;
      this._removed = true;
      if (this._strip) { this._stripOff(); try { this._strip.geometry.dispose(); this._strip.material.dispose(); } catch (e) { /* ignore */ } this._strip = null; }
      try { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); } catch (e) { /* ignore */ }
      for (let i = 0; i < this._skinned.length; i++) { try { this._skinned[i].skeleton.dispose(); } catch (e) { /* ignore */ } }
      this._owned.forEach((m) => { try { m.dispose(); } catch (e) { /* ignore */ } });
      this._owned.clear();
      if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    }
  }

  // reference data for subclasses / tuning (the Boss may override gear: new Knight({ gear: { shield: { asset: 'knight_boss_shield', scale: ... } } }))
  Knight.GEAR = GEAR;
  Knight.CLIP_SPEED = CLIP_SPEED;
  Knight.getClipSets = getClipSets;
  window.Knight = Knight;

  // ------------------------------------------------------------------------------------------------------------------------
  // Enemies manager
  // ------------------------------------------------------------------------------------------------------------------------
  window.Enemies = {
    list: [],
    daggers: [],          // thrown daggers: { mesh, spin, vel, state 'fly'|'lie', age, lie, thrower, whirr }
    _clock: 0,
    _lastStepAt: -1,

    add(e) {
      const scene = sceneOf();
      if (!scene) throw new Error('Enemies.add: no scene (Game.init has not run)');
      scene.add(e.mesh);                           // the renderer only draws what is parented to the scene
      this.list.push(e);
      // face the player and show the first animation frame right away (also for a frozen / paused AI)
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      if (pp) {
        e._yaw = Math.atan2(pp.x - e.mesh.position.x, pp.z - e.mesh.position.z);
        e.mesh.rotation.y = e._yaw;
      }
      try { e.mixer.update(0); } catch (err) { /* ignore */ }
      installDebug();
      return e;
    },

    update(dt, playerPos) {
      this._clock += dt;
      this._tickDaggers(dt);
      const wave = window.Waves && typeof Waves.current === 'number' ? Waves.current : 1;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const e = this.list[i];
        if (!e) continue;
        try {
          e.update(dt, playerPos, wave);
        } catch (err) {
          e._errs = (e._errs || 0) + 1;
          if (e._errs <= 3) console.error('[Enemies] update failed', err);
        }
      }
    },

    rayTargets() {
      const out = [];
      for (let i = 0; i < this.list.length; i++) {
        const e = this.list[i];
        if (!e.dead && e.mesh) out.push(e.mesh);
      }
      return out;
    },

    aliveCount() {
      let n = 0;
      for (let i = 0; i < this.list.length; i++) if (!this.list[i].dead) n++;
      return n;
    },

    findByObject(obj) {
      for (let o = obj; o; o = o.parent) {
        if (o.userData && o.userData.enemy) return o.userData.enemy;
      }
      return null;
    },

    // take an enemy out of the list and the scene and free its resources
    remove(e) {
      const i = this.list.indexOf(e);
      if (i >= 0) this.list.splice(i, 1);
      if (e.dispose) e.dispose();
      else if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
    },

    // ---- Daggers ------------------------------------------------------------------------------------------------------
    // Launch a dagger from `thrower`'s right hand at the player's chest as it is now: a slight arc (DAGGER_G) at DAGGER_SPEED, so
    // a player who keeps moving is missed. Returns the dagger record (or null when it cannot be made).
    throwDagger(thrower) {
      const scene = sceneOf();
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      if (!scene || !pp || !window.Assets) return null;
      // the dagger is a small clone of the knight's sword. Assets' `length` option sizes the longest HORIZONTAL extent, which for the
      // upright sword is the cross guard (a 2.8 m blade at length 0.5), so it is sized by height here: 0.5 m from pommel to tip.
      const sword = Assets.get('knight_sword', { height: DAGGER_SIZE });
      if (!sword) return null;
      const spin = new THREE.Group();            // rotated about X every frame: the blade (local Z) tumbles end over end
      const align = new THREE.Group();           // carries the sword so that its long axis is local Z and its centre is the origin
      const box = new THREE.Box3().setFromObject(sword);
      const size = box.getSize(new V3()), mid = box.getCenter(new V3());
      sword.position.sub(mid);
      if (size.y >= size.x && size.y >= size.z) align.rotation.x = Math.PI / 2;        // Y -> Z
      else if (size.x >= size.z) align.rotation.y = -Math.PI / 2;                      // X -> Z
      align.add(sword);
      spin.add(align);
      const mesh = new THREE.Group();
      mesh.name = 'dagger';
      mesh.add(spin);

      const hand = thrower.bones && thrower.bones.handR;
      if (hand) hand.getWorldPosition(mesh.position);
      else mesh.position.set(thrower.mesh.position.x, thrower.height * 0.75, thrower.mesh.position.z);
      const vel = new V3();
      const tx = pp.x, ty = Math.min(pp.y, 1.7) - 0.45, tz = pp.z;       // chest height of the player
      const dx = tx - mesh.position.x, dy = ty - mesh.position.y, dz = tz - mesh.position.z;
      const T = Math.max(0.12, Math.hypot(dx, dy, dz) / DAGGER_SPEED);
      vel.set(dx / T, dy / T + 0.5 * DAGGER_G * T, dz / T);
      mesh.quaternion.setFromUnitVectors(AZ, _v1.copy(vel).normalize());
      scene.add(mesh);

      const d = { mesh, spin, vel, state: 'fly', age: 0, lie: 0, thrower, whirr: null };
      this.daggers.push(d);
      if (window.Sfx) {
        try {
          if (Sfx.throwWhoosh) Sfx.throwWhoosh(mesh.position);
          if (Sfx.whirr) d.whirr = Sfx.whirr(mesh.position, 4);
        } catch (e) { /* audio never breaks the game */ }
      }
      return d;
    },

    _tickDaggers(dt) {
      const L = this.daggers;
      if (!L.length) return;
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      for (let i = L.length - 1; i >= 0; i--) {
        const d = L[i];
        if (d.state === 'lie') {
          d.lie -= dt;
          if (d.lie <= 0) { this._removeDagger(d); L.splice(i, 1); }
          continue;
        }
        d.age += dt;
        d.spin.rotation.x += DAGGER_SPIN * dt;
        // sub-steps of <= 0.25 m, so a long frame cannot jump over the player or a tree
        const n = clamp(Math.ceil(d.vel.length() * dt / 0.25), 1, 16), h = dt / n;
        const p = d.mesh.position;
        let end = null;
        for (let k = 0; k < n && !end; k++) {
          d.vel.y -= DAGGER_G * h;
          p.x += d.vel.x * h; p.y += d.vel.y * h; p.z += d.vel.z * h;
          if (pp && !(window.Game && Game.dead) && Math.hypot(p.x - pp.x, p.z - pp.z) < DAGGER_HIT_R && p.y > 0.2 && p.y < 1.95) end = 'hit';
          else if (p.y <= 0.04) end = 'ground';
          else {
            const cols = window.World && World.colliders;
            if (cols) {
              for (let c = 0; c < cols.length; c++) {
                const q = cols[c];
                if (p.y < 5 && Math.hypot(p.x - q.x, p.z - q.z) < q.r) { end = 'collider'; break; }
              }
            }
          }
        }
        if (!end && (d.age > 5 || Math.hypot(p.x, p.z) > 80)) end = 'gone';
        if (d.whirr && d.whirr.move) { try { d.whirr.move(p); } catch (e) { /* ignore */ } }
        if (end) this._landDagger(d, end, pp, i);
      }
    },

    // the dagger ended its flight: 'hit' (the player), 'ground', 'collider' (tree / rock) or 'gone' (out of bounds / too old)
    _landDagger(d, how, pp, index) {
      const p = d.mesh.position;
      if (d.whirr && d.whirr.stop) { try { d.whirr.stop(); } catch (e) { /* ignore */ } }
      d.whirr = null;
      const dir = _v1.copy(d.vel).normalize();
      const near = pp ? Math.hypot(p.x - pp.x, p.z - pp.z) < 3 : false;
      if (how === 'gone') { this._removeDagger(d); this.daggers.splice(index, 1); return; }
      if (how === 'hit') {
        if (window.FX && FX.sparks) { try { FX.sparks(p, _q1v(dir).negate(), 8); } catch (e) { /* ignore */ } }
        sfx('dagger', 'hit', p);
        if (window.Player && Player.hurt) Player.hurt(Math.max(1, Math.round(DAGGER_DAMAGE * diff().dmg)), d.thrower);
        this._removeDagger(d); this.daggers.splice(index, 1);
        return;
      }
      if (how === 'collider') {
        // drop at the foot of the obstacle
        if (window.FX && FX.sparks) { try { FX.sparks(p, _q1v(dir).negate(), 8); } catch (e) { /* ignore */ } }
        sfx('dagger', 'clang', p);
      } else {
        if (window.FX && FX.dust) { try { FX.dust(_sp.set(p.x, 0.02, p.z), new V3(0, 1, 0), 0.35); } catch (e) { /* ignore */ } }
        sfx('dagger', near ? 'clang' : 'ground', p);
      }
      d.state = 'lie';
      d.lie = DAGGER_LIE;
      d.vel.set(0, 0, 0);
      p.y = 0.04;
      d.mesh.quaternion.setFromAxisAngle(new V3(0, 1, 0), Math.random() * TAU);   // blade (local Z) flat on the ground
      d.spin.rotation.set(0, 0, 0);
    },

    // take a dagger's meshes out of the scene (geometry and materials are shared with the sword asset: nothing to dispose)
    _removeDagger(d) {
      if (d.whirr && d.whirr.stop) { try { d.whirr.stop(); } catch (e) { /* ignore */ } }
      d.whirr = null;
      if (d.mesh && d.mesh.parent) d.mesh.parent.remove(d.mesh);
    },

    clear() {
      for (let i = 0; i < this.daggers.length; i++) this._removeDagger(this.daggers[i]);
      this.daggers.length = 0;
      const all = this.list.slice();
      this.list.length = 0;
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e.dispose) e.dispose();
        else if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
      }
    },

  };

  // ------------------------------------------------------------------------------------------------------------------------
  // QA helpers (only with ?debug=1; installed when the first enemy is added, debug.js has run by then)
  // ------------------------------------------------------------------------------------------------------------------------
  let dbgDone = false;
  function installDebug() {
    if (dbgDone || !window.__dbg) return;
    dbgDone = true;
    const round = (v) => Math.round(v * 1000) / 1000;
    const get = (i) => Enemies.list[i];
    // the knight i (default: the nearest living one) throws a dagger right now. flightSec > 0 advances the dagger that long at once,
    // which is how a dagger is put mid-flight while the AI is frozen (a frozen AI does not tick the daggers).
    window.__dbg.knightThrow = function (i, flightSec) {
      let k = typeof i === 'number' ? get(i) : null;
      if (!k) {
        const pp = Game.playerObj.position;
        let best = 1e9;
        for (const e of Enemies.list) {
          if (e.dead || e.type !== 'knight') continue;
          const dd = Math.hypot(e.mesh.position.x - pp.x, e.mesh.position.z - pp.z);
          if (dd < best) { best = dd; k = e; }
        }
      }
      if (!k) return null;
      const d = k.throwDagger();
      if (d && flightSec > 0) Enemies._tickDaggers(flightSec);
      return d ? { pos: d.mesh.position.toArray().map(round), vel: d.vel.toArray().map(round), state: d.state } : null;
    };
    // the knight i (default: the nearest living one) starts its shield rush at once (no cooldown / range / path checks)
    window.__dbg.knightRush = function (i) {
      let k = typeof i === 'number' ? get(i) : null;
      if (!k) {
        const pp = Game.playerObj.position;
        let best = 1e9;
        for (const e of Enemies.list) {
          if (e.dead || e.type !== 'knight') continue;
          const dd = Math.hypot(e.mesh.position.x - pp.x, e.mesh.position.z - pp.z);
          if (dd < best) { best = dd; k = e; }
        }
      }
      if (!k) return null;
      k.hold = false;
      k.startRush();
      return { state: k.state, dir: k._rushDir.toArray().map(round) };
    };
    window.__dbg.daggers = function () {
      return Enemies.daggers.map((d) => ({ state: d.state, pos: d.mesh.position.toArray().map(round), age: round(d.age), lie: round(d.lie) }));
    };
    window.__dbg.knight = {
      // freeze the AI of knight i in `state` at `progress` (0..1 of that state's duration); animation keeps running.
      // yaw (optional, radians): turn the knight (0 = facing +Z, PI/2 = its right side toward +Z)
      pose(i, state, progress, yaw) {
        const k = get(i);
        if (!k) return null;
        k.hold = true;
        if (typeof yaw === 'number') { k._yaw = yaw; k.mesh.rotation.y = yaw; }
        k.setState(state);
        const dur = { windup: k.windupTime, attack: k.strikeTime, recover: k.recoverTime, stagger: 0.3 }[state] || 1;
        k.stateT = (progress || 0) * dur;
        return { state: k.state, stateT: round(k.stateT) };
      },
      release(i) { const k = get(i); if (k) k.hold = false; return !!k; },
      // distance of every gear piece from the bone it should ride on (constant while attached) + world positions
      gear(i) {
        const k = get(i);
        if (!k) return null;
        k.mesh.updateMatrixWorld(true);
        const out = {};
        for (const [kind, bone] of [['helmet', 'Head'], ['sword', 'Palm.R'], ['shield', 'LowerArm.L']]) {
          const g = k[kind];
          if (!g) { out[kind] = null; continue; }
          const b = Assets.bone(k.model, bone);
          const gp = g.getWorldPosition(new V3()), bp = b.getWorldPosition(new V3());
          out[kind] = { parent: g.parent && (g.parent.userData.name || g.parent.name), dist: round(gp.distanceTo(bp)), pos: gp.toArray().map(round), loose: !!g.userData.loose };
        }
        return out;
      },
      info(i) {
        const k = get(i);
        if (!k) return null;
        return { state: k.state, clip: k.currentClip, hp: k.hp, dead: k.dead, speed: round(k._speed || 0), yaw: round(k._yaw), stateT: round(k.stateT),
          pos: k.mesh.position.toArray().map(round), cool: round(k._cool), flinch: round(k._flinch) };
      },
    };
  }
})();
