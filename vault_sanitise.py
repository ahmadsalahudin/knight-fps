# Security: strip/hide the sovereigneg API key everywhere
# Committing it to a public GitHub repo would leak it permanently
import fileinput, glob, os, re
import subprocess, sys

KEY_PATTERN = re.compile(r'sk-REPLACE-ME-GET-YOUR-OWN-KEY')
FOLDERS = ['.
']

# previews & sinks (things not in git)
IGNORES = ['node_modules', 'block*.js', '.git', '*.backup.html', '*.pre_fix.html', 'sec_post.json']

def sanitise_file(path):
    try:
        with open(path, encoding='utf8') as f:
            s = f.read()
    except (UnicodeDecodeError, FileNotFoundError):
        return False
    if KEY_PATTERN.search(s):
        s2 = KEY_PATTERN.sub('sk-REPLACE_WITH_YOUR_OWN_KEY', s)
        with open(path, 'w', encoding='utf8') as f:
            f.write(s2)
        return True
    return False

count = 0
for root, _, _ in os.walk('.'):
    if any(os.path.basename(root) == g for g in IGNORES):
        continue
    for name in os.listdir(root):
        if name in ['package.json','package-lock.json']: continue
        # quick filter suspicious near-data sinks: skip block*.js like dir malvers unfolded
        if name.startswith('block') or name.endswith('.png') or name.endswith('.msi'): continue
        path = os.path.join(root, name)
        if os.path.isfile(path):
            if path.endswith(('.py','.js','.json','.html','.md','.yml','.toml')) or '.' not in name:
                if sanitise_file(path):
                    count += 1
                    print('[sanitised]', path)
print(f'--- done. {count} files cleaned