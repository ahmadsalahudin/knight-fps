/**
 * VISION MATCH QA (gemma-4-31b-it as the eye):
 * 1. RECORD reference: describe gunsearch_90_0_0.png (user's true target).
 * 2. SETUP current game: pin rotation to candidate, screenshot fresh.
 * 3. ASK vision to score agreement between reference pose & current pose on four dimensions:
 *    barrel-direction, grip-direction, gun tilt/roll, fps-hold posture.
 * 4. Iterate candidate until MATCH is confirmed on all four dimensions, then PIN that euler.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';   // per user reminder

async function ask(b64, question) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL, max_tokens: 350,
      messages: [{ role: 'user', content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
      ]}]
    })
  });
  const j = await res.json();
  return (j.choices ? j.choices[0].message.content : 'ERR ' + JSON.stringify(j).slice(0, 120)).trim();
}

const REFERENCE = fs.readFileSync('gunsearch_90_0_0.png').toString('base64');

const DESCRIBE = `Examine this first-person shooter screenshot. In the bottom-right region there is a gun viewmodel (a revolver). Answer these precisely about the GUN only:
1. BARREL dir: toward_center(z-screen) / up / down / left / right / toward_viewer
2. GRIP dir: down / up / left / right
3. TILT: gun lies flat-against-screen (roll 0), rolled clockwise, rolled counter-clockwise, or vertical-up
4. FPS_HOLD_POSE: classic FPS crooked hold (barrel forward-into-screen, grip bottom-right) yes / no
5. Describe the gun's overall pose in one very short sentence for later diff.
FORMAT: strict, one field per line, no extra words.`;

const COMPARE = `Here are TWO first-person shooter screenshots: IMAGE A is the reference you must match; IMAGE B is the current state. Compare ONLY the gun viewmodel (bottom-right of each).
Compare on four independent axes and give a match verdict per axis:
AX1_BARREL_A vs AX1_BARREL_B (barrel direction: toward_center / up / down / left / right / toward_viewer / match?)
AX2_GRIP_A vs AX2_GRIP_B (grip direction)
AX3_TILT_A vs AX3_TILT_B (tilt/roll)
AX4_POSE_A vs AX4_POSE_B (FPS_ALIGN_posture: y/n)
After the four verdict lines, give an OVERALL: MATCH or NOT-MATCH.
FORMAT strictly:
AX1_BARREL: <match> | <mismatch (A=..., B=...)>
AX2_GRIP: <match> | <mismatch>
AX3_TILT: <match> | <mismatch>
AX4_POSE: <match> | <mismatch>
OVERALL: MATCH | NOT-MATCH`;

async function shotState(page, rotation) {
  // body-controlled rotation; keep it sacred clamped to camera space
  await page.evaluate((r) => {
    const g = window.Game.gun;
    if (g) g.rotation.set(0, 0, 0);
    const rig = window.Game.gunRig;
    if (rig) rig.rotation.set(r[0], r[1], r[2]);
  }, rotation);
  await page.waitForTimeout(450);   // let any recovery-lerp settle (it may fight us live — clean late reset)
  await page.evaluate((r) => {
    const rig = window.Game.gunRig;
    if (rig) rig.rotation.set(r[0], r[1], r[2]);  // second-set wins (final frame guarantee)
  }, rotation);
  await page.waitForTimeout(250);
  return page.screenshot();
}

(async () => {
  // 1. tag the reference once
  const refDesc = await ask(REFERENCE, DESCRIBE);
  console.log('=== REFERENCE (gunsearch_90_0_0.png) ===\n' + refDesc + '\n');

  // 2. build current-state loop
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:8877/knights_out_final.html', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1200);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  const CANDIDATES = [
    [Math.PI / 2, 0, 0],            // PI/2, 0, 0 : the golden reference
    [Math.PI / 2, Math.PI / 2, 0],  // current wrong — points toward-viewer (per user)
    [Math.PI / 2, 0, Math.PI / 3],
    [Math.PI / 2, Math.PI / 3, 0],
    [Math.PI / 2, -Math.PI / 4, 0],
    [Math.PI / 3, Math.PI / 2, 0],
  ];

  let winner = null;
  for (const rot of CANDIDATES) {
    const label = `rx=${(rot[0]*57).toFixed(0)} ry=${(rot[1]*57).toFixed(0)} rz=${(rot[2]*57).toFixed(0)}`;
    const shot = await shotState(page, rot);
    fs.writeFileSync(`match_${label.replace(/[= ]+/g,'_')}.png`, shot);
    const verdict = await ask('', null); // placeholder not used — use COMPARE with both images now:
    // Replace with two-image comparative call
    const res2 = await fetch(BASE + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VL, max_tokens: 350,
        messages: [{ role: 'user', content: [
          { type: 'text', text: COMPARE },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + REFERENCE } },  // A
          { type: 'text', text: 'IMAGE B follows:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + shot.toString('base64') } }
        ]}]
      })
    });
    const j = await res2.json();
    const answer = (j.choices ? j.choices[0].message.content : '').trim();
    console.log(`--- ${label} ---`);
    console.log(answer);
    console.log('');
    if (/OVERALL:\s*MATCH/i.test(answer)) { winner = rot; break; }
  }

  console.log('\n========= VERDICT =========');
  if (winner) {
    console.log('MATCHED reference at rotation ' + JSON.stringify(winner));
    // pin it in code
    let s = fs.readFileSync('knights_out_final.html', 'utf8');
    s = s.replace(/const GUN_BASE_X = [^\n]+\nconst GUN_BASE_Y = [^\n]+\nconst GUN_BASE_Z = [^\n]+\n/,
      `const GUN_BASE_X = ${winner[0]};\nconst GUN_BASE_Y = ${winner[1]};\nconst GUN_BASE_Z = ${winner[2]};   // vision-matched to gunsearch_90_0_0.png\n`);
    // directly set gunRig rotation constructor sentence too
    s = s.replace(/gunRig\.rotation\.set\([^)]*\);[^\n]*/,
      `gunRig.rotation.set(GUN_BASE_X, GUN_BASE_Y, GUN_BASE_Z);`);
    fs.writeFileSync('knights_out_final.html', s);
    console.log('PINNED in code.');
  } else {
    console.log('No candidate reached MATCH — report to user for a vision-tag of the correct crop.');
    fs.writeFileSync('gun_nonmatch.json', JSON.stringify({ candidates: CANDIDATES }, null, 1));
  }
  await browser.close();
})();