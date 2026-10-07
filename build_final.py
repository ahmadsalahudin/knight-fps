"""Final assembly: ALL modules incl. fx_hud (fixes HUD undefined = no game over screens)."""
import json, os, re

cache = json.load(open('modules_cache.json', encoding='utf-8'))
parts = dict(zip(cache['ids'], cache['parts']))

def strip_fences(code):
    code = code.strip()
    if code.startswith('```'):
        code = code.split('\n', 1)[1]
    if code.endswith('```'):
        code = code[:-3]
    return code.strip()

# ---- AI module (repaired, same fixes as rebuild.py) ----
ai = strip_fences(parts['ai'])
ai = ai.replace("Assets.get('helmet')", "Assets.get('knight_helmet1')")
ai = ai.replace("Assets.get('shield')", "Assets.get('knight_shield')")
ai = ai.replace("Assets.get('sword')", "Assets.get('knight_sword')")
ai = ai.replace("Assets.get('boss_shield')", "Assets.get('knight_boss_shield')")
ai = ai.replace("const loader = new THREE.GLTFLoader();\n", "")
ai = re.sub(r"loader\.parse\((window\.Assets\.get\('[^']+'\))\)\.scene", r"\1", ai)
ai = re.sub(r"loader\.parse\((window\.Assets\.get\('[^']+'\))\)", r"\1", ai)
ai = re.sub(r"const gltf = (window\.Assets\.get\('[^']+'\));\s*this\.mesh = gltf\.scene;", r"this.mesh = \1;", ai)
ai = ai.replace("this.mesh = gltf.scene;", "this.mesh = window.Assets.get('knight');")
ai = ai.replace(
    "window.Enemies.hurt = (obj, damage) => {\n        window.Enemies.hurt(obj, damage);\n    };", "")
ai = ai.replace(
    """hurt(damage) {
            this.mesh.userData.hp -= damage;
            if (this.mesh.userData.hp <= 0) {
                window.Waves.complete();
            }
        }""",
    """hurt(damage) {
            this.mesh.userData.hp -= damage;
            if (this.mesh.userData.hp <= 0) {
                this.die();
            }
        }""")
ai = ai.replace(
    """hurt(obj, damage) {
            if (obj.userData.hp !== undefined) {
                obj.userData.hp -= damage;
                if (obj.userData.hp <= 0) {
                    const enemy = this.list.find(e => e.mesh === obj);
                    if (enemy) enemy.die();
                }
            }
        }""",
    """hurt(obj, damage) {
            if (obj.userData.hp !== undefined) {
                obj.userData.hp -= damage;
                if (obj.userData.hp <= 0) {
                    const enemy = this.list.find(e => e.mesh === obj);
                    if (enemy && !enemy.mesh.userData.dying) enemy.die();
                }
                if (this.list.every(e => e.mesh.userData.dying) && window.Waves && window.Waves.complete) {
                    window.Waves.complete();
                }
            }
        }""")
ai = ai.replace(
    """complete() {
            this.current++;
            window.HUD.setWave(this.current);
            this.active = false;
            if (this.current === 5) {
                console.log("Victory!");
            }
        },""",
    """complete() {
            this.current++;
            if (window.HUD && HUD.setWave) HUD.setWave(this.current, Number(localStorage.getItem('kf_best') || 0));
            this.active = false;
            if (this.current >= 5) {
                if (window.HUD && HUD.victory) { HUD.victory(); document.exitPointerLock(); }
                return;
            }
            const self = this;
            setTimeout(function () { self.start(self.current); }, 4000);
        },""")
ai = ai.replace("window.HUD.setWave(waveNumber);",
                "if (window.HUD && HUD.setWave) window.HUD.setWave(waveNumber, Number(localStorage.getItem('kf_best') || 0));")
# swing arc: cosTest util + overlap free-hit (Boss + Knight)
archelper = """
function cosTest(facing, toPlayer) {
  const n = toPlayer.clone().normalize();
  return facing.x * n.x + facing.y * n.y + facing.z * n.z;
}
"""
ai = "function cosTest(facing, toPlayer) { const n = toPlayer.clone().normalize(); return facing.x*n.x + facing.y*n.y + facing.z*n.z; }\n" + ai
ai = ai.replace("const cos = facing.dot(toPlayer.normalize());",
                "const cos = cosTest(facing, toPlayer);")
old_arc = """if (dist < 3.2 && cos > 0.2) {
                window.Player.hurt(15);
            }"""
new_arc = """if (dist < 3.2) {
                if (dist > 0.2) {
                    const cos2 = cosTest(facing, toPlayer);
                    if (cos2 > 0.2) { window.Player.hurt(15); return; }
                } else {
                    window.Player.hurt(15); return;
                }
            }"""
cnt = ai.count(old_arc)
ai = ai.replace(old_arc, new_arc)
print(f'[ai] arc hardened x{cnt}')
# separation
ai = ai.replace("""// Movement
            const moveDir = this.lookAt.clone().multiplyScalar(speed * dt);
            this.mesh.position.add(moveDir);""",
"""// Movement — keep melee separation
            const gap = this.mesh.position.distanceTo(playerPos);
            if (gap > 1.4) {
                const moveDir = this.lookAt.clone().multiplyScalar(Math.min(speed * dt, gap - 1.4));
                this.mesh.position.add(moveDir);
            }""")
# bob + phase
ai = ai.replace("""// Shield animation during walk/strafe
            if (this.state === 'walking' || this.isStrafing) {""",
"""// procedural march: bob
            const _t = performance.now() / 1000;
            this.mesh.position.y = Math.abs(Math.sin(_t * 6 + (this._phase0 || 0))) * 0.05;
            // Shield animation
            if (this.state === 'walking' || this.isStrafing) {""")
ai = ai.replace("this.shieldUp = true;",
                "this.shieldUp = true;\n            this._phase0 = Math.random() * 6.28;")
# scale + bbox attachment
ai = ai.replace("this.mesh.position.set(0, 0, 0);",
    "this.mesh.scale.setScalar(0.35);\n"
    "            const _bb = new THREE.Box3().setFromObject(this.mesh);\n"
    "            this._top = _bb.max.y; this._mid = (_bb.max.y + _bb.min.y) / 2;")
ai = ai.replace("""helmet.scale.set(0.8, 0.8, 0.8);
            helmet.position.set(0, 0.7, 0);""",
    """helmet.scale.set(0.35, 0.35, 0.35);
            helmet.position.set(0, this._top * 0.92, 0);""")
ai = ai.replace("""shield.scale.set(0.7, 0.7, 0.7);
            shield.position.set(-0.6, 0.2, 0);""",
    """shield.scale.set(0.35, 0.35, 0.35);
            shield.position.set(-this._top * 0.32, this._mid, 0);""")
ai = ai.replace("""sword.scale.set(0.6, 0.6, 0.6);
            sword.position.set(0.6, 0, 0);""",
    """sword.scale.set(0.35, 0.35, 0.35);
            sword.position.set(this._top * 0.32, this._mid, 0);""")
# gun 45deg corrected rotation handled in game module

# ---- hand modules ----
hand_assets_world = open('knight_modules_hand.js', encoding='utf-8').read()
hand_game = open('game_module_hand.js', encoding='utf-8').read()
# strip script wrappers if present
hg = hand_game.strip()
if hg.startswith('<script>'):
    hg = hg[len('<script>'):].strip()
if hg.endswith('</script>'):
    hg = hg[:-len('</script>')].strip()
hand_game = hg

fx = strip_fences(parts['fx_hud'])
assets_src = open('assets.js', encoding='utf-8').read()

boot = """
<script>
window.addEventListener('load', function () {
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8c8e8);
    scene.fog = new THREE.FogExp2(0x9fb98a, 0.018);
    const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);
    addEventListener('resize', () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

    scene.add(new THREE.HemisphereLight(0xbfd6e4, 0x6a8f5a, 0.95));
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.05);
    sun.position.set(40, 60, 20); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    scene.add(sun);

    window.World.build(scene);
    window.Game.init(scene, camera, renderer);
    if (window.HUD && HUD.init) HUD.init();

    const clock = new THREE.Clock();
    let started = false;

    function startWaves() {
      if (started) return;
      started = true;
      window.__gameStarted = true;
      document.getElementById('lock').style.display = 'none';
      try { window.Waves.start(1); } catch (e) { console.error('Waves.start', e); }
    }

    document.getElementById('startBtn').addEventListener('click', function () {
      try { window.Game.controls.lock(); } catch (e) { console.error('lock', e); }
      startWaves();  // unconditional — Brave/Firefox lock must not gate waves
    });

    document.addEventListener('pointerlockchange', function () {
      if (document.pointerLockElement) startWaves();
    });

    (function loop() {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      if (started && !window.Game.dead) {
        window.Game.update(dt);
        if (window.Enemies && Enemies.update) window.Enemies.update(dt, window.Game.playerObj.position.clone());
        if (window.Waves && Waves.update) window.Waves.update(dt);
        if (window.Smite && Smite.update) Smite.update(dt);
        // live spawn badge: proves enemies module is alive in YOUR browser
        const badge = document.getElementById('spawnBadge');
        if (badge) badge.textContent = 'SPAWN OK (' + window.Enemies.list.length + ')';
      }
      renderer.render(scene, camera);
    })();
  } catch (e) {
    console.error('BOOTSTRAP FAIL', e);
    document.body.insertAdjacentHTML('beforeend', '<pre style="color:red;z-index:99;position:fixed;max-width:80vw;overflow:auto">' + e.stack + '</pre>');
  }
});
</script>
"""

final = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Knights of the Meadow</title>
<style>
  html,body{{margin:0;height:100%;overflow:hidden;font-family:'Segoe UI',sans-serif;background:#111}}
  #lock{{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:linear-gradient(rgba(8,20,8,.8),rgba(8,20,8,.9));color:#eee;z-index:20;cursor:pointer;text-align:center}}
  #lock h1{{font-size:44px;margin:.2em;text-shadow:0 2px 8px #000}}
  #lock p{{color:#b8d8b8}}
  #startBtn{{margin-top:18px;padding:12px 34px;font-size:20px;background:#2e5d2e;color:#fff;border:1px solid #7fae7f;border-radius:8px;cursor:pointer}}
  #startBtn:hover{{background:#3e7d3e}}
</style>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/PointerLockControls.js"></script>
</head>
<body>
<div id="lock">
  <h1>Knights of the Meadow</h1>
  <p>WASD move · Mouse aim · LMB fire · R reload · Survive the armored waves · Boss at wave 5</p>
  <button id="startBtn">START</button>
</div>
<div id="hud" style="position:fixed;inset:0;pointer-events:none;font-family:monospace;color:#fff;z-index:10">
  <div id="spawnBadge" style="position:absolute;top:8px;left:10px;font-size:11px;color:#6f6;padding:2px 6px;background:rgba(0,0,0,.35);border-radius:3px">SPAWN OK (0)</div>
  <div id="waveInfo" style="position:absolute;top:14px;left:50%;transform:translateX(-50%);font-size:20px;text-shadow:0 1px 3px #000">WAVE 1</div>
  <div style="position:absolute;bottom:22px;left:24px;display:flex;align-items:center;gap:10px">
    <span>HP</span>
    <div style="width:220px;height:14px;background:rgba(0,0,0,.5);border-radius:7px;overflow:hidden">
      <div id="hpFill" style="height:100%;width:100%;background:linear-gradient(90deg,#c0392b,#27ae60);transition:width .2s"></div>
    </div>
  </div>
  <div style="position:absolute;bottom:22px;right:24px;display:flex;gap:7px;font-size:17px">
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <span class="ammo-pip" style="width:11px;height:22px;background:#0f0;border-radius:2px"></span>
    <div id="reloadSpinner" style="display:none;color:#ffd54f">RELOADING…</div>
  </div>
  <div id="crosshair" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6px;height:6px;background:#fff;border-radius:50%;box-shadow:0 0 4px #000"></div>
  <div id="hitMarker" style="display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);color:#ffd54f;font-size:22px">✕</div>
  <div id="vignette" style="display:none;position:absolute;inset:0;background:radial-gradient(circle,transparent 55%,rgba(200,0,0,.55) 100%)"></div>
</div>
<script>
{assets_src}
</script>
<script>
{hand_assets_world}
</script>
<script>
{fx}
</script>
<script>
{ai}
</script>
<script>
{hand_game}
</script>
{boot}
</body>
</html>"""

out = 'knights_out_final.html'
open(out, 'w', encoding='utf-8').write(final)
print(f"[final] saved {round(os.path.getsize(out)/1024)} KB with modules: assets,world,fx_hud,ai,game")
# sanity: HUD assignment present?
import io
print('HUD assigned:', 'window.HUD = HUD' in final)
print('Sfx assigned:', 'window.Sfx = Sfx' in final)
