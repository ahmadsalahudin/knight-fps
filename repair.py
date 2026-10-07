import urllib.request, json, re

def chat(model, user, timeout=300):
    payload = {"model": model, "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request("https://backend.sovereigneg.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer sk-REPLACE-ME-GET-YOUR-OWN-KEY",
                 "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())["choices"][0]["message"]["content"]

code = open("fps_out.html", encoding="utf-8").read()

qa_summary = """CURRENT QA RESULTS (run in headless Chromium):
- PASS: loads, THREE defined, menu hides on START, pointer locks, 4 enemies spawn (wave 1), WASD moves player
- FAIL C8 shoot_kills_enemy: shooting never kills. CombatApi has NO public handleWeaponFire/handleEnemyDeath/handleSwitch/setSlot/incomplete spawn-death routing. My external patch (exposeCombatHandlers) didn't work because the death filter/wave-advance operates on internals copy.
- FAIL C9 health: player.getHealth() returns 0 at QA time though enemies are alive - enemies damage player every frame they're close; but game-over never triggered, health bar seems broken. Also HUD setHealth is only called inside chase-branch per-frame, not on takeDamage callers elsewhere. Health should start 100, drop on接触 damage.
TASK: Return the COMPLETE corrected single HTML file implementing these requirements:
1. One clean global game orchestrator (window.Game) that owns: init, buildArena, input(keys/mouse), shoot(), damageEnemy(id,dmg), killEnemy(id), waveManager(current/states/advance), playerHealth(start=100, takeDamage, heal, gameOver->HudFx.showMenu('gameover')), frame loop driving everything, HUD binding.
2. Reuse existing module structures if you must, but ALL cross-module calls must resolve. No external patch IIFEs; no dangling references; no duplicate identifiers.
3. Weapons: pistol (hitscan dmg 25, fire rate 300ms), shotgun (5 pellets, dmg 15 each, 800ms), plasma rifle (fast projectile dmg 40, 150ms), slots 1/2/3. Ammo: pistol infinite, shotgun 24 reserve, plasma 60 reserve with ammo pickups dropping from killed enemies (wired real spawn+collect).
4. Enemies: 3 archetypes minimum: rusher (fast melee), shooter (stops at 8-14m, fires projectiles at player, dodges sideways occasionally), spitter (stationary ranged arcing projectile). Enemies spawn from vents at arena edges each wave. Wave N: enemyCount = 3 + N*2, shooter appears wave>=2, spitter wave>=3. Wave advance: intermission 4s banner, all-dead triggers next wave. Big hive mother boss at wave 5 (20x scale capsule, spawns 2 rushers every 6s, 1500 hp, phases: >=1000hp turret spread, <1000 adds beam sweep, <500 speed up + spawns faster).
5. Player death -> game over screen with final wave + best wave from localStorage; restart button reloads. Save best wave to localStorage on death AND on each wave advance.
6. HUD: health bar (red ff0000 fill), ammo counter matching current weapon, wave display top-right (BOSS tag on wave 5), kill toast, damage flash vignette (opacity by recent damage), dynamic crosshair that grows with movement/fire.
7. Sound: WebAudio synth bleeps for fire/hit/kill/wave/zone (no external files). Muted before user gesture ok.
8. Three.js CDN r0.147 UMD: https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js and examples/js/controls/PointerLockControls.js. WASD + shift sprint + pointer lock look. Arena 50x50 with crates providing cover. Dramatic contrast lighting (some spot lights, emissive meshes ok).
Output ONLY the html file, no markdown fences, no commentary. Include <script src> exactly as above."""

r = chat("glm-5.3-flash", qa_summary + "\n\n" + code, timeout=600)
print("raw len:", len(r))
s = r.find("<!"); out = r[s:] if s != -1 else r
open("fps_out3.html", "w", encoding="utf-8").write(out)
print("saved ", len(out), "bytes")
