# Diagnose the 'Unsafe attempt to load URL file://' warning: find any iframe/embed/fetch/XHR
import re

p = 'knights_out_final.html'
s = open(p, encoding='utf-8').read()

patterns = ['iframe', 'embed', 'window.open', 'XMLHttpRequest', 'fetch(', 'location.href', 'location.replace', 'import(', 'Worker(', 'link rel']
for pat in patterns:
    hits = [(m.start(), s[max(0,m.start()-60):m.start()+80].replace('\n', ' ')) for m in re.finditer(re.escape(pat), s)]
    if hits:
        print(f'== {pat} x{len(hits)}:')
        for pos, ctx in hits[:5]:
            print('   ...', ctx[:140])

# also: any <iframe>/<object> tags in html?
print('tag scan:', re.findall(r'<(iframe|object|embed)[^>]*>', s)[:5])
