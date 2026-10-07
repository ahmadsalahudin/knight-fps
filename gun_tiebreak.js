/**
 * GUN VISUAL TIEBREAK: generate clean screenshots of exactly two named rotations
 * WITHOUT applying/patching anything — just show the user and await confirmation.
 *
 * Candidate A: gunsearch_label_"90_0_0"   -> euler (Math.PI/2, 0, 0)
 * Candidate B: gunsearch_label_"90_90_0"  -> euler (Math.PI/2, Math.PI/2, 0)
 * All other thread: zeroes inner-gun (avoid backup rotation confound),
 * restores for honest idle pose, then force-fire ONLY the mutated rig.
 */

const { chromium: pw } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOT_TAG = 'gun_tiebreak';
const INTERIOR = path.resolve('knights_out_final.html').replace(/\\/g, '/');
const SHOT_A = `EULER_A_90_0_0.png`;
const SHOT_B = `EULER_B_90_90_0.png`;

async function shootExactly(explodeFn, calls) {
  const browser = await pw.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + INTERIOR, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);
  await calls(page);
  await page.waitForTimeout(400);
  return { browser, shot: await page.screenshot() };
}

async function main() {
  // ---------- TASK A: euler (PI/2, 0, 0) = 90_0_0 ----------
  let { browser: b1, shot: shotA } = await shootExactly(null, async (p) => {
    await p.evaluate(() => {
      // neutralize both sub-fixes so neither masks the other; transform is now gunRig:
      const g = window.Game.gun;
      if (g) g.rotation.set(0, 0, 0);
      const rig = window.Game.gunRig;
      rig.rotation.set(Math.PI / 2, 0, 0);   // (90_0_0)
    });
  });
  fs.writeFileSync(SHOT_A, shotA);
  console.log('SAVED', SHOT_A);
  await b1.close();

  // ---------- TASK B: euler (PI/2, PI/2, 0) = 90_90_0 ----------
  let { browser: b2, shot: shotB } = await shootExactly(null, async (p) => {
    await p.evaluate(() => {
      const g = window.Game.gun;
      if (g) g.rotation.set(0, 0, 0);
      const rig = window.Game.gunRig;
      rig.rotation.set(Math.PI / 2, Math.PI / 2, 0);   // (90_90_0)
    });
  });
  fs.writeFileSync(SHOT_B, shotB);
  console.log('SAVED', SHOT_B);
  await b2.close();

  // reset final file's rotation to FOUND? NO — leave untouched, user confirms next
  console.log('\n=== TIEBREAK SCREENSHOTS READY ===');
  console.log('Please OPEN each to inspect the gun:');
  console.log('  ' + SHOT_A + ' = rotation(PI/2, 0, 0)');
  console.log('  ' + SHOT_B + ' = rotation(PI/2, PI/2, 0)');
  console.log('Reply which you prefer — the losing candidate is discarded, the winning one becomes the sole pin.');
}

main();