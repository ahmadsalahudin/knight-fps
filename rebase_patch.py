# rebase patch v2: align with the actual file text
s = open('knights_out_final.html', encoding='utf-8').read()
n = 0

def patch(find, rep, why, count=1):
    global s, n
    assert find in s, f'MISS: {why}'
    s = s.replace(find, rep, count)
    n += count
    print(f'[ok] {why}')

# already applied: Assets.parse rebase (patch 1 succeeded before the assert killed the run)
# 2) drop the manual knight scale (line 641), compute heights
patch("""this.mesh.scale.setScalar(0.35);
            const _bb = new THREE.Box3().setFromObject(this.mesh);
            this._top = _bb.max.y; this._mid = (_bb.max.y + _bb.min.y) / 2;""",
"""const _bb = new THREE.Box3().setFromObject(this.mesh);
            this._top = _bb.max.y; this._mid = (_bb.max.y + _bb.min.y) / 2;""",
    'Knight uses rebased 1.8u height (no manual scale)')

# 3) armor part scales normalized relative to 1.8 body
patch("helmet.scale.set(0.35, 0.35, 0.35);", "helmet.scale.set(0.9, 0.9, 0.9);", 'helmet 0.9')
patch("shield.scale.set(0.35, 0.35, 0.35);", "shield.scale.set(0.8, 0.8, 0.8);", 'shield 0.8')
patch("sword.scale.set(0.35, 0.35, 0.35);", "sword.scale.set(0.8, 0.8, 0.8);", 'sword 0.8')

# 4) boss scale rationalized
patch("this.mesh.scale.set(3.5, 3.5, 3.5);", "this.mesh.scale.set(2.2, 2.2, 2.2);", 'boss scale 2.2x')

open('knights_out_final.html', 'w', encoding='utf-8').write(s)
print(f'[done] {n} patches')
