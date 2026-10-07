"""Cost-capped panel: 3 models in parallel, slim (no-assets) prompt, exact-match patch verify.
Usage: python swing_panel.py [bug]  — default runs all 3 in parallel.
Reads panel_<bug>.json outputs; does NOT apply — that's done by apply_reviewed.py.
"""
import json, re, urllib.request

BASE = "https://backend.sovereigneg.com/v1"
KEY = "sk-REPLACE-ME-GET-YOUR-OWN-KEY"

# slim file: strip 1.9MB of base64 so each call sees only real code (~35KB instead of 1.9MB)
src = open('knights_out_final.html', encoding='utf-8').read()
slim = re.sub(r'(window\.ASSETS\["[^"]+"\] = ")data:model/gltf-binary;base64,[^"]+"', r'\1@EMBEDDED@"', src)
print(f"[slim] {len(src)//1024}KB -> {len(slim)//1024}KB for panel calls")

BUGS = {
  'swing': dict(
    model='kimi-k2.7-code',
    issue='''BUG 1 (WORST): At melee range, knight.swing() runs ~50 times in 4 seconds but deal 0 damage.
Two defects: (a) swing() fires every frame -- must be a ONE-SHOT per attack cycle (fire once between state=telegraph reaching attackTime>1.2 and the post-attack reset, add a hasSwung flag). (b) the damage connection inside swing() never registers -- trace it: the hit test uses cosTest(facing,toPlayer) with dist<3.2 && cos>0.2 but hits=0 even at dist~1.5. Find the distance/normalizing/off-by-one bug and fix INSIDE swing(). Also wire window.Sfx && Sfx.hurt to fire inside Player.hurt (currently silent).''',
  ),
  'fire': dict(
    model='deepseek-v4.1-flash',
    issue='''BUG 2: Player.fire does NOT exist (proven: window.Player.fire is undefined). The contract said 'Player.fire calls Smite.arm + raycasts Enemies.rayTargets -> Enemies.hurt' but hand-code added tryFire instead. Consequences: (a) holy_smite powerup (the ONLY signature chase-mechanic from the design) is DEAD CODE -- Smite.arm never invoked; (b) tryFire's hit-walk calls Enemies.hurt directly and never touches Smite. Fix: expose window.Player.fire (same body as tryFire, or alias), have it call Smite.arm(shotObj) on mousedown before the raycast, and after a hit call window.Smite.maybeApply(hitInfo). Keep tryFire as alias for backwards compat (kill the duplicate).''',
  ),
  'dom': dict(
    model='qwen3-coder-30b-a3b-instruct',
    issue='''BUG 3 (rendering dup): DOM after boot has crosshair x3, waveInfo x3, gameOver x2, victory x2, and SEPARATE #hpFill / #healthFill health bars (only #healthFill is updated by HUD.updateHP -- visible bar never animates). Root cause: static hand-DOM already declares these ids in HTML, then fx_hud's HUD.init() CREATE a second world (crosshair/healthbar/pips/spinner/waveInfo/vignette/hitMarker/gameOver/victory) via document.createElement. Fix: rewrite HUD.init() to GRAB the existing static DOM by id (getElementById('crosshair') etc) and only CREATE what is absent (gameOverScreen/victoryScreen/no coin). Never createElement for anything that already has an id in the static markdown. Update updateHP to target the static #hpFill (or set BOTH fills). Also reduce fx-hud's 4 pips to match static's 6, or delete the fx re-pips entirely (they duplicate).''',
  ),
}

def call(model, system, issue):
    payload = {"model": model, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": issue + "\n\n--- CURRENT CODE (external .glb assets inlined as base64) ---\n" + slim},
    ]}
    req = urllib.request.Request(BASE + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=1500).read())
    return r["choices"][0]["message"]["content"]

SYSTEM = '''You are a surgical browser-game repair agent. Return ONLY valid JSON:
{"root_cause": str, "patched_blocks": [{"find": "EXACT unique JS substring copied from CURRENT CODE (>=30 chars, unique in file)", "replace": "full replacement text (>=find length is OK)"}]}
Rules: find MUST be a real contiguous substring of CURRENT CODE. Fewest possible edits. No markdown outside JSON.'''

if __name__ == '__main__':
    import sys, concurrent.futures
    names = [sys.argv[1]] if len(sys.argv) > 1 else list(BUGS)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futs = {n: ex.submit(call, BUGS[n]['model'], SYSTEM, BUGS[n]['issue']) for n in names}
        for n, f in futs.items():
            raw = f.result()
            try:
                obj = json.loads(raw[raw.index('{'): raw.rindex('}')+1])
            except Exception as e:
                obj = {'parse_error': str(e), 'raw': raw[:300]}
            open(f'panel_{n}.json', 'w', encoding='utf-8').write(json.dumps(obj, indent=1))
            print(f"[panel:{n}] patches={len(obj.get('patched_blocks', []))} cause={(obj.get('root_cause') or 'ERROR')[:150]}")