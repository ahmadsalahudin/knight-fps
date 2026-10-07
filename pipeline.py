"""MCQ framework spike: static pack + glm-generated delta -> Jev decisions -> qwen3-coder-30b implements."""
import json, time, sys, os, urllib.request

BASE = "https://backend.sovereigneg.com/v1"
KEY = os.environ.get("SOVEREIGN_KEY") or "sk-REPLACE-ME-GET-YOUR-OWN-KEY"

def chat(model, messages, timeout=300):
    body = json.dumps({"model": model, "messages": messages}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]

def chat_json(model, messages, timeout=300):
    for attempt in range(3):
        try:
            raw = chat(model, messages, timeout)
            return json.loads(raw[raw.index("{"): raw.rindex("}")+1])
        except (ValueError, json.JSONDecodeError):
            raw_b = {"type": "json_object"}
            body = json.dumps({"model": model, "messages": messages,
                               "response_format": raw_b}).encode()
            req = urllib.request.Request(BASE + "/chat/completions", data=body,
                headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = json.loads(r.read())["choices"][0]["message"]["content"]
            try:
                return json.loads(raw[raw.index("{"): raw.rindex("}")+1])
            except Exception:
                continue
    raise RuntimeError("could not parse JSON from generator")

def jev(state, questions):
    body = json.dumps({"model": "jev-1.13", "state": state, "questions": questions}).encode()
    req = urllib.request.Request(BASE + "/systemone", data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print("[jev error]", e.read().decode()[:800])
        raise
    out["_latency_ms"] = (time.perf_counter() - t0) * 1000
    return out

def load_static_pack(path):
    with open(path, encoding="utf-8") as f:
        pack = json.load(f)
    return pack["questions"]

gen_prompt = """You generate EXTRA multiple-choice design questions missing from a static library.
User request for a game: "{prompt}"

Here are question IDs already covered by the static library:
{covered}

Write ONLY the questions that are important for THIS specific request but NOT covered above
(e.g. sub-systems the user uniquely mentioned, special mechanics, research-worthy constraints).
Return JSON only:
{{"questions": {{"<id>": {{"type": "choice", "instructions": "...", "criteria": {{"<opt>": "<description 5-12 words>", ...}}}}}}}}
Rules:
- 4 to 8 questions max. Only if they genuinely add decision richness for this request.
- choice questions only, 3-5 options each, every option described.
- If none add value, return {{"questions": {{}}}}
"""

def rephrase(q, meta):
    """Generate 3 alternative phrasings of a low-confidence question."""
    opts = "\n".join(f"- {k}: {v}" for k, v in meta["criteria"].items())
    out = chat_json("glm-5.3-flash", [{"role": "user", "content":
        f"Rewrite this design-choice question 3 different ways so a keyword-matching model can"
        f" discriminate better. Question: {meta['instructions']}\nOptions:\n{opts}\n"
        f"Return JSON: {{\"variants\": [\"...\", \"...\", \"...\"]}}"}])
    return out.get("variants", [])

def jd(d): return json.dumps({k: round(v, 0) if isinstance(v, float) else v for k, v in d.items()})

def run(prompt, static_path):
    timings = {}
    t0 = time.perf_counter()

    # Layer A: static pack (0 ms)
    static_q = load_static_pack(static_path)
    timings["static_pack_load_ms"] = (time.perf_counter() - t0) * 1000

    # Layer B: glm-5.3-flash generates the delta
    tb = time.perf_counter()
    sys_m = "You are a terse game-design question generator. Output JSON only."
    delta = chat_json("glm-5.3-flash", [
        {"role": "system", "content": sys_m},
        {"role": "user", "content": gen_prompt.format(
            prompt=prompt, covered=", ".join(sorted(static_q.keys())) + ".")},
    ])
    timings["glm_dynamic_pack_ms"] = (time.perf_counter() - tb) * 1000

    questions = {**static_q, **delta.get("questions", {})}
    print(f"[pack] static={len(static_q)} dynamic={len(delta.get('questions', {}))} total={len(questions)}")

    # Jev decision pass
    res = jev(prompt, questions)
    timings["jev_ms"] = res["_latency_ms"]
    answers = res["answers"]
    usage = res.get("usage", {})

    # Stance 3: rephrase low-confidence questions
    low = {k: v for k, v in questions.items()
           if k in answers and answers[k].get("confidence", 1) < 0.6}
    if low:
        tr = time.perf_counter()
        fixed = {}
        for qid, meta in low.items():
            variants = rephrase(qid, meta)
            subq = {f"{qid}__v{i}": {**meta, "instructions": vi} for i, vi in enumerate(variants)}
            sub = jev(prompt, subq)
            best_qid, best = max(
                ((k, v) for k, v in sub["answers"].items()),
                key=lambda kv: kv[1].get("confidence", 0))
            fixed[qid] = dict(answers[qid])  # keep prob view
            fixed[qid]["choice"] = best_qid.split("__v")[0] and sub["answers"][best_qid]["choice"]
            fixed[qid]["confidence"] = best.get("confidence")
            fixed[qid]["rephrased_via"] = best_qid
        timings["rephrase_ms"] = (time.perf_counter() - tr) * 1000
        answers.update(fixed)
    low_after = [k for k, v in answers.items()
                 if isinstance(v, dict) and v.get("confidence", 1) < 0.5]
    timings["total_to_decisions_ms"] = (time.perf_counter() - t0) * 1000

    decisions = {k: {kk: v[kk] for kk in
                     ("choice", "noul", "confidence", "probabilities") if kk in v}
                 for k, v in answers.items() if isinstance(v, dict)}

    print(json.dumps(decisions, indent=1))
    print(f"[timings to decisions] {jd(timings)}")
    print(f"[jev usage] {usage}")

    # Implementation: qwen3-coder-30b
    flat = "; ".join(f"{k}={v.get('choice', v.get('noul'))}" for k, v in decisions.items())
    print("[impl] generating game with qwen3-coder-30b-a3b-instruct ...")
    ti = time.perf_counter()
    code = chat("qwen3-coder-30b-a3b-instruct", [{"role": "user", "content":
        f"Build a complete playable browser game as ONE self-contained HTML file (inline CSS+JS, canvas).\n"
        f"User said: {prompt}\n"
        f"All design decisions already made — honor every one exactly:\n{flat}\n"
        f"Return ONLY the HTML file content, no markdown fences, no commentary."}],
        timeout=600)
    timings["implement_ms"] = (time.perf_counter() - ti) * 1000
    if code.strip().startswith("<!"):
        out_html = code
    else:
        s = code.find("<!"); out_html = code[s:] if s != -1 else code
    with open("game_out.html", "w", encoding="utf-8") as f:
        f.write(out_html)
    timings["total_ms"] = (time.perf_counter() - t0) * 1000
    print(f"[timings total] {jd(timings)}")
    with open("decisions.json", "w", encoding="utf-8") as f:
        json.dump({"prompt": prompt, "decisions": decisions, "timings": timings}, f, indent=1)

if __name__ == "__main__":
    prompt = sys.argv[1]
    pack = sys.argv[2] if len(sys.argv) > 2 else "game.mcq.json"
    run(prompt, pack)
