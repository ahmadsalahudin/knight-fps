/* ============================================================
   GLB ASSETS MODULE (hand-written by agent — replaces qwen module)
   Parses embedded base64 GLBs into THREE meshes. No GLTFLoader dep.
   ============================================================ */
window.Assets = (function () {
  const cache = {};

  function decodeGLB(ab) {
    const view = new DataView(ab);
    if (view.getUint32(0, true) !== 0x46546C67) throw new Error('not GLB'); // 'glTF'
    const totalLen = view.getUint32(8, true);
    let json = null, bin = null, off = 12;
    while (off < totalLen) {
      const cLen = view.getUint32(off, true);
      const cType = view.getUint32(off + 4, true);
      const data = new Uint8Array(ab, off + 8, Math.min(cLen, ab.byteLength - off - 8));
      if (cType === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(data));        // 'JSON'
      else if (cType === 0x004E4942) bin = data;                                          // 'BIN\0'
      off += 8 + cLen; off = (off + 3) & ~3;
    }
    if (!json) throw new Error('no JSON chunk');
    return { json, bin: bin || new Uint8Array(0) };
  }

  const COMP = { 5126: { c: 4, t: Float32Array }, 5123: { c: 2, t: Uint16Array }, 5125: { c: 4, t: Uint32Array }, 5121: { c: 1, t: Uint8Array } };
  const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function accessorBytes(json, bin, idx) {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const info = COMP[a.componentType];
    const n = NCOMP[a.type];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const count = a.count * n;
    const raw = bin.subarray(start, start + count * info.c);
    const arr = new info.t(raw.buffer, raw.byteOffset, count);
    return { arr, n, count, min: a.min, max: a.max };
  }

  function buildPrimitive(json, bin, prim) {
    const g = new THREE.BufferGeometry();
    const pos = accessorBytes(json, bin, prim.attributes.POSITION);
    g.setAttribute('position', new THREE.BufferAttribute(pos.arr, 3));
    if (prim.attributes.NORMAL !== undefined) {
      const nrm = accessorBytes(json, bin, prim.attributes.NORMAL);
      g.setAttribute('normal', new THREE.BufferAttribute(nrm.arr, 3));
    } else {
      g.computeVertexNormals();
    }
    const indices = accessorBytes(json, bin, prim.indices);
    g.setIndex(new THREE.BufferAttribute(indices.arr, 1));

    let material;
    const matDef = json.materials ? json.materials[prim.material || 0] : null;
    if (matDef && matDef.pbrMetallicRoughness && matDef.pbrMetallicRoughness.baseColorFactor) {
      const c = matDef.pbrMetallicRoughness.baseColorFactor;
      material = new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: c[3] < 1, opacity: c[3] });
    } else {
      material = new THREE.MeshLambertMaterial({ color: 0x999999 });
    }
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    return mesh;
  }

  function buildNode(json, bin, nodeIdx, parent) {
    const nd = json.nodes[nodeIdx];
    const obj = new THREE.Object3D();
    if (nd.translation) obj.position.fromArray(nd.translation);
    if (nd.rotation) obj.quaternion.fromArray(nd.rotation);
    if (nd.scale) obj.scale.fromArray(nd.scale);
    if (nd.matrix) obj.applyMatrix4(new THREE.Matrix4().fromArray(nd.matrix));
    if (nd.mesh !== undefined) {
      const meshDef = json.meshes[nd.mesh];
      for (const prim of meshDef.primitives) obj.add(buildPrimitive(json, bin, prim));
    }
    if (nd.children) for (const c of nd.children) buildNode(json, bin, c, obj);
    parent.add(obj);
    return obj;
  }

  function parse(name) {
    if (cache[name]) return cache[name].clone(true);
    const dataURI = window.ASSETS[name];
    if (!dataURI) { console.warn('[Assets] missing asset', name); return null; }
    const b64 = dataURI.split(',')[1];
    const binStr = atob(b64);
    const ab = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) ab[i] = binStr.charCodeAt(i);
    const { json, bin } = decodeGLB(ab.buffer);
    const root = new THREE.Group();
    if (!json.scenes || !json.scenes[0] || !json.scenes[0].nodes) return null;
    for (const ni of json.scenes[0].nodes) buildNode(json, bin, ni, root);
    // REBASE: Quaternius GLBs carry huge armature offsets — visible geometry can sit far
    // from the group origin (observed: root claimed (-13.7,0,1.7), children rendering at (-8,1,11)).
    // Recenter so the visual body's ground-center = origin, and normalize standup height to 1.8u.
    root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(root);
    if (bb.min.x !== Infinity) {
      const size = new THREE.Vector3(); bb.getSize(size);
      const center = new THREE.Vector3(); bb.getCenter(center);
      const recenter = new THREE.Group();
      recenter.add(root);
      root.position.set(-center.x, -bb.min.y, -center.z);   // ground-center at origin
      const targetH = 1.8;
      if (size.y > 0.001) recenter.scale.setScalar(targetH / size.y);
      cache[name] = recenter;
      return recenter.clone(true);
    }
    cache[name] = root;
    return root.clone(true);
  }

  return { get: parse, instance: parse, parseGLB: parse };
})();

/* ============================================================
   WORLD MODULE (hand-written — replaces qwen 'world' module)
   ============================================================ */
window.World = (function () {
  const colliders = [];

  function scatter(scene, name, count, areaHalf, yBase, opts = {}) {
    const src = window.Assets.get(name);
    if (!src) return;
    for (let i = 0; i < count; i++) {
      const m = src.clone(true);
      const x = (Math.random() * 2 - 1) * areaHalf;
      const z = (Math.random() * 2 - 1) * areaHalf;
      m.position.set(x, yBase, z);
      m.rotation.y = Math.random() * Math.PI * 2;
      const s = opts.scale || 1;
      m.scale.setScalar(s * (opts.variance ? (0.7 + Math.random() * 0.6) : 1));
      if (!opts.noShadow) m.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
      scene.add(m);
      if (opts.collidable) colliders.push({ x, z, r: opts.radius || 1 });
    }
  }

  function build(scene) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshLambertMaterial({ color: 0x4a7c3a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    scatter(scene, 'grass', 90, 45, 0, { noShadow: true, variance: true, scale: 1.4 });
    scatter(scene, 'grass_2', 60, 45, 0, { noShadow: true, variance: true, scale: 1.2 });
    scatter(scene, 'birch_tree', 10, 55, 0, { collidable: true, radius: 1.2, scale: 2.2 });
    scatter(scene, 'rock', 12, 40, 0, { collidable: true, radius: 1.0, variance: true });

    // boundary ring of rocks so play area feels closed
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const rock = window.Assets.get('rock');
      if (!rock) break;
      const m = rock.clone(true);
      m.position.set(Math.cos(a) * 52, 0, Math.sin(a) * 52);
      m.scale.setScalar(2.5 + Math.random());
      m.rotation.y = Math.random() * Math.PI;
      m.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(m);
      colliders.push({ x: m.position.x, z: m.position.z, r: 2.4 });
    }
    return colliders;
  }

  return { build, colliders };
})();
