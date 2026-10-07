"""Stage 2: run the saved glm plan through parallel qwen-coder build + merge + QA loop."""
import json, sys, time
sys.path.insert(0, '.')
exec(open('knights_pipeline.py', encoding='utf-8').read().split('if __name__')[0])

plan = json.load(open('knights_plan.json', encoding='utf-8'))
import os
if os.environ.get('SKIP_BUILD') == '1':
    print('[skip] build already done')
elif os.environ.get('RESUME_MERGE') == '1':
    cache = json.load(open('modules_cache.json', encoding='utf-8'))
    parts = cache['parts']
    print(f"[resume] cached modules sizes={[len(p) for p in parts]}")
    t1 = time.perf_counter()
    joined = "\n\n".join(f"/* ==== MODULE {mid} ==== */\n{p}" for mid, p in zip(cache['ids'], parts))
    html = chat(CODE_MODEL,
        f"Merge these modules into ONE complete self-contained HTML file, script in this order: "
        f"{cache['ids']}. Include: doctype html, three.js r0.147 CDN scripts, "
        f"assets.js inlined verbatim (the full base64 contents as given), pointer lock start flow, "
        f"{plan.get('merge_instructions', 'wire all modules')}.\n"
        f"Output ONLY final html.\n\n{joined}", timeout=900)
    print(f"[merge] {round((time.perf_counter() - t1))}s")
    s = html.find("<!")
    out = html[s:] if s != -1 else html
    out = out.strip()
    if out.endswith("```"):
        out = out[:-3].rstrip()
    open("knights_out.html", "w", encoding="utf-8").write(out)
    print("[saved] knights_out.html", round(len(out) / 1024), "KB")
else:
    implement(plan)
ok = fix_loop(plan, max_rounds=5)
print('FINAL:', 'GREEN' if ok else 'STILL FAILING')
