/**
 * Vision QA loop: screenshot the first-person view, ask a VL model to judge
 * revolver orientation, iterate rotation presets until it passes.
 * Usage: node vision_loop.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'ling-3.0-flash-vl';

// candidate gun orientation presets: [rotX, rotY, rotZ] applied to gun inside rig
const PRESETS = [
  ['A_upright-yfwd',   { x: 0, y: Math.PI / 2, z: Math.PI / 2 }],
  ['B_flat-yfwd',      { x: 0, y: Math.PI / 2, z: 0 }],
  ['C_upright-y180',   { x: 0, y: Math.PI, z: Math.PI / 2 }],
  ['D_flat-y180',      { x: 0, y: Math.PI, z: 0 }],
  ['E_upright-z0',     { x: 0, y: 0, z: Math.PI / 2 }],
  ['F_flat-z0',        { x: 0, y: 0, z: 0 }],
];

async function vlJudge(imagePath, question) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const payload = {
    model: VL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    max_tokens: 400,
  };
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  return j.choices ? j.choices[0].message.content : ('ERR ' + JSON.stringify(j).slice(0, 300));
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + path.resolve('knights_out.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  const results = [];
  for (const [name, rot] of PRESETS) {
    // point camera straight ahead (-Z), neutral
    await page.evaluate(() => {
      const cam = window.Game.camera;
      cam.rotation.set(0, 0, 0);
      // apply preset to gun inside rig
      if (window.Game.gun) {
        window.Game.gun.rotation.set(0, 0, 0);
        window.Game.gun.rotation.x = arguments[0] ? 0 : 0;
      }
    }).catch(e => console.log('eval err', e.message));

    // actual rotation application (cleaner): set gun euler directly
    await page.evaluate((r) => {
      if (window.Game.gun) window.Game.gun.rotation.set(r.x, r.y, r.z);
      if (window.Game.gunRig) { window.Game.gunRig.position.set(0.28, -0.26, -0.55); window.Game.gunRig.rotation.set(0, 0, 0); }
    }, rot);

    await page.waitForTimeout(400); // let recoil-lerp settle (rig lerps position)
    const shot = `vl_${name}.png`;
    await page.screenshot({ path: shot });
    const verdict = await vlJudge(page, shot);
    results.push({ name, verdict });
    console.log(`=== ${name} ===`);
    console.log(verdict.trim().slice(0, 400));
    console.log('');
  }

  fs.writeFileSync('vision_report.json', JSON.stringify(results, null, 1));
  await browser.close();

  async function vlJudge(page, imagePath) {
    // Ask focused, answerable question with strict format
    return await vlCall(imagePath,
      `This is a first-person shooter game screenshot. Look at the WEAPON visible in the lower right area of the view. ` +
      `Answer these in order, tersely:\n` +
      `1. Is a weapon clearly visible? (yes/no)\n` +
      `2. Which way does the BARREL (the long tube part) point relative to the CENTER of the screen ` +
      `(toward center = away from player = correct; or up; or right; or left; or toward camera)?\n` +
      `3. Is the gun upside-down (grip pointing up instead of down)? (yes/no)\n` +
      `4. Overall on a scale 1-10 how much does this look like a proper first-person revolver hold?\n` +
      `Format:\nWEAPON: yes/no\nBARREL: center|up|right|left|camera\nUPSIDEDOWN: yes/no\nSCORE: N/10`);
  }
})();

async function vlCall(imagePath, question) {
  return await vlJudgeImpl(imagePath, question);
}

async function vlJudgeImpl(imagePath, question) {
  return await vlJudgeCore(imagePath, question);
}

async function vlJudgeCore(imagePath, question) {
  // delegate to main vlJudge (hoisted above)
  return await globalThis.__vlJudge(imagePath, question);
}

// hoist: re-assign vlJudge to core implementation
globalThis.__vlJudge = vlJudge;
