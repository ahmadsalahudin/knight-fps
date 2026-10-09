/* gunmodel.js - window.GunModel: the first-person revolver, built procedurally (no GLB).

   Contract (read by weapon.js _buildModelGun; keep it, the hands and the reload are fitted to it):
     GunModel.build(ctx) -> {
       root:   THREE.Group in GUN SPACE: +x right, +y up, -z forward (toward the muzzle), metres; origin = the hold point
               (where the web of the shooting hand sits, top-rear of the grip). Overall length ~0.30.
       muzzle: THREE.Vector3, the bore exit (the flash and tracers start here).
       cyl:    { swing, spin, axisLocal, swingSign, center, radius }
               swing: Object3D at the crane hinge (below-left of the cylinder centre), child of root (or of a root child)
               spin:  Object3D at the cylinder centre, child of swing; the cylinder meshes hang under it
               axisLocal: unit Vector3 parallel to the bore, expressed in swing's / spin's local frame
               swingSign: +1 / -1 so that swing.quaternion = axisAngle(axisLocal, swingSign * 1.5) swings the cylinder out to
                          the shooter's LEFT (-x) and down
               center: Vector3 gun-space cylinder centre at rest;  radius: cylinder radius (m)
       hammer: { pivot, axisLocal, dirSign, center }
               pivot: Object3D at the hammer hinge (the hammer meshes hang under it); rest pose = COCKED (spur back)
               axisLocal: unit lateral axis in pivot's parent frame; dirSign: +1 / -1 so that +angle * dirSign tips the top
               of the hammer to the REAR (the game drops it forward by 0.62 rad on a shot)
       grip:   THREE.Box3, gun-space box of the part of the grip the hand holds (wood)
       gripTopZ, gripBotZ: z of the grip centre line near its top / bottom (the hand follows this rake)
     }
   ctx = { col(hex) -> THREE.Color in the renderer's colour space, srgb: bool (set texture.encoding to sRGBEncoding if true),
           anisotropy: number }

   Landmarks the hands / reload are tuned to (keep close to these):
     grip: top y 0.020, bottom y -0.072, half width 0.012, depth ~0.037 at the hand, gripTopZ -0.017, gripBotZ +0.015
     trigger face ~(-0.004, -0.021, -0.062);  cylinder centre (0, 0.022, -0.078), radius 0.023, length ~0.048
     muzzle (0, 0.044, -0.262);  hammer hinge ~(0, 0.027, -0.034), spur up to y ~0.06;  max half width ~0.023

   Design "faithful": the ornate antique hero pistol of the reference, as a six-shot swing-out revolver. A long octagonal barrel
   in dark browned steel with silver inlay lines and a gold muzzle ring, an engraved silver breech band and a pierced scroll
   plate under it; a bright nickel frame, cylinder (oval cartouches) and swan-neck hammer, all deeply engraved; a thin
   scroll-curled trigger guard; a rosewood bird's-head grip with an engraved backstrap, a silver cross inlay, and a big
   engraved butt cap with a lanyard ring. Five canvas textures: engraving, cylinder cartouches, barrel inlay, wood grain and a
   small equirectangular environment that gives the metal its reflections. */
(function () {
  'use strict';
  const V3 = THREE.Vector3;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------------------------------------ helpers
  function prng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  // smooth normals across edges flatter than `deg`, keep the sharper ones (extrusions come out with flat, faceted normals)
  function creaseNormals(geo, deg) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const P = g.attributes.position.array, n = P.length / 3, nf = n / 3;
    const fn = new Float32Array(nf * 3), fa = new Float32Array(nf);
    for (let f = 0; f < nf; f++) {
      const a = f * 9;
      const ux = P[a + 3] - P[a], uy = P[a + 4] - P[a + 1], uz = P[a + 5] - P[a + 2];
      const vx = P[a + 6] - P[a], vy = P[a + 7] - P[a + 1], vz = P[a + 8] - P[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const l = Math.hypot(cx, cy, cz);
      if (l > 1e-14) { fn[f * 3] = cx / l; fn[f * 3 + 1] = cy / l; fn[f * 3 + 2] = cz / l; fa[f] = l; }
    }
    const map = new Map(), keys = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.round(P[i * 3] * 2e5) + ',' + Math.round(P[i * 3 + 1] * 2e5) + ',' + Math.round(P[i * 3 + 2] * 2e5);
      keys[i] = k;
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push((i / 3) | 0);
    }
    const ct = Math.cos(deg * Math.PI / 180), N = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const f0 = (i / 3) | 0, ax = fn[f0 * 3], ay = fn[f0 * 3 + 1], az = fn[f0 * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (const f of map.get(keys[i])) {
        const bx = fn[f * 3], by = fn[f * 3 + 1], bz = fn[f * 3 + 2];
        if (ax * bx + ay * by + az * bz >= ct) { sx += bx * fa[f]; sy += by * fa[f]; sz += bz * fa[f]; }
      }
      let l = Math.hypot(sx, sy, sz);
      if (l < 1e-14) { sx = ax; sy = ay; sz = az; l = Math.hypot(sx, sy, sz) || 1; if (l === 1 && !ax && !ay && !az) sy = 1; }
      N[i * 3] = sx / l; N[i * 3 + 1] = sy / l; N[i * 3 + 2] = sz / l;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    return g;
  }
  function scaleUV(g, k) { const uv = g.attributes.uv; if (!uv) return g; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k); return g; }

  // a profile drawn in the gun's side plane (shape x = gun z, shape y = gun y), extruded across x with rounded edges
  const SIDE_M = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  const ENGR = 1 / 0.06;   // engraving tile = 6 cm
  function extrudeSide(shape, hw, o) {
    o = o || {};
    const bt = o.bevel != null ? o.bevel : 0.0008;
    const depth = Math.max(1e-5, 2 * (hw - bt));
    const g = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: bt > 0, bevelThickness: bt, bevelSize: bt, bevelOffset: -bt, bevelSegments: o.seg || 3, curveSegments: o.curve || 12 });
    g.translate(0, 0, -depth / 2);
    g.applyMatrix4(SIDE_M);
    if (o.x) g.translate(o.x, 0, 0);
    scaleUV(g, o.uv || ENGR);
    return creaseNormals(g, o.crease || 38);
  }
  // a cross-section in the gun's x-y plane, extruded along z from z0 to z1
  function extrudeZ(shape, z0, z1, o) {
    o = o || {};
    const bt = o.bevel != null ? o.bevel : 0.0006;
    const depth = Math.max(1e-5, (z1 - z0) - 2 * bt);
    const g = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: bt > 0, bevelThickness: bt, bevelSize: bt, bevelOffset: -bt, bevelSegments: o.seg || 3, curveSegments: o.curve || 16 });
    g.translate(0, 0, z0 + bt);
    scaleUV(g, o.uv || ENGR);
    return creaseNormals(g, o.crease || 38);
  }
  function shapeFrom(pts) { const s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); s.closePath(); return s; }
  function octPts(apo) { const R = apo / Math.cos(Math.PI / 8), p = []; for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + k * Math.PI / 4; p.push([Math.cos(a) * R, Math.sin(a) * R]); } return p; }

  // octagonal prism along z (z0 < z1), flats centred on 0 / 45 / 90.. deg, corners chamfered by `ch`. Crisp flat normals;
  // u runs 0..uS across every flat (the chamfers get the texture's edge strip), v runs v0 (at z0) .. v1 (at z1)
  function octPrism(apo, z0, z1, ch, uS, v0, v1) {
    const R = apo / Math.cos(Math.PI / 8), side = 2 * apo * Math.tan(Math.PI / 8), t = ch / side, P = [];
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + k * Math.PI / 4, ap = a - Math.PI / 4, an = a + Math.PI / 4;
      const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
      P.push([cx + (Math.cos(ap) * R - cx) * t, cy + (Math.sin(ap) * R - cy) * t]);
      P.push([cx + (Math.cos(an) * R - cx) * t, cy + (Math.sin(an) * R - cy) * t]);
    }
    const pos = [], nor = [], uv = [];
    for (let i = 0; i < 16; i++) {
      const a = P[i], b = P[(i + 1) % 16], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey), nx = ey / l, ny = -ex / l;
      const flat = i % 2 === 1, ua = flat ? 0 : -0.035 * uS, ub = flat ? uS : 0;
      const vs = [[a, ua, z0, v0], [b, ub, z0, v0], [b, ub, z1, v1], [a, ua, z0, v0], [b, ub, z1, v1], [a, ua, z1, v1]];
      for (const q of vs) { pos.push(q[0][0], q[0][1], q[2]); nor.push(nx, ny, 0); uv.push(q[1], q[3]); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }

  // ------------------------------------------------------------------------------------------------ canvas engraving kit
  function stipple(g, w, h, r, count, dark, light) {
    for (let i = 0; i < count; i++) {
      const x = r() * w, y = r() * h, v = r();
      g.fillStyle = v < 0.62 ? dark : light;
      const s = 1 + r() * 1.4;
      g.fillRect(x, y, s, s);
    }
  }
  function spiralPts(cx, cy, R, a0, dir, turns, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, r = R * Math.pow(1 - 0.86 * t, 0.9), a = a0 + dir * t * turns * TAU;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }
  function normalsOf(pts) {
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
  }
  function polyPath(g, pts, i0, i1) { g.beginPath(); g.moveTo(pts[i0][0], pts[i0][1]); for (let i = i0 + 1; i <= i1; i++) g.lineTo(pts[i][0], pts[i][1]); }
  function leafPath(g, L) {
    const x = L[0], y = L[1], ang = L[2], len = L[3], wid = L[4], ca = Math.cos(ang), sa = Math.sin(ang);
    const P = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v];
    const tip = P(len, wid * 0.35), l1 = P(len * 0.3, wid), l2 = P(len * 0.85, wid * 0.9), r1 = P(len * 0.3, -wid * 0.9), r2 = P(len * 0.8, -wid * 0.4);
    g.beginPath(); g.moveTo(x, y);
    g.bezierCurveTo(l1[0], l1[1], l2[0], l2[1], tip[0], tip[1]);
    g.bezierCurveTo(r2[0], r2[1], r1[0], r1[1], x, y);
    g.closePath();
  }
  // bands: {pts, w0, w1} raised polished scroll ribbons; leaves: [x, y, ang, len, wid]; offs: wrap offsets for tiling
  function engrave(g, bands, leaves, offs, k, pal) {
    k = k || 1;
    pal = pal || { cut: 'rgba(24,26,30,0.95)', body: '#e4e6ea', groove: 'rgba(60,62,68,0.9)', hatch: 'rgba(40,42,48,0.55)', hi: 'rgba(255,255,255,0.75)' };
    const each = (fn) => { for (const o of offs) { g.save(); g.translate(o[0], o[1]); fn(); g.restore(); } };
    const chunks = 6;
    const tapered = (b, extra) => {
      const n = b.pts.length - 1;
      for (let c = 0; c < chunks; c++) {
        const i0 = Math.floor(c * n / chunks), i1 = Math.min(n, Math.floor((c + 1) * n / chunks) + 1);
        g.lineWidth = (b.w0 + (b.w1 - b.w0) * ((c + 0.5) / chunks)) * k + extra;
        polyPath(g, b.pts, i0, i1); g.stroke();
      }
    };
    g.lineCap = 'round'; g.lineJoin = 'round';
    each(() => {   // the cut round every raised element
      g.strokeStyle = pal.cut; g.fillStyle = pal.cut;
      for (const b of bands) tapered(b, 6 * k);
      g.lineWidth = 6 * k;
      for (const L of leaves) { leafPath(g, L); g.stroke(); }
      for (const b of bands) { const e = b.pts[b.pts.length - 1]; g.beginPath(); g.arc(e[0], e[1], (b.w1 * 0.9 + 3) * k, 0, TAU); g.fill(); }
    });
    each(() => {   // polished bodies
      g.strokeStyle = pal.body; g.fillStyle = pal.body;
      for (const b of bands) tapered(b, 0);
      for (const L of leaves) { leafPath(g, L); g.fill(); }
      for (const b of bands) { const e = b.pts[b.pts.length - 1]; g.beginPath(); g.arc(e[0], e[1], b.w1 * 0.9 * k, 0, TAU); g.fill(); }
    });
    each(() => {   // shading: a groove and hatching on one side, a highlight on the other
      for (const b of bands) {
        const ns = normalsOf(b.pts), n = b.pts.length - 1;
        const w = (i) => (b.w0 + (b.w1 - b.w0) * (i / n)) * k;
        g.strokeStyle = pal.groove; g.lineWidth = 1.4 * k;
        g.beginPath();
        b.pts.forEach((p, i) => { const d = w(i) * 0.2, x = p[0] + ns[i][0] * d, y = p[1] + ns[i][1] * d; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
        g.strokeStyle = pal.hatch; g.lineWidth = 1.0 * k;
        g.beginPath();
        for (let i = 0; i <= n; i += 2) {
          const p = b.pts[i], a = w(i) * 0.28, c = w(i) * 0.5;
          g.moveTo(p[0] + ns[i][0] * a, p[1] + ns[i][1] * a); g.lineTo(p[0] + ns[i][0] * c, p[1] + ns[i][1] * c);
        }
        g.stroke();
        g.strokeStyle = pal.hi; g.lineWidth = 1.2 * k;
        g.beginPath();
        b.pts.forEach((p, i) => { const d = -w(i) * 0.24, x = p[0] + ns[i][0] * d, y = p[1] + ns[i][1] * d; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
      }
      g.strokeStyle = pal.groove; g.lineWidth = 1.3 * k;
      for (const L of leaves) {   // midrib + veins
        const x = L[0], y = L[1], ca = Math.cos(L[2]), sa = Math.sin(L[2]), len = L[3], wid = L[4];
        const P = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v];
        g.beginPath();
        let q = P(len * 0.08, 0); g.moveTo(q[0], q[1]); q = P(len * 0.5, wid * 0.25); const q2 = P(len * 0.88, wid * 0.32); g.quadraticCurveTo(q[0], q[1], q2[0], q2[1]);
        for (let j = 1; j <= 3; j++) { const u = len * (0.2 + j * 0.17), a = P(u, wid * 0.12), b = P(u + len * 0.12, wid * 0.7); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); const c2 = P(u + len * 0.1, -wid * 0.55); g.moveTo(a[0], a[1]); g.lineTo(c2[0], c2[1]); }
        g.stroke();
      }
    });
  }
  function wrapOffs(w, h) { const o = []; for (const dx of [-w, 0, w]) for (const dy of (h ? [-h, 0, h] : [0])) o.push([dx, dy]); return o; }
  function tarnish(g, w, h, r, n) {
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, rad = 40 + r() * 160, dark = r() < 0.7;
      for (const o of wrapOffs(w, h)) {
        const gr = g.createRadialGradient(x + o[0], y + o[1], 0, x + o[0], y + o[1], rad);
        gr.addColorStop(0, dark ? 'rgba(40,36,30,0.10)' : 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + o[0] - rad, y + o[1] - rad, rad * 2, rad * 2);
      }
    }
  }
  // occupancy grid so small curls can fill the gaps the main scrolls leave (dense arabesque)
  function occGrid(w, h, wrapY) {
    const cell = 6, nx = Math.ceil(w / cell), ny = Math.ceil(h / cell), a = new Uint8Array(nx * ny);
    const at = (x, y) => {
      let i = Math.floor(x / cell) % nx; if (i < 0) i += nx;
      let j = Math.floor(y / cell);
      if (wrapY) { j %= ny; if (j < 0) j += ny; } else if (j < 0 || j >= ny) return -1;
      return j * nx + i;
    };
    const disk = (x, y, r, fn) => { for (let yy = -r; yy <= r; yy += cell * 0.7) for (let xx = -r; xx <= r; xx += cell * 0.7) if (xx * xx + yy * yy <= r * r) { if (fn(at(x + xx, y + yy))) return true; } return false; };
    return {
      mark(x, y, r) { disk(x, y, r, (k) => { if (k >= 0) a[k] = 1; return false; }); },
      free(x, y, r) { return !disk(x, y, r, (k) => k < 0 || a[k] === 1); },
      band(b) { const n = b.pts.length - 1; b.pts.forEach((p, i) => this.mark(p[0], p[1], (b.w0 + (b.w1 - b.w0) * i / n) / 2 + 5)); },
      leaf(L) { const ca = Math.cos(L[2]), sa = Math.sin(L[2]); for (let u = 0; u <= L[3]; u += 5) this.mark(L[0] + ca * u, L[1] + sa * u, L[4] * 0.75 + 3); },
    };
  }
  // fill free space with small curls (each with a leaf or two)
  function fillCurls(occ, w, h, r, bands, leaves, tries, rMax, rMin, wid) {
    for (let t = 0; t < tries; t++) {
      const R = rMax - (rMax - rMin) * (t / tries), x = r() * w, y = r() * h;
      if (!occ.free(x, y, R + 7)) continue;
      const dir = r() < 0.5 ? 1 : -1, a0 = r() * TAU, sp = spiralPts(x, y, R, a0, dir, 1.25 + r() * 0.35, Math.max(24, Math.round(R * 1.2)));
      const b = { pts: sp, w0: wid * (R / rMax) + 3, w1: 2.5 };
      bands.push(b); occ.mark(x, y, R + 4);
      const p = sp[0], tang = Math.atan2(sp[2][1] - p[1], sp[2][0] - p[0]);
      const L1 = [p[0], p[1], tang + Math.PI + dir * 0.5, R * 0.95, R * 0.3];
      if (occ.free(p[0] - Math.cos(tang) * R * 0.5, p[1] - Math.sin(tang) * R * 0.5, R * 0.35)) { leaves.push(L1); occ.leaf(L1); }
    }
  }

  // tileable arabesque: running vines with spirals curling into the pockets, leaves along them, small curls in every gap
  function engravingCanvas() {
    const S = 1024, c = mkCanvas(S, S), g = c.getContext('2d'), r = prng(11);
    g.fillStyle = '#4e5156'; g.fillRect(0, 0, S, S);
    stipple(g, S, S, r, 80000, 'rgba(22,24,28,0.7)', 'rgba(140,143,150,0.5)');
    const bands = [], leaves = [], occ = occGrid(S, S, true);
    const lam = 512, A = 74;
    for (let row = 0; row < 2; row++) {
      const y0 = 256 + 512 * row, sh = row ? lam / 2 : 0;
      const vy = (x) => y0 + A * Math.sin((x - sh) / lam * TAU);
      const vine = [];
      for (let i = 0; i <= 160; i++) { const x = i / 160 * S; vine.push([x, vy(x)]); }
      bands.push({ pts: vine, w0: 13, w1: 13 });
      for (let n = 0; n < 2; n++) {
        const xa = sh + lam / 4 + n * lam, xb = sh + 3 * lam / 4 + n * lam;
        const R = 112;
        const ca = [xa - 6, vy(xa) - R - 12], cb = [xb - 6, vy(xb) + R + 12];
        const sa = spiralPts(ca[0], ca[1], R, Math.PI / 2 + 0.55, -1, 1.75, 120);
        const sb = spiralPts(cb[0], cb[1], R, -Math.PI / 2 - 0.55, 1, 1.75, 120);
        bands.push({ pts: sa, w0: 12, w1: 3.5 }, { pts: sb, w0: 12, w1: 3.5 });
        for (const [sp, cx, cy, dir] of [[sa, ca[0], ca[1], -1], [sb, cb[0], cb[1], 1]]) {
          for (const t of [0.12, 0.3, 0.48]) {
            const p = sp[Math.floor(t * (sp.length - 1))], out = Math.atan2(p[1] - cy, p[0] - cx);
            leaves.push([p[0], p[1], out - dir * 0.8, 50 - t * 30, 14 - t * 6]);
          }
          for (const t of [0.22, 0.42]) {
            const p2 = sp[Math.floor(t * (sp.length - 1))], inn = Math.atan2(cy - p2[1], cx - p2[0]);
            leaves.push([p2[0], p2[1], inn + dir * 1.0, 36 - t * 20, 11]);
          }
          occ.mark(cx, cy, R + 8);
        }
        for (const xz of [sh + n * lam, sh + n * lam + lam / 2]) {
          const up = ((xz - sh) / (lam / 2)) % 2 < 1 ? 1 : -1;
          leaves.push([xz, vy(xz), -up * 1.1, 66, 18], [xz + 22, vy(xz + 22), up * 2.2, 50, 14]);
        }
      }
    }
    bands.forEach((b) => occ.band(b)); leaves.forEach((L) => occ.leaf(L));
    fillCurls(occ, S, S, r, bands, leaves, 4200, 58, 11, 8);
    engrave(g, bands, leaves, wrapOffs(S, S), 1);
    tarnish(g, S, S, r, 20);
    return c;
  }

  // the cylinder: three engraved oval cartouches round it (u = around, v = along the axis), rims at both ends
  function cylinderCanvas() {
    const W = 1024, H = 512, c = mkCanvas(W, H), g = c.getContext('2d'), r = prng(23);
    g.fillStyle = '#4e5156'; g.fillRect(0, 0, W, H);
    stipple(g, W, H, r, 40000, 'rgba(22,24,28,0.7)', 'rgba(140,143,150,0.5)');
    const bands = [], leaves = [], occ = occGrid(W, H, false);
    for (let y = 0; y < 34; y += 4) for (let x = 0; x < W; x += 4) { occ.mark(x, y, 3); occ.mark(x, H - y, 3); }
    for (let k = 0; k < 3; k++) {
      const cx = W / 6 + k * W / 3, cy = H / 2, rx = 122, ry = 196;
      const ring = []; for (let i = 0; i <= 140; i++) { const a = i / 140 * TAU; ring.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
      bands.push({ pts: ring, w0: 16, w1: 16 });
      const inner = []; for (let i = 0; i <= 140; i++) { const a = i / 140 * TAU; inner.push([cx + Math.cos(a) * (rx - 17), cy + Math.sin(a) * (ry - 17)]); }
      bands.push({ pts: inner, w0: 3, w1: 3 });
      // mirrored scrolls along the axis on an S stem, a rosette in the middle
      const sA = spiralPts(cx + 12, cy - 96, 64, Math.PI * 0.95, 1, 1.7, 90);
      const sB = spiralPts(cx - 12, cy + 96, 64, -Math.PI * 0.05, 1, 1.7, 90);
      bands.push({ pts: sA, w0: 11, w1: 3 }, { pts: sB, w0: 11, w1: 3 });
      const stem = []; for (let i = 0; i <= 40; i++) { const t = i / 40; stem.push([cx - 52 + 104 * t, cy - 96 + 192 * t - Math.sin(t * TAU) * 34]); }
      bands.push({ pts: stem, w0: 10, w1: 10 });
      for (let q = 0; q < 6; q++) leaves.push([cx, cy, q * Math.PI / 3 + 0.3, 36, 12]);
      leaves.push([cx + 56, cy - 152, 2.4, 40, 12], [cx - 56, cy + 152, -0.7, 40, 12], [cx - 74, cy - 40, -1.9, 38, 11], [cx + 74, cy + 40, 1.2, 38, 11]);
      // mark the cartouche frame; inside / outside get their own small curls
      ring.forEach((p) => occ.mark(p[0], p[1], 14));
    }
    bands.forEach((b) => occ.band(b)); leaves.forEach((L) => occ.leaf(L));
    fillCurls(occ, W, H, r, bands, leaves, 3200, 40, 10, 7);
    engrave(g, bands, leaves, wrapOffs(W, 0), 1);
    // raised rims at both ends
    for (const [y0, y1] of [[0, 26], [H - 26, H]]) {
      g.fillStyle = 'rgba(24,26,30,0.95)'; g.fillRect(0, y0 === 0 ? y1 : y0 - 6, W, 6);
      g.fillStyle = '#e2e4e8'; g.fillRect(0, y0, W, y1 - y0);
      g.fillStyle = 'rgba(60,62,68,0.9)'; g.fillRect(0, (y0 + y1) / 2 - 1, W, 2);
      for (let x = 0; x < W; x += 9) { g.fillStyle = 'rgba(50,52,58,0.6)'; g.fillRect(x, y0 + 4, 2, 6); g.fillRect(x + 4, y1 - 10, 2, 6); }
    }
    tarnish(g, W, H, r, 10);
    return c;
  }

  // one barrel flat: u = across (0..1), v = along (canvas bottom = breech, top = muzzle). Browned steel, fine silver edge
  // lines, a thin inlaid silver vine, engraved silver bands near the ends and the middle
  function barrelCanvas() {
    const W = 256, H = 1024, c = mkCanvas(W, H), g = c.getContext('2d'), r = prng(5);
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#22201f'); gr.addColorStop(0.5, '#272221'); gr.addColorStop(1, '#211e1e');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 800; i++) { const x = r() * W; g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(150,140,150,0.05)'; g.fillRect(x, 0, 1 + r() * 2, H); }
    for (let i = 0; i < 30; i++) { const y = r() * H, rad = 30 + r() * 120; const q = g.createRadialGradient(r() * W, y, 0, W / 2, y, rad); q.addColorStop(0, 'rgba(100,60,36,0.12)'); q.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = q; g.fillRect(0, y - rad, W, rad * 2); }
    const silver = '#dcdee2', cut = 'rgba(8,8,10,0.9)';
    // edge lines (the chamfers sample u in [-0.035, 0], i.e. the right edge strip)
    for (const x of [0, W - 9]) { g.fillStyle = cut; g.fillRect(x === 0 ? 9 : x - 2, 0, 2, H); g.fillStyle = silver; g.fillRect(x, 0, 9, H); }
    g.fillStyle = 'rgba(200,202,206,0.75)'; g.fillRect(22, 0, 2, H); g.fillRect(W - 24, 0, 2, H);
    // a fine inlaid vine with tiny leaves
    const bands = [], leaves = [];
    for (const [a, b] of [[64, 958]]) {
      const pts = []; for (let y = a; y <= b; y += 4) pts.push([W / 2 + 40 * Math.sin((y - a) / 136 * TAU), y]);
      bands.push({ pts: pts, w0: 4.5, w1: 4.5 });
      for (let y = a + 34; y < b - 20; y += 68) {
        const x = W / 2 + 40 * Math.sin((y - a) / 136 * TAU), s = Math.cos((y - a) / 136 * TAU) > 0 ? 1 : -1;
        leaves.push([x, y, s > 0 ? -0.5 : Math.PI + 0.5, 30, 8]);
      }
    }
    engrave(g, bands, leaves, [[0, 0]], 0.7, { cut: cut, body: silver, groove: 'rgba(70,70,76,0.8)', hatch: 'rgba(60,60,66,0.35)', hi: 'rgba(255,255,255,0.6)' });
    // engraved bands
    for (const [y0, y1] of [[10, 44], [976, 1016]]) {
      g.fillStyle = cut; g.fillRect(0, y0 - 3, W, y1 - y0 + 6);
      g.fillStyle = silver; g.fillRect(0, y0, W, y1 - y0);
      g.strokeStyle = 'rgba(40,40,46,0.85)'; g.lineWidth = 2;
      g.beginPath(); for (let x = 0; x <= W; x += 12) { g.lineTo(x, x % 24 ? y0 + 5 : y1 - 5); } g.stroke();
      g.fillStyle = 'rgba(40,40,46,0.8)'; g.fillRect(0, y0 + 2, W, 2); g.fillRect(0, y1 - 4, W, 2);
    }
    return c;
  }

  // dark rosewood / walnut: flowing grain along v, pores, a little figure (tileable)
  function woodCanvas() {
    const S = 1024, c = mkCanvas(S, S), g = c.getContext('2d'), r = prng(31);
    g.fillStyle = '#34170d'; g.fillRect(0, 0, S, S);
    const line = (x0, amp1, k1, ph1, amp2, k2, ph2, w, col) => {
      for (const dx of [-S, 0, S]) {
        g.strokeStyle = col; g.lineWidth = w; g.beginPath();
        for (let y = 0; y <= S; y += 8) {
          const x = x0 + dx + amp1 * Math.sin(y / S * TAU * k1 + ph1) + amp2 * Math.sin(y / S * TAU * k2 + ph2);
          if (y) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
      }
    };
    for (let i = 0; i < 30; i++) line(r() * S, 30 + r() * 40, 1, r() * TAU, 10, 3, r() * TAU, 30 + r() * 80, r() < 0.55 ? 'rgba(12,4,2,0.22)' : 'rgba(110,48,24,0.16)');
    for (let i = 0; i < 340; i++) {
      const dark = r() < 0.75;
      line(r() * S, 18 + r() * 26, 1, r() * TAU, 3 + r() * 5, 2 + Math.floor(r() * 4), r() * TAU, 0.6 + r() * 2.6,
        dark ? 'rgba(10,3,1,' + (0.3 + r() * 0.45).toFixed(2) + ')' : 'rgba(132,62,32,' + (0.16 + r() * 0.26).toFixed(2) + ')');
    }
    for (let i = 0; i < 10000; i++) { g.fillStyle = 'rgba(8,2,1,' + (0.3 + r() * 0.4).toFixed(2) + ')'; g.fillRect(r() * S, r() * S, 1 + r(), 2 + r() * 5); }
    for (let i = 0; i < 600; i++) { g.fillStyle = 'rgba(160,84,46,0.16)'; g.fillRect(r() * S, r() * S, 1.5, 4 + r() * 8); }
    return c;
  }

  // a small equirectangular sky / meadow for the metal to reflect
  function envCanvas() {
    const W = 512, H = 256, c = mkCanvas(W, H), g = c.getContext('2d'), r = prng(3);
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#9ab4dc'); gr.addColorStop(0.42, '#e2eaf6'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(0.52, '#8c8f84');
    gr.addColorStop(0.7, '#57584f'); gr.addColorStop(1, '#2c2b28');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 14; i++) { const x = r() * W, w = 10 + r() * 40, h = 8 + r() * 26; g.fillStyle = 'rgba(52,62,50,0.7)'; g.beginPath(); g.ellipse(x, H * 0.5 - h * 0.4, w, h, 0, 0, TAU); g.fill(); }
    for (let i = 0; i < 8; i++) { const x = r() * W, y = 20 + r() * 70, q = g.createRadialGradient(x, y, 0, x, y, 40 + r() * 40); q.addColorStop(0, 'rgba(255,255,255,0.7)'); q.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = q; g.fillRect(0, 0, W, H); }
    const s = g.createRadialGradient(150, 40, 0, 150, 40, 30); s.addColorStop(0, 'rgba(255,255,240,1)'); s.addColorStop(1, 'rgba(255,255,240,0)'); g.fillStyle = s; g.fillRect(0, 0, W, H);
    return c;
  }

  // ------------------------------------------------------------------------------------------------ the grip (lofted)
  function makeGrip() {
    const curve = new THREE.CatmullRomCurve3([
      new V3(0, 0.0250, -0.0210),
      new V3(0, 0.0200, -0.0189),
      new V3(0, -0.0260, -0.0010),
      new V3(0, -0.0630, 0.0135),
      new V3(0, -0.0785, 0.0212),
      new V3(0, -0.0875, 0.0322),
      new V3(0, -0.0930, 0.0448),
    ], false, 'centripetal');
    const L = curve.getLength(), NT = 400, tab = [];
    for (let i = 0; i <= NT; i++) { const u = i / NT; tab.push({ p: curve.getPointAt(u), t: curve.getTangentAt(u) }); }
    const fr = (s) => {
      const f = Math.min(NT - 1e-6, Math.max(0, s / L * NT)), i = Math.floor(f), w = f - i;
      const p = tab[i].p.clone().lerp(tab[i + 1].p, w), T = tab[i].t.clone().lerp(tab[i + 1].t, w).normalize();
      return { p: p, T: T, N: new V3(0, T.z, -T.y) };   // N: rearwards
    };
    const hw = (s) => 0.0101 + 0.0013 * sm(0, 0.024, s) + 0.0018 * sm(0.085, 0.13, s);
    const hf = (s) => 0.0176 + 0.0018 * sm(0.09, 0.13, s);
    const hb = (s) => 0.0180 + 0.0050 * sm(0.085, 0.132, s);
    const dome = 0.016;
    const endK = (s) => { const u = Math.max(0, (s - (L - dome)) / dome); return Math.pow(Math.max(0, 1 - Math.pow(u, 2.3)), 1 / 2.3); };
    const M = 2.7;
    function base(s, a) {
      const f = fr(s), c = Math.cos(a), si = Math.sin(a), e = endK(s);
      const sn = spow(c, 2 / M), sx = spow(si, 2 / M);
      const d = sn * (c >= 0 ? hb(s) : hf(s)) * e;
      const w = sx * hw(s) * (1 - 0.14 * Math.max(0, -sn)) * e;
      return f.p.addScaledVector(f.N, d).add(new V3(w, 0, 0));
    }
    function nrm(s, a) {
      const s0 = Math.max(0, Math.min(L - 1e-4, s)), ds = 2e-4, da = 2e-3;
      const dA = base(s0, a + da).sub(base(s0, a - da)), dS = base(Math.min(L, s0 + ds), a).sub(base(Math.max(0, s0 - ds), a));
      const n = new V3().crossVectors(dA, dS);
      if (n.lengthSq() < 1e-24) return fr(s0).T.clone();
      if (n.dot(base(s0, a).sub(fr(s0).p)) < 0) n.negate();
      return n.normalize();
    }
    // a grid sheet: at(j, i) -> {s, a, off}; uvAt(j, i, s, a) -> [u, v]
    function sheet(nj, ni, at, uvAt) {
      const pos = [], nor = [], uv = [], idx = [];
      for (let j = 0; j <= nj; j++) {
        for (let i = 0; i <= ni; i++) {
          const q = at(j, i), p = base(q.s, q.a), n = nrm(q.s, q.a);
          p.addScaledVector(n, q.off || 0);
          pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z);
          const t = uvAt(j, i, q.s, q.a); uv.push(t[0], t[1]);
        }
      }
      for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
        const a = j * (ni + 1) + i, b = (j + 1) * (ni + 1) + i;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      // wind the triangles so they face along the stored normals
      for (let t = 0; t < idx.length; t += 3) {
        const A = new V3().fromArray(pos, idx[t] * 3), B = new V3().fromArray(pos, idx[t + 1] * 3), C = new V3().fromArray(pos, idx[t + 2] * 3);
        const fn = new V3().subVectors(B, A).cross(new V3().subVectors(C, A));
        if (fn.lengthSq() < 1e-16) continue;
        const nn = new V3().fromArray(nor, idx[t] * 3);
        if (fn.dot(nn) < 0) for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
        break;
      }
      g.setIndex(idx);
      return g;
    }
    const sCap = (a) => 0.101 - 0.020 * Math.pow(Math.max(0, Math.cos(a)), 1.3);
    const NA = 72;
    return { L: L, fr: fr, base: base, nrm: nrm, sheet: sheet, sCap: sCap, NA: NA, hb: hb };
  }

  // ------------------------------------------------------------------------------------------------ build
  function build(ctx) {
    const col = ctx.col;
    const aniso = Math.min(8, ctx.anisotropy || 4);
    const tex = (cv) => {
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
      if (ctx.srgb) t.encoding = THREE.sRGBEncoding;
      return t;
    };
    const engrT = tex(engravingCanvas()), cylT = tex(cylinderCanvas()), barT = tex(barrelCanvas()), woodT = tex(woodCanvas());
    const envT = tex(envCanvas()); envT.mapping = THREE.EquirectangularReflectionMapping; envT.wrapS = envT.wrapT = THREE.ClampToEdgeWrapping;

    const silver = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: engrT, bumpMap: engrT, bumpScale: 0.00026, specular: col(0xf2f4f8), shininess: 64, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.32 });
    const silverCyl = silver.clone(); silverCyl.map = cylT; silverCyl.bumpMap = cylT;
    const steel = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: barT, bumpMap: barT, bumpScale: 0.00008, specular: col(0x8d939c), shininess: 60, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.10 });
    // every material is the same Phong variant (map + bump + env, mix blend) so the gun costs one shader compile
    const gold = new THREE.MeshPhongMaterial({ color: col(0xe8b44c), map: engrT, bumpMap: engrT, bumpScale: 0.00018, specular: col(0xffdc8a), shininess: 80, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.12 });
    const wood = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: woodT, bumpMap: woodT, bumpScale: 0.00006, specular: col(0x4a3022), shininess: 40, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.04 });
    const dark = new THREE.MeshPhongMaterial({ color: col(0x202124), map: engrT, bumpMap: engrT, bumpScale: 0.00005, specular: col(0x202224), shininess: 20, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.04 });

    const mesh = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; return m; };
    const root = new THREE.Group();
    root.name = 'gunModel';

    // ---------------------------------------------------------------- barrel (octagonal, browned, silver inlay), muzzle
    const BY = 0.044, APO = 0.0106, MZ = -0.262, BREECH = -0.1052;
    const barrel = mesh(octPrism(APO, MZ + 0.004, BREECH, 0.0007, 1, 1, 0), steel);
    barrel.position.y = BY; root.add(barrel);
    // gold muzzle ring with the bore
    const ringS = shapeFrom(octPts(APO + 0.0007));
    const boreH = new THREE.Path(); boreH.absarc(0, 0, 0.0056, 0, TAU, true); ringS.holes.push(boreH);
    const ring = mesh(extrudeZ(ringS, MZ - 0.0002, MZ + 0.0050, { bevel: 0.0006, curve: 16 }), gold);
    ring.position.y = BY; root.add(ring);
    const boreGeo = new THREE.CylinderGeometry(0.0056, 0.0056, 0.05, 20, 1, true);
    { const ix = boreGeo.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } const n = boreGeo.attributes.normal.array; for (let i = 0; i < n.length; i++) n[i] = -n[i]; }
    const bore = mesh(boreGeo, dark);
    bore.rotation.x = Math.PI / 2; bore.position.set(0, BY, MZ + 0.025); root.add(bore);
    // engraved silver band behind the ring, the breech band, a thin gold line in front of it
    const band1 = mesh(octPrism(APO + 0.0004, MZ + 0.0049, MZ + 0.0085, 0.0007, 0.13, 0, 0.06), silver);
    band1.position.y = BY; root.add(band1);
    const band2 = mesh(octPrism(APO + 0.0009, -0.1345, -0.1158, 0.0008, 0.13, 0, 0.31), silver);
    band2.position.y = BY; root.add(band2);
    const band3 = mesh(octPrism(APO + 0.0007, -0.1360, -0.1343, 0.0006, 0.13, 0, 0.03), gold);
    band3.position.y = BY; root.add(band3);
    // front sight: a small silver blade
    const fs = new THREE.Shape();
    fs.moveTo(-0.2568, BY + APO - 0.0004); fs.lineTo(-0.2562, BY + APO + 0.0026);
    fs.quadraticCurveTo(-0.2536, BY + APO + 0.0058, -0.2504, BY + APO + 0.0032);
    fs.lineTo(-0.2486, BY + APO - 0.0004); fs.closePath();
    root.add(mesh(extrudeSide(fs, 0.0011, { bevel: 0.0003 }), silver));

    // ---------------------------------------------------------------- grip geometry first (the frame's rear follows its back)
    const G = makeGrip();
    const back = (s) => { const p = G.base(s, 0); return [p.z, p.y]; };

    // ---------------------------------------------------------------- frame
    const HW = 0.0110;
    const fr = new THREE.Shape();
    fr.moveTo(-0.1160, 0.0455);
    fr.quadraticCurveTo(-0.1160, 0.0558, -0.1080, 0.0558);
    fr.lineTo(-0.0495, 0.0558);
    fr.lineTo(-0.0495, 0.0335);
    fr.lineTo(-0.0160, 0.0335);
    const b0 = back(0);
    fr.quadraticCurveTo(-0.0090, 0.0335, b0[0], b0[1]);
    for (const s of [0.003, 0.006, 0.009, 0.012]) { const b = back(s); fr.lineTo(b[0], b[1]); }
    fr.quadraticCurveTo(-0.0090, 0.0170, -0.0200, 0.0050);
    fr.quadraticCurveTo(-0.0290, -0.0040, -0.0320, -0.0100);
    fr.quadraticCurveTo(-0.0345, -0.0130, -0.0390, -0.0135);
    fr.quadraticCurveTo(-0.0450, -0.0165, -0.0535, -0.0165);
    fr.lineTo(-0.0535, 0.0465);
    fr.lineTo(-0.1050, 0.0465);
    fr.lineTo(-0.1050, -0.0165);
    fr.lineTo(-0.1100, -0.0165);
    fr.quadraticCurveTo(-0.1160, -0.0165, -0.1160, -0.0080);
    fr.closePath();
    root.add(mesh(extrudeSide(fr, HW, { bevel: 0.0009 }), silver));
    // hammer housing: two cheeks either side of the hammer slot, sweeping down into the backstrap
    const ear = new THREE.Shape();
    ear.moveTo(-0.0495, 0.0310);
    ear.lineTo(-0.0495, 0.0558);
    ear.lineTo(-0.0420, 0.0558);
    ear.quadraticCurveTo(-0.0270, 0.0558, -0.0185, 0.0445);
    ear.quadraticCurveTo(-0.0110, 0.0350, b0[0], b0[1]);
    const b4 = back(0.004); ear.lineTo(b4[0], b4[1]);
    ear.lineTo(-0.0100, 0.0290);
    ear.closePath();
    const EW = (HW - 0.0036) / 2;
    for (const sgn of [1, -1]) root.add(mesh(extrudeSide(ear, EW, { bevel: 0.0007, x: sgn * (0.0036 + EW) }), silver));
    // recoil shield: a round plate behind the cylinder (covers the chamber mouths that stand out past the frame)
    {
      const rs = new THREE.Shape(); rs.absarc(0, 0.022, 0.0190, 0, TAU, false);
      root.add(mesh(extrudeZ(rs, -0.0536, -0.0496, { bevel: 0.0006, curve: 24 }), silver));
    }
    // bottom strap under the cylinder, scooped on the left so the cylinder swings out past it
    const strap = shapeFrom([[HW, -0.0018], [-0.0025, -0.0018], [-0.0034, -0.0050], [-0.0046, -0.0080], [-0.0064, -0.0110], [-0.0080, -0.0130],
      [-0.0095, -0.0145], [-HW, -0.0162], [-HW, -0.0170], [HW, -0.0170]]);
    root.add(mesh(extrudeZ(strap, -0.1020, -0.0532, { bevel: 0.0006 }), silver));
    // the rounded belly under the cylinder window (the lock's curved bottom); the guard grows out of it
    const belly = new THREE.Shape();
    belly.moveTo(-0.1056, -0.0160); belly.lineTo(-0.0530, -0.0160);
    belly.quadraticCurveTo(-0.0793, -0.0262, -0.1056, -0.0160);
    root.add(mesh(extrudeSide(belly, HW - 0.0004, { bevel: 0.0012, seg: 4, curve: 24 }), silver));
    // pierced scroll plate in front of the frame, under the barrel
    const pp = new THREE.Shape();
    pp.moveTo(-0.1150, 0.0340);
    pp.lineTo(-0.1440, 0.0340);
    pp.quadraticCurveTo(-0.1530, 0.0340, -0.1532, 0.0268);
    pp.quadraticCurveTo(-0.1534, 0.0190, -0.1455, 0.0180);
    pp.quadraticCurveTo(-0.1395, 0.0175, -0.1370, 0.0125);
    pp.quadraticCurveTo(-0.1320, 0.0030, -0.1240, -0.0010);
    pp.quadraticCurveTo(-0.1195, -0.0035, -0.1150, -0.0040);
    pp.closePath();
    for (const h of [[-0.1462, 0.0262, 0.0033], [-0.1360, 0.0264, 0.0027], [-0.1272, 0.0230, 0.0024], [-0.1262, 0.0128, 0.0020], [-0.1212, 0.0050, 0.0015]]) {
      const hp = new THREE.Path(); hp.absarc(h[0], h[1], h[2], 0, TAU, true); pp.holes.push(hp);
    }
    root.add(mesh(extrudeSide(pp, 0.0048, { bevel: 0.0007 }), silver));
    // screws (domed, slotted)
    const screwGeo = new THREE.SphereGeometry(0.0019, 18, 8, 0, TAU, 0, Math.PI / 2);
    const slotGeo = new THREE.BoxGeometry(0.0034, 0.00045, 0.0006);
    for (const sp of [[-0.0340, 0.0265], [-0.0440, 0.0020], [-0.1105, 0.0040]]) {
      for (const sgn of [1, -1]) {
        const sc = mesh(screwGeo, silver);
        sc.scale.set(1, 0.38, 1); sc.rotation.z = -sgn * Math.PI / 2; sc.position.set(sgn * (HW - 0.0002), sp[1], sp[0]);
        root.add(sc);
        const sl = mesh(slotGeo, dark); sl.position.set(sgn * (HW + 0.0005), sp[1], sp[0]); sl.rotation.x = 0.6; sl.rotation.y = Math.PI / 2;
        root.add(sl);
      }
    }

    // ---------------------------------------------------------------- trigger + guard
    const tr = new THREE.Shape();
    tr.moveTo(-0.0572, -0.0100);
    tr.quadraticCurveTo(-0.0606, -0.0150, -0.0624, -0.0205);
    tr.quadraticCurveTo(-0.0638, -0.0268, -0.0606, -0.0318);
    tr.quadraticCurveTo(-0.0592, -0.0334, -0.0584, -0.0314);
    tr.quadraticCurveTo(-0.0602, -0.0250, -0.0590, -0.0200);
    tr.quadraticCurveTo(-0.0576, -0.0150, -0.0546, -0.0100);
    tr.closePath();
    root.add(mesh(extrudeSide(tr, 0.0017, { bevel: 0.0005 }), silver));
    const gpts = [
      [-0.0815, -0.0110], [-0.0832, -0.0190], [-0.0806, -0.0285], [-0.0735, -0.0355], [-0.0630, -0.0390], [-0.0520, -0.0392],
      [-0.0420, -0.0362], [-0.0345, -0.0302], [-0.0288, -0.0238],
      [-0.0246, -0.0182], [-0.0240, -0.0132], [-0.0270, -0.0104], [-0.0308, -0.0118], [-0.0318, -0.0160], [-0.0293, -0.0188], [-0.0266, -0.0174], [-0.0268, -0.0148],
    ].map((p) => new V3(0, p[1], p[0]));
    const gcurve = new THREE.CatmullRomCurve3(gpts, false, 'centripetal');
    root.add(mesh(new THREE.TubeGeometry(gcurve, 240, 0.0016, 10, false), silver));
    const knob = mesh(new THREE.SphereGeometry(0.0025, 18, 12), silver);
    knob.scale.set(0.9, 0.85, 1.5); knob.position.set(0, -0.0393, -0.0575); root.add(knob);
    const tipK = mesh(new THREE.SphereGeometry(0.0021, 14, 10), silver);
    tipK.position.set(0, -0.0148, -0.0268); root.add(tipK);

    // ---------------------------------------------------------------- grip: wood, backstrap, butt cap, cross inlay, lanyard ring
    const NA = G.NA, L = G.L;
    const woodGeo = G.sheet(NA, 70, (j, i) => { const a = j / NA * TAU; return { s: (G.sCap(a) + 0.0025) * i / 70, a: a, off: 0 }; },
      (j, i, s) => [j / NA, s / 0.10]);
    root.add(mesh(woodGeo, wood));
    // the top end of the wood (inside the frame)
    {
      const f0 = G.fr(0), pos = [f0.p.x, f0.p.y, f0.p.z], idx = [];
      for (let j = 0; j <= NA; j++) { const p = G.base(0, j / NA * TAU); pos.push(p.x, p.y, p.z); }
      // wind the fan so it faces up the grip (-T)
      const A = new V3().fromArray(pos, 0), B = new V3().fromArray(pos, 3), C = new V3().fromArray(pos, 6);
      const flip = new V3().subVectors(C, A).cross(new V3().subVectors(B, A)).dot(f0.T) > 0;
      for (let j = 0; j < NA; j++) idx.push(0, flip ? j + 1 : j + 2, flip ? j + 2 : j + 1);
      const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      tg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2)); tg.setIndex(idx); tg.computeVertexNormals();
      root.add(mesh(tg, wood));
    }
    const capGeo = G.sheet(NA, 46, (j, i) => { const a = j / NA * TAU, s0 = G.sCap(a); return { s: s0 + (L - s0) * Math.pow(i / 46, 0.85), a: a, off: 0.0007 }; },
      (j, i, s) => [j / NA * 2, s * ENGR]);
    root.add(mesh(capGeo, silver));
    // a raised rim along the cap's edge
    {
      const pts = [];
      for (let j = 0; j < 120; j++) { const a = j / 120 * TAU, sc = G.sCap(a); pts.push(G.base(sc, a).addScaledVector(G.nrm(sc, a), 0.0008)); }
      root.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'centripetal'), 240, 0.0009, 8, true), silver));
    }
    // backstrap: a raised engraved strip down the back, widening into the frame and into the cap
    const wb = (s) => 0.64 + 0.26 * (1 - sm(0, 0.03, s)) + 0.25 * sm(0.06, 0.095, s);
    const NK = 12;
    const strapGeo = G.sheet(NK + 2, 60, (j, i) => {
      const edge = j === 0 || j === NK + 2, k = Math.min(1, Math.max(-1, (j - 1) / NK * 2 - 1));
      const sEnd = G.sCap(k * wb(0.09)) + 0.002, s = sEnd * i / 60, a = k * wb(s);
      return { s: s, a: a, off: edge ? -0.0002 : 0.0005 };
    }, (j, i, s, a) => [a * 0.02 * ENGR, s * ENGR]);
    root.add(mesh(strapGeo, silver));
    // cross inlays on both sides of the grip
    const cross = new THREE.Shape();
    {
      const pts = [];
      for (let q = 0; q < 4; q++) {
        const a = q * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
        const P = (u, v) => [ca * u - sa * v, sa * u + ca * v];
        pts.push(P(0.0011, -0.0008), P(0.0040, -0.0021), P(0.0036, 0), P(0.0040, 0.0021), P(0.0011, 0.0008));
      }
      cross.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) cross.lineTo(pts[i][0], pts[i][1]); cross.closePath();
    }
    const crossGeo = creaseNormals(new THREE.ExtrudeGeometry(cross, { depth: 0.0004, bevelEnabled: true, bevelThickness: 0.0002, bevelSize: 0.0002, bevelOffset: -0.0002, bevelSegments: 2 }), 40);
    scaleUV(crossGeo, ENGR);
    for (const a of [Math.PI / 2, -Math.PI / 2]) {
      const s = 0.040, p = G.base(s, a), n = G.nrm(s, a), up = G.fr(s).T.clone().negate();
      up.addScaledVector(n, -up.dot(n)).normalize();
      const xx = new V3().crossVectors(up, n);
      const m = mesh(crossGeo, silver);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, up, n));
      m.position.copy(p).addScaledVector(n, -0.0001);
      root.add(m);
    }
    // lanyard eye + ring at the lowest point of the cap
    {
      let lo = null;
      for (let i = 0; i <= 40; i++) for (let j = 0; j < 48; j++) {
        const s = L - 0.03 + 0.03 * i / 40, p = G.base(s, j / 48 * TAU);
        if (!lo || p.y < lo.y) lo = p;
      }
      const eye = mesh(new THREE.TorusGeometry(0.0022, 0.0008, 10, 24), silver);
      eye.position.set(0, lo.y - 0.0010, lo.z); root.add(eye);
      const lr = mesh(new THREE.TorusGeometry(0.0052, 0.0008, 10, 40), silver);
      lr.rotation.y = Math.PI / 2; lr.rotation.x = 0.35; lr.position.set(0, lo.y - 0.0010 - 0.0022 - 0.0044, lo.z + 0.0016); root.add(lr);
    }

    // ---------------------------------------------------------------- cylinder: hinge below-left of the centre, spin at the centre
    const C = new V3(0, 0.022, -0.078), R = 0.023, CL = 0.048;
    const swing = new THREE.Group(); swing.name = 'cylSwing'; swing.position.set(C.x - 0.1 * R, C.y - 1.02 * R, C.z); root.add(swing);
    const spin = new THREE.Group(); spin.name = 'cylSpin'; spin.position.set(0.1 * R, 1.02 * R, 0); swing.add(spin);
    {
      const cs = new THREE.Shape(); cs.absarc(0, 0, R, 0, TAU, false);
      for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3, h = new THREE.Path(); h.absarc(Math.cos(a) * 0.0132, Math.sin(a) * 0.0132, 0.0049, 0, TAU, true); cs.holes.push(h); }
      const ch = new THREE.Path(); ch.absarc(0, 0, 0.0026, 0, TAU, true); cs.holes.push(ch);
      const bt = 0.0012;
      let g = new THREE.ExtrudeGeometry(cs, { depth: CL - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bt, bevelOffset: -bt, bevelSegments: 4, curveSegments: 28 });
      g.translate(0, 0, -CL / 2 + bt);
      g = creaseNormals(g, 40);
      // regroup: faces (engraved silver), outer drum (cartouches), chamber walls (dark)
      const P = g.attributes.position.array, Nn = g.attributes.normal.array, U = g.attributes.uv.array, nt = P.length / 9;
      const buckets = [[], [], []];
      for (let t = 0; t < nt; t++) {
        let cx = 0, cy = 0, nz = 0;
        for (let v = 0; v < 3; v++) { cx += P[t * 9 + v * 3]; cy += P[t * 9 + v * 3 + 1]; nz += Nn[t * 9 + v * 3 + 2]; }
        const rr = Math.hypot(cx / 3, cy / 3); nz = Math.abs(nz / 3);
        buckets[rr > 0.0205 ? 1 : nz > 0.55 ? 0 : 2].push(t);
      }
      const pos = [], nor = [], uv = [], groups = [];
      buckets.forEach((b, gi) => {
        const start = pos.length / 3;
        for (const t of b) {
          const us = [];
          for (let v = 0; v < 3; v++) {
            const o = t * 9 + v * 3;
            pos.push(P[o], P[o + 1], P[o + 2]); nor.push(Nn[o], Nn[o + 1], Nn[o + 2]);
            if (gi === 1) us.push([(Math.atan2(P[o + 1], P[o]) / TAU + 1) % 1, (P[o + 2] + CL / 2) / CL]);
            else us.push([U[t * 6 + v * 2] * ENGR, U[t * 6 + v * 2 + 1] * ENGR]);
          }
          if (gi === 1) { const mx = Math.max(us[0][0], us[1][0], us[2][0]); for (const q of us) if (mx - q[0] > 0.5) q[0] += 1; }
          for (const q of us) uv.push(q[0], q[1]);
        }
        groups.push([start, pos.length / 3 - start, gi]);
      });
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      cg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      cg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      for (const q of groups) cg.addGroup(q[0], q[1], q[2]);
      spin.add(mesh(cg, [silver, silverCyl, dark]));
      // ejector star on the rear face
      const st = new THREE.Shape();
      for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6, rr = k % 2 ? 0.0040 : 0.0064; if (k) st.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else st.moveTo(rr, 0); }
      st.closePath();
      const star = mesh(scaleUV(new THREE.ShapeGeometry(st), ENGR), silver);
      star.position.z = CL / 2 + 0.0002; spin.add(star);
    }
    // crane arm in front of the cylinder (swings with it) and its knuckle on the hinge axis
    {
      const sx = 0.1 * R, sy = 1.02 * R, d = Math.hypot(sx, sy), ux = sx / d, uy = sy / d, px = -uy, py = ux, r0 = 0.0034, r1 = 0.0046, pts = [];
      for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + i / 12 * Math.PI, c = Math.cos(a), s = Math.sin(a); pts.push([(ux * c + px * s) * r0, (uy * c + py * s) * r0]); }
      for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + i / 12 * Math.PI, c = Math.cos(a), s = Math.sin(a); pts.push([sx + (ux * c + px * s) * r1, sy + (uy * c + py * s) * r1]); }
      const arm = mesh(extrudeZ(shapeFrom(pts), -0.0268, -0.0244, { bevel: 0.0004 }), silver);
      swing.add(arm);
      const kn = mesh(new THREE.CylinderGeometry(0.0031, 0.0031, 0.0062, 20), silver);
      kn.rotation.x = Math.PI / 2; kn.position.z = -0.0275; swing.add(kn);
    }

    // ---------------------------------------------------------------- hammer: tall swan neck, cocked at rest
    const pivot = new THREE.Group(); pivot.name = 'hammerPivot'; pivot.position.set(0, 0.027, -0.034); root.add(pivot);
    {
      // profile in the cocked pose (shape x = z offset from the pivot, shape y = y offset): body in the frame, an S-curved
      // swan neck rising out of the slot, and a long head ("jaw") that rises to the rear as the thumb piece
      const hm = new THREE.Shape();
      hm.moveTo(0.0055, -0.0050);
      hm.lineTo(-0.0055, -0.0055);
      hm.lineTo(-0.0088, 0.0040);
      hm.lineTo(-0.0082, 0.0140);
      hm.quadraticCurveTo(-0.0040, 0.0210, -0.0012, 0.0268);
      hm.quadraticCurveTo(0.0004, 0.0310, -0.0014, 0.0345);
      hm.quadraticCurveTo(-0.0034, 0.0372, -0.0022, 0.0396);
      hm.lineTo(-0.0024, 0.0418);
      hm.quadraticCurveTo(-0.0022, 0.0440, 0.0004, 0.0442);
      hm.quadraticCurveTo(0.0120, 0.0450, 0.0205, 0.0468);
      hm.quadraticCurveTo(0.0232, 0.0472, 0.0230, 0.0448);
      hm.quadraticCurveTo(0.0226, 0.0428, 0.0196, 0.0426);
      hm.quadraticCurveTo(0.0120, 0.0418, 0.0074, 0.0392);
      hm.quadraticCurveTo(0.0052, 0.0370, 0.0060, 0.0330);
      hm.quadraticCurveTo(0.0072, 0.0285, 0.0052, 0.0240);
      hm.quadraticCurveTo(0.0040, 0.0190, 0.0068, 0.0130);
      hm.quadraticCurveTo(0.0098, 0.0060, 0.0090, 0.0010);
      hm.quadraticCurveTo(0.0082, -0.0035, 0.0055, -0.0050);
      pivot.add(mesh(extrudeSide(hm, 0.0032, { bevel: 0.0009, curve: 10 }), silver));
      // the jaw screw on top of the head
      const post = mesh(new THREE.CylinderGeometry(0.0010, 0.0010, 0.0040, 12), silver);
      post.position.set(0, 0.0462, 0.0080); post.rotation.x = -0.10; pivot.add(post);
      const cap = mesh(new THREE.SphereGeometry(0.0020, 16, 10), silver);
      cap.scale.set(1, 0.55, 1); cap.position.set(0, 0.0484, 0.0082); pivot.add(cap);
    }

    return {
      root: root,
      muzzle: new V3(0, BY, MZ),
      cyl: { swing: swing, spin: spin, axisLocal: new V3(0, 0, 1), swingSign: 1, center: C.clone(), radius: R },
      hammer: { pivot: pivot, axisLocal: new V3(1, 0, 0), dirSign: 1, center: pivot.position.clone() },
      grip: new THREE.Box3(new V3(-0.012, -0.072, -0.035), new V3(0.012, 0.020, 0.035)),
      gripTopZ: -0.017, gripBotZ: 0.015,
    };
  }

  window.GunModel = { build: build };
})();
