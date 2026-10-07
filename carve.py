"""Surgical kimi-k3 repair: carves GLB base64 OUT of the file, repairs code, stitches assets back in.
The 1.82MB of base64 never passes through the model — the model only repairs actual JS."""
import re, base64, os

src = open('knights_out.html', encoding='utf-8').read()

# 1) carve out the giant asset data URIs -> placeholders
asset_uris = {}
def repl(m):
    key = m.group(1)
    asset_uris[key] = m.group(2)
    return f'window.ASSETS["${key}"] = "@@ASSET:{key}@@";'
slim = re.sub(r'window\.ASSETS\["([^"]+)"\] = "(data:model/gltf-binary;base64,[^"]+)"', repl, src)
slim_kb = round(len(slim) / 1024)
print(f"[slim] {os.path.getsize('knights_out.html')//1024} KB -> {slim_kb} KB, {len(asset_uris)} assets carved")
open('knights_slim.html', 'w', encoding='utf-8').write(slim)
open('knights_assets_map.json', 'w').write(json.dumps(asset_uris) if (json := __import__('json')) else '')
