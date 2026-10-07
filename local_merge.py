"""Local deterministic merge: no LLM. Assembles knights_out.html from cached modules + assets.js."""
import json, os, time

cache = json.load(open('modules_cache.json', encoding='utf-8'))
plan = json.load(open('knights_plan.json', encoding='utf-8'))
assets_src = open('assets.js', encoding='utf-8').read()

order = ["assets", "world", "fx_hud", "controls", "ai"]  # provider-first per glm plan
order = [m for m in order if m in cache['ids']] + [m for m in cache['ids'] if m not in order]
parts = {mid: p for mid, p in zip(cache['ids'], cache['parts'])}

def strip_fences(code):
    code = code.strip()
    if code.startswith('```'):
        code = code.split('\n', 1)[1]
    if code.endswith('```'):
        code = code[:-3]
    return code.strip()

scripts = []
for mid in order:
    code = strip_fences(parts[mid])
    scripts.append(f"<!-- ==== MODULE {mid} ==== -->\n<script>\n{code}\n</script>")

boot = """
<script>
// bootstrap: wire modules together per glm plan
window.addEventListener('load', function () {
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8c8e8);
    scene.fog = new THREE.FogExp2(0x9fb98a, 0.02);
    const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);
    addEventListener('resize', () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

    // lights
    scene.add(new THREE.HemisphereLight(0xbfd6e4, 0x6a8f5a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.0);
    sun.position.set(40, 60, 20); sun.castShadow = true;
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    scene.add(sun);

    // build world, then player controls, then waves
    const colliders = window.World.build(scene, window.Assets);    window.Game.init(scene, camera, renderer);
    const clock = new THREE.Clock();
    let started = false;
    const lockEl = document.getElementById('lock');
    lockEl.addEventListener('click', function () { renderer.domElement.requestPointerLock(); });
    document.addEventListener('pointerlockchange', function () {
      if (document.pointerLockElement && !started) {
        started = true; lockEl.style.display = 'none';
        window.Waves.start(1);
      }
    });
    document.getElementById('startBtn').addEventListener('click', function(){ renderer.domElement.requestPointerLock(); });
    (function loop() {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      if (started) {
        window.Game.update(dt);
        window.Enemies.update(dt);
        window.Waves.update(dt);
        window.Smite.update(dt);
      }
      renderer.render(scene, camera);
    })();
  } catch (e) {
    console.error('BOOTSTRAP FAIL', e);
    document.body.insertAdjacentHTML('beforeend', '<pre style="color:red;z-index:99;position:fixed">' + e.stack + '</pre>');
  }
});
</script>
"""

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Knights of the Meadow — FPS</title>
<style>
  html,body{{margin:0;height:100%;overflow:hidden;font-family:Segoe UI,sans-serif;background:#111}}
  #lock{{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:rgba(10,20,10,.75);color:#eee;z-index:20;cursor:pointer;text-align:center}}
  #lock h1{{font-size:42px;margin:.2em}}
  #startBtn{{margin-top:16px;padding:12px 30px;font-size:20px;background:#2e5d2e;color:#fff;border:1px solid #7fae7f;border-radius:8px;cursor:pointer}}
  .hud, #hud > * {{pointer-events:none}}
</style>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/PointerLockControls.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/GLTFLoader.js"></script>
</head>
<body>
<div id="lock">
  <h1>Knights of the Meadow</h1>
  <p>WASD move &middot; Mouse aim &middot; LMB fire &middot; R reload &middot; Survive the armored waves.</p>
  <button id="startBtn">START</button>
</div>
<div id="hud"></div>
{assets_src}
{chr(10).join(scripts)}
{boot}
</body>
</html>"""

open('knights_out.html', 'w', encoding='utf-8').write(html)
print(f"[local merge] {order=} sizes={{{', '.join(mid + '=' + str(len(parts[mid])) for mid in order)}}}")
print(f"[saved] knights_out.html {round(os.path.getsize('knights_out.html')/1024)} KB total")
