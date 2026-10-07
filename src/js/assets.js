/* assets.js — window.Assets
   Extracted verbatim from the single-file build (hand-written GLB parser, no GLTFLoader).
   Plan: B1 replaces this with GLTFLoader + SkeletonUtils; keep the Assets.get(name, opts) call shape. */
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
      material = new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: c[3] < 1, opacity: c[3], side: THREE.DoubleSide });
    } else {
      material = new THREE.MeshLambertMaterial({ color: 0x999999, side: THREE.DoubleSide });
    }
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
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
    // CULL-FIX: LL parsers can produce triangle winding/three.js-side artifacts baked into
    // un-indexed geometry, causing WebGL to skip painting every triangle. Combined with a
    // wrong-bounding-sphere the engine then frustum-culls meshes that ARE on screen. Belt
    // AND suspenders: force culling-safe material everywhere + disable frustum-culling
    // recursively on the whole parsed tree. Never trust the path of ancestors alone.
    root.traverse(function (o) {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.material && o.material.side !== undefined) o.material.side = THREE.DoubleSide;
        if (o.geometry && !o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      }
    });
    // REBASE: vendor GLBs carry armature offsets far from the group origin; recenter
    // the visible body's ground-center to origin and normalize standup height to 1.8u.
    root.updateMatrixWorld(true);
    const _bb = new THREE.Box3().setFromObject(root);
    if (isFinite(_bb.min.x)) {
      const _size = _bb.getSize(new THREE.Vector3());
      const _center = _bb.getCenter(new THREE.Vector3());
      root.position.set(-_center.x, -_bb.min.y, -_center.z);
      const _wrap = new THREE.Group();
      _wrap.add(root);
      if (_size.y > 0.001) _wrap.scale.setScalar(1.8 / _size.y);
      cache[name] = _wrap;
      return _wrap.clone(true);
    }
    cache[name] = root;
    return root.clone(true);
  }

  return { get: parse, instance: parse, parseGLB: parse };
})();
