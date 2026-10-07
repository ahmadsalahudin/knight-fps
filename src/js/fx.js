/* fx.js — window.FX: pooled particles, tracers, decals, blood pools, camera shake.   (Worker B3, docs/FIX_PLAN.md section 3)

   Contract (all optional-arg, all safe to call before init: they simply do nothing):
     FX.init(scene, camera)          build pools + meshes (called once from main.js after World.build)
     FX.update(dt)                   advance everything by dt seconds (dt-driven only: no timers, no performance.now)
     FX.sparks(point, normal, count?)  metal-on-armor hit: additive hot streaks with gravity + a short flash   (default 12)
     FX.blood(point, dir, amount?)     blood spray: dark drops with gravity (leave small splat decals on the ground) + a thin mist (default 10)
     FX.dust(point, normal, scale?)    ground / tree / rock impact: tan puffs + a few debris chips
     FX.smoke(point, dir?, scale?)     muzzle smoke: a few soft grey puffs that drift along dir and rise
     FX.tracer(from, to)             bright travelling streak (+ faint air trail), ~0.05-0.3 s
     FX.bloodPool(position, radius)  ground decal (y = 0): grows to `radius` over ~3 s, stays ~1 s, fades out by ~22 s
     FX.impactDecal(point, normal)   small dark bullet mark on a world surface (fades after ~40 s)
     FX.shake(amount)                add camera trauma; amount ~0.02-0.1 = gunshot, ~0.3 = player hit, ~1 = boss slam
     FX.shakeOffset                  THREE.Vector3, recomputed in FX.update, absolute offset (zero when idle). Game adds it to the camera
                                     position after movement (camera.position.add(FX.shakeOffset) on top of the un-shaken base position)
   Extras: FX.stats() -> active counts, FX.clear() -> remove every effect. With ?debug=1 init() also installs
   __dbg.fx = { demo, sparks, blood, dust, smoke, tracer, pool, decal, shake, stats, clear }.

   Everything is allocation-free per call: effects write into preallocated typed arrays and InstancedBufferGeometry
   attributes (one draw call per pool), materials are shared ShaderMaterials. `point` / `dir` / `normal` may be
   THREE.Vector3 or any {x,y,z}. Colours are display (sRGB-looking) values: the shaders write them as-is. */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const rnd = Math.random;
  const GROUND = 0.015;            // particles rest / die at this height (world ground is y = 0)

  // ------------------------------------------------------------------------------------------------ shaders
  const NOISE_GLSL = [
    'float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}'
  ].join('\n');

  // Camera-facing billboards (smoke, dust, flashes) and velocity-aligned streaks (sparks, blood drops, chips).
  const PARTICLE_VS = [
    'attribute vec4 iPosSize;   // xyz world position, w size (billboard diameter / streak width)',
    'attribute vec4 iVelRot;    // xyz velocity (streak direction), w billboard rotation',
    'attribute vec4 iColor;     // rgba',
    'attribute vec2 iParams;    // x streak length per unit speed (0 = billboard), y noise seed (<0 = smooth disc)',
    'varying vec4 vColor; varying vec2 vUv; varying vec2 vC; varying float vStreak; varying float vSeed;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vec4 mvPosition = viewMatrix * vec4(iPosSize.xyz, 1.0);',
    '  float size = iPosSize.w;',
    '  float stretch = iParams.x;',
    '  float depth = -mvPosition.z;',
    '  float fade = smoothstep(0.08, 0.35, depth);',
    '  vec2 off;',
    '  if (stretch > 0.0) {',
    '    vec3 vv = (viewMatrix * vec4(iVelRot.xyz, 0.0)).xyz;',
    '    float l2 = length(vv.xy);',
    '    vec2 dir = l2 > 1e-4 ? vv.xy / l2 : vec2(1.0, 0.0);',
    '    vec2 perp = vec2(-dir.y, dir.x);',
    '    float len = clamp(stretch * l2, size * 1.5, 2.5);',
    '    off = dir * ((position.x - 1.0) * 0.5 * len) + perp * (position.y * 0.5 * size);',
    '    vUv = position.xy; vStreak = 1.0;',
    '  } else {',
    '    float c = cos(iVelRot.w), s = sin(iVelRot.w);',
    '    vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);',
    '    off = q * (0.5 * size);',
    '    vUv = q; vStreak = 0.0;',
    '    fade *= 1.0 - smoothstep(0.5, 1.2, size / max(depth, 0.05));',   // never let a puff swallow the screen
    '  }',
    '  vC = position.xy; vSeed = iParams.y;',
    '  vColor = vec4(iColor.rgb, iColor.a * fade);',
    '  mvPosition.xy += off;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  const PARTICLE_FS = [
    'uniform float uHot;     // 0..1: streak head blends to white',
    'uniform float uShade;   // 0..1: billboards are slightly lighter on top (fake puff lighting)',
    'varying vec4 vColor; varying vec2 vUv; varying vec2 vC; varying float vStreak; varying float vSeed;',
    NOISE_GLSL,
    '#include <fog_pars_fragment>',
    'void main() {',
    '  float a; vec3 col = vColor.rgb;',
    '  if (vStreak > 0.5) {',
    '    float across = 1.0 - vUv.y * vUv.y; across *= across;',
    '    float along = smoothstep(-1.0, 0.7, vUv.x);',
    '    float cap = 1.0 - smoothstep(0.75, 1.0, vUv.x + 0.25 * vUv.y * vUv.y);',
    '    a = across * along * cap;',
    '    col = mix(col, vec3(1.0), uHot * along * along * across);',
    '  } else {',
    '    float r = length(vUv);',
    '    if (vSeed >= 0.0) {',
    '      float n = vnoise(vUv * 2.4 + vSeed * 37.0) * 0.65 + vnoise(vUv * 5.3 - vSeed * 13.0) * 0.35;',
    '      r += (n - 0.5) * 0.5;',
    '    }',
    '    a = 1.0 - smoothstep(0.08, 1.0, r);',
    '    a = a * (0.55 + 0.45 * a);',
    '    col *= 1.0 + uShade * 0.22 * (vC.y * 0.8 - vC.x * 0.25);',
    '  }',
    '  a *= vColor.a;',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(col, a);',
    '  #include <fog_fragment>',
    '}'
  ].join('\n');

  // Tracers: ribbons from iA.xyz (tail) to iB.xyz (head), turned towards the camera, never thinner than ~3 px.
  const TRACER_VS = [
    'attribute vec4 iA;   // xyz tail, w half width (world)',
    'attribute vec4 iB;   // xyz head, w alpha',
    'varying vec2 vUv; varying float vAlpha;',
    'void main() {',
    '  vec3 A = iA.xyz, B = iB.xyz;',
    '  vec3 p = mix(A, B, position.x);',
    '  vec3 toCam = cameraPosition - p;',
    '  vec3 side = cross(B - A, toCam);',
    '  float sl = length(side);',
    '  side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);',
    '  float w = max(iA.w, length(toCam) * 0.0032);',
    '  p += side * (position.y * w);',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
    '  vUv = position.xy; vAlpha = iB.w;',
    '}'
  ].join('\n');

  const TRACER_FS = [
    'uniform vec3 uColor;',
    'varying vec2 vUv; varying float vAlpha;',
    'void main() {',
    '  float across = 1.0 - vUv.y * vUv.y; across *= across;',
    '  float along = smoothstep(0.0, 1.0, vUv.x);',
    '  float a = across * along * vAlpha;',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), across * across * along), a);',
    '}'
  ].join('\n');

  // Ground / wall decals: instanced quads spanned by tangent + bitangent. BLOOD = organic blot, BULLET = scorch + cracks.
  const DECAL_VS = [
    'attribute vec4 iCenter;  // xyz centre, w half size',
    'attribute vec4 iTan;     // xyz tangent, w alpha',
    'attribute vec4 iBit;     // xyz bitangent, w seed',
    'varying vec2 vUv; varying float vAlpha; varying float vSeed;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vec3 wp = iCenter.xyz + (iTan.xyz * position.x + iBit.xyz * position.y) * iCenter.w;',
    '  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  vUv = position.xy; vAlpha = iTan.w; vSeed = iBit.w;',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  const DECAL_FS_HEAD = [
    'varying vec2 vUv; varying float vAlpha; varying float vSeed;',
    NOISE_GLSL,
    '#include <fog_pars_fragment>'
  ].join('\n');

  const BLOOD_FS = DECAL_FS_HEAD + '\n' + [
    'void main() {',
    '  float r = length(vUv);',
    '  float ang = atan(vUv.y, vUv.x);',
    '  float edge = 0.74 + 0.10 * sin(ang * 3.0 + vSeed * 6.283) + 0.07 * sin(ang * 5.0 + vSeed * 17.0) + 0.05 * sin(ang * 9.0 + vSeed * 40.0);',
    '  edge += (vnoise(vUv * 4.5 + vSeed * 20.0) - 0.5) * 0.18;',
    '  float a = 1.0 - smoothstep(edge - 0.07, edge, r);',
    '  if (a < 0.01) discard;',
    '  float k = smoothstep(0.0, edge, r);',
    '  vec3 col = mix(vec3(0.20, 0.010, 0.010), vec3(0.38, 0.025, 0.020), k);',
    '  float mottle = vnoise(vUv * 7.0 + vSeed * 9.0);',
    '  col *= 0.8 + 0.4 * mottle;',
    '  float sheen = pow(max(0.0, 1.0 - length(vUv - vec2(-0.25, 0.3)) * 1.6), 3.0) * 0.25;',
    '  col += vec3(0.55, 0.12, 0.10) * sheen;',
    '  gl_FragColor = vec4(col, a * vAlpha * 0.93);',
    '  #include <fog_fragment>',
    '}'
  ].join('\n');

  const BULLET_FS = DECAL_FS_HEAD + '\n' + [
    'void main() {',
    '  float r = length(vUv);',
    '  float ang = atan(vUv.y, vUv.x);',
    '  float jitter = (vnoise(vUv * 6.0 + vSeed * 9.0) - 0.5);',
    '  float core = 1.0 - smoothstep(0.10, 0.21, r + jitter * 0.12);',
    '  float halo = (1.0 - smoothstep(0.12, 0.95, r + jitter * 0.45)) * 0.5;',
    '  float spokes = pow(abs(sin(ang * 4.0 + vSeed * 6.283)), 18.0) * (1.0 - smoothstep(0.2, 0.9, r)) * 0.28;',
    '  float a = max(core * 0.95, halo + spokes);',
    '  if (a < 0.01) discard;',
    '  vec3 col = mix(vec3(0.10, 0.085, 0.07), vec3(0.015), core);',
    '  gl_FragColor = vec4(col, a * vAlpha);',
    '  #include <fog_fragment>',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------------------------------------ helpers
  function instAttr(count, size) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
    if (a.setUsage) a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }
  function makeQuad(x0) {   // position.xy is the quad coordinate used by the shaders (x0 = -1 for centred quads, 0 for tracers)
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, -1, 0, 1, -1, 0, 1, 1, 0, x0, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = 0;
    return g;
  }
  function makeMesh(geom, mat, order) {
    const m = new THREE.Mesh(geom, mat);
    m.frustumCulled = false;
    m.castShadow = false; m.receiveShadow = false;
    m.renderOrder = order;
    m.visible = false;
    return m;
  }
  function fogUniforms(extra) { return THREE.UniformsUtils.merge([THREE.UniformsLib.fog, extra]); }
  function flush(attr, n) {      // upload only the live part of an instance buffer
    if (attr.updateRange) { attr.updateRange.offset = 0; attr.updateRange.count = n * attr.itemSize; }
    attr.needsUpdate = true;
  }

  // scratch values for basis / direction math (no per-call allocation)
  let nx = 0, ny = 1, nz = 0, tx = 1, ty = 0, tz = 0, bx = 0, by = 0, bz = 1;
  function setNormal(v, dx, dy, dz) {   // normalise v (or fall back to the default) into nx,ny,nz
    let x = dx, y = dy, z = dz;
    if (v) { x = +v.x || 0; y = +v.y || 0; z = +v.z || 0; if (x === 0 && y === 0 && z === 0) { x = dx; y = dy; z = dz; } }
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    nx = x / l; ny = y / l; nz = z / l;
  }
  function makeBasis() {                // tangent / bitangent perpendicular to n (tx.. , bx..)
    if (Math.abs(ny) < 0.95) { tx = nz; ty = 0; tz = -nx; } else { tx = 1; ty = 0; tz = 0; }
    let l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; tx /= l; ty /= l; tz /= l;
    bx = ny * tz - nz * ty; by = nz * tx - nx * tz; bz = nx * ty - ny * tx;
    l = Math.sqrt(bx * bx + by * by + bz * bz) || 1; bx /= l; by /= l; bz /= l;
  }
  function rotateBasis(a) {             // spin the tangent frame around n by angle a
    const c = Math.cos(a), s = Math.sin(a);
    const ox = tx, oy = ty, oz = tz;
    tx = ox * c + bx * s; ty = oy * c + by * s; tz = oz * c + bz * s;
    bx = bx * c - ox * s; by = by * c - oy * s; bz = bz * c - oz * s;
  }

  // ------------------------------------------------------------------------------------------------ particle pool
  // Per-particle state lives in one Float32Array (stride PS); live particles are kept packed (swap-remove).
  const PS = 26;
  const F = { X: 0, Y: 1, Z: 2, VX: 3, VY: 4, VZ: 5, AGE: 6, LIFE: 7, S0: 8, S1: 9, ROT: 10, ROTV: 11,
    R0: 12, G0: 13, B0: 14, A0: 15, R1: 16, G1: 17, B1: 18, A1: 19, GRAV: 20, DRAG: 21, MODE: 22, STRETCH: 23, SEED: 24 };
  // MODE: 0 free flight, 1 rest on the ground, 2 bounce, 3 die on the ground, 4 die on the ground and splat blood

  function Particles(max, material, order) {
    this.max = max; this.n = 0; this.cursor = 0;
    this.S = new Float32Array(max * PS);
    this.geom = makeQuad(-1);
    this.aPos = instAttr(max, 4); this.aVel = instAttr(max, 4); this.aCol = instAttr(max, 4); this.aPar = instAttr(max, 2);
    this.geom.setAttribute('iPosSize', this.aPos); this.geom.setAttribute('iVelRot', this.aVel);
    this.geom.setAttribute('iColor', this.aCol); this.geom.setAttribute('iParams', this.aPar);
    this.mesh = makeMesh(this.geom, material, order);
    this.onGround = null;
  }
  Particles.prototype.emit = function (px, py, pz, vx, vy, vz, life, s0, s1, rot, rotv,
                                       r0, g0, b0, a0, r1, g1, b1, a1, grav, drag, mode, stretch, seed) {
    let i;
    if (this.n < this.max) i = this.n++;
    else { i = this.cursor; this.cursor = (this.cursor + 1) % this.max; }   // full: recycle (approximately the oldest)
    const S = this.S, o = i * PS;
    S[o] = px; S[o + 1] = py; S[o + 2] = pz; S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
    S[o + 6] = 0; S[o + 7] = life; S[o + 8] = s0; S[o + 9] = s1; S[o + 10] = rot; S[o + 11] = rotv;
    S[o + 12] = r0; S[o + 13] = g0; S[o + 14] = b0; S[o + 15] = a0;
    S[o + 16] = r1; S[o + 17] = g1; S[o + 18] = b1; S[o + 19] = a1;
    S[o + 20] = grav; S[o + 21] = drag; S[o + 22] = mode; S[o + 23] = stretch; S[o + 24] = seed;
  };
  Particles.prototype.update = function (dt) {
    const S = this.S, pa = this.aPos.array, va = this.aVel.array, ca = this.aCol.array, qa = this.aPar.array;
    let i = 0;
    while (i < this.n) {
      const o = i * PS;
      const age = S[o + 6] + dt, life = S[o + 7];
      let dead = age >= life;
      let x = S[o], y = S[o + 1], z = S[o + 2], vx = S[o + 3], vy = S[o + 4], vz = S[o + 5];
      if (!dead && dt > 0) {
        const k = Math.max(0, 1 - S[o + 21] * dt);
        vx *= k; vy *= k; vz *= k;
        vy -= S[o + 20] * dt;
        x += vx * dt; y += vy * dt; z += vz * dt;
        const mode = S[o + 22];
        if (mode !== 0 && y < GROUND) {
          if (mode === 1) { y = GROUND; if (vy < 0) vy = 0; vx *= 0.9; vz *= 0.9; }
          else if (mode === 2) { y = GROUND; if (vy < 0) vy = -vy * 0.38; vx *= 0.65; vz *= 0.65; }
          else { if (mode === 4 && this.onGround) this.onGround(x, z, vx, vz); dead = true; }
        }
      }
      if (dead) {   // swap-remove: pull the last live particle into this slot and re-process the slot
        const last = --this.n;
        if (i !== last) {
          const lo = last * PS;
          for (let j = 0; j < PS; j++) S[o + j] = S[lo + j];
        }
        continue;
      }
      S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz; S[o + 6] = age;
      const t = age / life, e = 1 - (1 - t) * (1 - t);
      const rot = S[o + 10] + S[o + 11] * dt; S[o + 10] = rot;
      let a = S[o + 15] + (S[o + 19] - S[o + 15]) * t;
      if (S[o + 23] === 0 && life > 0.2 && age < 0.06) a *= age / 0.06;   // puffs fade in instead of popping
      const q = i * 4;
      pa[q] = x; pa[q + 1] = y; pa[q + 2] = z; pa[q + 3] = S[o + 8] + (S[o + 9] - S[o + 8]) * e;
      va[q] = vx; va[q + 1] = vy; va[q + 2] = vz; va[q + 3] = rot;
      ca[q] = S[o + 12] + (S[o + 16] - S[o + 12]) * t;
      ca[q + 1] = S[o + 13] + (S[o + 17] - S[o + 13]) * t;
      ca[q + 2] = S[o + 14] + (S[o + 18] - S[o + 14]) * t;
      ca[q + 3] = a;
      qa[i * 2] = S[o + 23]; qa[i * 2 + 1] = S[o + 24];
      i++;
    }
    const n = this.n;
    this.mesh.visible = n > 0;
    this.geom.instanceCount = n;
    if (n > 0) { flush(this.aPos, n); flush(this.aVel, n); flush(this.aCol, n); flush(this.aPar, n); }
  };
  Particles.prototype.clear = function () { this.n = 0; this.cursor = 0; this.mesh.visible = false; this.geom.instanceCount = 0; };

  // ------------------------------------------------------------------------------------------------ decal pool
  // Ring buffer of quads; a slot is free when its half size is 0. Size grows with an ease-out, alpha fades out smoothly.
  const DS = 8;   // age, life, R, growT, fadeStart, startFrac
  function Decals(max, material, order) {
    this.max = max; this.cursor = 0; this.active = 0;
    this.S = new Float32Array(max * DS);
    this.geom = makeQuad(-1);
    this.aCen = instAttr(max, 4); this.aTan = instAttr(max, 4); this.aBit = instAttr(max, 4);
    this.geom.setAttribute('iCenter', this.aCen); this.geom.setAttribute('iTan', this.aTan); this.geom.setAttribute('iBit', this.aBit);
    this.geom.instanceCount = max;
    this.mesh = makeMesh(this.geom, material, order);
  }
  Decals.prototype.spawn = function (cx, cy, cz, R, growT, fadeStart, life, startFrac, seed) {
    // tangent frame comes from the module scratch (tx.. bx..)
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    const S = this.S, o = i * DS;
    if (S[o + 1] <= 0) this.active++;       // slot was free
    S[o] = 0; S[o + 1] = life; S[o + 2] = R; S[o + 3] = Math.max(growT, 1e-3); S[o + 4] = fadeStart; S[o + 5] = startFrac;
    const q = i * 4, c = this.aCen.array, t = this.aTan.array, b = this.aBit.array;
    c[q] = cx; c[q + 1] = cy; c[q + 2] = cz; c[q + 3] = R * startFrac;
    t[q] = tx; t[q + 1] = ty; t[q + 2] = tz; t[q + 3] = 0;
    b[q] = bx; b[q + 1] = by; b[q + 2] = bz; b[q + 3] = seed;
    this.mesh.visible = true;
  };
  Decals.prototype.update = function (dt) {
    if (this.active <= 0) return;
    const S = this.S, c = this.aCen.array, t = this.aTan.array;
    for (let i = 0; i < this.max; i++) {
      const o = i * DS;
      const life = S[o + 1];
      if (life <= 0) continue;
      const age = S[o] + dt;
      const q = i * 4;
      if (age >= life) { S[o + 1] = 0; c[q + 3] = 0; t[q + 3] = 0; this.active--; continue; }
      S[o] = age;
      const g = Math.min(1, age / S[o + 3]), e = 1 - (1 - g) * (1 - g) * (1 - g);
      const sf = S[o + 5];
      c[q + 3] = S[o + 2] * (sf + (1 - sf) * e);
      let a = Math.min(1, age / 0.05);
      const fs = S[o + 4];
      if (age > fs) { const f = (age - fs) / Math.max(life - fs, 1e-3); a *= 1 - f * f * (3 - 2 * f); }
      t[q + 3] = a;
    }
    flush(this.aCen, this.max); flush(this.aTan, this.max);
    if (this.active <= 0) this.mesh.visible = false;
  };
  Decals.prototype.clear = function () {
    this.S.fill(0); this.aCen.array.fill(0); this.aTan.array.fill(0); this.active = 0; this.cursor = 0;
    flush(this.aCen, this.max); flush(this.aTan, this.max); this.mesh.visible = false;
  };

  // ------------------------------------------------------------------------------------------------ tracer pool
  // Each tracer owns two ribbon slots: [2k] the travelling hot head (a short bright segment), [2k+1] a faint air trail.
  const TS = 10;   // fx,fy,fz, dx,dy,dz, dist, age, life, trailLife
  const TRACER_SPEED = 260, TRACER_SEG = 3.5, TRACER_MAX = 16;
  const tr = { max: TRACER_MAX, S: new Float32Array(TRACER_MAX * TS), n: 0, cursor: 0 };

  // ------------------------------------------------------------------------------------------------ state
  let ready = false;
  let sceneRef = null, cameraRef = null;
  let normP = null, addP = null, splatD = null, poolD = null, bulletD = null;
  let tracerGeom = null, tracerMesh = null, tracerA = null, tracerB = null;
  let materials = [];
  let trauma = 0, shakeT = 0;

  function disposeAll() {
    if (!ready) return;
    const meshes = [normP.mesh, addP.mesh, splatD.mesh, poolD.mesh, bulletD.mesh, tracerMesh];
    for (const m of meshes) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
    for (const m of materials) m.dispose();
    materials = []; ready = false;
  }

  function init(scene, camera) {
    disposeAll();
    sceneRef = scene; cameraRef = camera;

    const normMat = new THREE.ShaderMaterial({
      uniforms: fogUniforms({ uHot: { value: 0 }, uShade: { value: 1 } }),
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.NormalBlending, fog: true
    });
    const addMat = new THREE.ShaderMaterial({
      uniforms: fogUniforms({ uHot: { value: 0.7 }, uShade: { value: 0 } }),
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false
    });
    const decalOpts = { transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, vertexShader: DECAL_VS };
    const bloodMat = new THREE.ShaderMaterial(Object.assign({ uniforms: fogUniforms({}), fragmentShader: BLOOD_FS }, decalOpts));
    const bulletMat = new THREE.ShaderMaterial(Object.assign({ uniforms: fogUniforms({}), fragmentShader: BULLET_FS }, decalOpts));
    const tracerMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.78, 0.38) } },
      vertexShader: TRACER_VS, fragmentShader: TRACER_FS,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false
    });
    materials = [normMat, addMat, bloodMat, bulletMat, tracerMat];

    // draw order: decals, then soft particles, then additive sparks, then tracers
    poolD = new Decals(24, bloodMat, 1);       // blood pools
    splatD = new Decals(72, bloodMat, 1);      // tiny blood splats where drops land
    bulletD = new Decals(64, bulletMat, 1);    // bullet marks
    normP = new Particles(420, normMat, 2);
    addP = new Particles(260, addMat, 3);
    normP.onGround = bloodSplat;

    tracerGeom = makeQuad(0);
    tracerA = instAttr(TRACER_MAX * 2, 4); tracerB = instAttr(TRACER_MAX * 2, 4);
    tracerGeom.setAttribute('iA', tracerA); tracerGeom.setAttribute('iB', tracerB);
    tracerMesh = makeMesh(tracerGeom, tracerMat, 4);
    tr.S.fill(0); tr.n = 0; tr.cursor = 0;

    for (const m of [poolD.mesh, splatD.mesh, bulletD.mesh, normP.mesh, addP.mesh, tracerMesh]) scene.add(m);
    trauma = 0; shakeT = 0; FX.shakeOffset.set(0, 0, 0);
    ready = true;
    installDebug();
  }

  // ------------------------------------------------------------------------------------------------ effects
  function bloodSplat(x, z, vx, vz) {
    if (rnd() > 0.4) return;
    setNormal(null, 0, 1, 0); makeBasis(); rotateBasis(rnd() * TAU);
    const r = 0.025 + rnd() * 0.05;
    splatD.spawn(x, 0.011, z, r, 0.1, 9, 14, 0.5, rnd());
  }

  function sparks(point, normal, count) {
    if (!ready || !point) return;
    const n = count === undefined ? 12 : Math.max(0, Math.min(40, count | 0));
    setNormal(normal, 0, 1, 0); makeBasis();
    const px = point.x + nx * 0.02, py = point.y + ny * 0.02, pz = point.z + nz * 0.02;
    // hot flash at the impact point
    addP.emit(px, py, pz, 0, 0, 0, 0.08, 0.40, 0.14, 0, 0, 1, 0.88, 0.55, 0.95, 1, 0.6, 0.2, 0, 0, 0, 0, 0, -1);
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * 1.05, h = 0.3 + rnd() * 0.7;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      const sp = 2.2 + rnd() * 7.5;
      const life = 0.22 + rnd() * 0.42;
      addP.emit(px, py, pz,
        (nx * h + tx * ca + bx * sa) * sp, (ny * h + ty * ca + by * sa) * sp, (nz * h + tz * ca + bz * sa) * sp,
        life, 0.04 + rnd() * 0.025, 0.022, 0, 0,
        1, 0.86 - rnd() * 0.2, 0.5 - rnd() * 0.2, 1, 1, 0.34, 0.06, 0,
        9.8, 0.7, 2, 0.028, -1);
    }
  }

  function blood(point, dir, amount) {
    if (!ready || !point) return;
    const n = amount === undefined ? 10 : Math.max(0, Math.min(40, amount | 0));
    setNormal(dir, 0, 0, -1);
    const dx = nx, dy = ny, dz = nz;
    for (let i = 0; i < n; i++) {
      const back = rnd() < 0.25;                       // some blood splashes back towards the shooter
      const sp = back ? 0.8 + rnd() * 2.0 : 1.5 + rnd() * 5.5;
      const sgn = back ? -1 : 1;
      const jx = rnd() * 2 - 1, jy = rnd() * 2 - 1, jz = rnd() * 2 - 1;
      const sz = 0.03 + rnd() * 0.03;
      normP.emit(point.x, point.y, point.z,
        dx * sp * sgn + jx * 1.6, dy * sp * sgn + jy * 1.6 + rnd() * 1.6, dz * sp * sgn + jz * 1.6,
        1.4, sz, sz, 0, 0,
        0.62 + rnd() * 0.1, 0.03, 0.03, 1, 0.38, 0.02, 0.02, 1,
        12, 0.15, 4, 0.02, -1);
    }
    const mist = Math.max(1, Math.round(n / 4));
    for (let i = 0; i < mist; i++) {
      normP.emit(point.x, point.y, point.z,
        dx * (0.6 + rnd()) + (rnd() - 0.5) * 0.8, dy * (0.6 + rnd()) + (rnd() - 0.2) * 0.8, dz * (0.6 + rnd()) + (rnd() - 0.5) * 0.8,
        0.3 + rnd() * 0.3, 0.08, 0.26 + rnd() * 0.12, rnd() * TAU, (rnd() - 0.5) * 3,
        0.55, 0.03, 0.03, 0.42, 0.45, 0.02, 0.02, 0,
        1.5, 3.5, 0, 0, rnd());
    }
  }

  function dust(point, normal, scale) {
    if (!ready || !point) return;
    const sc = scale === undefined ? 1 : Math.max(0.2, Math.min(4, +scale || 1));
    setNormal(normal, 0, 1, 0); makeBasis();
    const px = point.x + nx * 0.03, py = point.y + ny * 0.03, pz = point.z + nz * 0.03;
    const puffs = Math.min(10, Math.round(5 * sc));
    for (let i = 0; i < puffs; i++) {
      const a = rnd() * TAU, r = (0.4 + rnd() * 0.9) * sc;
      const up = (0.5 + rnd() * 0.9) * (0.7 + 0.3 * sc);
      const g = 0.50 + rnd() * 0.1;
      normP.emit(px, py, pz,
        nx * up + (tx * Math.cos(a) + bx * Math.sin(a)) * r, ny * up + (ty * Math.cos(a) + by * Math.sin(a)) * r, nz * up + (tz * Math.cos(a) + bz * Math.sin(a)) * r,
        0.5 + rnd() * 0.5, 0.14 * sc, (0.5 + rnd() * 0.3) * sc, rnd() * TAU, (rnd() - 0.5) * 2,
        g + 0.08, g + 0.02, g - 0.1, 0.7, g, g - 0.05, g - 0.14, 0,
        -0.25, 2.6, 1, 0, rnd());
    }
    const chips = Math.min(14, Math.round(5 * sc));
    for (let i = 0; i < chips; i++) {
      const a = rnd() * TAU, r = (0.4 + rnd() * 0.9);
      const sp = 2 + rnd() * 3.5;
      normP.emit(px, py, pz,
        (nx * (0.7 + rnd() * 0.6) + (tx * Math.cos(a) + bx * Math.sin(a)) * r) * sp,
        (ny * (0.7 + rnd() * 0.6) + (ty * Math.cos(a) + by * Math.sin(a)) * r) * sp,
        (nz * (0.7 + rnd() * 0.6) + (tz * Math.cos(a) + bz * Math.sin(a)) * r) * sp,
        0.55, 0.028, 0.028, 0, 0,
        0.30, 0.22, 0.14, 1, 0.26, 0.19, 0.12, 1,
        12, 0.3, 3, 0.025, -1);
    }
  }

  function smoke(point, dir, scale) {
    if (!ready || !point) return;
    const sc = scale === undefined ? 1 : Math.max(0.2, Math.min(4, +scale || 1));
    setNormal(dir, 0, 0.35, -1);
    for (let i = 0; i < 4; i++) {
      const sp = 1.0 + rnd() * 1.4;
      normP.emit(point.x + nx * i * 0.03, point.y + ny * i * 0.03, point.z + nz * i * 0.03,
        nx * sp + (rnd() - 0.5) * 0.5, ny * sp + 0.25 + (rnd() - 0.5) * 0.4, nz * sp + (rnd() - 0.5) * 0.5,
        0.9 + rnd() * 0.8, 0.06 * sc, (0.28 + rnd() * 0.14) * sc, rnd() * TAU, (rnd() - 0.5) * 1.5,
        0.84, 0.84, 0.82, 0.34, 0.7, 0.7, 0.7, 0,
        -0.35, 2.4, 0, 0, rnd());
    }
  }

  function tracer(from, to) {
    if (!ready || !from || !to) return;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.05) return;
    let i;
    if (tr.n < tr.max) i = tr.n++; else { i = tr.cursor; tr.cursor = (tr.cursor + 1) % tr.max; }
    const S = tr.S, o = i * TS;
    S[o] = from.x; S[o + 1] = from.y; S[o + 2] = from.z;
    S[o + 3] = dx / dist; S[o + 4] = dy / dist; S[o + 5] = dz / dist;
    S[o + 6] = dist; S[o + 7] = 0;
    S[o + 8] = Math.min(0.32, (dist + Math.min(TRACER_SEG, dist)) / TRACER_SPEED + 0.02);   // head life
    S[o + 9] = 0.16;                                                                            // faint trail life
  }

  function bloodPool(position, radius) {
    if (!ready || !position) return;
    const R = Math.max(0.1, +radius || 0.8);
    setNormal(null, 0, 1, 0); makeBasis(); rotateBasis(rnd() * TAU);
    poolD.spawn(position.x, 0.012, position.z, R * 1.2, 3.0, 4.0, 22, 0.12, rnd());
  }

  function impactDecal(point, normal) {
    if (!ready || !point) return;
    setNormal(normal, 0, 1, 0); makeBasis(); rotateBasis(rnd() * TAU);
    bulletD.spawn(point.x + nx * 0.012, point.y + ny * 0.012, point.z + nz * 0.012, 0.07 + rnd() * 0.04, 0.01, 30, 40, 1, rnd());
  }

  function shake(amount) {
    const a = +amount;
    if (!(a > 0)) return;
    trauma = Math.min(1.25, trauma + a);
  }

  // ------------------------------------------------------------------------------------------------ update
  function updateTracers(dt) {
    const S = tr.S, A = tracerA.array, B = tracerB.array;
    let i = 0;
    while (i < tr.n) {
      const o = i * TS;
      const age = S[o + 7] + dt;
      if (age >= Math.max(S[o + 8], S[o + 9])) {
        const last = --tr.n;
        if (i !== last) for (let j = 0; j < TS; j++) S[o + j] = S[last * TS + j];
        continue;
      }
      S[o + 7] = age;
      const dist = S[o + 6], seg = Math.min(TRACER_SEG, dist);
      const head = Math.min(dist, age * TRACER_SPEED), tail = Math.max(0, age * TRACER_SPEED - seg);
      const fx = S[o], fy = S[o + 1], fz = S[o + 2], dx = S[o + 3], dy = S[o + 4], dz = S[o + 5];
      const headLife = S[o + 8], trailLife = S[o + 9];
      // hot head: tail point (w = half width) -> head point (w = alpha)
      let q = (i * 2) * 4;
      let ha = age < headLife ? 1 : 0;
      A[q] = fx + dx * tail; A[q + 1] = fy + dy * tail; A[q + 2] = fz + dz * tail; A[q + 3] = 0.012;
      B[q] = fx + dx * head; B[q + 1] = fy + dy * head; B[q + 2] = fz + dz * head; B[q + 3] = ha * 0.95;
      // faint trail from the muzzle to the head
      q += 4;
      const ta = age < trailLife ? 0.28 * (1 - age / trailLife) : 0;
      A[q] = fx; A[q + 1] = fy; A[q + 2] = fz; A[q + 3] = 0.005;
      B[q] = fx + dx * head; B[q + 1] = fy + dy * head; B[q + 2] = fz + dz * head; B[q + 3] = ta;
      i++;
    }
    tracerMesh.visible = tr.n > 0;
    tracerGeom.instanceCount = tr.n * 2;
    if (tr.n > 0) { flush(tracerA, tr.n * 2); flush(tracerB, tr.n * 2); }
  }

  function update(dt) {
    if (!ready) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    normP.update(dt); addP.update(dt);
    poolD.update(dt); splatD.update(dt); bulletD.update(dt);
    updateTracers(dt);

    // camera shake: exponential trauma decay, high-frequency sine mix, amplitude ~0.12 m at trauma 1
    if (trauma > 0) {
      shakeT += dt;
      trauma *= Math.exp(-3.5 * dt);
      if (trauma < 0.003) trauma = 0;
    }
    if (trauma > 0) {
      const amp = 0.12 * Math.min(1, trauma), t = shakeT;
      FX.shakeOffset.set(
        (Math.sin(t * 37.3) * 0.6 + Math.sin(t * 61.7 + 1.3) * 0.4) * amp * 0.8,
        (Math.sin(t * 43.1 + 2.1) * 0.6 + Math.sin(t * 71.9 + 0.4) * 0.4) * amp,
        Math.sin(t * 29.7 + 4.2) * amp * 0.4);
    } else if (FX.shakeOffset.x !== 0 || FX.shakeOffset.y !== 0 || FX.shakeOffset.z !== 0) {
      FX.shakeOffset.set(0, 0, 0);
    }
  }

  function clear() {
    if (!ready) return;
    normP.clear(); addP.clear(); poolD.clear(); splatD.clear(); bulletD.clear();
    tr.n = 0; tr.cursor = 0; tracerMesh.visible = false; tracerGeom.instanceCount = 0;
    trauma = 0; FX.shakeOffset.set(0, 0, 0);
  }

  function stats() {
    if (!ready) return { ready: false };
    return { ready: true, particles: normP.n, sparks: addP.n, tracers: tr.n, pools: poolD.active, splats: splatD.active,
      decals: bulletD.active, trauma: Math.round(trauma * 1000) / 1000, shake: FX.shakeOffset.toArray().map(function (v) { return Math.round(v * 1000) / 1000; }) };
  }

  // ------------------------------------------------------------------------------------------------ debug helpers (?debug=1)
  function installDebug() {
    const d = window.__dbg;
    if (!d || d.fx) return;
    const cam = function () { return (window.Game && Game.camera) || cameraRef; };
    // camera-relative frame on the ground plane: p(f, r, h) = a point f metres ahead, r to the right, h above the ground
    function frame() {
      const c = cam(), f = new THREE.Vector3(); c.getWorldDirection(f); f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const r = new THREE.Vector3(-f.z, 0, f.x), o = new THREE.Vector3(); c.getWorldPosition(o);
      return { f: f, r: r, o: o, at: function (fw, rt, h) { return new THREE.Vector3(o.x + f.x * fw + r.x * rt, h, o.z + f.z * fw + r.z * rt); } };
    }
    function muzzle(fr) {
      const m = new THREE.Vector3();
      if (window.Weapon && Weapon.muzzleWorldPosition) { try { Weapon.muzzleWorldPosition(m); if (m.lengthSq() > 0) return m; } catch (e) { /* fall through */ } }
      return new THREE.Vector3(fr.o.x + fr.f.x * 0.5 + fr.r.x * 0.17, fr.o.y - 0.14, fr.o.z + fr.f.z * 0.5 + fr.r.z * 0.17);
    }
    d.fx = {
      sparks: function (n) { const fr = frame(); sparks(fr.at(6, 0, 1.3), fr.f.clone().negate(), n); return stats(); },
      blood: function (n) { const fr = frame(); blood(fr.at(6, 0, 1.3), fr.r.clone().multiplyScalar(0.7).addScaledVector(fr.f, 0.3), n); return stats(); },
      dust: function () { const fr = frame(); dust(fr.at(6, 0, 0), new THREE.Vector3(0, 1, 0)); return stats(); },
      smoke: function () { const fr = frame(); smoke(muzzle(fr), fr.f); return stats(); },
      tracer: function () { const fr = frame(); tracer(muzzle(fr), fr.at(30, 0, 1.3)); return stats(); },
      pool: function (r) { const fr = frame(); bloodPool(fr.at(6, 0, 0), r || 0.9); return stats(); },
      decal: function () { const fr = frame(); impactDecal(fr.at(6, 0, 0), new THREE.Vector3(0, 1, 0)); return stats(); },
      shake: function (a) { shake(a === undefined ? 0.5 : a); return stats(); },
      stats: stats,
      clear: function () { clear(); return stats(); },
      // one of each effect, spread left to right `dist` (default 5) m in front of the camera
      demo: function (dist) {
        const D = +dist > 0.5 ? +dist : 5, k = D / 5;
        const fr = frame(), up = new THREE.Vector3(0, 1, 0), toCam = fr.f.clone().negate();
        const m = muzzle(fr), hh = 1.3 * Math.min(1, k + 0.3);
        dust(fr.at(D, -3.0 * k, 0), up);
        dust(fr.at(D, -3.0 * k, 0), up, 0.6);
        const sp = fr.at(D, -1.5 * k, hh);
        sparks(sp, toCam.clone().add(fr.r.clone().multiplyScalar(-0.3)), 14);
        blood(fr.at(D, 0, hh), fr.r.clone().multiplyScalar(0.7).addScaledVector(fr.f, 0.4), 12);
        bloodPool(fr.at(D, 1.5 * k, 0), 0.9);
        impactDecal(fr.at(D, 2.7 * k, 0), up);
        impactDecal(fr.at(D - 0.4 * k, 2.9 * k, 0.02), up);
        smoke(m, fr.f);
        tracer(m, sp);
        tracer(m, fr.at(40, 2.5, 1.6));
        impactDecal(fr.at(40, 2.5, 1.6), toCam);
        return stats();
      }
    };
  }

  // ------------------------------------------------------------------------------------------------ export
  const FX = {
    shakeOffset: new THREE.Vector3(),
    init: init,
    update: update,
    sparks: sparks,
    blood: blood,
    dust: dust,
    smoke: smoke,
    tracer: tracer,
    bloodPool: bloodPool,
    impactDecal: impactDecal,
    shake: shake,
    clear: clear,
    stats: stats
  };
  window.FX = FX;
})();
