"""Rebuild knights_out.html fully locally: verified good AI module + hand-written modules."""
import json, os, re

# --- which cached modules are good? keep ai (worth rescuing), replace assets/world/controls with hand versions
cache = json.load(open('modules_cache.json', encoding='utf-8'))
parts = dict(zip(cache['ids'], cache['parts']))
ai_module = parts['ai']

# strip fences from ai module
ai = ai_module.strip()
if ai.startswith('```'):
    ai = ai.split('\n', 1)[1]
if ai.endswith('```'):
    ai = ai[:-3]

# --- fix asset names in AI module to our real embedded names
ai = ai.replace("Assets.get('helmet')", "Assets.get('knight_helmet1')")
ai = ai.replace("Assets.get('shield')", "Assets.get('knight_shield')")
ai = ai.replace("Assets.get('sword')", "Assets.get('knight_sword')")
ai = ai.replace("Assets.get('boss_shield')", "Assets.get('knight_boss_shield')")

# --- remove all GLTFLoader usage (replace with parser calls returning scene objects directly)
ai = ai.replace("const loader = new THREE.GLTFLoader();\n", "")
ai = ai.replace('loader.parse(window.Assets.get(knight)).scene', 'window.Assets.get(knight)')
# regex-free explicit fixes (ai uses loader.parse(...).scene three times)
ai = re.sub(r"loader\.parse\((window\.Assets\.get\('[^']+'\))\)\.scene", r"\1", ai)
# remaining loader.parse calls missing .scene suffix
ai = re.sub(r"loader\.parse\((window\.Assets\.get\('[^']+'\))\)", r"\1", ai)
# leftover: const gltf = Assets.get(...); this.mesh = gltf.scene  -> direct
ai = re.sub(r"const gltf = (window\.Assets\.get\('[^']+'\));\s*this\.mesh = gltf\.scene;",
            r"this.mesh = \1;", ai)
ai = ai.replace("this.mesh = gltf.scene;", "this.mesh = window.Assets.get('knight');")
# Knight.hurt misroutes every kill to Waves.complete() — should call enemy.die(), wave advance belongs to Enemies manager when list empties
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
# Enemies.hurt: after a die(), if ALL knights dying/dead -> Waves.complete()
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

# infinite recursion bug at end of module: Enemies.hurt re-defines itself calling itself
ai = ai.replace(
    "window.Enemies.hurt = (obj, damage) => {\n        window.Enemies.hurt(obj, damage);\n    };",
    "")
ai = ai.replace(
    """window.Enemies.hurt = (obj, damage) => {
            window.Enemies.hurt(obj, damage);
        };""",
    "")

# waves.complete() only increments; wave flow: complete should trigger next wave start
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
# spawn path also calls HUD.setWave unguarded (line 514 original)
ai = ai.replace("window.HUD.setWave(waveNumber);",
                "if (window.HUD && HUD.setWave) window.HUD.setWave(waveNumber, Number(localStorage.getItem('kf_best') || 0));")

# targeted raycast for swing: hits only the player! original checks enemies; make it check player distance-arc instead of ray-through-enemies
ai = ai.replace(
    """swing() {
            window.Sfx.swing();
            const angle = this.mesh.rotation.y;
            const halfArc = Math.PI * 110 / 180;
            const from = this.mesh.position.clone();
            const to = new THREE.Vector3(
                from.x + Math.sin(angle) * 2.6,
                from.y,
                from.z + Math.cos(angle) * 2.6
            );
            
            // Raycast to detect hit
            const raycaster = new THREE.Raycaster(from, to.clone().sub(from).normalize());
            const intersects = raycaster.intersectObjects(window.Enemies.rayTargets());
            for (const hit of intersects) {
                if (hit.object.userData.hp !== undefined) {
                    window.Player.hurt(15, hit.face.normal);
                }
            }
        }""",
    """swing() {
            if (window.Sfx && Sfx.swing) Sfx.swing();
            const self = this;
            const playerPos = Game.playerObj ? Game.playerObj.position : new THREE.Vector3();
            const toPlayer = playerPos.clone().sub(this.mesh.position); toPlayer.y = 0;
            const dist = toPlayer.length();
            const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
            const cos = facing.dot(toPlayer.normalize());
            if (dist < 3.2 && cos > 0.2) {
                window.Player.hurt(15);
            }
        }""")
# second copy (Boss's override, same pattern)
ai = ai.replace(
    """const raycaster = new THREE.Raycaster(from, to.clone().sub(from).normalize());
            const intersects = raycaster.intersectObjects(window.Enemies.rayTargets());
            for (const hit of intersects) {
                if (hit.object.userData.hp !== undefined) {
                    window.Player.hurt(15, hit.face.normal);
                }
            }""",
    """const playerPos = Game.playerObj ? Game.playerObj.position : new THREE.Vector3();
            const toPlayer = playerPos.clone().sub(this.mesh.position); toPlayer.y = 0;
            const dist = toPlayer.length();
            const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
            const cos = facing.dot(toPlayer.normalize());
            if (dist < 6.0 && cos > 0.0) {
                window.Player.hurt(15);
            }""")

# --- hand-written modules (from knight_modules_hand.js: Assets+World, game_module_hand.js: Game+Player)
hand_assets_world = open('knight_modules_hand.js', encoding='utf-8').read()
hand_game = open('game_module_hand.js', encoding='utf-8').read()
assets_src = open('assets.js', encoding='utf-8').read()

ai_wrapped = f"<!-- ==== MODULE ai (qwen-coder, repaired by agent) ==== -->\n<script>\n{ai}\n</script>"

# HUD bootstrap шews needed ids: waveInfo, .ammo-pip x6, reloadSpinner, vignette, hitMarker
hud_dom = """
<div id="hud" style="position:fixed;inset:0;pointer-events:none;font-family:monospace;color:#fff;z-index:10">
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
"""

boot = """
<script>
// bootstrap (hand-written): scene, lights, world, game, waves - full wiring
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

    const clock = new THREE.Clock();
    let started = false;

    function startWaves() {
      if (started) return;
      started = true;
      window.__gameStarted = true;
      document.getElementById('lock').style.display = 'none';
      try { window.Waves.start(1); } catch (e) { showErr('Waves.start', e); }
    }

    function showErr(tag, e) {
      console.error(tag, e);
      document.body.insertAdjacentHTML('beforeend', '<pre style="color:red;z-index:99;position:fixed;max-width:80vw;overflow:auto">' + tag + ': ' + (e.stack || e) + '</pre>');
    }

    // START: must call controls.lock() synchronously in the click gesture for Firefox/Brave
    document.getElementById('startBtn').addEventListener('click', function () {
      try { window.Game.controls.lock(); } catch (e) { showErr('lock', e); startWaves(); }
      startWaves();  // even if lock denies, waves must start immediately (Brave shield blocks lock)
    });

    // waves fire on real pointer lock...
    document.addEventListener('pointerlockchange', function () {
      if (document.pointerLockElement) startWaves();
    });
    // fallback: if lock never engages (Brave strict shields), start waves anyway after 1.2s
    setTimeout(function () {
      if (!started) { console.warn('[boot] pointer lock did not engage; starting waves anyway'); startWaves(); }
    }, 1200);
    setTimeout(function () {
      if (!started) { startWaves(); }
    }, 5000);
    (function loop() {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      if (started && !window.Game.dead) {
        window.Game.update(dt);
        if (window.Enemies && Enemies.update) window.Enemies.update(dt, window.Game.playerObj.position.clone());
        if (window.Waves && Waves.update) window.Waves.update(dt);
        if (window.Smite && Smite.update) Smite.update(dt);
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

html = f"""<!DOCTYPE html>
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
{ai_wrapped}
{hand_game}
{boot}
</body>
</html>"""

open('knights_out.html', 'w', encoding='utf-8').write(html)
print(f"[rebuild] saved {round(os.path.getsize('knights_out.html')/1024)} KB")
