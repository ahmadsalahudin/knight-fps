"""Full surgical repair loop:
1. carve assets -> slim file
2. kimi-k3 repairs slim code only
3. stitch real assets back -> knights_out_final.html
4. QA gate
"""
import re, json, os, urllib.request, time

BASE = "https://backend.sovereigneg.com/v1"
KEY = "sk-REPLACE-ME-GET-YOUR-OWN-KEY"

def chat_json(model, user, timeout=900, system=None):
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    data = json.dumps({"model": model, "messages": msgs}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=data,
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    raw = json.loads(urllib.request.urlopen(req, timeout=timeout).read())["choices"][0]["message"]["content"]
    try:
        return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except ValueError:
        return json.loads(raw[raw.index("["): raw.rindex("]") + 1])

# -- STEP 1: carve --
src = open('knights_out.html', encoding='utf-8').read()
asset_uris = {}
def repl(m):
    asset_uris[m.group(1)] = m.group(2)
    return f'window.ASSETS["@@{m.group(1)}@@"] = "@@ASSET_URI:{m.group(1)}@@";'
slim = re.sub(r'window\.ASSETS\["([^"]+)"\] = "(data:model/gltf-binary;base64,[^"]+)"', repl, src)
print(f"[carve] {len(src)//1024} KB -> {len(slim)//1024} KB, {len(asset_uris)} assets")

# -- STEP 2: kimi-k3 repair (slim file is ~40KB of real code) --
brief = """You are the senior browser-game repair engineer. This single-file three.js FPS 'Knights of the Meadow' has specific field-report defects. Repair surgically — change as little as possible.

FIELD REPORTS (real Chrome + Brave + Firefox):
1. Gun viewmodel points UP. It must be a classic FPS revolver hold: grip down toward bottom-right, barrel pointing forward (into the screen toward center). The gun group is `gunRig` child of camera. Fix using euler rotation on `gunRig` so the muzzle aims along camera -Z. The GLB inside has unknown rest orientation; assuming muzzle is its +Y, `gunRig.rotation.set(-Math.PI/2, 0, 0)` aligns +Y -> -Z. Verify logic and adjust if needed.
2. Enemies often do not spawn: waves start only on 'pointerlockchange'. In Brave/Firefox the lock is delayed or denied, so Waves.start never runs. Make waves start UNCONDITIONALLY at the START button click (do not gate on lock), keep pointer lock only as an enhancement.
3. Movement sometimes pins/sticks near spawn: the collider clamp can push against the input vector. Cancel penetration only; never add force opposite to movement; allow sliding; if still stuck after a frame inside 2+ colliders, nudge to nearest free position.
4. Double-check every section you leave untouched still gets wired by the bootstrap (loop calls Game.update, Enemies.update with playerPos, Waves.update; Waves.start(1) fires once).

CONSTRAINTS:
- Do NOT touch the window.ASSETS placeholder lines (they get re-hydrated externally).
- Do not introduce THREE.GLTFLoader (r147 UMD lacks it) — the window.Assets parser is complete and correct.
- Keep module structure and function signatures identical so the test harness stays valid.

Return JSON only: {"patch_summary": str, "patched_blocks": [{"find": "exact JS substring to locate", "replace": "full replacement text"}]}
Keep each find unique and short (a distinctive line), replace full corrected block."""

r = chat_json("kimi-k3", brief, timeout=1500, system="Return only valid JSON.") if False else chat_json("moonshotai/kimi-k2", brief, timeout=1500, system="Return only valid JSON.")
r = chat_json("kimi-k3", brief + "\n\n--- CURRENT FILE ---\n" + slim, timeout=1800)
print("[k3] response keys:", list(r.keys()) if isinstance(r, dict) else type(r))

# -- STEP 3: apply patches --
patched = slim
ok_patches, fail_patches = 0, 0
for blk in r.get("patched_blocks", []):
    find, rep = blk["find"], blk["replace"]
    if find in patched:
        patched = patched.replace(find, rep, 1)
        ok_patches += 1
    else:
        print("[patch-miss]", str(find)[:80]); fail_patches += 1
print(f"[patched] ok={ok_patches} fail={fail_patches}")

# stitch assets back
for name, uri in asset_uris.items():
    placeholder = f'window.ASSETS["@@{name}@@"] = "@@ASSET_URI:{name}@@";'
    if placeholder in patched:
        patched = patched.replace(placeholder, f'window.ASSETS["{name}"] = "{uri}";', 1)
    else:
        # patch may have moved code; append missing assets
        patched = patched.replace("window.ASSETS = {};", "window.ASSETS = {};\n" +
            "\n".join(f'window.ASSETS["{k}"] = "{v}";' for k, v in asset_uris.items()), 1)
        break

open('knights_out_final.html', 'w', encoding='utf-8').write(patched)
print("[final] saved", round(len(patched) / 1024), "KB — run: node qa_loop.js knights_out_final.html")
