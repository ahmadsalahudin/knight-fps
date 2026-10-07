/* world.js — window.World (extracted verbatim) */
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
