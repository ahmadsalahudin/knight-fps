import urllib.request, json, time, sys

def chat(model, user, timeout=900, system=None):
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    data = json.dumps({"model": model, "messages": msgs}).encode()
    req = urllib.request.Request("https://backend.sovereigneg.com/v1/chat/completions", data=data,
        headers={"Authorization": "Bearer sk-REPLACE-ME-GET-YOUR-OWN-KEY",
                 "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())["choices"][0]["message"]["content"]

code = open("knights_out.html", encoding="utf-8").read()

brief = """You are the senior game-repair engineer. Below is a single-file three.js browser FPS called 'Knights of the Meadow'.

USER FIELD TESTS (3 real browsers: Chrome, Brave, Firefox):
1. Revolver viewmodel points UP instead of forward. Must look like classic first-person revolver: grip down, barrel pointing away from camera toward screen center, positioned lower-right.
2. In most runs NO enemies spawn at all. Current boot relies on pointerlockchange to call Waves.start; in Brave/Firefox lock is often denied or delayed, so waves never begin. Waves must start unconditionally right at the START click, and pointer-lock loss must not kill the run.
3. Movement gets stuck/pinned near spawn sometimes - collider clamp math fights the movement vector.
4. Verify every flow works from an idle fresh page load: load -> START click -> menu hides -> enemies visibly spawn within ~2 seconds -> shoot kills -> wave advances -> boss at wave 5 -> victory/gameover screens.

REQUIREMENTS:
- Keep the existing Assets/World/Enemies/Waves/HUD/Sfx module structure and all GLB code as-is.
- Rewrite the bootstrap (last <script> block) and the Game.init/update sections ONLY as needed to fix the four issues above.
- Gun orientation: keep the gun as a child of the camera. Apply an euler rotation to the gun GROUP so the muzzle points -Z (screen center). If unsure of the raw GLB orientation, rotate (Math.PI/2, Math.PI, 0) as base - explain your reasoning briefly in a comment.
- Collider handling: cancel penetration AFTER movement, never push backDD against the input vector; add escape hatch (if stuck inside several colliders, teleport to nearest free spot).
- No leftover references to THREE.GLTFLoader (r147 UMD lacks it) - Assets parser handles everything.
- Output ONLY the complete corrected single HTML file, no fences, no commentary."""

r = chat("kimi-k3", brief + "\n\n" + code, timeout=1200)
print("raw len:", len(r))
s = r.find("<!")
open("knights_out_v2.html", "w", encoding="utf-8").write(r[s:] if s != -1 else r)
print("saved knights_out_v2.html")
