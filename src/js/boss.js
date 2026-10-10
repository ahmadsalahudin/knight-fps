/* boss.js - window.Boss extends Knight  (Worker D1, docs/FIX_PLAN.md "Boss", diagnosis 1.5)

   The Iron Warlord: a golden, horn-helmed armoured giant, 2.8x the height of a knight (5 m), 1500 HP, with a tower shield and a
   scaled-up greatsword. It is a Knight (same skinned model, bone-mounted gear, mixer, state machine, steering, death lifecycle) and only
   overrides the hooks that enemies.js exposes (updateAI, speedFor, startWindup, onDamageFrame, onEnter, takeHit, onDeath, ...).

   new Boss()   no arguments (waves.js and __dbg.spawn('boss') call it that way). opts (optional) are merged over the defaults.
                A boss that Waves spawns also gets boss.startEntrance() (the cinematic, below); a debug boss just stands up and roars.
   Fields: everything Knight has + phase (1..3), atk ('sweep'|'leap'|'charge'|'split'|'whirl'|'roar'|null), displayName 'The Iron Warlord',
           type 'boss', hp / maxHp (1500), knockbackScale 0.1, minions[] (summoned Knights), cinematic (true until it has landed).
   Telegraphs (every attack has one, >= 0.5 s):
        sweep   Run_swordAttack, the sword rises and holds (windup 1.0 s -> 0.62 s over the phases); a red fan on the ground (the
                exact hit area, 6.4 m reach, 140 degrees) fills up; damage once, on the swing frame, if the player is inside it.
        leap    swordAttackJump: a crouch, a red ring on the ground at the landing spot (the exact AoE, 5.0 - 5.8 m) fills up,
                the boss leaps (the landing spot is locked half way through the crouch) and lands on it: damage on the landing
                frame, shockwave ring + dust ring + camera shake (FX.shake).
        charge  (phase 2+) the sword rises and holds while a red strip is drawn on the ground along the locked run line, then
                a straight Run at 11-13 m/s; damage once if it reaches the player; it stumbles (vulnerable) afterwards.
        split   EARTHSPLITTER (all phases, 7-30 m away): the sword rises and a red strip (2.8 m wide) follows the player and locks 45 % into the
                windup; the sword smashes down and a glowing crack races along the strip at 26 m/s while stone spikes erupt every 1.9 m along it
                (a spike hurts once, within 1.1 m of its centre, and shoves). Sidestep the strip: nothing else is hit.
        whirl   WHIRLWIND (phase 2+, under 13 m): a red ring (the exact reach, 5.6 m) fills up while the sword is held out, then it spins with the
                sword out and chases for 2.5 s at 5 m/s (slower than the player; its heading steers at only 2.3 rad/s, so strafing out of the ring
                works), hurting inside the ring every 0.55 s and shoving the player out; then it is DIZZY for 1.7 - 2 s (stars circle its head, it
                sways, takes 1.5x damage, cannot guard): the punish window.
   Phases: 66 % and 33 % of maxHp. A phase change is a roar (sword up, shake, shockwave, glow), it is faster (walk / run speed,
        windups, recovery, cooldowns), unlocks the charge and the whirlwind (phase 2) and a double sweep (phase 3) and summons 2 minions
        (Knights) on the arena ring, away from the player and the boss (never on top of the boss). Minions are not tracked by Waves.
   The boss never staggers from bullets (a tiny flinch only). HUD.bossBar is refreshed every frame and hidden on death.
   Death: the slow Death clip (x0.6), a spark / blood / smoke burst, a thud with shake and a dust ring when it hits the ground;
        Waves.onEnemyKilled is called once by Knight.die().

   HEAD GUARD: every frame the boss checks whether the camera ray passes near its head (within 1.9 head radii, 70 m). Once the player has
        aimed there for a reaction time it may raise the shield arm in front of its face (procedural pose on UpperArm.L / LowerArm.L, eased
        in and out) for 0.8 - 1.6 s; right after it takes an unguarded head shot it may do the same. How often and how fast is
        Difficulty.bossGuard (0.35 / 0.6 / 0.9): that is the chance to react (per second of aiming), and the reaction time and the cooldown
        shrink as it grows; phase 3 is stronger still. A head shot that lands while the shield is up hits the shield (it sits in front of the
        face, so a bullet meant for the head lands on it, whatever zone combat.js gives it: a bullet on the shield within 3 head radii of
        the head centre counts): x0.15 of a head shot's damage (22), clang + sparks, and the shot counts as a torso hit (no head bonus, no helmet
        pop, no head hitmarker: Combat.onHit / onKill are wrapped once, see patchCombat). It cannot guard while it leaps, charges, spins,
        is dizzy or roaring.

   ENTRANCE (boss.startEntrance(), called by waves.js; ~3.5 s, the player keeps control): letterbox bars slide in (DOM overlay), the sky
        and the light darken to a storm (Storm: scene lights, background, fog), a lightning bolt (bright mesh + flash + thunder) strikes the spawn
        point, glowing cracks run out of it with embers, the ground heaves, then the boss bursts up out of the ground (debris, dust, sparks),
        jumps and lands with a shockwave that shoves the player without damage (Game.shove, when the ring reaches him), a heavy camera shake
        and the title card THE IRON WARLORD (DOM overlay), then the roar; the bars slide out and the sky calms to a light overcast. The boss
        cannot be hurt until it has landed. Everything is dt-driven (no timers) and cleaned up by dispose() / death.

   QA (?debug=1, installed when the page has loaded): __dbg.boss.info(), .force('sweep'|'leap'|'charge'|'split'|'whirl'|'roar'), .phase(n),
        .hold(on), .clip(name, t) (freeze a clip pose), .gear(), .tele(), .guard(on?, sec?) (raise / lower the shield arm), .headPos(),
        .guardPose({u, f}) (tune the guard arm live), .entrance() (arm the cinematic on the boss, or build one 19 m ahead), .storm(level)
        (sky mood 0..1). Scenarios: boss-entrance, boss-guard, boss-split, boss-whirl (tools/qa/scenarios.mjs).
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

  const DMG = { sweep: 22, slam: 30, charge: 28, split: 24, whirl: 14 };    // player HP 100; x1.0 / 1.1 / 1.2 by phase (whirl: per hit, every 0.55 s)
  const SWEEP_R = 6.4, SWEEP_COS = Math.cos(70 * Math.PI / 180);   // reach (m) and half angle of the sweep, from the boss centre
  const LEAP_MIN = 9, LEAP_MAX = 26;
  const CHARGE_MIN = 11, CHARGE_MAX = 32, CHARGE_HIT_R = 2.5;     // hit radius around the boss while it charges; also half the strip width
  const WIDTH = 1.22;                     // x / z stretch on top of the uniform size
  const BODY_R = 0.42 * SIZE;
  const ARENA_LIMIT = 57;
  // Earthsplitter: a crack line (strip) races along the ground and stone spikes erupt along it
  const SPLIT_MIN = 7, SPLIT_MAX = 30, SPLIT_W = 2.8, SPLIT_LOCK = 0.45;   // distance window (m), strip width (m), share of the windup after which the line locks
  const SPLIT_SPEED = 26, SPIKE_GAP = 1.9, SPIKE_R = 1.1, SPIKES = 24;      // crack front speed (m/s), spike spacing (m), hit radius (m), pool size
  // Whirlwind
  const WHIRL_MAX = 13, WHIRL_R = 5.6, WHIRL_TICK = 0.55, WHIRL_STEER = 2.3, WHIRL_SPIN = 11;   // start window (m), reach (m), s between hits, heading turn rate and spin (rad/s)
  const DIZZY_DMG = 1.5;                  // damage taken while dizzy
  const SWOOSH_ARC = 4.4;                 // rad of the translucent arc that trails the spinning sword
  const WHIRL_POSE = 0.30;                // clip time (s) of Run_swordAttack that is held while it spins: the sword out to the side
  // head guard
  const GUARD_NEAR = 1.9, GUARD_MAX_D = 70;   // the camera ray counts as "at the head" within this many head radii; no reaction beyond this distance (m)
  const HEAD_UP = 0.24, HEAD_R = 0.25;        // head sphere (combat.js), in 1.8 m knight units, x the boss size
  const GUARD_BLOCK = 0.15;                   // damage factor of a head shot that hits the raised shield
  const GUARD_HIT = 3.0, GUARD_SHIELD_R = 1.5; // a bullet on the shield (within 1.5 m of its centre) and within 3 head radii of the head centre was meant for the head
  // the shield arm of the guard, as directions (forward, towards its left, up) of the upper arm (shoulder -> elbow) and the forearm (elbow -> hand)
  const GUARD_POSE = { u: [0.62, -0.25, 0.1], f: [0.25, -0.05, 0.97] };
  const DEATH_IMPACT = 1.6;               // seconds after the lethal hit (Death clip x0.6) when the body hits the ground

  // per phase (index = phase)
  const PH = [null,
    { walk: 2.3, run: 7.0, windup: 1.00, strike: 0.46, recover: 0.95, gap: 0.55, leapCd: 8.0, leapWind: 1.00, air: 0.85, leapEnd: 1.25, slam: 5.0, charge: false,
      split: true, splitCd: 11.0, splitWind: 1.05, splitStrike: 0.42, splitRecover: 0.85, whirl: false },
    { walk: 3.0, run: 8.2, windup: 0.80, strike: 0.40, recover: 0.75, gap: 0.40, leapCd: 6.5, leapWind: 0.85, air: 0.75, leapEnd: 1.05, slam: 5.4, charge: true,
      chargeCd: 9.0, chargeWind: 1.00, chargeSpeed: 11.5, chargeEnd: 1.40,
      split: true, splitCd: 8.5, splitWind: 0.90, splitStrike: 0.40, splitRecover: 0.70,
      whirl: true, whirlCd: 15.0, whirlWind: 0.85, whirlT: 2.5, whirlSpeed: 5.0, dizzy: 2.0 },
    { walk: 3.7, run: 9.4, windup: 0.62, strike: 0.36, recover: 0.55, gap: 0.30, leapCd: 5.0, leapWind: 0.70, air: 0.65, leapEnd: 0.90, slam: 5.8, charge: true,
      chargeCd: 7.0, chargeWind: 0.80, chargeSpeed: 13.0, chargeEnd: 1.15, combo: true,
      split: true, splitCd: 7.0, splitWind: 0.75, splitStrike: 0.36, splitRecover: 0.55,
      whirl: true, whirlCd: 11.0, whirlWind: 0.70, whirlT: 2.6, whirlSpeed: 5.5, dizzy: 1.7 },
  ];

  // The entrance cinematic: seconds since the boss was armed (waves.js calls startEntrance() when it spawns it).
  const ENT = {
    bars: 0.45,                           // the letterbox bars slide in
    strike: 0.55,                         // the lightning hits the spawn point
    crack: 0.62,                          // the cracks start to run
    burst: 1.1,                           // the boss bursts out of the ground
    buryY: -5.6, peak: 3.2, g: 46,        // start height under the ground, top of the jump (m), gravity of the jump
    end: 3.5, out: 0.5,                   // the bars leave from `end` on, taking `out` seconds; the boss acts from end + 0.1
    storm: 0.78, calm: 0.12,              // sky mood during the cinematic and the (light overcast) afterwards
  };
  ENT.rise = Math.sqrt(2 * (ENT.peak - ENT.buryY) / ENT.g);                 // burst -> top of the jump
  ENT.v = ENT.g * ENT.rise;                                                // take-off speed (m/s)
  ENT.land = ENT.burst + ENT.rise + Math.sqrt(2 * ENT.peak / ENT.g);       // ... -> back on the ground (~2.1 s)
  const BOLT_TRUNK = 27, BOLT_BRANCH = 7, BOLT_PTS = BOLT_TRUNK + 2 * BOLT_BRANCH, BOLT_SEGS = BOLT_TRUNK - 1 + 2 * (BOLT_BRANCH - 1);
  const N_CRACKS = 9, N_DEBRIS = 16;

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
  // Difficulty (waves.js): boss HP, damage to the player and attack reach. Read when used, so a missing module means Normal.
  const diff = () => (window.Difficulty && Difficulty.get()) || { dmg: 1, boss: 1, reach: 1 };
  const bossHp = () => Math.round(HP * diff().boss);
  const dmgOf = (base) => Math.max(1, Math.round(base * diff().dmg));

  const _gc = new V3(), _gd = new V3(), _gh = new V3(), _gf = new V3(), _go = new V3(), _gU = new V3(), _gF = new V3(), _gN = new V3(), _gA = new V3(), _gB = new V3(), _gC = new V3(), _up = new V3(0, 1, 0);   // head guard scratch
  const sfx = (name, a, b) => { try { if (window.Sfx && Sfx[name]) Sfx[name](a, b); } catch (e) { /* ignore */ } };
  const _sv = new V3(), _sn = new V3(0, 1, 0), _sn2 = new V3(0.8, 0.4, 0);          // scratch for FX calls

  // ------------------------------------------------------------------------------------------------------------------------
  // Storm: the sky / light mood of the entrance. Module level, because the lights belong to the scene, not to a boss. It only touches
  // the scene while the mood is not zero (or a lightning flash is fading) and puts the exact original values back afterwards.
  // ------------------------------------------------------------------------------------------------------------------------
  const Storm = {
    level: 0, target: 0, flash: 0, on: false,
    scene: null, lights: [], bg: null, fogC: null, fogD: 0,
    sky: new THREE.Color(0x1b2231), murk: new THREE.Color(0x2b332f), cool: new THREE.Color(0x9db0da), white: new THREE.Color(0xe8f0ff),
    grab() {
      const scene = sceneOf();
      if (!scene) return false;
      if (this.scene === scene) return true;
      this.scene = scene; this.lights.length = 0;
      scene.traverse((o) => { if (o.isLight) this.lights.push({ l: o, i: o.intensity, c: o.color.clone(), dir: !!o.isDirectionalLight }); });
      this.bg = scene.background && scene.background.isColor ? scene.background.clone() : null;
      this.fogC = scene.fog && scene.fog.color ? scene.fog.color.clone() : null;
      this.fogD = scene.fog && typeof scene.fog.density === 'number' ? scene.fog.density : 0;
      return true;
    },
    apply() {
      const L = this.level, F = Math.min(1, this.flash), scene = this.scene;
      for (let i = 0; i < this.lights.length; i++) {
        const e = this.lights[i];
        e.l.intensity = e.i * (1 - (e.dir ? 0.76 : 0.58) * L) + F * (e.dir ? 1.7 : 1.3);     // a lightning flash lifts the light, without a white-out
        e.l.color.copy(e.c).lerp(this.cool, 0.45 * L).lerp(this.white, 0.6 * F);
      }
      if (this.bg) scene.background.copy(this.bg).lerp(this.sky, L).lerp(this.white, 0.45 * F);
      if (this.fogC) { scene.fog.color.copy(this.fogC).lerp(this.murk, L).lerp(this.white, 0.45 * F); if (this.fogD) scene.fog.density = this.fogD * (1 + 0.55 * L); }
    },
    restore() {
      const scene = this.scene;
      if (scene) {
        for (let i = 0; i < this.lights.length; i++) { const e = this.lights[i]; e.l.intensity = e.i; e.l.color.copy(e.c); }
        if (this.bg) scene.background.copy(this.bg);
        if (this.fogC) { scene.fog.color.copy(this.fogC); if (this.fogD) scene.fog.density = this.fogD; }
      }
      this.on = false; this.scene = null; this.lights.length = 0;
    },
    tick(dt) {
      const up = this.target > this.level;
      this.level += (this.target - this.level) * (1 - Math.exp(-(up ? 2.4 : 0.7) * dt));
      if (Math.abs(this.level - this.target) < 0.004) this.level = this.target;
      this.flash = this.flash > 0 ? Math.max(0, this.flash - dt * 2.8) : 0;
      if (this.level === 0 && this.flash === 0) { if (this.on) this.restore(); return; }
      if (!this.grab()) return;
      this.on = true;
      this.apply();
    },
    reset() { this.target = 0; this.level = 0; this.flash = 0; if (this.on) this.restore(); },
  };

  // ------------------------------------------------------------------------------------------------------------------------
  // Cine: the letterbox bars, the title card and the screen flash of the entrance (DOM, driven by the cinematic's own clock).
  // ------------------------------------------------------------------------------------------------------------------------
  const Cine = {
    bars: null, top: null, bot: null, card: null, main: null, sub: null, rule: null, flashEl: null,
    v: { bars: -1, card: -1, slam: -1, flash: -1 },
    build() {
      if (this.bars) return true;
      try {
        const div = (css, parent) => { const d = document.createElement('div'); d.style.cssText = css; parent.appendChild(d); return d; };
        this.bars = div('position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:9;display:none', document.body);
        this.bars.id = 'bossBars';
        this.top = div('position:absolute;left:0;right:0;top:0;height:12.5%;background:#000;transform:translateY(-100%)', this.bars);
        this.bot = div('position:absolute;left:0;right:0;bottom:0;height:12.5%;background:#000;transform:translateY(100%)', this.bars);
        this.card = div('position:fixed;left:0;right:0;top:53%;text-align:center;pointer-events:none;z-index:11;opacity:0;visibility:hidden;'
          + 'text-shadow:0 0 34px rgba(255,70,20,.75),0 4px 16px #000', document.body);
        this.card.id = 'bossTitle';
        this.main = div('font:700 clamp(24px,5.6vw,88px) Georgia,"Palatino Linotype","Book Antiqua",serif;text-transform:uppercase;color:#ff7a45;white-space:nowrap;'
          + 'letter-spacing:.12em;margin-right:-.12em', this.card);
        this.main.textContent = NAME;
        this.rule = div('height:3px;width:0;margin:10px auto 0;background:linear-gradient(90deg,rgba(241,210,138,0),#f1d28a,rgba(241,210,138,0))', this.card);
        this.sub = div('margin-top:10px;font-size:clamp(13px,2vw,24px);letter-spacing:.42em;text-transform:uppercase;color:#f1d28a', this.card);
        this.sub.textContent = 'The final wave';
        this.flashEl = div('position:fixed;inset:0;background:#e6efff;pointer-events:none;z-index:41;opacity:0;visibility:hidden', document.body);
        this.flashEl.id = 'bossCineFlash';
      } catch (e) { this.bars = null; return false; }
      return true;
    },
    setBars(k) {
      if (!this.build() || Math.abs(k - this.v.bars) < 0.002) return;
      this.v.bars = k;
      this.bars.style.display = k > 0 ? 'block' : 'none';
      this.top.style.transform = 'translateY(' + (-(1 - k) * 100) + '%)';
      this.bot.style.transform = 'translateY(' + ((1 - k) * 100) + '%)';
    },
    // a = opacity 0..1, slam = 0..1: the letters pull together and the card settles from 1.45x
    setCard(a, slam) {
      if (!this.build()) return;
      if (Math.abs(a - this.v.card) > 0.004 || Math.abs(slam - this.v.slam) > 0.004) {
        this.v.card = a; this.v.slam = slam;
        const st = this.card.style;
        st.opacity = String(a); st.visibility = a > 0 ? 'visible' : 'hidden';
        const k = slam * slam * (3 - 2 * slam);
        this.main.style.letterSpacing = (0.12 + 0.18 * (1 - k)) + 'em';
        this.main.style.marginRight = (-(0.12 + 0.18 * (1 - k))) + 'em';
        this.main.style.transform = 'scale(' + (1 + 0.2 * (1 - k)) + ')';
        this.rule.style.width = (62 * k) + '%';
      }
    },
    // a full-screen tint, capped low (photosensitivity: the bolt and the scene light carry the strike, the overlay only hints at it)
    setFlash(a) {
      a = Math.min(0.24, a * 0.4);
      if (!this.build() || Math.abs(a - this.v.flash) < 0.004) return;
      this.v.flash = a;
      this.flashEl.style.opacity = String(a); this.flashEl.style.visibility = a > 0 ? 'visible' : 'hidden';
    },
    hide() { if (!this.bars) return; this.v.bars = this.v.card = this.v.flash = -1; this.setBars(0); this.setCard(0, 0); this.setFlash(0); },
  };

  // procedural textures (drawn once, shared by every boss): a glowing crack down the middle, and a soft ember glow
  let crackTex = null, glowTex = null;
  function getCrackTex() {
    if (crackTex) return crackTex;
    const W = 128, H = 512, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    // a jagged line from the top (near the boss; the strip's v = 1) to the bottom (far end), thinner towards the end
    const pts = [];
    let x = W / 2;
    for (let y = 0; y <= H; y += 22) { x = clamp(x + (Math.random() - 0.5) * 26, W * 0.3, W * 0.7); pts.push([x, y]); }
    const stroke = (lw, style, blur) => {
      g.lineJoin = 'round'; g.lineCap = 'round'; g.shadowBlur = blur || 0; g.shadowColor = 'rgba(255,90,10,.9)';
      for (let i = 0; i + 1 < pts.length; i++) {
        const k = 1 - 0.55 * (i / pts.length);
        g.lineWidth = lw * k; g.strokeStyle = style;
        g.beginPath(); g.moveTo(pts[i][0], pts[i][1]); g.lineTo(pts[i + 1][0], pts[i + 1][1]); g.stroke();
      }
    };
    // a few side cracks
    const branches = [];
    for (let i = 3; i < pts.length - 3; i += 3) {
      const side = Math.random() < 0.5 ? -1 : 1, b = [[pts[i][0], pts[i][1]]];
      let bx = pts[i][0], by = pts[i][1];
      for (let j = 0; j < 3; j++) { bx += side * (8 + Math.random() * 10); by += 10 + Math.random() * 10; b.push([bx, by]); }
      branches.push(b);
    }
    const strokeBranches = (lw, style, blur) => {
      g.lineJoin = 'round'; g.lineCap = 'round'; g.shadowBlur = blur || 0; g.shadowColor = 'rgba(255,90,10,.9)'; g.lineWidth = lw; g.strokeStyle = style;
      for (const b of branches) { g.beginPath(); g.moveTo(b[0][0], b[0][1]); for (let j = 1; j < b.length; j++) g.lineTo(b[j][0], b[j][1]); g.stroke(); }
    };
    stroke(30, 'rgba(8,5,3,.88)', 0); strokeBranches(12, 'rgba(8,5,3,.88)', 0);
    stroke(12, 'rgba(255,96,16,.95)', 14); strokeBranches(5, 'rgba(255,96,16,.95)', 8);
    stroke(4.5, 'rgba(255,226,150,1)', 0); strokeBranches(2, 'rgba(255,226,150,1)', 0);
    crackTex = new THREE.CanvasTexture(cv);
    crackTex.encoding = THREE.sRGBEncoding;
    return crackTex;
  }
  let pillarTex = null;
  function getPillarTex() {                // a column of heat: opaque at the bottom, fading to nothing at the top
    if (pillarTex) return pillarTex;
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 128;
    const g = cv.getContext('2d'), gr = g.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgba(255,214,140,0.95)'); gr.addColorStop(0.18, 'rgba(255,130,40,0.7)'); gr.addColorStop(0.6, 'rgba(220,60,15,0.25)'); gr.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 8, 128);
    pillarTex = new THREE.CanvasTexture(cv);
    pillarTex.encoding = THREE.sRGBEncoding;
    return pillarTex;
  }
  function getGlowTex() {
    if (glowTex) return glowTex;
    const S = 128, cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,214,140,1)'); gr.addColorStop(0.25, 'rgba(255,120,30,.8)'); gr.addColorStop(0.6, 'rgba(200,50,10,.35)'); gr.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    glowTex = new THREE.CanvasTexture(cv);
    glowTex.encoding = THREE.sRGBEncoding;
    return glowTex;
  }

  // free what a boss added to the scene (meshes, geometries, materials; the shared textures stay)
  function disposeRes(res) {
    for (const o of res.objs) { if (o.parent) o.parent.remove(o); }
    for (const g of res.geos) { try { g.dispose(); } catch (e) { /* ignore */ } }
    for (const m of res.mats) { try { m.dispose(); } catch (e) { /* ignore */ } }
    res.objs.length = 0; res.geos.length = 0; res.mats.length = 0;
  }

  // A head shot that lands on the raised shield must not count as a head shot anywhere: Game computes the zone from the ray (head) before it
  // calls takeHit, and Combat.onHit / onKill look at the zone cached on the ray hit. Boss.takeHit flags such a shot (_blockedHit) and these
  // wrappers (installed once) turn the cached zone into 'torso' for exactly that call: armour sound and sparks, 'hit' hitmarker, no helmet pop.
  let combatPatched = false;
  function patchCombat() {
    if (combatPatched || !window.Combat) return;
    combatPatched = true;
    for (const fn of ['onHit', 'onKill']) {
      const orig = Combat[fn];
      if (typeof orig !== 'function') continue;
      Combat[fn] = function (enemy, hit) {
        if (enemy && enemy._blockedHit && hit) { try { hit.__cmbZone = 'torso'; hit.__cmbEnemy = enemy; } catch (e) { /* frozen */ } }
        return orig.apply(this, arguments);
      };
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Boss
  // ------------------------------------------------------------------------------------------------------------------------
  class Boss extends Knight {
    constructor(opts) {
      opts = opts || {};
      super(Object.assign({
        type: 'boss', displayName: NAME, scale: SIZE, hp: bossHp(), maxHp: bossHp(), damage: DMG.sweep, knockbackScale: 0.1, gear: GEAR,
      }, opts));
      // timings of the base attack (sweep); everything else is driven by the phase table
      this.attackStart = 2.2 * this.sizeScale * diff().reach;     // starts a sweep from here (the sweep reaches 6.4 m on Normal)
      this.stopDist = 1.55 * this.sizeScale;
      this.lungeSpeed = this._lunge0 = 1.2 * this.sizeScale;      // a small step into the swing (not in the Earthsplitter)
      this.turnRate = 3.2;
      this.turnRateAttack = 2.0;

      this.phase = 1;
      this.atk = null;
      this.minions = [];
      this._roarPending = 0;                  // phase changes waiting for a quiet moment
      this._gap = 1.0;
      this._leapCd = 3.5;
      this._chargeCd = 6;
      this._splitCd = 4.5;                    // Earthsplitter / Whirlwind cooldowns (s), randomised when they are used
      this._whirlCd = 7;
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
      // head guard
      this._g = { w: 0, on: false, t: 0, cd: 1.0, aim: 0, roll: -1, rollT: 0, pending: -1, aimed: false, blocks: 0, lastD: 99 };
      this._blockedHit = false;
      this._shieldMats = [];
      this._shieldFlash = 0;
      // earthsplitter
      this._sdir = new V3(0, 0, 1);
      this._sLen = 20;
      this._split = { active: false, t: 0, front: 0, nextD: 0, ox: 0, oz: 0, fade: 0, hit: false, spikes: null, crackOp: 0 };
      // whirlwind / dizzy
      this._wdir = new V3(0, 0, 1);
      this._spinRate = 0; this._whirlHitCd = 0; this._whirlSnd = 0; this._whirlDust = 0; this._wSpeed = 0;
      this._stars = null;
      // everything this boss adds to the scene besides its model (disposed with it)
      this._res = { geos: [], mats: [], objs: [] };
      this._ent = null;

      // a broader build than the knight's slim frame (the whole posed model is stretched across x / z)
      this.model.scale.x *= WIDTH; this.model.scale.z *= WIDTH;
      this._paint();
      this._addHorns();
      this._addPauldrons();
      this._buildExtraClips();
      installDebug();

      patchCombat();

      // the arrival: it stands, raises the sword and roars before it starts to walk. Waves calls startEntrance() on top of this
      // (the cinematic replaces the plain roar); a debug-spawned boss only does the roar.
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
      this.shield && this.shield.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.emissive && this._shieldMats.indexOf(m) < 0) this._shieldMats.push(m); }); });
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
      this._gap -= dt; this._leapCd -= dt; this._chargeCd -= dt; this._splitCd -= dt; this._whirlCd -= dt;
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
          else {
            if (this.atk === 'split' && this.stateT < SPLIT_LOCK * this.windupTime) this._aimSplit(ctx);       // the line follows the player, then locks
            if (this.stateT >= this.windupTime) this.startStrike();
          }
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
        case 'whirlWind':
          if (this.stateT >= P.whirlWind) this.setState('whirl');
          break;
        case 'whirl':
          this._tickWhirl(dt, ctx);
          break;
        case 'dizzy':
          if (this.stateT >= P.dizzy) this._afterAttack();
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
      if (P.split && this._splitCd <= 0 && d > SPLIT_MIN && d < SPLIT_MAX && fe < 0.45) { this.startSplit(ctx); return; }
      if (P.whirl && this._whirlCd <= 0 && d < WHIRL_MAX && fe < 0.9) { this.startWhirl(ctx); return; }
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
      this.lungeSpeed = this._lunge0;
      this.windupTime = second ? Math.max(0.5, P.windup * 0.8) : P.windup;
      this.strikeTime = P.strike;
      this.recoverTime = (this._combo > 0) ? 0.3 : P.recover;
      this.setState('windup');
    }

    startStrike() {
      this.setState('attack');
      if (window.Sfx && Sfx.swing) { try { Sfx.swing(true, this.mesh.position); } catch (e) { /* ignore */ } }
    }

    // damage frame of the sweep: the player inside the fan drawn on the ground
    onDamageFrame(ctx) {
      if (this.atk === 'split') { this._splitStart(); return; }
      const pp = playerPos();
      if (!pp || !window.Player || !Player.hurt) return;
      const p = this.mesh.position;
      const dx = pp.x - p.x, dz = pp.z - p.z;
      const dist = Math.hypot(dx, dz);
      this._shake(0.28);
      this._dustAt(p.x + Math.sin(this._yaw) * 2.6, p.z + Math.cos(this._yaw) * 2.6, 0.8);
      this._tele && (this._teleFlash = 1);
      if (dist > SWEEP_R * diff().reach) return;
      const fx = Math.sin(this._yaw), fz = Math.cos(this._yaw);
      const cos = dist > 1e-4 ? (fx * dx + fz * dz) / dist : 1;
      if (cos < SWEEP_COS) return;
      if (window.Sfx && Sfx.clang) { try { Sfx.clang(this.mesh.position); } catch (e) { /* ignore */ } }
      Player.hurt(dmgOf(DMG.sweep * (1 + 0.1 * (this.phase - 1))), this);
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
      this._slam(p.x, p.z, P.slam * diff().reach);
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
        try { if (Sfx.footstep) Sfx.footstep('boss', this.mesh.position); if (Sfx.clang) Sfx.clang(this.mesh.position); if (Sfx.armorHit) Sfx.armorHit(this.mesh.position); } catch (e) { /* ignore */ }
      }
      if (!pp || !window.Player || !Player.hurt) return;
      if (Math.hypot(pp.x - x, pp.z - z) <= R) Player.hurt(dmgOf(DMG.slam * (1 + 0.1 * (this.phase - 1))), this);
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
          if (window.Sfx && Sfx.clang) { try { Sfx.clang(this.mesh.position); } catch (e) { /* ignore */ } }
          Player.hurt(dmgOf(DMG.charge * (1 + 0.1 * (this.phase - 1))), this);
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
        if (window.Sfx && Sfx.clang) { try { Sfx.clang(this.mesh.position); } catch (e) { /* ignore */ } }
      }
      if (end) {
        this._endT = P.chargeEnd + (this._cCrash ? 0.8 : 0);
        this.setState('chargeEnd');
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // entrance cinematic (see the header): storm, lightning, cracks, the burst out of the ground, the landing, the title card
    // -------------------------------------------------------------------------------------------------------------------
    get cinematic() { return !!(this._ent && !this._ent.landed); }

    // arm the cinematic: the boss is buried and hidden; it starts on the first update (after _placeInView has put it in front of the player)
    startEntrance() {
      if (this._ent || this.dead) return;
      this._ent = {
        t: 0, built: false, landed: false, done: false, cleaned: false, y: ENT.buryY, sx: 0, sz: 0,
        stormed: false, calmed: false, struck: false, reStruck: false, burst: false, roared: false, shoving: false, titleT0: -1,
        boltT: -1, ringR: 0, flashK: 0, emberT: 0, hot: 0, crackK: 1,
        bp: null, core: null, halo: null, crackMat: null, cracks: null, disc: null, pillar: null, debris: null, res: { geos: [], mats: [], objs: [] },
      };
      this.atk = 'roar'; this._roarKind = 'entrance'; this._roarFx = 0;
      this.windupTime = ENT.end + 0.1;
      this.mesh.position.y = ENT.buryY;
      this.mesh.visible = false;
      this.setState('windup');
    }

    _entBuild() {
      const E = this._ent, scene = this.mesh.parent || sceneOf(), R = E.res;
      E.built = true;
      E.sx = this.mesh.position.x; E.sz = this.mesh.position.z;
      if (!scene) return;
      const mat = (o) => { const m = new THREE.MeshBasicMaterial(Object.assign({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }, o)); R.mats.push(m); return m; };
      const add = (geo, m, order) => {
        const o = new THREE.Mesh(geo, m);
        o.frustumCulled = false; o.visible = false; o.renderOrder = order; o.castShadow = false; o.receiveShadow = false;
        scene.add(o); R.objs.push(o);
        return o;
      };
      // lightning: two ribbons of crossed quads (a thin bright core and a wide soft halo) that share one point list
      E.bp = new Float32Array(BOLT_PTS * 3);
      const ribbon = () => {
        const g = new THREE.BufferGeometry(), idx = [];
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_SEGS * 8 * 3), 3));
        for (let i = 0; i < BOLT_SEGS * 2; i++) { const o = i * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3); }
        g.setIndex(idx);
        R.geos.push(g);
        return g;
      };
      E.core = add(ribbon(), mat({ color: 0xf4f8ff, blending: THREE.AdditiveBlending }), 12);
      E.halo = add(ribbon(), mat({ color: 0x6f9bff, blending: THREE.AdditiveBlending, opacity: 0.4 }), 11);
      // cracks that run out of the strike point
      const strip = new THREE.PlaneGeometry(1, 1); strip.rotateX(-Math.PI / 2); strip.translate(0, 0, 0.5);
      R.geos.push(strip);
      E.crackMat = mat({ map: getCrackTex(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      E.cracks = [];
      for (let i = 0; i < N_CRACKS; i++) {
        const m = add(strip, E.crackMat, 5 + i * 0.01);
        m.position.set(E.sx, 0.045, E.sz);
        m.userData.ang = (i / N_CRACKS) * TAU + (Math.random() - 0.5) * 0.45;
        m.userData.len = 5 + Math.random() * 7 + (i % 3 === 0 ? 3 : 0);
        m.userData.w = 1.7 + Math.random() * 0.9;
        m.userData.delay = Math.random() * 0.18;
        m.userData.flip = Math.random() < 0.5 ? -1 : 1;
        m.rotation.y = m.userData.ang;
        E.cracks.push(m);
      }
      // the glow of the heat under the ground
      const disc = new THREE.CircleGeometry(1, 40); disc.rotateX(-Math.PI / 2);
      R.geos.push(disc);
      E.disc = add(disc, mat({ map: getGlowTex(), blending: THREE.AdditiveBlending }), 4);
      E.disc.position.set(E.sx, 0.04, E.sz);
      // the column of heat and light the boss comes up in
      const pg = new THREE.CylinderGeometry(1, 1.5, 1, 22, 1, true); pg.translate(0, 0.5, 0);
      R.geos.push(pg);
      E.pillar = add(pg, mat({ map: getPillarTex(), blending: THREE.AdditiveBlending }), 10);
      E.pillar.position.set(E.sx, 0, E.sz);
      // debris chunks
      const dg = new THREE.DodecahedronGeometry(1, 0), dm = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
      dm.color.setRGB(0.12, 0.1, 0.082);
      R.geos.push(dg); R.mats.push(dm);
      E.debris = [];
      for (let i = 0; i < N_DEBRIS; i++) {
        const m = new THREE.Mesh(dg, dm);
        m.castShadow = true; m.visible = false;
        scene.add(m); R.objs.push(m);
        E.debris.push({ m: m, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, s: 0.4, rest: false });
      }
    }

    // a new jagged bolt from high up to the strike point (+ two forks)
    _boltShape() {
      const E = this._ent, bp = E.bp;
      if (!bp) return;
      const topX = E.sx + 6 + Math.random() * 9, topZ = E.sz - 7 + Math.random() * 14, topY = 88;
      for (let i = 0; i < BOLT_TRUNK; i++) {
        const t = i / (BOLT_TRUNK - 1), amp = (i === 0 || i === BOLT_TRUNK - 1) ? 0 : 2.3 * (1 - 0.5 * t);
        bp[i * 3] = lerp(topX, E.sx, t) + (Math.random() - 0.5) * 2 * amp;
        bp[i * 3 + 1] = lerp(topY, 0.05, t);
        bp[i * 3 + 2] = lerp(topZ, E.sz, t) + (Math.random() - 0.5) * 2 * amp;
      }
      for (let b = 0; b < 2; b++) {
        const base = BOLT_TRUNK + b * BOLT_BRANCH, k = 7 + b * 7 + Math.floor(Math.random() * 3);
        let x = bp[k * 3], y = bp[k * 3 + 1], z = bp[k * 3 + 2];
        const a = Math.random() * TAU, dx = Math.cos(a) * 3.2, dz = Math.sin(a) * 3.2;
        for (let j = 0; j < BOLT_BRANCH; j++) {
          bp[(base + j) * 3] = x; bp[(base + j) * 3 + 1] = y; bp[(base + j) * 3 + 2] = z;
          x += dx * (0.5 + Math.random()); y -= 4.5 + Math.random() * 3; z += dz * (0.5 + Math.random());
        }
      }
      this._boltFill(E.core.geometry, 0.15, 0.07);
      this._boltFill(E.halo.geometry, 0.75, 0.32);
    }

    // write the quads of the point list: w = half width of the trunk, wb = of the forks
    _boltFill(geo, w, wb) {
      const bp = this._ent.bp, pos = geo.attributes.position.array;
      let o = 0;
      const seg = (a, b, h) => {
        const ax = bp[a * 3], ay = bp[a * 3 + 1], az = bp[a * 3 + 2], bx = bp[b * 3], by = bp[b * 3 + 1], bz = bp[b * 3 + 2];
        pos[o++] = ax - h; pos[o++] = ay; pos[o++] = az;  pos[o++] = ax + h; pos[o++] = ay; pos[o++] = az;
        pos[o++] = bx + h; pos[o++] = by; pos[o++] = bz;  pos[o++] = bx - h; pos[o++] = by; pos[o++] = bz;
        pos[o++] = ax; pos[o++] = ay; pos[o++] = az - h;  pos[o++] = ax; pos[o++] = ay; pos[o++] = az + h;
        pos[o++] = bx; pos[o++] = by; pos[o++] = bz + h;  pos[o++] = bx; pos[o++] = by; pos[o++] = bz - h;
      };
      for (let i = 0; i < BOLT_TRUNK - 1; i++) seg(i, i + 1, w * (1 + 0.5 * i / BOLT_TRUNK));
      for (let b = 0; b < 2; b++) { const base = BOLT_TRUNK + b * BOLT_BRANCH; for (let j = 0; j < BOLT_BRANCH - 1; j++) seg(base + j, base + j + 1, wb * (1 - j / BOLT_BRANCH)); }
      geo.attributes.position.needsUpdate = true;
    }

    _entTick(dt) {
      const E = this._ent;
      if (E.cleaned) return;
      if (!E.built) this._entBuild();
      E.t += dt;
      const t = E.t, p = this.mesh.position, pp = playerPos(), wasLanded = E.landed;

      // ---- letterbox bars, storm mood, flash overlay
      if (!E.stormed) { E.stormed = true; Storm.target = ENT.storm; }
      if (!E.done) {
        Cine.setBars(t < ENT.end ? smooth(t / ENT.bars) : 1 - smooth((t - ENT.end) / ENT.out));
        if (t >= ENT.end && !E.calmed) { E.calmed = true; Storm.target = ENT.calm; }
        if (t >= ENT.end + ENT.out) { E.done = true; Cine.hide(); }
      }
      E.flashK = Math.max(0, E.flashK - dt * 3.2);
      Cine.setFlash(E.flashK);

      // ---- the lightning strikes
      if (!E.struck && t >= ENT.strike) {
        E.struck = true; E.boltT = 0;
        this._boltShape();
        Storm.flash = 1; E.flashK = 0.6;
        if (window.FX && FX.shake) FX.shake(0.75);
        _sv.set(E.sx, 0.25, E.sz);
        if (window.FX) { try { FX.sparks(_sv, _sn, 46); FX.dust(_sv, _sn, 2.2); } catch (e) { /* ignore */ } }
        sfx('explosion', p);                                     // thunder
      }
      if (E.struck) {
        const bt = t - ENT.strike;
        let k;
        if (bt < 0.09) k = 1;
        else if (bt < 0.15) k = 0.1;
        else if (bt < 0.28) {
          k = 1;
          if (!E.reStruck) { E.reStruck = true; this._boltShape(); Storm.flash = 0.85; E.flashK = Math.max(E.flashK, 0.5); if (window.FX && FX.shake) FX.shake(0.25); }
        } else k = Math.max(0, 1 - (bt - 0.28) / 0.4);
        const vis = k > 0.01;
        if (E.core.visible !== vis) { E.core.visible = vis; E.halo.visible = vis; }
        if (vis) { E.core.material.opacity = k; E.halo.material.opacity = 0.4 * k; }
      }

      // ---- cracks, embers, the heat glow, the rumble
      if (t >= ENT.crack) {
        let maxU = 0;
        for (let i = 0; i < E.cracks.length; i++) {
          const m = E.cracks[i], d = m.userData;
          const u = smooth((t - ENT.crack - d.delay) / 0.7);
          if (u > maxU) maxU = u;
          m.visible = u > 0.01;
          m.scale.set(d.w * d.flip, 1, d.len * u);
        }
        const heat = smooth((t - ENT.crack) / (ENT.burst - ENT.crack));
        const after = t > ENT.burst ? clamp((t - ENT.burst) / 1.0, 0, 1) : 0;
        E.disc.visible = true;
        const r = 3.2 + 2.6 * heat + 3 * after;
        E.disc.scale.set(r, 1, r);
        E.disc.material.opacity = clamp((0.25 + 0.55 * heat + 0.12 * Math.sin(t * 17)) * (1 - after), 0, 1);
        if (t < ENT.land) {
          E.emberT += dt;
          if (E.emberT >= 0.06) {
            E.emberT = 0;
            const m = E.cracks[(Math.random() * E.cracks.length) | 0], d = m.userData, rr = Math.random() * d.len * smooth((t - ENT.crack - d.delay) / 0.7);
            _sv.set(E.sx + Math.sin(d.ang) * rr, 0.12, E.sz + Math.cos(d.ang) * rr);
            if (window.FX && FX.sparks) { try { FX.sparks(_sv, _sn, 2); } catch (e) { /* ignore */ } }
          }
          if (t < ENT.burst && window.FX && FX.shake) FX.shake((0.3 + 1.1 * heat) * dt);       // the ground rumbles louder and louder
        }
        // the scar fades once the boss is up: the cracks go dark and are gone ~6 s after the landing
        if (t > ENT.land + 1.2) E.crackK = Math.max(0, 1 - (t - ENT.land - 1.2) / 5);
        E.crackMat.opacity = E.crackK;
        if (E.crackK <= 0) { this._entClean(); return; }
      }

      // ---- the column of heat around the burst
      if (t > ENT.burst - 0.15 && t < ENT.burst + 1.0) {
        const u = (t - (ENT.burst - 0.15)) / 1.15, r = 1.6 + 2.4 * smooth(u);
        E.pillar.visible = true;
        E.pillar.scale.set(r, 26 * (0.4 + 0.6 * smooth(u * 3)), r);
        E.pillar.material.opacity = clamp(Math.min(u * 6, 1) * (1 - u * u), 0, 1);
        E.pillar.rotation.y = t * 3;
      } else if (E.pillar.visible) E.pillar.visible = false;

      // ---- debris physics
      if (E.burst) {
        const D = E.debris;
        for (let i = 0; i < D.length; i++) {
          const d = D[i];
          if (d.rest) continue;
          d.vy -= 24 * dt;
          d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt;
          d.m.rotation.x += d.wx * dt; d.m.rotation.y += d.wy * dt; d.m.rotation.z += d.wz * dt;
          if (d.m.position.y < d.s * 0.45 && d.vy < 0) {
            d.m.position.y = d.s * 0.45;
            if (d.vy > -3) { d.rest = true; continue; }
            d.vy *= -0.32; d.vx *= 0.6; d.vz *= 0.6; d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
          }
        }
      }

      // ---- the burst out of the ground
      if (!E.burst && t >= ENT.burst) {
        E.burst = true;
        this.mesh.visible = true;
        const D = E.debris;
        for (let i = 0; i < D.length; i++) {
          const d = D[i], a = Math.random() * TAU, sp = 2.5 + Math.random() * 7;
          d.s = 0.25 + Math.random() * 0.55;
          d.m.scale.set(d.s * (0.8 + Math.random() * 0.5), d.s * (0.6 + Math.random() * 0.5), d.s * (0.8 + Math.random() * 0.5));
          d.m.position.set(E.sx + Math.cos(a) * (0.6 + Math.random() * 2), 0.2, E.sz + Math.sin(a) * (0.6 + Math.random() * 2));
          d.vx = Math.cos(a) * sp; d.vz = Math.sin(a) * sp; d.vy = 9 + Math.random() * 12;
          d.wx = (Math.random() - 0.5) * 12; d.wy = (Math.random() - 0.5) * 12; d.wz = (Math.random() - 0.5) * 12;
          d.rest = false; d.m.visible = true;
        }
        for (let i = 0; i < 14; i++) { const a = i / 14 * TAU; this._dustAt(E.sx + Math.cos(a) * 2.8, E.sz + Math.sin(a) * 2.8, 2.0); }
        _sv.set(E.sx, 0.3, E.sz);
        if (window.FX) { try { FX.sparks(_sv, _sn, 60); if (FX.shake) FX.shake(0.95); } catch (e) { /* ignore */ } }
        E.flashK = Math.max(E.flashK, 0.3);
        sfx('explosion', p); sfx('footstep', 'boss', p);
      }

      // ---- its jump (a parabola from under the ground), then the landing
      if (E.burst && !E.landed) {
        const tau = t - ENT.burst;
        E.y = ENT.buryY + ENT.v * tau - 0.5 * ENT.g * tau * tau;
        if (t >= ENT.land) {
          E.landed = true; E.y = 0;
          const x = E.sx, z = E.sz;
          this._wave = { t: 0, x: x, z: z, R: 26 };
          for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; this._dustAt(x + Math.cos(a) * 5.5, z + Math.sin(a) * 5.5, 1.8); }
          for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; this._dustAt(x + Math.cos(a) * 2.5, z + Math.sin(a) * 2.5, 2.4); }
          _sv.set(x, 0.2, z);
          if (window.FX) { try { FX.sparks(_sv, _sn, 50); FX.sparks(_sv, _sn2, 30); if (FX.shake) FX.shake(1.25); } catch (e) { /* ignore */ } }
          sfx('footstep', 'boss', p); sfx('clang', p); sfx('armorHit', p);
          E.flashK = Math.max(E.flashK, 0.55);
          E.shoving = true; E.ringR = 0; E.titleT0 = t;
        }
      }
      if (!wasLanded) p.y = E.y;

      // ---- the shockwave shoves the player when its front reaches him (no damage)
      if (E.shoving) {
        E.ringR += dt * 38;
        if (pp) {
          const dx = pp.x - p.x, dz = pp.z - p.z, d = Math.hypot(dx, dz) || 1;
          if (E.ringR >= d) {
            E.shoving = false;
            const v = 12 * clamp(1 - d / 32, 0.4, 1);
            if (window.Game && Game.shove) { try { Game.shove(dx / d * v, dz / d * v); } catch (e) { /* ignore */ } }
            if (window.FX && FX.shake) FX.shake(0.35);
          }
        } else E.shoving = false;
      }

      // ---- the title card, then the roar
      if (E.titleT0 >= 0) {
        const ta = t - E.titleT0 - 0.08;
        const a = ta < 0 ? 0 : (t < ENT.end ? clamp(ta / 0.12, 0, 1) : 1 - clamp((t - ENT.end) / 0.45, 0, 1));
        Cine.setCard(a, clamp(ta / 0.32, 0, 1));
      }
      if (!E.roared && E.landed && t >= ENT.land + 0.3) {
        E.roared = true;
        sfx('bossRoar', p);
        this._shake(0.6);
      }
    }

    // free everything the cinematic put in the scene (the cracks have faded, or the boss died / was removed)
    _entClean() {
      const E = this._ent;
      if (!E || E.cleaned) return;
      E.cleaned = true;
      disposeRes(E.res);
      E.cracks = E.debris = E.core = E.halo = E.disc = E.pillar = null;
    }

    // the boss died or was removed mid-cinematic
    _entAbort() {
      const E = this._ent;
      if (!E) return;
      E.landed = true; E.done = true; E.y = 0;
      this.mesh.visible = true;
      Cine.hide();
      this._entClean();
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
      if (this._roarKind === 'entrance') {                       // the cinematic (_entTick) does the effects; this only ends the state
        if (this.stateT >= this.windupTime) { this.atk = null; this._gap = 0.4; this._idleWait = 0.1; this.setState('combatIdle'); }
        return;
      }
      const t = this.stateT;
      if (this._roarFx < 1 && t >= 0.35) {
        this._roarFx = 1;
        this._shake(0.55);
        this._wave = { t: 0, x: this.mesh.position.x, z: this.mesh.position.z, R: 11 };
        if (this._roarKind === 'phase') {
          if (window.Sfx && Sfx.bossRoar) { try { Sfx.bossRoar(this.mesh.position); } catch (e) { /* ignore */ } }
          this._summon(2);
        }
      }
      if (this._roarFx < 2 && t >= 0.95) { this._roarFx = 2; this._shake(0.35); }
      if (this.stateT >= this.windupTime) {
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
    // head guard: raises the shield arm in front of the face when the player aims at the head (see the header)
    // -------------------------------------------------------------------------------------------------------------------
    // 0..1: Difficulty.bossGuard (the chance to react, shorter reaction time and cooldown as it grows), stronger in phase 3
    _guardLevel() {
      const D = diff(), G = clamp(typeof D.bossGuard === 'number' ? D.bossGuard : 0.6, 0, 1);
      return this.phase >= 3 ? Math.min(1, G * 1.3 + 0.05) : G;
    }

    _canGuard() {
      if (this.dead || (this._ent && !this._ent.landed)) return false;
      const s = this.state;
      if (s === 'approach' || s === 'combatIdle' || s === 'stagger' || s === 'attack' || s === 'recover') return true;
      return s === 'windup' && (this.atk === 'sweep' || this.atk === 'split');
    }

    // does the camera ray pass near the head? (every frame; the head sphere is combat.js's, 1.9 radii wide)
    _aimingAtHead() {
      const cam = window.Game && Game.camera, head = this.bones.head;
      if (!cam || !head) return false;
      cam.getWorldPosition(_gc); cam.getWorldDirection(_gd);
      head.getWorldPosition(_gh);
      _gh.y += HEAD_UP * this.sizeScale;
      _gh.sub(_gc);
      const t = _gh.dot(_gd);
      if (t < 1 || t > GUARD_MAX_D) return false;
      const perp2 = Math.max(0, _gh.lengthSq() - t * t), r = HEAD_R * this.sizeScale * GUARD_NEAR;
      this._g.lastD = Math.sqrt(perp2);
      return perp2 < r * r;
    }

    // did a bullet land on the raised shield (the tower shield is ~3 m tall and stands about 1.5 m in front of the face) within reach of the head?
    _onGuard(pt) {
      const head = this.bones.head;
      if (!pt || !head || !this.shield) return false;
      head.getWorldPosition(_gh);
      _gh.y += HEAD_UP * this.sizeScale;
      const rh = HEAD_R * this.sizeScale * GUARD_HIT;
      if (_gh.distanceToSquared(pt) > rh * rh) return false;
      this.shield.getWorldPosition(_gc);
      return _gc.distanceToSquared(pt) < GUARD_SHIELD_R * GUARD_SHIELD_R;
    }

    _guardTick(dt) {
      const g = this._g, G = this._guardLevel();
      const can = this._canGuard();
      g.cd -= dt;
      const aimed = can && this._aimingAtHead();
      g.aimed = aimed;
      if (g.on) {
        g.t -= dt;
        if (g.t <= 0 || !can) this._guardEnd(G);
      } else if (can) {
        if (g.pending >= 0) {                                    // reacting to a head shot it just took
          g.pending -= dt;
          if (g.pending < 0) this._guardStart();
        } else if (aimed && g.cd <= 0) {
          // a roll when the aim arrives (and again after every second it keeps on aiming without a reaction), then the reaction time
          if (g.roll < 0) { g.roll = Math.random() < G ? 1 : 0; g.rollT = 0; }
          else if (g.roll === 0 && (g.rollT += dt) >= 1) { g.roll = Math.random() < G ? 1 : 0; g.rollT = 0; }
          if (g.roll === 1) { g.aim += dt; if (g.aim >= lerp(0.7, 0.18, G)) this._guardStart(); }
        }
      }
      if (!aimed) { g.aim = Math.max(0, g.aim - dt * 2); if (g.aim === 0) g.roll = -1; }
    }

    _guardStart() {
      const g = this._g;
      g.on = true; g.pending = -1; g.aim = 0; g.roll = -1;
      g.t = (0.8 + Math.random() * 0.8) * (this.phase >= 3 ? 1.15 : 1);
    }

    _guardEnd(G) {
      const g = this._g;
      g.on = false; g.aim = 0; g.roll = -1; g.rollT = 0;
      g.cd = lerp(3.0, 1.0, G) * (this.phase >= 3 ? 0.75 : 1) * (0.85 + Math.random() * 0.3);
    }

    // right after an unguarded head shot it may throw the shield up (the cooldown is mostly ignored)
    _guardAlert() {
      const g = this._g, G = this._guardLevel();
      if (g.on || g.pending >= 0 || !this._canGuard() || g.cd > 1.0) return;
      if (Math.random() < Math.min(1, G + 0.25)) g.pending = 0.1 + 0.2 * (1 - G);
    }

    // the shield arm, on top of the clip: upper arm down and forward, forearm up in front of the face, shield turned to the front
    _extraPose(dt) {
      const g = this._g, target = g.on ? 1 : 0;
      g.w += (target - g.w) * Math.min(1, dt * (target ? 11 : 6));
      if (g.w < 0.01) { g.w = 0; return; }
      const fore = this.bones.armL, upper = fore && fore.parent, hand = this.bones.handL;
      if (!fore || !upper || !hand || !this.shield) return;
      this.mesh.updateMatrixWorld(true);
      const yaw = this.mesh.rotation.y, sn = Math.sin(yaw), cs = Math.cos(yaw), W = g.w;
      _gf.set(sn, 0, cs);                                        // the way it faces
      _go.set(cs, 0, -sn);                                       // its left (the shield arm's side)
      const GP = GUARD_POSE;
      _gU.copy(_gf).multiplyScalar(GP.u[0]).addScaledVector(_go, GP.u[1]).addScaledVector(_up, GP.u[2]).normalize();
      this._ovAim(upper, fore, _gU, W);
      _gF.copy(_gf).multiplyScalar(GP.f[0]).addScaledVector(_go, GP.f[1]).addScaledVector(_up, GP.f[2]).normalize();
      this._ovAim(fore, hand, _gF, W);
      // roll the forearm about its axis until the shield face looks along the way it faces
      this.shield.updateWorldMatrix(true, false);
      _gN.set(0, 0, 1).transformDirection(this.shield.matrixWorld);
      _gA.copy(_gN).addScaledVector(_gF, -_gN.dot(_gF)).normalize();
      _gB.copy(_gf).addScaledVector(_gF, -_gf.dot(_gF)).normalize();
      let ang = Math.acos(clamp(_gA.dot(_gB), -1, 1));
      if (_gC.crossVectors(_gA, _gB).dot(_gF) < 0) ang = -ang;
      this._ovRotate(fore, _gF, ang * W);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Earthsplitter: a red strip follows the player and locks, the sword smashes down, a crack races along the strip and
    // stone spikes erupt along it. Sidestep the strip.
    // -------------------------------------------------------------------------------------------------------------------
    startSplit(ctx) {
      const P = this.P;
      this.atk = 'split';
      this._splitCd = P.splitCd * (0.85 + Math.random() * 0.3);
      this._aimSplit(ctx);
      this.windupTime = P.splitWind; this.strikeTime = P.splitStrike; this.recoverTime = P.splitRecover;
      this.lungeSpeed = 0;
      this.setState('windup');
    }

    _aimSplit(ctx) {
      this._sdir.set(ctx.nx, 0, ctx.nz);
      if (this._sdir.lengthSq() < 1e-6) this._sdir.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
      this._sdir.normalize();
      this._sLen = clamp(ctx.dist + 10, 16, 36);
    }

    // the sword hits the ground: the crack starts
    _splitStart() {
      const S = this._split, p = this.mesh.position;
      this._ensureSpikes();
      S.active = true; S.t = 0; S.front = 0; S.nextD = 3.2; S.fade = 1; S.hit = false; S.n = 0;
      S.ox = p.x; S.oz = p.z; S.dx = this._sdir.x; S.dz = this._sdir.z; S.len = this._sLen;
      this._shake(0.55);
      const hx = p.x + S.dx * 3.6, hz = p.z + S.dz * 3.6;
      this._dustAt(hx, hz, 1.8);
      _sv.set(hx, 0.2, hz);
      if (window.FX && FX.sparks) { try { FX.sparks(_sv, _sn, 22); } catch (e) { /* ignore */ } }
      sfx('clang', this.mesh.position); sfx('footstep', 'boss', this.mesh.position);
    }

    _ensureSpikes() {
      if (this._spikes) return;
      const scene = this.mesh.parent || sceneOf();
      if (!scene) return;
      const R = this._res;
      const geo = new THREE.ConeGeometry(1, 1, 7); geo.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, flatShading: true });
      mat.color.setRGB(0.075, 0.062, 0.05); mat.emissive.setRGB(0.1, 0.03, 0.006);          // linear colours: dark stone with a hint of heat
      R.geos.push(geo); R.mats.push(mat);
      this._spikes = [];
      for (let i = 0; i < SPIKES; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.visible = false; m.frustumCulled = false;
        scene.add(m); R.objs.push(m);
        this._spikes.push({ m: m, age: -1, x: 0, z: 0, h: 2, r: 0.6 });
      }
    }

    _spikeAt(d) {
      const S = this._split, sp = this._spikes;
      if (!sp) return;
      let k = null;
      for (let i = 0; i < sp.length; i++) if (sp[i].age < 0) { k = sp[i]; break; }
      if (!k) return;
      const lat = (Math.random() - 0.5) * 0.5;
      k.x = S.ox + S.dx * d - S.dz * lat; k.z = S.oz + S.dz * d + S.dx * lat;
      k.h = 2.1 + Math.random() * 1.5; k.r = 0.55 + Math.random() * 0.25; k.age = 0;
      k.m.rotation.set((Math.random() - 0.5) * 0.35, Math.random() * TAU, (Math.random() - 0.5) * 0.35);
      k.m.scale.set(k.r, k.h, k.r);
      k.m.position.set(k.x, -k.h, k.z);
      k.m.visible = true;
      _sv.set(k.x, 0.1, k.z);
      if (window.FX) { try { FX.dust(_sv, _sn, 1.0); if (FX.sparks) FX.sparks(_sv, _sn, 3); } catch (e) { /* ignore */ } }
      if ((S.n++ & 1) === 0) sfx('footstep', 'boss', _sv);
      const pp = playerPos();
      if (pp && !S.hit && Math.hypot(pp.x - k.x, pp.z - k.z) < SPIKE_R) {
        S.hit = true;
        if (window.Player && Player.hurt) Player.hurt(dmgOf(DMG.split * (1 + 0.1 * (this.phase - 1))), this);
        const dx = pp.x - k.x, dz = pp.z - k.z, l = Math.hypot(dx, dz) || 1;
        if (window.Game && Game.shove) { try { Game.shove(dx / l * 8, dz / l * 8); } catch (e) { /* ignore */ } }
        if (window.FX && FX.shake) FX.shake(0.4);
      }
    }

    _splitTick(dt) {
      const S = this._split, sp = this._spikes;
      if (S.active) {
        S.t += dt;
        S.front = Math.min(S.len, S.t * SPLIT_SPEED);
        while (S.nextD <= S.front) { this._spikeAt(S.nextD); S.nextD += SPIKE_GAP; }
        if (S.front >= S.len) S.active = false;
      } else if (S.fade > 0) S.fade = Math.max(0, S.fade - dt / 2.4);
      if (!sp) return;
      for (let i = 0; i < sp.length; i++) {
        const k = sp[i];
        if (k.age < 0) continue;
        k.age += dt;
        const a = k.age;
        let y = 0;
        if (a < 0.12) { const u = a / 0.12; y = -k.h * (1 - (1 - (1 - u) * (1 - u))); }
        else if (a > 1.2) { y = -k.h * smooth((a - 1.2) / 0.5); if (a > 1.7) { k.age = -1; k.m.visible = false; continue; } }
        k.m.position.y = y;
      }
    }

    _splitAbort() {
      const S = this._split;
      S.active = false; S.fade = 0;
      if (this._spikes) for (let i = 0; i < this._spikes.length; i++) { this._spikes[i].age = -1; this._spikes[i].m.visible = false; }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Whirlwind: windup (the ring on the ground is the reach), a spinning chase, then dizzy
    // -------------------------------------------------------------------------------------------------------------------
    startWhirl(ctx) {
      this.atk = 'whirl';
      this._whirlCd = this.P.whirlCd * (0.85 + Math.random() * 0.3);
      this.setState('whirlWind');
    }

    _tickWhirl(dt, ctx) {
      const P = this.P, p = this.mesh.position;
      this._spinRate += (WHIRL_SPIN - this._spinRate) * (1 - Math.exp(-6 * dt));
      this._yaw = (this._yaw + this._spinRate * dt) % TAU;
      this.mesh.rotation.y = this._yaw;
      // it runs along a heading that steers towards the player at a limited rate: strafing out of the ring works
      const want = Math.atan2(ctx.dx, ctx.dz), cur = Math.atan2(this._wdir.x, this._wdir.z);
      const na = cur + clamp(angDiff(cur, want), -WHIRL_STEER * dt, WHIRL_STEER * dt);
      this._wdir.set(Math.sin(na), 0, Math.cos(na));
      const sp = P.whirlSpeed * clamp(ctx.dist / 3.5, 0.15, 1) * Math.min(1, this.stateT / 0.5);
      this._wSpeed += (sp - this._wSpeed) * (1 - Math.exp(-5 * dt));
      p.x += this._wdir.x * this._wSpeed * dt; p.z += this._wdir.z * this._wSpeed * dt;
      this._resolve(p, BODY_R, ctx);
      p.y = 0;
      const ts = Math.max(0.2, this._wSpeed / (Knight.CLIP_SPEED.Run * this.sizeScale));
      if (this._cur.lower) this._cur.lower.setEffectiveTimeScale(ts);
      // hits inside the ring
      this._whirlHitCd -= dt;
      const R = WHIRL_R * diff().reach, pp = playerPos();
      if (pp && this._whirlHitCd <= 0 && ctx.dist < R) {
        this._whirlHitCd = WHIRL_TICK;
        sfx('clang', this.mesh.position);
        if (window.Player && Player.hurt) Player.hurt(dmgOf(DMG.whirl * (1 + 0.1 * (this.phase - 1))), this);
        const l = ctx.dist || 1;
        if (window.Game && Game.shove) { try { Game.shove(-ctx.dx / l * 10, -ctx.dz / l * 10); } catch (e) { /* ignore */ } }
        this._shake(0.3);
      }
      // the whoosh of the blade and a dust trail
      this._whirlSnd -= dt; this._whirlDust -= dt;
      if (this._whirlSnd <= 0) { this._whirlSnd = 0.32; sfx('swing', true, this.mesh.position); }
      if (this._whirlDust <= 0 && window.FX && FX.dust) {
        this._whirlDust = 0.14;
        _sv.set(p.x + Math.sin(this._yaw) * 3.2, 0.05, p.z + Math.cos(this._yaw) * 3.2);
        try { FX.dust(_sv, _sn, 0.9); } catch (e) { /* ignore */ }
      }
      if (this.stateT >= P.whirlT) this.setState('dizzy');
    }

    // three stars circle the head while it is dizzy
    _ensureStars() {
      if (this._stars) return;
      const scene = this.mesh.parent || sceneOf();
      if (!scene) return;
      const R = this._res;
      const geo = new THREE.OctahedronGeometry(0.4, 0), mat = new THREE.MeshBasicMaterial({ color: 0xffe27a, fog: false });
      R.geos.push(geo); R.mats.push(mat);
      this._stars = [];
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.visible = false; m.frustumCulled = false;
        scene.add(m); R.objs.push(m);
        this._stars.push(m);
      }
    }

    // the blade's sweep while it spins: a translucent arc on the ground plane that trails behind the sword (the whole thing turns with the boss)
    _ensureSwoosh() {
      if (this._swoosh) return;
      const scene = this.mesh.parent || sceneOf();
      if (!scene) return;
      const R = this._res, SEG = 36;
      const geo = new THREE.RingGeometry(2.4, WHIRL_R * 0.96, SEG, 1, 0, SWOOSH_ARC);
      geo.rotateX(-Math.PI / 2);
      const n = geo.attributes.position.count, col = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) {                       // RingGeometry: index = ring * (SEG + 1) + step; the alpha grows towards the leading edge (the sword)
        const u = (k % (SEG + 1)) / SEG;
        col[k * 4] = 1; col[k * 4 + 1] = 0.9; col[k * 4 + 2] = 0.7; col[k * 4 + 3] = Math.pow(u, 1.7) * 0.62;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending });
      R.geos.push(geo); R.mats.push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false; m.renderOrder = 9;
      scene.add(m); R.objs.push(m);
      this._swoosh = m;
    }

    _updateSwoosh(dt) {
      const whirling = this.state === 'whirl' && !this.dead;
      if (whirling) this._ensureSwoosh();
      else if (this._spinRate > 0.05) this._spinRate *= Math.exp(-7 * dt);     // fades out after the spin
      const m = this._swoosh;
      if (!m) return;
      const k = clamp(this._spinRate / WHIRL_SPIN, 0, 1);
      if (k < 0.03) { m.visible = false; return; }
      const p = this.mesh.position;
      m.visible = true;
      m.position.set(p.x, 2.9, p.z);
      m.rotation.y = this._yaw - SWOOSH_ARC;             // the leading edge lies where the sword points (boss-local +x)
      m.material.opacity = k;
    }

    _updateDizzy(dt) {
      const dizzy = this.state === 'dizzy' && !this.dead;
      if (dizzy) {
        const dur = this.P.dizzy, t = this.stateT, env = Math.min(1, t / 0.3) * clamp((dur - t) / 0.4, 0, 1);
        this.mesh.rotation.z = 0.1 * env * Math.sin(this._t * 4.4);
        if (this._stars && this.bones.head) {
          this.bones.head.getWorldPosition(_sv);
          for (let i = 0; i < this._stars.length; i++) {
            const m = this._stars[i], a = this._t * 6 + i * (TAU / this._stars.length);
            m.visible = true;
            m.position.set(_sv.x + Math.cos(a) * 1.9, _sv.y + 1.9 + Math.sin(a * 1.7) * 0.18, _sv.z + Math.sin(a) * 1.9);
            m.rotation.y = a * 2; m.rotation.x = a;
          }
        }
      } else if (this._stars && this._stars[0].visible) {
        for (let i = 0; i < this._stars.length; i++) this._stars[i].visible = false;
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
          if (window.Sfx && Sfx.swing) { try { Sfx.swing(true, this.mesh.position); } catch (e) { /* ignore */ } }
          break;
        case 'chargeEnd': this._playStateAnim('combatIdle', 0.35); break;
        case 'whirlWind':
          this._playStateAnim('windup', 0.25);
          sfx('swing', true, this.mesh.position);
          break;
        case 'whirl': {
          const ctx = this._ctx;
          this._wdir.set(ctx.nx, 0, ctx.nz);
          this._spinRate = 0; this._wSpeed = 0; this._whirlHitCd = 0.3; this._whirlSnd = 0; this._whirlDust = 0;
          this._play('lower', 'Run', 0.2);
          const a = this._play('upper', ATTACK, 0.15);
          if (a) a.setEffectiveTimeScale(0);
          this.currentClip = ATTACK; this.gait = 'Run';
          break;
        }
        case 'dizzy':
          this._playStateAnim('combatIdle', 0.3);
          this._ensureStars();
          sfx('clang', this.mesh.position);
          break;
        default: break;
      }
      if (prev === 'dizzy') this.mesh.rotation.z = 0;
    }

    // -------------------------------------------------------------------------------------------------------------------
    // movement / turning / animation overrides for the custom states
    // -------------------------------------------------------------------------------------------------------------------
    _custom() {
      const s = this.state;
      return s === 'leapWind' || s === 'leap' || s === 'leapEnd' || s === 'chargeWind' || s === 'charge' || s === 'chargeEnd'
        || s === 'whirlWind' || s === 'whirl' || s === 'dizzy';
    }

    _move(dt, ctx) {
      const s = this.state;
      if (this._ent && !this._ent.landed) {                              // the entrance owns its height (and it does not move sideways)
        this._speed = 0; this._vel.set(0, 0, 0); this._decayKnockback(dt);
        this.mesh.position.y = this._ent.y;
        return;
      }
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
      if (this.atk === 'split' && (s === 'windup' || s === 'attack' || s === 'recover')) {       // faces the line (which follows the player until it locks)
        this._yaw += clamp(angDiff(this._yaw, Math.atan2(this._sdir.x, this._sdir.z)), -4 * dt, 4 * dt);
        this.mesh.rotation.y = this._yaw;
        return;
      }
      if (!this._custom()) { super._turn(dt, ctx); return; }
      let target = null, rate = 0;
      if (s === 'leapWind') { target = Math.atan2(this._leap.tx - this._leap.sx, this._leap.tz - this._leap.sz); rate = 4.0; }
      else if (s === 'chargeWind') { target = Math.atan2(this._cdir.x, this._cdir.z); rate = 4.5; }
      else if (s === 'leap') { target = Math.atan2(this._leap.tx - this._leap.sx, this._leap.tz - this._leap.sz); rate = 4.0; }
      else if (s === 'charge') { target = Math.atan2(this._cdir.x, this._cdir.z); rate = 6; }
      else if (s === 'whirlWind') { target = Math.atan2(ctx.dx, ctx.dz); rate = 3.0; }
      else if (s === 'dizzy') { target = Math.atan2(ctx.dx, ctx.dz); rate = 0.7; }
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
      else if (s === 'chargeWind' || s === 'whirlWind') {
        const a = this.actions[ATTACK];
        if (a && this._cur.upper === a) { a.time = lerp(0, ATK_RAISE, smooth(this.stateT / 0.45)); a.setEffectiveTimeScale(0); }
      } else if (s === 'whirl') {
        const a = this.actions[ATTACK];
        if (a && this._cur.upper === a) { a.time = WHIRL_POSE; a.setEffectiveTimeScale(0); }
      }
      super._animate(dt, ctx);
      this._updateLook(dt);
      this._updateTele(dt);
      this._updateDizzy(dt);
      this._updateSwoosh(dt);
    }

    // during the entrance the sword rises as it bursts out of the ground and is held up for the roar
    _attackClipT() {
      if (this.state === 'windup' && this.atk === 'roar' && this._roarKind === 'entrance' && this._ent) {
        return lerp(0, ATK_RAISE, smooth((this._ent.t - ENT.burst + 0.1) / (ENT.land - ENT.burst + 0.3)));
      }
      return super._attackClipT();
    }

    // heavy boots, only close by
    _footsteps(ctx) {
      const s = this.state;
      if ((s !== 'approach' && s !== 'charge' && s !== 'whirl') || !window.Sfx || !Sfx.footstep) return;
      const a = this._cur.lower;
      if (!a) return;
      const clip = a.getClip();
      const step = Math.floor((a.time / clip.duration) * 2);
      if (step !== this._stepPhase) {
        this._stepPhase = step;
        if (ctx.dist > 40) return;
        try { Sfx.footstep('boss', this.mesh.position); } catch (e) { /* ignore */ }
        this._shake(s === 'charge' || s === 'whirl' ? 0.16 : 0.07);
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
      this._shieldFlash = Math.max(0, this._shieldFlash - dt * 4);
      const sf = this._shieldFlash;
      for (let i = 0; i < this._shieldMats.length; i++) {
        const m = this._shieldMats[i], b = m._baseEmissive;
        if (b) m.emissive.setRGB(b.r + 0.85 * sf, b.g + 0.5 * sf, b.b + 0.2 * sf);
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
      this._blockedHit = false;
      Storm.tick(dt);
      if (this._ent && !this._ent.cleaned && !this.dead) this._entTick(dt);
      super.update(dt, target, waveNumber);
      if (this.dead || this._removed) return;
      this._guardTick(dt);
      this._splitTick(dt);
      // boss bar every frame (waves.js also does it: same values), from the moment it has landed
      if (window.HUD && HUD.bossBar && !this.cinematic) { HUD.bossBar(true, Math.max(0, this.hp) / this.maxHp, this.displayName || NAME); this._barShown = true; }
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
        if (Math.hypot(x, z) > ((window.World && World.arenaRadius) || 49) - 3) continue;
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
      if (this._ent && !this._ent.landed) return false;          // not before it has landed
      hit = hit || {};
      const g = this._g;
      if (this.state === 'dizzy' && typeof hit.damage === 'number') hit.damage *= DIZZY_DMG;
      // a head shot into the raised shield: a fraction of the damage, sparks and a clang, and it is no head shot any more. The shield sits in
      // front of the face, so a bullet that was meant for the head usually lands on it and is zoned as arm / torso: anything that lands
      // within the guard radius of the head centre counts, and does the damage of a head shot x GUARD_BLOCK either way.
      if (g.on && g.w > 0.5 && !this.dead && (hit.zone === 'head' || this._onGuard(hit.point))) {
        hit.zone = 'torso';
        hit.damage = (window.Combat && Combat.damageFor ? Combat.damageFor('head', this) : 150) * GUARD_BLOCK;
        this._blockedHit = true; this._shieldFlash = 1; g.blocks++;
        if (hit.point) {
          _sv.copy(hit.dir || _sn).negate();
          if (window.FX && FX.sparks) { try { FX.sparks(hit.point, _sv, 14); } catch (e) { /* ignore */ } }
          sfx('clang', hit.point);
        }
      }
      const wasHead = hit.zone === 'head';
      const killed = super.takeHit(hit);
      if (!killed) { this._checkPhase(); if (wasHead) this._guardAlert(); }
      return killed;
    }

    // -------------------------------------------------------------------------------------------------------------------
    // death
    // -------------------------------------------------------------------------------------------------------------------
    onDeath(hit) {
      this.atk = null;
      this.mesh.position.y = 0;
      this.mesh.rotation.z = 0;
      this._g.on = false; this._g.pending = -1;
      this._entAbort();
      this._splitAbort();
      this._spinRate = 0;
      if (this._swoosh) this._swoosh.visible = false;
      Storm.target = 0;                                           // the sky clears
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
      if (window.Sfx && Sfx.bossRoar) { try { Sfx.bossRoar(this.mesh.position); } catch (e) { /* ignore */ } }
      const at = (t, fn) => this._deathEvents.push({ t: t, fn: fn, done: false });
      at(0.9, () => { this._shake(0.35); if (window.Sfx && Sfx.footstep) { try { Sfx.footstep('boss', this.mesh.position); } catch (e) { /* ignore */ } } });
      at(DEATH_IMPACT, () => {
        this._shake(1.0);
        const q = this.mesh.position;
        const f = new V3(Math.sin(this._yaw), 0, Math.cos(this._yaw));
        if (window.Sfx) { try { if (Sfx.footstep) Sfx.footstep('boss', this.mesh.position); if (Sfx.clang) Sfx.clang(this.mesh.position); } catch (e) { /* ignore */ } }
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
      Storm.tick(dt);
      this._updateDizzy(dt);
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
      this._entClean();
      disposeRes(this._res);
      this._spikes = this._stars = this._swoosh = null;
      if (this._ent) { Cine.hide(); this._ent = null; }
      Storm.reset();
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
      const crackMat = new THREE.MeshBasicMaterial({ map: getCrackTex(), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      mats.push(crackMat);
      mk('crack', strip, crackMat, 5.5);
      this._tele = { meshes: meshes, geos: geos, mats: mats, names: Object.keys(meshes) };     // names: cached, _updateTele runs every frame
      return this._tele;
    }

    _hideTele() {
      const T = this._tele;
      if (!T) return;
      for (let i = 0; i < T.names.length; i++) T.meshes[T.names[i]].visible = false;
    }

    _updateTele(dt) {
      const W = this._wave, S = this._split;
      const st = this.state;
      const wantTele = !this.dead && (st === 'windup' || st === 'attack' || st === 'leapWind' || st === 'leap' || st === 'chargeWind' || st === 'charge'
        || st === 'whirlWind' || st === 'whirl');
      const crackOn = !this.dead && (S.active || S.fade > 0);
      if (!wantTele && !W && !crackOn) { if (this._tele) this._hideTele(); return; }
      const T = this._ensureTele();
      if (!T) return;
      const M = T.meshes;
      for (let i = 0; i < T.names.length; i++) if (T.names[i] !== 'wave') M[T.names[i]].visible = false;
      const p = this.mesh.position;
      const pulse = 0.5 + 0.5 * Math.sin(this._t * 14);
      this._teleFlash = Math.max(0, (this._teleFlash || 0) - dt * 4);

      if (wantTele) {
        const P = this.P;
        if ((st === 'windup' || st === 'attack') && this.atk === 'split') {
          // the Earthsplitter's line: it follows the player, locks (brighter) and is struck
          const w = SPLIT_W, len = this._sLen, yaw = Math.atan2(this._sdir.x, this._sdir.z);
          const u = st === 'windup' ? clamp(this.stateT / this.windupTime, 0, 1) : 1;
          const locked = st === 'attack' || u >= SPLIT_LOCK;
          M.stripBase.visible = true; M.stripBase.position.set(p.x, 0.05, p.z); M.stripBase.rotation.y = yaw; M.stripBase.scale.set(w, 1, len);
          M.stripBase.material.opacity = 0.24 + 0.08 * pulse + (locked ? 0.08 : 0);
          M.stripFill.visible = true; M.stripFill.position.set(p.x, 0.055, p.z); M.stripFill.rotation.y = yaw;
          M.stripFill.scale.set(w, 1, len * (st === 'windup' ? lerp(0.1, 1, smooth(u)) : 1));
          M.stripFill.material.opacity = st === 'windup' ? 0.26 + 0.3 * u + (locked ? 0.12 : 0) : 0.65;
          const px = Math.cos(yaw), pz = -Math.sin(yaw);
          for (let i = 0; i < 2; i++) {
            const k = STRIP_EDGES[i], sg = EDGE_SIGN[i];
            M[k].visible = true; M[k].position.set(p.x + px * sg * w / 2, 0.06, p.z + pz * sg * w / 2); M[k].rotation.y = yaw; M[k].scale.set(0.16, 1, len);
            M[k].material.opacity = locked ? 0.95 : 0.55 + 0.2 * pulse;
          }
        } else if ((st === 'windup' || st === 'attack') && this.atk === 'sweep') {
          const u = st === 'windup' ? clamp(this.stateT / this.windupTime, 0, 1) : 1;
          const R = SWEEP_R * diff().reach;
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
          const L = this._leap, R = P.slam * diff().reach;
          const u = st === 'leapWind' ? clamp(this.stateT / P.leapWind, 0, 1) : 1;
          M.discBase.visible = true; M.discBase.position.set(L.tx, 0.05, L.tz); M.discBase.scale.set(R, 1, R);
          M.discBase.material.opacity = 0.26 + 0.08 * pulse;
          M.discFill.visible = true; M.discFill.position.set(L.tx, 0.055, L.tz); M.discFill.scale.set(R * lerp(0.1, 1, smooth(u)), 1, R * lerp(0.1, 1, smooth(u)));
          M.discFill.material.opacity = 0.32 + 0.3 * u;
          M.ring.visible = true; M.ring.position.set(L.tx, 0.06, L.tz); M.ring.scale.set(R, 1, R);
          M.ring.material.opacity = L.locked ? 0.7 + 0.3 * pulse : 0.55;
        } else if (st === 'whirlWind' || st === 'whirl') {
          // the Whirlwind's reach: a ring around the boss that fills up during the windup, then pulses while it spins
          const R = WHIRL_R * diff().reach;
          const u = st === 'whirlWind' ? clamp(this.stateT / P.whirlWind, 0, 1) : 1;
          M.discBase.visible = true; M.discBase.position.set(p.x, 0.05, p.z); M.discBase.scale.set(R, 1, R);
          M.discBase.material.opacity = 0.24 + 0.08 * pulse;
          M.discFill.visible = true; M.discFill.position.set(p.x, 0.055, p.z);
          const f = st === 'whirlWind' ? lerp(0.1, 1, smooth(u)) : 1;
          M.discFill.scale.set(R * f, 1, R * f);
          M.discFill.material.opacity = st === 'whirlWind' ? 0.3 + 0.3 * u : 0.42 + 0.12 * pulse;
          M.ring.visible = true; M.ring.position.set(p.x, 0.06, p.z); M.ring.scale.set(R, 1, R);
          M.ring.material.opacity = st === 'whirl' ? 0.75 + 0.25 * pulse : 0.55;
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

      if (crackOn) {
        const yaw = Math.atan2(S.dx, S.dz);
        M.crack.visible = true; M.crack.position.set(S.ox, 0.052, S.oz); M.crack.rotation.y = yaw;
        M.crack.scale.set(SPLIT_W * 1.15, 1, Math.max(0.01, S.front));
        M.crack.material.opacity = S.active ? 1 : Math.min(1, S.fade * 1.6);
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
  // __dbg is made by debug.js, which loads after this file: install the helpers once the page has loaded (or when the first Boss is built)
  if (document.readyState === 'complete') setTimeout(() => installDebug(), 0); else window.addEventListener('load', () => installDebug());
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
          stateT: round(b.stateT), cds: { gap: round(b._gap), leap: round(b._leapCd), charge: round(b._chargeCd), split: round(b._splitCd), whirl: round(b._whirlCd) },
          pendingRoars: b._roarPending,
          guard: { on: b._g.on, w: round(b._g.w), t: round(b._g.t), cd: round(b._g.cd), aimed: b._g.aimed, aimDist: round(b._g.lastD), blocks: b._g.blocks, level: round(b._guardLevel()) },
          ent: b._ent ? { t: round(b._ent.t), landed: b._ent.landed, done: b._ent.done, y: round(b._ent.y) } : null,
          split: { active: b._split.active, front: round(b._split.front), len: round(b._sLen) },
          minions: b.minions.filter((m) => !m.dead && !m._removed).length, height: round(b.height), glow: round(b._glow), combo: b._combo };
      },
      // start an attack right now (the AI keeps running): 'sweep' | 'leap' | 'charge' | 'split' (Earthsplitter) | 'whirl' (Whirlwind) | 'roar'
      force(kind) {
        const b = find();
        if (!b) return null;
        b.hold = false;
        const ctx = ctxFor(b);
        b._gap = 0;
        if (kind === 'sweep') b.startWindup();
        else if (kind === 'leap') b.startLeap(ctx);
        else if (kind === 'charge') { if (b.phase < 2) b.phase = 2; b.startCharge(ctx); }
        else if (kind === 'split' || kind === 'earthsplitter') b.startSplit(ctx);
        else if (kind === 'whirl' || kind === 'whirlwind') { if (b.phase < 2) b.phase = 2; b.startWhirl(ctx); }
        else if (kind === 'roar') b.startRoar('phase');
        return this.info();
      },
      // raise (true) / lower (false) the shield arm right now for a while (default 1.2 s); undefined = raise. Lowering leaves a cooldown (default 99 s: no new guard)
      guard(on, sec) {
        const b = find();
        if (!b) return null;
        if (on === false) { b._guardEnd(b._guardLevel()); b._g.cd = sec === undefined ? 99 : sec; }
        else { b._guardStart(); b._g.t = sec || 1.2; }
        return { on: b._g.on, w: round(b._g.w), cd: round(b._g.cd), blocks: b._g.blocks };
      },
      // tune the guard pose live: guardPose({ u: [fwd, left, up], f: [fwd, left, up] })
      guardPose(o) { if (o && o.u) GUARD_POSE.u = o.u; if (o && o.f) GUARD_POSE.f = o.f; return GUARD_POSE; },
      // world position of the middle of the head (where a head shot lands): [x, y, z]
      headPos() {
        const b = find();
        if (!b) return null;
        b.mesh.updateMatrixWorld(true);
        const h = b.bones.head.getWorldPosition(new V3());
        h.y += HEAD_UP * b.sizeScale;
        return h.toArray().map(round);
      },
      // arm the entrance cinematic on the boss (or build a boss 19 m ahead of the camera and arm it): the sequence starts on its next update
      entrance() {
        let b = find();
        if (!b) {
          if (!window.Enemies || !window.Game) return null;
          const d = new V3(); Game.camera.getWorldDirection(d); d.y = 0; d.normalize();
          b = new Boss();
          const pp = playerPos();
          b.mesh.position.set(pp.x + d.x * 19, 0, pp.z + d.z * 19);
          Enemies.add(b);
        } else { b._ent = null; b.mesh.visible = true; }
        b._placed = true;
        b.startEntrance();
        return this.info();
      },
      // sky mood 0..1 (the cinematic sets it itself): the lights, background and fog of the scene
      storm(level, flash) { Storm.target = level === undefined ? 0.78 : level; if (flash) Storm.flash = flash; return { level: Storm.level, target: Storm.target }; },
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
      constants() { return { SIZE: SIZE, HP: HP, PH: PH, DMG: DMG, SWEEP_R: SWEEP_R, J: J, ENT: ENT, SPLIT_W: SPLIT_W, SPIKE_R: SPIKE_R, WHIRL_R: WHIRL_R }; },
    };
  }
})();
