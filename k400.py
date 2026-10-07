"""Get the actual 400 error message from kimi-k3 with the big payload."""
import urllib.request, urllib.error, json

code = open("knights_out.html", encoding="utf-8").read()
payload = {"model": "kimi-k3", "messages": [{"role": "user", "content": "test\n\n" + code}], "max_tokens": 50}
req = urllib.request.Request("https://backend.sovereigneg.com/v1/chat/completions",
    data=json.dumps(payload).encode(),
    headers={"Authorization": "Bearer sk-REPLACE-ME-GET-YOUR-OWN-KEY",
             "Content-Type": "application/json"})
try:
    urllib.request.urlopen(req, timeout=60)
except urllib.error.HTTPError as e:
    print("STATUS:", e.code)
    print("BODY:", e.read().decode()[:600])
