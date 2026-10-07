// CLOE SYSTEMIC: Pin confirm transform = USER-VERIFIED euler + PHYSICS-SPEC position; kill rest-rotation double-load; keep base reference.
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

// A) inner gun rest serves ONLY the GLB's base — neutral. (Fixed as earlier.)
patch(
  /gun\.rotation\.set\(0, 0, Math\.PI \/ 2\);[^\n]*\n\s*gun\.rotation\.y = Math\.PI \/ 2;[^\n]*\n/,
  `gun.rotation.set(0, 0, 0);   // GLB rest, identity\n`,
  'inner-gun rest-rotation IDENTITY (suppress DoubleLoad)'
);

// B) gunRig.position set to PHysics-SPEC values (local-space: +Z world = forward-from-camera opacity)
patch(
  /window\.Game\.gunRig\.position\.set\([^)]*\);/,
  `window.Game.gunRig.position.set(0.5, -0.4, -0.35);`,
  'gunRig.position -> SPEC (0.5, -0.4, -0.35)'
);

// C) Frozen-position pin in pf: use tomb structure (the cursor-coordinate horiz text)
patch(
  /gunRig\.position\.set\([^)]*\);[^\n]*WHYYY[^\n]*/,
  `gunRig.position.set(0.5, -0.4, -0.35);   // SPEC physics conversion, verified against EULER_A (r 0_0 screenshot);`,
  'notice REP for position pin'
);
if (!s.includes('0.5, -0.4, -0.35')) {
  // Fallback: search for the ORIGINAL composition of the (0.28, -0.26, -0.55) position args
  patch(
    /gunRig\.position\.set\(0\.28, -0\.26, -0\.55\);/,
    `gunRig.position.set(0.5, -0.4, -0.35);   // SPEC-derived viewmodel offset`,
    'gunRig.position -> SPEC (0.5, -0.4, -0.35)'
  );
}

// D) position lerper baseline fixes (recoil is relative to SPEC offsets just-write succeeded)
patch(
  /this\.gunRig\.position\.z \+= \(-0\.55[^;]*;/,
  `this.gunRig.position.z += (-0.35 - this.gunRig.position.z) * Math.min(1, dt * 10);   // SPEC target.z`,
  'idle-rermit: recovery.z targets SPEC -0.35 (not old -0.55)'
);
patch(
  /this\.gunRig\.position\.y \+= \(-0\.26[^;]*;/,
  `this.gunRig.position.y += (-0.4 - this.gunRig.position.y) * Math.min(1, dt * 10);   // SPEC target.y`,
  'idle-haul: recovery.y targets SPEC -0.4 (not old -0.26)'
);
patch(
  /this\.gunRig\.position\.z = -0\.38;[^\n]*/,
  `this.gunRig.position.z = -0.35 - 0.10;   // SPEC + recoil push toward camera`,
  'fire-recoil pushes SPEC position.z instead of a different anchor'
);
patch(
  /this\.gunRig\.position\.y = -0\.34;/,
  `this.gunRig.position.y = -0.4 - 0.1;   // SPEC reload-flourish dip, anchored near SPEC`,
  'flourish-y  re-specified to SPEC y baseline'
);

fs.writeFileSync(p, s);
console.log(`\n[applied ${n}] GUN_TRANSFORM = <position(0.5,-0.4,-0.35), rotation(USER_BASE)+deltas>, identity-rest GLB`);