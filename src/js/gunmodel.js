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

   This file is the BASELINE (plain shapes); it exists so the contract is exercised. */
(function () {
  'use strict';
  const V3 = THREE.Vector3;

  function build(ctx) {
    const col = ctx.col;
    const steel = new THREE.MeshPhongMaterial({ color: col(0x2c3036), specular: col(0x50575f), shininess: 40 });
    const bright = new THREE.MeshPhongMaterial({ color: col(0x9aa0a8), specular: col(0xffffff), shininess: 70 });
    const wood = new THREE.MeshPhongMaterial({ color: col(0x4a2a16), specular: col(0x2a1a10), shininess: 24 });
    const mesh = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; return m; };
    const root = new THREE.Group();
    root.name = 'gunModel';

    // barrel (octagonal) and frame
    const barrel = mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.16, 8), steel);
    barrel.rotation.x = Math.PI / 2; barrel.rotation.y = Math.PI / 8; barrel.position.set(0, 0.044, -0.182);
    root.add(barrel);
    const frame = mesh(new THREE.BoxGeometry(0.025, 0.05, 0.085), bright);
    frame.position.set(0, 0.02, -0.068);
    root.add(frame);

    // cylinder: hinge below-left of the centre, spin at the centre
    const C = new V3(0, 0.022, -0.078), R = 0.023;
    const swing = new THREE.Group(); swing.position.set(C.x - 0.1 * R, C.y - 1.02 * R, C.z); root.add(swing);
    const spin = new THREE.Group(); spin.position.set(0.1 * R, 1.02 * R, 0); swing.add(spin);
    const cyl = mesh(new THREE.CylinderGeometry(R, R, 0.048, 24), bright);
    cyl.rotation.x = Math.PI / 2; spin.add(cyl);

    // hammer: hinge at the rear of the frame, spur up and back (cocked)
    const pivot = new THREE.Group(); pivot.position.set(0, 0.027, -0.034); root.add(pivot);
    const spur = mesh(new THREE.BoxGeometry(0.008, 0.035, 0.01), bright);
    spur.position.set(0, 0.018, 0.008); spur.rotation.x = 0.4; pivot.add(spur);

    // trigger + guard
    const trig = mesh(new THREE.BoxGeometry(0.004, 0.018, 0.004), bright);
    trig.position.set(-0.002, -0.015, -0.062); root.add(trig);
    const guard = mesh(new THREE.TorusGeometry(0.016, 0.002, 8, 24), bright);
    guard.rotation.y = Math.PI / 2; guard.position.set(0, -0.018, -0.058); root.add(guard);

    // grip (raked)
    const grip = mesh(new THREE.BoxGeometry(0.024, 0.095, 0.037), wood);
    grip.position.set(0, -0.026, -0.001); grip.rotation.x = -0.39; root.add(grip);

    return {
      root: root,
      muzzle: new V3(0, 0.044, -0.262),
      cyl: { swing: swing, spin: spin, axisLocal: new V3(0, 0, 1), swingSign: 1, center: C.clone(), radius: R },
      hammer: { pivot: pivot, axisLocal: new V3(1, 0, 0), dirSign: 1, center: pivot.position.clone() },
      grip: new THREE.Box3(new V3(-0.012, -0.072, -0.035), new V3(0.012, 0.020, 0.035)),
      gripTopZ: -0.017, gripBotZ: 0.015,
    };
  }

  window.GunModel = { build: build };
})();
