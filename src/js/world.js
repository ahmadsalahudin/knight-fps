/* world.js — window.World (B1, F2)
   World.build(scene)      ground + scattered grass / birch trees / rocks (all inside the arena disc) + a closed rock wall
   World.colliders         [{x, z, r}]   circles for movement collision (trees, rocks, one per boundary rock)
   World.staticTargets     Object3D[]    ground + trees + rocks + the boundary wall meshes for bullet-impact raycasts
                                         (use raycaster.intersectObjects(World.staticTargets, true); grass is excluded)
   World.arenaRadius       49    radius of the circle the player is clamped to (game.js); knights and the boss are kept in by the colliders
   World.ringRadius        51.6  centre line of the boundary wall
   Needs Assets.load() to have resolved (main.js awaits it before World.build). */
window.World = (function () {
  const colliders = [];
  const staticTargets = [];

  // Prop heights in world units. They reproduce the sizes the game always had (the old code scaled the native glTF
  // size by 1.4 / 1.2 / 2.2 / 1.0); native heights: grass 1.01, grass_2 1.20, birch 3.57, rock 0.88.
  const HEIGHT = { grass: 1.4, grass_2: 1.45, birch_tree: 7.9, rock: 0.9 };

  // The arena is a disc. The player is clamped to ARENA_RADIUS (game.js reads World.arenaRadius); the wall of boulders stands
  // just outside it: the innermost rock face is at about RING_RADIUS - 0.3 - 1.75 = 49.5, so the camera never touches a rock.
  const ARENA_RADIUS = 49;
  const RING_RADIUS = 51.6;

  // Props are scattered exactly as before (two Math.random() draws per prop over a square), so the random sequence and the layout of
  // every prop that already lies inside the arena disc stay the same; the ones that fall outside it (the square reaches past the wall)
  // are re-placed inside by a deterministic hash of their own draw (no extra Math.random calls).
  const hash = function (n) { const v = Math.sin(n) * 43758.5453; return v - Math.floor(v); };
  function intoDisc(x, z, half, R) {
    if (Math.hypot(x, z) <= R) return { x: x, z: z };
    const u = x / half * 0.5 + 0.5, v = z / half * 0.5 + 0.5;
    const r = R * Math.sqrt(hash(u * 127.1 + v * 311.7)), a = Math.PI * 2 * hash(u * 269.5 + v * 183.3);
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  function scatter(scene, name, count, areaHalf, maxR, opts) {
    opts = opts || {};
    const tpl = window.Assets.get(name, { height: opts.height || HEIGHT[name] || 1 });
    if (!tpl) return;
    const baseScale = tpl.scale.x;
    for (let i = 0; i < count; i++) {
      const m = tpl.clone(true);
      const pt = intoDisc((Math.random() * 2 - 1) * areaHalf, (Math.random() * 2 - 1) * areaHalf, areaHalf, maxR);
      const x = pt.x, z = pt.z;
      m.position.set(x, 0, z);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.scale.setScalar(baseScale * (opts.variance ? (0.7 + Math.random() * 0.6) : 1));
      if (opts.noShadow) m.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      scene.add(m);
      if (opts.collidable) colliders.push({ x: x, z: z, r: opts.radius || 1 });
      if (opts.target) staticTargets.push(m);
    }
  }

  // Bake a list of boulders (the existing rock asset, stretched and tilted per boulder) into ONE mesh: the wall is a couple of
  // hundred rocks, but it costs a single draw call and one raycast target. Geometry data is copied,
  // the material is the asset's shared one.
  function bakeRocks(scene, tpl, rocks) {
    let meshes = [];
    tpl.traverse(function (o) { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    if (!meshes.length || !rocks.length) return null;
    let nv = 0, ni = 0;
    for (const m of meshes) {
      const g = m.geometry;
      nv += g.attributes.position.count;
      ni += g.index ? g.index.count : g.attributes.position.count;
    }
    nv *= rocks.length; ni *= rocks.length;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    const v = new THREE.Vector3(), nm = new THREE.Matrix3();
    let vo = 0, io = 0;
    for (const r of rocks) {
      tpl.position.set(r.x, r.y, r.z);
      tpl.rotation.set(r.tx, r.ry, r.tz);
      tpl.scale.set(r.sx, r.sy, r.sx);
      tpl.updateMatrixWorld(true);
      for (const m of meshes) {
        const g = m.geometry, p = g.attributes.position, n = g.attributes.normal;
        nm.getNormalMatrix(m.matrixWorld);
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
          if (n) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z; }
        }
        const cnt = g.index ? g.index.count : p.count;
        for (let i = 0; i < cnt; i++) idx[io + i] = vo + (g.index ? g.index.getX(i) : i);
        vo += p.count; io += cnt;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, meshes[0].material);
    mesh.castShadow = false; mesh.receiveShadow = false;   // no shadows: the 2048 px map over 160 m makes blocky patches on the wall faces up close
    mesh.frustumCulled = false;                      // the camera stands inside the ring: it is always in view
    mesh.userData.asset = 'rock';
    scene.add(mesh);
    return mesh;
  }

  // Closed wall of boulders around the arena. Front row: overlapping boulders on RING_RADIUS (one collider each, so knights and
  // the boss cannot pass); back row: taller boulders behind it for a ragged skyline and depth. No gaps in the line of sight.
  function buildRing(scene) {
    const tpl = window.Assets.get('rock', { height: HEIGHT.rock });
    if (!tpl) return;
    const base = tpl.scale.x;
    const sz = (window.Assets.size && window.Assets.size('rock')) || null;
    const foot = sz ? Math.max(sz.x, sz.z) * base : 0.5;        // footprint / height of one asset rock at the base scale
    const tall = sz ? sz.y * base : 0.9;
    const rnd = function (a, b) { return a + Math.random() * (b - a); };
    const make = function (R, step, wMin, wMax, hMin, hMax, rJit, withColliders) {
      const rocks = [], n = Math.round(Math.PI * 2 * R / step);
      for (let i = 0; i < n; i++) {
        const a = ((i + (Math.random() - 0.5) * 0.35) / n) * Math.PI * 2;
        const r = R + (Math.random() - 0.5) * rJit;
        const w = rnd(wMin, wMax), h = rnd(hMin, hMax);
        const rock = {
          x: Math.cos(a) * r, y: -h * 0.12, z: Math.sin(a) * r,                 // sunk a little: no floating bottom edges
          tx: (Math.random() - 0.5) * 0.2, ry: Math.random() * Math.PI * 2, tz: (Math.random() - 0.5) * 0.2,
          sx: base * w / foot, sy: base * h / tall
        };
        rocks.push(rock);
        if (withColliders) colliders.push({ x: rock.x, z: rock.z, r: w * 0.45 });
      }
      return rocks;
    };
    const front = make(RING_RADIUS, 1.7, 2.8, 3.5, 2.6, 3.8, 0.6, true);
    const back = make(RING_RADIUS + 2.8, 3.0, 3.6, 5.0, 4.2, 6.2, 1.2, false);
    const f = bakeRocks(scene, tpl, front);
    const b = bakeRocks(scene, tpl, back);
    if (f) { f.name = 'boundary'; staticTargets.push(f); }
    if (b) { b.name = 'boundary-back'; staticTargets.push(b); }
  }

  function build(scene) {
    colliders.length = 0;
    staticTargets.length = 0;

    // glTF colours are linear and main.js switches the renderer to sRGB output (Assets.srgbOutput), so the
    // hand-picked sRGB hex of the ground has to be converted to linear or it renders washed out.
    const groundColor = new THREE.Color(0x4a7c3a);
    if (window.Assets && window.Assets.srgbOutput && groundColor.convertSRGBToLinear) groundColor.convertSRGBToLinear();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshLambertMaterial({ color: groundColor })
    );
    ground.name = 'ground';
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    staticTargets.push(ground);

    // props stay inside the arena disc (the squares they are scattered over, as before, reach past the boundary)
    scatter(scene, 'grass', 90, 45, ARENA_RADIUS, { noShadow: true, variance: true });
    scatter(scene, 'grass_2', 60, 45, ARENA_RADIUS, { noShadow: true, variance: true });
    scatter(scene, 'birch_tree', 10, 55, 46, { collidable: true, radius: 1.2, target: true });
    scatter(scene, 'rock', 12, 40, 42, { collidable: true, radius: 1.0, variance: true, target: true });

    buildRing(scene);
    return colliders;
  }

  return { build: build, colliders: colliders, staticTargets: staticTargets, arenaRadius: ARENA_RADIUS, ringRadius: RING_RADIUS };
})();
