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
   plate under it; a bright nickel frame, cylinder (oval cartouches) and swan-neck hammer, all finely engraved; a thin
   scroll-curled trigger guard; a walnut bird's-head grip with an engraved backstrap, a silver cross inlay, and a big
   engraved butt cap (double border) with a lanyard ring. Five canvas textures: the all-over engraving, the cylinder drum
   (oval cartouches), barrel inlay, walnut grain and a small equirectangular environment that gives the metal its reflections.
   Engraving = fine dense arabesque: S- and C-scrolls (swell cuts) sprouting from one another with small lobed acanthus leaves,
   dark cuts on bright silver, grown on an occupancy grid with a seeded PRNG (deterministic); the same canvas is the bump map,
   so the cuts sit recessed. */
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
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const mix = (a, b, t) => a + (b - a) * t;
  // periodic value-noise fbm on [0,1)^2 (tiles seamlessly); cx / cy lattice cells of the first octave
  function makeFbm(seed, cx, cy, oct, gain) {
    const r = prng(seed), layers = [];
    let amp = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      const nx = cx << o, ny = cy << o, g = new Float32Array(nx * ny);
      for (let i = 0; i < g.length; i++) g[i] = r();
      layers.push({ nx: nx, ny: ny, g: g, amp: amp });
      norm += amp; amp *= gain;
    }
    return function (u, v) {
      let s = 0;
      for (let k = 0; k < layers.length; k++) {
        const L = layers[k], x = u * L.nx, y = v * L.ny;
        let xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        xi = ((xi % L.nx) + L.nx) % L.nx; yi = ((yi % L.ny) + L.ny) % L.ny;
        const x1 = (xi + 1) % L.nx, y1 = (yi + 1) % L.ny;
        const a = L.g[yi * L.nx + xi], b = L.g[yi * L.nx + x1], c = L.g[y1 * L.nx + xi], d = L.g[y1 * L.nx + x1];
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        s += L.amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
      return s / norm;
    };
  }
  // sample a periodic function on a coarse gw x gh grid once, return a bilinear (periodic) lookup: smooth noise at a fraction
  // of the cost of evaluating every octave per pixel
  function coarse(fn, gw, gh) {
    const a = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) a[y * gw + x] = fn(x / gw, y / gh);
    return function (u, v) {
      const x = u * gw, y = v * gh;
      let xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      xi = ((xi % gw) + gw) % gw; yi = ((yi % gh) + gh) % gh;
      const x1 = (xi + 1) % gw, y1 = (yi + 1) % gh;
      const p = a[yi * gw + xi], q = a[yi * gw + x1], r = a[y1 * gw + xi], s = a[y1 * gw + x1];
      return p + (q - p) * fx + (r - p) * fy + (p - q - r + s) * fx * fy;
    };
  }

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
  // (normalsOf / polyPath / leafPath / engrave: the raised-band engraver, now only used for the barrel's inlaid vine)
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

  // ------------------------------------------------------------------------------------------------ dense arabesque
  // Fine scrollwork grown on a grid in a texture's own pixel space (K scales every size: lines, curls, gaps). Stems are
  // S-scrolls / C-scrolls (an S bulge, then a clothoid curl) that sprout from one another and carry small lobed acanthus
  // leaves; an occupancy grid keeps every cut clear of its neighbours, so the gaps fill with ever smaller curls.
  function occGrid(w, h, wrapX, wrapY, cell) {
    const nx = Math.ceil(w / cell), ny = Math.ceil(h / cell), a = new Int32Array(nx * ny);
    const at = (x, y) => {
      let i = Math.floor(x / cell), j = Math.floor(y / cell);
      if (wrapX) { i %= nx; if (i < 0) i += nx; } else if (i < 0 || i >= nx) return -1;
      if (wrapY) { j %= ny; if (j < 0) j += ny; } else if (j < 0 || j >= ny) return -1;
      return j * nx + i;
    };
    const disc = (x, y, r, fn) => {
      const n = Math.ceil(r / cell), rr = r * r + cell * cell * 0.5;
      for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
        if ((di * di + dj * dj) * cell * cell > rr) continue;
        if (fn(at(x + di * cell, y + dj * cell))) return true;
      }
      return false;
    };
    return {
      mask(inside) { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!inside((i + 0.5) * cell, (j + 0.5) * cell)) a[j * nx + i] = -1; },
      mark(x, y, r, id) { disc(x, y, r, (k) => { if (k >= 0 && a[k] === 0) a[k] = id; return false; }); },
      blocked(x, y, r, ign) { return disc(x, y, r, (k) => k < 0 || (a[k] !== 0 && a[k] !== ign)); },
    };
  }
  // an acanthus leaf along a bent rib: scalloped outline, midrib, hatching on the shaded half. rib: [[x, y]...]; returns the cut geometry
  function leafGeom(rib, wf, K, r) {
    const n = rib.length, out = [], lft = [], rgt = [], nl = 2 + Math.floor(r() * 2) + 0.5, ph = r();
    for (let i = 0; i < n; i++) {
      const a = rib[Math.max(0, i - 1)], b = rib[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      const t = i / (n - 1), base = wf(t);
      const wl = base * (0.64 + 0.36 * Math.pow(Math.abs(Math.sin(Math.PI * (nl * t + ph))), 0.8));
      const wr = base * 0.82 * (0.64 + 0.36 * Math.pow(Math.abs(Math.sin(Math.PI * (nl * t + ph + 0.5))), 0.8));
      lft.push([rib[i][0] + nx * wl, rib[i][1] + ny * wl]); rgt.push([rib[i][0] - nx * wr, rib[i][1] - ny * wr]);
    }
    for (const p of lft) out.push(p);
    for (let i = n - 1; i >= 0; i--) out.push(rgt[i]);
    const hatch = [], L = Math.hypot(rib[n - 1][0] - rib[0][0], rib[n - 1][1] - rib[0][1]);
    if (L > 34 * K) for (let i = 3; i < n - 2; i += 2) hatch.push([rib[i][0] * 0.82 + lft[i][0] * 0.18, rib[i][1] * 0.82 + lft[i][1] * 0.18, rib[i][0] * 0.3 + lft[i][0] * 0.7, rib[i][1] * 0.3 + lft[i][1] * 0.7]);
    return { out: out, rib: rib, hatch: hatch, lw: Math.max(1.3, Math.min(2.5, L * 0.062)) * Math.max(0.7, K) };
  }

  function growArabesque(o) {
    const K = o.K, r = o.rand, ds = Math.max(1.8, 2.0 * K), clear = 3.4 * K;
    const occ = occGrid(o.w, o.h, !!o.wrapX, !!o.wrapY, Math.max(2, Math.round(1.6 * K)));
    if (o.mask) occ.mask(o.mask);
    const stems = [], leaves = [];
    let nid = 1;
    const rnd = (a, b) => a + (b - a) * r();
    const wprof = (t, w0, wm, w1) => { const u = 1 - t, wc = 2 * wm - 0.5 * (w0 + w1); return Math.max(0.9, u * u * w0 + 2 * u * t * wc + t * t * w1); };
    const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };

    // an S bulge (bending against the curl), then a log-like volute: radius of curvature R0 shrinking by c per unit length to rho
    function trace(x, y, a, P) {
      const Lc = (P.R0 - P.rho) / P.c, L = P.ls + Lc, n = Math.max(8, Math.round(L / ds)), st = L / n, pts = [[x, y, a]];
      for (let i = 0; i < n; i++) {
        const s = (i + 0.5) * st;
        let k;
        if (s < P.ls) k = -P.dir * P.kb * Math.sin(Math.PI * s / P.ls);
        else { const u = s - P.ls, q = Math.min(1, u / P.ramp); k = P.dir * q * q * (3 - 2 * q) / (P.R0 - P.c * u); }
        a += k * st; x += Math.cos(a) * st; y += Math.sin(a) * st;
        pts.push([x, y, a]);
      }
      return pts;
    }
    // longest collision-free prefix of a candidate (half widths hw[]); the first nIgn points may touch `ign` (the parent)
    function fit(pts, hw, ign, nIgn, minFrac) {
      const n = pts.length;
      let hmax = 0; for (let i = 0; i < n; i++) if (hw[i] > hmax) hmax = hw[i];
      const nSelf = Math.ceil(2.2 * (2 * hmax + clear) / ds) + 1;
      let m = n;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        let bad = occ.blocked(p[0], p[1], hw[i] + clear * 0.5, i < nIgn ? ign : 0);
        for (let j = 0; !bad && j <= i - nSelf; j++) {
          const q = pts[j], d = hw[i] + hw[j] + clear * 0.8, dx = p[0] - q[0], dy = p[1] - q[1];
          if (dx * dx + dy * dy < d * d) bad = true;
        }
        if (bad) { m = i; break; }
      }
      return m >= Math.max(6, Math.ceil(minFrac * n)) ? m : 0;
    }
    function commitStem(pts, m, w0, wm, w1, sc) {
      const id = nid++, out = [];
      for (let i = 0; i < m; i++) {
        const w = wprof(i / (m - 1), w0, wm, w1);
        out.push([pts[i][0], pts[i][1], w, pts[i][2]]);
        occ.mark(pts[i][0], pts[i][1], w * 0.5 + clear * 0.5, id);
      }
      const st = { id: id, pts: out, sc: sc };
      stems.push(st);
      return st;
    }
    function scrollParams(sc, dir) {
      return { dir: dir, ls: rnd(3, 18) * K * sc, kb: 1 / (rnd(40, 90) * K * sc), ramp: 14 * K * sc, R0: rnd(28, 42) * K * sc,
        c: rnd(0.19, 0.27), rho: Math.max(3.2 * K, rnd(4.2, 5.6) * K * Math.pow(sc, 0.8)) };
    }
    function tryScroll(x, y, a, dir, sc, w0f, ign, nIgn, minFrac) {
      const P = scrollParams(sc, dir), pts = trace(x, y, a, P), n = pts.length;
      const wm = rnd(4.2, 5.6) * K * Math.pow(sc, 0.9), w0 = w0f(wm), w1 = 1.1 * Math.max(0.8, K), hw = [];
      for (let i = 0; i < n; i++) hw.push(wprof(i / (n - 1), w0, wm, w1) * 0.5);
      const m = fit(pts, hw, ign, nIgn, minFrac);
      return m ? commitStem(pts, m, w0, wm, w1, sc) : null;
    }
    // an S-scroll: two stems leaving the same point in opposite directions, curling the same way (point symmetric)
    function root(x, y, a, sc) {
      const dir = r() < 0.5 ? 1 : -1;
      const A = tryScroll(x, y, a, dir, sc, (wm) => wm * 0.92, 0, 0, 0.95);
      if (!A) return false;
      tryScroll(x, y, a + Math.PI, dir, sc * rnd(0.8, 1.05), (wm) => wm * 0.92, A.id, 12, 0.93);
      return true;
    }
    function attachScroll(par, idx, sd, sc) {
      const p = par.pts[idx], a = p[3], al = rnd(0.3, 0.8);
      const x = p[0] - Math.sin(a) * sd * p[2] * 0.2, y = p[1] + Math.cos(a) * sd * p[2] * 0.2;
      return tryScroll(x, y, a + sd * al, sd, sc, (wm) => Math.max(wm * 0.5, Math.min(wm, p[2] * 0.85)), par.id, Math.ceil((p[2] + 2 * clear) / ds) + 4, 0.95);
    }
    function attachLeaf(par, idx, sd, L, W) {
      const p = par.pts[idx], a = p[3], al = rnd(0.5, 1.0), c0 = rnd(0.35, 0.8), c1 = rnd(0.9, 1.8);
      let x = p[0] - Math.sin(a) * sd * p[2] * 0.3, y = p[1] + Math.cos(a) * sd * p[2] * 0.3, h = a + sd * al;
      const N = Math.max(8, Math.round(L / (ds * 0.9))), st = L / N, rib = [[x, y]];
      for (let i = 0; i < N; i++) {
        const t = (i + 0.5) / N;
        h -= sd * (c0 + c1 * t * t) / N;
        x += Math.cos(h) * st; y += Math.sin(h) * st; rib.push([x, y]);
      }
      const wf = (t) => W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.85);
      const hw = rib.map((q, i) => wf(i / N) + 1.0);
      const m = fit(rib, hw, par.id, Math.ceil((p[2] + 2 * clear) / ds) + 3, 0.999);
      if (!m) return false;
      const id = nid++;
      rib.forEach((q, i) => occ.mark(q[0], q[1], hw[i] + clear * 0.35, id));
      leaves.push(leafGeom(rib, wf, K, r));
      return true;
    }

    // 1: S-scrolls at the seeds
    for (const sp of o.roots) for (let k = 0; k < 4; k++) if (root(sp[0] + (k ? rnd(-30, 30) * K : 0), sp[1] + (k ? rnd(-30, 30) * K : 0), r() * TAU, o.rootScale || 1)) break;
    // 2: ever smaller scrolls sprouting from the stems already there
    const sprout = (sc) => {
      const parents = shuffle(stems.filter((s) => s.sc > sc * 1.15));
      for (const par of parents) {
        const n = par.pts.length, step = Math.max(3, Math.round((22 + 60 * sc) * K / ds));
        for (let i = Math.floor(n * rnd(0.05, 0.2)); i < n * 0.92; i += Math.max(2, Math.round(step * rnd(0.7, 1.3)))) {
          const sd = r() < 0.5 ? 1 : -1;
          if (!attachScroll(par, i, sd, sc * rnd(0.92, 1.08))) attachScroll(par, i, -sd, sc * rnd(0.85, 1));
        }
      }
    };
    const foliage = (Lb, minSc) => {
      for (const par of shuffle(stems.slice())) {
        if (par.sc < minSc) continue;
        const n = par.pts.length, step = Math.max(3, Math.round(Lb * 0.9 * K / ds));
        for (let i = Math.floor(n * rnd(0.04, 0.2)); i < n - 3; i += Math.max(2, Math.round(step * rnd(0.8, 1.25)))) {
          const sd = r() < 0.5 ? 1 : -1, L = Lb * K * rnd(0.85, 1.15);
          if (!attachLeaf(par, i, sd, L, L * rnd(0.27, 0.36))) attachLeaf(par, i, -sd, L * 0.8, L * 0.25);
        }
      }
    };
    const free = (sc, tries) => {
      for (let t = 0; t < tries; t++) root(r() * o.w, r() * o.h, r() * TAU, sc * rnd(0.9, 1.1));
    };
    for (const lv of o.levels) {
      if (typeof lv === 'object') free(lv.free, lv.n); else if (lv > 0) sprout(lv); else foliage(-lv, 0);
    }
    return { stems: stems, leaves: leaves, w: o.w, h: o.h, K: K };
  }

  // lay the cuts into the canvas: a lit lip up-left of every cut, a soft penumbra, then the dark core. offs: wrap offsets
  function paintCuts(g, A, offs, K, mx) {
    const pad = 40 * K;
    const polys = A.stems.map((s) => {
      const pts = s.pts, n = pts.length, L = [], R = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i], a = p[3], hw = p[2] * 0.5, nx = -Math.sin(a), ny = Math.cos(a);
        L.push([p[0] + nx * hw, p[1] + ny * hw]); R.push([p[0] - nx * hw, p[1] - ny * hw]);
      }
      return L.concat(R.reverse());
    });
    const bbox = (pl) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of pl) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0 - 4, y0 - 4, x1 + 4, y1 + 4]; };
    const items = [];
    A.stems.forEach((s, i) => items.push({ t: 0, pl: polys[i], bb: bbox(polys[i]) }));
    A.leaves.forEach((l) => items.push({ t: 1, l: l, pl: l.out, bb: bbox(l.out) }));
    const path = (pl) => { g.beginPath(); g.moveTo(pl[0][0], pl[0][1]); for (let i = 1; i < pl.length; i++) g.lineTo(pl[i][0], pl[i][1]); g.closePath(); };
    const hl = 1.1 * Math.max(0.8, K);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const pass = (mode) => {
      for (const o of offs) {
        g.save(); g.translate(o[0] + (mode === 0 ? -hl : 0), o[1] + (mode === 0 ? -hl : 0));
        for (const it of items) {
          if (it.bb[2] + o[0] < -pad || it.bb[0] + o[0] > A.w + pad || it.bb[3] + o[1] < -pad || it.bb[1] + o[1] > A.h + pad) continue;
          const sw = it.t ? it.l.lw : 0;
          if (mode === 0) {
            g.fillStyle = g.strokeStyle = 'rgba(255,255,255,0.85)';
            if (it.t) { g.lineWidth = sw; path(it.pl); g.stroke(); } else { path(it.pl); g.fill(); }
          } else if (mode === 1) {
            g.fillStyle = g.strokeStyle = 'rgba(54,56,62,0.34)';
            g.lineWidth = sw + 2.0 * Math.max(0.8, K); path(it.pl); if (!it.t) g.fill(); g.stroke();
          } else {
            g.fillStyle = g.strokeStyle = 'rgba(16,17,21,0.97)';
            if (it.t) {
              g.lineWidth = sw; path(it.pl); g.stroke();
              const rb = it.l.rib, n = rb.length;
              g.lineWidth = Math.max(1.1, sw * 0.62); g.beginPath();
              for (let i = 1; i < n - 2; i++) { if (i === 1) g.moveTo(rb[i][0], rb[i][1]); else g.lineTo(rb[i][0], rb[i][1]); }
              g.stroke();
              if (it.l.hatch.length) { g.lineWidth = Math.max(0.9, sw * 0.42); g.beginPath(); for (const h of it.l.hatch) { g.moveTo(h[0], h[1]); g.lineTo(h[2], h[3]); } g.stroke(); }
            } else { path(it.pl); g.fill(); }
          }
        }
        g.restore();
      }
    };
    pass(0); pass(1); pass(2);
  }
  function wrapOffs(w, h) { const o = []; for (const dx of [-w, 0, w]) for (const dy of (h ? [-h, 0, h] : [0])) o.push([dx, dy]); return o; }

  // bright satin silver ground: soft patina blotches and a fine grain (the cuts are laid over it)
  function silverGround(g, w, h, r) {
    g.fillStyle = '#d3d6db'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * h, rad = 50 + r() * 150, dark = r() < 0.6;
      for (const o of wrapOffs(w, h)) {
        const gr = g.createRadialGradient(x + o[0], y + o[1], 0, x + o[0], y + o[1], rad);
        gr.addColorStop(0, dark ? 'rgba(70,74,84,0.10)' : 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + o[0] - rad, y + o[1] - rad, rad * 2, rad * 2);
      }
    }
    for (let i = 0, n = w * h / 14; i < n; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(64,68,76,0.09)' : 'rgba(255,255,255,0.16)';
      g.fillRect(r() * w, r() * h, 1, 1 + (r() < 0.2 ? 1 : 0));
    }
  }

  // tileable all-over arabesque (frame, hammer, guard, butt cap, bands): 6 cm per tile, ~0.6 mm swell cuts, curls 2-5 mm
  function engravingCanvas() {
    const S = 1024, K = 1.2, c = mkCanvas(S, S), g = c.getContext('2d'), r = prng(11);
    silverGround(g, S, S, r);
    const roots = [];
    for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) roots.push([(i + 0.5) * S / 6 + (r() - 0.5) * 70, (j + 0.5) * S / 6 + (r() - 0.5) * 70]);
    const A = growArabesque({ w: S, h: S, wrapX: true, wrapY: true, K: K, rand: r, roots: roots, rootScale: 1,
      levels: [0.7, -34, { free: 0.8, n: 200 }, 0.62, { free: 0.55, n: 200 }, 0.52, -26, { free: 0.4, n: 300 }, 0.4, 0.3, -19, { free: 0.3, n: 400 }, 0.23, -14] });
    paintCuts(g, A, wrapOffs(S, S), K);
    return c;
  }

  // a ruled (single stroked) cut with the same lit lip / penumbra / core as the scroll cuts. drawPath() builds the path
  function cutStroke(g, drawPath, w, K) {
    const hl = 1.1 * Math.max(0.8, K);
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    g.save(); g.translate(-hl, -hl); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = w; drawPath(); g.stroke(); g.restore();
    g.strokeStyle = 'rgba(54,56,62,0.42)'; g.lineWidth = w + 2.4 * Math.max(0.8, K); drawPath(); g.stroke();
    g.strokeStyle = 'rgba(16,17,21,0.97)'; g.lineWidth = w; drawPath(); g.stroke();
    g.restore();
  }
  function ellipsePath(g, cx, cy, rx, ry) { return () => { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); }; }

  // the cylinder drum: u runs round it (14.5 cm over 1024 px), v along the axis (4.8 cm over 512 px). Drawn in a stretched
  // space so the curls come out round. Four oval cartouches (mirrored arabesque round a rosette) in a field of small scrolls,
  // double rules at both ends.
  function cylinderCanvas() {
    const W = 1024, H = 512, DH = 340, c = mkCanvas(W, H), g = c.getContext('2d'), r = prng(23);
    silverGround(g, W, H, r);
    g.save(); g.scale(1, H / DH);
    const cy = DH / 2, rx = 88, ry = 128, KF = 0.46, KM = 0.38, cxs = [];
    for (let k = 0; k < 4; k++) for (const o of [-W, 0, W]) { const x = k * 256 + o; if (x > -rx - 20 && x < W + rx + 20) cxs.push(x); }
    const inField = (x, y) => {
      if (y < 27 || y > DH - 27) return false;
      for (const cx of cxs) { const dx = (x - cx) / (rx + 17), dy = (y - cy) / (ry + 17); if (dx * dx + dy * dy < 1) return false; }
      return true;
    };
    const roots = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) roots.push([i * 256 + 128 + (r() - 0.5) * 30, 60 + j * 74 + (r() - 0.5) * 30]);
    const F = growArabesque({ w: W, h: DH, wrapX: true, wrapY: false, K: KF, rand: r, roots: roots, rootScale: 0.9, mask: inField,
      levels: [0.6, -30, { free: 0.7, n: 200 }, 0.5, -26, { free: 0.5, n: 400 }, 0.4, -20, { free: 0.36, n: 600 }, 0.3, -16, { free: 0.26, n: 800 }, 0.2, -12] });
    paintCuts(g, F, wrapOffs(W, 0), KF);
    // one cartouche interior: grown in the left half (local frame, origin at the cartouche's left edge), mirrored about the axis
    const lw = rx + 4, lh = 2 * ry + 12, lcx = lw, lcy = ry + 6;
    const inCart = (x, y) => {
      if (x > lcx - 11) return false;
      const dx = (x - lcx) / (rx - 15), dy = (y - lcy) / (ry - 15);
      if (dx * dx + dy * dy > 1) return false;
      if (Math.hypot(x - lcx, y - lcy) < 26) return false;
      if (Math.hypot(x - lcx, Math.abs(y - lcy) - (ry - 36)) < 21) return false;
      return true;
    };
    const mroots = [];
    for (let j = 0; j < 6; j++) for (let i = 0; i < 2; i++) mroots.push([18 + i * 36 + (r() - 0.5) * 12, 26 + j * 42 + (r() - 0.5) * 14]);
    const M = growArabesque({ w: lw, h: lh, wrapX: false, wrapY: false, K: KM, rand: r, roots: mroots, rootScale: 0.9, mask: inCart,
      levels: [0.62, -26, { free: 0.55, n: 200 }, 0.46, -19, { free: 0.42, n: 400 }, 0.34, 0.26, -14, { free: 0.32, n: 500 }, 0.22, -11, { free: 0.24, n: 600 }, 0.18, -9] });
    for (const cx of cxs) {
      for (const mir of [1, -1]) {
        g.save(); g.translate(cx, cy - lcy);
        if (mir > 0) g.translate(-lcx, 0); else { g.scale(-1, 1); g.translate(-lcx, 0); }
        paintCuts(g, M, [[0, 0]], KM);
        g.restore();
      }
    }
    // frames: a bold rule inside a fine one, the axis, a rosette in the middle and a leaf fan at both ends
    for (const x of cxs) {
      cutStroke(g, ellipsePath(g, x, cy, rx, ry), 3.6, KF);
      cutStroke(g, ellipsePath(g, x, cy, rx - 8.5, ry - 8.5), 1.6, KF);
      cutStroke(g, () => { g.beginPath(); g.moveTo(x, cy - ry + 40); g.lineTo(x, cy + ry - 40); }, 1.6, KF);
      const rr = prng(7);
      const petals = { A: { stems: [], leaves: [], w: W, h: DH, K: KM } };
      const leaf = (px, py, ang, L, Wd, bend) => {
        const rib = []; let hx = px, hy = py, h = ang;
        for (let i = 0; i <= 12; i++) { rib.push([hx, hy]); h += bend / 12 * (0.6 + i / 12); hx += Math.cos(h) * L / 12; hy += Math.sin(h) * L / 12; }
        petals.A.leaves.push(leafGeom(rib, (t) => Wd * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.85), KM, rr));
      };
      for (let q = 0; q < 8; q++) leaf(x, cy, q * Math.PI / 4 + 0.2, 22, 6.5, 0.5);
      for (const sg of [-1, 1]) {
        const py = cy + sg * (ry - 36);
        for (const da of [-0.95, 0, 0.95]) leaf(x, py, -sg * Math.PI / 2 + da * -sg, da ? 21 : 26, da ? 5.5 : 6.5, da * 0.4);
      }
      paintCuts(g, petals.A, [[0, 0]], KM);
    }
    for (const y of [7, 15, DH - 7, DH - 15]) {
      const bold = y === 7 || y === DH - 7;
      cutStroke(g, () => { g.beginPath(); g.moveTo(-10, y); g.lineTo(W + 10, y); }, bold ? 3.6 : 1.6, KF);
    }
    g.restore();
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

  // walnut: u runs round the grip (the tile wraps twice), v down it. Flowing, warped growth rings, dark streaks, a faint
  // fiddleback figure and elongated pores (tileable). Warm dark brown; used as map and bump (pores / latewood sit lower).
  function woodCanvas() {
    const W = 512, H = 1024, c = mkCanvas(W, H), g = c.getContext('2d');
    const img = g.createImageData(W, H), d = img.data;
    const w1 = coarse(makeFbm(301, 3, 2, 4, 0.5), 96, 128), w2 = coarse(makeFbm(302, 8, 4, 3, 0.5), 192, 192), st = coarse(makeFbm(303, 5, 1, 4, 0.55), 160, 64);
    const pore = makeFbm(304, 220, 24, 1, 1), tone = coarse(makeFbm(305, 2, 2, 3, 0.5), 64, 64);
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, i = (y * W + x) * 4;
        const a = w1(u, v), b = w2(u, v);
        const ring = u * 15 + (a - 0.5) * 3.4 + (b - 0.5) * 0.8 + 0.35 * Math.sin(TAU * v + a * 4);
        const f = ring - Math.floor(ring);
        const late = sm(0.42, 0.74, f) * (1 - sm(0.84, 1.0, f));
        const fl = 0.5 + 0.5 * Math.sin(TAU * (u * 90 + (a - 0.5) * 22));
        const streak = sm(0.58, 0.80, st(u, v));
        const fig = 0.5 + 0.5 * Math.sin(TAU * (v * 34 + b * 4));
        const pr = sm(0.80, 0.92, pore(u, v));
        const dk = clamp01(late * 0.70 + streak * 0.55 + pr * 0.45);
        const t = (0.80 + 0.26 * tone(u, v)) * (0.90 + 0.10 * fl) * (0.95 + 0.07 * fig);
        d[i] = clamp01(mix(0.34, 0.07, dk) * t) * 255; d[i + 1] = clamp01(mix(0.17, 0.032, dk) * t) * 255; d[i + 2] = clamp01(mix(0.085, 0.018, dk) * t) * 255; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
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

    const silver = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: engrT, bumpMap: engrT, bumpScale: 0.00014, specular: col(0xf2f4f8), shininess: 64, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.32 });
    const silverCyl = silver.clone(); silverCyl.map = cylT; silverCyl.bumpMap = cylT;
    const steel = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: barT, bumpMap: barT, bumpScale: 0.00008, specular: col(0x8d939c), shininess: 60, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.10 });
    // every material is the same Phong variant (map + bump + env, mix blend) so the gun costs one shader compile
    const gold = new THREE.MeshPhongMaterial({ color: col(0xe8b44c), map: engrT, bumpMap: engrT, bumpScale: 0.00018, specular: col(0xffdc8a), shininess: 80, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.12 });
    const wood = new THREE.MeshPhongMaterial({ color: col(0xffffff), map: woodT, bumpMap: woodT, bumpScale: 0.00005, specular: col(0x33261b), shininess: 24, envMap: envT, combine: THREE.MixOperation, reflectivity: 0.03 });
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
      (j, i, s) => [j / NA * 2, s / 0.11]);
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
      // ... and a fine wire inside it: the cap is framed by a double border
      const pts2 = [];
      for (let j = 0; j < 120; j++) { const a = j / 120 * TAU, sc = G.sCap(a) + 0.0044; pts2.push(G.base(sc, a).addScaledVector(G.nrm(sc, a), 0.0008)); }
      root.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts2, true, 'centripetal'), 240, 0.00036, 6, true), silver));
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
