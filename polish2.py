# final polish patches for knights_out_final.html — applied after previous fixes
import re

p = 'knights_out_final.html'
s = open(p, encoding='utf-8').read()
n = 0

def patch(find, rep, why):
    global s, n
    assert find in s, f'MISS: {why}'
    s = s.replace(find, rep, 1)
    n += 1
    print(f'[ok] {why}')

# --- 1) gun: 45 degrees up-tilt correction (user: points down; barrel must sit at screen center)
patch("gunRig.rotation.set(Math.PI / 2, Math.PI / 2, 0);",
      "gunRig.rotation.set(Math.PI / 2, Math.PI / 2 + Math.PI / 4, 0);",
      'gun muzzle +45deg yaw toward center')

# --- 2) knight size: 6-unit export -> human scale. find scale in Knight constructor & attach parts by bbox
patch("this.mesh.position.set(0, 0, 0);",
      "this.mesh.scale.setScalar(0.35);  // export is ~6u tall; 0.35 -> human-height knight\n"
      "            const _bb = new THREE.Box3().setFromObject(this.mesh);\n"
      "            this._height = _bb.max.y - _bb.min.y;\n"
      "            this._top = _bb.max.y;\n"
      "            this._mid = (_bb.max.y + _bb.min.y) / 2;",
      'knight human-scale + bbox measurements')

# helmet: attach at head level (top of bbox) not fixed 0.7
patch("""helmet.scale.set(0.8, 0.8, 0.8);
            helmet.position.set(0, 0.7, 0);
            this.mesh.add(helmet);""",
      """helmet.scale.set(0.35, 0.35, 0.35);
            helmet.position.set(0, this._top * 0.92, 0);
            this.mesh.add(helmet);""",
      'helnet rides at true head height')

# shield: mid-left, floating at hand height on the bbox, not near feet
patch("""shield.scale.set(0.7, 0.7, 0.7);
            shield.position.set(-0.6, 0.2, 0);
            shield.rotation.z = Math.PI / 2;
            this.mesh.add(shield);""",
      """shield.scale.set(0.35, 0.35, 0.35);
            shield.position.set(-this._top * 0.32, this._mid, 0);
            shield.rotation.z = Math.PI / 2;
            this.mesh.add(shield);""",
      'shield at left-hand/mid height')

# sword: right-hand height
patch("""sword.scale.set(0.6, 0.6, 0.6);
            sword.position.set(0.6, 0, 0);
            sword.rotation.z = -Math.PI / 2;
            this.mesh.add(sword);""",
      """sword.scale.set(0.35, 0.35, 0.35);
            sword.position.set(this._top * 0.32, this._mid, 0);
            sword.rotation.z = -Math.PI / 2;
            this.mesh.add(sword);""",
      'sword at right-hand height')

# --- 3) facing bug: lookAt aims model's -Z at player, but swing tests +Z -> never true.
# fix by testing the -Z direction (what lookAt actually points at the player)
patch("const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);",
      "const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);",
      'swing arc now matches lookAt facing (-Z)')

# boss has same facing bug (its own swing) - fix its copy too
s2 = s
patch("const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);",
      "const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);",
      'boss swing arc facing fixed') if "const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);" in s else None

# --- 4) walking bob: knights slide statically; add procedural walk motion (leg-ish tilt + bob)
patch("""// Shield animation during walk/strafe
            if (this.state === 'walking' || this.isStrafing) {""",
      """// procedural walk cycle: bob + slight roll so movement reads as marching
            const t = performance.now() / 1000;
            this.mesh.position.y = Math.abs(Math.sin(t * 6 + this._phase0 || 0)) * 0.06;
            this.mesh.rotation.z = Math.sin(t * 6) * 0.05;
            // Shield animation during walk/strafe
            if (this.state === 'walking' || this.isStrafing) {""",
      'walk bob+roll so knights march visibly')

# init phase offset once
patch("this.shieldUp = true;",
      "this.shieldUp = true;\n            this._phase0 = Math.random() * 6.28;",
      'per-knight walk phase')

open(p, 'w', encoding='utf-8').write(s)
print(f'[done] {n} patches applied')
