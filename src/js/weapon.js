/* weapon.js — window.Weapon: revolver viewmodel.
   First-pass extraction of the gun code that used to live inside Game.init / Game.tryFire / Game.update.
   Behavior is unchanged: the gun is still a child of the main camera and renders in the main scene
   (so it still clips into the world). B2 replaces this with the real viewmodel (own scene/camera/hands).
   Public API (per docs/FIX_PLAN.md): init(camera, renderer), fire(), reload(ms), update(dt, state),
   render(renderer), muzzleWorldPosition(target). */
(function () {
  const GUN_BASE_X = Math.PI / 2; // USER-VISUAL-adjusted
  const GUN_BASE_Y = 0; // USER-VISUAL-adjusted
  const GUN_BASE_Z = 0; // USER-VISUAL-adjusted

  const Weapon = {
    gunRig: null,
    gun: null,

    init: function (camera, renderer) {
      // revolver viewmodel: rotate GLB so barrel faces away from camera (-Z), hold lower-right
      const gun = window.Assets.get('revolver');
      if (gun) {
        gun.traverse(o => { if (o.isMesh) { o.castShadow = false; } });
        const gunRig = new THREE.Group();
        gunRig.add(gun);
        // Quaternius FBX glbs export facing +X; rotate so barrel points -Z (away from camera)
        gun.rotation.set(0, 0, 0);
        gun.scale.setScalar(0.22);
        gunRig.position.set(0.5, -0.4, -0.35);
        gunRig.rotation.set(GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z);
        camera.add(gunRig);
        this.gunRig = gunRig;
        this.gun = gun;
      }
    },

    fire: function () {
      if (this.gunRig) {
        this.gunRig.position.z = -0.38;               // recoil kick toward camera
        this.gunRig.rotation.x = GUN_BASE_X + 0.28;  // kick upward pitch away from base
      }
    },

    // The original had no separate reload-start hook: the flourish is driven by update({reloading:true}).
    reload: function (ms) {},

    // state: { reloading, moving, sprinting, aimDelta } (only `reloading` is used by this first pass)
    update: function (dt, state) {
      if (!this.gunRig) return;
      if (state && state.reloading) {
        this.gunRig.rotation.x = GUN_BASE_X + Math.sin(performance.now() / 120) * 0.35; // cylinder flourish around base
        this.gunRig.position.y = -0.34;
        return;
      }
      // recoil recovery + idle sway
      this.gunRig.position.z += (-0.55 - this.gunRig.position.z) * Math.min(1, dt * 10);
      this.gunRig.rotation.x += (GUN_BASE_X - this.gunRig.rotation.x) * Math.min(1, dt * 10);
      this.gunRig.position.y += (-0.26 - this.gunRig.position.y) * Math.min(1, dt * 10);
    },

    // The viewmodel lives in the main scene in this version, so there is nothing extra to render.
    render: function (renderer) {},

    muzzleWorldPosition: function (target) {
      target = target || new THREE.Vector3();
      if (this.gunRig) this.gunRig.getWorldPosition(target);
      return target;
    }
  };

  window.Weapon = Weapon;
})();
