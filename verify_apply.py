"""Verify panel patches against CURRENT code, then apply the verified set.
Prefers panel_A/B/C.json; falls back to panel_swing/fire/dom.json (run-1 free output).
NEVER applies a find that is not an exact unique substring — reports MISS instead.
"""
import json, shutil, os

s = open('knights_out_final.html', encoding='utf-8').read()
shutil.copyfile('knights_out_final.html', 'knights_out_final.pre_fix.html')

SOURCES = {
    'B': ['panel_B.json', 'panel_fire.json'],   # FIRST: its Player patch is a superset (fire+position+Sfx.hurt)
    'A': ['panel_A.json', 'panel_swing.json'],   # A#5 (Player.hurt Sfx) will MISS after B lands — intended
    'C': ['panel_C.json', 'panel_dom.json'],
}

def load_first(paths):
    for p in paths:
        if os.path.exists(p):
            obj = json.load(open(p, encoding='utf-8'))
            if obj.get('patched_blocks'):
                return p, obj
    return None, {}

report = []
for tag, paths in SOURCES.items():
    src, obj = load_first(paths)
    if not src:
        report.append((tag, 'NO-SOURCE', 0, 0)); continue
    ok = miss = dup = 0
    applied = []
    for i, blk in enumerate(obj['patched_blocks'], 1):
        find, rep = blk['find'], blk['replace']
        cnt = s.count(find)
        if cnt == 1:
            s = s.replace(find, rep, 1)
            ok += 1
            applied.append(i)
        elif cnt == 0:
            miss += 1
            print(f'[{tag}#{i}] MISS (not in code) find-head: {find[:70]!r}')
        else:
            dup += 1
            print(f'[{tag}#{i}] AMBIGUOUS x{cnt} find-head: {find[:70]!r}')
    report.append((tag, src, ok, miss + dup))
    print(f'[{tag}] source={src} applied={ok} rejected={miss + dup}')

open('knights_out_final.html', 'w', encoding='utf-8').write(s)
print('\nBACKUP: knights_out_final.pre_fix.html')
print('SUMMARY:', report)
