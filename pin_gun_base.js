/**
 * FIX: animate gunRig on TOP of a frozen euler base instead of overwriting it.
 * Base = user-confirmed pose: gunRig.rotation = (Math.PI/2, Math.PI/2, 0).
 * Recoil kick, reload flourish, and idle recoily are DELTAS that decay back to base.
 */
const fs = require('fs');
const p = 'C:\\Users\\i\\Documents\\Default Project\\mcq-game\\knights_out_final.html';
let s = fs.readFileSync(p, 'utf8');
let n = 0;

function patch(find, rep, why) {
  if (!s.includes(find)) { console.log('MISS:', why); return; }
  s = s.replace(find, rep, 1);
  n++;
  console.log('OK:', why);
}

// BASE euler must be referenceable everywhere: hoist as module-level constant near gunRig construction
patch(
  `gunRig.rotation.set(Math.PI / 2, Math.PI / 2, 0);   // USER-VERIFIED FPS pose via gunsearch_90_90_0.png`,
  `const GUN_BASE_X = Math.PI / 2, GUN_BASE_Y = Math.PI / 2, GUN_BASE_Z = 0;  // USER-VERIFIED via gunsearch_90_90_0.png
      gunRig.rotation.set(GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z);
      window.__GUN_BASE = [GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z];`,
  'hoist frozen base euler as constant'
);

// 1) RECOIL: rotated BASE + kick amount (not absolute 0.25)
patch(
  `this.gunRig.rotation.x = 0.25;`,
  `this.gunRig.rotation.x = GUN_BASE_X + 0.28;  // kick upward pitch away from base`,
  'recoil-kick relative to base'
);

// 2) RELOAD FLOURISH: oscillate as delta about base; hardcode-free duration
patch(
  `this.gunRig.rotation.x = Math.sin(performance.now() / 120) * 0.5; // cylinder-out flourish
        this.gunRig.position.y = -0.34;`,
  `this.gunRig.rotation.x = GUN_BASE_X + Math.sin(performance.now() / 120) * 0.35; // cylinder flourish around base
        this.gunRig.position.y = -0.26 - 0.08;  // dips without entirely repositioning`,
  'reload-flourish centered on base'
);

// 3) RECOVERY: chase base (PI/2), not zero
patch(
  `this.gunRig.rotation.x += (0 - this.gunRig.rotation.x) * Math.min(1, dt * 10);`,
  `this.gunRig.rotation.x += (GUN_BASE_X - this.gunRig.rotation.x) * Math.min(1, dt * 10);`,
  'recovery returns to GUN_BASE, not zero'
);

fs.writeFileSync(p, s);
console.log('\n[' + n + ' patches applied]  BASE = (' + (Math.PI/2).toFixed(2) + ', ' + (Math.PI/2).toFixed(2) + ', 0) — verified via EULER_B_90_90_0.png photo.');