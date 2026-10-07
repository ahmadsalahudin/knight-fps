const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';

async function vlJudge(imagePath, question) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const payload = {
    model: VL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ]}],
    max_tokens: 300,
  };
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  return j.choices ? j.choices[0].message.content : ('ERR ' + JSON.stringify(j).slice(0, 200));
}

(async () => {
  const q = `This is a first-person shooter screenshot. Answer tersely:\n` +
    `WEAPON: yes/no (is a gun visible?)\n` +
    `BARREL: center|up|down|right|left|camera (which way does the barrel point relative to screen center?)\n` +
    `GRIP: down|up|middle (which way does the handle/grip point?)\n` +
    `LOOKS_LIKE_FPS_HOLD: yes/no\nSCORE: N/10`;
  const v = await vlJudge('vl_final.png', q);
  console.log(v);
})();
