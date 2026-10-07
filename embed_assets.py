import base64, json, os

out = ['window.ASSETS = {};']
sizes = {}
for f in sorted(os.listdir('assets')):
    if not f.endswith('.glb'):
        continue
    name = f[:-4]
    b64 = base64.b64encode(open('assets/' + f, 'rb').read()).decode()
    uri = 'data:model/gltf-binary;base64,' + b64
    out.append('window.ASSETS[' + json.dumps(name) + '] = ' + json.dumps(uri) + ';')
    sizes[name] = round(len(b64) / 1024.0, 1)
open('assets.js', 'w').write('\n'.join(out))
print(json.dumps(sizes, indent=1))
print('assets.js:', round(os.path.getsize('assets.js') / 1048576.0, 2), 'MB')
