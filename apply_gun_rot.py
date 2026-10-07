# patch knights_out_final.html gun rig euler to the vision-verified best: (+90deg, +90deg, 0)
import re

p = 'knights_out_final.html'
s = open(p, encoding='utf-8').read()

old = "gunRig.rotation.set(-Math.PI / 2, 0, 0);"
new = "gunRig.rotation.set(Math.PI / 2, Math.PI / 2, 0);  // vision-verified: barrel->screen center"
assert old in s, 'original rotation line not found'
s = s.replace(old, new, 1)

# recoil rotation.x offset should be relative to new base (+PI/2): kick additive small
old2 = "this.gunRig.rotation.x = -Math.PI / 2 + 0.25;"
if old2 in s:
    s = s.replace(old2, "this.gunRig.rotation.x = Math.PI / 2 + 0.18;", 1)
open(p, 'w', encoding='utf-8').write(s)
print('patched gun rig orientation')
