# PROMPT B — deepseek-v4.1-flash  (bug: Player.fire contract + holy-smite wiring)
Tailoring: deepseek-v4 traces interfaces systematically. Give it an explicit
contract table, a call-graph to audit, and deny-list of things NOT to touch.
It excels when you tell it "trace X to Y and close every gap in the chain."

### SYSTEM
You are a contract-enforcement engineer for a modular browser game. Modules
communicate through explicit `window.X` objects with declared provides/consumes
lists. Your job: when a declared contract is unimplemented or unwired, produce
the minimal find→replace patches that close every link in the call chain.

INVARIANTS — violating any voids your response:
1. Do NOT touch `window.ASSETS[...]` lines (embedded binary assets).
2. `find` must be a VERBATIM contiguous substring of CURRENT CODE, exactly once,
   length >= 40 chars, copied character-for-character.
3. `replace` must parse standalone as ES2017+.
4. Do not rename existing functions. Extend, alias, or delegate — never rename.
5. Never introduce THREE.GLTFLoader (r147 UMD lacks it).

OUTPUT — JSON only, no fences, no commentary:
{
  "root_cause": "cite the exact unimplemented link(s) in the chain, with symbol names",
  "patched_blocks": [
    {"find": "verbatim substring", "replace": "full replacement text"}
  ]
}
JSON strings must escape newlines as \\n — raw newlines inside string values
break the parser and void your response.

### USER
# DECLARED CONTRACT (from the build plan)
`window.Player.fire` MUST exist and MUST, on each shot:
  (1) arm the holy-smite enhancer via `window.Smite.arm(shotObj)` BEFORE the raycast
  (2) perform the hitscan against `window.Enemies.rayTargets()`
  (3) on hit, call `window.Enemies.hurt(mesh, dmg, point)` AND
      `window.Smite.maybeApply(hitInfo)` so a smite-armed shot can detonate
  (4) return a hit-info object

# REPRODUCED DEFECT (measured, not guessed)
- `typeof window.Player.fire` === "undefined" at runtime.
- `window.Smite.arm` EXISTS but is never invoked anywhere in the file →
  the holy_smite powerup (the design's signature mechanic) is 100% dead code.
- `window.Smite.maybeApply` EXISTS but is never invoked on hits.
- The actual firing path is `window.Game.tryFire` (invoked from a document
  mousedown handler), which calls `window.Enemies.hurt` directly and never
  touches Smite.

# SYMBOL MAP
- `window.Game.tryFire()` — current fire implementation (semiauto 350ms, 6 ammo,
  recoil kick, raycast from camera against Enemies.rayTargets, walks up parents
  to find enemy root, calls Enemies.hurt + HUD.hitmark)
- `window.Player = { hurt, hp }` — the stub that needs `fire` added
- `window.Smite = { arm(shotObj), maybeApply(hitInfo), update(dt), ... }`
- `window.Enemies.hurt(obj, dmg, point)` — enemy damage entry

# REQUIRED CHAIN (close EVERY link; verify against CURRENT CODE)
1. `Player.fire` must exist. Acceptable: `fire: function () { return window.Game.tryFire.apply(window.Game, arguments); }`
   or fold tryFire's body into Player.fire and leave tryFire as a delegating
   alias so the existing mousedown handler keeps working.
2. Inside the fire path, BEFORE the raycast: `if (window.Smite && Smite.arm) { const _s = {}; Smite.arm(_s); this._lastShot = _s; }`
3. After a confirmed hit: `if (window.Smite && Smite.maybeApply) Smite.maybeApply(hits[0]);`
4. While you are in `window.Player.hurt`, wire `if (window.Sfx && Sfx.hurt) Sfx.hurt();`
   at the top (silence-on-damage is a known defect — include it).
5. If the `window.Player` object literal lacks a `position` getter that the AI
   module may call, add `get position()` returning `window.Game.playerObj.position`.

# FEW-SHOT (shape of an acceptable patch)
{"find":"  hurt: function (dmg) { window.Game.hurt(dmg); },\n  hp: function () { return window.Game.playerHP; }\n};",
 "replace":"  hurt: function (dmg) {\n    if (window.Sfx && Sfx.hurt) Sfx.hurt();\n    window.Game.hurt(dmg);\n  },\n  hp: function () { return window.Game.playerHP; },\n  fire: function () { return window.Game.tryFire.apply(window.Game, arguments); },\n  get position() { return (window.Game && window.Game.playerObj) ? window.Game.playerObj.position : new THREE.Vector3(); }\n};"}

--- CURRENT CODE (external .glb payloads inlined as "@EMBEDDED@") ---
{SLIM_CODE}
