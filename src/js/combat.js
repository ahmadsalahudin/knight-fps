/* combat.js — window.Combat  (Worker C2, docs/FIX_PLAN.md section 3 "Combat")

   Hit zones, the damage model, hit / kill reactions and the physics of loose gear.

     Combat.zoneFor(enemy, hit)         -> 'head' | 'torso' | 'limb'
                                           hit = THREE.Intersection (object, point) or takeHit data ({zone, point, dir}).
                                           helmet mesh => head; otherwise the distance of hit.point to the head bone sphere,
                                           the torso axis (hips -> neck) and the arm / leg bone chains (skeleton found by
                                           the original glTF bone names, so enemy.bones is optional). Without any bones:
                                           height above enemy.mesh.position relative to the enemy's height.
     Combat.damageFor(zone, enemy)      -> head 150, torso 40, limb 28 (knights have 100 HP; the boss only has more HP)
     Combat.onHit(enemy, hit, dir)      -> sparks + a little blood, armour sound, horizontal knockback impulse.
                                           Returns 'head' | 'hit' (Game turns it into the hitmarker; Combat NEVER calls HUD.hitmark).
     Combat.onKill(enemy, hit, dir)     -> sets enemy._killFx = true (repeat calls are ignored), blood burst + pool, death
                                           sound, bigger knockback, loose gear: a head shot pops the helmet off (velocity + spin);
                                           the sword and shield leave the hands a few frames later. Returns 'kill'.
     Combat.update(dt)                  -> simulates the loose props (gravity, rigid-body ground contact with bounce, friction,
                                           sleeping), runs the delayed effects, despawns props after ~15 s (sink, remove, dispose).
   Extras: Combat.clear() removes every loose prop, Combat.stats(), Combat.zoneShapes(enemy) (debug), Combat.props (read only).

   Knockback protocol (enemies.js): Combat adds a horizontal velocity impulse in m/s. If the enemy has applyImpulse(Vector3) it is
   called with it; otherwise enemy.knockback (THREE.Vector3, created when missing) is incremented. The enemy owns the decay and
   the movement (collide / slide, then damp ~6 /s). enemy.knockbackScale (default 1, 0.1 for type 'boss') scales the impulse.
   Safety net: when the enemy never changes that vector (it does not read it), Combat slides enemy.mesh itself and damps the
   vector (see stepKnockback); the first time the enemy modifies it, Combat stops touching it (enemy._cmbKbOwn).

   Loose gear: the original object (enemy.helmet / sword / shield, the Assets wrapper) is re-parented into a small physics holder
   Group in the scene, keeping its exact world transform (like scene.attach), and gets userData.loose = true. The enemy must not
   remove / dispose it any more (enemy.mesh does not contain it any more). Everything is dt driven (no timers); every
   cross-module call is guarded, and missing enemy.bones / helmet / sword / shield are tolerated. */
(function () {
  'use strict';

  const V3 = THREE.Vector3, Q = THREE.Quaternion, M4 = THREE.Matrix4;
  const rnd = Math.random;
  const rr = function (a, b) { return a + rnd() * (b - a); };
  const clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

  // ---------------------------------------------------------------------------------------------------------------- tuning
  const DAMAGE = { head: 150, torso: 40, limb: 28 };
  const KNOCK = { head: 2.0, torso: 1.3, limb: 0.8 };            // m/s horizontal, per non-lethal hit
  const KNOCK_KILL = { head: 3.6, torso: 3.0, limb: 2.2 };       // m/s horizontal, on the killing shot
  const BLOOD_HIT = { head: 7, torso: 4, limb: 3 };              // FX.blood amounts (modest on purpose)
  const BLOOD_KILL = { head: 16, torso: 11, limb: 9 };
  const POOL_R = { head: 0.66, torso: 0.82, limb: 0.64 };          // metres, for a 1.8 m knight
  // zone geometry in "knight units" (a 1.8 m knight); multiplied by the enemy's own scale
  const HEAD_UP = 0.24, HEAD_R = 0.25, TORSO_R = 0.25, ARM_R = 0.115, LEG_R = 0.14, PELVIS_DROP = 0.04;
  const HIPS_TO_HEAD = 0.696;                                    // hips -> head bone distance of the 1.8 m knight

  // props
  const GRAVITY = 9.8, STEP = 1 / 120, MAX_STEPS = 12;
  const LIFE = 12.5, SINK_TIME = 1.6, MAX_PROPS = 30;
  const SHAPES = {
    helmet: { shape: 'sphere', e: 0.40, mu: 0.45, angDamp: 3.0, linDamp: 2.2 },
    sword: { shape: 'box', e: 0.26, mu: 0.60, angDamp: 2.6, linDamp: 0.25 },
    shield: { shape: 'box', e: 0.20, mu: 0.55, angDamp: 2.8, linDamp: 0.25 }
  };

  // ---------------------------------------------------------------------------------------------------------------- state
  const props = [];            // active loose bodies
  const tasks = [];            // delayed effects { t, fn }
  const kbWatch = new Set();   // enemies whose knockback vector Combat wrote and nobody has consumed yet
  const probes = Object.create(null);   // asset name -> { mats:Set, geos:Set } (what the shared asset cache owns)
  let dbgInstalled = false;
  let propsSpawned = 0;

  // scratch
  const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _hc = new V3(), _up = new V3();
  const _wp = []; for (let i = 0; i < 6; i++) _wp.push(new V3());
  const UP = new V3(0, 1, 0);

  function guard(fn, label) {
    try { return fn(); } catch (e) { if (!guard.n || guard.n < 4) { guard.n = (guard.n || 0) + 1; console.error('[Combat] ' + label, e); } return undefined; }
  }

  // ---------------------------------------------------------------------------------------------------------------- rig
  function isDescendant(obj, root) { for (let o = obj; o; o = o.parent) if (o === root) return true; return false; }

  function segDist(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 1e-10 ? (apx * abx + apy * aby + apz * abz) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Find (once per enemy) the bones the zone test needs. Names are the ORIGINAL glTF names; Assets.bones() maps them.
  function rigOf(enemy) {
    let r = enemy._cmbRig;
    if (r && r.mesh === enemy.mesh) return r;
    const B = enemy.bones || {};
    let named = null;
    try { if (window.Assets && Assets.bones && enemy.mesh) named = Assets.bones(enemy.mesh); } catch (e) { named = null; }
    const pick = function (name, alt) { return (named && named[name]) || alt || null; };
    r = { mesh: enemy.mesh, head: pick('Head', B.head), neck: pick('Neck', null), hips: pick('Hips', B.hips), arms: [], legs: [], H: 0 };
    if (!r.neck) r.neck = B.torso || null;
    const side = ['L', 'R'];
    for (let i = 0; i < 2; i++) {
      const s = side[i];
      const arm = [pick('UpperArm.' + s), pick('LowerArm.' + s, B['arm' + s]), pick('Palm.' + s, B['hand' + s]), pick('Fingers.' + s)].filter(Boolean);
      const leg = [pick('UpperLeg.' + s), pick('LowerLeg.' + s), pick('Foot.' + s)].filter(Boolean);
      if (!leg.length && B['leg' + s]) leg.push(B['leg' + s]);
      if (arm.length) r.arms.push(arm);
      if (leg.length) r.legs.push(leg);
    }
    // the height of the enemy: explicit, else from the rigid hips -> head distance, else its bounding box
    if (typeof enemy.height === 'number' && enemy.height > 0.2) r.H = enemy.height;
    else if (r.head && r.hips && r.head !== r.hips) {
      r.head.getWorldPosition(_a); r.hips.getWorldPosition(_b);
      const d = _a.distanceTo(_b);
      if (d > 0.05) r.H = d / HIPS_TO_HEAD * 1.8;
    }
    if (!(r.H > 0.2) && enemy.mesh) {
      enemy.mesh.updateWorldMatrix(true, true);
      const bb = new THREE.Box3().setFromObject(enemy.mesh);
      r.H = bb.isEmpty() ? 1.8 : Math.max(0.5, bb.max.y - bb.min.y);
    }
    if (!(r.H > 0.2)) r.H = 1.8;
    r.s = r.H / 1.8;
    r.bones = !!(r.head && r.hips);
    enemy._cmbRig = r;
    return r;
  }

  function worldPos(obj, out) { obj.getWorldPosition(out); return out; }

  // ---------------------------------------------------------------------------------------------------------------- zones
  function zoneByBones(rig, pt) {
    const s = rig.s;
    worldPos(rig.head, _a);                                    // head bone = base of the head
    if (rig.neck && rig.neck !== rig.head) { worldPos(rig.neck, _b); _up.subVectors(_a, _b); } else _up.set(0, 0, 0);
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();
    _hc.copy(_a).addScaledVector(_up, HEAD_UP * s);
    if (pt.distanceTo(_hc) < HEAD_R * s) return 'head';

    // torso axis: hips -> neck (or the head bone)
    worldPos(rig.hips, _c);
    const top = (rig.neck && rig.neck !== rig.hips) ? worldPos(rig.neck, _d) : _a;
    // legs: everything clearly below the pelvis
    if (pt.y < _c.y - PELVIS_DROP * s) return 'limb';
    const mT = segDist(pt, _c, top) - TORSO_R * s;
    let mA = 1e9;
    for (let i = 0; i < rig.arms.length; i++) {
      const ch = rig.arms[i];
      for (let k = 0; k < ch.length; k++) worldPos(ch[k], _wp[k]);
      if (ch.length === 1) mA = Math.min(mA, pt.distanceTo(_wp[0]) - ARM_R * s);
      for (let k = 0; k + 1 < ch.length; k++) mA = Math.min(mA, segDist(pt, _wp[k], _wp[k + 1]) - ARM_R * s);
    }
    let mL = 1e9;
    for (let i = 0; i < rig.legs.length; i++) {
      const ch = rig.legs[i];
      for (let k = 0; k < ch.length; k++) worldPos(ch[k], _wp[k]);
      if (ch.length === 1) mL = Math.min(mL, pt.distanceTo(_wp[0]) - LEG_R * s);
      for (let k = 0; k + 1 < ch.length; k++) mL = Math.min(mL, segDist(pt, _wp[k], _wp[k + 1]) - LEG_R * s);
    }
    const mLimb = Math.min(mA, mL);
    return (mLimb < mT - 0.03 * s) ? 'limb' : 'torso';
  }

  // no skeleton at all: height above the enemy's feet relative to its height, lateral offset for the arms
  function zoneByHeight(enemy, rig, pt) {
    const base = worldPos(enemy.mesh, _a);
    const f = (pt.y - base.y) / rig.H;
    if (f > 0.78) return 'head';
    if (f < 0.40) return 'limb';
    const lat = Math.hypot(pt.x - base.x, pt.z - base.z);
    return lat > 0.27 * rig.s ? 'limb' : 'torso';
  }

  function zoneFor(enemy, hit) {
    if (!enemy || !hit) return 'torso';
    if (!hit.object && typeof hit.zone === 'string' && DAMAGE[hit.zone] !== undefined) return hit.zone;   // takeHit() data
    if (hit.__cmbZone && hit.__cmbEnemy === enemy) return hit.__cmbZone;
    let zone = 'torso';
    const z = guard(function () {
      if (hit.object && enemy.helmet && isDescendant(hit.object, enemy.helmet)) return 'head';
      if (!hit.point || !enemy.mesh) return 'torso';
      const rig = rigOf(enemy);
      return rig.bones ? zoneByBones(rig, hit.point) : zoneByHeight(enemy, rig, hit.point);
    }, 'zoneFor');
    if (z) zone = z;
    try { hit.__cmbZone = zone; hit.__cmbEnemy = enemy; } catch (e) { /* frozen hit object */ }
    return zone;
  }

  function damageFor(zone, enemy) {
    const d = DAMAGE[zone];
    return d === undefined ? DAMAGE.torso : d;
  }

  // ---------------------------------------------------------------------------------------------------------------- helpers
  function bulletDir(enemy, hit, dir) {
    const d = new V3();
    if (dir && isFinite(dir.x) && isFinite(dir.y) && isFinite(dir.z)) d.copy(dir);
    else if (hit && hit.dir && isFinite(hit.dir.x)) d.copy(hit.dir);
    else {
      if (enemy && enemy.mesh) enemy.mesh.getWorldPosition(d);
      const pp = window.Game && Game.playerObj ? Game.playerObj.position : null;
      if (pp) d.sub(pp); else d.set(0, 0, -1);
    }
    if (d.lengthSq() < 1e-8) d.set(0, 0, -1);
    return d.normalize();
  }

  function hitPoint(enemy, hit) {
    if (hit && hit.point && isFinite(hit.point.x)) return hit.point;
    const p = new V3();
    if (enemy && enemy.mesh) { enemy.mesh.getWorldPosition(p); p.y += 1.1 * (enemy._cmbRig ? enemy._cmbRig.s : 1); }
    return p;
  }

  function enemyScale(enemy) {
    if (!enemy) return 1;
    if (enemy._cmbRig) return enemy._cmbRig.s;
    return guard(function () { return enemy.mesh ? rigOf(enemy).s : 1; }, 'scale') || 1;
  }

  // horizontal velocity impulse (m/s) along (dx, dz)
  function push(enemy, dx, dz, speed) {
    if (!enemy || !(speed > 0)) return;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const ks = typeof enemy.knockbackScale === 'number' ? enemy.knockbackScale : (enemy.type === 'boss' ? 0.1 : 1);
    const f = speed * ks / l;
    if (typeof enemy.applyImpulse === 'function') { enemy.applyImpulse(new V3(dx * f, 0, dz * f)); return; }
    if (enemy.knockback && enemy.knockback.isVector3) { enemy.knockback.x += dx * f; enemy.knockback.z += dz * f; }
    else enemy.knockback = new V3(dx * f, 0, dz * f);
    if (!enemy._cmbKbOwn && !kbWatch.has(enemy)) { kbWatch.add(enemy); enemy._cmbKbX = enemy.knockback.x; enemy._cmbKbZ = enemy.knockback.z; enemy._cmbKbSeen = false; }
    else if (kbWatch.has(enemy)) { enemy._cmbKbX = enemy.knockback.x; enemy._cmbKbZ = enemy.knockback.z; }
  }

  // Safety net for enemies that never read enemy.knockback: if the vector is still exactly what Combat wrote after the enemy's own
  // update has run (Enemies.update runs before Combat.update in the main loop), Combat slides the mesh itself and damps the vector.
  // As soon as an enemy changes the vector it is marked as the owner (enemy._cmbKbOwn) and is never touched again.
  function stepKnockback(dt) {
    kbWatch.forEach(function (e) {
      const kb = e.knockback;
      if (!kb || !e.mesh || !e.mesh.parent) { kbWatch.delete(e); return; }
      if (Math.abs(kb.x - e._cmbKbX) > 1e-6 || Math.abs(kb.z - e._cmbKbZ) > 1e-6) { e._cmbKbOwn = true; kbWatch.delete(e); return; }
      e.mesh.position.x += kb.x * dt; e.mesh.position.z += kb.z * dt;
      const k = Math.exp(-7 * dt);
      kb.x *= k; kb.z *= k;
      if (kb.x * kb.x + kb.z * kb.z < 4e-4) { kb.x = 0; kb.z = 0; kbWatch.delete(e); return; }
      e._cmbKbX = kb.x; e._cmbKbZ = kb.z;
    });
  }

  function later(t, fn) { tasks.push({ t: t, fn: fn }); }

  function getScene(obj, enemy) {
    for (let o = obj; o; o = o.parent) if (o.isScene) return o;
    if (enemy && enemy.mesh) for (let o = enemy.mesh; o; o = o.parent) if (o.isScene) return o;
    if (window.Game && Game.scene) return Game.scene;
    if (window.Main && Main.scene) return Main.scene;
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------- hit / kill
  function onHit(enemy, hit, dir) {
    if (!enemy) return 'hit';
    const zone = zoneFor(enemy, hit);
    const d = bulletDir(enemy, hit, dir);
    const pt = hitPoint(enemy, hit);
    const toShooter = new V3().copy(d).negate();
    if (window.FX) {
      if (FX.sparks) guard(function () { FX.sparks(pt, toShooter, zone === 'head' ? 11 : 8); }, 'sparks');
      if (FX.blood) guard(function () { FX.blood(pt, d, BLOOD_HIT[zone]); }, 'blood');
    }
    if (window.Sfx) {      // head shot = a sharp ping, anything else = an armour clank, both played where the bullet landed
      if (zone === 'head' && Sfx.headshot) guard(function () { Sfx.headshot(pt); }, 'sfx');
      else if (Sfx.armorHit) guard(function () { Sfx.armorHit(pt); }, 'sfx');
    }
    push(enemy, d.x, d.z, KNOCK[zone]);
    return zone === 'head' ? 'head' : 'hit';
  }

  function onKill(enemy, hit, dir) {
    if (!enemy) return 'kill';
    if (enemy._killFx) return 'kill';
    enemy._killFx = true;
    const zone = zoneFor(enemy, hit);
    const d = bulletDir(enemy, hit, dir);
    const pt = hitPoint(enemy, hit).clone();
    const s = enemyScale(enemy);
    const flat = new V3(d.x, 0, d.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const side = new V3(-flat.z, 0, flat.x);

    if (window.FX) {
      if (FX.sparks) guard(function () { FX.sparks(pt, new V3().copy(d).negate(), zone === 'head' ? 12 : 9); }, 'sparks');
      if (FX.blood) guard(function () { FX.blood(pt, d, BLOOD_KILL[zone]); }, 'blood');
    }
    if (window.Sfx) {      // the killing blow: the ping for a head shot, then the heavy crunch and the fall of body and armour
      if (zone === 'head' && Sfx.headshot) guard(function () { Sfx.headshot(pt); }, 'sfx');
      if (Sfx.kill) guard(function () { Sfx.kill(pt); }, 'sfx');
    }
    push(enemy, d.x, d.z, KNOCK_KILL[zone]);

    // ---- loose gear ---------------------------------------------------------------------------------------------
    if (zone === 'head' && enemy.helmet) {
      const v = new V3().copy(flat).multiplyScalar(rr(1.0, 1.9)).addScaledVector(side, rr(-0.6, 0.6));
      v.y = rr(3.4, 4.2);
      const w = new V3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize().multiplyScalar(rr(9, 15));
      detach(enemy, enemy.helmet, 'helmet', 0, v, w, s);
    }
    if (enemy.sword) {
      const v = new V3().copy(flat).multiplyScalar(rr(0.7, 1.5)).addScaledVector(side, rr(-0.8, 0.8));
      v.y = rr(0.8, 1.7);
      const w = new V3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize().multiplyScalar(rr(3, 6));
      detach(enemy, enemy.sword, 'sword', 0.10, v, w, s);
    }
    if (enemy.shield) {
      const v = new V3().copy(flat).multiplyScalar(rr(0.3, 0.9)).addScaledVector(side, rr(-0.5, 0.5));
      v.y = rr(0.4, 1.0);
      const w = new V3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize().multiplyScalar(rr(2, 4));
      detach(enemy, enemy.shield, 'shield', 0.26, v, w, s);
    }

    // ---- blood: a short second spurt, then a pool that spreads under the fallen body -----------------------------
    const rig = enemy._cmbRig;
    const p0 = new V3();
    if (enemy.mesh) enemy.mesh.getWorldPosition(p0); else p0.copy(pt);
    later(0.14, function () { if (window.FX && FX.blood) FX.blood(pt, d, zone === 'head' ? 6 : 4); });
    const radius = POOL_R[zone] * Math.pow(Math.max(1, s), 0.85) * rr(0.9, 1.12);
    later(0.5, function () {
      const p = new V3();
      let ok = false;
      if (enemy.mesh && getScene(enemy.mesh)) {
        const bone = (rig && (rig.hips || rig.head)) || null;
        if (bone) { bone.getWorldPosition(p); ok = true; }
        else { enemy.mesh.getWorldPosition(p); ok = true; }
      }
      if (!ok) p.copy(p0);
      if (!isFinite(p.x) || !isFinite(p.z)) p.copy(p0);
      if (window.FX && FX.bloodPool) FX.bloodPool(p, radius);
    });
    if (zone === 'head') {
      later(0.8, function () {
        if (!(rig && rig.head && enemy.mesh && getScene(enemy.mesh))) return;
        const p = new V3(); rig.head.getWorldPosition(p);
        if (isFinite(p.x) && window.FX && FX.bloodPool) FX.bloodPool(p, 0.45 * Math.pow(Math.max(1, s), 0.85));
      });
    }
    return 'kill';
  }

  // ---------------------------------------------------------------------------------------------------------------- loose props
  // Local-space AABB (in prop's own frame) of all visible mesh geometry below prop.
  function localBox(prop) {
    prop.updateWorldMatrix(true, true);
    const inv = new M4().copy(prop.matrixWorld).invert();
    const box = new THREE.Box3();
    const m = new M4(), v = new V3();
    prop.traverse(function (o) {
      if (!o.isMesh || !o.geometry || o.visible === false) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb || bb.isEmpty()) return;
      m.multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < 8; i++) {
        v.set((i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z).applyMatrix4(m);
        box.expandByPoint(v);
      }
    });
    return box;
  }

  // Release an enemy's gear after `delay` seconds with a launch velocity (+ whatever speed the part had while it was still attached).
  function detach(enemy, prop, kind, delay, v, w, s) {
    if (!prop || !prop.parent || prop.userData.loose) return;
    const startPos = new V3();
    prop.getWorldPosition(startPos);
    const t0 = delay;
    const go = function () {
      if (!prop.parent || prop.userData.loose) return;
      let sc = null;
      for (let o = prop; o; o = o.parent) if (o.isScene) { sc = o; break; }
      if (!sc) return;                                      // enemy already removed from the scene: nothing to show
      const vel = new V3().copy(v);
      if (t0 > 0.02) {                                      // inherit the motion of the falling limb
        const now = prop.getWorldPosition(new V3());
        const inh = now.sub(startPos).multiplyScalar(1 / t0);
        const sp = inh.length();
        if (sp > 4) inh.multiplyScalar(4 / sp);
        vel.addScaledVector(inh, 0.6);
      }
      spawnBody(enemy, prop, kind, sc, vel, w, s);
    };
    if (delay > 0) later(delay, go); else go();
  }

  function spawnBody(enemy, prop, kind, sc, vel, angVel, s) {
    const cfg = SHAPES[kind] || SHAPES.sword;
    prop.updateWorldMatrix(true, false);
    const pos = new V3(), quat = new Q(), scl = new V3();
    prop.matrixWorld.decompose(pos, quat, scl);
    const box = localBox(prop);
    let center, hs;
    if (box.isEmpty()) { center = new V3(); hs = new V3(0.12, 0.12, 0.12); }
    else { center = box.getCenter(new V3()); hs = box.getSize(new V3()).multiplyScalar(0.5); }
    const he = new V3(Math.max(0.012, hs.x * Math.abs(scl.x)), Math.max(0.012, hs.y * Math.abs(scl.y)), Math.max(0.012, hs.z * Math.abs(scl.z)));
    const cs = center.clone().multiply(scl);

    const holder = new THREE.Group();
    holder.name = 'combat-prop:' + kind;
    holder.position.copy(pos).add(cs.clone().applyQuaternion(quat));
    holder.quaternion.copy(quat);
    sc.add(holder);
    holder.add(prop);                                       // leaves the bone / mesh, keeps its world transform
    prop.position.copy(cs).negate();
    prop.quaternion.identity();
    prop.scale.copy(scl);
    prop.userData.loose = true;
    prop.visible = true;

    const b = {
      kind: kind, holder: holder, prop: prop, assets: assetNames(prop), cfg: cfg,
      p: holder.position.clone(), q: holder.quaternion.clone(), v: vel.clone(), w: angVel.clone(),
      he: he, shape: cfg.shape, R: 0, corners: null, invI: new V3(), acc: 0, age: 0, rest: 0, asleep: false,
      settleT: 0, settleDur: 0, q0: null, q1: null, y0: 0, y1: 0, restY: 0, sink: 0, sinkTotal: 0, clangCd: 0, contact: false
    };
    // limit absurd launch speeds
    if (b.v.length() > 9) b.v.setLength(9);
    if (b.w.length() > 20) b.w.setLength(20);
    if (cfg.shape === 'sphere') {
      b.R = clamp((he.x + he.y + he.z) / 3 * 0.95, 0.05, 0.6);
      const I = 0.4 * b.R * b.R * 1.4;
      b.invI.set(1 / I, 1 / I, 1 / I);
      b.nc = 1;
    } else {
      b.corners = [];
      for (let i = 0; i < 8; i++) b.corners.push(new V3((i & 1) ? he.x : -he.x, (i & 2) ? he.y : -he.y, (i & 4) ? he.z : -he.z));
      const hx = Math.max(he.x, 0.04), hy = Math.max(he.y, 0.04), hz = Math.max(he.z, 0.04);
      const k = 1.4 / 3;
      b.invI.set(1 / (k * (hy * hy + hz * hz)), 1 / (k * (hx * hx + hz * hz)), 1 / (k * (hx * hx + hy * hy)));
      b.nc = 8;
    }
    b.sinkTotal = 2 * Math.max(he.x, he.y, he.z) + 0.05;
    props.push(b);
    propsSpawned++;
    if (props.length > MAX_PROPS) {                         // too many loose props: the oldest one sinks away fast
      for (let i = 0; i < props.length; i++) {
        if (!props[i].fast) { props[i].fast = true; if (props[i].age < LIFE) props[i].age = LIFE; break; }
      }
    }
    syncHolder(b);
    return b;
  }

  // ---- rigid body: gravity, bounce, friction against the flat ground (y = 0) ------------------------------------------
  const _r = []; for (let i = 0; i < 8; i++) _r.push(new V3());
  const _depth = new Float32Array(8), _vn0 = new Float32Array(8), _jn = new Float32Array(8), _jtx = new Float32Array(8), _jtz = new Float32Array(8), _act = new Uint8Array(8);
  const _qi = new Q(), _wq = new Q(), _qs = new Q(), _u = new V3(), _t1 = new V3(), _t2 = new V3(), _t3 = new V3(), _P = new V3();

  // out = I^-1 * vec  (diagonal inertia in the body frame)
  function invIApply(b, vec, out) {
    out.copy(vec).applyQuaternion(_qi).multiply(b.invI).applyQuaternion(b.q);
    return out;
  }

  // 1 / m + ( (I^-1 (r x d)) x r ) . d      (m = 1)
  function effMass(b, r, d) {
    _t1.crossVectors(r, d);
    invIApply(b, _t1, _t2);
    _t3.crossVectors(_t2, r);
    return 1 + _t3.dot(d);
  }

  function applyImpulse(b, r, P) {
    b.v.add(P);
    _t1.crossVectors(r, P);
    invIApply(b, _t1, _t2);
    b.w.add(_t2);
  }

  const NY = new V3(0, 1, 0), NX = new V3(1, 0, 0), NZ = new V3(0, 0, 1);

  function contacts(b, h) {
    const n = b.nc;
    let any = false, maxDepth = 0, impact = 0;
    for (let i = 0; i < n; i++) {
      if (b.shape === 'sphere') _r[i].set(0, -b.R, 0); else _r[i].copy(b.corners[i]).applyQuaternion(b.q);
      const dep = -(b.p.y + _r[i].y);
      _depth[i] = dep;
      if (dep > 0) {
        _act[i] = 1; any = true;
        if (dep > maxDepth) maxDepth = dep;
        _u.crossVectors(b.w, _r[i]).add(b.v);
        _vn0[i] = _u.y; _jn[i] = 0; _jtx[i] = 0; _jtz[i] = 0;
        if (-_u.y > impact) impact = -_u.y;
      } else _act[i] = 0;
    }
    b.contact = any;
    if (!any) return;
    _qi.copy(b.q).invert();
    const mu = b.cfg.mu, e = b.cfg.e;
    for (let it = 0; it < 5; it++) {
      for (let i = 0; i < n; i++) {
        if (!_act[i]) continue;
        const r = _r[i];
        // normal
        _u.crossVectors(b.w, r).add(b.v);
        const target = _vn0[i] < -1.3 ? -e * _vn0[i] : 0;
        let j = (target - _u.y) / effMass(b, r, NY);
        const acc = Math.max(0, _jn[i] + j);
        j = acc - _jn[i]; _jn[i] = acc;
        if (j !== 0) { _P.set(0, j, 0); applyImpulse(b, r, _P); }
        // friction (two tangents), clamped by the Coulomb cone of the accumulated normal impulse
        const lim = mu * _jn[i];
        _u.crossVectors(b.w, r).add(b.v);
        let jx = -_u.x / effMass(b, r, NX);
        let nx = clamp(_jtx[i] + jx, -lim, lim); jx = nx - _jtx[i]; _jtx[i] = nx;
        if (jx !== 0) { _P.set(jx, 0, 0); applyImpulse(b, r, _P); }
        _u.crossVectors(b.w, r).add(b.v);
        let jz = -_u.z / effMass(b, r, NZ);
        const nz = clamp(_jtz[i] + jz, -lim, lim); jz = nz - _jtz[i]; _jtz[i] = nz;
        if (jz !== 0) { _P.set(0, 0, jz); applyImpulse(b, r, _P); }
      }
    }
    b.p.y += maxDepth;                                      // project out of the ground: never sinks in
    // contact damping (rolling resistance, scrubbing)
    const ad = Math.max(0, 1 - b.cfg.angDamp * h), ld = Math.max(0, 1 - b.cfg.linDamp * h);
    b.w.multiplyScalar(ad); b.v.x *= ld; b.v.z *= ld;
    if (impact > 1.6 && b.clangCd <= 0) {
      b.clangCd = 0.16;
      guard(function () {
        if (window.Sfx && Sfx.clang && (b.kind !== 'helmet' || impact > 2.2)) Sfx.clang(b.p);
        if (impact > 3.2 && window.FX && FX.dust) FX.dust(new V3(b.p.x, 0.02, b.p.z), UP, 0.35);
      }, 'impact fx');
    }
  }

  function stepBody(b, h) {
    const v = b.v, w = b.w, p = b.p, q = b.q;
    v.y -= GRAVITY * h;
    const drag = 1 - 0.04 * h;
    v.multiplyScalar(drag);
    p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    _wq.set(w.x, w.y, w.z, 0).multiply(q);
    q.x += 0.5 * h * _wq.x; q.y += 0.5 * h * _wq.y; q.z += 0.5 * h * _wq.z; q.w += 0.5 * h * _wq.w;
    q.normalize();
    if (b.clangCd > 0) b.clangCd -= h;
    contacts(b, h);
    // sleep: in contact and (almost) not moving for a short while -> settle flat
    if (b.contact && v.lengthSq() < 0.0036 && w.lengthSq() < 0.05) b.rest += h; else b.rest = 0;
    if (b.rest > 0.18 || b.age > 7) trySettle(b);
  }

  // Snap to a clean resting pose: the face that points down becomes exactly flat on the ground.
  function trySettle(b) {
    let restY = b.R;
    b.q0 = b.q.clone(); b.q1 = b.q.clone();
    if (b.shape === 'box') {
      let best = -1, bestAbs = 0, sign = 1;
      for (let k = 0; k < 3; k++) {
        _a.set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(b.q);
        const ay = Math.abs(_a.y);
        if (ay > bestAbs) { bestAbs = ay; best = k; sign = _a.y >= 0 ? 1 : -1; _b.copy(_a).multiplyScalar(sign); }
      }
      if (bestAbs < 0.82 && b.age < 7) { b.rest = -0.4; return false; }   // propped on an edge: keep simulating
      _qs.setFromUnitVectors(_b, UP);
      b.q1.copy(_qs).multiply(b.q).normalize();
      restY = best === 0 ? b.he.x : (best === 1 ? b.he.y : b.he.z);
    }
    b.v.set(0, 0, 0); b.w.set(0, 0, 0);
    b.asleep = true;
    b.restY = restY;
    b.y0 = b.p.y; b.y1 = restY;
    b.settleT = 0; b.settleDur = 0.16;
    return true;
  }

  function syncHolder(b) {
    b.holder.position.copy(b.p);
    b.holder.quaternion.copy(b.q);
  }

  // ---------------------------------------------------------------------------------------------------------------- disposal
  function probeOf(assetName) {
    let pr = probes[assetName];
    if (pr) return pr;
    pr = { mats: new Set(), geos: new Set() };
    probes[assetName] = pr;
    guard(function () {
      const g = window.Assets && Assets.get ? Assets.get(assetName, { raw: true }) : null;
      if (!g) return;
      g.traverse(function (o) {
        if (!o.isMesh) return;
        if (o.geometry) pr.geos.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m) pr.mats.add(m); });
      });
    }, 'probe');
    return pr;
  }

  // names of the Assets wrappers inside a prop (Assets.get() tags each wrapper with userData.asset)
  function assetNames(prop) {
    const names = [];
    prop.traverse(function (o) { const a = o.userData && o.userData.asset; if (a && names.indexOf(a) < 0) names.push(a); });
    return names;
  }

  // dispose what the prop owns exclusively (per-instance materials / geometry). Resources shared with the Assets cache stay.
  function disposeProp(b) {
    const probesOf = b.assets.map(probeOf);
    const shared = function (set, x) { for (let i = 0; i < probesOf.length; i++) if (probesOf[i][set].has(x)) return true; return false; };
    b.prop.traverse(function (o) {
      if (!o.isMesh) return;
      if (o.geometry && !shared('geos', o.geometry)) o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        if (m && !shared('mats', m)) m.dispose();
      });
    });
  }

  function removeBody(b) {
    if (b.holder.parent) b.holder.parent.remove(b.holder);
    b.holder.remove(b.prop);
    disposeProp(b);
  }

  // ---------------------------------------------------------------------------------------------------------------- update
  function installDebug() {
    if (dbgInstalled || !window.__dbg) return;
    dbgInstalled = true;
    window.__dbg.combat = {
      stats: function () { return stats(); },
      props: function () {
        return props.map(function (b) {
          return { kind: b.kind, p: [b.p.x, b.p.y, b.p.z].map(function (x) { return Math.round(x * 1000) / 1000; }),
            speed: Math.round(b.v.length() * 1000) / 1000, spin: Math.round(b.w.length() * 1000) / 1000, asleep: b.asleep,
            age: Math.round(b.age * 100) / 100, he: [b.he.x, b.he.y, b.he.z].map(function (x) { return Math.round(x * 1000) / 1000; }) };
        });
      }
    };
  }

  function update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    if (!dbgInstalled) installDebug();

    if (kbWatch.size) stepKnockback(dt);

    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      t.t -= dt;
      if (t.t <= 0) { tasks.splice(i, 1); guard(t.fn, 'delayed effect'); }
    }

    for (let i = props.length - 1; i >= 0; i--) {
      const b = props[i];
      b.age += dt;
      if (!b.asleep) {
        b.acc += dt;
        let steps = 0;
        while (b.acc >= STEP && steps < MAX_STEPS && !b.asleep) { stepBody(b, STEP); b.acc -= STEP; steps++; }
        if (steps >= MAX_STEPS) b.acc = 0;
      } else if (b.settleT < b.settleDur) {                 // short ease into the exact resting pose
        b.settleT = Math.min(b.settleDur, b.settleT + dt);
        const k = b.settleT / b.settleDur, e = k * k * (3 - 2 * k);
        b.q.copy(b.q0).slerp(b.q1, e);
        b.p.y = b.y0 + (b.y1 - b.y0) * e;
      }
      let done = false;
      if (b.age > LIFE) {                                   // lifetime over: sink into the grass, then remove
        if (!b.asleep) { b.v.set(0, 0, 0); b.w.set(0, 0, 0); b.asleep = true; b.settleT = b.settleDur; b.restY = b.p.y; }
        b.sink += dt * (b.fast ? 4 : 1) / SINK_TIME;
        if (b.sink >= 1) done = true;
        else { const k = b.sink; b.holder.position.set(b.p.x, b.p.y - b.sinkTotal * k * k * (3 - 2 * k), b.p.z); b.holder.quaternion.copy(b.q); continue; }
      }
      if (done) { removeBody(b); props.splice(i, 1); continue; }
      syncHolder(b);
    }
  }

  function clear() {
    for (let i = 0; i < props.length; i++) removeBody(props[i]);
    props.length = 0;
    tasks.length = 0;
    kbWatch.clear();
  }

  function stats() {
    let awake = 0;
    for (let i = 0; i < props.length; i++) if (!props[i].asleep) awake++;
    return { props: props.length, awake: awake, tasks: tasks.length, spawned: propsSpawned };
  }

  // world-space description of the zones of an enemy (debug / QA drawing)
  function zoneShapes(enemy) {
    const rig = rigOf(enemy);
    const out = { s: rig.s, H: rig.H, bones: rig.bones, head: null, torso: null, arms: [], legs: [], pelvisY: null };
    if (!rig.bones) return out;
    const s = rig.s;
    worldPos(rig.head, _a);
    if (rig.neck && rig.neck !== rig.head) { worldPos(rig.neck, _b); _up.subVectors(_a, _b); } else _up.set(0, 0, 0);
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();
    out.head = { c: _hc.copy(_a).addScaledVector(_up, HEAD_UP * s).toArray(), r: HEAD_R * s };
    worldPos(rig.hips, _c);
    const top = (rig.neck && rig.neck !== rig.hips) ? worldPos(rig.neck, _d) : _a;
    out.torso = { a: _c.toArray(), b: top.toArray(), r: TORSO_R * s };
    out.pelvisY = _c.y - PELVIS_DROP * s;
    rig.arms.forEach(function (ch) { out.arms.push({ pts: ch.map(function (o) { return worldPos(o, new V3()).toArray(); }), r: ARM_R * s }); });
    rig.legs.forEach(function (ch) { out.legs.push({ pts: ch.map(function (o) { return worldPos(o, new V3()).toArray(); }), r: LEG_R * s }); });
    return out;
  }

  window.Combat = {
    zoneFor: zoneFor,
    damageFor: damageFor,
    onHit: function (enemy, hit, dir) { return guard(function () { return onHit(enemy, hit, dir); }, 'onHit') || 'hit'; },
    onKill: function (enemy, hit, dir) { return guard(function () { return onKill(enemy, hit, dir); }, 'onKill') || 'kill'; },
    update: update,
    clear: clear,
    stats: stats,
    zoneShapes: zoneShapes,
    props: props,
    DAMAGE: DAMAGE
  };
})();
