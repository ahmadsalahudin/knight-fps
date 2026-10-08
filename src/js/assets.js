/* assets.js — window.Assets (B1)
   THREE.GLTFLoader over the base64 GLBs in window.ASSETS, cloned with THREE.SkeletonUtils so skinned meshes animate
   independently.

   Boot:    await Assets.load()                      Promise<void>; idempotent; get()/clips() are only valid afterwards.
   Assets.srgbOutput = true                           main.js then sets renderer.outputEncoding = sRGB (glTF colours are linear).

   Assets.get(name, opts?) -> THREE.Group | null      NEW wrapper per call, origin at the bottom-centre of the asset's
                                                      bind-pose bounding box (wrapper.children[0] is the model clone).
       opts.height  default 1.8   uniform scale so the box height == height   (applied as wrapper.scale)
       opts.length                uniform scale so the longest horizontal extent == length (overrides height)
       opts.raw     true          no recentering, no normalization (native glTF units, identity wrapper)
       opts.cloneMaterials true   give this instance its own materials (tint / fade without touching other instances)
   Assets.clips(name)   -> AnimationClip[]            names with the 'HumanArmature|' prefix stripped ('Walking', 'Run', ...)
   Assets.clip(name, clipName) -> AnimationClip|null
   Assets.bone(root, 'Palm.R') -> Object3D|null        find a node by its ORIGINAL glTF name ('Palm.R'); GLTFLoader sanitises
                                                      node names ('PalmR'), the original is kept in userData.name
   Assets.bones(root)   -> { 'Head': Bone, 'Palm.R': Bone, ... }   every Bone under root keyed by its original name
   Assets.size(name)    -> THREE.Vector3 | null       native (un-normalised) bind-pose bounding-box size
   Assets.has(name), Assets.names(), Assets.isLoaded(), Assets.failed (names that failed to parse)
   Legacy aliases kept so old call sites work: Assets.instance, Assets.parseGLB (== get). */
window.Assets = (function () {
  const store = Object.create(null);   // name -> { scene, animations, box:Box3, size:Vector3, center:Vector3, skinned:bool }
  let loadPromise = null;
  let loaded = false;
  const failed = [];
  const warned = {};

  // ---- tuning ---------------------------------------------------------------------------------------------------
  // Material tuning for this lighting (hemisphere + one sun, no environment map): the glTF files ship metalness 0.4
  // and a very dark Armor colour, which reads as black without an env map. Metal needs light to bounce off, so keep
  // the diffuse term alive (low metalness) and the specular broad (higher roughness).
  const MAX_METALNESS = 0.3;
  const MIN_ROUGHNESS = 0.5;
  // Per-material overrides by glTF material name. Colours are linear (multiplied by `tint`, floored at `lift`);
  // metalness / roughness replace the generic clamp above.
  const MATERIAL_TWEAKS = {
    Armor: { lift: 0.09, tint: [0.92, 1.0, 1.14], metalness: 0.35, roughness: 0.45 },   // dark cool steel with a visible sun glint
  };
  // Per-asset linear colour gain (the grass material is almost black next to the lit ground).
  const ASSET_GAIN = { grass: 1.7, grass_2: 1.7 };
  const DOUBLE_SIDED_ASSETS = { grass: 1, grass_2: 1 };   // single-sided blade cards

  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn('[Assets] ' + msg);
  }

  function dataURIToArrayBuffer(uri) {
    const b64 = uri.slice(uri.indexOf(',') + 1);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  function tuneMaterial(mat, assetName) {
    if (!mat || !mat.isMaterial) return;
    if (mat.metalness !== undefined) mat.metalness = Math.min(mat.metalness, MAX_METALNESS);
    if (mat.roughness !== undefined) mat.roughness = Math.max(mat.roughness, MIN_ROUGHNESS);
    const tw = MATERIAL_TWEAKS[mat.name];
    if (tw && mat.color) {
      const lift = tw.lift, t = tw.tint;
      mat.color.setRGB(Math.max(mat.color.r, lift) * t[0], Math.max(mat.color.g, lift) * t[1], Math.max(mat.color.b, lift) * t[2]);
      if (tw.metalness !== undefined) mat.metalness = Math.min(tw.metalness, 0.4);
      if (tw.roughness !== undefined) mat.roughness = Math.max(tw.roughness, 0.45);
    }
    const gain = ASSET_GAIN[assetName];
    if (gain && mat.color) mat.color.multiplyScalar(gain);
    if (DOUBLE_SIDED_ASSETS[assetName]) mat.side = THREE.DoubleSide;
  }

  function prepare(name, gltf) {
    const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!scene) throw new Error('glTF has no scene');
    let skinned = false;
    scene.traverse(function (o) {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // Bind-pose bounds are wrong once a skeleton animates: never cull skinned meshes. Static meshes keep culling.
      o.frustumCulled = !o.isSkinnedMesh;
      if (o.isSkinnedMesh) skinned = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) tuneMaterial(mats[i], name);
    });

    // clips: strip the "HumanArmature|" style prefix once, on the cached clips we own
    const animations = (gltf.animations || []).map(function (c) {
      const i = c.name.lastIndexOf('|');
      if (i >= 0) c.name = c.name.slice(i + 1);
      return c;
    });

    // native bind-pose bounding box (scene root is at identity, so this is also the clone's box)
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    if (!isFinite(box.min.x)) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    store[name] = { scene: scene, animations: animations, box: box, size: size, center: center, skinned: skinned };
  }

  function parseOne(name) {
    return new Promise(function (resolve) {
      const uri = window.ASSETS && window.ASSETS[name];
      if (!uri) { failed.push(name); console.error('[Assets] no data for asset "' + name + '"'); resolve(); return; }
      let ab;
      try { ab = dataURIToArrayBuffer(uri); } catch (e) { failed.push(name); console.error('[Assets] bad base64 for "' + name + '"', e); resolve(); return; }
      try {
        new THREE.GLTFLoader().parse(ab, '', function (gltf) {
          try { prepare(name, gltf); } catch (e) { failed.push(name); console.error('[Assets] failed to prepare "' + name + '"', e); }
          resolve();
        }, function (err) {
          failed.push(name); console.error('[Assets] GLTFLoader failed on "' + name + '"', err); resolve();
        });
      } catch (e) {
        failed.push(name); console.error('[Assets] GLTFLoader threw on "' + name + '"', e); resolve();
      }
    });
  }

  function load() {
    if (loadPromise) return loadPromise;
    if (!THREE.GLTFLoader || !THREE.SkeletonUtils) {
      loadPromise = Promise.reject(new Error('GLTFLoader / SkeletonUtils not loaded (check the CDN script tags)'));
      return loadPromise;
    }
    const names = Object.keys(window.ASSETS || {});
    loadPromise = Promise.all(names.map(parseOne)).then(function () {
      loaded = true;
      if (failed.length) console.error('[Assets] failed assets: ' + failed.join(', '));
    });
    return loadPromise;
  }

  // ---- instances ------------------------------------------------------------------------------------------------
  function cloneMaterialsOf(root) {
    const map = new Map();
    root.traverse(function (o) {
      if (!o.isMesh) return;
      const dup = function (m) {
        if (!map.has(m)) map.set(m, m.clone());
        return map.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(dup) : dup(o.material);
    });
  }

  function get(name, opts) {
    const entry = store[name];
    if (!entry) {
      if (!loaded) warnOnce('early:' + name, 'Assets.get("' + name + '") called before Assets.load() resolved');
      else warnOnce('missing:' + name, 'missing asset "' + name + '"');
      return null;
    }
    opts = opts || {};
    const model = THREE.SkeletonUtils.clone(entry.scene);
    if (opts.cloneMaterials) cloneMaterialsOf(model);

    const wrapper = new THREE.Group();
    wrapper.name = 'asset:' + name;
    wrapper.userData.asset = name;
    wrapper.add(model);
    if (opts.raw) return wrapper;

    // bottom-centre of the bind-pose box at the wrapper origin; normalisation lives on wrapper.scale
    model.position.set(-entry.center.x, -entry.box.min.y, -entry.center.z);
    let s = 1;
    if (opts.length > 0) {
      const ext = Math.max(entry.size.x, entry.size.z);
      if (ext > 1e-6) s = opts.length / ext;
    } else {
      const h = opts.height > 0 ? opts.height : 1.8;
      if (entry.size.y > 1e-6) s = h / entry.size.y;
    }
    wrapper.scale.setScalar(s);
    return wrapper;
  }

  function clips(name) {
    const entry = store[name];
    return entry ? entry.animations.slice() : [];
  }

  function clip(name, clipName) {
    const entry = store[name];
    if (!entry) return null;
    for (let i = 0; i < entry.animations.length; i++) if (entry.animations[i].name === clipName) return entry.animations[i];
    return null;
  }

  // ---- bone lookup by original glTF name ('Palm.R' is sanitised to 'PalmR' by GLTFLoader) -----------------------------
  function bone(root, name) {
    if (!root) return null;
    const plain = THREE.PropertyBinding.sanitizeNodeName(name);
    let found = null;
    root.traverse(function (o) {
      if (found) return;
      if (o.name === name || o.name === plain || (o.userData && o.userData.name === name)) found = o;
    });
    return found;
  }

  function bones(root) {
    const out = {};
    if (!root) return out;
    root.traverse(function (o) {
      if (o.isBone) out[(o.userData && o.userData.name) || o.name] = o;
    });
    return out;
  }

  function size(name) {
    const e = store[name];
    return e ? e.size.clone() : null;
  }

  return {
    srgbOutput: true,
    load: load,
    get: get,
    instance: get,      // legacy aliases
    parseGLB: get,
    clips: clips,
    clip: clip,
    bone: bone,
    bones: bones,
    size: size,
    has: function (name) { return !!store[name]; },
    names: function () { return Object.keys(store); },
    isLoaded: function () { return loaded; },
    failed: failed
  };
})();
