# polish3: facing +Z (three.js Object3D.lookAt points +Z at target for meshes), separation distance, degenerate-direction guard
import re

p = 'knights_out_final.html'
s = open(p, encoding='utf-8').read()
n = 0

def patch(find, rep, why):
    global s, n
    assert find in s, f'MISS: {why} -> {find[:70]}'
    s = s.replace(find, rep, 1)
    n += 1
    print(f'[ok] {why}')

# undo the -Z change: Object3D.lookAt (non-camera) points +Z AT target
s2 = s
while "const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);" in s:
    s = s.replace(
        "const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);",
        "const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);  // Object3D.lookAt points +Z at target", 1)
    n += 1
print(f'[ok] facing restored +Z ({n} sites)')

# degenerate-direction guard + proper dot in BOTH swing fns: rewrite the arc test block
old_arc = """const toPlayer = playerPos.clone().sub(this.mesh.position); toPlayer.y = 0;
            const dist = toPlayer.length();
            const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);  // Object3D.lookAt points +Z at target
            const cos = facing.dot(toPlayer.normalize());
            if (dist < 3.2 && cos > 0.2) {
                window.Player.hurt(15);
            }"""
new_arc = """const toPlayer = playerPos.clone().sub(this.mesh.position); toPlayer.y = 0;
            const dist = toPlayer.length();
            if (dist < 3.2) {
                const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
                if (dist > 0.2) {
                    const cos = facing.dot(toPlayer.clone().normalize());
                    if (cos > 0.2) { window.Player.hurt(15); return; }
                } else {
                    window.Player.hurt(15); return;  // overlapping: free hit
                }
            }"""
cnt = s.count(old_arc)
assert cnt >= 1, 'arc block not found'
s = s.replace(old_arc, new_arc)
n += cnt
print(f'[ok] arc test hardened ({cnt} swing fns)')

# separation: knights stop at 1.4u instead of walking inside the player
patch("""// Movement
            const moveDir = this.lookAt.clone().multiplyScalar(speed * dt);
            this.mesh.position.add(moveDir);""",
      """// Movement — maintain melee separation, never overlap the player
            const gap = this.mesh.position.distanceTo(playerPos);
            if (gap > 1.4) {
                const moveDir = this.lookAt.clone().multiplyScalar(Math.min(speed * dt, gap - 1.4));
                this.mesh.position.add(moveDir);
            }""",
      'knight stops at 1.4u separation')

open(p, 'w', encoding='utf-8').write(s)
print(f'[done] {n} total patches')
