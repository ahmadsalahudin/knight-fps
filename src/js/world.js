/* world.js — window.World (B1)
   World.build(scene)      ground + scattered grass / birch trees / rocks + boundary ring of rocks
   World.colliders         [{x, z, r}]   circles for movement collision (trees, rocks)
   World.staticTargets     Object3D[]    ground + trees + rocks (+ boundary rocks) for bullet-impact raycasts
                                         (use raycaster.intersectObjects(World.staticTargets, true); grass is excluded)
   Needs Assets.load() to have resolved (main.js awaits it before World.build). */
window.World = (function () {
  const colliders = [];
  const staticTargets = [];

  // Prop heights in world units. They reproduce the sizes the game always had (the old code scaled the native glTF
  // size by 1.4 / 1.2 / 2.2 / 1.0); native heights: grass 1.01, grass_2 1.20, birch 3.57, rock 0.88.
  const HEIGHT = { grass: 1.4, grass_2: 1.45, birch_tree: 7.9, rock: 0.9 };

  function scatter(scene, name, count, areaHalf, opts) {
    opts = opts || {};
    const tpl = window.Assets.get(name, { height: opts.height || HEIGHT[name] || 1 });
    if (!tpl) return;
    const baseScale = tpl.scale.x;
    for (let i = 0; i < count; i++) {
      const m = tpl.clone(true);
      const x = (Math.random() * 2 - 1) * areaHalf;
      const z = (Math.random() * 2 - 1) * areaHalf;
      m.position.set(x, 0, z);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.scale.setScalar(baseScale * (opts.variance ? (0.7 + Math.random() * 0.6) : 1));
      if (opts.noShadow) m.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      scene.add(m);
      if (opts.collidable) colliders.push({ x: x, z: z, r: opts.radius || 1 });
      if (opts.target) staticTargets.push(m);
    }
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

    scatter(scene, 'grass', 90, 45, { noShadow: true, variance: true });
    scatter(scene, 'grass_2', 60, 45, { noShadow: true, variance: true });
    scatter(scene, 'birch_tree', 10, 55, { collidable: true, radius: 1.2, target: true });
    scatter(scene, 'rock', 12, 40, { collidable: true, radius: 1.0, variance: true, target: true });

    // boundary ring of rocks so play area feels closed
    const ringRock = window.Assets.get('rock', { height: HEIGHT.rock });
    if (ringRock) {
      const baseScale = ringRock.scale.x;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const m = ringRock.clone(true);
        m.position.set(Math.cos(a) * 52, 0, Math.sin(a) * 52);
        m.scale.setScalar(baseScale * (2.5 + Math.random()));
        m.rotation.y = Math.random() * Math.PI;
        scene.add(m);
        colliders.push({ x: m.position.x, z: m.position.z, r: 2.4 });
        staticTargets.push(m);
      }
    }
    return colliders;
  }

  return { build: build, colliders: colliders, staticTargets: staticTargets };
})();
