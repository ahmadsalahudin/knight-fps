"""3D FPS spike: glm dynamic pack -> Jev -> 3x parallel qwen3-coder -> merge."""
import json, time, sys, os, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://backend.sovereigneg.com/v1"
KEY = os.environ.get("SOVEREIGN_KEY") or "sk-REPLACE-ME-GET-YOUR-OWN-KEY"
CODER = "qwen3-coder-30b-a3b-instruct"
M = "glm-5.3-flash"

def _post(path, payload, timeout=600):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out, (time.perf_counter() - t0) * 1000

def chat(model, messages, timeout=600, json_mode=False):
    payload = {"model": model, "messages": messages}
    if json_mode: payload["response_format"] = {"type": "json_object"}
    for attempt in range(3):
        try:
            out, _ = _post("/chat/completions", payload, timeout)
            raw = out["choices"][0]["message"]["content"]
            return json.loads(raw[raw.index("{"): raw.rindex("}") + 1]) if json_mode else raw
        except json.JSONDecodeError:
            continue
    raise RuntimeError("json parse failed")

def jev(state, questions):
    try:
        out, ms = _post("/systemone", {"model": "jev-1.13", "state": state, "questions": questions}, 60)
    except urllib.error.HTTPError as e:
        print("[jev error]", e.read().decode()[:500]); raise
    out["_latency_ms"] = ms
    return out

FPS_PACK_PROMPT = """Generate a multiple-choice question pack for building a 3D FIRST-PERSON SHOOTER for a request.
Request: "{prompt}"

Return a JSON question pack covering: movement feel, weapon loadout, enemy types+AI,
arena/map structure, health/armor system, enemy waves vs open exploration,
HUD, difficulty, atmosphere/horror level, distinct 3D scene set dressing, win/lose conditions.
Rules: 16-22 questions. type=choice for all, 3-5 options each, every option described (5-12 words).
Return JSON only: {{"questions": {{"<id>": {{"type": "choice", "instructions": "...", "criteria": {{"<opt>": "<desc>"}}}}}}}}"""

PLAN_PROMPT = """You are the lead architect. A 3-instance coder team (each a qwen3-coder-30b LLM) will build
ONE 3D first-person shooter browser game in parallel. You must decompose the work so the three
instances can code simultaneously with zero communication.

User request: "{prompt}"
Final design decisions (Jev output): {decisions}

Plan exactly 3 modules with a hard, explicit JavaScript interface. Good default decomposition:
engine/scene+player, enemies+weapons AI, HUD/effects/menus — but YOU decide; if the request has a
special dominant feature, give it its own instance and rebalance.

Return JSON only:
{{
 "modules": [
   {{"id": "<kebab-name>",
     "own": "<one line: what this instance alone owns>",
     "api_provides": ["window.<ArtifactName>.<method()>", ...],
     "api_consumes": ["window.<OtherArtifact>.<method()>", ...],
     "task_brief": "<detailed build instructions 80-150 words: what to implement, per the decisions>",
     "constraints": "<specific gotchas: canvas/renderer ownership, event listeners, artifact contract>"}}
 ]
}}
Rules: exactly 3 modules; each api_provides must be the FULL artifact object contract with method
signatures; api_consumes must only reference artifacts another module provides; artifact objects must
be disjoint (no shared global names); decision fields like file_structure/persistence still apply."""

class ThreeWayCoder:
    """glm-5.3 plans the work split; 3 qwen3-coder-30b instances code in parallel; then merge."""

    def __init__(self, decisions_flat, prompt):
        self.decisions = decisions_flat
        self.prompt = prompt
        self.plan = None

    def architect(self):
        raw = chat(M, [{"role": "system", "content": "You are a terse lead architect. Output JSON only."},
                       {"role": "user", "content": PLAN_PROMPT.format(
                           prompt=self.prompt, decisions=self.decisions)}],
                  json_mode=True)
        mods = raw["modules"]
        assert len(mods) == 3 and all("task_brief" in m for m in mods), f"bad plan: {raw}"
        # core artifact/interface objects for the coder prompts (disjoint names come from plan)
        self.plan = mods
        return mods

    def run(self):
        ta = time.perf_counter()
        mods = self.architect()
        self.plan_ms = (time.perf_counter() - ta) * 1000
        iface_note = ("Hard interface contract (follow exactly): modules communicate ONLY via the global "
                      "artifact objects each module creates (e.g. window.Engine = {...}). Never touch another "
                      "module's internals. Your api_provides object must exist; api_consumes you call but do not "
                      "define (the merge step wires load order).")
        briefs = []
        for m in mods:
            briefs.append(
                f"You are instance '{m['id']}' of a 3-instance team building a 3D first-person shooter "
                f"browser game with three.js (r160, CDN).\n"
                f"You OWN: {m['own']}\n"
                f"You PROVIDE: {json.dumps(m.get('api_provides', []))}\n"
                f"You CONSUME (do not define): {json.dumps(m.get('api_consumes', []))}\n"
                f"BUILD TASK: {m['task_brief']}\n"
                f"CONSTRAINTS: {m.get('constraints', '')}\n{iface_note}\n"
                f"User said: {self.prompt}\nDesign decisions: {self.decisions}\n"
                f"Output ONLY a single <script> block with your module's code, no html skeleton, no markdown.")

        t0 = time.perf_counter()
        ids = [m["id"] for m in mods]
        with ThreadPoolExecutor(max_workers=3) as ex:
            parts = dict(zip(ids, ex.map(
                lambda kv: chat(CODER, [{"role": "user", "content": kv[1]}], timeout=900),
                briefs)))
        t_modules = (time.perf_counter() - t0) * 1000
        self.sizes = {m: len(p) for m, p in parts.items()}

        tm = time.perf_counter()
        joined = "\n\n".join(
            f"/* ==== MODULE {m['id']} (provides {json.dumps(m.get('api_provides', []))}) ====\n{parts[m['id']]} */"
            for m in mods) if False else "\n\n".join(
            f"/* ==== MODULE {m['id']} ====\n{parts[m['id']]}" for m in mods)
        merged = chat(CODER, [{"role": "user", "content":
            f"Assemble these 3 parallel-authored module blocks into ONE complete self-contained HTML file "
            f"for a 3D FPS browser game. Exact interface plan it was built to: "
            f"{json.dumps([{'id': m['id'], 'provides': m.get('api_provides', []),
                              'consumes': m.get('api_consumes', [])} for m in mods])}\n"
            f"Use three.js r160 from jsdelivr/unpkg CDN, pointer lock controls. Keep module code intact; "
            f"fix ONLY cross-module wiring, load order, and any missing glue. Output ONLY the html, no fences.\n\n{joined}"}],
            timeout=900)
        t_merge = (time.perf_counter() - tm) * 1000
        s = merged.find("<!"); html_out = merged[s:] if s != -1 else merged
        with open("fps_out.html", "w", encoding="utf-8") as f:
            f.write(html_out)
        return {"architect_ms": self.plan_ms, "module_ms": t_modules,
                "merge_ms": t_merge, "sizes": self.sizes}

def main():
    prompt = sys.argv[1]
    static_f = "fps.mcq.json"
    t0 = time.perf_counter()
    with open(static_f, encoding="utf-8") as f:
        static_q = json.load(f)["questions"]
    # small glm delta for prompt-specific gaps
    delta = chat(M, [{"role": "system", "content": "You are a terse FPS-design question generator. JSON only."},
                     {"role": "user", "content":
                      f"Static question pack already covers: {', '.join(sorted(static_q))}.\n"
                      f"Request: {prompt}\n"
                      f"Add ONLY questions important for THIS request but not covered (0-6, choice type, described options). "
                      f'Return JSON: {{"questions": {{...}}}}'}], json_mode=True)
    questions = {**static_q, **delta.get("questions", {})}
    # validate delta: drop malformed, fixes glm output inconsistencies
    valid = {}
    for qid, meta in questions.items():
        if (isinstance(meta, dict) and meta.get("type") == "choice"
                and isinstance(meta.get("criteria"), dict) and meta.get("instructions")):
            valid[qid] = meta
        else:
            print(f"[pack] dropped malformed question: {qid}: {str(meta)[:120]}")
    questions = valid
    print(f"[pack] static={len(static_q)} delta={len(delta.get('questions', {}))} total={len(questions)} in {(time.perf_counter()-t0):.1f}s")
    res = jev(prompt, questions)
    print(f"[jev] {res['_latency_ms']:.0f}ms, usage={res.get('usage')}")
    answers = res["answers"]
    for k, v in answers.items():
        c = v.get("choice", v.get("noul"))
        print(f"  {k:32s} = {c!s:28s} conf={v.get('confidence', '-')}")
    flat = "; ".join(f"{k}={v.get('choice', v.get('noul'))}" for k, v in answers.items())
    with open("fps_decisions.json", "w", encoding="utf-8") as f:
        json.dump({"prompt": prompt, "decisions": answers}, f, indent=1)
    timings = {"pack_ms": (time.perf_counter()-t0)*1000, "jev_ms": res["_latency_ms"]}
    t_i = time.perf_counter()
    r = ThreeWayCoder(flat, prompt).run()
    r["implement_total_ms"] = (time.perf_counter()-t_i)*1000
    print(f"[impl] {json.dumps(r)}")
    timings.update(r)
    tv = time.perf_counter() - t0
    timings["wall_total_ms"] = tv*1000
    print(f"[total] decision_layer={timings['pack_ms']+timings['jev_ms']:.0f}ms wall={tv:.1f}s")
    with open("fps_timings.json", "w", encoding="utf-8") as f:
        json.dump(timings, f, indent=1)

if __name__ == "__main__":
    main()
