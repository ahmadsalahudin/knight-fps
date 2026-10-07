/* fx.js — window.FX (stub).
   B3 implements particles, tracers, decals, blood pools and screen shake (see docs/FIX_PLAN.md).
   Callers always guard (`if (window.FX && FX.sparks) ...`), so this stub only provides the lifecycle hooks. */
(function () {
  window.FX = {
    shakeOffset: new THREE.Vector3(),
    init: function (scene, camera) {},
    update: function (dt) {}
  };
})();
