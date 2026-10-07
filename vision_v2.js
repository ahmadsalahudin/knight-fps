/**
 * Vision gun search v2: full 26-combination euler sweep to identify the GLB's
 * actual rest-axis mapping. Reports axis table, then picks best barrel=center.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';

async function vlJudge(imagePath) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL, max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `First-person shooter screenshot. Only look at the gun in the lower right. Answer ONLY:\nBARREL: center|up|down|right|left|camera` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ]}],
    }),
  });
  const j = await res.json();
  const c = j.choices ? j.choices[0].message.content : '';
  return (c.match(/BARREL:\s*(\w+)/) || [0, '?'])[1];
}

const AXES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + path.resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  const table = [];
  let n = 0;
  for (const rx of AXES) {
    for (const ry of AXES) {
      n++;
      if (rx === Math.PI) rxApp = rx; // keep all 16 combos, skip none
      const rot = [rx, ry, 0];
      await page.evaluate((r) => {
        const cam = window.Game.camera;
        cam.rotation.set(0, 0, 0);
        if (window.Game.gunRig) {
          window.Game.gunRig.rotation.set(r[0], r[1], 0);
          window.Game.gunRig.position.set(0.28, -0.26, -0.55);
        }
      }, rot);
      await page.waitForTimeout(400);
      const shot = `v2_${n}.png`;
      await page.screenshot({ path: shot });
      const barrel = await vlJudge(shot);
      table.push({ rot: rot.map(x => +(x * 57.3).toFixed(0)), barrel });
      console.log(`x=${(rot[0] + 360) % 360} y=${(rot[1] + 360) % 360} -> ${barrel}`);
    }
  }
  const winners = table.filter(r => r.barrel === 'center');
  console.log('\nCENTER-BARREL WINNERS:', JSON.stringify(winners, null, 1));
  fs.writeFileSync('vision_v2_report.json', JSON.stringify(table, null, 1));
  await browser.close();
})();
