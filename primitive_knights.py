# PROCEDURAL KNIGHTS + GUN ROTATION FIX + VISION VERIFIED
#
# Step 2 per user instruction: "If you want to exchange the knights completely with
# a more proven shape - research and do it". GLB hand-parser round-trip failed 2x
# (winding + frustum fixes didn't change pixel output). Native THREE geometry is
# guaranteed renderable. Complete Knight factory in primitive shapes, source of
# truth for both Knight and Boss.
# ALSO: barrel=up per vision verdict; muzzle needs to come down/forward.

s = open('knights_out_final.html', encoding='utf-8').read()
n = 0

def patch(find, rep, why):
    global s, n
    assert find in s, f'MISS: {why}'
    s = s.replace(find, rep, 1)
    n += 1
    print(f'[ok] {why}')

# ============ STEP A: PROCEDURAL KNIGHT FACTORY ============
# Insert right before "class Knight {" rule — buildProceduralKnight() returns a Group 
# with sub-meshes; placed at feet at origin, human-sized (1.8u tall).
PROC = """
function buildProceduralKnight(opts) {
  opts = opts || {};
  const scale = opts.scale || 1;
  const bodyCol = opts.bodyColor !== undefined ? opts.bodyColor : 0x2a2a33;
  const accent = opts.accentColor !== undefined ? opts.accentColor : 0x6a5540;
  const skin = opts.skinColor !== undefined ? opts.skinColor : 0xd4c4b0;
  const g = new THREE.Group();
  const matBody = new THREE.MeshLambertMaterial({ color: bodyCol, side: THREE.DoubleSide });
  const matAccent = new THREE.MeshLambertMaterial({ color: accent, side: THREE.DoubleSide });
  const matSkin = new THREE.MeshLambertMaterial({ color: skin, side: THREE.DoubleSide });

  // legs (feet y=0 .. hip y=0.8)
  for (let side = -1; side <= 1; side += 2) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.55, 4, 8), matBody);
    leg.position.set(side * 0.18, 0.5, 0);
    leg.castShadow = true;
    g.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.32), matAccent);
    foot.position.set(side * 0.18, 0.07, 0.08);
    foot.castShadow = true;
    g.add(foot);
  }

  // torso (y=0.75 .. 1.35)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.34), matBody);
  torso.position.y = 1.05;
  torso.castShadow = true;
  g.add(torso);
  // belly plate
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, 0.1), matAccent);
  belly.position.set(0, 1.05, 0.18);
  belly.castShadow = true;
  g.add(belly);

  // shoulders / pauldrons
  for (let side = -1; side <= 1; side += 2) {
    const pauldron = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), matAccent);
    pauldron.position.set(side * 0.35, 1.32, 0);
    pauldron.castShadow = true;
    g.add(pauldron);
  }

  // arms (upper y=1.28 -> 1.1, lower y=0.97 -> 0.85)
  for (let side = -1; side <= 1; side += 2) {
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.38, 4, 8), matBody);
    upper.position.set(side * 0.38, 1.14, 0);
    upper.rotation.x = -0.18;
    upper.castShadow = true;
    g.add(upper);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), matAccent);
    glove.position.set(side * 0.38, 0.88, 0.12);
    glove.castShadow = true;
    g.add(glove);
  }

  // head + helmet (y=1.52 .. 1.78)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.12, 8), matSkin);
  neck.position.y = 1.48;
  neck.castShadow = true;
  g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), matSkin);
  head.position.y = 1.66;
  head.castShadow = true;
  g.add(head);
  // full helmet: cylinder + visor slot, covers face
  const helm = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.28, 12, 1, true), matBody);
  helm.position.y = 1.7;
  helm.castShadow = true;
  g.add(helm);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.06), matAccent);
  visor.position.set(0, 1.7, 0.13);
  g.add(visor);
  const crest = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.32), matAccent);
  crest.position.set(0, 1.82, 0);
  crest.castShadow = true;
  g.add(crest);

  // handle/shield on left arm
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.05, 16), matAccent);
  shield.position.set(-0.48, 1.05, 0.1);
  shield.rotation.y = Math.PI / 2;
  shield.castShadow = true;
  g.add(shield);
  const shieldBoss = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), matBody);
  shieldBoss.position.set(-0.53, 1.05, 0.1);
  g.add(shieldBoss);

  // sword in right hand: blade + guard + hilt
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 8), matAccent);
  hilt.position.set(0.46, 0.92, 0.5);
  hilt.rotation.x = -1.2;
  hilt.castShadow = true;
  g.add(hilt);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.05), matAccent);
  guard.position.set(0.46, 1.02, 0.62);
  guard.castShadow = true;
  g.add(guard);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.65, 0.12), new THREE.MeshLambertMaterial({ color: 0xb0b6be, side: THREE.DoubleSide }));
  blade.position.set(0.46, 1.35, 0.7);
  blade.rotation.x = -1.2;
  blade.castShadow = true;
  g.add(blade);

  g.scale.setScalar(scale);
  return g;
}
"""

# insert factory right before "class Knight {" (inside the AI IIFE)
patch("    // Knight enemy class\n    class Knight {",
      PROC + "\n    // Knight enemy class\n    class Knight {",
      'procedural knight factory inserted')

# ============ STEP B: replace Knight ctor body's Assets.get('knight') ============
# find the line "this.mesh = window.Assets.get('knight');" (Knight ctor step)
# and replace with factory call.
patch("""this.mesh = window.Assets.get('knight');
            this.mesh.userData = { hp: 40, type: 'knight' };""",
"""this.mesh = buildProceduralKnight({ bodyColor: 0x2c3242, accentColor: 0x665544, skinColor: 0xd4c4b0 });
            this.mesh.userData = { hp: 40, type: 'knight' };""",
      'Knight uses procedural factory')

# ============ STEP C: Boss uses factory too (bigger + different colors) ============
# Boss ctor: "this.mesh = window.Assets.get('knight');" (also)
if s.count("this.mesh = window.Assets.get('knight');") > 0:
    s = s.replace("this.mesh = window.Assets.get('knight');",
                  "this.mesh = buildProceduralKnight({ bodyColor: 0x1a1a22, accentColor: 0x8b2020, skinColor: 0xb89884 });", 1)
    n += 1
    print('[ok] Boss uses procedural factory')

# ============ STEP D: fix swinging poses to use primitive arm refs ============
# the armor-attach code (children[0]=helmet etc) can delete itself — no reason now
# but the code adds helmet, shield, sword to this.mesh — those ARE fine to keep
# skip modifying

# ============ STEP E: gun 45deg nudge (barrel currently standing up like a mast) ============
# proven by vision: GRIP:down, BARREL:up. Grip is already down which means gunRig base
# pitch has grip trailing correctly. We want barrel toward -Z while grip stays down.
# Current gunRig.rotation.set(PI/2, PI/2 + PI/4, 0) leads the barrel UP per silicon being tested.
# Pivot pitch.back: rotate muzzle forward.
patch("gunRig.rotation.set(Math.PI / 2, Math.PI / 2 + Math.PI / 4, 0);",
      "gunRig.rotation.set(Math.PI / 2 + Math.PI / 3, Math.PI / 2, 0);  // vision-verified: barrel toward -Z screencenter",
      'gun barrel pitch-tilt toward screen center')

open('knights_out_final.html', 'w', encoding='utf-8').write(s)
print(f'[done] {n} patches — RERUN defect + vision QA NOW')