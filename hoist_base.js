// hoist _GUN_BASE to block scope so all three Game methods share it. Node string replace isolates block.
const fs = require('fs');
const p = 'C:\\Users\\i\\Documents\\Default Project\\mcq-game\\knights_out_final.html';
let s = fs.readFileSync(p, 'utf8');

// remove from init-scoped location
const declReg = /\n\s*const GUN_BASE_X = Math\.PI \/ 2, GUN_BASE_Y = Math\.PI \/ 2, GUN_BASE_Z = 0;[^\n]*\n\s*gunRig\.rotation\.set\(GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z\);\n\s*window\.__GUN_BASE = \[GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z\];/;
const NEWDECL = '\n      gunRig.rotation.set(GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z);';
if (declReg.test(s)) {
  s = s.replace(declReg, NEWDECL);
  console.log('removed init-scoped decl');
}
const NEW_DECL = `const GUN_BASE_X = Math.PI / 2;
const GUN_BASE_Y = Math.PI / 2;
const GUN_BASE_Z = 0;   // USER-VERIFIED via EULER_B_90_90_0.png
`;
// insert before "window.Game = { if possible (block top)
s = s.replace('window.Game = {', NEW_DECL + 'window.Game = {', 1);
fs.writeFileSync(p, s);
console.log('hoisted + kept body intact');