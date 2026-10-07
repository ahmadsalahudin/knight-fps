import urllib.request, json, time

def chat(model, user, timeout=300):
    payload = {"model": model, "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request("https://backend.sovereigneg.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer sk-REPLACE-ME-GET-YOUR-OWN-KEY",
                 "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())["choices"][0]["message"]["content"]

code = open("fps_out.html", encoding="utf-8").read()
r = chat("glm-5.3-flash",
    "This browser FPS game fails: clicking START GAME does nothing visible, enemies never act. "
    "Trace the code carefully. Return ONLY a JSON array of precise findings: "
    '["bug": desc, "location": func/line, "fix": precise remedy]. Nothing else.\n\n' + code)
open("fixes.json", "w", encoding="utf-8").write(r)
print(r[:3000])
