/**
 * Vision-driven gun-rotation search: tries candidate euler rots on gunRig,
 * screenshots, gemma-4-31b judges, picks the best. 8 presets + winner.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';

async function vlJudge(imagePath) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const payload = {
    model: VL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `First-person shooter screenshot. Judge the gun viewmodel in the lower right. Tersely:\nBARREL: center|up|down|right|left|camera\nGRIP: down|up|middle\nSCORE: N/10 how proper the FPS hold looks` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ]}],
    max_tokens: 150,
  };
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  return j.choices ? j.choices[0].message.content : 'ERR';
}

// candidate gunRig eulers [x, y, z]
const CANDIDATES = [
  ['r1_-90y0', [-Math.PI / 2, 0, 0]],        // current: muzzle up reported...
  ['r2_-90y90', [-Math.PI / 2, Math.PI / 2, 0]],
  ['r3_90y0', [Math.PI / 2, 0, 0]],
  ['r4_90y180', [Math.PI / 2, Math.PI, 0]],
  ['r5_0y0', [0, 0, 0]],                     // raw GLB orientation
  ['r6_0y90', [0, Math.PI / 2, 0]],
  ['r7_0y-90', [0, -Math.PI / 2, 0]],
  ['r8_-90z90', [-Math.PI / 2, 0, Math.PI / 2]],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + path.resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  const results = [];
  for (const [name, rot] of CANDIDATES) {
    await page.evaluate((r) => {
      const cam = window.Game.camera;
      cam.rotation.set(0, 0, 0);
      if (window.Game.gunRig) {
        window.Game.gunRig.rotation.set(r[0], r[1], r[2]);
        window.Game.gunRig.position.set(0.28, -0.26, -0.55);
      }
    }, rot);
    await page.waitForTimeout(500);
    const shot = `vls_${name}.png`;
    await page.screenshot({ path: shot });
    const v = await vlJudge(shot);
    const score = (v.match(/SCORE:\s*(\d+)/) || [0, 0])[1];
    const barrel = (v.match(/BARREL:\s*(\w+)/) || [0, '?'])[1];
    results.push({ name, rot, score: Number(score), barrel, verdict: v.trim().slice(0, 200) });
    console.log(`${name} rot=[${rot.map(x => (x * 57.3).toFixed(0))}] -> barrel=${barrel} score=${score}`);
  }
  const best = results.filter(r => r.barrel === 'center').sort((a, b) => b.score - a.score)[0] || results.sort((a, b) => b.score - a.score)[0];
  console.log('\nWINNER:', JSON.stringify(best, null, 1));
  fs.writeFileSync('vision_gun_report.json', JSON.stringify(results, null, 1));
  await browser.close();
})();
