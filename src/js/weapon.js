/* weapon.js — window.Weapon: first-person revolver viewmodel (B2).

   The viewmodel lives in its OWN scene + camera (Weapon.scene / Weapon.camera, FOV 60, aspect synced with the main
   camera) and is drawn by Weapon.render(renderer) AFTER the world render with the depth buffer cleared, so the gun
   can never clip into knights, trees or rocks.

   Public API (docs/FIX_PLAN.md "Weapon"):
     init(camera, renderer)           build the viewmodel (revolver + gloved hands), lights, flash
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
      try { ok = this._buildRevolver(); } catch (e) { console.error('[Weapon] revolver build failed, using fallback', e); }
      if (!ok) this._buildFallbackGun();
      try { this._buildHands(); } catch (e) { console.error('[Weapon] hands build failed', e); }
      this._buildFlash();

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
      this.mats = {
        dark: new THREE.MeshPhongMaterial({ color: col(0x2c3036), specular: col(0x4c535b), shininess: 38 }),
        light: new THREE.MeshPhongMaterial({ color: col(0x626972), specular: col(0x7e868f), shininess: 42 }),
        wood: new THREE.MeshPhongMaterial({ color: col(0x5d3a20), specular: col(0x34271a), shininess: 22 }),
        glove: new THREE.MeshPhongMaterial({ color: col(0x6b4a30), specular: col(0x241a12), shininess: 10, flatShading: true }),
        glove2: new THREE.MeshPhongMaterial({ color: col(0x4d3523), specular: col(0x1a120c), shininess: 8, flatShading: true }),
        sleeve: new THREE.MeshPhongMaterial({ color: col(0x39424f), specular: col(0x121820), shininess: 6, flatShading: true })
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
      this.worldLight = new THREE.PointLight(0xffa850, 0, 14, 2);
      this.worldLight.castShadow = false;
      this._worldLightAdded = false;
    },

    // -----------------------------------------------------------------------------------------------------
    // revolver
    // -----------------------------------------------------------------------------------------------------
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
    // hands (simple low-poly gloved hand + sleeve)
    // -----------------------------------------------------------------------------------------------------
    _buildHands: function () {
      const M = this.mats, lm = this.lm;
      if (!lm) return;
      const up = new V3(0, 1, 0);
      const limb = (a, b, r, mat, seg) => {            // capsule from a to b
        const d = new V3().subVectors(b, a), len = d.length();
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.0005, len - 2 * r), 2, seg || 6), mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(up, d.normalize());
        m.frustumCulled = false;
        return m;
      };
      const taper = (a, b, ra, rb, mat, seg) => {      // cone frustum, radius ra at a, rb at b
        const d = new V3().subVectors(b, a), len = d.length();
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rb, ra, len, seg || 8, 1), mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(up, d.normalize());
        m.frustumCulled = false;
        return m;
      };
      const slab = (c, sx, sy, sz, mat, q) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
        m.position.copy(c);
        if (q) m.quaternion.copy(q);
        m.frustumCulled = false;
        return m;
      };

      // ---------------------------------------------------------------- right (shooting) hand, on the grip
      const g = lm.grip;
      const topY = g.max.y, botY = g.min.y;
      const gT = new V3(0, topY - 0.010, lm.gripTopZ);
      const gB = new V3(0, botY + 0.006, lm.gripBotZ);
      const u = new V3().subVectors(gB, gT).normalize();          // down along the grip
      const n = new V3(0, u.z, -u.y).normalize();                 // rearwards, perpendicular to the grip
      const halfD = 0.0185;                                       // half grip depth (front-back)
      const mid = gT.clone().add(gB).multiplyScalar(0.5);
      const R = new THREE.Group();
      R.name = 'rightHand';

      // back of the hand: faceted ellipsoid behind (and to the right of) the grip, tilted with the grip rake
      const blob = (c, rx, ry, rz, mat, q) => {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), mat);
        m.scale.set(rx, ry, rz);
        m.position.copy(c);
        if (q) m.quaternion.copy(q);
        m.frustumCulled = false;
        return m;
      };
      const basis = new THREE.Matrix4().makeBasis(new V3(1, 0, 0), u.clone().negate(), n);
      const palmQ = new THREE.Quaternion().setFromRotationMatrix(basis);
      const palmC = mid.clone().addScaledVector(n, halfD + 0.010).add(new V3(0.010, 0.0, 0));
      R.add(blob(palmC, 0.031, 0.043, 0.024, M.glove, palmQ));
      // heel of the hand / web between thumb and index finger, over the top strap
      const webC = gT.clone().addScaledVector(n, halfD + 0.002).addScaledVector(u, -0.006).add(new V3(0.0, 0.0, 0));
      R.add(blob(webC, 0.022, 0.016, 0.019, M.glove2, palmQ));
      // palm side covering the right of the grip
      R.add(blob(mid.clone().add(new V3(0.016, 0.003, -0.002)), 0.016, 0.040, 0.025, M.glove2, palmQ));

      // three fingers wrapped around the front of the grip (tips curl round to the left side)
      for (let i = 0; i < 3; i++) {
        const sOff = 0.032 + i * 0.019;
        const c = gT.clone().addScaledVector(u, sOff).addScaledVector(n, -(halfD + 0.007));
        const a = c.clone().add(new V3(-0.0195 + i * 0.0015, 0, 0));
        const b = c.clone().add(new V3(0.024, 0, 0));
        R.add(limb(a, b, 0.0088 - i * 0.0007, i % 2 ? M.glove2 : M.glove, 6));
      }
      // index finger along the left of the frame, resting on the trigger
      const knuckle = gT.clone().addScaledVector(n, -(halfD + 0.002)).add(new V3(-0.0135, 0.0045, 0));
      const trig = new V3(-0.0045, -0.0215, -0.0625);
      R.add(limb(knuckle, trig, 0.0074, M.glove, 6));
      // thumb lying along the left side of the frame
      const thumbRoot = gT.clone().addScaledVector(n, halfD - 0.004).add(new V3(-0.009, 0.013, 0));
      const thumbTip = new V3(-0.0195, 0.0265, -0.040);
      R.add(blob(thumbRoot, 0.012, 0.012, 0.014, M.glove2, null));
      R.add(limb(thumbRoot, thumbTip, 0.0090, M.glove2, 6));

      // wrist: leather cuff then sleeve, running back and DOWN out of the frame
      const wrist = palmC.clone().addScaledVector(u, -0.030).addScaledVector(n, 0.010).add(new V3(0.004, 0, 0));
      const fdir = new V3(0.30, -0.62, 0.72).normalize();
      const cuffEnd = wrist.clone().addScaledVector(fdir, 0.055);
      const elbow = wrist.clone().addScaledVector(fdir, 0.34);
      R.add(taper(wrist.clone().addScaledVector(fdir, -0.014), cuffEnd, 0.0215, 0.0235, M.glove2, 8));
      R.add(taper(cuffEnd.clone().addScaledVector(fdir, -0.006), elbow, 0.0275, 0.037, M.sleeve, 8));
      this.gunPivot.add(R);
      this.handR = R;

      // ---------------------------------------------------------------- left (reload) hand, hidden until reload
      const L = new THREE.Group();
      L.name = 'leftHand';
      // canonical pose: palm faces +x (towards the gun), fingers point -z, thumb up
      L.add(slab(new V3(0, 0, 0), 0.016, 0.042, 0.046, M.glove, null));
      for (let i = 0; i < 4; i++) {
        const y = -0.015 + i * 0.0105;
        L.add(limb(new V3(0.002, y, -0.020), new V3(0.002, y + 0.002, -0.058 + (i === 1 ? -0.004 : 0)), 0.0068, i % 2 ? M.glove2 : M.glove, 6));
      }
      L.add(limb(new V3(0.0, 0.017, -0.004), new V3(0.004, 0.034, -0.030), 0.0078, M.glove2, 6));
      const lw = new V3(-0.002, -0.004, 0.026);
      const ldir = new V3(-0.25, -0.3, 0.92).normalize();
      L.add(taper(lw, lw.clone().addScaledVector(ldir, 0.05), 0.0215, 0.0245, M.glove2, 8));
      L.add(taper(lw.clone().addScaledVector(ldir, 0.05), lw.clone().addScaledVector(ldir, 0.36), 0.0265, 0.039, M.sleeve, 8));
      L.visible = false;
      this.gunPivot.add(L);
      this.handL = L;
    },

    // reload choreography of the left hand (gun space)
    handsUpdate: function (dt) {
      const L = this.handL;
      if (!L) return;
      const p = this._relP;
      if (p < 0 || !this.rel) { if (L.visible) L.visible = false; return; }
      const k = this._relHand;
      L.visible = k > 0.01;
      // approach from below-left, hold beside the cylinder, dip twice to "load", then withdraw
      const dip = kf(p, [[0.48, 0], [0.54, 1], [0.6, 0], [0.64, 1], [0.7, 0]]);
      const far = new V3(-0.16, -0.17, 0.10);
      const near = new V3(-0.058, -0.022 - dip * 0.020, -0.050 - dip * 0.006);
      L.position.lerpVectors(far, near, smooth(k));
      L.rotation.set(0.10 * (1 - k), 0.05 + 0.5 * (1 - k), -0.2 * (1 - k) + dip * 0.15);
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

      // reload
      let swingOut = 0, spinAngle = 0, hand = 0;
      if (this.rel) {
        const p = clamp(this.rel.t / this.rel.dur, 0, 1);
        const tilt = kf(p, [[0, 0], [0.13, 1], [0.78, 1], [0.93, 0], [1, 0]]);
        x += -0.045 * tilt; y += 0.03 * tilt; z += 0.045 * tilt;
        rz += 0.62 * tilt; rx += 0.34 * tilt; ry += 0.26 * tilt;
        swingOut = kf(p, [[0, 0], [0.16, 0], [0.27, 1], [0.7, 1], [0.8, 0], [1, 0]]);
        // spin while out, then click through the chambers while loading
        const spinA = kf(p, [[0.27, 0], [0.5, 1]]) * Math.PI * 3;
        const load = kf(p, [[0.5, 0], [0.7, 1]]) * (Math.PI / 3) * 4;
        spinAngle = spinA + load;
        const shake = Math.sin(p * 90) * 0.035 * (kf(p, [[0.3, 0], [0.38, 1], [0.5, 0]]));
        rz += shake; y += shake * 0.05;
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
        this.worldLight.intensity = wk * 3.6;
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
        // view(px,py,pz, tx,ty,tz) renders the viewmodel from an arbitrary camera (viewmodel space); view() resets
        view: function (px, py, pz, tx, ty, tz) { self._dbgView = (px === undefined) ? null : [px, py, pz, tx, ty, tz]; return true; },
        pose: function (o) { if (o) Object.assign(self.BASE, o); return Object.assign({}, self.BASE); }
      };
    }
  };

  window.Weapon = Weapon;
})();
