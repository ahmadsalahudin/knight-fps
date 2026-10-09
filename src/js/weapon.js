/* weapon.js — window.Weapon: first-person revolver viewmodel (B2).

   The viewmodel lives in its OWN scene + camera (Weapon.scene / Weapon.camera, FOV 60, aspect synced with the main
   camera) and is drawn by Weapon.render(renderer) AFTER the world render with the depth buffer cleared, so the gun
   can never clip into knights, trees or rocks.

   Public API (docs/FIX_PLAN.md "Weapon"):
     init(camera, renderer)           build the viewmodel (revolver + bare pale hands), lights, flash
     fire() -> THREE.Vector3          recoil spring + hammer drop + cylinder step + muzzle flash + world PointLight;
                                      returns the muzzle position in WORLD space (for tracers)
     reload(ms)                       tilt, swing the cylinder out, spin, snap it back; timed to ms (dt driven)
     update(dt, {moving, sprinting, aimDelta})   walk bob, sprint lowering, mouse-lag sway, idle breathing
     render(renderer)                 draw the viewmodel on top of the world
     muzzleWorldPosition(target)      muzzle in world space
     resize(w, h)                     keep the viewmodel aspect in sync (main.js calls it on window resize)
   Extras: isReloading(), isFlashing(), setVisible(on), state() and, with ?debug=1, window.__dbg.weapon.*

   Everything is driven by the dt passed to update(); there are no timers. */
(function () {
  'use strict';

  const DEG = Math.PI / 180;
  const VM_FOV = 60;          // fixed viewmodel field of view
  const GUN_LEN = 0.30;       // revolver length in world units (grip heel to muzzle)
  // rigged hands (see _buildRiggedHands): size, where the knuckle row sits on the grip ([down the grip, right, rearwards] from its top),
  // how far the hand is turned round the grip, and the finger angles of the grip / reload poses
  const HAND_SCALE = 0.86;
  const CYL_HALF = 0.024;      // half the cylinder length (centre -> chamber mouths)
  const GRIP_AT = [0.034, 0.018, -0.0145];
  const GRIP_ROLL = 0.12;
  const GRIP_WRIST = 0.6;      // 0 = forearm straight on from the hand (up the grip rake), 1 = fully down / back / right
  const GRIP_POSE = {
    f: [[-0.05, 0.45, 0.90, 0.35], [0, 1.45, 1.55, 0.55], [0, 1.50, 1.55, 0.55], [0, 1.55, 1.50, 0.55]],    // index on the trigger, the rest round the grip
    t: [[1, 0, 0, -0.40], [0, 0, 1, -0.25], [0, 0, 1, -0.10]],                                                  // thumb along the left of the frame
  };
  const RELOAD_POSE = (c, w) => {
    const k = (i) => Math.max(0, Math.min(1, c + (w || 0) * (0.06 - i * 0.03)));
    return {
      f: [0, 1, 2, 3].map((i) => [0.02 * (1.5 - i), 0.25 + 0.75 * k(i), 0.35 + 0.95 * k(i), 0.20 + 0.55 * k(i)]),
      t: [[0, 0, 1, 0.10 + 0.20 * c], [0, 0, 1, 0.10 + 0.25 * c], [0, 0, 1, 0.05 + 0.20 * c]],
    };
  };
  const V3 = THREE.Vector3;

  // ---------------------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };

  // piecewise smoothstep through keyframes [[p, value], ...] (p ascending)
  function kf(p, keys) {
    if (p <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (p <= keys[i][0]) {
        const a = keys[i - 1], b = keys[i];
        return lerp(a[1], b[1], smooth((p - a[0]) / (b[0] - a[0] || 1)));
      }
    }
    return keys[keys.length - 1][1];
  }

  // damped spring, sub-stepped so large dt (virtual clock steps, slow headless frames) stay stable
  function Spring(omega, zeta) { this.x = 0; this.v = 0; this.w = omega; this.z = zeta; }
  Spring.prototype.step = function (dt, target) {
    target = target || 0;
    const n = Math.max(1, Math.ceil(dt / 0.006)), h = dt / n;
    const k = this.w * this.w, c = 2 * this.z * this.w;
    for (let i = 0; i < n; i++) {
      this.v += (-k * (this.x - target) - c * this.v) * h;
      this.x += this.v * h;
    }
  };
  // velocity that makes the spring peak at `peak` (critically damped approximation)
  Spring.prototype.kick = function (peak) { this.v += peak * this.w * Math.E * 0.92; };

  // ---------------------------------------------------------------------------------------------------------
  // procedural textures (muzzle flash)
  // ---------------------------------------------------------------------------------------------------------
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  // pale skin: warm base, soft blotches, fine pores, faint blue-green veins and creases (generated, 256 px, wraps)
  function makeSkinTexture(base, shade) {
    const t = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      const wrap = (x, y, r, fn) => { for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { if (x + ox + r < 0 || x + ox - r > w || y + oy + r < 0 || y + oy - r > h) continue; fn(x + ox, y + oy); } };
      let seed = 1337; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 70; i++) {                       // soft blood-flush and shade blotches
        const x = rnd() * w, y = rnd() * h, r = 18 + rnd() * 40, warm = rnd() < 0.5;
        wrap(x, y, r, (cx, cy) => { const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r); const c = warm ? '255,150,130' : shade; gr.addColorStop(0, 'rgba(' + c + ',0.10)'); gr.addColorStop(1, 'rgba(' + c + ',0)'); g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2); });
      }
      g.lineCap = 'round';
      for (let i = 0; i < 9; i++) {                        // faint veins
        const x = rnd() * w, y = rnd() * h, a = rnd() * 6.28; g.strokeStyle = 'rgba(120,140,170,0.10)'; g.lineWidth = 2 + rnd() * 2.5; g.beginPath(); g.moveTo(x, y);
        g.bezierCurveTo(x + Math.cos(a) * 30, y + Math.sin(a) * 30, x + Math.cos(a + 1) * 60, y + Math.sin(a + 1) * 60, x + Math.cos(a + 0.4) * 90, y + Math.sin(a + 0.4) * 90); g.stroke();
      }
      g.strokeStyle = 'rgba(150,100,85,0.16)';             // skin creases
      for (let i = 0; i < 26; i++) { const x = rnd() * w, y = rnd() * h, l = 14 + rnd() * 26; g.lineWidth = 0.8 + rnd() * 0.8; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y + (rnd() - 0.5) * 8, x + l, y + (rnd() - 0.5) * 6); g.stroke(); }
      const img = g.getImageData(0, 0, w, h), d = img.data;   // fine grain + pores
      for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 14; d[i] += n; d[i + 1] += n * 0.9; d[i + 2] += n * 0.8; }
      g.putImageData(img, 0, 0);
      for (let i = 0; i < 900; i++) { g.fillStyle = 'rgba(120,70,60,' + (0.05 + rnd() * 0.07) + ')'; g.beginPath(); g.arc(rnd() * w, rnd() * h, 0.6 + rnd() * 0.7, 0, 6.28); g.fill(); }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  function makeStarTexture() {
    return canvasTex(128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.translate(w / 2, h / 2);
      // spikes
      const spikes = [[0, 62, 5], [72, 44, 4], [144, 52, 4.5], [216, 46, 4], [288, 40, 4], [36, 30, 3], [180, 28, 3]];
      g.globalCompositeOperation = 'lighter';
      for (const s of spikes) {
        g.save();
        g.rotate(s[0] * DEG);
        const gr = g.createLinearGradient(0, 0, s[1], 0);
        gr.addColorStop(0, 'rgba(255,236,170,0.95)');
        gr.addColorStop(1, 'rgba(255,120,30,0)');
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(0, -s[2]); g.lineTo(s[1], 0); g.lineTo(0, s[2]); g.closePath(); g.fill();
        g.restore();
      }
      const r = g.createRadialGradient(0, 0, 0, 0, 0, 34);
      r.addColorStop(0, 'rgba(255,255,240,1)');
      r.addColorStop(0.35, 'rgba(255,214,120,0.9)');
      r.addColorStop(1, 'rgba(255,110,20,0)');
      g.fillStyle = r;
      g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.fill();
    });
  }

  function makeJetTexture() {
    // elongated flame: bright at the muzzle end (left), fading to the right
    return canvasTex(128, 64, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const gr = g.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, 'rgba(255,250,220,1)');
      gr.addColorStop(0.25, 'rgba(255,200,100,0.85)');
      gr.addColorStop(1, 'rgba(255,90,10,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, h * 0.5 - 14);
      g.quadraticCurveTo(w * 0.55, h * 0.5 - 22, w, h * 0.5);
      g.quadraticCurveTo(w * 0.55, h * 0.5 + 22, 0, h * 0.5 + 14);
      g.closePath(); g.fill();
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // the kick (Weapon.kick): the player's right leg. Generated leather and wool, lofted / revolved surfaces.
  // ---------------------------------------------------------------------------------------------------------
  const KICK_IMPACT = 0.16, KICK_DUR = 0.6;    // seconds: the sole lands at KICK_IMPACT, the leg is gone again at KICK_DUR
  const UPV = new V3(0, 1, 0);

  function seededRnd(seed) { let s = (seed | 0) || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

  // tileable value noise (0..1) on a w x h grid with `cells` lattice cells across
  function tileNoise(w, h, cells, rnd) {
    const n = cells, lat = new Float32Array(n * n), out = new Float32Array(w * h);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < h; y++) {
      const fy = y / h * n, y0 = Math.floor(fy), ty = smooth(fy - y0), ya = (y0 % n) * n, yb = ((y0 + 1) % n) * n;
      for (let x = 0; x < w; x++) {
        const fx = x / w * n, x0 = Math.floor(fx), tx = smooth(fx - x0), xa = x0 % n, xb = (x0 + 1) % n;
        out[y * w + x] = lerp(lerp(lat[ya + xa], lat[ya + xb], tx), lerp(lat[yb + xa], lat[yb + xb], tx), ty);
      }
    }
    return out;
  }

  // cubic Hermite through [[x, y], ...] (x ascending), finite-difference tangents: smooth with no flat spots at the keys
  function spline(x, k) {
    const n = k.length;
    if (x <= k[0][0]) return k[0][1];
    if (x >= k[n - 1][0]) return k[n - 1][1];
    let i = 1;
    while (x > k[i][0]) i++;
    const x0 = k[i - 1][0], h = k[i][0] - x0, t = (x - x0) / h, t2 = t * t, t3 = t2 * t;
    const m0 = i > 1 ? (k[i][1] - k[i - 2][1]) / (k[i][0] - k[i - 2][0]) : (k[1][1] - k[0][1]) / h;
    const m1 = i < n - 1 ? (k[i + 1][1] - k[i - 1][1]) / (k[i + 1][0] - k[i - 1][0]) : (k[n - 1][1] - k[n - 2][1]) / h;
    return (2 * t3 - 3 * t2 + 1) * k[i - 1][1] + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * k[i][1] + (t3 - t2) * h * m1;
  }

  // Leather: a height field (soft hide undulation, pores, short wandering creases) turned into a colour canvas and a bump canvas.
  // o: { size, seed, dark, mid, light ([r, g, b] 0..255), pores, creases, pr (pore radius px) }
  function makeLeatherCanvases(o) {
    const S = o.size, N = S * S, rnd = seededRnd(o.seed), pr = o.pr || 3;
    const n1 = tileNoise(S, S, 3, rnd), n2 = tileNoise(S, S, 9, rnd), n3 = tileNoise(S, S, 30, rnd), hg = new Float32Array(N);
    for (let i = 0; i < N; i++) hg[i] = 0.6 + (n3[i] - 0.5) * 0.2 + (n2[i] - 0.5) * 0.1;
    const dip = (cx, cy, r, d) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const q = Math.sqrt(dx * dx + dy * dy) / r;
          if (q < 1) hg[((cy + dy + S) % S) * S + ((cx + dx + S) % S)] -= d * (1 - q) * (1 - q);
        }
      }
    };
    for (let i = 0; i < o.pores; i++) dip((rnd() * S) | 0, (rnd() * S) | 0, pr - 1 + ((rnd() * 3) | 0), 0.06 + rnd() * 0.08);
    for (let i = 0; i < o.creases; i++) {
      let x = rnd() * S, y = rnd() * S, a = rnd() * 6.283;
      const len = 25 + rnd() * 70;
      for (let k = 0; k < len; k++) { dip(Math.round(x), Math.round(y), 1, 0.07); a += (rnd() - 0.5) * 0.3; x += Math.cos(a); y += Math.sin(a); }
    }
    const col = document.createElement('canvas'), bmp = document.createElement('canvas');
    col.width = col.height = bmp.width = bmp.height = S;
    const gc = col.getContext('2d'), gb = bmp.getContext('2d'), ic = gc.createImageData(S, S), ib = gb.createImageData(S, S), dc = ic.data, db = ib.data;
    const D = o.dark, M = o.mid, L = o.light;
    for (let i = 0; i < N; i++) {
      const h = clamp(hg[i], 0, 1), t = clamp(0.5 + (h - 0.58) * 0.7 + (n1[i] - 0.5) * 0.55, 0, 1), tint = 0.96 + n2[i] * 0.08;
      let r, g, b;
      if (t < 0.5) { const k = t * 2; r = D[0] + (M[0] - D[0]) * k; g = D[1] + (M[1] - D[1]) * k; b = D[2] + (M[2] - D[2]) * k; }
      else { const k = (t - 0.5) * 2; r = M[0] + (L[0] - M[0]) * k; g = M[1] + (L[1] - M[1]) * k; b = M[2] + (L[2] - M[2]) * k; }
      dc[i * 4] = r * tint; dc[i * 4 + 1] = g * tint; dc[i * 4 + 2] = b * tint; dc[i * 4 + 3] = 255;
      db[i * 4] = db[i * 4 + 1] = db[i * 4 + 2] = h * 255; db[i * 4 + 3] = 255;
    }
    gc.putImageData(ic, 0, 0); gb.putImageData(ib, 0, 0);
    return { color: col, bump: bmp };
  }

  // Wool: a twill (diagonal ridges 16 px apart, so it tiles), fibre noise, heathered mottling, light and dark flecks.
  function makeWoolCanvases(o) {
    const S = 256, N = S * S, rnd = seededRnd(o.seed), n1 = tileNoise(S, S, 4, rnd), n2 = tileNoise(S, S, 16, rnd);
    const col = document.createElement('canvas'), bmp = document.createElement('canvas');
    col.width = col.height = bmp.width = bmp.height = S;
    const gc = col.getContext('2d'), gb = bmp.getContext('2d'), ic = gc.createImageData(S, S), ib = gb.createImageData(S, S), dc = ic.data, db = ib.data;
    const D = o.dark, M = o.mid, L = o.light;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x, ridge = 0.5 + 0.5 * Math.cos(((x + y) % 16) / 16 * 6.2832), fib = rnd();
        const t = clamp(0.42 + ridge * 0.05 + (fib - 0.5) * 0.18 + (n1[i] - 0.5) * 0.42 + (n2[i] - 0.5) * 0.16, 0, 1);
        let r, g, b;
        if (t < 0.5) { const k = t * 2; r = D[0] + (M[0] - D[0]) * k; g = D[1] + (M[1] - D[1]) * k; b = D[2] + (M[2] - D[2]) * k; }
        else { const k = (t - 0.5) * 2; r = M[0] + (L[0] - M[0]) * k; g = M[1] + (L[1] - M[1]) * k; b = M[2] + (L[2] - M[2]) * k; }
        dc[i * 4] = r; dc[i * 4 + 1] = g; dc[i * 4 + 2] = b; dc[i * 4 + 3] = 255;
        db[i * 4] = db[i * 4 + 1] = db[i * 4 + 2] = (ridge * 0.7 + fib * 0.3) * 255; db[i * 4 + 3] = 255;
      }
    }
    for (let i = 0; i < 300; i++) {            // flecks: pale undyed fibres and dark burrs
      const p = (((rnd() * S) | 0) * S + ((rnd() * S) | 0)) * 4, pale = rnd() < 0.6, k = pale ? 1.45 : 0.62;
      for (let c = 0; c < 3; c++) { dc[p + c] *= k; dc[p + 4 + c] *= k; }
    }
    gc.putImageData(ic, 0, 0); gb.putImageData(ib, 0, 0);
    return { color: col, bump: bmp };
  }

  // Parametric grid mesh. fn(u, v, out) writes out[0..2] (position) and optionally out[3] (the v texture coordinate); u is the column
  // direction (wraps round a tube when `wrap`: the seam normals are welded). Triangles are wound to face away from `ref` ([x, y, z], a point
  // inside the solid), so the callers never have to think about handedness.
  function gridSurface(nu, nv, fn, wrap, ref) {
    const cols = nu + 1, count = cols * (nv + 1), P = new Float32Array(count * 3), UV = new Float32Array(count * 2), o = [0, 0, 0, -1];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        o[3] = -1; fn(i / nu, j / nv, o);
        const k = j * cols + i;
        P[k * 3] = o[0]; P[k * 3 + 1] = o[1]; P[k * 3 + 2] = o[2];
        UV[k * 2] = i / nu; UV[k * 2 + 1] = o[3] >= 0 ? o[3] : j / nv;
      }
    }
    const m = (nv >> 1) * cols + (nu >> 2), a = m * 3, b = (m + cols) * 3, c = (m + 1) * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const flip = nx * (P[a] - ref[0]) + ny * (P[a + 1] - ref[1]) + nz * (P[a + 2] - ref[2]) < 0;
    const I = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p = j * cols + i, q = p + cols;
        if (flip) I.push(p, p + 1, q, q, p + 1, q + 1); else I.push(p, q, p + 1, q, q + 1, p + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    if (wrap) {
      const N = g.attributes.normal;
      for (let j = 0; j <= nv; j++) {
        const k0 = j * cols, k1 = k0 + nu;
        const x = N.getX(k0) + N.getX(k1), y = N.getY(k0) + N.getY(k1), z = N.getZ(k0) + N.getZ(k1), l = Math.hypot(x, y, z) || 1;
        N.setXYZ(k0, x / l, y / l, z / l); N.setXYZ(k1, x / l, y / l, z / l);
      }
    }
    return g;
  }

  // Surface of revolution about the y axis through (0, *, cz): prof = [[y, r], ...] bottom to top, elliptical sections (ex, ez), u = 0 faces +z,
  // v follows the arc length of the profile. wob(theta, y) -> radius factor (cloth folds).
  function revolve(prof, nu, ex, ez, cz, wob) {
    const n = prof.length, arc = [0];
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
    const total = arc[n - 1] || 1;
    return gridSurface(nu, n - 1, (u, v, o) => {
      const j = Math.round(v * (n - 1)), y = prof[j][0], r = prof[j][1], th = u * 6.283185307, w = wob ? wob(th, y) : 1;
      o[0] = Math.sin(th) * r * ex * w; o[1] = y; o[2] = cz + Math.cos(th) * r * ez * w; o[3] = arc[j] / total;
    }, true, [0, (prof[0][0] + prof[n - 1][0]) / 2, cz]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // revolver geometry processing
  // ---------------------------------------------------------------------------------------------------------
  function classify(mat) {
    const m = Array.isArray(mat) ? mat[0] : mat;
    const n = ((m && m.name) || '').toLowerCase();
    if (n.indexOf('wood') >= 0) return 'wood';
    if (n.indexOf('light') >= 0) return 'light';
    if (n.indexOf('metal') >= 0) return 'dark';
    const c = m && m.color;
    if (!c) return 'dark';
    if (c.r > c.b * 1.4) return 'wood';
    return (c.r + c.g + c.b) / 3 > 0.08 ? 'light' : 'dark';
  }

  // Split an indexed mesh into welded-vertex connected components. Returns null for non-indexed geometry.
  function analyzeMesh(mesh) {
    const g = mesh.geometry;
    if (!g || !g.index || !g.attributes.position) return null;
    const pos = g.attributes.position, idx = g.index.array, count = pos.count;
    const first = new Map(), rep = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const key = pos.getX(i) + ',' + pos.getY(i) + ',' + pos.getZ(i);
      let r = first.get(key);
      if (r === undefined) { r = i; first.set(key, i); }
      rep[i] = r;
    }
    const parent = new Int32Array(count);
    for (let i = 0; i < count; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const triCount = idx.length / 3;
    for (let t = 0; t < triCount; t++) {
      const r0 = find(rep[idx[t * 3]]);
      for (let k = 1; k < 3; k++) { const r = find(rep[idx[t * 3 + k]]); if (r !== r0) parent[r] = r0; }
    }
    const comps = new Map();
    const tmp = new V3();
    for (let t = 0; t < triCount; t++) {
      const r = find(rep[idx[t * 3]]);
      let c = comps.get(r);
      if (!c) { c = { mesh: mesh, tris: [], box: new THREE.Box3() }; comps.set(r, c); }
      c.tris.push(t);
      for (let k = 0; k < 3; k++) {
        tmp.fromBufferAttribute(pos, idx[t * 3 + k]).applyMatrix4(mesh.matrixWorld);
        c.box.expandByPoint(tmp);
      }
    }
    return Array.from(comps.values());
  }

  // Build a new geometry from a list of triangles of `mesh`, with positions shifted by -origin (mesh-local).
  function carveGeometry(mesh, tris, origin) {
    const g = mesh.geometry, pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv, idx = g.index.array;
    const remap = new Map(), P = [], N = [], U = [], I = [];
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = idx[t * 3 + k];
        let ni = remap.get(vi);
        if (ni === undefined) {
          ni = P.length / 3; remap.set(vi, ni);
          P.push(pos.getX(vi) - origin.x, pos.getY(vi) - origin.y, pos.getZ(vi) - origin.z);
          if (nrm) N.push(nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi));
          if (uv) U.push(uv.getX(vi), uv.getY(vi));
        }
        I.push(ni);
      }
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    if (N.length) ng.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); else ng.computeVertexNormals();
    if (U.length) ng.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    ng.setIndex(I);
    ng.computeBoundingSphere(); ng.computeBoundingBox();
    return ng;
  }

  // Same attributes, but only the triangles NOT listed in `removed` (shares the vertex buffers).
  function remainderGeometry(mesh, removedSet) {
    const g = mesh.geometry, idx = g.index.array, keep = [];
    const triCount = idx.length / 3;
    for (let t = 0; t < triCount; t++) {
      if (removedSet.has(t)) continue;
      keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    }
    const ng = new THREE.BufferGeometry();
    for (const name of Object.keys(g.attributes)) ng.setAttribute(name, g.attributes[name]);
    ng.setIndex(keep);
    ng.computeBoundingSphere(); ng.computeBoundingBox();
    return ng;
  }

  // ---------------------------------------------------------------------------------------------------------
  // the Weapon module
  // ---------------------------------------------------------------------------------------------------------
  const Weapon = {
    scene: null,
    camera: null,
    ready: false,
    gunRig: null,       // legacy alias of the gun pivot (some tools poke at it)
    gun: null,

    // animation state ---------------------------------------------------------------------------------
    time: 0,
    S: null,            // springs
    rel: null,          // reload {t, dur} or null
    flashT: 1,          // seconds since the last shot (>= 0.06 means flash is over)
    flashOn: false,
    cylStep: 0,         // cylinder step angle currently shown (rad)
    cylFrom: 0, cylTo: 0, cylT: 1,
    hamT: 1,            // seconds since the hammer fell
    bobPhase: 0, bobAmp: 0, sprintBlend: 0,
    sway: { x: 0, y: 0, vx: 0, vy: 0 },
    lastYaw: null, lastPitch: null,
    _dbgView: null,
    kleg: null,         // the kick leg rig (see _buildKickLeg)
    kickT: -1,          // seconds into the kick, -1 = not kicking
    _kickW: 0,          // 0..1 how far the gun and hands have shifted for the kick
    _kickFreeze: -1,    // debug: hold the kick at this instant

    // -----------------------------------------------------------------------------------------------------
    init: function (camera, renderer) {
      this.mainCam = camera;
      this.renderer = renderer;
      this.srgb = !!(renderer && renderer.outputEncoding === THREE.sRGBEncoding);

      const aspect = camera && camera.aspect ? camera.aspect : innerWidth / innerHeight;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(VM_FOV, aspect, 0.01, 6);
      this.scene.add(this.camera);

      this._makeMaterials();
      this._makeLights();

      // rig: viewRoot (sway / bob / recoil) > gunPivot (rotates about the hold point) > gun + hand
      this.viewRoot = new THREE.Group();
      this.scene.add(this.viewRoot);
      this.gunPivot = new THREE.Group();
      this.viewRoot.add(this.gunPivot);
      this.gunRig = this.gunPivot;

      this.S = {
        kz: new Spring(24, 0.72),      // kick back toward the camera
        kp: new Spring(21, 0.62),      // muzzle flip (pitch)
        kc: new Spring(12, 0.85),       // slow muzzle climb
        kr: new Spring(20, 0.6),       // roll
        ky: new Spring(20, 0.7),       // yaw jitter
        kh: new Spring(18, 0.8)        // reload "clunk" bump
      };

      let ok = false;
      try { ok = this._buildModelGun(); } catch (e) { console.error('[Weapon] procedural gun model failed, using the GLB revolver', e); ok = false; }
      if (!ok) { try { ok = this._buildRevolver(); } catch (e) { console.error('[Weapon] revolver build failed, using fallback', e); } }
      if (!ok) this._buildFallbackGun();
      try { this._buildHands(); } catch (e) { console.error('[Weapon] hands build failed', e); }
      this._buildFlash();
      const kt0 = performance.now();
      try { this._buildKickLeg(); this._kickBuildMs = performance.now() - kt0; } catch (e) { console.error('[Weapon] kick leg build failed, Weapon.kick() is off', e); this.kleg = null; }

      this._applyPose(0);
      this.scene.updateMatrixWorld(true);
      this.ready = true;
      this._installDebug();
    },

    // -----------------------------------------------------------------------------------------------------
    _col: function (hex) {
      const c = new THREE.Color(hex);
      if (this.srgb && c.convertSRGBToLinear) c.convertSRGBToLinear();
      return c;
    },

    _makeMaterials: function () {
      const col = (h) => this._col(h);
      const skin = (b, sh) => { const t = makeSkinTexture(b, sh); if (this.srgb) t.encoding = THREE.sRGBEncoding; return t; };
      this.mats = {
        dark: new THREE.MeshPhongMaterial({ color: col(0x2c3036), specular: col(0x3a4046), shininess: 30 }),
        light: new THREE.MeshPhongMaterial({ color: col(0x626972), specular: col(0x545b63), shininess: 30 }),
        wood: new THREE.MeshPhongMaterial({ color: col(0x5d3a20), specular: col(0x34271a), shininess: 22 }),
        // bare, pale hands: generated skin textures, smooth shading, a little warm emissive so the shade side never goes grey
        skin: new THREE.MeshPhongMaterial({ color: 0xffffff, map: skin('#ecc6b4', '205,140,135'), specular: col(0x30262a), shininess: 14, emissive: col(0x1e0c08) }),
        skin2: new THREE.MeshPhongMaterial({ color: 0xf2dccf, map: skin('#e6bfa8', '190,140,135'), specular: col(0x30262a), shininess: 16, emissive: col(0x26100b) }),
        nail: new THREE.MeshPhongMaterial({ color: col(0xf0c4bb), specular: col(0xb0a6a4), shininess: 95, emissive: col(0x1c0b09) }),
        nailEdge: new THREE.MeshPhongMaterial({ color: col(0xf8ece6), specular: col(0xb0a6a4), shininess: 80, emissive: col(0x1a1412) }),
        sleeve: new THREE.MeshPhongMaterial({ color: col(0x4a5668), specular: col(0x141a22), shininess: 6 }),
        cuff: new THREE.MeshPhongMaterial({ color: col(0x3a2a1c), specular: col(0x16100a), shininess: 8 })
      };
    },

    _makeLights: function () {
      const sc = this.scene;
      this.vmHemi = new THREE.HemisphereLight(0xdfe9ff, 0x6b5a45, 0.95);
      sc.add(this.vmHemi);
      this.vmSun = new THREE.DirectionalLight(0xfff0d6, 1.25);
      this.vmSun.position.set(-0.6, 1.0, 0.7);
      sc.add(this.vmSun);
      this.vmFill = new THREE.DirectionalLight(0xb8c8e8, 0.35);
      this.vmFill.position.set(0.8, 0.1, 0.5);
      sc.add(this.vmFill);
      // muzzle flash light for the viewmodel itself (kept visible with intensity 0 so no shader recompiles)
      this.vmFlashLight = new THREE.PointLight(0xffa850, 0, 0.9, 2);
      sc.add(this.vmFlashLight);
      // world flash light (added to the main scene lazily; see _ensureWorldLight)
      this.worldLight = new THREE.PointLight(0xffa850, 0, 10, 2);
      this.worldLight.castShadow = false;
      this._worldLightAdded = false;
    },

    // -----------------------------------------------------------------------------------------------------
    // revolver
    // -----------------------------------------------------------------------------------------------------
    // the procedural revolver from gunmodel.js (window.GunModel; see the contract at the top of that file)
    _buildModelGun: function () {
      if (!window.GunModel || typeof GunModel.build !== 'function') return false;
      const r = GunModel.build({ col: (h) => this._col(h), srgb: this.srgb, anisotropy: this.renderer && this.renderer.capabilities ? this.renderer.capabilities.getMaxAnisotropy() : 4 });
      if (!r || !r.root || !r.muzzle || !r.grip) return false;
      r.root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
      this.gunPivot.add(r.root);
      this.gun = r.root;
      this.muzzle = new THREE.Object3D();
      this.muzzle.position.copy(r.muzzle);
      this.gunPivot.add(this.muzzle);
      const parts = { cyl: null, hammer: null };
      if (r.cyl && r.cyl.swing && r.cyl.spin) {
        parts.cyl = { swing: r.cyl.swing, spin: r.cyl.spin, axisLocal: r.cyl.axisLocal.clone().normalize(), swingSign: r.cyl.swingSign || 1, radius: r.cyl.radius };
        parts.cylCenterGun = r.cyl.center.clone();
      }
      if (r.hammer && r.hammer.pivot) {
        parts.hammer = { pivot: r.hammer.pivot, axisLocal: r.hammer.axisLocal.clone().normalize(), dirSign: r.hammer.dirSign || 1 };
        parts.hammerCtrGun = (r.hammer.center || r.hammer.pivot.position).clone();
      }
      this.parts = parts;
      r.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(r.root);
      this.gunPivot.updateMatrixWorld(true);
      box.applyMatrix4(new THREE.Matrix4().copy(this.gunPivot.matrixWorld).invert());
      this.lm = {
        box: box, grip: r.grip.clone(), muzzle: r.muzzle.clone(), length: box.max.z - box.min.z,
        scale: 1, rotY: 0, hasWood: true, gripTopZ: r.gripTopZ, gripBotZ: r.gripBotZ, model: true,
      };
      return true;
    },

    _buildRevolver: function () {
      if (!window.Assets || !Assets.get) return false;
      let raw = null;
      try { raw = Assets.get('revolver', { raw: true }); } catch (e) { raw = null; }
      if (!raw) return false;

      const holder = new THREE.Group();   // stays at identity: everything below is measured in this space
      holder.add(raw);
      raw.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
      holder.updateMatrixWorld(true);

      const meshes = [];
      raw.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
      if (!meshes.length) return false;
      meshes.forEach((m) => { m.userData.kind = classify(m.material); });

      const box = new THREE.Box3().setFromObject(holder);
      const size = box.getSize(new V3()), ctr = box.getCenter(new V3());
      if (!isFinite(size.x) || size.x <= 0) return false;

      // barrel axis = longest horizontal extent; the barrel is on the end away from the (wooden) grip
      const axis = size.x >= size.z ? 'x' : 'z';
      const woodBox = new THREE.Box3();
      meshes.forEach((m) => { if (m.userData.kind === 'wood') woodBox.expandByObject(m); });
      const hasWood = !woodBox.isEmpty();
      const woodCtr = hasWood ? woodBox.getCenter(new V3()) : ctr.clone();
      const sign = hasWood ? (woodCtr[axis] < ctr[axis] ? 1 : -1) : 1;
      const rotY = axis === 'x' ? sign * Math.PI / 2 : (sign > 0 ? Math.PI : 0);
      const L = size[axis];
      const s = GUN_LEN / L;

      // hold point: grip centre, near the top of the grip (where the web of the hand sits)
      const wb = hasWood ? woodBox : box;
      const P = new V3(woodCtr.x, wb.min.y + 0.78 * (wb.max.y - wb.min.y), woodCtr.z);

      const rot = new THREE.Group(); rot.rotation.y = rotY;
      const scl = new THREE.Group(); scl.scale.setScalar(s);
      const align = new THREE.Group(); align.position.set(-P.x, -P.y, -P.z);
      this.gunPivot.add(rot); rot.add(scl); scl.add(align); align.add(raw);
      this.gunScale = scl; this.gunRaw = raw; this.gun = rot;

      const yAxis = new V3(0, 1, 0);
      const toGun = (q, out) => {
        out = out || new V3();
        out.copy(q).sub(P).multiplyScalar(s);
        return out.applyAxisAngle(yAxis, rotY);
      };
      // gun-space axes (+x right, +y up, -z forward) expressed in holder space
      const frame = {
        fwdH: new V3(0, 0, -1).applyAxisAngle(yAxis, -rotY),
        rightH: new V3(1, 0, 0).applyAxisAngle(yAxis, -rotY),
        upH: new V3(0, 1, 0)
      };
      frame.leftH = frame.rightH.clone().negate();

      // ---- landmarks, measured on the untouched meshes (gun space, origin at the hold point) ----------------
      const gb = new THREE.Box3(), gripB = new THREE.Box3(), tmp = new V3(), verts = [];
      let maxFwd = -Infinity;
      for (const m of meshes) {
        const pa = m.geometry.attributes.position;
        for (let i = 0; i < pa.count; i++) {
          tmp.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld);
          toGun(tmp, tmp);
          gb.expandByPoint(tmp);
          if (m.userData.kind === 'wood') gripB.expandByPoint(tmp);
          verts.push(tmp.x, tmp.y, tmp.z);
          if (-tmp.z > maxFwd) maxFwd = -tmp.z;
        }
      }
      let mx = 0, my = 0, mn = 0;
      for (let i = 0; i < verts.length; i += 3) {
        if (-verts[i + 2] > maxFwd - 0.0035) { mx += verts[i]; my += verts[i + 1]; mn++; }
      }
      const muzzlePos = new V3(mx / mn, my / mn, -maxFwd);
      // grip slant: mean z of the wooden grip near its top and near its bottom
      let tz = 0, tn = 0, bz = 0, bn = 0;
      if (!gripB.isEmpty()) {
        const gh = gripB.max.y - gripB.min.y;
        for (const m of meshes) {
          if (m.userData.kind !== 'wood') continue;
          const pa = m.geometry.attributes.position;
          for (let i = 0; i < pa.count; i++) {
            tmp.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld);
            toGun(tmp, tmp);
            if (tmp.y > gripB.max.y - 0.2 * gh) { tz += tmp.z; tn++; }
            else if (tmp.y < gripB.min.y + 0.2 * gh) { bz += tmp.z; bn++; }
          }
        }
      }

      // ---- carve the moving parts (cylinder, hammer) out of the static meshes -------------------------------
      const parts = { cyl: null, hammer: null };
      try { this._carveParts(meshes, frame, toGun, parts); } catch (e) { console.warn('[Weapon] part carving failed', e); }
      this.parts = parts;

      // ---- materials -------------------------------------------------------------------------------------------
      raw.traverse((o) => {
        if (!o.isMesh) return;
        o.material = this.mats[o.userData.kind || 'dark'] || this.mats.dark;
      });

      this.muzzle = new THREE.Object3D();
      this.muzzle.position.copy(muzzlePos);
      this.gunPivot.add(this.muzzle);

      this.lm = {
        box: gb, grip: gripB.isEmpty() ? gb.clone() : gripB, muzzle: muzzlePos, length: gb.max.z - gb.min.z,
        scale: s, rotY: rotY, axis: axis, sign: sign, hasWood: hasWood,
        gripTopZ: tn ? tz / tn : 0, gripBotZ: bn ? bz / bn : 0.01
      };
      return true;
    },

    _carveParts: function (meshes, frame, toGun, parts) {
      const cand = [];
      for (const m of meshes) {
        if (m.userData.kind === 'wood') continue;
        const comps = analyzeMesh(m);
        if (comps) for (const c of comps) cand.push(c);
      }
      if (!cand.length) return;

      // gun-space descriptor of every connected component
      const info = cand.map((c) => {
        const gb = new THREE.Box3(), cs = [c.box.min, c.box.max];
        for (let i = 0; i < 8; i++) gb.expandByPoint(toGun(new V3(cs[i & 1].x, cs[(i >> 1) & 1].y, cs[(i >> 2) & 1].z)));
        return { c: c, size: gb.getSize(new V3()), ctr: gb.getCenter(new V3()), n: c.tris.length };
      });

      // cylinder: the biggest roughly round component of decent size
      let cyl = null;
      for (const it of info) {
        const round = Math.abs(it.size.x - it.size.y) < 0.22 * Math.max(it.size.x, it.size.y);
        if (round && it.size.x > 0.1 * GUN_LEN && it.n > 150 && (!cyl || it.n > cyl.n)) cyl = it;
      }
      // hammer: the rearmost thin component that sits above the hold point (the trigger is thin too but lower,
      // the front sight is thin but far forward)
      let ham = null;
      for (const it of info) {
        if (it === cyl) continue;
        if (it.size.x < 0.075 * GUN_LEN && it.size.y > 0.04 * GUN_LEN && it.n >= 20 && it.ctr.y > 0 && (!ham || it.ctr.z > ham.ctr.z)) ham = it;
      }

      const toLocal = (m, v) => m.worldToLocal(v.clone());
      const dirLocal = (m, dirH) => dirH.clone().transformDirection(new THREE.Matrix4().copy(m.matrixWorld).invert()).normalize();
      const makeRoot = (m) => {
        const r = new THREE.Group();
        m.parent.add(r);
        r.position.copy(m.position); r.quaternion.copy(m.quaternion); r.scale.copy(m.scale);
        return r;
      };

      if (cyl) {
        const mesh = cyl.c.mesh, cb = cyl.c.box;
        const sz = cb.getSize(new V3());
        const cH = cb.getCenter(new V3());
        const radius = 0.5 * sz.y;                                   // holder units
        const hingeH = cH.clone().add(new V3(0, -1.02 * radius, 0)).addScaledVector(frame.leftH, 0.1 * radius);
        // swing sign: +angle about the barrel axis must move the cylinder towards the shooter's left
        const v0 = cH.clone().sub(hingeH);
        const v1 = v0.clone().applyAxisAngle(frame.fwdH, 0.4);
        const swingSign = v1.clone().sub(v0).dot(frame.leftH) > 0 ? 1 : -1;

        const root = makeRoot(mesh);
        const hingeL = toLocal(mesh, hingeH), centerL = toLocal(mesh, cH);
        const swing = new THREE.Group(); swing.position.copy(hingeL); root.add(swing);
        const spin = new THREE.Group(); spin.position.copy(centerL).sub(hingeL); swing.add(spin);
        const pm = new THREE.Mesh(carveGeometry(mesh, cyl.c.tris, centerL), mesh.material);
        pm.userData.kind = mesh.userData.kind; pm.frustumCulled = false;
        spin.add(pm);
        mesh.geometry = remainderGeometry(mesh, new Set(cyl.c.tris));
        parts.cyl = { swing: swing, spin: spin, axisLocal: dirLocal(mesh, frame.fwdH), swingSign: swingSign, radius: radius };
        parts.cylCenterGun = toGun(cH);
        parts.cylVerts = cyl.n;
      }

      if (ham) {
        const mesh = ham.c.mesh, hb = ham.c.box;
        const hs = hb.getSize(new V3());
        const along = Math.abs(hs.dot(frame.fwdH));
        const piv = hb.getCenter(new V3());
        piv.y = hb.min.y + 0.12 * hs.y;
        piv.addScaledVector(frame.fwdH, 0.38 * along);                // hinge towards the front of the hammer
        // lateral hinge axis; +angle must tip the top of the hammer towards the REAR
        const latH = frame.rightH.clone();
        const tip = new V3(0, 1, 0).applyAxisAngle(latH, 0.3).sub(new V3(0, 1, 0));
        const rearSign = tip.dot(frame.fwdH) < 0 ? 1 : -1;

        const root = makeRoot(mesh);
        const pivL = toLocal(mesh, piv);
        const hp = new THREE.Group(); hp.position.copy(pivL); root.add(hp);
        const pm = new THREE.Mesh(carveGeometry(mesh, ham.c.tris, pivL), mesh.material);
        pm.userData.kind = mesh.userData.kind; pm.frustumCulled = false;
        hp.add(pm);
        mesh.geometry = remainderGeometry(mesh, new Set(ham.c.tris));
        parts.hammer = { pivot: hp, axisLocal: dirLocal(mesh, latH), dirSign: rearSign };
        parts.hammerCtrGun = toGun(piv);
        parts.hammerVerts = ham.n;
      }
    },

    _buildFallbackGun: function () {
      // procedural revolver, used only if the GLB is missing: frame, barrel, cylinder, grip
      const g = new THREE.Group();
      const dark = this.mats.dark, light = this.mats.light, wood = this.mats.wood;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.17, 10), light);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.03, -0.14);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.1), dark);
      frame.position.set(0, 0.015, -0.03);
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 12), dark);
      cyl.rotation.x = Math.PI / 2; cyl.position.set(0, 0.03, -0.045);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.085, 0.045), wood);
      grip.position.set(0, -0.035, 0.02); grip.rotation.x = -0.3;
      g.add(barrel, frame, cyl, grip);
      this.gunPivot.add(g);
      this.gun = g;
      this.muzzle = new THREE.Object3D(); this.muzzle.position.set(0, 0.03, -0.225); this.gunPivot.add(this.muzzle);
      this.parts = { cyl: null, hammer: null, fallback: true };
      const box = new THREE.Box3().setFromObject(g);
      this.lm = { box: box, grip: new THREE.Box3(new V3(-0.012, -0.08, -0.002), new V3(0.012, 0.01, 0.045)), muzzle: this.muzzle.position.clone(), length: 0.3, scale: 1, rotY: 0, hasWood: true, gripTopZ: 0.02, gripBotZ: 0.04 };
    },

    // -----------------------------------------------------------------------------------------------------
    // hands. Preferred: the rigged WebXR "generic hand" models (assets/hand_right.glb, hand_left.glb, MIT, from
    // @webxr-input-profiles/assets) re-skinned pale and posed here with a small FK solver: their 25 joints are a FLAT
    // list (every joint is a child of the armature, as in the WebXR hand spec), so bending a joint means rotating every
    // joint after it in the chain about it. Hand space of the models: fingers point -y, thumb on -z, palm faces -x
    // (right) / +x (left). Fallback when the models are missing: the procedural hands below.
    // -----------------------------------------------------------------------------------------------------
    _buildHands: function () {
      let ok = false;
      try { ok = this._buildRiggedHands(); } catch (e) { console.error('[Weapon] rigged hands failed, using procedural hands', e); ok = false; }
      if (!ok) { this._rigR = this._rigL = null; this._buildProcHands(); }
    },

    _loadHandRig: function (name, palmSign) {
      if (!window.Assets || !Assets.get) return null;
      const w = Assets.get(name, { raw: true });
      if (!w) return null;
      const J = {};
      let mesh = null;
      w.traverse((o) => { if (o.isBone) J[o.name] = o; if (o.isSkinnedMesh) mesh = o; });
      if (!mesh || !J.wrist || !J['middle-finger-tip'] || !J['thumb-tip']) return null;
      mesh.material = this.mats.skin;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      const rest = {};
      Object.keys(J).forEach((k) => { rest[k] = { p: J[k].position.clone(), q: J[k].quaternion.clone() }; });
      const rig = { root: w, J: J, rest: rest, mesh: mesh, pn: new V3(palmSign, 0, 0) };
      try { this._addNails(rig); } catch (e) { console.warn('[Weapon] nails failed', e); }
      return rig;
    },

    // Fingernails: the hand models have none. Each nail is a thin, glossy, slightly curved plate (a flattened ellipsoid
    // half sunk into the skin) placed on the back of the last segment, found on the mesh itself: of the vertices along
    // that segment, the one furthest out on the back side gives the surface. The plate is parented to the distal joint,
    // so it follows every pose. A paler free edge sits at the tip end.
    _addNails: function (rig) {
      const J = rig.J, rest = rig.rest, M = this.mats;
      const back = rig.pn.clone().negate();                         // back of the hand (hand space)
      const geo = new THREE.SphereGeometry(1, 24, 12);
      const chains = [
        ['index-finger-phalanx-distal', 'index-finger-tip', back.clone()],
        ['middle-finger-phalanx-distal', 'middle-finger-tip', back.clone()],
        ['ring-finger-phalanx-distal', 'ring-finger-tip', back.clone()],
        ['pinky-finger-phalanx-distal', 'pinky-finger-tip', back.clone()],
        ['thumb-phalanx-distal', 'thumb-tip', back.clone().multiplyScalar(0.55).add(new V3(0, 0, -0.85))],
      ];
      rig.root.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      const toMesh = rig.mesh.matrixWorld.clone().invert();
      for (const [dn, tn, guess] of chains) {
        const bone = J[dn];
        if (!bone || !J[tn]) continue;
        const a = rest[dn].p, b = rest[tn].p;
        const dir = new V3().subVectors(b, a); const len = dir.length(); dir.normalize();
        const dorsal = guess.addScaledVector(dir, -guess.dot(dir)).normalize();
        // the skin surface on the back of the last segment: shoot a ray at it from outside (rest pose, mesh space)
        const axisPt = a.clone().addScaledVector(dir, len * 0.62);
        const o = axisPt.clone().addScaledVector(dorsal, 0.03).applyMatrix4(rig.mesh.matrixWorld);
        ray.set(o, dorsal.clone().negate().transformDirection(rig.mesh.matrixWorld));
        const hit = ray.intersectObject(rig.mesh, false)[0];
        if (!hit || !hit.face) continue;
        const surf = hit.point.clone().applyMatrix4(toMesh);
        const nrm = hit.face.normal.clone().lerp(dorsal, 0.5).normalize();     // face normal, steadied by the finger's back direction
        const thumb = dn.indexOf('thumb') === 0;
        const halfW = thumb ? 0.0062 : 0.0050;
        const halfL = Math.min(len * 0.42, thumb ? 0.0085 : 0.0072);
        const thick = 0.0011;
        const fwd = dir.clone().addScaledVector(nrm, -dir.dot(nrm)).normalize();
        const c = surf.clone().addScaledVector(nrm, thick * 0.15).addScaledVector(fwd, len * 0.08);
        const x = new V3().crossVectors(nrm, fwd).normalize();
        const qN = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, nrm, fwd));
        // into the distal joint's own frame (rest pose)
        const invQ = rest[dn].q.clone().invert();
        const toLocal = (p) => p.clone().sub(rest[dn].p).applyQuaternion(invQ);
        const plate = new THREE.Mesh(geo, M.nail);
        plate.scale.set(halfW, thick, halfL);
        plate.position.copy(toLocal(c));
        plate.quaternion.copy(invQ.clone().multiply(qN));
        plate.frustumCulled = false;
        bone.add(plate);
        const dorsalN = nrm;
        // paler free edge at the tip end of the nail
        const edge = new THREE.Mesh(geo, M.nailEdge);
        edge.scale.set(halfW * 0.92, thick * 0.9, halfL * 0.22);
        edge.position.copy(toLocal(c.clone().addScaledVector(fwd, halfL * 0.86).addScaledVector(dorsalN, thick * 0.10)));
        edge.quaternion.copy(plate.quaternion);
        edge.frustumCulled = false;
        bone.add(edge);
      }
    },

    // Pose a hand rig. pose.f[i] = [spread, proximal, intermediate, distal] (radians, + curls toward the palm) for
    // index / middle / ring / pinky; pose.t = [[ax, ay, az, angle] at the thumb metacarpal, at the proximal, at the distal]
    // (axes in hand space, x mirrored automatically for the left hand).
    _poseHand: function (rig, pose) {
      const J = rig.J, rest = rig.rest, pn = rig.pn;
      Object.keys(J).forEach((k) => { J[k].position.copy(rest[k].p); J[k].quaternion.copy(rest[k].q); });
      const q = this._hq || (this._hq = new THREE.Quaternion());
      const tmp = this._hv || (this._hv = new V3());
      const bend = (chain, k, axis, ang) => {
        if (!ang) return;
        q.setFromAxisAngle(axis, ang);
        const piv = chain[k].position.clone();
        for (let j = k; j < chain.length; j++) {
          chain[j].position.sub(piv).applyQuaternion(q).add(piv);
          chain[j].quaternion.premultiply(q);
        }
      };
      ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
        const a = pose.f[i];
        if (!a) return;
        const c = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((p) => J[f + '-finger-' + p]);
        if (c.some((x) => !x)) return;
        const dir = tmp.subVectors(c[4].position, c[1].position).normalize();
        const axis = new V3().crossVectors(dir, pn).normalize();
        bend(c, 1, pn.clone().multiplyScalar(-1), a[0] * (pn.x < 0 ? 1 : -1));   // spread (toward the thumb side when > 0)
        for (let k = 1; k <= 3; k++) bend(c, k, axis, a[k]);
      });
      const t = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'].map((p) => J[p]);
      if (pose.t && !t.some((x) => !x)) {
        pose.t.forEach((s, k) => { if (s) bend(t, k, new V3(s[0] * (pn.x < 0 ? 1 : -1), s[1], s[2]).normalize(), s[3] * (pn.x < 0 ? 1 : -1)); });
      }
      // wrist: turn the whole hand (every joint but the wrist) about the wrist, so the forearm can leave at its own angle
      if (rig.bendQ) {
        const piv = J.wrist.position;
        Object.keys(J).forEach((k) => {
          if (k === 'wrist') return;
          J[k].position.sub(piv).applyQuaternion(rig.bendQ).add(piv);
          J[k].quaternion.premultiply(rig.bendQ);
        });
      }
    },

    // Orient a rig: the hand (palm, fingers) is turned by handQ and stays undeformed; the forearm leaves the wrist along armDir
    // (gun space). The bend between the two is made by the forearm itself (a curved loft, _armLoft), not by deforming the hand
    // mesh: bending the skinned wrist folded the model's cut wrist edge into a ridge on the back of the forearm.
    _aimHand: function (rig, handQ, armDir) {
      rig.bendQ = null;
      rig.armDir = armDir.clone().normalize().applyQuaternion(handQ.clone().invert());   // in the hand model's own space
      return handQ.clone();
    },

    // The forearm, in the hand model's own space. The model ends in a cut, flared wrist; that last part is trimmed off, and a lofted
    // forearm starts on the model's real cross-section just below the cut, runs on along the wrist (+y) and then curves smoothly into
    // rig.armDir, through a dark leather band into the sleeve.
    _armLoft: function (rig) {
      const M = this.mats;
      if (rig.arm) { rig.root.children[0].remove(rig.arm); rig.arm.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
      const v = new V3();
      if (!rig.cut) {
        // trim the flared wrist end of the hand mesh (its own copy of the geometry)
        const geo = rig.mesh.geometry.clone();
        rig.mesh.geometry = geo;
        const pos = geo.attributes.position;
        let top = -1;
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); if (v.y > top) top = v.y; }
        const cutY = top - 0.016;
        if (geo.index) {
          const src = geo.index.array, keep = [];
          for (let t = 0; t < src.length; t += 3) {
            let above = 0;
            for (let k = 0; k < 3; k++) if (pos.getY(src[t + k]) > cutY) above++;
            if (above < 2) keep.push(src[t], src[t + 1], src[t + 2]);
          }
          geo.setIndex(keep);
        }
        // the cross-section just below the cut
        const secY = cutY - 0.005;
        let x0 = 1, x1 = -1, z0 = 1, z1 = -1;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          if (Math.abs(v.y - secY) > 0.004) continue;
          x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
        }
        rig.cut = { y: secY, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2 };
      }
      const C = rig.cut, Y = new V3(0, 1, 0);
      const A = (rig.armDir && rig.armDir.lengthSq() > 0) ? rig.armDir.clone().normalize() : Y.clone();
      // path: a quadratic Bezier from the section along +y, bending into A, then straight on along A
      const p0 = new V3(C.cx, C.y, C.cz), p1 = p0.clone().addScaledVector(Y, 0.040), p2 = p1.clone().addScaledVector(A, 0.040);
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40, u = 1 - t;
        pts.push(new V3().addScaledVector(p0, u * u).addScaledVector(p1, 2 * u * t).addScaledVector(p2, t * t));
      }
      for (let i = 1; i <= 10; i++) pts.push(p2.clone().addScaledVector(A, 0.04 * i));
      const len = [0];
      for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const at = (d) => {
        let i = 1;
        while (i < pts.length - 1 && len[i] < d) i++;
        const t = Math.min(1, Math.max(0, (d - len[i - 1]) / Math.max(1e-6, len[i] - len[i - 1])));
        return { p: pts[i - 1].clone().lerp(pts[i], t), T: pts[i].clone().sub(pts[i - 1]).normalize() };
      };
      const SEG = 32;
      // rings: [distance along the path, x scale, z scale]; each ring is an ellipse turned from the wrist plane onto the path
      const loft = (rings, mat) => {
        const P = [], UV = [], I = [], q = new THREE.Quaternion(), e = new V3();
        rings.forEach((r, j) => {
          const f = at(r[0]);
          q.setFromUnitVectors(Y, f.T);
          for (let i = 0; i <= SEG; i++) {
            const a = i / SEG * Math.PI * 2;
            e.set(Math.cos(a) * C.rx * r[1], 0, Math.sin(a) * C.rz * r[2]).applyQuaternion(q).add(f.p);
            P.push(e.x, e.y, e.z);
            UV.push(i / SEG, j / (rings.length - 1));
          }
        });
        for (let j = 0; j < rings.length - 1; j++) {
          for (let i = 0; i < SEG; i++) {
            const a = j * (SEG + 1) + i, b = a + SEG + 1;
            I.push(a, b, a + 1, b, b + 1, a + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
        geo.setIndex(I);
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        return m;
      };
      const arm = new THREE.Group();
      arm.add(loft([
        [0.000, 1.02, 1.02], [0.008, 1.05, 1.02], [0.018, 1.16, 1.01], [0.030, 1.36, 0.99],
        [0.044, 1.58, 0.98], [0.058, 1.74, 0.98], [0.070, 1.82, 0.99],
      ], M.skin));
      arm.add(loft([[0.062, 1.92, 1.05], [0.064, 2.04, 1.10], [0.082, 2.10, 1.12], [0.084, 2.00, 1.07]], M.cuff));
      arm.add(loft([[0.078, 2.06, 1.10], [0.088, 2.32, 1.20], [0.200, 2.60, 1.30], [0.430, 2.90, 1.38]], M.sleeve));
      rig.root.children[0].add(arm);
      rig.arm = arm;
    },

    _rigPoint: function (rig, names) {
      const c = new V3();
      names.forEach((n) => c.add(rig.J[n].position));
      return c.multiplyScalar(1 / names.length);
    },

    // pose the right hand round the grip and place it (re-run by __dbg.weapon.grip(cfg) while tuning)
    _placeRightHand: function () {
      const rig = this._rigR, lm = this.lm, C = this.gripCfg;
      if (!rig || !lm) return;
      const g = lm.grip;
      const gT = new V3(0, g.max.y - 0.010, lm.gripTopZ);
      const gB = new V3(0, g.min.y + 0.006, lm.gripBotZ);
      const u = new V3().subVectors(gB, gT).normalize();          // down along the grip
      const n = new V3(0, u.z, -u.y).normalize();                 // rearwards, perpendicular to the grip
      const X = new V3(1, 0, 0);
      const Yc = X.clone().multiplyScalar(Math.cos(C.roll)).addScaledVector(n, Math.sin(C.roll)).normalize();   // back of the hand
      const Zc = new V3().crossVectors(u, Yc).normalize();                                                     // towards the wrist
      const handQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Yc, Zc, u));
      // the forearm leaves the wrist back, down and out to the right (a firm, slightly cocked wrist), not straight up the grip rake
      const armDir = Zc.clone().lerp(new V3(0.32, -0.42, 0.85).normalize(), C.wrist).normalize();
      const hq = this._aimHand(rig, handQ, armDir);
      this._poseHand(rig, C.pose);
      const knuck = this._rigPoint(rig, ['index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal']);
      const target = gT.clone().addScaledVector(u, C.at[0]).addScaledVector(X, C.at[1]).addScaledVector(n, C.at[2]);
      rig.root.scale.setScalar(C.scale);
      rig.root.quaternion.copy(hq);
      rig.root.position.copy(target).sub(knuck.clone().multiplyScalar(C.scale).applyQuaternion(hq));
      rig.root.updateMatrix();
      this._armLoft(rig);
    },

    _buildRiggedHands: function () {
      const M = this.mats, lm = this.lm;
      if (!lm) return false;
      const rigR = this._loadHandRig('hand_right', -1);
      const rigL = this._loadHandRig('hand_left', 1);
      if (!rigR || !rigL) return false;
      const UP = new V3(0, 1, 0);
      const tube = (a, b, ra, rb, mat) => {
        const d = new V3().subVectors(b, a), len = d.length();
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rb, ra, Math.max(1e-4, len), 24, 1), mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(UP, d.normalize());
        m.frustumCulled = false;
        return m;
      };
      const ball = (c, r, mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat); m.position.copy(c); m.frustumCulled = false; return m; };
      const basisQ = (x, y, z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      const S = HAND_SCALE;
      // the forearm: a bit of skin at the wrist, a dark leather band, then the sleeve
      const forearm = (parent, wrist, fdir, rw) => {
        const skinEnd = wrist.clone().addScaledVector(fdir, 0.045);
        parent.add(tube(wrist.clone().addScaledVector(fdir, -0.010), skinEnd, rw, rw * 1.07, M.skin));
        parent.add(tube(skinEnd.clone().addScaledVector(fdir, -0.004), skinEnd.clone().addScaledVector(fdir, 0.018), rw * 1.22, rw * 1.22, M.cuff));
        parent.add(tube(skinEnd.clone().addScaledVector(fdir, 0.012), wrist.clone().addScaledVector(fdir, 0.38), rw * 1.28, rw * 1.7, M.sleeve));
      };

      // ---------------------------------------------------------------- right hand: a firm grip round the revolver grip
      const HR = new THREE.Group();
      HR.name = 'rightHand';
      HR.add(rigR.root);
      this._rigR = rigR;
      this.gripCfg = { scale: HAND_SCALE, at: GRIP_AT.slice(), roll: GRIP_ROLL, wrist: GRIP_WRIST, pose: JSON.parse(JSON.stringify(GRIP_POSE)) };
      this._placeRightHand();
      this.gunPivot.add(HR);
      this.handR = HR;

      // ---------------------------------------------------------------- left (reload) hand, hidden until reload
      const L = new THREE.Group();
      L.name = 'leftHand';
      const handQL = basisQ(new V3(1, 0, 0), new V3(0, 0, 1), new V3(0, -1, 0));   // palm faces the gun (+x), fingers forward, thumb up
      const lq = this._aimHand(rigL, handQL, new V3(-0.30, -0.38, 0.87));
      // reload hand orientations (gun space; left-hand model: palm +x, fingers -y, thumb -z):
      //   cradle: palm up under the gun, fingers across to the right, thumb forward;  loader: palm forward, fingers up, thumb right;
      //   push: palm against the left of the cylinder, fingers forward, thumb up
      this._handOri = {
        cradle: basisQ(new V3(0, 1, 0), new V3(-1, 0, 0), new V3(0, 0, 1)),
        loader: basisQ(new V3(0, 0, -1), new V3(0, -1, 0), new V3(-1, 0, 0)),
        push: handQL.clone(),
        baseInv: handQL.clone().invert(),
      };
      this._poseHand(rigL, RELOAD_POSE(0));
      const palmL = this._rigPoint(rigL, ['index-finger-metacarpal', 'pinky-finger-metacarpal', 'index-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal']);
      rigL.root.scale.setScalar(S);
      rigL.root.quaternion.copy(lq);
      rigL.root.position.copy(palmL.multiplyScalar(-S).applyQuaternion(lq)).add(new V3(-0.012, 0, 0));
      L.add(rigL.root);
      this._armLoft(rigL);
      L.visible = false;
      this.gunPivot.add(L);
      this.handL = L;
      this._rigL = rigL;
      this._buildReloadProps();
      void ball;
      return true;
    },

    // -----------------------------------------------------------------------------------------------------
    // procedural fallback hands: bare, pale, smooth. Built from ellipsoids and tapered tubes with a ball at every joint, so there are no
    // facets or seams. The right hand is a fist around the grip (finger paths are computed from the grip geometry);
    // the left hand is a rig (palm + 4 fingers x 3 joints + thumb) whose fingers curl during the reload.
    // -----------------------------------------------------------------------------------------------------
    _buildProcHands: function () {
      const M = this.mats, lm = this.lm;
      if (!lm) return;
      const UP = new V3(0, 1, 0);
      const mesh = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; return m; };
      // tapered tube from a to b (radius ra at a, rb at b)
      const tube = (a, b, ra, rb, mat) => {
        const d = new V3().subVectors(b, a), len = d.length();
        const m = mesh(new THREE.CylinderGeometry(rb, ra, Math.max(1e-4, len), 20, 1), mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(UP, d.normalize());
        return m;
      };
      // ellipsoid (radii rx, ry, rz) at c, optionally rotated by q
      const ball = (c, rx, ry, rz, mat, q) => {
        const m = mesh(new THREE.SphereGeometry(1, 28, 20), mat);
        m.scale.set(rx, ry, rz); m.position.copy(c);
        if (q) m.quaternion.copy(q);
        return m;
      };
      const basisQ = (x, y, z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      // fingernail: a flat, glossy shield on the back of the last segment (a -> b), `dorsal` is the direction of the back of the finger
      const nail = (parent, a, b, dorsal, r) => {
        const dir = new V3().subVectors(b, a), len = dir.length(); dir.normalize();
        const y = dorsal.clone().addScaledVector(dir, -dorsal.dot(dir)).normalize();
        const x = new V3().crossVectors(y, dir);
        const c = a.clone().lerp(b, 0.58).addScaledVector(y, r * 0.78);
        parent.add(ball(c, r * 0.62, r * 0.26, Math.max(len * 0.36, r * 0.7), M.nail, basisQ(x, y, dir)));
      };
      // a finger through the waypoints pts (radii[i] at pts[i]); balls at the joints make the bends smooth
      const chain = (parent, pts, radii, mat, dorsal, nailR) => {
        for (let i = 0; i < pts.length - 1; i++) parent.add(tube(pts[i], pts[i + 1], radii[i], radii[i + 1], mat));
        for (let i = 0; i < pts.length; i++) parent.add(ball(pts[i], radii[i], radii[i], radii[i], mat));
        if (nailR) nail(parent, pts[pts.length - 2], pts[pts.length - 1], dorsal, nailR);
      };

      // ---------------------------------------------------------------- right (shooting) hand: a fist round the grip
      const g = lm.grip;
      const gT = new V3(0, g.max.y - 0.010, lm.gripTopZ);
      const gB = new V3(0, g.min.y + 0.006, lm.gripBotZ);
      const u = new V3().subVectors(gB, gT).normalize();          // down along the grip
      const n = new V3(0, u.z, -u.y).normalize();                 // rearwards, perpendicular to the grip
      const X = new V3(1, 0, 0);
      const halfD = 0.0185;                                       // half grip depth (front-back)
      const R = new THREE.Group();
      R.name = 'rightHand';
      const at = (v, side, depth) => gT.clone().addScaledVector(u, v).addScaledVector(X, side).addScaledVector(n, depth);
      // the three lower fingers: knuckle on the right of the grip, across the front strap, tip curling onto the left side
      const rf = [0.0082, 0.0076, 0.0070, 0.0064];
      const fing = [
        { v: 0.025, L: [0.034, 0.021, 0.017], k: 1.00 },
        { v: 0.042, L: [0.032, 0.020, 0.016], k: 0.94 },
        { v: 0.058, L: [0.026, 0.016, 0.014], k: 0.86 },
      ];
      const away = new V3(-1, 0.25, -0.6).normalize();            // the back of the curled fingertips faces left / forward
      const mcps = [];
      fing.forEach((f) => {
        const r = rf.map((x) => x * f.k);
        const p0 = at(f.v, 0.0155, -(halfD + r[0] + 0.001));
        const p1 = p0.clone().addScaledVector(X, -f.L[0]);
        const p2 = p1.clone().addScaledVector(n, f.L[1]);
        const p3 = p2.clone().addScaledVector(n, Math.cos(0.45) * f.L[2]).addScaledVector(X, Math.sin(0.45) * f.L[2]);
        chain(R, [p0, p1, p2, p3], r, M.skin, away, r[3] * 1.05);
        mcps.push(p0);
      });
      // index finger lies along the left of the frame and rests on the trigger
      const i0 = at(0.004, 0.0150, -(halfD + 0.004));
      const i1 = new V3(-0.0172, i0.y - 0.001, i0.z - 0.004);
      const i2 = new V3(-0.0172, -0.0105, -0.0455);
      const i3 = new V3(-0.0050, -0.0215, -0.0605);
      chain(R, [i0, i1, i2, i3], [0.0086, 0.0080, 0.0074, 0.0068], M.skin, new V3(-0.6, 0.8, 0), 0.0072);
      mcps.unshift(i0);
      // thumb lying along the left side of the frame, root in the web above the grip
      const t0 = new V3(0.0125, 0.0215, 0.0150);
      const t1 = new V3(-0.0045, 0.0270, 0.0020);
      const t2 = new V3(-0.0160, 0.0270, -0.0150);
      const t3 = new V3(-0.0178, 0.0240, -0.0285);
      chain(R, [t0, t1, t2, t3], [0.0120, 0.0100, 0.0088, 0.0078], M.skin2, new V3(-0.2, 1, 0), 0.0086);

      // palm and back of the hand: one ellipsoid on the knuckle row, turned a little towards the rear of the grip
      const phi = 0.5;
      const Yc = X.clone().multiplyScalar(Math.cos(phi)).addScaledVector(n, Math.sin(phi)).normalize();     // back of the hand
      const Xc = u.clone();                                                                                // towards the little finger
      const Zc = new V3().crossVectors(Xc, Yc).normalize();                                                // towards the wrist
      const palmQ = basisQ(Xc, Yc, Zc);
      const mcpMid = new V3();
      mcps.forEach((p) => mcpMid.add(p)); mcpMid.multiplyScalar(1 / mcps.length);
      const palmC = mcpMid.clone().addScaledVector(Yc, 0.016).addScaledVector(Zc, 0.036);
      R.add(ball(palmC, 0.0405, 0.0185, 0.0440, M.skin, palmQ));                                          // palm / back of the hand
      R.add(ball(palmC.clone().addScaledVector(Yc, 0.006).addScaledVector(Xc, -0.012).addScaledVector(Zc, 0.020), 0.0200, 0.0150, 0.0300, M.skin2, palmQ));   // thumb muscle
      R.add(ball(palmC.clone().addScaledVector(Xc, 0.020).addScaledVector(Zc, 0.026), 0.0160, 0.0140, 0.0260, M.skin2, palmQ));                         // heel of the hand
      // wrist: skin, a dark leather band, then the sleeve, running back and down out of the frame
      const wrist = palmC.clone().addScaledVector(Zc, 0.040);
      const fdir = Zc.clone().multiplyScalar(0.55).add(new V3(0.30, -0.55, 0.78).multiplyScalar(0.45)).normalize();
      const skinEnd = wrist.clone().addScaledVector(fdir, 0.050);
      const elbow = wrist.clone().addScaledVector(fdir, 0.36);
      R.add(tube(wrist.clone().addScaledVector(fdir, -0.012), skinEnd, 0.0235, 0.0250, M.skin2));
      R.add(ball(wrist.clone().addScaledVector(fdir, -0.012), 0.0235, 0.0235, 0.0235, M.skin2));
      R.add(tube(skinEnd.clone().addScaledVector(fdir, -0.004), skinEnd.clone().addScaledVector(fdir, 0.018), 0.0285, 0.0285, M.cuff));
      R.add(tube(skinEnd.clone().addScaledVector(fdir, 0.012), elbow, 0.0300, 0.0400, M.sleeve));
      this.gunPivot.add(R);
      this.handR = R;

      // ---------------------------------------------------------------- left (reload) hand, hidden until reload
      // rig frame: palm down, fingers point -z, thumb on +x, back of the hand +y; the outer group Lo puts the palm
      // against the gun (palm faces +x, thumb up), L is moved by handsUpdate
      const L = new THREE.Group();
      L.name = 'leftHand';
      const Lo = new THREE.Group();
      Lo.quaternion.copy(basisQ(new V3(0, 1, 0), new V3(-1, 0, 0), new V3(0, 0, 1)));
      L.add(Lo);
      Lo.add(ball(new V3(0, 0, 0), 0.0345, 0.0165, 0.0430, M.skin, null));
      Lo.add(ball(new V3(0.016, -0.004, 0.008), 0.0190, 0.0130, 0.0290, M.skin2, null));       // thumb muscle (palm side)
      Lo.add(ball(new V3(-0.022, -0.002, 0.024), 0.0150, 0.0135, 0.0240, M.skin2, null));      // heel of the hand
      const rig = (parent, pos, lens, radii, mat, nailR, yaw) => {
        const root = new THREE.Group(); root.position.copy(pos); if (yaw) root.rotation.y = yaw; parent.add(root);
        const joints = []; let cur = root;
        for (let i = 0; i < lens.length; i++) {
          const j = new THREE.Group(); if (i > 0) j.position.set(0, 0, -lens[i - 1]);
          cur.add(j); joints.push(j);
          j.add(tube(new V3(0, 0, 0), new V3(0, 0, -lens[i]), radii[i], radii[i + 1], mat));
          j.add(ball(new V3(0, 0, 0), radii[i], radii[i], radii[i], mat));
          cur = j;
        }
        const last = joints[joints.length - 1], tip = new V3(0, 0, -lens[lens.length - 1]);
        last.add(ball(tip, radii[lens.length], radii[lens.length], radii[lens.length], mat));
        if (nailR) nail(last, new V3(0, 0, 0), tip, UP, nailR);
        return joints;
      };
      this.handLFingers = [
        rig(Lo, new V3(0.0255, -0.002, -0.040), [0.034, 0.021, 0.017], [0.0082, 0.0076, 0.0070, 0.0064], M.skin, 0.0068),
        rig(Lo, new V3(0.0085, -0.002, -0.042), [0.036, 0.023, 0.018], [0.0084, 0.0078, 0.0072, 0.0066], M.skin, 0.0070),
        rig(Lo, new V3(-0.0085, -0.002, -0.040), [0.034, 0.021, 0.017], [0.0080, 0.0074, 0.0068, 0.0062], M.skin, 0.0066),
        rig(Lo, new V3(-0.0235, -0.002, -0.034), [0.027, 0.016, 0.014], [0.0072, 0.0066, 0.0061, 0.0056], M.skin, 0.0060),
      ];
      this.handLThumb = rig(Lo, new V3(0.029, -0.006, -0.012), [0.030, 0.022, 0.018], [0.0112, 0.0098, 0.0088, 0.0078], M.skin2, 0.0086, 0.55);
      // forearm: skin wrist, leather band, sleeve, back and out of the frame
      const lw = new V3(0, 0, 0.038);
      const ldir = new V3(-0.25, -0.3, 0.92).normalize();
      const lq = new V3(0, 0, 0);
      L.add(tube(lw.clone().addScaledVector(ldir, -0.012), lw.clone().addScaledVector(ldir, 0.05), 0.0225, 0.0245, M.skin2));
      L.add(ball(lw.clone().addScaledVector(ldir, -0.012), 0.0225, 0.0225, 0.0225, M.skin2));
      L.add(tube(lw.clone().addScaledVector(ldir, 0.046), lw.clone().addScaledVector(ldir, 0.066), 0.0285, 0.0285, M.cuff));
      L.add(tube(lw.clone().addScaledVector(ldir, 0.058), lw.clone().addScaledVector(ldir, 0.38), 0.0295, 0.0400, M.sleeve));
      void lq;
      L.visible = false;
      this.gunPivot.add(L);
      this.handL = L;
      this._curlLeft(0);
    },

    // curl the left hand's fingers: c = 0 relaxed .. 1 firmly closed (the fingers follow with a slight delay each)
    _curlLeft: function (c, wave) {
      if (!this.handLFingers) return;
      const w = wave || 0;
      this.handLFingers.forEach((j, i) => {
        const k = clamp(c + w * (0.12 - i * 0.05), 0, 1);
        const f = 1 + i * 0.07;
        j[0].rotation.x = -(0.22 + 0.55 * k) * f;
        j[1].rotation.x = -(0.30 + 0.85 * k) * f;
        j[2].rotation.x = -(0.18 + 0.55 * k) * f;
      });
      const t = this.handLThumb;
      if (t) {
        const k = clamp(c, 0, 1);
        t[0].rotation.x = -(0.10 + 0.25 * k); t[1].rotation.x = -(0.14 + 0.35 * k); t[2].rotation.x = -(0.10 + 0.30 * k);
      }
    },

    // reload choreography of the left hand (gun space). Rigged hands: the full revolver reload as games show it (and as it is
    // done): the hand comes up and pushes the cylinder out, the thumb strokes the ejector rod and the six empties drop, the
    // hand dips out of view for a speedloader, lines it up behind the open cylinder, pushes it in, twists it to release the
    // rounds, pulls the empty loader away, then the palm swings the cylinder shut and the hand leaves.
    handsUpdate: function (dt) {
      const L = this.handL;
      if (!L) return;
      const p = this._relP;
      if (!this._rigL) return this._handsUpdateProc(p);
      this._updateCasings(dt);
      if (p < 0 || !this.rel) {
        if (L.visible) L.visible = false;
        if (this._loader) this._loader.visible = false;
        this._ejected = false;
        return;
      }
      L.visible = true;
      const R = this._reloadRig();
      const C = R.c, F = R.fwd;                                   // live cylinder centre (follows the swing) and bore direction
      const rear = C.clone().addScaledVector(F, -CYL_HALF);       // the rear face of the cylinder (the chamber mouths)
      const off = (base, x, y, z) => base.clone().add(new V3(x, y, z));
      const ins = kf(p, [[0.555, 0], [0.605, 1]]);                // speedloader pushed home
      const loaderPos = rear.clone().addScaledVector(F, -0.045 * (1 - kf(p, [[0.50, 0], [0.56, 1]])) - 0.010 + 0.014 * ins)
        .add(new V3(-0.06, -0.05, 0).multiplyScalar(1 - kf(p, [[0.47, 0], [0.555, 1]])));
      const pullAway = kf(p, [[0.635, 0], [0.70, 1]]);
      // where the palm goes: [p, palm-centre position, hand orientation, extra euler tweak (x, y, z)]
      const O = this._handOri;
      const far = off(C, -0.11, -0.20, 0.09);
      const keys = [
        [0.00, far, O.cradle, [0.5, 0, 0.3]],
        [0.12, off(C, -0.006, -0.046, 0.010), O.cradle, [0, 0, 0]],               // palm under the frame, thumb on the cylinder
        [0.27, off(C, -0.006, -0.046, 0.010), O.cradle, [0, 0, 0.15]],            // the cylinder swings out into the palm
        [0.33, off(C, -0.004, -0.044, -0.034), O.cradle, [-0.15, 0, 0]],          // thumb on the ejector rod
        [0.40, off(C, -0.004, -0.044, -0.012), O.cradle, [-0.15, 0, 0]],          // stroke: the empties drop
        [0.47, off(C, -0.09, -0.16, 0.06), O.loader, [0.4, 0, 0]],                 // down out of view for the speedloader
        [0.555, off(loaderPos, -0.004, -0.030, 0.040), O.loader, [0, 0, 0]],      // loader lined up behind the chambers
        [0.605, off(loaderPos, -0.004, -0.030, 0.040), O.loader, [0, 0, 0]],      // pushed in
        [0.635, off(loaderPos, -0.004, -0.030, 0.040), O.loader, [0, 0, 0.5]],    // twist to release the rounds
        [0.70, off(C, -0.08, -0.12, 0.07), O.loader, [0.3, 0, 0.2]],               // pull the empty loader away
        [0.75, off(C, -0.036, -0.008, 0.004), O.push, [1.15, 0, 0]],                  // palm on the open cylinder
        [0.80, off(C, -0.033, -0.004, 0.004), O.push, [1.15, 0, 0]],                  // ... and swings it shut
        [0.86, off(C, -0.006, -0.050, 0.010), O.cradle, [0, 0, 0]],                // back under the frame for a moment
        [0.97, far, O.cradle, [0.5, 0, 0.3]],
        [1.00, far, O.cradle, [0.5, 0, 0.3]],
      ];
      let i = 1;
      while (i < keys.length - 1 && p > keys[i][0]) i++;
      const a = keys[i - 1], b = keys[i];
      const t = smooth((p - a[0]) / Math.max(1e-6, b[0] - a[0]));
      L.position.lerpVectors(a[1], b[1], t);
      const e = [0, 1, 2].map((q) => lerp(a[3][q], b[3][q], t));
      L.quaternion.copy(a[2]).slerp(b[2], t).multiply(this._hq2 || (this._hq2 = new THREE.Quaternion()).setFromEuler(new THREE.Euler(e[0], e[1], e[2])))
        .multiply(O.baseInv);
      // fingers: [index..pinky curl 0..1, thumb curl 0..1, thumb out (pushing the rod)]
      const fk = [
        [0.00, 0.25, 0.20, 0.0], [0.12, 0.55, 0.35, 0.0], [0.27, 0.55, 0.35, 0.0],
        [0.33, 0.70, 0.05, 1.0], [0.40, 0.70, 0.05, 1.0],
        [0.47, 0.55, 0.40, 0.0], [0.555, 0.62, 0.55, 0.0], [0.635, 0.62, 0.55, 0.0],
        [0.70, 0.45, 0.30, 0.0], [0.75, 0.12, 0.15, 0.0], [0.80, 0.12, 0.15, 0.0], [0.86, 0.35, 0.25, 0.0], [1.00, 0.25, 0.20, 0.0],
      ];
      let j = 1;
      while (j < fk.length - 1 && p > fk[j][0]) j++;
      const fa = fk[j - 1], fb = fk[j], ft = smooth((p - fa[0]) / Math.max(1e-6, fb[0] - fa[0]));
      const curl = lerp(fa[1], fb[1], ft), tc = lerp(fa[2], fb[2], ft), tout = lerp(fa[3], fb[3], ft);
      this._poseHand(this._rigL, {
        f: [0, 1, 2, 3].map((q) => { const c = clamp(curl + q * 0.06, 0, 1); return [0.03 * (1.5 - q), 0.20 + 0.85 * c, 0.30 + 1.00 * c, 0.20 + 0.55 * c]; }),
        t: [[1, 0, 0, -0.35 * tout], [0, 0, 1, 0.10 + 0.30 * tc - 0.10 * tout], [0, 0, 1, 0.05 + 0.30 * tc - 0.05 * tout]],
      });
      // the empties drop out when the rod is stroked
      if (!this._ejected && p >= 0.385) { this._ejected = true; this._ejectCasings(rear, F); }
      if (p < 0.2) this._ejected = false;
      // the speedloader: rides in the fingertips from the dip until it is pulled away (rounds stay in the chambers)
      const Lo = this._loader;
      if (Lo) {
        const show = p > 0.45 && p < 0.70;
        Lo.visible = show;
        if (show) {
          const pos = p < 0.635 ? loaderPos : loaderPos.clone().lerp(off(C, -0.07, -0.10, 0.08), pullAway);
          Lo.position.copy(pos);
          Lo.quaternion.setFromUnitVectors(new V3(0, 0, -1), F);
          Lo.rotateZ(kf(p, [[0.605, 0], [0.635, 0.45]]));
          Lo.userData.rounds.visible = p < 0.62;
        }
      }
    },

    // live cylinder centre (gun space) and bore direction; the centre is carried by the swing pivot
    _reloadRig: function () {
      const P = this.parts, lm = this.lm;
      const out = this._rr || (this._rr = { c: new V3(), fwd: new V3(0, 0, -1) });
      const c0 = P && P.cylCenterGun ? P.cylCenterGun : new V3(0, 0.022, -0.078);
      if (P && P.cyl && P.cyl.swing) {
        if (!this._cylLocal) {
          this.scene.updateMatrixWorld(true);
          this._cylLocal = P.cyl.swing.worldToLocal(this.gunPivot.localToWorld(c0.clone()));
        }
        this.viewRoot.updateMatrixWorld(true);
        out.c.copy(this.gunPivot.worldToLocal(P.cyl.swing.localToWorld(this._cylLocal.clone())));
      } else out.c.copy(c0);
      if (lm && lm.muzzle) out.fwd.subVectors(lm.muzzle, c0).setX(0).normalize();
      return out;
    },

    _buildReloadProps: function () {
      const brass = new THREE.MeshPhongMaterial({ color: this._col(0xc8962e), specular: this._col(0xfff0c0), shininess: 80 });
      const steel = new THREE.MeshPhongMaterial({ color: this._col(0xb9bec6), specular: this._col(0xffffff), shininess: 90 });   // nickel speedloader
      const knobM = new THREE.MeshPhongMaterial({ color: this._col(0x9a6a2a), specular: this._col(0xffe0a0), shininess: 60 });
      const lead = new THREE.MeshPhongMaterial({ color: this._col(0x8a8d92), specular: this._col(0x333333), shininess: 20 });
      // speedloader: body + knob behind, six rounds in front (bullets toward the cylinder, i.e. along -z of the group)
      const Lo = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0205, 0.0205, 0.009, 28), steel);
      body.rotation.x = Math.PI / 2; Lo.add(body);
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0085, 0.012, 20), knobM);
      knob.rotation.x = Math.PI / 2; knob.position.z = 0.010; Lo.add(knob);
      const rounds = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2, x = Math.cos(a) * 0.0132, y = Math.sin(a) * 0.0132;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.0046, 0.016, 14), brass);
        c.rotation.x = Math.PI / 2; c.position.set(x, y, -0.0125); rounds.add(c);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0043, 12, 8), lead);
        tip.scale.z = 1.3; tip.position.set(x, y, -0.021); rounds.add(tip);
      }
      Lo.add(rounds);
      Lo.userData.rounds = rounds;
      Lo.traverse((o) => { o.frustumCulled = false; });
      Lo.visible = false;
      this.gunPivot.add(Lo);
      this._loader = Lo;
      // six empties, reused every reload (they fall in viewmodel-camera space)
      this._casings = [];
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.0050, 0.017, 12), brass);
        m.frustumCulled = false; m.visible = false;
        this.scene.add(m);
        this._casings.push({ m: m, v: new V3(), w: new V3(), t: 0 });
      }
    },

    _ejectCasings: function (rear, F) {
      if (!this._casings) return;
      this.scene.updateMatrixWorld(true);
      const q = new THREE.Quaternion();
      this.gunPivot.getWorldQuaternion(q);
      const back = F.clone().negate().applyQuaternion(q);              // out of the rear of the cylinder, in view space
      const up = new V3(0, 1, 0).applyQuaternion(q), side = new V3().crossVectors(back, up).normalize();
      up.crossVectors(side, back).normalize();
      this._casings.forEach((c, i) => {
        const a = i / 6 * Math.PI * 2 + 0.3;
        const p = rear.clone();
        this.gunPivot.localToWorld(p);
        p.addScaledVector(side, Math.cos(a) * 0.0132).addScaledVector(up, Math.sin(a) * 0.0132).addScaledVector(back, 0.004);
        c.m.position.copy(p);
        c.m.quaternion.setFromUnitVectors(new V3(0, 1, 0), back);
        c.v.copy(back).multiplyScalar(0.55 + 0.25 * Math.random()).addScaledVector(side, (Math.random() - 0.5) * 0.25);
        c.w.set((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 18);
        c.t = 0.9;
        c.m.visible = true;
      });
    },

    _updateCasings: function (dt) {
      if (!this._casings) return;
      for (const c of this._casings) {
        if (c.t <= 0) continue;
        c.t -= dt;
        c.v.y -= 6.0 * dt;
        c.m.position.addScaledVector(c.v, dt);
        c.m.rotation.x += c.w.x * dt; c.m.rotation.y += c.w.y * dt; c.m.rotation.z += c.w.z * dt;
        if (c.t <= 0 || c.m.position.y < -0.6) { c.t = 0; c.m.visible = false; }
      }
    },

    // procedural-hand fallback of the reload (the old two-dip loading motion)
    _handsUpdateProc: function (p) {
      const L = this.handL;
      if (p < 0 || !this.rel) { if (L.visible) L.visible = false; return; }
      const k = this._relHand;
      L.visible = k > 0.01;
      const dip = kf(p, [[0.48, 0], [0.54, 1], [0.6, 0], [0.64, 1], [0.7, 0]]);
      const far = new V3(-0.16, -0.17, 0.10);
      const near = new V3(-0.058, -0.022 - dip * 0.020, -0.050 - dip * 0.006);
      L.position.lerpVectors(far, near, smooth(k));
      L.rotation.set(0.10 * (1 - k), 0.05 + 0.5 * (1 - k), -0.2 * (1 - k) + dip * 0.15);
      this._curlLeft(0.35 * smooth(k) + 0.55 * dip, 0.5 * dip);
    },

    // -----------------------------------------------------------------------------------------------------
    // muzzle flash
    // -----------------------------------------------------------------------------------------------------
    _buildFlash: function () {
      this.texStar = makeStarTexture();
      this.texJet = makeJetTexture();
      const grp = new THREE.Group();
      grp.renderOrder = 10;
      const starMat = new THREE.SpriteMaterial({ map: this.texStar, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
      const star = new THREE.Sprite(starMat);
      star.scale.set(0.16, 0.16, 1);
      star.renderOrder = 11;
      grp.add(star);
      const jetMat = new THREE.MeshBasicMaterial({ map: this.texJet, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
      const jetGeo = new THREE.PlaneGeometry(1, 1);
      jetGeo.translate(0.5, 0, 0);            // base at the origin, extends along +x
      const jets = [];
      for (let i = 0; i < 2; i++) {
        const j = new THREE.Mesh(jetGeo, jetMat);
        j.rotation.y = -Math.PI / 2;           // +x -> -z (forward)
        j.rotation.order = 'YXZ';
        j.rotation.x = i * Math.PI / 2;        // second plane perpendicular
        j.renderOrder = 10;
        j.frustumCulled = false;
        jets.push(j);
        grp.add(j);
      }
      this.flashGroup = grp;
      this.flashStar = star; this.flashJets = jets; this.flashJetMat = jetMat; this.flashStarMat = starMat;
      this.muzzle.add(grp);
      grp.position.set(0, 0, -0.004);
    },

    // -----------------------------------------------------------------------------------------------------
    // world light (main scene)
    // -----------------------------------------------------------------------------------------------------
    _worldScene: function () {
      let o = this.mainCam;
      while (o && o.parent) o = o.parent;
      return o && o.isScene ? o : null;
    },

    _ensureWorldLight: function () {
      if (this._worldLightAdded) return;
      const sc = this._worldScene();
      if (!sc) return;
      sc.add(this.worldLight);
      this._worldLightAdded = true;
    },

    // map a point in the viewmodel camera space (FOV 60) to main-camera space (FOV of the main camera) so that
    // it lands on the same screen pixel
    _vmToMainCam: function (p, out) {
      const d = Math.max(0.001, -p.z);
      const mc = this.mainCam;
      const aspect = this.camera.aspect;
      const tvm = Math.tan(VM_FOV * 0.5 * DEG);
      const tmain = Math.tan((mc && mc.fov ? mc.fov : 75) * 0.5 * DEG);
      const ndcX = p.x / (d * tvm * aspect), ndcY = p.y / (d * tvm);
      return out.set(ndcX * d * tmain * aspect, ndcY * d * tmain, -d);
    },

    // -----------------------------------------------------------------------------------------------------
    // public API
    // -----------------------------------------------------------------------------------------------------
    resize: function (w, h) {
      if (!this.camera) return;
      const a = (w && h) ? w / h : (this.mainCam ? this.mainCam.aspect : 1);
      if (a > 0 && Math.abs(this.camera.aspect - a) > 1e-5) {
        this.camera.aspect = a;
        this.camera.updateProjectionMatrix();
      }
    },

    isReloading: function () { return !!this.rel; },
    isFlashing: function () { return this.flashOn; },
    setVisible: function (on) { if (this.viewRoot) this.viewRoot.visible = !!on; },

    // Muzzle position in WORLD space (aligned with where the muzzle is drawn on screen).
    muzzleWorldPosition: function (target) {
      target = target || new V3();
      if (!this.ready || !this.muzzle) return target.set(0, 0, 0);
      this.scene.updateMatrixWorld(true);
      const p = this._tmpA || (this._tmpA = new V3());
      this.muzzle.getWorldPosition(p);                 // viewmodel camera space (the viewmodel camera sits at the origin)
      this._vmToMainCam(p, target);
      const mc = this.mainCam;
      if (mc) { mc.updateMatrixWorld(); target.applyMatrix4(mc.matrixWorld); }
      return target;
    },

    fire: function () {
      if (!this.ready) return new V3();
      const out = this.muzzleWorldPosition(new V3());   // position before the kick is applied
      const S = this.S;
      const r = Math.random;
      S.kz.kick(0.034 + r() * 0.006);
      S.kp.kick(0.115 + r() * 0.03);
      S.kc.kick(0.03 + r() * 0.01);
      S.kr.kick((r() - 0.5) * 0.09);
      S.ky.kick((r() - 0.5) * 0.05);
      // flash
      this.flashT = 0; this.flashOn = true;
      this.flashRoll = r() * Math.PI * 2;
      this.flashSize = 0.85 + r() * 0.35;
      this.flashLen = 0.8 + r() * 0.4;
      // hammer falls, then re-cocks; cylinder steps 60 degrees
      this.hamT = 0;
      this.cylFrom = this.cylStep; this.cylTo = this.cylStep + Math.PI / 3; this.cylT = -0.07;
      this._ensureWorldLight();
      return out;
    },

    reload: function (ms) {
      if (!this.ready) return;
      const dur = Math.max(300, ms || 1600);
      this.rel = { t: 0, dur: dur, spun: false };
      this.flashT = 1; this.flashOn = false;
    },

    // -----------------------------------------------------------------------------------------------------
    // the kick: the player's right leg (charcoal-brown wool trouser, knee-high brown riding boot with a buckled instep strap, welted dark sole,
    // stacked heel, small iron spur) swings up from below the screen, thrusts the sole forward and snaps at KICK_IMPACT, holds a beat and drops
    // away by KICK_DUR. The revolver and hands dip down-right and tilt while it is out (the weight shift, see _applyPose). The leg is a 2-bone
    // IK chain (thigh + shin) from a virtual hip below and behind the camera; the boot rides the shin. All in viewmodel space; no allocations
    // per frame. Not offered during a reload (the open cylinder and the loading hand are where the leg goes).
    // -----------------------------------------------------------------------------------------------------
    // starts the kick if the viewmodel is ready, not already kicking and not reloading; { impactAt, duration } in seconds, else null
    kick: function () {
      if (!this.ready || !this.kleg || this.kickT >= 0 || this.rel) return null;
      this.kickT = 0; this._kickW = 0;
      this.kleg.root.visible = true;
      this._poseKickLeg(0);
      return { impactAt: KICK_IMPACT, duration: KICK_DUR };
    },
    isKicking: function () { return this.kickT >= 0; },
    kickPhase: function () { return this.kickT >= 0 ? clamp(this.kickT / KICK_DUR, 0, 1) : -1; },

    _updateKick: function (dt) {
      if (this._kickFreeze >= 0) this.kickT = this._kickFreeze;     // debug: hold the leg at one instant
      else if (this.kickT >= 0) {
        const prev = this.kickT;
        this.kickT += dt;
        if (prev < KICK_IMPACT && this.kickT >= KICK_IMPACT) this.S.kh.kick(0.012);     // the hit goes through the gun as a short jolt
      } else return;
      const t = this.kickT;
      if (t >= KICK_DUR) {
        this.kickT = -1; this._kickW = 0;
        this.kleg.root.visible = false;
        return;
      }
      this._kickW = kf(t, [[0, 0], [0.12, 1], [0.34, 1], [0.58, 0]]);
      this._poseKickLeg(t);
    },

    // leg pose at time t: sample the keys (ankle, toe hint, knee pole), solve the 2-bone chain, orient the boot
    _poseKickLeg: function (t) {
      const C = this.KICK, V = this._kv, B = V.b, L = this.kleg, keys = C.keys, n = keys.length;
      let i = 1;
      while (i < n - 1 && t > keys[i][0]) i++;
      const ka = keys[i - 1], kb = keys[i], f0 = clamp((t - ka[0]) / (kb[0] - ka[0]), 0, 1);
      const f = kb[13] === 1 ? f0 * f0 : kb[13] === 2 ? 1 - (1 - f0) * (1 - f0) * (1 - f0) : smooth(f0);
      for (let c = 0; c < 12; c++) B[c] = ka[c + 1] + (kb[c + 1] - ka[c + 1]) * f;
      const H = V.H.set(B[0], B[1], B[2]), A = V.A.set(B[3], B[4], B[5]), T = V.T.set(B[6], B[7], B[8]), P = V.P.set(B[9], B[10], B[11]);
      const L1 = C.thigh, L2 = C.shin, d = V.d.subVectors(A, H);
      let D = d.length();
      const reach = L1 + L2 - 0.004;
      if (D > reach) { d.multiplyScalar(reach / D); A.copy(H).add(d); D = reach; }
      d.multiplyScalar(1 / D);
      const a = (L1 * L1 - L2 * L2 + D * D) / (2 * D), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const pe = V.pe.copy(P).addScaledVector(d, -P.dot(d));
      if (pe.lengthSq() < 1e-8) pe.set(0, 1, 0);
      const K = V.K.copy(H).addScaledVector(d, a).addScaledVector(pe.normalize(), h);
      const s = V.s.subVectors(K, A).normalize();                      // up the shin, ankle -> knee
      T.addScaledVector(s, -T.dot(s));                                 // the foot is square to the shin
      if (T.lengthSq() < 1e-8) T.set(0, 0, -1).addScaledVector(s, s.z);
      T.normalize();
      L.boot.position.copy(A);
      L.boot.quaternion.setFromRotationMatrix(V.m.makeBasis(V.X.crossVectors(s, T), s, T));     // boot space: y up the shaft, z toes
      L.thigh.position.copy(K);
      L.thigh.quaternion.setFromUnitVectors(UPV, V.d2.subVectors(H, K).normalize());
    },

    _buildKickLeg: function () {
      const srgb = this.srgb, col = (h) => this._col(h);
      const aniso = this.renderer && this.renderer.capabilities ? Math.min(8, this.renderer.capabilities.getMaxAnisotropy()) : 4;
      const tex = (cv, rx, ry, color) => {
        const t = new THREE.CanvasTexture(cv);
        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = aniso;
        if (color && srgb) t.encoding = THREE.sRGBEncoding;
        return t;
      };
      const clone = (cv) => { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0); return c; };
      const phong = (o) => new THREE.MeshPhongMaterial(o);

      const tm0 = performance.now();
      // ---- textures and materials (r147 bumpScale is in world units: white = that many metres, so it is a millimetre or two here)
      const lea = makeLeatherCanvases({ size: 512, seed: 11, dark: [56, 34, 20], mid: [94, 60, 36], light: [126, 86, 54], pores: 2300, creases: 60, pr: 3 });
      const sol = makeLeatherCanvases({ size: 256, seed: 5, dark: [26, 18, 13], mid: [42, 30, 21], light: [60, 44, 31], pores: 300, creases: 10, pr: 2 });
      const wool = makeWoolCanvases({ seed: 3, dark: [46, 40, 36], mid: [70, 62, 55], light: [104, 93, 82] });
      // the shaft gets its own copy of the hide: a stitched back seam, a stitched top edge and ankle creases painted on
      const shaftC = clone(lea.color), shaftB = clone(lea.bump), SC = shaftC.width;
      const km = this.kmats = {
        wool: phong({ color: 0xffffff, map: tex(wool.color, 3.5, 3.5, true), bumpMap: tex(wool.bump, 3.5, 3.5), bumpScale: 0.0012, specular: col(0x060606), shininess: 3 }),
        leather: phong({ color: 0xffffff, map: tex(lea.color, 1.3, 1.7, true), bumpMap: tex(lea.bump, 1.3, 1.7), bumpScale: 0.0016, specular: col(0x5a3f2a), shininess: 42 }),
        
        sole: phong({ color: 0xffffff, map: tex(sol.color, 6, 6, true), bumpMap: tex(sol.bump, 6, 6), bumpScale: 0.0012, specular: col(0x2a2018), shininess: 14 }),
        iron: phong({ color: col(0x5b6068), specular: col(0xa8aeb8), shininess: 60 }),
      };
      // the strap: darker, smooth leather with a row of cream stitches along each edge (v runs across its width)
      const sc = document.createElement('canvas'); sc.width = 128; sc.height = 32;
      { const g = sc.getContext('2d'); g.fillStyle = '#3e2412'; g.fillRect(0, 0, 128, 32); g.fillStyle = 'rgba(255,220,170,0.06)'; g.fillRect(0, 10, 128, 12);
        g.fillStyle = '#d9c391'; for (let x = 0; x < 128; x += 16) { g.fillRect(x + 2, 8, 9, 2.4); g.fillRect(x + 2, 22, 9, 2.4); } }
      km.strap = phong({ color: 0xffffff, map: tex(sc, 3, 1, true), specular: col(0x5a3f2a), shininess: 40 });
      const stitch = (g, x, y, w, h) => { g.fillRect(x, y, w, h); };
      const gC = shaftC.getContext('2d'), gB = shaftB.getContext('2d');
      const YB0 = -0.05, YT = 0.322;                                    // shaft bottom (inside the foot) and top edge, boot space
      // shaft profile: calf-hugging taper, a rolled top edge, a short inner wall
      const SHR = [[-0.05, 0.0500], [0.0, 0.0498], [0.05, 0.0505], [0.12, 0.0540], [0.20, 0.0590], [0.27, 0.0618], [YT, 0.0628]];
      const prof = [];
      for (let i = 0; i <= 30; i++) { const y = YB0 + (YT - YB0) * i / 30; prof.push([y, spline(y, SHR)]); }
      const rt = spline(YT, SHR);
      for (let k = 1; k <= 6; k++) { const a = k / 6 * Math.PI; prof.push([YT + Math.sin(a) * 0.0045, rt - 0.0045 + Math.cos(a) * 0.0045]); }
      prof.push([YT - 0.016, rt - 0.0095]);
      let tot = 0; const arc = [0];
      for (let i = 1; i < prof.length; i++) { tot += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]); arc.push(tot); }
      const vOf = (y) => { let i = 1; while (i < prof.length - 1 && prof[i][0] < y) i++; return arc[i] / tot; };       // canvas row of a height on the shaft
      const rowOf = (y) => (1 - vOf(y)) * SC;
      {
        const thread = 'rgba(224,198,150,0.9)', dent = 'rgba(0,0,0,0.55)', sx = SC * 0.5, y0 = rowOf(0.31), y1 = rowOf(0.02);
        gC.fillStyle = 'rgba(40,22,10,0.35)'; gC.fillRect(sx - 3, y0, 6, y1 - y0);                        // back seam: a darker welt strip
        gB.fillStyle = 'rgba(255,255,255,0.45)'; gB.fillRect(sx - 3, y0, 6, y1 - y0);
        for (let y = y0; y < y1; y += 11) {
          for (const dx of [-8, 8]) { gC.fillStyle = thread; stitch(gC, sx + dx - 1, y, 2.4, 6); gB.fillStyle = dent; stitch(gB, sx + dx - 1, y, 2.4, 6); }
        }
        const ty = rowOf(0.300);                                                                          // top edge stitching
        for (let x = 0; x < SC; x += 11) { gC.fillStyle = thread; stitch(gC, x, ty, 6, 2.4); gB.fillStyle = dent; stitch(gB, x, ty, 6, 2.4); }
        for (let k = 0; k < 3; k++) {                                                                      // ankle creases across the front
          const y = rowOf(0.085 + k * 0.030), w = 110 - k * 16;
          for (const ox of [0, SC]) {
            gC.strokeStyle = 'rgba(28,14,6,0.40)'; gC.lineWidth = 3; gC.beginPath(); gC.moveTo(ox - w, y - 4); gC.quadraticCurveTo(ox, y + 12, ox + w, y - 4); gC.stroke();
            gB.strokeStyle = 'rgba(0,0,0,0.45)'; gB.lineWidth = 4; gB.beginPath(); gB.moveTo(ox - w, y - 4); gB.quadraticCurveTo(ox, y + 12, ox + w, y - 4); gB.stroke();
            gB.strokeStyle = 'rgba(255,255,255,0.35)'; gB.lineWidth = 3; gB.beginPath(); gB.moveTo(ox - w, y - 9); gB.quadraticCurveTo(ox, y + 7, ox + w, y - 9); gB.stroke();
          }
        }
      }
      km.shaft = phong({ color: 0xffffff, map: tex(shaftC, 1, 1, true), bumpMap: tex(shaftB, 1, 1), bumpScale: 0.0022, specular: col(0x5a3f2a), shininess: 42 });

      // the welt: tan leather with a dashed cream thread
      const wc = document.createElement('canvas'); wc.width = 32; wc.height = 16;
      { const g = wc.getContext('2d'); g.fillStyle = '#8c6038'; g.fillRect(0, 0, 32, 16); g.fillStyle = '#e2cfa0'; g.fillRect(2, 5, 18, 6); }
      km.welt = phong({ color: 0xffffff, map: tex(wc, 120, 1, true), specular: col(0x3a2a1c), shininess: 20 });
      // the stacked heel: leather lifts, a thin dark line between each
      const hc = document.createElement('canvas'); hc.width = 8; hc.height = 16;
      { const g = hc.getContext('2d'); g.fillStyle = '#3a2412'; g.fillRect(0, 0, 8, 16); g.fillStyle = '#150d07'; g.fillRect(0, 13, 8, 3); }
      km.heel = phong({ color: 0xffffff, map: tex(hc, 1, 118, true), specular: col(0x1e150c), shininess: 10 });

      const tm1 = performance.now();
      // ---- rig
      const root = new THREE.Group(), boot = new THREE.Group(), thigh = new THREE.Group();
      root.name = 'kickLeg'; root.visible = false;
      root.add(boot, thigh);
      this.scene.add(root);
      const add = (parent, geo, mat) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; parent.add(m); return m; };

      // ---- trouser: thigh tube (from the knee towards the hip, along +y), knee, and the shin cloth bloused over the boot top
      const fold = (th, y) => 1 + 0.04 * Math.sin(th * 3 + y * 52) * Math.sin(th * 2 - y * 29 + 1.3);
      const TH = [[0, 0.0668], [0.06, 0.0676], [0.14, 0.0728], [0.24, 0.0800], [0.35, 0.0870], [0.46, 0.0930]], tp = [];
      for (let i = 0; i <= 14; i++) { const y = 0.46 * i / 14; tp.push([y, spline(y, TH)]); }
      add(thigh, revolve(tp, 36, 1, 1, 0, fold), km.wool);
      add(boot, new THREE.SphereGeometry(0.0668, 30, 20), km.wool).position.set(0, 0.40, 0);
      const TR = [[YT - 0.04, 0.0500], [YT - 0.012, 0.0535], [YT + 0.002, 0.0585], [YT + 0.008, 0.0640], [YT + 0.022, 0.0705], [0.36, 0.0700], [0.40, 0.0668]], trp = [];
      for (let i = 0; i <= 16; i++) { const y = TR[0][0] + (0.40 - TR[0][0]) * i / 16; trp.push([y, spline(y, TR)]); }
      add(boot, revolve(trp, 40, 1, 1.03, 0, fold), km.wool);

      // ---- boot shaft
      add(boot, revolve(prof, 48, 1, 1.07, 0), km.shaft);

      // ---- the foot: lofted superellipse sections from the heel to the toe (boot space, ankle centre at the origin, +z toes, sole top at YB)
      const YB = -0.062;
      const FA = [[-0.090, 0.040], [-0.070, 0.043], [-0.045, 0.0455], [-0.010, 0.049], [0.030, 0.0505], [0.075, 0.0525], [0.120, 0.0545], [0.160, 0.052], [0.200, 0.046], [0.236, 0.038]];
      const FT = [[-0.090, -0.005], [-0.075, 0.010], [-0.050, 0.035], [-0.020, 0.050], [0.020, 0.052], [0.060, 0.040], [0.100, 0.018], [0.140, 0.000], [0.180, -0.012], [0.236, -0.022]];
      const ZH = -0.090, ZT = 0.236, RH = 0.040, RT = 0.075;
      const cap = (z) => (z > ZT - RT ? Math.sqrt(Math.max(0, 1 - Math.pow((z - (ZT - RT)) / RT, 2))) : z < ZH + RH ? Math.sqrt(Math.max(0, 1 - Math.pow((ZH + RH - z) / RH, 2))) : 1);
      const footA = (z) => spline(z, FA) * cap(z);
      const ring = (z, u, out) => {                                     // u: 0 = top of the foot, 0.25 = +x side, 0.5 = underneath
        const c = cap(z), a = spline(z, FA) * c, yt = spline(z, FT), b = (yt - YB) / 2 * c, th = u * 6.283185307, cs = Math.cos(th), sn = Math.sin(th);
        const p = cs > 0 ? 2.4 : 4.0;
        out[0] = a * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p);
        out[1] = (yt + YB) / 2 + b * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / p);
      };
      const zAt = (v) => ZH + (ZT - ZH) * (0.5 - 0.5 * Math.cos(Math.PI * v));
      const rr = [0, 0];
      add(boot, gridSurface(40, 44, (u, v, o) => { const z = zAt(v); ring(z, u, rr); o[0] = rr[0]; o[1] = rr[1]; o[2] = z; }, true, [0, 0, 0.07]), km.leather);

      // sole: the foot's plan outline, extruded and bevelled; welt thread round its top edge; the heel stack under the back
      const zs = [], pts = [];
      for (let i = 0; i <= 40; i++) zs.push(zAt(i / 40));
      for (let i = 0; i < zs.length; i++) pts.push(new THREE.Vector2(footA(zs[i]) + 0.003, zs[i]));
      for (let i = zs.length - 2; i > 0; i--) pts.push(new THREE.Vector2(-(footA(zs[i]) + 0.003), zs[i]));
      const BT = 0.0015, SOLE_D = 0.009;
      const soleGeo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: SOLE_D, bevelEnabled: true, bevelThickness: BT, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 8 });
      soleGeo.rotateX(Math.PI / 2); soleGeo.translate(0, YB - BT, 0);
      add(boot, soleGeo, km.sole);
      const wp = [];
      for (let i = 0; i < pts.length; i++) { const p = pts[i]; wp.push(new V3(p.x * 1.0 + Math.sign(p.x) * 0.0012, YB - 0.0005, p.y)); }
      add(boot, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wp, true, 'centripetal'), 140, 0.0030, 6, true), km.welt);
      const hs = new THREE.Shape(), hz = -0.058;
      for (let i = 0; i <= 16; i++) { const t = i / 16 * Math.PI; if (i === 0) hs.moveTo(0.0365 * Math.cos(t), hz - 0.030 * Math.sin(t)); else hs.lineTo(0.0365 * Math.cos(t), hz - 0.030 * Math.sin(t)); }
      hs.lineTo(-0.02, hz + 0.003); hs.lineTo(0, hz - 0.001); hs.lineTo(0.02, hz + 0.003); hs.lineTo(0.0365, hz);
      const heelGeo = new THREE.ExtrudeGeometry(hs, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 6 });
      heelGeo.rotateX(Math.PI / 2); heelGeo.translate(0, YB - 0.0125 - 0.002 + 0.0, 0);
      add(boot, heelGeo, km.heel);

      // ---- instep strap (a ribbon following the foot's section) with an iron buckle on the inner side of the top
      const rA = [0, 0], rB = [0, 0];
      const strap = (zc, w, s0, s1, nu, lift) => {
        const rows = [[-0.5, 0.0010], [-0.5, 0.0036], [-0.38, 0.0046], [0.38, 0.0046], [0.5, 0.0036], [0.5, 0.0010]];
        return gridSurface(nu, rows.length - 1, (u, v, o) => {
          const s = lerp(s0, s1, u), row = rows[Math.round(v * (rows.length - 1))], z = zc + row[0] * w;
          ring(z, (s + 1) % 1, rA); ring(z, (s + 1.002) % 1, rB);
          let tx = rB[0] - rA[0], ty = rB[1] - rA[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
          o[0] = rA[0] - ty * (row[1] + lift); o[1] = rA[1] + tx * (row[1] + lift); o[2] = z;
        }, false, [0, 0.0, zc]);
      };
      const ZS = 0.060, SB = 0.115;
      add(boot, strap(ZS, 0.026, -0.30, 0.30, 60, 0), km.strap);
      add(boot, strap(ZS, 0.020, SB - 0.05, SB + 0.055, 12, 0.0016), km.strap);               // the tail laid back over the strap
      const roundRect = (p, x, y, w, h, r) => {
        p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.quadraticCurveTo(x + w, y, x + w, y + r); p.lineTo(x + w, y + h - r); p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        p.lineTo(x + r, y + h); p.quadraticCurveTo(x, y + h, x, y + h - r); p.lineTo(x, y + r); p.quadraticCurveTo(x, y, x + r, y);
        return p;
      };
      const frame = roundRect(new THREE.Shape(), -0.0200, -0.0160, 0.0400, 0.0320, 0.007);
      frame.holes.push(roundRect(new THREE.Path(), -0.0150, -0.0115, 0.0300, 0.0230, 0.005));
      const buckle = new THREE.Group();
      add(buckle, new THREE.ExtrudeGeometry(frame, { depth: 0.0030, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 1, curveSegments: 6 }), km.iron);
      const prong = add(buckle, new THREE.BoxGeometry(0.0270, 0.0030, 0.0028), km.iron);
      prong.position.set(0.0015, 0, 0.0034);
      ring(ZS, (SB - 0.07 + 1) % 1, rA); ring(ZS, (SB - 0.07 + 1.002) % 1, rB);
      {
        let tx = rB[0] - rA[0], ty = rB[1] - rA[1]; const l = Math.hypot(tx, ty); tx /= l; ty /= l;
        const nx = -ty, ny = tx, off = 0.0068;
        buckle.position.set(rA[0] + nx * off, rA[1] + ny * off, ZS);
        const X = new V3(tx, ty, 0), Z = new V3(nx, ny, 0);
        buckle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new V3().crossVectors(Z, X), Z));
        boot.add(buckle);
      }

      // ---- small iron spur: a yoke round the back of the heel counter, a neck and a toothed rowel
      {
        const yp = [];
        for (let i = 0; i <= 18; i++) { const a = (-100 + 200 * i / 18) * DEG; yp.push(new V3(Math.sin(a) * 0.0455, YB + 0.020, -0.058 - Math.cos(a) * 0.0335)); }
        add(boot, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(yp, false), 24, 0.0022, 6, false), km.iron);
        const neck = add(boot, new THREE.CylinderGeometry(0.0020, 0.0032, 0.026, 8), km.iron);
        neck.rotation.x = Math.PI / 2; neck.position.set(0, YB + 0.020, -0.100);
        const star = new THREE.Shape();
        for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? 0.0070 : 0.0125; if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r); else star.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        const rg = new THREE.ExtrudeGeometry(star, { depth: 0.0022, bevelEnabled: false });
        rg.translate(0, 0, -0.0011); rg.rotateY(Math.PI / 2);
        add(boot, rg, km.iron).position.set(0, YB + 0.020, -0.115);
      }

      this.kleg = { root: root, boot: boot, thigh: thigh };
      this._kv = { b: new Array(12).fill(0), H: new V3(), A: new V3(), T: new V3(), P: new V3(), d: new V3(), d2: new V3(), pe: new V3(), K: new V3(), s: new V3(), X: new V3(), m: new THREE.Matrix4() };
      const tm2 = performance.now();
      // the first kick must not stall on a shader compile or a texture upload
      try {
        if (this.renderer) {
          Object.keys(km).forEach((k) => { ['map', 'bumpMap'].forEach((n) => { if (km[k][n] && this.renderer.initTexture) this.renderer.initTexture(km[k][n]); }); });
          this.renderer.compile(this.scene, this.camera);
        }
      } catch (e) { /* the first kick compiles instead */ }
      this._kickBuildParts = { texturesMs: Math.round(tm1 - tm0), geometryMs: Math.round(tm2 - tm1), uploadCompileMs: Math.round(performance.now() - tm2) };
    },

    // state: { moving, sprinting, aimDelta:{x,y}? }  (reloading is ignored: Weapon.reload(ms) owns that animation)
    update: function (dt, state) {
      if (!this.ready) return;
      state = state || {};
      dt = clamp(dt || 0, 0, 0.1);
      this.time += dt;
      this._ensureWorldLight();
      this._updateSway(dt, state);
      const S = this.S;
      S.kz.step(dt); S.kp.step(dt); S.kc.step(dt); S.kr.step(dt); S.ky.step(dt); S.kh.step(dt);

      // walk bob + sprint blend
      const moving = !!state.moving, sprinting = !!state.sprinting && moving;
      this.bobAmp += ((moving ? 1 : 0) - this.bobAmp) * Math.min(1, dt * 8);
      this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);
      if (moving) this.bobPhase += dt * (sprinting ? 12.5 : 8.8);

      // flash / hammer / cylinder timers
      if (this.flashT < 1) this.flashT += dt;
      this.flashOn = this.flashT < 0.062;
      if (this.hamT < 1) this.hamT += dt;
      if (this.cylT < 1) this.cylT = Math.min(1, this.cylT + dt / 0.11);
      this.cylStep = this.cylT <= 0 ? this.cylFrom : lerp(this.cylFrom, this.cylTo, easeOut(this.cylT));

      // reload timer
      if (this.rel) {
        this.rel.t += dt * 1000;
        if (this.rel.t >= this.rel.dur) { this.rel = null; this.S.kh.kick(0.01); }
      }
      if (this.kleg) this._updateKick(dt);
      this._applyPose(dt);
    },

    _updateSway: function (dt, state) {
      let dx = 0, dy = 0;
      if (state.aimDelta && typeof state.aimDelta === 'object') {
        dx = state.aimDelta.x || 0; dy = state.aimDelta.y || 0;
      } else if (this.mainCam) {
        // derive from the main camera's heading (yaw / pitch change since the last frame)
        const d = this._tmpDir || (this._tmpDir = new V3());
        this.mainCam.getWorldDirection(d);
        const yaw = Math.atan2(-d.x, -d.z), pitch = Math.asin(clamp(d.y, -1, 1));
        if (this.lastYaw !== null) {
          let dyaw = yaw - this.lastYaw;
          if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
          dx = dyaw; dy = pitch - this.lastPitch;
        }
        this.lastYaw = yaw; this.lastPitch = pitch;
      }
      // lag: the gun trails the view, then springs back
      const sw = this.sway;
      const gain = 0.5;
      sw.vx += clamp(-dx, -0.1, 0.1) * gain * 60;
      sw.vy += clamp(-dy, -0.1, 0.1) * gain * 60;
      const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
      for (let i = 0; i < n; i++) {
        sw.vx += (-90 * sw.x - 13 * sw.vx) * h;
        sw.vy += (-90 * sw.y - 13 * sw.vy) * h;
        sw.x += sw.vx * h; sw.y += sw.vy * h;
      }
      sw.x = clamp(sw.x, -0.03, 0.03); sw.y = clamp(sw.y, -0.025, 0.025);
    },

    // base pose of the hold point in viewmodel camera space
    BASE: { x: 0.145, y: -0.112, z: -0.285, rx: 0.03, ry: 0.12, rz: 0 },   // hold point in viewmodel camera space + resting angles

    // the kick leg: thigh and shin lengths and the pose keys (viewmodel space, x right, y up, -z forward). The hip is virtual, below and behind
    // the camera, and moves with the kick (the body lunges). Each key: [t seconds, hip x y z, ankle x y z, toe hint x y z (the foot points along
    // it, made square to the shin), knee pole x y z (the knee bends towards it), ease into this key: 0 smooth, 1 accelerating (the snap),
    // 2 decelerating]. The knee comes up into view first (chamber), the boot rises from the bottom edge, then snaps out and the sole lands at
    // KICK_IMPACT; it holds a beat, drops back and is gone by KICK_DUR.
    KICK: {
      thigh: 0.44, shin: 0.44,
      keys: [
        [0.000, 0.16, -0.62, 0.10, 0.10, -1.00, 0.00, 0.00, -0.6, -1.0, 0.00, 0.0, -1.00, 0],
        [0.050, 0.16, -0.38, -0.02, 0.04, -0.64, -0.52, 0.00, -0.5, -1.0, -0.35, 0.8, -0.50, 2],
        [0.075, 0.20, -0.38, 0.02, 0.045, -0.42, -0.50, -0.05, -0.2, -1.0, 0.00, -0.8, -0.30, 0],
        [0.105, 0.22, -0.32, 0.05, 0.05, -0.20, -0.48, -0.10, 0.1, -1.0, 0.30, -0.8, -0.20, 0],
        [0.160, 0.30, -0.38, 0.15, 0.03, -0.17, -0.57, -0.60, 0.8, 0.0, 0.50, -0.8, 0.00, 1],
        [0.260, 0.30, -0.38, 0.15, 0.025, -0.17, -0.60, -0.60, 0.8, 0.0, 0.50, -0.8, 0.00, 2],
        [0.380, 0.26, -0.34, 0.08, 0.07, -0.25, -0.48, -0.30, 0.6, -0.6, -0.50, -0.6, -0.30, 0],
        [0.520, 0.20, -0.46, 0.08, 0.12, -0.62, -0.40, 0.00, -0.5, -1.0, -0.60, -0.6, -0.20, 0],
        [0.600, 0.16, -0.62, 0.10, 0.10, -1.00, 0.00, 0.00, -0.6, -1.0, -0.60, -0.4, -0.20, 0],
      ],
    },

    _applyPose: function (dt) {
      const S = this.S, B = this.BASE, t = this.time;
      const sb = this.sprintBlend, ba = this.bobAmp * (1 - 0.35 * sb);
      let x = B.x, y = B.y, z = B.z;
      let rx = B.rx || 0, ry = B.ry || 0, rz = B.rz || 0;

      // idle breathing
      y += Math.sin(t * 1.7) * 0.0016;
      rx += Math.sin(t * 1.3 + 0.6) * 0.0035;
      x += Math.sin(t * 0.9) * 0.0008;

      // walk bob (figure eight)
      const ph = this.bobPhase;
      x += Math.sin(ph) * 0.0075 * ba;
      y += -Math.abs(Math.cos(ph)) * 0.0085 * ba + 0.003 * ba;
      rz += Math.sin(ph) * 0.012 * ba;
      rx += Math.sin(ph * 2) * 0.006 * ba;

      // sprint: lower and angle the gun across the body
      x += -0.03 * sb; y += -0.04 * sb; z += 0.03 * sb;
      rx += -0.42 * sb; ry += 0.38 * sb; rz += 0.16 * sb;

      // mouse-lag sway
      x += this.sway.x; y += this.sway.y;
      ry += this.sway.x * 1.6; rx += this.sway.y * 1.6;

      // recoil
      z += S.kz.x;
      y += -S.kz.x * 0.18;
      rx += S.kp.x + S.kc.x;
      rz += S.kr.x;
      ry += S.ky.x;
      y += S.kh.x; rx += S.kh.x * 3;

      // kick: the weight shifts, the gun and hands dip down-right and tilt while the leg is out
      const kw = this._kickW;
      if (kw > 0) { x += 0.052 * kw; y += -0.074 * kw; z += 0.020 * kw; rx += -0.22 * kw; rz += 0.26 * kw; ry += 0.06 * kw; }

      // reload
      let swingOut = 0, spinAngle = 0, hand = 0;
      if (this.rel) {
        const p = clamp(this.rel.t / this.rel.dur, 0, 1);
        const tilt = kf(p, [[0, 0], [0.13, 1], [0.78, 1], [0.93, 0], [1, 0]]);
        x += -0.045 * tilt; y += 0.03 * tilt; z += 0.045 * tilt;
        rz += 0.62 * tilt; rx += 0.34 * tilt; ry += 0.26 * tilt;
        swingOut = kf(p, [[0, 0], [0.16, 0], [0.27, 1], [0.7, 1], [0.8, 0], [1, 0]]);
        // spin while out, then click through the chambers while loading
        // rigged hands: no free spin, the speedloader fills all six at once; muzzle up for the ejector stroke, down to load.
        // procedural fallback: the old spin + chamber clicks
        const rig = !!this._rigL;
        const spinA = rig ? 0 : kf(p, [[0.27, 0], [0.5, 1]]) * Math.PI * 3;
        const load = rig ? kf(p, [[0.74, 0], [0.80, 1]]) * (Math.PI / 3) : kf(p, [[0.5, 0], [0.7, 1]]) * (Math.PI / 3) * 4;
        spinAngle = spinA + load;
        const shake = Math.sin(p * 90) * 0.035 * (rig ? kf(p, [[0.36, 0], [0.39, 1], [0.44, 0]]) : kf(p, [[0.3, 0], [0.38, 1], [0.5, 0]]));
        rz += shake; y += shake * 0.05;
        if (rig) {
          const ej = kf(p, [[0.27, 0], [0.34, 1], [0.43, 1], [0.49, 0]]), ld = kf(p, [[0.47, 0], [0.54, 1], [0.66, 1], [0.74, 0]]);
          rx += 0.28 * ej - 0.22 * ld; y += 0.010 * ej - 0.006 * ld;
        }
        hand = kf(p, [[0, 0], [0.1, 1], [0.86, 1], [0.97, 0], [1, 0]]);
        this._relHand = hand; this._relP = p;
        const close = kf(p, [[0.78, 0], [0.82, 1], [0.9, 0]]);
        y += -close * 0.006; rx += -close * 0.03;
      } else {
        this._relHand = 0; this._relP = -1;
      }

      this.viewRoot.position.set(x, y, z);
      this.viewRoot.rotation.set(rx, ry, rz, 'YXZ');

      // moving parts
      const P = this.parts;
      if (P) {
        if (P.cyl) {
          P.cyl.swing.quaternion.setFromAxisAngle(P.cyl.axisLocal, P.cyl.swingSign * swingOut * 1.5);
          P.cyl.spin.quaternion.setFromAxisAngle(P.cyl.axisLocal, this.cylStep + spinAngle);
        }
        if (P.hammer) {
          // rest = as modelled (cocked). Falls forward on fire (0.04 s), then re-cocks until ~0.2 s.
          const ht = this.hamT;
          const fall = ht < 0.2 ? kf(ht, [[0, 0], [0.035, 1], [0.1, 1], [0.2, 0]]) : 0;
          const relFall = this.rel ? kf(this._relP, [[0.8, 0], [0.84, 0.0], [0.9, 0.0], [1, 0]]) : 0;
          this._hamFall = Math.max(fall, relFall);
          P.hammer.pivot.quaternion.setFromAxisAngle(P.hammer.axisLocal, -P.hammer.dirSign * 0.62 * this._hamFall);
        }
      }

      // flash
      this._applyFlash();
      if (this.handsUpdate) this.handsUpdate(dt);
    },

    _applyFlash: function () {
      const on = this.flashOn;
      const ft = this.flashT;
      const k = on ? clamp(1 - Math.max(0, ft - 0.03) / 0.032, 0, 1) : 0;     // bright for 30 ms, gone by ~62 ms
      const burst = on ? 0.55 + 0.45 * easeOut(ft / 0.025) : 0;
      if (this.flashStarMat) {
        this.flashStarMat.opacity = k;
        this.flashStarMat.rotation = this.flashRoll || 0;
        const sz = 0.125 * (this.flashSize || 1) * burst;
        this.flashStar.scale.set(sz, sz, 1);
        this.flashJetMat.opacity = k * 0.9;
        const len = 0.12 * (this.flashLen || 1) * burst, wd = 0.042 * (this.flashSize || 1) * burst;
        for (const j of this.flashJets) j.scale.set(len, wd, 1);
      }
      if (this.vmFlashLight) {
        this.vmFlashLight.intensity = k * 2.2;
        this.vmFlashLight.position.copy(this._muzzleVm());
        this.vmFlashLight.position.z -= 0.03;
      }
      if (this.worldLight) {
        const wk = on ? clamp(1 - Math.max(0, ft - 0.02) / 0.055, 0, 1) : 0;
        this.worldLight.intensity = wk * 1.1;
        if (wk > 0 && this.mainCam) {
          const p = this._tmpB || (this._tmpB = new V3());
          this.scene.updateMatrixWorld(true);
          this.muzzle.getWorldPosition(p);
          p.z -= 0.25;
          this._vmToMainCam(p, p);
          this.mainCam.updateMatrixWorld();
          p.applyMatrix4(this.mainCam.matrixWorld);
          this.worldLight.position.copy(p);
        }
      }
    },

    // debug (kickClip): sweeps the kick (gun shift included) and reports the closest the leg's vertices come to the gun / hand / forearm
    // surfaces, in metres (0 = touching or inside). Only meshes whose boxes overlap are compared, vertex against triangle.
    _kickClip: function (step) {
      if (!this.kleg) return null;
      const leg = [], oth = [];
      this.kleg.root.traverse((o) => { if (o.isMesh) leg.push(o); });
      this.viewRoot.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) oth.push(o); });
      const world = (m, i, out) => { out.fromBufferAttribute(m.geometry.attributes.position, i); if (m.isSkinnedMesh) m.boneTransform(i, out); return out.applyMatrix4(m.matrixWorld); };
      const tri = new THREE.Triangle(), cp = new V3(), pt = new V3(), bo = new THREE.Box3(), bl = new THREE.Box3(), reg = new THREE.Box3(), tb = new THREE.Box3();
      const res = { minDist: Infinity, t: -1, leg: null, other: null, samples: 0, worst: [] };
      const keep = this._kickFreeze;
      for (let t = 0; t < KICK_DUR - 1e-6; t += step) {
        this._kickFreeze = t; this.kickT = t; this.kleg.root.visible = true;
        this._updateKick(0); this._applyPose(0); this.scene.updateMatrixWorld(true);
        res.samples++;
        let tmin = Infinity, lname = null, oname = null;
        for (const L of leg) {
          bl.setFromObject(L).expandByScalar(0.03);
          for (const O of oth) {
            let vis = true; for (let q = O; q; q = q.parent) if (!q.visible) { vis = false; break; }
            if (!vis) continue;
            bo.setFromObject(O);
            if (!bo.intersectsBox(bl)) continue;
            reg.copy(bl).intersect(bo);
            const lp = [], P = L.geometry.attributes.position;
            for (let i = 0; i < P.count; i++) { world(L, i, pt); if (reg.containsPoint(pt)) lp.push(pt.x, pt.y, pt.z); }
            if (!lp.length) continue;
            const OP = O.geometry.attributes.position, idx = O.geometry.index, wp = new Float32Array(OP.count * 3), v = new V3();
            for (let i = 0; i < OP.count; i++) { world(O, i, v); wp[i * 3] = v.x; wp[i * 3 + 1] = v.y; wp[i * 3 + 2] = v.z; }
            const n = idx ? idx.count / 3 : OP.count / 3;
            for (let k = 0; k < n; k++) {
              const ia = idx ? idx.getX(k * 3) : k * 3, ib = idx ? idx.getX(k * 3 + 1) : k * 3 + 1, ic = idx ? idx.getX(k * 3 + 2) : k * 3 + 2;
              tri.a.fromArray(wp, ia * 3); tri.b.fromArray(wp, ib * 3); tri.c.fromArray(wp, ic * 3);
              tb.setFromPoints([tri.a, tri.b, tri.c]);
              if (!tb.intersectsBox(reg)) continue;
              for (let i = 0; i < lp.length; i += 3) {
                pt.set(lp[i], lp[i + 1], lp[i + 2]);
                tri.closestPointToPoint(pt, cp);
                const d = cp.distanceTo(pt);
                if (d < tmin) { tmin = d; lname = L.parent === this.kleg.thigh ? 'thigh' : (L.material === this.kmats.shaft ? 'shaft' : L.material === this.kmats.wool ? 'wool' : L.material === this.kmats.leather ? 'foot' : L.material === this.kmats.strap ? 'strap' : L.material === this.kmats.iron ? 'iron' : 'sole'); oname = O.name || (O.material && O.material.name) || (O.isSkinnedMesh ? 'hand' : 'gun'); }
              }
            }
          }
        }
        if (tmin < res.minDist) { res.minDist = tmin; res.t = +t.toFixed(3); res.leg = lname; res.other = oname; }
        if (tmin < 0.02) res.worst.push([+t.toFixed(3), +tmin.toFixed(4), lname, oname]);
      }
      this._kickFreeze = keep; this.kickT = keep >= 0 ? keep : -1;
      if (keep < 0) { this._kickW = 0; this.kleg.root.visible = false; }
      res.minDist = +res.minDist.toFixed(4);
      return res;
    },

    _muzzleVm: function () {
      const p = this._tmpC || (this._tmpC = new V3());
      this.viewRoot.updateMatrixWorld(true);
      this.muzzle.getWorldPosition(p);
      return p;
    },

    render: function (renderer) {
      if (!this.ready) return;
      this._ensureWorldLight();            // attach the (idle, intensity 0) world flash light as early as possible: no mid-game shader recompile
      if (!this.viewRoot.visible) return;
      // keep the aspect in sync with the main camera
      if (this.mainCam && Math.abs(this.camera.aspect - this.mainCam.aspect) > 1e-5) {
        this.camera.aspect = this.mainCam.aspect;
        this.camera.updateProjectionMatrix();
      }
      if (this._dbgView) {
        const v = this._dbgView;
        this.camera.position.set(v[0], v[1], v[2]);
        this.camera.lookAt(v[3], v[4], v[5]);
      } else {
        this.camera.position.set(0, 0, 0);
        this.camera.quaternion.set(0, 0, 0, 1);
      }
      const prev = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
      renderer.autoClear = prev;
    },

    state: function () {
      const P = this.parts || {};
      return {
        ready: this.ready, reloading: !!this.rel, reloadMs: this.rel ? Math.round(this.rel.t) : 0,
        flashOn: this.flashOn, flashAgeMs: Math.round(this.flashT * 1000),
        cylinderStepDeg: Math.round(this.cylStep / DEG), hasCylinder: !!P.cyl, hasHammer: !!P.hammer, hammerFall: +(this._hamFall || 0).toFixed(3),
        recoil: { z: +this.S.kz.x.toFixed(4), pitch: +this.S.kp.x.toFixed(4), climb: +this.S.kc.x.toFixed(4), roll: +this.S.kr.x.toFixed(4) },
        sprintBlend: +this.sprintBlend.toFixed(3), bobAmp: +this.bobAmp.toFixed(3),
        kick: { built: !!this.kleg, buildMs: Math.round(this._kickBuildMs || 0), buildParts: this._kickBuildParts || null, active: this.kickT >= 0, t: +Math.max(0, this.kickT).toFixed(3), phase: +this.kickPhase().toFixed(3), weight: +this._kickW.toFixed(3) },
        worldLightIntensity: this.worldLight ? +this.worldLight.intensity.toFixed(3) : null,
        worldLightAdded: this._worldLightAdded,
        gunLength: this.lm ? +this.lm.length.toFixed(4) : null,
        muzzleVm: this.muzzle ? this._muzzleVm().toArray().map((v) => +v.toFixed(4)) : null,
        landmarks: this.lm ? { grip: [this.lm.grip.min.toArray(), this.lm.grip.max.toArray()].map((a) => a.map((v) => +v.toFixed(4))), box: [this.lm.box.min.toArray(), this.lm.box.max.toArray()].map((a) => a.map((v) => +v.toFixed(4))), muzzle: this.lm.muzzle.toArray().map((v) => +v.toFixed(4)) } : null,
        parts: { cylMembers: P.cylMembers || 0, cylCenterGun: P.cylCenterGun ? P.cylCenterGun.toArray().map((v) => +v.toFixed(4)) : null, hammerPivotGun: P.hammerCtrGun ? P.hammerCtrGun.toArray().map((v) => +v.toFixed(4)) : null, fallback: !!P.fallback }
      };
    },

    _installDebug: function () {
      if (!window.__dbg) return;
      const self = this;
      window.__dbg.weapon = {
        state: function () { return self.state(); },
        fire: function () { return self.fire().toArray(); },
        reload: function (ms) { self.reload(ms); return true; },
        // kick() starts the kick (returns { impactAt, duration } or null); kickAt(sec) freezes the leg at that instant of it (kickAt() or
        // kickAt(-1) lets it go); kickKeys(keys) / kickRig({ thigh, shin }) retune the pose live
        kick: function () { return self.kick(); },
        kickAt: function (sec) {
          if (!self.kleg) return false;
          if (sec === undefined || sec < 0) { self._kickFreeze = -1; self.kickT = -1; self._kickW = 0; self.kleg.root.visible = false; return true; }
          self._kickFreeze = sec; self.kickT = sec; self.kleg.root.visible = true; self._updateKick(0); return true;
        },
        kickClip: function (step) { return self._kickClip(step || 0.04); },
        kickKeys: function (k) { if (k) self.KICK.keys = k; return self.KICK.keys; },
        kickRig: function (o) { if (o) Object.assign(self.KICK, o); return { thigh: self.KICK.thigh, shin: self.KICK.shin }; },
        // view(px,py,pz, tx,ty,tz) renders the viewmodel from an arbitrary camera (viewmodel space); view() resets
        view: function (px, py, pz, tx, ty, tz) { self._dbgView = (px === undefined) ? null : [px, py, pz, tx, ty, tz]; return true; },
        pose: function (o) { if (o) Object.assign(self.BASE, o); return Object.assign({}, self.BASE); },
        // right-hand grip tuning: grip({ at, roll, scale, pose }) re-poses and re-places the hand, returns the config
        grip: function (o) { if (!self._rigR) return null; if (o) Object.assign(self.gripCfg, o); self._placeRightHand(); return JSON.parse(JSON.stringify(self.gripCfg)); }
      };
    }
  };

  window.Weapon = Weapon;
})();
