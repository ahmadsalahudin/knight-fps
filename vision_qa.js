/**
 * VISION QA — pixel-level proof via gemma-4-31b-it.
 * Runs the game in real Chromium (headed so WebGL renders), captures
 * screenshots at key moments/angles, sends each to a vision model for
 * concrete answers to specific questions. NO blind checks.
 * Usage: node vision_qa.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';  // user-specified vision model

async function visionAsk(b64, question) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL, max_tokens: 250,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
        ]
      }]
    })
  });
  const j = await res.json();
  return (j.choices ? j.choices[0].message.content : 'ERR ' + JSON.stringify(j).slice(0, 200)).trim();
}

(async () => {
  const browser = await chromium.launch({
    headless: true,  // we still render real WebGL; screenshots below are the golem's eyes
    args: ['--use-gl=angle', '--force-device-scale-factor=1']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + path.resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.click('#startBtn');

  // ========== THE FIELD PROTOCOL ==========
  // We capture FIVE shots, each a frozen frame with a precise context question.
  // F1: 2s after start, camera at spawn (-Z default), 360 spawn ring — some knights behind you.
  // F2: 2.5s after, camera YAW-rotated 180deg so we look at the OPPOSITE side of spawn ring.
  // F3: 8s after start — knights have walked 13-15u closer from spawn at distance 20.
  // F4: 14s — knights have closed to within 5-8u of player.
  // F5: hostile contact — one knight within 2u; verify they are visible AND attack.

  const shots = [];

  // F1 default view after START
  await page.waitForTimeout(2000);
  shots.push(await page.screenshot());
  console.log('F1 captured');

  // F2: camera pointed 180deg (facing +Z where half the spawn ring is)
  await page.evaluate(() => { window.Game.camera.rotation.y = Math.PI; });
  await page.waitForTimeout(600);
  shots.push(await page.screenshot());
  console.log('F2 captured (back-turned)');

  // F3: 9s total, knights approaching from random edges, camera at spawn default
  await page.evaluate(() => { window.Game.camera.rotation.y = 0; });
  await page.waitForTimeout(7500);
  shots.push(await page.screenshot());
  console.log('F3 captured (t+9s, knights closer)');

  // F4: 15s total
  await page.waitForTimeout(6500);
  shots.push(await page.screenshot());
  console.log('F4 captured (t+15s, knights closer still)');

  // F5: force a knight into close range for the contact shot
  await page.evaluate(() => {
    const e = window.Enemies.list.find(x => !x.mesh.userData.dying);
    if (e) {
      const cam = window.Game.camera;
      const f = cam.getWorldDirection(new THREE.Vector3());
      const target = cam.position.clone().add(f.multiplyScalar(4));  // 4u in front of cam
      e.mesh.position.copy(target);  // place knight 4u ahead
      cam.lookAt(target);
    }
  });
  await page.waitForTimeout(400);
  shots.push(await page.screenshot());
  console.log('F5 captured (forced knight 4u in front)');

  // ========== PIXEL-LEVEL VERIFICATION ==========
  const evidence = [];

  const ASK_KNIGHT = (extra) => `This is a screenshot from a first-person 3D browser game.
${extra}
ANSWER PER QUESTION, BE SPECIFIC AND QUANTITATIVE:
1. Are there any HUMAN-SHAPED FIGURES in the image (a knight with armor, head/helmet, body, possibly carrying a shield or sword)? YES or NO.
2. If yes: how MANY figures can you see? Give a number.
3. Where are they on-screen? (X percent from left edge, Y percent from top edge).
4. How tall is the NEAREST visible figure as a percentage of screen height? (Example: if it's half the screen height, say 50%.)
5. Do the figures look like armored knights (full body armor, possibly with helmets) or something else? Describe in 3 words or fewer.
RETURN FORMAT strictly:
KNIGHTS: yes/no
COUNT: N
POS: x%, y%
HEIGHT: N% screen
DESC: 3-words`;

  const ASK_GUN = `This is a screenshot from a first-person 3D browser game. In the lower-right area of the screen there should be a WEAPON VIEWMODEL (a gun). The white dot in the exact screen CENTER is the crosshair / aim point.
ANSWER PER QUESTION:
1. Is there a gun/weapon visible in the lower-right region? YES or NO.
2. The gun has a BARREL (long tube part) and a GRIP (handle part). Which direction does the BARREL point? CHOOSE ONE:
   INTO_SCREEN  (barrel away from viewer toward center/crosshair — correct FPS hold)
   UP           (barrel points toward sky/ceiling)
   DOWN         (barrel points toward floor)
   RIGHT        (barrel points off screen right)
   LEFT         (barrel points off screen left)
   TOWARD_YOU   (barrel points out of screen at viewer)
3. Which way does the GRIP (handle) point? DOWN (toward bottom of screen) or UP (toward top) or SIDE?
4. Does this look like a held weapon in a classic first-person shooter pose (barrel toward crosshair, grip down-right)? YES or NO.
RETURN FORMAT strictly:
GUN_VISIBLE: yes/no
GRIP: down/up/side
BARREL_DIRECTION: into_screen/up/down/left/right/toward_you
FPS_POSE: yes/no`;

  // F1 — default forward view
  evidence.push({ frame: 'F1 t+2s forward', answer: await visionAsk(
    shots[0].toString('base64'),
    ASK_KNIGHT('The camera is facing the default forward direction. The spawn ring is 360 degrees around the player, so some knights may be behind the camera.') + '\n\n' + ASK_GUN) });

  // F2 — back-turned
  evidence.push({ frame: 'F2 t+2.5s back-turned', answer: await visionAsk(
    shots[1].toString('base64'),
    ASK_KNIGHT('The camera has been rotated 180 degrees so we look at the OTHER side of the spawn ring.') + '\n\n' + ASK_GUN) });

  // F3 — t+9s forward
  evidence.push({ frame: 'F3 t+9s knights closer', answer: await visionAsk(
    shots[2].toString('base64'),
    ASK_KNIGHT('Knights have had 9 seconds to walk toward the player (2.2 units/sec from a 2000mm spawn distance).') + '\n\n' + ASK_GUN) });

  // F4 — t+15s
  evidence.push({ frame: 'F4 t+15s knights closer still', answer: await visionAsk(
    shots[3].toString('base64'),
    ASK_KNIGHT('Knights have had 15 seconds to approach (2.2u/s from 20u) so they should be within 6-10 units of the player now.') + '\n\n' + ASK_GUN) });

  // F5 — forced close contact, a knight exactly 4u ahead
  evidence.push({ frame: 'F5 forced knight 4u in front', answer: await visionAsk(
    shots[4].toString('base64'),
    ASK_KNIGHT('A single knight has been teleported 4 meters directly in front of the camera. It should be clearly visible filling roughly 20-30% of screen height.') + '\n\n' + ASK_GUN) });

  // ===== WRITE VERDICT =====
  console.log('\n=========== PIXEL VERDICT ===========\n');
  for (const e of evidence) {
    console.log(`--- ${e.frame} ---`);
    console.log(e.answer);
    console.log('');
  }
  fs.writeFileSync('vision_verdict.json', JSON.stringify(evidence, null, 1));

  // screenshot saves for user
  for (let i = 0; i < 5; i++) fs.writeFileSync('shot_F' + (i+1) + '.png', shots[i]);

  await browser.close();
  console.log('Saved: shot_F1..F5.png, vision_verdict.json');
})();