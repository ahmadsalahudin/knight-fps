"""Apply reviewed deepseek-panel patches with exact-match verification + backup."""
import json, shutil

r = json.load(open('panel_report.json', encoding='utf-8'))
src_path = 'knights_out_final.html'
shutil.copyfile(src_path, 'knights_out_final.backup.html')
s = open(src_path, encoding='utf-8').read()

ok, miss = 0, []
for agent in r:
    for i, blk in enumerate(agent.get('patched_blocks', []) if isinstance(agent, dict) else []):
        find, rep = blk['find'], blk['replace']
        if find in s:
            s = s.replace(find, rep, 1)
            ok += 1
            print(f"[applied] {agent.get('agent', '?')}#{i+1}")
        else:
            miss.append(f"{agent.get('agent', '?')}#{i+1}: {find[:70]!r}")

print(f'\napplied={ok} missed={len(miss)}')
for m in miss: print('MISS:', m)
open(src_path, 'w', encoding='utf-8').write(s)
print('saved', round(len(s)/1024), 'KB (backup: knights_out_final.backup.html)')