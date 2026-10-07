"""Knight FPS: assets.js + Jev decisions -> qwen-coder build -> merge -> QA gate."""
import json, os, sys, time, base64, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://backend.sovereigneg.com/v1"
KEY = "sk-REPLACE-ME-GET-YOUR-OWN-KEY"
PLAN_MODEL = "glm-5.3-flash"
CODE_MODEL = "qwen3-coder-30b-a3b-instruct"

def _post(path, payload, timeout):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def chat(model, user, timeout=600, system=None):
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    last = None
    for attempt in range(6):
        try:
            return _post("/chat/completions", {"model": model, "messages": msgs}, timeout)["choices"][0]["message"]["content"]
        except Exception as e:
            last = e
            wait = 10 * (attempt + 1)
            print(f"  [retry {attempt+1}] {str(e)[:70]} waiting {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"chat failed after retries: {last}")

def chat_json(model, user, timeout=300, system=None):
    raw = chat(model, user, timeout, system=(system or "Output JSON only, nothing else."))
    try:
        return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except ValueError:
        for line in raw.splitlines():
            if line.strip().startswith("{"):
                return json.loads(line)
        raise

def jev(state, questions):
    out = _post("/systemone", {"model": "jev-1.13", "state": state, "questions": questions}, 60)
    return out["answers"]

PROMPT = ("A grassy medieval field FPS: I am a knight with a six-shot revolver, fighting waves of "
          "fully armored knights with covered faces, with a giant boss knight at wave 5. "
          "Rich single-file browser game, three.js, embedded GLB assets via window.ASSETS.")

QA_PROMPT = """You are a QA diagnosis pass. The game spec and the current HTML are given.
QA headless-browser results reported failures. Return ONLY a JSON array [{"file_or_scope": str, "fix": precise remedy str}].
Be surgical: smallest changes that make the QA checks pass. Do not redesign."""

def decide():
    pack = json.load(open("knights_questions.json", encoding="utf-8"))["questions"]
    t0 = time.perf_counter()
    answers = jev(PROMPT, pack)
    flat = "; ".join(f"{k}={v.get('choice') or round(v.get('noul', 0), 2)}" for k, v in answers.items())
    print("[jev]", flat)
    print(f"[jev] {round((time.perf_counter() - t0) * 1000)}ms")
    json.dump(answers, open("knights_decisions.json", "w"), indent=1)
    return flat

def build_spec(flat):
    # glm-5.3 is the architect: it authors the exact 3-module work plan for the coders,
    # with the embedded asset list baked into the brief
    assets_list = ", ".join(sorted(os.listdir("assets")))
    plan = chat_json(PLAN_MODEL,
        f"Plan the build of a single-file HTML knight-FPS browser game. THREE parallel coder instances "
        f"(competent but narrow) will each produce one <script> module; a fourth pass merges. "
        f"Assets already embedded as base64 GLB in window.ASSETS: {assets_list}. "
        f"Use three.js r0.147 UMD CDN (build/three.min.js + examples/js/controls/PointerLockControls.js). "
        f"Design decisions (do not revisit): {flat}\n"
        f"Game requirements: grassy field arena (GLB grass tufts, trees, rocks scattered), knight enemies "
        f"(GLB knight with helmet/sword/shield variants) in waves, giant boss knight wave 5, revolver "
        f"viewmodel from revolver.glb (anchor to camera, recoil, reload with cylinder out), HUD, game over/victory, "
        f"localStorage best wave, synthesis webaudio sfx. Enemy AI: advance in guard stance, occasional sidestep, "
        f"sword swing telegraph. Boss: 3 phases, spawns minions, sweeping greatsword.\n"
        f"Return JSON: {{\"modules\": [{{\"id\": str, \"task_brief\": \"detailed precise instructions\", "
        f"\"provides\": [\"window.X.method\"], \"consumes\": [\"window.Y.method\"]}}], "
        f"\"merge_instructions\": str, \"qa_checklist\": [\"testable assertion\", ...]}}",
        system="You are the lead architect. JSON only.")
    return plan

def implement(plan):
    briefs = []
    for m in plan["modules"]:
        briefs.append(
            f"You build ONE module of a browser knight-FPS game. Assets: base64 GLBs in window.ASSETS "
            f"(name -> data URI, load with THREE.GLTFLoader, parse from data URI). "
            f"three.js r0.147 UMD already loaded globally as THREE.\n"
            f"Module '{m['id']}' owns exactly: {m['task_brief']}\n"
            f"You PROVIDE (must fully implement): {json.dumps(m.get('provides', []))}\n"
            f"You CONSUME (call, never define): {json.dumps(m.get('consumes', []))}\n"
            f"Hard rules: standalone script block; no cross-module internals; don't duplicate identifiers; "
            f"no html skeleton, no markdown fences, ONLY the script content.")
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as ex:
        parts = list(ex.map(lambda b: chat(CODE_MODEL, b, timeout=900), briefs))
    print(f"[parallel modules] {round((time.perf_counter() - t0))}s sizes={[len(p) for p in parts]}")
    json.dump({"parts": parts, "ids": [m['id'] for m in plan['modules']]},
              open('modules_cache.json', 'w', encoding='utf-8'))
    t1 = time.perf_counter()
    joined = "\n\n".join(f"/* ==== MODULE {m['id']} ==== */\n{p}" for m, p in zip(plan["modules"], parts))
    MERGE_MODEL = CODE_MODEL  # glm 504s on large merge payloads; qwen-coder handled them before
    html = chat(MERGE_MODEL,
        f"Merge these modules into ONE complete self-contained HTML file, script in this order: "
        f"{[m['id'] for m in plan['modules']]}. Include: doctype html, three.js r0.147 CDN scripts, "
        f"assets.js inlined verbatim (the full base64 contents as given), pointer lock start flow, "
        f"{plan.get('merge_instructions', 'wire all modules')}.\n"
        f"Output ONLY final html.\n\n{joined}",
        timeout=900)
    print(f"[merge] {round((time.perf_counter() - t1))}s")
    s = html.find("<!")
    out = html[s:] if s != -1 else html
    # fence-strips and code-fence cleanup
    out = out.strip()
    if out.endswith("```"):
        out = out[:-3].rstrip()
    open("knights_out.html", "w", encoding="utf-8").write(out)
    print("[saved] knights_out.html", round(len(out) / 1024), "KB")
    return plan

def qa():
    os.system("node qa_loop.js knights_out.html")
    rep = json.load(open("qa_report.json", encoding="utf-8"))
    return rep

def fix_loop(plan, max_rounds=4):
    for round_no in range(1, max_rounds + 1):
        rep = qa()
        failed = [k for k, v in rep["checks"].items() if not v["ok"]]
        print(f"=== QA ROUND {round_no}: failed={failed}")
        if not failed and not rep["errors"]:
            print("QA GREEN — done"); return True
        code = open("knights_out.html", encoding="utf-8").read()
        fixes = chat_json(PLAN_MODEL,
            f"Game: knight FPS spec. QA failed checks: {json.dumps([rep['checks'][k] for k in failed], indent=1)}\n"
            f"JS errors: {json.dumps(rep['errors'][:8])}\n"
            f"Failed request URLs: {json.dumps(rep['failedReqs'][:5])}\n"
            f"Give the complete corrected HTML back, fixing ONLY the failures. Output ONLY html.\n\n{code}",
            timeout=900, system=QA_PROMPT) if False else chat(PLAN_MODEL,
            f"Game: knight FPS. QA failed: {json.dumps([rep['checks'][k] for k in failed], indent=1)}\n"
            f"JS errors: {json.dumps(rep['errors'][:8])}\n"
            f"Return the COMPLETE corrected single HTML file fixing ONLY failed checks and errors. "
            f"Output ONLY html, no fences.\n\n{code}",
            timeout=900)
        s = fixes.find("<!")
        out = fixes[s:] if s != -1 else fixes
        open("knights_out.html", "w", encoding="utf-8").write(out)
        print("[fix round saved]", round(len(out) / 1024), "KB")
    return False

if __name__ == "__main__":
    flat = decide()
    plan = build_spec(flat)
    implement(plan)
    ok = fix_loop(plan)
    sys.exit(0 if ok else 1)
