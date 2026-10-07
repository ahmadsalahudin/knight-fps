"""Prompt-driven panel runner: loads reviewable prompt files, injects slim code, calls 3 models in parallel.
Usage: python run_panel.py [A|B|C]   — default: all three.
Writes panel_A.json / panel_B.json / panel_C.json. Does NOT apply patches — verify first.
"""
import json, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://backend.sovereigneg.com/v1"
KEY = "sk-REPLACE-ME-GET-YOUR-OWN-KEY"

SLIM = re.sub(r'(window\.ASSETS\["[^"]+"\] = ")data:model/gltf-binary;base64,[^"]+"',
              r'\1@EMBEDDED@"',
              open('knights_out_final.html', encoding='utf-8').read())

PROMPTS = {
    'A': ('prompts/A_kimi_swing.md',      'kimi-k2.7-code'),
    'B': ('prompts/B_deepseek_fire.md',   'deepseek-v4.1-flash'),
    'C': ('prompts/C_qwen_dom.md',        'qwen3-coder-30b-a3b-instruct'),
}

def split_prompt(path):
    """Prompt file: everything up to '### SYSTEM' ... '### USER' separated; the final marker is the code slot."""
    text = open(path, encoding='utf-8').read()
    sys_part = text.split('### SYSTEM', 1)[1].split('### USER', 1)[0].strip()
    usr_part = text.split('### USER', 1)[1]
    usr_part = usr_part.replace('{SLIM_CODE}', SLIM)
    return sys_part, usr_part

def call(tag, path, model):
    system, user = split_prompt(path)
    payload = {"model": model, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]}
    req = urllib.request.Request(BASE + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    raw = json.loads(urllib.request.urlopen(req, timeout=1500).read())["choices"][0]["message"]["content"]
    # tolerant parse: strip fences, find outermost JSON object
    raw = re.sub(r'^```(?:json)?|```$', '', raw.strip(), flags=re.M).strip()
    try:
        obj = json.loads(raw[raw.index('{'): raw.rindex('}') + 1])
    except Exception as e:
        obj = {'parse_error': str(e), 'raw_head': raw[:400]}
    open(f'panel_{tag}.json', 'w', encoding='utf-8').write(json.dumps(obj, indent=1))
    n = len(obj.get('patched_blocks', []))
    cause = (obj.get('root_cause') or obj.get('parse_error') or 'ERR')[:160]
    print(f"[{tag}:{model}] patches={n}  {cause}")
    return obj

if __name__ == '__main__':
    tags = sys.argv[1:] or list(PROMPTS)
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = [ex.submit(call, t, PROMPTS[t][0], PROMPTS[t][1]) for t in tags]
        for f in futs:
            f.result()
